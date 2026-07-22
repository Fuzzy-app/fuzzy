//! SQLite上の保存ルール・照合対象ファイル・適合注釈の永続化。

use std::collections::BTreeMap;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::{db_err, Database};
use crate::folder_names::{
	course_folder_names_equal, normalize_course_folder_override, resolve_course_folder_names,
	CourseFolderIdentity, CourseFolderNameResolution,
};
use crate::rule::{validate_rule_set, RuleEngine};
use crate::types::{
	CourseRuleOverride, CourseRuleOverrideRecord, RuleComplianceSummary, RuleContext,
	RuleFileEntry, RuleSet, RuleSetRecord, RuleViolationRecord,
};
use crate::{EngineError, EngineResult};

impl Database {
	/// 保存ルートをSQLiteの正本から読み込む。
	pub fn base_folder_path(&self) -> EngineResult<PathBuf> {
		load_base_folder_path(&self.conn)
	}

	/// グローバルルールとコース別例外ルールをSQLiteの正本から読み込む。
	pub fn load_rule_set(&self) -> EngineResult<RuleSet> {
		load_rule_set(&self.conn)
	}

	/// 画面表示に必要なコース名を含めて保存ルールを取得する。
	pub fn rule_set_record(&self) -> EngineResult<RuleSetRecord> {
		load_rule_set_record(&self.conn)
	}

	/// グローバルルールを保存し、同じトランザクションで違反注釈を再計算する。
	pub fn update_global_rule(
		&mut self,
		pattern_template: &str,
		engine: &impl RuleEngine,
	) -> EngineResult<()> {
		let pattern_template = pattern_template.trim();
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let mut rules = load_rule_set(&transaction)?;
		rules.global_pattern_template = pattern_template.to_string();
		validate_rule_set(&rules)?;

		let updated = transaction
			.execute(
				"UPDATE global_rule
				 SET pattern_template = ?1, updated_at = datetime('now')
				 WHERE id = 1",
				[pattern_template],
			)
			.map_err(db_err)?;
		if updated != 1 {
			return Err(EngineError::Database {
				message: "グローバルルールが設定されていません".to_string(),
			});
		}
		apply_rule_compliance(&transaction, engine)?;
		transaction.commit().map_err(db_err)
	}

