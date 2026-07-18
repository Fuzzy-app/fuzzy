//! SQLite接続とスキーマ適用（issue #36）。
//!
//! native-host起動時にDBへ接続し、必要ならスキーマ（[`engine_core::SCHEMA_SQL`]）を
//! 適用する。ここで開くSQLiteが正本（source of truth）であり、接続直後に必ず
//! `PRAGMA foreign_keys = ON;` を実行する（docs/データベース設計.md）。

use std::path::{Path, PathBuf};

use engine_core::{EngineError, EngineResult, SCHEMA_SQL};
use rusqlite::Connection;

/// DBファイルパスのオーバーライドに使う環境変数。
/// 設定ファイル相当の指定手段で、開発・テスト・seed投入時に用いる。
const DB_PATH_ENV: &str = "FUZZY_DB_PATH";
const SCHEMA_VERSION: i64 = 1;

// v0からv1: duplicate_members.similarityへ0.0〜1.0のCHECK制約を追加する。
// SQLiteは既存列へCHECKを追加できないため、トランザクション内でテーブルを再構築する。
const MIGRATION_TO_V1_SQL: &str = r#"
ALTER TABLE duplicate_members RENAME TO duplicate_members_v0;
CREATE TABLE duplicate_members (
	group_id   INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
	file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	similarity REAL NOT NULL DEFAULT 1.0 CHECK (similarity BETWEEN 0.0 AND 1.0),
	PRIMARY KEY (group_id, file_id)
);
INSERT INTO duplicate_members (group_id, file_id, similarity)
	SELECT group_id, file_id, similarity FROM duplicate_members_v0;
DROP TABLE duplicate_members_v0;
PRAGMA user_version = 1;
"#;

/// SQLite接続のラッパ。接続時にFK有効化とスキーマ適用を保証する。
pub struct Db {
	// issue #37 以降のコマンド実装で参照する（現状は接続保持のみ）。
	#[allow(dead_code)]
	conn: Connection,
}

impl Db {
	/// 既定のパス（[`resolve_db_path`]）でDBを開く。
	pub fn open_default() -> EngineResult<Self> {
		Self::open(&resolve_db_path()?)
	}

	/// 指定パスのDBを開く。親ディレクトリが無ければ作成し、
	/// `PRAGMA foreign_keys = ON;` を実行、スキーマ未適用なら適用する。
	pub fn open(path: &Path) -> EngineResult<Self> {
		if let Some(parent) = path.parent() {
			if !parent.as_os_str().is_empty() {
				std::fs::create_dir_all(parent)?;
			}
		}
		let conn = Connection::open(path).map_err(db_err)?;
		Self::from_connection(conn)
	}

	/// メモリ上のDBを開く（テスト・一時利用）。
	#[cfg(test)]
	pub fn open_in_memory() -> EngineResult<Self> {
		let conn = Connection::open_in_memory().map_err(db_err)?;
		Self::from_connection(conn)
	}

	/// 既存の[`Connection`]からDbを構成する（ファイル／メモリで共通の初期化）。
	fn from_connection(mut conn: Connection) -> EngineResult<Self> {
		// 接続直後に必ずFK制約を有効化する（データベース設計.md）。
		conn.execute_batch("PRAGMA foreign_keys = ON;")
			.map_err(db_err)?;
		if !schema_applied(&conn)? {
			apply_schema(&mut conn, SCHEMA_SQL)?;
		}
		migrate_schema(&mut conn)?;
		Ok(Self { conn })
	}

	/// 内部の[`Connection`]への参照を返す（コマンド実装で使用: issue #37以降）。
	#[allow(dead_code)]
	pub fn conn(&self) -> &Connection {
		&self.conn
	}
}

/// スキーマが既に適用済みか（`app_settings` テーブルの有無で判定）。
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

/// DDL全体を1トランザクションで適用する。
///
/// スキーマ適用の途中で失敗しても、`app_settings` だけが作成されたような
/// 部分適用状態を残さない。部分適用が残ると、次回起動時に
/// [`schema_applied`] が誤って適用済みと判断してしまうためである。
fn apply_schema(conn: &mut Connection, schema_sql: &str) -> EngineResult<()> {
	let tx = conn.transaction().map_err(db_err)?;
	tx.execute_batch(schema_sql).map_err(db_err)?;
	tx.commit().map_err(db_err)
}

