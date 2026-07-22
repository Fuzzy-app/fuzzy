//! 保存パターン推定方式の共通インターフェースと組み込み実装。
//!
//! すべての方式は同じ走査結果を受け取り、同じ[`SavePatternGuess`]を返す。
//! 呼び出し側は方式固有のロジックへ依存せず、用途や検証結果に応じて切り替えられる。

use std::collections::BTreeMap;
use std::fmt::Debug;
use std::path::Component;

use crate::error::EngineResult;
use crate::section::{parse_section_file_prefix, parse_section_name, SectionMatch};
use crate::types::{FileEntry, SavePatternGuess};

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
			let Some(has_section_folder) = add_folder_evidence(entry, evidence) else {
				return;
			};
			if has_section_folder {
				return;
			}
			if parse_section_file_prefix(&entry.file_name).is_some() {
				add_evidence(
					evidence,
					PatternTemplate::file_name_section(),
					FREQUENCY_EVIDENCE_WEIGHT,
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
			let Some(has_section_folder) = add_folder_evidence(entry, evidence) else {
				return;
			};
			if has_section_folder {
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
			add_evidence(evidence, PatternTemplate::file_name_section(), weight);
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

	fn file_name_section() -> Self {
		Self {
			directory: COURSE_DIRECTORY_TEMPLATE.to_string(),
			file_name: Some(SECTION_FILE_NAME_TEMPLATE.to_string()),
		}
	}
}

#[derive(Debug, Default)]
struct Evidence {
	matched_count: usize,
	weighted_support: f64,
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

	let minimum_support = if entries.len() >= 3 { 2 } else { 1 };
	let mut guesses = evidence
		.into_iter()
		.filter(|(_, evidence)| evidence.matched_count >= minimum_support)
		.map(|(template, evidence)| SavePatternGuess {
			directory_template: template.directory,
			file_name_template: template.file_name,
			confidence: (evidence.weighted_support / entries.len() as f64).clamp(0.0, 1.0),
			matched_count: evidence.matched_count,
		})
		.collect::<Vec<_>>();
	sort_guesses(&mut guesses);
	Ok(guesses)
}

/// 対応する科目階層を認識できた場合、セクションフォルダの有無を返す。
fn add_folder_evidence(
	entry: &FileEntry,
	evidence: &mut BTreeMap<PatternTemplate, Evidence>,
) -> Option<bool> {
	let parent = entry.relative_path.parent()?;
	let segments = parent
		.components()
		.map(|component| match component {
			Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
			_ => None,
		})
		.collect::<Option<Vec<_>>>()?;

	let (directory_template, has_section_folder) = match segments.as_slice() {
		[_course] => (COURSE_DIRECTORY_TEMPLATE.to_string(), false),
		[_course, section_name] => {
			let section = parse_section_name(section_name)?;
			(
				format!(
					"{COURSE_DIRECTORY_TEMPLATE}/{}",
					section_directory_segment(&section)?
				),
				true,
			)
		}
		_ => return None,
	};

	add_evidence(
		evidence,
		PatternTemplate::directory_only(directory_template),
		FOLDER_EVIDENCE_WEIGHT,
	);
	Some(has_section_folder)
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
) {
	let item = evidence.entry(template).or_default();
	item.matched_count += 1;
	item.weighted_support += weight;
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
