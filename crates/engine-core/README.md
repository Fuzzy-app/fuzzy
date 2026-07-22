# engine-core

`apps/desktop/src-tauri`（初期セットアップ）と `apps/native-host`（常駐エンジン）の両方から利用される共有Rustライブラリクレート。

フォルダ再帰走査・保存パターン推定・ルール照合・全文索引・重複検出など、両バイナリで共通する中核ロジックをここに実装し、二重実装を避ける。想定モジュール構成（詳細は `docs/仕様書.md` 5章参照）：

- `ScanEngine` — フォルダの再帰走査・既存の保存パターン推定
- `PatternEstimator` — 共通入出力で切り替え可能な保存パターン推定方式
- `RuleEngine` — グローバル／コース別ルールの照合・違反検出
- `IndexEngine` — Tantivy を用いた全文索引の構築・検索
- `DuplicateDetector` — blake3 / simhash・LSH による重複・類似ファイル検出

保存パターン推定には`folder_only`、`frequency`、`evidence_weighted`の3方式があり、`ConfigurableScanEngine`から選択できる。推定結果はDB用のディレクトリテンプレートと比較評価用のファイル名テンプレートを分離する。将来の学習方式も`PatternEstimator`を実装して同じ入出力で追加する。詳細は`docs/保存パターン推定方式.md`を参照。
