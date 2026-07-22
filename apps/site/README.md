# Fuzzy GitHub Pages site

Issue #101で作成した、Fuzzyの概要と導入手順を案内する静的サイトです。

## ローカル表示

リポジトリのルートで次を実行します。

```powershell
bun install
bun run dev:site
```

表示されたURL（通常は `http://127.0.0.1:5173/`）をChromeで開きます。

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
