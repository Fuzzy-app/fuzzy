//! 認証済み拡張機能が取得したファイル内容の分割受信と安全な実保存。

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use engine_core::duplicate::{DefaultDuplicateDetector, DuplicateDetector};
use engine_core::section::parse_section_file_prefix;
use engine_core::types::SavedFileRegistration;
use engine_core::{Database, EngineError, EngineResult};
use tempfile::NamedTempFile;

use crate::api_types::{
	AppendCheckSimilarFileChunkRequest, AppendSaveFileChunkRequest, BeginCheckSimilarFileRequest,
	BeginSaveFilesRequest, SaveFileDescriptor, SaveFileFailure, SaveFileFailureCode,
	SaveFilesResult,
};

const MAX_ACTIVE_TRANSFERS: usize = 4;
const MAX_FILES_PER_TRANSFER: usize = 20;
pub(crate) const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TRANSFER_BYTES: usize = 128 * 1024 * 1024;
const MAX_DECODED_CHUNK_BYTES: usize = 256 * 1024;
const MAX_ENCODED_CHUNK_CHARACTERS: usize = MAX_DECODED_CHUNK_BYTES.div_ceil(3) * 4;
const MAX_ZIP_ENTRIES: usize = 1_000;
const MAX_EXTRACTED_BYTES: u64 = 256 * 1024 * 1024;
const ZIP_STAGING_PREFIX: &str = ".fuzzy-internal-zip-staging-";

#[derive(Default)]
pub struct FileTransferManager {
	transfers: HashMap<String, PendingTransfer>,
	similarity_transfers: HashMap<String, PendingSimilarityTransfer>,
}

pub struct FileTransferCommitResult {
	pub response: SaveFilesResult,
	pub files_to_index: Vec<SavedFileForIndex>,
}

pub struct SavedFileForIndex {
	pub database_id: i64,
	pub path: PathBuf,
}

pub struct ExtractedZipFiles {
	paths: Vec<String>,
	created_files: Option<Vec<CreatedPath>>,
	created_directories: Option<Vec<CreatedPath>>,
	directory_tree: Option<SafeDirectoryTree>,
}

impl ExtractedZipFiles {
	pub fn paths(&self) -> &[String] {
		&self.paths
	}

	/// SQLiteへの登録まで完了した後に、補償ロールバックを解除する。
	pub fn commit(mut self) -> Vec<String> {
		self.created_files.take();
		self.created_directories.take();
		self.directory_tree.take();
		std::mem::take(&mut self.paths)
	}
}

impl std::fmt::Debug for ExtractedZipFiles {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("ExtractedZipFiles")
			.field("paths", &self.paths)
			.finish_non_exhaustive()
	}
}

impl Drop for ExtractedZipFiles {
	fn drop(&mut self) {
		let Some(files) = self.created_files.take() else {
			return;
		};
		let directories = self.created_directories.take().unwrap_or_default();
		drop(self.directory_tree.take());
		rollback_created_paths(files, directories);
	}
}

struct PendingTransfer {
	target_path: PathBuf,
	course_id: Option<i64>,
	files: HashMap<String, PendingFile>,
}

struct ZipEntryPlan {
	archive_index: usize,
	relative_path: PathBuf,
	declared_size: u64,
}

struct StagedZipEntry {
	relative_path: PathBuf,
	file: NamedTempFile,
}

struct CreatedPath {
	path: PathBuf,
	#[cfg(windows)]
	handle: File,
	#[cfg(not(windows))]
	identity: FileIdentity,
}

#[cfg(not(windows))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity {
	#[cfg(unix)]
	device: u64,
	#[cfg(unix)]
	inode: u64,
	#[cfg(not(any(windows, unix)))]
	created: Option<std::time::SystemTime>,
	#[cfg(not(any(windows, unix)))]
	length: u64,
}

struct SafeDirectoryTree {
	base: PathBuf,
	locked_paths: HashSet<String>,
	#[cfg(windows)]
	handles: HashMap<String, File>,
}

pub fn extract_zip_archive(
	base_folder: &Path,
	source: &Path,
	destination_path: &str,
	flatten: bool,
) -> EngineResult<ExtractedZipFiles> {
	let destination = validate_target_path(base_folder, destination_path)?;
	let response_destination = destination.clone();
	let canonical_base = safe_base_path(base_folder)?;
	let source = safe_source_path(&canonical_base, source)?;
	if !path_starts_with(&source, &canonical_base) {
		return Err(invalid("fileMeta", "保存ルート外のZIPは展開できません"));
	}
	let destination_relative = relative_path_from_base(&destination, base_folder)
		.ok_or_else(|| invalid("destinationPath", "保存ルート外は指定できません"))?;
	let destination = canonical_base.join(destination_relative);
	let mut directory_tree = SafeDirectoryTree::new(&canonical_base)?;
	let source_parent = source
		.parent()
		.ok_or_else(|| invalid("fileMeta", "保存済みZIPの場所を確認できません"))?;
	let mut source_directories = Vec::new();
	ensure_safe_directory_tree(
		&canonical_base,
		source_parent,
		&mut source_directories,
		&mut directory_tree,
		false,
	)?;
	let input = open_safe_zip_source(&source)?;
	let mut archive = zip::ZipArchive::new(input)
		.map_err(|_| invalid("fileMeta", "ZIPファイルを読み込めません"))?;
	let plans = plan_zip_entries(&mut archive, flatten)?;
	let staging = tempfile::Builder::new()
		.prefix(ZIP_STAGING_PREFIX)
		.tempdir_in(&canonical_base)
		.map_err(EngineError::Io)?;
	let _staging_guard = lock_staging_directory(staging.path())?;
	let mut staged_entries = Vec::with_capacity(plans.len());
	let mut extracted_bytes = 0_u64;
	for plan in plans {
		let mut entry = archive
			.by_index(plan.archive_index)
			.map_err(|_| invalid("fileMeta", "ZIP項目を読み込めません"))?;
		let mut output = new_protected_tempfile(staging.path()).map_err(EngineError::Io)?;
		let remaining = MAX_EXTRACTED_BYTES.saturating_sub(extracted_bytes);
		let copied = std::io::copy(&mut entry.by_ref().take(remaining + 1), &mut output)
			.map_err(EngineError::Io)?;
		if copied > remaining || copied != plan.declared_size {
			return Err(invalid("fileMeta", "ZIP項目の展開サイズが不正です"));
		}
		output.flush().map_err(EngineError::Io)?;
		output.as_file().sync_all().map_err(EngineError::Io)?;
		extracted_bytes += copied;
		staged_entries.push(StagedZipEntry {
			relative_path: plan.relative_path,
			file: output,
		});
	}

	let mut created_directories = Vec::new();
	let mut committed_files = Vec::new();
	let result = (|| {
		ensure_safe_directory_tree(
			&canonical_base,
			&destination,
			&mut created_directories,
			&mut directory_tree,
			true,
		)?;
		for staged in &staged_entries {
			let output_path = destination.join(&staged.relative_path);
			let parent = output_path
				.parent()
				.ok_or_else(|| invalid("destinationPath", "展開先を解決できません"))?;
			ensure_safe_directory_tree(
				&canonical_base,
				parent,
				&mut created_directories,
				&mut directory_tree,
				true,
			)?;
			match std::fs::symlink_metadata(&output_path) {
				Ok(_) => {
					return Err(invalid(
						"destinationPath",
						"展開先に同名のファイルまたはリンクが既にあります",
					));
				}
				Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
				Err(error) => return Err(EngineError::Io(error)),
			}
		}

		let mut extracted_paths = Vec::with_capacity(staged_entries.len());
		for staged in staged_entries {
			let output_path = destination.join(&staged.relative_path);
			let parent = output_path
				.parent()
				.ok_or_else(|| invalid("destinationPath", "展開先を解決できません"))?;
			ensure_safe_directory_tree(
				&canonical_base,
				parent,
				&mut created_directories,
				&mut directory_tree,
				true,
			)?;
			if std::fs::symlink_metadata(&output_path).is_ok() {
				return Err(invalid(
					"destinationPath",
					"展開先に同名のファイルまたはリンクが既にあります",
				));
			}
			let persisted = persist_protected_noclobber(staged.file, &output_path, &directory_tree)
				.map_err(|error| {
					if error.kind() == std::io::ErrorKind::AlreadyExists {
						invalid(
							"destinationPath",
							"展開先に同名のファイルまたはリンクが既にあります",
						)
					} else {
						EngineError::Io(error)
					}
				})?;
			committed_files.push(created_path(output_path.clone(), persisted)?);
			extracted_paths.push(
				response_destination
					.join(&staged.relative_path)
					.to_string_lossy()
					.into_owned(),
			);
		}
		Ok(extracted_paths)
	})();
	match result {
		Ok(paths) => Ok(ExtractedZipFiles {
			paths,
			created_files: Some(committed_files),
			created_directories: Some(created_directories),
			directory_tree: Some(directory_tree),
		}),
		Err(error) => {
			drop(directory_tree);
			rollback_created_paths(committed_files, created_directories);
			Err(error)
		}
	}
}

