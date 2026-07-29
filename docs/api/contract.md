# API契約（拡張機能 ⇄ Native Messagingホスト / Tauri）

最終更新: 2026-07-25

DBスキーマは [`データベース設計.md`](../データベース設計.md) を参照。wire型の正本は用途に応じて`crates/engine-core`または`apps/native-host/src/api_types.rs`のRust DTOとし、`ts-rs`で`packages/shared/src/generated/`へTS型を自動生成する（生成物は手編集しない）。`packages/shared/src/types.ts`は生成型の再exportを基本とし、未移行の暫定TS型だけを直接定義する。絶対パスを含む内部型をそのままwire形式にしない。

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

`id`は1〜128文字のASCII英数字・ピリオド・アンダースコア・コロン・ハイフン、`command`は1〜64文字のASCII英数字とする。envelopeおよび各payloadの未知フィールドは拒否する。不正な`id`はレスポンスへ反射せず、`id: null`の`INVALID_REQUEST`を返す。

### 1.2 コマンド一覧

現在のNative Messaging契約バージョンは`3`とする。Moodle課題同期を安定ID付きのコース完全スナップショットへ変更し、`ping`で契約バージョンを照合するため、契約バージョン`2`以前の拡張機能またはnative-hostは互換として扱わない。

| command                    | 用途                      | payload → data（概要）                                  |
|----------------------------|-------------------------|-----------------------------------------------------|
| `ping`                     | native-hostの実接続判定             | `{}` → `{ version, protocolVersion }`               |
| `reportExtensionRuntime`   | 拡張機能の実応答・バージョンをSQLiteへ記録 | `{ installationId, extensionVersion, protocolVersion }` → `ExtensionRuntimeObservation` |
| `suggestSavePath`          | 保存先候補の提案                | `{ course, fileMeta }` → `SaveSuggestion[]`         |
| `beginSaveFiles`           | 取得済み資料の分割転送開始           | `{ transferId, targetPath, files: [{ fileId, fileName, mimeType, byteLength }] }` → `{ ok: true }` |
| `appendSaveFileChunk`      | 取得済み資料のBase64チャンク追加      | `{ transferId, fileId, chunkIndex, dataBase64 }` → `{ ok: true }` |
| `saveFiles`                | 転送完了済み資料の一括保存実行         | `{ transferId }` → `SaveFilesResult`                |
| `beginCheckSimilarFile`    | 類似照合用資料の分割転送開始          | `{ transferId, byteLength }` → `{ ok: true }`       |
| `appendCheckSimilarFileChunk` | 類似照合用資料のBase64チャンク追加 | `{ transferId, chunkIndex, dataBase64 }` → `{ ok: true }` |
| `extractZip`               | ZIP展開要否の提案・実行           | `{ fileMeta, targetPath, destinationPath, flatten }` → `{ extractedPaths }` |
| `checkSimilarFiles`        | 転送済み内容による保存前の類似ファイル検知 | `{ transferId, fileMeta }` → `SimilarFileMatch[]` |
| `search`                   | 全文検索（該当箇所ジャンプ用のページ情報含む） | `{ query }` → `SearchResult[]`                      |
| `getDashboard`             | コース別ダッシュボード集計           | `{}` → `DashboardSummary`                           |
| `getDeadlines`             | 締切一覧取得（フィルタ可）           | `{ filter? }` → `Assignment[]`                      |
| `syncMoodleAssignments`    | Moodleコースの課題完全スナップショット同期 | `{ trigger, course, assignments }` → `DataSyncEvent` |
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
| `exportData`               | バックアップ用エクスポート           | `{ filePath }` → `{ filePath }`                     |
| `importData`               | バックアップからの復元             | `{ filePath }` → `{ ok, reindexRequired }`          |
| `rebuildLibrary`           | 保存ルートの再走査・SQLite注釈と全文索引の整合 | `{ rebuildIndex? }` → `LibraryMaintenanceSummary`   |

