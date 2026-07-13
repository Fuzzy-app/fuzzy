//! Moodle資料のフォルダ名・ファイル名からセクション番号を認識する。
//!
//! 認識規則の仕様は `docs/セクション名規則.md` を参照。このモジュールは文字列の
//! 認識と正規化だけを担当し、保存先の決定やファイル操作は行わない。

use std::path::Path;

/// セクション名を認識した結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionMatch {
	/// 一致した規則の安定ID。ログやテストで判定理由を追跡するために使う。
	pub rule_id: &'static str,
	/// 認識したセクション番号。将来の番号なし規則に備えて任意値としている。
	pub number: Option<u32>,
	/// 表記揺れを除いたセクション名。
	pub normalized_name: String,
}

/// フォルダ名全体をセクション名として解析する。
///
/// 日本語は `第十二回`・`二十週` 等、英語は `Week 4`・`Unit2` 等を認識する。
pub fn parse_section_name(name: &str) -> Option<SectionMatch> {
	let normalized = name.trim().to_ascii_lowercase();
	if normalized.is_empty() {
		return None;
	}

	if let Some(rest) = normalized.strip_prefix('第') {
		let (number_text, suffix) = split_japanese_suffix(rest)?;
		let number = parse_section_number(number_text)?;
		return Some(section_match(
			"ja_ordinal",
			number,
			format!("第{number}{suffix}"),
		));
	}

	if let Some((number_text, suffix)) = split_japanese_suffix(&normalized) {
		let number = parse_section_number(number_text)?;
		return Some(section_match(
			"ja_suffixed",
			number,
			format!("第{number}{suffix}"),
		));
	}

	for (keyword, rule_id) in [
		("week", "en_week"),
		("unit", "en_unit"),
		("lesson", "en_lesson"),
		("lecture", "en_lecture"),
		("session", "en_session"),
	] {
		let Some(rest) = normalized.strip_prefix(keyword) else {
			continue;
		};
		let number = parse_section_number(rest.trim_start_matches([' ', '_', '-']))?;
		return Some(section_match(
			rule_id,
			number,
			format!("{keyword} {number}"),
		));
	}

	None
}

/// ファイル名の先頭をセクション表記として解析する。
///
/// `第十二回_資料.pdf` のような明示表記に加え、既存仕様との互換性のため
/// `09_資料.pdf`・`十二_資料.pdf` のような数字だけの接頭辞も認識する。
pub fn parse_section_file_prefix(file_name: &str) -> Option<SectionMatch> {
	let stem = Path::new(file_name).file_stem()?.to_string_lossy();
	if let Some(matched) = parse_section_name(&stem) {
		return Some(matched);
	}
	for (index, character) in stem.char_indices().rev() {
		if !is_file_name_separator(character) {
			continue;
		}
		if let Some(matched) = parse_section_name(stem[..index].trim_end()) {
			return Some(matched);
		}
	}

	let first_part = stem.split(is_file_name_separator).next()?.trim();
	let number = parse_section_number(first_part)?;
	Some(section_match(
		"numeric_file_prefix",
		number,
		number.to_string(),
	))
}

fn is_file_name_separator(character: char) -> bool {
	matches!(character, '_' | '-' | ' ' | '　')
}

fn section_match(rule_id: &'static str, number: u32, normalized_name: String) -> SectionMatch {
	SectionMatch {
		rule_id,
		number: Some(number),
		normalized_name,
	}
}

fn split_japanese_suffix(value: &str) -> Option<(&str, char)> {
	for suffix in ['回', '週', '講', '章'] {
		if let Some(number) = value.strip_suffix(suffix) {
			return Some((number, suffix));
		}
	}
	None
}

/// 半角・全角のアラビア数字、または一般的な漢数字を数値へ変換する。
fn parse_section_number(value: &str) -> Option<u32> {
	let value = value.trim();
	if value.is_empty() {
		return None;
	}

	if value
		.chars()
		.all(|character| arabic_digit(character).is_some())
	{
		return parse_positional_digits(value, arabic_digit);
	}

	if !value
		.chars()
		.any(|character| matches!(character, '十' | '百' | '千'))
	{
		return parse_positional_digits(value, kanji_digit);
	}

	parse_kanji_with_units(value)
}

fn parse_positional_digits(value: &str, digit: fn(char) -> Option<u32>) -> Option<u32> {
	value.chars().try_fold(0_u32, |number, character| {
		number.checked_mul(10)?.checked_add(digit(character)?)
	})
}

fn parse_kanji_with_units(value: &str) -> Option<u32> {
	let mut total = 0_u32;
	let mut pending_digit = None;
	let mut previous_unit = u32::MAX;

	for character in value.chars() {
		if let Some(digit) = kanji_digit(character) {
			// `二三十` のような曖昧な単位付き表記は受け付けない。
			if pending_digit.replace(digit).is_some() {
				return None;
			}
			continue;
		}

		let unit = match character {
			'十' => 10,
			'百' => 100,
			'千' => 1_000,
			_ => return None,
		};
		// `十百` のように単位が大きくなる表記は不正とする。
		if unit >= previous_unit {
			return None;
		}
		let coefficient = pending_digit.take().unwrap_or(1);
		if coefficient == 0 {
			return None;
		}
		total = total.checked_add(coefficient.checked_mul(unit)?)?;
		previous_unit = unit;
	}

	total.checked_add(pending_digit.unwrap_or_default())
}

fn arabic_digit(character: char) -> Option<u32> {
	character.to_digit(10).or_else(|| {
		('０'..='９')
			.contains(&character)
			.then(|| u32::from(character) - u32::from('０'))
	})
}

fn kanji_digit(character: char) -> Option<u32> {
	match character {
		'〇' | '零' => Some(0),
		'一' => Some(1),
		'二' => Some(2),
		'三' => Some(3),
		'四' => Some(4),
		'五' => Some(5),
		'六' => Some(6),
		'七' => Some(7),
		'八' => Some(8),
		'九' => Some(9),
		_ => None,
	}
}
