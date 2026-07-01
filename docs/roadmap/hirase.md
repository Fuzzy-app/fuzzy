# ロードマップ: hirase

最終更新: 2026-07-01
担当範囲（README.md準拠）: `apps/extension` の活用UI（検索・締切ハブ・ダッシュボード・カレンダー連携・通知）

GitHub: [Fuzzy-app/fuzzy](https://github.com/Fuzzy-app/fuzzy) issue一覧は番号順が着手順の目安。

---

## Phase2（Day3〜8・活用UI一式）

matoba（#34）が拡張機能雛形を作ったら着手できる。以下は着手推奨順。

- [ ] [#55 締切ハブ画面（一覧・提出状況・期限異常/期限切れ）](https://github.com/Fuzzy-app/fuzzy/issues/55)
  最優先。締切一覧・提出状況の手動更新・要確認強調表示・期限切れ絞り込み。データ取得通知UI（#56）の土台になるので他の画面より少し早めに着手する。
- [ ] [#56 締切ハブ：データ取得通知・変更点表示UI](https://github.com/Fuzzy-app/fuzzy/issues/56)
  #55完了後。今回追加した新機能。同期完了検知でブラウザ通知、`getAssignmentChanges`で変更前後の値を一覧表示。サンプルデータ（sync-events.json, assignment-changes.json）で確認できる。
- [ ] [#54 ワード検索画面（該当箇所へのジャンプ）](https://github.com/Fuzzy-app/fuzzy/issues/54)
- [ ] [#57 ダッシュボード画面（コース別集計・オフラインキャッシュ）](https://github.com/Fuzzy-app/fuzzy/issues/57)
  IndexedDBキャッシュの実装を含む。
- [ ] [#58 カレンダー連携（ICS/Googleカレンダー）と締切通知設定画面](https://github.com/Fuzzy-app/fuzzy/issues/58)
  Googleカレンダー連携が重ければICSエクスポートのみに縮小してよい（自分の判断でOK）。

## Phase3（最終週・全員）

- [ ] [#59 拡張機能⇄native-host 結合テスト・最終動作確認](https://github.com/Fuzzy-app/fuzzy/issues/59)
  自分の担当画面一式をnative-hostの実データに切り替えて動作確認する。

---

## 進め方のポイント

- 担当5画面はすべて`MockApiClient`のサンプルデータ（`packages/shared/src/sample-data/`）で並行開発できる。subaruのバックエンド完了を待つ必要はない。
- #56（データ取得通知・変更点表示）は今回の仕様追加分。`docs/仕様書.md` 1.3節と`docs/api/contract.md` 1.4節を必ず確認してから着手する。
- subaruの#43（同期時の変更検知ロジック）が終わるとnativeモードでの動作確認ができるようになるので、Phase3前に一度声をかけておくとよい。