fn plan_zip_entries<R: Read + Seek>(
	archive: &mut zip::ZipArchive<R>,
	flatten: bool,
) -> EngineResult<Vec<ZipEntryPlan>> {
	if archive.len() > MAX_ZIP_ENTRIES {
		return Err(invalid("fileMeta", "ZIP内の項目数が上限を超えています"));
	}
	let mut plans = Vec::new();
	let mut output_keys = HashSet::new();
	let mut declared_total = 0_u64;
	for archive_index in 0..archive.len() {
		let entry = archive
			.by_index(archive_index)
			.map_err(|_| invalid("fileMeta", "ZIP項目を読み込めません"))?;
		if entry
			.unix_mode()
			.is_some_and(|mode| mode & 0o170000 == 0o120000)
		{
			return Err(invalid(
				"fileMeta",
				"ZIP内のシンボリックリンクは展開できません",
			));
		}
		let enclosed = entry
			.enclosed_name()
			.ok_or_else(|| invalid("fileMeta", "ZIP内に不正なパスがあります"))?
			.to_path_buf();
		for component in enclosed.components() {
			match component {
				Component::Normal(value) => validate_file_name(&value.to_string_lossy())?,
				_ => return Err(invalid("fileMeta", "ZIP内に不正なパスがあります")),
			}
		}
		if entry.is_dir() {
			continue;
		}
		if !entry.is_file()
			|| entry.unix_mode().is_some_and(|mode| {
				let file_type = mode & 0o170000;
				file_type != 0 && file_type != 0o100000
			}) {
			return Err(invalid(
				"fileMeta",
				"ZIP内の通常ファイル以外は展開できません",
			));
		}
		let relative_path = if flatten {
			PathBuf::from(
				enclosed
					.file_name()
					.ok_or_else(|| invalid("fileMeta", "ZIP項目名が不正です"))?,
			)
		} else {
			enclosed
		};
		let output_key = zip_output_key(&relative_path)?;
		if !output_keys.insert(output_key.clone())
			|| output_keys.iter().any(|existing| {
				existing != &output_key
					&& (existing.starts_with(&format!("{output_key}/"))
						|| output_key.starts_with(&format!("{existing}/")))
			}) {
			return Err(invalid(
				"fileMeta",
				"ZIP内の展開先が重複または競合しています",
			));
		}
		declared_total = declared_total
			.checked_add(entry.size())
			.ok_or_else(|| invalid("fileMeta", "ZIP展開後の合計サイズが不正です"))?;
		if declared_total > MAX_EXTRACTED_BYTES {
			return Err(invalid(
				"fileMeta",
				"ZIP展開後の合計サイズが上限を超えています",
			));
		}
		plans.push(ZipEntryPlan {
			archive_index,
			relative_path,
			declared_size: entry.size(),
		});
	}
	if plans.is_empty() {
		return Err(invalid(
			"fileMeta",
			"通常ファイルを含まないZIPは展開できません",
		));
	}
	Ok(plans)
}

fn zip_output_key(path: &Path) -> EngineResult<String> {
	let components = path
		.components()
		.map(|component| match component {
			Component::Normal(value) => Ok(value.to_string_lossy().to_lowercase()),
			_ => Err(invalid("fileMeta", "ZIP内に不正なパスがあります")),
		})
		.collect::<EngineResult<Vec<_>>>()?;
	if components.is_empty() {
		return Err(invalid("fileMeta", "ZIP項目名が不正です"));
	}
	Ok(components.join("/"))
}

fn ensure_safe_directory_tree(
	base: &Path,
	directory: &Path,
	created_directories: &mut Vec<CreatedPath>,
	directory_tree: &mut SafeDirectoryTree,
	create_missing: bool,
) -> EngineResult<()> {
	let relative = relative_path_from_base(directory, base)
		.ok_or_else(|| invalid("destinationPath", "保存ルート外は指定できません"))?;
	let mut current = base.to_path_buf();
	for component in relative.components() {
		let Component::Normal(value) = component else {
			return Err(invalid("destinationPath", "展開先を安全に解決できません"));
		};
		current.push(value);
		if directory_tree.is_locked(&current) {
			continue;
		}
		match std::fs::symlink_metadata(&current) {
			Ok(metadata) => {
				validate_safe_directory_metadata(&metadata)?;
				directory_tree.lock_existing(&current)?;
			}
			Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_missing => {
				match std::fs::create_dir(&current) {
					Ok(()) => {
						let created = directory_tree.lock_created(&current)?;
						created_directories.push(created);
					}
					Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
						let metadata =
							std::fs::symlink_metadata(&current).map_err(EngineError::Io)?;
						validate_safe_directory_metadata(&metadata)?;
						directory_tree.lock_existing(&current)?;
					}
					Err(error) => return Err(EngineError::Io(error)),
				}
			}
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
				return Err(invalid("fileMeta", "保存済みZIPの親フォルダが存在しません"));
			}
			Err(error) => return Err(EngineError::Io(error)),
		}
	}
	Ok(())
}

impl SafeDirectoryTree {
	fn new(base: &Path) -> EngineResult<Self> {
		let mut tree = Self {
			base: base.to_path_buf(),
			locked_paths: HashSet::new(),
			#[cfg(windows)]
			handles: HashMap::new(),
		};
		let metadata = std::fs::symlink_metadata(base).map_err(EngineError::Io)?;
		validate_safe_directory_metadata(&metadata)?;
		tree.lock_existing(base)?;
		Ok(tree)
	}

	fn is_locked(&self, path: &Path) -> bool {
		self.locked_paths.contains(&directory_key(path))
	}

	fn lock_existing(&mut self, path: &Path) -> EngineResult<()> {
		if self.is_locked(path) {
			return Ok(());
		}
		if !path_starts_with(path, &self.base) {
			return Err(invalid("destinationPath", "保存ルート外は指定できません"));
		}
		#[cfg(windows)]
		{
			let handle = open_safe_directory(path, false).map_err(EngineError::Io)?;
			validate_safe_directory_metadata(&handle.metadata().map_err(EngineError::Io)?)?;
			self.handles.insert(directory_key(path), handle);
		}
		self.locked_paths.insert(directory_key(path));
		Ok(())
	}

	fn lock_created(&mut self, path: &Path) -> EngineResult<CreatedPath> {
		if !path_starts_with(path, &self.base) {
			return Err(invalid("destinationPath", "保存ルート外は指定できません"));
		}
		#[cfg(windows)]
		let created = {
			let handle = open_safe_directory(path, true).map_err(EngineError::Io)?;
			validate_safe_directory_metadata(&handle.metadata().map_err(EngineError::Io)?)?;
			self.handles.insert(
				directory_key(path),
				handle.try_clone().map_err(EngineError::Io)?,
			);
			CreatedPath {
				path: path.to_path_buf(),
				handle,
			}
		};
		#[cfg(not(windows))]
		let created = {
			let metadata = std::fs::symlink_metadata(path).map_err(EngineError::Io)?;
			validate_safe_directory_metadata(&metadata)?;
			CreatedPath {
				path: path.to_path_buf(),
				identity: file_identity(&metadata),
			}
		};
		self.locked_paths.insert(directory_key(path));
		Ok(created)
	}

	#[cfg(windows)]
	fn handle(&self, path: &Path) -> EngineResult<&File> {
		self.handles
			.get(&directory_key(path))
			.ok_or_else(|| invalid("destinationPath", "展開先の親フォルダを固定できません"))
	}
}

