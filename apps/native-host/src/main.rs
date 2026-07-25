#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

//! Fuzzy Native Messagingホストのエントリポイント。
//!
//! 標準入出力のI/Oループだけを担当し、コマンド処理は`commands`へ委譲する。

pub mod api_types;
mod commands;
mod file_transfer;
mod protocol;

use std::io::{stdin, stdout};

use engine_core::index::DefaultIndexEngine;
use engine_core::Database;
use protocol::{Request, Response};

fn main() -> std::io::Result<()> {
	let mut database = Database::open_default().map_err(|error| {
		eprintln!("DB接続に失敗しました: {error}");
		std::io::Error::other(error)
	})?;
	let mut index_engine = DefaultIndexEngine::open_default().map_err(|error| {
		eprintln!("全文索引の初期化に失敗しました: {error}");
		std::io::Error::other(error)
	})?;
	let mut file_transfers = file_transfer::FileTransferManager::default();
	let mut input = stdin().lock();
	let mut output = stdout().lock();

	while let Some(body) = protocol::read_message(&mut input)? {
		let response = match serde_json::from_slice::<Request>(&body) {
			Ok(request) => match protocol::validate_request(request) {
				Ok(request) => commands::dispatch_with_services(
					&mut database,
					&mut index_engine,
					&mut file_transfers,
					request,
				),
				Err(response) => response,
			},
			Err(error) => {
				eprintln!("Native Messagingリクエストの解析に失敗しました: {error}");
				Response::err(None, "INVALID_REQUEST", "リクエストの形式が不正です。")
			}
		};
		protocol::write_message(&mut output, &response)?;
	}
	Ok(())
}
