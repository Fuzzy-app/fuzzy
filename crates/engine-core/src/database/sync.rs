use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::{db_err, Database};
use crate::types::{AssignmentChangeRecord, AssignmentSyncInput, DataSyncEventRecord};
use crate::{EngineError, EngineResult};

#[derive(Debug)]
struct StoredAssignment {
	title: String,
	due_at: Option<String>,
	due_at_status: String,
	submission_mode: String,
	submitted: bool,
}

impl Database {
	pub fn latest_sync_event(&self) -> EngineResult<Option<DataSyncEventRecord>> {
		self.conn
			.query_row(
				"SELECT id, synced_at, trigger, new_assignment_count,
				        changed_assignment_count, removed_assignment_count
				 FROM sync_events
				 ORDER BY id DESC
				 LIMIT 1",
				[],
				sync_event_from_row,
			)
			.optional()
			.map_err(db_err)
	}

	pub fn assignment_changes(
		&self,
		since_sync_event_id: Option<i64>,
	) -> EngineResult<Vec<AssignmentChangeRecord>> {
		if since_sync_event_id.is_some_and(|id| id < 0) {
			return Err(EngineError::InvalidInput {
				field: "sinceSyncEventId".to_string(),
				reason: "0以上の整数を指定してください".to_string(),
			});
		}
		let latest_id = self.latest_sync_event()?.map(|event| event.id);
		let mut statement = self
			.conn
			.prepare(
				"SELECT ac.assignment_id, c.name, a.title, ac.field,
				        ac.old_value, ac.new_value, ac.detected_at
				 FROM assignment_changes ac
				 JOIN assignments a ON a.id = ac.assignment_id
				 JOIN courses c ON c.id = a.course_id
				 WHERE (
					?1 IS NOT NULL AND ac.sync_event_id > ?1
				 ) OR (
					?1 IS NULL AND ac.sync_event_id = ?2
				 )
				 ORDER BY ac.sync_event_id, ac.id",
			)
			.map_err(db_err)?;
		let changes = statement
			.query_map(params![since_sync_event_id, latest_id], |row| {
				Ok(AssignmentChangeRecord {
					assignment_id: row.get(0)?,
					course_name: row.get(1)?,
					title: row.get(2)?,
					field: row.get(3)?,
					old_value: row.get(4)?,
					new_value: row.get(5)?,
					detected_at: row.get(6)?,
				})
			})
			.map_err(db_err)?
			.collect::<rusqlite::Result<Vec<_>>>()
			.map_err(db_err)?;
		Ok(changes)
	}