#[cfg(windows)]
fn directory_key(path: &Path) -> String {
	path.to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
fn directory_key(path: &Path) -> String {
	path.to_string_lossy().into_owned()
}

fn validate_safe_directory_metadata(metadata: &std::fs::Metadata) -> EngineResult<()> {
	if is_link_or_reparse(metadata) || !metadata.is_dir() {
		return Err(invalid(
			"destinationPath",
			"リンクまたはファイルを経由する展開先は指定できません",
		));
	}
	Ok(())
}

fn rollback_created_paths(files: Vec<CreatedPath>, directories: Vec<CreatedPath>) {
	for created in files.into_iter().rev() {
		remove_created_path_if_unchanged(created, false);
	}
	for created in directories.into_iter().rev() {
		remove_created_path_if_unchanged(created, true);
	}
}

#[cfg(windows)]
fn remove_created_path_if_unchanged(created: CreatedPath, _directory: bool) {
	if let Err(error) = mark_delete_by_handle(&created.handle) {
		eprintln!(
			"ZIP展開で新規作成したパスをハンドルからロールバックできませんでした（既存資料は削除しません）: {}: {error}",
			created.path.display()
		);
	}
}

#[cfg(not(windows))]
fn remove_created_path_if_unchanged(created: CreatedPath, directory: bool) {
	let Ok(metadata) = std::fs::symlink_metadata(&created.path) else {
		return;
	};
	if is_link_or_reparse(&metadata) || file_identity(&metadata) != created.identity {
		eprintln!(
			"ZIP展開のロールバック対象が置き換えられたため削除を中止しました: {}",
			created.path.display()
		);
		return;
	}
	let result = if directory {
		std::fs::remove_dir(&created.path)
	} else {
		std::fs::remove_file(&created.path)
	};
	if let Err(error) = result {
		eprintln!(
			"ZIP展開で新規作成したパスをロールバックできませんでした（既存資料は削除しません）: {}: {error}",
			created.path.display()
		);
	}
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
	use std::os::windows::fs::MetadataExt;

	const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
	metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
	metadata.file_type().is_symlink()
}

#[cfg(unix)]
fn file_identity(metadata: &std::fs::Metadata) -> FileIdentity {
	use std::os::unix::fs::MetadataExt;

	FileIdentity {
		device: metadata.dev(),
		inode: metadata.ino(),
	}
}

#[cfg(not(any(windows, unix)))]
fn file_identity(metadata: &std::fs::Metadata) -> FileIdentity {
	FileIdentity {
		created: metadata.created().ok(),
		length: metadata.len(),
	}
}

#[cfg(windows)]
fn safe_base_path(base: &Path) -> EngineResult<PathBuf> {
	validate_lexical_absolute_path(base, "targetPath")?;
	Ok(base.to_path_buf())
}

#[cfg(not(windows))]
fn safe_base_path(base: &Path) -> EngineResult<PathBuf> {
	std::fs::canonicalize(base).map_err(EngineError::Io)
}

#[cfg(windows)]
fn safe_source_path(base: &Path, source: &Path) -> EngineResult<PathBuf> {
	validate_lexical_absolute_path(source, "fileMeta")?;
	let relative = relative_path_from_base(source, base)
		.ok_or_else(|| invalid("fileMeta", "保存ルート外のZIPは展開できません"))?;
	Ok(base.join(relative))
}

#[cfg(not(windows))]
fn safe_source_path(_base: &Path, source: &Path) -> EngineResult<PathBuf> {
	std::fs::canonicalize(source).map_err(EngineError::Io)
}

#[cfg(windows)]
fn validate_lexical_absolute_path(path: &Path, field: &str) -> EngineResult<()> {
	if !path.is_absolute()
		|| path
			.components()
			.any(|component| matches!(component, Component::ParentDir | Component::CurDir))
	{
		return Err(invalid(field, "正規化済みの絶対パスを指定してください"));
	}
	Ok(())
}

#[cfg(windows)]
fn created_path(path: PathBuf, handle: File) -> EngineResult<CreatedPath> {
	let created = CreatedPath { path, handle };
	let metadata = match created.handle.metadata() {
		Ok(metadata) => metadata,
		Err(error) => {
			let message = error.to_string();
			remove_created_path_if_unchanged(created, false);
			return Err(EngineError::Io(std::io::Error::new(error.kind(), message)));
		}
	};
	if is_link_or_reparse(&metadata) || !metadata.is_file() {
		remove_created_path_if_unchanged(created, false);
		return Err(invalid(
			"destinationPath",
			"通常ファイル以外を展開先として確定できません",
		));
	}
	Ok(created)
}

#[cfg(not(windows))]
fn created_path(path: PathBuf, handle: File) -> EngineResult<CreatedPath> {
	let metadata = match handle.metadata() {
		Ok(metadata) => metadata,
		Err(error) => {
			eprintln!(
				"確定後ファイルの同一性を確認できないため安全な補償削除を見送りました: {}: {error}",
				path.display()
			);
			return Err(EngineError::Io(error));
		}
	};
	let created = CreatedPath {
		path,
		identity: file_identity(&metadata),
	};
	if is_link_or_reparse(&metadata) || !metadata.is_file() {
		remove_created_path_if_unchanged(created, metadata.is_dir());
		return Err(invalid(
			"destinationPath",
			"通常ファイル以外を展開先として確定できません",
		));
	}
	Ok(created)
}

struct StagingDirectoryGuard {
	#[cfg(windows)]
	_handle: File,
}

fn lock_staging_directory(path: &Path) -> EngineResult<StagingDirectoryGuard> {
	let metadata = std::fs::symlink_metadata(path).map_err(EngineError::Io)?;
	validate_safe_directory_metadata(&metadata)?;
	#[cfg(windows)]
	{
		let handle = open_safe_directory(path, false).map_err(EngineError::Io)?;
		validate_safe_directory_metadata(&handle.metadata().map_err(EngineError::Io)?)?;
		Ok(StagingDirectoryGuard { _handle: handle })
	}
	#[cfg(not(windows))]
	{
		Ok(StagingDirectoryGuard {})
	}
}

#[cfg(windows)]
fn open_safe_directory(path: &Path, delete_access: bool) -> std::io::Result<File> {
	use std::fs::OpenOptions;
	use std::os::windows::fs::OpenOptionsExt;
	use windows_sys::Win32::Foundation::GENERIC_READ;
	use windows_sys::Win32::Storage::FileSystem::{
		DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
		FILE_SHARE_WRITE,
	};

	let mut access = GENERIC_READ;
	if delete_access {
		access |= DELETE;
	}
	OpenOptions::new()
		.access_mode(access)
		.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
		.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
		.open(path)
}

#[cfg(windows)]
fn open_safe_zip_source(path: &Path) -> EngineResult<File> {
	use std::fs::OpenOptions;
	use std::os::windows::fs::OpenOptionsExt;
	use windows_sys::Win32::Foundation::GENERIC_READ;
	use windows_sys::Win32::Storage::FileSystem::{
		FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_SEQUENTIAL_SCAN, FILE_SHARE_READ,
	};

	let file = OpenOptions::new()
		.access_mode(GENERIC_READ)
		.share_mode(FILE_SHARE_READ)
		.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN)
		.open(path)
		.map_err(EngineError::Io)?;
	let metadata = file.metadata().map_err(EngineError::Io)?;
	if is_link_or_reparse(&metadata) || !metadata.is_file() {
		return Err(invalid(
			"fileMeta",
			"リンクまたは通常ファイル以外はZIPとして展開できません",
		));
	}
	Ok(file)
}

#[cfg(not(windows))]
fn open_safe_zip_source(path: &Path) -> EngineResult<File> {
	let metadata = std::fs::symlink_metadata(path).map_err(EngineError::Io)?;
	if is_link_or_reparse(&metadata) || !metadata.is_file() {
		return Err(invalid(
			"fileMeta",
			"リンクまたは通常ファイル以外はZIPとして展開できません",
		));
	}
	File::open(path).map_err(EngineError::Io)
}

#[cfg(windows)]
fn new_protected_tempfile(directory: &Path) -> std::io::Result<NamedTempFile<File>> {
	use std::fs::OpenOptions;
	use std::os::windows::fs::OpenOptionsExt;
	use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
	use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE};

	tempfile::Builder::new()
		.prefix(".fuzzy-entry-")
		.make_in(directory, |path| {
			OpenOptions::new()
				.read(true)
				.write(true)
				.access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
				.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
				.create_new(true)
				.open(path)
		})
}

#[cfg(not(windows))]
fn new_protected_tempfile(directory: &Path) -> std::io::Result<NamedTempFile<File>> {
	NamedTempFile::new_in(directory)
}

#[cfg(windows)]
fn persist_protected_noclobber(
	staged: NamedTempFile<File>,
	destination: &Path,
	directory_tree: &SafeDirectoryTree,
) -> std::io::Result<File> {
	let (file, temporary_path) = staged.into_parts();
	let parent = destination.parent().ok_or_else(|| {
		std::io::Error::new(
			std::io::ErrorKind::InvalidInput,
			"展開先の親フォルダを解決できません",
		)
	})?;
	let parent_handle = directory_tree
		.handle(parent)
		.map_err(|error| std::io::Error::other(error.to_string()))?;
	let rename_result =
		rename_file_by_handle_noclobber(&file, destination, parent_handle).map_err(|error| {
			std::io::Error::new(
				error.kind(),
				format!(
					"保護ハンドルから展開ファイルを確定できません (OS error {:?})",
					error.raw_os_error()
				),
			)
		});
	if let Err(error) = rename_result {
		drop(file);
		drop(temporary_path);
		return Err(error);
	}
	drop(temporary_path);
	Ok(file)
}

#[cfg(not(windows))]
fn persist_protected_noclobber(
	staged: NamedTempFile<File>,
	destination: &Path,
	_directory_tree: &SafeDirectoryTree,
) -> std::io::Result<File> {
	staged
		.persist_noclobber(destination)
		.map_err(|error| error.error)
}

