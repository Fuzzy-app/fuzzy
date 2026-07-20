//! エンジン共通のエラー型。
//!
//! docs/api/contract.md のエラーコード（INVALID_PATH / DB_ERROR / INDEX_ERROR / INTERNAL 等）へ
//! 変換しやすい粒度で定義する。Phase0 では最小限とし、実装が進むにつれ追加する。

use std::fmt;

/// エンジン共通の結果型。
pub type EngineResult<T> = Result<T, EngineError>;

/// エンジン共通のエラー。
#[derive(Debug)]
pub enum EngineError {
	/// API入力の形式・値が契約を満たさない。
	InvalidInput { field: String, reason: String },
	/// 指定パスが存在しない・アクセスできない等。
	InvalidPath { path: String, reason: String },
	/// ファイルI/Oエラー。
	Io(std::io::Error),
	/// SQLite等の永続化層のエラー。
	Database { message: String },
	/// Tantivy索引の構築・検索エラー。
	Index { message: String },
	/// その他の内部エラー。
	Internal { message: String },
}

impl fmt::Display for EngineError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::InvalidInput { field, reason } => {
				write!(f, "入力値 '{field}' が不正です: {reason}")
			}
			Self::InvalidPath { path, reason } => {
				write!(f, "無効なパス '{path}': {reason}")
			}
			Self::Io(e) => write!(f, "I/Oエラー: {e}"),
			Self::Database { message } => write!(f, "DBエラー: {message}"),
			Self::Index { message } => write!(f, "索引エラー: {message}"),
			Self::Internal { message } => write!(f, "内部エラー: {message}"),
		}
	}
}

impl std::error::Error for EngineError {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::Io(e) => Some(e),
			_ => None,
		}
	}
}

impl From<std::io::Error> for EngineError {
	fn from(e: std::io::Error) -> Self {
		Self::Io(e)
	}
}
