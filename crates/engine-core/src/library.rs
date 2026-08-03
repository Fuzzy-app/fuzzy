//! 保存ルートを明示的に再走査し、SQLite注釈と全文索引を整合させる保守処理。

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::database::saved_path_key;
use crate::database::ScannedFileUpsertResult;
use crate::duplicate::{DefaultDuplicateDetector, DuplicateDetector, DEFAULT_SIMILARITY_THRESHOLD};
use crate::index::IndexEngine;
use crate::pattern::{normalize_term_component, parse_academic_year_component};
use crate::rule::DefaultRuleEngine;
use crate::scan::{relative_warning_path, scan_registered_file, DefaultScanEngine, ScanEngine};
use crate::section::{parse_section_file_prefix, parse_section_name};
use crate::types::{FileEntry, FileFingerprint, SavedFileRegistration, ScanSnapshot, ScanWarning};
use crate::{Database, EngineError, EngineResult};

const MAX_WARNINGS: usize = 200;
const UPSERT_BATCH_SIZE: usize = 256;
const INDEX_BATCH_SIZE: usize = 64;
const MAX_HASH_WORKERS: usize = 4;

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
	pub reused_fingerprint_count: usize,
	pub missing_file_count: usize,
	pub skipped_file_count: usize,
	pub warnings: Vec<LibraryMaintenanceWarning>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryMaintenancePhase {
	Scanning,
	Registering,
	Indexing,
	Finalizing,
	Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryMaintenanceProgressState {
	Running,
	Completed,
	CompletedWithWarnings,
	Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMaintenanceProgress {
	pub phase: LibraryMaintenancePhase,
	pub state: LibraryMaintenanceProgressState,
	pub completed_count: usize,
	pub total_count: Option<usize>,
	pub warning_count: usize,
}

#[derive(Debug, Default)]
pub struct LibraryMaintenance;

#[derive(Debug, Clone)]
struct CourseReconcileScope {
	course_id: i64,
	course_root: PathBuf,
}

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
		Self::reconcile_with_progress(database, index_engine, rebuild_index, &mut |_| {})
	}

	/// フェーズ・単調な完了件数・警告件数を通知しながら整合処理を行う。
	pub fn reconcile_with_progress(
		database: &mut Database,
		index_engine: &mut dyn IndexEngine,
		rebuild_index: bool,
		progress: &mut dyn FnMut(LibraryMaintenanceProgress),
	) -> EngineResult<LibraryMaintenanceSummary> {
		progress(LibraryMaintenanceProgress {
			phase: LibraryMaintenancePhase::Scanning,
			state: LibraryMaintenanceProgressState::Running,
			completed_count: 0,
			total_count: None,
			warning_count: 0,
		});
		let result = Self::reconcile_inner(database, index_engine, rebuild_index, None, progress);
		match &result {
			Ok(summary) => progress(LibraryMaintenanceProgress {
				phase: LibraryMaintenancePhase::Completed,
				state: if summary.warnings.is_empty() {
					LibraryMaintenanceProgressState::Completed
				} else {
					LibraryMaintenanceProgressState::CompletedWithWarnings
				},
				completed_count: summary.scanned_file_count,
				total_count: Some(summary.scanned_file_count),
				warning_count: summary.warnings.len(),
			}),
			Err(_) => progress(LibraryMaintenanceProgress {
				phase: LibraryMaintenancePhase::Completed,
				state: LibraryMaintenanceProgressState::Failed,
				completed_count: 0,
				total_count: None,
				warning_count: 0,
			}),
		}
		result
	}

	/// Moodleで表示中の1コースだけを差分走査する。
	///
	/// 新規ファイルの探索はコースフォルダー内に限定し、欠損確認も指定コースの
	/// SQLite行だけを対象にする。利用者ファイルの移動・削除は行わない。
	pub fn reconcile_course(
		database: &mut Database,
		index_engine: &mut dyn IndexEngine,
		course_id: i64,
		course_root: &Path,
	) -> EngineResult<LibraryMaintenanceSummary> {
		let mut progress = |_| {};
		Self::reconcile_inner(
			database,
			index_engine,
			false,
			Some(CourseReconcileScope {
				course_id,
				course_root: course_root.to_path_buf(),
			}),
			&mut progress,
		)
	}

	fn reconcile_inner(
		database: &mut Database,
		index_engine: &mut dyn IndexEngine,
		rebuild_index: bool,
		course_scope: Option<CourseReconcileScope>,
		progress: &mut dyn FnMut(LibraryMaintenanceProgress),
	) -> EngineResult<LibraryMaintenanceSummary> {
		database.normalize_stored_saved_paths()?;
		let root = database.base_folder_path()?;
		let canonical_root = root.canonicalize().map_err(|source| EngineError::PathIo {
			path: root.display().to_string(),
			source,
		})?;
		let course_segment_index = if course_scope.is_some() {
			None
		} else {
			database.initial_scan_course_segment_index()?
		};
		let mut snapshot = if let Some(scope) = &course_scope {
			let course_root = if scope.course_root.exists() {
				scope
					.course_root
					.canonicalize()
					.map_err(|source| EngineError::PathIo {
						path: scope.course_root.display().to_string(),
						source,
					})?
			} else {
				scope.course_root.clone()
			};
			if !course_root.starts_with(&canonical_root) {
				return Err(EngineError::InvalidPath {
					path: course_root.display().to_string(),
					reason: "コースフォルダーは保存ルート内を指定してください".to_string(),
				});
			}
			if course_root.exists() {
				DefaultScanEngine.scan(&course_root)?
			} else {
				ScanSnapshot {
					root: course_root,
					entries: Vec::new(),
					warnings: Vec::new(),
				}
			}
		} else {
			DefaultScanEngine.scan(&canonical_root)?
		};
		if let Some(scope) = &course_scope {
			let mut seen_paths = snapshot
				.entries
				.iter()
				.map(|entry| saved_path_key(&entry.path).to_lowercase())
				.collect::<HashSet<_>>();
			for registered in database.registered_library_files_for_course(Some(scope.course_id))? {
				let key = saved_path_key(&registered.saved_path).to_lowercase();
				if seen_paths.contains(&key) {
					continue;
				}
				match scan_registered_file(&canonical_root, &registered.saved_path) {
					Ok(Some(entry)) => {
						seen_paths.insert(key);
						snapshot.entries.push(entry);
					}
					Ok(None) => {}
					Err(error) => {
						eprintln!(
							"登録済み資料の更新情報を読み取れませんでした（{}）: {error}",
							registered.saved_path.display()
						);
						snapshot.warnings.push(ScanWarning {
							path: relative_warning_path(&canonical_root, &registered.saved_path),
							message: "登録済み資料の更新情報を読み取れませんでした。".to_string(),
						});
					}
				}
			}
			snapshot
				.entries
				.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
		}
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
		progress(LibraryMaintenanceProgress {
			phase: LibraryMaintenancePhase::Registering,
			state: LibraryMaintenanceProgressState::Running,
			completed_count: 0,
			total_count: Some(summary.scanned_file_count),
			warning_count: summary.warnings.len(),
		});

		let detector = DefaultDuplicateDetector::default();
		let previous_observations = database
			.scanned_file_observations(course_scope.as_ref().map(|scope| scope.course_id))?
			.into_iter()
			.map(|observation| (observation.saved_path.to_lowercase(), observation))
			.collect::<HashMap<_, _>>();
		let mut index_candidates = Vec::new();
		let mut course_ids = HashMap::<String, Option<i64>>::new();
		let mut pending_fingerprints = Vec::with_capacity(snapshot.entries.len());
		for entry in snapshot.entries {
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
			let course_id = if let Some(scope) = &course_scope {
				Some(scope.course_id)
			} else {
				match course_context_at(&entry, course_segment_index) {
					Some(course) => {
						if let Some(course_id) = course_ids.get(&course.identity) {
							*course_id
						} else {
							let course_id = match database.ensure_contextual_local_scan_course(
								&course.name,
								&course.identity,
								course.academic_year,
								course.term.as_deref(),
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
							};
							course_ids.insert(course.identity, course_id);
							course_id
						}
					}
					None => None,
				}
			};
			let reusable = previous_observations
				.get(&saved_path_key(&entry.path).to_lowercase())
				.filter(|observation| {
					entry.modified_at.is_some()
						&& observation.size_bytes == size_bytes
						&& observation.modified_at_ns == entry.modified_at
						&& observation.simhash.is_some()
						&& !observation.is_missing
				})
				.map(|observation| FileFingerprint {
					hash_blake3: observation.hash_blake3.clone(),
					simhash: observation.simhash.expect("直前に存在確認済み"),
				});
			if reusable.is_some() {
				summary.reused_fingerprint_count += 1;
			}
			pending_fingerprints.push(PendingFingerprint {
				entry,
				size_bytes,
				course_id,
				result: reusable.map(Ok),
			});
		}
		let reused_fingerprint_count = summary.reused_fingerprint_count;
		fingerprint_in_parallel(&mut pending_fingerprints, &mut |completed| {
			progress(LibraryMaintenanceProgress {
				phase: LibraryMaintenancePhase::Registering,
				state: LibraryMaintenanceProgressState::Running,
				completed_count: reused_fingerprint_count + completed,
				total_count: Some(summary.scanned_file_count),
				warning_count: summary.warnings.len(),
			});
		});

		let mut pending_registrations = Vec::with_capacity(pending_fingerprints.len());
		for pending in pending_fingerprints {
			let fingerprint = match pending.result.expect("並列計算後は必ず結果がある")
			{
				Ok(fingerprint) => fingerprint,
				Err(error) => {
					eprintln!(
						"走査ファイルのフィンガープリントを計算できませんでした（{}）: {error}",
						pending.entry.path.display()
					);
					summary.skipped_file_count += 1;
					push_warning(
						&mut summary.warnings,
						&mut omitted_warnings,
						relative_display(&pending.entry.relative_path),
						"ファイルを読み取れなかったため、登録を見送りました。".to_string(),
					);
					continue;
				}
			};
			let registration = SavedFileRegistration {
				course_id: pending.course_id,
				section_no: infer_section_number(&pending.entry),
				moodle_file_id: None,
				original_name: pending.entry.file_name.clone(),
				saved_path: pending.entry.path.clone(),
				size_bytes: pending.size_bytes,
				mime_type: document_mime_type(&pending.entry.path).map(str::to_string),
				hash_blake3: fingerprint.hash_blake3,
				simhash: fingerprint.simhash,
			};
			pending_registrations.push((registration, pending.entry.modified_at));
		}
		progress(LibraryMaintenanceProgress {
			phase: LibraryMaintenancePhase::Registering,
			state: LibraryMaintenanceProgressState::Running,
			completed_count: summary.scanned_file_count,
			total_count: Some(summary.scanned_file_count),
			warning_count: summary.warnings.len(),
		});

		for batch in pending_registrations.chunks(UPSERT_BATCH_SIZE) {
			match database.upsert_scanned_files_observed(batch) {
				Ok(results) => {
					for ((registration, _), upserted) in batch.iter().zip(results) {
						collect_upsert_result(
							registration,
							upserted,
							&root,
							rebuild_index,
							&mut summary,
							&mut index_candidates,
						);
					}
				}
				Err(batch_error) => {
					eprintln!(
						"走査ファイルのSQLite一括登録に失敗したため単件で再試行します: {batch_error}"
					);
					for (registration, modified_at) in batch {
						match database.upsert_scanned_file_observed(registration, *modified_at) {
							Ok(upserted) => collect_upsert_result(
								registration,
								upserted,
								&root,
								rebuild_index,
								&mut summary,
								&mut index_candidates,
							),
							Err(error) => {
								eprintln!(
									"走査ファイルをSQLiteへ登録できませんでした（{}）: {error}",
									registration.saved_path.display()
								);
								summary.skipped_file_count += 1;
								push_warning(
									&mut summary.warnings,
									&mut omitted_warnings,
									registration
										.saved_path
										.strip_prefix(&root)
										.map(relative_display)
										.unwrap_or_else(|_| ".".to_string()),
									"SQLiteへ登録できなかったため、この資料を見送りました。"
										.to_string(),
								);
							}
						}
					}
				}
			}
		}

		reconcile_missing_files(
			database,
			index_engine,
			&root,
			course_scope.as_ref().map(|scope| scope.course_id),
			rebuild_index,
			&mut summary,
			&mut omitted_warnings,
		)?;
		if course_scope.is_none() {
			if let Err(error) = database.cleanup_orphaned_local_scan_courses() {
				eprintln!("再分類後の未参照ローカルコースを整理できませんでした: {error}");
				push_warning(
					&mut summary.warnings,
					&mut omitted_warnings,
					".".to_string(),
					"以前の自動分類結果を整理できませんでした。再スキャンで再試行できます。"
						.to_string(),
				);
			}
		}
		progress(LibraryMaintenanceProgress {
			phase: LibraryMaintenancePhase::Indexing,
			state: LibraryMaintenanceProgressState::Running,
			completed_count: 0,
			total_count: Some(index_candidates.len()),
			warning_count: summary.warnings.len(),
		});

		if rebuild_index {
			// SQLiteを正本として先に「未索引」へ戻す。物理索引の削除に失敗しても
			// 古いヒットは公開されず、次回の通常再走査で全実在ファイルを再投入できる。
			database.clear_search_index_meta()?;
			index_engine.clear()?;
			// 別プロセスの保存処理が上の2操作の間に完了しても、削除済みの物理索引を
			// 「索引済み」と誤認しないよう、クリア直後にもう一度無効化する。
			database.clear_search_index_meta()?;
		}
		let index_candidate_count = index_candidates.len();
		let mut completed_index_count = 0usize;
		for batch in index_candidates.chunks(INDEX_BATCH_SIZE) {
			let files = batch
				.iter()
				.map(|(file_id, path, _)| (*file_id, path.clone()))
				.collect::<Vec<_>>();
			let results = index_engine.index_files(database, &files);
			for ((_, path, relative_path), result) in batch.iter().zip(results) {
				match result {
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
							relative_display(relative_path),
							"本文を索引化できませんでした。再スキャンで再試行できます。"
								.to_string(),
						);
					}
				}
				completed_index_count += 1;
				progress(LibraryMaintenanceProgress {
					phase: LibraryMaintenancePhase::Indexing,
					state: LibraryMaintenanceProgressState::Running,
					completed_count: completed_index_count,
					total_count: Some(index_candidate_count),
					warning_count: summary.warnings.len(),
				});
			}
		}

		progress(LibraryMaintenanceProgress {
			phase: LibraryMaintenancePhase::Finalizing,
			state: LibraryMaintenanceProgressState::Running,
			completed_count: 0,
			total_count: Some(3),
			warning_count: summary.warnings.len(),
		});
		let metadata_changed = rebuild_index
			|| summary.registered_file_count > 0
			|| summary.updated_file_count > 0
			|| summary.missing_file_count > 0;
		if metadata_changed {
			if let Err(error) = database.refresh_rule_compliance(&DefaultRuleEngine) {
				eprintln!("ライブラリ走査後のルール適合状況を更新できませんでした: {error}");
				push_warning(
					&mut summary.warnings,
					&mut omitted_warnings,
					".".to_string(),
					"ルール整合性の再計算に失敗しました。再スキャンで再試行できます。".to_string(),
				);
			}
		}
		progress(LibraryMaintenanceProgress {
			phase: LibraryMaintenancePhase::Finalizing,
			state: LibraryMaintenanceProgressState::Running,
			completed_count: 1,
			total_count: Some(3),
			warning_count: summary.warnings.len(),
		});
		if metadata_changed {
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
		}
		progress(LibraryMaintenanceProgress {
			phase: LibraryMaintenancePhase::Finalizing,
			state: LibraryMaintenanceProgressState::Running,
			completed_count: 2,
			total_count: Some(3),
			warning_count: summary.warnings.len(),
		});
		if let Err(error) = database.mark_library_scan_completed() {
			eprintln!("ライブラリ走査の完了時刻を保存できませんでした: {error}");
			push_warning(
				&mut summary.warnings,
				&mut omitted_warnings,
				".".to_string(),
				"再スキャンの完了日時を保存できませんでした。".to_string(),
			);
		}
		progress(LibraryMaintenanceProgress {
			phase: LibraryMaintenancePhase::Finalizing,
			state: LibraryMaintenanceProgressState::Running,
			completed_count: 3,
			total_count: Some(3),
			warning_count: summary.warnings.len(),
		});
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

