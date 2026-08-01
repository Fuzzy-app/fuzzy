//! エンジン間で共有するデータ型。
//!
//! `packages/shared/src/types.ts` の手書き型と対応させている（現時点の正は
//! docs/api/contract.md）。issue #44 で `#[derive(TS)]`（ts-rs）を付与し、
//! `packages/shared/src/generated/` へのTS型自動生成に切り替える予定。

use std::path::PathBuf;
use url::Url;

/// Moodle文脈をSQLiteのコースへ解決した結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CourseContextRecord {
	pub course_id: i64,
	pub name: String,
	pub academic_year: Option<i64>,
	pub term: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExcludedFolderRecord {
	pub id: i64,
	pub scope: String,
	pub course_id: Option<i64>,
	pub relative_path: String,
}

/// ファイルシステムへの保存成功後にSQLiteへ登録するメタデータ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedFileRegistration {
	pub course_id: Option<i64>,
	pub section_no: Option<i64>,
	pub moodle_file_id: Option<String>,
	pub original_name: String,
	pub saved_path: PathBuf,
	pub size_bytes: i64,
	pub mime_type: Option<String>,
	pub hash_blake3: String,
	pub simhash: u64,
}

/// 保存前の重複・類似照合結果へ表示名を付与したレコード。
#[derive(Debug, Clone, PartialEq)]
pub struct SimilarFileRecord {
	pub file_id: i64,
	pub original_name: String,
	pub similarity: f64,
}

/// SQLiteに保存された課題の取得条件。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DeadlineFilter {
	pub course_id: Option<i64>,
	pub include_past: bool,
	pub needs_review_only: bool,
}

/// Moodle由来の課題・締切情報。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssignmentRecord {
	pub id: i64,
	pub course_id: i64,
	pub course_name: String,
	pub title: String,
	pub source: String,
	pub due_at: Option<String>,
	pub due_at_status: String,
	pub submission_mode: String,
	pub submitted: bool,
	pub submission_availability: String,
	pub moodle_url: Option<String>,
}

/// One assignment received from the Moodle acquisition pipeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssignmentSyncInput {
	pub id: i64,
	pub course_id: i64,
	pub title: String,
	pub source: String,
	pub due_at: Option<String>,
	pub due_at_status: String,
	pub submission_mode: String,
	pub submitted: bool,
}

/// Moodleの安定した課題識別子を使う、コース単位同期の入力。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoodleAssignmentSyncInput {
	pub moodle_assignment_id: String,
	pub title: String,
	pub source: String,
	pub due_at: Option<String>,
	pub due_at_status: String,
	pub submission_mode: String,
	pub submitted: bool,
	pub submission_availability: String,
	pub moodle_url: Option<String>,
}

pub fn is_supported_moodle_assignment_url(value: &str) -> bool {
	if value.len() > 2_048 {
		return false;
	}
	let Ok(url) = Url::parse(value) else {
		return false;
	};
	let Some(host) = url.host_str() else {
		return false;
	};
	let moodle_suffix = host
		.strip_prefix("moodle")
		.and_then(|value| value.strip_suffix(".wakayama-u.ac.jp"));
	let supported_host = moodle_suffix.is_some_and(|year| {
		year.is_empty() || year.chars().all(|character| character.is_ascii_digit())
	});
	let assignment_id = url
		.query_pairs()
		.find_map(|(key, value)| (key == "id").then_some(value));
	url.scheme() == "https"
		&& supported_host
		&& matches!(url.path(), "/mod/assign/view.php" | "/mod/quiz/view.php")
		&& url.username().is_empty()
		&& url.password().is_none()
		&& url.fragment().is_none()
		&& assignment_id.is_some_and(|value| {
			!value.is_empty()
				&& value.len() <= 128
				&& value.chars().all(|character| {
					character.is_ascii_alphanumeric() || "._:-".contains(character)
				})
		})
}

/// Aggregate result of one assignment synchronization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataSyncEventRecord {
	pub id: i64,
	pub synced_at: String,
	pub trigger: String,
	pub new_assignment_count: i64,
	pub changed_assignment_count: i64,
	pub removed_assignment_count: i64,
}

/// One changed field detected during assignment synchronization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssignmentChangeRecord {
	pub assignment_id: i64,
	pub course_name: String,
	pub title: String,
	pub field: String,
	pub old_value: Option<String>,
	pub new_value: Option<String>,
	pub detected_at: String,
}

/// ダッシュボードに表示する1コース分の集計。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CourseDashboardRecord {
	pub course_id: i64,
	pub course_name: String,
	pub file_count: i64,
	pub violation_count: i64,
	pub next_due_at: Option<String>,
}

