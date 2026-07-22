# API契約（拡張機能 ⇄ Native Messagingホスト / Tauri）

最終更新: 2026-07-22

DBスキーマは [`データベース設計.md`](../データベース設計.md) を参照。型はnative-hostのAPI DTOを正とし、`ts-rs` で `packages/shared/src/generated/` にTS型を自動生成する想定（生成物は手編集しない）。実装初期のRust DTOは `apps/native-host/src/api_types.rs`、暫定TS型は `packages/shared/src/types.ts` に定義する。`crates/engine-core` の絶対パスを含む内部型をそのままwire形式にしない。

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
| `reportExtensionRuntime`   | 拡張機能の実応答・バージョンをSQLiteへ記録 | `{ installationId, extensionVersion, protocolVersion }` → `ExtensionRuntimeObservation` |
| `suggestSavePath`          | 保存先候補の提案                | `{ course, fileMeta }` → `SaveSuggestion[]`         |
| `saveFiles`                | 一括保存実行                  | `{ files[], targetPath }` → `{ savedFileIds }`      |
| `extractZip`               | ZIP展開要否の提案・実行           | `{ fileMeta, targetPath, destinationPath, flatten }` → `{ extractedPaths }` |
| `checkSimilarFiles`        | 保存前の類似ファイル検知            | `{ fileMeta }` → `SimilarFileMatch[]` |
| `search`                   | 全文検索（該当箇所ジャンプ用のページ情報含む） | `{ query }` → `SearchResult[]`                      |
| `getDashboard`             | コース別ダッシュボード集計           | `{}` → `DashboardSummary`                           |
| `getDeadlines`             | 締切一覧取得（フィルタ可）           | `{ filter? }` → `Assignment[]`                      |
| `updateSubmissionStatus`   | 提出状況の手動更新               | `{ assignmentId, submitted }` → `{ ok }`            |
| `getRules`                 | グローバル／コース別ルール取得         | `{}` → `RuleSet`                                    |
| `updateGlobalRule`         | グローバルルール更新              | `{ patternTemplate }` → `{ ok }`                    |
| `updateCourseRuleOverride` | コース別例外ルール更新             | `{ courseId, override: { splitBySection, patternTemplate, note } }` → `{ ok }` |
| `updateCourseFolderName`   | 保存用コースフォルダ名の編集・自動提案への復帰 | `{ courseId, folderName: string \| null }` → `{ ok: true, courseFolder: CourseFolderNameResolution }` |
| `getRuleViolations`        | ルール違反ファイル一覧             | `{}` → `RuleViolationListItem[]`                    |
| `getDuplicateGroups`       | 重複ファイル一覧                | `{}` → `DuplicateGroupListItem[]`                   |
| `getNotificationRules`     | 通知タイミング設定取得             | `{}` → `NotificationRule[]`                         |
| `updateNotificationRules`  | 通知タイミング設定更新             | `{ rules: NotificationRuleInput[] }` → `{ ok, rules: NotificationRule[] }` |
| `getLatestSyncEvent`       | 直近の同期結果取得（データ取得通知用）     | `{}` → `DataSyncEvent \| null`                      |
| `getAssignmentChanges`     | 同期で検出された課題の変更点一覧（変更点表示用） | `{ sinceSyncEventId? }` → `AssignmentChange[]`      |
| `exportData`               | バックアップ用エクスポート           | `{}` → `{ filePath }`                               |
| `importData`               | バックアップからの復元             | `{ filePath }` → `{ ok, reindexRequired }`          |

`suggestSavePath.course`は、生のMoodle文脈`{ moodleCourseId?, name, academicYear?, term?, sectionTitle, breadcrumbs }`とする。移行中は新規フィールドを省略可能とするが、拡張機能はMoodle安定コースID、年度、学期を取得できた場合に別フィールドで送り、コース名を加工しない。backendは`moodleCourseId`でSQLiteのコースを解決し、省略時は同名候補が一意な場合だけ既存コースへ結び付ける。曖昧な場合は`RULE_CONFLICT`を返し、同じフォルダへの混在を許可しない。`academicYear`は1900〜9999の整数または`null`とし、`term`から推測しない。

`SaveSuggestion`とコース保存名の型は次のとおりとする。

```ts
type CourseFolderNameWarningCode = "name_conflict" | "name_shortened";

interface CourseFolderNameWarning {
	code: CourseFolderNameWarningCode;
	message: string;
	suggestedFolderName: string;
}

interface CourseFolderNameResolution {
	courseId: number | null;
	folderName: string;
	warnings: CourseFolderNameWarning[];
}

interface SaveSuggestion {
	path: string;
	relativePath: string;
	confidence: number;
	similarMatches?: SimilarFileMatch[];
	courseFolder: CourseFolderNameResolution;
}
```

