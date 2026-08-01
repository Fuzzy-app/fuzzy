//! 初期セットアップで確定した保存ルートとグローバルルールの永続化。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use std::collections::BTreeSet;

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::library::saved_path_key;
use super::rules::apply_rule_compliance;
use super::{db_err, Database};
use crate::rule::{validate_rule_set, DefaultRuleEngine};
use crate::types::RuleSet;
use crate::{EngineError, EngineResult};

const BASE_FOLDER_SETTING: &str = "base_folder_path";
const SCAN_PATTERN_SETTING: &str = "initial_scan_pattern_id";
const SCAN_COURSE_SEGMENT_SETTING: &str = "initial_scan_course_segment_index";
const COURSE_OVERRIDES_SETTING: &str = "initial_course_overrides";
const SETUP_SAVED_AT_SETTING: &str = "initial_setup_saved_at";
const MAX_SETTING_VALUE_BYTES: usize = 16 * 1024;
const MAX_COURSE_SEGMENT_INDEX: usize = 64;
const MAX_INITIAL_COURSE_OVERRIDES: usize = 32;
const INITIAL_COURSE_OVERRIDE_PATTERN: &str = "{course}/{assignment}";
const INITIAL_COURSE_OVERRIDE_NOTE: &str = "初期セットアップで選択した例外";

impl Database {
	/// 保存先・推定結果・グローバルルールを1トランザクションで確定する。
	///
	/// 保存済みファイルの移動や削除は行わず、選択済みフォルダーを正規化して
	/// SQLiteへ記録するだけに留める。
	pub fn save_initial_setup(
		&mut self,
		base_folder: &Path,
		rule_key: &str,
		rule_template: &str,
		scan_pattern_id: &str,
		course_segment_index: Option<usize>,
		course_overrides_json: &str,
	) -> EngineResult<String> {
		let base_folder = validate_base_folder(base_folder)?;
		validate_identifier("ruleKey", rule_key)?;
		validate_identifier("scanPatternId", scan_pattern_id)?;
		if course_segment_index.is_some_and(|index| index > MAX_COURSE_SEGMENT_INDEX) {
			return Err(EngineError::InvalidInput {
				field: "pattern.courseSegmentIndex".to_string(),
				reason: format!("0から{MAX_COURSE_SEGMENT_INDEX}の範囲で指定してください"),
			});
		}
		if course_overrides_json.len() > MAX_SETTING_VALUE_BYTES {
			return Err(EngineError::InvalidInput {
				field: "courseOverrides".to_string(),
				reason: "保存できる上限を超えています".to_string(),
			});
		}

		let rule_template = rule_template.trim();
		validate_rule_set(&RuleSet {
			global_pattern_template: rule_template.to_string(),
			course_overrides: Vec::new(),
		})?;

		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		transaction
			.execute(
				"INSERT INTO global_rule (id, pattern_key, pattern_template, updated_at)
				 VALUES (1, ?1, ?2, datetime('now'))
				 ON CONFLICT(id) DO UPDATE SET
					pattern_key = excluded.pattern_key,
					pattern_template = excluded.pattern_template,
					updated_at = excluded.updated_at",
				params![rule_key, rule_template],
			)
			.map_err(db_err)?;
		upsert_setting(
			&transaction,
			BASE_FOLDER_SETTING,
			&base_folder.to_string_lossy(),
		)?;
		upsert_setting(&transaction, SCAN_PATTERN_SETTING, scan_pattern_id)?;
		if let Some(index) = course_segment_index {
			upsert_setting(
				&transaction,
				SCAN_COURSE_SEGMENT_SETTING,
				&index.to_string(),
			)?;
		} else {
			transaction
				.execute(
					"DELETE FROM app_settings WHERE key = ?1",
					[SCAN_COURSE_SEGMENT_SETTING],
				)
				.map_err(db_err)?;
		}
		upsert_setting(
			&transaction,
			COURSE_OVERRIDES_SETTING,
			course_overrides_json,
		)?;
		transaction
			.execute(
				"INSERT INTO app_settings (key, value)
				 VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				[SETUP_SAVED_AT_SETTING],
			)
			.map_err(db_err)?;
		let saved_at = transaction
			.query_row(
				"SELECT value FROM app_settings WHERE key = ?1",
				[SETUP_SAVED_AT_SETTING],
				|row| row.get(0),
			)
			.map_err(db_err)?;
		transaction.commit().map_err(db_err)?;
		Ok(saved_at)
	}

