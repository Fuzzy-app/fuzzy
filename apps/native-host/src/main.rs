//! Fuzzy Native Messagingホストのエントリポイント。
//!
//! 標準入出力で envelope（docs/api/contract.md 1.1節）を読み書きするI/Oループ。
//! Moodleタブが開いている間ブラウザが `connectNative` で本プロセスを起動・維持し、
//! ポートが閉じられる（stdinがEOFになる）と正常終了する（docs/仕様書.md 3.4節）。
//!
//! 起動時に issue #36 でSQLiteへ接続しスキーマを適用する。issue #37 で `ping`
//! を実装し疎通確認できるようにした。他コマンドは順次 `dispatch` に追加していく。

mod protocol;

use std::io::{stdin, stdout};
use std::path::{Path, PathBuf};

use engine_core::index::{DefaultIndexEngine, IndexEngine};
use engine_core::{Database, EngineError, ExtensionRuntimeReport};
use native_host::api_types::{
	CourseFolderNameResolution, ExportDataRequest, ExportDataResult, ImportDataRequest,
	ImportDataResult, SearchRequest, SearchResult, UpdateCourseFolderNameRequest,
	UpdateCourseFolderNameResult,
};
use protocol::{Request, Response};

const DEFAULT_SEARCH_LIMIT: usize = 50;

fn main() -> std::io::Result<()> {
	// 起動時にSQLiteへ接続する（必要ならスキーマ適用・FK有効化）。
	// 接続できなければホストとして機能しないため、stderrへ記録して異常終了する
	// （拡張機能側は ping タイムアウトでサンプルデータのモック動作へフォールバックする）。
	let mut database = Database::open_default().map_err(|e| {
		eprintln!("DB接続に失敗しました: {e}");
		std::io::Error::other(e)
	})?;
	let mut index_engine = DefaultIndexEngine::open_default().map_err(|e| {
		eprintln!("全文索引の初期化に失敗しました: {e}");
		std::io::Error::other(e)
	})?;

	let mut input = stdin().lock();
	let mut output = stdout().lock();

	// メッセージ1件ごとに「読む→処理→返す」を繰り返す逐次ループ。
	// EOF（ブラウザ側のポート切断）で正常終了する。
	while let Some(body) = protocol::read_message(&mut input)? {
		let response = match serde_json::from_slice::<Request>(&body) {
			Ok(request) => dispatch(&mut database, &mut index_engine, request),
			// envelope自体が壊れておりidも取れないため、id: null で返す。
			Err(e) => Response::err(None, "INTERNAL", format!("リクエストを解釈できません: {e}")),
		};
		protocol::write_message(&mut output, &response)?;
	}
	Ok(())
}

/// コマンド名に応じて処理を振り分ける。
///
/// 実装済みコマンド以外は `INTERNAL` を返す。
/// 以降の issue でここに分岐を追加し、`db` を通じてSQLiteへアクセスする。
fn dispatch(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	request: Request,
) -> Response {
	match request.command.as_str() {
		"ping" => ping(request.id),
		"reportExtensionRuntime" => report_extension_runtime(database, request),
		"updateCourseFolderName" => update_course_folder_name(database, request),
		"search" => search(database, index_engine, request),
		"exportData" => export_data(database, request),
		"importData" => import_data(database, index_engine, request),
		_ => Response::err(
			Some(request.id),
			"INTERNAL",
			format!("コマンド '{}' は未実装です", request.command),
		),
	}
}

/// 全文索引を検索し、表示用メタデータをSQLiteの正本から付与する。
fn search(database: &Database, index_engine: &dyn IndexEngine, request: Request) -> Response {
	let search = match serde_json::from_value::<SearchRequest>(request.payload) {
		Ok(search) => search,
		Err(_) => {
			return Response::err(
				Some(request.id),
				"INVALID_REQUEST",
				"検索語を解釈できません",
			);
		}
	};
	let hits = match index_engine.search(&search.query, DEFAULT_SEARCH_LIMIT) {
		Ok(hits) => hits,
		Err(error) => return engine_error_response(request.id, error),
	};
	let mut results = Vec::with_capacity(hits.len());
	for hit in hits {
		let metadata = match database.search_document_metadata(hit.file_id) {
			Ok(Some(metadata)) => metadata,
			// DBに存在しない索引エントリは正本に従って公開しない。
			Ok(None) => continue,
			Err(error) => return engine_error_response(request.id, error),
		};
		results.push(SearchResult {
			file_id: metadata.file_id,
			file_name: metadata.file_name,
			course_name: metadata.course_name,
			snippet: hit.snippet,
			page: hit.page,
			score: hit.score,
		});
	}
	serialize_response(request.id, results)
}

