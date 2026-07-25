ALTER TABLE files ADD COLUMN missing_at TEXT;

CREATE INDEX idx_files_missing ON files(missing_at);

PRAGMA user_version = 6;
