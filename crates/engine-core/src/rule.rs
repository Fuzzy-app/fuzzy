//! RuleEngine — グローバル／コース別ルールの照合・違反検出。
//!
//! SQLiteへの読み書きは永続化層へ委ね、このモジュールはルールの検証・テンプレート展開・
//! パス照合だけを担当する。違反時もファイルの移動や削除は行わない。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::error::{EngineError, EngineResult};
use crate::types::{RuleContext, RuleFileEntry, RuleSet, RuleViolation};

mod template;

use template::{
	join_relative_path, pattern_tokens, relative_components, validate_base_folder,
	validate_file_name, validate_pattern, ExpectedRelativePath,
};

/// 保存ルールの照合・違反検出を担うトレイト。
///
/// 違反は警告表示用のデータとして返すのみで、ファイルの自動移動・自動削除は行わない。
pub trait RuleEngine {
	/// 単一ファイルをルールと照合し、違反があれば返す（違反なしなら空Vec）。
	fn check_file(
		&self,
		entry: &RuleFileEntry,
		base_folder: &Path,
		rules: &RuleSet,
	) -> EngineResult<Vec<RuleViolation>>;

	/// 走査済みファイル一式をまとめて照合し、全違反を返す。
	fn check_all(
		&self,
		entries: &[RuleFileEntry],
		base_folder: &Path,
		rules: &RuleSet,
	) -> EngineResult<Vec<RuleViolation>>;

	/// ルールに基づく、保存ルート以下の相対ファイルパスを返す。
	fn suggest_save_path(
		&self,
		file_name: &str,
		context: &RuleContext,
		rules: &RuleSet,
	) -> EngineResult<String>;
}

/// ファイルシステムを変更しない既定のルールエンジン。
#[derive(Debug, Default)]
pub struct DefaultRuleEngine;

impl RuleEngine for DefaultRuleEngine {
	fn check_file(
		&self,
		entry: &RuleFileEntry,
		base_folder: &Path,
		rules: &RuleSet,
	) -> EngineResult<Vec<RuleViolation>> {
		validate_rule_set(rules)?;
		validate_base_folder(base_folder)?;
		Ok(check_file_with_valid_rules(entry, base_folder, rules)
			.into_iter()
			.collect())
	}

	fn check_all(
		&self,
		entries: &[RuleFileEntry],
		base_folder: &Path,
		rules: &RuleSet,
	) -> EngineResult<Vec<RuleViolation>> {
		validate_rule_set(rules)?;
		validate_base_folder(base_folder)?;
		Ok(entries
			.iter()
			.filter_map(|entry| check_file_with_valid_rules(entry, base_folder, rules))
			.collect())
	}

	fn suggest_save_path(
		&self,
		file_name: &str,
		context: &RuleContext,
		rules: &RuleSet,
	) -> EngineResult<String> {
		validate_rule_set(rules)?;
		validate_file_name(file_name)?;
		let rule = effective_rule(rules, context.course_id);
		let context = context_with_file_assignment(context, file_name);
		let expected = ExpectedRelativePath::new(rule.pattern, &context)?;
		expected.render_complete()
	}
}

/// グローバルルールとコース別例外ルールの定義を検証する。
///
/// API境界と同じ既知トークン・Windowsパス制約を適用する。コース別ルールは、
/// `split_by_section` と実効テンプレートの `{section}` の有無も一致させる。
pub fn validate_rule_set(rules: &RuleSet) -> EngineResult<()> {
	validate_pattern("global_pattern_template", &rules.global_pattern_template)?;

	let mut course_ids = BTreeSet::new();
	for course_override in &rules.course_overrides {
		if !course_ids.insert(course_override.course_id) {
			return Err(EngineError::RuleConflict {
				reason: format!(
					"コースID {} の例外ルールが重複しています",
					course_override.course_id
				),
			});
		}

		let pattern = course_override
			.pattern_template
			.as_deref()
			.map(str::trim)
			.filter(|pattern| !pattern.is_empty())
			.unwrap_or(&rules.global_pattern_template);
		validate_pattern("course_override.pattern_template", pattern)?;
		let has_section = pattern_tokens(pattern)?
			.iter()
			.any(|token| token == "section");
		if course_override.split_by_section != has_section {
			let reason = if course_override.split_by_section {
				"回ごとに分ける例外ルールには {section} が必要です"
			} else {
				"回ごとに分けない例外ルールでは {section} を使用できません"
			};
			return Err(EngineError::RuleConflict {
				reason: format!("コースID {}: {reason}", course_override.course_id),
			});
		}
	}

	Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleSource {
	Global,
	CourseOverride,
}

impl RuleSource {
	fn label(self) -> &'static str {
		match self {
			Self::Global => "グローバルルール",
			Self::CourseOverride => "コース別例外ルール",
		}
	}
}

