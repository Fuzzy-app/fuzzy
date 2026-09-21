//! Moodleコース本文のブロック同期と検索。

use std::collections::BTreeSet;

use rusqlite::{params, params_from_iter, types::Value, TransactionBehavior};

use super::{db_err, Database};
use crate::types::{MoodleTextBlockRecord, MoodleTextSearchRecord};
use crate::{EngineError, EngineResult};

impl Database {
	/// 完全なcourse/view.phpの本文snapshotで、当該コースだけを置き換える。
	pub fn sync_moodle_text_blocks(
		&mut self,
		course_id: i64,
		blocks: &[MoodleTextBlockRecord],
	) -> EngineResult<()> {
		let expected_hostname = self
			.conn
			.query_row(
				"SELECT moodle_course_id FROM courses WHERE id = ?1",
				[course_id],
				|row| row.get::<_, String>(0),
			)
			.map_err(db_err)?;
		let expected_hostname = contextual_moodle_hostname(&expected_hostname);
		let mut keys = BTreeSet::new();
		for block in blocks {
			validate_block(block, expected_hostname)?;
			if !keys.insert(block.block_key.as_str()) {
				return Err(invalid(
					"blocks.blockKey",
					"同じブロックキーが重複しています",
				));
			}
		}

		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;
		for block in blocks {
			transaction
				.execute(
					"INSERT INTO moodle_text_blocks (
						course_id, block_key, title, body, normalized_body, moodle_url, updated_at
					 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
					 ON CONFLICT(course_id, block_key) DO UPDATE SET
						title = excluded.title,
						body = excluded.body,
						normalized_body = excluded.normalized_body,
						moodle_url = excluded.moodle_url,
						updated_at = datetime('now')",
					params![
						course_id,
						block.block_key,
						block.title,
						block.body,
						block.normalized_body,
						block.moodle_url
					],
				)
				.map_err(db_err)?;
		}
		let existing = {
			let mut statement = transaction
				.prepare("SELECT block_key FROM moodle_text_blocks WHERE course_id = ?1")
				.map_err(db_err)?;
			let keys = statement
				.query_map([course_id], |row| row.get::<_, String>(0))
				.map_err(db_err)?
				.collect::<rusqlite::Result<Vec<_>>>()
				.map_err(db_err)?;
			keys
		};
		for stale_key in existing
			.into_iter()
			.filter(|key| !keys.contains(key.as_str()))
		{
			transaction
				.execute(
					"DELETE FROM moodle_text_blocks WHERE course_id = ?1 AND block_key = ?2",
					params![course_id, stale_key],
				)
				.map_err(db_err)?;
		}
		transaction.commit().map_err(db_err)
	}

	pub fn search_moodle_text_blocks(
		&self,
		normalized_query: &str,
		course_ids: Option<&[i64]>,
		limit: usize,
	) -> EngineResult<Vec<MoodleTextSearchRecord>> {
		if normalized_query.is_empty() || limit == 0 {
			return Ok(Vec::new());
		}
		if course_ids.is_some_and(<[i64]>::is_empty) {
			return Ok(Vec::new());
		}
		let limit = i64::try_from(limit).map_err(|_| invalid("limit", "検索件数が大きすぎます"))?;
		let course_filter = course_ids.map_or_else(String::new, |course_ids| {
			format!(
				" AND b.course_id IN ({})",
				std::iter::repeat_n("?", course_ids.len())
					.collect::<Vec<_>>()
					.join(", ")
			)
		});
		let sql = format!(
			"SELECT b.id, b.course_id, c.name, b.block_key, b.title, b.body, b.moodle_url,
				CASE WHEN b.normalized_body = ? THEN 4.0 ELSE 2.0 END
			 FROM moodle_text_blocks b
			 JOIN courses c ON c.id = b.course_id
			 WHERE instr(b.normalized_body, ?) > 0
				{course_filter}
			 ORDER BY 8 DESC, b.updated_at DESC, b.id
			 LIMIT ?"
		);
		let mut values = vec![
			Value::Text(normalized_query.to_string()),
			Value::Text(normalized_query.to_string()),
		];
		if let Some(course_ids) = course_ids {
			values.extend(course_ids.iter().copied().map(Value::Integer));
		}
		values.push(Value::Integer(limit));
		let mut statement = self.conn.prepare(&sql).map_err(db_err)?;
		let records = statement
			.query_map(params_from_iter(values.iter()), |row| {
				Ok(MoodleTextSearchRecord {
					block_id: row.get(0)?,
					course_id: row.get(1)?,
					course_name: row.get(2)?,
					block_key: row.get(3)?,
					title: row.get(4)?,
					body: row.get(5)?,
					moodle_url: row.get(6)?,
					score: row.get(7)?,
				})
			})
			.map_err(db_err)?
			.collect::<rusqlite::Result<Vec<_>>>()
			.map_err(db_err)?;
		Ok(records)
	}
}

