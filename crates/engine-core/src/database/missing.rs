//! 再スキャンで確認できない保存済みファイルの状態管理。

use std::path::PathBuf;

use rusqlite::{params, TransactionBehavior};

use super::{db_err, Database};
use crate::{EngineError, EngineResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredLibraryFile {
	pub file_id: i64,
	pub saved_path: PathBuf,
	pub is_missing: bool,
}

impl Database {
	/// SQLiteに保持している保存済みファイルを、実体確認用に読み込む。
	pub fn registered_library_files(&self) -> EngineResult<Vec<RegisteredLibraryFile>> {
		self.registered_library_files_for_course(None)
	}

	/// 指定コースに紐づく保存済みファイルだけを実体確認用に読み込む。
	pub fn registered_library_files_for_course(
		&self,
		course_id: Option<i64>,
	) -> EngineResult<Vec<RegisteredLibraryFile>> {
		let sql = if course_id.is_some() {
			"SELECT id, saved_path, missing_at IS NOT NULL
			 FROM files WHERE course_id = ?1 ORDER BY id"
		} else {
			"SELECT id, saved_path, missing_at IS NOT NULL FROM files ORDER BY id"
		};
		let mut statement = self.conn.prepare(sql).map_err(db_err)?;
		let map_row = |row: &rusqlite::Row<'_>| {
			Ok(RegisteredLibraryFile {
				file_id: row.get(0)?,
				saved_path: PathBuf::from(row.get::<_, String>(1)?),
				is_missing: row.get(2)?,
			})
		};
		let files = match course_id {
			Some(course_id) => statement
				.query_map([course_id], map_row)
				.map_err(db_err)?
				.collect::<rusqlite::Result<Vec<_>>>()
				.map_err(db_err)?,
			None => statement
				.query_map([], map_row)
				.map_err(db_err)?
				.collect::<rusqlite::Result<Vec<_>>>()
				.map_err(db_err)?,
		};
		Ok(files)
	}

	/// ファイル行を削除せず、実体の欠損状態だけを更新する。
	///
	/// 欠損へ変わる場合は検索メタ情報も同じトランザクションで無効化する。
	/// 戻り値は状態が変化したかを表す。
	pub fn update_library_file_presence(
		&mut self,
		file_id: i64,
		is_present: bool,
	) -> EngineResult<bool> {
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let was_missing = transaction
			.query_row(
				"SELECT missing_at IS NOT NULL FROM files WHERE id = ?1",
				[file_id],
				|row| row.get::<_, bool>(0),
			)
			.map_err(|error| match error {
				rusqlite::Error::QueryReturnedNoRows => EngineError::NotFound {
					entity: "ファイル".to_string(),
					id: file_id.to_string(),
				},
				other => db_err(other),
			})?;
		let is_missing = !is_present;
		if was_missing == is_missing {
			transaction.commit().map_err(db_err)?;
			return Ok(false);
		}

		if is_missing {
			transaction
				.execute(
					"UPDATE files
					 SET missing_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
					     rule_compliant = 1,
					     violation_reason = NULL
					 WHERE id = ?1",
					[file_id],
				)
				.map_err(db_err)?;
			transaction
				.execute(
					"DELETE FROM search_index_meta WHERE file_id = ?1",
					[file_id],
				)
				.map_err(db_err)?;
		} else {
			transaction
				.execute(
					"UPDATE files SET missing_at = NULL WHERE id = ?1",
					params![file_id],
				)
				.map_err(db_err)?;
		}
		transaction.commit().map_err(db_err)?;
		Ok(true)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn missing_state_preserves_the_file_row_and_invalidates_search_metadata() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO files (
					id, original_name, saved_path, size_bytes, hash_blake3
				 ) VALUES (41, '資料.pdf', 'C:\\Fuzzy\\資料.pdf', 12, ?1)",
				[format!("b3:{}", "a".repeat(64))],
			)
			.unwrap();
		database.mark_search_indexed(41, Some(2)).unwrap();

		assert!(database.update_library_file_presence(41, false).unwrap());
		assert!(!database.update_library_file_presence(41, false).unwrap());
		assert_eq!(database.registered_library_files().unwrap().len(), 1);
		assert!(database.registered_library_files().unwrap()[0].is_missing);
		assert!(database.search_document_metadata(41).unwrap().is_none());

		assert!(database.update_library_file_presence(41, true).unwrap());
		assert!(!database.registered_library_files().unwrap()[0].is_missing);
	}
}
