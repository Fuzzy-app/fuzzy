//! DuplicateDetector — blake3 / simhash による重複・類似ファイル検出。
//!
//! 実装は issue #40（blake3・simhash等の依存追加もそのissueで行う）。

use std::path::Path;

use crate::error::EngineResult;
use crate::types::DuplicateMatch;

/// 重複・類似ファイル検出を担うトレイト。
///
/// 検出結果は保存前の重複通知・類似ファイル提示に使う。削除・統合は行わない。
pub trait DuplicateDetector {
	/// 指定ファイルのblake3ハッシュを計算し、登録済みファイルとの完全一致を返す。
	fn find_exact(&self, path: &Path) -> EngineResult<Vec<DuplicateMatch>>;

	/// simhash等により、登録済みファイルとの類似候補を類似度の降順で返す。
	///
	/// `threshold` は 0.0〜1.0 の類似度下限。
	fn find_similar(&self, path: &Path, threshold: f64) -> EngineResult<Vec<DuplicateMatch>>;
}

/// Phase1（issue #40）で実装する既定実装。
#[derive(Debug, Default)]
pub struct DefaultDuplicateDetector;

impl DuplicateDetector for DefaultDuplicateDetector {
	fn find_exact(&self, _path: &Path) -> EngineResult<Vec<DuplicateMatch>> {
		todo!("issue #40: blake3完全一致検出を実装する")
	}

	fn find_similar(&self, _path: &Path, _threshold: f64) -> EngineResult<Vec<DuplicateMatch>> {
		todo!("issue #40: simhash類似検出を実装する")
	}
}
