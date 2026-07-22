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
	/// 走査起点からの相対パス。推定処理ではこの階層だけを根拠にする。
	pub relative_path: PathBuf,
	/// ファイル名（拡張子込み）。
	pub file_name: String,
	/// バイト単位のサイズ。
	pub size: u64,
	/// 最終更新日時（UNIXエポック秒）。
	pub modified_at: Option<i64>,
}

/// 走査中に読み取れなかったパス。走査可能な他のファイルは結果として返す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanWarning {
	/// 読み取りに失敗した、走査起点からの相対パス。
	pub path: PathBuf,
	/// 内部情報を含まないユーザー確認用の説明。
	pub message: String,
}

/// 走査起点、取得できたファイル、部分的な読み取り失敗をまとめた結果。
#[derive(Debug, Clone, PartialEq)]
pub struct ScanSnapshot {
	/// 正規化済みの走査起点。
	pub root: PathBuf,
	/// 読み取りに成功したファイル。
	pub entries: Vec<FileEntry>,
	/// 読み取りを継続できた非致命的なエラー。
	pub warnings: Vec<ScanWarning>,
}

/// 既存フォルダ構成・命名規則から推定した保存パターン。
#[derive(Debug, Clone, PartialEq)]
pub struct SavePatternGuess {
	/// DBの保存ルールへ使用できるディレクトリ用テンプレート。
	pub directory_template: String,
	/// 比較評価用に推定したファイル名テンプレート。命名規則を検出しない場合は`None`。
	pub file_name_template: Option<String>,
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

/// ルールエンジン内部の違反検出結果。
///
/// 絶対パスを含むためNative Messagingへ直接シリアライズせず、native-host側で
/// 保存ルートからの相対パスだけを持つAPI DTOへ変換する。移動・削除は行わない。
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