fn validate_block(
	block: &MoodleTextBlockRecord,
	expected_hostname: Option<&str>,
) -> EngineResult<()> {
	if block.block_key.is_empty() || block.block_key.len() > 256 {
		return Err(invalid("blocks.blockKey", "1〜256文字で指定してください"));
	}
	if block.title.is_empty() || block.title.chars().count() > 512 {
		return Err(invalid("blocks.title", "1〜512文字で指定してください"));
	}
	if block.body.is_empty() || block.body.chars().count() > 12_000 {
		return Err(invalid("blocks.text", "1〜12000文字で指定してください"));
	}
	if block.normalized_body.is_empty() || block.normalized_body.chars().count() > 12_000 {
		return Err(invalid("blocks.normalizedText", "検索用本文が不正です"));
	}
	let valid_url = url::Url::parse(&block.moodle_url).ok().is_some_and(|url| {
		url.scheme() == "https"
			&& url.username().is_empty()
			&& url.password().is_none()
			&& expected_hostname.is_none_or(|hostname| {
				url.host_str()
					.is_some_and(|actual| actual.eq_ignore_ascii_case(hostname))
			})
	});
	if !valid_url || block.moodle_url.len() > 2_048 {
		return Err(invalid(
			"blocks.moodleUrl",
			"対象コースと同じMoodleホストのHTTPS URLを指定してください",
		));
	}
	Ok(())
}

fn contextual_moodle_hostname(identifier: &str) -> Option<&str> {
	identifier
		.strip_prefix("moodle:")?
		.split_once(':')
		.map(|(hostname, _)| hostname)
		.filter(|hostname| !hostname.is_empty())
}

fn invalid(field: &str, reason: &str) -> EngineError {
	EngineError::InvalidInput {
		field: field.to_string(),
		reason: reason.to_string(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::index::normalize_search_text;

	fn block(key: &str, text: &str, url: &str) -> MoodleTextBlockRecord {
		MoodleTextBlockRecord {
			block_key: key.to_string(),
			title: "高速化の資料".to_string(),
			body: text.to_string(),
			normalized_body: normalize_search_text(text),
			moodle_url: url.to_string(),
		}
	}

	#[test]
	fn snapshot_sync_is_searchable_and_removes_stale_blocks() {
		let mut database = Database::open_in_memory().unwrap();
		let course = database
			.resolve_course_context(
				Some("moodle:moodle.example.jp:2026:350"),
				Some("アプリ演習"),
				Some(2026),
				Some("前期"),
			)
			.unwrap();
		let first = block(
			"section-1",
			"Pythonを高速化する方法",
			"https://moodle.example.jp/course/view.php?id=350#section-1",
		);
		database
			.sync_moodle_text_blocks(course.course_id, &[first])
			.unwrap();
		let results = database
			.search_moodle_text_blocks(
				&normalize_search_text("Pythonを高速化"),
				Some(&[course.course_id]),
				10,
			)
			.unwrap();
		assert_eq!(results.len(), 1);

		let replacement = block(
			"section-2",
			"Rustの資料",
			"https://moodle.example.jp/course/view.php?id=350#section-2",
		);
		database
			.sync_moodle_text_blocks(course.course_id, &[replacement])
			.unwrap();
		assert!(database
			.search_moodle_text_blocks(
				&normalize_search_text("Pythonを高速化"),
				Some(&[course.course_id]),
				10,
			)
			.unwrap()
			.is_empty());
	}

	#[test]
	fn searches_multiple_courses_with_one_database_query() {
		let mut database = Database::open_in_memory().unwrap();
		let first = database
			.resolve_course_context(
				Some("moodle:moodle.example.jp:2026:351"),
				Some("第一コース"),
				Some(2026),
				Some("前期"),
			)
			.unwrap();
		let second = database
			.resolve_course_context(
				Some("moodle:moodle.example.jp:2026:352"),
				Some("第二コース"),
				Some(2026),
				Some("前期"),
			)
			.unwrap();
		let third = database
			.resolve_course_context(
				Some("moodle:moodle.example.jp:2026:353"),
				Some("第三コース"),
				Some(2026),
				Some("前期"),
			)
			.unwrap();
		for course_id in [first.course_id, second.course_id, third.course_id] {
			database
				.sync_moodle_text_blocks(
					course_id,
					&[block(
						"section-1",
						"検索対象の本文",
						"https://moodle.example.jp/course/view.php?id=350#section-1",
					)],
				)
				.unwrap();
		}

		let results = database
			.search_moodle_text_blocks(
				&normalize_search_text("検索対象"),
				Some(&[first.course_id, third.course_id]),
				10,
			)
			.unwrap();

		assert_eq!(results.len(), 2);
		assert!(results
			.iter()
			.all(|result| { [first.course_id, third.course_id].contains(&result.course_id) }));
	}

	#[test]
	fn contextual_course_rejects_a_jump_url_on_another_host() {
		let mut database = Database::open_in_memory().unwrap();
		let course = database
			.resolve_course_context(
				Some("moodle:moodle.example.jp:2026:350"),
				Some("アプリ演習"),
				Some(2026),
				Some("前期"),
			)
			.unwrap();
		let foreign = block(
			"section-1",
			"本文",
			"https://attacker.example/course/view.php?id=350",
		);
		assert!(database
			.sync_moodle_text_blocks(course.course_id, &[foreign])
			.is_err());
	}
}
