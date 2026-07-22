//! ルールテンプレートの構文検証・展開とWindowsパス照合。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::error::{EngineError, EngineResult};
use crate::types::RuleContext;

const ALLOWED_TOKENS: [&str; 5] = ["year", "term", "course", "assignment", "section"];

#[derive(Debug, Clone, PartialEq, Eq)]
enum MatchPart {
	Literal(String),
	MissingToken(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ExpectedRelativePath {
	segments: Vec<Vec<MatchPart>>,
}

impl ExpectedRelativePath {
	pub(super) fn new(pattern: &str, context: &RuleContext) -> EngineResult<Self> {
		let segments = pattern
			.trim()
			.split(['/', '\\'])
			.map(|segment| expected_segment(segment.trim(), context))
			.collect::<EngineResult<Vec<_>>>()?;
		Ok(Self { segments })
	}

	pub(super) fn matches(&self, actual_components: &[String]) -> bool {
		self.segments.len() == actual_components.len()
			&& self
				.segments
				.iter()
				.zip(actual_components)
				.all(|(expected, actual)| segment_matches(expected, actual))
	}

	pub(super) fn missing_tokens(&self) -> Vec<&'static str> {
		let mut missing = BTreeSet::new();
		for segment in &self.segments {
			for part in segment {
				if let MatchPart::MissingToken(token) = part {
					missing.insert(*token);
				}
			}
		}
		missing.into_iter().collect()
	}

	pub(super) fn render_complete(&self) -> EngineResult<String> {
		let missing = self.missing_tokens();
		if !missing.is_empty() {
			return Err(EngineError::InvalidInput {
				field: missing.join(","),
				reason: "テンプレート展開に必要な値がありません".to_string(),
			});
		}
		Ok(self
			.segments
			.iter()
			.map(|segment| {
				segment
					.iter()
					.filter_map(|part| match part {
						MatchPart::Literal(value) => Some(value.as_str()),
						MatchPart::MissingToken(_) => None,
					})
					.collect::<String>()
			})
			.collect::<Vec<_>>()
			.join("\\"))
	}
}

fn expected_segment(segment: &str, context: &RuleContext) -> EngineResult<Vec<MatchPart>> {
	let mut parts = Vec::new();
	let mut rest = segment;
	while let Some(open) = rest.find('{') {
		if open > 0 {
			parts.push(MatchPart::Literal(rest[..open].to_string()));
		}
		let after_open = &rest[open + 1..];
		let close = after_open
			.find('}')
			.ok_or_else(|| invalid_pattern("波括弧が対応していません"))?;
		let token = &after_open[..close];
		let value = context_value(context, token);
		match value {
			Some(value) => {
				validate_windows_component(token, value)?;
				parts.push(MatchPart::Literal(value.to_string()));
			}
			None => parts.push(MatchPart::MissingToken(token_label(token))),
		}
		rest = &after_open[close + 1..];
	}
	if !rest.is_empty() {
		parts.push(MatchPart::Literal(rest.to_string()));
	}
	Ok(parts)
}

fn context_value<'a>(context: &'a RuleContext, token: &str) -> Option<&'a str> {
	match token {
		"year" => context.year.as_deref(),
		"term" => context.term.as_deref(),
		"course" => context.course_name.as_deref(),
		"assignment" => context.assignment.as_deref(),
		"section" => context.section.as_deref(),
		_ => None,
	}
	.map(str::trim)
}

fn token_label(token: &str) -> &'static str {
	match token {
		"year" => "年度",
		"term" => "学期",
		"course" => "コース名",
		"assignment" => "課題名",
		"section" => "セクション",
		_ => "不明な項目",
	}
}

fn segment_matches(expected: &[MatchPart], actual: &str) -> bool {
	let actual = actual.to_lowercase();
	let expected = expected
		.iter()
		.map(|part| match part {
			MatchPart::Literal(value) => MatchPart::Literal(value.to_lowercase()),
			MatchPart::MissingToken(token) => MatchPart::MissingToken(token),
		})
		.collect::<Vec<_>>();
	match_parts(&expected, &actual)
}

