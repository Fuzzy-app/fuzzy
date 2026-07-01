# ロードマップ: matoba

最終更新: 2026-07-01
担当範囲（README.md準拠）: `apps/extension` の資料保存UI（保存先サジェスト・一括DL・ZIP提案）

GitHub: [Fuzzy-app/fuzzy](https://github.com/Fuzzy-app/fuzzy) issue一覧は番号順が着手順の目安。

---

## Phase0（Day1・最優先・ブロッキング）

- [ ] [#34 apps/extension の雛形生成（WXT + Svelte）](https://github.com/Fuzzy-app/fuzzy/issues/34)
  `bun create wxt@latest apps/extension`。okaji・hiraseもこの拡張機能プロジェクトの上に画面を作るので最優先で終わらせる。`createApiClient() → getDashboard()`が表示できる疎通確認ページまで作る。

## Phase2（Day3〜8・資料保存UI本体）

- [ ] [#48 Moodleページのデータ取得（ファイルリンク・本文・ダッシュボード）](https://github.com/Fuzzy-app/fuzzy/issues/48)
  コース名・回・ファイルリンク・本文・ダッシュボードウィジェットの取得。深い階層の資料も対象。バックエンド未完成でもローカルで開発可能。
- [ ] [#49 保存先サジェストUI・一括保存機能](https://github.com/Fuzzy-app/fuzzy/issues/49)
  `suggestSavePath`の候補提示・手動指定・複数ファイル一括保存。`MockApiClient`のサンプルデータで進めてよい。
- [ ] [#50 ZIPファイルの解凍提案UI](https://github.com/Fuzzy-app/fuzzy/issues/50)
- [ ] [#51 類似ファイル検索・保存前の重複通知UI](https://github.com/Fuzzy-app/fuzzy/issues/51)
  #49完了後に着手。

## Phase3（最終週・全員）

- [ ] [#59 拡張機能⇄native-host 結合テスト・最終動作確認](https://github.com/Fuzzy-app/fuzzy/issues/59)
  自分の資料保存UI一式をnative-hostの実データに切り替えて動作確認する。

---

## 進め方のポイント

- #34（拡張機能雛形）はokaji・hiraseの画面作業の前提になるので、他の作業より優先してDay1中に終わらせる。
- #48〜#51は`packages/shared/src/sample-data/`（例: なし、`suggestSavePath`はコード内モック）を使えばバックエンド未完成でも進められる。subaruの#42（コマンド一式）が終わったらnativeモードに切り替えて再確認する。
- 仕様書1.1節（資料を保存する）が正。迷ったら`docs/仕様書.md`を確認する。
