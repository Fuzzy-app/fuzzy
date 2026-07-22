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
use serde::{Deserialize, Serialize};

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
}
