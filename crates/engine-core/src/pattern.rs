//! 保存パターン推定方式の共通インターフェースと組み込み実装。
//!
//! すべての方式は同じ走査結果を受け取り、同じ[`SavePatternGuess`]を返す。
//! 呼び出し側は方式固有のロジックへ依存せず、用途や検証結果に応じて切り替えられる。

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Debug;
use std::path::{Component, Path, PathBuf};

use crate::error::EngineResult;
use crate::section::{parse_section_file_prefix, parse_section_name, SectionMatch};
use crate::types::{FileEntry, SavePatternGuess};
use unicode_normalization::UnicodeNormalization;

const COURSE_DIRECTORY_TEMPLATE: &str = "{course}";
const SECTION_FILE_NAME_TEMPLATE: &str = "{section}_{filename}";
const FREQUENCY_EVIDENCE_WEIGHT: f64 = 1.0;
const FOLDER_EVIDENCE_WEIGHT: f64 = 1.0;
const EXPLICIT_FILE_NAME_EVIDENCE_WEIGHT: f64 = 0.6;
const NUMERIC_FILE_NAME_EVIDENCE_WEIGHT: f64 = 0.25;

/// 組み込み保存パターン推定方式。
///
/// 安定した設定キーは[`Self::key`]で取得する。将来のSQLite設定等では表示名ではなく
/// このキーを保存し、名称変更の影響を避ける。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PatternEstimatorKind {
	/// 明示的な親フォルダ構成だけを根拠にする保守的な方式。
	FolderOnly,
	/// 各ファイルの根拠を同じ1票として数える、issue #38当初実装との互換方式。
	#[default]
	Frequency,
	/// フォルダ、明示的なファイル名、数字だけの接頭辞で証拠の強さを変える方式。
	EvidenceWeighted,
}

impl PatternEstimatorKind {
	/// 利用可能な組み込み方式。
	pub const ALL: [Self; 3] = [Self::FolderOnly, Self::Frequency, Self::EvidenceWeighted];

	/// 設定保存に使用できる安定キー。
	pub const fn key(self) -> &'static str {
		match self {
			Self::FolderOnly => "folder_only",
			Self::Frequency => "frequency",
			Self::EvidenceWeighted => "evidence_weighted",
		}
	}

	/// 安定キーから組み込み方式を復元する。
	pub fn from_key(key: &str) -> Option<Self> {
		Self::ALL.into_iter().find(|kind| kind.key() == key)
	}
}

/// 保存パターン推定方式が実装する共通インターフェース。
///
/// 学習済みモデル等はモデル状態を実装型のフィールドとして保持できる。推定時の
/// 入出力は方式によらず固定し、`ScanEngine`やUIへ方式固有型を漏らさない。
pub trait PatternEstimator: Debug + Send + Sync {
	/// ログ・診断表示に使用する安定ID。
	fn id(&self) -> &'static str;

	/// 走査済みファイルから保存パターン候補を確からしさ順に返す。
	fn estimate(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>>;
}

/// 組み込み方式を生成する。
pub fn built_in_estimator(kind: PatternEstimatorKind) -> Box<dyn PatternEstimator> {
	match kind {
		PatternEstimatorKind::FolderOnly => Box::new(FolderOnlyPatternEstimator),
		PatternEstimatorKind::Frequency => Box::new(FrequencyPatternEstimator),
		PatternEstimatorKind::EvidenceWeighted => Box::new(EvidenceWeightedPatternEstimator),
	}
}

/// 明示的な親フォルダ構成だけを使用する方式。
#[derive(Debug, Default)]
pub struct FolderOnlyPatternEstimator;

impl PatternEstimator for FolderOnlyPatternEstimator {
	fn id(&self) -> &'static str {
		PatternEstimatorKind::FolderOnly.key()
	}

	fn estimate(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>> {
		estimate_with(entries, |entry, evidence| {
			add_folder_evidence(entry, evidence);
		})
	}
}

/// すべての根拠を同じ1票として扱う頻度方式。
#[derive(Debug, Default)]
pub struct FrequencyPatternEstimator;

impl PatternEstimator for FrequencyPatternEstimator {
	fn id(&self) -> &'static str {
		PatternEstimatorKind::Frequency.key()
	}

	fn estimate(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>> {
		estimate_with(entries, |entry, evidence| {
			let Some(folder) = add_folder_evidence(entry, evidence) else {
				return;
			};
			if folder.has_section_folder {
				return;
			}
			if parse_section_file_prefix(&entry.file_name).is_some() {
				add_evidence(
					evidence,
					PatternTemplate::file_name_section(folder.directory_template),
					FREQUENCY_EVIDENCE_WEIGHT,
					entry,
				);
			}
		})
	}
}

/// 根拠の強さに応じてconfidenceへの寄与を変える方式。
///
/// 数字だけの接頭辞は年度・日付・資料番号等との誤認可能性があるため、明示的な
/// セクション表記より弱く扱う。重みは比較検証用の暫定値である。
#[derive(Debug, Default)]
pub struct EvidenceWeightedPatternEstimator;

impl PatternEstimator for EvidenceWeightedPatternEstimator {
	fn id(&self) -> &'static str {
		PatternEstimatorKind::EvidenceWeighted.key()
	}

