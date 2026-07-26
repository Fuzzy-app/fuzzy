# GitHub Pages運用

## 目的

GitHub Pagesは、Fuzzyの概要、対応環境、一般利用者向け導入手順、プライバシーポリシー、正式なダウンロード先とブラウザストアへの導線を提供します。Windowsバイナリ自体はPagesへ直接置かず、GitHub Releaseへ案内します。

公開予定URL:

- <https://fuzzy-app.github.io/fuzzy/>
- プライバシーポリシー: <https://fuzzy-app.github.io/fuzzy/privacy.html>

## リポジトリ内の構成

- サイト本体: `apps/site`
- ビルド先: `apps/site/dist`
- ワークフロー: `.github/workflows/deploy-pages.yml`
- サイトテスト: `tests/site/pages-site.test.ts`

PRではサイトのbuildとtestだけを行い、公開はしません。mainへのpushまたは手動実行時だけ、`github-pages`環境へdeployします。

## 初回有効化

初回だけ、リポジトリの管理権限を持つ担当者がGitHub UIから設定します。

1. <https://github.com/Fuzzy-app/fuzzy>を開く
2. `Settings`を開く
3. 左メニューの`Pages`を開く
4. `Build and deployment`の`Source`を`GitHub Actions`にする
5. `Actions`から`Deploy Fuzzy site to GitHub Pages`を開く
6. `Run workflow`を押し、branchに`main`を選ぶ
7. `build`と`deploy`が成功するまで待つ
8. workflowの`deploy`欄、`Settings → Pages`、または上記公開予定URLから表示を確認する

一般利用者はこの設定やコマンド操作を行いません。

## main更新時の動作

次のパスがmainで更新されると、自動でサイトを再公開します。

- `apps/site/**`
- `tests/site/**`
- `.github/workflows/deploy-pages.yml`
- `package.json`
- `bun.lock`

文書だけを更新してサイトを変更しない場合、Pages workflowは自動実行されません。公開サイトへ反映が必要なら、`apps/site`も同じPRで更新するか、Actions UIから手動実行します。

## 公開前表示

Windows ReleaseまたはストアURLが未確定の間は、ダウンロードボタンを「公開予定」として無効化します。存在しないURL、CIの一時artifact URL、ローカルパスへリンクしてはいけません。

プライバシーポリシーはストア申請前に公開します。トップページのダウンロードが無効でも、プライバシーポリシーとサポート導線は閲覧可能にします。

## 正式公開時の更新

1. GitHub Releaseに署名済み`Fuzzy-Setup.exe`が存在することを確認する
2. Chrome Web Store／Edge Add-onsの詳細ページが閲覧可能であることを確認する
3. `apps/site/index.html`へ実在確認済みHTTPS URLを設定する
4. バージョン、公開日、対応環境、既知の制限、リリースノートを掲載する
5. `apps/site/privacy.html`の最終更新日と内容を確認する
6. PR上でサイトテストを通す
7. mainへマージし、Pagesのdeploy成功後に公開リンクを実際に操作する

## 確認項目

- [ ] トップページがHTTPSで表示される
- [ ] `/privacy.html`が単独で表示される
- [ ] スマートフォン幅でも本文とリンクを操作できる
- [ ] 「Windows版を入手」が署名済みReleaseへ遷移する
- [ ] 拡張機能導線が正式なストア詳細ページへ遷移する
- [ ] 未公開ファイルやCI artifactへ案内していない
- [ ] GitHub Issuesへ個人情報や認証情報を投稿しない注意書きがある
- [ ] 対応MoodleとWindows 11限定であることが分かる

## 404の場合

次の順で確認します。

1. `Settings → Pages`でSourceが`GitHub Actions`になっているか
2. workflowがPRではなくmainまたは`workflow_dispatch`で実行されたか
3. `Configure GitHub Pages`が404で失敗していないか
4. `deploy` jobに`pages: write`と`id-token: write`があるか
5. `apps/site/dist/index.html`がartifactへ含まれているか
6. URLのOrganization名とリポジトリ名の大文字小文字・パスを確認する

初回の`Configure GitHub Pages`が`Not Found`の場合は、ほとんどがPages未有効化です。ワークフローを変更して権限確認を回避せず、GitHub UIでSourceを有効化します。

## 参考

- [GitHub Pagesの公開元を設定する](https://docs.github.com/ja/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [GitHub Pagesでカスタムworkflowを使う](https://docs.github.com/ja/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
