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
use engine_core::types::{
	AssignmentRecord, CourseDashboardRecord, CourseRuleOverrideRecord, DashboardRecord,
	DeadlineFilter as EngineDeadlineFilter, DuplicateGroupRecord,
	NotificationRuleInput as EngineNotificationRuleInput, NotificationRuleRecord, RuleSetRecord,
	RuleViolationRecord,
};
use engine_core::{EngineError, EngineResult};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// payloadを持たないコマンドの入力。未知フィールドを受理しない。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyRequest {}

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
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCourseFolderNameRequest {
	pub course_id: i64,
	pub folder_name: Option<String>,
}

/// コースフォルダ名について利用者確認が必要な理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CourseFolderNameWarningCode {
	NameConflict,
	NameShortened,
}

/// backendの別名・短縮名を利用者へ提示する警告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseFolderNameWarning {
	pub code: CourseFolderNameWarningCode,
	pub message: String,
	pub suggested_folder_name: String,
}

/// 一意性を確認済みの保存用コースフォルダ名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseFolderNameResolution {
	pub course_id: i64,
	pub folder_name: String,
	pub warnings: Vec<CourseFolderNameWarning>,
}

/// 保存用コースフォルダ名の更新結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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
			course_id: value.course_id,
			folder_name: value.folder_name,
			warnings: value.warnings.into_iter().map(Into::into).collect(),
		}
	}
}

/// ルール違反一覧に表示する1件。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DuplicateMethod {
	Exact,
	Similar,
}

/// 重複グループに含まれる1ファイル。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFileListItem {
	pub file_id: i64,
	pub file_name: String,
	/// 初期設定の保存ルートからの相対パス。ファイル名を含む。
	pub relative_path: String,
	/// 0.0〜1.0。完全一致の場合は1.0。
	pub similarity: f64,
}

/// 重複ファイル一覧に表示する1グループ。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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
		message: "保存先を安全な相対パスとして表示できません".to_string(),
	}
}

fn invalid_stored_value(name: &str) -> EngineError {
	EngineError::Database {
		message: format!("SQLiteに未対応の{name}が保存されています"),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dto_is_serialized_with_contract_field_names() {
		let course_folder = CourseFolderNameResolution {
			course_id: 2,
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
