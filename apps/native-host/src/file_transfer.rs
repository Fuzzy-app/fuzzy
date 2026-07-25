//! 認証済み拡張機能が取得したファイル内容の分割受信と安全な実保存。

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use engine_core::duplicate::{DefaultDuplicateDetector, DuplicateDetector};
use engine_core::section::parse_section_file_prefix;
use engine_core::types::SavedFileRegistration;
use engine_core::{Database, EngineError, EngineResult};

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

#[derive(Default)]
pub struct FileTransferManager {
	transfers: HashMap<String, PendingTransfer>,
	similarity_transfers: HashMap<String, PendingSimilarityTransfer>,
}

struct PendingTransfer {
	target_path: PathBuf,
	course_id: Option<i64>,
	files: HashMap<String, PendingFile>,
}

pub fn extract_zip_archive(
	base_folder: &Path,
	source: &Path,
	destination_path: &str,
	flatten: bool,
) -> EngineResult<Vec<String>> {
	let destination = validate_target_path(base_folder, destination_path)?;
	let source = std::fs::canonicalize(source).map_err(EngineError::Io)?;
	let canonical_base = std::fs::canonicalize(base_folder).map_err(EngineError::Io)?;
	if !path_starts_with(&source, &canonical_base) {
		return Err(invalid("fileMeta", "保存ルート外のZIPは展開できません"));
	}
	let input = std::fs::File::open(&source).map_err(EngineError::Io)?;
	let mut archive = zip::ZipArchive::new(input)
		.map_err(|_| invalid("fileMeta", "ZIPファイルを読み込めません"))?;
	if archive.len() > MAX_ZIP_ENTRIES {
		return Err(invalid("fileMeta", "ZIP内の項目数が上限を超えています"));
	}
	std::fs::create_dir_all(&destination).map_err(EngineError::Io)?;

	let mut extracted_paths = Vec::new();
	let mut extracted_bytes = 0_u64;
	for index in 0..archive.len() {
		let mut entry = archive
			.by_index(index)
			.map_err(|_| invalid("fileMeta", "ZIP項目を読み込めません"))?;
		if entry.is_dir() {
			continue;
		}
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
			if let Component::Normal(value) = component {
				validate_file_name(&value.to_string_lossy())?;
			}
		}
		let relative = if flatten {
			PathBuf::from(
				enclosed
					.file_name()
					.ok_or_else(|| invalid("fileMeta", "ZIP項目名が不正です"))?,
			)
		} else {
			enclosed
		};
		let output_path = destination.join(relative);
		if let Some(parent) = output_path.parent() {
			std::fs::create_dir_all(parent).map_err(EngineError::Io)?;
		}
		let mut output = OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(&output_path)
			.map_err(EngineError::Io)?;
		let remaining = MAX_EXTRACTED_BYTES.saturating_sub(extracted_bytes);
		let copied = std::io::copy(&mut entry.by_ref().take(remaining + 1), &mut output)
			.map_err(EngineError::Io)?;
		if copied > remaining {
			drop(output);
			let _ = std::fs::remove_file(&output_path);
			return Err(invalid(
				"fileMeta",
				"ZIP展開後の合計サイズが上限を超えています",
			));
		}
		extracted_bytes += copied;
		extracted_paths.push(output_path.to_string_lossy().into_owned());
	}
	Ok(extracted_paths)
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
	) -> EngineResult<SaveFilesResult> {
		let transfer = self
			.transfers
			.remove(transfer_id)
			.ok_or_else(|| invalid("transferId", "転送が開始されていません"))?;
		let target_path =
			validate_target_path(base_folder, transfer.target_path.to_string_lossy().as_ref())?;
		std::fs::create_dir_all(&target_path).map_err(EngineError::Io)?;

		let mut saved_file_ids = Vec::new();
		let mut failed_files = Vec::new();
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
			let mut output = match OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(&destination)
			{
				Ok(output) => output,
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
			if output.write_all(&file.bytes).is_err() {
				drop(output);
				let _ = std::fs::remove_file(&destination);
				failed_files.push(SaveFileFailure {
					file_id,
					code: SaveFileFailureCode::IoError,
				});
				continue;
			}
			drop(output);

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
			if let Err(error) = registration {
				eprintln!("保存ファイルのメタデータ登録に失敗しました: {error}");
				let _ = std::fs::remove_file(&destination);
				failed_files.push(SaveFileFailure {
					file_id,
					code: SaveFileFailureCode::IoError,
				});
				continue;
			}
			saved_file_ids.push(file_id);
		}
		Ok(SaveFilesResult {
			saved_file_ids,
			failed_files,
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
		assert_eq!(result.saved_file_ids, vec!["file-1"]);
		assert_eq!(std::fs::read(target.join("guide.docx")).unwrap(), docx);
		assert_eq!(
			database.saved_file_path_by_moodle_id("file-1").unwrap(),
			target.join("guide.docx")
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
		assert!(result.saved_file_ids.is_empty());
		assert_eq!(
			result.failed_files[0].code,
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

			assert!(result.saved_file_ids.is_empty());
			assert_eq!(
				result.failed_files[0].code,
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
		assert!(result.saved_file_ids.is_empty());
		assert_eq!(
			result.failed_files[0].code,
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

		assert!(result.saved_file_ids.is_empty());
		assert_eq!(
			result.failed_files[0].code,
			SaveFileFailureCode::AlreadyExists
		);
		assert_eq!(std::fs::read(existing_path).unwrap(), b"original");
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

		let extracted =
			extract_zip_archive(&root, &safe_zip, &destination.to_string_lossy(), false).unwrap();
		assert_eq!(
			extracted,
			vec![destination
				.join("folder/guide.txt")
				.to_string_lossy()
				.into_owned()]
		);
		assert_eq!(
			std::fs::read(destination.join("folder/guide.txt")).unwrap(),
			b"guide"
		);

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
		let file = std::fs::File::create(path).unwrap();
		let mut archive = zip::ZipWriter::new(file);
		archive
			.start_file(entry_name, SimpleFileOptions::default())
			.unwrap();
		archive.write_all(contents).unwrap();
		archive.finish().unwrap();
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