struct PendingFingerprint {
	entry: FileEntry,
	size_bytes: i64,
	course_id: Option<i64>,
	result: Option<EngineResult<FileFingerprint>>,
}

fn fingerprint_in_parallel(pending: &mut [PendingFingerprint], progress: &mut dyn FnMut(usize)) {
	let hash_count = pending.iter().filter(|item| item.result.is_none()).count();
	if hash_count == 0 {
		return;
	}
	let worker_count = std::thread::available_parallelism()
		.map(usize::from)
		.unwrap_or(1)
		.min(MAX_HASH_WORKERS)
		.min(hash_count);
	let chunk_size = pending.len().div_ceil(worker_count);
	std::thread::scope(|scope| {
		let mut handles = Vec::new();
		for chunk in pending.chunks_mut(chunk_size) {
			handles.push(scope.spawn(move || {
				let detector = DefaultDuplicateDetector::default();
				let mut completed = 0usize;
				for item in chunk {
					if item.result.is_none() {
						item.result = Some(detector.fingerprint(&item.entry.path));
						completed += 1;
					}
				}
				completed
			}));
		}
		let mut completed = 0usize;
		for handle in handles {
			completed += handle.join().expect("フィンガープリント計算スレッド");
			progress(completed);
		}
	});
}

fn collect_upsert_result(
	registration: &SavedFileRegistration,
	upserted: ScannedFileUpsertResult,
	root: &Path,
	rebuild_index: bool,
	summary: &mut LibraryMaintenanceSummary,
	index_candidates: &mut Vec<(i64, std::path::PathBuf, std::path::PathBuf)>,
) {
	if upserted.inserted {
		summary.registered_file_count += 1;
	} else if upserted.updated {
		summary.updated_file_count += 1;
	}
	if is_indexable_document(&registration.saved_path) && (rebuild_index || upserted.needs_index) {
		let relative_path = registration
			.saved_path
			.strip_prefix(root)
			.map(Path::to_path_buf)
			.unwrap_or_default();
		index_candidates.push((
			upserted.file_id,
			registration.saved_path.clone(),
			relative_path,
		));
	}
}

