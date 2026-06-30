# native-host

Native Messaging ホスト（常駐エンジン）。GUIを持たない Rust バイナリで、ブラウザ拡張機能（`apps/extension`）から Native Messaging 経由で起動・通信される。

役割：保存・フォルダ生成・再帰走査・全文検索・重複検出・ルール照合・集計・SQLite管理。

中核ロジックは `crates/engine-core` を参照し、ここには Native Messaging のプロトコル処理（標準入出力でのJSON送受信、起動・終了制御）のみを実装する。

未生成：`cargo new --bin apps/native-host` で生成し、`crates/engine-core` に依存させる。詳細は `docs/セットアップ.md` を参照。
