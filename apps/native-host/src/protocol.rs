//! Native Messaging のワイヤプロトコル層。
//!
//! Chrome系ブラウザのNative Messagingは「4byteリトルエンディアンのメッセージ長
//! プレフィックス＋UTF-8のJSON本文」を標準入出力でやり取りする。
//! envelope形式は docs/api/contract.md 1.1節を正とする。

use std::io::{Read, Write};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// ブラウザ→ホスト方向のメッセージ長上限（Chromeの仕様上64MB）。
/// 異常な長さを受け取った際に巨大アロケーションで落ちないための防御。
const MAX_INCOMING_LEN: u32 = 64 * 1024 * 1024;
/// Chromeのホスト→拡張機能上限（1MiB）に余裕を持たせた1フレーム上限。
const MAX_OUTGOING_FRAME_LEN: usize = 900 * 1024;
/// base64化後もフレーム上限内に収まる生JSONチャンク長。
const OUTGOING_CHUNK_LEN: usize = 512 * 1024;
/// ブラウザ側で再構築するレスポンス全体の防御上限。
const MAX_OUTGOING_RESPONSE_LEN: usize = 64 * 1024 * 1024;
const MAX_REQUEST_ID_LEN: usize = 128;
const MAX_COMMAND_LEN: usize = 64;

/// リクエストenvelope: `{ "id": "uuid", "command": "search", "payload": { ... } }`
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Request {
	pub id: String,
	pub command: String,
	/// コマンドごとの引数。省略時は `null` として扱う。
	#[serde(default)]
	pub payload: Value,
}

/// envelopeの識別子を検証し、不正なIDはレスポンスへ反射しない。
pub fn validate_request(request: Request) -> Result<Request, Response> {
	if request.id.is_empty()
		|| request.id.len() > MAX_REQUEST_ID_LEN
		|| !request
			.id
			.chars()
			.all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
	{
		return Err(Response::err(
			None,
			"INVALID_REQUEST",
			"リクエストIDが不正です。",
		));
	}
	if request.command.is_empty()
		|| request.command.len() > MAX_COMMAND_LEN
		|| !request
			.command
			.chars()
			.all(|character| character.is_ascii_alphanumeric())
	{
		return Err(Response::err(
			Some(request.id),
			"INVALID_REQUEST",
			"コマンド名が不正です。",
		));
	}
	Ok(request)
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
	/// 大きなレスポンスを複数のNative Messagingフレームへ分割した転送情報。
	#[serde(skip_serializing_if = "Option::is_none")]
	pub chunk: Option<Box<ResponseChunk>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseChunk {
	pub index: usize,
	pub total: usize,
	pub encoding: &'static str,
	pub data: String,
}

/// エラー本体（コードは docs/api/contract.md 3章の暫定一覧に従う）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ErrorBody {
	pub code: String,
	pub message: String,
}

