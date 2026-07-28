//! ScanEngine — フォルダの再帰走査・既存の保存パターン推定。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{EngineError, EngineResult};
use crate::pattern::{
	built_in_estimator, FrequencyPatternEstimator, PatternEstimator, PatternEstimatorKind,
};
use crate::types::{FileEntry, SavePatternGuess, ScanSnapshot, ScanWarning};

const ZIP_STAGING_PREFIX: &str = ".fuzzy-internal-zip-staging-";
const IGNORED_DIRECTORY_NAMES: &[&str] = &[
	"$recycle.bin",
	".angular",
	".bzr",
	".cache-loader",
	".cdktf.out",
	".eggs",
	".fossil-settings",
	".git",
	".hg",
	".hypothesis",
	".idea",
	".ipynb_checkpoints",
	".julia",
	".metadata",
	".mypy_cache",
	".next",
	".nox",
	".npm",
	".nuxt",
	".nyc_output",
	".output",
	".parcel-cache",
	".pnpm-store",
	".pyre",
	".pytest_cache",
	".pytype",
	".ruff_cache",
	".serverless",
	".settings",
	".spotlight-v100",
	".svn",
	".svelte-kit",
	".terraform",
	".terragrunt-cache",
	".tox",
	".trashes",
	".turbo",
	".venv",
	".vite",
	".vscode",
	".vs",
	".yarn",
	"_darcs",
	"__macosx",
	"__pycache__",
	"allure-report",
	"allure-results",
	"bower_components",
	"carthage",
	"coverage",
	"cvs",
	"deriveddata",
	"htmlcov",
	"jspm_packages",
	"node_modules",
	"playwright-report",
	"system volume information",
	"test-results",
	"venv",
];

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