#[cfg(windows)]
fn rename_file_by_handle_noclobber(
	file: &File,
	destination: &Path,
	_parent_handle: &File,
) -> std::io::Result<()> {
	use std::os::windows::ffi::OsStrExt;
	use std::os::windows::io::AsRawHandle;
	use windows_sys::Win32::Storage::FileSystem::{
		FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO,
	};

	destination.file_name().ok_or_else(|| {
		std::io::Error::new(
			std::io::ErrorKind::InvalidInput,
			"展開先のファイル名を解決できません",
		)
	})?;
	let file_name = destination.as_os_str().encode_wide().collect::<Vec<_>>();
	let byte_size = std::mem::size_of::<FILE_RENAME_INFO>()
		.checked_add(
			file_name
				.len()
				.saturating_add(1)
				.saturating_mul(std::mem::size_of::<u16>()),
		)
		.ok_or_else(|| {
			std::io::Error::new(
				std::io::ErrorKind::InvalidInput,
				"展開先のファイル名が長すぎます",
			)
		})?;
	let word_size = std::mem::size_of::<usize>();
	let mut buffer = vec![0usize; byte_size.div_ceil(word_size)];
	let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
	unsafe {
		(*info).Anonymous.ReplaceIfExists = false;
		(*info).RootDirectory = std::ptr::null_mut();
		(*info).FileNameLength =
			u32::try_from(file_name.len().saturating_mul(2)).map_err(|_| {
				std::io::Error::new(
					std::io::ErrorKind::InvalidInput,
					"展開先のファイル名が長すぎます",
				)
			})?;
		std::ptr::copy_nonoverlapping(
			file_name.as_ptr(),
			std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
			file_name.len(),
		);
		if SetFileInformationByHandle(
			file.as_raw_handle().cast(),
			FileRenameInfo,
			info.cast(),
			u32::try_from(byte_size).map_err(|_| {
				std::io::Error::new(
					std::io::ErrorKind::InvalidInput,
					"展開先のファイル名が長すぎます",
				)
			})?,
		) == 0
		{
			return Err(std::io::Error::last_os_error());
		}
	}
	Ok(())
}

#[cfg(windows)]
fn mark_delete_by_handle(file: &File) -> std::io::Result<()> {
	use std::os::windows::io::AsRawHandle;
	use windows_sys::Win32::Storage::FileSystem::{
		FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
	};

	let information = FILE_DISPOSITION_INFO { DeleteFile: true };
	let result = unsafe {
		SetFileInformationByHandle(
			file.as_raw_handle().cast(),
			FileDispositionInfo,
			std::ptr::addr_of!(information).cast(),
			u32::try_from(std::mem::size_of::<FILE_DISPOSITION_INFO>())
				.expect("FILE_DISPOSITION_INFOのサイズはu32に収まる"),
		)
	};
	if result == 0 {
		Err(std::io::Error::last_os_error())
	} else {
		Ok(())
	}
}

struct PendingFile {
	descriptor: SaveFileDescriptor,
	bytes: Vec<u8>,
	next_chunk_index: u32,
}

struct PendingSimilarityTransfer {
	byte_length: usize,
	bytes: Vec<u8>,
	next_chunk_index: u32,
}

impl FileTransferManager {
	pub fn begin(
		&mut self,
		base_folder: &Path,
		request: BeginSaveFilesRequest,
	) -> EngineResult<()> {
		validate_transfer_id(&request.transfer_id)?;
		if self.contains_transfer(&request.transfer_id) {
			return Err(invalid("transferId", "同じ転送IDは再利用できません"));
		}
		if self.active_transfer_count() >= MAX_ACTIVE_TRANSFERS {
			return Err(invalid("transferId", "同時転送数の上限を超えています"));
		}
		if request.files.is_empty() || request.files.len() > MAX_FILES_PER_TRANSFER {
			return Err(invalid("files", "保存ファイル数が許容範囲外です"));
		}
		if request.course_id.is_some_and(|course_id| course_id <= 0) {
			return Err(invalid("courseId", "正の整数またはnullを指定してください"));
		}
		let total_bytes = request
			.files
			.iter()
			.try_fold(0usize, |total, file| total.checked_add(file.byte_length))
			.ok_or_else(|| invalid("files", "転送サイズが大きすぎます"))?;
		if total_bytes > MAX_TRANSFER_BYTES {
			return Err(invalid("files", "転送サイズが大きすぎます"));
		}

		let target_path = validate_target_path(base_folder, &request.target_path)?;
		let mut file_ids = HashSet::new();
		let mut files = HashMap::new();
		for descriptor in request.files {
			validate_descriptor(&descriptor)?;
			if !file_ids.insert(descriptor.file_id.clone()) {
				return Err(invalid("files", "fileIdが重複しています"));
			}
			files.insert(
				descriptor.file_id.clone(),
				PendingFile {
					descriptor,
					bytes: Vec::new(),
					next_chunk_index: 0,
				},
			);
		}
		self.transfers.insert(
			request.transfer_id,
			PendingTransfer {
				target_path,
				course_id: request.course_id,
				files,
			},
		);
		Ok(())
	}

	pub fn append(&mut self, request: AppendSaveFileChunkRequest) -> EngineResult<()> {
		let transfer = self
			.transfers
			.get_mut(&request.transfer_id)
			.ok_or_else(|| invalid("transferId", "転送が開始されていません"))?;
		let file = transfer
			.files
			.get_mut(&request.file_id)
			.ok_or_else(|| invalid("fileId", "転送対象に含まれていません"))?;
		if request.chunk_index != file.next_chunk_index {
			return Err(invalid("chunkIndex", "チャンクの順序が不正です"));
		}
		let decoded = decode_chunk(&request.data_base64)?;
		if file.bytes.len().saturating_add(decoded.len()) > file.descriptor.byte_length {
			return Err(invalid("dataBase64", "宣言サイズを超えています"));
		}
		file.bytes.extend_from_slice(&decoded);
		file.next_chunk_index += 1;
		Ok(())
	}

	pub fn begin_similarity(&mut self, request: BeginCheckSimilarFileRequest) -> EngineResult<()> {
		validate_transfer_id(&request.transfer_id)?;
		if self.contains_transfer(&request.transfer_id) {
			return Err(invalid("transferId", "同じ転送IDは再利用できません"));
		}
		if self.active_transfer_count() >= MAX_ACTIVE_TRANSFERS {
			return Err(invalid("transferId", "同時転送数の上限を超えています"));
		}
		if request.byte_length == 0 || request.byte_length > MAX_FILE_BYTES {
			return Err(invalid("byteLength", "ファイルサイズが許容範囲外です"));
		}
		self.similarity_transfers.insert(
			request.transfer_id,
			PendingSimilarityTransfer {
				byte_length: request.byte_length,
				bytes: Vec::new(),
				next_chunk_index: 0,
			},
		);
		Ok(())
	}

	pub fn append_similarity(
		&mut self,
		request: AppendCheckSimilarFileChunkRequest,
	) -> EngineResult<()> {
		let mut transfer = self
			.similarity_transfers
			.remove(&request.transfer_id)
			.ok_or_else(|| invalid("transferId", "転送が開始されていません"))?;
		if request.chunk_index != transfer.next_chunk_index {
			return Err(invalid("chunkIndex", "チャンクの順序が不正です"));
		}
		let decoded = decode_chunk(&request.data_base64)?;
		if transfer.bytes.len().saturating_add(decoded.len()) > transfer.byte_length {
			return Err(invalid("dataBase64", "宣言サイズを超えています"));
		}
		transfer.bytes.extend_from_slice(&decoded);
		transfer.next_chunk_index += 1;
		self.similarity_transfers
			.insert(request.transfer_id, transfer);
		Ok(())
	}

	pub fn finish_similarity(&mut self, transfer_id: &str) -> EngineResult<Vec<u8>> {
		let transfer = self
			.similarity_transfers
			.remove(transfer_id)
			.ok_or_else(|| invalid("transferId", "転送が開始されていません"))?;
		if transfer.bytes.len() != transfer.byte_length {
			return Err(invalid(
				"transferId",
				"宣言サイズ分の転送が完了していません",
			));
		}
		Ok(transfer.bytes)
	}