	/// Atomically stores one complete Moodle assignment snapshot and its field-level diff.
	pub fn sync_assignments(
		&mut self,
		trigger: &str,
		assignments: &[AssignmentSyncInput],
	) -> EngineResult<DataSyncEventRecord> {
		validate_sync_input(trigger, assignments)?;
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let synced_at: String = transaction
			.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
				row.get(0)
			})
			.map_err(db_err)?;
		transaction
			.execute(
				"INSERT INTO sync_events (synced_at, trigger) VALUES (?1, ?2)",
				params![synced_at, trigger],
			)
			.map_err(db_err)?;
		let event_id = transaction.last_insert_rowid();

		let mut stored = HashMap::new();
		{
			let mut statement = transaction
				.prepare(
					"SELECT id, title, due_at, due_at_status,
					        submission_mode, submitted
					 FROM assignments
					 WHERE source IN ('moodle_dashboard', 'moodle_text')
					   AND removed_at IS NULL",
				)
				.map_err(db_err)?;
			for row in statement
				.query_map([], |row| {
					Ok((
						row.get::<_, i64>(0)?,
						StoredAssignment {
							title: row.get(1)?,
							due_at: row.get(2)?,
							due_at_status: row.get(3)?,
							submission_mode: row.get(4)?,
							submitted: row.get::<_, i64>(5)? != 0,
						},
					))
				})
				.map_err(db_err)?
			{
				let (id, value) = row.map_err(db_err)?;
				stored.insert(id, value);
			}
		}

		let incoming_ids = assignments
			.iter()
			.map(|item| item.id)
			.collect::<HashSet<_>>();
		let mut new_count = 0;
		let mut changed_count = 0;
		for incoming in assignments {
			if let Some(previous) = stored.get(&incoming.id) {
				let submitted = synced_submitted(Some(previous.submitted), incoming);
				let changes = changed_fields(previous, incoming, submitted);
				if !changes.is_empty() {
					changed_count += 1;
					for (field, old_value, new_value) in changes {
						transaction
							.execute(
								"INSERT INTO assignment_changes (
									sync_event_id, assignment_id, field, old_value, new_value, detected_at
								 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
								params![
									event_id,
									incoming.id,
									field,
									old_value,
									new_value,
									synced_at
								],
							)
							.map_err(db_err)?;
					}
				}
				transaction
					.execute(
						"UPDATE assignments
						 SET course_id = ?1, title = ?2, source = ?3, due_at = ?4,
						     due_at_status = ?5, submission_mode = ?6, submitted = ?7,
						     removed_at = NULL, updated_at = ?8
						 WHERE id = ?9",
						params![
							incoming.course_id,
							incoming.title,
							incoming.source,
							incoming.due_at,
							incoming.due_at_status,
							incoming.submission_mode,
							submitted,
							synced_at,
							incoming.id
						],
					)
					.map_err(db_err)?;
			} else {
				let existing: Option<(String, bool)> = transaction
					.query_row(
						"SELECT source, submitted FROM assignments WHERE id = ?1",
						[incoming.id],
						|row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
					)
					.optional()
					.map_err(db_err)?;
				if existing
					.as_ref()
					.is_some_and(|(source, _)| source == "file_content")
				{
					return Err(EngineError::InvalidInput {
						field: "assignments.id".to_string(),
						reason: format!("ID {} は同期対象外の課題に使用されています", incoming.id),
					});
				}
				let submitted =
					synced_submitted(existing.as_ref().map(|(_, submitted)| *submitted), incoming);
				new_count += 1;
				transaction
					.execute(
						"INSERT INTO assignments (
							id, course_id, title, source, due_at, due_at_status,
							submission_mode, submitted, removed_at, created_at, updated_at
						 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?9)
						 ON CONFLICT(id) DO UPDATE SET
							course_id = excluded.course_id, title = excluded.title,
							source = excluded.source, due_at = excluded.due_at,
							due_at_status = excluded.due_at_status,
							submission_mode = excluded.submission_mode,
							submitted = excluded.submitted, removed_at = NULL,
							updated_at = excluded.updated_at",
						params![
							incoming.id,
							incoming.course_id,
							incoming.title,
							incoming.source,
							incoming.due_at,
							incoming.due_at_status,
							incoming.submission_mode,
							submitted,
							synced_at
						],
					)
					.map_err(db_err)?;
			}
		}

		let removed_count = stored
			.keys()
			.filter(|id| !incoming_ids.contains(id))
			.try_fold(0i64, |count, id| {
				transaction
					.execute(
						"UPDATE assignments SET removed_at = ?1, updated_at = ?1 WHERE id = ?2",
						params![synced_at, id],
					)
					.map(|_| count + 1)
					.map_err(db_err)
			})?;
		transaction
			.execute(
				"UPDATE sync_events
				 SET new_assignment_count = ?1, changed_assignment_count = ?2,
				     removed_assignment_count = ?3
				 WHERE id = ?4",
				params![new_count, changed_count, removed_count, event_id],
			)
			.map_err(db_err)?;
		transaction
			.execute(
				"INSERT INTO app_settings (key, value) VALUES ('last_full_scan_at', ?1)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				[&synced_at],
			)
			.map_err(db_err)?;
		transaction.commit().map_err(db_err)?;

		Ok(DataSyncEventRecord {
			id: event_id,
			synced_at,
			trigger: trigger.to_string(),
			new_assignment_count: new_count,
			changed_assignment_count: changed_count,
			removed_assignment_count: removed_count,
		})
	}
}

