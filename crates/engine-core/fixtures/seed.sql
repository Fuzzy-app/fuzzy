-- Fuzzy サンプルデータ（開発・デモ・モックフォールバック用）
-- 投入手順: sqlite3 fuzzy.db ".read schema.sql" ".read seed.sql"
-- 科目名は Fuzzy.pdf のダッシュボード画面モックアップに合わせている

PRAGMA foreign_keys = ON;

INSERT INTO app_settings (key, value) VALUES
	('base_folder_path', 'C:\Users\sample\Documents\大学'),
	('app_version', '0.1.0'),
	('last_full_scan_at', '2026-07-01T08:00:00');

INSERT INTO global_rule (id, pattern_key, pattern_template) VALUES
	(1, 'year_term_course_section', '{year}/{term}/{course}/第{section}回');

INSERT INTO courses (id, moodle_course_id, name, term) VALUES
	(1, 'course-350', '情報アーキテクチャ', '2026前期'),
	(2, 'course-412', 'データベース', '2026前期'),
	(3, 'course-318', '離散数学', '2026前期'),
	(4, 'course-350-app', 'アプリ演習', '2026前期'),
	(5, 'course-274', '認知科学概論', '2026前期'),
	(6, 'course-501', '英語IIB', '2026前期');

-- アプリ演習だけ「回ごとに分けない」例外ルール（仕様書の例に対応）
INSERT INTO course_rule_overrides (course_id, split_by_section, pattern_template, note) VALUES
	(4, 0, '{year}/{term}/{course}', '実習課題はまとめて1フォルダで管理したいため回ごとに分けない');

INSERT INTO files (id, course_id, section_no, moodle_file_id, original_name, saved_path, size_bytes, mime_type, hash_blake3, simhash, text_extracted, rule_compliant, violation_reason, downloaded_at) VALUES
	(1, 1, 9, 'res-9001', '09_情報アーキテクチャ_講義資料.pdf', 'C:\Users\sample\Documents\大学\2026前期\情報アーキテクチャ\第9回\09_情報アーキテクチャ_講義資料.pdf', 2456000, 'application/pdf', 'b3:1a2b3c...', 84512, 1, 1, NULL, '2026-06-29T10:12:00'),
	(2, 1, 9, 'res-9002', '09_演習課題.docx', 'C:\Users\sample\Documents\大学\2026前期\情報アーキテクチャ\第9回\09_演習課題.docx', 88000, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'b3:9f8e7d...', 84520, 1, 1, NULL, '2026-06-29T10:12:30'),
	(3, 2, 4, 'res-4101', '第4回_正規化.pdf', 'C:\Users\sample\Documents\大学\2026前期\データベース\第4回\第4回_正規化.pdf', 1980000, 'application/pdf', 'b3:2c3d4e...', 55012, 1, 1, NULL, '2026-06-20T09:00:00'),
	(4, 2, NULL, NULL, '正規化_メモ.docx', 'C:\Users\sample\Documents\大学\正規化_メモ.docx', 12000, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'b3:aa11bb...', 55090, 1, 0, 'グローバルルール（年度/学期/コース名/回）から外れた場所に保存されています', '2026-06-21T19:40:00'),
	(5, 3, 6, 'res-6044', '離散数学_第6回_グラフ理論.pdf', 'C:\Users\sample\Documents\大学\2026前期\離散数学\第6回\離散数学_第6回_グラフ理論.pdf', 3100000, 'application/pdf', 'b3:3d4e5f...', 71234, 1, 1, NULL, '2026-06-22T13:05:00'),
	(6, 4, NULL, 'res-7701', 'アプリ演習_中間プレゼン資料.pptx', 'C:\Users\sample\Documents\大学\2026前期\アプリ演習\アプリ演習_中間プレゼン資料.pptx', 5400000, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'b3:4e5f6a...', 91022, 0, 1, NULL, '2026-06-27T15:30:00'),
	(7, 5, 3, 'res-3302', '認知科学概論_第3回レジュメ.pdf', 'C:\Users\sample\Documents\大学\2026前期\認知科学概論\第3回\認知科学概論_第3回レジュメ.pdf', 1450000, 'application/pdf', 'b3:5f6a7b...', 62211, 1, 1, NULL, '2026-05-18T11:00:00'),
	(8, 6, 2, 'res-2201', 'English_IIB_Unit2_reading.pdf', 'C:\Users\sample\Documents\大学\2026前期\英語IIB\第2回\English_IIB_Unit2_reading.pdf', 980000, 'application/pdf', 'b3:6a7b8c...', 48899, 1, 1, NULL, '2026-04-30T09:20:00'),
	-- 重複ペア（同一資料を2回DLしてしまった例）
	(9,  2, 4, 'res-4101', '第4回_正規化(1).pdf', 'C:\Users\sample\Documents\大学\ダウンロード\第4回_正規化(1).pdf', 1980000, 'application/pdf', 'b3:2c3d4e...', 55012, 1, 0, 'グローバルルール（年度/学期/コース名/回）から外れた場所に保存されています。データベース/第4回に同一内容のファイルが既にあります', '2026-06-25T08:10:00');

