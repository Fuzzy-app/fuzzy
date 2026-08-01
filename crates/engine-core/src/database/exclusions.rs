//! SQLiteで管理する利用者指定の除外フォルダー。
use std::path::{Component, Path};

use rusqlite::{params, TransactionBehavior};

use super::rules::apply_rule_compliance;
use super::{db_err, Database};
use crate::rule::RuleEngine;
use crate::types::ExcludedFolderRecord;
use crate::{EngineError, EngineResult};

impl Database {
	pub(super) fn refresh_excluded_file_flags(&mut self) -> EngineResult<()> {
		let base_folder = self.base_folder_path().ok();
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		reapply_excluded_file_flags(&transaction, base_folder.as_deref())?;
		transaction.commit().map_err(db_err)
	}

	pub fn list_excluded_folders(
		&self,
		course_id: Option<i64>,
	) -> EngineResult<Vec<ExcludedFolderRecord>> {
		let mut statement = self
			.conn
			.prepare(
				"SELECT id, scope, course_id, relative_path
				 FROM excluded_folders
				 WHERE scope = 'root' OR (?1 IS NOT NULL AND course_id = ?1)
				 ORDER BY scope, course_id, relative_path",
			)
			.map_err(db_err)?;
		let records = statement
			.query_map([course_id], |row| {
				Ok(ExcludedFolderRecord {
					id: row.get(0)?,
					scope: row.get(1)?,
					course_id: row.get(2)?,
					relative_path: row.get(3)?,
				})
			})
			.map_err(db_err)?
			.collect::<rusqlite::Result<Vec<_>>>()
			.map_err(db_err)?;
		Ok(records)
	}

	pub fn update_excluded_folders(
		&mut self,
		scope: &str,
		course_id: Option<i64>,
		paths: &[String],
		engine: &impl RuleEngine,
	) -> EngineResult<Vec<ExcludedFolderRecord>> {
		if scope != "root" && scope != "course" {
			return Err(invalid("scope", "scope must be root or course"));
		}
		if (scope == "root" && course_id.is_some()) || (scope == "course" && course_id.is_none()) {
			return Err(invalid("courseId", "course scope requires a courseId"));
		}
		if let Some(course_id) = course_id {
			if course_id <= 0 {
				return Err(invalid("courseId", "courseId must be positive"));
			}
		}
		let normalized = paths
			.iter()
			.map(|path| normalize_relative_path(path))
			.collect::<EngineResult<Vec<_>>>()?;
		if normalized.iter().any(|path| path == ".") {
			return Err(invalid("paths", "the root folder cannot be excluded"));
		}
		let base_folder = self.base_folder_path().ok();
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		if let Some(course_id) = course_id {
			let exists: bool = transaction
				.query_row(
					"SELECT EXISTS(SELECT 1 FROM courses WHERE id = ?1)",
					[course_id],
					|row| row.get(0),
				)
				.map_err(db_err)?;
			if !exists {
				return Err(EngineError::NotFound {
					entity: "course".into(),
					id: course_id.to_string(),
				});
			}
		}
		transaction
			.execute(
				"DELETE FROM excluded_folders WHERE scope = ?1 AND ((course_id IS NULL AND ?2 IS NULL) OR course_id = ?2)",
				params![scope, course_id],
			)
			.map_err(db_err)?;
		for path in &normalized {
			transaction
				.execute(
					"INSERT INTO excluded_folders (scope, course_id, relative_path) VALUES (?1, ?2, ?3)",
					params![scope, course_id, path],
				)
				.map_err(db_err)?;
		}
		reapply_excluded_file_flags(&transaction, base_folder.as_deref())?;
		apply_rule_compliance(&transaction, engine)?;
		transaction.commit().map_err(db_err)?;
		self.list_excluded_folders(course_id)
	}
}

