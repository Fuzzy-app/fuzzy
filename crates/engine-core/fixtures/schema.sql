-- Fuzzy ローカルDB（SQLite）スキーマ定義
-- 使用前に必ず実行: PRAGMA foreign_keys = ON;

CREATE TABLE app_settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
-- 例: base_folder_path（初期セットアップで選んだ保存先実パス）, app_version, last_full_scan_at

CREATE TABLE courses (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	moodle_course_id TEXT NOT NULL UNIQUE,
	name             TEXT NOT NULL,
	term             TEXT,
	created_at       TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE global_rule (
	id               INTEGER PRIMARY KEY CHECK (id = 1),
	pattern_key      TEXT NOT NULL,
	pattern_template TEXT NOT NULL,
	updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE course_rule_overrides (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	course_id        INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
	split_by_section INTEGER NOT NULL DEFAULT 1,
	pattern_template TEXT,
	note             TEXT,
	created_at       TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (course_id)
);

CREATE TABLE files (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	course_id        INTEGER REFERENCES courses(id) ON DELETE SET NULL,
	section_no       INTEGER,
	moodle_file_id   TEXT,
	original_name    TEXT NOT NULL,
	saved_path       TEXT NOT NULL UNIQUE,
	size_bytes       INTEGER NOT NULL,
	mime_type        TEXT,
	hash_blake3      TEXT NOT NULL,
	simhash          INTEGER,
	text_extracted   INTEGER NOT NULL DEFAULT 0,
	rule_compliant   INTEGER NOT NULL DEFAULT 1,
	violation_reason TEXT,
	downloaded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_files_course ON files(course_id);
CREATE INDEX idx_files_hash ON files(hash_blake3);
CREATE INDEX idx_files_violation ON files(rule_compliant);

CREATE TABLE duplicate_groups (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	method     TEXT NOT NULL CHECK (method IN ('exact', 'similar')),
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE duplicate_members (
	group_id   INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
	file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	similarity REAL NOT NULL DEFAULT 1.0,
	PRIMARY KEY (group_id, file_id)
);

CREATE TABLE assignments (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	course_id        INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
	title            TEXT NOT NULL,
	source           TEXT NOT NULL CHECK (source IN ('moodle_dashboard', 'moodle_text', 'file_content')),
	due_at           TEXT,
	due_at_status    TEXT NOT NULL DEFAULT 'normal' CHECK (due_at_status IN ('normal', 'needs_review')),
	submission_mode  TEXT NOT NULL DEFAULT 'unknown' CHECK (submission_mode IN ('moodle_auto', 'manual', 'notify_only', 'unknown')),
	submitted        INTEGER NOT NULL DEFAULT 0,
	related_file_id  INTEGER REFERENCES files(id) ON DELETE SET NULL,
	created_at       TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assignments_due ON assignments(due_at);
CREATE INDEX idx_assignments_course ON assignments(course_id);

CREATE TABLE notification_rules (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	offset_minutes INTEGER NOT NULL,
	label          TEXT NOT NULL,
	enabled        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE search_index_meta (
	file_id    INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
	indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
	page_count INTEGER
);
