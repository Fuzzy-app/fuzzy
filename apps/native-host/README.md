# native-host

ブラウザ拡張機能からNative Messaging経由で起動される、GUIを持たないRustバイナリ。

標準入出力の4byteリトルエンディアン長プレフィックス付きJSONを処理し、共有DB層を通じてSQLiteへアクセスする。初期セットアップでは`reportExtensionRuntime`を受信し、拡張機能のインストール識別子・バージョン・通信仕様バージョン・受信日時を保存する。

DBパス解決、スキーマ適用、マイグレーションはTauriと共通の`crates/engine-core`を使用する。コマンド契約は`docs/api/contract.md`、開発時のホスト登録手順は`docs/セットアップ.md`を参照する。
