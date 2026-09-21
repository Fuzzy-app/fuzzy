//! 全文検索の範囲検証と、原文を保持した結果表示用の整形。

use std::path::Path;

use engine_core::index::{normalize_search_text, search_match_byte_range, IndexEngine};
use engine_core::types::SearchDocumentMetadata;
use engine_core::{Database, EngineError, EngineResult};

use crate::api_types::{SearchRequest, SearchResult, SearchResultSource, SearchScope};

pub(crate) const MAX_SEARCH_COURSE_IDS: usize = 200;
const DEFAULT_SEARCH_LIMIT: usize = 50;
const SEARCH_CANDIDATE_LIMIT: usize = 200;
pub(crate) const MAX_SEARCH_QUERY_CHARACTERS: usize = 256;
const MAX_SEARCH_FOLDER_CHARACTERS: usize = 512;
const SNIPPET_CONTEXT_CHARACTERS: usize = 45;
const SNIPPET_BASE_CHARACTERS: usize = 180;

pub(crate) fn execute_search(
	database: &Database,
	index_engine: &dyn IndexEngine,
	payload: SearchRequest,
) -> EngineResult<Vec<SearchResult>> {
	let query = payload.query.trim();
	if query.is_empty() || query.chars().count() > MAX_SEARCH_QUERY_CHARACTERS {
		return Err(EngineError::InvalidInput {
			field: "query".to_string(),
			reason: format!("1〜{MAX_SEARCH_QUERY_CHARACTERS}文字で指定してください"),
		});
	}
	let normalized_query = normalize_search_text(query);
	if normalized_query.is_empty() {
		return Err(EngineError::InvalidInput {
			field: "query".to_string(),
			reason: "検索できる文字を1文字以上指定してください".to_string(),
		});
	}
	let scope = normalize_search_scope(payload.scope, MAX_SEARCH_FOLDER_CHARACTERS)?;
	let allowed_file_ids = scope
		.as_ref()
		.map(|scope| {
			database.search_document_ids_in_scope(
				search_scope_course_ids(Some(scope)),
				scope.folder.as_deref(),
			)
		})
		.transpose()?;
	let hits =
		index_engine.search_scoped(query, SEARCH_CANDIDATE_LIMIT, allowed_file_ids.as_deref())?;
	let metadata_by_file = database
		.search_document_metadata_batch(&hits.iter().map(|hit| hit.file_id).collect::<Vec<_>>())?;
	let mut results = hits
		.into_iter()
		.filter_map(|hit| {
			let metadata = metadata_by_file.get(&hit.file_id)?;
			if !search_scope_matches(scope.as_ref(), metadata) {
				return None;
			}
			let file_stem = Path::new(&metadata.file_name)
				.file_stem()
				.and_then(|value| value.to_str())
				.unwrap_or(&metadata.file_name);
			let normalized_file_name = normalize_search_text(file_stem);
			let filename_boost = if normalized_file_name == normalized_query {
				0.5
			} else if normalized_file_name.contains(&normalized_query) {
				0.1
			} else {
				0.0
			};
			Some((
				SearchResult {
					file_id: metadata.file_id,
					source: SearchResultSource::File,
					file_name: metadata.file_name.clone(),
					course_name: metadata.course_name.clone(),
					relative_path: metadata.relative_path.clone(),
					snippet: hit.snippet,
					page: hit.page.filter(|page| {
						*page >= 1
							&& metadata
								.page_count
								.is_none_or(|page_count| *page <= page_count)
					}),
					page_count: metadata.page_count,
					score: hit.score + filename_boost,
					moodle_url: None,
					block_key: None,
				},
				metadata.modified_at,
			))
		})
		.collect::<Vec<_>>();
	if scope
		.as_ref()
		.and_then(|scope| scope.folder.as_ref())
		.is_none()
	{
		for block in database.search_moodle_text_blocks(
			&normalized_query,
			search_scope_course_ids(scope.as_ref()),
			DEFAULT_SEARCH_LIMIT,
		)? {
			let file_id = block
				.block_id
				.checked_neg()
				.ok_or_else(|| EngineError::Internal {
					message: "Moodle本文の検索結果IDを作成できません".to_string(),
				})?;
			results.push((
				SearchResult {
					file_id,
					source: SearchResultSource::MoodleText,
					file_name: block.title,
					course_name: Some(block.course_name),
					relative_path: "Moodle本文".to_string(),
					snippet: moodle_text_snippet(&block.body, query),
					page: None,
					page_count: None,
					score: block.score,
					moodle_url: Some(block.moodle_url),
					block_key: Some(block.block_key),
				},
				None,
			));
		}
	}
	results.sort_by(|(left, left_modified), (right, right_modified)| {
		right
			.score
			.total_cmp(&left.score)
			.then_with(|| right_modified.cmp(left_modified))
	});
	results.truncate(DEFAULT_SEARCH_LIMIT);
	Ok(results.into_iter().map(|(result, _)| result).collect())
}

