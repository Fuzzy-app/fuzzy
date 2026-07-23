//! Windowsの単一パス要素に共通する検証。

use crate::error::{EngineError, EngineResult};

pub(crate) const WINDOWS_COMPONENT_MAX_UTF16_UNITS: usize = 255;

pub(crate) fn validate_windows_component(field: &str, value: &str) -> EngineResult<()> {
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
	if utf16_len(value) > WINDOWS_COMPONENT_MAX_UTF16_UNITS {
		return Err(EngineError::InvalidInput {
			field: field.to_string(),
			reason: format!(
				"Windowsの名前はUTF-16で{WINDOWS_COMPONENT_MAX_UTF16_UNITS}コード単位以内にしてください"
			),
		});
	}
	Ok(())
}

pub(crate) fn is_windows_reserved_name(value: &str) -> bool {
	let value = value.to_ascii_lowercase();
	matches!(value.as_str(), "con" | "prn" | "aux" | "nul")
		|| value
			.strip_prefix("com")
			.or_else(|| value.strip_prefix("lpt"))
			.is_some_and(|number| {
				matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
			})
}

pub(crate) fn utf16_len(value: &str) -> usize {
	value.encode_utf16().count()
}
