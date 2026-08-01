# Windows配布とコード署名

## 配布方針

正式な一般利用経路は、Windows 11で署名済み`Fuzzy-Setup.exe`を実行し、Fuzzy画面と公式ブラウザストアだけでセットアップする方法です。一般利用者へビルド、ターミナル、レジストリ編集、ZIP展開、native-hostの手動登録を要求しません。

現在のNSIS設定は現在のWindowsユーザーへインストールするため、通常は管理者権限を必要としません。

## 成果物

`bun run dist:windows`は、次の構成を`dist/Fuzzy-<version>-windows/`へ作成します。

```text
Fuzzy-<version>-windows/
├── Fuzzy-Setup.exe
├── README.txt
├── SHA256SUMS.txt
└── QA-確認用/
	├── Fuzzy-Extension.zip
	├── FuzzyNativeHost.exe
	└── Fuzzy-Portable/
		├── Fuzzy.exe
		└── resources/
```

- `Fuzzy-Setup.exe`: 一般利用者と正式なアンインストール確認に使う
- `QA-確認用/Fuzzy-Portable`: インストーラーなしの内部確認に使う
- `QA-確認用/FuzzyNativeHost.exe`: Native Messaging単体確認に使う
- `QA-確認用/Fuzzy-Extension.zip`: ストア提出と内部結合確認に使う

QA用ファイルを一般利用者向けダウンロードとして案内しません。

## 公開者ID

署名を取得する前に次を統一します。

- Tauri `publisher`
- コード署名証明書のSubject
- GitHub Releaseとサイトに表示する公開者名
- Chrome Web Store／Edge Add-onsの公開者名
- サポートメールと公開主体

`Fuzzy Project`のまま署名資格を取得できるとは限りません。個人または法人の本人確認済み名称に合わせます。

## コード署名方法

候補:

- Microsoft Artifact Signing
- 信頼された認証局のOVコード署名証明書
- 条件を満たすオープンソースプロジェクト向けSignPath Foundation
- 将来のMicrosoft Store MSIX配布

自己署名証明書は開発・組織内配布専用で、一般公開版には使用しません。EV証明書だけを理由に初回SmartScreen警告が必ず消えるとは扱いません。

## 署名順序

1. `FuzzyNativeHost.exe`をreleaseビルドする
2. `FuzzyNativeHost.exe`へ署名する
3. 署名済みnative-hostをTauri resourcesへ配置する
4. `Fuzzy.exe`をreleaseビルドする
5. `Fuzzy.exe`へ署名する
6. 署名済み内部EXEを含むNSISインストーラーを作成する
7. 最後に`Fuzzy-Setup.exe`へ署名する
8. すべての署名とタイムスタンプを検証する
9. 署名後のファイルでSHA-256一覧を生成する

署名後にファイルをコピーすること自体は問題ありませんが、バイト内容を変更してはいけません。現在の配布スクリプトへ署名工程を追加する場合は、収集・チェックサム作成より前に実行します。

## CI資格情報

- 証明書、秘密鍵、署名トークンをリポジトリへコミットしない
- Fork由来PRへ署名資格情報を渡さない
- 署名jobは保護されたGitHub Environmentとmain/tagだけで実行する
- 承認者、監査ログ、最小権限、資格情報ローテーションを設定する
- 未署名smoke artifactと正式署名artifactを明確に別名にする
- 正式release workflowは署名失敗や検証失敗を無視しない

## ストア版Tauriビルド

公開審査前のQA版は、手動導入用のunpacked拡張機能を同梱します。正式版は公式ストアから追加するため、`tauri.store.conf.json`でunpacked拡張機能を除外します。

正式ストアURLが`null`、許可IDとURL末尾IDが不一致、Native Messagingホスト名が不一致の場合、ストア版ビルドを停止する設計を維持します。

## GitHub Release

公開審査前QA版:

- Tag: `v0.1.0-qa.3`
- Release title: `Fuzzy v0.1.0-qa.3 — QAプレリリース（未署名）`
- Pre-releaseとして作成し、Latest releaseにはしない
- Asset: `Fuzzy-Setup.exe`
- Asset: `Fuzzy-0.1.0-qa.3-windows-unsigned.zip`
- Asset: `SHA256SUMS.txt`
- Release本文とAsset名の両方で未署名・QA専用と明示する

初回正式版:

- Tag: `v0.1.0`
- Release title: `Fuzzy v0.1.0`
- Asset: `Fuzzy-Setup.exe`
- Asset: `SHA256SUMS.txt`
- 必要に応じて署名検証情報、SBOM、第三者ライセンス一覧

Release本文へ次を記載します。

- 対応OSとブラウザ
- 対応Moodle
- 新規導入手順
- 既知の制限
- データ保存場所
- アンインストールしても資料とSQLiteを削除しないこと
- ストア詳細ページ
- プライバシーポリシー

ソースコードの自動生成ZIPを、Windowsアプリのインストーラーと誤認させないようにします。

## バージョン整合

次を同じ公開バージョンにします。

- ルート`package.json`
- `apps/extension/package.json`
- `apps/desktop/package.json`
- `apps/site/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- Rust crates
- ストア提出manifest
- Release tagとRelease title

配布ビルドは不一致を検出したら停止します。

## 公開前確認

- [ ] 3つのEXEで署名状態が`Valid`
- [ ] タイムスタンプが有効
- [ ] 署名主体名がサイト・ストアと一致
- [ ] SHA-256一覧が全件一致
- [ ] 配布物とビルド元が一致
- [ ] NSISのインストールとアンインストールが成功
- [ ] native-host登録と解除が自動で成功
- [ ] アンインストールで資料とSQLiteを削除しない
- [ ] GitHub ReleaseのAssetを別PCからダウンロードできる
- [ ] SmartScreenとウイルス対策ソフトの表示を記録した

## 参考

- [Tauri Windowsコード署名](https://v2.tauri.app/distribute/sign/windows/)
- [Windowsコード署名の選択肢](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)
- [SmartScreen reputation](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)
- [GitHub Releases](https://docs.github.com/repositories/releasing-projects-on-github/about-releases)
