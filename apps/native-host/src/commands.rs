//! Native Messagingコマンドの入力検証・SQLite呼び出し・API DTO変換。

use std::io::Write;
use std::path::Path;
#[cfg(not(windows))]
use std::process::Command;

use engine_core::database::ExtractedFileRegistration;
use engine_core::duplicate::{
	DefaultDuplicateDetector, DuplicateDetector, DEFAULT_SIMILARITY_THRESHOLD,
};
use engine_core::index::{normalize_search_text, IndexEngine};
use engine_core::library::{document_mime_type, is_indexable_document, LibraryMaintenance};
use engine_core::rule::{DefaultRuleEngine, RuleEngine};
use engine_core::section::{parse_section_file_prefix, parse_section_name};
use engine_core::types::RuleContext;
use engine_core::{Database, EngineError, EngineResult, ExtensionRuntimeReport};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::api_types::{
	AppendCheckSimilarFileChunkRequest, AppendSaveFileChunkRequest, Assignment, AssignmentChange,
	BeginCheckSimilarFileRequest, BeginSaveFilesRequest, CheckSimilarFilesTransferRequest,
	ClearCourseRuleOverrideRequest, CourseFolderNameResolution, DashboardSummary, DataSyncEvent,
	DuplicateGroupListItem, EmptyRequest, ExcludedFolder, ExportDataRequest, ExportDataResult,
	ExtractZipRequest, ExtractZipResult, GetAssignmentChangesRequest, GetDeadlinesRequest,
	GetExcludedFoldersRequest, ImportDataRequest, ImportDataResult, LibraryMaintenanceSummary,
	NotificationRule, NotificationRuleUpdateResult, OkResult, OpenFileRequest, OpenFileResult,
	PingResult, RebuildLibraryRequest, ReconcileCourseFilesRequest, RuleSet, RuleViolationListItem,
	SaveFilesRequest, SaveFilesResult, SaveSuggestion, SearchRequest, SearchResult, SearchScope,
	SimilarFileMatch, SuggestSavePathRequest, SyncMoodleAssignmentsRequest,
	UpdateCourseFolderNameRequest, UpdateCourseFolderNameResult, UpdateCourseRuleOverrideRequest,
	UpdateExcludedFoldersRequest, UpdateGlobalRuleRequest, UpdateNotificationRulesRequest,
	UpdateSubmissionStatusRequest,
};
use crate::file_transfer::{extract_zip_archive, FileTransferCommitResult, FileTransferManager};
use crate::protocol::{Request, Response};
use engine_core::EXTENSION_RUNTIME_PROTOCOL_VERSION;

const DEFAULT_SEARCH_LIMIT: usize = 50;
const SEARCH_CANDIDATE_LIMIT: usize = 200;
const MAX_SEARCH_QUERY_CHARS: usize = 256;
const MAX_SEARCH_FOLDER_CHARS: usize = 512;

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
		"openFile" => open_file(database, request),
		"exportData" => export_data(database, request),
		"importData" => import_data(database, index_engine, request),
		"rebuildLibrary" => rebuild_library(database, index_engine, request),
		"reconcileCourseFiles" => reconcile_course_files(database, index_engine, request),
		"saveFiles" => save_files(database, index_engine, file_transfers, request),
		"extractZip" => extract_zip(database, index_engine, request),
		"updateExcludedFolders" => update_excluded_folders(database, index_engine, request),
		_ => dispatch_with_file_transfers(database, file_transfers, request),
	}
}

/// コマンド名に応じて処理を振り分ける。
#[cfg(test)]
fn dispatch(database: &mut Database, request: Request) -> Response {
	let mut file_transfers = FileTransferManager::default();
	dispatch_with_file_transfers(database, &mut file_transfers, request)
}

