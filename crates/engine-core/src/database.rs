//! Tauriとnative-hostが共有するSQLite接続・永続化層。
//!
//! 同じDBパス解決、外部キー設定、スキーマ検証を両プロセスで使用し、
//! SQLiteを唯一の正本として扱う。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::library::is_indexable_document;
use crate::types::SearchDocumentMetadata;
use crate::{
	is_compatible_extension_version, EngineError, EngineResult, ExtensionRecoveryState,
	ExtensionRecoveryStatus, ExtensionRuntimeObservation, ExtensionRuntimeReport,
	ExtensionSetupState, ExtensionSetupStatus, EXTENSION_RUNTIME_PROTOCOL_VERSION,
	EXTENSION_RUNTIME_RECENT_SECONDS, SCHEMA_SQL,
};

mod backup;
mod duplicates;
mod learning;
mod library;
mod missing;
mod notifications;
mod rules;
mod saved_files;
mod setup;
mod sync;

pub(crate) use library::saved_path_key;
pub use library::{ReusableScannedFingerprint, ScannedFileObservation, ScannedFileUpsertResult};
pub use saved_files::{ExtractedFileRegistration, SavedZipSource};

/// DBファイルパスのオーバーライドに使う環境変数。
const DB_PATH_ENV: &str = "FUZZY_DB_PATH";
const SCHEMA_VERSION: i64 = 1;

/// SQLite接続。接続時にFK有効化と初版スキーマの適用・検証を保証する。
pub struct Database {
	conn: Connection,
	path: Option<PathBuf>,
}

impl Database {
	/// 既定のパスでDBを開く。
	pub fn open_default() -> EngineResult<Self> {
		Self::open(&resolve_db_path()?)
	}

	/// 指定パスでDBを開く。親ディレクトリが無ければ作成する。
	pub fn open(path: &Path) -> EngineResult<Self> {
		if let Some(parent) = path.parent() {
			if !parent.as_os_str().is_empty() {
				std::fs::create_dir_all(parent)?;
			}
		}
		let conn = Connection::open(path).map_err(db_err)?;
		Self::from_connection(conn, Some(path.to_path_buf()))
	}

	/// メモリ上のDBを開く。
	pub fn open_in_memory() -> EngineResult<Self> {
		let conn = Connection::open_in_memory().map_err(db_err)?;
		Self::from_connection(conn, None)
	}

	fn from_connection(mut conn: Connection, path: Option<PathBuf>) -> EngineResult<Self> {
		conn.execute_batch(
			"PRAGMA foreign_keys = ON;
			 PRAGMA busy_timeout = 5000;",
		)
		.map_err(db_err)?;
		validate_foreign_keys_enabled(&conn)?;

		if database_is_empty(&conn)? {
			apply_schema(&mut conn, SCHEMA_SQL)?;
		} else {
			let version = schema_version(&conn)?;
			validate_schema_generation(&conn, version)?;
			validate_foreign_key_integrity(&conn)?;
		}

		validate_schema_generation(&conn, SCHEMA_VERSION)?;
		validate_foreign_key_integrity(&conn)?;

		Ok(Self { conn, path })
	}

	/// 拡張機能から届いた実行情報を、native-hostの受信時刻で保存する。
	pub fn record_extension_runtime(
		&self,
		report: &ExtensionRuntimeReport,
	) -> EngineResult<ExtensionRuntimeObservation> {
		report.validate()?;

		self.conn
			.execute(
				"INSERT INTO extension_runtime_observations (
					installation_id,
					extension_version,
					protocol_version,
					first_seen_at,
					last_seen_at
				) VALUES (
					?1,
					?2,
					?3,
					strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
					strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				)
				ON CONFLICT(installation_id, extension_version, protocol_version)
				DO UPDATE SET last_seen_at = excluded.last_seen_at",
				params![
					report.installation_id,
					report.extension_version,
					report.protocol_version
				],
			)
			.map_err(db_err)?;

