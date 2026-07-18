use std::path::PathBuf;

use engine_core::pattern::{
	built_in_estimator, EvidenceWeightedPatternEstimator, FolderOnlyPatternEstimator,
	FrequencyPatternEstimator, PatternEstimator, PatternEstimatorKind,
};
use engine_core::scan::{ConfigurableScanEngine, ScanEngine};
use engine_core::types::FileEntry;

fn entry(path: &str) -> FileEntry {
	let path = PathBuf::from(path);
	FileEntry {
		file_name: path
			.file_name()
			.expect("ファイル名がある")
			.to_string_lossy()
			.into_owned(),
		path,
		size: 1,
		modified_at: None,
	}
}

fn flat_numbered_entries() -> Vec<FileEntry> {
	vec![
		entry("root/データベース/01_講義資料.pdf"),
		entry("root/データベース/02_演習課題.pdf"),
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
			guesses
				.iter()
				.all(|guess| (0.0..=1.0).contains(&guess.confidence)),
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
	assert_eq!(guesses[0].pattern_template, "{course}/{filename}");
	assert_eq!(guesses[0].confidence, 1.0);
}

#[test]
fn frequency_counts_numeric_file_markers_as_full_evidence() {
	let guesses = FrequencyPatternEstimator
		.estimate(&flat_numbered_entries())
		.expect("推定に成功する");
	let file_name_pattern = guesses
		.iter()
		.find(|guess| guess.pattern_template == "{course}/{section}_{filename}")
		.expect("ファイル名パターン候補がある");

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
		.find(|guess| guess.pattern_template == "{course}/{section}_{filename}")
		.expect("ファイル名パターン候補がある");

	assert_eq!(file_name_pattern.matched_count, 2);
	assert_eq!(file_name_pattern.confidence, 0.25);
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
fn estimator_keys_are_stable_and_reversible() {
	for kind in PatternEstimatorKind::ALL {
		assert_eq!(PatternEstimatorKind::from_key(kind.key()), Some(kind));
	}
	assert_eq!(PatternEstimatorKind::from_key("unknown"), None);
}
