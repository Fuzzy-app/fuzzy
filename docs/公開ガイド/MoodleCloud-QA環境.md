# MoodleCloud QA環境

## 目的と対象

Microsoft Edge Add-onsなどのストア審査とFuzzyの動作確認に、合成データだけを持つMoodleCloud環境を使用します。

- QAサイト: <https://fuzzy-qa-2026.moodlecloud.com/>
- 対応origin: `https://fuzzy-qa-2026.moodlecloud.com/*`
- 用途: ゲスト閲覧、資料候補の取得、課題・締切表示、拡張機能起動の確認

この環境は一般向けのMoodleCloud対応を表明するものではありません。正式な一般利用者向け対応範囲は、引き続き`https://*.wakayama-u.ac.jp/*`の対応Moodleです。

## 情報管理

- 実在する氏名、学生番号、授業情報、授業資料を登録しない
- 管理者、ゲストアクセス、審査用アカウントのパスワードをリポジトリ、Issue、PR、ログへ記載しない
- 認証情報が必要な場合は、ストアの非公開テスト欄など承認された経路だけで共有する
- 公開するスクリーンショットやQA証跡へ認証情報を含めない
- MoodleのCookieや認証情報をnative-hostへ渡さない

## サイト基本設定

管理画面の検索から`Site home settings`を開き、次を設定します。

| 項目 | 値 |
|---|---|
| Full site name | Fuzzy QA Moodle |
| Short name | Fuzzy QA |
| Summary | 下記参照 |

```text
Fuzzy拡張機能の動作確認・審査用Moodle環境です。
実在の学生情報や授業データは使用していません。
```

管理画面の検索から`Default time zone`を開き、`Asia/Tokyo`へ設定します。続いて`Manage authentication`を開き、`Guest login`を有効化します。

## テスト用コース

`Manage courses and categories`から、次のコースを作成します。

| 項目 | 値 |
|---|---|
| Course full name | Fuzzy 動作確認コース |
| Course short name | FUZZY-QA |
| Course visibility | Show |
| Summary | Fuzzyの資料整理、課題期限検出、Moodle連携を確認するための合成データです。 |

コースで編集モードを有効にし、次の活動と資料を登録します。

### Page

- タイトル: 講義資料サンプル
- 内容:

```text
これはFuzzyの資料整理機能を確認するための合成資料です。
科目名：情報アーキテクチャ
テーマ：データ整理と検索
```

### File

`fuzzy-qa-material.txt`を作成し、次の内容を登録します。

```text
Fuzzy QA サンプル資料
これは公開審査と拡張機能の動作確認用の合成データです。
```

### Assignment

次の2件へ合成データであることが分かる説明文を設定します。締切は作成時点からの相対日で設定し、QA実施時に未来日時であることを確認します。

| 課題 | 締切 |
|---|---|
| 第1回レポート | 作成時点から7日後 |
| 第2回レポート | 作成時点から14日後 |

## ゲストアクセス

コース内の`Participants`から`Enrolment methods`を開き、`Guest access`を追加して有効化します。審査上必要な場合だけゲストアクセス用パスワードを設定し、公開場所には記録しません。

ゲストは閲覧専用であり、課題を提出できません。課題提出など認証が必須の機能を審査対象に含める場合は、実在人物と結び付かない審査専用アカウントを別途用意します。

## 動作確認

シークレットウィンドウなど既存セッションの影響を受けない環境でQAサイトを開き、`Login as a guest`を選択します。

- [ ] 「Fuzzy 動作確認コース」が表示される
- [ ] Page「講義資料サンプル」を閲覧できる
- [ ] `fuzzy-qa-material.txt`をダウンロードできる
- [ ] 「第1回レポート」「第2回レポート」と各締切が表示される
- [ ] Fuzzy UIがQAサイト上で起動する
- [ ] コース、課題、資料候補を読み取れる
- [ ] 対応外originではFuzzy UIが起動しない

確認日、Windows build、ブラウザversion、対象コミットSHAをQA証跡へ残します。認証情報、個人情報、実在の授業資料は証跡へ含めません。

## 拡張機能成果物

Issue番号に対応するブランチで、次を実行します。

```powershell
bun run typecheck:extension
bun run build:extension
bun run --cwd apps/extension zip
bun run build
```

生成ZIPでは、ルート直下の`manifest.json`にQA用originと既存の和歌山大学Moodle originが含まれることを確認します。ソースマップ、秘密鍵、認証情報、実在データ、不要なテストデータを含めません。
