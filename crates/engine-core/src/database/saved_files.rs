//! Moodle資料の保存に伴うコース解決とファイルメタデータ永続化。

use std::path::PathBuf;

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::{db_err, Database};
use crate::types::{CourseContextRecord, DuplicateMatch, SavedFileRegistration, SimilarFileRecord};
use crate::{EngineError, EngineResult};

impl Database {
	/// Moodleの安定IDを優先し、ない場合は同名候補が一意な既存コースだけへ解決する。
	pub fn resolve_course_context(
		&mut self,
		moodle_course_id: Option<&str>,
		name: Option<&str>,
		academic_year: Option<i64>,
		term: Option<&str>,
	) -> EngineResult<CourseContextRecord> {
		if academic_year.is_some_and(|year| !(1900..=9999).contains(&year)) {
			return Err(invalid(
				"academicYear",
				"1900から9999の範囲で指定してください",
			));
		}
		let name = name.map(str::trim).filter(|value| !value.is_empty());
		let term = term.map(str::trim).filter(|value| !value.is_empty());
		let stable_id = moodle_course_id
			.map(str::trim)
			.filter(|value| !value.is_empty());
		if stable_id.is_some_and(|value| value.len() > 128) {
			return Err(invalid("moodleCourseId", "128文字以内で指定してください"));
		}

		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let course_id = if let Some(stable_id) = stable_id {
			let existing = transaction
				.query_row(
					"SELECT id FROM courses WHERE moodle_course_id = ?1",
					[stable_id],
					|row| row.get::<_, i64>(0),
				)
				.optional()
				.map_err(db_err)?;
			match existing {
				Some(course_id) => {
					transaction
						.execute(
							"UPDATE courses
							 SET name = COALESCE(?1, name),
							     academic_year = COALESCE(?2, academic_year),
							     term = COALESCE(?3, term),
							     updated_at = datetime('now')
							 WHERE id = ?4",
							params![name, academic_year, term, course_id],
						)
						.map_err(db_err)?;
					course_id
				}
				None => {
					let name = name
						.ok_or_else(|| invalid("course.name", "新しいコースには名称が必要です"))?;
					transaction
						.execute(
							"INSERT INTO courses (
								moodle_course_id, name, academic_year, term
							 ) VALUES (?1, ?2, ?3, ?4)",
							params![stable_id, name, academic_year, term],
						)
						.map_err(db_err)?;
					transaction.last_insert_rowid()
				}
			}
		} else {
			let name = name.ok_or_else(|| {
				invalid(
					"course",
					"moodleCourseIdがない場合は既存コースの名称が必要です",
				)
			})?;
			let mut statement = transaction
				.prepare("SELECT id FROM courses WHERE name = ?1 ORDER BY id")
				.map_err(db_err)?;
			let ids = statement
				.query_map([name], |row| row.get::<_, i64>(0))
				.map_err(db_err)?
				.collect::<rusqlite::Result<Vec<_>>>()
				.map_err(db_err)?;
			drop(statement);
			match ids.as_slice() {
				[course_id] => *course_id,
				[] => {
					return Err(EngineError::NotFound {
						entity: "コース".to_string(),
						id: name.to_string(),
					});
				}
				_ => {
					return Err(EngineError::RuleConflict {
						reason: "同名コースが複数あるためMoodleコースIDが必要です".to_string(),
					});
				}
			}
		};

