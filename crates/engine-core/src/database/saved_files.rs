//! Moodle資料の保存に伴うコース解決とファイルメタデータ永続化。

use std::collections::HashSet;
use std::path::PathBuf;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use super::library::{
	matching_local_course_for_moodle, merge_local_course_into, saved_path_key,
	upsert_file_in_transaction, validate_file_registration, SavedFileUpsertMode,
};
use super::rules::apply_rule_compliance;
use super::{db_err, Database};
use crate::rule::DefaultRuleEngine;
use crate::types::{CourseContextRecord, DuplicateMatch, SavedFileRegistration, SimilarFileRecord};
use crate::{EngineError, EngineResult};

/// ZIP展開元として解決した保存済みファイル。
///
/// 後続の一括登録では`file_id`を使って同じ行を再参照し、コース統合との競合時も
/// transaction開始時点の`course_id`と`section_no`を継承する。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedZipSource {
	pub file_id: i64,
	pub saved_path: PathBuf,
	pub course_id: Option<i64>,
	pub section_no: Option<i64>,
}

/// ZIPから展開済みの1ファイルをSQLiteへ登録するための内部メタデータ。
///
/// `course_id`は展開元から、`moodle_file_id`は常に`NULL`としてDB層が決定する。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedFileRegistration {
	pub section_no: Option<i64>,
	pub original_name: String,
	pub saved_path: PathBuf,
	pub size_bytes: i64,
	pub mime_type: Option<String>,
	pub hash_blake3: String,
	pub simhash: u64,
}

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
		if stable_id.is_some_and(|value| value.starts_with("local-scan:")) {
			return Err(invalid(
				"moodleCourseId",
				"ローカル走査用に予約された識別子は指定できません",
			));
		}

		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let mut context_changed = false;
		let course_id = if let Some(stable_id) = stable_id {
			let existing = transaction
				.query_row(
					"SELECT id, name, academic_year, term
					 FROM courses
					 WHERE moodle_course_id = ?1",
					[stable_id],
					|row| {
						Ok((
							row.get::<_, i64>(0)?,
							row.get::<_, String>(1)?,
							row.get::<_, Option<i64>>(2)?,
							row.get::<_, Option<String>>(3)?,
						))
					},
				)
				.optional()
				.map_err(db_err)?;
			let existing = match existing {
				Some(existing) => Some(existing),
				None => {
					let legacy = legacy_course_for_context(&transaction, stable_id)?;
					if let Some((course_id, current_name, current_year, current_term)) = legacy {
						transaction
							.execute(
								"UPDATE courses
								 SET moodle_course_id = ?1, updated_at = datetime('now')
								 WHERE id = ?2",
								params![stable_id, course_id],
							)
							.map_err(db_err)?;
						context_changed = true;
						Some((course_id, current_name, current_year, current_term))
					} else {
						None
					}
				}
			};
			match existing {
				Some((course_id, current_name, current_year, current_term)) => {
					if let Some(name) = name {
						if let Some(local_course_id) = matching_local_course_for_moodle(
							&transaction,
							name,
							academic_year,
							term,
							Some(course_id),
						)? {
							merge_local_course_into(&transaction, local_course_id, course_id)?;
							context_changed = true;
						}
					}
					context_changed |= name.is_some_and(|value| value != current_name.as_str())
						|| academic_year.is_some_and(|value| Some(value) != current_year)
						|| term.is_some_and(|value| current_term.as_deref() != Some(value));
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
					let local_course_id = matching_local_course_for_moodle(
						&transaction,
						name,
						academic_year,
						term,
						None,
					)?;
					context_changed = true;
					match local_course_id {
						Some(course_id) => {
							// 初期スキャンで作った同名コースを実Moodle IDへ昇格し、
							// 既存filesの外部キーを保ったまま同期データへ接続する。
							transaction
								.execute(
									"UPDATE courses
									 SET moodle_course_id = ?1, name = ?2,
									     academic_year = COALESCE(?3, academic_year),
									     term = COALESCE(?4, term),
									     updated_at = datetime('now')
									 WHERE id = ?5",
									params![stable_id, name, academic_year, term, course_id],
								)
								.map_err(db_err)?;
							course_id
						}
						None => {
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

		let has_active_files = transaction
			.query_row(
				"SELECT EXISTS(SELECT 1 FROM files WHERE missing_at IS NULL AND excluded_at IS NULL)",
				[],
				|row| row.get::<_, bool>(0),
			)
			.map_err(db_err)?;
		if context_changed && has_active_files {
			apply_rule_compliance(&transaction, &DefaultRuleEngine)?;
		}
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
		validate_file_registration(file)?;
		let saved_path = saved_path_key(&file.saved_path);
		let excluded = self.is_path_excluded(&file.saved_path, file.course_id)?;
		self.conn
			.execute(
				"INSERT INTO files (
					course_id, section_no, moodle_file_id, original_name, saved_path,
					size_bytes, mime_type, hash_blake3, simhash, excluded_at
				 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
					CASE WHEN ?10 THEN datetime('now') ELSE NULL END)",
				params![
					file.course_id,
					file.section_no,
					file.moodle_file_id,
					file.original_name,
					saved_path,
					file.size_bytes,
					file.mime_type,
					file.hash_blake3,
					file.simhash as i64,
					excluded,
				],
			)
			.map_err(db_err)?;
		Ok(self.conn.last_insert_rowid())
	}

	/// ZIP展開時に、直前に保存したMoodle資料をDB正本の行IDとともに解決する。
	pub fn saved_zip_source_by_moodle_id(
		&self,
		moodle_file_id: &str,
	) -> EngineResult<SavedZipSource> {
		self.conn
			.query_row(
				"SELECT id, saved_path, course_id, section_no
				 FROM files
				 WHERE moodle_file_id = ?1
					AND missing_at IS NULL
					AND excluded_at IS NULL
				 ORDER BY id DESC
				 LIMIT 1",
				[moodle_file_id],
				|row| {
					Ok(SavedZipSource {
						file_id: row.get(0)?,
						saved_path: PathBuf::from(row.get::<_, String>(1)?),
						course_id: row.get(2)?,
						section_no: row.get(3)?,
					})
				},
			)
			.optional()
			.map_err(db_err)?
			.ok_or_else(|| EngineError::NotFound {
				entity: "保存済みファイル".to_string(),
				id: moodle_file_id.to_string(),
			})
	}

	/// ZIP展開時に、直前に保存したMoodle資料の実体パスをDB正本から解決する。
	pub fn saved_file_path_by_moodle_id(&self, moodle_file_id: &str) -> EngineResult<PathBuf> {
		self.saved_zip_source_by_moodle_id(moodle_file_id)
			.map(|source| source.saved_path)
	}

	/// ZIP展開物を、展開元のコース文脈を継承して一括登録する。
	///
	/// 全項目を1つの`IMMEDIATE` transactionでupsertし、途中で1件でも失敗した場合は
	/// SQLite変更を全て取り消す。既存の欠損行は同じIDのまま復活させ、古いMoodle
	/// ファイルIDと検索索引メタ情報を引き継がない。
	pub fn register_extracted_files_from_source(
		&mut self,
		source_file_id: i64,
		files: &[ExtractedFileRegistration],
	) -> EngineResult<Vec<i64>> {
		if source_file_id <= 0 {
			return Err(invalid("sourceFileId", "正のファイルIDを指定してください"));
		}
		if files.is_empty() {
			return Err(invalid("files", "展開ファイルを1件以上指定してください"));
		}
		let mut saved_paths = HashSet::with_capacity(files.len());
		for file in files {
			let validation = SavedFileRegistration {
				course_id: None,
				section_no: file.section_no,
				moodle_file_id: None,
				original_name: file.original_name.clone(),
				saved_path: file.saved_path.clone(),
				size_bytes: file.size_bytes,
				mime_type: file.mime_type.clone(),
				hash_blake3: file.hash_blake3.clone(),
				simhash: file.simhash,
			};
			validate_file_registration(&validation)?;
			let path_key = saved_path_key(&file.saved_path).to_lowercase();
			if !saved_paths.insert(path_key) {
				return Err(invalid(
					"files",
					"同じ保存先の展開ファイルが複数指定されています",
				));
			}
		}

		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let source_context = transaction
			.query_row(
				"SELECT course_id, section_no
				 FROM files
				 WHERE id = ?1 AND missing_at IS NULL AND excluded_at IS NULL",
				[source_file_id],
				|row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
			)
			.optional()
			.map_err(db_err)?
			.ok_or_else(|| EngineError::NotFound {
				entity: "ZIP展開元ファイル".to_string(),
				id: source_file_id.to_string(),
			})?;

		let mut file_ids = Vec::with_capacity(files.len());
		for file in files {
			let registration = SavedFileRegistration {
				course_id: source_context.0,
				section_no: file.section_no.or(source_context.1),
				moodle_file_id: None,
				original_name: file.original_name.clone(),
				saved_path: file.saved_path.clone(),
				size_bytes: file.size_bytes,
				mime_type: file.mime_type.clone(),
				hash_blake3: file.hash_blake3.clone(),
				simhash: file.simhash,
			};
			let result = upsert_file_in_transaction(
				&transaction,
				&registration,
				SavedFileUpsertMode::Extracted,
			)?;
			file_ids.push(result.file_id);
		}
		transaction.commit().map_err(db_err)?;
		self.refresh_excluded_file_flags()?;
		Ok(file_ids)
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
						"SELECT original_name
						 FROM files
						 WHERE id = ?1 AND missing_at IS NULL AND excluded_at IS NULL",
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

type LegacyCourseContext = (i64, String, Option<i64>, Option<String>);

fn legacy_course_for_context(
	transaction: &Transaction<'_>,
	stable_id: &str,
) -> EngineResult<Option<LegacyCourseContext>> {
	let Some((raw_id, academic_year)) = parse_contextual_moodle_id(stable_id) else {
		return Ok(None);
	};
	let mut statement = transaction
		.prepare(
			"SELECT id, name, academic_year, term
			 FROM courses
			 WHERE moodle_course_id = ?1
			   AND (academic_year = ?2 OR academic_year IS NULL)
			 ORDER BY id",
		)
		.map_err(db_err)?;
	let matches = statement
		.query_map(params![raw_id, academic_year], |row| {
			Ok((
				row.get::<_, i64>(0)?,
				row.get::<_, String>(1)?,
				row.get::<_, Option<i64>>(2)?,
				row.get::<_, Option<String>>(3)?,
			))
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	match matches.as_slice() {
		[] => Ok(None),
		[course] => Ok(Some(course.clone())),
		_ => Err(EngineError::RuleConflict {
			reason: "同じMoodle IDと年度の旧コースが複数あるため自動移行できません".to_string(),
		}),
	}
}

fn parse_contextual_moodle_id(value: &str) -> Option<(&str, i64)> {
	let mut parts = value.splitn(4, ':');
	if parts.next() != Some("moodle") {
		return None;
	}
	let hostname = parts.next()?;
	let academic_year = parts.next()?.parse::<i64>().ok()?;
	let raw_id = parts.next()?;
	if hostname.is_empty()
		|| !(1900..=9999).contains(&academic_year)
		|| !matches!(raw_id.len(), 1..=80)
		|| !raw_id
			.chars()
			.all(|character| character.is_ascii_alphanumeric() || ".:_-".contains(character))
	{
		return None;
	}
	Some((raw_id, academic_year))
}

fn invalid(field: &str, reason: &str) -> EngineError {
	EngineError::InvalidInput {
		field: field.to_string(),
		reason: reason.to_string(),
	}
}

#[cfg(test)]
mod tests {
	use std::fs;
	use std::time::{SystemTime, UNIX_EPOCH};

	use super::*;
	use crate::rule::DefaultRuleEngine;
	use crate::types::SavedFileRegistration;

	struct TestDirectory {
		path: PathBuf,
	}

	impl TestDirectory {
		fn new() -> Self {
			let suffix = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.unwrap()
				.as_nanos();
			let path = std::env::temp_dir().join(format!(
				"fuzzy-course-context-{}-{suffix}",
				std::process::id()
			));
			fs::create_dir_all(&path).unwrap();
			Self { path }
		}
	}

	impl Drop for TestDirectory {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.path);
		}
	}

	fn rule_sensitive_local_course() -> (Database, TestDirectory, i64) {
		let directory = TestDirectory::new();
		let mut database = Database::open_in_memory().unwrap();
		let course_id = database
			.ensure_contextual_local_scan_course("Data Science", "Data Science", None, None, false)
			.unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO app_settings (key, value)
				 VALUES ('base_folder_path', ?1)",
				[directory.path.to_string_lossy().as_ref()],
			)
			.unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO global_rule (id, pattern_key, pattern_template)
				 VALUES (1, 'year-course-assignment', '{year}/{course}/{assignment}')",
				[],
			)
			.unwrap();
		database
			.register_saved_file(&SavedFileRegistration {
				course_id: Some(course_id),
				section_no: None,
				moodle_file_id: None,
				original_name: "guide.pdf".to_string(),
				saved_path: directory
					.path
					.join("2026")
					.join("Data Science")
					.join("guide")
					.join("guide.pdf"),
				size_bytes: 42,
				mime_type: Some("application/pdf".to_string()),
				hash_blake3: "b3:context".to_string(),
				simhash: 7,
			})
			.unwrap();
		database
			.refresh_rule_compliance(&DefaultRuleEngine)
			.unwrap();
		(database, directory, course_id)
	}

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
	fn migrates_a_legacy_moodle_course_id_to_the_contextual_id() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO courses (moodle_course_id, name, academic_year, term)
				 VALUES ('412', 'Data Science', 2026, 'Spring')",
				[],
			)
			.unwrap();
		let legacy_course_id = database.conn().last_insert_rowid();

		let resolved = database
			.resolve_course_context(
				Some("moodle:moodle.example:2026:412"),
				Some("Data Science"),
				Some(2026),
				Some("Spring"),
			)
			.unwrap();

		assert_eq!(resolved.course_id, legacy_course_id);
		let stored_id: String = database
			.conn()
			.query_row(
				"SELECT moodle_course_id FROM courses WHERE id = ?1",
				[legacy_course_id],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(stored_id, "moodle:moodle.example:2026:412");
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
	fn rejects_ambiguous_same_named_local_courses_without_context() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.ensure_contextual_local_scan_course("Shared", "archive-a/Shared", None, None, false)
			.unwrap();
		database
			.ensure_contextual_local_scan_course("Shared", "archive-b/Shared", None, None, false)
			.unwrap();

		assert!(matches!(
			database.resolve_course_context(Some("moodle-shared"), Some("Shared"), None, None),
			Err(EngineError::RuleConflict { .. })
		));
	}

	#[test]
	fn course_context_promotion_revalidates_file_annotations() {
		let (mut database, _directory, course_id) = rule_sensitive_local_course();
		let before: i64 = database
			.conn()
			.query_row(
				"SELECT rule_compliant FROM files WHERE course_id = ?1",
				[course_id],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(before, 0);

		let resolved = database
			.resolve_course_context(
				Some("moodle-data-science-2026"),
				Some("Data Science"),
				Some(2026),
				None,
			)
			.unwrap();

		assert_eq!(resolved.course_id, course_id);
		let after: (i64, Option<String>) = database
			.conn()
			.query_row(
				"SELECT rule_compliant, violation_reason
				 FROM files
				 WHERE course_id = ?1",
				[course_id],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(after, (1, None));
	}

	#[test]
	fn course_context_promotion_rolls_back_when_revalidation_fails() {
		let (mut database, _directory, course_id) = rule_sensitive_local_course();
		let stable_id_before: String = database
			.conn()
			.query_row(
				"SELECT moodle_course_id FROM courses WHERE id = ?1",
				[course_id],
				|row| row.get(0),
			)
			.unwrap();
		let annotation_before: (i64, Option<String>) = database
			.conn()
			.query_row(
				"SELECT rule_compliant, violation_reason
				 FROM files
				 WHERE course_id = ?1",
				[course_id],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		database
			.conn()
			.execute(
				"UPDATE global_rule SET pattern_template = '{course}/{unknown}' WHERE id = 1",
				[],
			)
			.unwrap();

		assert!(database
			.resolve_course_context(
				Some("moodle-data-science-2026"),
				Some("Data Science"),
				Some(2026),
				None,
			)
			.is_err());
		let course_after: (String, Option<i64>) = database
			.conn()
			.query_row(
				"SELECT moodle_course_id, academic_year
				 FROM courses
				 WHERE id = ?1",
				[course_id],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		let annotation_after: (i64, Option<String>) = database
			.conn()
			.query_row(
				"SELECT rule_compliant, violation_reason
				 FROM files
				 WHERE course_id = ?1",
				[course_id],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(course_after, (stable_id_before, None));
		assert_eq!(annotation_after, annotation_before);
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

	#[test]
	fn registers_new_files_as_excluded_when_their_folder_is_excluded() {
		let directory = TestDirectory::new();
		let database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO app_settings (key, value) VALUES ('base_folder_path', ?1)",
				[directory.path.to_string_lossy().as_ref()],
			)
			.unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO excluded_folders (scope, course_id, relative_path)
				 VALUES ('root', NULL, 'ignored')",
				[],
			)
			.unwrap();

		let file_id = database
			.register_saved_file(&SavedFileRegistration {
				course_id: None,
				section_no: None,
				moodle_file_id: Some("file-excluded".to_string()),
				original_name: "new.txt".to_string(),
				saved_path: directory.path.join("ignored").join("new.txt"),
				size_bytes: 3,
				mime_type: Some("text/plain".to_string()),
				hash_blake3: "b3:excluded".to_string(),
				simhash: 7,
			})
			.unwrap();

		let excluded: bool = database
			.conn()
			.query_row(
				"SELECT excluded_at IS NOT NULL FROM files WHERE id = ?1",
				[file_id],
				|row| row.get(0),
			)
			.unwrap();
		assert!(excluded);
	}

	#[test]
	fn resolves_the_latest_active_zip_source_with_its_database_context() {
		let directory = TestDirectory::new();
		let mut database = Database::open_in_memory().unwrap();
		let first_course = database
			.resolve_course_context(Some("course-first"), Some("First"), None, None)
			.unwrap()
			.course_id;
		let latest_course = database
			.resolve_course_context(Some("course-latest"), Some("Latest"), None, None)
			.unwrap()
			.course_id;
		let first_id = database
			.register_saved_file(&SavedFileRegistration {
				course_id: Some(first_course),
				section_no: Some(1),
				moodle_file_id: Some("archive-42".to_string()),
				original_name: "first.zip".to_string(),
				saved_path: directory.path.join("first.zip"),
				size_bytes: 10,
				mime_type: Some("application/zip".to_string()),
				hash_blake3: "b3:first".to_string(),
				simhash: 1,
			})
			.unwrap();
		let latest_path = directory.path.join("latest.zip");
		let latest_id = database
			.register_saved_file(&SavedFileRegistration {
				course_id: Some(latest_course),
				section_no: Some(8),
				moodle_file_id: Some("archive-42".to_string()),
				original_name: "latest.zip".to_string(),
				saved_path: latest_path.clone(),
				size_bytes: 20,
				mime_type: Some("application/zip".to_string()),
				hash_blake3: "b3:latest".to_string(),
				simhash: 2,
			})
			.unwrap();

		assert_eq!(
			database
				.saved_zip_source_by_moodle_id("archive-42")
				.unwrap(),
			SavedZipSource {
				file_id: latest_id,
				saved_path: latest_path,
				course_id: Some(latest_course),
				section_no: Some(8),
			}
		);

		database
			.update_library_file_presence(latest_id, false)
			.unwrap();
		assert_eq!(
			database
				.saved_zip_source_by_moodle_id("archive-42")
				.unwrap()
				.file_id,
			first_id
		);
	}

	#[test]
	fn bulk_registers_extracted_files_with_source_context_and_revives_missing_rows() {
		let directory = TestDirectory::new();
		let mut database = Database::open_in_memory().unwrap();
		let source_course = database
			.resolve_course_context(Some("course-source"), Some("Source"), None, None)
			.unwrap()
			.course_id;
		let old_course = database
			.resolve_course_context(Some("course-old"), Some("Old"), None, None)
			.unwrap()
			.course_id;
		let source_id = database
			.register_saved_file(&SavedFileRegistration {
				course_id: Some(source_course),
				section_no: Some(3),
				moodle_file_id: Some("archive-source".to_string()),
				original_name: "materials.zip".to_string(),
				saved_path: directory.path.join("materials.zip"),
				size_bytes: 100,
				mime_type: Some("application/zip".to_string()),
				hash_blake3: "b3:source".to_string(),
				simhash: 3,
			})
			.unwrap();
		let revived_path = directory.path.join("第7回_復習.txt");
		let revived_id = database
			.register_saved_file(&SavedFileRegistration {
				course_id: Some(old_course),
				section_no: Some(99),
				moodle_file_id: Some("old-moodle-file".to_string()),
				original_name: "古い資料.txt".to_string(),
				saved_path: revived_path.clone(),
				size_bytes: 1,
				mime_type: Some("text/plain".to_string()),
				hash_blake3: "b3:old".to_string(),
				simhash: 99,
			})
			.unwrap();
		database
			.update_library_file_presence(revived_id, false)
			.unwrap();
		database.mark_search_indexed(revived_id, None).unwrap();
		let inherited_section_path = directory.path.join("補足.txt");

		let file_ids = database
			.register_extracted_files_from_source(
				source_id,
				&[
					ExtractedFileRegistration {
						section_no: Some(7),
						original_name: "第7回_復習.txt".to_string(),
						saved_path: revived_path.clone(),
						size_bytes: 21,
						mime_type: Some("text/plain".to_string()),
						hash_blake3: format!("b3:{}", "a".repeat(64)),
						simhash: 700,
					},
					ExtractedFileRegistration {
						section_no: None,
						original_name: "補足.txt".to_string(),
						saved_path: inherited_section_path.clone(),
						size_bytes: 12,
						mime_type: Some("text/plain".to_string()),
						hash_blake3: format!("b3:{}", "b".repeat(64)),
						simhash: 300,
					},
				],
			)
			.unwrap();

		assert_eq!(file_ids[0], revived_id);
		let revived: (Option<i64>, Option<i64>, Option<String>, String, i64) = database
			.conn()
			.query_row(
				"SELECT
					course_id, section_no, moodle_file_id, hash_blake3, simhash
				 FROM files
				 WHERE id = ?1",
				[revived_id],
				|row| {
					Ok((
						row.get(0)?,
						row.get(1)?,
						row.get(2)?,
						row.get(3)?,
						row.get(4)?,
					))
				},
			)
			.unwrap();
		assert_eq!(
			revived,
			(
				Some(source_course),
				Some(7),
				None,
				format!("b3:{}", "a".repeat(64)),
				700,
			)
		);
		let revived_state: (bool, bool) = database
			.conn()
			.query_row(
				"SELECT
					missing_at IS NULL,
					EXISTS(SELECT 1 FROM search_index_meta WHERE file_id = files.id)
				 FROM files
				 WHERE id = ?1",
				[revived_id],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(revived_state, (true, false));

		let inherited: (
			Option<i64>,
			Option<i64>,
			Option<String>,
			String,
			Option<i64>,
		) = database
			.conn()
			.query_row(
				"SELECT course_id, section_no, moodle_file_id, hash_blake3, simhash
				 FROM files
				 WHERE id = ?1",
				[file_ids[1]],
				|row| {
					Ok((
						row.get(0)?,
						row.get(1)?,
						row.get(2)?,
						row.get(3)?,
						row.get(4)?,
					))
				},
			)
			.unwrap();
		assert_eq!(
			inherited,
			(
				Some(source_course),
				Some(3),
				None,
				format!("b3:{}", "b".repeat(64)),
				Some(300),
			)
		);
	}

	#[test]
	fn bulk_extracted_file_registration_rejects_an_empty_batch() {
		let mut database = Database::open_in_memory().unwrap();
		let error = database
			.register_extracted_files_from_source(1, &[])
			.unwrap_err();

		assert!(matches!(
			error,
			EngineError::InvalidInput { ref field, .. } if field == "files"
		));
	}

	#[test]
	fn bulk_extracted_file_registration_rolls_back_every_row_on_failure() {
		let directory = TestDirectory::new();
		let mut database = Database::open_in_memory().unwrap();
		let course_id = database
			.resolve_course_context(Some("course-atomic"), Some("Atomic"), None, None)
			.unwrap()
			.course_id;
		let source_id = database
			.register_saved_file(&SavedFileRegistration {
				course_id: Some(course_id),
				section_no: Some(4),
				moodle_file_id: Some("archive-atomic".to_string()),
				original_name: "atomic.zip".to_string(),
				saved_path: directory.path.join("atomic.zip"),
				size_bytes: 100,
				mime_type: Some("application/zip".to_string()),
				hash_blake3: "b3:atomic".to_string(),
				simhash: 4,
			})
			.unwrap();
		database
			.conn()
			.execute_batch(
				"CREATE TRIGGER reject_failed_extracted_file
				 BEFORE INSERT ON files
				 WHEN NEW.original_name = '失敗.txt'
				 BEGIN
					SELECT RAISE(ABORT, 'テスト用の登録失敗');
				 END;",
			)
			.unwrap();
		let first_path = directory.path.join("成功.txt");
		let failed_path = directory.path.join("失敗.txt");

		assert!(database
			.register_extracted_files_from_source(
				source_id,
				&[
					ExtractedFileRegistration {
						section_no: None,
						original_name: "成功.txt".to_string(),
						saved_path: first_path.clone(),
						size_bytes: 10,
						mime_type: Some("text/plain".to_string()),
						hash_blake3: "b3:first-child".to_string(),
						simhash: 10,
					},
					ExtractedFileRegistration {
						section_no: None,
						original_name: "失敗.txt".to_string(),
						saved_path: failed_path.clone(),
						size_bytes: 20,
						mime_type: Some("text/plain".to_string()),
						hash_blake3: "b3:failed-child".to_string(),
						simhash: 20,
					},
				],
			)
			.is_err());
		let child_count: i64 = database
			.conn()
			.query_row(
				"SELECT count(*) FROM files WHERE saved_path IN (?1, ?2)",
				params![
					first_path.to_string_lossy().as_ref(),
					failed_path.to_string_lossy().as_ref()
				],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(child_count, 0);
		assert_eq!(
			database
				.saved_zip_source_by_moodle_id("archive-atomic")
				.unwrap()
				.file_id,
			source_id
		);
	}
}