`ping.protocolVersion`は現在値`4`とし、クライアントは一致した場合だけnative-hostを利用する。不一致、タイムアウト、切断時は接続を破棄して再判定できる状態へ戻す。v4では課題同期と締切取得へ`detailUrl`と`submissionAvailability`を追加した。

`search.query`は前後の空白を除いた1〜256文字とする。検索結果は最大50件とし、SQLiteの`search_index_meta`に現在の索引完了記録があるファイルだけを返す。

`rebuildLibrary`は次の形式を使用する。

```ts
interface RebuildLibraryRequest {
	rebuildIndex?: boolean;
}

interface LibraryMaintenanceWarning {
	path: string;
	message: string;
}

interface LibraryMaintenanceSummary {
	scannedFileCount: number;
	registeredFileCount: number;
	updatedFileCount: number;
	indexedFileCount: number;
	missingFileCount: number;
	skippedFileCount: number;
	warnings: LibraryMaintenanceWarning[];
}
```

`rebuildIndex`の省略時は`false`とし、新規・本文変更・索引メタデータ欠落の資料だけを索引へ反映する。`true`では既存の全文索引と索引メタデータを空にしてから、走査時点で実在する対応資料を再構築する。いずれもSQLiteに設定済みの保存ルートを走査し、新規資料の登録、既存資料の注釈更新、ルール適合状況と重複候補の再計算を行うが、利用者のファイルを移動・削除しない。`warnings.path`は保存ルートからの相対パスだけとし、絶対パスを返さない。native-hostへ接続できない場合はモックで成功を偽装せず`NO_NATIVE_HOST`を返す。

`syncMoodleAssignments`は次の形式を使用する。

```ts
interface SyncMoodleAssignmentsRequest {
	trigger: "manual" | "auto";
	course: {
		moodleCourseId: string;
		name: string;
		academicYear: number | null;
		term: string | null;
	};
	assignments: Array<{
		moodleAssignmentId: string;
		title: string;
		dueAt: string | null;
		source: "moodle_dashboard" | "moodle_text";
		dueAtStatus: "normal" | "needs_review";
		submissionMode: "moodle_auto" | "manual" | "notify_only" | "unknown";
		submitted: boolean;
		detailUrl: string | null;
		submissionAvailability: "available" | "unavailable" | "unknown";
	}>;
}
```

`moodleCourseId`と`moodleAssignmentId`はMoodleのcourse／course-module由来の安定IDを必須とし、SQLite内部IDをクライアントから受け取らない。`dueAt`は`Z`または`±HH:MM`を明示した実在するISO 8601日時だけを許可する。`detailUrl`は拡張機能が同一オリジンで検証し、数字のcourse-module IDだけを残して正規化したHTTPSの`/mod/assign/view.php?id=...`または`null`とする。`available`／`unavailable`には非`null`の`detailUrl`を必須とし、取得失敗・未知DOM・根拠競合・未対応活動は`unknown`にする。締切状態、`submitted`、`submissionMode`から`submissionAvailability`を推測しない。

同期対象は当該コースの完全スナップショットに限り、単一セクション表示・部分DOM・安定IDを取得できない活動を含む画面からは送信しない。native-hostはコース内だけを1トランザクションで更新し、受信しなかった既存Moodle課題を`removed_at`付きの同期対象外として保持する。別コースと安定IDのない従来行は変更しない。

`getDeadlines`の`Assignment`は同期入力に対応する`detailUrl`と`submissionAvailability`を返す。`AssignmentChange.field`は`"dueAt" | "title" | "submissionMode" | "dueAtStatus" | "submitted" | "detailUrl" | "submissionAvailability" | "removedAt"`とする。完全スナップショットから課題が消えた場合は`removedAt`の`oldValue: null`、`newValue: syncedAt`を記録し、同じ安定IDが再び現れた場合は`oldValue: 以前のremovedAt`、`newValue: null`を記録する。削除は`removedAssignmentCount`だけ、復帰は`newAssignmentCount`だけへ計上し、`changedAssignmentCount`へ重複加算しない。したがって通知件数に用いる`newAssignmentCount + changedAssignmentCount + removedAssignmentCount`は、状態が変わった課題数と一致する。