`path`はnative-hostが保存に使う、`app_settings.base_folder_path`を含む絶対パス、`relativePath`はUI表示・手動編集に使う保存ルート以下の相対パスである。`suggestSavePath`はSQLiteに保存されたグローバルルールとコース別例外を適用する。適用パターンに`{section}`があってセクション情報を取得できない場合は、そのコース直下までのパターンへ縮退し、エラーにしない。

コース保存名の生成・検証はbackendだけが担当する。生の名前をNFKCへ揃え、補足括弧・絵文字・Windows禁止文字を処理し、UTF-16で80コード単位を超える場合は単語境界、次に書記素境界で短縮して決定的サフィックスを付ける。簡略化後の衝突では、除去された補足の識別語、Moodle安定コースIDの順で一意な別名を生成し、`name_conflict`を返す。短縮時は`name_shortened`を返す。警告の`message`と`suggestedFolderName`はUIに表示し、ユーザーが編集できるようにする。

`updateCourseFolderName.folderName`はユーザーが選んだ単一フォルダ名、`null`は自動提案へ戻す操作を表す。backendはNFKC後にWindows名と80 UTF-16コード単位の上限を検証し、全コースをトランザクション内で再解決する。別コースが現在使用中の実効名と同じ編集名、および再解決後に異なるコースの実効名が大文字・小文字を区別しない比較で同一になる更新は`RULE_CONFLICT`としてロールバックする。編集によって別コースの現在の保存名を暗黙に変更しない。

クライアントは資料ごとに`suggestSavePath`を呼び、選択資料の保存先が複数になった場合は同じ`path`の資料をまとめ、保存先ごとに`saveFiles`を1回ずつ呼ぶ。手動指定は`relativePath`として検証し、絶対パス、UNCパス、`.`、`..`、Windowsの禁止文字・予約名を拒否する。

#### 1.2.1 ルール違反・重複一覧の型と安全境界

`getRuleViolations` は次の形式を返す。

```ts
interface RuleViolationListItem {
	fileId: number;
	fileName: string;
	courseId: number | null;
	courseName: string | null;
	relativePath: string;
	reason: string;
}
```

`courseId` と `courseName` は、授業に紐付く場合は両方を設定し、未紐付けの場合は両方を `null` にする。授業数の集計や同名授業の区別には `courseId` を使う。

`getDuplicateGroups` は次の形式を返す。

```ts
interface DuplicateFileListItem {
	fileId: number;
	fileName: string;
	relativePath: string;
	similarity: number;
}

interface DuplicateGroupListItem {
	groupId: number;
	method: "exact" | "similar";
	members: DuplicateFileListItem[];
}
```

`similarity` は0.0以上1.0以下とし、`method = "exact"` の全メンバーは1.0とする。同名ファイルを識別できるよう、各メンバーにファイル名を含む `relativePath` を必ず含める。

両一覧の `relativePath` は `files.saved_path` から `app_settings.base_folder_path` を除いてnative-hostが導出する。Windows向けの正規化済みバックスラッシュ区切りとし、絶対パス、UNCパス、`.`、`..` を含めない。保存ルート外の行を相対化できない場合は、その絶対パスをレスポンスやエラーメッセージへ含めず、固定の `INTERNAL` エラーにする。拡張機能は受信値を再検証し、不正な一覧をDOMへ表示しない。例外の生メッセージもDOMへ表示しない。

content scriptはNative Messagingへ直接接続せず、ルール取得・更新と同じbackgroundのメッセージ境界を通じて両コマンドを呼ぶ。これにより接続とSQLiteの正本をbackgroundへ集約する。

`NotificationRule.offsetMinutes` は締切日時から遡る相対時間（分）を表し、0以上525,600以下の整数（締切時刻から365日前まで）に限定する。`NotificationRuleInput` は `{ id?, offsetMinutes, enabled }` とし、新規ルールでは`id`を省略する。native-hostはSQLiteのトランザクション内で、ID付きの既存行を更新、IDなしの行を新規採番、入力から除かれた既存行を削除し、保存後の`NotificationRule[]`を返す。

`label`はクライアント入力として受け取らず、保存側が`offsetMinutes`から生成する。0は「締切時刻」、24時間の倍数は「n日前」、60分の倍数は「n時間前」、それ以外は時間と分または分単位で表示し、「当日9:00」のような固定時刻として解釈しない。同じ`offsetMinutes`の重複は拒否する。

