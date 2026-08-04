# Fuzzy 公開ガイド

このフォルダーは、Fuzzyを初回リリースし、その後も安全に更新・配布するための正本ガイドです。一般利用者へコマンド操作を要求しないこと、SQLiteを唯一の正本として扱うこと、保存済み資料を自動移動・自動削除しないことを全手順の前提とします。

## 読む文書

| 対象 | 文書 | 目的 |
|---|---|---|
| リリース責任者 | [公開ロードマップ](公開ロードマップ.md) | 公開可否、作業順、Go/No-Go条件を判断する |
| サイト管理者 | [GitHub Pages運用](GitHub-Pages運用.md) | 公開サイトを有効化・確認・更新する |
| ストア申請担当 | [ブラウザストア申請](ブラウザストア申請.md) | Chrome Web Store／Microsoft Edge Add-onsへ申請する |
| Windows配布担当 | [Windows配布とコード署名](Windows配布とコード署名.md) | 署名済みインストーラーとGitHub Releaseを作成する |
| 一般利用者・サポート担当 | [一般利用者向けインストール](一般利用者向けインストール.md) | コマンドなしで導入・保守・削除する |
| QA参加者 | [QAプレリリース](QAプレリリース.md) | 未署名のテスト版を別PCへ導入し、不具合を報告する |
| QA担当 | [リリース前QA](リリース前QA.md) | クリーン環境で公開判定を行う |
| QA環境管理者 | [MoodleCloud QA環境](MoodleCloud-QA環境.md) | 合成データだけのストア審査環境を構築・確認する |
| 開発者・審査担当 | [構成とデータフロー](構成とデータフロー.md) | アプリ構成、データ境界、権限理由を確認する |

## 公開時の正本

- 製品仕様: [`docs/仕様書.md`](../仕様書.md)
- API契約: [`docs/api/contract.md`](../api/contract.md)
- SQLite設計: [`docs/データベース設計.md`](../データベース設計.md)
- 開発・QA環境: [`docs/セットアップ.md`](../セットアップ.md)
- 公開サイト: [`apps/site`](../../apps/site)
- 配布設定: [`apps/desktop/distribution.config.json`](../../apps/desktop/distribution.config.json)

型・API・DBスキーマを変更する場合は、公開ガイドだけを更新して実装との矛盾を残してはいけません。仕様書、API契約、SQLiteスキーマ、共有型を同時に確認します。

## 初回公開の基本方針

1. GitHub Pagesで概要、対応環境、導入手順、プライバシーポリシーを公開する
2. Chrome Web StoreとMicrosoft Edge Add-onsで正式な拡張機能IDを確定する
3. 正式IDをNative Messagingの許可元とデスクトップ配布設定へ反映する
4. Windows実行ファイルとインストーラーへ同じ公開者名でコード署名する
5. クリーンなWindows 11環境で[リリース前QA](リリース前QA.md)を完了する
6. GitHub Releaseへ署名済み`Fuzzy-Setup.exe`とチェックサムを添付する
7. GitHub Pagesの無効な「公開予定」導線を、実在確認済みのReleaseとストアURLへ切り替える

ストア審査や署名資格情報は、ソースコードや公開Issueへ保存しません。
