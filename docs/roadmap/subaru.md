# ロードマップ: subaru

最終更新: 2026-07-01
担当範囲（README.md準拠）: API定義（Native Messaging・Tauriコマンド・ts-rs型方針）、DB定義、`crates/engine-core`、`apps/native-host`、`packages/shared`、`docs/api/contract.md`

GitHub: [Fuzzy-app/fuzzy](https://github.com/Fuzzy-app/fuzzy) issue一覧は番号順が着手順の目安。

---

## Phase0（Day1・最優先・ブロッキング）

- [ ] [#32 crates/engine-core の雛形生成とトレイト設計](https://github.com/Fuzzy-app/fuzzy/issues/32)
  `cargo new --lib crates/engine-core`、ScanEngine/RuleEngine/IndexEngine/DuplicateDetectorのtrait定義。以降の全バックエンド作業の土台。
- [ ] [#33 apps/native-host の雛形生成とNative Messaging I/Oループ](https://github.com/Fuzzy-app/fuzzy/issues/33)
  `cargo new --bin apps/native-host`、envelope読み書きループ。未知コマンドはINTERNALエラーでよい。

## Phase1（Day2〜6・バックエンド本体）

- [ ] [#36 native-hostでSQLite接続・スキーマ適用](https://github.com/Fuzzy-app/fuzzy/issues/36)
- [ ] [#37 native-hostにpingコマンドを実装し疎通確認できるようにする](https://github.com/Fuzzy-app/fuzzy/issues/37)
  これが通ると拡張機能が`mode: "native"`に切り替わる。他メンバーの結合確認にも影響するため早めに。
- [ ] [#38 engine-coreにScanEngineを実装（再帰走査・保存パターン推定）](https://github.com/Fuzzy-app/fuzzy/issues/38)
- [ ] [#39 engine-coreにRuleEngineを実装（ルール照合・違反検出）](https://github.com/Fuzzy-app/fuzzy/issues/39)
- [ ] [#40 engine-coreにDuplicateDetectorを実装（blake3 + simhash）](https://github.com/Fuzzy-app/fuzzy/issues/40)
- [ ] [#41 engine-coreにIndexEngineを実装（Tantivy全文索引）](https://github.com/Fuzzy-app/fuzzy/issues/41)
- [ ] [#42 締切・ダッシュボード・ルール系のコマンド一式を実装](https://github.com/Fuzzy-app/fuzzy/issues/42)
  #38〜#40完了後に着手。ここが揃うと他メンバーの画面がnativeモードで動き出す。
- [ ] [#43 同期時の変更検知ロジックとgetLatestSyncEvent/getAssignmentChangesを実装](https://github.com/Fuzzy-app/fuzzy/issues/43)
  hirase担当の締切ハブ「データ取得通知・変更点表示」(#56)が依存。

## Phase1後半（Day6〜・余力があれば）

- [ ] [#44 ts-rsによるRust→TS型自動生成パイプラインを整備](https://github.com/Fuzzy-app/fuzzy/issues/44)
- [ ] [#45 データのエクスポート／インポート機能を実装](https://github.com/Fuzzy-app/fuzzy/issues/45)

## Phase3（最終週・全員）

- [ ] [#59 拡張機能⇄native-host 結合テスト・最終動作確認](https://github.com/Fuzzy-app/fuzzy/issues/59)
  subaruが結合をリード。全員の画面をnativeモードに切り替えて動作確認し、`bun run build`をグリーンにする。

---

## 進め方のポイント

- 自分の作業がボトルネックになりやすいので、#37（ping）と#42（コマンド一式）は最優先で早めに終わらせる。他3人はそれまで`MockApiClient`で画面開発を進めているので、待たせすぎない。
- 型・API・DBスキーマを変更したら`packages/shared/src/types.ts`・`docs/api/contract.md`・`crates/engine-core/fixtures/schema.sql`の3点を必ずセットで更新する（CLAUDE.md参照）。
- 各コマンド実装後は他メンバーに「〇〇のnative実装が完了」とissueコメントか一声かけると、結合が早く進む。
