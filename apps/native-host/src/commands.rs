//! Native Messagingコマンドの入力検証・SQLite呼び出し・API DTO変換。

use std::io::Write;
use std::path::Path;

use engine_core::duplicate::{
	DefaultDuplicateDetector, DuplicateDetector, DEFAULT_SIMILARITY_THRESHOLD,
};
use engine_core::index::IndexEngine;
use engine_core::rule::{DefaultRuleEngine, RuleEngine};
use engine_core::section::parse_section_name;
use engine_core::types::RuleContext;
use engine_core::{Database, EngineError, EngineResult, ExtensionRuntimeReport};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::api_types::{
	AppendCheckSimilarFileChunkRequest, AppendSaveFileChunkRequest, Assignment, AssignmentChange,
	BeginCheckSimilarFileRequest, BeginSaveFilesRequest, CheckSimilarFilesTransferRequest,
	CourseFolderNameResolution, DashboardSummary, DataSyncEvent, DuplicateGroupListItem,
	EmptyRequest, ExportDataRequest, ExportDataResult, ExtractZipRequest, ExtractZipResult,
	GetAssignmentChangesRequest, GetDeadlinesRequest, ImportDataRequest, ImportDataResult,
	NotificationRule, NotificationRuleUpdateResult, OkResult, RuleSet, RuleViolationListItem,
	SaveFilesRequest, SaveSuggestion, SearchRequest, SearchResult, SimilarFileMatch,
	SuggestSavePathRequest, UpdateCourseFolderNameRequest, UpdateCourseFolderNameResult,
	UpdateCourseRuleOverrideRequest, UpdateGlobalRuleRequest, UpdateNotificationRulesRequest,
	UpdateSubmissionStatusRequest,
};
use crate::file_transfer::{extract_zip_archive, FileTransferManager};
use crate::protocol::{Request, Response};

const DEFAULT_SEARCH_LIMIT: usize = 50;

pub fn dispatch_with_services(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	file_transfers: &mut FileTransferManager,
	request: Request,
) -> Response {
	match request.command.as_str() {
		"getLatestSyncEvent" => get_latest_sync_event(database, request),
		"getAssignmentChanges" => get_assignment_changes(database, request),
		"search" => search(database, index_engine, request),
		"exportData" => export_data(database, request),
		"importData" => import_data(database, index_engine, request),
		_ => dispatch_with_file_transfers(database, file_transfers, request),
	}
}

/// コマンド名に応じて処理を振り分ける。
#[cfg(test)]
pub fn dispatch(database: &mut Database, request: Request) -> Response {
	let mut file_transfers = FileTransferManager::default();
	dispatch_with_file_transfers(database, &mut file_transfers, request)
}

pub fn dispatch_with_file_transfers(
	database: &mut Database,
	file_transfers: &mut FileTransferManager,
	request: Request,
) -> Response {
	match request.command.as_str() {
		"ping" => ping(request.id),
		"reportExtensionRuntime" => report_extension_runtime(database, request),
		"suggestSavePath" => suggest_save_path(database, request),
		"beginCheckSimilarFile" => begin_check_similar_file(file_transfers, request),
		"appendCheckSimilarFileChunk" => append_check_similar_file_chunk(file_transfers, request),
		"checkSimilarFiles" => check_similar_files(database, file_transfers, request),
		"beginSaveFiles" => begin_save_files(database, file_transfers, request),
		"appendSaveFileChunk" => append_save_file_chunk(file_transfers, request),
		"saveFiles" => save_files(database, file_transfers, request),
		"extractZip" => extract_zip(database, request),
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
		_ => {
			eprintln!(
				"未実装のNative Messagingコマンドを受信しました: {}",
				request.command
			);
			Response::err(
				Some(request.id),
				"INTERNAL",
				"指定されたコマンドは利用できません。",
			)
		}
	}
}

