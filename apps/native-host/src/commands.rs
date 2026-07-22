//! Native Messagingコマンドの入力検証・SQLite呼び出し・API DTO変換。

use engine_core::rule::DefaultRuleEngine;
use engine_core::{Database, EngineError, EngineResult, ExtensionRuntimeReport};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::api_types::{
	Assignment, CourseFolderNameResolution, DashboardSummary, DuplicateGroupListItem, EmptyRequest,
	GetDeadlinesRequest, NotificationRule, NotificationRuleUpdateResult, OkResult, RuleSet,
	RuleViolationListItem, UpdateCourseFolderNameRequest, UpdateCourseFolderNameResult,
	UpdateCourseRuleOverrideRequest, UpdateGlobalRuleRequest, UpdateNotificationRulesRequest,
	UpdateSubmissionStatusRequest,
};
use crate::protocol::{Request, Response};

/// コマンド名に応じて処理を振り分ける。
pub fn dispatch(database: &mut Database, request: Request) -> Response {
	match request.command.as_str() {
		"ping" => ping(request.id),
		"reportExtensionRuntime" => report_extension_runtime(database, request),
		"updateCourseFolderName" => update_course_folder_name(database, request),
		"getDashboard" => get_dashboard(database, request),
		"getDeadlines" => get_deadlines(database, request),
		"updateSubmissionStatus" => update_submission_status(database, request),
		"getRules" => get_rules(database, request),
		"updateGlobalRule" => update_global_rule(database, request),
		"updateCourseRuleOverride" => update_course_rule_override(database, request),
		"getRuleViolations" => get_rule_violations(database, request),
		"getDuplicateGroups" => get_duplicate_groups(database, request),
		"getNotificationRules" => get_notification_rules(database, request),
		"updateNotificationRules" => update_notification_rules(database, request),
		_ => Response::err(
			Some(request.id),
			"INTERNAL",
			format!("コマンド '{}' は未実装です", request.command),
		),
	}
}

fn get_dashboard(database: &Database, request: Request) -> Response {
	if let Err(response) = parse_payload::<EmptyRequest>(&request) {
		return response;
	}
	respond(request.id, database.dashboard().map(DashboardSummary::from))
}

fn get_deadlines(database: &Database, request: Request) -> Response {
	let payload = match parse_payload::<GetDeadlinesRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = database
		.deadlines(payload.filter.unwrap_or_default().into())
		.and_then(|items| {
			items
				.into_iter()
				.map(Assignment::try_from)
				.collect::<EngineResult<Vec<_>>>()
		});
	respond(request.id, result)
}

fn update_submission_status(database: &Database, request: Request) -> Response {
	let payload = match parse_payload::<UpdateSubmissionStatusRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	respond(
		request.id,
		database
			.update_submission_status(payload.assignment_id, payload.submitted)
			.map(|()| OkResult { ok: true }),
	)
}

fn get_rules(database: &Database, request: Request) -> Response {
	if let Err(response) = parse_payload::<EmptyRequest>(&request) {
		return response;
	}
	respond(request.id, database.rule_set_record().map(RuleSet::from))
}

fn update_global_rule(database: &mut Database, request: Request) -> Response {
	let payload = match parse_payload::<UpdateGlobalRuleRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	respond(
		request.id,
		database
			.update_global_rule(&payload.pattern_template, &DefaultRuleEngine)
			.map(|()| OkResult { ok: true }),
	)
}

fn update_course_rule_override(database: &mut Database, request: Request) -> Response {
	let payload = match parse_payload::<UpdateCourseRuleOverrideRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let override_rule = payload.r#override;
	respond(
		request.id,
		database
			.update_course_rule_override(
				payload.course_id,
				override_rule.split_by_section,
				override_rule.pattern_template.as_deref(),
				override_rule.note.as_deref(),
				&DefaultRuleEngine,
			)
			.map(|()| OkResult { ok: true }),
	)
}

fn get_rule_violations(database: &Database, request: Request) -> Response {
	if let Err(response) = parse_payload::<EmptyRequest>(&request) {
		return response;
	}
	let result = database.base_folder_path().and_then(|base_folder| {
		database.rule_violations().and_then(|records| {
			records
				.into_iter()
				.map(|record| RuleViolationListItem::from_record(record, &base_folder))
				.collect::<EngineResult<Vec<_>>>()
		})
	});
	respond(request.id, result)
}

fn get_duplicate_groups(database: &Database, request: Request) -> Response {
	if let Err(response) = parse_payload::<EmptyRequest>(&request) {
		return response;
	}
	let result = database.base_folder_path().and_then(|base_folder| {
		database.duplicate_groups().and_then(|records| {
			records
				.into_iter()
				.map(|record| DuplicateGroupListItem::from_record(record, &base_folder))
				.collect::<EngineResult<Vec<_>>>()
		})
	});
	respond(request.id, result)
}

fn get_notification_rules(database: &Database, request: Request) -> Response {
	if let Err(response) = parse_payload::<EmptyRequest>(&request) {
		return response;
	}
	respond(
		request.id,
		database.notification_rules().map(|rules| {
			rules
				.into_iter()
				.map(NotificationRule::from)
				.collect::<Vec<_>>()
		}),
	)
}

fn update_notification_rules(database: &mut Database, request: Request) -> Response {
	let payload = match parse_payload::<UpdateNotificationRulesRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let rules = payload
		.rules
		.into_iter()
		.map(Into::into)
		.collect::<Vec<_>>();
	respond(
		request.id,
		database
			.update_notification_rules(&rules)
			.map(|saved| NotificationRuleUpdateResult {
				ok: true,
				rules: saved.into_iter().map(NotificationRule::from).collect(),
			}),
	)
}