課題詳細取得はログイン済みcontent scriptが行う。対象は同一オリジンの許可URL、1同期50件、同時4件、1件10秒、HTML 2MiBまでとし、同じ正規化URLは1回だけ取得する。`credentials: "include"`を使用するが、Cookie、認証情報、取得HTMLをnative-hostや外部サービスへ送らない。1件の失敗は`unknown`として残りを継続する。

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

`updateCourseFolderName.folderName`はユーザーが選んだ単一フォルダ名、`null`は自動提案へ戻す操作を表す。backendはNFKC後にWindows名と80 UTF-16コード単位の上限を検証し、全コースをトランザクション内で再解決する。別コースが現在使用中の実効名と同じ編集名、および再解決後に異なるコースの実効名が大文字・小文字を区別しない比較で同一になる更新は`RULE_CONFLICT`としてロールバックする。更新後の実効名を使った全保存済みファイルのルール適合注釈再計算も同じトランザクションで行い、再計算に失敗した場合はフォルダ名変更を残さない。編集によって別コースの現在の保存名を暗黙に変更しない。

クライアントは資料ごとに`suggestSavePath`を呼び、選択資料の保存先が複数になった場合は同じ`path`の資料をまとめ、保存先ごとに`saveFiles`を1回ずつ呼ぶ。手動指定は`relativePath`として検証し、絶対パス、UNCパス、`.`、`..`、Windowsの禁止文字・予約名を拒否する。

#### 1.2.1 Moodle資料の確定・分割転送・実保存

拡張機能のcontent scriptからbackgroundへ渡す保存要求は`MoodleSaveFilesRequest = { files: MoodleFileMeta[], targetPath, courseId }`とする。`courseId`は`suggestSavePath`がSQLiteへ解決したIDまたは`null`であり、クライアントがコース名から採番しない。backgroundはメッセージ送信元ページと各資料URLが同一オリジンであることを検証し、`credentials: "include"`のGETで本体を取得する。リダイレクト後のURLも同一オリジンでなければ拒否する。Cookie・Authorizationヘッダー等の認証情報はpayloadへ含めず、取得済み内容だけをNative Messagingへ渡す。

`mod/resource/view.php`の種別確定はHEADを先に使用し、HEAD非対応・HTTPエラー・情報不足時はGETへフォールバックする。`Content-Disposition`の`filename*`を`filename`より優先し、宣言charset付きpercent encoding、旧式のRFC 2047 encoded-word、Latin-1として受け取った生UTF-8の順で日本語名を復元する。復元後も制御文字、パス成分、UTF-16長を検証し、対応済み拡張子を持つ実ファイル名を使用する。実ファイル名がない場合は表示名へ確定した拡張子を補う。`text/html`、HTML先頭シグネチャ、ログイン／エラーページ、種別未確定の間接リンクは保存しない。DOCX本体は文字列へ変換せずバイナリのまま転送し、native-hostでZIPアーカイブとして開けることと、`[Content_Types].xml`、`word/document.xml`が空でなく上限内で最後まで読み取れることを確認する。

Native Messagingの転送は同じ接続上で`beginSaveFiles`、0個以上の`appendSaveFileChunk`、`saveFiles`の順に行う。`chunkIndex`はファイルごとに0から連続させる。拡張機能はBase64文字列を192KiB以下に分割し、native-hostは復号後256KiB以下だけを受理する。1要求は20ファイル、1ファイル64MiB、合計128MiBまでとする。backgroundはレスポンスをストリームで読み、Content-Lengthの有無にかかわらず上限到達時に中断する。切断・タイムアウト・一時的なHTTP失敗を固定キャッシュせず、利用者の再実行で新しい`transferId`を使って再試行できるようにする。