	/// コース別例外を保存し、同じトランザクションで違反注釈を再計算する。
	pub fn update_course_rule_override(
		&mut self,
		course_id: i64,
		split_by_section: bool,
		pattern_template: Option<&str>,
		note: Option<&str>,
		engine: &impl RuleEngine,
	) -> EngineResult<()> {
		if course_id <= 0 {
			return Err(EngineError::InvalidInput {
				field: "courseId".to_string(),
				reason: "1以上の整数を指定してください".to_string(),
			});
		}
		let pattern_template = pattern_template
			.map(str::trim)
			.filter(|value| !value.is_empty())
			.map(str::to_string);
		let note = note
			.map(str::trim)
			.filter(|value| !value.is_empty())
			.map(str::to_string);
		let override_rule = CourseRuleOverride {
			course_id,
			split_by_section,
			pattern_template,
			note,
		};

		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let course_exists = transaction
			.query_row("SELECT 1 FROM courses WHERE id = ?1", [course_id], |_| {
				Ok(())
			})
			.optional()
			.map_err(db_err)?
			.is_some();
		if !course_exists {
			return Err(EngineError::NotFound {
				entity: "コース".to_string(),
				id: course_id.to_string(),
			});
		}

		let mut rules = load_rule_set(&transaction)?;
		if let Some(existing) = rules
			.course_overrides
			.iter_mut()
			.find(|candidate| candidate.course_id == course_id)
		{
			*existing = override_rule.clone();
		} else {
			rules.course_overrides.push(override_rule.clone());
		}
		validate_rule_set(&rules)?;

		transaction
			.execute(
				"INSERT INTO course_rule_overrides (
					course_id, split_by_section, pattern_template, note
				 ) VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(course_id) DO UPDATE SET
					split_by_section = excluded.split_by_section,
					pattern_template = excluded.pattern_template,
					note = excluded.note",
				params![
					override_rule.course_id,
					override_rule.split_by_section,
					override_rule.pattern_template,
					override_rule.note
				],
			)
			.map_err(db_err)?;
		apply_rule_compliance(&transaction, engine)?;
		transaction.commit().map_err(db_err)
	}

	/// SQLiteに注釈されたルール違反を取得する。
	/// 絶対パスは内部値のまま返し、Native Messaging境界でのみ相対化する。
	pub fn rule_violations(&self) -> EngineResult<Vec<RuleViolationRecord>> {
		let mut statement = self
			.conn
			.prepare(
				"SELECT
					f.id,
					f.original_name,
					f.course_id,
					c.name,
					f.saved_path,
					f.violation_reason
				 FROM files f
				 LEFT JOIN courses c ON c.id = f.course_id
				 WHERE f.rule_compliant = 0
				 ORDER BY f.id",
			)
			.map_err(db_err)?;
		let records = statement
			.query_map([], |row| {
				let reason = row.get::<_, Option<String>>(5)?.ok_or_else(|| {
					rusqlite::Error::InvalidColumnType(
						5,
						"violation_reason".to_string(),
						rusqlite::types::Type::Null,
					)
				})?;
				Ok(RuleViolationRecord {
					file_id: row.get(0)?,
					file_name: row.get(1)?,
					course_id: row.get(2)?,
					course_name: row.get(3)?,
					saved_path: PathBuf::from(row.get::<_, String>(4)?),
					reason,
				})
			})
			.map_err(db_err)?
			.collect::<rusqlite::Result<Vec<_>>>()
			.map_err(db_err)?;
		Ok(records)
	}

	/// ルール照合に必要な保存済みファイルとコース文脈を読み込む。
	pub fn load_rule_files(&self) -> EngineResult<Vec<RuleFileEntry>> {
		load_rule_files(&self.conn)
	}

	/// 全コースの、衝突しない保存用フォルダ名と利用者向け警告を読み込む。
	pub fn load_course_folder_resolutions(&self) -> EngineResult<Vec<CourseFolderNameResolution>> {
		load_course_folder_resolutions(&self.conn)
	}

	/// 利用者が編集したコースフォルダ名を保存し、全コース間の一意性を検証する。
	///
	/// `None` は上書き解除を表す。同名になる場合はトランザクションをロールバックする。
	pub fn update_course_folder_name(
		&mut self,
		course_id: i64,
		folder_name: Option<&str>,
	) -> EngineResult<CourseFolderNameResolution> {
		let normalized = folder_name
			.map(normalize_course_folder_override)
			.transpose()?;
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		if let Some(folder_name) = &normalized {
			let conflicts_with_existing = load_course_folder_resolutions(&transaction)?
				.into_iter()
				.any(|resolution| {
					resolution.course_id != course_id
						&& course_folder_names_equal(&resolution.folder_name, folder_name)
				});
			if conflicts_with_existing {
				return Err(EngineError::RuleConflict {
					reason: "別のコースが使用中のフォルダ名は指定できません".to_string(),
				});
			}
		}
		let updated = transaction
			.execute(
				"UPDATE courses
				 SET folder_name_override = ?1, updated_at = datetime('now')
				 WHERE id = ?2",
				params![normalized, course_id],
			)
			.map_err(db_err)?;
		if updated != 1 {
			return Err(EngineError::NotFound {
				entity: "コース".to_string(),
				id: course_id.to_string(),
			});
		}

		let resolution = load_course_folder_resolutions(&transaction)?
			.into_iter()
			.find(|resolution| resolution.course_id == course_id)
			.ok_or_else(|| EngineError::Internal {
				message: format!("コースID {course_id} の保存名を解決できませんでした"),
			})?;
		transaction.commit().map_err(db_err)?;
		Ok(resolution)
	}

	/// 全保存済みファイルのルール適合状況を再計算し、`files`へ注釈する。
	///
	/// 読み込んだルール・ファイルと書き戻す注釈が同じDBスナップショットになるよう、
	/// `IMMEDIATE`トランザクション内で一括更新する。ファイル自体は変更しない。
	pub fn refresh_rule_compliance(
		&mut self,
		engine: &impl RuleEngine,
	) -> EngineResult<RuleComplianceSummary> {
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let summary = apply_rule_compliance(&transaction, engine)?;
		transaction.commit().map_err(db_err)?;
		Ok(summary)
	}
}

