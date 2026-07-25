//! エンジン共通のエラー型。
//!
//! docs/api/contract.md のエラーコード（INVALID_REQUEST / DB_ERROR / IO_ERROR /
//! RULE_CONFLICT / INTERNAL 等）へ変換しやすい粒度で定義する。

use std::fmt;

/// エンジン共通の結果型。
pub type EngineResult<T> = Result<T, EngineError>;

/// エンジン共通のエラー。
#[derive(Debug)]
pub enum EngineError {
	/// API入力の形式・値が契約を満たさない。
	InvalidInput { field: String, reason: String },
	/// 指定されたエンティティが存在しない。
	NotFound { entity: String, id: String },
	/// 指定パスが存在しない、アクセスできない、またはフォルダではない。
	InvalidPath { path: String, reason: String },
	/// ファイルI/Oエラー。
	Io(std::io::Error),
	/// 対象パスを特定できるファイルI/Oエラー。
	PathIo {
		path: String,
		source: std::io::Error,
	},
	/// SQLite等の永続化層のエラー。
	Database { message: String },
	/// グローバルルールとコース別例外ルールの定義が矛盾している。
	RuleConflict { reason: String },
	/// Tantivy索引の構築・検索エラー。
	Index { message: String },
	/// その他の内部エラー。
	Internal { message: String },
}

impl EngineError {
	/// APIレスポンスや画面表示に使える、内部情報を含まない固定メッセージ。
	///
	/// [`fmt::Display`]はローカルログ向けの詳細を返すため、外部境界では必ず
	/// このメソッドを使用する。
	pub fn user_message(&self) -> &'static str {
		match self {
			Self::InvalidInput { .. } => "入力内容が不正です。",
			Self::NotFound { .. } => "指定されたデータが見つかりません。",
			Self::InvalidPath { .. } => "指定されたパスを利用できません。",
			Self::Io(_) | Self::PathIo { .. } => "ファイルの読み書きに失敗しました。",
			Self::Database { .. } => "データベースの処理に失敗しました。",
			Self::RuleConflict { .. } => "設定内容が他のルールと競合しています。",
			Self::Index { .. } => "検索索引の処理に失敗しました。",
			Self::Internal { .. } => "内部処理に失敗しました。",
		}
	}
}

impl fmt::Display for EngineError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::InvalidInput { field, reason } => {
				write!(f, "入力値 '{field}' が不正です: {reason}")
			}
			Self::NotFound { entity, id } => write!(f, "{entity} '{id}' が見つかりません"),
			Self::InvalidPath { path, reason } => {
				write!(f, "無効なパス '{path}': {reason}")
			}
			Self::Io(e) => write!(f, "I/Oエラー: {e}"),
			Self::PathIo { path, source } => {
				write!(f, "パス '{path}' のI/Oエラー: {source}")
			}
			Self::Database { message } => write!(f, "DBエラー: {message}"),
			Self::RuleConflict { reason } => write!(f, "ルール定義が矛盾しています: {reason}"),
			Self::Index { message } => write!(f, "索引エラー: {message}"),
			Self::Internal { message } => write!(f, "内部エラー: {message}"),
		}
	}
}

impl std::error::Error for EngineError {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::Io(e) => Some(e),
			Self::PathIo { source, .. } => Some(source),
			_ => None,
		}
	}
}

impl From<std::io::Error> for EngineError {
	fn from(e: std::io::Error) -> Self {
		Self::Io(e)
	}
}
