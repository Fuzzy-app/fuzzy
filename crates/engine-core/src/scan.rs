//! ScanEngine — フォルダの再帰走査・既存の保存パターン推定。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{EngineError, EngineResult};
use crate::pattern::{
	built_in_estimator, FrequencyPatternEstimator, PatternEstimator, PatternEstimatorKind,
};
use crate::types::{FileEntry, SavePatternGuess, ScanSnapshot, ScanWarning};

/// フォルダの再帰走査と保存パターン推定を担うトレイト。
///
/// 初期セットアップ（Tauri）では既存構成のスキャンとパターン推定に、
/// 常駐エンジン（native-host）では整合性チェック用の再走査に使う。
/// 読み取り専用であり、ファイルの移動・削除は一切行わない。
pub trait ScanEngine {
	/// `root` 以下を再帰走査し、取得できたファイルと警告を返す。
	fn scan(&self, root: &Path) -> EngineResult<ScanSnapshot>;

	/// 走査結果から保存先・ファイル名のパターンを推定する。
	fn estimate_patterns(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>>;
}

/// 標準ライブラリだけで走査・推定を行う既定実装。
#[derive(Debug, Default)]
pub struct DefaultScanEngine;

impl ScanEngine for DefaultScanEngine {
	fn scan(&self, root: &Path) -> EngineResult<ScanSnapshot> {
		scan_root(root)
	}

	fn estimate_patterns(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>> {
		FrequencyPatternEstimator.estimate(entries)
	}
}

/// 保存パターン推定方式を切り替えられる`ScanEngine`。
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
	fn scan(&self, root: &Path) -> EngineResult<ScanSnapshot> {
		scan_root(root)
	}

	fn estimate_patterns(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>> {
		self.estimator.estimate(entries)
	}
}

fn scan_root(root: &Path) -> EngineResult<ScanSnapshot> {
	let metadata = match fs::metadata(root) {
		Ok(metadata) => metadata,
		Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
			return Err(EngineError::InvalidPath {
				path: root.display().to_string(),
				reason: "パスが存在しません".to_string(),
			});
		}
		Err(source) => return Err(path_io(root, source)),
	};
	if !metadata.is_dir() {
		return Err(EngineError::InvalidPath {
			path: root.display().to_string(),
			reason: "フォルダではありません".to_string(),
		});
	}