fn reconcile_missing_files(
	database: &mut Database,
	index_engine: &mut dyn IndexEngine,
	root: &Path,
	course_id: Option<i64>,
	rebuild_index: bool,
	summary: &mut LibraryMaintenanceSummary,
	omitted_warnings: &mut usize,
) -> EngineResult<()> {
	let normalized_root = std::path::PathBuf::from(saved_path_key(root));
	for registered in database.registered_library_files_for_course(course_id)? {
		let normalized_saved_path =
			std::path::PathBuf::from(saved_path_key(&registered.saved_path));
		let Ok(relative_path) = normalized_saved_path.strip_prefix(&normalized_root) else {
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
				eprintln!(
					"登録済み資料の実体を確認できませんでした（{}）: {error}",
					registered.saved_path.display()
				);
				summary.skipped_file_count += 1;
				push_warning(
					&mut summary.warnings,
					omitted_warnings,
					relative_display(relative_path),
					"登録済み資料の実体を確認できませんでした。".to_string(),
				);
				continue;
			}
		};
		let Some(reason) = missing_reason else {
			continue;
		};

		let presence_changed =
			match database.update_library_file_presence(registered.file_id, false) {
				Ok(changed) => changed,
				Err(error) => {
					eprintln!(
						"欠損状態をSQLiteへ保存できませんでした（{}）: {error}",
						registered.saved_path.display()
					);
					summary.skipped_file_count += 1;
					push_warning(
						&mut summary.warnings,
						omitted_warnings,
						relative_display(relative_path),
						"欠損状態をSQLiteへ保存できませんでした。".to_string(),
					);
					continue;
				}
			};
		if !presence_changed {
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
				eprintln!(
					"欠損資料を検索索引から除外できませんでした（{}）: {error}",
					registered.saved_path.display()
				);
				summary.skipped_file_count += 1;
				push_warning(
					&mut summary.warnings,
					omitted_warnings,
					relative_display(relative_path),
					"欠損資料を検索索引から除外できませんでした。再スキャンで再試行できます。"
						.to_string(),
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
	// 旧版が保存した誤った科目位置でも、年度・学期・授業回をコースとして
	// 永続化しない。曖昧な場合は未分類のまま利用者確認へ残す。
	if parse_academic_year_component(name).is_some()
		|| normalize_term_component(name).is_some()
		|| parse_section_name(name).is_some()
	{
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
	let academic_year = parent_components.iter().rev().find_map(|component| {
		parse_academic_year_component(component).map(|(year, _template)| year)
	});
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
	fn warning_paths_never_expose_the_library_root() {
		let root = PathBuf::from(r"C:\Users\student\Fuzzy");

		assert_eq!(
			relative_warning_path(&root, &root.join("データベース/第4回/正規化.pdf")),
			PathBuf::from("データベース/第4回/正規化.pdf")
		);
		assert_eq!(
			relative_warning_path(&root, &PathBuf::from(r"D:\outside\secret.pdf")),
			PathBuf::from(".")
		);
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

	#[test]
	fn registers_a_binary_by_hash_without_counting_it_as_skipped() {
		let directory = TestDirectory::new();
		directory.write("アプリ演習/配布プログラム.exe", "binary");
		let mut database = configured_database(&directory);
		let mut index = ControlledIndexEngine::default();

		let summary = LibraryMaintenance::reconcile(&mut database, &mut index, false).unwrap();

		assert_eq!(summary.scanned_file_count, 1);
		assert_eq!(summary.registered_file_count, 1);
		assert_eq!(summary.indexed_file_count, 0);
		assert_eq!(summary.skipped_file_count, 0);
		assert!(summary.warnings.is_empty());
		assert!(index.indexed_file_ids.is_empty());
		let hash: String = database
			.conn()
			.query_row("SELECT hash_blake3 FROM files", [], |row| row.get(0))
			.unwrap();
		assert!(!hash.is_empty());
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
		assert_eq!(second.reused_fingerprint_count, 2);

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
	fn course_reconcile_scans_only_the_requested_course_and_reuses_unchanged_hashes() {
		let directory = TestDirectory::new();
		directory.write("データベース/A.txt", "first");
		directory.write("離散数学/B.txt", "second");
		let mut database = configured_database(&directory);
		let mut index = ControlledIndexEngine::default();
		LibraryMaintenance::reconcile(&mut database, &mut index, false).unwrap();
		let database_course_id = database
			.conn()
			.query_row(
				"SELECT id FROM courses WHERE name = 'データベース'",
				[],
				|row| row.get::<_, i64>(0),
			)
			.unwrap();

		directory.write("データベース/C.txt", "third");
		directory.write("離散数学/D.txt", "must remain undiscovered");
		let summary = LibraryMaintenance::reconcile_course(
			&mut database,
			&mut index,
			database_course_id,
			&directory.path.join("データベース"),
		)
		.unwrap();

		assert_eq!(summary.scanned_file_count, 2);
		assert_eq!(summary.registered_file_count, 1);
		assert_eq!(summary.reused_fingerprint_count, 1);
		let discovered_other_course = database
			.conn()
			.query_row(
				"SELECT COUNT(*) FROM files WHERE original_name = 'D.txt'",
				[],
				|row| row.get::<_, i64>(0),
			)
			.unwrap();
		assert_eq!(discovered_other_course, 0);

		std::fs::remove_file(directory.path.join("データベース/A.txt")).unwrap();
		let missing = LibraryMaintenance::reconcile_course(
			&mut database,
			&mut index,
			database_course_id,
			&directory.path.join("データベース"),
		)
		.unwrap();
		assert_eq!(missing.missing_file_count, 1);

		directory.write("データベース/A.txt", "first restored with change");
		let restored = LibraryMaintenance::reconcile_course(
			&mut database,
			&mut index,
			database_course_id,
			&directory.path.join("データベース"),
		)
		.unwrap();
		assert_eq!(restored.updated_file_count, 1);
		assert_eq!(restored.missing_file_count, 0);

		let idempotent = LibraryMaintenance::reconcile_course(
			&mut database,
			&mut index,
			database_course_id,
			&directory.path.join("データベース"),
		)
		.unwrap();
		assert_eq!(idempotent.registered_file_count, 0);
		assert_eq!(idempotent.updated_file_count, 0);
		assert_eq!(idempotent.reused_fingerprint_count, 2);
	}

	#[test]
	fn progress_is_monotonic_and_always_ends_with_a_terminal_state() {
		let directory = TestDirectory::new();
		directory.write("データベース/A.txt", "a");
		directory.write("データベース/B.txt", "b");
		let mut database = configured_database(&directory);
		let mut index = ControlledIndexEngine::default();
		let mut events = Vec::new();

		let summary = LibraryMaintenance::reconcile_with_progress(
			&mut database,
			&mut index,
			false,
			&mut |event| events.push(event),
		)
		.unwrap();

		assert_eq!(summary.scanned_file_count, 2);
		assert_eq!(
			events.last().unwrap().state,
			LibraryMaintenanceProgressState::Completed
		);
		for pair in events.windows(2) {
			if pair[0].phase == pair[1].phase {
				assert!(pair[0].completed_count <= pair[1].completed_count);
				assert!(pair[0].warning_count <= pair[1].warning_count);
			}
		}

		let mut unavailable = Database::open_in_memory().unwrap();
		let mut failed_events = Vec::new();
		assert!(LibraryMaintenance::reconcile_with_progress(
			&mut unavailable,
			&mut index,
			false,
			&mut |event| failed_events.push(event),
		)
		.is_err());
		assert_eq!(
			failed_events.last().unwrap().state,
			LibraryMaintenanceProgressState::Failed
		);
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
			.all(|course| course.1.starts_with("local-scan:v0:")));

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
		assert!(remaining_2025_id.starts_with("local-scan:v0:"));
	}

	#[test]
	fn deep_year_grade_term_and_course_layout_registers_the_actual_course() {
		let directory = TestDirectory::new();
		directory.write(
			"2026年度/1年前期/画像処理/第3回/畳み込み.txt",
			"convolution",
		);
		let mut database = configured_database(&directory);
		database
			.conn()
			.execute(
				"UPDATE app_settings
				 SET value = '2'
				 WHERE key = 'initial_scan_course_segment_index'",
				[],
			)
			.unwrap();
		let mut index = ControlledIndexEngine::default();

		let summary = LibraryMaintenance::reconcile(&mut database, &mut index, true).unwrap();

		assert_eq!(summary.registered_file_count, 1);
		let stored: (String, Option<i64>, Option<String>) = database
			.conn()
			.query_row("SELECT name, academic_year, term FROM courses", [], |row| {
				Ok((row.get(0)?, row.get(1)?, row.get(2)?))
			})
			.unwrap();
		assert_eq!(
			stored,
			(
				"画像処理".to_string(),
				Some(2026),
				Some("1年前期".to_string())
			)
		);
	}

	#[test]
	fn legacy_term_position_is_never_registered_as_a_course() {
		for term in [
			"1年前期",
			"2年後期",
			"1Q",
			"4Q",
			"1クォーター",
			"第4クォーター",
		] {
			let directory = TestDirectory::new();
			directory.write(&format!("{term}/データベース/資料.txt"), "normalization");
			let mut database = configured_database(&directory);
			let mut index = ControlledIndexEngine::default();

			let summary = LibraryMaintenance::reconcile(&mut database, &mut index, true).unwrap();

			assert_eq!(summary.registered_file_count, 1, "{term}");
			let registered_term_course_count: i64 = database
				.conn()
				.query_row(
					"SELECT count(*) FROM courses WHERE name = ?1",
					[term],
					|row| row.get(0),
				)
				.unwrap();
			assert_eq!(registered_term_course_count, 0, "{term}");
			let course_id: Option<i64> = database
				.conn()
				.query_row("SELECT course_id FROM files", [], |row| row.get(0))
				.unwrap();
			assert_eq!(course_id, None, "{term}");
		}
	}

	#[test]
	fn corrected_role_reassigns_files_and_removes_only_unreferenced_legacy_local_course() {
		let directory = TestDirectory::new();
		directory.write("1年前期/データベース/正規化.txt", "normalization");
		let file_path = directory.path.join("1年前期/データベース/正規化.txt");
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
		database
			.conn()
			.execute(
				"INSERT INTO courses (moodle_course_id, name)
				 VALUES ('local-scan:legacy-term', '1年前期')",
				[],
			)
			.unwrap();
		let legacy_course_id = database.conn().last_insert_rowid();
		database
			.conn()
			.execute(
				"INSERT INTO files (
					course_id, original_name, saved_path, size_bytes, hash_blake3, simhash
				 ) VALUES (?1, '正規化.txt', ?2, 13, 'b3:legacy', 0)",
				params![legacy_course_id, file_path.to_string_lossy()],
			)
			.unwrap();
		let mut index = ControlledIndexEngine::default();

		LibraryMaintenance::reconcile(&mut database, &mut index, false).unwrap();

		assert!(file_path.exists());
		let courses = database
			.conn()
			.prepare("SELECT name FROM courses ORDER BY name")
			.unwrap()
			.query_map([], |row| row.get::<_, String>(0))
			.unwrap()
			.collect::<rusqlite::Result<Vec<_>>>()
			.unwrap();
		assert_eq!(courses, vec!["データベース".to_string()]);
		let file_course_name: String = database
			.conn()
			.query_row(
				"SELECT courses.name
				 FROM files JOIN courses ON courses.id = files.course_id",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(file_course_name, "データベース");
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
