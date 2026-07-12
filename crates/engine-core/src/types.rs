//! エンジン間で共有するデータ型。
//!
//! `packages/shared/src/types.ts` の手書き型と対応させている（現時点の正は
//! docs/api/contract.md）。issue #44 で `#[derive(TS)]`（ts-rs）を付与し、
//! `packages/shared/src/generated/` へのTS型自動生成に切り替える予定。

use std::path::PathBuf;

/// 再帰走査で発見された1ファイルのメタ情報。
#[derive(Debug, Clone, PartialEq)]
pub struct FileEntry {
	/// 絶対パス。
	pub path: PathBuf,
	/// ファイル名（拡張子込み）。
	pub file_name: String,
	/// バイト単位のサイズ。
	pub size: u64,
	/// 最終更新日時（UNIXエポック秒）。
	pub modified_at: Option<i64>,
}

/// 既存フォルダ構成から推定した保存パターン。
#[derive(Debug, Clone, PartialEq)]
pub struct SavePatternGuess {
	/// パターンテンプレート（例: `{course}/{section}/{filename}`）。
	pub pattern_template: String,
	/// 確からしさ（0.0〜1.0）。確からしさ順の提示に使う。
	pub confidence: f64,
	/// このパターンに合致した既存ファイル数。
	pub matched_count: usize,
}

/// グローバル／コース別の保存ルール一式。
#[derive(Debug, Clone, PartialEq)]
pub struct RuleSet {
	/// グローバルの保存パターンテンプレート。
	pub global_pattern_template: String,
	/// コース別の上書きルール。
	pub course_overrides: Vec<CourseRuleOverride>,
}

/// コース別ルールの上書き。
#[derive(Debug, Clone, PartialEq)]
pub struct CourseRuleOverride {
	/// SQLite上のコースID。
	pub course_id: i64,
	/// セクション（週・回）ごとにフォルダを分けるか。
	pub split_by_section: bool,
	/// コース専用のパターンテンプレート（`None` ならグローバルを継承）。
	pub pattern_template: Option<String>,
	/// ユーザー向けメモ。
	pub note: Option<String>,
}

/// ルール違反の検出結果。移動・削除は行わず、警告表示のためのデータに徹する。
#[derive(Debug, Clone, PartialEq)]
pub struct RuleViolation {
	/// 対象ファイルのSQLite上のID（未登録ファイルは `None`）。
	pub file_id: Option<i64>,
	/// 現在の保存先パス。
	pub saved_path: PathBuf,
	/// 違反理由（ユーザー提示用）。
	pub reason: String,
	/// ルールに従った場合の推奨パス（提示のみ。自動移動はしない）。
	pub suggested_path: Option<PathBuf>,
}

/// 全文検索のヒット1件。
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
	/// SQLite上のファイルID。
	pub file_id: i64,
	/// ヒット箇所の抜粋（ハイライト用）。
	pub snippet: String,
	/// ヒットしたページ番号（PDF等。テキストなら `None`）。
	pub page: Option<u32>,
	/// スコア（大きいほど関連が強い）。
	pub score: f32,
}

/// 重複・類似ファイルの検出結果1件。
#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateMatch {
	/// 比較対象ファイルのSQLite上のID。
	pub file_id: i64,
	/// blake3ハッシュの完全一致か。
	pub exact: bool,
	/// 類似度（0.0〜1.0。`exact == true` なら 1.0）。
	pub similarity: f64,
}