fn changed_fields(
	previous: &StoredAssignment,
	incoming: &AssignmentSyncInput,
	submitted: bool,
) -> Vec<(&'static str, Option<String>, Option<String>)> {
	let mut changes = Vec::new();
	if previous.title != incoming.title {
		changes.push((
			"title",
			Some(previous.title.clone()),
			Some(incoming.title.clone()),
		));
	}
	if previous.due_at != incoming.due_at {
		changes.push(("due_at", previous.due_at.clone(), incoming.due_at.clone()));
	}
	if previous.due_at_status != incoming.due_at_status {
		changes.push((
			"due_at_status",
			Some(previous.due_at_status.clone()),
			Some(incoming.due_at_status.clone()),
		));
	}
	if previous.submission_mode != incoming.submission_mode {
		changes.push((
			"submission_mode",
			Some(previous.submission_mode.clone()),
			Some(incoming.submission_mode.clone()),
		));
	}
	if previous.submitted != submitted {
		changes.push((
			"submitted",
			Some(previous.submitted.to_string()),
			Some(submitted.to_string()),
		));
	}
	changes
}

fn synced_submitted(previous: Option<bool>, incoming: &AssignmentSyncInput) -> bool {
	if incoming.submission_mode == "moodle_auto" {
		incoming.submitted
	} else {
		previous.unwrap_or(incoming.submitted)
	}
}

fn validate_sync_input(trigger: &str, assignments: &[AssignmentSyncInput]) -> EngineResult<()> {
	if !matches!(trigger, "manual" | "auto") {
		return Err(EngineError::InvalidInput {
			field: "trigger".to_string(),
			reason: "manual または auto を指定してください".to_string(),
		});
	}
	let mut ids = HashSet::new();
	for assignment in assignments {
		if assignment.id <= 0 || !ids.insert(assignment.id) {
			return Err(EngineError::InvalidInput {
				field: "assignments.id".to_string(),
				reason: "正の一意なIDを指定してください".to_string(),
			});
		}
		if assignment.course_id <= 0 || assignment.title.trim().is_empty() {
			return Err(EngineError::InvalidInput {
				field: "assignments".to_string(),
				reason: "courseId と title は必須です".to_string(),
			});
		}
		if !matches!(
			assignment.source.as_str(),
			"moodle_dashboard" | "moodle_text"
		) || !matches!(assignment.due_at_status.as_str(), "normal" | "needs_review")
			|| !matches!(
				assignment.submission_mode.as_str(),
				"moodle_auto" | "manual" | "notify_only" | "unknown"
			) {
			return Err(EngineError::InvalidInput {
				field: "assignments".to_string(),
				reason: "列挙値が仕様に一致しません".to_string(),
			});
		}
	}
	Ok(())
}