	/// 初期セットアップで選んだパターンにおける、保存ルート直下からの科目位置。
	///
	/// 科目セグメントを持たないパターンでは`None`を返す。
	pub fn initial_scan_course_segment_index(&self) -> EngineResult<Option<usize>> {
		let stored = self
			.conn
			.query_row(
				"SELECT value FROM app_settings WHERE key = ?1",
				[SCAN_COURSE_SEGMENT_SETTING],
				|row| row.get::<_, String>(0),
			)
			.optional()
			.map_err(db_err)?;
		stored
			.map(|value| {
				value.parse::<usize>().map_err(|_| EngineError::Database {
					message: "初期セットアップの科目セグメント位置が不正です".to_string(),
				})
			})
			.transpose()
	}

	/// 初期セットアップで明示されたコースだけに、短い保存ルールを反映する。
	///
	/// この処理が作成した行だけを専用noteで管理し、ルール画面などで作成された既存の
	/// コース別例外は上書き・削除しない。同じ選択を再保存しても行を増やさず、
	/// 選択解除された初期例外だけを取り除く。
	pub fn synchronize_initial_course_overrides(
		&mut self,
		course_names: &[String],
	) -> EngineResult<()> {
		if course_names.len() > MAX_INITIAL_COURSE_OVERRIDES {
			return Err(EngineError::InvalidInput {
				field: "courseOverrides".to_string(),
				reason: format!("{MAX_INITIAL_COURSE_OVERRIDES}件以内で指定してください"),
			});
		}

		let mut normalized_names = BTreeSet::new();
		for course_name in course_names {
			let course_name = course_name.trim();
			if course_name.is_empty() || course_name.len() > 512 {
				return Err(EngineError::InvalidInput {
					field: "courseOverrides.courseName".to_string(),
					reason: "1文字以上512文字以内で指定してください".to_string(),
				});
			}
			normalized_names.insert(course_name.to_string());
		}

		let base_folder = self.base_folder_path()?;
		let mut selected_course_ids = BTreeSet::new();
		for course_name in normalized_names {
			let active_course_ids =
				active_course_ids_in_base(&self.conn, &base_folder, &course_name)?;
			if !active_course_ids.is_empty() {
				// 画面の候補はコース名単位なので、同名科目が年度別に複数見つかった場合は、
				// 現在の保存ルートで実際に走査された全候補へ同じ選択を適用する。
				selected_course_ids.extend(active_course_ids);
				continue;
			}

			let existing_course_ids = course_ids_by_name(&self.conn, &course_name)?;
			match existing_course_ids.as_slice() {
				[course_id] => {
					selected_course_ids.insert(*course_id);
				}
				[] => {
					// 旧呼び出し順や空フォルダーにも対応するため、一意な従来IDを保持する。
					selected_course_ids.insert(self.ensure_local_scan_course(&course_name)?);
				}
				_ => {
					return Err(EngineError::RuleConflict {
						reason: format!(
							"「{course_name}」は年度・学期の異なる候補が複数あり、走査済み資料から対象を特定できません"
						),
					});
				}
			}
		}

		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let managed_course_ids = {
			let mut statement = transaction
				.prepare(
					"SELECT course_id
					 FROM course_rule_overrides
					 WHERE note = ?1",
				)
				.map_err(db_err)?;
			let course_ids = statement
				.query_map([INITIAL_COURSE_OVERRIDE_NOTE], |row| row.get::<_, i64>(0))
				.map_err(db_err)?
				.collect::<rusqlite::Result<Vec<_>>>()
				.map_err(db_err)?;
			course_ids
		};
		for course_id in managed_course_ids {
			if !selected_course_ids.contains(&course_id) {
				transaction
					.execute(
						"DELETE FROM course_rule_overrides
						 WHERE course_id = ?1 AND note = ?2",
						params![course_id, INITIAL_COURSE_OVERRIDE_NOTE],
					)
					.map_err(db_err)?;
			}
		}
		for course_id in selected_course_ids {
			transaction
				.execute(
					"INSERT INTO course_rule_overrides (
						course_id, split_by_section, pattern_template, note
					 ) VALUES (?1, 0, ?2, ?3)
					 ON CONFLICT(course_id) DO UPDATE SET
						split_by_section = excluded.split_by_section,
						pattern_template = excluded.pattern_template,
						note = excluded.note
					 WHERE course_rule_overrides.note = excluded.note",
					params![
						course_id,
						INITIAL_COURSE_OVERRIDE_PATTERN,
						INITIAL_COURSE_OVERRIDE_NOTE
					],
				)
				.map_err(db_err)?;
		}
		let has_active_files = transaction
			.query_row(
				"SELECT EXISTS(SELECT 1 FROM files WHERE missing_at IS NULL)",
				[],
				|row| row.get::<_, bool>(0),
			)
			.map_err(db_err)?;
		if has_active_files {
			apply_rule_compliance(&transaction, &DefaultRuleEngine)?;
		}
		transaction.commit().map_err(db_err)
	}

	/// 保存ルートだけを変更し、既存ルールを保ったままファイルメタデータのパスを付け替える。
	///
	/// 資料ファイル自体は移動・削除しない。旧ルート配下だった行は同じ相対パスで
	/// 新ルートへ付け替え、全行をいったん「実体未確認」にする。呼び出し側は続けて
	/// 再スキャンと全文索引再構築を行い、実在する行だけを通常表示へ戻す。
	pub fn relocate_base_folder(&mut self, new_base_folder: &Path) -> EngineResult<usize> {
		let new_base_folder = validate_base_folder(new_base_folder)?;
		let old_base_folder = self.base_folder_path()?;
		if old_base_folder == new_base_folder {
			return Ok(0);
		}

		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		let registered_paths = {
			let mut statement = transaction
				.prepare("SELECT id, saved_path FROM files ORDER BY id")
				.map_err(db_err)?;
			let paths = statement
				.query_map([], |row| {
					Ok((
						row.get::<_, i64>(0)?,
						PathBuf::from(row.get::<_, String>(1)?),
					))
				})
				.map_err(db_err)?
				.collect::<rusqlite::Result<Vec<_>>>()
				.map_err(db_err)?;
			paths
		};
		let mut rebased_file_count = 0usize;
		for (file_id, saved_path) in registered_paths {
			let Some(relative_path) = relative_path_within_base(&saved_path, &old_base_folder)
			else {
				continue;
			};
			if relative_path.components().any(|component| {
				matches!(
					component,
					Component::ParentDir | Component::RootDir | Component::Prefix(_)
				)
			}) {
				return Err(EngineError::InvalidPath {
					path: saved_path.display().to_string(),
					reason: "旧保存先からの相対パスを安全に引き継げません".to_string(),
				});
			}
			let relocated_path = new_base_folder.join(relative_path);
			let relocated_path = saved_path_key(&relocated_path);
			transaction
				.execute(
					"UPDATE files SET saved_path = ?1 WHERE id = ?2",
					params![relocated_path, file_id],
				)
				.map_err(db_err)?;
			rebased_file_count += 1;
		}
		transaction
			.execute(
				"UPDATE files
				 SET missing_at = COALESCE(
					 missing_at,
					 strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				 ),
				     rule_compliant = 1,
				     violation_reason = NULL",
				[],
			)
			.map_err(db_err)?;
		transaction
			.execute("DELETE FROM search_index_meta", [])
			.map_err(db_err)?;
		upsert_setting(
			&transaction,
			BASE_FOLDER_SETTING,
			&new_base_folder.to_string_lossy(),
		)?;
		transaction.commit().map_err(db_err)?;
		Ok(rebased_file_count)
	}

	/// 必要な設定が揃っている場合だけ、初期セットアップの保存日時を返す。
	pub fn initial_setup_saved_at(&self) -> EngineResult<Option<String>> {
		self.conn
			.query_row(
				"SELECT saved.value
				 FROM app_settings saved
				 WHERE saved.key = ?1
				   AND EXISTS (
						SELECT 1 FROM app_settings base
						WHERE base.key = ?2 AND trim(base.value) <> ''
				   )
				   AND EXISTS (
						SELECT 1 FROM global_rule
						WHERE id = 1 AND trim(pattern_template) <> ''
				   )",
				params![SETUP_SAVED_AT_SETTING, BASE_FOLDER_SETTING],
				|row| row.get(0),
			)
			.optional()
			.map_err(db_err)
	}
}

