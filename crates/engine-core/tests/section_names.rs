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
fn recognizes_section_markers_at_the_start_of_file_names() {
	for (input, number) in [
		("第十二回_講義資料.pdf", 12),
		("十二_講義資料.pdf", 12),
		("09_演習課題.docx", 9),
		("０４-配布資料.pptx", 4),
		("Week 4_lecture.pdf", 4),
		("第十三回　補講資料.pdf", 13),
	] {
		let matched = parse_section_file_prefix(input).expect("接頭辞を認識できる");
		assert_eq!(matched.number, Some(number), "入力: {input}");
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
