-- v2からv3: Moodleの最新取得結果から消えた課題を履歴付きで同期対象外にする。
ALTER TABLE assignments
	ADD COLUMN removed_at TEXT;
CREATE INDEX idx_assignments_active ON assignments(removed_at);

PRAGMA user_version = 3;
