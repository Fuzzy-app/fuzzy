//! SQLiteバックアップの書き出し・検証・安全な復元。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, DatabaseName, OpenFlags};

use super::{
	db_err, schema_version, validate_foreign_key_integrity, validate_schema_generation,
	validate_schema_generation_v1, Database,
};
use crate::{EngineError, EngineResult};

impl Database {
	/// SQLite Online Backup APIを使い、整合した生SQLiteファイルを書き出す。
	pub fn export_to(&self, destination: &Path) -> EngineResult<()> {
		if destination.exists() {
			return Err(EngineError::InvalidInput {
				field: "filePath".to_string(),
				reason: "既存ファイルを上書きしない保存先を指定してください".to_string(),
			});
		}
		if self
			.path
			.as_deref()
			.is_some_and(|database_path| paths_refer_to_same_file(database_path, destination))
		{
			return Err(EngineError::InvalidInput {
				field: "filePath".to_string(),
				reason: "使用中のデータベースとは別の保存先を指定してください".to_string(),
			});
		}
		if let Some(parent) = destination.parent() {
			if !parent.as_os_str().is_empty() {
				std::fs::create_dir_all(parent)?;
			}
		}

		let staging_path = temporary_sibling(destination, "export");
		let result = self
			.conn
			.backup(DatabaseName::Main, &staging_path, None)
			.map_err(db_err)
			.and_then(|_| std::fs::rename(&staging_path, destination).map_err(EngineError::from));
		if result.is_err() {
			let _ = std::fs::remove_file(&staging_path);
		}
		result
	}

	/// 生SQLiteバックアップを検証して復元し、索引メタ情報を無効化する。
	///
	/// Tantivy索引はバックアップへ含めないため、呼び出し側は既存索引も破棄し、
	/// `reindexRequired: true`を返す。
	pub fn import_from(&mut self, source: &Path) -> EngineResult<()> {
		let destination = self.path.clone().ok_or_else(|| EngineError::InvalidInput {
			field: "filePath".to_string(),
			reason: "メモリ上のデータベースへはインポートできません".to_string(),
		})?;
		if !source.is_file() {
			return Err(EngineError::InvalidInput {
				field: "filePath".to_string(),
				reason: "読み取り可能なSQLiteバックアップを指定してください".to_string(),
			});
		}
		if paths_refer_to_same_file(source, &destination) {
			return Err(EngineError::InvalidInput {
				field: "filePath".to_string(),
				reason: "使用中のデータベースとは別のバックアップを指定してください".to_string(),
			});
		}

		validate_import_source(source)?;
		let staging_path = temporary_sibling(&destination, "import");
		let source_connection =
			Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
				.map_err(db_err)?;
		if let Err(error) = source_connection.backup(DatabaseName::Main, &staging_path, None) {
			let _ = std::fs::remove_file(&staging_path);
			return Err(db_err(error));
		}
		let staged = match Self::open(&staging_path) {
			Ok(staged) => staged,
			Err(error) => {
				let _ = std::fs::remove_file(&staging_path);
				return Err(error);
			}
		};
		if let Err(error) = staged.clear_search_index_meta() {
			drop(staged);
			let _ = std::fs::remove_file(&staging_path);
			return Err(error);
		}
		drop(staged);

		// SQLite Online Backup APIの復元は、完了時にだけ宛先transactionをcommitする。
		// ファイルを一度退避してrenameする方式と異なり、失敗時にも現在のDBファイルと
		// 接続をそのまま利用でき、元DBの喪失や空DBの新規作成が起きない。
		let restore_result = self
			.conn
			.restore(
				DatabaseName::Main,
				&staging_path,
				None::<fn(rusqlite::backup::Progress)>,
			)
			.map_err(db_err);
		let _ = std::fs::remove_file(&staging_path);
		restore_result
	}
}

fn validate_import_source(path: &Path) -> EngineResult<()> {
	let conn =
		Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(db_err)?;
	let integrity: String = conn
		.query_row("PRAGMA integrity_check", [], |row| row.get(0))
		.map_err(db_err)?;
	if integrity != "ok" {
		return Err(EngineError::InvalidInput {
			field: "filePath".to_string(),
			reason: "SQLiteバックアップの整合性を確認できません".to_string(),
		});
	}
	let version = schema_version(&conn).map_err(invalid_backup)?;
	if version == 1 {
		validate_schema_generation_v1(&conn).map_err(invalid_backup)?;
	} else {
		validate_schema_generation(&conn, version).map_err(invalid_backup)?;
	}
	validate_foreign_key_integrity(&conn).map_err(invalid_backup)?;
	Ok(())
}

fn invalid_backup(error: EngineError) -> EngineError {
	EngineError::InvalidInput {
		field: "filePath".to_string(),
		reason: format!("Fuzzyバックアップのスキーマまたは外部キーが不正です: {error}"),
	}
}

fn temporary_sibling(path: &Path, purpose: &str) -> PathBuf {
	let nonce = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_nanos();
	let file_name = path
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or("fuzzy.db");
	path.with_file_name(format!(
		".{file_name}.{purpose}-{}-{nonce}",
		std::process::id()
	))
}

fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
	match (left.canonicalize(), right.canonicalize()) {
		(Ok(left), Ok(right)) => left == right,
		_ => left == right,
	}
}