	let root = root
		.canonicalize()
		.map_err(|source| path_io(root, source))?;
	let mut entries = Vec::new();
	let mut warnings = Vec::new();
	scan_directory(&root, &root, &mut entries, &mut warnings, true)?;
	entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
	warnings.sort_by(|left, right| left.path.cmp(&right.path));
	Ok(ScanSnapshot {
		root,
		entries,
		warnings,
	})
}

fn scan_directory(
	root: &Path,
	directory: &Path,
	entries: &mut Vec<FileEntry>,
	warnings: &mut Vec<ScanWarning>,
	fail_if_unreadable: bool,
) -> EngineResult<()> {
	let children = match fs::read_dir(directory) {
		Ok(children) => children,
		Err(source) if fail_if_unreadable => return Err(path_io(directory, source)),
		Err(source) => {
			warnings.push(scan_warning(root, directory, &source));
			return Ok(());
		}
	};

	for child in children {
		let child = match child {
			Ok(child) => child,
			Err(source) => {
				warnings.push(scan_warning(root, directory, &source));
				continue;
			}
		};
		let path = child.path();
		let file_type = match child.file_type() {
			Ok(file_type) => file_type,
			Err(source) => {
				warnings.push(scan_warning(root, &path, &source));
				continue;
			}
		};
		if file_type.is_symlink() {
			// Windowsのジャンクションを含む名前サロゲートは追跡しない。
			continue;
		}
		if file_type.is_dir() {
			scan_directory(root, &path, entries, warnings, false)?;
			continue;
		}
		if !file_type.is_file() {
			continue;
		}

		let metadata = match child.metadata() {
			Ok(metadata) => metadata,
			Err(source) => {
				warnings.push(scan_warning(root, &path, &source));
				continue;
			}
		};
		let relative_path = match path.strip_prefix(root) {
			Ok(relative_path) => relative_path.to_path_buf(),
			Err(_) => {
				warnings.push(ScanWarning {
					path: PathBuf::from("."),
					message: "走査起点からの相対パスを取得できません".to_string(),
				});
				continue;
			}
		};
		entries.push(FileEntry {
			file_name: child.file_name().to_string_lossy().into_owned(),
			path,
			relative_path,
			size: metadata.len(),
			modified_at: modified_at(&metadata),
		});
	}
	Ok(())
}

fn path_io(path: &Path, source: std::io::Error) -> EngineError {
	EngineError::PathIo {
		path: path.display().to_string(),
		source,
	}
}

fn scan_warning(root: &Path, path: &Path, source: &std::io::Error) -> ScanWarning {
	ScanWarning {
		path: relative_warning_path(root, path),
		message: match source.kind() {
			std::io::ErrorKind::NotFound => "走査中にパスが見つからなくなりました",
			std::io::ErrorKind::PermissionDenied => "アクセスが拒否されました",
			_ => "ファイル情報を読み取れませんでした",
		}
		.to_string(),
	}
}

fn relative_warning_path(root: &Path, path: &Path) -> PathBuf {
	path.strip_prefix(root)
		.ok()
		.filter(|relative_path| !relative_path.as_os_str().is_empty())
		.map(Path::to_path_buf)
		.unwrap_or_else(|| PathBuf::from("."))
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

	use super::{scan_directory, DefaultScanEngine, ScanEngine};

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

		let snapshot = DefaultScanEngine
			.scan(&directory.path)
			.expect("再帰走査に成功する");

		assert_eq!(snapshot.entries.len(), 2);
		assert!(snapshot.warnings.is_empty());
		assert_eq!(snapshot.entries[0].file_name, "第4回_正規化.pdf");
		assert_eq!(snapshot.entries[0].size, 3);
		assert!(snapshot.entries[0].path.is_absolute());
		assert_eq!(
			snapshot.entries[0].relative_path,
			PathBuf::from("データベース/第4回/第4回_正規化.pdf")
		);
		assert!(snapshot.entries[0].modified_at.is_some());
		assert_eq!(snapshot.entries[1].file_name, "09_演習課題.docx");
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
	fn rejects_a_missing_scan_root() {
		let directory = TestDirectory::new("missing-root");
		let error = DefaultScanEngine
			.scan(&directory.path.join("missing"))
			.expect_err("存在しないフォルダは走査できない");
		assert!(error.to_string().contains("パスが存在しません"));
	}

	#[test]
	fn records_an_unreadable_child_path_and_continues() {
		let directory = TestDirectory::new("partial-warning");
		let missing_child = directory.path.join("走査中に消えたフォルダ");
		let mut entries = Vec::new();
		let mut warnings = Vec::new();

		scan_directory(
			&directory.path,
			&missing_child,
			&mut entries,
			&mut warnings,
			false,
		)
		.expect("子パスの失敗は走査全体を失敗させない");

		assert!(entries.is_empty());
		assert_eq!(warnings.len(), 1);
		assert_eq!(warnings[0].path, PathBuf::from("走査中に消えたフォルダ"));
		assert_eq!(warnings[0].message, "走査中にパスが見つからなくなりました");
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
		let snapshot = DefaultScanEngine
			.scan(&directory.path)
			.expect("6科目構成を走査できる");
		let guesses = DefaultScanEngine
			.estimate_patterns(&snapshot.entries)
			.expect("保存パターンを推定できる");

		assert!(snapshot.warnings.is_empty());
		assert_eq!(guesses.len(), 1);
		assert_eq!(guesses[0].directory_template, "{course}/第{section}回");
		assert_eq!(guesses[0].file_name_template, None);
		assert_eq!(guesses[0].matched_count, 5);
		assert!((guesses[0].confidence - 5.0 / 6.0).abs() < f64::EPSILON);
	}

	#[test]
	fn estimates_layouts_with_kanji_section_numbers() {
		let directory = TestDirectory::new("kanji-sections");
		directory.create_file("データベース/第十二回/正規化.pdf", b"sample");
		directory.create_file("離散数学/第二十回/グラフ理論.pdf", b"sample");
		let snapshot = DefaultScanEngine
			.scan(&directory.path)
			.expect("漢数字のセクションを走査できる");
		let guesses = DefaultScanEngine
			.estimate_patterns(&snapshot.entries)
			.expect("保存パターンを推定できる");

		assert_eq!(guesses.len(), 1);
		assert_eq!(guesses[0].directory_template, "{course}/第{section}回");
		assert_eq!(guesses[0].file_name_template, None);
		assert_eq!(guesses[0].matched_count, 2);
		assert_eq!(guesses[0].confidence, 1.0);
	}

	#[test]
	fn does_not_infer_a_pattern_from_one_file() {
		let directory = TestDirectory::new("one-file");
		directory.create_file("データベース/第4回_正規化.pdf", b"sample");
		let snapshot = DefaultScanEngine.scan(&directory.path).expect("走査できる");
		let guesses = DefaultScanEngine
			.estimate_patterns(&snapshot.entries)
			.expect("推定処理に成功する");
		assert!(guesses.is_empty());
	}

	#[test]
	fn does_not_treat_scan_root_as_a_course_folder() {
		let directory = TestDirectory::new("root-files");
		directory.create_file("講義資料.pdf", b"sample");
		directory.create_file("演習課題.docx", b"sample");
		let snapshot = DefaultScanEngine.scan(&directory.path).expect("走査できる");
		let guesses = DefaultScanEngine
			.estimate_patterns(&snapshot.entries)
			.expect("推定処理に成功する");
		assert!(guesses.is_empty());
	}
}