/// 利用者が編集した保存用コースフォルダ名をSQLiteへ保存する。
fn update_course_folder_name(database: &mut Database, request: Request) -> Response {
	let update = match parse_payload::<UpdateCourseFolderNameRequest>(&request) {
		Ok(update) => update,
		Err(response) => return response,
	};
	respond(
		request.id,
		database
			.update_course_folder_name(update.course_id, update.folder_name.as_deref())
			.map(|course_folder| UpdateCourseFolderNameResult {
				ok: true,
				course_folder: CourseFolderNameResolution::from(course_folder),
			}),
	)
}

/// 拡張機能の実応答を、native-hostの受信時刻・バージョン付きでSQLiteへ保存する。
fn report_extension_runtime(database: &Database, request: Request) -> Response {
	let report = match parse_payload::<ExtensionRuntimeReport>(&request) {
		Ok(report) => report,
		Err(response) => return response,
	};
	respond(request.id, database.record_extension_runtime(&report))
}

fn parse_payload<T: DeserializeOwned>(request: &Request) -> Result<T, Response> {
	serde_json::from_value(request.payload.clone()).map_err(|error| {
		Response::err(
			Some(request.id.clone()),
			"INVALID_REQUEST",
			format!("{}の入力を解釈できません: {error}", request.command),
		)
	})
}

fn respond<T: Serialize>(id: String, result: EngineResult<T>) -> Response {
	match result {
		Ok(value) => match serde_json::to_value(value) {
			Ok(data) => Response::ok(id, data),
			Err(error) => Response::err(
				Some(id),
				"INTERNAL",
				format!("応答を生成できません: {error}"),
			),
		},
		Err(error) => engine_error_response(id, error),
	}
}

fn engine_error_response(id: String, error: EngineError) -> Response {
	let code = match error {
		EngineError::InvalidInput { .. } => "INVALID_REQUEST",
		EngineError::NotFound { .. } => "NOT_FOUND",
		EngineError::Database { .. } => "DB_ERROR",
		EngineError::RuleConflict { .. } => "RULE_CONFLICT",
		_ => "INTERNAL",
	};
	Response::err(Some(id), code, error.to_string())
}

/// `ping`：疎通確認（docs/api/contract.md 1.2節）。`{}` → `{ version }`。
fn ping(id: String) -> Response {
	Response::ok(
		id,
		serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }),
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn request(command: &str, payload: serde_json::Value) -> Request {
		Request {
			id: format!("req-{command}"),
			command: command.to_string(),
			payload,
		}
	}

	fn seeded_database() -> Database {
		let database = Database::open_in_memory().unwrap();
		database.apply_development_seed().unwrap();
		database
	}

	#[test]
	fn unknown_command_returns_internal_error() {
		let mut database = Database::open_in_memory().unwrap();
		let response = dispatch(
			&mut database,
			request("unknownCommand", serde_json::json!({})),
		);
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INTERNAL");
	}

	#[test]
	fn all_issue_42_read_commands_return_contract_shaped_data() {
		let mut database = seeded_database();
		for (command, assertion) in [
			("getDashboard", "totalFiles"),
			("getDeadlines", "courseId"),
			("getRules", "globalPatternTemplate"),
			("getRuleViolations", "relativePath"),
			("getDuplicateGroups", "members"),
			("getNotificationRules", "offsetMinutes"),
		] {
			let response = dispatch(&mut database, request(command, serde_json::json!({})));
			assert!(response.ok, "{command}: {:?}", response.error);
			let data = response.data.unwrap();
			let contains_field = if let Some(array) = data.as_array() {
				array
					.first()
					.is_some_and(|item| item.get(assertion).is_some())
			} else {
				data.get(assertion).is_some()
			};
			assert!(contains_field, "{command} did not contain {assertion}");
		}
	}

	#[test]
	fn issue_42_write_commands_persist_and_validate_inputs() {
		let mut database = seeded_database();
		let submitted = dispatch(
			&mut database,
			request(
				"updateSubmissionStatus",
				serde_json::json!({ "assignmentId": 2, "submitted": true }),
			),
		);
		assert!(submitted.ok);

		let global = dispatch(
			&mut database,
			request(
				"updateGlobalRule",
				serde_json::json!({ "patternTemplate": "{term}/{course}/第{section}回" }),
			),
		);
		assert!(global.ok);

		let course = dispatch(
			&mut database,
			request(
				"updateCourseRuleOverride",
				serde_json::json!({
					"courseId": 2,
					"override": {
						"splitBySection": false,
						"patternTemplate": "{term}/{course}",
						"note": "まとめて保存"
					}
				}),
			),
		);
		assert!(course.ok, "{:?}", course.error);

		let notifications = dispatch(
			&mut database,
			request(
				"updateNotificationRules",
				serde_json::json!({
					"rules": [{ "id": 2, "offsetMinutes": 1440, "enabled": false }]
				}),
			),
		);
		assert!(notifications.ok);
		assert_eq!(notifications.data.unwrap()["rules"][0]["label"], "1日前");
	}

	#[test]
	fn malformed_payload_is_rejected_without_writing() {
		let mut database = seeded_database();
		let response = dispatch(
			&mut database,
			request(
				"updateSubmissionStatus",
				serde_json::json!({ "assignmentId": "2", "submitted": true }),
			),
		);
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INVALID_REQUEST");
	}
}
