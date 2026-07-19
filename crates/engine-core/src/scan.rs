//! ScanEngine — フォルダの再帰走査・既存の保存パターン推定。
//!
//! 実装は issue #38。

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{EngineError, EngineResult};
use crate::pattern::{
	built_in_estimator, FrequencyPatternEstimator, PatternEstimator, PatternEstimatorKind,
};
use crate::types::{FileEntry, SavePatternGuess};

/// フォルダの再帰走査と保存パターン推定を担うトレイト。
///
/// 初期セットアップ（Tauri）では既存構成のスキャンとパターン推定に、
/// 常駐エンジン（native-host）では整合性チェック用の再走査に使う。
/// 読み取り専用であり、ファイルの移動・削除は一切行わない。
pub trait ScanEngine {
	/// `root` 以下を再帰走査し、発見したファイルのメタ情報を返す。
	fn scan(&self, root: &Path) -> EngineResult<Vec<FileEntry>>;

	/// 走査結果から既存の保存パターンを推定し、確からしさ順に返す。
	fn estimate_patterns(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>>;
}

/// 標準ライブラリだけで走査・推定を行う既定実装。
#[derive(Debug, Default)]
pub struct DefaultScanEngine;

impl ScanEngine for DefaultScanEngine {
	fn scan(&self, root: &Path) -> EngineResult<Vec<FileEntry>> {
		scan_root(root)
	}

	fn estimate_patterns(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>> {
		FrequencyPatternEstimator.estimate(entries)
	}
}

/// 保存パターン推定方式を切り替えられるScanEngine。
#[derive(Debug)]
pub struct ConfigurableScanEngine {
	estimator: Box<dyn PatternEstimator>,
}

impl ConfigurableScanEngine {
	/// 組み込み方式を選んで構成する。
	pub fn new(kind: PatternEstimatorKind) -> Self {
		Self {
			estimator: built_in_estimator(kind),
		}
	}

	/// 任意の独自方式を注入する。将来の学習済み推定器もこの経路を使用する。
	pub fn with_estimator(estimator: impl PatternEstimator + 'static) -> Self {
		Self {
			estimator: Box::new(estimator),
		}
	}

	/// 現在の推定方式ID。
	pub fn estimator_id(&self) -> &'static str {
		self.estimator.id()
	}
}

impl Default for ConfigurableScanEngine {
	fn default() -> Self {
		Self::new(PatternEstimatorKind::default())
	}
}

impl ScanEngine for ConfigurableScanEngine {
	fn scan(&self, root: &Path) -> EngineResult<Vec<FileEntry>> {
		scan_root(root)
	}

	fn estimate_patterns(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>> {
		self.estimator.estimate(entries)
	}
}

fn scan_root(root: &Path) -> EngineResult<Vec<FileEntry>> {
	if !root.exists() {
		return Err(EngineError::InvalidPath {
			path: root.display().to_string(),
			reason: "パスが存在しません".to_string(),
		});
	}
	if !root.is_dir() {
		return Err(EngineError::InvalidPath {
			path: root.display().to_string(),
			reason: "フォルダではありません".to_string(),
		});
	}

	let root = root.canonicalize()?;
	let mut entries = Vec::new();
	scan_directory(&root, &mut entries)?;
	entries.sort_by(|left, right| left.path.cmp(&right.path));
	Ok(entries)
}

fn scan_directory(directory: &Path, entries: &mut Vec<FileEntry>) -> EngineResult<()> {
	for child in fs::read_dir(directory)? {
		let child = child?;
		let file_type = child.file_type()?;
		if file_type.is_symlink() {
			// ジャンクション等の循環を避けるため、リンクは追跡しない。
			continue;
		}
		if file_type.is_dir() {
			scan_directory(&child.path(), entries)?;
			continue;
		}
		if !file_type.is_file() {
			continue;
		}

		let path = child.path();
		let metadata = child.metadata()?;
		entries.push(FileEntry {
			file_name: child.file_name().to_string_lossy().into_owned(),
			path,
			size: metadata.len(),
			modified_at: modified_at(&metadata),
		});
	}
	Ok(())
}

fn modified_at(metadata: &fs::Metadata) -> Option<i64> {
	let modified = metadata.modified().ok()?;
	match modified.duration_since(UNIX_EPOCH) {
		Ok(duration) => i64::try_from(duration.as_secs()).ok(),
		Err(error) => i64::try_from(error.duration().as_secs())
			.ok()
			.and_then(|seconds| seconds.checked_neg()),
	}
}

#[cfg(test)]
mod tests {
	use std::fs::{self, File};
	use std::io::Write;
	use std::path::PathBuf;
	use std::time::{SystemTime, UNIX_EPOCH};