/// SQLite正本だけを生SQLiteファイルとして書き出す。Tantivy索引は含めない。
fn export_data(database: &Database, request: Request) -> Response {
	let export = match serde_json::from_value::<ExportDataRequest>(request.payload) {
		Ok(export) => export,
		Err(_) => {
			return Response::err(
				Some(request.id),
				"INVALID_REQUEST",
				"エクスポート先を解釈できません",
			);
		}
	};
	if export.file_path.trim().is_empty() {
		return Response::err(
			Some(request.id),
			"INVALID_REQUEST",
			"エクスポート先を指定してください",
		);
	}
	let destination = PathBuf::from(&export.file_path);
	match database.export_to(&destination) {
		Ok(()) => serialize_response(
			request.id,
			ExportDataResult {
				file_path: export.file_path,
			},
		),
		Err(error) => engine_error_response(request.id, error),
	}
}

/// SQLiteバックアップを読み込み、同梱されないTantivy索引を破棄する。
fn import_data(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	request: Request,
) -> Response {
	let import = match serde_json::from_value::<ImportDataRequest>(request.payload) {
		Ok(import) => import,
		Err(_) => {
			return Response::err(
				Some(request.id),
				"INVALID_REQUEST",
				"インポート元を解釈できません",
			);
		}
	};
	if import.file_path.trim().is_empty() {
		return Response::err(
			Some(request.id),
			"INVALID_REQUEST",
			"インポート元を指定してください",
		);
	}

	match database.import_from(Path::new(&import.file_path)) {
		Ok(()) => {
			if let Err(error) = index_engine.clear() {
				return engine_error_response(request.id, error);
			}
			serialize_response(
				request.id,
				ImportDataResult {
					ok: true,
					reindex_required: true,
				},
			)
		}
		Err(error) => engine_error_response(request.id, error),
	}
}

fn serialize_response(id: String, value: impl serde::Serialize) -> Response {
	match serde_json::to_value(value) {
		Ok(data) => Response::ok(id, data),
		Err(_) => Response::err(Some(id), "INTERNAL", "応答を生成できません"),
	}
}

/// 利用者が編集した保存用コースフォルダ名をSQLiteへ保存する。
fn update_course_folder_name(database: &mut Database, request: Request) -> Response {
	let update = match serde_json::from_value::<UpdateCourseFolderNameRequest>(request.payload) {
		Ok(update) => update,
		Err(error) => {
			return Response::err(
				Some(request.id),
				"INVALID_REQUEST",
				format!("コースフォルダ名の更新内容を解釈できません: {error}"),
			);
		}
	};

	match database.update_course_folder_name(update.course_id, update.folder_name.as_deref()) {
		Ok(course_folder) => {
			let result = UpdateCourseFolderNameResult {
				ok: true,
				course_folder: CourseFolderNameResolution::from(course_folder),
			};
			match serde_json::to_value(result) {
				Ok(data) => Response::ok(request.id, data),
				Err(error) => Response::err(
					Some(request.id),
					"INTERNAL",
					format!("応答を生成できません: {error}"),
				),
			}
		}
		Err(error) => engine_error_response(request.id, error),
	}
}

/// 拡張機能の実応答を、native-hostの受信時刻・バージョン付きでSQLiteへ保存する。
fn report_extension_runtime(database: &Database, request: Request) -> Response {
	let report = match serde_json::from_value::<ExtensionRuntimeReport>(request.payload) {
		Ok(report) => report,
		Err(error) => {
			return Response::err(
				Some(request.id),
				"INVALID_REQUEST",
				format!("拡張機能の実行情報を解釈できません: {error}"),
			);
		}
	};

	match database.record_extension_runtime(&report) {
		Ok(observation) => match serde_json::to_value(observation) {
			Ok(data) => Response::ok(request.id, data),
			Err(error) => Response::err(
				Some(request.id),
				"INTERNAL",
				format!("応答を生成できません: {error}"),
			),
		},
		Err(error) => engine_error_response(request.id, error),
	}
}

fn engine_error_response(id: String, error: EngineError) -> Response {
	let (code, message) = match error {
		EngineError::InvalidInput { reason, .. } => ("INVALID_REQUEST", reason),
		EngineError::NotFound { entity, .. } => ("NOT_FOUND", format!("{entity}が見つかりません")),
		EngineError::InvalidPath { .. } | EngineError::Io(_) | EngineError::PathIo { .. } => {
			("IO_ERROR", "ファイル操作に失敗しました".to_string())
		}
		EngineError::Database { .. } => ("DB_ERROR", "データベース操作に失敗しました".to_string()),
		EngineError::RuleConflict { reason } => ("RULE_CONFLICT", reason),
		EngineError::Index { .. } => ("INTERNAL", "全文索引の処理に失敗しました".to_string()),
		EngineError::Internal { .. } => ("INTERNAL", "内部処理に失敗しました".to_string()),
	};
	Response::err(Some(id), code, message)
}