fn get_latest_sync_event(database: &Database, request: Request) -> Response {
	let payload_is_empty = request.payload.is_null()
		|| matches!(&request.payload, serde_json::Value::Object(value) if value.is_empty());
	if !payload_is_empty {
		return Response::err(
			Some(request.id),
			"INVALID_REQUEST",
			"同期履歴の取得条件を解釈できません",
		);
	}

	match database.latest_sync_event() {
		Ok(event) => respond(request.id, Ok(event.map(DataSyncEvent::from))),
		Err(error) => engine_error_response(request.id, error),
	}
}

fn get_assignment_changes(database: &Database, request: Request) -> Response {
	let payload = match serde_json::from_value::<GetAssignmentChangesRequest>(request.payload) {
		Ok(payload) => payload,
		Err(_) => {
			return Response::err(
				Some(request.id),
				"INVALID_REQUEST",
				"課題変更履歴の取得条件を解釈できません",
			);
		}
	};

	let changes = match database.assignment_changes(payload.since_sync_event_id) {
		Ok(changes) => changes,
		Err(error) => return engine_error_response(request.id, error),
	};
	let changes = match changes
		.into_iter()
		.map(AssignmentChange::try_from)
		.collect::<Result<Vec<_>, _>>()
	{
		Ok(changes) => changes,
		Err(error) => return engine_error_response(request.id, error),
	};
	respond(request.id, Ok(changes))
}

fn search(database: &Database, index_engine: &dyn IndexEngine, request: Request) -> Response {
	let payload = match parse_payload::<SearchRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = index_engine
		.search(&payload.query, DEFAULT_SEARCH_LIMIT)
		.and_then(|hits| {
			hits.into_iter()
				.filter_map(|hit| match database.search_document_metadata(hit.file_id) {
					Ok(Some(metadata)) => Some(Ok(SearchResult {
						file_id: metadata.file_id,
						file_name: metadata.file_name,
						course_name: metadata.course_name,
						snippet: hit.snippet,
						page: hit.page,
						score: hit.score,
					})),
					Ok(None) => None,
					Err(error) => Some(Err(error)),
				})
				.collect::<EngineResult<Vec<_>>>()
		});
	respond(request.id, result)
}

fn export_data(database: &Database, request: Request) -> Response {
	let payload = match parse_payload::<ExportDataRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	if payload.file_path.trim().is_empty() {
		return engine_error_response(
			request.id,
			EngineError::InvalidInput {
				field: "filePath".to_string(),
				reason: "エクスポート先を指定してください".to_string(),
			},
		);
	}
	respond(
		request.id,
		database
			.export_to(Path::new(&payload.file_path))
			.map(|()| ExportDataResult {
				file_path: payload.file_path,
			}),
	)
}

fn import_data(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	request: Request,
) -> Response {
	let payload = match parse_payload::<ImportDataRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	if payload.file_path.trim().is_empty() {
		return engine_error_response(
			request.id,
			EngineError::InvalidInput {
				field: "filePath".to_string(),
				reason: "インポート元を指定してください".to_string(),
			},
		);
	}
	let result = database
		.import_from(Path::new(&payload.file_path))
		.and_then(|()| {
			index_engine.clear()?;
			Ok(ImportDataResult {
				ok: true,
				reindex_required: true,
			})
		});
	respond(request.id, result)
}

