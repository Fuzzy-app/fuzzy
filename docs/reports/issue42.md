# Issue #42 実装報告

## 対象

`getDashboard`、`getDeadlines`、`updateSubmissionStatus`、`getRules`、
`updateGlobalRule`、`updateCourseRuleOverride`、`getRuleViolations`、
`getDuplicateGroups`、`getNotificationRules`、`updateNotificationRules`を、
Native Messaging経由でSQLiteへ接続した。

## 責務分担

- `engine-core::database::learning`: ダッシュボード集計、締切取得、提出状態更新
- `engine-core::database::rules`: ルール取得・更新、違反再計算、警告一覧取得
- `engine-core::database::duplicates`: 重複グループ取得とDB値の整合性確認
- `engine-core::database::notifications`: 通知ルール取得・一括更新、表示名生成
- `native-host::api_types`: `packages/shared/src/types.ts`に対応するwire DTOと安全な相対パス変換
- `native-host::commands`: payload検証、DB呼び出し、レスポンス生成
- `native-host::main`: Native Messagingの入出力ループのみ

## 整合性と安全性

- APIのフィールド名は`camelCase`、列挙値は共有TypeScript型と同じ`snake_case`で返す。
- ルール更新と違反注釈の再計算は同一SQLiteトランザクションで行い、失敗時は全変更を戻す。
- 通知ルールはID・相対時間の重複と0〜525,600分の範囲を検証し、一括更新する。
- 通知名は`offsetMinutes`から生成し、「固定時刻」ではなく「締切から何分前」として扱う。
- ルール違反・重複一覧は保存ルート以下の相対パスだけを返し、保存ルート外の絶対パスは応答やエラー文へ含めない。
- 存在しない課題・コース・通知ルールIDは`NOT_FOUND`とし、更新成功として扱わない。

## 依存Issueについて

`getDuplicateGroups`はSQLiteに登録済みのグループを読み取るコマンドであり、
重複を検出して登録する`DuplicateDetector`（Issue #40）とは責務を分けている。
Issue #40の完了後も、このAPIの型と読み取り処理は変更せず利用できる。