	use super::{DefaultScanEngine, ScanEngine};

	struct TestDirectory {
		path: PathBuf,
	}

	impl TestDirectory {
		fn new(name: &str) -> Self {
			let unique = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("現在時刻を取得できる")
				.as_nanos();
			let path = std::env::temp_dir().join(format!("fuzzy-{name}-{unique}"));
			fs::create_dir_all(&path).expect("テスト用フォルダを作成できる");
			Self { path }
		}

		fn create_file(&self, relative_path: &str, contents: &[u8]) {
			let path = self.path.join(relative_path);
			fs::create_dir_all(path.parent().expect("親フォルダがある"))
				.expect("親フォルダを作成できる");
			let mut file = File::create(path).expect("テスト用ファイルを作成できる");
			file.write_all(contents)
				.expect("テスト用ファイルへ書き込める");
		}
	}

	impl Drop for TestDirectory {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.path);
		}
	}

	#[test]
	fn recursively_scans_files_in_deterministic_order() {
		let directory = TestDirectory::new("scan");
		directory.create_file("データベース/第4回/第4回_正規化.pdf", b"pdf");
		directory.create_file("情報アーキテクチャ/第9回/09_演習課題.docx", b"docx");

		let entries = DefaultScanEngine
			.scan(&directory.path)
			.expect("再帰走査に成功する");

		assert_eq!(entries.len(), 2);
		assert_eq!(entries[0].file_name, "第4回_正規化.pdf");
		assert_eq!(entries[0].size, 3);
		assert!(entries[0].path.is_absolute());
		assert!(entries[0].modified_at.is_some());
		assert_eq!(entries[1].file_name, "09_演習課題.docx");
	}

	#[test]
	fn rejects_a_file_as_scan_root() {
		let directory = TestDirectory::new("invalid-root");
		directory.create_file("file.txt", b"text");

		let error = DefaultScanEngine
			.scan(&directory.path.join("file.txt"))
			.expect_err("ファイルは走査起点にできない");

		assert!(error.to_string().contains("フォルダではありません"));
	}

	#[test]
	fn estimates_the_six_course_sample_layout() {
		let directory = TestDirectory::new("six-courses");
		for relative_path in [
			"情報アーキテクチャ/第9回/09_情報アーキテクチャ_講義資料.pdf",
			"データベース/第4回/第4回_正規化.pdf",
			"離散数学/第6回/離散数学_第6回_グラフ理論.pdf",
			"アプリ演習/アプリ演習_中間プレゼン資料.pptx",
			"認知科学概論/第3回/認知科学概論_第3回レジュメ.pdf",
			"英語IIB/第2回/English_IIB_Unit2_reading.pdf",
		] {
			directory.create_file(relative_path, b"sample");
		}
		let entries = DefaultScanEngine
			.scan(&directory.path)
			.expect("6科目構成を走査できる");

		let guesses = DefaultScanEngine
			.estimate_patterns(&entries)
			.expect("保存パターンを推定できる");

		assert_eq!(guesses.len(), 1);
		assert_eq!(guesses[0].pattern_template, "{course}/{section}/{filename}");
		assert_eq!(guesses[0].matched_count, 5);
		assert!((guesses[0].confidence - 5.0 / 6.0).abs() < f64::EPSILON);
	}

	#[test]
	fn estimates_layouts_with_kanji_section_numbers() {
		let directory = TestDirectory::new("kanji-sections");
		directory.create_file("データベース/第十二回/正規化.pdf", b"sample");
		directory.create_file("離散数学/第二十週/グラフ理論.pdf", b"sample");
		let entries = DefaultScanEngine
			.scan(&directory.path)
			.expect("漢数字のセクションを走査できる");

		let guesses = DefaultScanEngine
			.estimate_patterns(&entries)
			.expect("漢数字のセクションから保存パターンを推定できる");

		assert_eq!(guesses.len(), 1);
		assert_eq!(guesses[0].pattern_template, "{course}/{section}/{filename}");
		assert_eq!(guesses[0].matched_count, 2);
		assert_eq!(guesses[0].confidence, 1.0);
	}

	#[test]
	fn does_not_infer_a_pattern_from_one_file() {
		let directory = TestDirectory::new("one-file");
		directory.create_file("データベース/第4回_正規化.pdf", b"sample");
		let entries = DefaultScanEngine.scan(&directory.path).expect("走査できる");

		let guesses = DefaultScanEngine
			.estimate_patterns(&entries)
			.expect("推定処理に成功する");

		assert!(guesses.is_empty());
	}
}
