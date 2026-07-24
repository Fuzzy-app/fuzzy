//! 締切通知ルールのSQLite永続化。

use std::collections::BTreeSet;

#[cfg(test)]
use rusqlite::OptionalExtension;
use rusqlite::{params, TransactionBehavior};

use super::{db_err, Database};
use crate::types::{NotificationRuleInput, NotificationRuleRecord};
use crate::{EngineError, EngineResult};

const MAX_NOTIFICATION_OFFSET_MINUTES: i64 = 365 * 24 * 60;

impl Database {
	/// 通知ルールを相対時間の大きい順で取得する。
	pub fn notification_rules(&self) -> EngineResult<Vec<NotificationRuleRecord>> {
		load_notification_rules(&self.conn)
	}

	/// 通知ルールを一括更新する。
	///
	/// ID付きは更新、IDなしは追加、入力から除かれた既存行は削除する。
	/// 全操作を1トランザクションにまとめ、部分更新を残さない。
	pub fn update_notification_rules(
		&mut self,
		rules: &[NotificationRuleInput],
	) -> EngineResult<Vec<NotificationRuleRecord>> {
		validate_notification_rules(rules)?;
		let transaction = self
			.conn
			.transaction_with_behavior(TransactionBehavior::Immediate)
			.map_err(db_err)?;

		let known_ids = {
			let mut statement = transaction
				.prepare("SELECT id FROM notification_rules")
				.map_err(db_err)?;
			let ids = statement
				.query_map([], |row| row.get::<_, i64>(0))
				.map_err(db_err)?
				.collect::<rusqlite::Result<BTreeSet<_>>>()
				.map_err(db_err)?;
			ids
		};
		for id in rules.iter().filter_map(|rule| rule.id) {
			if !known_ids.contains(&id) {
				return Err(EngineError::NotFound {
					entity: "通知ルール".to_string(),
					id: id.to_string(),
				});
			}
		}

		// 既存IDを保ったまま全行を入れ直す。これにより、2つのルールが
		// offset_minutesを交換する更新でも一時的なUNIQUE違反を起こさない。
		transaction
			.execute("DELETE FROM notification_rules", [])
			.map_err(db_err)?;
		for rule in rules {
			let label = notification_rule_label(rule.offset_minutes);
			if let Some(id) = rule.id {
				transaction
					.execute(
						"INSERT INTO notification_rules (id, offset_minutes, label, enabled)
						 VALUES (?1, ?2, ?3, ?4)",
						params![id, rule.offset_minutes, label, rule.enabled],
					)
					.map_err(db_err)?;
			} else {
				transaction
					.execute(
						"INSERT INTO notification_rules (offset_minutes, label, enabled)
						 VALUES (?1, ?2, ?3)",
						params![rule.offset_minutes, label, rule.enabled],
					)
					.map_err(db_err)?;
			}
		}

		let saved = load_notification_rules(&transaction)?;
		transaction.commit().map_err(db_err)?;
		Ok(saved)
	}
}

fn load_notification_rules(
	conn: &rusqlite::Connection,
) -> EngineResult<Vec<NotificationRuleRecord>> {
	let mut statement = conn
		.prepare(
			"SELECT id, offset_minutes, enabled
			 FROM notification_rules
			 ORDER BY offset_minutes DESC, id",
		)
		.map_err(db_err)?;
	let rules = statement
		.query_map([], |row| {
			let id = row.get(0)?;
			let offset_minutes = row.get(1)?;
			let enabled = match row.get::<_, i64>(2)? {
				0 => false,
				1 => true,
				value => return Err(rusqlite::Error::IntegralValueOutOfRange(2, value)),
			};
			Ok(NotificationRuleRecord {
				id,
				offset_minutes,
				label: notification_rule_label(offset_minutes),
				enabled,
			})
		})
		.map_err(db_err)?
		.collect::<rusqlite::Result<Vec<_>>>()
		.map_err(db_err)?;
	Ok(rules)
}