fn match_parts(parts: &[MatchPart], actual: &str) -> bool {
	let Some((part, rest)) = parts.split_first() else {
		return actual.is_empty();
	};
	match part {
		MatchPart::Literal(value) => actual
			.strip_prefix(value)
			.is_some_and(|remaining| match_parts(rest, remaining)),
		MatchPart::MissingToken(_) => char_boundaries_after_first(actual)
			.into_iter()
			.any(|end| match_parts(rest, &actual[end..])),
	}
}

fn char_boundaries_after_first(value: &str) -> Vec<usize> {
	value
		.char_indices()
		.skip(1)
		.map(|(index, _)| index)
		.chain(std::iter::once(value.len()))
		.collect()
}

pub(super) fn validate_pattern(field: &str, pattern: &str) -> EngineResult<()> {
	let pattern = pattern.trim();
	if pattern.is_empty() {
		return Err(EngineError::InvalidInput {
			field: field.to_string(),
			reason: "テンプレートを入力してください".to_string(),
		});
	}
	if is_rooted_path_text(pattern) {
		return Err(EngineError::InvalidInput {
			field: field.to_string(),
			reason: "絶対パスやUNCパスは指定できません".to_string(),
		});
	}
	let tokens = pattern_tokens(pattern)?;
	if !tokens.iter().any(|token| token == "course") {
		return Err(EngineError::InvalidInput {
			field: field.to_string(),
			reason: "テンプレートには {course} を含めてください".to_string(),
		});
	}

	for segment in pattern.split(['/', '\\']) {
		if segment.is_empty() {
			return Err(EngineError::InvalidInput {
				field: field.to_string(),
				reason: "空のフォルダ階層は指定できません".to_string(),
			});
		}
		let static_segment = replace_tokens_with_placeholder(segment)?;
		validate_windows_component(field, &static_segment)?;
	}
	Ok(())
}

pub(super) fn pattern_tokens(pattern: &str) -> EngineResult<Vec<String>> {
	let mut tokens = Vec::new();
	let mut rest = pattern;
	while let Some(open) = rest.find('{') {
		if rest[..open].contains('}') {
			return Err(invalid_pattern("波括弧が対応していません"));
		}
		let after_open = &rest[open + 1..];
		let close = after_open
			.find('}')
			.ok_or_else(|| invalid_pattern("波括弧が対応していません"))?;
		let token = &after_open[..close];
		if token.contains(['{', '}']) || !ALLOWED_TOKENS.contains(&token) {
			return Err(invalid_pattern(&format!(
				"未対応の項目 {{{token}}} が含まれています"
			)));
		}
		tokens.push(token.to_string());
		rest = &after_open[close + 1..];
	}
	if rest.contains(['{', '}']) {
		return Err(invalid_pattern("波括弧が対応していません"));
	}
	Ok(tokens)
}

fn replace_tokens_with_placeholder(segment: &str) -> EngineResult<String> {
	let mut result = String::new();
	let mut rest = segment;
	while let Some(open) = rest.find('{') {
		result.push_str(&rest[..open]);
		let after_open = &rest[open + 1..];
		let close = after_open
			.find('}')
			.ok_or_else(|| invalid_pattern("波括弧が対応していません"))?;
		result.push('x');
		rest = &after_open[close + 1..];
	}
	result.push_str(rest);
	Ok(result.trim().to_string())
}

pub(super) fn validate_file_name(file_name: &str) -> EngineResult<()> {
	validate_windows_component("file_name", file_name)
}

