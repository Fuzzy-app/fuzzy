# Issue #39 作業レポート

作成日: 2026-07-22

## タスク

`crates/engine-core` の `RuleEngine` に、グローバルルールとコース別例外ルールの照合、違反理由の生成、SQLite上の適合注釈更新を実装する。

完了条件は次の3点。

- グローバルルール・コース別例外ルールを読み込み、保存済みファイルと照合する
- 違反時に `files.violation_reason` へ保存できる理由文字列を生成する
- seed の `正規化_メモ.docx` 等を使い、違反検出を自動テストする

参照した正本は `docs/仕様書.md` 1.2節・3.3節・4.1節、`docs/データベース設計.md`、`docs/api/contract.md`、`crates/engine-core/fixtures/schema.sql`、`seed.sql` である。

## 解決方法

### ルール照合

- 走査用 `FileEntry` にDB固有の情報を追加せず、ルール照合専用の `RuleFileEntry` と `RuleContext` を追加した
- `{year}` / `{term}` / `{course}` / `{assignment}` / `{section}` を展開し、Windows向けのパス区切りへ正規化する
- 保存先提案はAPI契約どおり保存フォルダの相対パスを返し、ファイル名自体は含めない
- `{assignment}` が未指定の場合は、既存のモック実装と同じくファイル名から拡張子を除いた値を使用する
- 既存ファイルの照合では保存フォルダとファイル名を別々に確認し、Windowsの大文字・小文字差は違反にしない
- セクション情報等が欠けていても、既知の階層だけで明らかな不一致を検出する。構造が一致しても必要情報が欠ける場合は「確認不能」を警告として返す
- コース別例外がある場合はコースIDで選択し、`split_by_section` と実効テンプレートの `{section}` の有無が矛盾していないか検証する

### 入力検証と安全境界

- API契約と同じ既知トークン、相対パス、`.` / `..`、Windows禁止文字・予約名の制約をRust側でも検証する
- Moodle由来のコース名は共有クライアントと同じく括弧内補足・絵文字を除去し、簡略化後に衝突する場合はMoodle安定IDを付ける
- 絶対パス・UNCパスをルールテンプレートとして受け付けない
- 保存ルート外のファイルを違反扱いにするが、利用者向け理由文字列へ絶対パスを含めない
- `RuleViolation` はengine-core内部型のまま絶対パスを保持し、Native Messaging用DTOへ直接シリアライズしない既存境界を維持する
- ルール定義の矛盾は、API契約にある `RULE_CONFLICT` へ変換できる `EngineError::RuleConflict` として返す

### SQLite注釈

- `Database` に保存ルート・ルール一式・照合対象ファイルの読み込みを追加した
- 全件再判定は `IMMEDIATE` トランザクション内で読み込みから `rule_compliant` / `violation_reason` の更新まで行う
- 判定または書き込みに失敗した場合はロールバックし、既存注釈を消さない
- ファイル自体の移動・削除・改名は一切行わない
- SQLite固有の処理は `database/rules.rs`、テンプレートとWindowsパスの処理は `rule/template.rs` に分け、照合の調停だけを `rule.rs` に残した

## 型・API・DB・仕様の整合性

- 外部API DTO、`packages/shared/src/types.ts`、DBスキーマの変更は不要だった
- 保存先提案を「ファイルのフルパス」ではなく `saveFiles.targetPath` に渡す「フォルダ」として扱い、既存の `SaveSuggestion` 契約・モック実装と揃えた
- `RuleSet` のグローバルテンプレートとコース別例外、`files.rule_compliant` / `violation_reason`、コースID基準の上書きという既存設計を維持した
- `PatternEstimator` が返す `{filename}` を含む候補は、現行APIで永続化できるルールテンプレートとは別の「推定結果」である。`docs/reports/issue38.md` にあるとおり、ファイル名規則を別ルールとして保持するかは未決事項のため、RuleEngineはAPI契約の既知5トークンだけを受け付ける

## 検証

- seed のグローバルルール違反（file id 4 `正規化_メモ.docx`、file id 9 `第4回_正規化(1).pdf`）を検出する
- コース別例外「アプリ演習」（file id 6）は、セクション無しでも適合と判定する
- グローバルルールとコース別例外から保存先フォルダを展開する
- 不明トークン、絶対パス、UNCパス、親階層移動、Windows予約名、`split_by_section` の矛盾を拒否する
- WindowsパスをホストOSの区切り文字に依存せず照合する
- 不正ルールで再判定が失敗した場合に既存注釈が保持される
- SQLiteのboolean相当値が0/1以外の場合に黙って解釈せずDBエラーにする

## 残る境界

- コース名の正規化は `packages/shared/src/folderNames.ts` と `crates/engine-core/src/folder_names.rs` の双方に同じ受け入れテストを置いている。将来ロジックを変更する場合は両実装とテストを同時に更新する
- `PatternEstimator` の `{filename}` を含む候補から永続化可能なルールへ変換する仕様は、初期ルール選択UIの後続issueで決定する