fn validate_notification_rules(rules: &[NotificationRuleInput]) -> EngineResult<()> {
	let mut ids = BTreeSet::new();
	let mut offsets = BTreeSet::new();
	for rule in rules {
		if let Some(id) = rule.id {
			if id <= 0 {
				return Err(invalid_notification_rule("idは1以上の整数にしてください"));
			}
			if !ids.insert(id) {
				return Err(invalid_notification_rule("同じidを複数回指定できません"));
			}
		}
		if !(0..=MAX_NOTIFICATION_OFFSET_MINUTES).contains(&rule.offset_minutes) {
			return Err(invalid_notification_rule(
				"通知タイミングは締切時刻から365日前までの分数で指定してください",
			));
		}
		if !offsets.insert(rule.offset_minutes) {
			return Err(EngineError::RuleConflict {
				reason: "同じ通知タイミングは重複して登録できません".to_string(),
			});
		}
	}
	Ok(())
}

fn invalid_notification_rule(reason: &str) -> EngineError {
	EngineError::InvalidInput {
		field: "rules".to_string(),
		reason: reason.to_string(),
	}
}

/// TypeScript側の`notificationRuleLabel`と同じ規則で表示名を生成する。
pub fn notification_rule_label(offset_minutes: i64) -> String {
	if offset_minutes == 0 {
		return "締切時刻".to_string();
	}
	if offset_minutes % (24 * 60) == 0 {
		return format!("{}日前", offset_minutes / (24 * 60));
	}
	if offset_minutes % 60 == 0 {
		return format!("{}時間前", offset_minutes / 60);
	}
	if offset_minutes > 60 {
		return format!("{}時間{}分前", offset_minutes / 60, offset_minutes % 60);
	}
	format!("{offset_minutes}分前")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::SEED_SQL;

	fn seeded_database() -> Database {
		let database = Database::open_in_memory().unwrap();
		database.conn().execute_batch(SEED_SQL).unwrap();
		database
	}

	#[test]
	fn labels_match_the_shared_typescript_contract() {
		assert_eq!(notification_rule_label(0), "締切時刻");
		assert_eq!(notification_rule_label(4320), "3日前");
		assert_eq!(notification_rule_label(540), "9時間前");
		assert_eq!(notification_rule_label(95), "1時間35分前");
		assert_eq!(notification_rule_label(15), "15分前");
	}

	#[test]
	fn notification_rules_replace_all_rows_atomically() {
		let mut database = seeded_database();
		let saved = database
			.update_notification_rules(&[
				NotificationRuleInput {
					id: Some(2),
					offset_minutes: 1440,
					enabled: false,
				},
				NotificationRuleInput {
					id: None,
					offset_minutes: 30,
					enabled: true,
				},
			])
			.unwrap();

		assert_eq!(saved.len(), 2);
		assert_eq!(saved[0].id, 2);
		assert!(!saved[0].enabled);
		assert_eq!(saved[1].label, "30分前");
		let old_rule = database
			.conn()
			.query_row(
				"SELECT id FROM notification_rules WHERE id = 1",
				[],
				|row| row.get::<_, i64>(0),
			)
			.optional()
			.unwrap();
		assert_eq!(old_rule, None);
	}

	#[test]
	fn invalid_notification_update_keeps_existing_rows() {
		let mut database = seeded_database();
		let result = database.update_notification_rules(&[
			NotificationRuleInput {
				id: Some(1),
				offset_minutes: 60,
				enabled: true,
			},
			NotificationRuleInput {
				id: Some(2),
				offset_minutes: 60,
				enabled: false,
			},
		]);
		assert!(matches!(result, Err(EngineError::RuleConflict { .. })));
		assert_eq!(database.notification_rules().unwrap().len(), 4);
	}

	#[test]
	fn existing_rules_can_swap_offsets_without_a_temporary_unique_conflict() {
		let mut database = seeded_database();
		let saved = database
			.update_notification_rules(&[
				NotificationRuleInput {
					id: Some(2),
					offset_minutes: 60,
					enabled: true,
				},
				NotificationRuleInput {
					id: Some(4),
					offset_minutes: 1440,
					enabled: false,
				},
			])
			.unwrap();

		assert_eq!(saved[0].id, 4);
		assert_eq!(saved[1].id, 2);
	}
}
