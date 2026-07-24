//! ダッシュボード集計と課題・締切のSQLite永続化。

use rusqlite::{params, Connection};

use super::{db_err, Database};
use crate::types::{AssignmentRecord, CourseDashboardRecord, DashboardRecord, DeadlineFilter};
use crate::{EngineError, EngineResult};

impl Database {
	/// 現在時刻を基準に、コース別の資料・違反・次の締切を集計する。
	pub fn dashboard(&self) -> EngineResult<DashboardRecord> {
		load_dashboard(&self.conn, None)
	}

	/// 現在時刻を基準に、指定条件の課題・締切を取得する。
	pub fn deadlines(&self, filter: DeadlineFilter) -> EngineResult<Vec<AssignmentRecord>> {
		load_deadlines(&self.conn, filter, None)
	}

	/// 課題の提出状態を更新する。存在しないIDは成功扱いにしない。
	pub fn update_submission_status(
		&self,
		assignment_id: i64,
		submitted: bool,
	) -> EngineResult<()> {
		if assignment_id <= 0 {
			return Err(EngineError::InvalidInput {
				field: "assignmentId".to_string(),
				reason: "1以上の整数を指定してください".to_string(),
			});
		}
		let updated = self
			.conn
			.execute(
				"UPDATE assignments
				 SET submitted = ?1, updated_at = datetime('now')
				 WHERE id = ?2",
				params![submitted, assignment_id],
			)
			.map_err(db_err)?;
		if updated != 1 {
			return Err(EngineError::NotFound {
				entity: "課題".to_string(),
				id: assignment_id.to_string(),
			});
		}
		Ok(())
	}
}

