//! 重複・類似ファイルグループのSQLite読み取り。

use std::collections::BTreeMap;
use std::path::PathBuf;

#[cfg(test)]
use rusqlite::params;

use super::{db_err, Database};
use crate::types::{DuplicateFileRecord, DuplicateGroupRecord};
use crate::{EngineError, EngineResult};

impl Database {
	/// 重複グループと所属ファイルを、グループID・ファイルID順で取得する。
	pub fn duplicate_groups(&self) -> EngineResult<Vec<DuplicateGroupRecord>> {
		let mut statement = self
			.conn
			.prepare(
				"SELECT
					dg.id,
					dg.method,
					f.id,
					f.original_name,
					f.saved_path,
					dm.similarity
				 FROM duplicate_groups dg
				 JOIN duplicate_members dm ON dm.group_id = dg.id
				 JOIN files f ON f.id = dm.file_id
				 ORDER BY dg.id, f.id",
			)
			.map_err(db_err)?;
		let rows = statement
			.query_map([], |row| {
				Ok((
					row.get::<_, i64>(0)?,
					row.get::<_, String>(1)?,
					DuplicateFileRecord {
						file_id: row.get(2)?,
						file_name: row.get(3)?,
						saved_path: PathBuf::from(row.get::<_, String>(4)?),
						similarity: row.get(5)?,
					},
				))
			})
			.map_err(db_err)?
			.collect::<rusqlite::Result<Vec<_>>>()
			.map_err(db_err)?;

		let mut groups = BTreeMap::<i64, DuplicateGroupRecord>::new();
		for (group_id, method, member) in rows {
			validate_duplicate_member(&method, &member)?;
			let group = groups
				.entry(group_id)
				.or_insert_with(|| DuplicateGroupRecord {
					group_id,
					method: method.clone(),
					members: Vec::new(),
				});
			if group.method != method {
				return Err(EngineError::Database {
					message: format!("重複グループID {group_id} の判定方式が一致しません"),
				});
			}
			group.members.push(member);
		}
		Ok(groups.into_values().collect())
	}
}

fn validate_duplicate_member(method: &str, member: &DuplicateFileRecord) -> EngineResult<()> {
	if !matches!(method, "exact" | "similar") {
		return Err(EngineError::Database {
			message: "未対応の重複判定方式が保存されています".to_string(),
		});
	}
	if !(0.0..=1.0).contains(&member.similarity) {
		return Err(EngineError::Database {
			message: "重複ファイルの類似度が範囲外です".to_string(),
		});
	}
	if method == "exact" && member.similarity != 1.0 {
		return Err(EngineError::Database {
			message: "完全一致グループの類似度が1.0ではありません".to_string(),
		});
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::SEED_SQL;

	#[test]
	fn loads_seed_duplicate_group_with_members() {
		let database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();

		let groups = database.duplicate_groups().unwrap();
		assert_eq!(groups.len(), 1);
		assert_eq!(groups[0].method, "exact");
		assert_eq!(
			groups[0]
				.members
				.iter()
				.map(|member| member.file_id)
				.collect::<Vec<_>>(),
			vec![3, 9]
		);
		assert!(groups[0]
			.members
			.iter()
			.all(|member| member.similarity == 1.0));
	}

	#[test]
	fn rejects_inconsistent_exact_similarity_even_if_foreign_keys_are_disabled() {
		let database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		database
			.conn()
			.execute(
				"UPDATE duplicate_members SET similarity = ?1 WHERE group_id = 1 AND file_id = 3",
				params![0.5],
			)
			.unwrap();

		assert!(matches!(
			database.duplicate_groups(),
			Err(EngineError::Database { .. })
		));
	}
}
