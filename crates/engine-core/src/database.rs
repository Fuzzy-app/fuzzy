//! Tauriとnative-hostが共有するSQLite接続・永続化層。
//!
//! 同じDBパス解決、外部キー設定、スキーマ適用、マイグレーションを両プロセスで
//! 使用し、SQLiteを唯一の正本として扱う。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::{
	EngineError, EngineResult, ExtensionRuntimeObservation, ExtensionRuntimeReport,
	ExtensionSetupState, ExtensionSetupStatus, EXTENSION_RUNTIME_PROTOCOL_VERSION, SCHEMA_SQL,
};

mod rules;

/// DBファイルパスのオーバーライドに使う環境変数。
const DB_PATH_ENV: &str = "FUZZY_DB_PATH";
const EXTENSION_RUNTIME_MIGRATION_SQL: &str =
	include_str!("../fixtures/migrations/0001_extension_runtime_observations.sql");

/// SQLite接続。接続時にFK有効化、スキーマ適用、マイグレーションを保証する。
pub struct Database {
	conn: Connection,
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
		Self::from_connection(conn)
	}

	/// メモリ上のDBを開く。
	pub fn open_in_memory() -> EngineResult<Self> {
		let conn = Connection::open_in_memory().map_err(db_err)?;
		Self::from_connection(conn)
	}

	fn from_connection(mut conn: Connection) -> EngineResult<Self> {
		conn.execute_batch(
			"PRAGMA foreign_keys = ON;
			 PRAGMA busy_timeout = 5000;",
		)
		.map_err(db_err)?;

		if !schema_applied(&conn)? {
			apply_schema(&mut conn, SCHEMA_SQL)?;
		}

		// schema.sql適用済みの既存DBにも新しいテーブルを追加する。
		conn.execute_batch(EXTENSION_RUNTIME_MIGRATION_SQL)
			.map_err(db_err)?;

		Ok(Self { conn })
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
		let state = if observation.protocol_version == EXTENSION_RUNTIME_PROTOCOL_VERSION {
			ExtensionSetupState::Ready
		} else {
			ExtensionSetupState::Incompatible
		};

		Ok(ExtensionSetupStatus {
			state,
			observation: Some(observation),
		})
	}

	/// 内部接続への参照。DB実装の結合テストで使用する。
	#[cfg(test)]
	fn conn(&self) -> &Connection {
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

fn schema_applied(conn: &Connection) -> EngineResult<bool> {
	let count: i64 = conn
		.query_row(
			"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
			[],
			|row| row.get(0),
		)
		.map_err(db_err)?;
	Ok(count > 0)
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
	fn migration_adds_extension_table_to_existing_database() {
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
		)
		.unwrap();

		let database = Database::from_connection(conn).unwrap();
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
			.record_extension_runtime(&report("1.0.0", 1))
			.unwrap();
		let repeated = database
			.record_extension_runtime(&report("1.0.0", 1))
			.unwrap();
		let updated = database
			.record_extension_runtime(&report("1.1.0", 1))
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
			.record_extension_runtime(&report("1.0.0", 1))
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
	fn setup_status_reports_incompatible_protocol() {
		let database = Database::open_in_memory().unwrap();
		database
			.record_extension_runtime(&report("2.0.0", 99))
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
			.record_extension_runtime(&report("1.0.0", 1))
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
}
