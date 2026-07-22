-- v1からv2: 年度を独立した正本へ分離し、ユーザー指定のコースフォルダ名を保持する。
ALTER TABLE courses
	ADD COLUMN academic_year INTEGER CHECK (academic_year BETWEEN 1900 AND 9999);
ALTER TABLE courses
	ADD COLUMN folder_name_override TEXT;

-- v1までのseed・既存データはterm先頭に年度を含めていたため、移行時だけ補完する。
-- 以後の実行時処理はtermから年度を推測せず、academic_yearだけを参照する。
UPDATE courses
SET academic_year = CAST(substr(term, 1, 4) AS INTEGER)
WHERE term GLOB '[0-9][0-9][0-9][0-9]*'
	AND CAST(substr(term, 1, 4) AS INTEGER) BETWEEN 1900 AND 9999;

PRAGMA user_version = 2;