		self.conn
			.query_row(
				"SELECT
					installation_id,
					extension_version,
					protocol_version,
					first_seen_at,
					last_seen_at
				FROM extension_runtime_observations
				WHERE installation_id = ?1
					AND extension_version = ?2
					AND protocol_version = ?3",
				params![
					report.installation_id,
					report.extension_version,
					report.protocol_version
				],
				observation_from_row,
			)
			.map_err(db_err)
	}

	/// 指定日時以降に届いた最新応答から、初期セットアップ状態を算出する。
	pub fn extension_setup_status_since(&self, since: &str) -> EngineResult<ExtensionSetupStatus> {
		let valid_since: bool = self
			.conn
			.query_row("SELECT julianday(?1) IS NOT NULL", [since], |row| {
				row.get(0)
			})
			.map_err(db_err)?;
		if !valid_since {
			return Err(EngineError::InvalidInput {
				field: "since".to_string(),
				reason: "ISO 8601形式の日時を指定してください".to_string(),
			});
		}

		let observation = self
			.conn
			.query_row(
				"SELECT
					installation_id,
					extension_version,
					protocol_version,
					first_seen_at,
					last_seen_at
				FROM extension_runtime_observations
				WHERE julianday(last_seen_at) >= julianday(?1)
				ORDER BY julianday(last_seen_at) DESC, rowid DESC
				LIMIT 1",
				[since],
				observation_from_row,
			)
			.optional()
			.map_err(db_err)?;

		let Some(observation) = observation else {
			return Ok(ExtensionSetupStatus::waiting());
		};
		let state = if is_compatible_observation(&observation) {
			ExtensionSetupState::Ready
		} else {
			ExtensionSetupState::Incompatible
		};

		Ok(ExtensionSetupStatus {
			state,
			observation: Some(observation),
		})
	}

	/// 最新の保存済み応答から、セットアップ完了後の復旧状態を算出する。
	pub fn extension_recovery_status(&self) -> EngineResult<ExtensionRecoveryStatus> {
		let recent_modifier = format!("-{EXTENSION_RUNTIME_RECENT_SECONDS} seconds");
		let mut statement = self
			.conn
			.prepare(
				"WITH ranked_observations AS (
					SELECT
						installation_id,
						extension_version,
						protocol_version,
						first_seen_at,
						last_seen_at,
						rowid AS source_rowid,
						ROW_NUMBER() OVER (
							PARTITION BY installation_id
							ORDER BY julianday(last_seen_at) DESC, rowid DESC
						) AS installation_rank
					FROM extension_runtime_observations
				)
				SELECT
					installation_id,
					extension_version,
					protocol_version,
					first_seen_at,
					last_seen_at,
					julianday(last_seen_at) >= julianday('now', ?1)
				FROM ranked_observations
				WHERE installation_rank = 1
				ORDER BY julianday(last_seen_at) DESC, source_rowid DESC",
			)
			.map_err(db_err)?;
		let rows = statement
			.query_map([recent_modifier], |row| {
				Ok((observation_from_row(row)?, row.get::<_, bool>(5)?))
			})
			.map_err(db_err)?;
		let observations = rows.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
		let Some((latest_observation, _)) = observations.first() else {
			return Ok(ExtensionRecoveryStatus::missing());
		};
		if let Some((observation, _)) = observations
			.iter()
			.find(|(observation, recent)| is_compatible_observation(observation) && *recent)
		{
			return Ok(ExtensionRecoveryStatus {
				state: ExtensionRecoveryState::Ready,
				observation: Some(observation.clone()),
				recent_within_seconds: EXTENSION_RUNTIME_RECENT_SECONDS,
			});
		}

		let state = if !is_compatible_observation(latest_observation) {
			ExtensionRecoveryState::Incompatible
		} else {
			ExtensionRecoveryState::Stale
		};

		Ok(ExtensionRecoveryStatus {
			state,
			observation: Some(latest_observation.clone()),
			recent_within_seconds: EXTENSION_RUNTIME_RECENT_SECONDS,
		})
	}

	/// 全文索引への投入完了をSQLiteの補助メタ情報へ反映する。
	pub fn mark_search_indexed(&self, file_id: i64, page_count: Option<u32>) -> EngineResult<()> {
		self.conn
			.execute(
				"INSERT INTO search_index_meta (file_id, indexed_at, page_count)
				 VALUES (?1, datetime('now'), ?2)
				 ON CONFLICT(file_id) DO UPDATE SET
					indexed_at = excluded.indexed_at,
					page_count = excluded.page_count",
				params![file_id, page_count.map(i64::from)],
			)
			.map_err(db_err)?;
		Ok(())
	}

	/// 全文索引からの削除に追従して補助メタ情報を削除する。
	pub fn remove_search_index_meta(&self, file_id: i64) -> EngineResult<()> {
		self.conn
			.execute(
				"DELETE FROM search_index_meta WHERE file_id = ?1",
				[file_id],
			)
			.map_err(db_err)?;
		Ok(())
	}

	/// 全文索引を再構築する前に、全ファイルの索引済み情報を無効化する。
	pub fn clear_search_index_meta(&self) -> EngineResult<()> {
		self.conn
			.execute("DELETE FROM search_index_meta", [])
			.map_err(db_err)?;
		Ok(())
	}

	/// SQLite正本に、まだ全文索引へ反映されていない有効な文書があるかを返す。
	///
	/// `search_index_meta`は索引成功後だけ作成されるため、この判定は別プロセスで
	/// 資料が登録された場合や、バックアップ復元後にアプリを再起動した場合にも有効。
	pub fn has_unindexed_active_documents(&self) -> EngineResult<bool> {
		let mut statement = self
			.conn
			.prepare(
				"SELECT files.saved_path
				 FROM files
				 LEFT JOIN search_index_meta
					ON search_index_meta.file_id = files.id
				 WHERE files.missing_at IS NULL
				   AND search_index_meta.file_id IS NULL",
			)
			.map_err(db_err)?;
		let paths = statement
			.query_map([], |row| row.get::<_, String>(0))
			.map_err(db_err)?;
		for path in paths {
			if is_indexable_document(Path::new(&path.map_err(db_err)?)) {
				return Ok(true);
			}
		}
		Ok(false)
	}

	/// SQLiteには索引済み記録がある有効な文書が1件以上あるかを返す。
	///
	/// Tantivyの保存先が消失した場合に、空の索引を新規作成して正常と誤認しないために使う。
	pub fn has_indexed_active_documents(&self) -> EngineResult<bool> {
		self.conn
			.query_row(
				"SELECT EXISTS(
					SELECT 1
					FROM files
					INNER JOIN search_index_meta
						ON search_index_meta.file_id = files.id
					WHERE files.missing_at IS NULL
				)",
				[],
				|row| row.get(0),
			)
			.map_err(db_err)
	}

	/// 検索ヒットのファイル名・コース名をSQLiteの正本から取得する。
	pub fn search_document_metadata(
		&self,
		file_id: i64,
	) -> EngineResult<Option<SearchDocumentMetadata>> {
		self.conn
			.query_row(
				"SELECT files.id, files.original_name, courses.name
				 FROM files
				 INNER JOIN search_index_meta ON search_index_meta.file_id = files.id
				 LEFT JOIN courses ON courses.id = files.course_id
				 WHERE files.id = ?1
					AND files.missing_at IS NULL",
				[file_id],
				|row| {
					Ok(SearchDocumentMetadata {
						file_id: row.get(0)?,
						file_name: row.get(1)?,
						course_name: row.get(2)?,
					})
				},
			)
			.optional()
			.map_err(db_err)
	}

	/// 開発・テスト用のサンプルデータを投入する。
	/// リリースビルドには含めず、実利用DBへ誤って投入できないようにする。
	#[cfg(debug_assertions)]
	pub fn apply_development_seed(&self) -> EngineResult<()> {
		self.conn.execute_batch(crate::SEED_SQL).map_err(db_err)
	}

	/// 内部接続への参照。DB実装の結合テストで使用する。
	#[cfg(test)]
	pub(crate) fn conn(&self) -> &Connection {
		&self.conn
	}
}

fn observation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExtensionRuntimeObservation> {
	Ok(ExtensionRuntimeObservation {
		installation_id: row.get(0)?,
		extension_version: row.get(1)?,
		protocol_version: row.get(2)?,
		first_seen_at: row.get(3)?,
		last_seen_at: row.get(4)?,
	})
}

fn is_compatible_observation(observation: &ExtensionRuntimeObservation) -> bool {
	observation.protocol_version == EXTENSION_RUNTIME_PROTOCOL_VERSION
		&& is_compatible_extension_version(&observation.extension_version)
}

fn database_is_empty(conn: &Connection) -> EngineResult<bool> {
	let count: i64 = conn
		.query_row(
			"SELECT count(*)
			 FROM sqlite_schema
			 WHERE name NOT LIKE 'sqlite_%'",
			[],
			|row| row.get(0),
		)
		.map_err(db_err)?;
	Ok(count == 0)
}

fn table_exists(conn: &Connection, table_name: &str) -> EngineResult<bool> {
	let count: i64 = conn
		.query_row(
			"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
			[table_name],
			|row| row.get(0),
		)
		.map_err(db_err)?;
	Ok(count > 0)
}

fn column_exists(conn: &Connection, table_name: &str, column_name: &str) -> EngineResult<bool> {
	let count: i64 = conn
		.query_row(
			"SELECT count(*)
			 FROM pragma_table_info(?1)
			 WHERE name = ?2",
			params![table_name, column_name],
			|row| row.get(0),
		)
		.map_err(db_err)?;
	Ok(count > 0)
}

fn schema_version(conn: &Connection) -> EngineResult<i64> {
	conn.query_row("PRAGMA user_version", [], |row| row.get(0))
		.map_err(db_err)
}

pub(super) fn validate_schema_generation(conn: &Connection, version: i64) -> EngineResult<()> {
	if version != SCHEMA_VERSION {
		let detail = if version == 0 {
			"世代情報のない非空DBはFuzzy初版の正規スキーマとして確認できません".to_string()
		} else if version > SCHEMA_VERSION {
			format!(
				"新しいバージョンのFuzzyで作成された可能性があります（対応上限: {SCHEMA_VERSION}）"
			)
		} else {
			"不正なスキーマ世代です".to_string()
		};
		return Err(EngineError::Database {
			message: format!("未対応のSQLiteスキーマ世代です（実際: {version}）。{detail}"),
		});
	}

	for (table, columns) in REQUIRED_TABLE_COLUMNS {
		require_table_columns(conn, table, columns)?;
	}

	validate_schema_shape(conn)?;

	let assignment_changes_sql: String = conn
		.query_row(
			"SELECT sql
			 FROM sqlite_schema
			 WHERE type = 'table' AND name = 'assignment_changes'",
			[],
			|row| row.get(0),
		)
		.map_err(db_err)?;
	if !assignment_changes_sql.contains("'removed_at'") {
		return Err(EngineError::Database {
			message: "SQLiteスキーマのassignment_changes.field制約にremoved_atがありません"
				.to_string(),
		});
	}

	Ok(())
}