	fn estimate(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>> {
		estimate_with(entries, |entry, evidence| {
			let Some(folder) = add_folder_evidence(entry, evidence) else {
				return;
			};
			if folder.has_section_folder {
				return;
			}
			let Some(section) = parse_section_file_prefix(&entry.file_name) else {
				return;
			};
			let weight = if section.rule_id == "numeric_file_prefix" {
				NUMERIC_FILE_NAME_EVIDENCE_WEIGHT
			} else {
				EXPLICIT_FILE_NAME_EVIDENCE_WEIGHT
			};
			add_evidence(
				evidence,
				PatternTemplate::file_name_section(folder.directory_template),
				weight,
				entry,
			);
		})
	}
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct PatternTemplate {
	directory: String,
	file_name: Option<String>,
}

impl PatternTemplate {
	fn directory_only(directory: String) -> Self {
		Self {
			directory,
			file_name: None,
		}
	}

	fn file_name_section(directory: String) -> Self {
		Self {
			directory,
			file_name: Some(SECTION_FILE_NAME_TEMPLATE.to_string()),
		}
	}
}

#[derive(Debug, Default)]
struct Evidence {
	matched_count: usize,
	weighted_support: f64,
	representative_paths: BTreeSet<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FolderEvidence {
	directory_template: String,
	has_section_folder: bool,
}

/// 保存ルートからの相対パスを、年度・学期・科目・授業回の役割へ分類した結果。
///
/// 強い根拠を持たないセグメントが複数ある場合は、科目を勝手に選ばず`None`を返す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathRoleClassification {
	pub directory_template: String,
	pub course_segment_index: usize,
	pub academic_year: Option<i64>,
	pub term: Option<String>,
	pub has_section_folder: bool,
}

fn estimate_with(
	entries: &[FileEntry],
	mut collect: impl FnMut(&FileEntry, &mut BTreeMap<PatternTemplate, Evidence>),
) -> EngineResult<Vec<SavePatternGuess>> {
	if entries.len() < 2 {
		return Ok(Vec::new());
	}

	let mut evidence = BTreeMap::new();
	for entry in entries {
		collect(entry, &mut evidence);
	}

	let classified = entries
		.iter()
		.filter_map(|entry| classify_relative_path(&entry.relative_path))
		.collect::<Vec<_>>();
	let classified_count = classified.len();
	let mut directory_evaluated_counts = BTreeMap::<String, usize>::new();
	for classification in &classified {
		*directory_evaluated_counts
			.entry(classification.directory_template.clone())
			.or_default() += 1;
	}
	let minimum_support = if entries.len() >= 3 { 2 } else { 1 };
	let mut guesses = evidence
		.into_iter()
		.filter(|(_, evidence)| evidence.matched_count >= minimum_support)
		.filter_map(|(template, evidence)| {
			let evaluated_count = if template.file_name.is_some() {
				directory_evaluated_counts
					.get(&template.directory)
					.copied()
					.unwrap_or_default()
			} else {
				classified_count
			};
			let course_segment_index = template
				.directory
				.split(['/', '\\'])
				.position(|segment| segment.contains("{course}"))?;
			(evaluated_count > 0).then(|| SavePatternGuess {
				directory_template: template.directory,
				file_name_template: template.file_name,
				course_segment_index,
				confidence: (evidence.weighted_support / evaluated_count as f64).clamp(0.0, 1.0),
				matched_count: evidence.matched_count,
				evaluated_count,
				representative_paths: evidence.representative_paths.into_iter().take(8).collect(),
			})
		})
		.collect::<Vec<_>>();
	sort_guesses(&mut guesses);
	Ok(guesses)
}

/// 対応する科目階層を認識できた場合、セクションフォルダの有無を返す。
fn add_folder_evidence(
	entry: &FileEntry,
	evidence: &mut BTreeMap<PatternTemplate, Evidence>,
) -> Option<FolderEvidence> {
	let classification = classify_relative_path(&entry.relative_path)?;

	add_evidence(
		evidence,
		PatternTemplate::directory_only(classification.directory_template.clone()),
		FOLDER_EVIDENCE_WEIGHT,
		entry,
	);
	Some(FolderEvidence {
		directory_template: classification.directory_template,
		has_section_folder: classification.has_section_folder,
	})
}

fn section_directory_segment(section: &SectionMatch) -> Option<String> {
	let number = section.number?.to_string();
	section
		.normalized_name
		.contains(&number)
		.then(|| section.normalized_name.replacen(&number, "{section}", 1))
}

fn add_evidence(
	evidence: &mut BTreeMap<PatternTemplate, Evidence>,
	template: PatternTemplate,
	weight: f64,
	entry: &FileEntry,
) {
	let item = evidence.entry(template).or_default();
	item.matched_count += 1;
	item.weighted_support += weight;
	if let Some(parent) = entry.relative_path.parent() {
		item.representative_paths.insert(parent.to_path_buf());
	}
}

/// ファイルの親階層を役割分類し、科目位置を一意に特定できた場合だけ返す。
pub fn classify_relative_path(relative_path: &Path) -> Option<PathRoleClassification> {
	let parent = relative_path.parent()?;
	let segments = parent
		.components()
		.map(|component| match component {
			Component::Normal(value) => value.to_str().map(str::trim),
			_ => None,
		})
		.collect::<Option<Vec<_>>>()?;
	if segments.is_empty() || segments.iter().any(|segment| segment.is_empty()) {
		return None;
	}

	let mut templates = Vec::with_capacity(segments.len());
	let mut unclassified = Vec::new();
	let mut academic_year = None;
	let mut term = None;
	let mut has_section_folder = false;
	for (index, segment) in segments.iter().enumerate() {
		if let Some((year, template)) = parse_academic_year_component(segment) {
			if academic_year.replace(year).is_some() {
				return None;
			}
			templates.push(template);
			continue;
		}
		if let Some(normalized_term) = normalize_term_component(segment) {
			if term.replace(normalized_term).is_some() {
				return None;
			}
			templates.push("{term}".to_string());
			continue;
		}
		if let Some(section) = parse_section_name(segment) {
			// 授業回フォルダーはファイルの直上だけを強い根拠として扱う。
			if index + 1 != segments.len() || has_section_folder {
				return None;
			}
			templates.push(section_directory_segment(&section)?);
			has_section_folder = true;
			continue;
		}
		unclassified.push(index);
		templates.push(String::new());
	}

	let [course_segment_index] = unclassified.as_slice() else {
		return None;
	};
	templates[*course_segment_index] = COURSE_DIRECTORY_TEMPLATE.to_string();
	Some(PathRoleClassification {
		directory_template: templates.join("/"),
		course_segment_index: *course_segment_index,
		academic_year,
		term,
		has_section_folder,
	})
}

/// `2026`、`2026年`、`2026年度`だけを暦年として認識する。
pub fn parse_academic_year_component(value: &str) -> Option<(i64, String)> {
	let normalized = value.trim().nfkc().collect::<String>();
	let (digits, template) = if let Some(digits) = normalized.strip_suffix("年度") {
		(digits, "{year}年度")
	} else if let Some(digits) = normalized.strip_suffix('年') {
		(digits, "{year}年")
	} else {
		(normalized.as_str(), "{year}")
	};
	if digits.len() != 4 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	digits
		.parse::<i64>()
		.ok()
		.filter(|year| (1900..=9999).contains(year))
		.map(|year| (year, template.to_string()))
}

/// 学期、年度付き学期、学年付き学期、クォーター表記を正規化する。
///
/// `2026前期`のように年度を含むフォルダー名も、分割せず学期全体として扱う。
/// 年度の正本は別フィールドなので、ここから年度を推測しない。
pub fn normalize_term_component(value: &str) -> Option<String> {
	let normalized = value.trim().nfkc().collect::<String>();
	if matches!(
		normalized.as_str(),
		"前期" | "後期" | "通年" | "春学期" | "秋学期" | "Spring" | "Fall"
	) {
		return Some(normalized);
	}
	let lower = normalized.to_ascii_lowercase();
	if matches!(lower.as_str(), "spring" | "fall") {
		return Some(normalized);
	}
	if let Some(number) = lower.strip_suffix('q') {
		return parse_quarter_number(number).map(|_| normalized);
	}
	if let Some(number) = normalized.strip_suffix("クォーター") {
		let number = number.strip_prefix('第').unwrap_or(number);
		return parse_quarter_number(number).map(|_| normalized);
	}
	for suffix in ["前期", "後期", "春学期", "秋学期"] {
		if let Some(prefix) = normalized.strip_suffix(suffix) {
			if parse_academic_year_component(prefix.trim()).is_some() {
				return Some(normalized);
			}
			let Some(grade) = prefix.strip_suffix('年') else {
				continue;
			};
			if grade.len() == 1
				&& grade
					.parse::<u8>()
					.ok()
					.is_some_and(|grade| (1..=9).contains(&grade))
			{
				return Some(normalized);
			}
		}
	}
	None
}

fn parse_quarter_number(value: &str) -> Option<u8> {
	value
		.parse::<u8>()
		.ok()
		.filter(|quarter| (1..=4).contains(quarter))
}

fn sort_guesses(guesses: &mut [SavePatternGuess]) {
	guesses.sort_by(|left, right| {
		right
			.confidence
			.total_cmp(&left.confidence)
			.then_with(|| right.matched_count.cmp(&left.matched_count))
			.then_with(|| left.directory_template.cmp(&right.directory_template))
			.then_with(|| left.file_name_template.cmp(&right.file_name_template))
	});
}