Googleカレンダー／Google Tasks連携用コマンドは将来の専用Issueで定義する。Google認証、送信対象の確認、明示的な追加操作、認証解除を必須とし、既存のローカルAPIへ暗黙の外部送信を追加しない。Windowsデスクトップ通知の常駐方式とAPIも別Issueで定義する。

`reportExtensionRuntime`はブラウザ名を受け取らない。`installationId`は拡張機能が`browser.storage.local`へ保存する1〜128文字の英数字・ハイフン、`extensionVersion`はmanifestのバージョン、`protocolVersion`は1以上の整数とする。native-hostは境界で再検証し、拡張機能が送る日時は使用せず、受信時のUTC時刻を`firstSeenAt`／`lastSeenAt`として返す。Native Messagingホストマニフェストの許可元はFuzzy拡張機能のIDだけに限定し、別の拡張機能からこのコマンドを呼べないようにする。

`ExtensionRuntimeObservation`は次の形とする。

```ts
{
	installationId: string;
	extensionVersion: string;
	protocolVersion: number;
	firstSeenAt: string; // ISO 8601 UTC
	lastSeenAt: string;  // ISO 8601 UTC
}
```

### 1.3 起動・接続方針

`docs/仕様書.md` 3.3節のとおり、Moodleドメインのタブが存在する間 `connectNative` で接続を維持する。拡張機能側は `ping` にタイムアウト（目安800ms）を設定し、応答がなければサンプルデータへのモック動作にフォールバックする（`packages/shared/src/api/`）。単発のコマンド（ルール更新など）は `sendNativeMessage` でも構わない。

初期セットアップ確認のため、拡張機能のインストール・更新・ブラウザ起動時には`reportExtensionRuntime`を1回送信する。この報告に対してはモックへフォールバックせず、native-hostがSQLiteへ保存した成功応答だけを実応答として扱う。

ルール更新時のコース名はクライアントから受け取らず、`courseId` を使ってSQLiteの `courses` から解決する。保存パターンは相対パスのみを許可し、既知のトークン（`{year}` / `{term}` / `{course}` / `{assignment}` / `{section}`）以外、絶対パス、UNCパス、`.` / `..`、Windowsの禁止文字・予約名を拒否する。拡張機能側の検証は入力支援であり、native-host側でも同じ制約を再検証する。

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
| `get_extension_setup_status` | 確認開始後の拡張機能実応答をSQLiteから取得 | `{ since: string }` → `ExtensionSetupStatus` |

`pick_base_folder` 等の実体は `crates/engine-core` の `ScanEngine` を呼び出す（`apps/desktop/src-tauri` と `apps/native-host` の両方が同じ `crates/engine-core` に依存する設計。`docs/仕様書.md` 3.3節）。

`get_extension_setup_status`の`since`はTauriアプリが今回起動した日時（ISO 8601）とし、それより前の応答記録だけでは完了にしない。戻り値は次のいずれかとする。状態自体はSQLiteへ保存せず、応答記録と現在の通信仕様バージョンから算出する。

```ts
type ExtensionSetupStatus =
	| { state: "waiting"; observation: null }
	| { state: "ready"; observation: ExtensionRuntimeObservation }
	| { state: "incompatible"; observation: ExtensionRuntimeObservation };
```

- `waiting`：`since`以降の応答がない
- `ready`：`since`以降に現在の通信仕様バージョンと一致する応答がある
- `incompatible`：`since`以降に応答はあるが通信仕様バージョンが一致しない

---

## 3. エラーコード（暫定）

| code                 | 意味                                   |
|----------------------|--------------------------------------|
| `NOT_FOUND`          | 対象のファイル／コース／ルールが存在しない                |
| `INVALID_REQUEST`    | payloadの形式・値がAPI契約を満たさない                  |
| `DB_ERROR`           | SQLiteへの読み書きに失敗                            |
| `IO_ERROR`           | ファイル保存・読み込みに失敗                       |
| `RULE_CONFLICT`      | ルール定義が矛盾している                         |
| `MOODLE_UNREACHABLE` | Moodle側の情報取得に失敗（拡張機能側で発生、ホストには関係しない） |
| `INTERNAL`           | 想定外のエラー                              |

エラーの `message` は利用者向けの概要に限定し、保存ルート、DBファイル、対象ファイルの絶対パスや内部例外の生文字列を含めない。詳細はローカルログ側で扱う。

---

## 4. 未決事項

- `saveFiles` のレスポンスに保存後の `SaveSuggestion` 形式を含めるか
- `exportData` / `importData` のファイル形式（生SQLiteファイル vs 専用アーカイブ）
