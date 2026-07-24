//! Fuzzy Native Messagingホストのエントリポイント。
//!
//! 標準入出力でenvelope（docs/api/contract.md 1.1節）を読み書きし、
//! コマンド処理は`commands`、メッセージ形式は`protocol`へ分離する。

pub mod api_types;
mod commands;
mod protocol;

use std::io::{stdin, stdout};

use engine_core::Database;
use protocol::{Request, Response};

fn main() -> std::io::Result<()> {
	let mut database = Database::open_default().map_err(|error| {
		eprintln!("DB接続に失敗しました: {error}");
		std::io::Error::other(error)
	})?;
	let mut input = stdin().lock();
	let mut output = stdout().lock();

	while let Some(body) = protocol::read_message(&mut input)? {
		let response = match serde_json::from_slice::<Request>(&body) {
			Ok(request) => commands::dispatch(&mut database, request),
			Err(error) => Response::err(
				None,
				"INTERNAL",
				format!("リクエストを解釈できません: {error}"),
			),
		};
		protocol::write_message(&mut output, &response)?;
	}
	Ok(())
}