fn suggest_save_path(database: &mut Database, request: Request) -> Response {
	let payload = match parse_payload::<SuggestSavePathRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = (|| {
		let course = database.resolve_course_context(
			payload.course.moodle_course_id.as_deref(),
			payload.course.name.as_deref(),
			payload.course.academic_year,
			payload.course.term.as_deref(),
		)?;
		let course_folder = database
			.load_course_folder_resolutions()?
			.into_iter()
			.find(|folder| folder.course_id == course.course_id)
			.ok_or_else(|| EngineError::NotFound {
				entity: "コース保存名".to_string(),
				id: course.course_id.to_string(),
			})?;
		let rules = database.load_rule_set()?;
		let base_folder = database.base_folder_path()?;
		let file_name = payload
			.file_meta
			.as_ref()
			.map(|file| file.title.trim())
			.filter(|name| !name.is_empty())
			.unwrap_or("資料");
		let section_title = payload
			.file_meta
			.as_ref()
			.and_then(|file| file.section_title.as_deref())
			.or(payload.course.section_title.as_deref());
		let context = RuleContext {
			course_id: Some(course.course_id),
			course_name: Some(course_folder.folder_name.clone()),
			year: course.academic_year.map(|year| year.to_string()),
			term: course.term,
			assignment: None,
			section: section_title
				.and_then(parse_section_name)
				.and_then(|section| section.number)
				.map(|number| number.to_string()),
		};
		let relative_path = DefaultRuleEngine.suggest_save_path(file_name, &context, &rules)?;
		let path = base_folder.join(&relative_path);
		Ok(vec![SaveSuggestion {
			path: path.to_string_lossy().into_owned(),
			relative_path,
			confidence: 0.92,
			course_folder: course_folder.into(),
		}])
	})();
	respond(request.id, result)
}

fn begin_check_similar_file(
	file_transfers: &mut FileTransferManager,
	request: Request,
) -> Response {
	let payload = match parse_payload::<BeginCheckSimilarFileRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	respond(
		request.id,
		file_transfers
			.begin_similarity(payload)
			.map(|()| OkResult { ok: true }),
	)
}

fn append_check_similar_file_chunk(
	file_transfers: &mut FileTransferManager,
	request: Request,
) -> Response {
	let payload = match parse_payload::<AppendCheckSimilarFileChunkRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	respond(
		request.id,
		file_transfers
			.append_similarity(payload)
			.map(|()| OkResult { ok: true }),
	)
}

fn check_similar_files(
	database: &Database,
	file_transfers: &mut FileTransferManager,
	request: Request,
) -> Response {
	let payload = match parse_payload::<CheckSimilarFilesTransferRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = (|| {
		let bytes = file_transfers.finish_similarity(&payload.transfer_id)?;
		let mut temporary = tempfile::NamedTempFile::new().map_err(EngineError::Io)?;
		temporary.write_all(&bytes).map_err(EngineError::Io)?;
		let detector = DefaultDuplicateDetector::new(database.load_file_fingerprints()?);
		let matches = detector.find_similar(temporary.path(), DEFAULT_SIMILARITY_THRESHOLD)?;
		database.similar_file_records(&matches).map(|records| {
			records
				.into_iter()
				.map(|record| SimilarFileMatch {
					file_id: record.file_id,
					original_name: record.original_name,
					similarity: record.similarity,
				})
				.collect::<Vec<_>>()
		})
	})();
	respond(request.id, result)
}

fn extract_zip(database: &Database, request: Request) -> Response {
	let payload = match parse_payload::<ExtractZipRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = (|| {
		let file_id = payload
			.file_meta
			.moodle_file_id
			.as_deref()
			.unwrap_or(&payload.file_meta.url);
		let source = database.saved_file_path_by_moodle_id(file_id)?;
		let target = std::fs::canonicalize(Path::new(&payload.target_path)).map_err(|_| {
			EngineError::InvalidInput {
				field: "targetPath".to_string(),
				reason: "保存先を確認できません".to_string(),
			}
		})?;
		let source_parent = source
			.parent()
			.and_then(|parent| std::fs::canonicalize(parent).ok())
			.ok_or_else(|| EngineError::InvalidInput {
				field: "fileMeta".to_string(),
				reason: "保存済みZIPの場所を確認できません".to_string(),
			})?;
		if source_parent != target {
			return Err(EngineError::InvalidInput {
				field: "fileMeta".to_string(),
				reason: "指定した保存先にZIPがありません".to_string(),
			});
		}
		let base_folder = database.base_folder_path()?;
		extract_zip_archive(
			&base_folder,
			&source,
			&payload.destination_path,
			payload.flatten,
		)
		.map(|extracted_paths| ExtractZipResult { extracted_paths })
	})();
	respond(request.id, result)
}

