//! Fuzzy Native Messagingホストのエントリポイント。
//!
//! 標準入出力で envelope（docs/api/contract.md 1.1節）を読み書きするI/Oループ。
//! Moodleタブが開いている間ブラウザが `connectNative` で本プロセスを起動・維持し、
//! ポートが閉じられる（stdinがEOFになる）と正常終了する（docs/仕様書.md 3.4節）。
//!
//! Phase0（issue #33）ではコマンドの中身は実装せず、全コマンドに `INTERNAL` エラーを
//! 返す。個別コマンドは issue #37（ping）以降で `dispatch` に追加していく。

mod protocol;

use std::io::{stdin, stdout};

use protocol::{Request, Response};

fn main() -> std::io::Result<()> {
	let mut input = stdin().lock();
	let mut output = stdout().lock();

	// メッセージ1件ごとに「読む→処理→返す」を繰り返す逐次ループ。
	// EOF（ブラウザ側のポート切断）で正常終了する。
	while let Some(body) = protocol::read_message(&mut input)? {
		let response = match serde_json::from_slice::<Request>(&body) {
			Ok(request) => dispatch(request),
			// envelope自体が壊れておりidも取れないため、id: null で返す。
			Err(e) => Response::err(None, "INTERNAL", format!("リクエストを解釈できません: {e}")),
		};
		protocol::write_message(&mut output, &response)?;
	}
	Ok(())
}

/// コマンド名に応じて処理を振り分ける。
///
/// Phase0では全コマンド未実装のため、常に `INTERNAL` エラーを返す。
/// issue #37 以降でここに `match request.command.as_str()` の分岐を追加する。
fn dispatch(request: Request) -> Response {
	Response::err(
		Some(request.id),
		"INTERNAL",
		format!("コマンド '{}' は未実装です", request.command),
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	/// 未知コマンドには `INTERNAL` エラーを返すこと。
	#[test]
	fn unknown_cmd_internal_err() {
		let request = Request {
			id: "req-1".to_string(),
			command: "unknownCommand".to_string(),
			payload: serde_json::Value::Null,
		};
		let response = dispatch(request);
		assert_eq!(response.id.as_deref(), Some("req-1"));
		assert!(!response.ok);
		assert_eq!(response.error.unwrap().code, "INTERNAL");
	}
}
