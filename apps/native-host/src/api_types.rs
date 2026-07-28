//! Native Messagingで返すAPI専用DTO。
//!
//! SQLiteとengine-coreは実ファイル操作のため絶対パスを保持するが、この境界では
//! 保存ルートからの相対パスだけを公開する。`packages/shared/src/types.ts` と
//! `docs/api/contract.md` が定めるcamelCaseのwire形式に対応する。

use engine_core::folder_names::{
	CourseFolderNameResolution as EngineCourseFolderNameResolution,
	CourseFolderNameWarning as EngineCourseFolderNameWarning,
	CourseFolderNameWarningCode as EngineCourseFolderNameWarningCode,
};
use engine_core::library::{
	LibraryMaintenanceSummary as EngineLibraryMaintenanceSummary,
	LibraryMaintenanceWarning as EngineLibraryMaintenanceWarning,
};
use engine_core::types::{
	AssignmentChangeRecord, AssignmentRecord, CourseDashboardRecord, CourseRuleOverrideRecord,
	DashboardRecord, DataSyncEventRecord, DeadlineFilter as EngineDeadlineFilter,
	DuplicateGroupRecord, MoodleAssignmentSyncInput as EngineMoodleAssignmentSyncInput,
	NotificationRuleInput as EngineNotificationRuleInput, NotificationRuleRecord, RuleSetRecord,
	RuleViolationRecord,
};
use engine_core::{EngineError, EngineResult};
use serde::{Deserialize, Serialize};
use std::path::Path;
use ts_rs::TS;

