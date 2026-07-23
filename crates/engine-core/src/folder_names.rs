//! Moodle由来のコース名をWindowsの保存フォルダ名へ正規化する。
//!
//! raw course nameはSQLiteへ保持し、保存用の名前はbackendだけが生成する。NFKC正規化、
//! 明確な補足・絵文字除去、Windows名の安全化、長さ制限、同名衝突の別名提案をここへ集約する。

use std::collections::{BTreeMap, BTreeSet};

use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

use crate::error::{EngineError, EngineResult};
use crate::folder_name_notes::remove_supplemental_notes;
use crate::windows_names::{is_windows_reserved_name, utf16_len, validate_windows_component};

/// 保存用コースフォルダ名の上限。後続の学期・セクション・ファイル名の余地を残す。
pub const COURSE_FOLDER_MAX_UTF16_UNITS: usize = 80;
const MAX_ALIAS_SUFFIX_UTF16_UNITS: usize = 24;
const UNKNOWN_COURSE_NAME: &str = "不明なコース";

/// 複数コースの保存名を一括解決するためのSQLite由来の識別情報。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CourseFolderIdentity<'a> {
	pub course_id: i64,
	pub name: &'a str,
	pub stable_id: &'a str,
	pub folder_name_override: Option<&'a str>,
}

/// 保存用コース名について利用者確認が必要な理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CourseFolderNameWarningCode {
	NameConflict,
	NameShortened,
}

/// backendが決定した別名・短縮名を利用者へ提示する警告。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CourseFolderNameWarning {
	pub code: CourseFolderNameWarningCode,
	pub message: String,
	pub suggested_folder_name: String,
}

/// 1コース分の衝突しない保存用フォルダ名。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CourseFolderNameResolution {
	pub course_id: i64,
	pub folder_name: String,
	pub warnings: Vec<CourseFolderNameWarning>,
}

#[derive(Debug)]
struct FolderCandidate<'a> {
	identity: CourseFolderIdentity<'a>,
	folder_name: String,
	is_override: bool,
	had_conflict: bool,
	was_shortened: bool,
}

/// Moodle上の明確な補足表記と絵文字を除き、分類情報を保ったフォルダ名へ正規化する。
pub fn folder_segment(value: &str) -> String {
	let normalized = normalize_folder_text(value);
	let without_notes = remove_supplemental_notes(&normalized);
	let normalized = normalize_folder_text(&without_notes);
	sanitize_generated_component(&normalized)
}

/// ルールへ展開する動的な値を、単一のWindowsフォルダ要素へ正規化する。
///
/// テンプレート中の区切りとMoodle由来の値に含まれる区切りを混同しないよう、`/`と`\`は
/// 可読な中黒へ変換する。不正文字だけで空になった値は、階層を黙って欠落させずエラーにする。
pub(crate) fn normalize_dynamic_folder_component(token: &str, value: &str) -> EngineResult<String> {
	let normalized = normalize_folder_text(value);
	let sanitized = sanitize_normalized_component(&normalized, token);
	validate_windows_component(token, &sanitized)?;
	Ok(sanitized)
}

