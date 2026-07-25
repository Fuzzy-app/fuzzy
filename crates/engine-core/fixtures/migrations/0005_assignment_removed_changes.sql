-- v4からv5: 課題の同期対象外化・復帰もフィールド差分として保持する。
CREATE TABLE assignment_changes_v5 (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	sync_event_id INTEGER NOT NULL REFERENCES sync_events(id) ON DELETE CASCADE,
	assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
	field         TEXT NOT NULL CHECK (field IN ('due_at', 'title', 'submission_mode', 'due_at_status', 'submitted', 'removed_at')),
	old_value     TEXT,
	new_value     TEXT,
	detected_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO assignment_changes_v5 (
	id, sync_event_id, assignment_id, field, old_value, new_value, detected_at
)
SELECT
	id, sync_event_id, assignment_id, field, old_value, new_value, detected_at
FROM assignment_changes;

DROP TABLE assignment_changes;
ALTER TABLE assignment_changes_v5 RENAME TO assignment_changes;

CREATE INDEX idx_assignment_changes_sync ON assignment_changes(sync_event_id);
CREATE INDEX idx_assignment_changes_assignment ON assignment_changes(assignment_id);

PRAGMA user_version = 5;
