//! ScanEngine — フォルダの再帰走査・既存の保存パターン推定。
//!
//! 実装は issue #38。

use std::path::Path;

use crate::error::EngineResult;
use crate::types::{FileEntry, SavePatternGuess};

/// フォルダの再帰走査と保存パターン推定を担うトレイト。
///
/// 初期セットアップ（Tauri）では既存構成のスキャンとパターン推定に、
/// 常駐エンジン（native-host）では整合性チェック用の再走査に使う。
/// 読み取り専用であり、ファイルの移動・削除は一切行わない。
pub trait ScanEngine {
	/// `root` 以下を再帰走査し、発見したファイルのメタ情報を返す。
	fn scan(&self, root: &Path) -> EngineResult<Vec<FileEntry>>;

	/// 走査結果から既存の保存パターンを推定し、確からしさ順に返す。
	fn estimate_patterns(&self, entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>>;
}

/// Phase1（issue #38）で実装する既定実装。
#[derive(Debug, Default)]
pub struct DefaultScanEngine;

impl ScanEngine for DefaultScanEngine {
	fn scan(&self, _root: &Path) -> EngineResult<Vec<FileEntry>> {
		todo!("issue #38: 再帰走査を実装する")
	}

	fn estimate_patterns(&self, _entries: &[FileEntry]) -> EngineResult<Vec<SavePatternGuess>> {
		todo!("issue #38: 保存パターン推定を実装する")
	}
}
