# Fuzzy

Moodle の授業資料を自動整理し、課題・締切を一元化する学習補助アプリ。

## 構成（モノレポ / Bun ワークスペース）

- `apps/extension` — ブラウザ拡張（WXT / Svelte / TS）。Moodle 取得・保存先サジェスト・一括DL・締切取得
- `apps/desktop` — デスクトップアプリ（Tauri）。`src` = UI(Svelte)、`src-tauri` = 処理エンジン(Rust)
- `packages/shared` — 拡張 ⇄ アプリで共有する型（ts-rs で Rust から生成）
- `docs` — 企画書・仕様書・工程計画書・構成図・API 契約

## 必要なもの

- Bun >= 1.1（ https://bun.sh ）
- Rust（rustup）＋ Tauri の前提パッケージ（OS ごとに異なる: https://tauri.app ）
- VS Code（`.vscode/extensions.json` の推奨拡張が自動提案されます）

## セットアップ

1. リポジトリを clone する
2. ルートで依存をインストール: `bun install`
3. （初回のみ）アプリを生成する
   - 拡張: `bun create wxt@latest apps/extension`（テンプレートは Svelte）
   - デスクトップ: `bun create tauri-app@latest apps/desktop`（フロントは Svelte + TS）
   - 生成後、ルート `package.json` の `workspaces` に `"apps/*"` を追加して再度 `bun install`
4. 整形・チェック: `bun run check`

## よく使うコマンド

| コマンド | 内容 |
| --- | --- |
| `bun run build` | check（自動修正）→ 型チェック。**commit 前にこれを通す** |
| `bun run check` | 整形＋Lint 自動修正（TS/JS/JSON は Biome、`.svelte` は Prettier）|
| `bun run format` | 整形のみ |
| `bun run lint` | Lint のみ（自動修正）|
| `bun run typecheck` | 型チェック |
| `bun run fmt:rust` | Rust 整形（cargo fmt）|
| `bun run lint:rust` | Rust Lint（clippy）|

## コーディング規約

- インデントは **タブ**（`.editorconfig` で全エディタに適用。VS Code は `.vscode/settings.json` でスペース無効）
- 改行コードは **LF**（`.gitattributes` で正規化。Windows 混在でも安全）
- コミット前に `bun run build` を実行して整形・型エラーを解消する
- 生成物 `packages/shared/src/generated/` は **手で編集しない**（ts-rs が Rust から生成）

## 担当（フォルダ＝担当）

- subaru: `apps/desktop/src-tauri`、`packages/shared`、`extension/background`・`content`、`docs/api/contract.md`
- hirase: `apps/extension`（popup）
- okaji: `apps/desktop/src`（setup・rules）
- matoba: `apps/desktop/src`（search・deadlines・dashboard）
- 接点: `apps/desktop/src/lib/api.ts` と `docs/api/contract.md`（変更は PR で相談）

## ブランチ運用

main は保護。作業は `feature/担当-内容` ブランチ → PR → 1人レビュー → CI 通過後にマージ。
