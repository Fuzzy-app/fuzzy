# API契約（拡張機能 ⇄ Native Messagingホスト / Tauri）

最終更新: 2026-07-01

DBスキーマは [`データベース設計.md`](../データベース設計.md) を参照。型はRust構造体を正とし、`ts-rs` で `packages/shared/src/generated/` にTS型を自動生成する想定（生成物は手編集しない）。実装初期の暫定型は `packages/shared/src/types.ts` に手書きしている。

---

## 1. Native Messaging API（拡張機能 ⇄ native-host）

### 1.1 エンベロープ

リクエスト・レスポンスは共通の envelope を JSON でやり取りする（`connectNative` の場合は同一ポート上で複数回、`sendNativeMessage` の場合は1往復のみ）。

```jsonc
// リクエスト
{ "id": "uuid", "command": "search", "payload": { "query": "正規化" } }

// レスポンス（成功）
{ "id": "uuid", "ok": true, "data": { /* ... */ } }

// レスポンス（失敗）
{ "id": "uuid", "ok": false, "error": { "code": "NOT_FOUND", "message": "..." } }
```

### 1.2 コマンド一覧

| command                    | 用途                      | payload → data（概要）                                  |
|----------------------------|-------------------------|-----------------------------------------------------|
| `ping`                     | 疎通確認（フォールバック判定に使用）      | `{}` → `{ version }`                                |
| `suggestSavePath`          | 保存先候補の提案                | `{ course, fileMeta }` → `SaveSuggestion[]`         |
| `saveFiles`                | 一括保存実行                  | `{ files[], targetPath }` → `{ savedFileIds }`      |
| `extractZip`               | ZIP展開要否の提案・実行           | `{ zipPath, flatten }` → `{ extractedPaths }`       |
| `checkSimilarFiles`        | 保存前の類似ファイル検知            | `{ fileMeta }` → `SaveSuggestion["similarMatches"]` |
| `search`                   | 全文検索（該当箇所ジャンプ用のページ情報含む） | `{ query }` → `SearchResult[]`                      |
| `getDashboard`             | コース別ダッシュボード集計           | `{}` → `DashboardSummary`                           |
| `getDeadlines`             | 締切一覧取得（フィルタ可）           | `{ filter? }` → `Assignment[]`                      |
| `updateSubmissionStatus`   | 提出状況の手動更新               | `{ assignmentId, submitted }` → `{ ok }`            |
| `getRules`                 | グローバル／コース別ルール取得         | `{}` → `RuleSet`                                    |
| `updateGlobalRule`         | グローバルルール更新              | `{ patternTemplate }` → `{ ok }`                    |
| `updateCourseRuleOverride` | コース別例外ルール更新             | `{ courseId, override }` → `{ ok }`                 |
| `getRuleViolations`        | ルール違反ファイル一覧             | `{}` → `RuleViolation[]`                            |
| `getDuplicateGroups`       | 重複ファイル一覧                | `{}` → `DuplicateGroup[]`                           |
| `getNotificationRules`     | 通知タイミング設定取得             | `{}` → `NotificationRule[]`                         |
| `updateNotificationRules`  | 通知タイミング設定更新             | `{ rules[] }` → `{ ok }`                            |
| `getLatestSyncEvent`       | 直近の同期結果取得（データ取得通知用）     | `{}` → `DataSyncEvent \| null`                      |
| `getAssignmentChanges`     | 同期で検出された課題の変更点一覧（変更点表示用） | `{ sinceSyncEventId? }` → `AssignmentChange[]`      |
| `exportData`               | バックアップ用エクスポート           | `{}` → `{ filePath }`                               |
| `importData`               | バックアップからの復元             | `{ filePath }` → `{ ok, reindexRequired }`          |

### 1.3 起動・接続方針

`docs/仕様書.md` 3.3節のとおり、Moodleドメインのタブが存在する間 `connectNative` で接続を維持する。拡張機能側は `ping` にタイムアウト（目安800ms）を設定し、応答がなければサンプルデータへのモック動作にフォールバックする（`packages/shared/src/api/`）。単発のコマンド（ルール更新など）は `sendNativeMessage` でも構わない。

### 1.4 データ取得通知・変更点表示のフロー

Moodleから課題・締切データを取得（同期）した直後、拡張機能は次の手順で「データ取得通知」と「変更点の表示」を行う（`docs/仕様書.md` 1.3節）。

1. native-host側は同期完了ごとに `sync_events` に1行追加し、変更を検出した課題ごとに `assignment_changes` へ差分を記録する（`データベース設計.md` 参照）
2. 拡張機能は同期完了を検知したら `getLatestSyncEvent` を呼び、`new/changed/removed_assignment_count` を使ってブラウザ通知を出す（例:「Moodleからデータを取得しました（変更2件）」）。変更が0件でも取得したこと自体は通知する
3. 通知または締切ハブから「変更点を見る」操作をした際は `getAssignmentChanges({ sinceSyncEventId })` で対象同期以降の差分一覧を取得し、`field` ごとに変更前後の値（`oldValue` → `newValue`）を表示する

---

## 2. Tauriコマンド（初期セットアップアプリ ⇄ Rust）

| コマンド                      | 用途                              | 引数 → 戻り値                                         |
|---------------------------|---------------------------------|--------------------------------------------------|
| `pick_base_folder`        | OSネイティブダイアログで保存先フォルダを選択し実パスを取得  | `()` → `string \| null`                          |
| `scan_existing_structure` | 選択フォルダの既存構成を再帰スキャンし、近いパターン候補を提示 | `{ path }` → `PatternCandidate[]`                |
| `save_initial_setup`      | 選んだパターン／ルールをSQLiteに保存           | `{ path, pattern, courseOverrides? }` → `{ ok }` |
| `get_setup_status`        | 初期セットアップ済みかどうか確認                | `()` → `{ done: boolean }`                       |

`pick_base_folder` 等の実体は `crates/engine-core` の `ScanEngine` を呼び出す（`apps/desktop/src-tauri` と `apps/native-host` の両方が同じ `crates/engine-core` に依存する設計。`docs/仕様書.md` 3.3節）。

---

## 3. エラーコード（暫定）

| code                 | 意味                                   |
|----------------------|--------------------------------------|
| `NOT_FOUND`          | 対象のファイル／コース／ルールが存在しない                |
| `IO_ERROR`           | ファイル保存・読み込みに失敗                       |
| `RULE_CONFLICT`      | ルール定義が矛盾している                         |
| `MOODLE_UNREACHABLE` | Moodle側の情報取得に失敗（拡張機能側で発生、ホストには関係しない） |
| `INTERNAL`           | 想定外のエラー                              |

---

## 4. 未決事項

- `saveFiles` のレスポンスに保存後の `SaveSuggestion` 形式を含めるか
- `exportData` / `importData` のファイル形式（生SQLiteファイル vs 専用アーカイブ）
- バージョン不整合時（拡張機能とnative-hostのバージョン差）の扱い