fn dispatch_with_file_transfers(
	database: &mut Database,
	file_transfers: &mut FileTransferManager,
	request: Request,
) -> Response {
	match request.command.as_str() {
		"ping" => ping(request),
		"reportExtensionRuntime" => report_extension_runtime(database, request),
		"syncMoodleAssignments" => sync_moodle_assignments(database, request),
		"suggestSavePath" => suggest_save_path(database, request),
		"beginCheckSimilarFile" => begin_check_similar_file(file_transfers, request),
		"appendCheckSimilarFileChunk" => append_check_similar_file_chunk(file_transfers, request),
		"checkSimilarFiles" => check_similar_files(database, file_transfers, request),
		"beginSaveFiles" => begin_save_files(database, file_transfers, request),
		"appendSaveFileChunk" => append_save_file_chunk(file_transfers, request),
		"updateCourseFolderName" => update_course_folder_name(database, request),
		"getDashboard" => get_dashboard(database, request),
		"getDeadlines" => get_deadlines(database, request),
		"updateSubmissionStatus" => update_submission_status(database, request),
		"getRules" => get_rules(database, request),
		"updateGlobalRule" => update_global_rule(database, request),
		"updateCourseRuleOverride" => update_course_rule_override(database, request),
		"clearCourseRuleOverride" => clear_course_rule_override(database, request),
		"getExcludedFolders" => get_excluded_folders(database, request),
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

fn sync_moodle_assignments(database: &mut Database, request: Request) -> Response {
	let payload = match parse_payload::<SyncMoodleAssignmentsRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = (|| {
		if !valid_moodle_identifier(&payload.course.moodle_course_id) {
			return Err(EngineError::InvalidInput {
				field: "course.moodleCourseId".to_string(),
				reason: "1文字以上128文字以下の安定IDを指定してください".to_string(),
			});
		}
		if payload.course.name.trim().is_empty() || payload.course.name.chars().count() > 1_000 {
			return Err(EngineError::InvalidInput {
				field: "course.name".to_string(),
				reason: "1文字以上1000文字以下で指定してください".to_string(),
			});
		}
		if payload
			.course
			.term
			.as_deref()
			.is_some_and(|term| term.trim().is_empty() || term.chars().count() > 256)
		{
			return Err(EngineError::InvalidInput {
				field: "course.term".to_string(),
				reason: "1文字以上256文字以下で指定してください".to_string(),
			});
		}
		let assignments = payload
			.assignments
			.into_iter()
			.map(Into::into)
			.collect::<Vec<_>>();
		Database::validate_moodle_assignment_snapshot(&payload.trigger, &assignments)?;
		let course = database.resolve_course_context(
			Some(&payload.course.moodle_course_id),
			Some(&payload.course.name),
			payload.course.academic_year,
			payload.course.term.as_deref(),
		)?;
		database
			.sync_moodle_assignments(&payload.trigger, course.course_id, &assignments)
			.map(DataSyncEvent::from)
	})();
	respond(request.id, result)
}

fn valid_moodle_identifier(value: &str) -> bool {
	!value.is_empty()
		&& value.len() <= 128
		&& value
			.chars()
			.all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

fn search(database: &Database, index_engine: &dyn IndexEngine, request: Request) -> Response {
	let payload = match parse_payload::<SearchRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let query = payload.query.trim();
	if query.is_empty() || query.chars().count() > MAX_SEARCH_QUERY_CHARS {
		return engine_error_response(
			request.id,
			EngineError::InvalidInput {
				field: "query".to_string(),
				reason: format!("1〜{MAX_SEARCH_QUERY_CHARS}文字で指定してください"),
			},
		);
	}
	let normalized_query = normalize_search_text(query);
	if normalized_query.is_empty() {
		return engine_error_response(
			request.id,
			EngineError::InvalidInput {
				field: "query".to_string(),
				reason: "検索できる文字を1文字以上指定してください".to_string(),
			},
		);
	}
	let scope = match normalize_search_scope(payload.scope) {
		Ok(scope) => scope,
		Err(error) => return engine_error_response(request.id, error),
	};
	let result = index_engine
		.search(query, SEARCH_CANDIDATE_LIMIT)
		.and_then(|hits| {
			let mut results = hits
				.into_iter()
				.filter_map(|hit| match database.search_document_metadata(hit.file_id) {
					Ok(Some(metadata)) if search_scope_matches(scope.as_ref(), &metadata) => {
						let file_stem = Path::new(&metadata.file_name)
							.file_stem()
							.and_then(|value| value.to_str())
							.unwrap_or(&metadata.file_name);
						let normalized_file_name = normalize_search_text(file_stem);
						let filename_boost = if normalized_file_name == normalized_query {
							0.5
						} else if normalized_file_name.contains(&normalized_query) {
							0.1
						} else {
							0.0
						};
						Some(Ok((
							SearchResult {
								file_id: metadata.file_id,
								file_name: metadata.file_name,
								course_name: metadata.course_name,
								relative_path: metadata.relative_path,
								snippet: hit.snippet,
								page: hit.page.filter(|page| {
									*page >= 1
										&& metadata
											.page_count
											.is_none_or(|page_count| *page <= page_count)
								}),
								page_count: metadata.page_count,
								score: hit.score + filename_boost,
							},
							metadata.modified_at,
						)))
					}
					Ok(Some(_)) => None,
					Ok(None) => None,
					Err(error) => Some(Err(error)),
				})
				.collect::<EngineResult<Vec<_>>>()?;
			results.sort_by(|(left, left_modified), (right, right_modified)| {
				right
					.score
					.total_cmp(&left.score)
					.then_with(|| right_modified.cmp(left_modified))
			});
			results.truncate(DEFAULT_SEARCH_LIMIT);
			Ok(results
				.into_iter()
				.map(|(result, _)| result)
				.collect::<Vec<_>>())
		});
	respond(request.id, result)
}

fn normalize_search_scope(scope: Option<SearchScope>) -> EngineResult<Option<SearchScope>> {
	let Some(mut scope) = scope else {
		return Ok(None);
	};
	if scope.course_id.is_some_and(|course_id| course_id <= 0) {
		return Err(EngineError::InvalidInput {
			field: "scope.courseId".to_string(),
			reason: "1以上のコースIDを指定してください".to_string(),
		});
	}
	if let Some(folder) = scope.folder.take() {
		let folder = folder.trim().replace('\\', "/");
		if folder.len() > MAX_SEARCH_FOLDER_CHARS
			|| folder.is_empty()
			|| folder.starts_with('/')
			|| folder.ends_with('/')
			|| folder
				.split('/')
				.any(|part| part.is_empty() || part == "." || part == ".." || part.contains(':'))
		{
			return Err(EngineError::InvalidInput {
				field: "scope.folder".to_string(),
				reason: "保存ルートからの相対フォルダーを指定してください".to_string(),
			});
		}
		scope.folder = Some(folder);
	}
	if scope.course_id.is_none() && scope.folder.is_none() {
		return Ok(None);
	}
	Ok(Some(scope))
}

fn search_scope_matches(
	scope: Option<&SearchScope>,
	metadata: &engine_core::types::SearchDocumentMetadata,
) -> bool {
	let Some(scope) = scope else {
		return true;
	};
	if scope
		.course_id
		.is_some_and(|course_id| metadata.course_id != Some(course_id))
	{
		return false;
	}
	scope.folder.as_ref().is_none_or(|folder| {
		let relative_path = metadata.relative_path.replace('\\', "/");
		relative_path == *folder || relative_path.starts_with(&format!("{folder}/"))
	})
}

fn open_file(database: &Database, request: Request) -> Response {
	let payload = match parse_payload::<OpenFileRequest>(&request) {
		Ok(payload) if payload.file_id > 0 && payload.page.is_none_or(|page| page > 0) => payload,
		Ok(_) => {
			return Response::err(
				Some(request.id),
				"INVALID_REQUEST",
				"開く資料の指定が不正です",
			)
		}
		Err(response) => return response,
	};
	let result = (|| {
		let path = database
			.openable_file_path(payload.file_id)?
			.ok_or_else(|| EngineError::InvalidInput {
				field: "fileId".to_string(),
				reason: "資料を開けませんでした".to_string(),
			})?;
		open_path_with_default_application(&path)?;
		Ok(OpenFileResult {
			opened: true,
			page: payload.page,
		})
	})();
	respond(request.id, result)
}

fn open_path_with_default_application(path: &Path) -> EngineResult<()> {
	#[cfg(windows)]
	{
		use std::iter::once;
		use std::os::windows::ffi::OsStrExt;
		use windows_sys::Win32::UI::Shell::ShellExecuteW;
		use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

		let operation = "open".encode_utf16().chain(once(0)).collect::<Vec<_>>();
		let path = path
			.as_os_str()
			.encode_wide()
			.chain(once(0))
			.collect::<Vec<_>>();
		let result = unsafe {
			ShellExecuteW(
				std::ptr::null_mut(),
				operation.as_ptr(),
				path.as_ptr(),
				std::ptr::null(),
				std::ptr::null(),
				SW_SHOWNORMAL,
			)
		};
		if result as usize <= 32 {
			return Err(EngineError::InvalidInput {
				field: "fileId".to_string(),
				reason: "資料を開くアプリケーションを起動できませんでした".to_string(),
			});
		}
		Ok(())
	}
	#[cfg(target_os = "macos")]
	{
		Command::new("open")
			.arg(path)
			.spawn()
			.map(|_| ())
			.map_err(EngineError::Io)
	}
	#[cfg(all(unix, not(target_os = "macos")))]
	{
		Command::new("xdg-open")
			.arg(path)
			.spawn()
			.map(|_| ())
			.map_err(EngineError::Io)
	}
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
		.map(|()| {
			// import_fromは置換前のステージングDBでsearch_index_metaを全削除する。
			// そのため物理索引の削除に失敗しても検索APIは古い文書を公開しない。
			// DBだけ復元済みの状態を「復元失敗」と誤報せず、物理索引の削除は
			// ベストエフォートとしてローカルログへ残す。
			if let Err(error) = index_engine.clear() {
				eprintln!("バックアップ復元後の物理索引削除に失敗しました: {error}");
			}
			// 別プロセスの保存がDB復元と物理索引削除の間に完了しても、
			// 削除済みの索引を有効と扱わない。次回の再走査で安全に再構築する。
			if let Err(error) = database.clear_search_index_meta() {
				eprintln!("バックアップ復元後の索引メタデータ再無効化に失敗しました: {error}");
			}
			ImportDataResult {
				ok: true,
				reindex_required: true,
			}
		});
	respond(request.id, result)
}

fn rebuild_library(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	request: Request,
) -> Response {
	let payload = match parse_payload::<RebuildLibraryRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	respond(
		request.id,
		LibraryMaintenance::reconcile(
			database,
			index_engine,
			payload.rebuild_index.unwrap_or(false),
		)
		.map(LibraryMaintenanceSummary::from),
	)
}

fn reconcile_course_files(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	request: Request,
) -> Response {
	let payload = match parse_payload::<ReconcileCourseFilesRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = (|| {
		if !valid_moodle_identifier(&payload.course.moodle_course_id) {
			return Err(EngineError::InvalidInput {
				field: "course.moodleCourseId".to_string(),
				reason: "1文字以上128文字以下の安定IDを指定してください".to_string(),
			});
		}
		if payload.course.name.trim().is_empty() || payload.course.name.chars().count() > 1_000 {
			return Err(EngineError::InvalidInput {
				field: "course.name".to_string(),
				reason: "1文字以上1000文字以下で指定してください".to_string(),
			});
		}
		let course = database.resolve_course_context(
			Some(&payload.course.moodle_course_id),
			Some(&payload.course.name),
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
		let context = RuleContext {
			course_id: Some(course.course_id),
			course_name: Some(course_folder.folder_name),
			year: course.academic_year.map(|year| year.to_string()),
			term: course.term,
			assignment: None,
			section: None,
		};
		let relative_root = DefaultRuleEngine.suggest_course_root(&context, &rules)?;
		LibraryMaintenance::reconcile_course(
			database,
			index_engine,
			course.course_id,
			&base_folder.join(relative_root),
		)
		.map(LibraryMaintenanceSummary::from)
	})();
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

fn extract_zip(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	request: Request,
) -> Response {
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
		let source = database.saved_zip_source_by_moodle_id(file_id)?;
		let target = std::fs::canonicalize(Path::new(&payload.target_path)).map_err(|_| {
			EngineError::InvalidInput {
				field: "targetPath".to_string(),
				reason: "保存先を確認できません".to_string(),
			}
		})?;
		let source_parent = source
			.saved_path
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
		let pending = extract_zip_archive(
			&base_folder,
			&source.saved_path,
			&payload.destination_path,
			payload.flatten,
		)?;
		let registrations = pending
			.paths()
			.iter()
			.map(|path| {
				let path = Path::new(path);
				let metadata = path.metadata().map_err(EngineError::Io)?;
				let fingerprint = DefaultDuplicateDetector::default().fingerprint(path)?;
				let original_name = path
					.file_name()
					.and_then(|name| name.to_str())
					.ok_or_else(|| EngineError::InvalidInput {
						field: "destinationPath".to_string(),
						reason: "展開ファイル名をSQLiteへ登録できません".to_string(),
					})?
					.to_string();
				Ok(ExtractedFileRegistration {
					section_no: parse_section_file_prefix(&original_name)
						.and_then(|section| section.number)
						.map(i64::from),
					original_name,
					saved_path: path.to_path_buf(),
					size_bytes: i64::try_from(metadata.len()).map_err(|_| {
						EngineError::InvalidInput {
							field: "fileMeta".to_string(),
							reason: "展開ファイルのサイズをSQLiteへ登録できません".to_string(),
						}
					})?,
					mime_type: document_mime_type(path).map(str::to_string),
					hash_blake3: fingerprint.hash_blake3,
					simhash: fingerprint.simhash,
				})
			})
			.collect::<EngineResult<Vec<_>>>()?;
		let database_ids =
			database.register_extracted_files_from_source(source.file_id, &registrations)?;
		let extracted_paths = pending.commit();
		for (database_id, path) in database_ids.iter().copied().zip(&extracted_paths) {
			let path = Path::new(path);
			if is_indexable_document(path) {
				if let Err(error) = index_engine.index_file(database, database_id, path) {
					eprintln!(
						"ZIP展開済みファイルを全文索引へ追加できませんでした（file_id={database_id}）: {error}"
					);
				}
			}
		}
		if database_ids.len() != extracted_paths.len() {
			eprintln!(
				"ZIP展開後のSQLite ID数とファイル数が一致しませんでした（ids={}, paths={}）",
				database_ids.len(),
				extracted_paths.len()
			);
		}
		refresh_saved_file_derivatives(database, "ZIP展開後");
		Ok(ExtractZipResult { extracted_paths })
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
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	file_transfers: &mut FileTransferManager,
	request: Request,
) -> Response {
	let payload = match parse_payload::<SaveFilesRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = database
		.base_folder_path()
		.and_then(|base_folder| file_transfers.commit(database, &base_folder, &payload.transfer_id))
		.map(|committed| index_committed_files(database, index_engine, committed));
	respond(request.id, result)
}

fn index_committed_files(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	committed: FileTransferCommitResult,
) -> SaveFilesResult {
	let has_saved_files = !committed.response.saved_file_ids.is_empty();
	for file in committed.files_to_index {
		if let Err(error) = index_engine.index_file(database, file.database_id, &file.path) {
			// 保存とSQLite登録は完了済みなので、索引失敗で利用者のファイルを
			// 削除しない。search_index_metaはindex_file成功時だけ作られるため、
			// 未索引ファイルが誤った検索結果として公開されることもない。
			eprintln!(
				"保存済みファイルを全文索引へ追加できませんでした（file_id={}）: {error}",
				file.database_id
			);
		}
	}
	if has_saved_files {
		refresh_saved_file_derivatives(database, "保存後");
	}
	committed.response
}

fn refresh_saved_file_derivatives(database: &mut Database, operation: &str) {
	if let Err(error) = database.refresh_rule_compliance(&DefaultRuleEngine) {
		eprintln!("{operation}のルール適合状況を更新できませんでした: {error}");
	}
	if let Err(error) = database.refresh_duplicate_groups(
		&DefaultDuplicateDetector::default(),
		DEFAULT_SIMILARITY_THRESHOLD,
	) {
		eprintln!("{operation}の重複グループを更新できませんでした: {error}");
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

fn clear_course_rule_override(database: &mut Database, request: Request) -> Response {
	let payload = match parse_payload::<ClearCourseRuleOverrideRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	respond(
		request.id,
		database
			.clear_course_rule_override(payload.course_id, &DefaultRuleEngine)
			.map(|()| OkResult { ok: true }),
	)
}

fn get_excluded_folders(database: &Database, request: Request) -> Response {
	let payload = match parse_payload::<GetExcludedFoldersRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	respond(
		request.id,
		database
			.list_excluded_folders(payload.course_id)
			.map(|folders| {
				folders
					.into_iter()
					.map(ExcludedFolder::from)
					.collect::<Vec<_>>()
			}),
	)
}

fn update_excluded_folders(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	request: Request,
) -> Response {
	let payload = match parse_payload::<UpdateExcludedFoldersRequest>(&request) {
		Ok(payload) => payload,
		Err(response) => return response,
	};
	let result = (|| {
		let folders = database.update_excluded_folders(
			&payload.scope,
			payload.course_id,
			&payload.paths,
			&DefaultRuleEngine,
		)?;
		if database.base_folder_path().is_ok() {
			LibraryMaintenance::reconcile(database, index_engine, false)?;
		}
		refresh_saved_file_derivatives(database, "除外フォルダー変更");
		Ok(folders)
	})();
	respond(
		request.id,
		result.map(|folders| {
			folders
				.into_iter()
				.map(ExcludedFolder::from)
				.collect::<Vec<_>>()
		}),
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
			.update_course_folder_name(
				update.course_id,
				update.folder_name.as_deref(),
				&DefaultRuleEngine,
			)
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
		EngineError::SetupConflict { .. } => "SETUP_CONFLICT",
		EngineError::Io(_) | EngineError::PathIo { .. } => "IO_ERROR",
		_ => "INTERNAL",
	};
	eprintln!("エンジン処理に失敗しました（{code}）: {error}");
	Response::err(Some(id), code, error.user_message())
}

/// `ping`：疎通確認（docs/api/contract.md 1.2節）。`{}` → `{ version, protocolVersion }`。
fn ping(request: Request) -> Response {
	if let Err(response) = parse_payload::<EmptyRequest>(&request) {
		return response;
	}
	respond(
		request.id,
		Ok(PingResult {
			version: env!("CARGO_PKG_VERSION").to_string(),
			protocol_version: EXTENSION_RUNTIME_PROTOCOL_VERSION,
		}),
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	use engine_core::types::{AssignmentSyncInput, SavedFileRegistration, SearchHit};
	use std::time::{SystemTime, UNIX_EPOCH};
	use zip::write::SimpleFileOptions;

	#[derive(Default)]
	struct TestIndexEngine {
		clear_count: usize,
		fail_clear: bool,
		fail_index: bool,
		indexed_file_ids: Vec<i64>,
		indexed_paths: Vec<std::path::PathBuf>,
		search_hits: Vec<SearchHit>,
	}

	impl IndexEngine for TestIndexEngine {
		fn index_file(
			&mut self,
			database: &Database,
			file_id: i64,
			path: &Path,
		) -> EngineResult<()> {
			if self.fail_index {
				return Err(EngineError::Index {
					message: "テスト用の索引追加失敗".to_string(),
				});
			}
			self.indexed_file_ids.push(file_id);
			self.indexed_paths.push(path.to_path_buf());
			database.mark_search_indexed(file_id, None)?;
			Ok(())
		}

		fn remove_file(&mut self, _database: &Database, _file_id: i64) -> EngineResult<()> {
			Ok(())
		}

		fn clear(&mut self) -> EngineResult<()> {
			self.clear_count += 1;
			if self.fail_clear {
				return Err(EngineError::Index {
					message: "テスト用の索引削除失敗".to_string(),
				});
			}
			Ok(())
		}

		fn search(&self, _query: &str, _limit: usize) -> EngineResult<Vec<SearchHit>> {
			Ok(self.search_hits.clone())
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
	fn every_native_api_command_is_routed_by_the_runtime_dispatcher() {
		let mut database = seeded_database();
		let mut index = TestIndexEngine::default();
		let mut transfers = FileTransferManager::default();
		for command in [
			"ping",
			"reportExtensionRuntime",
			"suggestSavePath",
			"beginCheckSimilarFile",
			"appendCheckSimilarFileChunk",
			"checkSimilarFiles",
			"beginSaveFiles",
			"appendSaveFileChunk",
			"saveFiles",
			"extractZip",
			"search",
			"openFile",
			"getDashboard",
			"getDeadlines",
			"updateSubmissionStatus",
			"getRules",
			"updateGlobalRule",
			"updateCourseRuleOverride",
			"updateCourseFolderName",
			"getRuleViolations",
			"getDuplicateGroups",
			"getNotificationRules",
			"updateNotificationRules",
			"syncMoodleAssignments",
			"getLatestSyncEvent",
			"getAssignmentChanges",
			"exportData",
			"importData",
			"rebuildLibrary",
		] {
			let response = dispatch_with_services(
				&mut database,
				&mut index,
				&mut transfers,
				request(command, serde_json::json!({})),
			);
			assert_ne!(
				response.error.as_ref().map(|error| error.message.as_str()),
				Some("指定されたコマンドは利用できません。"),
				"{command} was not routed"
			);
		}
	}

	#[test]
	fn open_file_rejects_invalid_ids_before_touching_the_os() {
		let mut database = Database::open_in_memory().unwrap();
		let mut index = TestIndexEngine::default();
		let mut transfers = FileTransferManager::default();
		let response = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request("openFile", serde_json::json!({ "fileId": 0, "page": 0 })),
		);
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INVALID_REQUEST");
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
		let data = response.data.unwrap();
		assert_eq!(data["version"], env!("CARGO_PKG_VERSION"));
		assert_eq!(data["protocolVersion"], EXTENSION_RUNTIME_PROTOCOL_VERSION);
	}

	#[test]
	fn ping_rejects_non_empty_payload() {
		let mut database = Database::open_in_memory().unwrap();
		let response = dispatch(
			&mut database,
			request("ping", serde_json::json!({ "unexpected": true })),
		);
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INVALID_REQUEST");
	}

	#[test]
	fn search_rejects_empty_and_oversized_queries_at_the_host_boundary() {
		let database = Database::open_in_memory().unwrap();
		let index = TestIndexEngine::default();

		for query in [" \t".to_string(), "あ".repeat(MAX_SEARCH_QUERY_CHARS + 1)] {
			let response = search(
				&database,
				&index,
				request("search", serde_json::json!({ "query": query })),
			);
			assert!(!response.ok);
			assert_eq!(response.error.unwrap().code, "INVALID_REQUEST");
		}

		let response = search(
			&database,
			&index,
			request(
				"search",
				serde_json::json!({ "query": "あ".repeat(MAX_SEARCH_QUERY_CHARS) }),
			),
		);
		assert!(response.ok, "{:?}", response.error);
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
	fn rebuild_library_registers_existing_files_and_rebuilds_the_index() {
		let root = unique_temp_dir();
		let course = root.join("データベース");
		std::fs::create_dir_all(&course).unwrap();
		std::fs::write(course.join("第4回_正規化.txt"), "normalization").unwrap();
		let mut database = Database::open_in_memory().unwrap();
		database
			.save_initial_setup(
				&root,
				"course-assignment",
				"{course}/{assignment}",
				"estimated-1",
				Some(0),
				"[]",
			)
			.unwrap();
		let mut index = TestIndexEngine::default();
		let mut transfers = FileTransferManager::default();

		let rebuilt = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"rebuildLibrary",
				serde_json::json!({ "rebuildIndex": true }),
			),
		);

		assert!(rebuilt.ok, "{:?}", rebuilt.error);
		let summary = rebuilt.data.unwrap();
		assert_eq!(summary["scannedFileCount"], 1);
		assert_eq!(summary["registeredFileCount"], 1);
		assert_eq!(summary["indexedFileCount"], 1);
		assert_eq!(summary["warnings"], serde_json::json!([]));
		assert_eq!(index.clear_count, 1);
		assert_eq!(index.indexed_file_ids.len(), 1);
		assert_eq!(database.dashboard().unwrap().total_files, 1);

		let invalid = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request("rebuildLibrary", serde_json::json!({ "unexpected": true })),
		);
		assert!(!invalid.ok);
		assert_eq!(invalid.error.unwrap().code, "INVALID_REQUEST");
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn changing_excluded_folders_reconciles_files_before_unexcluding_them() {
		let root = unique_temp_dir();
		let course = root.join("Data Science");
		std::fs::create_dir_all(&course).unwrap();
		let file = course.join("notes.txt");
		std::fs::write(&file, "before").unwrap();
		let mut database = Database::open_in_memory().unwrap();
		database
			.save_initial_setup(
				&root,
				"course-assignment",
				"{course}/{assignment}",
				"estimated-1",
				Some(0),
				"[]",
			)
			.unwrap();
		let mut index = TestIndexEngine::default();
		let mut transfers = FileTransferManager::default();

		let rebuilt = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"rebuildLibrary",
				serde_json::json!({ "rebuildIndex": true }),
			),
		);
		assert!(rebuilt.ok, "{:?}", rebuilt.error);
		let file_id = database.registered_library_files().unwrap()[0].file_id;

		let excluded = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"updateExcludedFolders",
				serde_json::json!({
					"scope": "root",
					"courseId": null,
					"paths": ["Data Science"]
				}),
			),
		);
		assert!(excluded.ok, "{:?}", excluded.error);

		std::fs::write(&file, "after changed").unwrap();
		let unexcluded = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"updateExcludedFolders",
				serde_json::json!({
					"scope": "root",
					"courseId": null,
					"paths": []
				}),
			),
		);
		assert!(unexcluded.ok, "{:?}", unexcluded.error);
		assert!(
			index
				.indexed_file_ids
				.iter()
				.filter(|indexed_id| **indexed_id == file_id)
				.count() >= 2
		);

		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn reconcile_course_files_scans_only_the_requested_moodle_course() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(root.join("データベース")).unwrap();
		std::fs::create_dir_all(root.join("離散数学")).unwrap();
		std::fs::write(root.join("データベース").join("A.txt"), "database").unwrap();
		std::fs::write(root.join("離散数学").join("B.txt"), "discrete").unwrap();
		let mut database = Database::open_in_memory().unwrap();
		database
			.save_initial_setup(
				&root,
				"course-assignment",
				"{course}/{assignment}",
				"estimated-1",
				Some(0),
				"[]",
			)
			.unwrap();
		let mut index = TestIndexEngine::default();
		let mut transfers = FileTransferManager::default();

		let response = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"reconcileCourseFiles",
				serde_json::json!({
					"course": {
						"moodleCourseId": "412",
						"name": "データベース",
						"academicYear": 2026,
						"term": "前期"
					}
				}),
			),
		);

		assert!(response.ok, "{:?}", response.error);
		assert_eq!(response.data.unwrap()["scannedFileCount"], 1);
		assert_eq!(database.dashboard().unwrap().total_files, 1);
		assert_eq!(index.indexed_paths.len(), 1);
		assert_eq!(
			index.indexed_paths[0].canonicalize().unwrap(),
			root.join("データベース")
				.join("A.txt")
				.canonicalize()
				.unwrap()
		);
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn extract_zip_registers_context_and_indexes_only_supported_documents_immediately() {
		let root = unique_temp_dir();
		let course = root.join("データベース");
		std::fs::create_dir_all(&course).unwrap();
		let archive_path = course.join("第4回_資料.zip");
		let archive = std::fs::File::create(&archive_path).unwrap();
		let mut writer = zip::ZipWriter::new(archive);
		writer
			.start_file("第4回_正規化.txt", SimpleFileOptions::default())
			.unwrap();
		writer.write_all(b"normalization").unwrap();
		writer
			.start_file("第4回_添付.bin", SimpleFileOptions::default())
			.unwrap();
		writer.write_all(b"normalization").unwrap();
		writer.finish().unwrap();

		let mut database = Database::open_in_memory().unwrap();
		database
			.save_initial_setup(
				&root,
				"course-assignment",
				"{course}/{assignment}",
				"estimated-1",
				Some(0),
				"[]",
			)
			.unwrap();
		let canonical_root = database.base_folder_path().unwrap();
		let canonical_course = canonical_root.join("データベース");
		let canonical_archive_path = canonical_course.join("第4回_資料.zip");
		let fingerprint = DefaultDuplicateDetector::default()
			.fingerprint(&canonical_archive_path)
			.unwrap();
		let course_context = database
			.resolve_course_context(
				Some("moodle-course-db"),
				Some("データベース"),
				Some(2026),
				Some("前期"),
			)
			.unwrap();
		let archive_size = canonical_archive_path.metadata().unwrap().len();
		database
			.register_saved_file(&SavedFileRegistration {
				course_id: Some(course_context.course_id),
				section_no: Some(4),
				moodle_file_id: Some("zip-4".to_string()),
				original_name: "第4回_資料.zip".to_string(),
				saved_path: canonical_archive_path,
				size_bytes: i64::try_from(archive_size).unwrap(),
				mime_type: Some("application/zip".to_string()),
				hash_blake3: fingerprint.hash_blake3,
				simhash: fingerprint.simhash,
			})
			.unwrap();
		let destination = canonical_course.join("展開済み");
		let mut index = TestIndexEngine::default();
		let mut transfers = FileTransferManager::default();

		let response = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"extractZip",
				serde_json::json!({
					"fileMeta": {
						"title": "第4回_資料.zip",
						"url": "https://moodle.example/pluginfile.php/4/material.zip",
						"moodleFileId": "zip-4",
						"sectionTitle": "第4回",
						"mimeHint": "application/zip"
					},
					"targetPath": canonical_course.to_string_lossy(),
					"destinationPath": destination.to_string_lossy(),
					"flatten": false
				}),
			),
		);

		assert!(response.ok, "{:?}", response.error);
		let text_path = destination.join("第4回_正規化.txt");
		let binary_path = destination.join("第4回_添付.bin");
		assert!(text_path.is_file());
		assert!(binary_path.is_file());
		assert_eq!(database.dashboard().unwrap().total_files, 3);
		assert_eq!(database.registered_library_files().unwrap().len(), 3);
		assert_eq!(index.indexed_paths, vec![text_path.clone()]);
		let text_file_id = database
			.registered_library_files()
			.unwrap()
			.into_iter()
			.find(|file| file.saved_path == text_path)
			.unwrap()
			.file_id;
		let metadata = database
			.search_document_metadata(text_file_id)
			.unwrap()
			.unwrap();
		assert_eq!(metadata.course_name.as_deref(), Some("データベース"));
		let rule_file = database
			.load_rule_files()
			.unwrap()
			.into_iter()
			.find(|file| file.saved_path == text_path)
			.unwrap();
		assert_eq!(rule_file.context.course_id, Some(course_context.course_id));
		assert!(database
			.rule_violations()
			.unwrap()
			.into_iter()
			.any(|violation| violation.file_id == text_file_id));
		assert_eq!(database.duplicate_groups().unwrap().len(), 1);
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn extract_zip_keeps_files_and_db_rows_when_immediate_indexing_fails() {
		let root = unique_temp_dir();
		let course = root.join("認知科学概論");
		std::fs::create_dir_all(&course).unwrap();
		let archive_path = course.join("第3回_資料.zip");
		let archive = std::fs::File::create(&archive_path).unwrap();
		let mut writer = zip::ZipWriter::new(archive);
		writer
			.start_file("第3回_講義メモ.txt", SimpleFileOptions::default())
			.unwrap();
		writer.write_all(b"cognition").unwrap();
		writer.finish().unwrap();

		let mut database = Database::open_in_memory().unwrap();
		database
			.save_initial_setup(
				&root,
				"course-assignment",
				"{course}/{assignment}",
				"estimated-1",
				Some(0),
				"[]",
			)
			.unwrap();
		let canonical_course = database.base_folder_path().unwrap().join("認知科学概論");
		let canonical_archive = canonical_course.join("第3回_資料.zip");
		let fingerprint = DefaultDuplicateDetector::default()
			.fingerprint(&canonical_archive)
			.unwrap();
		database
			.register_saved_file(&SavedFileRegistration {
				course_id: None,
				section_no: Some(3),
				moodle_file_id: Some("zip-3".to_string()),
				original_name: "第3回_資料.zip".to_string(),
				saved_path: canonical_archive.clone(),
				size_bytes: i64::try_from(canonical_archive.metadata().unwrap().len()).unwrap(),
				mime_type: Some("application/zip".to_string()),
				hash_blake3: fingerprint.hash_blake3,
				simhash: fingerprint.simhash,
			})
			.unwrap();
		let destination = canonical_course.join("展開済み");
		let mut index = TestIndexEngine {
			fail_index: true,
			..Default::default()
		};
		let mut transfers = FileTransferManager::default();

		let response = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"extractZip",
				serde_json::json!({
					"fileMeta": {
						"title": "第3回_資料.zip",
						"url": "https://moodle.example/pluginfile.php/3/material.zip",
						"moodleFileId": "zip-3",
						"sectionTitle": "第3回",
						"mimeHint": "application/zip"
					},
					"targetPath": canonical_course.to_string_lossy(),
					"destinationPath": destination.to_string_lossy(),
					"flatten": false
				}),
			),
		);

		assert!(response.ok, "{:?}", response.error);
		let extracted_path = destination.join("第3回_講義メモ.txt");
		assert!(extracted_path.is_file());
		assert_eq!(database.dashboard().unwrap().total_files, 2);
		let extracted_id = database
			.registered_library_files()
			.unwrap()
			.into_iter()
			.find(|file| file.saved_path == extracted_path)
			.unwrap()
			.file_id;
		assert!(database
			.search_document_metadata(extracted_id)
			.unwrap()
			.is_none());
		assert!(index.indexed_file_ids.is_empty());
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn committed_files_are_indexed_and_immediately_searchable() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let path = root.join("第4回_正規化.txt");
		std::fs::write(&path, "正規化").unwrap();
		let mut database = Database::open_in_memory().unwrap();
		let database_id = database
			.register_saved_file(&SavedFileRegistration {
				course_id: None,
				section_no: Some(4),
				moodle_file_id: Some("moodle-41".to_string()),
				original_name: "第4回_正規化.txt".to_string(),
				saved_path: path.clone(),
				size_bytes: 9,
				mime_type: Some("text/plain".to_string()),
				hash_blake3: "b3:test-41".to_string(),
				simhash: 41,
			})
			.unwrap();
		let committed = FileTransferCommitResult {
			response: SaveFilesResult {
				saved_file_ids: vec!["moodle-41".to_string()],
				failed_files: Vec::new(),
			},
			files_to_index: vec![crate::file_transfer::SavedFileForIndex { database_id, path }],
		};
		let mut index = TestIndexEngine::default();

		let response = index_committed_files(&mut database, &mut index, committed);
		assert_eq!(response.saved_file_ids, vec!["moodle-41"]);
		assert_eq!(index.indexed_file_ids, vec![database_id]);

		index.search_hits.push(SearchHit {
			file_id: database_id,
			snippet: "正規化".to_string(),
			page: None,
			score: 1.0,
		});
		let searched = search(
			&database,
			&index,
			request("search", serde_json::json!({ "query": "正規化" })),
		);
		assert!(searched.ok, "{:?}", searched.error);
		assert_eq!(searched.data.unwrap().as_array().unwrap().len(), 1);

		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn search_rejects_a_stale_pdf_page_outside_the_current_page_count() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let path = root.join("第4回_正規化.pdf");
		std::fs::write(&path, b"%PDF-test").unwrap();
		let database = Database::open_in_memory().unwrap();
		let file_id = database
			.register_saved_file(&SavedFileRegistration {
				course_id: None,
				section_no: Some(4),
				moodle_file_id: Some("pdf-41".to_string()),
				original_name: "第4回_正規化.pdf".to_string(),
				saved_path: path,
				size_bytes: 9,
				mime_type: Some("application/pdf".to_string()),
				hash_blake3: "b3:pdf-41".to_string(),
				simhash: 41,
			})
			.unwrap();
		database.mark_search_indexed(file_id, Some(12)).unwrap();
		let mut index = TestIndexEngine::default();
		index.search_hits.push(SearchHit {
			file_id,
			snippet: "正規化".to_string(),
			page: Some(153),
			score: 1.0,
		});

		let response = search(
			&database,
			&index,
			request("search", serde_json::json!({ "query": "正規化" })),
		);

		assert!(response.ok, "{:?}", response.error);
		let result = &response.data.unwrap()[0];
		assert_eq!(result["page"], serde_json::Value::Null);
		assert_eq!(result["pageCount"], 12);
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn index_failure_keeps_the_saved_file_but_does_not_publish_a_stale_hit() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let path = root.join("講義メモ.txt");
		std::fs::write(&path, "認知科学").unwrap();
		let mut database = Database::open_in_memory().unwrap();
		let database_id = database
			.register_saved_file(&SavedFileRegistration {
				course_id: None,
				section_no: None,
				moodle_file_id: Some("moodle-99".to_string()),
				original_name: "講義メモ.txt".to_string(),
				saved_path: path.clone(),
				size_bytes: 12,
				mime_type: Some("text/plain".to_string()),
				hash_blake3: "b3:test-99".to_string(),
				simhash: 99,
			})
			.unwrap();
		let committed = FileTransferCommitResult {
			response: SaveFilesResult {
				saved_file_ids: vec!["moodle-99".to_string()],
				failed_files: Vec::new(),
			},
			files_to_index: vec![crate::file_transfer::SavedFileForIndex {
				database_id,
				path: path.clone(),
			}],
		};
		let mut index = TestIndexEngine {
			fail_index: true,
			search_hits: vec![SearchHit {
				file_id: database_id,
				snippet: "古い本文".to_string(),
				page: None,
				score: 1.0,
			}],
			..Default::default()
		};

		let response = index_committed_files(&mut database, &mut index, committed);
		assert_eq!(response.saved_file_ids, vec!["moodle-99"]);
		assert!(path.exists());
		let searched = search(
			&database,
			&index,
			request("search", serde_json::json!({ "query": "古い" })),
		);
		assert!(searched.ok, "{:?}", searched.error);
		assert_eq!(searched.data.unwrap(), serde_json::json!([]));

		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn import_succeeds_and_hides_stale_hits_when_physical_index_clear_fails() {
		let root = unique_temp_dir();
		std::fs::create_dir_all(&root).unwrap();
		let source_path = root.join("source.sqlite3");
		let backup_path = root.join("backup.sqlite3");
		let target_path = root.join("target.sqlite3");

		let source = Database::open(&source_path).unwrap();
		source.apply_development_seed().unwrap();
		source.export_to(&backup_path).unwrap();
		drop(source);

		let mut database = Database::open(&target_path).unwrap();
		let mut index = TestIndexEngine {
			clear_count: 0,
			fail_clear: true,
			fail_index: false,
			indexed_file_ids: Vec::new(),
			indexed_paths: Vec::new(),
			search_hits: vec![SearchHit {
				file_id: 1,
				snippet: "復元前の古い本文".to_string(),
				page: Some(1),
				score: 1.0,
			}],
		};
		let mut transfers = FileTransferManager::default();

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

		let dashboard = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request("getDashboard", serde_json::json!({})),
		);
		assert!(dashboard.ok, "{:?}", dashboard.error);
		assert!(
			dashboard.data.unwrap()["totalFiles"]
				.as_u64()
				.is_some_and(|count| count > 0),
			"復元済みDBのデータが参照できること"
		);

		let searched = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request("search", serde_json::json!({ "query": "復元前" })),
		);
		assert!(searched.ok, "{:?}", searched.error);
		assert_eq!(searched.data.unwrap(), serde_json::json!([]));

		drop(database);
		std::fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn service_dispatcher_preserves_sync_commands_after_merge() {
		let mut database = seeded_database();
		let mut index = TestIndexEngine::default();
		let mut transfers = FileTransferManager::default();

		let synced = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request(
				"syncMoodleAssignments",
				serde_json::json!({
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
						"submitted": false,
						"submissionAvailability": "available",
						"moodleUrl": "https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php?id=701"
					}]
				}),
			),
		);
		assert!(synced.ok, "{:?}", synced.error);
		assert_eq!(synced.data.as_ref().unwrap()["newAssignmentCount"], 1);

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
	fn assignment_change_command_converts_removed_at_to_camel_case() {
		let mut database = Database::open_in_memory().unwrap();
		let course = database
			.resolve_course_context(
				Some("course-1"),
				Some("認知科学概論"),
				Some(2026),
				Some("2026前期"),
			)
			.unwrap();
		let assignment = AssignmentSyncInput {
			id: 1,
			course_id: course.course_id,
			title: "期末レポート".to_string(),
			source: "moodle_dashboard".to_string(),
			due_at: None,
			due_at_status: "normal".to_string(),
			submission_mode: "moodle_auto".to_string(),
			submitted: false,
		};
		database
			.sync_assignments("auto", std::slice::from_ref(&assignment))
			.unwrap();
		let no_assignments: &[AssignmentSyncInput] = &[];
		let removed = database.sync_assignments("auto", no_assignments).unwrap();
		let mut index = TestIndexEngine::default();
		let mut transfers = FileTransferManager::default();

		let response = dispatch_with_services(
			&mut database,
			&mut index,
			&mut transfers,
			request("getAssignmentChanges", serde_json::json!({})),
		);
		assert!(response.ok, "{:?}", response.error);
		let changes = response.data.unwrap();
		assert_eq!(changes[0]["field"], "removedAt");
		assert_eq!(changes[0]["oldValue"], serde_json::Value::Null);
		assert_eq!(changes[0]["newValue"], removed.synced_at);
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
					"protocolVersion": EXTENSION_RUNTIME_PROTOCOL_VERSION
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
					"protocolVersion": EXTENSION_RUNTIME_PROTOCOL_VERSION
				}),
			),
		);
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INVALID_REQUEST");

		let response = dispatch(
			&mut database,
			request(
				"reportExtensionRuntime",
				serde_json::json!({
					"installationId": "550e8400-e29b-41d4-a716-446655440000",
					"extensionVersion": "0.1.0",
					"protocolVersion": EXTENSION_RUNTIME_PROTOCOL_VERSION,
					"unexpected": true
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
