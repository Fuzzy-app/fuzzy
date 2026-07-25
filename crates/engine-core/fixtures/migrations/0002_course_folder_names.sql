ALTER TABLE courses
	ADD COLUMN academic_year INTEGER CHECK (academic_year BETWEEN 1900 AND 9999);

ALTER TABLE courses
	ADD COLUMN folder_name_override TEXT;

UPDATE courses
SET academic_year = CAST(substr(term, 1, 4) AS INTEGER)
WHERE academic_year IS NULL
	AND term GLOB '[0-9][0-9][0-9][0-9]*'
	AND CAST(substr(term, 1, 4) AS INTEGER) BETWEEN 1900 AND 9999;

PRAGMA user_version = 2;
