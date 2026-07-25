-- 既存DBへ拡張機能の実応答記録を追加する冪等マイグレーション。
CREATE TABLE IF NOT EXISTS extension_runtime_observations (
	installation_id   TEXT NOT NULL,
	extension_version TEXT NOT NULL,
	protocol_version  INTEGER NOT NULL CHECK (protocol_version > 0),
	first_seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	last_seen_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (installation_id, extension_version, protocol_version)
);
CREATE INDEX IF NOT EXISTS idx_extension_runtime_last_seen
	ON extension_runtime_observations(last_seen_at);
