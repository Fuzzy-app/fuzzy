//! Moodle由来の文字列をWindowsの保存フォルダ名へ正規化する。
//!
//! `packages/shared/src/folderNames.ts` と同じ境界をRust側でも適用し、RuleEngineと
//! Native Messaging実装で保存先の解釈が分岐しないようにする。

/// 同名コースの衝突判定に使う、コース名とMoodle安定ID。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CourseFolderIdentity<'a> {
	pub name: &'a str,
	pub stable_id: &'a str,
}

/// Moodle上の補足表記と絵文字を除き、保存先に使うフォルダ名へ正規化する。
pub fn folder_segment(value: &str) -> String {
	let normalized = normalize_folder_text(value);
	let without_notes = remove_balanced_notes(&normalized);
	normalize_folder_text(&without_notes)
}

/// コース名を簡略化し、簡略化後に衝突する場合はMoodle安定IDを付ける。
pub fn course_folder_name(
	course_name: &str,
	known_courses: &[CourseFolderIdentity<'_>],
	stable_id: Option<&str>,
) -> String {
	let original = non_empty_or(normalize_folder_text(course_name), "不明なコース");
	let simplified = non_empty_or(folder_segment(&original), "不明なコース");
	let simplified_key = comparison_key(&simplified);
	let has_collision = known_courses.iter().any(|course| {
		let other_name = normalize_folder_text(course.name);
		comparison_key(&other_name) != comparison_key(&original)
			&& comparison_key(&folder_segment(&other_name)) == simplified_key
	});
	if !has_collision {
		return simplified;
	}

	let known_identity = known_courses
		.iter()
		.find(|course| comparison_key(course.name) == comparison_key(&original));
	let stable_id = stable_id
		.or_else(|| known_identity.map(|course| course.stable_id))
		.map(normalize_stable_id)
		.unwrap_or_else(|| stable_hash(&original));
	format!("{simplified}_{stable_id}")
}

fn non_empty_or(value: String, fallback: &str) -> String {
	if value.is_empty() {
		fallback.to_string()
	} else {
		value
	}
}

fn normalize_folder_text(value: &str) -> String {
	let compatible = value
		.chars()
		.filter_map(|character| {
			let character = compatibility_character(character);
			(!is_emoji_character(character)).then_some(character)
		})
		.collect::<String>();
	compatible.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn compatibility_character(character: char) -> char {
	match character {
		'\u{3000}' => ' ',
		'\u{ff01}'..='\u{ff5e}' => char::from_u32(character as u32 - 0xfee0).unwrap_or(character),
		_ => character,
	}
}

fn is_emoji_character(character: char) -> bool {
	matches!(
		character,
		'\u{200d}' | '\u{20e3}' | '\u{fe0f}'
			| '\u{2600}'..='\u{27bf}'
			| '\u{1f000}'..='\u{1faff}'
	)
}

fn remove_balanced_notes(value: &str) -> String {
	let mut current = value.to_string();
	loop {
		let characters = current.char_indices().collect::<Vec<_>>();
		let mut pair = None;
		for (close_index, close) in &characters {
			let open = match close {
				')' => '(',
				']' => '[',
				_ => continue,
			};
			if let Some((open_index, _)) = characters
				.iter()
				.rev()
				.find(|(index, character)| index < close_index && *character == open)
			{
				pair = Some((*open_index, *close_index + close.len_utf8()));
				break;
			}
		}
		let Some((start, end)) = pair else {
			return current;
		};
		current.replace_range(start..end, " ");
	}
}

fn normalize_stable_id(value: &str) -> String {
	let normalized = normalize_folder_text(value);
	let mut result = String::new();
	let mut previous_hyphen = false;
	for character in normalized.chars() {
		let replace =
			character.is_whitespace() || r#"<>:"/\|?*()[]"#.contains(character) || character == '-';
		if replace {
			if !previous_hyphen && !result.is_empty() {
				result.push('-');
			}
			previous_hyphen = true;
		} else {
			result.push(character);
			previous_hyphen = false;
		}
	}
	let result = result.trim_matches('-');
	if result.is_empty() {
		stable_hash(value)
	} else {
		result.to_string()
	}
}

fn comparison_key(value: &str) -> String {
	normalize_folder_text(value).to_lowercase()
}

fn stable_hash(value: &str) -> String {
	let hash = value.chars().fold(2_166_136_261_u32, |hash, character| {
		(hash ^ character as u32).wrapping_mul(16_777_619)
	});
	format!("course-{}", base36(hash))
}

fn base36(mut value: u32) -> String {
	if value == 0 {
		return "0".to_string();
	}
	let mut result = Vec::new();
	while value > 0 {
		let digit = (value % 36) as u8;
		result.push(if digit < 10 {
			char::from(b'0' + digit)
		} else {
			char::from(b'a' + digit - 10)
		});
		value /= 36;
	}
	result.into_iter().rev().collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn removes_bracketed_notes_and_emoji_like_the_shared_client() {
		for (input, expected) in [
			("情報科学📚（2026年度・前期）", "情報科学"),
			("統計学 (担当: 山田)", "統計学"),
			("英語［Aクラス］", "英語"),
			("第4回[配布資料]🔬", "第4回"),
			("プログラミング（演習[追加]）", "プログラミング"),
			("情報科学（前期", "情報科学(前期"),
		] {
			assert_eq!(folder_segment(input), expected, "入力: {input}");
		}
	}

	#[test]
	fn adds_stable_ids_when_simplified_course_names_collide() {
		let courses = [
			CourseFolderIdentity {
				name: "英語（A）",
				stable_id: "course-english-a",
			},
			CourseFolderIdentity {
				name: "英語［B］",
				stable_id: "course-english-b",
			},
		];
		assert_eq!(
			course_folder_name("英語（A）", &courses, None),
			"英語_course-english-a"
		);
		assert_eq!(
			course_folder_name("英語［B］", &courses, None),
			"英語_course-english-b"
		);
	}
}
