# Fuzzy GitHub Pages site

Issue #101で作成した、Fuzzyの概要と導入手順を案内する静的サイトです。

## 現在の配布状態

現在は開発・レビュー段階のため、サイト上のダウンロードボタンは「公開予定」として無効化しています。

- 開発・レビュー段階：拡張機能をTauriアプリへ同梱
- 正式公開後：Windowsアプリとブラウザ拡張機能をこのサイトから個別配布
- どちらの段階でも、初期セットアップ完了は拡張機能からの実応答で確認

## ローカル表示

リポジトリのルートで次を実行します。

```powershell
bun install
bun run dev:site
```

表示されたURL（通常は `http://127.0.0.1:5173/`）をブラウザで開きます。

## 配布ファイル名

正式公開後、サイトのダウンロードボタンはGitHub Releaseへ次の名前で添付されたファイルを直接取得します。

- Windowsアプリ: `Fuzzy-Setup.exe`
- ブラウザ拡張機能: `Fuzzy-Extension.zip`

配布時はファイル名を変えずにReleaseへ添付します。利用者はGitHub Releasesの一覧画面を経由しません。拡張機能はZIPを展開し、対応ブラウザのデベロッパーモードから「パッケージ化されていない拡張機能を読み込む」操作で追加します。

## 正式公開時の有効化

ダウンロードボタンを有効にする前に、次の項目をすべて確認します。

1. GitHub Releaseへ`Fuzzy-Setup.exe`と`Fuzzy-Extension.zip`を添付する
2. 両方の直接ダウンロードURLが正常にファイルを返すことを確認する
3. `apps/site/index.html`の「公開予定」表示を直接ダウンロードリンクへ変更する
4. サイトへバージョン、公開日、リリースノートを掲載する
5. `bun run verify`を実行し、サイトビルドと全テストが成功することを確認する

## 公開用ビルド

```powershell
bun run build:site
bun run --cwd apps/site preview
```

`apps/site/dist` にGitHub Pagesへ公開する静的ファイルが生成されます。

## GitHub Pagesの有効化

1. `issue101` のPRをレビューして `main` へマージする
2. GitHubのリポジトリで `Settings` → `Pages` を開く
3. `Build and deployment` の `Source` を `GitHub Actions` にする
4. `Deploy Fuzzy site to GitHub Pages` の完了を待つ
5. `https://fuzzy-app.github.io/fuzzy/` を開いて確認する

Organization Pages用の `Fuzzy-app/Fuzzy-app.github.io` リポジトリへ移す場合も、リンクとアセットは相対パスなので同じサイトを利用できます。
