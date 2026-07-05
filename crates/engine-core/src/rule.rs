//! RuleEngine — グローバル／コース別ルールの照合・違反検出。
//!
//! 実装は issue #39。

use crate::error::EngineResult;
use crate::types::{FileEntry, RuleSet, RuleViolation};

/// 保存ルールの照合・違反検出を担うトレイト。
///
/// 違反は警告表示用のデータとして返すのみで、ファイルの自動移動・自動削除は行わない。
pub trait RuleEngine {
	/// 単一ファイルをルールと照合し、違反があれば返す（違反なしなら空Vec）。
	fn check_file(&self, entry: &FileEntry, rules: &RuleSet) -> EngineResult<Vec<RuleViolation>>;

	/// 走査済みファイル一式をまとめて照合し、全違反を返す。
	fn check_all(&self, entries: &[FileEntry], rules: &RuleSet)
		-> EngineResult<Vec<RuleViolation>>;

	/// ルールに基づき、新規保存ファイルの推奨保存先パス（テンプレート展開結果）を返す。
	fn suggest_save_path(
		&self,
		file_name: &str,
		course_id: Option<i64>,
		rules: &RuleSet,
	) -> EngineResult<String>;
}

/// Phase1（issue #39）で実装する既定実装。
#[derive(Debug, Default)]
pub struct DefaultRuleEngine;

impl RuleEngine for DefaultRuleEngine {
	fn check_file(&self, _entry: &FileEntry, _rules: &RuleSet) -> EngineResult<Vec<RuleViolation>> {
		todo!("issue #39: ルール照合を実装する")
	}

	fn check_all(
		&self,
		_entries: &[FileEntry],
		_rules: &RuleSet,
	) -> EngineResult<Vec<RuleViolation>> {
		todo!("issue #39: 一括照合を実装する")
	}

	fn suggest_save_path(
		&self,
		_file_name: &str,
		_course_id: Option<i64>,
		_rules: &RuleSet,
	) -> EngineResult<String> {
		todo!("issue #39: 推奨保存先の算出を実装する")
	}
}
