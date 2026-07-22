use std::path::PathBuf;

use engine_core::pattern::{
	built_in_estimator, EvidenceWeightedPatternEstimator, FolderOnlyPatternEstimator,
	FrequencyPatternEstimator, PatternEstimator, PatternEstimatorKind,
};
use engine_core::scan::{ConfigurableScanEngine, ScanEngine};
use engine_core::types::{FileEntry, SavePatternGuess};

#[derive(Debug)]
struct ExperimentalEstimator;

impl PatternEstimator for ExperimentalEstimator {
	fn id(&self) -> &'static str {
		"experimental"
	}

	fn estimate(
		&self,
		_entries: &[FileEntry],
	) -> engine_core::error::EngineResult<Vec<SavePatternGuess>> {
		Ok(vec![SavePatternGuess {
			directory_template: "{course}".to_string(),
			file_name_template: Some("custom-{filename}".to_string()),
			confidence: 0.75,
			matched_count: 2,
		}])
	}
}

fn entry(relative_path: &str) -> FileEntry {
	let relative_path = PathBuf::from(relative_path);
	FileEntry {
		file_name: relative_path
			.file_name()
			.expect("ファイル名がある")
			.to_string_lossy()
			.into_owned(),
		path: PathBuf::from("C:/scan-root").join(&relative_path),
		relative_path,
		size: 1,
		modified_at: None,
	}
}

fn flat_numbered_entries() -> Vec<FileEntry> {
	vec![
		entry("データベース/01_講義資料.pdf"),
		entry("データベース/02_演習課題.pdf"),
	]
}

#[test]
fn all_estimators_share_the_same_input_and_output_contract() {
	let entries = flat_numbered_entries();
	for kind in PatternEstimatorKind::ALL {
		let estimator = built_in_estimator(kind);
		let guesses = estimator.estimate(&entries).expect("推定に成功する");
		assert!(!guesses.is_empty(), "方式: {}", kind.key());
		assert!(
			guesses.iter().all(|guess| {
				!guess.directory_template.contains("{filename}")
					&& (0.0..=1.0).contains(&guess.confidence)
			}),
			"方式: {}",
			kind.key()
		);
	}
}

#[test]
fn folder_only_ignores_file_name_markers() {
	let guesses = FolderOnlyPatternEstimator
		.estimate(&flat_numbered_entries())
		.expect("推定に成功する");

	assert_eq!(guesses.len(), 1);
	assert_eq!(guesses[0].directory_template, "{course}");
	assert_eq!(guesses[0].file_name_template, None);
	assert_eq!(guesses[0].confidence, 1.0);
}

#[test]
fn frequency_counts_numeric_file_markers_as_full_evidence() {
	let guesses = FrequencyPatternEstimator
		.estimate(&flat_numbered_entries())
		.expect("推定に成功する");
	let file_name_pattern = guesses
		.iter()
		.find(|guess| guess.file_name_template.as_deref() == Some("{section}_{filename}"))
		.expect("ファイル名パターン候補がある");

	assert_eq!(file_name_pattern.directory_template, "{course}");
	assert_eq!(file_name_pattern.matched_count, 2);
	assert_eq!(file_name_pattern.confidence, 1.0);
}

#[test]
fn evidence_weighted_downgrades_numeric_only_markers() {
	let guesses = EvidenceWeightedPatternEstimator
		.estimate(&flat_numbered_entries())
		.expect("推定に成功する");
	let file_name_pattern = guesses
		.iter()
		.find(|guess| guess.file_name_template.as_deref() == Some("{section}_{filename}"))
		.expect("ファイル名パターン候補がある");

	assert_eq!(file_name_pattern.matched_count, 2);
	assert_eq!(file_name_pattern.confidence, 0.25);
}

#[test]
fn evidence_weighted_uses_explicit_prefix_weight() {
	let guesses = EvidenceWeightedPatternEstimator
		.estimate(&[
			entry("データベース/第1回_講義資料.pdf"),
			entry("データベース/第2回_演習課題.pdf"),
		])
		.expect("推定に成功する");
	let file_name_pattern = guesses
		.iter()
		.find(|guess| guess.file_name_template.is_some())
		.expect("ファイル名パターン候補がある");

	assert_eq!(file_name_pattern.confidence, 0.6);
}

#[test]
fn folder_pattern_preserves_the_section_folder_format() {
	let guesses = FolderOnlyPatternEstimator
		.estimate(&[
			entry("データベース/第十二回/正規化.pdf"),
			entry("離散数学/第二十回/グラフ理論.pdf"),
		])
		.expect("推定に成功する");

	assert_eq!(guesses.len(), 1);
	assert_eq!(guesses[0].directory_template, "{course}/第{section}回");
	assert_eq!(guesses[0].file_name_template, None);
}

#[test]
fn configurable_scan_engine_switches_built_in_estimators() {
	let entries = flat_numbered_entries();
	let conservative = ConfigurableScanEngine::new(PatternEstimatorKind::FolderOnly);
	let weighted = ConfigurableScanEngine::new(PatternEstimatorKind::EvidenceWeighted);

	assert_eq!(conservative.estimator_id(), "folder_only");
	assert_eq!(weighted.estimator_id(), "evidence_weighted");
	assert_eq!(conservative.estimate_patterns(&entries).unwrap().len(), 1);
	assert_eq!(weighted.estimate_patterns(&entries).unwrap().len(), 2);
}

#[test]
fn configurable_scan_engine_accepts_future_estimators() {
	let engine = ConfigurableScanEngine::with_estimator(ExperimentalEstimator);
	let guesses = engine
		.estimate_patterns(&flat_numbered_entries())
		.expect("独自推定器を実行できる");

	assert_eq!(engine.estimator_id(), "experimental");
	assert_eq!(
		guesses[0].file_name_template.as_deref(),
		Some("custom-{filename}")
	);
}

#[test]
fn estimator_keys_are_stable_and_reversible() {
	for kind in PatternEstimatorKind::ALL {
		assert_eq!(PatternEstimatorKind::from_key(kind.key()), Some(kind));
	}
	assert_eq!(PatternEstimatorKind::from_key("unknown"), None);
}

#[test]
fn does_not_treat_the_scan_root_as_a_course_folder() {
	let entries = [entry("01_講義資料.pdf"), entry("02_演習課題.pdf")];
	for kind in PatternEstimatorKind::ALL {
		let guesses = built_in_estimator(kind)
			.estimate(&entries)
			.expect("推定に成功する");
		assert!(guesses.is_empty(), "方式: {}", kind.key());
	}
}

#[test]
fn rejects_unsupported_intermediate_directory_layouts() {
	let entries = [
		entry("資料/データベース/正規化.pdf"),
		entry("配布物/離散数学/グラフ理論.pdf"),
	];
	for kind in PatternEstimatorKind::ALL {
		let guesses = built_in_estimator(kind)
			.estimate(&entries)
			.expect("推定に成功する");
		assert!(guesses.is_empty(), "方式: {}", kind.key());
	}
}

#[test]
fn requires_two_supporting_files_when_scanning_three_or_more() {
	let guesses = FrequencyPatternEstimator
		.estimate(&[
			entry("データベース/第1回/資料.pdf"),
			entry("離散数学/演習課題.pdf"),
			entry("未整理.txt"),
		])
		.expect("推定に成功する");

	assert!(guesses.is_empty());
}