fn apply_rule_compliance(
	conn: &Connection,
	engine: &impl RuleEngine,
) -> EngineResult<RuleComplianceSummary> {
	let base_folder = load_base_folder_path(conn)?;
	let rules = load_rule_set(conn)?;
	let files = load_rule_files(conn)?;
	let violations = engine.check_all(&files, &base_folder, &rules)?;

	let mut annotations = BTreeMap::new();
	for violation in violations {
		let file_id = violation.file_id.ok_or_else(|| EngineError::Internal {
			message: "DB由来のルール違反にファイルIDがありません".to_string(),
		})?;
		if annotations.insert(file_id, violation.reason).is_some() {
			return Err(EngineError::Internal {
				message: format!("ファイルID {file_id} のルール違反が重複しています"),
			});
		}
	}

	conn.execute(
		"UPDATE files SET rule_compliant = 1, violation_reason = NULL",
		[],
	)
	.map_err(db_err)?;
	for (file_id, reason) in &annotations {
		let updated = conn
			.execute(
				"UPDATE files
				 SET rule_compliant = 0, violation_reason = ?1
				 WHERE id = ?2",
				params![reason, file_id],
			)
			.map_err(db_err)?;
		if updated != 1 {
			return Err(EngineError::Internal {
				message: format!("ファイルID {file_id} のルール注釈を更新できませんでした"),
			});
		}
	}

	Ok(RuleComplianceSummary {
		checked_count: files.len(),
		violation_count: annotations.len(),
	})
}

fn load_base_folder_path(conn: &Connection) -> EngineResult<PathBuf> {
	conn.query_row(
		"SELECT value FROM app_settings WHERE key = 'base_folder_path'",
		[],
		|row| row.get::<_, String>(0),
	)
	.optional()
	.map_err(db_err)?
	.map(PathBuf::from)
	.ok_or_else(|| EngineError::Database {
		message: "保存ルートが設定されていません".to_string(),
	})
}