#[derive(Debug, Clone, Copy)]
struct EffectiveRule<'a> {
	pattern: &'a str,
	source: RuleSource,
}

fn effective_rule(rules: &RuleSet, course_id: Option<i64>) -> EffectiveRule<'_> {
	let course_override = course_id.and_then(|course_id| {
		rules
			.course_overrides
			.iter()
			.find(|course_override| course_override.course_id == course_id)
	});
	let Some(course_override) = course_override else {
		return EffectiveRule {
			pattern: rules.global_pattern_template.trim(),
			source: RuleSource::Global,
		};
	};
	let pattern = course_override
		.pattern_template
		.as_deref()
		.map(str::trim)
		.filter(|pattern| !pattern.is_empty())
		.unwrap_or_else(|| rules.global_pattern_template.trim());
	EffectiveRule {
		pattern,
		source: RuleSource::CourseOverride,
	}
}

fn check_file_with_valid_rules(
	entry: &RuleFileEntry,
	base_folder: &Path,
	rules: &RuleSet,
) -> Option<RuleViolation> {
	let rule = effective_rule(rules, entry.context.course_id);
	if let Err(error) = validate_file_name(&entry.file_name) {
		return Some(violation(
			entry,
			format!("保存ファイル名が不正なため照合できません: {error}"),
			None,
		));
	}
	let context = context_with_file_assignment(&entry.context, &entry.file_name);
	let expected = match ExpectedRelativePath::new(rule.pattern, &context) {
		Ok(expected) => expected,
		Err(error) => {
			return Some(violation(
				entry,
				format!(
					"{}との照合に必要な情報が不正です: {error}",
					rule.source.label()
				),
				None,
			));
		}
	};
	let suggested_path = expected
		.render_complete()
		.ok()
		.map(|relative| join_relative_path(base_folder, &relative).join(&entry.file_name));
	let Some(actual_components) = relative_components(base_folder, &entry.saved_path) else {
		return Some(violation(
			entry,
			"保存ルート外にあるため、保存ルールに適合していません".to_string(),
			suggested_path,
		));
	};

	let Some((actual_file_name, actual_folders)) = actual_components.split_last() else {
		return Some(violation(
			entry,
			"保存先にファイル名が含まれていないため照合できません".to_string(),
			suggested_path,
		));
	};
	if !expected.matches(actual_folders)
		|| actual_file_name.to_lowercase() != entry.file_name.to_lowercase()
	{
		return Some(violation(
			entry,
			format!(
				"{}「{}」で定めた保存先・命名から外れています",
				rule.source.label(),
				rule.pattern
			),
			suggested_path,
		));
	}

	let missing = expected.missing_tokens();
	if !missing.is_empty() {
		return Some(violation(
			entry,
			format!(
				"{}との照合に必要な情報（{}）が不足しています",
				rule.source.label(),
				missing.join("、")
			),
			None,
		));
	}

	None
}

fn context_with_file_assignment(context: &RuleContext, file_name: &str) -> RuleContext {
	let mut context = context.clone();
	if context.assignment.is_none() {
		context.assignment = Path::new(file_name)
			.file_stem()
			.map(|stem| stem.to_string_lossy().into_owned());
	}
	context
}

