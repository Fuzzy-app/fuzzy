use engine_core::section::{parse_section_file_prefix, parse_section_name};

#[test]
fn recognizes_arabic_and_kanji_section_names() {
	for (input, rule_id, number, normalized) in [
		("第4回", "ja_ordinal", 4, "第4回"),
		("第４週", "ja_ordinal", 4, "第4週"),
		("第十二回", "ja_ordinal", 12, "第12回"),
		("二十週", "ja_suffixed", 20, "第20週"),
		("第百一講", "ja_ordinal", 101, "第101講"),
		("二〇章", "ja_suffixed", 20, "第20章"),
		("Week 4", "en_week", 4, "week 4"),
		("Unit２", "en_unit", 2, "unit 2"),
		("Lesson-3", "en_lesson", 3, "lesson 3"),
		("Lecture_5", "en_lecture", 5, "lecture 5"),
		("Session6", "en_session", 6, "session 6"),
	] {
		let matched = parse_section_name(input).expect("セクション名を認識できる");
		assert_eq!(matched.rule_id, rule_id, "入力: {input}");
		assert_eq!(matched.number, Some(number), "入力: {input}");
		assert_eq!(matched.normalized_name, normalized, "入力: {input}");
	}
}

#[test]
fn recognizes_file_name_prefixes_without_scanning_the_middle() {
	for (input, rule_id, number) in [
		("第十二回_講義資料.pdf", "ja_ordinal", 12),
		("Week 4 - reading.pdf", "en_week", 4),
		("09_講義資料.pdf", "numeric_file_prefix", 9),
		("十二_演習課題.docx", "numeric_file_prefix", 12),
	] {
		let matched = parse_section_file_prefix(input).expect("接頭辞を認識できる");
		assert_eq!(matched.rule_id, rule_id, "入力: {input}");
		assert_eq!(matched.number, Some(number), "入力: {input}");
	}

	for input in ["講義資料_第4回.pdf", "report2026.pdf", "v2_改訂版.pdf"] {
		assert!(parse_section_file_prefix(input).is_none(), "入力: {input}");
	}
}

#[test]
fn rejects_ambiguous_or_unsupported_names() {
	for input in [
		"2026前期",
		"資料4",
		"データベース2",
		"第回",
		"二三十回",
		"十百回",
		"第一万回",
		"講義資料",
	] {
		assert!(parse_section_name(input).is_none(), "入力: {input}");
	}
}
