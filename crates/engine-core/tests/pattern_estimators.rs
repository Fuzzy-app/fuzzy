use std::path::{Path, PathBuf};

use engine_core::pattern::{
	built_in_estimator, classify_relative_path, EvidenceWeightedPatternEstimator,
	FolderOnlyPatternEstimator, FrequencyPatternEstimator, PatternEstimator, PatternEstimatorKind,
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
			course_segment_index: 0,
			confidence: 0.75,
			matched_count: 2,
			evaluated_count: 2,
			representative_paths: vec![PathBuf::from("データベース")],
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

#[test]
fn classifies_deep_year_term_course_and_section_layouts() {
	let guesses = FrequencyPatternEstimator
		.estimate(&[
			entry("2026年度/1年前期/画像処理/第3回/資料.pdf"),
			entry("2026年度/1年前期/画像処理/第4回/演習.pdf"),
		])
		.expect("深い階層を推定できる");

	assert_eq!(guesses.len(), 1);
	assert_eq!(
		guesses[0].directory_template,
		"{year}年度/{term}/{course}/第{section}回"
	);
	assert_eq!(guesses[0].course_segment_index, 2);
	assert_eq!(guesses[0].matched_count, 2);
	assert_eq!(guesses[0].evaluated_count, 2);
	assert_eq!(guesses[0].confidence, 1.0);
	assert_eq!(
		guesses[0].representative_paths,
		vec![
			PathBuf::from("2026年度/1年前期/画像処理/第3回"),
			PathBuf::from("2026年度/1年前期/画像処理/第4回"),
		]
	);
}

#[test]
fn recognizes_quarters_and_grade_terms_without_treating_them_as_courses() {
	let cases = [
		("1Q/データベース/正規化.pdf", "{term}/{course}", 1),
		("第2クォーター/離散数学/課題.pdf", "{term}/{course}", 1),
		("2年後期/画像処理/資料.pdf", "{term}/{course}", 1),
	];
	for (path, expected_template, expected_course_index) in cases {
		let guesses = FrequencyPatternEstimator
			.estimate(&[entry(path), entry(path)])
			.expect("学期区分を推定できる");
		assert_eq!(guesses[0].directory_template, expected_template);
		assert_eq!(guesses[0].course_segment_index, expected_course_index);
	}
}

#[test]
fn recognizes_calendar_year_prefixed_terms_without_hiding_the_course() {
	let entries = [
		entry("2026前期/人工知能/ニューラルネットワーク.pdf"),
		entry("2026前期/人工知能/機械学習.pdf"),
	];

	for kind in PatternEstimatorKind::ALL {
		let guesses = built_in_estimator(kind)
			.estimate(&entries)
			.expect("年度付き学期の下にある科目を推定できる");
		assert_eq!(guesses.len(), 1, "方式: {}", kind.key());
		assert_eq!(guesses[0].directory_template, "{term}/{course}");
		assert_eq!(guesses[0].course_segment_index, 1);
		assert_eq!(
			guesses[0].representative_paths,
			vec![PathBuf::from("2026前期/人工知能")]
		);
	}
}

#[test]
fn recognizes_year_prefixed_term_folders_without_deriving_the_academic_year() {
	let classification = classify_relative_path(Path::new("2026前期/人工知能/講義資料.pdf"))
		.expect("年度を含む学期フォルダーを分類できる");

	assert_eq!(classification.directory_template, "{term}/{course}");
	assert_eq!(classification.course_segment_index, 1);
	assert_eq!(classification.academic_year, None);
	assert_eq!(classification.term.as_deref(), Some("2026前期"));

	let guesses = FrequencyPatternEstimator
		.estimate(&[
			entry("2026前期/人工知能/講義資料.pdf"),
			entry("2026前期/人工知能/演習課題.pdf"),
		])
		.expect("年度を含む学期フォルダーから保存ルールを推定できる");
	assert_eq!(guesses.len(), 1);
	assert_eq!(guesses[0].directory_template, "{term}/{course}");
	assert_eq!(guesses[0].course_segment_index, 1);
	assert_eq!(guesses[0].matched_count, 2);
}

#[test]
fn excludes_unclassified_deep_paths_from_the_confidence_denominator() {
	let guesses = FrequencyPatternEstimator
		.estimate(&[
			entry("2026年度/前期/データベース/正規化.pdf"),
			entry("2026年度/前期/離散数学/グラフ理論.pdf"),
			entry("資料/共有/未分類.pdf"),
		])
		.expect("評価可能な母集団で推定できる");

	assert_eq!(guesses.len(), 1);
	assert_eq!(guesses[0].matched_count, 2);
	assert_eq!(guesses[0].evaluated_count, 2);
	assert_eq!(guesses[0].confidence, 1.0);
}

#[test]
fn keeps_file_name_rules_distinct_for_the_same_directory_layout() {
	let guesses = FrequencyPatternEstimator
		.estimate(&[
			entry("1Q/データベース/第1回_資料.pdf"),
			entry("1Q/データベース/第2回_演習.pdf"),
		])
		.expect("フォルダー規則とファイル名規則を別候補にできる");

	assert_eq!(guesses.len(), 2);
	assert!(guesses
		.iter()
		.any(|guess| guess.file_name_template.is_none()));
	assert!(guesses
		.iter()
		.any(|guess| guess.file_name_template.as_deref() == Some("{section}_{filename}")));
	assert!(guesses.iter().all(|guess| guess.confidence > 0.0));
}