const REQUIRED_COLUMN_SHAPES: &[(&str, &str, bool, i64)] = &[
	("app_settings", "key", false, 1),
	("app_settings", "value", true, 0),
	("extension_runtime_observations", "installation_id", true, 1),
	(
		"extension_runtime_observations",
		"extension_version",
		true,
		2,
	),
	(
		"extension_runtime_observations",
		"protocol_version",
		true,
		3,
	),
	("extension_runtime_observations", "first_seen_at", true, 0),
	("extension_runtime_observations", "last_seen_at", true, 0),
	("courses", "id", false, 1),
	("courses", "moodle_course_id", true, 0),
	("courses", "name", true, 0),
	("courses", "academic_year", false, 0),
	("courses", "folder_name_override", false, 0),
	("global_rule", "id", false, 1),
	("global_rule", "pattern_key", true, 0),
	("global_rule", "pattern_template", true, 0),
	("course_rule_overrides", "id", false, 1),
	("course_rule_overrides", "course_id", true, 0),
	("course_rule_overrides", "split_by_section", true, 0),
	("files", "id", false, 1),
	("files", "original_name", true, 0),
	("files", "saved_path", true, 0),
	("files", "size_bytes", true, 0),
	("files", "scan_modified_at_ns", false, 0),
	("files", "hash_blake3", true, 0),
	("files", "text_extracted", true, 0),
	("files", "rule_compliant", true, 0),
	("files", "downloaded_at", true, 0),
	("files", "missing_at", false, 0),
	("duplicate_groups", "id", false, 1),
	("duplicate_groups", "method", true, 0),
	("duplicate_members", "group_id", true, 1),
	("duplicate_members", "file_id", true, 2),
	("duplicate_members", "similarity", true, 0),
	("assignments", "id", false, 1),
	("assignments", "course_id", true, 0),
	("assignments", "moodle_assignment_id", false, 0),
	("assignments", "title", true, 0),
	("assignments", "source", true, 0),
	("assignments", "due_at_status", true, 0),
	("assignments", "submission_mode", true, 0),
	("assignments", "submitted", true, 0),
	("assignments", "removed_at", false, 0),
	("assignments", "created_at", true, 0),
	("assignments", "updated_at", true, 0),
	("notification_rules", "id", false, 1),
	("notification_rules", "offset_minutes", true, 0),
	("notification_rules", "label", true, 0),
	("notification_rules", "enabled", true, 0),
	("search_index_meta", "file_id", false, 1),
	("search_index_meta", "indexed_at", true, 0),
	("sync_events", "id", false, 1),
	("sync_events", "synced_at", true, 0),
	("sync_events", "trigger", true, 0),
	("sync_events", "new_assignment_count", true, 0),
	("sync_events", "changed_assignment_count", true, 0),
	("sync_events", "removed_assignment_count", true, 0),
	("assignment_changes", "id", false, 1),
	("assignment_changes", "sync_event_id", true, 0),
	("assignment_changes", "assignment_id", true, 0),
	("assignment_changes", "field", true, 0),
	("assignment_changes", "detected_at", true, 0),
];

const EXPECTED_FOREIGN_KEYS: &[(&str, &str, &str, &str, &str)] = &[
	(
		"course_rule_overrides",
		"course_id",
		"courses",
		"id",
		"CASCADE",
	),
	("files", "course_id", "courses", "id", "SET NULL"),
	(
		"duplicate_members",
		"group_id",
		"duplicate_groups",
		"id",
		"CASCADE",
	),
	("duplicate_members", "file_id", "files", "id", "CASCADE"),
	("assignments", "course_id", "courses", "id", "CASCADE"),
	("assignments", "related_file_id", "files", "id", "SET NULL"),
	("search_index_meta", "file_id", "files", "id", "CASCADE"),
	(
		"assignment_changes",
		"sync_event_id",
		"sync_events",
		"id",
		"CASCADE",
	),
	(
		"assignment_changes",
		"assignment_id",
		"assignments",
		"id",
		"CASCADE",
	),
];

fn validate_schema_shape(conn: &Connection) -> EngineResult<()> {
	reject_unexpected_schema_objects(conn)?;
	for &(table, column, expected_not_null, expected_pk) in REQUIRED_COLUMN_SHAPES {
		validate_column_shape(conn, table, column, expected_not_null, expected_pk)?;
	}
	validate_foreign_key_declarations(conn)?;
	for (table, columns, partial) in [
		("courses", &["moodle_course_id"][..], false),
		("course_rule_overrides", &["course_id"][..], false),
		("files", &["saved_path"][..], false),
		("notification_rules", &["offset_minutes"][..], false),
	] {
		require_unique_index(conn, table, columns, partial)?;
	}
	require_unique_index_collation(conn, "files", &["saved_path"], &["NOCASE"], false)?;
	require_unique_index(
		conn,
		"assignments",
		&["course_id", "moodle_assignment_id"],
		true,
	)?;
	for index in ["idx_assignments_active", "idx_files_missing"] {
		if index_exists(conn, index)? {
			continue;
		}
		return Err(EngineError::Database {
			message: format!("SQLiteスキーマに必須索引「{index}」がありません"),
		});
	}
	validate_check_constraints(conn)
}