fn begin_save_files(
	database: &Database,
	file_transfers: &mut FileTransferManager,
	request: Request,
) -> Response {
	let payload = match parse_payload::<BeginSaveFilesRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = database
		.base_folder_path()
		.and_then(|base_folder| file_transfers.begin(&base_folder, payload))
		.map(|()| OkResult { ok: true });
	respond(request.id, result)
}

fn append_save_file_chunk(file_transfers: &mut FileTransferManager, request: Request) -> Response {
	let payload = match parse_payload::<AppendSaveFileChunkRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	respond(
		request.id,
		file_transfers
			.append(payload)
			.map(|()| OkResult { ok: true }),
	)
}

fn save_files(
	database: &Database,
	file_transfers: &mut FileTransferManager,
	request: Request,
) -> Response {
	let payload = match parse_payload::<SaveFilesRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = database.base_folder_path().and_then(|base_folder| {
		file_transfers.commit(database, &base_folder, &payload.transfer_id)
	});
	respond(request.id, result)
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
		eprintln!(
			"Native Messagingコマンド '{}' の入力解析に失敗しました: {error}",
			request.command
		);
		Response::err(
			Some(request.id.clone()),
			"INVALID_REQUEST",
			"リクエストの内容が不正です。",
		)
	})
}

fn respond<T: Serialize>(id: String, result: EngineResult<T>) -> Response {
	match result {
		Ok(value) => match serde_json::to_value(value) {
			Ok(data) => Response::ok(id, data),
			Err(error) => {
				eprintln!("Native Messaging応答の生成に失敗しました: {error}");
				Response::err(Some(id), "INTERNAL", "応答の生成に失敗しました。")
			}
		},
		Err(error) => engine_error_response(id, error),
	}
}

