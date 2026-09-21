//! 全文索引のヒットとSQLite正本を安全に結合する検索専用データアクセス。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use rusqlite::params_from_iter;

use super::setup::relative_path_within_base;
use super::{db_err, Database};
use crate::types::SearchDocumentMetadata;
use crate::EngineResult;

type SearchDocumentRecord = (
	i64,
	String,
	Option<String>,
	Option<i64>,
	PathBuf,
	Option<u32>,
	Option<i64>,
);

impl Database {
	/// 検索ヒットのファイル名・コース名をSQLiteの正本から取得する。
	pub fn search_document_metadata(
		&self,
		file_id: i64,
	) -> EngineResult<Option<SearchDocumentMetadata>> {
		Ok(self
			.search_document_metadata_batch(&[file_id])?
			.remove(&file_id))
	}

	/// 複数の検索ヒットを1回のSQLite照会で表示用メタデータへ変換する。
	///
	/// Tantivyはページ単位で同じ資料を複数返すため、IDを重複排除してから取得する。
	/// 保存ルート外の古い索引行は絶対パスを漏らさず、検索結果から除外する。
	pub fn search_document_metadata_batch(
		&self,
		file_ids: &[i64],
	) -> EngineResult<BTreeMap<i64, SearchDocumentMetadata>> {
		let file_ids = file_ids.iter().copied().collect::<BTreeSet<_>>();
		if file_ids.is_empty() {
			return Ok(BTreeMap::new());
		}
		let placeholders = placeholders(file_ids.len());
		let sql = format!(
			"SELECT files.id, files.original_name, courses.name,
			        files.course_id, files.saved_path, search_index_meta.page_count,
			        files.scan_modified_at_ns
			 FROM files
			 INNER JOIN search_index_meta ON search_index_meta.file_id = files.id
			 LEFT JOIN courses ON courses.id = files.course_id
			 WHERE files.id IN ({placeholders})
				AND files.missing_at IS NULL
				AND files.excluded_at IS NULL"
		);
		let mut statement = self.conn.prepare(&sql).map_err(db_err)?;
		let records = statement
			.query_map(params_from_iter(file_ids.iter()), |row| {
				Ok((
					row.get(0)?,
					row.get(1)?,
					row.get(2)?,
					row.get(3)?,
					PathBuf::from(row.get::<_, String>(4)?),
					row.get(5)?,
					row.get(6)?,
				))
			})
			.map_err(db_err)?
			.collect::<rusqlite::Result<Vec<SearchDocumentRecord>>>()
			.map_err(db_err)?;
		if records.is_empty() {
			return Ok(BTreeMap::new());
		}
		let base_folder = self.base_folder_path()?;
		Ok(records
			.into_iter()
			.filter_map(
				|(
					file_id,
					file_name,
					course_name,
					course_id,
					saved_path,
					page_count,
					modified_at,
				)| {
					let relative_path = relative_path_within_base(&saved_path, &base_folder)?
						.to_string_lossy()
						.replace('\\', "/");
					Some((
						file_id,
						SearchDocumentMetadata {
							file_id,
							file_name,
							course_id,
							course_name,
							relative_path,
							page_count,
							modified_at,
						},
					))
				},
			)
			.collect())
	}

	/// 指定範囲内で全文索引検索を許可する有効なファイルIDを返す。
	///
	/// 範囲指定をTantivyの上位件数取得後に適用すると、他コースの高得点結果に押し出された
	/// 対象コースの結果を失うため、検索実行前のフィルターとして使用する。
	pub fn search_document_ids_in_scope(
		&self,
		course_ids: Option<&[i64]>,
		folder: Option<&str>,
	) -> EngineResult<Vec<i64>> {
		if course_ids.is_some_and(|course_ids| course_ids.is_empty()) {
			return Ok(Vec::new());
		}
		let course_filter = course_ids.map_or_else(String::new, |course_ids| {
			format!(
				" AND files.course_id IN ({})",
				placeholders(course_ids.len())
			)
		});
		let sql = format!(
			"SELECT files.id, files.saved_path
			 FROM files
			 INNER JOIN search_index_meta ON search_index_meta.file_id = files.id
			 WHERE files.missing_at IS NULL
				AND files.excluded_at IS NULL
				{course_filter}
			 ORDER BY files.id"
		);
		let parameters = course_ids.unwrap_or_default();
		let mut statement = self.conn.prepare(&sql).map_err(db_err)?;
		let records = statement
			.query_map(params_from_iter(parameters.iter()), |row| {
				Ok((
					row.get::<_, i64>(0)?,
					PathBuf::from(row.get::<_, String>(1)?),
				))
			})
			.map_err(db_err)?
			.collect::<rusqlite::Result<Vec<_>>>()
			.map_err(db_err)?;
		if records.is_empty() {
			return Ok(Vec::new());
		}
		let base_folder = self.base_folder_path()?;
		Ok(records
			.into_iter()
			.filter_map(|(file_id, saved_path)| {
				let relative_path = relative_path_within_base(&saved_path, &base_folder)?
					.to_string_lossy()
					.replace('\\', "/");
				folder
					.is_none_or(|folder| {
						relative_path == folder || relative_path.starts_with(&format!("{folder}/"))
					})
					.then_some(file_id)
			})
			.collect())
	}
}

fn placeholders(count: usize) -> String {
	std::iter::repeat_n("?", count)
		.collect::<Vec<_>>()
		.join(", ")
}