fn violation(
	entry: &RuleFileEntry,
	reason: String,
	suggested_path: Option<PathBuf>,
) -> RuleViolation {
	RuleViolation {
		file_id: entry.file_id,
		saved_path: entry.saved_path.clone(),
		reason,
		suggested_path,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::types::{CourseRuleOverride, RuleContext, RuleFileEntry, RuleSet};

	fn rules() -> RuleSet {
		RuleSet {
			global_pattern_template: "{term}/{course}/第{section}回".to_string(),
			course_overrides: vec![CourseRuleOverride {
				course_id: 4,
				split_by_section: false,
				pattern_template: Some("{term}/{course}".to_string()),
				note: None,
			}],
		}
	}

	fn context(course_id: i64, course_name: &str, section: Option<&str>) -> RuleContext {
		RuleContext {
			course_id: Some(course_id),
			course_name: Some(course_name.to_string()),
			year: Some("2026".to_string()),
			term: Some("2026前期".to_string()),
			assignment: Some("正規化".to_string()),
			section: section.map(str::to_string),
		}
	}

	fn entry(id: i64, path: &str, context: RuleContext) -> RuleFileEntry {
		RuleFileEntry {
			file_id: Some(id),
			saved_path: PathBuf::from(path),
			file_name: "第4回_正規化.pdf".to_string(),
			context,
		}
	}

	#[test]
	fn suggests_global_and_course_override_paths() {
		let global = DefaultRuleEngine
			.suggest_save_path(
				"第4回_正規化.pdf",
				&context(2, "データベース", Some("4")),
				&rules(),
			)
			.unwrap();
		assert_eq!(global, "2026前期\\データベース\\第4回");

		let course_override = DefaultRuleEngine
			.suggest_save_path(
				"中間プレゼン資料.pptx",
				&context(4, "アプリ演習", None),
				&rules(),
			)
			.unwrap();
		assert_eq!(course_override, "2026前期\\アプリ演習");
	}

	#[test]
	fn uses_the_file_stem_for_a_missing_assignment_value() {
		let assignment_rules = RuleSet {
			global_pattern_template: "{term}/{course}/{assignment}".to_string(),
			course_overrides: Vec::new(),
		};
		let mut course_context = context(2, "データベース", Some("4"));
		course_context.assignment = None;

		let suggestion = DefaultRuleEngine
			.suggest_save_path("第4回_正規化.pdf", &course_context, &assignment_rules)
			.unwrap();

		assert_eq!(suggestion, "2026前期\\データベース\\第4回_正規化");
	}

	#[test]
	fn detects_a_path_outside_the_global_rule() {
		let violations = DefaultRuleEngine
			.check_file(
				&entry(
					4,
					r"C:\Users\sample\Documents\大学\正規化_メモ.docx",
					context(2, "データベース", None),
				),
				Path::new(r"C:\Users\sample\Documents\大学"),
				&rules(),
			)
			.unwrap();

		assert_eq!(violations.len(), 1);
		assert!(violations[0].reason.contains("グローバルルール"));
		assert!(!violations[0].reason.contains(r"C:\Users"));
	}

	#[test]
	fn accepts_a_course_override_without_a_section() {
		let mut course_context = context(4, "アプリ演習", None);
		course_context.assignment = Some("中間プレゼン".to_string());
		let mut file = entry(
			6,
			r"C:\Users\sample\Documents\大学\2026前期\アプリ演習\アプリ演習_中間プレゼン資料.pptx",
			course_context,
		);
		file.file_name = "アプリ演習_中間プレゼン資料.pptx".to_string();

		assert!(DefaultRuleEngine
			.check_file(
				&file,
				Path::new(r"C:\Users\sample\Documents\大学"),
				&rules(),
			)
			.unwrap()
			.is_empty());
	}

	#[test]
	fn reports_missing_metadata_even_when_the_structure_looks_valid() {
		let file = entry(
			3,
			r"C:\Users\sample\Documents\大学\2026前期\データベース\第4回\第4回_正規化.pdf",
			context(2, "データベース", None),
		);
		let violations = DefaultRuleEngine
			.check_file(
				&file,
				Path::new(r"C:\Users\sample\Documents\大学"),
				&rules(),
			)
			.unwrap();

		assert_eq!(violations.len(), 1);
		assert!(violations[0].reason.contains("セクション"));
	}

	#[test]
	fn rejects_unknown_tokens_and_conflicting_overrides() {
		let mut invalid = rules();
		invalid.global_pattern_template = "{term}/{course}/{unknown}".to_string();
		assert!(matches!(
			validate_rule_set(&invalid),
			Err(EngineError::InvalidInput { .. })
		));

		let mut conflicting = rules();
		conflicting.course_overrides[0].pattern_template =
			Some("{term}/{course}/第{section}回".to_string());
		assert!(matches!(
			validate_rule_set(&conflicting),
			Err(EngineError::RuleConflict { .. })
		));
	}
}
