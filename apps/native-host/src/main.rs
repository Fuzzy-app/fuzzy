//! Fuzzy Native Messagingホストのエントリポイント。
//!
//! 標準入出力で envelope（docs/api/contract.md 1.1節）を読み書きするI/Oループ。
//! Moodleタブが開いている間ブラウザが `connectNative` で本プロセスを起動・維持し、
//! ポートが閉じられる（stdinがEOFになる）と正常終了する（docs/仕様書.md 3.4節）。
//!
//! 起動時に issue #36 でSQLiteへ接続しスキーマを適用する。issue #37 で `ping`
//! を実装し疎通確認できるようにした。他コマンドは順次 `dispatch` に追加していく。

pub mod api_types;
mod protocol;

use std::io::{stdin, stdout};

use api_types::{
	CourseFolderNameResolution, UpdateCourseFolderNameRequest, UpdateCourseFolderNameResult,
};
use engine_core::{Database, EngineError, ExtensionRuntimeReport};
use protocol::{Request, Response};

fn main() -> std::io::Result<()> {
	// 起動時にSQLiteへ接続する（必要ならスキーマ適用・FK有効化）。
	// 接続できなければホストとして機能しないため、stderrへ記録して異常終了する
	// （拡張機能側は ping タイムアウトでサンプルデータのモック動作へフォールバックする）。
	let mut database = Database::open_default().map_err(|e| {
		eprintln!("DB接続に失敗しました: {e}");
		std::io::Error::other(e)
	})?;

	let mut input = stdin().lock();
	let mut output = stdout().lock();

	// メッセージ1件ごとに「読む→処理→返す」を繰り返す逐次ループ。
	// EOF（ブラウザ側のポート切断）で正常終了する。
	while let Some(body) = protocol::read_message(&mut input)? {
		let response = match serde_json::from_slice::<Request>(&body) {
			Ok(request) => dispatch(&mut database, request),
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
fn dispatch(database: &mut Database, request: Request) -> Response {
	match request.command.as_str() {
		"ping" => ping(request.id),
		"reportExtensionRuntime" => report_extension_runtime(database, request),
		"updateCourseFolderName" => update_course_folder_name(database, request),
		_ => Response::err(
			Some(request.id),
			"INTERNAL",
			format!("コマンド '{}' は未実装です", request.command),
		),
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

	/// 未知コマンドには `INTERNAL` エラーを返すこと。
	#[test]
	fn unknown_cmd_internal_err() {
		let mut db = Database::open_in_memory().unwrap();
		let request = Request {
			id: "req-1".to_string(),
			command: "unknownCommand".to_string(),
			payload: serde_json::Value::Null,
		};
		let response = dispatch(&mut db, request);
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
		let response = dispatch(&mut db, request);
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

		let response = dispatch(&mut database, request);
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

		let response = dispatch(&mut database, request);
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

		let response = dispatch(&mut database, request);
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "NOT_FOUND");
	}
}