/// 既存DBを現在のスキーマへ段階的に移行する。
fn migrate_schema(conn: &mut Connection) -> EngineResult<()> {
	let version: i64 = conn
		.query_row("PRAGMA user_version", [], |row| row.get(0))
		.map_err(db_err)?;
	if version > SCHEMA_VERSION {
		return Err(EngineError::Database {
			message: format!(
				"DBスキーマのバージョン{version}は、このアプリが対応する{SCHEMA_VERSION}より新しいです"
			),
		});
	}
	if version < 1 {
		let invalid_count: i64 = conn
			.query_row(
				"SELECT count(*) FROM duplicate_members WHERE similarity < 0.0 OR similarity > 1.0",
				[],
				|row| row.get(0),
			)
			.map_err(db_err)?;
		if invalid_count > 0 {
			return Err(EngineError::Database {
				message: "重複候補に0.0〜1.0の範囲外の類似度があるため、DBを移行できません"
					.to_string(),
			});
		}

		let tx = conn.transaction().map_err(db_err)?;
		tx.execute_batch(MIGRATION_TO_V1_SQL).map_err(db_err)?;
		tx.commit().map_err(db_err)?;
	}
	Ok(())
}

/// DBファイルの実パスを決定する。
///
/// 1. 環境変数 `FUZZY_DB_PATH`（設定ファイル相当のオーバーライド）
/// 2. OSのデータディレクトリ配下 `Fuzzy/fuzzy.db`
///    （Windows: `%APPDATA%`、Unix: `$XDG_DATA_HOME` か `$HOME/.local/share`）
///
/// `base_folder_path` 等の設定値は `app_settings`（DB内）に持つが、DBファイル自体の
/// 場所はDBを開く前に決める必要があるため本関数が担う。
pub fn resolve_db_path() -> EngineResult<PathBuf> {
	if let Some(p) = std::env::var_os(DB_PATH_ENV) {
		return Ok(PathBuf::from(p));
	}
	Ok(data_dir()?.join("Fuzzy").join("fuzzy.db"))
}

/// OSごとのアプリデータ用ディレクトリ。
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