類似照合用の内容も同じ接続上で`beginCheckSimilarFile`、0個以上の`appendCheckSimilarFileChunk`、`checkSimilarFiles`の順に送る。単一のNative Messagingメッセージへファイル全体のBase64を含めない。チャンク上限と1ファイル64MiB上限は保存転送と同じとし、`checkSimilarFiles`は宣言サイズ分の転送が完了した`transferId`だけを受理して、照合開始時に転送内容をセッションから取り出す。backgroundは全タブを合わせて同時に照合する資料を2件までに制限し、各保存パネルも実行中workerの収束を待ってから完了または失敗を返す。

```ts
interface SaveFilesResult {
	savedFileIds: string[];
	failedFiles: Array<{
		fileId: string;
		code: "DOWNLOAD_FAILED" | "INVALID_CONTENT" | "ALREADY_EXISTS" | "IO_ERROR";
	}>;
}
```

native-hostは`targetPath`がSQLiteの`app_settings.base_folder_path`以下であることを、既存の最深祖先を実体解決した後にも検証する。単一ファイル名だけを許可し、Windows禁止文字・予約名・末尾の空白／ピリオドを拒否する。既存ファイルは上書きしない。書き込み成功後はBLAKE3・SimHashとMoodleファイルIDを`files`へ登録し、DB登録に失敗したファイルは削除して成功扱いにしない。複数ファイルの一部が失敗した場合も、ファイル作成とDB登録の両方に成功した`fileId`だけを`savedFileIds`へ入れ、失敗分を`failedFiles`へ入れる。

`checkSimilarFiles`はbackgroundが同じ認証付き取得・サイズ制限を適用し、取得済み内容だけを専用のチャンク転送でnative-hostへ渡して、SQLiteに保存されたBLAKE3・SimHashと照合する。未開始、順序不正、宣言サイズ未満・超過、上限超過の転送は照合しない。`extractZip`は`files.moodle_file_id`から保存済みZIPを解決し、保存ルート直下の走査対象外ステージングへ全項目を検証・展開してから、既存パスを上書きしない方法で確定する。通常ファイルを含まないZIP、パストラバーサル、ZIP内またはZIP元／展開先の親にあるシンボリックリンク／junction、flatten後を含む重複・親子競合、1000項目超、展開後256MiB超を拒否する。Windowsでは保存ルートから各親フォルダーとZIP元をreparse pointを開く指定で検査し、削除共有を許可しないハンドルをSQLite登録完了まで保持する。展開物は展開元のコース文脈を継承して1つのSQLite transactionで登録し、その成功後にだけ補償ロールバックを解除する。対応文書形式は同じコマンド内で全文索引へ追加し、ルール適合状況と重複グループも再計算する。索引または派生情報の更新に失敗しても保存済みファイルとSQLite正本は維持し、索引メタ情報がないファイルは次回の再走査で回復できる。途中失敗時は今回作成したファイルを保持中のハンドルから削除し、既存資料には触れない。最大サイズの処理が通常APIの5秒timeoutを巻き込まないよう、クライアントは独立接続で最大10分待機する。

#### 1.2.2 ルール違反・重複一覧の型と安全境界

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

`docs/仕様書.md` 3.4節のとおり、認証済みMoodleタブが存在する間だけbackgroundから`connectNative`で接続を維持し、最後の対象タブが閉じた時点で切断する。content scriptはNative Messagingへ直接接続せず、全画面のAPIをbackgroundへ中継する。拡張機能側は`ping`にタイムアウト（既定5秒）を設定し、応答がなければ`NO_NATIVE_HOST`を返して一定時間後または次の操作時に疎通を再判定する。本番でサンプルデータへ暗黙に切り替えない。ダッシュボードだけは、native-hostから過去に取得してIndexedDBへ保存した実データのキャッシュがある場合に限り、最終更新日時を明示して表示できる。

ダッシュボードの実データはbackgroundが拡張機能originのIndexedDBへ表示用キャッシュとして保存する。content scriptからWeb Storage／IndexedDBを直接使用するとMoodleページoriginへ保存されるため、キャッシュの読み書きはbackground経由に限定する。popupは同じ拡張機能originのキャッシュを読み取り、native-hostやMoodleへ接続できない場合も前回情報だけを表示できる。

