# Issue #107 実装報告

## 検出とメタデータ確定

- `/f/document`、空バッジ、拡張子なし表示名の`mod/resource/view.php`を未判定候補として保持
- 同一オリジンへ認証付きHEADを送り、情報不足・HEAD非対応時はGETへフォールバック
- `Content-Type`、`Content-Disposition filename*`／`filename`、最終URLから種別と名前を確定
- HTML、ログイン画面相当、外部オリジン、未判定候補を資料一覧から除外
- 一時失敗をキャッシュせず再試行可能にした

## 本体取得とNative Messaging

- backgroundが送信元Moodleと同一オリジンの資料だけを`credentials: include`で取得
- Cookie等の認証情報を渡さず、取得済み内容だけをBase64化
- 1接続内で`beginSaveFiles`→`appendSaveFileChunk`→`saveFiles`を送信
- 20ファイル、1ファイル64MiB、合計128MiBの上限を設定
- 一時的なHTTPエラーは1回再試行

## native-hostの実保存

- SQLiteの保存ルート以下かを字句上・実体解決後の両方で検証
- Windowsファイル名、宣言サイズ、HTML先頭、DOCXのZIPシグネチャを再検証
- 既存ファイルを上書きせず、成功したファイルだけを`savedFileIds`へ返す
- 失敗分は`DOWNLOAD_FAILED`、`INVALID_CONTENT`、`ALREADY_EXISTS`、`IO_ERROR`で個別に返す

DBスキーマ変更はない。保存後メタデータの`files`テーブル登録は、コースID・ハッシュ・索引更新を含む別API設計が必要なため本Issueでは行わない。