fn reject_unexpected_schema_objects(conn: &Connection) -> EngineResult<()> {
	let mut expected_tables = REQUIRED_TABLE_COLUMNS
		.iter()
		.map(|(table, _)| (*table).to_string())
		.collect::<BTreeSet<_>>();
	expected_tables.insert("sqlite_sequence".to_string());
	let mut statement = conn
		.prepare(
			"SELECT type, name
			 FROM sqlite_schema
			 WHERE type IN ('table', 'view', 'trigger')
				AND name NOT LIKE 'sqlite_%'
			 ORDER BY type, name",
		)
		.map_err(db_err)?;
	let objects = statement
		.query_map([], |row| {
			Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	for (kind, name) in objects {
		if kind != "table" || !expected_tables.contains(&name) {
			return Err(EngineError::Database {
				message: format!("SQLiteスキーマに未対応の{kind}「{name}」があります"),
			});
		}
	}
	Ok(())
}

fn validate_column_shape(
	conn: &Connection,
	table: &str,
	column: &str,
	expected_not_null: bool,
	expected_pk: i64,
) -> EngineResult<()> {
	let mut statement = conn
		.prepare(&format!("PRAGMA table_info('{}')", sql_quote(table)))
		.map_err(db_err)?;
	let columns = statement
		.query_map([], |row| {
			Ok((
				row.get::<_, String>(1)?,
				row.get::<_, bool>(3)?,
				row.get::<_, i64>(5)?,
			))
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	let (_, actual_not_null, actual_pk) = columns
		.into_iter()
		.find(|(name, _, _)| name == column)
		.ok_or_else(|| EngineError::Database {
		message: format!("SQLiteスキーマの{table}.{column}がありません"),
	})?;
	if actual_not_null != expected_not_null || actual_pk != expected_pk {
		return Err(EngineError::Database {
			message: format!("SQLiteスキーマの{table}.{column}のNULL/主キー制約が一致しません"),
		});
	}
	Ok(())
}

fn validate_foreign_key_declarations(conn: &Connection) -> EngineResult<()> {
	for (table, _) in REQUIRED_TABLE_COLUMNS {
		let mut statement = conn
			.prepare(&format!("PRAGMA foreign_key_list('{}')", sql_quote(table)))
			.map_err(db_err)?;
		let actual = statement
			.query_map([], |row| {
				Ok((
					row.get::<_, String>(3)?,
					row.get::<_, String>(2)?,
					row.get::<_, String>(4)?,
					row.get::<_, String>(6)?,
				))
			})
			.map_err(db_err)?
			.collect::<rusqlite::Result<BTreeSet<_>>>()
			.map_err(db_err)?;
		let expected = EXPECTED_FOREIGN_KEYS
			.iter()
			.filter(|(owner, _, _, _, _)| owner == table)
			.map(|(_, from, target, to, on_delete)| {
				(
					(*from).to_string(),
					(*target).to_string(),
					(*to).to_string(),
					(*on_delete).to_string(),
				)
			})
			.collect::<BTreeSet<_>>();
		if actual != expected {
			return Err(EngineError::Database {
				message: format!("SQLiteスキーマの{table}外部キー宣言が一致しません"),
			});
		}
	}
	Ok(())
}

fn require_unique_index(
	conn: &Connection,
	table: &str,
	expected_columns: &[&str],
	expected_partial: bool,
) -> EngineResult<()> {
	let mut statement = conn
		.prepare(&format!("PRAGMA index_list('{}')", sql_quote(table)))
		.map_err(db_err)?;
	let indexes = statement
		.query_map([], |row| {
			Ok((
				row.get::<_, String>(1)?,
				row.get::<_, bool>(2)?,
				row.get::<_, bool>(4)?,
			))
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	for (name, unique, partial) in indexes {
		if !unique || partial != expected_partial {
			continue;
		}
		let mut columns_statement = conn
			.prepare(&format!("PRAGMA index_info('{}')", sql_quote(&name)))
			.map_err(db_err)?;
		let columns = columns_statement
			.query_map([], |row| row.get::<_, String>(2))
			.map_err(db_err)?
			.collect::<rusqlite::Result<Vec<_>>>()
			.map_err(db_err)?;
		if columns
			.iter()
			.map(String::as_str)
			.eq(expected_columns.iter().copied())
		{
			return Ok(());
		}
	}
	Err(EngineError::Database {
		message: format!(
			"SQLiteスキーマの{table}に必須一意制約（{}）がありません",
			expected_columns.join(", ")
		),
	})
}

fn require_unique_index_collation(
	conn: &Connection,
	table: &str,
	expected_columns: &[&str],
	expected_collations: &[&str],
	expected_partial: bool,
) -> EngineResult<()> {
	let mut statement = conn
		.prepare(&format!("PRAGMA index_list('{}')", sql_quote(table)))
		.map_err(db_err)?;
	let indexes = statement
		.query_map([], |row| {
			Ok((
				row.get::<_, String>(1)?,
				row.get::<_, bool>(2)?,
				row.get::<_, bool>(4)?,
			))
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	for (name, unique, partial) in indexes {
		if !unique || partial != expected_partial {
			continue;
		}
		let mut columns_statement = conn
			.prepare(&format!("PRAGMA index_xinfo('{}')", sql_quote(&name)))
			.map_err(db_err)?;
		let entries = columns_statement
			.query_map([], |row| {
				Ok((
					row.get::<_, Option<String>>(2)?,
					row.get::<_, String>(4)?,
					row.get::<_, bool>(5)?,
				))
			})
			.map_err(db_err)?
			.collect::<rusqlite::Result<Vec<_>>>()
			.map_err(db_err)?
			.into_iter()
			.filter(|(_, _, key)| *key)
			.collect::<Vec<_>>();
		let columns_match = entries
			.iter()
			.filter_map(|(column, _, _)| column.as_deref())
			.eq(expected_columns.iter().copied());
		let collations_match = entries
			.iter()
			.map(|(_, collation, _)| collation.as_str())
			.eq(expected_collations.iter().copied());
		if columns_match && collations_match {
			return Ok(());
		}
	}
	Err(EngineError::Database {
		message: format!(
			"SQLiteスキーマの{table}に照合順序を含む必須一意制約（{} / {}）がありません",
			expected_columns.join(", "),
			expected_collations.join(", ")
		),
	})
}

fn validate_check_constraints(conn: &Connection) -> EngineResult<()> {
	let requirements = [
		(
			"extension_runtime_observations",
			"check(protocol_version>0)",
		),
		("global_rule", "check(id=1)"),
		("duplicate_groups", "check(methodin('exact','similar'))"),
		("duplicate_members", "check(similaritybetween0.0and1.0)"),
		(
			"assignments",
			"check(sourcein('moodle_dashboard','moodle_text','file_content'))",
		),
		(
			"assignments",
			"check(due_at_statusin('normal','needs_review'))",
		),
		(
			"assignments",
			"check(submission_modein('moodle_auto','manual','notify_only','unknown'))",
		),
		(
			"notification_rules",
			"check(offset_minutesbetween0and525600)",
		),
		("courses", "check(academic_yearbetween1900and9999)"),
		(
			"assignment_changes",
			"check(fieldin('due_at','title','submission_mode','due_at_status','submitted','removed_at'))",
		),
	];

	for (table, required) in requirements {
		let sql: String = conn
			.query_row(
				"SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?1",
				[table],
				|row| row.get(0),
			)
			.map_err(db_err)?;
		let normalized = sql
			.chars()
			.filter(|character| !character.is_whitespace())
			.flat_map(char::to_lowercase)
			.collect::<String>();
		if !normalized.contains(required) {
			return Err(EngineError::Database {
				message: format!("SQLiteスキーマの{table}に必須CHECK制約がありません"),
			});
		}
	}
	Ok(())
}

fn index_exists(conn: &Connection, name: &str) -> EngineResult<bool> {
	let count: i64 = conn
		.query_row(
			"SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = ?1",
			[name],
			|row| row.get(0),
		)
		.map_err(db_err)?;
	Ok(count == 1)
}

fn sql_quote(value: &str) -> String {
	value.replace('\'', "''")
}

fn require_table_columns(
	conn: &Connection,
	table_name: &str,
	column_names: &[&str],
) -> EngineResult<()> {
	if !table_exists(conn, table_name)? {
		return Err(EngineError::Database {
			message: format!("SQLiteスキーマに必須テーブル「{table_name}」がありません"),
		});
	}
	for column_name in column_names {
		if !column_exists(conn, table_name, column_name)? {
			return Err(EngineError::Database {
				message: format!(
					"SQLiteスキーマの{table_name}テーブルに必須列「{column_name}」がありません"
				),
			});
		}
	}
	Ok(())
}

fn validate_foreign_keys_enabled(conn: &Connection) -> EngineResult<()> {
	let enabled: i64 = conn
		.query_row("PRAGMA foreign_keys", [], |row| row.get(0))
		.map_err(db_err)?;
	if enabled != 1 {
		return Err(EngineError::Database {
			message: "SQLiteの外部キー検証を有効にできません".to_string(),
		});
	}
	Ok(())
}

pub(super) fn validate_foreign_key_integrity(conn: &Connection) -> EngineResult<()> {
	let mut statement = conn.prepare("PRAGMA foreign_key_check").map_err(db_err)?;
	let mut rows = statement.query([]).map_err(db_err)?;
	if let Some(row) = rows.next().map_err(db_err)? {
		let table: String = row.get(0).map_err(db_err)?;
		let row_id: Option<i64> = row.get(1).map_err(db_err)?;
		let parent: String = row.get(2).map_err(db_err)?;
		return Err(EngineError::Database {
			message: format!(
				"SQLite外部キー整合性エラー: table={table}, rowid={}, parent={parent}",
				row_id.map_or_else(|| "不明".to_string(), |value| value.to_string())
			),
		});
	}
	Ok(())
}

const REQUIRED_TABLE_COLUMNS: &[(&str, &[&str])] = &[
	("app_settings", &["key", "value"]),
	(
		"extension_runtime_observations",
		&[
			"installation_id",
			"extension_version",
			"protocol_version",
			"first_seen_at",
			"last_seen_at",
		],
	),
	(
		"courses",
		&[
			"id",
			"moodle_course_id",
			"name",
			"academic_year",
			"term",
			"folder_name_override",
			"created_at",
			"updated_at",
		],
	),
	(
		"global_rule",
		&["id", "pattern_key", "pattern_template", "updated_at"],
	),
	(
		"course_rule_overrides",
		&[
			"id",
			"course_id",
			"split_by_section",
			"pattern_template",
			"note",
			"created_at",
		],
	),
	(
		"files",
		&[
			"id",
			"course_id",
			"section_no",
			"moodle_file_id",
			"original_name",
			"saved_path",
			"size_bytes",
			"scan_modified_at_ns",
			"mime_type",
			"hash_blake3",
			"simhash",
			"text_extracted",
			"rule_compliant",
			"violation_reason",
			"downloaded_at",
			"missing_at",
		],
	),
	("duplicate_groups", &["id", "method", "created_at"]),
	("duplicate_members", &["group_id", "file_id", "similarity"]),
	(
		"assignments",
		&[
			"id",
			"course_id",
			"moodle_assignment_id",
			"title",
			"source",
			"due_at",
			"due_at_status",
			"submission_mode",
			"submitted",
			"related_file_id",
			"removed_at",
			"created_at",
			"updated_at",
		],
	),
	(
		"notification_rules",
		&["id", "offset_minutes", "label", "enabled"],
	),
	(
		"search_index_meta",
		&["file_id", "indexed_at", "page_count"],
	),
	(
		"sync_events",
		&[
			"id",
			"synced_at",
			"trigger",
			"new_assignment_count",
			"changed_assignment_count",
			"removed_assignment_count",
		],
	),
	(
		"assignment_changes",
		&[
			"id",
			"sync_event_id",
			"assignment_id",
			"field",
			"old_value",
			"new_value",
			"detected_at",
		],
	),
];

fn apply_schema(conn: &mut Connection, schema_sql: &str) -> EngineResult<()> {
	let transaction = conn.transaction().map_err(db_err)?;
	transaction.execute_batch(schema_sql).map_err(db_err)?;
	transaction.commit().map_err(db_err)
}

/// DBファイルの実パスを決定する。
///
/// 1. 環境変数 `FUZZY_DB_PATH`
/// 2. Windowsの`LOCALAPPDATA/Fuzzy/fuzzy.db`
/// 3. 新パスがまだなく旧`APPDATA/Fuzzy/fuzzy.db`がある場合は旧パス
pub fn resolve_db_path() -> EngineResult<PathBuf> {
	#[cfg(windows)]
	{
		resolve_windows_db_path(
			std::env::var_os(DB_PATH_ENV).map(PathBuf::from),
			std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
			std::env::var_os("APPDATA").map(PathBuf::from),
		)
	}

	#[cfg(not(windows))]
	{
		if let Some(path) = std::env::var_os(DB_PATH_ENV) {
			return Ok(PathBuf::from(path));
		}
		Ok(data_dir()?.join("Fuzzy").join("fuzzy.db"))
	}
}

#[cfg(windows)]
fn resolve_windows_db_path(
	override_path: Option<PathBuf>,
	local_app_data: Option<PathBuf>,
	roaming_app_data: Option<PathBuf>,
) -> EngineResult<PathBuf> {
	if let Some(path) = override_path {
		return Ok(path);
	}
	let preferred = local_app_data.map(|root| root.join("Fuzzy").join("fuzzy.db"));
	let legacy = roaming_app_data.map(|root| root.join("Fuzzy").join("fuzzy.db"));

	if preferred.as_deref().is_some_and(Path::exists) {
		return Ok(preferred.expect("preferred path was checked"));
	}
	if legacy.as_deref().is_some_and(Path::exists) {
		return Ok(legacy.expect("legacy path was checked"));
	}
	preferred.ok_or_else(|| EngineError::Internal {
		message: "アプリデータディレクトリを決定できません（LOCALAPPDATA 未設定）".to_string(),
	})
}

#[cfg(not(windows))]
fn data_dir() -> EngineResult<PathBuf> {
	if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
		return Ok(PathBuf::from(xdg));
	}
	if let Some(home) = std::env::var_os("HOME") {
		return Ok(PathBuf::from(home).join(".local").join("share"));
	}
	Err(EngineError::Internal {
		message: "アプリデータディレクトリを決定できません（XDG_DATA_HOME/HOME 未設定）"
			.to_string(),
	})
}

fn db_err(error: rusqlite::Error) -> EngineError {
	EngineError::Database {
		message: error.to_string(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::SEED_SQL;

	fn report(version: &str, protocol_version: u32) -> ExtensionRuntimeReport {
		ExtensionRuntimeReport {
			installation_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
			extension_version: version.to_string(),
			protocol_version,
		}
	}

	#[test]
	fn foreign_keys_enabled_after_open() {
		let database = Database::open_in_memory().unwrap();
		let enabled: i64 = database
			.conn()
			.query_row("PRAGMA foreign_keys", [], |row| row.get(0))
			.unwrap();
		assert_eq!(enabled, 1);
	}

	#[test]
	fn saved_paths_are_case_insensitively_unique_and_use_the_unique_index() {
		let database = Database::open_in_memory().unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO files (
					original_name, saved_path, size_bytes, hash_blake3
				 ) VALUES ('A.txt', 'C:\\Fuzzy\\Course\\A.txt', 1, 'b3:first')",
				[],
			)
			.unwrap();
		assert!(database
			.conn()
			.execute(
				"INSERT INTO files (
					original_name, saved_path, size_bytes, hash_blake3
				 ) VALUES ('a.txt', 'c:\\fuzzy\\course\\a.TXT', 1, 'b3:second')",
				[],
			)
			.is_err());

		let plan: String = database
			.conn()
			.query_row(
				"EXPLAIN QUERY PLAN
				 SELECT id FROM files
				 WHERE saved_path = 'c:\\fuzzy\\course\\a.txt' COLLATE NOCASE",
				[],
				|row| row.get(3),
			)
			.unwrap();
		assert!(plan.contains("sqlite_autoindex_files"), "{plan}");
	}

	#[cfg(windows)]
	#[test]
	fn windows_default_path_prefers_local_and_preserves_legacy_without_moving_it() {
		let nonce = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let directory = std::env::temp_dir().join(format!(
			"fuzzy-path-resolution-{}-{nonce}",
			std::process::id()
		));
		let local_root = directory.join("Local");
		let roaming_root = directory.join("Roaming");
		let local_path = local_root.join("Fuzzy").join("fuzzy.db");
		let legacy_path = roaming_root.join("Fuzzy").join("fuzzy.db");
		let override_path = directory.join("isolated-test.db");

		assert_eq!(
			resolve_windows_db_path(None, Some(local_root.clone()), Some(roaming_root.clone()))
				.unwrap(),
			local_path
		);
		assert_eq!(
			resolve_windows_db_path(
				Some(override_path.clone()),
				Some(local_root.clone()),
				Some(roaming_root.clone())
			)
			.unwrap(),
			override_path
		);

		std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
		std::fs::write(&legacy_path, b"legacy").unwrap();
		assert_eq!(
			resolve_windows_db_path(None, Some(local_root.clone()), Some(roaming_root.clone()))
				.unwrap(),
			legacy_path
		);
		assert!(legacy_path.exists());

		std::fs::create_dir_all(local_path.parent().unwrap()).unwrap();
		std::fs::write(&local_path, b"preferred").unwrap();
		assert_eq!(
			resolve_windows_db_path(None, Some(local_root), Some(roaming_root.clone())).unwrap(),
			local_path
		);
		assert_eq!(
			resolve_windows_db_path(None, None, Some(roaming_root)).unwrap(),
			legacy_path
		);

		let _ = std::fs::remove_dir_all(&directory);
	}

	#[test]
	fn schema_applied_creates_tables() {
		let database = Database::open_in_memory().unwrap();
		let count: i64 = database
			.conn()
			.query_row(
				"SELECT count(*) FROM sqlite_master WHERE type = 'table'
				 AND name IN (
					'app_settings',
					'courses',
					'files',
					'assignments',
					'extension_runtime_observations'
				 )",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(count, 5);
	}

	#[test]
	fn completed_schema_uses_current_version_and_enforces_duplicate_similarity() {
		let database = Database::open_in_memory().unwrap();
		assert_eq!(schema_version(database.conn()).unwrap(), SCHEMA_VERSION);
		database
			.conn()
			.execute_batch(
				"INSERT INTO files (
					id, original_name, saved_path, size_bytes, hash_blake3
				 ) VALUES (1, '資料.pdf', 'C:\\資料.pdf', 1, 'b3:test');
				 INSERT INTO duplicate_groups (id, method) VALUES (1, 'similar');
				 INSERT INTO duplicate_members (group_id, file_id, similarity)
				 VALUES (1, 1, 0.75);",
			)
			.unwrap();

		assert!(database
			.conn()
			.execute(
				"UPDATE duplicate_members SET similarity = 1.1 WHERE file_id = 1",
				[],
			)
			.is_err());
	}

	#[test]
	fn unsupported_schema_version_is_rejected() {
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			 PRAGMA user_version = 99;",
		)
		.unwrap();

		assert!(matches!(
			Database::from_connection(conn, None),
			Err(EngineError::Database { .. })
		));
	}

	#[test]
	fn nonempty_unversioned_database_is_rejected_without_changes() {
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
		)
		.unwrap();

		assert!(matches!(
			Database::from_connection(conn, None),
			Err(EngineError::Database { .. })
		));
	}

	#[test]
	fn declared_current_schema_with_missing_table_is_rejected() {
		let mut conn = Connection::open_in_memory().unwrap();
		apply_schema(&mut conn, SCHEMA_SQL).unwrap();
		conn.execute_batch("DROP TABLE notification_rules;")
			.unwrap();

		assert!(matches!(
			Database::from_connection(conn, None),
			Err(EngineError::Database { .. })
		));
	}

	#[test]
	fn declared_current_schema_with_missing_column_is_rejected() {
		let mut conn = Connection::open_in_memory().unwrap();
		let incomplete_schema = SCHEMA_SQL
			.lines()
			.filter(|line| !line.trim_start().starts_with("mime_type"))
			.collect::<Vec<_>>()
			.join("\n");
		apply_schema(&mut conn, &incomplete_schema).unwrap();

		assert!(matches!(
			Database::from_connection(conn, None),
			Err(EngineError::Database { .. })
		));
	}

	#[test]
	fn declared_current_schema_with_broken_foreign_key_is_rejected() {
		let mut conn = Connection::open_in_memory().unwrap();
		apply_schema(&mut conn, SCHEMA_SQL).unwrap();
		conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
		conn.execute(
			"INSERT INTO assignments (course_id, title, source)
			 VALUES (999, '孤立した課題', 'moodle_dashboard')",
			[],
		)
		.unwrap();

		assert!(matches!(
			Database::from_connection(conn, None),
			Err(EngineError::Database { .. })
		));
	}

	#[test]
	fn declared_current_schema_with_weakened_constraints_is_rejected() {
		let weakened_schemas = [
			SCHEMA_SQL.replace(
				"course_id        INTEGER REFERENCES courses(id) ON DELETE SET NULL,",
				"course_id        INTEGER,",
			),
			SCHEMA_SQL.replace(
				"saved_path       TEXT NOT NULL COLLATE NOCASE UNIQUE,",
				"saved_path       TEXT NOT NULL,",
			),
			SCHEMA_SQL.replace(
				"method     TEXT NOT NULL CHECK (method IN ('exact', 'similar')),",
				"method     TEXT NOT NULL,",
			),
		];
		for weakened_schema in weakened_schemas {
			assert_ne!(weakened_schema, SCHEMA_SQL);
			let mut conn = Connection::open_in_memory().unwrap();
			apply_schema(&mut conn, &weakened_schema).unwrap();
			assert!(matches!(
				Database::from_connection(conn, None),
				Err(EngineError::Database { .. })
			));
		}
	}

	#[test]
	fn pre_release_schema_generation_is_rejected() {
		let mut conn = Connection::open_in_memory().unwrap();
		apply_schema(&mut conn, SCHEMA_SQL).unwrap();
		conn.execute_batch("PRAGMA user_version = 2;").unwrap();

		assert!(matches!(
			Database::from_connection(conn, None),
			Err(EngineError::Database { .. })
		));
	}

	#[test]
	fn seed_loads_six_courses() {
		let database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		let courses: i64 = database
			.conn()
			.query_row("SELECT count(*) FROM courses", [], |row| row.get(0))
			.unwrap();
		assert_eq!(courses, 6);
	}

	#[test]
	fn open_is_idempotent_on_existing_database() {
		let directory = std::env::temp_dir().join(format!("fuzzy-db-test-{}", std::process::id()));
		let path = directory.join("fuzzy.db");
		let _ = std::fs::remove_dir_all(&directory);
		{
			let _first = Database::open(&path).unwrap();
		}
		let second = Database::open(&path).unwrap();
		let tables: i64 = second
			.conn()
			.query_row(
				"SELECT count(*) FROM sqlite_master
				 WHERE type = 'table' AND name = 'extension_runtime_observations'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(tables, 1);
		let _ = std::fs::remove_dir_all(&directory);
	}

	#[test]
	fn schema_failure_is_atomic() {
		let mut conn = Connection::open_in_memory().unwrap();
		let invalid_schema = "CREATE TABLE app_settings (key TEXT PRIMARY KEY);\nINVALID SQL;";
		assert!(apply_schema(&mut conn, invalid_schema).is_err());

		let tables: i64 = conn
			.query_row(
				"SELECT count(*) FROM sqlite_master
				 WHERE type = 'table' AND name = 'app_settings'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(tables, 0);
	}

	#[test]
	fn runtime_observation_preserves_first_seen_and_version_history() {
		let database = Database::open_in_memory().unwrap();
		let first = database
			.record_extension_runtime(&report("1.0.0", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();
		let repeated = database
			.record_extension_runtime(&report("1.0.0", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();
		let updated = database
			.record_extension_runtime(&report("1.1.0", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();

		assert_eq!(first.first_seen_at, repeated.first_seen_at);
		assert_eq!(first.installation_id, updated.installation_id);
		let versions: i64 = database
			.conn()
			.query_row(
				"SELECT count(*) FROM extension_runtime_observations",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(versions, 2);
	}

	#[test]
	fn setup_status_requires_a_new_compatible_observation() {
		let database = Database::open_in_memory().unwrap();
		let before = "2000-01-01T00:00:00.000Z";
		let future = "2999-01-01T00:00:00.000Z";

		assert_eq!(
			database.extension_setup_status_since(before).unwrap().state,
			ExtensionSetupState::Waiting
		);
		database
			.record_extension_runtime(&report("1.0.0", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();
		assert_eq!(
			database.extension_setup_status_since(before).unwrap().state,
			ExtensionSetupState::Ready
		);
		assert_eq!(
			database.extension_setup_status_since(future).unwrap().state,
			ExtensionSetupState::Waiting
		);
	}

	#[test]
	fn setup_status_reports_incompatible_version_or_protocol() {
		let database = Database::open_in_memory().unwrap();
		database
			.record_extension_runtime(&report("0.0.9", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();

		assert_eq!(
			database
				.extension_setup_status_since("2000-01-01T00:00:00.000Z")
				.unwrap()
				.state,
			ExtensionSetupState::Incompatible
		);

		database
			.record_extension_runtime(&report("2.0.0", EXTENSION_RUNTIME_PROTOCOL_VERSION - 1))
			.unwrap();

		assert_eq!(
			database
				.extension_setup_status_since("2000-01-01T00:00:00.000Z")
				.unwrap()
				.state,
			ExtensionSetupState::Incompatible
		);
	}

	#[test]
	fn separate_process_connections_share_runtime_observation() {
		let directory =
			std::env::temp_dir().join(format!("fuzzy-runtime-test-{}", std::process::id()));
		let path = directory.join("fuzzy.db");
		let _ = std::fs::remove_dir_all(&directory);

		let desktop_database = Database::open(&path).unwrap();
		let native_host_database = Database::open(&path).unwrap();
		native_host_database
			.record_extension_runtime(&report("1.0.0", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();

		assert_eq!(
			desktop_database
				.extension_setup_status_since("2000-01-01T00:00:00.000Z")
				.unwrap()
				.state,
			ExtensionSetupState::Ready
		);

		drop(native_host_database);
		drop(desktop_database);
		let _ = std::fs::remove_dir_all(&directory);
	}

	#[test]
	fn recovery_status_distinguishes_missing_recent_and_stale_observations() {
		let database = Database::open_in_memory().unwrap();
		assert_eq!(
			database.extension_recovery_status().unwrap().state,
			ExtensionRecoveryState::Missing
		);

		database
			.record_extension_runtime(&report("0.1.0", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();
		assert_eq!(
			database.extension_recovery_status().unwrap().state,
			ExtensionRecoveryState::Ready
		);

		database
			.conn()
			.execute(
				"UPDATE extension_runtime_observations
				 SET last_seen_at = '2000-01-01T00:00:00.000Z'",
				[],
			)
			.unwrap();
		assert_eq!(
			database.extension_recovery_status().unwrap().state,
			ExtensionRecoveryState::Stale
		);
	}

	#[test]
	fn recovery_status_rejects_old_extension_or_protocol_version() {
		let database = Database::open_in_memory().unwrap();
		database
			.record_extension_runtime(&report("0.0.9", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();
		assert_eq!(
			database.extension_recovery_status().unwrap().state,
			ExtensionRecoveryState::Incompatible
		);

		database
			.record_extension_runtime(&report("0.2.0", EXTENSION_RUNTIME_PROTOCOL_VERSION - 1))
			.unwrap();
		assert_eq!(
			database.extension_recovery_status().unwrap().state,
			ExtensionRecoveryState::Incompatible
		);
	}

	#[test]
	fn compatible_update_or_reinstall_returns_recovery_to_ready() {
		let database = Database::open_in_memory().unwrap();
		database
			.record_extension_runtime(&report("0.0.9", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();

		let mut updated = report("0.2.0", EXTENSION_RUNTIME_PROTOCOL_VERSION);
		database.record_extension_runtime(&updated).unwrap();
		assert_eq!(
			database.extension_recovery_status().unwrap().state,
			ExtensionRecoveryState::Ready
		);

		updated.installation_id = "replacement-installation".to_string();
		database.record_extension_runtime(&updated).unwrap();
		let status = database.extension_recovery_status().unwrap();
		assert_eq!(status.state, ExtensionRecoveryState::Ready);
		assert_eq!(
			status.observation.unwrap().installation_id,
			"replacement-installation"
		);
	}

	#[test]
	fn recent_compatible_observation_wins_across_installations() {
		let database = Database::open_in_memory().unwrap();
		database
			.record_extension_runtime(&report("0.1.0", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();
		let mut incompatible = report("0.0.9", EXTENSION_RUNTIME_PROTOCOL_VERSION);
		incompatible.installation_id = "other-browser-installation".to_string();
		database.record_extension_runtime(&incompatible).unwrap();

		let status = database.extension_recovery_status().unwrap();
		assert_eq!(status.state, ExtensionRecoveryState::Ready);
		assert_eq!(status.observation.unwrap().extension_version, "0.1.0");
	}

	#[test]
	fn latest_observation_supersedes_older_version_for_the_same_installation() {
		let database = Database::open_in_memory().unwrap();
		database
			.record_extension_runtime(&report("0.1.0", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();
		database
			.record_extension_runtime(&report("0.0.9", EXTENSION_RUNTIME_PROTOCOL_VERSION))
			.unwrap();

		let status = database.extension_recovery_status().unwrap();
		assert_eq!(status.state, ExtensionRecoveryState::Incompatible);
		assert_eq!(status.observation.unwrap().extension_version, "0.0.9");
	}

	#[test]
	fn detects_only_active_indexable_documents_without_search_metadata() {
		let database = Database::open_in_memory().unwrap();
		assert!(!database.has_unindexed_active_documents().unwrap());
		assert!(!database.has_indexed_active_documents().unwrap());
		database
			.conn()
			.execute_batch(
				"INSERT INTO files (
					id, original_name, saved_path, size_bytes, hash_blake3
				 ) VALUES
					(41, '第4回_正規化.pdf', '資料/第4回_正規化.pdf', 1, 'hash-41'),
					(42, 'ER図.png', '資料/ER図.png', 1, 'hash-42'),
					(43, '旧資料.txt', '資料/旧資料.txt', 1, 'hash-43');
				 UPDATE files SET missing_at = datetime('now') WHERE id = 43;",
			)
			.unwrap();

		assert!(database.has_unindexed_active_documents().unwrap());
		database.mark_search_indexed(41, Some(2)).unwrap();
		assert!(!database.has_unindexed_active_documents().unwrap());
		assert!(database.has_indexed_active_documents().unwrap());

		database.remove_search_index_meta(41).unwrap();
		assert!(database.has_unindexed_active_documents().unwrap());
		assert!(!database.has_indexed_active_documents().unwrap());
		database.mark_search_indexed(41, Some(2)).unwrap();
		database
			.conn()
			.execute(
				"UPDATE files SET missing_at = datetime('now') WHERE id = 41",
				[],
			)
			.unwrap();
		assert!(!database.has_unindexed_active_documents().unwrap());
		assert!(!database.has_indexed_active_documents().unwrap());
	}

	#[test]
	fn export_and_import_preserve_data_but_invalidate_search_metadata() {
		use crate::index::{DefaultIndexEngine, IndexEngine};

		let directory =
			std::env::temp_dir().join(format!("fuzzy-backup-test-{}", std::process::id()));
		let source_path = directory.join("source.db");
		let backup_path = directory.join("backup.db");
		let target_path = directory.join("target.db");
		let _ = std::fs::remove_dir_all(&directory);

		let source = Database::open(&source_path).unwrap();
		source
			.conn()
			.execute(
				"INSERT INTO files (
					id, original_name, saved_path, size_bytes, hash_blake3
				 ) VALUES (41, '第4回_正規化.pdf', '資料\\第4回_正規化.pdf', 1, 'hash-41')",
				[],
			)
			.unwrap();
		source.mark_search_indexed(41, Some(12)).unwrap();
		source.export_to(&backup_path).unwrap();

		let mut target = Database::open(&target_path).unwrap();
		target.import_from(&backup_path).unwrap();

		let file_name: String = target
			.conn()
			.query_row("SELECT original_name FROM files WHERE id = 41", [], |row| {
				row.get(0)
			})
			.unwrap();
		let indexed_count: i64 = target
			.conn()
			.query_row("SELECT count(*) FROM search_index_meta", [], |row| {
				row.get(0)
			})
			.unwrap();
		assert_eq!(file_name, "第4回_正規化.pdf");
		assert_eq!(indexed_count, 0);

		let restored_document = directory.join("第4回_正規化.txt");
		std::fs::write(&restored_document, "第3正規化と更新異常").unwrap();
		target
			.conn()
			.execute(
				"UPDATE files SET original_name = ?1, saved_path = ?2 WHERE id = 41",
				params![
					"第4回_正規化.txt",
					restored_document.to_string_lossy().as_ref()
				],
			)
			.unwrap();
		let mut index = DefaultIndexEngine::open(&directory.join("search-index")).unwrap();
		index.index_file(&target, 41, &restored_document).unwrap();
		assert_eq!(index.search("正規化", 10).unwrap()[0].file_id, 41);
		let rebuilt_count: i64 = target
			.conn()
			.query_row("SELECT count(*) FROM search_index_meta", [], |row| {
				row.get(0)
			})
			.unwrap();
		assert_eq!(rebuilt_count, 1);

		drop(index);
		drop(target);
		drop(source);
		let _ = std::fs::remove_dir_all(&directory);
	}

	#[test]
	fn failed_restore_keeps_current_database_usable_and_unchanged() {
		let directory =
			std::env::temp_dir().join(format!("fuzzy-busy-import-{}", std::process::id()));
		let source_path = directory.join("source.db");
		let backup_path = directory.join("backup.db");
		let target_path = directory.join("target.db");
		let _ = std::fs::remove_dir_all(&directory);

		let source = Database::open(&source_path).unwrap();
		source
			.conn()
			.execute(
				"INSERT INTO app_settings (key, value) VALUES ('imported', 'yes')",
				[],
			)
			.unwrap();
		source.export_to(&backup_path).unwrap();
		drop(source);

		let mut target = Database::open(&target_path).unwrap();
		target
			.conn()
			.execute(
				"INSERT INTO app_settings (key, value) VALUES ('marker', 'preserved')",
				[],
			)
			.unwrap();
		let blocker = Connection::open(&target_path).unwrap();
		blocker.execute_batch("BEGIN EXCLUSIVE;").unwrap();

		assert!(target.import_from(&backup_path).is_err());
		blocker.execute_batch("ROLLBACK;").unwrap();
		let marker: String = target
			.conn()
			.query_row(
				"SELECT value FROM app_settings WHERE key = 'marker'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		let imported = target
			.conn()
			.query_row(
				"SELECT value FROM app_settings WHERE key = 'imported'",
				[],
				|row| row.get::<_, String>(0),
			)
			.optional()
			.unwrap();
		assert_eq!(marker, "preserved");
		assert_eq!(imported, None);

		drop(blocker);
		drop(target);
		let reopened = Database::open(&target_path).unwrap();
		let reopened_marker: String = reopened
			.conn()
			.query_row(
				"SELECT value FROM app_settings WHERE key = 'marker'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(reopened_marker, "preserved");
		drop(reopened);
		let _ = std::fs::remove_dir_all(&directory);
	}

	#[test]
	fn import_rejects_non_fuzzy_database_without_changing_current_data() {
		let directory =
			std::env::temp_dir().join(format!("fuzzy-invalid-import-{}", std::process::id()));
		let target_path = directory.join("target.db");
		let invalid_path = directory.join("invalid.db");
		let _ = std::fs::remove_dir_all(&directory);
		std::fs::create_dir_all(&directory).unwrap();
		Connection::open(&invalid_path)
			.unwrap()
			.execute("CREATE TABLE unrelated (id INTEGER)", [])
			.unwrap();
		let mut target = Database::open(&target_path).unwrap();
		target
			.conn()
			.execute(
				"INSERT INTO app_settings (key, value) VALUES ('marker', 'preserved')",
				[],
			)
			.unwrap();

		assert!(target.import_from(&invalid_path).is_err());
		let marker: String = target
			.conn()
			.query_row(
				"SELECT value FROM app_settings WHERE key = 'marker'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(marker, "preserved");
		drop(target);
		let _ = std::fs::remove_dir_all(&directory);
	}

	#[test]
	fn import_rejects_incomplete_fuzzy_schema_without_changing_current_data() {
		let directory =
			std::env::temp_dir().join(format!("fuzzy-incomplete-import-{}", std::process::id()));
		let target_path = directory.join("target.db");
		let incomplete_path = directory.join("incomplete.db");
		let _ = std::fs::remove_dir_all(&directory);
		std::fs::create_dir_all(&directory).unwrap();
		let mut incomplete = Connection::open(&incomplete_path).unwrap();
		apply_schema(&mut incomplete, SCHEMA_SQL).unwrap();
		incomplete
			.execute_batch("DROP TABLE notification_rules;")
			.unwrap();
		drop(incomplete);

		let mut target = Database::open(&target_path).unwrap();
		target
			.conn()
			.execute(
				"INSERT INTO app_settings (key, value) VALUES ('marker', 'preserved')",
				[],
			)
			.unwrap();

		assert!(target.import_from(&incomplete_path).is_err());
		let marker: String = target
			.conn()
			.query_row(
				"SELECT value FROM app_settings WHERE key = 'marker'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(marker, "preserved");
		drop(target);
		let _ = std::fs::remove_dir_all(&directory);
	}

	#[test]
	fn import_rejects_foreign_key_violation_without_changing_current_data() {
		let directory =
			std::env::temp_dir().join(format!("fuzzy-fk-import-{}", std::process::id()));
		let target_path = directory.join("target.db");
		let invalid_path = directory.join("invalid.db");
		let _ = std::fs::remove_dir_all(&directory);
		std::fs::create_dir_all(&directory).unwrap();
		let mut invalid = Connection::open(&invalid_path).unwrap();
		apply_schema(&mut invalid, SCHEMA_SQL).unwrap();
		invalid.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
		invalid
			.execute(
				"INSERT INTO assignments (course_id, title, source)
				 VALUES (999, '孤立した課題', 'moodle_dashboard')",
				[],
			)
			.unwrap();
		drop(invalid);

		let mut target = Database::open(&target_path).unwrap();
		target
			.conn()
			.execute(
				"INSERT INTO app_settings (key, value) VALUES ('marker', 'preserved')",
				[],
			)
			.unwrap();

		assert!(target.import_from(&invalid_path).is_err());
		let marker: String = target
			.conn()
			.query_row(
				"SELECT value FROM app_settings WHERE key = 'marker'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(marker, "preserved");
		drop(target);
		let _ = std::fs::remove_dir_all(&directory);
	}

	#[test]
	fn import_rejects_unsupported_schema_version_without_changing_current_data() {
		let directory =
			std::env::temp_dir().join(format!("fuzzy-version-import-{}", std::process::id()));
		let target_path = directory.join("target.db");
		let invalid_path = directory.join("invalid.db");
		let _ = std::fs::remove_dir_all(&directory);
		std::fs::create_dir_all(&directory).unwrap();
		let mut invalid = Connection::open(&invalid_path).unwrap();
		apply_schema(&mut invalid, SCHEMA_SQL).unwrap();
		invalid.execute_batch("PRAGMA user_version = 99;").unwrap();
		drop(invalid);

		let mut target = Database::open(&target_path).unwrap();
		target
			.conn()
			.execute(
				"INSERT INTO app_settings (key, value) VALUES ('marker', 'preserved')",
				[],
			)
			.unwrap();

		assert!(target.import_from(&invalid_path).is_err());
		let marker: String = target
			.conn()
			.query_row(
				"SELECT value FROM app_settings WHERE key = 'marker'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(marker, "preserved");
		drop(target);
		let _ = std::fs::remove_dir_all(&directory);
	}
}