		let record = transaction
			.query_row(
				"SELECT id, name, academic_year, term FROM courses WHERE id = ?1",
				[course_id],
				|row| {
					Ok(CourseContextRecord {
						course_id: row.get(0)?,
						name: row.get(1)?,
						academic_year: row.get(2)?,
						term: row.get(3)?,
					})
				},
			)
			.map_err(db_err)?;
		transaction.commit().map_err(db_err)?;
		Ok(record)
	}

	/// 実ファイルが作成された後、そのメタデータとフィンガープリントをSQLiteへ登録する。
	pub fn register_saved_file(&self, file: &SavedFileRegistration) -> EngineResult<i64> {
		self.conn
			.execute(
				"INSERT INTO files (
					course_id, section_no, moodle_file_id, original_name, saved_path,
					size_bytes, mime_type, hash_blake3, simhash
				 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
				params![
					file.course_id,
					file.section_no,
					file.moodle_file_id,
					file.original_name,
					file.saved_path.to_string_lossy(),
					file.size_bytes,
					file.mime_type,
					file.hash_blake3,
					file.simhash as i64,
				],
			)
			.map_err(db_err)?;
		Ok(self.conn.last_insert_rowid())
	}

	/// ZIP展開時に、直前に保存したMoodle資料の実体パスをDB正本から解決する。
	pub fn saved_file_path_by_moodle_id(&self, moodle_file_id: &str) -> EngineResult<PathBuf> {
		self.conn
			.query_row(
				"SELECT saved_path
				 FROM files
				 WHERE moodle_file_id = ?1
				 ORDER BY id DESC
				 LIMIT 1",
				[moodle_file_id],
				|row| row.get::<_, String>(0),
			)
			.optional()
			.map_err(db_err)?
			.map(PathBuf::from)
			.ok_or_else(|| EngineError::NotFound {
				entity: "保存済みファイル".to_string(),
				id: moodle_file_id.to_string(),
			})
	}

	/// 重複検出結果へSQLiteに保存された表示名を付与する。
	pub fn similar_file_records(
		&self,
		matches: &[DuplicateMatch],
	) -> EngineResult<Vec<SimilarFileRecord>> {
		matches
			.iter()
			.map(|matched| {
				let original_name = self
					.conn
					.query_row(
						"SELECT original_name FROM files WHERE id = ?1",
						[matched.file_id],
						|row| row.get::<_, String>(0),
					)
					.optional()
					.map_err(db_err)?
					.ok_or_else(|| EngineError::NotFound {
						entity: "ファイル".to_string(),
						id: matched.file_id.to_string(),
					})?;
				Ok(SimilarFileRecord {
					file_id: matched.file_id,
					original_name,
					similarity: matched.similarity,
				})
			})
			.collect()
	}
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
	use crate::types::SavedFileRegistration;

	#[test]
	fn resolves_a_course_by_stable_moodle_id_and_updates_its_context() {
		let mut database = Database::open_in_memory().unwrap();

		let created = database
			.resolve_course_context(
				Some("course-412"),
				Some("Data Science"),
				Some(2026),
				Some("Spring"),
			)
			.unwrap();
		let updated = database
			.resolve_course_context(
				Some("course-412"),
				Some("Data Science II"),
				Some(2027),
				Some("Fall"),
			)
			.unwrap();

		assert_eq!(updated.course_id, created.course_id);
		assert_eq!(updated.name, "Data Science II");
		assert_eq!(updated.academic_year, Some(2027));
		assert_eq!(updated.term.as_deref(), Some("Fall"));
	}

	#[test]
	fn name_fallback_requires_exactly_one_existing_course() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.resolve_course_context(Some("course-a"), Some("Shared"), None, None)
			.unwrap();
		let resolved = database
			.resolve_course_context(None, Some("Shared"), None, None)
			.unwrap();
		assert_eq!(resolved.name, "Shared");

		database
			.resolve_course_context(Some("course-b"), Some("Shared"), None, None)
			.unwrap();
		assert!(matches!(
			database.resolve_course_context(None, Some("Shared"), None, None),
			Err(EngineError::RuleConflict { .. })
		));
	}

	#[test]
	fn registers_saved_file_metadata_and_resolves_it_by_moodle_id() {
		let database = Database::open_in_memory().unwrap();
		let saved_path = PathBuf::from(r"C:\archive\guide.pdf");
		let file_id = database
			.register_saved_file(&SavedFileRegistration {
				course_id: None,
				section_no: Some(2),
				moodle_file_id: Some("file-4376".to_string()),
				original_name: "guide.pdf".to_string(),
				saved_path: saved_path.clone(),
				size_bytes: 42,
				mime_type: Some("application/pdf".to_string()),
				hash_blake3: "b3:test".to_string(),
				simhash: 7,
			})
			.unwrap();

		assert!(file_id > 0);
		assert_eq!(
			database.saved_file_path_by_moodle_id("file-4376").unwrap(),
			saved_path
		);
	}
}