/// `ping`：疎通確認（docs/api/contract.md 1.2節）。`{}` → `{ version }`。
/// 拡張機能はこの応答（タイムアウト目安800ms）でホスト常駐を判定し、応答が無ければ
/// サンプルデータのモック動作へフォールバックする（同 1.3節）。
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
		hits: Vec<SearchHit>,
		cleared: bool,
	}

	impl IndexEngine for TestIndexEngine {
		fn index_file(
			&mut self,
			_database: &Database,
			_file_id: i64,
			_path: &Path,
		) -> engine_core::EngineResult<()> {
			Ok(())
		}

		fn remove_file(
			&mut self,
			_database: &Database,
			_file_id: i64,
		) -> engine_core::EngineResult<()> {
			Ok(())
		}

		fn clear(&mut self) -> engine_core::EngineResult<()> {
			self.cleared = true;
			Ok(())
		}

		fn search(&self, _query: &str, _limit: usize) -> engine_core::EngineResult<Vec<SearchHit>> {
			Ok(self.hits.clone())
		}
	}

	/// 未知コマンドには `INTERNAL` エラーを返すこと。
	#[test]
	fn unknown_cmd_internal_err() {
		let mut db = Database::open_in_memory().unwrap();
		let request = Request {
			id: "req-1".to_string(),
			command: "unknownCommand".to_string(),
			payload: serde_json::Value::Null,
		};
		let response = dispatch(&mut db, &mut TestIndexEngine::default(), request);
		assert_eq!(response.id.as_deref(), Some("req-1"));
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INTERNAL");
	}

	/// `ping` は ok レスポンスで version を返すこと。
	#[test]
	fn ping_returns_version() {
		let mut db = Database::open_in_memory().unwrap();
		let request = Request {
			id: "req-ping".to_string(),
			command: "ping".to_string(),
			payload: serde_json::json!({}),
		};
		let response = dispatch(&mut db, &mut TestIndexEngine::default(), request);
		assert_eq!(response.id.as_deref(), Some("req-ping"));
		assert!(response.ok);
		let data = response.data.expect("data があること");
		assert_eq!(data["version"], env!("CARGO_PKG_VERSION"));
	}

	#[test]
	fn report_extension_runtime_persists_observation() {
		let mut database = Database::open_in_memory().unwrap();
		let request = Request {
			id: "req-runtime".to_string(),
			command: "reportExtensionRuntime".to_string(),
			payload: serde_json::json!({
				"installationId": "550e8400-e29b-41d4-a716-446655440000",
				"extensionVersion": "0.1.0",
				"protocolVersion": 1
			}),
		};

		let response = dispatch(&mut database, &mut TestIndexEngine::default(), request);
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
		let request = Request {
			id: "req-invalid-runtime".to_string(),
			command: "reportExtensionRuntime".to_string(),
			payload: serde_json::json!({
				"installationId": "../invalid",
				"extensionVersion": "0.1.0",
				"protocolVersion": 1
			}),
		};

		let response = dispatch(&mut database, &mut TestIndexEngine::default(), request);
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INVALID_REQUEST");
	}

	#[test]
	fn update_course_folder_name_rejects_unknown_course() {
		let mut database = Database::open_in_memory().unwrap();
		let request = Request {
			id: "req-course-folder".to_string(),
			command: "updateCourseFolderName".to_string(),
			payload: serde_json::json!({
				"courseId": 999,
				"folderName": "別名"
			}),
		};

		let response = dispatch(&mut database, &mut TestIndexEngine::default(), request);
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "NOT_FOUND");
	}

	#[test]
	fn export_and_import_commands_return_contract_shape_and_clear_index() {
		let directory = std::env::temp_dir().join(format!(
			"fuzzy-native-backup-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		let database_path = directory.join("fuzzy.db");
		let backup_path = directory.join("backup.db");
		let mut database = Database::open(&database_path).unwrap();
		let mut index = TestIndexEngine::default();

		let export_response = dispatch(
			&mut database,
			&mut index,
			Request {
				id: "req-export".to_string(),
				command: "exportData".to_string(),
				payload: serde_json::json!({
					"filePath": backup_path.to_string_lossy()
				}),
			},
		);
		assert!(export_response.ok);
		assert_eq!(
			export_response.data.unwrap()["filePath"],
			backup_path.to_string_lossy().as_ref()
		);
		assert!(backup_path.is_file());

		let import_response = dispatch(
			&mut database,
			&mut index,
			Request {
				id: "req-import".to_string(),
				command: "importData".to_string(),
				payload: serde_json::json!({
					"filePath": backup_path.to_string_lossy()
				}),
			},
		);
		assert!(import_response.ok);
		assert_eq!(
			import_response.data.unwrap()["reindexRequired"],
			serde_json::json!(true)
		);
		assert!(index.cleared);

		drop(database);
		let _ = std::fs::remove_dir_all(directory);
	}

	#[test]
	fn file_errors_do_not_expose_absolute_paths() {
		let response = engine_error_response(
			"req-io".to_string(),
			EngineError::PathIo {
				path: "C:\\Users\\secret\\fuzzy.db".to_string(),
				source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "secret"),
			},
		);
		let error = response.error.unwrap();
		assert_eq!(error.code, "IO_ERROR");
		assert_eq!(error.message, "ファイル操作に失敗しました");
		assert!(!error.message.contains("secret"));
	}
}
