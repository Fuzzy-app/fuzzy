//! Native Messaging のワイヤプロトコル層。
//!
//! Chrome系ブラウザのNative Messagingは「4byteリトルエンディアンのメッセージ長
//! プレフィックス＋UTF-8のJSON本文」を標準入出力でやり取りする。
//! envelope形式は docs/api/contract.md 1.1節を正とする。

use std::io::{Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// ブラウザ→ホスト方向のメッセージ長上限（Chromeの仕様上64MB）。
/// 異常な長さを受け取った際に巨大アロケーションで落ちないための防御。
const MAX_INCOMING_LEN: u32 = 64 * 1024 * 1024;

/// リクエストenvelope: `{ "id": "uuid", "command": "search", "payload": { ... } }`
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Request {
	pub id: String,
	pub command: String,
	/// コマンドごとの引数。省略時は `null` として扱う。
	#[serde(default)]
	pub payload: Value,
}

/// レスポンスenvelope（成功: `{id, ok:true, data}` ／ 失敗: `{id, ok:false, error}`）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Response {
	/// 対応するリクエストのid。リクエストのJSON自体が壊れていて
	/// idを取れなかった場合は `null` を返す。
	pub id: Option<String>,
	pub ok: bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub data: Option<Value>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub error: Option<ErrorBody>,
}

/// エラー本体（コードは docs/api/contract.md 3章の暫定一覧に従う）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ErrorBody {
	pub code: String,
	pub message: String,
}

impl Response {
	/// 成功レスポンスを作る。
	// Phase0では全コマンド未実装のため本体側からは未使用（issue #37 のpingで使用予定）。
	#[allow(dead_code)]
	pub fn ok(id: String, data: Value) -> Self {
		Self {
			id: Some(id),
			ok: true,
			data: Some(data),
			error: None,
		}
	}

	/// 失敗レスポンスを作る。
	pub fn err(id: Option<String>, code: &str, message: impl Into<String>) -> Self {
		Self {
			id,
			ok: false,
			data: None,
			error: Some(ErrorBody {
				code: code.to_string(),
				message: message.into(),
			}),
		}
	}
}

/// 入力ストリームからメッセージを1件読み取る。
///
/// - `Ok(Some(bytes))` — 本文のバイト列（JSONのパースは呼び出し側で行う）
/// - `Ok(None)` — クリーンなEOF（ブラウザがポートを閉じた＝正常終了の合図）
/// - `Err(_)` — 長さプレフィックスの途中終端や上限超過などのI/O異常
pub fn read_message(input: &mut impl Read) -> std::io::Result<Option<Vec<u8>>> {
	let mut len_buf = [0u8; 4];
	// 最初の1byteが読めるかでEOF判定する（0byteで切れているのは正常な切断）。
	match input.read(&mut len_buf[..1])? {
		0 => return Ok(None),
		_ => input.read_exact(&mut len_buf[1..])?,
	}
	let len = u32::from_le_bytes(len_buf);
	if len > MAX_INCOMING_LEN {
		return Err(std::io::Error::new(
			std::io::ErrorKind::InvalidData,
			format!("メッセージ長 {len} が上限 {MAX_INCOMING_LEN} を超えています"),
		));
	}
	let mut body = vec![0u8; len as usize];
	input.read_exact(&mut body)?;
	Ok(Some(body))
}

/// レスポンスを「4byte LE長＋JSON本文」で出力ストリームに書き込み、flushする。
pub fn write_message(output: &mut impl Write, response: &Response) -> std::io::Result<()> {
	let body = serde_json::to_vec(response)
		.map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
	let len = u32::try_from(body.len())
		.map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "本文が4GBを超過"))?;
	output.write_all(&len.to_le_bytes())?;
	output.write_all(&body)?;
	output.flush()
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	/// 長さプレフィックス付きメッセージ1件をエンコードするテスト用ヘルパ。
	fn frame(json: &str) -> Vec<u8> {
		let mut buf = (json.len() as u32).to_le_bytes().to_vec();
		buf.extend_from_slice(json.as_bytes());
		buf
	}

	/// 長さプレフィックス付き本文を読めること。
	#[test]
	fn read_framed_body() {
		let raw = frame(r#"{"id":"a","command":"ping","payload":{}}"#);
		let mut cursor = std::io::Cursor::new(raw);
		let body = read_message(&mut cursor).unwrap().unwrap();
		let req: Request = serde_json::from_slice(&body).unwrap();
		assert_eq!(req.id, "a");
		assert_eq!(req.command, "ping");
		assert_eq!(req.payload, json!({}));
	}

	/// クリーンなEOF（ポート切断）で `None` を返すこと。
	#[test]
	fn read_eof_as_none() {
		let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
		assert!(read_message(&mut cursor).unwrap().is_none());
	}

	/// メッセージ長の上限（64MB）超過をエラーにすること。
	#[test]
	fn read_rejects_oversize() {
		let mut raw = (u32::MAX).to_le_bytes().to_vec();
		raw.extend_from_slice(b"x");
		let mut cursor = std::io::Cursor::new(raw);
		assert!(read_message(&mut cursor).is_err());
	}

	/// 書き込んだenvelopeを読み戻して往復できること。
	#[test]
	fn write_read_roundtrip() {
		let res = Response::ok("a".to_string(), json!({"version": "0.1.0"}));
		let mut out = Vec::new();
		write_message(&mut out, &res).unwrap();
		// 書いたものを読み戻して検証する。
		let mut cursor = std::io::Cursor::new(out);
		let body = read_message(&mut cursor).unwrap().unwrap();
		let value: Value = serde_json::from_slice(&body).unwrap();
		assert_eq!(
			value,
			json!({"id": "a", "ok": true, "data": {"version": "0.1.0"}})
		);
	}

	/// 失敗レスポンスは `data` を含まず `error` を含むこと。
	#[test]
	fn err_res_shape() {
		let res = Response::err(Some("a".to_string()), "INTERNAL", "未対応");
		let value = serde_json::to_value(&res).unwrap();
		assert_eq!(
			value,
			json!({"id": "a", "ok": false, "error": {"code": "INTERNAL", "message": "未対応"}})
		);
	}
}