/// 全コースを同時に解決し、同じ保存用フォルダ名が二つ存在しないようにする。
///
/// 利用者指定名同士が衝突する場合は勝手に変更せずエラーにする。自動生成名の衝突は、
/// 元名にだけ含まれる識別語を優先し、識別できなければMoodle安定IDを接尾辞に使う。
pub fn resolve_course_folder_names(
	courses: &[CourseFolderIdentity<'_>],
) -> EngineResult<Vec<CourseFolderNameResolution>> {
	validate_identities(courses)?;
	let mut candidates = courses
		.iter()
		.map(|identity| {
			let folder_name = match identity.folder_name_override {
				Some(value) => normalize_course_folder_override(value)?,
				None => non_empty_or(folder_segment(identity.name), UNKNOWN_COURSE_NAME),
			};
			Ok(FolderCandidate {
				identity: *identity,
				folder_name,
				is_override: identity.folder_name_override.is_some(),
				had_conflict: false,
				was_shortened: false,
			})
		})
		.collect::<EngineResult<Vec<_>>>()?;

	let collision_groups = collision_groups(&candidates);
	for group in collision_groups.values().filter(|group| group.len() > 1) {
		let override_count = group
			.iter()
			.filter(|index| candidates[**index].is_override)
			.count();
		if override_count > 1 {
			return Err(EngineError::RuleConflict {
				reason: "利用者が指定したコースフォルダ名が重複しています".to_string(),
			});
		}

		for index in group {
			if candidates[*index].is_override {
				continue;
			}
			let suffix = distinctive_alias(*index, group, &candidates)
				.unwrap_or_else(|| normalize_stable_id(candidates[*index].identity.stable_id));
			let base = candidates[*index].folder_name.clone();
			candidates[*index].folder_name = append_suffix(&base, &suffix);
			candidates[*index].had_conflict = true;
		}
	}

	for candidate in &mut candidates {
		if utf16_len(&candidate.folder_name) > COURSE_FOLDER_MAX_UTF16_UNITS {
			candidate.folder_name =
				shorten_with_stable_hash(&candidate.folder_name, candidate.identity.stable_id);
			candidate.was_shortened = true;
		}
		validate_windows_component("course_folder_name", &candidate.folder_name)?;
	}

	ensure_unique_final_names(&mut candidates)?;

	Ok(candidates
		.into_iter()
		.map(|candidate| {
			let mut warnings = Vec::new();
			if candidate.had_conflict {
				warnings.push(CourseFolderNameWarning {
					code: CourseFolderNameWarningCode::NameConflict,
					message: "同じ保存名になるコースがあるため、別名を提案しました".to_string(),
					suggested_folder_name: candidate.folder_name.clone(),
				});
			}
			if candidate.was_shortened {
				warnings.push(CourseFolderNameWarning {
					code: CourseFolderNameWarningCode::NameShortened,
					message: "コース名が長いため、単語・文字の境界を保って短縮しました".to_string(),
					suggested_folder_name: candidate.folder_name.clone(),
				});
			}
			CourseFolderNameResolution {
				course_id: candidate.identity.course_id,
				folder_name: candidate.folder_name,
				warnings,
			}
		})
		.collect())
}

/// ユーザー入力の保存用コース名をNFKCへ揃え、単一Windowsフォルダ名として検証する。
pub fn normalize_course_folder_override(value: &str) -> EngineResult<String> {
	let normalized = value.nfkc().collect::<String>();
	let normalized = collapse_whitespace(&normalized);
	validate_windows_component("folder_name", &normalized)?;
	if utf16_len(&normalized) > COURSE_FOLDER_MAX_UTF16_UNITS {
		return Err(EngineError::InvalidInput {
			field: "folder_name".to_string(),
			reason: format!(
				"コースフォルダ名はUTF-16で{COURSE_FOLDER_MAX_UTF16_UNITS}文字以内にしてください"
			),
		});
	}
	Ok(normalized)
}

/// Windows上で同じコースフォルダ名として扱うかを、NFKC・大文字小文字を揃えて比較する。
pub fn course_folder_names_equal(left: &str, right: &str) -> bool {
	comparison_key(left) == comparison_key(right)
}

fn validate_identities(courses: &[CourseFolderIdentity<'_>]) -> EngineResult<()> {
	let mut course_ids = BTreeSet::new();
	let mut stable_ids = BTreeSet::new();
	for course in courses {
		if !course_ids.insert(course.course_id) || !stable_ids.insert(course.stable_id) {
			return Err(EngineError::RuleConflict {
				reason: "コースIDまたはMoodle安定IDが重複しています".to_string(),
			});
		}
	}
	Ok(())
}

fn collision_groups(candidates: &[FolderCandidate<'_>]) -> BTreeMap<String, Vec<usize>> {
	let mut groups = BTreeMap::<String, Vec<usize>>::new();
	for (index, candidate) in candidates.iter().enumerate() {
		groups
			.entry(comparison_key(&candidate.folder_name))
			.or_default()
			.push(index);
	}
	groups
}

fn distinctive_alias(
	index: usize,
	group: &[usize],
	candidates: &[FolderCandidate<'_>],
) -> Option<String> {
	let own = alias_tokens(
		candidates[index].identity.name,
		&candidates[index].folder_name,
	);
	let other_tokens = group
		.iter()
		.filter(|other| **other != index)
		.flat_map(|other| {
			alias_tokens(
				candidates[*other].identity.name,
				&candidates[*other].folder_name,
			)
		})
		.map(|token| comparison_key(&token))
		.collect::<BTreeSet<_>>();
	own.into_iter()
		.find(|token| !other_tokens.contains(&comparison_key(token)))
		.map(|token| truncate_to_utf16(&token, MAX_ALIAS_SUFFIX_UTF16_UNITS))
}

fn alias_tokens(original: &str, simplified: &str) -> Vec<String> {
	let normalized = normalize_folder_text(original);
	let simplified_tokens = simplified
		.unicode_words()
		.map(comparison_key)
		.collect::<BTreeSet<_>>();
	let mut seen = BTreeSet::new();
	normalized
		.unicode_words()
		.map(sanitize_generated_component)
		.filter(|token| !token.is_empty())
		.filter(|token| !simplified_tokens.contains(&comparison_key(token)))
		.filter(|token| seen.insert(comparison_key(token)))
		.collect()
}

fn ensure_unique_final_names(candidates: &mut [FolderCandidate<'_>]) -> EngineResult<()> {
	let duplicate_groups = collision_groups(candidates)
		.into_values()
		.filter(|group| group.len() > 1)
		.collect::<Vec<_>>();
	for group in duplicate_groups {
		if group
			.iter()
			.filter(|index| candidates[**index].is_override)
			.count() > 1
		{
			return Err(EngineError::RuleConflict {
				reason: "利用者が指定したコースフォルダ名が重複しています".to_string(),
			});
		}
		for index in group {
			if candidates[index].is_override {
				continue;
			}
			let unique_source = format!(
				"{}:{}:{}",
				candidates[index].identity.stable_id,
				candidates[index].identity.course_id,
				candidates[index].identity.name
			);
			let suffix = stable_hash(&unique_source);
			let base = candidates[index].folder_name.clone();
			candidates[index].folder_name = append_suffix(&base, &suffix);
			candidates[index].had_conflict = true;
		}
	}

	let unique_count = candidates
		.iter()
		.map(|candidate| comparison_key(&candidate.folder_name))
		.collect::<BTreeSet<_>>()
		.len();
	if unique_count != candidates.len() {
		return Err(EngineError::RuleConflict {
			reason: "コースフォルダ名を一意にできませんでした".to_string(),
		});
	}
	Ok(())
}

fn append_suffix(base: &str, suffix: &str) -> String {
	let suffix = sanitize_generated_component(suffix);
	let suffix = truncate_to_utf16(&suffix, MAX_ALIAS_SUFFIX_UTF16_UNITS);
	let separator_units = 1;
	let base_budget =
		COURSE_FOLDER_MAX_UTF16_UNITS.saturating_sub(utf16_len(&suffix) + separator_units);
	let base = truncate_to_utf16(base, base_budget);
	format!("{base}_{suffix}")
}

fn shorten_with_stable_hash(value: &str, stable_id: &str) -> String {
	let suffix = stable_hash(&format!("{stable_id}:{value}"));
	append_suffix(value, &suffix)
}

fn truncate_to_utf16(value: &str, max_units: usize) -> String {
	if utf16_len(value) <= max_units {
		return value.to_string();
	}
	let mut result = String::new();
	for boundary in value.split_word_bounds() {
		if utf16_len(&result) + utf16_len(boundary) > max_units {
			break;
		}
		result.push_str(boundary);
	}
	let result = result.trim_end_matches([' ', '.', '-', '_']).trim();
	if !result.is_empty() {
		return result.to_string();
	}

	let mut fallback = String::new();
	for grapheme in value.graphemes(true) {
		if utf16_len(&fallback) + utf16_len(grapheme) > max_units {
			break;
		}
		fallback.push_str(grapheme);
	}
	fallback.trim_end_matches([' ', '.', '-', '_']).to_string()
}

fn sanitize_generated_component(value: &str) -> String {
	sanitize_normalized_component(value, "course")
}

fn sanitize_normalized_component(value: &str, reserved_prefix: &str) -> String {
	let mut sanitized = String::new();
	let mut previous_path_separator = false;
	for character in value.chars() {
		if matches!(character, '/' | '\\') {
			if !previous_path_separator {
				sanitized.push('・');
			}
			previous_path_separator = true;
			continue;
		}
		previous_path_separator = false;
		if character.is_control() || r#"<>:"|?*"#.contains(character) {
			sanitized.push(' ');
		} else {
			sanitized.push(character);
		}
	}
	let sanitized = collapse_whitespace(&sanitized)
		.trim_end_matches(['.', ' '])
		.to_string();
	if sanitized.is_empty() {
		return String::new();
	}
	let stem = sanitized.split('.').next().unwrap_or(&sanitized);
	if is_windows_reserved_name(stem) {
		format!("{reserved_prefix}-{sanitized}")
	} else {
		sanitized
	}
}

fn non_empty_or(value: String, fallback: &str) -> String {
	if value.is_empty() {
		fallback.to_string()
	} else {
		value
	}
}

fn normalize_folder_text(value: &str) -> String {
	let compatible = value
		.nfkc()
		.filter(|character| !is_emoji_character(*character))
		.collect::<String>();
	collapse_whitespace(&compatible)
}

fn collapse_whitespace(value: &str) -> String {
	value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_emoji_character(character: char) -> bool {
	matches!(
		character,
		'\u{200d}' | '\u{20e3}' | '\u{fe0f}'
			| '\u{2600}'..='\u{27bf}'
			| '\u{1f000}'..='\u{1faff}'
	)
}

fn normalize_stable_id(value: &str) -> String {
	let normalized = normalize_folder_text(value);
	let mut result = String::new();
	let mut previous_hyphen = false;
	for character in normalized.chars() {
		let replace =
			character.is_whitespace() || r#"<>:"/\|?*()[]"#.contains(character) || character == '-';
		if replace {
			if !previous_hyphen && !result.is_empty() {
				result.push('-');
			}
			previous_hyphen = true;
		} else {
			result.push(character);
			previous_hyphen = false;
		}
	}
	let result = result.trim_matches('-');
	if result.is_empty() {
		stable_hash(value)
	} else {
		truncate_to_utf16(result, MAX_ALIAS_SUFFIX_UTF16_UNITS)
	}
}

fn comparison_key(value: &str) -> String {
	normalize_folder_text(value).to_lowercase()
}

fn stable_hash(value: &str) -> String {
	let hash = value.chars().fold(2_166_136_261_u32, |hash, character| {
		(hash ^ character as u32).wrapping_mul(16_777_619)
	});
	format!("course-{}", base36(hash))
}

fn base36(mut value: u32) -> String {
	if value == 0 {
		return "0".to_string();
	}
	let mut result = Vec::new();
	while value > 0 {
		let digit = (value % 36) as u8;
		result.push(if digit < 10 {
			char::from(b'0' + digit)
		} else {
			char::from(b'a' + digit - 10)
		});
		value /= 36;
	}
	result.into_iter().rev().collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn identity<'a>(
		course_id: i64,
		name: &'a str,
		stable_id: &'a str,
		override_name: Option<&'a str>,
	) -> CourseFolderIdentity<'a> {
		CourseFolderIdentity {
			course_id,
			name,
			stable_id,
			folder_name_override: override_name,
		}
	}

	#[test]
	fn removes_only_clear_supplemental_notes() {
		for (input, expected) in [
			("情報科学📚（2026年度・前期）", "情報科学"),
			("統計学 (担当: 山田)", "統計学"),
			("第4回[配布資料]🔬", "第4回"),
			("情報科学（2026）", "情報科学"),
			("情報科学（通年）", "情報科学"),
		] {
			assert_eq!(folder_segment(input), expected, "入力: {input}");
		}
	}

	#[test]
	fn preserves_important_ambiguous_and_nested_bracket_content() {
		for (input, expected) in [
			("総合科目（物理）", "総合科目(物理)"),
			("総合科目（物理・前期）", "総合科目(物理・前期)"),
			("英語［Aクラス］", "英語[Aクラス]"),
			("情報科学（追加）", "情報科学(追加)"),
			("プログラミング（演習［配布資料］）", "プログラミング(演習)"),
		] {
			assert_eq!(folder_segment(input), expected, "入力: {input}");
		}
	}

	#[test]
	fn preserves_unbalanced_or_crossed_brackets() {
		for input in [
			"情報科学（前期",
			"情報科学（［前期）］",
			"情報科学（補足［前期］",
		] {
			assert_eq!(folder_segment(input), input.nfkc().collect::<String>());
		}
	}

	#[test]
	fn sanitizes_path_separators_and_windows_names() {
		for (input, expected) in [
			("情報科学①", "情報科学1"),
			("C/C++演習", "C・C++演習"),
			("情報応用2A\\2B", "情報応用2A・2B"),
			("CON", "course-CON"),
		] {
			assert_eq!(folder_segment(input), expected, "入力: {input}");
		}
	}

	#[test]
	fn keeps_important_bracket_content_as_distinct_names() {
		let courses = [
			identity(1, "英語（A）", "course-english-a", None),
			identity(2, "英語［B］", "course-english-b", None),
		];
		let resolved = resolve_course_folder_names(&courses).unwrap();

		assert_eq!(resolved[0].folder_name, "英語(A)");
		assert_eq!(resolved[1].folder_name, "英語[B]");
		assert!(resolved.iter().all(|course| course.warnings.is_empty()));
	}

	#[test]
	fn disambiguates_names_after_supplemental_notes_are_removed() {
		let courses = [
			identity(1, "情報科学（2026年度・前期）", "course-info-2026", None),
			identity(2, "情報科学（担当: 山田）", "course-info-yamada", None),
		];
		let resolved = resolve_course_folder_names(&courses).unwrap();

		assert_ne!(resolved[0].folder_name, resolved[1].folder_name);
		assert!(resolved
			.iter()
			.all(|course| course.warnings[0].code == CourseFolderNameWarningCode::NameConflict));
	}

	#[test]
	fn exact_duplicate_names_use_stable_ids_and_never_collide() {
		let courses = [
			identity(1, "英語IIB", "course-a", None),
			identity(2, "英語IIB", "course-b", None),
		];
		let resolved = resolve_course_folder_names(&courses).unwrap();

		assert_eq!(resolved[0].folder_name, "英語IIB_course-a");
		assert_eq!(resolved[1].folder_name, "英語IIB_course-b");
		assert_ne!(resolved[0].folder_name, resolved[1].folder_name);
	}

	#[test]
	fn preserves_one_override_and_renames_the_generated_collision() {
		let courses = [
			identity(1, "英語IIB", "course-a", Some("英語IIB")),
			identity(2, "英語IIB", "course-b", None),
		];
		let resolved = resolve_course_folder_names(&courses).unwrap();

		assert_eq!(resolved[0].folder_name, "英語IIB");
		assert_eq!(resolved[1].folder_name, "英語IIB_course-b");
		assert!(resolved[0].warnings.is_empty());
		assert_eq!(resolved[1].warnings.len(), 1);
	}

	#[test]
	fn rejects_duplicate_user_overrides() {
		let courses = [
			identity(1, "英語A", "course-a", Some("英語")),
			identity(2, "英語B", "course-b", Some("英語")),
		];
		assert!(matches!(
			resolve_course_folder_names(&courses),
			Err(EngineError::RuleConflict { .. })
		));
	}

	#[test]
	fn shortens_long_names_on_word_or_grapheme_boundaries_with_a_stable_suffix() {
		let long_name = "高度情報処理演習 データベース設計と分散システム ".repeat(8);
		let courses = [identity(1, &long_name, "course-long", None)];
		let resolved = resolve_course_folder_names(&courses).unwrap();

		assert!(utf16_len(&resolved[0].folder_name) <= COURSE_FOLDER_MAX_UTF16_UNITS);
		assert!(resolved[0].folder_name.contains("course-"));
		assert_eq!(
			resolved[0].warnings[0].code,
			CourseFolderNameWarningCode::NameShortened
		);
	}
}