/// 既知の保存済みファイル1件を、保存ルート基準の走査エントリーへ変換する。
///
/// コース単位の差分走査で、ルール変更前の場所に残っている登録済みファイルも
/// 更新確認できるようにする。シンボリックリンク・保存ルート外・組み込み除外対象は
/// 対象外にする。
pub(crate) fn scan_registered_file(root: &Path, path: &Path) -> EngineResult<Option<FileEntry>> {
	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(source) => return Err(path_io(path, source)),
	};
	if metadata.file_type().is_symlink() || !metadata.is_file() {
		return Ok(None);
	}
	let canonical_root = root
		.canonicalize()
		.map_err(|source| path_io(root, source))?;
	let canonical_path = path
		.canonicalize()
		.map_err(|source| path_io(path, source))?;
	let Ok(relative_path) = canonical_path.strip_prefix(&canonical_root) else {
		return Ok(None);
	};
	let mut ancestor = canonical_path.parent();
	while let Some(directory) = ancestor {
		if directory == canonical_root {
			break;
		}
		let Some(name) = directory.file_name() else {
			return Ok(None);
		};
		if is_ignored_directory(&canonical_root, directory, name) {
			return Ok(None);
		}
		ancestor = directory.parent();
	}
	let relative_path = relative_path.to_path_buf();
	let Some(file_name) = canonical_path.file_name() else {
		return Ok(None);
	};
	Ok(Some(FileEntry {
		file_name: file_name.to_string_lossy().into_owned(),
		path: canonical_path,
		relative_path,
		size: metadata.len(),
		modified_at: modified_at(&metadata),
	}))
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
		if directory == root
			&& file_type.is_dir()
			&& child
				.file_name()
				.to_string_lossy()
				.starts_with(ZIP_STAGING_PREFIX)
		{
			// native-hostがZIPを検証中の一時領域は正本へ登録しない。
			continue;
		}
		if file_type.is_symlink() {
			// Windowsのジャンクションを含む名前サロゲートは追跡しない。
			continue;
		}
		if file_type.is_dir() {
			if is_ignored_directory(root, &path, &child.file_name()) {
				// 仮想環境・依存パッケージ・VCSメタデータは授業資料ではなく、
				// 数万件規模になることがあるため正本登録と全文索引の対象外にする。
				continue;
			}
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

fn is_ignored_directory(root: &Path, path: &Path, name: &std::ffi::OsStr) -> bool {
	is_ignored_directory_name(name)
		|| name
			.to_string_lossy()
			.to_ascii_lowercase()
			.starts_with("cmake-build-")
		|| name
			.to_string_lossy()
			.to_ascii_lowercase()
			.starts_with("_minted-")
		|| is_python_environment(path)
		|| is_project_output_directory(root, path, name)
}

fn is_ignored_directory_name(name: &std::ffi::OsStr) -> bool {
	let name = name.to_string_lossy();
	IGNORED_DIRECTORY_NAMES
		.iter()
		.any(|ignored| name.eq_ignore_ascii_case(ignored))
}

fn is_python_environment(path: &Path) -> bool {
	path.join("pyvenv.cfg").is_file()
		&& (path.join("Lib").join("site-packages").is_dir()
			|| path.join("Scripts").join("python.exe").is_file()
			|| path.join("bin").join("python").is_file())
		|| path.join("conda-meta").is_dir()
}

fn is_project_output_directory(root: &Path, path: &Path, name: &std::ffi::OsStr) -> bool {
	let name = name.to_string_lossy().to_ascii_lowercase();
	let Some(parent) = path.parent() else {
		return false;
	};
	let has_marker = |markers: &[&str]| markers.iter().any(|marker| parent.join(marker).is_file());
	match name.as_str() {
		"target" => has_marker(&["Cargo.toml", "pom.xml"]),
		"build" => has_marker(&["build.gradle", "build.gradle.kts", "CMakeLists.txt"]),
		"bin" | "obj" => contains_project_file(parent, root, &["csproj", "fsproj", "vbproj"]),
		"vendor" => has_marker(&["go.mod", "Gemfile", "composer.json"]),
		".build" => has_marker(&["Package.swift"]),
		"pods" => has_marker(&["Podfile"]),
		_ => false,
	}
}

fn contains_project_file(directory: &Path, root: &Path, extensions: &[&str]) -> bool {
	let mut current = Some(directory);
	while let Some(path) = current {
		if fs::read_dir(path).is_ok_and(|children| {
			children.filter_map(Result::ok).any(|child| {
				let child_path = child.path();
				child.file_type().is_ok_and(|file_type| file_type.is_file())
					&& child_path
						.extension()
						.and_then(|extension| extension.to_str())
						.is_some_and(|extension| {
							extensions
								.iter()
								.any(|expected| extension.eq_ignore_ascii_case(expected))
						})
			})
		}) {
			return true;
		}
		if path == root {
			break;
		}
		current = path.parent();
	}
	false
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

pub(crate) fn relative_warning_path(root: &Path, path: &Path) -> PathBuf {
	path.strip_prefix(root)
		.ok()
		.filter(|relative_path| !relative_path.as_os_str().is_empty())
		.map(Path::to_path_buf)
		.unwrap_or_else(|| PathBuf::from("."))
}

fn modified_at(metadata: &fs::Metadata) -> Option<i64> {
	let modified = metadata.modified().ok()?;
	match modified.duration_since(UNIX_EPOCH) {
		Ok(duration) => i64::try_from(duration.as_nanos()).ok(),
		Err(error) => i64::try_from(error.duration().as_nanos())
			.ok()
			.and_then(|nanoseconds| nanoseconds.checked_neg()),
	}
}

#[cfg(test)]
mod tests {
	use std::fs::{self, File};
	use std::io::Write;
	use std::path::PathBuf;
	use std::time::{SystemTime, UNIX_EPOCH};

	use super::{scan_directory, scan_registered_file, DefaultScanEngine, ScanEngine};

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
	fn ignores_native_host_zip_staging_directly_below_root() {
		let directory = TestDirectory::new("zip-staging");
		directory.create_file(
			".fuzzy-internal-zip-staging-test/途中の資料.pdf",
			b"partial",
		);
		directory.create_file("データベース/公開済み資料.pdf", b"published");

		let snapshot = DefaultScanEngine.scan(&directory.path).expect("走査できる");

		assert_eq!(snapshot.entries.len(), 1);
		assert_eq!(snapshot.entries[0].file_name, "公開済み資料.pdf");
	}

	#[test]
	fn ignores_dependency_and_tool_directories_at_any_depth() {
		let directory = TestDirectory::new("ignored-directories");
		for relative_path in [
			"データサイエンス基礎/.venv/Lib/site-packages/pandas/__init__.py",
			"アプリ演習/node_modules/package/index.js",
			"情報処理/第1回/__pycache__/answer.pyc",
			"離散数学/.git/objects/00/hash",
			"英語IIB/VENV/Lib/site.py",
		] {
			directory.create_file(relative_path, b"generated");
		}
		directory.create_file("データベース/第4回/正規化.pdf", b"material");

		let snapshot = DefaultScanEngine.scan(&directory.path).expect("走査できる");

		assert_eq!(snapshot.entries.len(), 1);
		assert_eq!(snapshot.entries[0].file_name, "正規化.pdf");
		assert!(snapshot.warnings.is_empty());
	}

	#[test]
	fn detects_a_python_environment_by_structure_even_with_a_custom_name() {
		let directory = TestDirectory::new("python-environment-signature");
		directory.create_file("情報処理/実験環境/pyvenv.cfg", b"home = python");
		directory.create_file(
			"情報処理/実験環境/Lib/site-packages/numpy/__init__.py",
			b"dependency",
		);
		directory.create_file("情報処理/第1回/answer.py", b"print('answer')");

		let snapshot = DefaultScanEngine.scan(&directory.path).expect("走査できる");

		assert_eq!(snapshot.entries.len(), 1);
		assert_eq!(snapshot.entries[0].file_name, "answer.py");
	}

	#[test]
	fn excludes_project_outputs_only_when_their_project_marker_exists() {
		let directory = TestDirectory::new("project-output-signature");
		directory.create_file("アプリ演習/Cargo.toml", b"[package]");
		directory.create_file("アプリ演習/target/debug/app.exe", b"binary");
		directory.create_file("コンパイラ演習/target/配布資料.pdf", b"material");

		let snapshot = DefaultScanEngine.scan(&directory.path).expect("走査できる");

		assert_eq!(snapshot.entries.len(), 2);
		assert!(snapshot
			.entries
			.iter()
			.any(|entry| entry.file_name == "Cargo.toml"));
		assert!(snapshot
			.entries
			.iter()
			.any(|entry| entry.file_name == "配布資料.pdf"));
	}

	#[test]
	fn project_marker_directories_do_not_exclude_course_materials() {
		let directory = TestDirectory::new("project-marker-directory");
		fs::create_dir_all(directory.path.join("アプリ演習/Cargo.toml"))
			.expect("マーカーと同名のフォルダを作成できる");
		directory.create_file("アプリ演習/target/配布資料.pdf", b"material");
		fs::create_dir_all(directory.path.join("情報処理/example.csproj"))
			.expect("プロジェクトファイルと同名のフォルダを作成できる");
		directory.create_file("情報処理/bin/課題データ.bin", b"material");

		let snapshot = DefaultScanEngine.scan(&directory.path).expect("走査できる");

		assert_eq!(snapshot.entries.len(), 2);
		assert!(snapshot
			.entries
			.iter()
			.any(|entry| entry.file_name == "配布資料.pdf"));
		assert!(snapshot
			.entries
			.iter()
			.any(|entry| entry.file_name == "課題データ.bin"));
	}

	#[test]
	fn registered_files_cannot_bypass_built_in_directory_exclusions() {
		let directory = TestDirectory::new("registered-file-exclusion");
		directory.create_file("アプリ演習/.venv/Lib/site-packages/sample.py", b"generated");
		directory.create_file("アプリ演習/第1回/answer.py", b"material");

		let ignored = scan_registered_file(
			&directory.path,
			&directory
				.path
				.join("アプリ演習/.venv/Lib/site-packages/sample.py"),
		)
		.expect("既登録ファイルを確認できる");
		let material = scan_registered_file(
			&directory.path,
			&directory.path.join("アプリ演習/第1回/answer.py"),
		)
		.expect("既登録ファイルを確認できる");

		assert!(ignored.is_none());
		assert_eq!(
			material.expect("通常資料は対象になる").file_name,
			"answer.py"
		);
	}

	#[test]
	fn keeps_source_data_and_binary_files_outside_ignored_directories() {
		let directory = TestDirectory::new("all-material-types");
		for relative_path in [
			"アプリ演習/main.py",
			"アプリ演習/settings.json",
			"アプリ演習/notebook.ipynb",
			"アプリ演習/program.exe",
		] {
			directory.create_file(relative_path, b"material");
		}

		let snapshot = DefaultScanEngine.scan(&directory.path).expect("走査できる");

		assert_eq!(snapshot.entries.len(), 4);
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