/// SQLiteから算出したダッシュボード全体の集計。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardRecord {
	pub courses: Vec<CourseDashboardRecord>,
	pub total_files: i64,
	pub total_violations: i64,
	pub upcoming_deadline_count: i64,
}

/// コース名を結合済みの、画面表示用コース別ルール。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CourseRuleOverrideRecord {
	pub course_id: i64,
	pub course_name: String,
	pub split_by_section: bool,
	pub pattern_template: Option<String>,
	pub note: Option<String>,
}

/// 画面表示用のルール一式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleSetRecord {
	pub global_pattern_template: String,
	pub course_overrides: Vec<CourseRuleOverrideRecord>,
}

/// SQLite上のルール違反。絶対パスはNative Messaging境界で相対化する。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleViolationRecord {
	pub file_id: i64,
	pub file_name: String,
	pub course_id: Option<i64>,
	pub course_name: Option<String>,
	pub saved_path: PathBuf,
	pub reason: String,
}

/// SQLite上の重複グループに属するファイル。
#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateFileRecord {
	pub file_id: i64,
	pub file_name: String,
	pub saved_path: PathBuf,
	pub similarity: f64,
}

/// SQLite上の重複グループ。
#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateGroupRecord {
	pub group_id: i64,
	pub method: String,
	pub members: Vec<DuplicateFileRecord>,
}

/// 締切からの相対時間で表す通知ルール。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationRuleRecord {
	pub id: i64,
	pub offset_minutes: i64,
	pub label: String,
	pub enabled: bool,
}

/// 通知ルール一括更新の入力。`id = None`は新規追加を表す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationRuleInput {
	pub id: Option<i64>,
	pub offset_minutes: i64,
	pub enabled: bool,
}

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
	/// 最終更新日時（UNIXエポックからのナノ秒）。取得不能時は`None`。
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
	/// 走査起点から見た科目セグメント位置。
	pub course_segment_index: usize,
	/// 確からしさ（0.0〜1.0）。確からしさ順の提示に使う。
	pub confidence: f64,
	/// このパターンに合致した既存ファイル数。
	pub matched_count: usize,
	/// この候補を評価できたファイル数。`confidence`の分母を説明するために使う。
	pub evaluated_count: usize,
	/// この候補を実際に支持した相対フォルダーパスの代表例。
	pub representative_paths: Vec<PathBuf>,
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
	/// 明確な括弧内補足・絵文字・同名衝突を処理した、保存フォルダ用のコース名。
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

/// 検索結果をAPI DTOへ変換するためのSQLite由来メタデータ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchDocumentMetadata {
	/// SQLite上のファイルID。
	pub file_id: i64,
	/// 保存時の元ファイル名。
	pub file_name: String,
	/// コース未紐付けの場合は`None`。
	pub course_name: Option<String>,
	/// PDF等の総ページ数。本文索引と同時に検証できない形式では`None`。
	pub page_count: Option<u32>,
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

/// 1ファイルの重複検出用フィンガープリント。
///
/// `simhash` はSQLiteの符号付き`INTEGER`へ保存する際にビット列を保ったまま`i64`へ
/// キャストし、読み込み時に`u64`へ戻す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFingerprint {
	/// `b3:<64桁の小文字16進数>`形式のBLAKE3ハッシュ。
	pub hash_blake3: String,
	/// ファイル内容から計算した64 bit SimHash。
	pub simhash: u64,
}

/// SQLiteへ登録済みのファイルとフィンガープリント。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFileFingerprint {
	/// SQLite上のファイルID。
	pub file_id: i64,
	/// BLAKE3ハッシュ。過去データとの比較のためDB上の文字列をそのまま保持する。
	pub hash_blake3: String,
	/// 64 bit SimHash。未計算の既存行は`None`。
	pub simhash: Option<u64>,
}

/// 重複グループの検出方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DuplicateMethod {
	/// BLAKE3が完全一致するファイル。
	Exact,
	/// SimHashのハミング距離が閾値以内のファイル。
	Similar,
}

/// 検出した重複グループに属する1ファイル。
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedDuplicateMember {
	/// SQLite上のファイルID。
	pub file_id: i64,
	/// 0.0〜1.0の類似度。完全一致グループでは常に1.0。
	pub similarity: f64,
}

/// SQLiteへ登録する前の重複グループ。
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedDuplicateGroup {
	/// 完全一致または類似検出。
	pub method: DuplicateMethod,
	/// 2件以上のメンバー。ファイルID順で保持する。
	pub members: Vec<DetectedDuplicateMember>,
}

/// 重複グループの再計算・再登録結果。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DuplicateRefreshSummary {
	/// BLAKE3完全一致グループ数。
	pub exact_group_count: usize,
	/// SimHash類似グループ数。
	pub similar_group_count: usize,
	/// 全グループの延べメンバー数。
	pub member_count: usize,
}
