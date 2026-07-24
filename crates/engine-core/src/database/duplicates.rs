//! SQLite上のファイルフィンガープリントと重複グループの永続化。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use super::{db_err, Database};
use crate::duplicate::DuplicateDetector;
use crate::types::{
	DetectedDuplicateGroup, DuplicateMethod, DuplicateRefreshSummary, FileFingerprint,
	StoredFileFingerprint,
};
use crate::{EngineError, EngineResult};

impl Database {
	/// 保存前の照合や再計算に使う、SQLite上の全フィンガープリントを読み込む。
	pub fn load_file_fingerprints(&self) -> EngineResult<Vec<StoredFileFingerprint>> {
		load_file_fingerprints(&self.conn)
	}

	/// SQLiteに登録済みのファイルを読み、BLAKE3とSimHashを更新する。
	///
	/// ファイル内容や保存場所は変更しない。グループ再計算は
	/// [`Database::refresh_duplicate_groups`]で明示的に行う。
	pub fn refresh_file_fingerprint(
		&self,
		file_id: i64,
		detector: &impl DuplicateDetector,
	) -> EngineResult<FileFingerprint> {
		let saved_path = self
			.conn
			.query_row(
				"SELECT saved_path FROM files WHERE id = ?1",
				[file_id],
				|row| row.get::<_, String>(0),
			)
			.optional()
			.map_err(db_err)?
			.map(PathBuf::from)
			.ok_or_else(|| EngineError::NotFound {
				entity: "ファイル".to_string(),
				id: file_id.to_string(),
			})?;
		let fingerprint = detector.fingerprint(Path::new(&saved_path))?;
		let updated = self
			.conn
			.execute(
				"UPDATE files SET hash_blake3 = ?1, simhash = ?2 WHERE id = ?3",
				params![fingerprint.hash_blake3, fingerprint.simhash as i64, file_id],
			)
			.map_err(db_err)?;
		if updated != 1 {
			return Err(EngineError::Internal {
				message: format!("ファイルID {file_id} のフィンガープリントを更新できませんでした"),
			});
		}
		Ok(fingerprint)
	}

	/// SQLite上の全フィンガープリントから重複グループを再計算し、一括置換する。
	///
	/// 読み込み・判定・置換は`IMMEDIATE`トランザクションで行い、判定または保存に
	/// 失敗した場合は既存グループを保持する。ファイル自体は変更しない。
	pub fn refresh_duplicate_groups(
		&mut self,
		detector: &impl DuplicateDetector,
		threshold: f64,
	) -> EngineResult<DuplicateRefreshSummary> {
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let fingerprints = load_file_fingerprints(&transaction)?;
		let groups = detector.detect_groups(&fingerprints, threshold)?;
		let summary = replace_duplicate_groups(&transaction, &groups)?;
		transaction.commit().map_err(db_err)?;
		Ok(summary)
	}
}

