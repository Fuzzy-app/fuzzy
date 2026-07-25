//! コース名に含まれる括弧書きのうち、明確な補足だけを取り除く。
//!
//! 未知の表記はコースを区別する情報かもしれないため保持する。括弧が壊れている範囲も
//! 推測で修復せず、そのまま残す。

#[derive(Debug, Clone, Copy)]
struct BracketPair {
	start: usize,
	content_start: usize,
	content_end: usize,
	end: usize,
	has_child: bool,
}

#[derive(Debug, Clone, Copy)]
struct OpenBracket {
	character: char,
	start: usize,
	content_start: usize,
	has_child: bool,
}

pub(crate) fn remove_supplemental_notes(value: &str) -> String {
	let mut current = value.to_string();
	loop {
		let pairs = balanced_bracket_pairs(&current);
		let mut removable = pairs
			.into_iter()
			.filter(|pair| {
				!pair.has_child
					&& is_supplemental_note(&current[pair.content_start..pair.content_end])
			})
			.collect::<Vec<_>>();
		if removable.is_empty() {
			return current;
		}
		removable.sort_by_key(|pair| pair.start);
		for pair in removable.into_iter().rev() {
			current.replace_range(pair.start..pair.end, "");
		}
	}
}

fn balanced_bracket_pairs(value: &str) -> Vec<BracketPair> {
	let mut stack = Vec::<OpenBracket>::new();
	let mut pairs = Vec::new();
	let mut invalid_ranges = Vec::new();
	for (index, character) in value.char_indices() {
		if matches!(character, '(' | '[') {
			stack.push(OpenBracket {
				character,
				start: index,
				content_start: index + character.len_utf8(),
				has_child: false,
			});
			continue;
		}
		let expected_open = match character {
			')' => '(',
			']' => '[',
			_ => continue,
		};
		let Some(open) = stack.last().copied() else {
			continue;
		};
		if open.character != expected_open {
			// 交差した括弧の範囲内では、内側だけが整形式でも削除しない。
			invalid_ranges.push((stack[0].start, index + character.len_utf8()));
			stack.clear();
			continue;
		}
		stack.pop();
		if let Some(parent) = stack.last_mut() {
			parent.has_child = true;
		}
		pairs.push(BracketPair {
			start: open.start,
			content_start: open.content_start,
			content_end: index,
			end: index + character.len_utf8(),
			has_child: open.has_child,
		});
	}
	if let Some(open) = stack.first() {
		invalid_ranges.push((open.start, value.len()));
	}
	pairs.retain(|pair| {
		!invalid_ranges
			.iter()
			.any(|(start, end)| pair.start >= *start && pair.end <= *end)
	});
	pairs
}

fn is_supplemental_note(value: &str) -> bool {
	let value = value.trim();
	value.is_empty()
		|| is_academic_period_note(value)
		|| is_staff_note(value)
		|| value == "配布資料"
}

fn is_academic_period_note(value: &str) -> bool {
	let compact = value
		.chars()
		.filter(|character| !character.is_whitespace())
		.collect::<String>();
	if is_academic_term(&compact) {
		return true;
	}
	let year_end = compact
		.char_indices()
		.nth(4)
		.map_or(compact.len(), |(index, _)| index);
	let year_text = &compact[..year_end];
	if year_text.chars().count() != 4
		|| !year_text
			.chars()
			.all(|character| character.is_ascii_digit())
	{
		return false;
	}
	let Ok(year) = year_text.parse::<u16>() else {
		return false;
	};
	if !(1900..=9999).contains(&year) {
		return false;
	}
	let mut remainder = &compact[year_end..];
	if let Some(without_year_label) = remainder.strip_prefix("年度") {
		remainder = without_year_label;
	}
	remainder = remainder.trim_start_matches(['・', ',', '/', '-']);
	remainder.is_empty() || is_academic_term(remainder)
}

fn is_academic_term(value: &str) -> bool {
	matches!(value, "前期" | "後期" | "通年")
}

fn is_staff_note(value: &str) -> bool {
	["担当教員", "担当者", "担当", "教員", "講師"]
		.into_iter()
		.any(|label| {
			value
				.strip_prefix(label)
				.and_then(|rest| rest.trim_start().strip_prefix(':'))
				.is_some_and(|rest| !rest.trim().is_empty())
		})
}