fn engine_error_response(id: String, error: EngineError) -> Response {
	let code = match &error {
		EngineError::InvalidInput { .. } | EngineError::InvalidPath { .. } => "INVALID_REQUEST",
		EngineError::NotFound { .. } => "NOT_FOUND",
		EngineError::Database { .. } => "DB_ERROR",
		EngineError::RuleConflict { .. } => "RULE_CONFLICT",
		EngineError::Io(_) | EngineError::PathIo { .. } => "IO_ERROR",
		_ => "INTERNAL",
	};
	eprintln!("エンジン処理に失敗しました（{code}）: {error}");
	Response::err(Some(id), code, error.user_message())
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
	use engine_core::types::SearchHit;
	use std::time::{SystemTime, UNIX_EPOCH};

	#[derive(Default)]
	struct TestIndexEngine {
		clear_count: usize,
	}

	impl IndexEngine for TestIndexEngine {
		fn index_file(
			&mut self,
			_database: &Database,
			_file_id: i64,
			_path: &Path,
		) -> EngineResult<()> {
			Ok(())
		}

		fn remove_file(&mut self, _database: &Database, _file_id: i64) -> EngineResult<()> {
			Ok(())
		}

		fn clear(&mut self) -> EngineResult<()> {
			self.clear_count += 1;
			Ok(())
		}

		fn search(&self, _query: &str, _limit: usize) -> EngineResult<Vec<SearchHit>> {
			Ok(Vec::new())
		}
	}

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

	#[test]
	fn ping_returns_version() {
		let mut database = Database::open_in_memory().unwrap();
		let response = dispatch(&mut database, request("ping", serde_json::json!({})));
		assert!(response.ok);
		assert_eq!(response.data.unwrap()["version"], env!("CARGO_PKG_VERSION"));
	}

	#[test]
	fn suggest_save_path_registers_a_new_course_by_moodle_id() {
		let mut database = seeded_database();
		let response = dispatch(
			&mut database,
			request(
				"suggestSavePath",
				serde_json::json!({
					"course": {
						"moodleCourseId": "course-412",
						"name": "Data Science",
						"academicYear": 2026,
						"term": "Spring",
						"sectionTitle": "Section 2",
						"breadcrumbs": []
					},
					"fileMeta": {
						"title": "guide.pdf",
						"url": "https://moodle.example/pluginfile.php/4376/guide.pdf",
						"moodleFileId": "4376",
						"sectionTitle": "Section 2",
						"mimeHint": "pdf"
					}
				}),
			),
		);

		assert!(response.ok, "{:?}", response.error);
		let suggestion = &response.data.unwrap()[0];
		assert!(suggestion["courseFolder"]["courseId"]
			.as_i64()
			.is_some_and(|course_id| course_id > 0));
		assert!(suggestion["relativePath"]
			.as_str()
			.is_some_and(|path| path.contains("Data Science")));
	}

	#[test]
	fn check_similar_files_requires_a_completed_transfer() {
		let mut database = seeded_database();
		let response = dispatch(
			&mut database,
			request(
				"checkSimilarFiles",
				serde_json::json!({
					"fileMeta": {
						"title": "guide.pdf",
						"url": "https://moodle.example/pluginfile.php/4376/guide.pdf",
						"moodleFileId": "4376",
						"sectionTitle": null,
						"mimeHint": "pdf"
					}
				}),
			),
		);

		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INVALID_REQUEST");
	}

	#[test]
	fn check_similar_files_uses_chunked_content_on_one_transfer_manager() {
		let mut database = seeded_database();
		let mut transfers = FileTransferManager::default();
		let begin = dispatch_with_file_transfers(
			&mut database,
			&mut transfers,
			request(
				"beginCheckSimilarFile",
				serde_json::json!({
					"transferId": "similar-command",
					"byteLength": 4
				}),
			),
		);
		assert!(begin.ok, "{:?}", begin.error);

		let append = dispatch_with_file_transfers(
			&mut database,
			&mut transfers,
			request(
				"appendCheckSimilarFileChunk",
				serde_json::json!({
					"transferId": "similar-command",
					"chunkIndex": 0,
					"dataBase64": "dGVzdA=="
				}),
			),
		);
		assert!(append.ok, "{:?}", append.error);

		let checked = dispatch_with_file_transfers(
			&mut database,
			&mut transfers,
			request(
				"checkSimilarFiles",
				serde_json::json!({
					"transferId": "similar-command",
					"fileMeta": {
						"title": "guide.pdf",
						"url": "https://moodle.example/pluginfile.php/4376/guide.pdf",
						"moodleFileId": "4376",
						"sectionTitle": null,
						"mimeHint": "pdf"
					}
				}),
			),
		);
		assert!(checked.ok, "{:?}", checked.error);
		assert!(checked.data.unwrap().is_array());

		let reused = dispatch_with_file_transfers(
			&mut database,
			&mut transfers,
			request(
				"checkSimilarFiles",
				serde_json::json!({
					"transferId": "similar-command",
					"fileMeta": {
						"title": "guide.pdf",
						"url": "https://moodle.example/pluginfile.php/4376/guide.pdf",
						"moodleFileId": "4376",
						"sectionTitle": null,
						"mimeHint": "pdf"
					}
				}),
			),
		);
		assert!(!reused.ok);
		assert_eq!(reused.error.unwrap().code, "INVALID_REQUEST");
	}

	#[test]
	fn service_dispatcher_exports_and_imports_without_duplicating_io_logic() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let backup_path = root.join("backup.sqlite3");
		let backup_path_text = backup_path.to_string_lossy().into_owned();
		let mut database = Database::open(&root.join("current.sqlite3")).unwrap();
		database.apply_development_seed().unwrap();
		let mut index = TestIndexEngine::default();
		let mut transfers = FileTransferManager::default();

		let exported = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"exportData",
				serde_json::json!({ "filePath": backup_path_text }),
			),
		);
		assert!(exported.ok, "{:?}", exported.error);
		assert!(backup_path.exists());

		let imported = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"importData",
				serde_json::json!({ "filePath": backup_path.to_string_lossy() }),
			),
		);
		assert!(imported.ok, "{:?}", imported.error);
		assert_eq!(imported.data.unwrap()["reindexRequired"], true);
		assert_eq!(index.clear_count, 1);

		drop(database);
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn service_dispatcher_preserves_sync_commands_after_merge() {
		let mut database = seeded_database();
		let mut index = TestIndexEngine::default();
		let mut transfers = FileTransferManager::default();

		let latest = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request("getLatestSyncEvent", serde_json::json!({})),
		);
		assert!(latest.ok, "{:?}", latest.error);
		assert!(latest.data.unwrap()["id"].as_i64().is_some());

		let changes = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"getAssignmentChanges",
				serde_json::json!({ "sinceSyncEventId": null }),
			),
		);
		assert!(changes.ok, "{:?}", changes.error);
		assert!(changes.data.unwrap().as_array().is_some());
	}

	#[test]
	fn report_extension_runtime_persists_observation() {
		let mut database = Database::open_in_memory().unwrap();
		let response = dispatch(
			&mut database,
			request(
				"reportExtensionRuntime",
				serde_json::json!({
					"installationId": "550e8400-e29b-41d4-a716-446655440000",
					"extensionVersion": "0.1.0",
					"protocolVersion": 2
				}),
			),
		);
		assert!(response.ok);
		assert_eq!(
			response.data.unwrap()["extensionVersion"],
			serde_json::json!("0.1.0")
		);
		assert_eq!(
			database
				.extension_setup_status_since("2000-01-01T00:00:00.000Z")
				.unwrap()
				.state,
			engine_core::ExtensionSetupState::Ready
		);
	}

	#[test]
	fn report_extension_runtime_rejects_invalid_payload() {
		let mut database = Database::open_in_memory().unwrap();
		let response = dispatch(
			&mut database,
			request(
				"reportExtensionRuntime",
				serde_json::json!({
					"installationId": "../invalid",
					"extensionVersion": "0.1.0",
					"protocolVersion": 2
				}),
			),
		);
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INVALID_REQUEST");
	}

	#[test]
	fn update_course_folder_name_rejects_unknown_course() {
		let mut database = Database::open_in_memory().unwrap();
		let response = dispatch(
			&mut database,
			request(
				"updateCourseFolderName",
				serde_json::json!({
					"courseId": 999,
					"folderName": "別名"
				}),
			),
		);
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "NOT_FOUND");
	}

	#[test]
	fn engine_error_response_hides_paths_and_internal_details() {
		let error = EngineError::PathIo {
			path: "C:\\Users\\sample\\Documents\\大学\\秘密.pdf".to_string(),
			source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied"),
		};

		let response = engine_error_response("req-io".to_string(), error);
		let error = response.error.unwrap();

		assert_eq!(error.code, "IO_ERROR");
		assert_eq!(error.message, "ファイルの読み書きに失敗しました。");
		assert!(!error.message.contains("C:\\"));
		assert!(!error.message.contains("access denied"));
	}

	#[test]
	fn get_rule_violations_and_duplicates_return_relative_paths_only() {
		let mut database = seeded_database();
		for command in ["getRuleViolations", "getDuplicateGroups"] {
			let response = dispatch(&mut database, request(command, serde_json::json!({})));
			assert!(response.ok, "{command}: {:?}", response.error);
			let serialized = response.data.unwrap().to_string();
			assert!(
				!serialized.contains("C:\\"),
				"{command} leaked an absolute Windows path: {serialized}"
			);
		}
	}

	fn unique_temp_dir() -> std::path::PathBuf {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		std::env::temp_dir().join(format!(
			"fuzzy-command-tests-{}-{suffix}",
			std::process::id()
		))
	}
}
