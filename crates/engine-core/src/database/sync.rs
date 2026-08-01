use std::collections::{HashMap, HashSet};

use super::{db_err, Database};
use crate::types::{
	is_supported_moodle_assignment_url, AssignmentChangeRecord, AssignmentSyncInput,
	DataSyncEventRecord, MoodleAssignmentSyncInput,
};
use crate::{EngineError, EngineResult};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

#[derive(Debug)]
struct StoredAssignment {
	title: String,
	due_at: Option<String>,
	due_at_status: String,
	submission_mode: String,
	submitted: bool,
	submission_availability: String,
	moodle_url: Option<String>,
}

struct StoredAssignmentState {
	id: i64,
	value: StoredAssignment,
	removed_at: Option<String>,
}

impl Database {
	/// コース解決などの書き込み前に、Moodle同期payloadを副作用なく検証する。
	pub fn validate_moodle_assignment_snapshot(
		trigger: &str,
		assignments: &[MoodleAssignmentSyncInput],
	) -> EngineResult<()> {
		validate_moodle_sync_input(trigger, 1, assignments)
	}

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

	/// Moodleの安定課題IDを使い、1コース分の完全スナップショットを原子的に保存する。
	///
	/// 未受信課題の除外判定は指定コース内だけに限定し、別コースの同期状態を変更しない。
	pub fn sync_moodle_assignments(
		&mut self,
		trigger: &str,
		course_id: i64,
		assignments: &[MoodleAssignmentSyncInput],
	) -> EngineResult<DataSyncEventRecord> {
		validate_moodle_sync_input(trigger, course_id, assignments)?;
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let course_exists = transaction
			.query_row(
				"SELECT EXISTS(SELECT 1 FROM courses WHERE id = ?1)",
				[course_id],
				|row| row.get::<_, bool>(0),
			)
			.map_err(db_err)?;
		if !course_exists {
			return Err(EngineError::NotFound {
				entity: "コース".to_string(),
				id: course_id.to_string(),
			});
		}
		for assignment in assignments {
			if let Some(due_at) = assignment.due_at.as_deref() {
				let valid = transaction
					.query_row("SELECT julianday(?1) IS NOT NULL", [due_at], |row| {
						row.get::<_, bool>(0)
					})
					.map_err(db_err)?;
				if !valid {
					return Err(EngineError::InvalidInput {
						field: "assignments.dueAt".to_string(),
						reason: "実在するISO 8601日時を指定してください".to_string(),
					});
				}
			}
		}

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
					"SELECT id, moodle_assignment_id, title, due_at, due_at_status,
					        submission_mode, submitted, submission_availability,
					        moodle_url, removed_at
					 FROM assignments
					 WHERE course_id = ?1
					   AND source IN ('moodle_dashboard', 'moodle_text')
					   AND moodle_assignment_id IS NOT NULL",
				)
				.map_err(db_err)?;
			for row in statement
				.query_map([course_id], |row| {
					Ok((
						row.get::<_, String>(1)?,
						StoredAssignmentState {
							id: row.get(0)?,
							value: StoredAssignment {
								title: row.get(2)?,
								due_at: row.get(3)?,
								due_at_status: row.get(4)?,
								submission_mode: row.get(5)?,
								submitted: row.get::<_, i64>(6)? != 0,
								submission_availability: row.get(7)?,
								moodle_url: row.get(8)?,
							},
							removed_at: row.get(9)?,
						},
					))
				})
				.map_err(db_err)?
			{
				let (moodle_assignment_id, value) = row.map_err(db_err)?;
				stored.insert(moodle_assignment_id, value);
			}
		}

		let incoming_ids = assignments
			.iter()
			.map(|item| item.moodle_assignment_id.as_str())
			.collect::<HashSet<_>>();
		let mut new_count = 0;
		let mut changed_count = 0;
		for incoming in assignments {
			if let Some(previous) = stored.get(&incoming.moodle_assignment_id) {
				let submitted = synced_moodle_submitted(Some(previous.value.submitted), incoming);
				if previous.removed_at.is_none() {
					let changes = changed_moodle_fields(&previous.value, incoming, submitted);
					if !changes.is_empty() {
						changed_count += 1;
						for (field, old_value, new_value) in changes {
							insert_assignment_change(
								&transaction,
								event_id,
								previous.id,
								field,
								old_value.as_deref(),
								new_value.as_deref(),
								&synced_at,
							)?;
						}
					}
				} else {
					new_count += 1;
					insert_assignment_change(
						&transaction,
						event_id,
						previous.id,
						"removed_at",
						previous.removed_at.as_deref(),
						None,
						&synced_at,
					)?;
				}
				transaction
					.execute(
						"UPDATE assignments
						 SET title = ?1, source = ?2, due_at = ?3, due_at_status = ?4,
						     submission_mode = ?5, submitted = ?6,
						     submission_availability = ?7, moodle_url = ?8,
						     removed_at = NULL, updated_at = ?9
						 WHERE id = ?10",
						params![
							incoming.title,
							incoming.source,
							incoming.due_at,
							incoming.due_at_status,
							incoming.submission_mode,
							submitted,
							incoming.submission_availability,
							incoming.moodle_url,
							synced_at,
							previous.id
						],
					)
					.map_err(db_err)?;
			} else {
				new_count += 1;
				transaction
					.execute(
						"INSERT INTO assignments (
							course_id, moodle_assignment_id, title, source, due_at,
							due_at_status, submission_mode, submitted,
							submission_availability, moodle_url, removed_at,
							created_at, updated_at
						 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?11)",
						params![
							course_id,
							incoming.moodle_assignment_id,
							incoming.title,
							incoming.source,
							incoming.due_at,
							incoming.due_at_status,
							incoming.submission_mode,
							incoming.submitted,
							incoming.submission_availability,
							incoming.moodle_url,
							synced_at
						],
					)
					.map_err(db_err)?;
			}
		}

		let mut removed_count = 0;
		for (_, assignment) in stored.iter().filter(|(moodle_assignment_id, assignment)| {
			assignment.removed_at.is_none() && !incoming_ids.contains(moodle_assignment_id.as_str())
		}) {
			insert_assignment_change(
				&transaction,
				event_id,
				assignment.id,
				"removed_at",
				None,
				Some(&synced_at),
				&synced_at,
			)?;
			transaction
				.execute(
					"UPDATE assignments SET removed_at = ?1, updated_at = ?1 WHERE id = ?2",
					params![synced_at, assignment.id],
				)
				.map_err(db_err)?;
			removed_count += 1;
		}
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
					        submission_mode, submitted, submission_availability,
					        moodle_url, removed_at
					 FROM assignments
					 WHERE source IN ('moodle_dashboard', 'moodle_text')",
				)
				.map_err(db_err)?;
			for row in statement
				.query_map([], |row| {
					Ok((
						row.get::<_, i64>(0)?,
						StoredAssignmentState {
							id: row.get(0)?,
							value: StoredAssignment {
								title: row.get(1)?,
								due_at: row.get(2)?,
								due_at_status: row.get(3)?,
								submission_mode: row.get(4)?,
								submitted: row.get::<_, i64>(5)? != 0,
								submission_availability: row.get(6)?,
								moodle_url: row.get(7)?,
							},
							removed_at: row.get(8)?,
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
				let submitted = synced_submitted(Some(previous.value.submitted), incoming);
				if previous.removed_at.is_none() {
					let changes = changed_fields(&previous.value, incoming, submitted);
					if !changes.is_empty() {
						changed_count += 1;
						for (field, old_value, new_value) in changes {
							insert_assignment_change(
								&transaction,
								event_id,
								incoming.id,
								field,
								old_value.as_deref(),
								new_value.as_deref(),
								&synced_at,
							)?;
						}
					}
				} else {
					new_count += 1;
					insert_assignment_change(
						&transaction,
						event_id,
						incoming.id,
						"removed_at",
						previous.removed_at.as_deref(),
						None,
						&synced_at,
					)?;
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

		let mut removed_count = 0;
		for (id, _) in stored.iter().filter(|(id, assignment)| {
			assignment.removed_at.is_none() && !incoming_ids.contains(id)
		}) {
			insert_assignment_change(
				&transaction,
				event_id,
				*id,
				"removed_at",
				None,
				Some(&synced_at),
				&synced_at,
			)?;
			transaction
				.execute(
					"UPDATE assignments SET removed_at = ?1, updated_at = ?1 WHERE id = ?2",
					params![synced_at, id],
				)
				.map_err(db_err)?;
			removed_count += 1;
		}
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

fn insert_assignment_change(
	transaction: &Transaction<'_>,
	event_id: i64,
	assignment_id: i64,
	field: &str,
	old_value: Option<&str>,
	new_value: Option<&str>,
	detected_at: &str,
) -> EngineResult<()> {
	transaction
		.execute(
			"INSERT INTO assignment_changes (
				sync_event_id, assignment_id, field, old_value, new_value, detected_at
			 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
			params![
				event_id,
				assignment_id,
				field,
				old_value,
				new_value,
				detected_at
			],
		)
		.map_err(db_err)?;
	Ok(())
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

fn changed_moodle_fields(
	previous: &StoredAssignment,
	incoming: &MoodleAssignmentSyncInput,
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
	if previous.submission_availability != incoming.submission_availability {
		changes.push((
			"submission_availability",
			Some(previous.submission_availability.clone()),
			Some(incoming.submission_availability.clone()),
		));
	}
	if previous.moodle_url != incoming.moodle_url {
		changes.push((
			"moodle_url",
			previous.moodle_url.clone(),
			incoming.moodle_url.clone(),
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

fn synced_moodle_submitted(previous: Option<bool>, incoming: &MoodleAssignmentSyncInput) -> bool {
	if incoming.submission_mode == "moodle_auto" {
		incoming.submitted
	} else {
		previous.unwrap_or(incoming.submitted)
	}
}

fn validate_moodle_sync_input(
	trigger: &str,
	course_id: i64,
	assignments: &[MoodleAssignmentSyncInput],
) -> EngineResult<()> {
	if !matches!(trigger, "manual" | "auto") {
		return Err(EngineError::InvalidInput {
			field: "trigger".to_string(),
			reason: "manual または auto を指定してください".to_string(),
		});
	}
	if course_id <= 0 {
		return Err(EngineError::InvalidInput {
			field: "courseId".to_string(),
			reason: "正の整数を指定してください".to_string(),
		});
	}
	if assignments.len() > 2_000 {
		return Err(EngineError::InvalidInput {
			field: "assignments".to_string(),
			reason: "1回に同期できる課題数を超えています".to_string(),
		});
	}

	let mut ids = HashSet::new();
	for assignment in assignments {
		if !valid_moodle_identifier(&assignment.moodle_assignment_id)
			|| !ids.insert(assignment.moodle_assignment_id.as_str())
		{
			return Err(EngineError::InvalidInput {
				field: "assignments.moodleAssignmentId".to_string(),
				reason: "コース内で一意なMoodle課題IDを指定してください".to_string(),
			});
		}
		if assignment.title.trim().is_empty() || assignment.title.chars().count() > 1_000 {
			return Err(EngineError::InvalidInput {
				field: "assignments.title".to_string(),
				reason: "1文字以上1000文字以下で指定してください".to_string(),
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
		if !matches!(
			assignment.submission_availability.as_str(),
			"available" | "unavailable" | "unknown"
		) {
			return Err(EngineError::InvalidInput {
				field: "assignments.submissionAvailability".to_string(),
				reason: "available、unavailable、unknownのいずれかを指定してください".to_string(),
			});
		}
		if assignment
			.moodle_url
			.as_deref()
			.is_some_and(|value| !is_supported_moodle_assignment_url(value))
		{
			return Err(EngineError::InvalidInput {
				field: "assignments.moodleUrl".to_string(),
				reason: "対応Moodleの課題詳細URLを指定してください".to_string(),
			});
		}
		if let Some(due_at) = assignment.due_at.as_deref() {
			if due_at.len() > 64 || !has_explicit_iso_offset(due_at) {
				return Err(EngineError::InvalidInput {
					field: "assignments.dueAt".to_string(),
					reason: "タイムゾーンを明示したISO 8601日時を指定してください".to_string(),
				});
			}
		}
	}
	Ok(())
}

fn valid_moodle_identifier(value: &str) -> bool {
	!value.is_empty()
		&& value.len() <= 128
		&& value
			.chars()
			.all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

fn has_explicit_iso_offset(value: &str) -> bool {
	let bytes = value.as_bytes();
	if bytes.len() < 20
		|| bytes.get(4) != Some(&b'-')
		|| bytes.get(7) != Some(&b'-')
		|| bytes.get(10) != Some(&b'T')
		|| bytes.get(13) != Some(&b':')
		|| bytes.get(16) != Some(&b':')
	{
		return false;
	}
	let timezone_start = if value.ends_with('Z') {
		bytes.len() - 1
	} else if bytes.len() >= 6 {
		let start = bytes.len() - 6;
		if !matches!(bytes[start], b'+' | b'-')
			|| bytes[start + 3] != b':'
			|| !bytes[start + 1..start + 3]
				.iter()
				.chain(bytes[start + 4..].iter())
				.all(u8::is_ascii_digit)
		{
			return false;
		}
		let offset_hour = parse_two_digits(&bytes[start + 1..start + 3]);
		let offset_minute = parse_two_digits(&bytes[start + 4..]);
		if offset_hour > 23 || offset_minute > 59 {
			return false;
		}
		start
	} else {
		return false;
	};
	if timezone_start < 19
		|| !bytes[0..4].iter().all(u8::is_ascii_digit)
		|| !bytes[5..7].iter().all(u8::is_ascii_digit)
		|| !bytes[8..10].iter().all(u8::is_ascii_digit)
		|| !bytes[11..13].iter().all(u8::is_ascii_digit)
		|| !bytes[14..16].iter().all(u8::is_ascii_digit)
		|| !bytes[17..19].iter().all(u8::is_ascii_digit)
	{
		return false;
	}
	let fractional = &bytes[19..timezone_start];
	if !fractional.is_empty()
		&& (fractional[0] != b'.'
			|| fractional.len() == 1
			|| !fractional[1..].iter().all(u8::is_ascii_digit))
	{
		return false;
	}
	let month = parse_two_digits(&bytes[5..7]);
	let day = parse_two_digits(&bytes[8..10]);
	let year = parse_four_digits(&bytes[0..4]);
	let hour = parse_two_digits(&bytes[11..13]);
	let minute = parse_two_digits(&bytes[14..16]);
	let second = parse_two_digits(&bytes[17..19]);
	(1..=12).contains(&month)
		&& (1..=days_in_month(year, month)).contains(&day)
		&& hour <= 23
		&& minute <= 59
		&& second <= 59
}

fn parse_two_digits(value: &[u8]) -> u8 {
	(value[0] - b'0') * 10 + value[1] - b'0'
}

fn parse_four_digits(value: &[u8]) -> u16 {
	value
		.iter()
		.fold(0, |total, digit| total * 10 + u16::from(*digit - b'0'))
}

fn days_in_month(year: u16, month: u8) -> u8 {
	match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		2 if year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100)) => {
			29
		}
		2 => 28,
		_ => 0,
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

	fn moodle_assignment(id: &str, title: &str, due_at: Option<&str>) -> MoodleAssignmentSyncInput {
		MoodleAssignmentSyncInput {
			moodle_assignment_id: id.to_string(),
			title: title.to_string(),
			source: "moodle_dashboard".to_string(),
			due_at: due_at.map(str::to_string),
			due_at_status: "normal".to_string(),
			submission_mode: "moodle_auto".to_string(),
			submitted: false,
			submission_availability: "unknown".to_string(),
			moodle_url: Some(format!(
				"https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php?id={id}"
			)),
		}
	}

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
			vec!["title", "due_at", "removed_at"]
		);
		let removal = changes.last().unwrap();
		assert_eq!(removal.assignment_id, 2);
		assert_eq!(removal.old_value, None);
		assert_eq!(removal.new_value.as_deref(), Some(event.synced_at.as_str()));
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
	fn generic_snapshot_records_removal_and_reactivation_without_double_counting() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute_batch(
				"INSERT INTO courses (id, moodle_course_id, name)
				 VALUES (1, 'c1', '情報アーキテクチャ');
				 INSERT INTO assignments (
					id, course_id, title, source, due_at_status, submission_mode, submitted
				 ) VALUES (
					1, 1, '設計レポート', 'moodle_dashboard', 'normal', 'moodle_auto', 0
				 );",
			)
			.unwrap();

		let removed = database.sync_assignments("auto", &[]).unwrap();
		assert_eq!(
			(
				removed.new_assignment_count,
				removed.changed_assignment_count,
				removed.removed_assignment_count
			),
			(0, 0, 1)
		);
		assert_eq!(
			removed.new_assignment_count
				+ removed.changed_assignment_count
				+ removed.removed_assignment_count,
			1
		);
		let removal_changes = database.assignment_changes(None).unwrap();
		assert_eq!(removal_changes.len(), 1);
		assert_eq!(removal_changes[0].field, "removed_at");
		assert_eq!(removal_changes[0].old_value, None);
		assert_eq!(
			removal_changes[0].new_value.as_deref(),
			Some(removed.synced_at.as_str())
		);

		let restored = database
			.sync_assignments(
				"auto",
				&[AssignmentSyncInput {
					id: 1,
					course_id: 1,
					title: "設計レポート".to_string(),
					source: "moodle_dashboard".to_string(),
					due_at: None,
					due_at_status: "normal".to_string(),
					submission_mode: "moodle_auto".to_string(),
					submitted: false,
				}],
			)
			.unwrap();
		assert_eq!(
			(
				restored.new_assignment_count,
				restored.changed_assignment_count,
				restored.removed_assignment_count
			),
			(1, 0, 0)
		);
		assert_eq!(
			restored.new_assignment_count
				+ restored.changed_assignment_count
				+ restored.removed_assignment_count,
			1
		);
		let restoration_changes = database.assignment_changes(None).unwrap();
		assert_eq!(restoration_changes.len(), 1);
		assert_eq!(restoration_changes[0].field, "removed_at");
		assert_eq!(
			restoration_changes[0].old_value.as_deref(),
			Some(removed.synced_at.as_str())
		);
		assert_eq!(restoration_changes[0].new_value, None);
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

	#[test]
	fn course_snapshot_uses_stable_moodle_ids_and_does_not_remove_other_courses() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute_batch(
				"INSERT INTO courses (id, moodle_course_id, name) VALUES
					(1, 'course-1', 'データベース'),
					(2, 'course-2', '離散数学');
				 INSERT INTO assignments (
					id, course_id, moodle_assignment_id, title, source, due_at,
					due_at_status, submission_mode, submitted
				 ) VALUES
					(10, 1, 'cm-10', '正規化レポート', 'moodle_dashboard',
					 '2026-07-20T09:00:00+09:00', 'normal', 'moodle_auto', 0),
					(20, 2, 'cm-20', 'グラフ理論課題', 'moodle_dashboard',
					 '2026-07-21T09:00:00+09:00', 'normal', 'moodle_auto', 0);",
			)
			.unwrap();

		let event = database
			.sync_moodle_assignments(
				"auto",
				1,
				&[moodle_assignment(
					"cm-10",
					"第3正規形レポート",
					Some("2026-07-22T09:00:00+09:00"),
				)],
			)
			.unwrap();
		assert_eq!(event.new_assignment_count, 0);
		assert_eq!(event.changed_assignment_count, 1);
		assert_eq!(event.removed_assignment_count, 0);

		let course_two_removed_at: Option<String> = database
			.conn()
			.query_row(
				"SELECT removed_at FROM assignments WHERE id = 20",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(course_two_removed_at, None);
		let updated_id: i64 = database
			.conn()
			.query_row(
				"SELECT id FROM assignments
				 WHERE course_id = 1 AND moodle_assignment_id = 'cm-10'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(updated_id, 10);
	}

	#[test]
	fn course_snapshot_soft_removes_and_reactivates_the_same_internal_assignment() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO courses (id, moodle_course_id, name)
				 VALUES (1, 'course-1', '認知科学概論')",
				[],
			)
			.unwrap();
		let assignment =
			moodle_assignment("cm-501", "期末レポート", Some("2026-07-30T23:59:00+09:00"));
		let first = database
			.sync_moodle_assignments("auto", 1, std::slice::from_ref(&assignment))
			.unwrap();
		assert_eq!(first.new_assignment_count, 1);
		let internal_id: i64 = database
			.conn()
			.query_row(
				"SELECT id FROM assignments WHERE moodle_assignment_id = 'cm-501'",
				[],
				|row| row.get(0),
			)
			.unwrap();

		let removed = database.sync_moodle_assignments("auto", 1, &[]).unwrap();
		assert_eq!(
			(
				removed.new_assignment_count,
				removed.changed_assignment_count,
				removed.removed_assignment_count
			),
			(0, 0, 1)
		);
		let removal_changes = database.assignment_changes(None).unwrap();
		assert_eq!(removal_changes.len(), 1);
		assert_eq!(removal_changes[0].field, "removed_at");
		assert_eq!(removal_changes[0].old_value, None);
		assert_eq!(
			removal_changes[0].new_value.as_deref(),
			Some(removed.synced_at.as_str())
		);
		let restored = database
			.sync_moodle_assignments("auto", 1, &[assignment])
			.unwrap();
		assert_eq!(
			(
				restored.new_assignment_count,
				restored.changed_assignment_count,
				restored.removed_assignment_count
			),
			(1, 0, 0)
		);
		let restoration_changes = database.assignment_changes(None).unwrap();
		assert_eq!(restoration_changes.len(), 1);
		assert_eq!(restoration_changes[0].field, "removed_at");
		assert_eq!(
			restoration_changes[0].old_value.as_deref(),
			Some(removed.synced_at.as_str())
		);
		assert_eq!(restoration_changes[0].new_value, None);
		let restored_id: i64 = database
			.conn()
			.query_row(
				"SELECT id FROM assignments WHERE moodle_assignment_id = 'cm-501'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(restored_id, internal_id);
	}

	#[test]
	fn course_snapshot_persists_and_tracks_submission_availability_and_moodle_url() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO courses (id, moodle_course_id, name)
				 VALUES (1, 'course-1', 'データベース')",
				[],
			)
			.unwrap();
		let mut assignment =
			moodle_assignment("701", "正規化レポート", Some("2026-07-30T23:59:00+09:00"));
		assignment.submission_availability = "available".to_string();
		database
			.sync_moodle_assignments("auto", 1, std::slice::from_ref(&assignment))
			.unwrap();

		let deadline = database.deadlines(Default::default()).unwrap().remove(0);
		assert_eq!(deadline.submission_availability, "available");
		assert_eq!(deadline.moodle_url, assignment.moodle_url);

		assignment.submission_availability = "unavailable".to_string();
		assignment.moodle_url =
			Some("https://moodle2026.wakayama-u.ac.jp/mod/quiz/view.php?id=701".to_string());
		let event = database
			.sync_moodle_assignments("auto", 1, &[assignment])
			.unwrap();
		assert_eq!(event.changed_assignment_count, 1);
		assert_eq!(
			database
				.assignment_changes(None)
				.unwrap()
				.into_iter()
				.map(|change| change.field)
				.collect::<Vec<_>>(),
			vec!["submission_availability", "moodle_url"]
		);
	}

	#[test]
	fn course_snapshot_rejects_missing_identity_and_offsetless_due_at_atomically() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO courses (id, moodle_course_id, name)
				 VALUES (1, 'course-1', '英語IIB')",
				[],
			)
			.unwrap();

		let missing_id = moodle_assignment("", "Presentation", Some("2026-07-30T09:00:00+09:00"));
		assert!(database
			.sync_moodle_assignments("auto", 1, &[missing_id])
			.is_err());
		let offsetless =
			moodle_assignment("cm-english", "Presentation", Some("2026-07-30T09:00:00"));
		assert!(database
			.sync_moodle_assignments("auto", 1, &[offsetless])
			.is_err());
		assert!(database.latest_sync_event().unwrap().is_none());
	}

	#[test]
	fn course_snapshot_rejects_external_moodle_url_atomically() {
		let mut database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO courses (id, moodle_course_id, name)
				 VALUES (1, 'course-1', '英語IIB')",
				[],
			)
			.unwrap();
		let mut assignment = moodle_assignment(
			"cm-english",
			"Presentation",
			Some("2026-07-30T09:00:00+09:00"),
		);
		assignment.moodle_url =
			Some("https://example.com/mod/assign/view.php?id=cm-english".to_string());

		assert!(database
			.sync_moodle_assignments("auto", 1, &[assignment])
			.is_err());
		assert!(database.latest_sync_event().unwrap().is_none());
	}

	#[test]
	fn explicit_iso_timestamp_validates_calendar_days_and_leap_years() {
		assert!(has_explicit_iso_offset("2028-02-29T23:59:00+09:00"));
		assert!(has_explicit_iso_offset("2026-07-31T14:59:00Z"));
		assert!(!has_explicit_iso_offset("2026-02-29T23:59:00+09:00"));
		assert!(!has_explicit_iso_offset("2026-02-31T23:59:00+09:00"));
		assert!(!has_explicit_iso_offset("2026-04-31T23:59:00+09:00"));
	}
}