初期セットアップ確認のため、拡張機能のインストール・更新・ブラウザ起動時には`reportExtensionRuntime`を1回送信する。セットアップ後の再確認では、MoodleのContent Script起動時にもbackgroundへ再報告を要求し、既にService Workerが動作中でも新しい応答を即時に保存する。この報告に対してはモックへフォールバックせず、native-hostがSQLiteへ保存した成功応答だけを実応答として扱う。

ルール更新時のコース名はクライアントから受け取らず、`courseId` を使ってSQLiteの `courses` から解決する。保存パターンは相対パスのみを許可し、既知のトークン（`{year}` / `{term}` / `{course}` / `{assignment}` / `{section}`）以外、絶対パス、UNCパス、`.` / `..`、Windowsの禁止文字・予約名を拒否する。拡張機能側の検証は入力支援であり、native-host側でも同じ制約を再検証する。

### 1.4 データ取得通知・変更点表示のフロー

Moodleから課題・締切データを取得（同期）した直後、拡張機能は次の手順で「データ取得通知」と「変更点の表示」を行う（`docs/仕様書.md` 1.3節）。

1. native-host側は同期完了ごとに `sync_events` に1行追加し、変更を検出した課題ごとに `assignment_changes` へ差分を記録する。同期対象外化・復帰も`removedAt`の差分として含める（`データベース設計.md` 参照）
2. 拡張機能は同期完了を検知したら `getLatestSyncEvent` を呼び、`new/changed/removed_assignment_count` の合計を使ってブラウザ通知を出す（例:「Moodleからデータを取得しました（変更2件）」）。削除・復帰を`changed`へ重複計上せず、変更が0件でも取得したこと自体は通知する
3. 通知または締切ハブから「変更点を見る」操作をした際は `getAssignmentChanges({ sinceSyncEventId })` で対象同期以降の差分一覧を取得し、`field` ごとに変更前後の値（`oldValue` → `newValue`）を表示する
4. `sinceSyncEventId` を省略した場合は直近の同期1回分、指定した場合はその同期IDより後に検出された差分を返す。同期履歴がない場合、`getLatestSyncEvent` は `null`、変更点一覧は空配列を返す
5. Moodle取得パイプラインは取得した全課題スナップショットを共有エンジンの同期処理へ渡す。同期処理は、課題更新・フィールド差分・削除扱い・集計を同一トランザクションで確定する

---

## 2. Tauriコマンド（初期セットアップアプリ ⇄ Rust）

| コマンド                      | 用途                              | 引数 → 戻り値                                         |
|---------------------------|---------------------------------|--------------------------------------------------|
| `pick_base_folder`        | OSネイティブダイアログで保存先フォルダを選択し実パスを取得  | `()` → `string \| null`                          |
| `scan_existing_structure` | 選択フォルダの既存構成を再帰スキャンし、近いパターン候補を提示 | `{ path }` → `PatternCandidate[]`                |
| `save_initial_setup`      | 選んだパターン／ルールを保存し、既存資料を取り込む        | `{ path, pattern, rule, courseOverrides }` → `{ ok, maintenance: LibraryMaintenanceSummary }` |
| `get_setup_status`        | 初期セットアップ済みかどうか確認                | `()` → `{ done: boolean, savedAt?: string }`     |
| `get_extension_setup_status` | 確認開始後の拡張機能実応答をSQLiteから取得 | `{ since: string }` → `ExtensionSetupStatus` |
| `get_extension_recovery_status` | セットアップ後の最新応答・互換性・鮮度をSQLiteから取得 | `()` → `ExtensionRecoveryStatus` |
| `get_application_recovery_status` | 起動時のSQLite正本・検索索引の利用可否を取得 | `()` → `{ database, searchIndex }` |
| `get_native_host_installation_status` | Native Messagingホストの自動登録結果を取得 | `()` → `{ ready, message }` |
| `repair_native_host_installation` | 同梱ホストのmanifestとユーザー単位登録を再作成 | `()` → `{ ready, message }` |
| `rebuild_library` | 明示操作で保存ルートを再走査し、SQLite注釈と全文索引を整合 | `{ rebuildIndex: boolean }` → `LibraryMaintenanceSummary` |
| `change_library_root` | OSフォルダーダイアログで保存ルートだけを変更し、再走査・再索引 | `()` → `{ cancelled, changed, rebasedFileCount, maintenance?, maintenanceError? }` |
| `export_backup` | OS保存ダイアログでSQLiteバックアップを書き出す | `()` → `{ cancelled, filePath? }` |
| `import_backup` | OS選択・確認ダイアログを経てSQLiteバックアップを復元し、索引を再構築 | `()` → `{ cancelled, imported, recoveryCopyPath?, maintenance?, maintenanceError? }` |
| `create_fresh_database` | 確認後に開けないDBを別名で保全し、新規SQLite正本を作成 | `()` → `{ cancelled, created, recoveryCopyPath?, indexError? }` |

