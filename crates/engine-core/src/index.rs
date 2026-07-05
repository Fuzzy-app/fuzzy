//! IndexEngine — Tantivy を用いた全文索引の構築・検索。
//!
//! 実装は issue #41（Tantivy・pdfium等の依存追加もそのissueで行う）。

use std::path::Path;

use crate::error::EngineResult;
use crate::types::SearchHit;

/// 全文索引の構築・更新・検索を担うトレイト。
pub trait IndexEngine {
	/// 指定ファイルの本文を抽出して索引に追加（既存なら更新）する。
	fn index_file(&mut self, file_id: i64, path: &Path) -> EngineResult<()>;

	/// 指定ファイルを索引から削除する（DB上の登録解除に追従するのみ。実ファイルは触らない）。
	fn remove_file(&mut self, file_id: i64) -> EngineResult<()>;

	/// クエリ文字列で全文検索し、スコア順のヒットを返す。
	fn search(&self, query: &str, limit: usize) -> EngineResult<Vec<SearchHit>>;
}

/// Phase1（issue #41）で実装する既定実装。
#[derive(Debug, Default)]
pub struct DefaultIndexEngine;

impl IndexEngine for DefaultIndexEngine {
	fn index_file(&mut self, _file_id: i64, _path: &Path) -> EngineResult<()> {
		todo!("issue #41: Tantivyによる索引構築を実装する")
	}

	fn remove_file(&mut self, _file_id: i64) -> EngineResult<()> {
		todo!("issue #41: 索引からの削除を実装する")
	}

	fn search(&self, _query: &str, _limit: usize) -> EngineResult<Vec<SearchHit>> {
		todo!("issue #41: 全文検索を実装する")
	}
}