fn load_dashboard(conn: &Connection, now: Option<&str>) -> EngineResult<DashboardRecord> {
	let now = now.unwrap_or("now");
	let mut statement = conn
		.prepare(
			"SELECT
				c.id,
				c.name,
				COUNT(f.id),
				COUNT(CASE WHEN f.rule_compliant = 0 THEN 1 END),
				(
					SELECT a.due_at
					FROM assignments a
					WHERE a.course_id = c.id
						AND a.submitted = 0
						AND a.due_at IS NOT NULL
						AND julianday(a.due_at) >= julianday(?1)
					ORDER BY julianday(a.due_at), a.id
					LIMIT 1
				)
			 FROM courses c
			 LEFT JOIN files f ON f.course_id = c.id
			 GROUP BY c.id, c.name
			 ORDER BY c.id",
		)
		.map_err(db_err)?;
	let courses = statement
		.query_map([now], |row| {
			Ok(CourseDashboardRecord {
				course_id: row.get(0)?,
				course_name: row.get(1)?,
				file_count: row.get(2)?,
				violation_count: row.get(3)?,
				next_due_at: row.get(4)?,
			})
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;

	let (total_files, total_violations) = conn
		.query_row(
			"SELECT COUNT(*), COUNT(CASE WHEN rule_compliant = 0 THEN 1 END) FROM files",
			[],
			|row| Ok((row.get(0)?, row.get(1)?)),
		)
		.map_err(db_err)?;
	let upcoming_deadline_count = conn
		.query_row(
			"SELECT COUNT(*)
			 FROM assignments
			 WHERE submitted = 0
				AND due_at IS NOT NULL
				AND julianday(due_at) >= julianday(?1)",
			[now],
			|row| row.get(0),
		)
		.map_err(db_err)?;

	Ok(DashboardRecord {
		courses,
		total_files,
		total_violations,
		upcoming_deadline_count,
	})
}

fn load_deadlines(
	conn: &Connection,
	filter: DeadlineFilter,
	now: Option<&str>,
) -> EngineResult<Vec<AssignmentRecord>> {
	if filter.course_id.is_some_and(|course_id| course_id <= 0) {
		return Err(EngineError::InvalidInput {
			field: "filter.courseId".to_string(),
			reason: "1以上の整数を指定してください".to_string(),
		});
	}
	let now = now.unwrap_or("now");
	let mut statement = conn
		.prepare(
			"SELECT
				a.id,
				a.course_id,
				c.name,
				a.title,
				a.source,
				a.due_at,
				a.due_at_status,
				a.submission_mode,
				a.submitted
			 FROM assignments a
			 JOIN courses c ON c.id = a.course_id
			 WHERE (?1 IS NULL OR a.course_id = ?1)
				AND (?2 = 0 OR a.due_at_status = 'needs_review')
				AND (
					?3 = 1
					OR a.due_at IS NULL
					OR julianday(a.due_at) >= julianday(?4)
					OR a.submitted = 0
				)
			 ORDER BY a.due_at IS NULL, julianday(a.due_at), a.id",
		)
		.map_err(db_err)?;
	let records = statement
		.query_map(
			params![
				filter.course_id,
				filter.needs_review_only,
				filter.include_past,
				now
			],
			|row| {
				let submitted = sqlite_boolean(row.get(8)?, 8)?;
				Ok(AssignmentRecord {
					id: row.get(0)?,
					course_id: row.get(1)?,
					course_name: row.get(2)?,
					title: row.get(3)?,
					source: row.get(4)?,
					due_at: row.get(5)?,
					due_at_status: row.get(6)?,
					submission_mode: row.get(7)?,
					submitted,
				})
			},
		)
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	Ok(records)
}

fn sqlite_boolean(value: i64, column: usize) -> rusqlite::Result<bool> {
	match value {
		0 => Ok(false),
		1 => Ok(true),
		other => Err(rusqlite::Error::IntegralValueOutOfRange(column, other)),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::SEED_SQL;

	fn seeded_database() -> Database {
		let database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		database
	}

	#[test]
	fn dashboard_matches_seed_at_the_documented_reference_time() {
		let database = seeded_database();
		let dashboard = load_dashboard(database.conn(), Some("2026-07-01T08:00:00")).unwrap();

		assert_eq!(dashboard.total_files, 9);
		assert_eq!(dashboard.total_violations, 2);
		assert_eq!(dashboard.upcoming_deadline_count, 3);
		assert_eq!(dashboard.courses.len(), 6);
		assert_eq!(dashboard.courses[1].file_count, 3);
		assert_eq!(dashboard.courses[1].violation_count, 2);
		assert_eq!(
			dashboard.courses[0].next_due_at.as_deref(),
			Some("2026-07-03T17:00:00")
		);
	}

	#[test]
	fn deadlines_apply_all_contract_filters() {
		let database = seeded_database();
		let course = load_deadlines(
			database.conn(),
			DeadlineFilter {
				course_id: Some(2),
				include_past: true,
				needs_review_only: false,
			},
			Some("2026-07-01T08:00:00"),
		)
		.unwrap();
		assert_eq!(
			course.iter().map(|item| item.id).collect::<Vec<_>>(),
			vec![1]
		);

		let review = load_deadlines(
			database.conn(),
			DeadlineFilter {
				needs_review_only: true,
				..DeadlineFilter::default()
			},
			Some("2026-07-01T08:00:00"),
		)
		.unwrap();
		assert_eq!(
			review.iter().map(|item| item.id).collect::<Vec<_>>(),
			vec![5]
		);
	}

	#[test]
	fn submission_update_persists_and_missing_id_is_not_found() {
		let database = seeded_database();
		database.update_submission_status(2, true).unwrap();
		let submitted: i64 = database
			.conn()
			.query_row(
				"SELECT submitted FROM assignments WHERE id = 2",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(submitted, 1);
		assert!(matches!(
			database.update_submission_status(999, true),
			Err(EngineError::NotFound { .. })
		));
	}

	#[test]
	fn dashboard_orders_timezone_aware_deadlines_by_actual_time() {
		let database = seeded_database();
		database
			.conn()
			.execute("DELETE FROM assignments", [])
			.unwrap();
		database
			.conn()
			.execute_batch(
				"INSERT INTO assignments
					(id, course_id, title, source, due_at, due_at_status, submission_mode, submitted)
				 VALUES
					(101, 1, 'earlier', 'moodle_dashboard', '2026-07-02T00:30:00+09:00', 'normal', 'moodle_auto', 0),
					(102, 1, 'later', 'moodle_dashboard', '2026-07-01T20:00:00Z', 'normal', 'moodle_auto', 0);",
			)
			.unwrap();

		let dashboard = load_dashboard(database.conn(), Some("2026-07-01T00:00:00Z")).unwrap();
		assert_eq!(
			dashboard.courses[0].next_due_at.as_deref(),
			Some("2026-07-02T00:30:00+09:00")
		);
	}
}
