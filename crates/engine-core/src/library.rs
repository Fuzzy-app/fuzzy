//! 保存ルートを明示的に再走査し、SQLite注釈と全文索引を整合させる保守処理。

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path};

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::duplicate::{DefaultDuplicateDetector, DuplicateDetector, DEFAULT_SIMILARITY_THRESHOLD};
use crate::index::IndexEngine;
use crate::rule::DefaultRuleEngine;
use crate::scan::{DefaultScanEngine, ScanEngine};
use crate::section::{parse_section_file_prefix, parse_section_name};
use crate::types::{FileEntry, SavedFileRegistration};
use crate::{Database, EngineResult};

const MAX_WARNINGS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMaintenanceWarning {
	pub path: String,
	pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMaintenanceSummary {
	pub scanned_file_count: usize,
	pub registered_file_count: usize,
	pub updated_file_count: usize,
	pub indexed_file_count: usize,
	pub missing_file_count: usize,
	pub skipped_file_count: usize,
	pub warnings: Vec<LibraryMaintenanceWarning>,
}

#[derive(Debug, Default)]
pub struct LibraryMaintenance;

impl LibraryMaintenance {
	/// 設定済み保存ルートを読み取り、ファイルを移動・削除せずにDBと索引を整合させる。
	///
	/// `rebuild_index`では物理索引をいったん空にしてから、走査時点で実在する対応文書を
	/// すべて再投入する。falseでは新規・本文変更・索引メタ欠落の文書だけを更新する。
	pub fn reconcile(
		database: &mut Database,
		index_engine: &mut dyn IndexEngine,
		rebuild_index: bool,
	) -> EngineResult<LibraryMaintenanceSummary> {
		let root = database.base_folder_path()?;
		let course_segment_index = database.initial_scan_course_segment_index()?;
		let snapshot = DefaultScanEngine.scan(&root)?;
		let course_context_counts =
			scan_course_context_counts(&snapshot.entries, course_segment_index);
		let mut summary = LibraryMaintenanceSummary {
			scanned_file_count: snapshot.entries.len(),
			..Default::default()
		};
		let mut omitted_warnings = 0usize;
		for warning in snapshot.warnings {
			summary.skipped_file_count += 1;
			push_warning(
				&mut summary.warnings,
				&mut omitted_warnings,
				relative_display(&warning.path),
				warning.message,
			);
		}

		let detector = DefaultDuplicateDetector::default();
		let mut index_candidates = Vec::new();
		for entry in snapshot.entries {
			let course_id = match course_context_at(&entry, course_segment_index) {
				Some(course) => match database.ensure_contextual_local_scan_course(
					&course.name,
					&course.identity,
					course.academic_year,
					course.term.as_deref(),
					course_context_counts
						.get(&course.name)
						.is_some_and(|contexts| contexts.len() == 1),
				) {
					Ok(course_id) => Some(course_id),
					Err(error) => {
						eprintln!(
							"走査ファイルのローカルコースを登録できませんでした（{}）: {error}",
							entry.path.display()
						);
						push_warning(
							&mut summary.warnings,
							&mut omitted_warnings,
							relative_display(&entry.relative_path),
							"コース名を登録できなかったため、未分類の資料として登録しました。"
								.to_string(),
						);
						None
					}
				},
				None => None,
			};
			let fingerprint = match detector.fingerprint(&entry.path) {
				Ok(fingerprint) => fingerprint,
				Err(error) => {
					eprintln!(
						"走査ファイルのフィンガープリントを計算できませんでした（{}）: {error}",
						entry.path.display()
					);
					summary.skipped_file_count += 1;
					push_warning(
						&mut summary.warnings,
						&mut omitted_warnings,
						relative_display(&entry.relative_path),
						"ファイルを読み取れなかったため、登録を見送りました。".to_string(),
					);
					continue;
				}
			};
			let Ok(size_bytes) = i64::try_from(entry.size) else {
				summary.skipped_file_count += 1;
				push_warning(
					&mut summary.warnings,
					&mut omitted_warnings,
					relative_display(&entry.relative_path),
					"ファイルサイズが上限を超えるため、登録を見送りました。".to_string(),
				);
				continue;
			};
			let registration = SavedFileRegistration {
				course_id,
				section_no: infer_section_number(&entry),
				moodle_file_id: None,
				original_name: entry.file_name.clone(),
				saved_path: entry.path.clone(),
				size_bytes,
				mime_type: document_mime_type(&entry.path).map(str::to_string),
				hash_blake3: fingerprint.hash_blake3,
				simhash: fingerprint.simhash,
			};
			let upserted = match database.upsert_scanned_file(&registration) {
				Ok(upserted) => upserted,
				Err(error) => {
					eprintln!(
						"走査ファイルをSQLiteへ登録できませんでした（{}）: {error}",
						entry.path.display()
					);
					summary.skipped_file_count += 1;
					push_warning(
						&mut summary.warnings,
						&mut omitted_warnings,
						relative_display(&entry.relative_path),
						"SQLiteへ登録できなかったため、この資料を見送りました。".to_string(),
					);
					continue;
				}
			};
			if upserted.inserted {
				summary.registered_file_count += 1;
			} else if upserted.updated {
				summary.updated_file_count += 1;
			}
			if is_indexable_document(&entry.path) && (rebuild_index || upserted.needs_index) {
				index_candidates.push((upserted.file_id, entry.path, entry.relative_path));
			} else if !is_indexable_document(&entry.path) {
				summary.skipped_file_count += 1;
			}
		}

		reconcile_missing_files(
			database,
			index_engine,
			&root,
			rebuild_index,
			&mut summary,
			&mut omitted_warnings,
		)?;

		if rebuild_index {
			// SQLiteを正本として先に「未索引」へ戻す。物理索引の削除に失敗しても
			// 古いヒットは公開されず、次回の通常再走査で全実在ファイルを再投入できる。
			database.clear_search_index_meta()?;
			index_engine.clear()?;
			// 別プロセスの保存処理が上の2操作の間に完了しても、削除済みの物理索引を
			// 「索引済み」と誤認しないよう、クリア直後にもう一度無効化する。
			database.clear_search_index_meta()?;
		}
		for (file_id, path, relative_path) in index_candidates {
			match index_engine.index_file(database, file_id, &path) {
				Ok(()) => summary.indexed_file_count += 1,
				Err(error) => {
					eprintln!(
						"走査ファイルを全文索引へ追加できませんでした（{}）: {error}",
						path.display()
					);
					summary.skipped_file_count += 1;
					push_warning(
						&mut summary.warnings,
						&mut omitted_warnings,
						relative_display(&relative_path),
						"本文を索引化できませんでした。再スキャンで再試行できます。".to_string(),
					);
				}
			}
		}

		if let Err(error) = database.refresh_rule_compliance(&DefaultRuleEngine) {
			eprintln!("ライブラリ走査後のルール適合状況を更新できませんでした: {error}");
			push_warning(
				&mut summary.warnings,
				&mut omitted_warnings,
				".".to_string(),
				"ルール整合性の再計算に失敗しました。再スキャンで再試行できます。".to_string(),
			);
		}
		if let Err(error) =
			database.refresh_duplicate_groups(&detector, DEFAULT_SIMILARITY_THRESHOLD)
		{
			eprintln!("ライブラリ走査後の重複グループを更新できませんでした: {error}");
			push_warning(
				&mut summary.warnings,
				&mut omitted_warnings,
				".".to_string(),
				"重複候補の再計算に失敗しました。再スキャンで再試行できます。".to_string(),
			);
		}
		if let Err(error) = database.mark_library_scan_completed() {
			eprintln!("ライブラリ走査の完了時刻を保存できませんでした: {error}");
			push_warning(
				&mut summary.warnings,
				&mut omitted_warnings,
				".".to_string(),
				"再スキャンの完了日時を保存できませんでした。".to_string(),
			);
		}
		if omitted_warnings > 0 {
			if summary.warnings.len() == MAX_WARNINGS {
				summary.warnings.pop();
			}
			summary.warnings.push(LibraryMaintenanceWarning {
				path: ".".to_string(),
				message: format!("ほか{omitted_warnings}件の警告があります。"),
			});
		}
		Ok(summary)
	}
}

fn reconcile_missing_files(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	root: &Path,
	rebuild_index: bool,
	summary: &mut LibraryMaintenanceSummary,
	omitted_warnings: &mut usize,
) -> EngineResult<()> {
	for registered in database.registered_library_files()? {
		let Ok(relative_path) = registered.saved_path.strip_prefix(root) else {
			continue;
		};
		let missing_reason = match std::fs::metadata(&registered.saved_path) {
			Ok(metadata) if metadata.is_file() => None,
			Ok(_) => Some("登録済みのパスがファイルではありません。履歴を保持したまま通常表示から除外しました。".to_string()),
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(
				"登録済みの資料が見つかりません。履歴を保持したまま通常表示から除外しました。"
					.to_string(),
			),
			Err(error) => {
				summary.skipped_file_count += 1;
				push_warning(
					&mut summary.warnings,
					omitted_warnings,
					relative_display(relative_path),
					format!("登録済み資料の実体を確認できませんでした: {error}"),
				);
				continue;
			}
		};
		let Some(reason) = missing_reason else {
			continue;
		};

		if let Err(error) = database.update_library_file_presence(registered.file_id, false) {
			summary.skipped_file_count += 1;
			push_warning(
				&mut summary.warnings,
				omitted_warnings,
				relative_display(relative_path),
				format!("欠損状態をSQLiteへ保存できませんでした: {error}"),
			);
			continue;
		}
		summary.missing_file_count += 1;
		push_warning(
			&mut summary.warnings,
			omitted_warnings,
			relative_display(relative_path),
			reason,
		);
		if !rebuild_index {
			if let Err(error) = index_engine.remove_file(database, registered.file_id) {
				summary.skipped_file_count += 1;
				push_warning(
					&mut summary.warnings,
					omitted_warnings,
					relative_display(relative_path),
					format!("欠損資料を検索索引から除外できませんでした: {error}"),
				);
			}
		}
	}
	Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScannedCourseContext {
	name: String,
	identity: String,
	academic_year: Option<i64>,
	term: Option<String>,
}

fn scan_course_context_counts(
	entries: &[FileEntry],
	index: Option<usize>,
) -> HashMap<String, HashSet<String>> {
	let mut contexts = HashMap::<String, HashSet<String>>::new();
	for entry in entries {
		if let Some(course) = course_context_at(entry, index) {
			contexts
				.entry(course.name)
				.or_default()
				.insert(course.identity);
		}
	}
	contexts
}

fn course_context_at(entry: &FileEntry, index: Option<usize>) -> Option<ScannedCourseContext> {
	let index = index?;
	let components = entry
		.relative_path
		.components()
		.take(index + 1)
		.map(|component| match component {
			Component::Normal(value) => value.to_str().map(str::trim),
			_ => None,
		})
		.collect::<Option<Vec<_>>>()?;
	if components.len() != index + 1 {
		return None;
	}
	let name = components[index];
	if name.is_empty() || name.len() > 512 {
		return None;
	}
	let identity = components
		.iter()
		.map(|component| {
			component
				.nfkc()
				.flat_map(char::to_lowercase)
				.collect::<String>()
		})
		.collect::<Vec<_>>()
		.join("/");
	let parent_components = &components[..index];
	let academic_year = parent_components
		.iter()
		.rev()
		.find_map(|component| parse_exact_academic_year(component));
	let term = parent_components
		.iter()
		.rev()
		.find_map(|component| normalize_term_component(component));
	Some(ScannedCourseContext {
		name: name.to_string(),
		identity,
		academic_year,
		term,
	})
}

fn parse_exact_academic_year(value: &str) -> Option<i64> {
	if value.len() != 4 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	value
		.parse::<i64>()
		.ok()
		.filter(|year| (1900..=9999).contains(year))
}

fn normalize_term_component(value: &str) -> Option<String> {
	let normalized = value.trim();
	matches!(
		normalized,
		"前期" | "後期" | "通年" | "春学期" | "秋学期" | "Spring" | "Fall"
	)
	.then(|| normalized.to_string())
}

fn infer_section_number(entry: &FileEntry) -> Option<i64> {
	parse_section_file_prefix(&entry.file_name)
		.and_then(|section| section.number)
		.or_else(|| {
			entry
				.relative_path
				.parent()
				.into_iter()
				.flat_map(Path::components)
				.filter_map(|component| match component {
					Component::Normal(value) => value.to_str(),
					_ => None,
				})
				.find_map(|value| parse_section_name(value).and_then(|section| section.number))
		})
		.map(i64::from)
}

/// 全文索引エンジンが内容抽出に対応している文書形式かを判定する。
pub fn is_indexable_document(path: &Path) -> bool {
	matches!(
		path.extension()
			.and_then(|extension| extension.to_str())
			.map(str::to_ascii_lowercase)
			.as_deref(),
		Some("pdf" | "docx" | "pptx" | "xlsx" | "txt" | "md" | "csv" | "json" | "html" | "htm")
	)
}

/// 登録済み文書へ保存する既知のMIME typeを拡張子から返す。
pub fn document_mime_type(path: &Path) -> Option<&'static str> {
	match path
		.extension()
		.and_then(|extension| extension.to_str())
		.map(str::to_ascii_lowercase)
		.as_deref()
	{
		Some("pdf") => Some("application/pdf"),
		Some("docx") => {
			Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
		}
		Some("pptx") => {
			Some("application/vnd.openxmlformats-officedocument.presentationml.presentation")
		}
		Some("xlsx") => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
		Some("txt" | "md" | "csv") => Some("text/plain"),
		Some("json") => Some("application/json"),
		Some("html" | "htm") => Some("text/html"),
		Some("zip") => Some("application/zip"),
		_ => None,
	}
}

fn relative_display(path: &Path) -> String {
	let value = path.to_string_lossy().replace('\\', "/");
	if value.is_empty() {
		".".to_string()
	} else {
		value
	}
}

fn push_warning(
	warnings: &mut Vec<LibraryMaintenanceWarning>,
	omitted: &mut usize,
	path: String,
	message: String,
) {
	if warnings.len() < MAX_WARNINGS {
		warnings.push(LibraryMaintenanceWarning { path, message });
	} else {
		*omitted += 1;
	}
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;
	use std::time::{SystemTime, UNIX_EPOCH};

	use rusqlite::params;

	use super::*;
	use crate::index::DefaultIndexEngine;
	use crate::types::SearchHit;

	struct TestDirectory {
		path: PathBuf,
	}

	impl TestDirectory {
		fn new() -> Self {
			let suffix = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.unwrap()
				.as_nanos();
			let path =
				std::env::temp_dir().join(format!("fuzzy-library-{}-{suffix}", std::process::id()));
			std::fs::create_dir_all(&path).unwrap();
			Self { path }
		}

		fn write(&self, relative: &str, contents: &str) {
			let path = self.path.join(relative);
			std::fs::create_dir_all(path.parent().unwrap()).unwrap();
			std::fs::write(path, contents).unwrap();
		}
	}

	impl Drop for TestDirectory {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.path);
		}
	}

	fn configured_database(directory: &TestDirectory) -> Database {
		let database = Database::open_in_memory().unwrap();
		let canonical = directory.path.canonicalize().unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO app_settings (key, value) VALUES
				 ('base_folder_path', ?1),
				 ('initial_scan_course_segment_index', '0')",
				[canonical.to_string_lossy().as_ref()],
			)
			.unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO global_rule (id, pattern_key, pattern_template)
				 VALUES (1, 'course-assignment', '{course}/{assignment}')",
				[],
			)
			.unwrap();
		database
	}

	#[test]
	fn shared_document_capabilities_distinguish_indexing_from_mime_detection() {
		assert!(is_indexable_document(Path::new("第4回_正規化.TXT")));
		assert!(!is_indexable_document(Path::new("第4回_資料.zip")));
		assert!(!is_indexable_document(Path::new("第4回_添付.bin")));
		assert_eq!(
			document_mime_type(Path::new("第4回_正規化.TXT")),
			Some("text/plain")
		);
		assert_eq!(
			document_mime_type(Path::new("第4回_資料.ZIP")),
			Some("application/zip")
		);
		assert_eq!(document_mime_type(Path::new("第4回_添付.bin")), None);
	}

	#[derive(Default)]
	struct ControlledIndexEngine {
		fail_clear: bool,
		indexed_file_ids: Vec<i64>,
	}

	impl IndexEngine for ControlledIndexEngine {
		fn index_file(
			&mut self,
			database: &Database,
			file_id: i64,
			_path: &Path,
		) -> EngineResult<()> {
			self.indexed_file_ids.push(file_id);
			database.mark_search_indexed(file_id, None)
		}

		fn remove_file(&mut self, database: &Database, file_id: i64) -> EngineResult<()> {
			database.remove_search_index_meta(file_id)
		}

		fn clear(&mut self) -> EngineResult<()> {
			if self.fail_clear {
				return Err(crate::EngineError::Index {
					message: "テスト用の物理索引削除失敗".to_string(),
				});
			}
			Ok(())
		}

		fn search(&self, _query: &str, _limit: usize) -> EngineResult<Vec<SearchHit>> {
			Ok(Vec::new())
		}
	}

	#[test]
	fn registers_indexes_and_reconciles_existing_library_idempotently() {
		let directory = TestDirectory::new();
		directory.write(
			"データベース/第4回_正規化.txt",
			"normalization prevents anomalies",
		);
		directory.write(
			"データベース/正規化の複製.txt",
			"normalization prevents anomalies",
		);
		let index_directory = TestDirectory::new();
		let mut database = configured_database(&directory);
		let mut index = DefaultIndexEngine::open(&index_directory.path).unwrap();

		let first = LibraryMaintenance::reconcile(&mut database, &mut index, true).unwrap();
		assert_eq!(first.scanned_file_count, 2);
		assert_eq!(first.registered_file_count, 2);
		assert_eq!(first.indexed_file_count, 2);
		assert!(first.warnings.is_empty());
		assert_eq!(database.dashboard().unwrap().total_files, 2);
		assert_eq!(database.duplicate_groups().unwrap().len(), 1);
		assert_eq!(index.search("normalization", 10).unwrap().len(), 2);

		let second = LibraryMaintenance::reconcile(&mut database, &mut index, false).unwrap();
		assert_eq!(second.registered_file_count, 0);
		assert_eq!(second.updated_file_count, 0);
		assert_eq!(second.indexed_file_count, 0);

		directory.write(
			"データベース/第4回_正規化.txt",
			"relational algebra changed",
		);
		let changed = LibraryMaintenance::reconcile(&mut database, &mut index, false).unwrap();
		assert_eq!(changed.updated_file_count, 1);
		assert_eq!(changed.indexed_file_count, 1);
		assert_eq!(index.search("algebra", 10).unwrap().len(), 1);
	}

	#[test]
	fn missing_files_are_preserved_but_excluded_and_reappear_after_restore() {
		let directory = TestDirectory::new();
		directory.write("データベース/正規化.txt", "normalization");
		let index_directory = TestDirectory::new();
		let mut database = configured_database(&directory);
		let mut index = DefaultIndexEngine::open(&index_directory.path).unwrap();
		LibraryMaintenance::reconcile(&mut database, &mut index, true).unwrap();
		let file_path = directory.path.join("データベース").join("正規化.txt");

		std::fs::remove_file(&file_path).unwrap();
		let missing = LibraryMaintenance::reconcile(&mut database, &mut index, false).unwrap();
		assert_eq!(missing.missing_file_count, 1);
		assert_eq!(database.dashboard().unwrap().total_files, 0);
		assert!(database.duplicate_groups().unwrap().is_empty());
		assert!(index.search("normalization", 10).unwrap().is_empty());
		let (row_count, missing_count): (i64, i64) = database
			.conn()
			.query_row("SELECT COUNT(*), COUNT(missing_at) FROM files", [], |row| {
				Ok((row.get(0)?, row.get(1)?))
			})
			.unwrap();
		assert_eq!((row_count, missing_count), (1, 1));

		directory.write("データベース/正規化.txt", "normalization");
		let restored = LibraryMaintenance::reconcile(&mut database, &mut index, false).unwrap();
		assert_eq!(restored.missing_file_count, 0);
		assert_eq!(restored.updated_file_count, 1);
		assert_eq!(restored.indexed_file_count, 1);
		assert_eq!(database.dashboard().unwrap().total_files, 1);
		assert_eq!(index.search("normalization", 10).unwrap().len(), 1);
	}

	#[test]
	fn failed_physical_clear_leaves_every_file_retryable_by_a_normal_rescan() {
		let directory = TestDirectory::new();
		directory.write("データベース/正規化.txt", "normalization");
		let mut database = configured_database(&directory);
		let mut index = ControlledIndexEngine::default();
		LibraryMaintenance::reconcile(&mut database, &mut index, true).unwrap();
		index.indexed_file_ids.clear();
		index.fail_clear = true;

		assert!(matches!(
			LibraryMaintenance::reconcile(&mut database, &mut index, true),
			Err(crate::EngineError::Index { .. })
		));
		let indexed_meta_count: i64 = database
			.conn()
			.query_row("SELECT count(*) FROM search_index_meta", [], |row| {
				row.get(0)
			})
			.unwrap();
		assert_eq!(indexed_meta_count, 0);

		index.fail_clear = false;
		let retried = LibraryMaintenance::reconcile(&mut database, &mut index, false).unwrap();
		assert_eq!(retried.indexed_file_count, 1);
		assert_eq!(index.indexed_file_ids.len(), 1);
		let indexed_meta_count: i64 = database
			.conn()
			.query_row("SELECT count(*) FROM search_index_meta", [], |row| {
				row.get(0)
			})
			.unwrap();
		assert_eq!(indexed_meta_count, 1);
	}

	#[test]
	fn promotes_one_matching_local_course_when_moodle_identity_arrives() {
		let directory = TestDirectory::new();
		let mut database = configured_database(&directory);
		let local_id = database.ensure_local_scan_course("データベース").unwrap();

		let resolved = database
			.resolve_course_context(Some("412"), Some("データベース"), Some(2026), Some("前期"))
			.unwrap();

		assert_eq!(resolved.course_id, local_id);
		let stored: (String, Option<i64>) = database
			.conn()
			.query_row(
				"SELECT moodle_course_id, academic_year FROM courses WHERE id = ?1",
				params![local_id],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(stored, ("412".to_string(), Some(2026)));
	}

	#[test]
	fn reuses_one_existing_moodle_course_instead_of_creating_a_local_duplicate() {
		let directory = TestDirectory::new();
		let mut database = configured_database(&directory);
		let moodle = database
			.resolve_course_context(
				Some("course-412"),
				Some("データベース"),
				Some(2026),
				Some("前期"),
			)
			.unwrap();

		let scanned = database.ensure_local_scan_course("データベース").unwrap();

		assert_eq!(scanned, moodle.course_id);
		let local_count: i64 = database
			.conn()
			.query_row(
				"SELECT count(*) FROM courses WHERE moodle_course_id GLOB 'local-scan:*'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(local_count, 0);
	}

	#[test]
	fn same_named_courses_in_different_year_folders_keep_distinct_contexts() {
		let directory = TestDirectory::new();
		directory.write("2025/Data Science/guide.txt", "year 2025");
		directory.write("2026/Data Science/guide.txt", "year 2026");
		let mut database = configured_database(&directory);
		database
			.conn()
			.execute(
				"UPDATE app_settings
				 SET value = '1'
				 WHERE key = 'initial_scan_course_segment_index'",
				[],
			)
			.unwrap();
		let mut index = ControlledIndexEngine::default();

		LibraryMaintenance::reconcile(&mut database, &mut index, true).unwrap();

		let courses = {
			let mut statement = database
				.conn()
				.prepare(
					"SELECT id, moodle_course_id, academic_year
					 FROM courses
					 WHERE name = 'Data Science'
					 ORDER BY academic_year",
				)
				.unwrap();
			statement
				.query_map([], |row| {
					Ok((
						row.get::<_, i64>(0)?,
						row.get::<_, String>(1)?,
						row.get::<_, Option<i64>>(2)?,
					))
				})
				.unwrap()
				.collect::<rusqlite::Result<Vec<_>>>()
				.unwrap()
		};
		assert_eq!(courses.len(), 2);
		assert_eq!(courses[0].2, Some(2025));
		assert_eq!(courses[1].2, Some(2026));
		assert_ne!(courses[0].0, courses[1].0);
		assert_ne!(courses[0].1, courses[1].1);
		assert!(courses
			.iter()
			.all(|course| course.1.starts_with("local-scan:v2:")));

		let resolved = database
			.resolve_course_context(
				Some("moodle-data-science-2026"),
				Some("Data Science"),
				Some(2026),
				None,
			)
			.unwrap();
		assert_eq!(resolved.course_id, courses[1].0);
		let remaining_2025_id: String = database
			.conn()
			.query_row(
				"SELECT moodle_course_id
				 FROM courses
				 WHERE id = ?1",
				[courses[0].0],
				|row| row.get(0),
			)
			.unwrap();
		assert!(remaining_2025_id.starts_with("local-scan:v2:"));
	}

	#[test]
	fn merges_a_legacy_local_split_into_the_unique_moodle_course_without_touching_the_file() {
		let directory = TestDirectory::new();
		directory.write("データベース/第4回_正規化.txt", "normalization");
		let file_path = directory.path.join("データベース/第4回_正規化.txt");
		let mut database = configured_database(&directory);
		let local_id = database.ensure_local_scan_course("データベース").unwrap();
		database
			.conn()
			.execute(
				"UPDATE courses SET folder_name_override = 'DB資料' WHERE id = ?1",
				[local_id],
			)
			.unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO course_rule_overrides (
					course_id, split_by_section, pattern_template, note
				 ) VALUES (?1, 1, '{course}/{section}/{assignment}', '既存資料用')",
				[local_id],
			)
			.unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO files (
					course_id, original_name, saved_path, size_bytes, hash_blake3
				 ) VALUES (?1, '第4回_正規化.txt', ?2, 13, 'b3:legacy')",
				params![local_id, file_path.to_string_lossy()],
			)
			.unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO assignments (
					course_id, title, source, due_at_status, submission_mode, submitted
				 ) VALUES (?1, '正規化レポート', 'file_content', 'normal', 'manual', 0)",
				[local_id],
			)
			.unwrap();
		database
			.conn()
			.execute(
				"INSERT INTO courses (
					moodle_course_id, name, academic_year, term
				 ) VALUES ('course-412', 'データベース', 2026, '前期')",
				[],
			)
			.unwrap();
		let moodle_id = database.conn().last_insert_rowid();

		let resolved = database.ensure_local_scan_course("データベース").unwrap();

		assert_eq!(resolved, moodle_id);
		assert!(file_path.exists());
		for table in ["files", "assignments", "course_rule_overrides"] {
			let course_id: i64 = database
				.conn()
				.query_row(
					&format!("SELECT course_id FROM {table} LIMIT 1"),
					[],
					|row| row.get(0),
				)
				.unwrap();
			assert_eq!(course_id, moodle_id, "{table}");
		}
		let stored: (Option<String>, i64) = database
			.conn()
			.query_row(
				"SELECT folder_name_override,
				        (SELECT count(*) FROM courses WHERE name = 'データベース')
				 FROM courses
				 WHERE id = ?1",
				[moodle_id],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.unwrap();
		assert_eq!(stored, (Some("DB資料".to_string()), 1));
		let foreign_key_error_count: i64 = database
			.conn()
			.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
				row.get(0)
			})
			.unwrap();
		assert_eq!(foreign_key_error_count, 0);
	}
}