fn sync_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DataSyncEventRecord> {
	Ok(DataSyncEventRecord {
		id: row.get(0)?,
		synced_at: row.get(1)?,
		trigger: row.get(2)?,
		new_assignment_count: row.get(3)?,
		changed_assignment_count: row.get(4)?,
		removed_assignment_count: row.get(5)?,
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::SEED_SQL;

	#[test]
	fn seed_latest_event_and_changes_match_documented_scenario() {
		let database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		let event = database.latest_sync_event().unwrap().unwrap();
		assert_eq!(
			(
				event.id,
				event.new_assignment_count,
				event.changed_assignment_count
			),
			(2, 1, 2)
		);
		let changes = database.assignment_changes(None).unwrap();
		assert_eq!(changes.len(), 2);
		assert_eq!(changes[0].field, "due_at_status");
		assert_eq!(changes[0].old_value.as_deref(), Some("normal"));
		assert_eq!(changes[0].new_value.as_deref(), Some("needs_review"));
	}

	#[test]
	fn sync_records_field_diffs_counts_and_soft_removals() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute_batch(
				"INSERT INTO courses (id, moodle_course_id, name) VALUES (1, 'c1', 'Course');
			 INSERT INTO assignments
				(id, course_id, title, source, due_at, due_at_status, submission_mode, submitted)
			 VALUES
				(1, 1, 'Old title', 'moodle_dashboard', '2026-07-01', 'normal', 'moodle_auto', 0),
				(2, 1, 'Removed', 'moodle_dashboard', NULL, 'normal', 'unknown', 0);",
			)
			.unwrap();
		let event = database
			.sync_assignments(
				"auto",
				&[
					AssignmentSyncInput {
						id: 1,
						course_id: 1,
						title: "New title".into(),
						source: "moodle_dashboard".into(),
						due_at: Some("2026-07-02".into()),
						due_at_status: "normal".into(),
						submission_mode: "moodle_auto".into(),
						submitted: false,
					},
					AssignmentSyncInput {
						id: 3,
						course_id: 1,
						title: "New".into(),
						source: "moodle_text".into(),
						due_at: None,
						due_at_status: "needs_review".into(),
						submission_mode: "manual".into(),
						submitted: false,
					},
				],
			)
			.unwrap();
		assert_eq!(
			(
				event.new_assignment_count,
				event.changed_assignment_count,
				event.removed_assignment_count
			),
			(1, 1, 1)
		);
		let changes = database.assignment_changes(None).unwrap();
		assert_eq!(
			changes
				.iter()
				.map(|item| item.field.as_str())
				.collect::<Vec<_>>(),
			vec!["title", "due_at"]
		);
		assert_eq!(
			database
				.deadlines(Default::default())
				.unwrap()
				.iter()
				.map(|item| item.id)
				.collect::<Vec<_>>(),
			vec![1, 3]
		);
	}

	#[test]
	fn manual_submission_status_survives_moodle_sync() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute_batch(
				"INSERT INTO courses (id, moodle_course_id, name) VALUES (1, 'c1', 'Course');
				 INSERT INTO assignments
					(id, course_id, title, source, due_at, due_at_status, submission_mode, submitted)
				 VALUES
					(1, 1, 'Manual task', 'moodle_text', NULL, 'normal', 'manual', 1);",
			)
			.unwrap();

		let event = database
			.sync_assignments(
				"auto",
				&[AssignmentSyncInput {
					id: 1,
					course_id: 1,
					title: "Manual task".into(),
					source: "moodle_text".into(),
					due_at: None,
					due_at_status: "normal".into(),
					submission_mode: "manual".into(),
					submitted: false,
				}],
			)
			.unwrap();

		assert_eq!(event.changed_assignment_count, 0);
		let submitted: i64 = database
			.conn()
			.query_row(
				"SELECT submitted FROM assignments WHERE id = 1",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(submitted, 1);
		assert!(database.assignment_changes(None).unwrap().is_empty());
	}

	#[test]
	fn empty_history_and_invalid_change_cursor_are_handled() {
		let database = Database::open_in_memory().unwrap();
		assert!(database.latest_sync_event().unwrap().is_none());
		assert!(database.assignment_changes(None).unwrap().is_empty());
		assert!(matches!(
			database.assignment_changes(Some(-1)),
			Err(EngineError::InvalidInput { .. })
		));
	}

	#[test]
	fn invalid_sync_is_atomic() {
		let mut database = Database::open_in_memory().unwrap();
		let result = database.sync_assignments(
			"auto",
			&[AssignmentSyncInput {
				id: 1,
				course_id: 999,
				title: "Task".into(),
				source: "moodle_dashboard".into(),
				due_at: None,
				due_at_status: "normal".into(),
				submission_mode: "unknown".into(),
				submitted: false,
			}],
		);
		assert!(result.is_err());
		assert!(database.latest_sync_event().unwrap().is_none());
	}
}