fn load_rule_set(conn: &Connection) -> EngineResult<RuleSet> {
	let global_pattern_template = conn
		.query_row(
			"SELECT pattern_template FROM global_rule WHERE id = 1",
			[],
			|row| row.get(0),
		)
		.optional()
		.map_err(db_err)?
		.ok_or_else(|| EngineError::Database {
			message: "グローバルルールが設定されていません".to_string(),
		})?;

	let mut statement = conn
		.prepare(
			"SELECT course_id, split_by_section, pattern_template, note
			 FROM course_rule_overrides
			 ORDER BY course_id",
		)
		.map_err(db_err)?;
	let course_overrides = statement
		.query_map([], |row| {
			let split_by_section = match row.get::<_, i64>(1)? {
				0 => false,
				1 => true,
				value => return Err(rusqlite::Error::IntegralValueOutOfRange(1, value)),
			};
			Ok(CourseRuleOverride {
				course_id: row.get(0)?,
				split_by_section,
				pattern_template: row.get(2)?,
				note: row.get(3)?,
			})
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;

	Ok(RuleSet {
		global_pattern_template,
		course_overrides,
	})
}

fn load_rule_set_record(conn: &Connection) -> EngineResult<RuleSetRecord> {
	let global_pattern_template = conn
		.query_row(
			"SELECT pattern_template FROM global_rule WHERE id = 1",
			[],
			|row| row.get(0),
		)
		.optional()
		.map_err(db_err)?
		.ok_or_else(|| EngineError::Database {
			message: "グローバルルールが設定されていません".to_string(),
		})?;
	let mut statement = conn
		.prepare(
			"SELECT
				o.course_id,
				c.name,
				o.split_by_section,
				o.pattern_template,
				o.note
			 FROM course_rule_overrides o
			 JOIN courses c ON c.id = o.course_id
			 ORDER BY o.course_id",
		)
		.map_err(db_err)?;
	let course_overrides = statement
		.query_map([], |row| {
			let split_by_section = match row.get::<_, i64>(2)? {
				0 => false,
				1 => true,
				value => return Err(rusqlite::Error::IntegralValueOutOfRange(2, value)),
			};
			Ok(CourseRuleOverrideRecord {
				course_id: row.get(0)?,
				course_name: row.get(1)?,
				split_by_section,
				pattern_template: row.get(3)?,
				note: row.get(4)?,
			})
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	Ok(RuleSetRecord {
		global_pattern_template,
		course_overrides,
	})
}

fn load_rule_files(conn: &Connection) -> EngineResult<Vec<RuleFileEntry>> {
	let course_folder_names = load_course_folder_resolutions(conn)?
		.into_iter()
		.map(|resolution| (resolution.course_id, resolution.folder_name))
		.collect::<BTreeMap<_, _>>();
	let mut statement = conn
		.prepare(
			"SELECT
				f.id,
				f.saved_path,
				f.original_name,
				f.course_id,
				c.academic_year,
				c.term,
				f.section_no
			 FROM files f
			 LEFT JOIN courses c ON c.id = f.course_id
			 ORDER BY f.id",
		)
		.map_err(db_err)?;
	let files = statement
		.query_map([], |row| {
			let file_name: String = row.get(2)?;
			let course_id: Option<i64> = row.get(3)?;
			let academic_year: Option<i64> = row.get(4)?;
			let term: Option<String> = row.get(5)?;
			Ok(RuleFileEntry {
				file_id: Some(row.get(0)?),
				saved_path: PathBuf::from(row.get::<_, String>(1)?),
				file_name,
				context: RuleContext {
					course_id,
					course_name: course_id
						.and_then(|course_id| course_folder_names.get(&course_id).cloned()),
					year: academic_year.map(|year| year.to_string()),
					term,
					assignment: None,
					section: row.get::<_, Option<i64>>(6)?.map(|value| value.to_string()),
				},
			})
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	Ok(files)
}

fn load_course_folder_resolutions(
	conn: &Connection,
) -> EngineResult<Vec<CourseFolderNameResolution>> {
	#[derive(Debug)]
	struct CourseRow {
		id: i64,
		name: String,
		stable_id: String,
		folder_name_override: Option<String>,
	}

	let mut statement = conn
		.prepare("SELECT id, name, moodle_course_id, folder_name_override FROM courses ORDER BY id")
		.map_err(db_err)?;
	let courses = statement
		.query_map([], |row| {
			Ok(CourseRow {
				id: row.get(0)?,
				name: row.get(1)?,
				stable_id: row.get(2)?,
				folder_name_override: row.get(3)?,
			})
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	let identities = courses
		.iter()
		.map(|course| CourseFolderIdentity {
			course_id: course.id,
			name: &course.name,
			stable_id: &course.stable_id,
			folder_name_override: course.folder_name_override.as_deref(),
		})
		.collect::<Vec<_>>();
	resolve_course_folder_names(&identities)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::rule::DefaultRuleEngine;
	use crate::SEED_SQL;

	#[test]
	fn seed_rules_detect_global_violations_and_apply_the_course_override() {
		let database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		let rules = database.load_rule_set().unwrap();
		let files = database.load_rule_files().unwrap();
		let base_folder = database.base_folder_path().unwrap();

		let violations = DefaultRuleEngine
			.check_all(&files, &base_folder, &rules)
			.unwrap();
		let violation_ids = violations
			.iter()
			.filter_map(|violation| violation.file_id)
			.collect::<Vec<_>>();

		assert_eq!(violation_ids, vec![4, 9]);
		assert!(violations[0].reason.contains("グローバルルール"));
		assert!(!violations[0].reason.contains(r"C:\Users"));
		assert!(!violation_ids.contains(&6));
	}

	#[test]
	fn refresh_rule_compliance_replaces_annotations_in_one_pass() {
		let mut database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		database
			.conn()
			.execute(
				"UPDATE files SET rule_compliant = 1, violation_reason = NULL",
				[],
			)
			.unwrap();

		let summary = database
			.refresh_rule_compliance(&DefaultRuleEngine)
			.unwrap();
		assert_eq!(summary.checked_count, 9);
		assert_eq!(summary.violation_count, 2);

		let misplaced: (i64, Option<String>) = database
			.conn()
			.query_row(
				"SELECT rule_compliant, violation_reason FROM files WHERE id = 4",
				[],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(misplaced.0, 0);
		assert!(misplaced.1.is_some_and(|reason| !reason.is_empty()));

		let compliant: (i64, Option<String>) = database
			.conn()
			.query_row(
				"SELECT rule_compliant, violation_reason FROM files WHERE id = 6",
				[],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(compliant, (1, None));
	}

	#[test]
	fn invalid_rules_roll_back_without_erasing_existing_annotations() {
		let mut database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		database
			.conn()
			.execute(
				"UPDATE files SET violation_reason = '既存の警告' WHERE id = 4",
				[],
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
			.refresh_rule_compliance(&DefaultRuleEngine)
			.is_err());
		let reason: String = database
			.conn()
			.query_row(
				"SELECT violation_reason FROM files WHERE id = 4",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(reason, "既存の警告");
	}

	#[test]
	fn rejects_non_boolean_course_override_values_from_sqlite() {
		let database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		database
			.conn()
			.execute(
				"UPDATE course_rule_overrides SET split_by_section = 2 WHERE course_id = 4",
				[],
			)
			.unwrap();

		assert!(matches!(
			database.load_rule_set(),
			Err(EngineError::Database { .. })
		));
	}

	#[test]
	fn normalizes_and_disambiguates_course_names_for_rule_matching() {
		let database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		database
			.conn()
			.execute_batch(
				"INSERT INTO courses (id, moodle_course_id, name, academic_year, term) VALUES
					(7, 'course-english-a', '英語（A）', 2026, '2026前期'),
					(8, 'course-english-b', '英語［B］', 2026, '2026前期');
				 INSERT INTO files (
					id, course_id, section_no, original_name, saved_path,
					size_bytes, hash_blake3
				 ) VALUES
					(10, 7, 1, '資料A.pdf',
					 'C:\\Users\\sample\\Documents\\大学\\2026前期\\英語_A\\第1回\\資料A.pdf',
					 1, 'b3:course-a'),
					(11, 8, 1, '資料B.pdf',
					 'C:\\Users\\sample\\Documents\\大学\\2026前期\\英語_B\\第1回\\資料B.pdf',
					 1, 'b3:course-b');",
			)
			.unwrap();

		let files = database.load_rule_files().unwrap();
		let course_names = files
			.iter()
			.filter(|file| matches!(file.file_id, Some(10 | 11)))
			.map(|file| file.context.course_name.as_deref().unwrap())
			.collect::<Vec<_>>();

		assert_eq!(course_names, vec!["英語_A", "英語_B"]);
		assert!(database
			.load_course_folder_resolutions()
			.unwrap()
			.into_iter()
			.filter(|resolution| matches!(resolution.course_id, 7 | 8))
			.all(|resolution| !resolution.warnings.is_empty()));
	}

	#[test]
	fn course_folder_override_is_unique_and_rolls_back_on_conflict() {
		let mut database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();

		let updated = database
			.update_course_folder_name(1, Some("共通ゼミ"))
			.unwrap();
		assert_eq!(updated.folder_name, "共通ゼミ");
		assert!(matches!(
			database.update_course_folder_name(2, Some("共通ゼミ")),
			Err(EngineError::RuleConflict { .. })
		));

		let second_override: Option<String> = database
			.conn()
			.query_row(
				"SELECT folder_name_override FROM courses WHERE id = 2",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(second_override, None);
	}

	#[test]
	fn course_folder_override_cannot_take_an_existing_effective_name() {
		let mut database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();

		assert!(matches!(
			database.update_course_folder_name(1, Some("データベース")),
			Err(EngineError::RuleConflict { .. })
		));
		let first_override: Option<String> = database
			.conn()
			.query_row(
				"SELECT folder_name_override FROM courses WHERE id = 1",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(first_override, None);
	}

	#[test]
	fn rule_record_includes_course_names_and_violations() {
		let database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();

		let rules = database.rule_set_record().unwrap();
		assert_eq!(
			rules.global_pattern_template,
			"{term}/{course}/第{section}回"
		);
		assert_eq!(rules.course_overrides[0].course_name, "アプリ演習");

		let violations = database.rule_violations().unwrap();
		assert_eq!(
			violations
				.iter()
				.map(|item| item.file_id)
				.collect::<Vec<_>>(),
			vec![4, 9]
		);
		assert_eq!(violations[0].course_name.as_deref(), Some("データベース"));
	}

	#[test]
	fn global_rule_update_and_violation_refresh_are_atomic() {
		let mut database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();

		let before = database.load_rule_set().unwrap();
		let result = database.update_global_rule("{course}/{unknown}", &DefaultRuleEngine);
		assert!(result.is_err());
		assert_eq!(database.load_rule_set().unwrap(), before);

		database
			.update_global_rule("{term}/{course}/第{section}回", &DefaultRuleEngine)
			.unwrap();
		assert_eq!(database.rule_violations().unwrap().len(), 2);
	}

	#[test]
	fn course_rule_override_is_upserted_and_revalidated() {
		let mut database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();

		database
			.update_course_rule_override(
				2,
				false,
				Some("{term}/{course}"),
				Some("  回ごとに分けない  "),
				&DefaultRuleEngine,
			)
			.unwrap();
		let rules = database.rule_set_record().unwrap();
		let database_rule = rules
			.course_overrides
			.iter()
			.find(|rule| rule.course_id == 2)
			.unwrap();
		assert!(!database_rule.split_by_section);
		assert_eq!(database_rule.note.as_deref(), Some("回ごとに分けない"));

		assert!(matches!(
			database.update_course_rule_override(
				999,
				false,
				Some("{term}/{course}"),
				None,
				&DefaultRuleEngine
			),
			Err(EngineError::NotFound { .. })
		));
	}
}
