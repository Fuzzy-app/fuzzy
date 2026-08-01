# QAプレリリースの試し方

## 対象

この文書は、Fuzzy `v0.1.0-qa.2`を別のWindows 11 PCで試すQA参加者向けです。開発ツールやコマンドは必要ありません。

この版は次の制限があります。

- Windowsコード署名を行っていない未署名版
- Chrome Web Store／Microsoft Edge Add-onsの審査前
- ブラウザ拡張機能はQA中だけデベロッパーモードで追加
- 正式な一般公開版ではなく、テストデータまたはバックアップ可能な環境で使用

## ダウンロード

[Fuzzy v0.1.0-qa.2 Pre-release](https://github.com/Fuzzy-app/fuzzy/releases/tag/v0.1.0-qa.2)を開き、Assetsから`Fuzzy-Setup.exe`をダウンロードします。

Releaseには次も添付します。

- `Fuzzy-0.1.0-qa.2-windows-unsigned.zip`: README、QA用成果物、チェックサムを含む一式
- `SHA256SUMS.txt`: 配布一式のSHA-256

GitHub Actionsの一時artifactではなくReleaseを共有してください。Release assetはGitHubへログインしていない相手にも共有でき、QA期間中に自動失効しません。

## インストール

1. ダウンロード元が上記のFuzzy公式GitHub Releaseであることを確認する
2. `Fuzzy-Setup.exe`をダブルクリックする
3. 未署名警告が表示された場合は、QA版であることとダウンロード元を再確認する
4. 確認できた場合だけ、Windowsの「詳細情報」から実行を選ぶ
5. インストーラーの案内に従ってインストールする
6. Fuzzyを起動し、資料の保存先と初期ルールを設定する

警告を回避する設定変更や、セキュリティ機能の恒久的な無効化は行わないでください。ダウンロード元を確認できない場合は実行しません。

## QA版のブラウザ拡張機能

1. Fuzzy画面の「同梱フォルダーを表示」を押す
2. Chromeは`chrome://extensions`、Edgeは`edge://extensions`を開く
3. デベロッパーモードを有効にする
4. 「パッケージ化されていない拡張機能を読み込む」を押す
5. Fuzzyが表示した`chrome-mv3`フォルダーを選ぶ
6. 対応Moodleを開く
7. Fuzzy画面で拡張機能からの実応答が確認されるまで待つ

正式版ではデベロッパーモードを使用せず、公式ブラウザストアから追加します。

## 最初に確認する項目

- Fuzzyが起動し、保存先を画面から選べる
- 既存資料の確認で資料自体が移動・削除されない
- Moodle上にFuzzy UIが表示される
- 資料保存前に保存先候補を確認できる
- 保存した資料が検索できる
- 課題と締切が表示される
- Fuzzy画面からバックアップを書き出せる
- Windowsの設定からアンインストールできる
- アンインストール後も資料とSQLiteが勝手に削除されない

詳しい確認項目は[リリース前QA](リリース前QA.md)を参照してください。

## 不具合を報告する

[QAプレリリース報告フォーム](https://github.com/Fuzzy-app/fuzzy/issues/new?template=qa_report.md)を使用し、次を記載してください。

- `v0.1.0-qa.2`を使用したこと
- Windows 11のバージョン
- Chrome／Edgeとそのバージョン
- 再現手順
- 期待した動作と実際の動作

氏名、学生番号、授業資料、課題本文、Cookie、認証情報、実際のSQLiteはIssueへ投稿しないでください。セキュリティ上の問題は公開Issueではなく、[非公開脆弱性報告](https://github.com/Fuzzy-app/fuzzy/security/advisories/new)を使用します。

## アンインストール

1. 資料保存が完了していることを確認する
2. Chrome／Edgeを閉じる
3. `設定 → アプリ → インストールされているアプリ`を開く
4. Fuzzyを選び、アンインストールする
5. ブラウザの拡張機能管理画面からFuzzyを削除する

アンインストールはNative Messaging登録を解除します。安全のため、授業資料、SQLite、索引、バックアップは自動削除しません。