fn relative_path_within_base(path: &Path, base: &Path) -> Option<PathBuf> {
	path.strip_prefix(base)
		.ok()
		.map(Path::to_path_buf)
		.or_else(|| {
			path.canonicalize()
				.ok()?
				.strip_prefix(base)
				.ok()
				.map(Path::to_path_buf)
		})
}

fn active_course_ids_in_base(
	conn: &rusqlite::Connection,
	base_folder: &Path,
	course_name: &str,
) -> EngineResult<BTreeSet<i64>> {
	let base_folder = PathBuf::from(saved_path_key(base_folder));
	let mut statement = conn
		.prepare(
			"SELECT DISTINCT c.id, f.saved_path
			 FROM courses c
			 JOIN files f ON f.course_id = c.id
			 WHERE c.name = ?1
			   AND f.missing_at IS NULL
			 ORDER BY c.id",
		)
		.map_err(db_err)?;
	let records = statement
		.query_map([course_name], |row| {
			Ok((
				row.get::<_, i64>(0)?,
				PathBuf::from(row.get::<_, String>(1)?),
			))
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	Ok(records
		.into_iter()
		.filter(|(_, saved_path)| {
			PathBuf::from(saved_path_key(saved_path)).starts_with(&base_folder)
		})
		.map(|(course_id, _)| course_id)
		.collect())
}

fn course_ids_by_name(conn: &rusqlite::Connection, course_name: &str) -> EngineResult<Vec<i64>> {
	let mut statement = conn
		.prepare("SELECT id FROM courses WHERE name = ?1 ORDER BY id")
		.map_err(db_err)?;
	let course_ids = statement
		.query_map([course_name], |row| row.get::<_, i64>(0))
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	Ok(course_ids)
}

fn validate_base_folder(base_folder: &Path) -> EngineResult<PathBuf> {
	let metadata = std::fs::metadata(base_folder).map_err(|source| EngineError::PathIo {
		path: base_folder.display().to_string(),
		source,
	})?;
	if !metadata.is_dir() {
		return Err(EngineError::InvalidPath {
			path: base_folder.display().to_string(),
			reason: "フォルダーではありません".to_string(),
		});
	}
	let canonical = base_folder
		.canonicalize()
		.map_err(|source| EngineError::PathIo {
			path: base_folder.display().to_string(),
			source,
		})?;
	std::fs::read_dir(&canonical).map_err(|source| EngineError::PathIo {
		path: canonical.display().to_string(),
		source,
	})?;
	validate_base_folder_write_access(&canonical)?;
	Ok(canonical)
}

fn validate_base_folder_write_access(base_folder: &Path) -> EngineResult<()> {
	let nonce = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap_or_default()
		.as_nanos();
	for attempt in 0..16_u8 {
		let probe_path = base_folder.join(format!(
			".fuzzy-write-check-{}-{nonce}-{attempt}.tmp",
			std::process::id()
		));
		let mut probe = match OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(&probe_path)
		{
			Ok(probe) => probe,
			Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => continue,
			Err(source) => {
				return Err(EngineError::PathIo {
					path: base_folder.display().to_string(),
					source,
				});
			}
		};
		let write_result = probe.write_all(b"Fuzzy write access check");
		drop(probe);
		// 利用者の資料ではなく、この検証でcreate_newした専用プローブだけを削除する。
		let cleanup_result = std::fs::remove_file(&probe_path);
		if let Err(source) = write_result {
			return Err(EngineError::PathIo {
				path: base_folder.display().to_string(),
				source,
			});
		}
		cleanup_result.map_err(|source| EngineError::PathIo {
			path: probe_path.display().to_string(),
			source,
		})?;
		return Ok(());
	}

	Err(EngineError::InvalidPath {
		path: base_folder.display().to_string(),
		reason: "書き込み確認用の一時ファイル名を確保できません".to_string(),
	})
}

fn validate_identifier(field: &str, value: &str) -> EngineResult<()> {
	let valid = !value.is_empty()
		&& value.len() <= 128
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
	if valid {
		Ok(())
	} else {
		Err(EngineError::InvalidInput {
			field: field.to_string(),
			reason: "英数字・ハイフン・アンダースコアを使用してください".to_string(),
		})
	}
}

fn upsert_setting(
	transaction: &rusqlite::Transaction<'_>,
	key: &str,
	value: &str,
) -> EngineResult<()> {
	transaction
		.execute(
			"INSERT INTO app_settings (key, value) VALUES (?1, ?2)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			params![key, value],
		)
		.map_err(db_err)?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::fs;
	use std::path::PathBuf;
	use std::time::{SystemTime, UNIX_EPOCH};

	use rusqlite::params;

	use super::{
		saved_path_key, validate_base_folder, Database, INITIAL_COURSE_OVERRIDE_NOTE,
		INITIAL_COURSE_OVERRIDE_PATTERN,
	};
	use crate::index::DefaultIndexEngine;
	use crate::library::LibraryMaintenance;
	use crate::rule::DefaultRuleEngine;

	struct TestDirectory {
		path: PathBuf,
	}

	impl TestDirectory {
		fn new() -> Self {
			let unique = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("現在時刻を取得できる")
				.as_nanos();
			let path = std::env::temp_dir().join(format!("fuzzy-setup-{unique}"));
			fs::create_dir_all(&path).expect("テスト用フォルダーを作成できる");
			Self { path }
		}

		fn write(&self, relative: &str, contents: &[u8]) {
			let path = self.path.join(relative);
			fs::create_dir_all(path.parent().unwrap()).unwrap();
			fs::write(path, contents).unwrap();
		}
	}

	impl Drop for TestDirectory {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.path);
		}
	}

	#[test]
	fn saves_initial_setup_atomically_and_reports_completion() {
		let directory = TestDirectory::new();
		let mut database = Database::open_in_memory().unwrap();

		assert_eq!(database.initial_setup_saved_at().unwrap(), None);
		let saved_at = database
			.save_initial_setup(
				&directory.path,
				"year-course-assignment",
				"{year}/{course}/{assignment}",
				"estimated-1",
				Some(1),
				r#"[{"courseName":"情報アーキテクチャ"}]"#,
			)
			.unwrap();

		assert_eq!(
			database.initial_setup_saved_at().unwrap().as_deref(),
			Some(saved_at.as_str())
		);
		assert_eq!(
			database.base_folder_path().unwrap(),
			directory.path.canonicalize().unwrap()
		);
		assert_eq!(
			database.load_rule_set().unwrap().global_pattern_template,
			"{year}/{course}/{assignment}"
		);
		assert_eq!(
			database.initial_scan_course_segment_index().unwrap(),
			Some(1)
		);
	}

	#[test]
	fn validates_write_access_without_leaving_probe_files() {
		let directory = TestDirectory::new();
		directory.write("既存資料.txt", b"preserved");

		assert_eq!(
			validate_base_folder(&directory.path).unwrap(),
			directory.path.canonicalize().unwrap()
		);
		let entries = fs::read_dir(&directory.path)
			.unwrap()
			.map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
			.collect::<Vec<_>>();
		assert_eq!(entries, vec!["既存資料.txt".to_string()]);
		assert_eq!(
			fs::read(directory.path.join("既存資料.txt")).unwrap(),
			b"preserved"
		);
	}

	#[test]
	fn invalid_rule_does_not_leave_partial_settings() {
		let directory = TestDirectory::new();
		let mut database = Database::open_in_memory().unwrap();

		assert!(database
			.save_initial_setup(
				&directory.path,
				"invalid",
				"{course}/{unknown}",
				"estimated-1",
				Some(0),
				"[]",
			)
			.is_err());
		assert_eq!(database.initial_setup_saved_at().unwrap(), None);
		assert!(database.base_folder_path().is_err());
	}

	#[test]
	fn initial_course_overrides_are_idempotent_and_preserve_user_rules() {
		let directory = TestDirectory::new();
		let mut database = Database::open_in_memory().unwrap();
		database
			.save_initial_setup(
				&directory.path,
				"year-course-assignment",
				"{year}/{course}/{assignment}",
				"estimated-1",
				Some(0),
				"[]",
			)
			.unwrap();
		let custom_course_id = database.ensure_local_scan_course("認知科学概論").unwrap();
		database
			.update_course_rule_override(
				custom_course_id,
				false,
				Some("{term}/{course}/{assignment}"),
				Some("利用者が設定した例外"),
				&DefaultRuleEngine,
			)
			.unwrap();

		let selections = vec!["情報アーキテクチャ".to_string(), "認知科学概論".to_string()];
		database
			.synchronize_initial_course_overrides(&selections)
			.unwrap();
		let managed_course_id = database
			.ensure_local_scan_course("情報アーキテクチャ")
			.unwrap();
		let managed: (i64, String, String) = database
			.conn()
			.query_row(
				"SELECT id, pattern_template, note
				 FROM course_rule_overrides
				 WHERE course_id = ?1",
				[managed_course_id],
				|row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
			)
			.unwrap();
		assert_eq!(managed.1, INITIAL_COURSE_OVERRIDE_PATTERN);
		assert_eq!(managed.2, INITIAL_COURSE_OVERRIDE_NOTE);
		let custom: (String, String) = database
			.conn()
			.query_row(
				"SELECT pattern_template, note
				 FROM course_rule_overrides
				 WHERE course_id = ?1",
				[custom_course_id],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(
			custom,
			(
				"{term}/{course}/{assignment}".to_string(),
				"利用者が設定した例外".to_string()
			)
		);

		database
			.synchronize_initial_course_overrides(&selections)
			.unwrap();
		let managed_after_resave: (i64, i64) = database
			.conn()
			.query_row(
				"SELECT id, (SELECT count(*) FROM course_rule_overrides)
				 FROM course_rule_overrides
				 WHERE course_id = ?1",
				[managed_course_id],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(managed_after_resave, (managed.0, 2));

		database
			.synchronize_initial_course_overrides(&["認知科学概論".to_string()])
			.unwrap();
		let remaining: Vec<(i64, String)> = {
			let mut statement = database
				.conn()
				.prepare("SELECT course_id, note FROM course_rule_overrides ORDER BY course_id")
				.unwrap();
			statement
				.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
				.unwrap()
				.collect::<rusqlite::Result<_>>()
				.unwrap()
		};
		assert_eq!(
			remaining,
			vec![(custom_course_id, "利用者が設定した例外".to_string())]
		);
	}

	#[test]
	fn initial_override_applies_to_all_scanned_year_contexts_without_placeholder() {
		let directory = TestDirectory::new();
		directory.write("2025/データベース/正規化.pdf", b"year 2025");
		directory.write("2026/データベース/正規化.pdf", b"year 2026");
		let index_directory = TestDirectory::new();
		let mut database = Database::open_in_memory().unwrap();
		database
			.save_initial_setup(
				&directory.path,
				"year-course-assignment",
				"{year}/{course}/{assignment}",
				"estimated-1",
				Some(1),
				r#"[{"courseName":"データベース"}]"#,
			)
			.unwrap();
		let mut index = DefaultIndexEngine::open(&index_directory.path).unwrap();
		LibraryMaintenance::reconcile(&mut database, &mut index, false).unwrap();

		database
			.synchronize_initial_course_overrides(&["データベース".to_string()])
			.unwrap();

		let overridden_courses = {
			let mut statement = database
				.conn()
				.prepare(
					"SELECT c.academic_year, c.moodle_course_id, o.pattern_template, o.note
					 FROM course_rule_overrides o
					 JOIN courses c ON c.id = o.course_id
					 WHERE c.name = 'データベース'
					 ORDER BY c.academic_year",
				)
				.unwrap();
			statement
				.query_map([], |row| {
					Ok((
						row.get::<_, Option<i64>>(0)?,
						row.get::<_, String>(1)?,
						row.get::<_, String>(2)?,
						row.get::<_, String>(3)?,
					))
				})
				.unwrap()
				.collect::<rusqlite::Result<Vec<_>>>()
				.unwrap()
		};
		assert_eq!(overridden_courses.len(), 2);
		assert_eq!(overridden_courses[0].0, Some(2025));
		assert_eq!(overridden_courses[1].0, Some(2026));
		assert!(overridden_courses.iter().all(|course| {
			course.1.starts_with("local-scan:v2:")
				&& course.2 == INITIAL_COURSE_OVERRIDE_PATTERN
				&& course.3 == INITIAL_COURSE_OVERRIDE_NOTE
		}));
		let legacy_placeholder_count: i64 = database
			.conn()
			.query_row(
				"SELECT count(*)
				 FROM courses
				 WHERE name = 'データベース'
				   AND moodle_course_id GLOB 'local-scan:*'
				   AND moodle_course_id NOT GLOB 'local-scan:v2:*'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(legacy_placeholder_count, 0);
	}

	#[test]
	fn relocating_base_folder_rebases_metadata_without_moving_files_or_rules() {
		let directory = TestDirectory::new();
		let old_root = directory.path.join("old");
		let new_root = directory.path.join("new");
		fs::create_dir_all(old_root.join("データベース")).unwrap();
		fs::create_dir_all(&new_root).unwrap();
		let old_file = old_root.join("データベース/正規化.pdf");
		fs::write(&old_file, b"normalization").unwrap();
		let mut database = Database::open_in_memory().unwrap();
		database
			.save_initial_setup(
				&old_root,
				"year-course-assignment",
				"{year}/{course}/{assignment}",
				"estimated-1",
				Some(1),
				"[]",
			)
			.unwrap();
		let course_id = database.ensure_local_scan_course("データベース").unwrap();
		database
			.update_course_rule_override(
				course_id,
				false,
				Some("{course}/{assignment}"),
				Some("利用者設定"),
				&DefaultRuleEngine,
			)
			.unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO files (
					id, course_id, original_name, saved_path, size_bytes, hash_blake3
				 ) VALUES (41, ?1, '正規化.pdf', ?2, 13, 'b3:test')",
				params![course_id, old_file.to_string_lossy()],
			)
			.unwrap();
		database.mark_search_indexed(41, Some(2)).unwrap();

		assert_eq!(database.relocate_base_folder(&new_root).unwrap(), 1);

		assert!(old_file.exists());
		assert!(!new_root.join("データベース/正規化.pdf").exists());
		let canonical_new_root = new_root.canonicalize().unwrap();
		assert_eq!(database.base_folder_path().unwrap(), canonical_new_root);
		let relocated: (String, bool) = database
			.conn()
			.query_row(
				"SELECT saved_path, missing_at IS NOT NULL FROM files WHERE id = 41",
				[],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(
			PathBuf::from(relocated.0),
			PathBuf::from(saved_path_key(
				&canonical_new_root.join("データベース/正規化.pdf")
			))
		);
		assert!(relocated.1);
		assert!(database.search_document_metadata(41).unwrap().is_none());
		assert_eq!(
			database.load_rule_set().unwrap().global_pattern_template,
			"{year}/{course}/{assignment}"
		);
		let stored_override: (String, String) = database
			.conn()
			.query_row(
				"SELECT pattern_template, note
				 FROM course_rule_overrides WHERE course_id = ?1",
				[course_id],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(
			stored_override,
			(
				"{course}/{assignment}".to_string(),
				"利用者設定".to_string()
			)
		);

		assert!(database
			.relocate_base_folder(&directory.path.join("missing"))
			.is_err());
		assert_eq!(database.base_folder_path().unwrap(), canonical_new_root);
	}
}