INSERT INTO duplicate_groups (id, method) VALUES
	(1, 'exact');
INSERT INTO duplicate_members (group_id, file_id, similarity) VALUES
	(1, 3, 1.0),
	(1, 9, 1.0);

INSERT INTO assignments (id, course_id, title, source, due_at, due_at_status, submission_mode, submitted, related_file_id) VALUES
	(1, 2, '正規化レポート提出', 'moodle_dashboard', '2026-07-04T23:59:00', 'normal', 'moodle_auto', 0, 3),
	(2, 1, '第9回 演習課題', 'file_content', '2026-07-03T17:00:00', 'normal', 'manual', 0, 2),
	(3, 4, '中間プレゼン資料の提出', 'moodle_text', '2026-07-02T12:00:00', 'normal', 'moodle_auto', 1, 6),
	(4, 3, '離散数学 小テスト範囲確認', 'moodle_dashboard', '2026-06-29T23:59:00', 'normal', 'notify_only', 0, NULL),
	(5, 5, '認知科学概論 期末レポート', 'moodle_dashboard', '2027-05-10T23:59:00', 'needs_review', 'moodle_auto', 0, NULL),
	(6, 6, '英語IIB 単語テスト', 'moodle_dashboard', '2026-06-20T23:59:00', 'normal', 'notify_only', 0, NULL);
-- assignment 5 は学期の範囲から大きく外れた締切（前年度設定ミスの想定）→ needs_review
-- assignment 6 は締切超過（期限切れのまとめ画面の対象）

INSERT INTO notification_rules (offset_minutes, label, enabled) VALUES
	(4320, '3日前', 1),
	(1440, '1日前', 1),
	(540,  '当日 9:00', 1),
	(60,   '1時間前', 0);

INSERT INTO search_index_meta (file_id, page_count) VALUES
	(1, 32), (2, 4), (3, 18), (4, 2), (5, 27), (6, 22), (7, 14), (8, 9);

-- 直近の同期イベント（データ取得通知・変更点表示のサンプル）
INSERT INTO sync_events (id, synced_at, trigger, new_assignment_count, changed_assignment_count, removed_assignment_count) VALUES
	(1, '2026-06-30T08:00:00', 'auto', 0, 0, 0),
	(2, '2026-07-01T08:00:00', 'auto', 1, 2, 0);
-- sync_event 2 が最新の取得。app_settings.last_full_scan_at と揃えている

INSERT INTO assignment_changes (sync_event_id, assignment_id, field, old_value, new_value, detected_at) VALUES
	-- 認知科学概論 期末レポート：締切そのものは変わっていないが、学期範囲チェックにより要確認へ変化した例
	(2, 5, 'due_at_status', 'normal', 'needs_review', '2026-07-01T08:00:00'),
	-- 正規化レポート提出：Moodle側で締切が延長された例
	(2, 1, 'due_at', '2026-07-03T23:59:00', '2026-07-04T23:59:00', '2026-07-01T08:00:00');
-- assignments.id=1（正規化レポート提出）は上記変更を反映した最新の due_at で登録済み
