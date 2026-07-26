//! 保存ルートの明示再スキャンで使う、コースとファイルメタデータの冪等更新。

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use super::{db_err, Database};
use crate::types::SavedFileRegistration;
use crate::{EngineError, EngineResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScannedFileUpsertResult {
	pub file_id: i64,
	pub inserted: bool,
	pub updated: bool,
	pub needs_index: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SavedFileUpsertMode {
	Scan,
	Extracted,
}

type CourseRuleOverrideState = (i64, Option<String>, Option<String>);
const LOCAL_SCAN_PREFIX: &str = "local-scan:";
const CONTEXTUAL_LOCAL_SCAN_PREFIX: &str = "local-scan:v2:";

#[derive(Debug, Clone, PartialEq, Eq)]
struct CourseIdentityRecord {
	id: i64,
	stable_id: String,
	academic_year: Option<i64>,
	term: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContextRelation {
	Match,
	Unknown,
	Different,
}

impl Database {
	/// ローカル走査だけで判明したコース名を、名称由来の安定IDで冪等登録する。
	pub fn ensure_local_scan_course(&mut self, name: &str) -> EngineResult<i64> {
		let name = validate_course_name(name)?;
		let digest = blake3::hash(name.as_bytes()).to_hex().to_string();
		let moodle_course_id = format!("{LOCAL_SCAN_PREFIX}{}", &digest[..24]);
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let real_course_ids = course_ids_by_name(&transaction, name, false)?;
		let local_course_ids = course_ids_by_name(&transaction, name, true)?;
		if let [real_course_id] = real_course_ids.as_slice() {
			match local_course_ids.as_slice() {
				[] => {}
				[local_course_id] => {
					merge_local_course_into(&transaction, *local_course_id, *real_course_id)?;
				}
				_ => {
					return Err(EngineError::RuleConflict {
						reason:
							"同名のローカル走査コースが複数あるためMoodleコースへ統合できません"
								.to_string(),
					});
				}
			}
			transaction.commit().map_err(db_err)?;
			return Ok(*real_course_id);
		}
		transaction
			.execute(
				"INSERT INTO courses (moodle_course_id, name)
				 VALUES (?1, ?2)
				 ON CONFLICT(moodle_course_id) DO UPDATE SET
					name = excluded.name,
					updated_at = datetime('now')",
				params![moodle_course_id, name],
			)
			.map_err(db_err)?;
		let course_id = transaction
			.query_row(
				"SELECT id FROM courses WHERE moodle_course_id = ?1",
				[moodle_course_id],
				|row| row.get(0),
			)
			.map_err(db_err)?;
		transaction.commit().map_err(db_err)?;
		Ok(course_id)
	}

	/// 保存ルートからコース位置までの相対文脈を含むローカルコースを冪等登録する。
	///
	/// 同名科目が年度など別の親フォルダーにある場合も別IDとなる。実Moodleコースは、
	/// 走査から安全に得られた年度・学期と一致する候補が一意な場合だけ再利用する。
	pub fn ensure_contextual_local_scan_course(
		&mut self,
		name: &str,
		relative_course_context: &str,
		academic_year: Option<i64>,
		term: Option<&str>,
		allow_legacy_upgrade: bool,
	) -> EngineResult<i64> {
		let name = validate_course_name(name)?;
		let context = relative_course_context.trim();
		if context.is_empty() || context.len() > 4096 {
			return Err(EngineError::InvalidInput {
				field: "courseContext".to_string(),
				reason: "保存ルートからのコース位置を4096文字以内で指定してください".to_string(),
			});
		}
		if academic_year.is_some_and(|year| !(1900..=9999).contains(&year)) {
			return Err(EngineError::InvalidInput {
				field: "academicYear".to_string(),
				reason: "1900から9999の範囲で指定してください".to_string(),
			});
		}
		let term = term.map(str::trim).filter(|value| !value.is_empty());
		let digest = blake3::hash(format!("course-context\0{context}").as_bytes())
			.to_hex()
			.to_string();
		let contextual_stable_id = format!("{CONTEXTUAL_LOCAL_SCAN_PREFIX}{}", &digest[..24]);
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;

		let exact_local = transaction
			.query_row(
				"SELECT id FROM courses WHERE moodle_course_id = ?1",
				[contextual_stable_id.as_str()],
				|row| row.get::<_, i64>(0),
			)
			.optional()
			.map_err(db_err)?;
		let real_matches = matching_real_courses(&transaction, name, academic_year, term)?;
		match real_matches.as_slice() {
			[real_course_id] => {
				if let Some(local_course_id) = exact_local {
					merge_local_course_into(&transaction, local_course_id, *real_course_id)?;
				} else if allow_legacy_upgrade {
					let legacy = legacy_local_courses_by_name(&transaction, name)?;
					if let [legacy_course] = legacy.as_slice() {
						merge_local_course_into(&transaction, legacy_course.id, *real_course_id)?;
					} else if legacy.len() > 1 {
						return Err(ambiguous_local_course());
					}
				}
				transaction.commit().map_err(db_err)?;
				return Ok(*real_course_id);
			}
			[] => {}
			_ => {
				return Err(EngineError::RuleConflict {
					reason: "同名かつ同じ年度・学期のMoodleコースが複数あるため自動統合できません"
						.to_string(),
				});
			}
		}

		if let Some(course_id) = exact_local {
			transaction.commit().map_err(db_err)?;
			return Ok(course_id);
		}
		if allow_legacy_upgrade {
			let legacy = legacy_local_courses_by_name(&transaction, name)?;
			match legacy.as_slice() {
				[legacy_course] => {
					transaction
						.execute(
							"UPDATE courses
							 SET moodle_course_id = ?1,
							     academic_year = COALESCE(academic_year, ?2),
							     term = COALESCE(term, ?3),
							     updated_at = datetime('now')
							 WHERE id = ?4",
							params![contextual_stable_id, academic_year, term, legacy_course.id],
						)
						.map_err(db_err)?;
					transaction.commit().map_err(db_err)?;
					return Ok(legacy_course.id);
				}
				[] => {}
				_ => return Err(ambiguous_local_course()),
			}
		}

		transaction
			.execute(
				"INSERT INTO courses (moodle_course_id, name, academic_year, term)
				 VALUES (?1, ?2, ?3, ?4)",
				params![contextual_stable_id, name, academic_year, term],
			)
			.map_err(db_err)?;
		let course_id = transaction.last_insert_rowid();
		transaction.commit().map_err(db_err)?;
		Ok(course_id)
	}

	/// 実在する走査済みファイルをsaved_path単位で登録または更新する。
	///
	/// Moodle由来の既存course_idは上書きせず、未紐付けの場合だけローカル走査の
	/// コースへ補完する。本文が変わった場合は古い検索メタ情報を同じtransactionで
	/// 無効化し、再索引失敗時に古い検索結果を公開しない。
	pub fn upsert_scanned_file(
		&mut self,
		file: &SavedFileRegistration,
	) -> EngineResult<ScannedFileUpsertResult> {
		validate_file_registration(file)?;
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let result = upsert_file_in_transaction(&transaction, file, SavedFileUpsertMode::Scan)?;
		transaction.commit().map_err(db_err)?;
		Ok(result)
	}

	/// 明示的なライブラリ走査の完了時刻を保存する。
	pub fn mark_library_scan_completed(&self) -> EngineResult<()> {
		self.conn
			.execute(
				"INSERT INTO app_settings (key, value)
				 VALUES ('last_library_scan_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				[],
			)
			.map_err(db_err)?;
		Ok(())
	}
}

pub(super) fn validate_file_registration(file: &SavedFileRegistration) -> EngineResult<()> {
	if !file.saved_path.is_absolute() {
		return Err(EngineError::InvalidPath {
			path: file.saved_path.display().to_string(),
			reason: "絶対パスを指定してください".to_string(),
		});
	}
	if file.original_name.trim().is_empty() {
		return Err(EngineError::InvalidInput {
			field: "originalName".to_string(),
			reason: "ファイル名を指定してください".to_string(),
		});
	}
	if file.size_bytes < 0 {
		return Err(EngineError::InvalidInput {
			field: "sizeBytes".to_string(),
			reason: "0以上のファイルサイズを指定してください".to_string(),
		});
	}
	if file.hash_blake3.trim().is_empty() {
		return Err(EngineError::InvalidInput {
			field: "hashBlake3".to_string(),
			reason: "BLAKE3フィンガープリントを指定してください".to_string(),
		});
	}
	Ok(())
}

/// 走査とZIP展開で共有する、1つのtransaction内でのファイルupsert。
///
/// 走査は実Moodleコースの紐付けを保護する。ZIP展開は展開元のコースと
/// 子ごとのセクションを優先し、MoodleファイルIDと古い索引メタ情報を引き継がない。
pub(super) fn upsert_file_in_transaction(
	transaction: &Transaction<'_>,
	file: &SavedFileRegistration,
	mode: SavedFileUpsertMode,
) -> EngineResult<ScannedFileUpsertResult> {
	validate_file_registration(file)?;
	let existing = transaction
		.query_row(
			"SELECT f.id, f.course_id, f.section_no, f.moodle_file_id,
			        f.original_name, f.size_bytes, f.mime_type, f.hash_blake3, f.simhash,
			        EXISTS(SELECT 1 FROM search_index_meta sim WHERE sim.file_id = f.id),
			        f.missing_at IS NOT NULL,
			        c.moodle_course_id
			 FROM files f
			 LEFT JOIN courses c ON c.id = f.course_id
			 WHERE f.saved_path = ?1 COLLATE NOCASE",
			[file.saved_path.to_string_lossy().as_ref()],
			|row| {
				Ok((
					row.get::<_, i64>(0)?,
					row.get::<_, Option<i64>>(1)?,
					row.get::<_, Option<i64>>(2)?,
					row.get::<_, Option<String>>(3)?,
					row.get::<_, String>(4)?,
					row.get::<_, i64>(5)?,
					row.get::<_, Option<String>>(6)?,
					row.get::<_, String>(7)?,
					row.get::<_, Option<i64>>(8)?,
					row.get::<_, bool>(9)?,
					row.get::<_, bool>(10)?,
					row.get::<_, Option<String>>(11)?,
				))
			},
		)
		.optional()
		.map_err(db_err)?;

	if let Some((
		file_id,
		current_course_id,
		current_section_no,
		current_moodle_file_id,
		current_name,
		current_size,
		current_mime,
		current_hash,
		current_simhash,
		was_indexed,
		was_missing,
		current_stable_id,
	)) = existing
	{
		let course_id = match mode {
			SavedFileUpsertMode::Scan => match (
				current_course_id,
				current_stable_id.as_deref(),
				file.course_id,
			) {
				(Some(current), Some(stable_id), Some(scanned))
					if stable_id.starts_with(LOCAL_SCAN_PREFIX) && current != scanned =>
				{
					Some(scanned)
				}
				_ => current_course_id.or(file.course_id),
			},
			SavedFileUpsertMode::Extracted => file.course_id,
		};
		let section_no = match mode {
			SavedFileUpsertMode::Scan => current_section_no.or(file.section_no),
			SavedFileUpsertMode::Extracted => file.section_no,
		};
		let moodle_file_id = match mode {
			SavedFileUpsertMode::Scan => current_moodle_file_id.clone(),
			SavedFileUpsertMode::Extracted => None,
		};
		let stored_simhash = file.simhash as i64;
		let content_changed = current_size != file.size_bytes
			|| current_hash != file.hash_blake3
			|| current_simhash != Some(stored_simhash);
		let updated = content_changed
			|| current_course_id != course_id
			|| current_section_no != section_no
			|| current_moodle_file_id != moodle_file_id
			|| current_name != file.original_name
			|| current_mime != file.mime_type
			|| was_missing;
		if updated {
			transaction
				.execute(
					"UPDATE files
					 SET course_id = ?1, section_no = ?2, moodle_file_id = ?3,
					     original_name = ?4, size_bytes = ?5, mime_type = ?6,
					     hash_blake3 = ?7, simhash = ?8, missing_at = NULL
					 WHERE id = ?9",
					params![
						course_id,
						section_no,
						moodle_file_id,
						file.original_name,
						file.size_bytes,
						file.mime_type,
						file.hash_blake3,
						stored_simhash,
						file_id
					],
				)
				.map_err(db_err)?;
		}
		let invalidate_index = content_changed || matches!(mode, SavedFileUpsertMode::Extracted);
		if invalidate_index {
			transaction
				.execute(
					"DELETE FROM search_index_meta WHERE file_id = ?1",
					[file_id],
				)
				.map_err(db_err)?;
		}
		Ok(ScannedFileUpsertResult {
			file_id,
			inserted: false,
			updated,
			needs_index: invalidate_index || !was_indexed || was_missing,
		})
	} else {
		let moodle_file_id: Option<&str> = None;
		transaction
			.execute(
				"INSERT INTO files (
					course_id, section_no, moodle_file_id, original_name, saved_path,
					size_bytes, mime_type, hash_blake3, simhash
				 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
				params![
					file.course_id,
					file.section_no,
					moodle_file_id,
					file.original_name,
					file.saved_path.to_string_lossy(),
					file.size_bytes,
					file.mime_type,
					file.hash_blake3,
					file.simhash as i64,
				],
			)
			.map_err(db_err)?;
		Ok(ScannedFileUpsertResult {
			file_id: transaction.last_insert_rowid(),
			inserted: true,
			updated: false,
			needs_index: true,
		})
	}
}

pub(super) fn matching_local_course_for_moodle(
	transaction: &Transaction<'_>,
	name: &str,
	academic_year: Option<i64>,
	term: Option<&str>,
	target_real_course_id: Option<i64>,
) -> EngineResult<Option<i64>> {
	let local_courses = local_courses_by_name(transaction, name)?;
	let exact_matches = local_courses
		.iter()
		.filter(|course| context_relation(course, academic_year, term) == ContextRelation::Match)
		.map(|course| course.id)
		.collect::<Vec<_>>();
	match exact_matches.as_slice() {
		[course_id] => return Ok(Some(*course_id)),
		[] => {}
		_ => return Err(ambiguous_local_course()),
	}

	let unknown_matches = local_courses
		.iter()
		.filter(|course| context_relation(course, academic_year, term) == ContextRelation::Unknown)
		.map(|course| course.id)
		.collect::<Vec<_>>();
	if unknown_matches.is_empty() {
		return Ok(None);
	}
	let other_real_count: i64 = transaction
		.query_row(
			"SELECT count(*)
			 FROM courses
			 WHERE name = ?1
			   AND moodle_course_id NOT GLOB 'local-scan:*'
			   AND (?2 IS NULL OR id <> ?2)",
			params![name, target_real_course_id],
			|row| row.get(0),
		)
		.map_err(db_err)?;
	if local_courses.len() == 1 && unknown_matches.len() == 1 && other_real_count == 0 {
		return Ok(unknown_matches.first().copied());
	}
	Err(ambiguous_local_course())
}

/// 旧版で分断されたローカル走査コースを実Moodleコースへ統合する。
///
/// 資料ファイル自体には触れず、参照先の外部キーだけを同一transactionで付け替える。
/// 両側に異なる明示設定や同一Moodle課題がある場合は、利用者データを捨てずに
/// transaction全体を拒否する。
pub(super) fn merge_local_course_into(
	transaction: &Transaction<'_>,
	local_course_id: i64,
	moodle_course_id: i64,
) -> EngineResult<()> {
	if local_course_id == moodle_course_id {
		return Ok(());
	}
	let (local_stable_id, local_folder_override, local_year, local_term) = transaction
		.query_row(
			"SELECT moodle_course_id, folder_name_override, academic_year, term
			 FROM courses
			 WHERE id = ?1",
			[local_course_id],
			|row| {
				Ok((
					row.get::<_, String>(0)?,
					row.get::<_, Option<String>>(1)?,
					row.get::<_, Option<i64>>(2)?,
					row.get::<_, Option<String>>(3)?,
				))
			},
		)
		.map_err(db_err)?;
	if !local_stable_id.starts_with("local-scan:") {
		return Err(EngineError::Database {
			message: "ローカル走査コース以外を自動統合しようとしました".to_string(),
		});
	}
	let (target_stable_id, target_folder_override): (String, Option<String>) = transaction
		.query_row(
			"SELECT moodle_course_id, folder_name_override
			 FROM courses
			 WHERE id = ?1",
			[moodle_course_id],
			|row| Ok((row.get(0)?, row.get(1)?)),
		)
		.map_err(db_err)?;
	if target_stable_id.starts_with("local-scan:") {
		return Err(EngineError::Database {
			message: "統合先に実Moodleコースが指定されていません".to_string(),
		});
	}
	if local_folder_override.is_some()
		&& target_folder_override.is_some()
		&& local_folder_override != target_folder_override
	{
		return Err(EngineError::RuleConflict {
			reason: "同一コースに異なる保存フォルダ名の編集があるため自動統合できません"
				.to_string(),
		});
	}

	let local_rule = course_rule_override(transaction, local_course_id)?;
	let target_rule = course_rule_override(transaction, moodle_course_id)?;
	match (&local_rule, &target_rule) {
		(Some(local), Some(target)) if local != target => {
			return Err(EngineError::RuleConflict {
				reason: "同一コースに異なるコース別ルールがあるため自動統合できません".to_string(),
			});
		}
		(Some(_), None) => {
			transaction
				.execute(
					"UPDATE course_rule_overrides SET course_id = ?1 WHERE course_id = ?2",
					params![moodle_course_id, local_course_id],
				)
				.map_err(db_err)?;
		}
		(Some(_), Some(_)) => {
			transaction
				.execute(
					"DELETE FROM course_rule_overrides WHERE course_id = ?1",
					[local_course_id],
				)
				.map_err(db_err)?;
		}
		(None, _) => {}
	}

	let assignment_collision_count: i64 = transaction
		.query_row(
			"SELECT count(*)
			 FROM assignments local
			 JOIN assignments target
			   ON target.course_id = ?1
			  AND target.moodle_assignment_id = local.moodle_assignment_id
			 WHERE local.course_id = ?2
			   AND local.moodle_assignment_id IS NOT NULL",
			params![moodle_course_id, local_course_id],
			|row| row.get(0),
		)
		.map_err(db_err)?;
	if assignment_collision_count > 0 {
		return Err(EngineError::RuleConflict {
			reason: "同一Moodle課題の履歴が両方のコースにあるため自動統合できません".to_string(),
		});
	}

	transaction
		.execute(
			"UPDATE files SET course_id = ?1 WHERE course_id = ?2",
			params![moodle_course_id, local_course_id],
		)
		.map_err(db_err)?;
	transaction
		.execute(
			"UPDATE assignments SET course_id = ?1 WHERE course_id = ?2",
			params![moodle_course_id, local_course_id],
		)
		.map_err(db_err)?;
	transaction
		.execute(
			"UPDATE courses
			 SET academic_year = COALESCE(academic_year, ?1),
			     term = COALESCE(term, ?2),
			     folder_name_override = COALESCE(folder_name_override, ?3),
			     updated_at = datetime('now')
			 WHERE id = ?4",
			params![
				local_year,
				local_term,
				local_folder_override,
				moodle_course_id
			],
		)
		.map_err(db_err)?;
	let deleted = transaction
		.execute("DELETE FROM courses WHERE id = ?1", [local_course_id])
		.map_err(db_err)?;
	if deleted != 1 {
		return Err(EngineError::Database {
			message: "ローカル走査コースを統合できませんでした".to_string(),
		});
	}
	Ok(())
}

fn course_ids_by_name(
	transaction: &Transaction<'_>,
	name: &str,
	local: bool,
) -> EngineResult<Vec<i64>> {
	let comparison = if local {
		"moodle_course_id GLOB 'local-scan:*'"
	} else {
		"moodle_course_id NOT GLOB 'local-scan:*'"
	};
	let mut statement = transaction
		.prepare(&format!(
			"SELECT id FROM courses WHERE name = ?1 AND {comparison} ORDER BY id"
		))
		.map_err(db_err)?;
	let course_ids = statement
		.query_map([name], |row| row.get::<_, i64>(0))
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	Ok(course_ids)
}

fn validate_course_name(name: &str) -> EngineResult<&str> {
	let name = name.trim();
	if name.is_empty() || name.len() > 512 {
		return Err(EngineError::InvalidInput {
			field: "courseName".to_string(),
			reason: "1文字以上512文字以内で指定してください".to_string(),
		});
	}
	Ok(name)
}

fn matching_real_courses(
	transaction: &Transaction<'_>,
	name: &str,
	academic_year: Option<i64>,
	term: Option<&str>,
) -> EngineResult<Vec<i64>> {
	let real_courses = course_identity_records(transaction, name, false)?;
	let exact = real_courses
		.iter()
		.filter(|course| context_relation(course, academic_year, term) == ContextRelation::Match)
		.map(|course| course.id)
		.collect::<Vec<_>>();
	if !exact.is_empty() {
		return Ok(exact);
	}
	if academic_year.is_none() && term.is_none() && real_courses.len() == 1 {
		return Ok(vec![real_courses[0].id]);
	}
	Ok(Vec::new())
}

fn local_courses_by_name(
	transaction: &Transaction<'_>,
	name: &str,
) -> EngineResult<Vec<CourseIdentityRecord>> {
	course_identity_records(transaction, name, true)
}

fn legacy_local_courses_by_name(
	transaction: &Transaction<'_>,
	name: &str,
) -> EngineResult<Vec<CourseIdentityRecord>> {
	Ok(local_courses_by_name(transaction, name)?
		.into_iter()
		.filter(|course| !course.stable_id.starts_with(CONTEXTUAL_LOCAL_SCAN_PREFIX))
		.collect())
}

fn course_identity_records(
	transaction: &Transaction<'_>,
	name: &str,
	local: bool,
) -> EngineResult<Vec<CourseIdentityRecord>> {
	let comparison = if local {
		"moodle_course_id GLOB 'local-scan:*'"
	} else {
		"moodle_course_id NOT GLOB 'local-scan:*'"
	};
	let mut statement = transaction
		.prepare(&format!(
			"SELECT id, moodle_course_id, academic_year, term
			 FROM courses
			 WHERE name = ?1 AND {comparison}
			 ORDER BY id"
		))
		.map_err(db_err)?;
	let records = statement
		.query_map([name], |row| {
			Ok(CourseIdentityRecord {
				id: row.get(0)?,
				stable_id: row.get(1)?,
				academic_year: row.get(2)?,
				term: row.get(3)?,
			})
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	Ok(records)
}

fn context_relation(
	course: &CourseIdentityRecord,
	academic_year: Option<i64>,
	term: Option<&str>,
) -> ContextRelation {
	let mut unknown = false;
	match (course.academic_year, academic_year) {
		(Some(left), Some(right)) if left != right => return ContextRelation::Different,
		(Some(_), None) | (None, Some(_)) => unknown = true,
		_ => {}
	}
	match (course.term.as_deref(), term) {
		(Some(left), Some(right)) if left != right => return ContextRelation::Different,
		(Some(_), None) | (None, Some(_)) => unknown = true,
		_ => {}
	}
	if unknown {
		ContextRelation::Unknown
	} else {
		ContextRelation::Match
	}
}

fn ambiguous_local_course() -> EngineError {
	EngineError::RuleConflict {
		reason: "同名ローカルコースの年度・学期を一意に対応付けられないため自動統合できません"
			.to_string(),
	}
}

fn course_rule_override(
	transaction: &Transaction<'_>,
	course_id: i64,
) -> EngineResult<Option<CourseRuleOverrideState>> {
	transaction
		.query_row(
			"SELECT split_by_section, pattern_template, note
			 FROM course_rule_overrides
			 WHERE course_id = ?1",
			[course_id],
			|row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
		)
		.optional()
		.map_err(db_err)
}
