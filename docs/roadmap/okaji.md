# ロードマップ: okaji

最終更新: 2026-07-01
担当範囲（README.md準拠）: `apps/desktop`（初期セットアップ画面）、`apps/extension` のルール管理・整合性チェック画面

GitHub: [Fuzzy-app/fuzzy](https://github.com/Fuzzy-app/fuzzy) issue一覧は番号順が着手順の目安。

---

## Phase0（Day1・最優先・ブロッキング）

- [ ] [#35 apps/desktop の雛形生成（Tauri + Svelte）](https://github.com/Fuzzy-app/fuzzy/issues/35)
  `bun create tauri-app@latest apps/desktop`。初期セットアップ画面（#46・#47）はこの上に作る。

## Phase2（Day3〜8・初期セットアップ画面）

- [ ] [#46 初期セットアップ：フォルダ選択・既存構成スキャンUI](https://github.com/Fuzzy-app/fuzzy/issues/46)
  OSダイアログでのフォルダ選択・既存構成の再帰スキャン結果表示。バックエンド（ScanEngine）未完成でもモック値で進めてよい。
- [ ] [#47 初期セットアップ：保存パターン推定結果の提示・初期ルール選択UI](https://github.com/Fuzzy-app/fuzzy/issues/47)
  #46完了後に着手。`save_initial_setup`・`get_setup_status`のセットアップ完了判定まで含む。

## Phase2（Day3〜8・ルール管理/整合性チェック画面、apps/extension側）

- [ ] [#52 ルール管理画面（グローバル／コース別ルールの編集）](https://github.com/Fuzzy-app/fuzzy/issues/52)
  matoba（#34）が拡張機能雛形を作った後に着手。モックで進行可。
- [ ] [#53 ルール違反・未整理ファイルの警告一覧画面](https://github.com/Fuzzy-app/fuzzy/issues/53)

## Phase3（最終週・全員）

- [ ] [#59 拡張機能⇄native-host 結合テスト・最終動作確認](https://github.com/Fuzzy-app/fuzzy/issues/59)
  初期セットアップ・ルール管理画面をnative-hostの実データに切り替えて動作確認する。

---

## 進め方のポイント

- 自分は`apps/desktop`と`apps/extension`の2つのアプリにまたがって作業する。#35（desktop雛形）を最優先で終わらせたら、#46・#47（初期セットアップ）を先に進め、その後#52・#53（拡張機能側のルール管理）に移るのがおすすめ。
- #52・#53はmatoba担当の#34（extension雛形）ができてから着手する。
- 仕様書1.2節（整理方法の決定）が正。初期セットアップとルール管理・整合性チェックの役割分担（初回のみ vs 常設）を混同しないよう注意。
