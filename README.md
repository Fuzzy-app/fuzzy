# Fuzzy

Moodle の授業資料を自動整理し、課題・締切を一元化する学習補助アプリ。詳細仕様は [`docs/仕様書.md`](docs/仕様書.md) を参照。

## 一般利用者向け

正式公開版は、Windows 11で`Fuzzy-Setup.exe`を実行し、Fuzzyの画面案内と公式ブラウザストアだけで導入できる設計です。ターミナルや開発者向けコマンドは使いません。Native Messagingホストの配置・登録・修復・アンインストール時の解除もアプリが行います。

現在は公開審査前です。ローカルテスト成果物は`dist/Fuzzy-<version>-windows/`へ生成され、通常の確認には最上位の`Fuzzy-Setup.exe`を使います。`QA-確認用/`は開発・審査専用です。正式公開には、Windowsコード署名とブラウザストアの公開URL・拡張機能IDの設定が別途必要です。

別PCでの動作確認には、未署名の[Fuzzy v0.1.0-qa.2 Pre-release](https://github.com/Fuzzy-app/fuzzy/releases/tag/v0.1.0-qa.2)を使用します。これは正式版ではありません。参加方法と注意事項は[QAプレリリースの試し方](docs/公開ガイド/QAプレリリース.md)を参照してください。

公開責任者、ストア申請担当、Windows配布担当、QA担当、一般利用者向けの手順は、役割別の[`docs/公開ガイド/`](docs/公開ガイド/README.md)を参照してください。

## 構成（モノレポ / Bun ワークスペース + Cargo ワークスペース）

```
apps/
├── extension/    ブラウザ拡張（WXT / Svelte / TS）。初期セットアップ以外のほぼ全画面
├── desktop/      初期セットアップ・拡張機能復旧確認用 Tauri アプリ（src=UI、src-tauri=Tauri側Rust）
└── native-host/  Native Messaging ホスト（Rust・GUIなし・常駐エンジン）
crates/
└── engine-core/  走査・ルール照合・全文索引・重複検出など、desktop/native-host 共有のRustロジック
packages/
└── shared/       拡張 ⇄ アプリで共有する型・APIクライアント（Rust DTOはts-rsで生成）
docs/
├── 仕様書.md          機能要件・アーキテクチャ・データ設計
├── 開発判断.md        Issue優先度・継続時の合意事項
├── UIデザインシステム.md 共通theme token・配色意図・画面状態の実装規約
├── セットアップ.md     開発環境構築手順（Bun / Rust / Tauri 前提パッケージ）
├── データベース設計.md  SQLiteスキーマ
└── api/contract.md   Native Messaging / Tauriコマンド契約
```

仕様とIssueの扱い、外部連携、Moodle資料取得など、開発中に合意した前提は [`docs/開発判断.md`](docs/開発判断.md) を参照する。仕様書・Issueとの相違を見つけた場合は、実装前に報告する。

`packages/shared` は共有型、`FuzzyApiClient`、Native Messagingクライアントを提供する。Rustのwire DTOは`src/generated/`へ自動生成し、未移行の型だけを`src/types.ts`に置く。本番画面はbackground経由でnative-hostの実データだけへ接続する。未接続時はサンプルへ切り替えず接続エラーを表示し、ダッシュボードだけは過去に取得した実データのローカルキャッシュがあれば明示して表示する。

新しい機能やコードを追加する際は、「実行可能なアプリ・プロセス単位 → `apps/*`」「複数アプリで共有するRustロジック → `crates/*`」「複数アプリで共有するTSコード → `packages/*`」「ドキュメント → `docs/*`」という分類に沿って配置場所を決める。この分類自体は変更しない想定。

## 必要なもの

- Bun >= 1.1
- Rust（rustup）＋ Tauri の前提パッケージ（Microsoft C++ Build Tools, WebView2）
- VS Code（`.vscode/extensions.json` の推奨拡張が自動提案されます）

インストール手順の詳細は [`docs/セットアップ.md`](docs/セットアップ.md) を参照。

## セットアップ

1. リポジトリを clone する
2. ルートで依存をインストール: `bun install`（パッケージ管理はbunに統一。npm/yarnは使わない）
3. Rust側のビルド確認: `cargo build`
4. 整形・チェック: `bun run check`

※各アプリ・クレートはPhase0（#32〜#35）で生成され、現在はnative-host統合を含む本実装まで完了しています。雛形を作り直す必要はありません。

詳しい手順・トラブルシューティングは [`docs/セットアップ.md`](docs/セットアップ.md) を参照。

## よく使うコマンド

| コマンド                | 内容                                                    |
|---------------------|-------------------------------------------------------|
| `bun run build`     | 自動整形・型・テストとsite／extension／desktopのbuild。**commit前に実行** |
| `bun run verify`    | CI相当の整形・型・テスト・全アプリbuild・Rust fmt/clippy/test        |
| `bun run dist:windows` | Windows用インストーラーと確認用成果物を`dist/`へ作成              |
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
- UI変更では [`docs/UIデザインシステム.md`](docs/UIデザインシステム.md) と共通theme tokenを使用し、アプリ固有コードへ色リテラルを追加しない

## 担当（機能＝担当）

- subaru: API定義（Native Messaging・Tauriコマンド・ts-rs型方針）、DB定義、`crates/engine-core`、`apps/native-host`、`packages/shared`、`docs/api/contract.md`
- matoba: `apps/extension` の資料保存UI（保存先サジェスト・一括DL・ZIP提案）
- okaji: `apps/desktop`（初期セットアップ画面）、`apps/extension` のルール管理・整合性チェック画面（カスタムルール・コース別例外・違反警告）
- hirase: `apps/extension` の活用UI（横断検索・締切ハブ・ダッシュボード・カレンダー連携・通知）
- 接点: 拡張⇄ホスト間のAPI（`packages/shared` の型と `docs/api/contract.md`）。変更は PR で相談

## GitHub運用

- gitフローで開発
- main は保護。作業は `issue<番号>` ブランチ（例: `issue33`。対応するissueの番号を付ける） → PR → 1人レビュー → CI 通過後にマージ。
- コミットメッセージは [`.github/COMMIT_MESSAGE_TEMPLATE.md`](.github/COMMIT_MESSAGE_TEMPLATE.md) に従ってください。
