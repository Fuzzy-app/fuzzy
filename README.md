# Fuzzy

Moodle の授業資料を自動整理し、課題・締切を一元化する学習補助アプリ。詳細仕様は [`docs/仕様書.md`](docs/仕様書.md) を参照。

## 構成（モノレポ / Bun ワークスペース + Cargo ワークスペース）

```
apps/
├── extension/    ブラウザ拡張（WXT / Svelte / TS）。初期セットアップ以外のほぼ全画面
├── desktop/      初期セットアップ専用 Tauri アプリ（src=UI、src-tauri=Tauri側Rust）
└── native-host/  Native Messaging ホスト（Rust・GUIなし・常駐エンジン）
crates/
└── engine-core/  走査・ルール照合・全文索引・重複検出など、desktop/native-host 共有のRustロジック
packages/
└── shared/       拡張 ⇄ アプリで共有する型・APIクライアント（型は将来 ts-rs で Rust から生成）
docs/
├── 仕様書.md          機能要件・アーキテクチャ・データ設計
├── セットアップ.md     開発環境構築手順（Bun / Rust / Tauri 前提パッケージ）
├── データベース設計.md  SQLiteスキーマ
└── api/contract.md   Native Messaging / Tauriコマンド契約
```

`packages/shared` には暫定の型定義（`src/types.ts`）、サンプルデータ（`src/sample-data/`）、`FuzzyApiClient`インターフェースとその実装（`NativeApiClient` / `MockApiClient`、`src/api/`）が既に入っている。`createApiClient()` が native-host への接続を試み、応答がなければ自動でサンプルデータにフォールバックするため、native-host・拡張機能の実装が揃っていない段階でも画面開発を進められる。

新しい機能やコードを追加する際は、「実行可能なアプリ・プロセス単位 → `apps/*`」「複数アプリで共有するRustロジック → `crates/*`」「複数アプリで共有するTSコード → `packages/*`」「ドキュメント → `docs/*`」という分類に沿って配置場所を決める。この分類自体は変更しない想定。

## 必要なもの

- Bun >= 1.1
- Rust（rustup）＋ Tauri の前提パッケージ（Microsoft C++ Build Tools, WebView2）
- VS Code（`.vscode/extensions.json` の推奨拡張が自動提案されます）

インストール手順の詳細は [`docs/セットアップ.md`](docs/セットアップ.md) を参照。

## セットアップ

1. リポジトリを clone する
2. ルートで依存をインストール: `bun install`
3. （初回のみ）各アプリ・クレートを生成する
	- 拡張: `bun create wxt@latest apps/extension`（テンプレートは Svelte）
	- デスクトップ（初期セットアップ）: `bun create tauri-app@latest apps/desktop`（フロントは Svelte + TS）
	- Native Messagingホスト: `cargo new --bin apps/native-host`
	- 共有Rustクレート: `cargo new --lib crates/engine-core`
	- 生成後、ルート `package.json` の `workspaces` に `"apps/*"` を追加して再度 `bun install`
4. 整形・チェック: `bun run check`

詳しい手順・トラブルシューティングは [`docs/セットアップ.md`](docs/セットアップ.md) を参照。

## よく使うコマンド

| コマンド                | 内容                                                    |
|---------------------|-------------------------------------------------------|
| `bun run build`     | check（自動修正）→ 型チェック。**commit 前にこれを通す**                 |
| `bun run check`     | 整形＋Lint 自動修正（TS/JS/JSON は Biome、`.svelte` は Prettier） |
| `bun run format`    | 整形のみ                                                  |
| `bun run lint`      | Lint のみ（自動修正）                                         |
| `bun run typecheck` | 型チェック                                                 |
| `bun run fmt:rust`  | Rust 整形（cargo fmt）                                    |
| `bun run lint:rust` | Rust Lint（clippy）                                     |

## コーディング規約

- インデントは **タブ**（`.editorconfig` で全エディタに適用。VS Code は `.vscode/settings.json` でスペース無効）
- 改行コードは **LF**（`.gitattributes` で正規化。Windows 混在でも安全）
- コミット前に `bun run build` を実行して整形・型エラーを解消する
- 生成物 `packages/shared/src/generated/` は **手で編集しない**（ts-rs が Rust から生成）

## 担当（機能＝担当）

- subaru: API定義（Native Messaging・Tauriコマンド・ts-rs型方針）、DB定義、`crates/engine-core`、`apps/native-host`、`packages/shared`、`docs/api/contract.md`
- matoba: `apps/extension` の資料保存UI（保存先サジェスト・一括DL・ZIP提案）
- okaji: `apps/desktop`（初期セットアップ画面）、`apps/extension` のルール管理・整合性チェック画面（カスタムルール・コース別例外・違反警告）
- hirase: `apps/extension` の活用UI（横断検索・締切ハブ・ダッシュボード・カレンダー連携・通知）
- 接点: 拡張⇄ホスト間のAPI（`packages/shared` の型と `docs/api/contract.md`）。変更は PR で相談

## GitHub運用

- gitフローで開発
- main は保護。作業は `feat/担当-内容` ブランチ → PR → 1人レビュー → CI 通過後にマージ。
- コミットメッセージは [`.github/COMMIT_MESSAGE_TEMPLATE.md`](.github/COMMIT_MESSAGE_TEMPLATE.md) に従ってください。
