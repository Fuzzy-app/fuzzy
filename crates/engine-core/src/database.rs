//! Tauriとnative-hostが共有するSQLite接続・永続化層。
//!
//! 同じDBパス解決、外部キー設定、スキーマ適用、マイグレーションを両プロセスで
//! 使用し、SQLiteを唯一の正本として扱う。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

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
mod notifications;
mod rules;
mod saved_files;
mod sync;

/// DBファイルパスのオーバーライドに使う環境変数。
const DB_PATH_ENV: &str = "FUZZY_DB_PATH";
const SCHEMA_VERSION: i64 = 3;
const EXTENSION_RUNTIME_MIGRATION_SQL: &str =
	include_str!("../fixtures/migrations/0001_extension_runtime_observations.sql");
const COURSE_FOLDER_NAMES_MIGRATION_SQL: &str =
	include_str!("../fixtures/migrations/0002_course_folder_names.sql");
const ASSIGNMENT_SYNC_MIGRATION_SQL: &str =
	include_str!("../fixtures/migrations/0003_assignment_sync.sql");

/// SQLite接続。接続時にFK有効化、スキーマ適用、マイグレーションを保証する。
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

		if !schema_applied(&conn)? {
			apply_schema(&mut conn, SCHEMA_SQL)?;
		}

		let version = schema_version(&conn)?;
		if version > SCHEMA_VERSION {
			return Err(EngineError::Database {
				message: format!(
					"未対応のSQLiteスキーマ世代です（対応上限: {SCHEMA_VERSION}, 実際: {version}）。新しいバージョンのFuzzyで作成されたDBか確認してください"
				),
			});
		}

		// schema.sql適用済みの既存DBにも新しいテーブルを追加する。
		conn.execute_batch(EXTENSION_RUNTIME_MIGRATION_SQL)
			.map_err(db_err)?;
		if table_exists(&conn, "courses")? && schema_version(&conn)? < 2 {
			let has_academic_year = column_exists(&conn, "courses", "academic_year")?;
			let has_folder_name_override = column_exists(&conn, "courses", "folder_name_override")?;
			match (has_academic_year, has_folder_name_override) {
				(false, false) => apply_schema(&mut conn, COURSE_FOLDER_NAMES_MIGRATION_SQL)?,
				(true, true) => conn
					.execute_batch("PRAGMA user_version = 2;")
					.map_err(db_err)?,
				_ => {
					return Err(EngineError::Database {
						message: "coursesテーブルの移行状態が不完全なため、安全に更新できません"
							.to_string(),
					});
				}
			}
		}
		if table_exists(&conn, "assignments")? && schema_version(&conn)? < 3 {
			apply_schema(&mut conn, ASSIGNMENT_SYNC_MIGRATION_SQL)?;
		}

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
				 WHERE files.id = ?1",
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

fn schema_applied(conn: &Connection) -> EngineResult<bool> {
	table_exists(conn, "app_settings")
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

fn apply_schema(conn: &mut Connection, schema_sql: &str) -> EngineResult<()> {
	let transaction = conn.transaction().map_err(db_err)?;
	transaction.execute_batch(schema_sql).map_err(db_err)?;
	transaction.commit().map_err(db_err)
}

/// DBファイルの実パスを決定する。
///
/// 1. 環境変数 `FUZZY_DB_PATH`
/// 2. OSのデータディレクトリ配下 `Fuzzy/fuzzy.db`
pub fn resolve_db_path() -> EngineResult<PathBuf> {
	if let Some(path) = std::env::var_os(DB_PATH_ENV) {
		return Ok(PathBuf::from(path));
	}
	Ok(data_dir()?.join("Fuzzy").join("fuzzy.db"))
}

fn data_dir() -> EngineResult<PathBuf> {
	#[cfg(windows)]
	{
		if let Some(appdata) = std::env::var_os("APPDATA") {
			return Ok(PathBuf::from(appdata));
		}
	}
	#[cfg(not(windows))]
	{
		if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
			return Ok(PathBuf::from(xdg));
		}
		if let Some(home) = std::env::var_os("HOME") {
			return Ok(PathBuf::from(home).join(".local").join("share"));
		}
	}
	Err(EngineError::Internal {
		message: "アプリデータディレクトリを決定できません（APPDATA/HOME 未設定）".to_string(),
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
	fn migration_adds_extension_table_to_existing_database() {
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
		)
		.unwrap();

		let database = Database::from_connection(conn, None).unwrap();
		let count: i64 = database
			.conn()
			.query_row(
				"SELECT count(*) FROM sqlite_master
				 WHERE type = 'table' AND name = 'extension_runtime_observations'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(count, 1);
	}

	#[test]
	fn migration_adds_course_folder_fields_and_backfills_academic_year() {
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			 CREATE TABLE courses (
				id INTEGER PRIMARY KEY,
				moodle_course_id TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				term TEXT
			 );
			 INSERT INTO courses (id, moodle_course_id, name, term)
			 VALUES (1, 'course-db', 'データベース', '2026前期');
			 PRAGMA user_version = 1;",
		)
		.unwrap();

		let database = Database::from_connection(conn, None).unwrap();
		let values: (Option<i64>, Option<String>) = database
			.conn()
			.query_row(
				"SELECT academic_year, folder_name_override FROM courses WHERE id = 1",
				[],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();

		assert_eq!(values, (Some(2026), None));
		assert_eq!(schema_version(database.conn()).unwrap(), 2);
	}

	#[test]
	fn migration_accepts_version_one_database_that_already_has_course_folder_fields() {
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			 CREATE TABLE courses (
				id INTEGER PRIMARY KEY,
				moodle_course_id TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				academic_year INTEGER,
				term TEXT,
				folder_name_override TEXT
			 );
			 PRAGMA user_version = 1;",
		)
		.unwrap();

		let database = Database::from_connection(conn, None).unwrap();
		assert_eq!(schema_version(database.conn()).unwrap(), 2);
	}

	#[test]
	fn version_two_database_is_migrated_without_losing_assignments() {
		let mut conn = Connection::open_in_memory().unwrap();
		let version_two_schema = SCHEMA_SQL
			.lines()
			.filter(|line| !line.contains("removed_at") && !line.contains("idx_assignments_active"))
			.collect::<Vec<_>>()
			.join("\n")
			.replace("PRAGMA user_version = 3;", "PRAGMA user_version = 2;");
		apply_schema(&mut conn, &version_two_schema).unwrap();
		conn.execute_batch(
			"INSERT INTO courses (id, moodle_course_id, name) VALUES (1, 'course-1', 'Course');
			 INSERT INTO assignments (id, course_id, title, source)
			 VALUES (1, 1, 'Task', 'moodle_dashboard');",
		)
		.unwrap();

		let database = Database::from_connection(conn, None).unwrap();
		assert_eq!(schema_version(database.conn()).unwrap(), SCHEMA_VERSION);
		let assignment: (String, Option<String>) = database
			.conn()
			.query_row(
				"SELECT title, removed_at FROM assignments WHERE id = 1",
				[],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(assignment, ("Task".to_string(), None));
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
}