`pick_base_folder` 等の実体は `crates/engine-core` の `ScanEngine` を呼び出す（`apps/desktop/src-tauri` と `apps/native-host` の両方が同じ `crates/engine-core` に依存する設計。`docs/仕様書.md` 3.3節）。

`save_initial_setup`は、選択フォルダーの実体確認と正規化、ルールテンプレート検証を行った後、`app_settings.base_folder_path`、推定候補ID、推定パターン内の科目セグメント位置、初期コース別候補、`global_rule`、保存日時を1つのSQLiteトランザクションで保存する。続けて保存ルートを走査し、既存資料をSQLiteへ登録して本文検索索引、ルール適合注釈、重複候補を作成する。既存ファイルの移動・削除は行わず、取り込み件数と警告は`maintenance`で画面へ返す。設定確定後の走査または初期コース別例外の同期だけが失敗した場合、保存済み設定を失敗扱いにせず`maintenance.warnings`へ追加し、利用者が前の画面へ戻って同じ設定を再保存できるようにする。`get_setup_status`は保存日時だけでなく保存ルートとグローバルルールが揃っている場合に限って`done: true`を返し、localStorageやIndexedDBを完了判定に使わない。

`rebuild_library`は利用者が復旧画面のボタンを押した場合だけ実行し、Native Messagingの`rebuildLibrary`と同じ`LibraryMaintenanceSummary`を返す。保存ルート上で見つからないSQLite行は`files.missing_at`を付けて履歴として保持し、通常のダッシュボード、ルール違反、重複候補、全文検索から除外する。再び同じパスに現れた場合は欠損状態を解除して再索引する。`missingFileCount`は今回の走査後も見つからない登録済み資料の件数であり、利用者の資料ファイルを移動・削除しない。全文索引を明示的に作り直す復旧操作では`rebuildIndex: true`を渡す。走査中はブラウザ側の保存処理と競合しないよう、画面で資料保存の完了とブラウザ終了を案内する。

`change_library_root`は別PCで作成したバックアップなど、保存済みの絶対パスが現在のPCで無効な場合にも使用できる。OSネイティブのフォルダーダイアログと確認画面を使い、既存ルールは変更しない。旧ルート配下のファイル行は同じ相対パスで新ルートへ付け替え、実体未確認・未索引としてから再走査と全文索引再構築を行うが、資料ファイル自体は移動・削除しない。変更後の再構築だけに失敗した場合は`changed: true`と`maintenanceError`を返す。

`export_backup`はOSネイティブの保存ダイアログを使用し、既存ファイル、使用中DBと同じパスへの上書きを拒否する。`import_backup`はOSネイティブの選択ダイアログに続いて、SQLite正本を置き換える旨の確認ダイアログを必ず表示する。バックアップを検証して復元できた後は保存ルートを再走査して全文索引を再構築する。復元自体が成功し再構築だけに失敗した場合は`imported: true`と利用者向け`maintenanceError`を返し、復元失敗と誤表示しない。起動時にSQLiteを開けない場合も同じコマンドを使用でき、開けなかったDBと`-wal`／`-shm`／`-journal`を別名の復旧用フォルダーへ保全してから、検証済みバックアップを同じAppStateへ接続する。この場合だけ保全先を`recoveryCopyPath`で返す。