fn normalize_relative_path(value: &str) -> EngineResult<String> {
	let value = value.trim().replace('\\', "/");
	if value.is_empty() || value.starts_with('/') || value.contains(':') {
		return Err(invalid("paths", "relative folder paths only are allowed"));
	}
	let path = Path::new(&value);
	if path
		.components()
		.any(|component| matches!(component, Component::ParentDir))
	{
		return Err(invalid(
			"paths",
			"parent directory segments are not allowed",
		));
	}
	let normalized = value.trim_matches('/').to_string();
	if normalized.is_empty() {
		Ok(".".to_string())
	} else {
		Ok(normalized)
	}
}

fn reapply_excluded_file_flags(
	transaction: &rusqlite::Transaction<'_>,
	root: Option<&Path>,
) -> EngineResult<()> {
	let Some(root) = root else {
		return Ok(());
	};
	let root = normalize_absolute(root);
	let rows = {
		let mut statement = transaction
			.prepare("SELECT id, saved_path, course_id FROM files")
			.map_err(db_err)?;
		let rows = statement
			.query_map([], |row| {
				Ok((
					row.get::<_, i64>(0)?,
					row.get::<_, String>(1)?,
					row.get::<_, Option<i64>>(2)?,
				))
			})
			.map_err(db_err)?
			.collect::<rusqlite::Result<Vec<_>>>()
			.map_err(db_err)?;
		rows
	};
	for (file_id, saved_path, course_id) in rows {
		let relative = normalize_absolute(Path::new(&saved_path))
			.strip_prefix(&root)
			.map(|path| path.trim_matches('/').to_ascii_lowercase());
		let excluded = relative.is_some_and(|relative| {
			transaction
				.query_row(
					"SELECT EXISTS(SELECT 1 FROM excluded_folders e
					 WHERE (e.scope = 'root' OR (e.scope = 'course' AND e.course_id = ?2))
					 AND (?1 = lower(e.relative_path) OR ?1 LIKE lower(e.relative_path) || '/%'))",
					params![relative, course_id],
					|row| row.get::<_, bool>(0),
				)
				.unwrap_or(false)
		});
		transaction
			.execute(
				"UPDATE files SET excluded_at = CASE WHEN ?1 THEN datetime('now') ELSE NULL END WHERE id = ?2",
				params![excluded, file_id],
			)
			.map_err(db_err)?;
	}
	Ok(())
}

fn normalize_absolute(path: &Path) -> String {
	path.to_string_lossy()
		.replace('\\', "/")
		.trim_end_matches('/')
		.to_ascii_lowercase()
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
	use crate::rule::DefaultRuleEngine;

	#[test]
	fn excluded_folders_are_replaced_per_scope_and_course() {
		let mut database = Database::open_in_memory().unwrap();
		let base_folder = std::env::temp_dir();
		database
			.conn
			.execute(
				"INSERT INTO app_settings (key, value) VALUES ('base_folder_path', ?1)",
				[base_folder.to_string_lossy().as_ref()],
			)
			.unwrap();
		database
			.conn
			.execute(
				"INSERT INTO courses (id, moodle_course_id, name) VALUES (1, 'course-1', 'Course 1')",
				[],
			)
			.unwrap();
		database
			.conn
			.execute(
				"INSERT INTO global_rule (id, pattern_key, pattern_template) VALUES (1, 'course', '{course}')",
				[],
			)
			.unwrap();

		let root = database
			.update_excluded_folders("root", None, &["Materials".to_string()], &DefaultRuleEngine)
			.unwrap();
		assert_eq!(root.len(), 1);
		assert_eq!(root[0].relative_path, "Materials");

		let course = database
			.update_excluded_folders(
				"course",
				Some(1),
				&["Drafts".to_string()],
				&DefaultRuleEngine,
			)
			.unwrap();
		assert_eq!(
			database
				.list_excluded_folders(Some(1))
				.unwrap()
				.iter()
				.map(|folder| folder.relative_path.as_str())
				.collect::<Vec<_>>(),
			["Drafts", "Materials"]
		);
		assert_eq!(course.len(), 2);

		let error = database.update_excluded_folders(
			"course",
			Some(1),
			&["../outside".to_string()],
			&DefaultRuleEngine,
		);
		assert!(matches!(error, Err(EngineError::InvalidInput { field, .. }) if field == "paths"));
	}
}
