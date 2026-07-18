# CLAUDE.md

このファイルは、このリポジトリでコーディング作業を行うAI（Claude等）が文脈を見失わないためのシステムプロンプトです。作業前に必ず読み、ここに書かれた前提と矛盾する変更を行う場合は必ずユーザーに確認してください。

## プロジェクト概要

Fuzzy は、Moodle の授業資料を自動整理し、課題・締切を一元化する学習補助アプリ（個人利用・Windows 11専用）。詳細仕様は必ず [`docs/仕様書.md`](docs/仕様書.md) を正として参照すること（本ファイルはその要約であり、矛盾があれば仕様書側が正しい）。

**絶対に守るべき制約**：

- 保存済みファイルの自動移動・自動削除は一切行わない。すべて推薦・提示・警告に留め、実行はユーザー操作のみ
- データは全てローカル完結。外部送信は行わない
- SQLite（native-host側）が正本（source of truth）。IndexedDB（拡張機能側）は表示用キャッシュに過ぎず、書き込み競合が起きない設計を崩さない

## 現在の進捗段階（重要）

**Phase0（雛形生成）完了・Phase1（バックエンド実装）着手前** の段階。全アプリ・crateの実体は生成済みだが、中核ロジックは未実装。実装を追加する前に必ず現状を確認すること（雛形があることと実装済みであることを混同しない）。

- `crates/engine-core` — 生成済み（#32）。`ScanEngine`／`RuleEngine`／`IndexEngine`／`DuplicateDetector` の4トレイト定義と `todo!()` スタブのみ。実装はPhase1の #38〜#41
- `apps/native-host` — 生成済み（#33）。Native MessagingのI/Oループ（4byte LE長プレフィックス＋envelope、`src/protocol.rs`）まで実装済み。コマンドは全て未実装で `INTERNAL` エラーを返す。SQLite接続は #36、pingは #37 以降で実装
- `apps/extension` — 生成済み（#34、WXT＋Svelte 5）。popupは `createApiClient()` → `getDashboard()` の疎通確認画面のみ。Phase2の画面系issue（#46〜#58）で置き換える
- `apps/desktop` — 生成済み（#35、Tauri 2＋SvelteKit）。初期セットアップ画面の土台のみ
- 動くロジックの中心は依然 `packages/shared`（型定義 `src/types.ts`、APIクライアント `src/api/`、サンプルデータ `src/sample-data/`）。native-hostのコマンド未実装のため、実行時は `MockApiClient` がサンプルデータで疑似応答する
- `packages/shared/src/generated/` はts-rsによるRust→TS自動生成物の予定地（#44）。**手編集禁止**（まだ生成されていない場合は何も置かない）

## モノレポ構成と配置ルール

```
apps/*      実行可能なアプリ・プロセス単位（extension / desktop / native-host）
crates/*    複数アプリで共有するRustロジック（engine-core）
packages/*  複数アプリで共有するTSコード（shared）
docs/*      ドキュメント
```

新機能・新コードを追加する際は必ずこの4分類のどこに属するかを先に判断してから配置場所を決める。分類自体（この4カテゴリの意味）は変更しない。

## 参照すべきドキュメント

- [`docs/仕様書.md`](docs/仕様書.md) — 機能要件・画面構成・アーキテクチャ・データ設計方針（正）
- [`docs/データベース設計.md`](docs/データベース設計.md) + [`crates/engine-core/fixtures/schema.sql`](crates/engine-core/fixtures/schema.sql) — SQLiteスキーマの正
- [`docs/api/contract.md`](docs/api/contract.md) — Native Messaging / Tauri コマンド契約
- [`docs/セットアップ.md`](docs/セットアップ.md) — 開発環境構築
- [`docs/開発判断.md`](docs/開発判断.md) — Issueと仕様書の優先関係、外部連携、Moodle資料取得などの継続時の合意事項

型・API・DBスキーマのいずれかを変更する場合は、**仕様書・contract.md・schema.sql・packages/shared の型定義を必ずセットで更新**し、矛盾が生じないようにする。

## コーディング規約

- インデントは **タブ**（スペース禁止。`.editorconfig` 準拠）
- 改行コードは **LF**
- コミット前に `bun run build`（`bun run check` の自動整形＋`bun run typecheck`）を通す。TS/JS/JSONはBiome、`.svelte`はPrettier
- Rust側は `bun run fmt:rust` / `bun run lint:rust`（clippy `-D warnings`）
- ドキュメント・コードコメントは日本語（既存ファイルの言語に合わせる）
- 生成物 `packages/shared/src/generated/` は手編集しない

## 開発フロー

- `main` は保護ブランチ。作業は `issue<番号>` 形式のブランチ（例: `issue33`。対応するissueの番号を付ける）を切り、PR → 1人レビュー → CI通過後にマージ
- 拡張⇄ホスト間API（`packages/shared`の型・`docs/api/contract.md`）を変更する場合はPRで相談（README記載の「接点」ルール）

## 担当（機能＝担当。README.mdが正）

- subaru: API定義・DB定義・`crates/engine-core`・`apps/native-host`・`packages/shared`・`docs/api/contract.md`
- matoba: `apps/extension` の資料保存UI（保存先サジェスト・一括DL・ZIP提案）
- okaji: `apps/desktop`（初期セットアップ画面）、`apps/extension` のルール管理・整合性チェック画面
- hirase: `apps/extension` の活用UI（検索・締切ハブ・ダッシュボード・カレンダー連携・通知）

## AIが作業する際の注意

1. 雛形のみで未実装の箇所（`todo!()` スタブ等）に本実装を追加する際は、対応するissueの担当者・完了条件を確認してから行う。他人の担当領域に踏み込む場合は必ずユーザーに確認する
2. 型定義・APIコマンド・DBスキーマは3点（`packages/shared/src/types.ts`・`docs/api/contract.md`・`crates/engine-core/fixtures/schema.sql`）の整合を必ず確認する
3. 仕様に無い自動実行系の機能（自動移動・自動削除・外部送信等）を提案・実装しない
4. 既存のサンプルデータ（6科目：情報アーキテクチャ・データベース・離散数学・アプリ演習・認知科学概論・英語IIB）の世界観に合わせてテストデータを作る
5. 変更後は `bun run build` を実行し、型エラー・Lintエラーがないことを確認してから完了報告する
6. 実装の着手・完了判定はGitHub Issueを優先する。ただし仕様書・API契約・DB設計との相違を見つけた場合は、黙って上書きせずユーザーへ報告する。継続時の合意事項は `docs/開発判断.md` を参照する
