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
	fn from_connection(conn: Connection) -> EngineResult<Self> {
		// 接続直後に必ずFK制約を有効化する（データベース設計.md）。
		conn.execute_batch("PRAGMA foreign_keys = ON;")
			.map_err(db_err)?;
		if !schema_applied(&conn)? {
			conn.execute_batch(SCHEMA_SQL).map_err(db_err)?;
		}
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
}