起動時はSQLiteまたはTantivy索引を開けなくてもpanicせずTauri UIを開始する。`get_application_recovery_status`の各`state`は`ready`、`recoveryRequired`、検索索引のみ`needsRebuild`を使用する。SQLiteが`recoveryRequired`の場合、通常コマンドは正本未接続として拒否し、`import_backup`と`create_fresh_database`だけを復旧手段として提示する。`create_fresh_database`は確認ダイアログ後に開けないDB一式を別名で保全できた場合だけ新規DBを作り、保全失敗時は新規作成しない。検索索引は派生データなので、明示した`rebuild_library`操作で開けない索引を別名へ退避し、SQLite正本と保存先から再生成する。いずれも利用者の資料ファイルを移動・削除せず、パス入力やコマンド操作を要求しない。

Native Messagingホストの配置、manifest生成、Chrome／Chromium／EdgeのHKCU登録はインストーラーとFuzzy起動時に自動実行する。利用者へ登録コマンドを要求しない。アンインストーラーは同じ登録とmanifestを解除するが、SQLite正本や利用者が保存した資料は削除しない。

`get_extension_setup_status`の`since`はTauriアプリが今回起動した日時（ISO 8601）とし、それより前の応答記録だけでは完了にしない。戻り値は次のいずれかとする。状態自体はSQLiteへ保存せず、応答記録、最低対応拡張機能バージョン（`0.1.0`）、現在の通信仕様バージョンから算出する。

```ts
interface ExtensionSetupStatus {
	state: "waiting" | "ready" | "incompatible";
	observation: ExtensionRuntimeObservation | null;
}
```

- `waiting`：`since`以降の応答がなく、`observation`は`null`
- `ready`：`since`以降に最低対応拡張機能バージョン以上かつ現在の通信仕様バージョンと一致する応答があり、`observation`は非`null`
- `incompatible`：`since`以降に応答はあるが、拡張機能バージョンまたは通信仕様バージョンに互換性がなく、`observation`は非`null`

`get_extension_recovery_status`はSQLiteの応答履歴を読み取り、状態を保存せずに次の形で返す。最近の応答とみなす期間は24時間、最低対応拡張機能バージョンは`0.1.0`とする。各`installationId`では最新の応答だけを現在状態の候補とし、その中に最近の互換応答が1件でもあれば`ready`とする。これにより、同じインストールの古い互換版を更新後の非互換版より優先せず、別のインストールから届いた最近の互換応答は正常状態の根拠にできる。互換候補がない場合は、候補全体の最新応答から`stale`または`incompatible`を算出する。

```ts
interface ExtensionRecoveryStatus {
	state: "missing" | "ready" | "stale" | "incompatible";
	observation: ExtensionRuntimeObservation | null;
	recentWithinSeconds: number;
}
```

- `missing`：応答履歴がない。拡張機能の実応答を確認済みとは扱わず、初回導入の応答待機と導入案内を表示する
- `ready`：24時間以内に、拡張機能・通信仕様の両方に互換性がある応答がある
- `stale`：最新応答に互換性はあるが24時間より古い。削除とは断定せず、Moodleを開いて再確認する
- `incompatible`：拡張機能バージョンまたは通信仕様バージョンに互換性がない

復旧画面は`stale`からユーザーが再確認を開始した間だけ表示上の`checking`へ遷移し、15秒以内に新しい互換応答がなければ`timed-out`として再導入案内を表示する。`checking`と`timed-out`はUIの一時状態であり、SQLiteやブラウザストレージには保存しない。

初期セットアップ保存済みの場合は、`get_extension_recovery_status`が`missing`でも保存先変更、再スキャン、バックアップ書き出し・復元の保守導線を隠さない。別PCへ復元した直後など、拡張機能の応答履歴がない状態でもGUI保守を実行できるようにする。

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
