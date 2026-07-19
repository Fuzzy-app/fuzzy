//! engine-core — Fuzzy 共有エンジンクレート
//!
//! `apps/desktop/src-tauri`（初期セットアップ）と `apps/native-host`（常駐エンジン）の
//! 両バイナリから利用される中核ロジックを、トレイト境界で責務分離して提供する
//! （docs/仕様書.md 3.3節）。
//!
//! - [`scan::ScanEngine`] — フォルダの再帰走査・既存の保存パターン推定
//! - [`rule::RuleEngine`] — グローバル／コース別ルールの照合・違反検出
//! - [`index::IndexEngine`] — Tantivy を用いた全文索引の構築・検索
//! - [`duplicate::DuplicateDetector`] — blake3 / simhash による重複・類似ファイル検出
//!
//! Phase1 の各issueで実装する（#38 ScanEngine / #39 RuleEngine /
//! #40 DuplicateDetector / #41 IndexEngine）。
//!
//! 【重要な設計制約】このクレートはファイルの自動移動・自動削除を一切行わない。
//! すべて推薦・提示・警告のためのデータを返すに留め、実行はユーザー操作のみとする。

pub mod duplicate;
pub mod error;
pub mod index;
pub mod pattern;
pub mod rule;
pub mod scan;
pub mod section;
pub mod types;

pub use error::{EngineError, EngineResult};

/// SQLiteスキーマ定義（DDL）の正本。native-host が初回起動時に適用する（issue #36）。
/// 実体は [`crates/engine-core/fixtures/schema.sql`]。
pub const SCHEMA_SQL: &str = include_str!("../fixtures/schema.sql");

/// 開発・デモ・モックフォールバック用のサンプルデータ（seed）。
/// 6科目の世界観（docs/データベース設計.md）。スキーマ適用後に投入する。
pub const SEED_SQL: &str = include_str!("../fixtures/seed.sql");
