-- v0からv1: duplicate_members.similarityを0.0〜1.0へ制約する。
-- 既存値が範囲外ならINSERTが失敗し、呼び出し側のトランザクション全体をロールバックする。
CREATE TABLE duplicate_members_v1 (
	group_id   INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
	file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	similarity REAL NOT NULL DEFAULT 1.0 CHECK (similarity BETWEEN 0.0 AND 1.0),
	PRIMARY KEY (group_id, file_id)
);

INSERT INTO duplicate_members_v1 (group_id, file_id, similarity)
	SELECT group_id, file_id, similarity
	FROM duplicate_members;

DROP TABLE duplicate_members;
ALTER TABLE duplicate_members_v1 RENAME TO duplicate_members;

PRAGMA user_version = 1;