	pub fn commit(
		&mut self,
		database: &Database,
		base_folder: &Path,
		transfer_id: &str,
	) -> EngineResult<FileTransferCommitResult> {
		let transfer = self
			.transfers
			.remove(transfer_id)
			.ok_or_else(|| invalid("transferId", "転送が開始されていません"))?;
		let requested_target =
			validate_target_path(base_folder, transfer.target_path.to_string_lossy().as_ref())?;
		let safe_base = safe_base_path(base_folder)?;
		let target_relative = relative_path_from_base(&requested_target, base_folder)
			.ok_or_else(|| invalid("targetPath", "保存ルート外の保存先は指定できません"))?;
		let target_path = safe_base.join(target_relative);
		let mut directory_tree = SafeDirectoryTree::new(&safe_base)?;
		let mut created_directories = Vec::new();
		ensure_safe_directory_tree(
			&safe_base,
			&target_path,
			&mut created_directories,
			&mut directory_tree,
			true,
		)?;

		let mut saved_file_ids = Vec::new();
		let mut failed_files = Vec::new();
		let mut files_to_index = Vec::new();
		for (_, file) in transfer.files {
			let file_id = file.descriptor.file_id.clone();
			if file.bytes.len() != file.descriptor.byte_length || !valid_content(&file) {
				failed_files.push(SaveFileFailure {
					file_id,
					code: SaveFileFailureCode::InvalidContent,
				});
				continue;
			}

			let destination = target_path.join(&file.descriptor.file_name);
			if destination.exists() {
				failed_files.push(SaveFileFailure {
					file_id,
					code: SaveFileFailureCode::AlreadyExists,
				});
				continue;
			}
			let mut output = match new_protected_tempfile(&target_path) {
				Ok(output) => output,
				Err(_error) => {
					failed_files.push(SaveFileFailure {
						file_id,
						code: SaveFileFailureCode::IoError,
					});
					continue;
				}
			};
			if output
				.write_all(&file.bytes)
				.and_then(|()| output.flush())
				.and_then(|()| output.as_file().sync_all())
				.is_err()
			{
				failed_files.push(SaveFileFailure {
					file_id,
					code: SaveFileFailureCode::IoError,
				});
				continue;
			}
			let persisted = match persist_protected_noclobber(output, &destination, &directory_tree)
			{
				Ok(persisted) => persisted,
				Err(error) => {
					failed_files.push(SaveFileFailure {
						file_id,
						code: if error.kind() == std::io::ErrorKind::AlreadyExists {
							SaveFileFailureCode::AlreadyExists
						} else {
							SaveFileFailureCode::IoError
						},
					});
					continue;
				}
			};
			let created = match created_path(destination.clone(), persisted) {
				Ok(created) => created,
				Err(error) => {
					eprintln!("保存ファイルの確定後検証に失敗しました: {error}");
					failed_files.push(SaveFileFailure {
						file_id,
						code: SaveFileFailureCode::IoError,
					});
					continue;
				}
			};

			let fingerprint = DefaultDuplicateDetector::default().fingerprint(&destination);
			let registration = fingerprint.and_then(|fingerprint| {
				database.register_saved_file(&SavedFileRegistration {
					course_id: transfer.course_id,
					section_no: parse_section_file_prefix(&file.descriptor.file_name)
						.and_then(|section| section.number)
						.map(i64::from),
					moodle_file_id: Some(file.descriptor.file_id.clone()),
					original_name: file.descriptor.file_name.clone(),
					saved_path: destination.clone(),
					size_bytes: i64::try_from(file.descriptor.byte_length).map_err(|_| {
						invalid("byteLength", "ファイルサイズをSQLiteへ保存できません")
					})?,
					mime_type: file.descriptor.mime_type.clone(),
					hash_blake3: fingerprint.hash_blake3,
					simhash: fingerprint.simhash,
				})
			});
			let database_id = match registration {
				Ok(database_id) => database_id,
				Err(error) => {
					eprintln!("保存ファイルのメタデータ登録に失敗しました: {error}");
					remove_created_path_if_unchanged(created, false);
					failed_files.push(SaveFileFailure {
						file_id,
						code: SaveFileFailureCode::IoError,
					});
					continue;
				}
			};
			drop(created);
			saved_file_ids.push(file_id);
			files_to_index.push(SavedFileForIndex {
				database_id,
				path: destination,
			});
		}
		Ok(FileTransferCommitResult {
			response: SaveFilesResult {
				saved_file_ids,
				failed_files,
			},
			files_to_index,
		})
	}

	fn contains_transfer(&self, transfer_id: &str) -> bool {
		self.transfers.contains_key(transfer_id)
			|| self.similarity_transfers.contains_key(transfer_id)
	}

	fn active_transfer_count(&self) -> usize {
		self.transfers.len() + self.similarity_transfers.len()
	}
}

fn decode_chunk(data_base64: &str) -> EngineResult<Vec<u8>> {
	if data_base64.is_empty() || data_base64.len() > MAX_ENCODED_CHUNK_CHARACTERS {
		return Err(invalid("dataBase64", "チャンクサイズが許容範囲外です"));
	}
	let decoded = STANDARD
		.decode(data_base64)
		.map_err(|_| invalid("dataBase64", "Base64データが不正です"))?;
	if decoded.is_empty() || decoded.len() > MAX_DECODED_CHUNK_BYTES {
		return Err(invalid("dataBase64", "チャンクサイズが許容範囲外です"));
	}
	Ok(decoded)
}

fn validate_descriptor(file: &SaveFileDescriptor) -> EngineResult<()> {
	if file.file_id.is_empty() || file.file_id.len() > 2048 {
		return Err(invalid("fileId", "fileIdの長さが不正です"));
	}
	if file.byte_length == 0 || file.byte_length > MAX_FILE_BYTES {
		return Err(invalid("byteLength", "ファイルサイズが許容範囲外です"));
	}
	validate_file_name(&file.file_name)
}

fn validate_transfer_id(value: &str) -> EngineResult<()> {
	if value.is_empty()
		|| value.len() > 64
		|| !value
			.chars()
			.all(|character| character.is_ascii_alphanumeric() || character == '-')
	{
		return Err(invalid("transferId", "転送IDの形式が不正です"));
	}
	Ok(())
}

fn validate_target_path(base_folder: &Path, target_path: &str) -> EngineResult<PathBuf> {
	let target = PathBuf::from(target_path);
	if !base_folder.is_absolute() || !target.is_absolute() {
		return Err(invalid("targetPath", "絶対パスを指定してください"));
	}
	if target
		.components()
		.any(|component| matches!(component, Component::ParentDir))
	{
		return Err(invalid("targetPath", "親フォルダへの移動は指定できません"));
	}
	if !path_starts_with(&target, base_folder) {
		return Err(invalid("targetPath", "保存ルート外は指定できません"));
	}
	let canonical_base = std::fs::canonicalize(base_folder)
		.map_err(|_| invalid("targetPath", "保存ルートが存在しないかアクセスできません"))?;
	let mut existing_ancestor = target.as_path();
	while !existing_ancestor.exists() {
		existing_ancestor = existing_ancestor
			.parent()
			.ok_or_else(|| invalid("targetPath", "保存先を解決できません"))?;
	}
	let canonical_ancestor = std::fs::canonicalize(existing_ancestor)
		.map_err(|_| invalid("targetPath", "保存先を解決できません"))?;
	if !path_starts_with(&canonical_ancestor, &canonical_base) {
		return Err(invalid(
			"targetPath",
			"シンボリックリンクを経由した保存ルート外は指定できません",
		));
	}
	Ok(target)
}

#[cfg(windows)]
fn relative_path_from_base(path: &Path, base: &Path) -> Option<PathBuf> {
	let path_components = path.components().collect::<Vec<_>>();
	let base_components = base.components().collect::<Vec<_>>();
	if path_components.len() < base_components.len()
		|| !path_components
			.iter()
			.zip(&base_components)
			.all(|(left, right)| {
				left.as_os_str()
					.to_string_lossy()
					.eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
			}) {
		return None;
	}
	let mut relative = PathBuf::new();
	for component in &path_components[base_components.len()..] {
		relative.push(component.as_os_str());
	}
	Some(relative)
}

#[cfg(not(windows))]
fn relative_path_from_base(path: &Path, base: &Path) -> Option<PathBuf> {
	path.strip_prefix(base).ok().map(Path::to_path_buf)
}

#[cfg(windows)]
fn path_starts_with(path: &Path, base: &Path) -> bool {
	path.to_string_lossy()
		.to_lowercase()
		.starts_with(&base.to_string_lossy().to_lowercase())
		&& path
			.strip_prefix(base)
			.map(|relative| !relative.is_absolute())
			.unwrap_or_else(|_| {
				path.to_string_lossy()
					.to_lowercase()
					.strip_prefix(&base.to_string_lossy().to_lowercase())
					.is_some_and(|suffix| suffix.is_empty() || suffix.starts_with(['\\', '/']))
			})
}

#[cfg(not(windows))]
fn path_starts_with(path: &Path, base: &Path) -> bool {
	path.starts_with(base)
}

fn validate_file_name(file_name: &str) -> EngineResult<()> {
	if file_name.is_empty()
		|| file_name == "."
		|| file_name == ".."
		|| file_name.encode_utf16().count() > 255
		|| file_name.ends_with([' ', '.'])
		|| file_name
			.chars()
			.any(|character| character.is_control() || r#"<>:"/\|?*"#.contains(character))
	{
		return Err(invalid("fileName", "Windowsで使用できないファイル名です"));
	}
	let stem = file_name
		.split('.')
		.next()
		.unwrap_or_default()
		.to_ascii_uppercase();
	let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
		|| (stem.len() == 4
			&& (stem.starts_with("COM") || stem.starts_with("LPT"))
			&& stem.as_bytes()[3].is_ascii_digit()
			&& stem.as_bytes()[3] != b'0');
	if reserved {
		return Err(invalid("fileName", "Windows予約名は使用できません"));
	}
	Ok(())
}

fn valid_content(file: &PendingFile) -> bool {
	let prefix = String::from_utf8_lossy(&file.bytes[..file.bytes.len().min(512)])
		.trim_start()
		.to_ascii_lowercase();
	if prefix.starts_with("<!doctype html") || prefix.starts_with("<html") {
		return false;
	}
	let is_docx = file
		.descriptor
		.file_name
		.to_ascii_lowercase()
		.ends_with(".docx")
		|| file.descriptor.mime_type.as_deref().is_some_and(|mime| {
			mime.to_ascii_lowercase()
				.contains("wordprocessingml.document")
		});
	!is_docx || valid_docx_content(&file.bytes)
}

fn valid_docx_content(bytes: &[u8]) -> bool {
	let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(bytes)) else {
		return false;
	};
	readable_docx_entry(&mut archive, "[Content_Types].xml")
		&& readable_docx_entry(&mut archive, "word/document.xml")
}

