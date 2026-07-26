# Fuzzy GitHub Pages site

Issue #101で作成した、Fuzzyの概要と導入手順を案内する静的サイトです。

公開判断、Pages運用、ストア申請、Windows署名、一般利用者向け導入、リリース前QAの正本は[`docs/公開ガイド/`](../../docs/公開ガイド/README.md)を参照してください。このREADMEはサイト固有のビルドと構成だけを補足します。

## 現在の配布状態

現在は開発・レビュー段階のため、正式版のダウンロードボタンは「公開予定」として無効化しています。QA参加者には、未署名であることを明示した`v0.1.0-qa.1` Pre-releaseへの独立した導線を表示します。

- 開発・レビュー段階：拡張機能をTauriアプリへ同梱
- QAプレリリース：未署名インストーラーとQA用拡張機能をGitHub Pre-releaseで配布
- 正式公開後：署名済みWindowsアプリの配布ページと、公式ブラウザストアの拡張機能詳細ページを案内
- どちらの段階でも、初期セットアップ完了は拡張機能からの実応答で確認

## ローカル表示

リポジトリのルートで次を実行します。

```powershell
bun install
bun run dev:site
```

表示されたURL（通常は `http://127.0.0.1:5173/`）をブラウザで開きます。

## 公開先

正式公開後、WindowsアプリはGitHub Releaseへ次の名前で添付し、サイトから存在確認済みの公開ページへ案内します。

- Windowsアプリ: `Fuzzy-Setup.exe`

ブラウザ拡張機能は、Chrome Web StoreまたはMicrosoft Edge Add-onsのFuzzy詳細ページへ案内します。一般利用者へZIP展開、デベロッパーモード、コマンド操作を要求しません。ローカル配布物の`QA-確認用/Fuzzy-Extension.zip`はストア提出・内部確認専用です。

## 正式公開時の有効化

ダウンロードボタンを有効にする前に、次の項目をすべて確認します。

1. `Fuzzy-Setup.exe`、`Fuzzy.exe`、`FuzzyNativeHost.exe`へWindowsコード署名を行い、署名を検証する
2. GitHub Releaseへ署名済み`Fuzzy-Setup.exe`を添付し、公開ページから正常に取得できることを確認する
3. 拡張機能を公式ブラウザストアへ公開し、確定したURLとIDを`distribution.config.json`とアプリの配布設定へ反映する
4. `apps/site/index.html`の「公開予定」を、Windows公開ページと公式ブラウザストアの実在確認済みリンクへ変更する
5. サイトへバージョン、公開日、リリースノートを掲載し、`privacy.html`の内容を再確認する
6. `bun run verify`とWindows配布ビルドを実行し、クリーンなWindowsユーザー環境で導入・接続・更新・削除を実機確認する

## 公開用ビルド

```powershell
bun run build:site
bun run --cwd apps/site preview
```

`apps/site/dist` にGitHub Pagesへ公開する静的ファイルが生成されます。

## GitHub Pagesの有効化

1. GitHubのリポジトリで `Settings` → `Pages` を開く
2. `Build and deployment` の `Source` を `GitHub Actions` にする
3. `Deploy Fuzzy site to GitHub Pages` の完了を待つ
4. `https://fuzzy-app.github.io/fuzzy/` を開いて確認する

Organization Pages用の `Fuzzy-app/Fuzzy-app.github.io` リポジトリへ移す場合も、リンクとアセットは相対パスなので同じサイトを利用できます。