/// payloadを持たないコマンドの入力。未知フィールドを受理しない。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PingResult {
	pub version: String,
	pub protocol_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveFileDescriptor {
	pub file_id: String,
	pub file_name: String,
	pub mime_type: Option<String>,
	pub byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginSaveFilesRequest {
	pub transfer_id: String,
	pub target_path: String,
	pub course_id: Option<i64>,
	pub files: Vec<SaveFileDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendSaveFileChunkRequest {
	pub transfer_id: String,
	pub file_id: String,
	pub chunk_index: u32,
	pub data_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveFilesRequest {
	pub transfer_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SaveFileFailureCode {
	InvalidContent,
	AlreadyExists,
	IoError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileFailure {
	pub file_id: String,
	pub code: SaveFileFailureCode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFilesResult {
	pub saved_file_ids: Vec<String>,
	pub failed_files: Vec<SaveFileFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoodleCourseContext {
	pub moodle_course_id: Option<String>,
	pub name: Option<String>,
	pub academic_year: Option<i64>,
	pub term: Option<String>,
	pub section_title: Option<String>,
	pub breadcrumbs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoodleFileMeta {
	pub title: String,
	pub url: String,
	pub moodle_file_id: Option<String>,
	pub section_title: Option<String>,
	pub mime_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuggestSavePathRequest {
	pub course: MoodleCourseContext,
	pub file_meta: Option<MoodleFileMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSuggestion {
	pub path: String,
	pub relative_path: String,
	pub confidence: f64,
	pub course_folder: CourseFolderNameResolution,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginCheckSimilarFileRequest {
	pub transfer_id: String,
	pub byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendCheckSimilarFileChunkRequest {
	pub transfer_id: String,
	pub chunk_index: u32,
	pub data_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckSimilarFilesTransferRequest {
	pub transfer_id: String,
	pub file_meta: MoodleFileMeta,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarFileMatch {
	pub file_id: i64,
	pub original_name: String,
	pub similarity: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractZipRequest {
	pub file_meta: MoodleFileMeta,
	pub target_path: String,
	pub destination_path: String,
	pub flatten: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractZipResult {
	pub extracted_paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeadlineFilter {
	pub course_id: Option<i64>,
	#[serde(default)]
	pub include_past: bool,
	#[serde(default)]
	pub needs_review_only: bool,
}

impl From<DeadlineFilter> for EngineDeadlineFilter {
	fn from(value: DeadlineFilter) -> Self {
		Self {
			course_id: value.course_id,
			include_past: value.include_past,
			needs_review_only: value.needs_review_only,
		}
	}
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetDeadlinesRequest {
	#[serde(default)]
	pub filter: Option<DeadlineFilter>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSubmissionStatusRequest {
	pub assignment_id: i64,
	pub submitted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentSource {
	MoodleDashboard,
	MoodleText,
	FileContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DueAtStatus {
	Normal,
	NeedsReview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionMode {
	MoodleAuto,
	Manual,
	NotifyOnly,
	Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
	pub id: i64,
	pub course_id: i64,
	pub course_name: String,
	pub title: String,
	pub source: AssignmentSource,
	pub due_at: Option<String>,
	pub due_at_status: DueAtStatus,
	pub submission_mode: SubmissionMode,
	pub submitted: bool,
}

impl TryFrom<AssignmentRecord> for Assignment {
	type Error = EngineError;

	fn try_from(value: AssignmentRecord) -> Result<Self, Self::Error> {
		Ok(Self {
			id: value.id,
			course_id: value.course_id,
			course_name: value.course_name,
			title: value.title,
			source: match value.source.as_str() {
				"moodle_dashboard" => AssignmentSource::MoodleDashboard,
				"moodle_text" => AssignmentSource::MoodleText,
				"file_content" => AssignmentSource::FileContent,
				_ => return Err(invalid_stored_value("課題の取得元")),
			},
			due_at: value.due_at,
			due_at_status: match value.due_at_status.as_str() {
				"normal" => DueAtStatus::Normal,
				"needs_review" => DueAtStatus::NeedsReview,
				_ => return Err(invalid_stored_value("締切の確認状態")),
			},
			submission_mode: match value.submission_mode.as_str() {
				"moodle_auto" => SubmissionMode::MoodleAuto,
				"manual" => SubmissionMode::Manual,
				"notify_only" => SubmissionMode::NotifyOnly,
				"unknown" => SubmissionMode::Unknown,
				_ => return Err(invalid_stored_value("提出状況の更新方式")),
			},
			submitted: value.submitted,
		})
	}
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetAssignmentChangesRequest {
	pub since_sync_event_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DataSyncEvent {
	pub id: i64,
	pub synced_at: String,
	pub trigger: String,
	pub new_assignment_count: i64,
	pub changed_assignment_count: i64,
	pub removed_assignment_count: i64,
}

impl From<DataSyncEventRecord> for DataSyncEvent {
	fn from(value: DataSyncEventRecord) -> Self {
		Self {
			id: value.id,
			synced_at: value.synced_at,
			trigger: value.trigger,
			new_assignment_count: value.new_assignment_count,
			changed_assignment_count: value.changed_assignment_count,
			removed_assignment_count: value.removed_assignment_count,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SyncMoodleCourseRequest {
	pub moodle_course_id: String,
	pub name: String,
	pub academic_year: Option<i64>,
	pub term: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SyncMoodleAssignmentRequest {
	pub moodle_assignment_id: String,
	pub title: String,
	pub due_at: Option<String>,
	pub source: String,
	pub due_at_status: String,
	pub submission_mode: String,
	pub submitted: bool,
}

impl From<SyncMoodleAssignmentRequest> for EngineMoodleAssignmentSyncInput {
	fn from(value: SyncMoodleAssignmentRequest) -> Self {
		Self {
			moodle_assignment_id: value.moodle_assignment_id,
			title: value.title,
			due_at: value.due_at,
			source: value.source,
			due_at_status: value.due_at_status,
			submission_mode: value.submission_mode,
			submitted: value.submitted,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SyncMoodleAssignmentsRequest {
	pub trigger: String,
	pub course: SyncMoodleCourseRequest,
	pub assignments: Vec<SyncMoodleAssignmentRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AssignmentChangeField {
	DueAt,
	Title,
	SubmissionMode,
	DueAtStatus,
	Submitted,
	RemovedAt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentChange {
	pub assignment_id: i64,
	pub course_name: String,
	pub title: String,
	pub field: AssignmentChangeField,
	pub old_value: Option<String>,
	pub new_value: Option<String>,
	pub detected_at: String,
}

impl TryFrom<AssignmentChangeRecord> for AssignmentChange {
	type Error = EngineError;

	fn try_from(value: AssignmentChangeRecord) -> Result<Self, Self::Error> {
		let field = match value.field.as_str() {
			"due_at" => AssignmentChangeField::DueAt,
			"title" => AssignmentChangeField::Title,
			"submission_mode" => AssignmentChangeField::SubmissionMode,
			"due_at_status" => AssignmentChangeField::DueAtStatus,
			"submitted" => AssignmentChangeField::Submitted,
			"removed_at" => AssignmentChangeField::RemovedAt,
			_ => return Err(invalid_stored_value("assignment_changes.field")),
		};
		Ok(Self {
			assignment_id: value.assignment_id,
			course_name: value.course_name,
			title: value.title,
			field,
			old_value: value.old_value,
			new_value: value.new_value,
			detected_at: value.detected_at,
		})
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseDashboardEntry {
	pub course_id: i64,
	pub course_name: String,
	pub file_count: i64,
	pub violation_count: i64,
	pub next_due_at: Option<String>,
}

impl From<CourseDashboardRecord> for CourseDashboardEntry {
	fn from(value: CourseDashboardRecord) -> Self {
		Self {
			course_id: value.course_id,
			course_name: value.course_name,
			file_count: value.file_count,
			violation_count: value.violation_count,
			next_due_at: value.next_due_at,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
	pub courses: Vec<CourseDashboardEntry>,
	pub total_files: i64,
	pub total_violations: i64,
	pub upcoming_deadline_count: i64,
}

impl From<DashboardRecord> for DashboardSummary {
	fn from(value: DashboardRecord) -> Self {
		Self {
			courses: value.courses.into_iter().map(Into::into).collect(),
			total_files: value.total_files,
			total_violations: value.total_violations,
			upcoming_deadline_count: value.upcoming_deadline_count,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseRuleOverride {
	pub course_id: i64,
	pub course_name: String,
	pub split_by_section: bool,
	pub pattern_template: Option<String>,
	pub note: Option<String>,
}

impl From<CourseRuleOverrideRecord> for CourseRuleOverride {
	fn from(value: CourseRuleOverrideRecord) -> Self {
		Self {
			course_id: value.course_id,
			course_name: value.course_name,
			split_by_section: value.split_by_section,
			pattern_template: value.pattern_template,
			note: value.note,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSet {
	pub global_pattern_template: String,
	pub course_overrides: Vec<CourseRuleOverride>,
}

impl From<RuleSetRecord> for RuleSet {
	fn from(value: RuleSetRecord) -> Self {
		Self {
			global_pattern_template: value.global_pattern_template,
			course_overrides: value.course_overrides.into_iter().map(Into::into).collect(),
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateGlobalRuleRequest {
	pub pattern_template: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CourseRuleOverrideInput {
	pub split_by_section: bool,
	pub pattern_template: Option<String>,
	pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateCourseRuleOverrideRequest {
	pub course_id: i64,
	pub r#override: CourseRuleOverrideInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct OkResult {
	pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRule {
	pub id: i64,
	pub offset_minutes: i64,
	pub label: String,
	pub enabled: bool,
}

impl From<NotificationRuleRecord> for NotificationRule {
	fn from(value: NotificationRuleRecord) -> Self {
		Self {
			id: value.id,
			offset_minutes: value.offset_minutes,
			label: value.label,
			enabled: value.enabled,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationRuleInput {
	pub id: Option<i64>,
	pub offset_minutes: i64,
	pub enabled: bool,
}

impl From<NotificationRuleInput> for EngineNotificationRuleInput {
	fn from(value: NotificationRuleInput) -> Self {
		Self {
			id: value.id,
			offset_minutes: value.offset_minutes,
			enabled: value.enabled,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateNotificationRulesRequest {
	pub rules: Vec<NotificationRuleInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NotificationRuleUpdateResult {
	pub ok: bool,
	pub rules: Vec<NotificationRule>,
}

/// 保存用コースフォルダ名の編集要求。`None`は自動提案へ戻す。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct UpdateCourseFolderNameRequest {
	pub course_id: i64,
	pub folder_name: Option<String>,
}

/// コースフォルダ名について利用者確認が必要な理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CourseFolderNameWarningCode {
	NameConflict,
	NameShortened,
}

/// backendの別名・短縮名を利用者へ提示する警告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CourseFolderNameWarning {
	pub code: CourseFolderNameWarningCode,
	pub message: String,
	pub suggested_folder_name: String,
}

/// 一意性を確認済みの保存用コースフォルダ名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CourseFolderNameResolution {
	pub course_id: Option<i64>,
	pub folder_name: String,
	pub warnings: Vec<CourseFolderNameWarning>,
}

/// 保存用コースフォルダ名の更新結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateCourseFolderNameResult {
	pub ok: bool,
	pub course_folder: CourseFolderNameResolution,
}

impl From<EngineCourseFolderNameWarningCode> for CourseFolderNameWarningCode {
	fn from(value: EngineCourseFolderNameWarningCode) -> Self {
		match value {
			EngineCourseFolderNameWarningCode::NameConflict => Self::NameConflict,
			EngineCourseFolderNameWarningCode::NameShortened => Self::NameShortened,
		}
	}
}

impl From<EngineCourseFolderNameWarning> for CourseFolderNameWarning {
	fn from(value: EngineCourseFolderNameWarning) -> Self {
		Self {
			code: value.code.into(),
			message: value.message,
			suggested_folder_name: value.suggested_folder_name,
		}
	}
}

impl From<EngineCourseFolderNameResolution> for CourseFolderNameResolution {
	fn from(value: EngineCourseFolderNameResolution) -> Self {
		Self {
			course_id: Some(value.course_id),
			folder_name: value.folder_name,
			warnings: value.warnings.into_iter().map(Into::into).collect(),
		}
	}
}

/// ルール違反一覧に表示する1件。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuleViolationListItem {
	pub file_id: i64,
	pub file_name: String,
	pub course_id: Option<i64>,
	pub course_name: Option<String>,
	/// 初期設定の保存ルートからの相対パス。ファイル名を含む。
	pub relative_path: String,
	pub reason: String,
}

/// APIで返す重複判定方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum DuplicateMethod {
	Exact,
	Similar,
}

/// 重複グループに含まれる1ファイル。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DuplicateFileListItem {
	pub file_id: i64,
	pub file_name: String,
	/// 初期設定の保存ルートからの相対パス。ファイル名を含む。
	pub relative_path: String,
	/// 0.0〜1.0。完全一致の場合は1.0。
	pub similarity: f64,
}

/// 重複ファイル一覧に表示する1グループ。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DuplicateGroupListItem {
	pub group_id: i64,
	pub method: DuplicateMethod,
	pub members: Vec<DuplicateFileListItem>,
}

impl RuleViolationListItem {
	pub fn from_record(record: RuleViolationRecord, base_folder: &Path) -> EngineResult<Self> {
		Ok(Self {
			file_id: record.file_id,
			file_name: record.file_name,
			course_id: record.course_id,
			course_name: record.course_name,
			relative_path: safe_relative_windows_path(base_folder, &record.saved_path)?,
			reason: record.reason,
		})
	}
}

impl DuplicateGroupListItem {
	pub fn from_record(record: DuplicateGroupRecord, base_folder: &Path) -> EngineResult<Self> {
		let method = match record.method.as_str() {
			"exact" => DuplicateMethod::Exact,
			"similar" => DuplicateMethod::Similar,
			_ => return Err(invalid_stored_value("重複判定方式")),
		};
		let members = record
			.members
			.into_iter()
			.map(|member| {
				Ok(DuplicateFileListItem {
					file_id: member.file_id,
					file_name: member.file_name,
					relative_path: safe_relative_windows_path(base_folder, &member.saved_path)?,
					similarity: member.similarity,
				})
			})
			.collect::<EngineResult<Vec<_>>>()?;
		Ok(Self {
			group_id: record.group_id,
			method,
			members,
		})
	}
}

/// 全文検索要求。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchRequest {
	pub query: String,
}

/// 全文検索のAPI結果。ファイル情報はSQLiteの正本から投影する。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchResult {
	pub file_id: i64,
	pub file_name: String,
	pub course_name: Option<String>,
	pub snippet: String,
	pub page: Option<u32>,
	pub page_count: Option<u32>,
	pub score: f32,
}

/// SQLiteバックアップの書き出し要求。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ExportDataRequest {
	pub file_path: String,
}

/// SQLiteバックアップの書き出し結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExportDataResult {
	pub file_path: String,
}

/// SQLiteバックアップの読み込み要求。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ImportDataRequest {
	pub file_path: String,
}

/// SQLiteバックアップの読み込み結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportDataResult {
	pub ok: bool,
	pub reindex_required: bool,
}

/// 保存ルートの明示再スキャンと全文索引再構築の要求。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RebuildLibraryRequest {
	#[ts(optional)]
	pub rebuild_index: Option<bool>,
}

/// Moodleで表示中の1コースだけを差分走査する要求。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ReconcileCourseFilesRequest {
	pub course: SyncMoodleCourseRequest,
}

/// 再スキャンで個別に処理できなかった相対パスと利用者向け理由。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryMaintenanceWarning {
	pub path: String,
	pub message: String,
}

/// ファイルを移動・削除しないライブラリ整合処理の集計。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryMaintenanceSummary {
	pub scanned_file_count: usize,
	pub registered_file_count: usize,
	pub updated_file_count: usize,
	pub indexed_file_count: usize,
	pub reused_fingerprint_count: usize,
	pub missing_file_count: usize,
	pub skipped_file_count: usize,
	pub warnings: Vec<LibraryMaintenanceWarning>,
}

impl From<EngineLibraryMaintenanceWarning> for LibraryMaintenanceWarning {
	fn from(value: EngineLibraryMaintenanceWarning) -> Self {
		Self {
			path: value.path,
			message: value.message,
		}
	}
}

impl From<EngineLibraryMaintenanceSummary> for LibraryMaintenanceSummary {
	fn from(value: EngineLibraryMaintenanceSummary) -> Self {
		Self {
			scanned_file_count: value.scanned_file_count,
			registered_file_count: value.registered_file_count,
			updated_file_count: value.updated_file_count,
			indexed_file_count: value.indexed_file_count,
			reused_fingerprint_count: value.reused_fingerprint_count,
			missing_file_count: value.missing_file_count,
			skipped_file_count: value.skipped_file_count,
			warnings: value.warnings.into_iter().map(Into::into).collect(),
		}
	}
}

/// SQLiteの絶対パスを、保存ルート以下の正規化済みWindows相対パスへ変換する。
/// 保存ルート外の値はパスをエラー文へ含めず拒否する。
fn safe_relative_windows_path(base_folder: &Path, saved_path: &Path) -> EngineResult<String> {
	let base = base_folder.to_string_lossy().replace('/', "\\");
	let saved = saved_path.to_string_lossy().replace('/', "\\");
	let base = base.trim_end_matches('\\');
	let prefix_matches = saved
		.get(..base.len())
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case(base));
	let boundary_matches = saved
		.as_bytes()
		.get(base.len())
		.is_some_and(|byte| *byte == b'\\');
	if base.is_empty() || !prefix_matches || !boundary_matches {
		return Err(unsafe_stored_path());
	}
	let relative = saved.get(base.len() + 1..).ok_or_else(unsafe_stored_path)?;
	let segments = relative.split('\\').collect::<Vec<_>>();
	if segments.is_empty()
		|| segments.iter().any(|segment| {
			segment.is_empty() || matches!(*segment, "." | "..") || segment.contains(':')
		}) {
		return Err(unsafe_stored_path());
	}
	Ok(segments.join("\\"))
}

fn unsafe_stored_path() -> EngineError {
	EngineError::Internal {
		message: "保存ルート外または不正な保存済みパスを検出しました".to_string(),
	}
}

fn invalid_stored_value(name: &str) -> EngineError {
	EngineError::Database {
		message: format!("SQLiteに保存された{name}が不正です"),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dto_is_serialized_with_contract_field_names() {
		let course_folder = CourseFolderNameResolution {
			course_id: Some(2),
			folder_name: "英語_A".to_string(),
			warnings: vec![CourseFolderNameWarning {
				code: CourseFolderNameWarningCode::NameConflict,
				message: "同名になるため別名を提案しました".to_string(),
				suggested_folder_name: "英語_A".to_string(),
			}],
		};
		let value = serde_json::to_value(course_folder).unwrap();
		assert_eq!(value["courseId"], 2);
		assert_eq!(value["warnings"][0]["code"], "name_conflict");
		assert_eq!(value["warnings"][0]["suggestedFolderName"], "英語_A");

		let item = RuleViolationListItem {
			file_id: 4,
			file_name: "正規化_メモ.docx".to_string(),
			course_id: Some(2),
			course_name: Some("データベース".to_string()),
			relative_path: "正規化_メモ.docx".to_string(),
			reason: "保存ルールから外れています".to_string(),
		};
		let value = serde_json::to_value(item).unwrap();
		assert_eq!(value["fileId"], 4);
		assert_eq!(value["courseId"], 2);
		assert_eq!(value["relativePath"], "正規化_メモ.docx");
		assert!(value.get("savedPath").is_none());

		let group = DuplicateGroupListItem {
			group_id: 1,
			method: DuplicateMethod::Exact,
			members: vec![DuplicateFileListItem {
				file_id: 3,
				file_name: "第4回_正規化.pdf".to_string(),
				relative_path: "2026前期\\データベース\\第4回\\第4回_正規化.pdf".to_string(),
				similarity: 1.0,
			}],
		};
		let value = serde_json::to_value(group).unwrap();
		assert_eq!(value["method"], "exact");
		assert_eq!(value["members"][0]["similarity"], 1.0);

		assert_eq!(
			serde_json::to_value(DuplicateMethod::Similar).unwrap(),
			"similar"
		);
	}

	#[test]
	fn issue_42_dtos_match_shared_camel_case_fields() {
		let assignment = Assignment::try_from(AssignmentRecord {
			id: 1,
			course_id: 2,
			course_name: "データベース".to_string(),
			title: "正規化レポート".to_string(),
			source: "moodle_dashboard".to_string(),
			due_at: Some("2026-07-04T23:59:00".to_string()),
			due_at_status: "needs_review".to_string(),
			submission_mode: "manual".to_string(),
			submitted: false,
		})
		.unwrap();
		let value = serde_json::to_value(assignment).unwrap();
		assert_eq!(value["courseId"], 2);
		assert_eq!(value["source"], "moodle_dashboard");
		assert_eq!(value["dueAtStatus"], "needs_review");
		assert_eq!(value["submissionMode"], "manual");

		let dashboard = DashboardSummary::from(DashboardRecord {
			courses: Vec::new(),
			total_files: 9,
			total_violations: 2,
			upcoming_deadline_count: 3,
		});
		let value = serde_json::to_value(dashboard).unwrap();
		assert_eq!(value["totalFiles"], 9);
		assert_eq!(value["upcomingDeadlineCount"], 3);
	}

	#[test]
	fn file_transfer_dtos_match_shared_contract() {
		let begin: BeginSaveFilesRequest = serde_json::from_value(serde_json::json!({
			"transferId": "transfer-1",
			"targetPath": "C:\\save",
			"files": [{
				"fileId": "4376",
				"fileName": "ガイダンス資料.docx",
				"mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				"byteLength": 4
			}]
		}))
		.unwrap();
		assert_eq!(begin.files[0].file_id, "4376");

		let similarity_begin: BeginCheckSimilarFileRequest =
			serde_json::from_value(serde_json::json!({
				"transferId": "similar-1",
				"byteLength": 4
			}))
			.unwrap();
		assert_eq!(similarity_begin.byte_length, 4);
		let similarity_chunk: AppendCheckSimilarFileChunkRequest =
			serde_json::from_value(serde_json::json!({
				"transferId": "similar-1",
				"chunkIndex": 0,
				"dataBase64": "dGVzdA=="
			}))
			.unwrap();
		assert_eq!(similarity_chunk.chunk_index, 0);
		let similarity_finish: CheckSimilarFilesTransferRequest =
			serde_json::from_value(serde_json::json!({
				"transferId": "similar-1",
				"fileMeta": {
					"title": "ガイダンス資料.pdf",
					"url": "https://moodle.example/guide.pdf",
					"moodleFileId": "4376",
					"sectionTitle": null,
					"mimeHint": "pdf"
				}
			}))
			.unwrap();
		assert_eq!(similarity_finish.transfer_id, "similar-1");
		assert!(
			serde_json::from_value::<CheckSimilarFilesTransferRequest>(serde_json::json!({
				"fileMeta": {
					"title": "ガイダンス資料.pdf",
					"url": "https://moodle.example/guide.pdf",
					"moodleFileId": "4376",
					"sectionTitle": null,
					"mimeHint": "pdf"
				},
				"contentBase64": "dGVzdA=="
			}))
			.is_err()
		);

		let result = SaveFilesResult {
			saved_file_ids: vec!["4376".to_string()],
			failed_files: vec![SaveFileFailure {
				file_id: "9999".to_string(),
				code: SaveFileFailureCode::InvalidContent,
			}],
		};
		let value = serde_json::to_value(result).unwrap();
		assert_eq!(value["savedFileIds"][0], "4376");
		assert_eq!(value["failedFiles"][0]["code"], "INVALID_CONTENT");
	}

	#[test]
	fn moodle_assignment_sync_dto_matches_the_wire_contract() {
		let request: SyncMoodleAssignmentsRequest = serde_json::from_value(serde_json::json!({
			"trigger": "auto",
			"course": {
				"moodleCourseId": "course-412",
				"name": "データベース",
				"academicYear": 2026,
				"term": "2026前期"
			},
			"assignments": [{
				"moodleAssignmentId": "cm-412-101",
				"title": "第3正規形レポート",
				"dueAt": "2026-07-31T23:59:00+09:00",
				"source": "moodle_dashboard",
				"dueAtStatus": "normal",
				"submissionMode": "moodle_auto",
				"submitted": false
			}]
		}))
		.unwrap();
		assert_eq!(request.course.moodle_course_id, "course-412");
		assert_eq!(request.assignments[0].moodle_assignment_id, "cm-412-101");
		assert!(
			serde_json::from_value::<SyncMoodleAssignmentsRequest>(serde_json::json!({
				"trigger": "auto",
				"course": {
					"moodleCourseId": "course-412",
					"name": "データベース",
					"academicYear": null,
					"term": null
				},
				"assignments": [],
				"unexpected": true
			}))
			.is_err()
		);

		let ping = serde_json::to_value(PingResult {
			version: "0.1.0".to_string(),
			protocol_version: engine_core::EXTENSION_RUNTIME_PROTOCOL_VERSION,
		})
		.unwrap();
		assert_eq!(
			ping["protocolVersion"],
			engine_core::EXTENSION_RUNTIME_PROTOCOL_VERSION
		);
	}

	#[test]
	fn native_request_dtos_reject_unknown_fields() {
		assert!(
			serde_json::from_value::<UpdateCourseFolderNameRequest>(serde_json::json!({
				"courseId": 1,
				"folderName": null,
				"unexpected": true
			}))
			.is_err()
		);
		assert!(serde_json::from_value::<SearchRequest>(serde_json::json!({
			"query": "正規化",
			"unexpected": true
		}))
		.is_err());
		assert!(
			serde_json::from_value::<ExportDataRequest>(serde_json::json!({
				"filePath": "backup.sqlite3",
				"unexpected": true
			}))
			.is_err()
		);
		assert!(
			serde_json::from_value::<ImportDataRequest>(serde_json::json!({
				"filePath": "backup.sqlite3",
				"unexpected": true
			}))
			.is_err()
		);
	}

	#[test]
	fn relative_path_conversion_never_exposes_paths_outside_the_save_root() {
		let base = Path::new(r"C:\Users\sample\Documents\大学");
		assert_eq!(
			safe_relative_windows_path(
				base,
				Path::new(r"C:\Users\sample\Documents\大学\2026前期\資料.pdf")
			)
			.unwrap(),
			r"2026前期\資料.pdf"
		);

		let error = safe_relative_windows_path(
			base,
			Path::new(r"C:\Users\sample\Documents\別フォルダ\秘密.txt"),
		)
		.unwrap_err();
		assert!(!error.to_string().contains("秘密.txt"));
	}
}
