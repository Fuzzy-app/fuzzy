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

/// ルールテンプレートの展開に使う、1ファイル分のコース文脈。
///
/// SQLite由来の値だけでなく、保存前のMoodle資料にも同じ照合処理を使えるよう、
/// すべての値を任意としている。テンプレートが必要とする値が無い場合、既存ファイルの
/// 照合では警告を返し、保存先の提案では入力エラーを返す。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RuleContext {
	/// SQLite上のコースID。コース別例外ルールの選択に使う。
	pub course_id: Option<i64>,
	/// 括弧内補足・絵文字・同名衝突を処理した、保存フォルダ用のコース名。
	pub course_name: Option<String>,
	/// 年度（例: `2026`）。
	pub year: Option<String>,
	/// 学期（例: `2026前期`）。
	pub term: Option<String>,
	/// 課題名。未指定時はファイル名から拡張子を除いた値を使用する。
	pub assignment: Option<String>,
	/// 回・週等のセクション値（例: `4`）。
	pub section: Option<String>,
}

/// 保存済みファイルをルールと照合するための入力。
///
/// ファイルシステム走査用の [`FileEntry`] へDB固有の情報を混在させず、ルール照合に
/// 必要なメタデータだけを独立して保持する。
#[derive(Debug, Clone, PartialEq)]
pub struct RuleFileEntry {
	/// SQLite上のファイルID（DB登録前のファイルは `None`）。
	pub file_id: Option<i64>,
	/// 現在の保存先パス。
	pub saved_path: PathBuf,
	/// ルール上のファイル名（拡張子込み）。
	pub file_name: String,
	/// テンプレート展開とコース別例外ルールの選択に使う文脈。
	pub context: RuleContext,
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

/// SQLite上のルール適合注釈を再計算した結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuleComplianceSummary {
	/// 照合したファイル数。
	pub checked_count: usize,
	/// 違反と判定したファイル数。
	pub violation_count: usize,
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