fn validate_windows_component(field: &str, value: &str) -> EngineResult<()> {
	if value.is_empty() {
		return Err(EngineError::InvalidInput {
			field: field.to_string(),
			reason: "空の名前は使用できません".to_string(),
		});
	}
	if value == "." || value == ".." {
		return Err(EngineError::InvalidInput {
			field: field.to_string(),
			reason: ". や .. は使用できません".to_string(),
		});
	}
	if value.ends_with(['.', ' ']) {
		return Err(EngineError::InvalidInput {
			field: field.to_string(),
			reason: "末尾にピリオドや空白は使用できません".to_string(),
		});
	}
	if value
		.chars()
		.any(|character| character.is_control() || r#"<>:"/\|?*"#.contains(character))
	{
		return Err(EngineError::InvalidInput {
			field: field.to_string(),
			reason: "Windowsの名前に使用できない文字が含まれています".to_string(),
		});
	}
	let stem = value.split('.').next().unwrap_or(value);
	if is_windows_reserved_name(stem) {
		return Err(EngineError::InvalidInput {
			field: field.to_string(),
			reason: format!("Windowsの予約名 {stem} は使用できません"),
		});
	}
	Ok(())
}

fn is_windows_reserved_name(value: &str) -> bool {
	let value = value.to_ascii_lowercase();
	matches!(value.as_str(), "con" | "prn" | "aux" | "nul")
		|| value
			.strip_prefix("com")
			.or_else(|| value.strip_prefix("lpt"))
			.is_some_and(|number| {
				matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
			})
}

fn invalid_pattern(reason: &str) -> EngineError {
	EngineError::InvalidInput {
		field: "pattern_template".to_string(),
		reason: reason.to_string(),
	}
}

pub(super) fn validate_base_folder(base_folder: &Path) -> EngineResult<()> {
	let value = base_folder.to_string_lossy();
	if value.is_empty() || !is_absolute_path_text(&value) {
		return Err(EngineError::InvalidPath {
			path: value.into_owned(),
			reason: "保存ルートには絶対パスを指定してください".to_string(),
		});
	}
	Ok(())
}

fn is_absolute_path_text(value: &str) -> bool {
	value.starts_with('/') || value.starts_with("\\\\") || has_windows_drive_prefix(value)
}

fn is_rooted_path_text(value: &str) -> bool {
	value.starts_with(['/', '\\']) || has_windows_drive_prefix(value)
}

fn has_windows_drive_prefix(value: &str) -> bool {
	value.len() >= 3
		&& value.as_bytes()[0].is_ascii_alphabetic()
		&& value.as_bytes()[1] == b':'
		&& matches!(value.as_bytes()[2], b'/' | b'\\')
}

pub(super) fn relative_components(base_folder: &Path, saved_path: &Path) -> Option<Vec<String>> {
	let base = path_components(base_folder)?;
	let saved = path_components(saved_path)?;
	if saved.len() <= base.len()
		|| !base
			.iter()
			.zip(&saved)
			.all(|(base, saved)| base.to_lowercase() == saved.to_lowercase())
	{
		return None;
	}
	Some(saved[base.len()..].to_vec())
}

fn path_components(path: &Path) -> Option<Vec<String>> {
	let value = path.to_string_lossy();
	if !is_absolute_path_text(&value) {
		return None;
	}
	let components = value
		.split(['/', '\\'])
		.filter(|component| !component.is_empty())
		.map(str::to_string)
		.collect::<Vec<_>>();
	if components.is_empty()
		|| components
			.iter()
			.any(|component| component == "." || component == "..")
	{
		return None;
	}
	Some(components)
}

pub(super) fn join_relative_path(base_folder: &Path, relative: &str) -> PathBuf {
	relative
		.split('\\')
		.fold(base_folder.to_path_buf(), |path, segment| {
			path.join(segment)
		})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn validates_the_same_rule_boundaries_as_the_api_contract() {
		for invalid in [
			"C:\\資料\\{course}",
			r"\\server\share\{course}",
			"{term}/../{course}",
			"{term}/{unknown}/{course}",
			"{term}//{course}",
			"{term}/CON/{course}",
		] {
			assert!(
				validate_pattern("pattern", invalid).is_err(),
				"入力: {invalid}"
			);
		}
		assert!(validate_pattern("pattern", "{term}/{course}/第{section}回").is_ok());
	}

	#[test]
	fn compares_windows_paths_without_host_os_separator_assumptions() {
		let context = RuleContext {
			course_name: Some("データベース".to_string()),
			term: Some("2026前期".to_string()),
			section: Some("4".to_string()),
			..RuleContext::default()
		};
		let expected =
			ExpectedRelativePath::new("{term}/{course}/第{section}回", &context).unwrap();
		let actual = relative_components(
			Path::new(r"C:\Users\sample\Documents\大学"),
			Path::new(
				r"c:/users/sample/documents/大学/2026前期/データベース/第4回/第4回_正規化.pdf",
			),
		)
		.unwrap();
		assert!(expected.matches(&actual[..actual.len() - 1]));
	}
}
