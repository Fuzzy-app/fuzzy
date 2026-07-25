//! 認証済み拡張機能が取得したファイル内容の分割受信と安全な実保存。

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use engine_core::{EngineError, EngineResult};

use crate::api_types::{
	AppendSaveFileChunkRequest, BeginSaveFilesRequest, SaveFileDescriptor, SaveFileFailure,
	SaveFileFailureCode, SaveFilesResult,
};

const MAX_ACTIVE_TRANSFERS: usize = 4;
const MAX_FILES_PER_TRANSFER: usize = 20;
const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TRANSFER_BYTES: usize = 128 * 1024 * 1024;
const MAX_DECODED_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub struct FileTransferManager {
	transfers: HashMap<String, PendingTransfer>,
}

struct PendingTransfer {
	target_path: PathBuf,
	files: HashMap<String, PendingFile>,
}

struct PendingFile {
	descriptor: SaveFileDescriptor,
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
		if self.transfers.contains_key(&request.transfer_id) {
			return Err(invalid("transferId", "同じ転送IDは再利用できません"));
		}
		if self.transfers.len() >= MAX_ACTIVE_TRANSFERS {
			return Err(invalid("transferId", "同時転送数の上限を超えています"));
		}
		if request.files.is_empty() || request.files.len() > MAX_FILES_PER_TRANSFER {
			return Err(invalid("files", "保存ファイル数が許容範囲外です"));
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
		self.transfers
			.insert(request.transfer_id, PendingTransfer { target_path, files });
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
		let decoded = STANDARD
			.decode(request.data_base64)
			.map_err(|_| invalid("dataBase64", "Base64データが不正です"))?;
		if decoded.len() > MAX_DECODED_CHUNK_BYTES {
			return Err(invalid("dataBase64", "チャンクサイズが上限を超えています"));
		}
		if file.bytes.len().saturating_add(decoded.len()) > file.descriptor.byte_length {
			return Err(invalid("dataBase64", "宣言サイズを超えています"));
		}
		file.bytes.extend_from_slice(&decoded);
		file.next_chunk_index += 1;
		Ok(())
	}

	pub fn commit(
		&mut self,
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
			let result = OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(&destination)
				.and_then(|mut output| output.write_all(&file.bytes));
			if result.is_ok() {
				saved_file_ids.push(file_id);
			} else {
				let _ = std::fs::remove_file(&destination);
				failed_files.push(SaveFileFailure {
					file_id,
					code: SaveFileFailureCode::IoError,
				});
			}
		}
		Ok(SaveFilesResult {
			saved_file_ids,
			failed_files,
		})
	}
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
		|| file
			.descriptor
			.mime_type
			.as_deref()
			.is_some_and(|mime| mime.contains("wordprocessingml.document"));
	!is_docx
		|| matches!(
			file.bytes.get(..4),
			Some([0x50, 0x4b, 0x03, 0x04])
				| Some([0x50, 0x4b, 0x05, 0x06])
				| Some([0x50, 0x4b, 0x07, 0x08])
		)
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
	use crate::api_types::{AppendSaveFileChunkRequest, BeginSaveFilesRequest, SaveFileDescriptor};
	use std::time::{SystemTime, UNIX_EPOCH};

	#[test]
	fn saves_valid_docx_and_rejects_html_without_overwriting() {
		let root = unique_temp_dir();
		let target = root.join("course");
		std::fs::create_dir_all(&root).unwrap();
		let mut manager = FileTransferManager::default();
		manager
			.begin(&root, begin_request(&target, "transfer-1", "guide.docx", 5))
			.unwrap();
		manager
			.append(AppendSaveFileChunkRequest {
				transfer_id: "transfer-1".to_string(),
				file_id: "file-1".to_string(),
				chunk_index: 0,
				data_base64: STANDARD.encode([0x50, 0x4b, 0x03, 0x04, 0x01]),
			})
			.unwrap();
		let result = manager.commit(&root, "transfer-1").unwrap();
		assert_eq!(result.saved_file_ids, vec!["file-1"]);
		assert_eq!(
			std::fs::read(target.join("guide.docx")).unwrap(),
			vec![0x50, 0x4b, 0x03, 0x04, 0x01]
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
		let result = invalid_manager.commit(&root, "transfer-2").unwrap();
		assert!(result.saved_file_ids.is_empty());
		assert_eq!(
			result.failed_files[0].code,
			SaveFileFailureCode::InvalidContent
		);
		assert!(!target.join("login.docx").exists());
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
			files: vec![SaveFileDescriptor {
				file_id: "file-1".to_string(),
				file_name: file_name.to_string(),
				mime_type: Some(
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
}
