ALTER TABLE assignments ADD COLUMN moodle_assignment_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_moodle_identity
	ON assignments(course_id, moodle_assignment_id)
	WHERE moodle_assignment_id IS NOT NULL;

PRAGMA user_version = 4;