fn readable_docx_entry<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, name: &str) -> bool {
	let Ok(mut entry) = archive.by_name(name) else {
		return false;
	};
	let expected_size = entry.size();
	if !entry.is_file() || expected_size == 0 || expected_size > MAX_FILE_BYTES as u64 {
		return false;
	}
	std::io::copy(
		&mut entry.by_ref().take(expected_size.saturating_add(1)),
		&mut std::io::sink(),
	)
	.is_ok_and(|read_size| read_size == expected_size)
}

fn invalid(field: &str, reason: &str) -> EngineError {
	EngineError::InvalidInput {
		field: field.to_string(),
		reason: reason.to_string(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::api_types::{
		AppendCheckSimilarFileChunkRequest, AppendSaveFileChunkRequest,
		BeginCheckSimilarFileRequest, BeginSaveFilesRequest, SaveFileDescriptor,
	};
	use std::time::{SystemTime, UNIX_EPOCH};
	use zip::write::SimpleFileOptions;

	#[test]
	fn saves_valid_docx_and_rejects_html_without_overwriting() {
		let root = unique_temp_dir();
		let target = root.join("course");
		std::fs::create_dir_all(&root).unwrap();
		let database = Database::open_in_memory().unwrap();
		let docx = docx_bytes();
		let mut manager = FileTransferManager::default();
		manager
			.begin(
				&root,
				begin_request(&target, "transfer-1", "guide.docx", docx.len()),
			)
			.unwrap();
		manager
			.append(AppendSaveFileChunkRequest {
				transfer_id: "transfer-1".to_string(),
				file_id: "file-1".to_string(),
				chunk_index: 0,
				data_base64: STANDARD.encode(&docx),
			})
			.unwrap();
		let result = manager.commit(&database, &root, "transfer-1").unwrap();
		assert_eq!(result.response.saved_file_ids, vec!["file-1"]);
		assert_eq!(result.files_to_index.len(), 1);
		assert_eq!(result.files_to_index[0].path, target.join("guide.docx"));
		assert_eq!(std::fs::read(target.join("guide.docx")).unwrap(), docx);
		assert_eq!(
			database.saved_file_path_by_moodle_id("file-1").unwrap(),
			target.join("guide.docx").canonicalize().unwrap()
		);

		let mut invalid_manager = FileTransferManager::default();
		let html = b"<!doctype html>";
		invalid_manager
			.begin(
				&root,
				begin_request(&target, "transfer-2", "login.docx", html.len()),
			)
			.unwrap();
		invalid_manager
			.append(AppendSaveFileChunkRequest {
				transfer_id: "transfer-2".to_string(),
				file_id: "file-1".to_string(),
				chunk_index: 0,
				data_base64: STANDARD.encode(html),
			})
			.unwrap();
		let result = invalid_manager
			.commit(&database, &root, "transfer-2")
			.unwrap();
		assert!(result.response.saved_file_ids.is_empty());
		assert!(result.files_to_index.is_empty());
		assert_eq!(
			result.response.failed_files[0].code,
			SaveFileFailureCode::InvalidContent
		);
		assert!(!target.join("login.docx").exists());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn rejects_corrupt_docx_and_zip_without_docx_entries() {
		let root = unique_temp_dir();
		let target = root.join("course");
		std::fs::create_dir_all(&root).unwrap();
		let database = Database::open_in_memory().unwrap();
		let invalid_files = [
			(
				"corrupt.docx",
				vec![0x50, 0x4b, 0x03, 0x04, 0x01],
				"transfer-corrupt",
			),
			(
				"ordinary.docx",
				zip_bytes(&[("guide.txt", b"guide")]),
				"transfer-ordinary",
			),
			(
				"missing-document.docx",
				zip_bytes(&[("[Content_Types].xml", b"<Types/>")]),
				"transfer-missing-document",
			),
			(
				"corrupt-entry.docx",
				corrupt_docx_bytes(),
				"transfer-corrupt-entry",
			),
		];

		for (file_name, contents, transfer_id) in invalid_files {
			let mut manager = FileTransferManager::default();
			manager
				.begin(
					&root,
					begin_request(&target, transfer_id, file_name, contents.len()),
				)
				.unwrap();
			manager
				.append(AppendSaveFileChunkRequest {
					transfer_id: transfer_id.to_string(),
					file_id: "file-1".to_string(),
					chunk_index: 0,
					data_base64: STANDARD.encode(contents),
				})
				.unwrap();

			let result = manager.commit(&database, &root, transfer_id).unwrap();

			assert!(result.response.saved_file_ids.is_empty());
			assert!(result.files_to_index.is_empty());
			assert_eq!(
				result.response.failed_files[0].code,
				SaveFileFailureCode::InvalidContent
			);
			assert!(!target.join(file_name).exists());
		}

		let mime_only_contents = zip_bytes(&[("guide.txt", b"guide")]);
		let mut mime_only_request = begin_request(
			&target,
			"transfer-mime-only",
			"ordinary.bin",
			mime_only_contents.len(),
		);
		mime_only_request.files[0].mime_type = Some(
			"APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.WORDPROCESSINGML.DOCUMENT".to_string(),
		);
		let mut mime_only_manager = FileTransferManager::default();
		mime_only_manager.begin(&root, mime_only_request).unwrap();
		mime_only_manager
			.append(AppendSaveFileChunkRequest {
				transfer_id: "transfer-mime-only".to_string(),
				file_id: "file-1".to_string(),
				chunk_index: 0,
				data_base64: STANDARD.encode(mime_only_contents),
			})
			.unwrap();
		let result = mime_only_manager
			.commit(&database, &root, "transfer-mime-only")
			.unwrap();
		assert!(result.response.saved_file_ids.is_empty());
		assert!(result.files_to_index.is_empty());
		assert_eq!(
			result.response.failed_files[0].code,
			SaveFileFailureCode::InvalidContent
		);
		assert!(!target.join("ordinary.bin").exists());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn keeps_an_existing_file_when_the_destination_appears_before_commit() {
		let root = unique_temp_dir();
		let target = root.join("course");
		std::fs::create_dir_all(&target).unwrap();
		let database = Database::open_in_memory().unwrap();
		let mut manager = FileTransferManager::default();
		manager
			.begin(
				&root,
				begin_request(&target, "transfer-race", "existing.pdf", 4),
			)
			.unwrap();
		manager
			.append(AppendSaveFileChunkRequest {
				transfer_id: "transfer-race".to_string(),
				file_id: "file-1".to_string(),
				chunk_index: 0,
				data_base64: STANDARD.encode([0x50, 0x4b, 0x03, 0x04]),
			})
			.unwrap();

		let existing_path = target.join("existing.pdf");
		std::fs::write(&existing_path, b"original").unwrap();
		let result = manager.commit(&database, &root, "transfer-race").unwrap();

		assert!(result.response.saved_file_ids.is_empty());
		assert!(result.files_to_index.is_empty());
		assert_eq!(
			result.response.failed_files[0].code,
			SaveFileFailureCode::AlreadyExists
		);
		assert_eq!(std::fs::read(existing_path).unwrap(), b"original");
		assert_eq!(
			std::fs::read_dir(&target).unwrap().count(),
			1,
			"競合失敗後に一時ファイルを残さないこと"
		);
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn database_registration_failure_removes_only_the_just_published_file() {
		let root = unique_temp_dir();
		let target = root.join("course");
		std::fs::create_dir_all(&root).unwrap();
		let database = Database::open_in_memory().unwrap();
		let contents = b"%PDF-test";
		let mut request =
			begin_request(&target, "transfer-db-failure", "guide.pdf", contents.len());
		request.course_id = Some(999);
		let mut manager = FileTransferManager::default();
		manager.begin(&root, request).unwrap();
		manager
			.append(AppendSaveFileChunkRequest {
				transfer_id: "transfer-db-failure".to_string(),
				file_id: "file-1".to_string(),
				chunk_index: 0,
				data_base64: STANDARD.encode(contents),
			})
			.unwrap();

		let result = manager
			.commit(&database, &root, "transfer-db-failure")
			.unwrap();

		assert!(result.response.saved_file_ids.is_empty());
		assert_eq!(
			result.response.failed_files[0].code,
			SaveFileFailureCode::IoError
		);
		assert!(!target.join("guide.pdf").exists());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn rebuilds_similarity_content_from_ordered_chunks() {
		let mut manager = FileTransferManager::default();
		manager
			.begin_similarity(BeginCheckSimilarFileRequest {
				transfer_id: "similar-1".to_string(),
				byte_length: 6,
			})
			.unwrap();
		for (chunk_index, contents) in [b"abc".as_slice(), b"def"].into_iter().enumerate() {
			manager
				.append_similarity(AppendCheckSimilarFileChunkRequest {
					transfer_id: "similar-1".to_string(),
					chunk_index: chunk_index as u32,
					data_base64: STANDARD.encode(contents),
				})
				.unwrap();
		}

		assert_eq!(manager.finish_similarity("similar-1").unwrap(), b"abcdef");
		assert!(manager.finish_similarity("similar-1").is_err());
	}

	#[test]
	fn discards_invalid_or_incomplete_similarity_transfers() {
		for (transfer_id, byte_length, data_base64) in [
			("invalid-base64", 4, "not base64!".to_string()),
			(
				"oversized-chunk",
				4,
				"A".repeat(MAX_ENCODED_CHUNK_CHARACTERS + 4),
			),
			("empty-chunk", 1, String::new()),
			("declared-overflow", 3, STANDARD.encode(b"test")),
		] {
			let mut manager = FileTransferManager::default();
			manager
				.begin_similarity(BeginCheckSimilarFileRequest {
					transfer_id: transfer_id.to_string(),
					byte_length,
				})
				.unwrap();
			assert!(manager
				.append_similarity(AppendCheckSimilarFileChunkRequest {
					transfer_id: transfer_id.to_string(),
					chunk_index: 0,
					data_base64,
				})
				.is_err());
			assert!(manager.finish_similarity(transfer_id).is_err());
		}

		let mut manager = FileTransferManager::default();
		manager
			.begin_similarity(BeginCheckSimilarFileRequest {
				transfer_id: "wrong-order".to_string(),
				byte_length: 4,
			})
			.unwrap();
		assert!(manager
			.append_similarity(AppendCheckSimilarFileChunkRequest {
				transfer_id: "wrong-order".to_string(),
				chunk_index: 1,
				data_base64: STANDARD.encode(b"test"),
			})
			.is_err());
		assert!(manager.finish_similarity("wrong-order").is_err());

		manager
			.begin_similarity(BeginCheckSimilarFileRequest {
				transfer_id: "incomplete".to_string(),
				byte_length: 5,
			})
			.unwrap();
		manager
			.append_similarity(AppendCheckSimilarFileChunkRequest {
				transfer_id: "incomplete".to_string(),
				chunk_index: 0,
				data_base64: STANDARD.encode(b"test"),
			})
			.unwrap();
		assert!(manager.finish_similarity("incomplete").is_err());
		assert!(manager.finish_similarity("incomplete").is_err());
	}

	#[test]
	fn enforces_similarity_size_and_combined_active_transfer_limits() {
		let contract_compatible_chunk = "A".repeat(192 * 1024 + 4);
		assert_eq!(
			decode_chunk(&contract_compatible_chunk).unwrap().len(),
			(192 * 1024 + 4) / 4 * 3
		);

		let mut manager = FileTransferManager::default();
		for byte_length in [0, MAX_FILE_BYTES + 1] {
			assert!(manager
				.begin_similarity(BeginCheckSimilarFileRequest {
					transfer_id: format!("invalid-{byte_length}"),
					byte_length,
				})
				.is_err());
		}
		manager
			.begin_similarity(BeginCheckSimilarFileRequest {
				transfer_id: "maximum-size".to_string(),
				byte_length: MAX_FILE_BYTES,
			})
			.unwrap();
		assert!(manager.finish_similarity("maximum-size").is_err());

		let root = unique_temp_dir();
		let target = root.join("course");
		std::fs::create_dir_all(&root).unwrap();
		manager
			.begin(&root, begin_request(&target, "shared-id", "guide.pdf", 1))
			.unwrap();
		assert!(manager
			.begin_similarity(BeginCheckSimilarFileRequest {
				transfer_id: "shared-id".to_string(),
				byte_length: 1,
			})
			.is_err());
		for index in 0..3 {
			manager
				.begin_similarity(BeginCheckSimilarFileRequest {
					transfer_id: format!("active-{index}"),
					byte_length: 1,
				})
				.unwrap();
		}
		assert!(manager
			.begin_similarity(BeginCheckSimilarFileRequest {
				transfer_id: "active-over-limit".to_string(),
				byte_length: 1,
			})
			.is_err());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn extracts_safe_zip_entries_and_rejects_parent_traversal() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let safe_zip = root.join("safe.zip");
		write_zip(&safe_zip, "folder/guide.txt", b"guide");
		let destination = root.join("safe-output");

		let pending =
			extract_zip_archive(&root, &safe_zip, &destination.to_string_lossy(), false).unwrap();
		assert_eq!(
			pending.paths(),
			&[destination
				.join("folder/guide.txt")
				.to_string_lossy()
				.into_owned()]
		);
		assert_eq!(
			std::fs::read(destination.join("folder/guide.txt")).unwrap(),
			b"guide"
		);
		let extracted = pending.commit();
		assert_eq!(extracted.len(), 1);

		let unsafe_zip = root.join("unsafe.zip");
		write_zip(&unsafe_zip, "../escaped.txt", b"escape");
		let unsafe_destination = root.join("unsafe-output");
		assert!(extract_zip_archive(
			&root,
			&unsafe_zip,
			&unsafe_destination.to_string_lossy(),
			false,
		)
		.is_err());
		assert!(!root.join("escaped.txt").exists());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn zip_extraction_is_all_or_nothing_and_preserves_existing_files() {
		let root = unique_temp_dir();
		let destination = root.join("output");
		std::fs::create_dir_all(&destination).unwrap();
		std::fs::write(destination.join("keep.txt"), b"user material").unwrap();
		let archive_path = root.join("conflict.zip");
		write_zip_entries(
			&archive_path,
			&[
				("new/fresh.txt", b"fresh"),
				("keep.txt", b"must not overwrite"),
			],
		);

		assert!(
			extract_zip_archive(&root, &archive_path, &destination.to_string_lossy(), false,)
				.is_err()
		);
		assert_eq!(
			std::fs::read(destination.join("keep.txt")).unwrap(),
			b"user material"
		);
		assert!(!destination.join("new/fresh.txt").exists());
		assert!(!destination.join("new").exists());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn corrupt_later_zip_entry_never_publishes_earlier_entries() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let archive_path = root.join("corrupt.zip");
		let mut archive_bytes = zip_bytes(&[
			("first.txt", b"FIRST-PAYLOAD"),
			("second.txt", b"SECOND-PAYLOAD-UNIQUE"),
		]);
		let marker = b"SECOND-PAYLOAD-UNIQUE";
		let marker_offset = archive_bytes
			.windows(marker.len())
			.position(|window| window == marker)
			.unwrap();
		archive_bytes[marker_offset] ^= 0x01;
		std::fs::write(&archive_path, archive_bytes).unwrap();
		let destination = root.join("output");

		assert!(
			extract_zip_archive(&root, &archive_path, &destination.to_string_lossy(), false,)
				.is_err()
		);
		assert!(!destination.exists());
		assert!(std::fs::read_dir(&root).unwrap().all(|entry| {
			!entry
				.unwrap()
				.file_name()
				.to_string_lossy()
				.starts_with(ZIP_STAGING_PREFIX)
		}));
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn dropping_uncommitted_zip_result_rolls_back_every_created_path() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let archive_path = root.join("pending.zip");
		write_zip(&archive_path, "nested/guide.txt", b"guide");
		let destination = root.join("output");

		let pending =
			extract_zip_archive(&root, &archive_path, &destination.to_string_lossy(), false)
				.unwrap();
		assert!(destination.join("nested/guide.txt").is_file());
		drop(pending);

		assert!(!destination.exists());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn rejects_empty_and_directory_only_zip_archives() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		for (name, directories) in [("empty.zip", &[][..]), ("dirs.zip", &["folder/"][..])] {
			let archive_path = root.join(name);
			write_directory_zip(&archive_path, directories);
			let destination = root.join(format!("{name}-output"));

			assert!(extract_zip_archive(
				&root,
				&archive_path,
				&destination.to_string_lossy(),
				false,
			)
			.is_err());
			assert!(!destination.exists());
		}
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn rejects_flattened_name_collisions_before_creating_destination() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let archive_path = root.join("duplicate.zip");
		write_zip_entries(
			&archive_path,
			&[
				("folder-a/Guide.txt", b"first"),
				("folder-b/guide.txt", b"second"),
			],
		);
		let destination = root.join("output");

		assert!(
			extract_zip_archive(&root, &archive_path, &destination.to_string_lossy(), true,)
				.is_err()
		);
		assert!(!destination.exists());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn rejects_declared_zip_bomb_size_before_extraction() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let archive_path = root.join("oversized.zip");
		let mut archive_bytes = zip_bytes(&[("oversized.txt", b"x")]);
		let central_header = archive_bytes
			.windows(4)
			.position(|window| window == b"PK\x01\x02")
			.unwrap();
		let declared_size = u32::try_from(MAX_EXTRACTED_BYTES + 1).unwrap();
		archive_bytes[central_header + 24..central_header + 28]
			.copy_from_slice(&declared_size.to_le_bytes());
		std::fs::write(&archive_path, archive_bytes).unwrap();
		let destination = root.join("output");

		assert!(
			extract_zip_archive(&root, &archive_path, &destination.to_string_lossy(), false,)
				.is_err()
		);
		assert!(!destination.exists());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn rejects_link_parent_inside_an_existing_destination() {
		let container = unique_temp_dir();
		let root = container.join("base");
		let destination = root.join("output");
		let outside = container.join("outside");
		std::fs::create_dir_all(&destination).unwrap();
		std::fs::create_dir_all(&outside).unwrap();
		let linked_parent = destination.join("linked");
		if create_test_directory_link(&outside, &linked_parent).is_err() {
			std::fs::remove_dir_all(container).unwrap();
			return;
		}
		let archive_path = root.join("linked.zip");
		write_zip(&archive_path, "linked/escape.txt", b"escape");

		assert!(
			extract_zip_archive(&root, &archive_path, &destination.to_string_lossy(), false,)
				.is_err()
		);
		assert!(!outside.join("escape.txt").exists());
		assert!(std::fs::symlink_metadata(&linked_parent).is_ok());
		remove_test_directory_link(&linked_parent).unwrap();
		std::fs::remove_dir_all(container).unwrap();
	}

	#[test]
	fn rejects_zip_source_reached_through_a_linked_parent() {
		let container = unique_temp_dir();
		let root = container.join("base");
		let outside = container.join("outside");
		std::fs::create_dir_all(&root).unwrap();
		std::fs::create_dir_all(&outside).unwrap();
		let archive_path = outside.join("source.zip");
		write_zip(&archive_path, "guide.txt", b"guide");
		let linked_parent = root.join("linked");
		if create_test_directory_link(&outside, &linked_parent).is_err() {
			std::fs::remove_dir_all(container).unwrap();
			return;
		}
		let linked_archive = linked_parent.join("source.zip");
		let destination = root.join("output");

		assert!(extract_zip_archive(
			&root,
			&linked_archive,
			&destination.to_string_lossy(),
			false,
		)
		.is_err());
		assert!(!destination.exists());
		remove_test_directory_link(&linked_parent).unwrap();
		std::fs::remove_dir_all(container).unwrap();
	}

	#[cfg(windows)]
	#[test]
	fn held_directory_handles_block_rename_until_the_operation_finishes() {
		let root = unique_temp_dir();
		let destination = root.join("output");
		std::fs::create_dir_all(&destination).unwrap();
		let safe_base = safe_base_path(&root).unwrap();
		let mut tree = SafeDirectoryTree::new(&safe_base).unwrap();
		let mut created = Vec::new();
		ensure_safe_directory_tree(&safe_base, &destination, &mut created, &mut tree, false)
			.unwrap();

		let moved = root.join("moved");
		assert!(std::fs::rename(&destination, &moved).is_err());
		drop(tree);
		std::fs::rename(&destination, &moved).unwrap();
		std::fs::remove_dir_all(root).unwrap();
	}

	#[cfg(windows)]
	#[test]
	fn safe_zip_source_handle_blocks_replacement_and_rejects_reparse_files() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let archive_path = root.join("source.zip");
		write_zip(&archive_path, "guide.txt", b"guide");

		let source = open_safe_zip_source(&archive_path).unwrap();
		assert!(std::fs::rename(&archive_path, root.join("moved.zip")).is_err());
		drop(source);

		let link_path = root.join("source-link.zip");
		if std::os::windows::fs::symlink_file(&archive_path, &link_path).is_ok() {
			assert!(open_safe_zip_source(&link_path).is_err());
			std::fs::remove_file(link_path).unwrap();
		}
		std::fs::remove_dir_all(root).unwrap();
	}

	#[cfg(windows)]
	#[test]
	fn published_file_handle_blocks_replacement_and_rolls_back_by_handle() {
		let root = unique_temp_dir();
		let destination = root.join("output");
		std::fs::create_dir_all(&destination).unwrap();
		let safe_base = safe_base_path(&root).unwrap();
		let mut tree = SafeDirectoryTree::new(&safe_base).unwrap();
		let mut created_directories = Vec::new();
		ensure_safe_directory_tree(
			&safe_base,
			&destination,
			&mut created_directories,
			&mut tree,
			false,
		)
		.unwrap();
		let mut staged = new_protected_tempfile(&destination).unwrap();
		staged.write_all(b"new").unwrap();
		let output = destination.join("guide.txt");
		let persisted = persist_protected_noclobber(staged, &output, &tree).unwrap();
		let created = created_path(output.clone(), persisted).unwrap();

		assert!(std::fs::rename(&output, destination.join("replaced.txt")).is_err());
		remove_created_path_if_unchanged(created, false);
		assert!(!output.exists());
		drop(tree);
		std::fs::remove_dir_all(root).unwrap();
	}

	#[cfg(windows)]
	#[test]
	fn pending_zip_result_keeps_existing_parent_handles_until_commit() {
		let root = unique_temp_dir();
		let destination = root.join("output");
		std::fs::create_dir_all(&destination).unwrap();
		let archive_path = root.join("source.zip");
		write_zip(&archive_path, "guide.txt", b"guide");

		let pending =
			extract_zip_archive(&root, &archive_path, &destination.to_string_lossy(), false)
				.unwrap();
		let moved = root.join("moved");
		assert!(std::fs::rename(&destination, &moved).is_err());

		pending.commit();
		std::fs::rename(&destination, &moved).unwrap();
		std::fs::remove_dir_all(root).unwrap();
	}

	#[cfg(windows)]
	#[test]
	fn invalid_created_object_is_removed_through_its_handle() {
		let root = unique_temp_dir();
		let invalid_output = root.join("not-a-file");
		std::fs::create_dir_all(&invalid_output).unwrap();
		let handle = open_safe_directory(&invalid_output, true).unwrap();

		assert!(created_path(invalid_output.clone(), handle).is_err());
		assert!(!invalid_output.exists());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn rejects_target_outside_base_folder() {
		let root = unique_temp_dir();
		let outside = root.parent().unwrap().join("outside");
		let mut manager = FileTransferManager::default();
		assert!(manager
			.begin(
				&root,
				begin_request(&outside, "transfer-3", "guide.docx", 4)
			)
			.is_err());
	}

	fn begin_request(
		target: &Path,
		transfer_id: &str,
		file_name: &str,
		byte_length: usize,
	) -> BeginSaveFilesRequest {
		BeginSaveFilesRequest {
			transfer_id: transfer_id.to_string(),
			target_path: target.to_string_lossy().into_owned(),
			course_id: None,
			files: vec![SaveFileDescriptor {
				file_id: "file-1".to_string(),
				file_name: file_name.to_string(),
				mime_type: Some(
					if file_name.to_ascii_lowercase().ends_with(".docx") {
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
					} else {
						"application/octet-stream"
					}
					.to_string(),
				),
				byte_length,
			}],
		}
	}

	fn unique_temp_dir() -> PathBuf {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		std::env::temp_dir().join(format!(
			"fuzzy-file-transfer-{}-{suffix}",
			std::process::id()
		))
	}

	fn write_zip(path: &Path, entry_name: &str, contents: &[u8]) {
		write_zip_entries(path, &[(entry_name, contents)]);
	}

	fn write_zip_entries(path: &Path, entries: &[(&str, &[u8])]) {
		let file = std::fs::File::create(path).unwrap();
		let mut archive = zip::ZipWriter::new(file);
		for (entry_name, contents) in entries {
			archive
				.start_file(*entry_name, SimpleFileOptions::default())
				.unwrap();
			archive.write_all(contents).unwrap();
		}
		archive.finish().unwrap();
	}

	fn write_directory_zip(path: &Path, directories: &[&str]) {
		let file = std::fs::File::create(path).unwrap();
		let mut archive = zip::ZipWriter::new(file);
		for directory in directories {
			archive
				.add_directory(*directory, SimpleFileOptions::default())
				.unwrap();
		}
		archive.finish().unwrap();
	}

	#[cfg(windows)]
	fn create_test_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
		std::os::windows::fs::symlink_dir(target, link)
	}

	#[cfg(unix)]
	fn create_test_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
		std::os::unix::fs::symlink(target, link)
	}

	#[cfg(not(any(windows, unix)))]
	fn create_test_directory_link(_target: &Path, _link: &Path) -> std::io::Result<()> {
		Err(std::io::Error::new(
			std::io::ErrorKind::Unsupported,
			"directory links are unsupported",
		))
	}

	#[cfg(windows)]
	fn remove_test_directory_link(link: &Path) -> std::io::Result<()> {
		std::fs::remove_dir(link)
	}

	#[cfg(not(windows))]
	fn remove_test_directory_link(link: &Path) -> std::io::Result<()> {
		std::fs::remove_file(link)
	}

	fn docx_bytes() -> Vec<u8> {
		zip_bytes(&[
			(
				"[Content_Types].xml",
				br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#,
			),
			(
				"word/document.xml",
				br#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>"#,
			),
		])
	}

	fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
		let buffer = Cursor::new(Vec::new());
		let mut archive = zip::ZipWriter::new(buffer);
		for (entry_name, contents) in entries {
			archive
				.start_file(
					*entry_name,
					SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
				)
				.unwrap();
			archive.write_all(contents).unwrap();
		}
		archive.finish().unwrap().into_inner()
	}

	fn corrupt_docx_bytes() -> Vec<u8> {
		let mut bytes = docx_bytes();
		let marker = b"<w:document";
		let marker_offset = bytes
			.windows(marker.len())
			.position(|window| window == marker)
			.unwrap();
		bytes[marker_offset] ^= 0x01;
		bytes
	}
}
