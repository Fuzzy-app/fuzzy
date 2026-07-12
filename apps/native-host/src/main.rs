//! Fuzzy Native Messagingホストのエントリポイント。
//!
//! 標準入出力で envelope（docs/api/contract.md 1.1節）を読み書きするI/Oループ。
//! Moodleタブが開いている間ブラウザが `connectNative` で本プロセスを起動・維持し、
//! ポートが閉じられる（stdinがEOFになる）と正常終了する（docs/仕様書.md 3.4節）。
//!
//! 起動時に issue #36 でSQLiteへ接続しスキーマを適用する。issue #37 で `ping`
//! を実装し疎通確認できるようにした。他コマンドは順次 `dispatch` に追加していく。

mod db;
mod protocol;

use std::io::{stdin, stdout};

use db::Db;
use protocol::{Request, Response};

fn main() -> std::io::Result<()> {
	// 起動時にSQLiteへ接続する（必要ならスキーマ適用・FK有効化）。
	// 接続できなければホストとして機能しないため、stderrへ記録して異常終了する
	// （拡張機能側は ping タイムアウトでサンプルデータのモック動作へフォールバックする）。
	let database = Db::open_default().map_err(|e| {
		eprintln!("DB接続に失敗しました: {e}");
		std::io::Error::other(e)
	})?;

	let mut input = stdin().lock();
	let mut output = stdout().lock();

	// メッセージ1件ごとに「読む→処理→返す」を繰り返す逐次ループ。
	// EOF（ブラウザ側のポート切断）で正常終了する。
	while let Some(body) = protocol::read_message(&mut input)? {
		let response = match serde_json::from_slice::<Request>(&body) {
			Ok(request) => dispatch(&database, request),
			// envelope自体が壊れておりidも取れないため、id: null で返す。
			Err(e) => Response::err(None, "INTERNAL", format!("リクエストを解釈できません: {e}")),
		};
		protocol::write_message(&mut output, &response)?;
	}
	Ok(())
}

/// コマンド名に応じて処理を振り分ける。
///
/// 実装済みコマンドは issue #37 の `ping` のみ。未実装コマンドは `INTERNAL` を返す。
/// 以降の issue でここに分岐を追加し、`db` を通じてSQLiteへアクセスする。
fn dispatch(_db: &Db, request: Request) -> Response {
	match request.command.as_str() {
		"ping" => ping(request.id),
		_ => Response::err(
			Some(request.id),
			"INTERNAL",
			format!("コマンド '{}' は未実装です", request.command),
		),
	}
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
		let db = Db::open_in_memory().unwrap();
		let request = Request {
			id: "req-1".to_string(),
			command: "unknownCommand".to_string(),
			payload: serde_json::Value::Null,
		};
		let response = dispatch(&db, request);
		assert_eq!(response.id.as_deref(), Some("req-1"));
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INTERNAL");
	}

	/// `ping` は ok レスポンスで version を返すこと。
	#[test]
	fn ping_returns_version() {
		let db = Db::open_in_memory().unwrap();
		let request = Request {
			id: "req-ping".to_string(),
			command: "ping".to_string(),
			payload: serde_json::json!({}),
		};
		let response = dispatch(&db, request);
		assert_eq!(response.id.as_deref(), Some("req-ping"));
		assert!(response.ok);
		let data = response.data.expect("data があること");
		assert_eq!(data["version"], env!("CARGO_PKG_VERSION"));
	}
}