fn load_file_fingerprints(conn: &Connection) -> EngineResult<Vec<StoredFileFingerprint>> {
	let mut statement = conn
		.prepare("SELECT id, hash_blake3, simhash FROM files ORDER BY id")
		.map_err(db_err)?;
	let fingerprints = statement
		.query_map([], |row| {
			Ok(StoredFileFingerprint {
				file_id: row.get(0)?,
				hash_blake3: row.get(1)?,
				simhash: row.get::<_, Option<i64>>(2)?.map(|value| value as u64),
			})
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	Ok(fingerprints)
}

fn replace_duplicate_groups(
	transaction: &Transaction<'_>,
	groups: &[DetectedDuplicateGroup],
) -> EngineResult<DuplicateRefreshSummary> {
	validate_groups(groups)?;
	transaction
		.execute("DELETE FROM duplicate_groups", [])
		.map_err(db_err)?;

	let mut summary = DuplicateRefreshSummary::default();
	for group in groups {
		let method = match group.method {
			DuplicateMethod::Exact => {
				summary.exact_group_count += 1;
				"exact"
			}
			DuplicateMethod::Similar => {
				summary.similar_group_count += 1;
				"similar"
			}
		};
		transaction
			.execute(
				"INSERT INTO duplicate_groups (method) VALUES (?1)",
				[method],
			)
			.map_err(db_err)?;
		let group_id = transaction.last_insert_rowid();
		for member in &group.members {
			transaction
				.execute(
					"INSERT INTO duplicate_members (group_id, file_id, similarity)
					 VALUES (?1, ?2, ?3)",
					params![group_id, member.file_id, member.similarity],
				)
				.map_err(db_err)?;
			summary.member_count += 1;
		}
	}
	Ok(summary)
}

fn validate_groups(groups: &[DetectedDuplicateGroup]) -> EngineResult<()> {
	for group in groups {
		if group.members.len() < 2 {
			return Err(EngineError::Internal {
				message: "重複グループには2件以上のファイルが必要です".to_string(),
			});
		}
		let mut file_ids = BTreeSet::new();
		for member in &group.members {
			if !file_ids.insert(member.file_id) {
				return Err(EngineError::Internal {
					message: format!(
						"重複グループ内でファイルID {} が重複しています",
						member.file_id
					),
				});
			}
			if !member.similarity.is_finite()
				|| !(0.0..=1.0).contains(&member.similarity)
				|| (group.method == DuplicateMethod::Exact && member.similarity != 1.0)
			{
				return Err(EngineError::Internal {
					message: format!(
						"ファイルID {} の類似度が重複グループの制約を満たしません",
						member.file_id
					),
				});
			}
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicU64, Ordering};

	use super::*;
	use crate::duplicate::{DefaultDuplicateDetector, DEFAULT_SIMILARITY_THRESHOLD};
	use crate::types::{DetectedDuplicateMember, DuplicateMatch};
	use crate::SEED_SQL;

	static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

	struct InvalidPersistenceDetector;

	impl DuplicateDetector for InvalidPersistenceDetector {
		fn fingerprint(&self, _path: &Path) -> EngineResult<FileFingerprint> {
			unreachable!("このテストでは呼び出さない")
		}

		fn find_exact(&self, _path: &Path) -> EngineResult<Vec<DuplicateMatch>> {
			unreachable!("このテストでは呼び出さない")
		}

		fn find_similar(&self, _path: &Path, _threshold: f64) -> EngineResult<Vec<DuplicateMatch>> {
			unreachable!("このテストでは呼び出さない")
		}

		fn detect_groups(
			&self,
			_fingerprints: &[StoredFileFingerprint],
			_threshold: f64,
		) -> EngineResult<Vec<DetectedDuplicateGroup>> {
			Ok(vec![DetectedDuplicateGroup {
				method: DuplicateMethod::Exact,
				members: vec![
					DetectedDuplicateMember {
						file_id: 3,
						similarity: 1.0,
					},
					DetectedDuplicateMember {
						file_id: i64::MAX,
						similarity: 1.0,
					},
				],
			}])
		}
	}

	fn stored_duplicate_rows(database: &Database) -> Vec<(i64, String, i64, f64)> {
		let mut statement = database
			.conn()
			.prepare(
				"SELECT g.id, g.method, m.file_id, m.similarity
				 FROM duplicate_groups g
				 JOIN duplicate_members m ON m.group_id = g.id
				 ORDER BY g.id, m.file_id",
			)
			.unwrap();
		statement
			.query_map([], |row| {
				Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
			})
			.unwrap()
			.collect::<rusqlite::Result<Vec<_>>>()
			.unwrap()
	}

	#[test]
	fn seed_exact_pair_is_detected_and_registered_again() {
		let mut database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		database
			.conn()
			.execute("DELETE FROM duplicate_groups", [])
			.unwrap();

		let summary = database
			.refresh_duplicate_groups(
				&DefaultDuplicateDetector::default(),
				DEFAULT_SIMILARITY_THRESHOLD,
			)
			.unwrap();

		let exact_pair_count: i64 = database
			.conn()
			.query_row(
				"SELECT count(*)
				 FROM duplicate_groups g
				 WHERE g.method = 'exact'
				   AND (SELECT count(*) FROM duplicate_members m WHERE m.group_id = g.id) = 2
				   AND EXISTS (
					SELECT 1 FROM duplicate_members m WHERE m.group_id = g.id AND m.file_id = 3
				   )
				   AND EXISTS (
					SELECT 1 FROM duplicate_members m WHERE m.group_id = g.id AND m.file_id = 9
				   )",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(summary.exact_group_count, 1);
		assert_eq!(summary.similar_group_count, 0);
		assert_eq!(exact_pair_count, 1);
	}

	#[test]
	fn failed_detection_keeps_existing_groups() {
		let mut database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();

		assert!(database
			.refresh_duplicate_groups(&DefaultDuplicateDetector::default(), f64::NAN)
			.is_err());

		let groups: i64 = database
			.conn()
			.query_row("SELECT count(*) FROM duplicate_groups", [], |row| {
				row.get(0)
			})
			.unwrap();
		assert_eq!(groups, 1);
	}

	#[test]
	fn failed_group_persistence_rolls_back_deleted_groups_and_members() {
		let mut database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		let before = stored_duplicate_rows(&database);

		assert!(database
			.refresh_duplicate_groups(&InvalidPersistenceDetector, DEFAULT_SIMILARITY_THRESHOLD,)
			.is_err());

		assert_eq!(stored_duplicate_rows(&database), before);
	}

	#[test]
	fn refresh_file_fingerprint_updates_only_metadata() {
		let database = Database::open_in_memory().unwrap();
		let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let directory = std::env::temp_dir().join(format!(
			"fuzzy-db-fingerprint-test-{}-{sequence}",
			std::process::id()
		));
		std::fs::create_dir_all(&directory).unwrap();
		let path = directory.join("第4回_正規化.pdf");
		std::fs::write(&path, b"database normalization").unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO files (
					id, original_name, saved_path, size_bytes, hash_blake3
				 ) VALUES (1, '第4回_正規化.pdf', ?1, 22, 'pending')",
				[path.to_string_lossy().as_ref()],
			)
			.unwrap();

		let fingerprint = database
			.refresh_file_fingerprint(1, &DefaultDuplicateDetector::default())
			.unwrap();

		let stored: (String, Option<i64>) = database
			.conn()
			.query_row(
				"SELECT hash_blake3, simhash FROM files WHERE id = 1",
				[],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(stored.0, fingerprint.hash_blake3);
		assert_eq!(
			stored.1.map(|value| value as u64),
			Some(fingerprint.simhash)
		);
		assert_eq!(std::fs::read(&path).unwrap(), b"database normalization");
		let _ = std::fs::remove_dir_all(directory);
	}
}