impl Response {
	/// 成功レスポンスを作る。
	pub fn ok(id: String, data: Value) -> Self {
		Self {
			id: Some(id),
			ok: true,
			data: Some(data),
			error: None,
			chunk: None,
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
			chunk: None,
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

/// レスポンスを「4byte LE長＋JSON本文」で出力する。
///
/// ホスト→ブラウザの1MiB上限へ達する場合は、元envelopeのUTF-8 JSONをbase64チャンクへ
/// 分割する。各チャンクも同じリクエストIDを持ち、クライアント側で元envelopeへ戻す。
pub fn write_message(output: &mut impl Write, response: &Response) -> std::io::Result<()> {
	let mut body = serde_json::to_vec(response)
		.map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
	if body.len() > MAX_OUTGOING_RESPONSE_LEN {
		body = serde_json::to_vec(&Response::err(
			response.id.clone(),
			"RESULT_TOO_LARGE",
			"結果が大きすぎます。条件を絞って再試行してください。",
		))
		.map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
	}
	if body.len() <= MAX_OUTGOING_FRAME_LEN {
		write_frame(output, &body)?;
		output.flush()?;
		return Ok(());
	}

	let total = body.len().div_ceil(OUTGOING_CHUNK_LEN);
	for (index, bytes) in body.chunks(OUTGOING_CHUNK_LEN).enumerate() {
		let chunk = Response {
			id: response.id.clone(),
			ok: true,
			data: None,
			error: None,
			chunk: Some(Box::new(ResponseChunk {
				index,
				total,
				encoding: "base64",
				data: BASE64_STANDARD.encode(bytes),
			})),
		};
		let chunk_body = serde_json::to_vec(&chunk)
			.map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
		if chunk_body.len() > MAX_OUTGOING_FRAME_LEN {
			return Err(std::io::Error::new(
				std::io::ErrorKind::InvalidData,
				"分割レスポンスがNative Messagingの送信上限を超えました",
			));
		}
		write_frame(output, &chunk_body)?;
	}
	output.flush()
}

fn write_frame(output: &mut impl Write, body: &[u8]) -> std::io::Result<()> {
	let len = u32::try_from(body.len())
		.map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "本文が4GBを超過"))?;
	output.write_all(&len.to_le_bytes())?;
	output.write_all(body)?;
	Ok(())
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

	#[test]
	fn request_rejects_unknown_envelope_fields() {
		let parsed = serde_json::from_value::<Request>(json!({
			"id": "request-1",
			"command": "ping",
			"payload": {},
			"unexpected": true
		}));
		assert!(parsed.is_err());
	}

	#[test]
	fn validation_does_not_reflect_invalid_request_ids() {
		for id in [
			String::new(),
			"../request".to_string(),
			"a".repeat(MAX_REQUEST_ID_LEN + 1),
		] {
			let response = validate_request(Request {
				id,
				command: "ping".to_string(),
				payload: json!({}),
			})
			.unwrap_err();
			assert_eq!(response.id, None);
			assert_eq!(response.error.unwrap().code, "INVALID_REQUEST");
		}
	}

	#[test]
	fn validation_rejects_invalid_commands_after_accepting_the_id() {
		for command in [
			String::new(),
			"ping!".to_string(),
			"a".repeat(MAX_COMMAND_LEN + 1),
		] {
			let response = validate_request(Request {
				id: "request-1".to_string(),
				command,
				payload: json!({}),
			})
			.unwrap_err();
			assert_eq!(response.id.as_deref(), Some("request-1"));
			assert_eq!(response.error.unwrap().code, "INVALID_REQUEST");
		}
	}

	#[test]
	fn validation_accepts_contract_identifiers() {
		let request = validate_request(Request {
			id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
			command: "appendCheckSimilarFileChunk".to_string(),
			payload: json!({}),
		})
		.unwrap();
		assert_eq!(request.command, "appendCheckSimilarFileChunk");
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

	#[test]
	fn large_responses_are_split_below_the_browser_frame_limit_and_roundtrip() {
		let response = Response::ok(
			"large".to_string(),
			json!({"items": ["あ".repeat(MAX_OUTGOING_FRAME_LEN)]}),
		);
		let expected = serde_json::to_vec(&response).unwrap();
		let mut out = Vec::new();
		write_message(&mut out, &response).unwrap();

		let mut cursor = std::io::Cursor::new(out);
		let mut rebuilt = Vec::new();
		let mut expected_index = 0;
		while let Some(body) = read_message(&mut cursor).unwrap() {
			assert!(body.len() <= MAX_OUTGOING_FRAME_LEN);
			let chunk_response: Value = serde_json::from_slice(&body).unwrap();
			let chunk = &chunk_response["chunk"];
			assert_eq!(chunk["index"], expected_index);
			assert_eq!(chunk["encoding"], "base64");
			rebuilt.extend(
				BASE64_STANDARD
					.decode(chunk["data"].as_str().unwrap())
					.unwrap(),
			);
			expected_index += 1;
			assert!(expected_index <= chunk["total"].as_u64().unwrap() as usize);
		}
		assert!(expected_index > 1);
		assert_eq!(rebuilt, expected);
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
