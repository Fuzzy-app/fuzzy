# desktop

Fuzzyの初期セットアップを行うTauri 2 + SvelteKitアプリ。

保存先・保存パターン・初期ルールを設定した後、Fuzzyブラウザ拡張機能の導入を必須で案内する。ブラウザ名による分岐や自己申告チェックは行わず、拡張機能からnative-hostへ届いてSQLiteに保存された実応答を確認すると完了する。

開発時の起動方法とNative Messagingホストの前提は`docs/セットアップ.md`を参照する。