pub(crate) fn moodle_text_snippet(body: &str, query: &str) -> String {
	let match_range = search_match_byte_range(body, query);
	let match_start = match_range
		.as_ref()
		.map_or(0, |range| body[..range.start].chars().count());
	let match_end = match_range
		.as_ref()
		.map_or(0, |range| body[..range.end].chars().count());
	let total_characters = body.chars().count();
	let snippet_start = match_start.saturating_sub(SNIPPET_CONTEXT_CHARACTERS);
	let snippet_end = snippet_start
		.saturating_add(SNIPPET_BASE_CHARACTERS)
		.max(match_end.saturating_add(SNIPPET_CONTEXT_CHARACTERS))
		.min(total_characters);
	let snippet = body
		.chars()
		.skip(snippet_start)
		.take(snippet_end.saturating_sub(snippet_start))
		.collect::<String>()
		.split_whitespace()
		.collect::<Vec<_>>()
		.join(" ");

	match (snippet_start > 0, snippet_end < total_characters) {
		(true, true) => format!("…{snippet}…"),
		(true, false) => format!("…{snippet}"),
		(false, true) => format!("{snippet}…"),
		(false, false) => snippet,
	}
}

pub(crate) fn normalize_search_scope(
	scope: Option<SearchScope>,
	max_folder_characters: usize,
) -> EngineResult<Option<SearchScope>> {
	let Some(mut scope) = scope else {
		return Ok(None);
	};
	if scope.course_id.is_some() && scope.course_ids.is_some() {
		return Err(EngineError::InvalidInput {
			field: "scope.courseIds".to_string(),
			reason: "courseIdとcourseIdsは同時に指定できません".to_string(),
		});
	}
	if scope.course_id.is_some_and(|course_id| course_id <= 0) {
		return Err(EngineError::InvalidInput {
			field: "scope.courseId".to_string(),
			reason: "1以上のコースIDを指定してください".to_string(),
		});
	}
	if let Some(course_ids) = scope.course_ids.as_mut() {
		if course_ids.is_empty() || course_ids.len() > MAX_SEARCH_COURSE_IDS {
			return Err(EngineError::InvalidInput {
				field: "scope.courseIds".to_string(),
				reason: format!("1〜{MAX_SEARCH_COURSE_IDS}件で指定してください"),
			});
		}
		if course_ids.iter().any(|course_id| *course_id <= 0) {
			return Err(EngineError::InvalidInput {
				field: "scope.courseIds".to_string(),
				reason: "すべて1以上のコースIDで指定してください".to_string(),
			});
		}
		course_ids.sort_unstable();
		course_ids.dedup();
	}
	if let Some(folder) = scope.folder.take() {
		let folder = folder.trim().replace('\\', "/");
		if folder.len() > max_folder_characters
			|| folder.is_empty()
			|| folder.starts_with('/')
			|| folder.ends_with('/')
			|| folder
				.split('/')
				.any(|part| part.is_empty() || part == "." || part == ".." || part.contains(':'))
		{
			return Err(EngineError::InvalidInput {
				field: "scope.folder".to_string(),
				reason: "保存ルートからの相対フォルダーを指定してください".to_string(),
			});
		}
		scope.folder = Some(folder);
	}
	if scope.course_id.is_none() && scope.course_ids.is_none() && scope.folder.is_none() {
		return Ok(None);
	}
	Ok(Some(scope))
}

pub(crate) fn search_scope_course_ids(scope: Option<&SearchScope>) -> Option<&[i64]> {
	let scope = scope?;
	if let Some(course_ids) = scope.course_ids.as_deref() {
		return Some(course_ids);
	}
	scope.course_id.as_ref().map(std::slice::from_ref)
}

pub(crate) fn search_scope_matches(
	scope: Option<&SearchScope>,
	metadata: &SearchDocumentMetadata,
) -> bool {
	let Some(scope) = scope else {
		return true;
	};
	if search_scope_course_ids(Some(scope)).is_some_and(|course_ids| {
		metadata
			.course_id
			.is_none_or(|course_id| course_ids.binary_search(&course_id).is_err())
	}) {
		return false;
	}
	scope.folder.as_ref().is_none_or(|folder| {
		let relative_path = metadata.relative_path.replace('\\', "/");
		relative_path == *folder || relative_path.starts_with(&format!("{folder}/"))
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn snippet_keeps_original_case_and_finds_normalized_query() {
		let body = format!(
			"{}Ｐｙｔｈｏｎを高速化する方法を説明します。{}",
			"前置き ".repeat(20),
			" 続き".repeat(40)
		);
		let snippet = moodle_text_snippet(&body, "Pythonを高速化");

		assert!(snippet.contains("Ｐｙｔｈｏｎを高速化"));
		assert!(!snippet.contains("ｐｙｔｈｏｎ"));
		assert!(snippet.starts_with('…'));
		assert!(snippet.ends_with('…'));
	}

	#[test]
	fn scope_deduplicates_and_sorts_course_ids() {
		let scope = normalize_search_scope(
			Some(SearchScope {
				course_id: None,
				course_ids: Some(vec![9, 2, 9]),
				folder: None,
			}),
			512,
		)
		.unwrap()
		.unwrap();

		assert_eq!(scope.course_ids, Some(vec![2, 9]));
	}

	#[test]
	fn scope_rejects_ambiguous_single_and_multiple_course_ids() {
		let error = normalize_search_scope(
			Some(SearchScope {
				course_id: Some(2),
				course_ids: Some(vec![2, 9]),
				folder: None,
			}),
			512,
		)
		.unwrap_err();

		assert!(matches!(error, EngineError::InvalidInput { .. }));
	}
}