/// rusqliteのエラーを [`EngineError::Database`] に変換する。
fn db_err(e: rusqlite::Error) -> EngineError {
	EngineError::Database {
		message: e.to_string(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use engine_core::SEED_SQL;

	/// 接続直後にFK制約が有効化されていること。
	#[test]
	fn foreign_keys_enabled_after_open() {
		let db = Db::open_in_memory().unwrap();
		let on: i64 = db
			.conn()
			.query_row("PRAGMA foreign_keys", [], |r| r.get(0))
			.unwrap();
		assert_eq!(on, 1);
	}

	/// スキーマ適用で主要テーブルが作成されること。
	#[test]
	fn schema_applied_creates_tables() {
		let db = Db::open_in_memory().unwrap();
		let n: i64 = db
			.conn()
			.query_row(
				"SELECT count(*) FROM sqlite_master WHERE type = 'table' \
				 AND name IN ('app_settings', 'courses', 'files', 'assignments')",
				[],
				|r| r.get(0),
			)
			.unwrap();
		assert_eq!(n, 4);
	}

	/// seed（FK制約下）が投入でき、6科目が読めること。
	#[test]
	fn seed_loads_six_courses() {
		let db = Db::open_in_memory().unwrap();
		db.conn().execute_batch(SEED_SQL).unwrap();
		let courses: i64 = db
			.conn()
			.query_row("SELECT count(*) FROM courses", [], |r| r.get(0))
			.unwrap();
		assert_eq!(courses, 6);
	}

	/// duplicate_membersの類似度はAPI契約と同じ0.0〜1.0に限定されること。
	#[test]
	fn duplicate_similarity_rejects_out_of_range_values() {
		let db = Db::open_in_memory().unwrap();
		db.conn().execute_batch(SEED_SQL).unwrap();
		db.conn()
			.execute(
				"INSERT INTO duplicate_groups (id, method) VALUES (2, 'similar')",
				[],
			)
			.unwrap();

		for similarity in [-0.01, 1.01] {
			let result = db.conn().execute(
				"INSERT INTO duplicate_members (group_id, file_id, similarity) VALUES (2, 1, ?1)",
				[similarity],
			);
			assert!(
				result.is_err(),
				"範囲外の類似度 {similarity} が拒否されること"
			);
		}

		for similarity in [0.0, 1.0] {
			db.conn()
				.execute(
					"INSERT OR REPLACE INTO duplicate_members (group_id, file_id, similarity) VALUES (2, 1, ?1)",
					[similarity],
				)
				.unwrap();
		}
	}

	/// v0の既存DBにも起動時マイグレーションで類似度制約が追加されること。
	#[test]
	fn existing_v0_database_is_migrated_to_similarity_constraint() {
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(&legacy_schema_sql()).unwrap();
		conn.execute_batch(SEED_SQL).unwrap();

		let db = Db::from_connection(conn).unwrap();
		let version: i64 = db
			.conn()
			.query_row("PRAGMA user_version", [], |row| row.get(0))
			.unwrap();
		assert_eq!(version, SCHEMA_VERSION);
		db.conn()
			.execute(
				"INSERT INTO duplicate_groups (id, method) VALUES (2, 'similar')",
				[],
			)
			.unwrap();
		assert!(db
			.conn()
			.execute(
				"INSERT INTO duplicate_members (group_id, file_id, similarity) VALUES (2, 1, 1.01)",
				[],
			)
			.is_err());
	}

	/// 不正な既存値がある場合はデータを変更せず、移行全体を中止すること。
	#[test]
	fn migration_preserves_out_of_range_legacy_data_on_failure() {
		let mut conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(&legacy_schema_sql()).unwrap();
		conn.execute_batch(SEED_SQL).unwrap();
		conn.execute_batch(
			"INSERT INTO duplicate_groups (id, method) VALUES (2, 'similar');
			 INSERT INTO duplicate_members (group_id, file_id, similarity) VALUES (2, 1, 1.2);",
		)
		.unwrap();

		assert!(migrate_schema(&mut conn).is_err());
		let similarity: f64 = conn
			.query_row(
				"SELECT similarity FROM duplicate_members WHERE group_id = 2 AND file_id = 1",
				[],
				|row| row.get(0),
			)
			.unwrap();
		let version: i64 = conn
			.query_row("PRAGMA user_version", [], |row| row.get(0))
			.unwrap();
		assert_eq!(similarity, 1.2);
		assert_eq!(version, 0);
	}

	/// 既存DBを再度openしてもスキーマを二重適用せず壊れないこと（冪等）。
	#[test]
	fn open_is_idempotent_on_existing_db() {
		let dir = std::env::temp_dir().join(format!("fuzzy-db-test-{}", std::process::id()));
		let path = dir.join("fuzzy.db");
		let _ = std::fs::remove_dir_all(&dir);
		{
			let _first = Db::open(&path).unwrap();
		}
		// 2回目: schema_applied=true になり再適用されない（再適用ならテーブル重複でエラー）。
		let second = Db::open(&path).unwrap();
		let tables: i64 = second
			.conn()
			.query_row(
				"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
				[],
				|r| r.get(0),
			)
			.unwrap();
		assert_eq!(tables, 1);
		let _ = std::fs::remove_dir_all(&dir);
	}

	/// DDL途中の失敗では、先行するDDLもロールバックされること。
	#[test]
	fn schema_failure_is_atomic() {
		let mut conn = Connection::open_in_memory().unwrap();
		let invalid_schema = "CREATE TABLE app_settings (key TEXT PRIMARY KEY);\nINVALID SQL;";
		assert!(apply_schema(&mut conn, invalid_schema).is_err());

		let tables: i64 = conn
			.query_row(
				"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
				[],
				|r| r.get(0),
			)
			.unwrap();
		assert_eq!(tables, 0);
	}

	fn legacy_schema_sql() -> String {
		SCHEMA_SQL
			.replace(" CHECK (similarity BETWEEN 0.0 AND 1.0)", "")
			.replace("PRAGMA user_version = 1;", "PRAGMA user_version = 0;")
	}
}
