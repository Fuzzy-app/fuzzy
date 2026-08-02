# 除外フォルダー API

保存ルートに対する除外設定は `excluded_folders` テーブルで管理します。

* `getExcludedFolders({ courseId? })` は、全体設定と指定した授業の設定を返します。
* `updateExcludedFolders({ scope, courseId, paths })` は、指定範囲の設定を置き換えます。`scope` が `root` の場合は `courseId: null`、`course` の場合は正の授業IDを指定します。
* `paths` は保存ルートからの相対フォルダー（1行1件）です。絶対パス、`..`、保存ルートそのものは指定できません。

除外された資料は、ファイルを移動・削除せず、ダッシュボード・検索・重複検出・ルール違反一覧の対象から外します。既存ファイルの状態は設定更新時に再計算し、SQLiteの正本と保存済みファイルは保持します。
