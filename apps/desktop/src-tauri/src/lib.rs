mod native_host_installation;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use engine_core::index::{resolve_index_path, DefaultIndexEngine, IndexEngine};
use engine_core::library::{
	LibraryMaintenance, LibraryMaintenanceProgress, LibraryMaintenanceSummary,
	LibraryMaintenanceWarning,
};
use engine_core::scan::{DefaultScanEngine, ScanEngine};
use engine_core::types::FileEntry;
use engine_core::{resolve_db_path, Database, ExtensionRecoveryStatus, ExtensionSetupStatus};
use native_host_installation::NativeHostInstallationStatus;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogButtons, MessageDialogKind};

struct AppState {
	database: Mutex<DatabaseRuntimeState>,
	index_engine: Mutex<IndexRuntimeState>,
	native_host_installation: Mutex<NativeHostInstallationStatus>,
}

const LIBRARY_MAINTENANCE_PROGRESS_EVENT: &str = "library-maintenance-progress";

struct DatabaseRuntimeState {
	database: Option<Database>,
	path: Option<PathBuf>,
}

impl DatabaseRuntimeState {
	fn ready(&self) -> Result<&Database, String> {
		self.database.as_ref().ok_or_else(|| {
			"SQLite正本を開けないため、この操作は実行できません。画面からバックアップを復元するか、破損DBを退避して新しく開始してください。"
				.to_string()
		})
	}

	fn ready_mut(&mut self) -> Result<&mut Database, String> {
		self.database.as_mut().ok_or_else(|| {
			"SQLite正本を開けないため、この操作は実行できません。画面からバックアップを復元するか、破損DBを退避して新しく開始してください。"
				.to_string()
		})
	}
}

struct IndexRuntimeState {
	engine: Option<DefaultIndexEngine>,
	path: Option<PathBuf>,
	needs_rebuild: bool,
}

impl IndexRuntimeState {
	fn ready_mut(&mut self) -> Result<&mut DefaultIndexEngine, String> {
		self.engine.as_mut().ok_or_else(|| {
			"検索索引を開けないため、この操作は実行できません。画面から検索索引を再構築してください。"
				.to_string()
		})
	}
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryComponentStatus {
	state: &'static str,
	message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationRecoveryStatus {
	database: RecoveryComponentStatus,
	search_index: RecoveryComponentStatus,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatternSelection {
	id: String,
	course_segment_index: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleSelection {
	id: String,
	template: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CourseOverrideSelection {
	course_name: String,
	enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PatternCandidate {
	id: String,
	name: String,
	description: String,
	folders: Vec<String>,
	course_segment_index: Option<usize>,
	file_name_template: Option<String>,
	match_score: Option<u8>,
	evaluated_count: usize,
	reason: String,
	recommended: bool,
	requires_confirmation: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatus {
	done: bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	saved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct InitialSetupResponse {
	ok: bool,
	maintenance: LibraryMaintenanceSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupExportResponse {
	cancelled: bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupImportResponse {
	cancelled: bool,
	imported: bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	recovery_copy_path: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	maintenance: Option<LibraryMaintenanceSummary>,
	#[serde(skip_serializing_if = "Option::is_none")]
	maintenance_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FreshDatabaseResponse {
	cancelled: bool,
	created: bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	recovery_copy_path: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	index_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryRootChangeResponse {
	cancelled: bool,
	changed: bool,
	rebased_file_count: usize,
	#[serde(skip_serializing_if = "Option::is_none")]
	maintenance: Option<LibraryMaintenanceSummary>,
	#[serde(skip_serializing_if = "Option::is_none")]
	maintenance_error: Option<String>,
}

async fn run_blocking_command<T, F>(task: F) -> Result<T, String>
where
	T: Send + 'static,
	F: FnOnce() -> Result<T, String> + Send + 'static,
{
	tauri::async_runtime::spawn_blocking(task)
		.await
		.map_err(|error| {
			eprintln!("バックグラウンド処理の完了待機に失敗しました: {error}");
			"バックグラウンド処理を完了できませんでした。Fuzzyを再起動してください。".to_string()
		})?
}

#[tauri::command]
async fn pick_base_folder(app: AppHandle) -> Result<Option<String>, String> {
	run_blocking_command(move || pick_base_folder_blocking(&app)).await
}

fn pick_base_folder_blocking(app: &AppHandle) -> Result<Option<String>, String> {
	let selected = app.dialog().file().blocking_pick_folder();
	let Some(selected) = selected else {
		return Ok(None);
	};
	let path = selected.into_path().map_err(|error| {
		eprintln!("フォルダー選択結果をローカルパスへ変換できません: {error}");
		"選択したフォルダーの場所を読み取れませんでした。".to_string()
	})?;
	path.into_os_string().into_string().map(Some).map_err(|_| {
		eprintln!("選択されたフォルダーパスをUnicode文字列へ変換できません");
		"選択したフォルダー名を読み取れませんでした。".to_string()
	})
}

#[tauri::command]
async fn scan_existing_structure(path: String) -> Result<Vec<PatternCandidate>, String> {
	run_blocking_command(move || scan_existing_structure_blocking(path)).await
}

fn scan_existing_structure_blocking(path: String) -> Result<Vec<PatternCandidate>, String> {
	let scan_engine = DefaultScanEngine;
	let root = PathBuf::from(&path);
	let snapshot = scan_engine.scan(&root).map_err(|error| {
		eprintln!("初期セットアップのフォルダー走査に失敗しました: {error}");
		"選択したフォルダーを読み取れませんでした。アクセス権と保存先を確認してください。"
			.to_string()
	})?;
	let guesses = scan_engine
		.estimate_patterns(&snapshot.entries)
		.map_err(|error| {
			eprintln!("初期セットアップの保存パターン推定に失敗しました: {error}");
			"既存のフォルダー構成を解析できませんでした。".to_string()
		})?;
	let folders = representative_folders(&snapshot.entries);

	if guesses.is_empty() {
		if !snapshot.entries.is_empty() {
			return Ok(vec![PatternCandidate {
				id: "manual-unclassified".to_string(),
				name: "推定できません".to_string(),
				description:
					"年度・学期・科目の役割を一意に判定できないため、科目を自動登録しません。"
						.to_string(),
				folders: representative_folders(&snapshot.entries),
				course_segment_index: None,
				file_name_template: None,
				match_score: None,
				evaluated_count: 0,
				reason:
					"内容を確認してこの候補を選ぶと、既存資料は未分類のまま安全に登録されます。"
						.to_string(),
				recommended: false,
				requires_confirmation: true,
			}]);
		}
		return Ok(vec![PatternCandidate {
			id: "new-folder".to_string(),
			name: "新しい保存先".to_string(),
			description: "既存の並びに依存せず、選択した初期ルールで整理を始めます。".to_string(),
			folders,
			course_segment_index: None,
			file_name_template: None,
			match_score: Some(100),
			evaluated_count: 0,
			reason: "既存ファイルがないため、新しい保存先として使用できます。".to_string(),
			recommended: true,
			requires_confirmation: false,
		}]);
	}

	Ok(guesses
		.into_iter()
		.enumerate()
		.map(|(index, guess)| {
			let template = guess.directory_template;
			let file_name_template = guess.file_name_template;
			let file_name_description = file_name_template
				.as_deref()
				.map(display_file_name_pattern)
				.unwrap_or("ファイル名規則なし");
			let mut name = display_pattern_name(&template);
			if file_name_template.is_some() {
				name.push_str(" + ");
				name.push_str(file_name_description);
			}
			PatternCandidate {
				id: format!("estimated-{}", index + 1),
				name,
				description: format!(
					"既存ファイルから推定した構成です。ファイル名: {file_name_description}"
				),
				folders: guess
					.representative_paths
					.into_iter()
					.map(|path| path.to_string_lossy().replace('\\', "/"))
					.collect(),
				course_segment_index: Some(guess.course_segment_index),
				file_name_template,
				match_score: Some((guess.confidence.clamp(0.0, 1.0) * 100.0).round() as u8),
				evaluated_count: guess.evaluated_count,
				reason: format!(
					"評価可能な{}件中{}件が一致しました。読み取り警告は{}件です。",
					guess.evaluated_count,
					guess.matched_count,
					snapshot.warnings.len()
				),
				recommended: index == 0,
				requires_confirmation: false,
			}
		})
		.collect())
}

#[tauri::command]
async fn save_initial_setup(
	path: String,
	pattern: PatternSelection,
	rule: RuleSelection,
	course_overrides: Vec<CourseOverrideSelection>,
	app: AppHandle,
) -> Result<InitialSetupResponse, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		let mut progress = |event| emit_library_maintenance_progress(&app, event);
		save_initial_setup_blocking(
			path,
			pattern,
			rule,
			course_overrides,
			state.inner(),
			&mut progress,
		)
	})
	.await
}

fn save_initial_setup_blocking(
	path: String,
	pattern: PatternSelection,
	rule: RuleSelection,
	course_overrides: Vec<CourseOverrideSelection>,
	state: &AppState,
	progress: &mut dyn FnMut(LibraryMaintenanceProgress),
) -> Result<InitialSetupResponse, String> {
	if course_overrides.len() > 32
		|| course_overrides
			.iter()
			.any(|item| item.course_name.trim().is_empty() || item.course_name.len() > 256)
	{
		return Err("コース別候補の内容が不正です。".to_string());
	}
	let enabled_overrides = course_overrides
		.into_iter()
		.filter(|item| item.enabled)
		.collect::<Vec<_>>();
	let initial_override_course_names = enabled_overrides
		.iter()
		.map(|item| item.course_name.trim().to_string())
		.collect::<Vec<_>>();
	let overrides_json = serde_json::to_string(&enabled_overrides).map_err(|error| {
		eprintln!("初期セットアップのコース別候補を変換できません: {error}");
		"初期設定を保存できませんでした。".to_string()
	})?;
	let mut database_state = state.database.lock().map_err(|_| {
		eprintln!("初期セットアップ保存時にSQLiteの状態ロックが破損しています");
		"初期設定を保存できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	let database = database_state.ready_mut()?;
	database
		.save_initial_setup(
			Path::new(&path),
			&rule.id,
			&rule.template,
			&pattern.id,
			pattern.course_segment_index,
			&overrides_json,
		)
		.map_err(|error| {
			eprintln!("初期セットアップのSQLite保存に失敗しました: {error}");
			"初期設定を保存できませんでした。保存先とルールを確認してください。".to_string()
		})?;
	let mut maintenance = match state.index_engine.lock() {
		Ok(mut index_state) => {
			let maintenance_result = match index_state.ready_mut() {
				Ok(index_engine) => LibraryMaintenance::reconcile_with_progress(
					database,
					index_engine,
					false,
					progress,
				),
				Err(error) => Err(engine_core::EngineError::Index { message: error }),
			};
			match maintenance_result {
				Ok(maintenance) => {
					index_state.needs_rebuild = false;
					maintenance
				}
				Err(error) => {
					index_state.needs_rebuild = true;
					eprintln!("初期セットアップ後の既存資料取り込みに失敗しました: {error}");
					LibraryMaintenanceSummary {
						warnings: vec![LibraryMaintenanceWarning {
							path: ".".to_string(),
							message:
								"初期設定は保存しましたが、既存資料を取り込めませんでした。セットアップ完了後、保存先を確認して再スキャンしてください。"
									.to_string(),
						}],
						..Default::default()
					}
				}
			}
		}
		Err(_) => {
			eprintln!("初期セットアップ走査時に全文索引の状態ロックが破損しています");
			LibraryMaintenanceSummary {
				warnings: vec![LibraryMaintenanceWarning {
					path: ".".to_string(),
					message:
						"初期設定は保存しましたが、検索索引の状態を更新できませんでした。Fuzzyを再起動してください。"
							.to_string(),
				}],
				..Default::default()
			}
		}
	};
	if let Err(error) =
		database.synchronize_initial_course_overrides(&initial_override_course_names)
	{
		eprintln!("初期セットアップのコース別例外をSQLiteへ保存できませんでした: {error}");
		maintenance.warnings.push(LibraryMaintenanceWarning {
			path: ".".to_string(),
			message:
				"初期設定は保存しましたが、コース別例外を反映できませんでした。前の画面へ戻って保存を再試行してください。"
					.to_string(),
		});
	}
	Ok(InitialSetupResponse {
		ok: true,
		maintenance,
	})
}

#[tauri::command]
async fn get_setup_status(app: AppHandle) -> Result<SetupStatus, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		get_setup_status_blocking(state.inner())
	})
	.await
}

fn get_setup_status_blocking(state: &AppState) -> Result<SetupStatus, String> {
	let database_state = state.database.lock().map_err(|_| {
		eprintln!("初期セットアップ状態取得時にSQLiteの状態ロックが破損しています");
		"初期設定の状態を確認できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	let database = database_state.ready()?;
	let saved_at = database.initial_setup_saved_at().map_err(|error| {
		eprintln!("初期セットアップ状態のSQLite取得に失敗しました: {error}");
		"初期設定の状態を確認できませんでした。".to_string()
	})?;
	Ok(SetupStatus {
		done: saved_at.is_some(),
		saved_at,
	})
}

#[tauri::command]
async fn get_extension_setup_status(
	since: String,
	app: AppHandle,
) -> Result<ExtensionSetupStatus, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		get_extension_setup_status_blocking(since, state.inner())
	})
	.await
}

fn get_extension_setup_status_blocking(
	since: String,
	state: &AppState,
) -> Result<ExtensionSetupStatus, String> {
	let database_state = state.database.lock().map_err(|_| {
		eprintln!("拡張機能セットアップ状態取得時にSQLiteの状態ロックが破損しています");
		"拡張機能の応答を確認できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	let database = database_state.ready()?;
	database
		.extension_setup_status_since(&since)
		.map_err(|error| {
			eprintln!("拡張機能セットアップ状態のSQLite取得に失敗しました: {error}");
			"拡張機能の応答を確認できませんでした。".to_string()
		})
}

#[tauri::command]
async fn get_extension_recovery_status(app: AppHandle) -> Result<ExtensionRecoveryStatus, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		get_extension_recovery_status_blocking(state.inner())
	})
	.await
}

fn get_extension_recovery_status_blocking(
	state: &AppState,
) -> Result<ExtensionRecoveryStatus, String> {
	let database_state = state.database.lock().map_err(|_| {
		eprintln!("拡張機能復旧状態取得時にSQLiteの状態ロックが破損しています");
		"拡張機能の状態を確認できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	let database = database_state.ready()?;
	database.extension_recovery_status().map_err(|error| {
		eprintln!("拡張機能復旧状態のSQLite取得に失敗しました: {error}");
		"拡張機能の状態を確認できませんでした。".to_string()
	})
}

#[tauri::command]
async fn get_application_recovery_status(
	app: AppHandle,
) -> Result<ApplicationRecoveryStatus, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		get_application_recovery_status_blocking(state.inner())
	})
	.await
}

fn get_application_recovery_status_blocking(
	state: &AppState,
) -> Result<ApplicationRecoveryStatus, String> {
	let database_state = state.database.lock().map_err(|_| {
		eprintln!("アプリ復旧状態取得時にSQLiteの状態ロックが破損しています");
		"ローカルデータの状態を確認できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	let index_state = state.index_engine.lock().map_err(|_| {
		eprintln!("アプリ復旧状態取得時に全文索引の状態ロックが破損しています");
		"検索索引の状態を確認できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	let index_metadata_exists = index_state
		.path
		.as_deref()
		.is_some_and(index_storage_metadata_exists);
	let database_needs_index_rebuild =
		database_needs_index_rebuild(&database_state, index_metadata_exists);

	let database = if database_state.database.is_some() {
		RecoveryComponentStatus {
			state: "ready",
			message: "SQLite正本を利用できます。".to_string(),
		}
	} else {
		RecoveryComponentStatus {
			state: "recoveryRequired",
			message: if database_state.path.is_some() {
				"SQLite正本を開けませんでした。バックアップから復元するか、破損DBを別名で保全して新しく開始してください。"
					.to_string()
			} else {
				"SQLite正本の保存先を決定できませんでした。Windowsのアプリデータ保存先を確認してください。"
					.to_string()
			},
		}
	};
	let search_index = if index_state.engine.is_none() {
		RecoveryComponentStatus {
			state: "recoveryRequired",
			message:
				"検索索引を開けませんでした。SQLite正本と資料は保持したまま索引を再生成できます。"
					.to_string(),
		}
	} else if index_state.needs_rebuild || database_needs_index_rebuild {
		RecoveryComponentStatus {
			state: "needsRebuild",
			message: if database_needs_index_rebuild {
				"SQLite正本に未反映の資料があります。SQLite正本から検索索引を再構築してください。"
					.to_string()
			} else {
				"検索索引の保存領域は復旧済みです。SQLite正本から索引を再構築してください。"
					.to_string()
			},
		}
	} else {
		RecoveryComponentStatus {
			state: "ready",
			message: "検索索引を利用できます。".to_string(),
		}
	};
	Ok(ApplicationRecoveryStatus {
		database,
		search_index,
	})
}

#[tauri::command]
async fn get_native_host_installation_status(
	app: AppHandle,
) -> Result<NativeHostInstallationStatus, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		get_native_host_installation_status_blocking(state.inner())
	})
	.await
}

fn get_native_host_installation_status_blocking(
	state: &AppState,
) -> Result<NativeHostInstallationStatus, String> {
	state
		.native_host_installation
		.lock()
		.map(|status| status.clone())
		.map_err(|_| "Native Messagingホストの状態を確認できませんでした。".to_string())
}

#[tauri::command]
async fn repair_native_host_installation(
	app: AppHandle,
) -> Result<NativeHostInstallationStatus, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		repair_native_host_installation_blocking(state.inner())
	})
	.await
}

fn repair_native_host_installation_blocking(
	state: &AppState,
) -> Result<NativeHostInstallationStatus, String> {
	let status = native_host_registration_status();
	let mut current = state
		.native_host_installation
		.lock()
		.map_err(|_| "Native Messagingホストの修復状態を保存できませんでした。".to_string())?;
	*current = status.clone();
	Ok(status)
}

#[tauri::command]
async fn rebuild_library(
	rebuild_index: bool,
	app: AppHandle,
) -> Result<LibraryMaintenanceSummary, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		let mut progress = |event| emit_library_maintenance_progress(&app, event);
		rebuild_library_blocking(rebuild_index, state.inner(), &mut progress)
	})
	.await
}

fn rebuild_library_blocking(
	rebuild_index: bool,
	state: &AppState,
	progress: &mut dyn FnMut(LibraryMaintenanceProgress),
) -> Result<LibraryMaintenanceSummary, String> {
	let mut database_state = state.database.lock().map_err(|_| {
		eprintln!("ライブラリ再構築時にSQLiteの状態ロックが破損しています");
		"保存先を再スキャンできませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	let database = database_state.ready_mut()?;
	let mut index_state = state.index_engine.lock().map_err(|_| {
		eprintln!("ライブラリ再構築時に全文索引の状態ロックが破損しています");
		"検索索引を再構築できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	if index_state.engine.is_none() {
		if let Some(quarantine_path) = repair_index_storage(&mut index_state)? {
			eprintln!(
				"開けなかった検索索引を退避しました: {}",
				quarantine_path.display()
			);
		}
	}
	if database
		.initial_setup_saved_at()
		.map_err(|error| {
			eprintln!("検索索引復旧時に初期設定状態を確認できませんでした: {error}");
			"検索索引を再構築できませんでした。".to_string()
		})?
		.is_none()
	{
		index_state.needs_rebuild = false;
		return Ok(LibraryMaintenanceSummary::default());
	}

	index_state.needs_rebuild = true;
	let result = {
		let index_engine = index_state.ready_mut()?;
		LibraryMaintenance::reconcile_with_progress(database, index_engine, rebuild_index, progress)
	};
	match result {
		Ok(summary) => {
			index_state.needs_rebuild = false;
			Ok(summary)
		}
		Err(error) => {
			eprintln!("保存先の再スキャンと検索索引の再構築に失敗しました: {error}");
			Err(
				"保存先を再スキャンできませんでした。資料の保存完了後にブラウザを閉じ、保存先を確認して再試行してください。"
					.to_string(),
			)
		}
	}
}

fn emit_library_maintenance_progress(app: &AppHandle, progress: LibraryMaintenanceProgress) {
	if let Err(error) = app.emit(LIBRARY_MAINTENANCE_PROGRESS_EVENT, progress) {
		eprintln!("ライブラリ整合処理の進捗を画面へ通知できませんでした: {error}");
	}
}

#[tauri::command]
async fn change_library_root(app: AppHandle) -> Result<LibraryRootChangeResponse, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		change_library_root_blocking(&app, state.inner())
	})
	.await
}

fn change_library_root_blocking(
	app: &AppHandle,
	state: &AppState,
) -> Result<LibraryRootChangeResponse, String> {
	let selected = app.dialog().file().blocking_pick_folder();
	let Some(selected) = selected else {
		return Ok(cancelled_library_root_change());
	};
	let new_root = dialog_path(selected, "新しい保存先")?;
	let confirmed = app
		.dialog()
		.message(
			"保存先の設定だけを選択したフォルダーへ変更します。既存ルールは保持し、資料ファイルは移動・削除しません。続けて再スキャンと検索索引の再構築を行います。続行しますか？",
		)
		.title("保存先を変更")
		.kind(MessageDialogKind::Warning)
		.buttons(MessageDialogButtons::OkCancelCustom(
			"変更する".to_string(),
			"キャンセル".to_string(),
		))
		.blocking_show();
	if !confirmed {
		return Ok(cancelled_library_root_change());
	}

	let mut database_state = state.database.lock().map_err(|_| {
		eprintln!("保存先変更時にSQLiteの状態ロックが破損しています");
		"保存先を変更できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	let database = database_state.ready_mut()?;
	let mut index_state = state.index_engine.lock().map_err(|_| {
		eprintln!("保存先変更時に全文索引の状態ロックが破損しています");
		"保存先を変更できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	if index_state.engine.is_none() {
		if let Some(quarantine_path) = repair_index_storage(&mut index_state)? {
			eprintln!(
				"保存先変更前に開けなかった検索索引を退避しました: {}",
				quarantine_path.display()
			);
		}
	}
	let index_engine = index_state.ready_mut()?;
	let rebased_file_count = database.relocate_base_folder(&new_root).map_err(|error| {
		eprintln!(
			"保存先を {} へ変更できませんでした: {error}",
			new_root.display()
		);
		"保存先を変更できませんでした。読み書きできるフォルダーを選んでください。".to_string()
	})?;

	match LibraryMaintenance::reconcile(database, index_engine, true) {
		Ok(maintenance) => {
			index_state.needs_rebuild = false;
			Ok(LibraryRootChangeResponse {
				cancelled: false,
				changed: true,
				rebased_file_count,
				maintenance: Some(maintenance),
				maintenance_error: None,
			})
		}
		Err(error) => {
			index_state.needs_rebuild = true;
			eprintln!("保存先変更後のライブラリ再構築に失敗しました: {error}");
			Ok(LibraryRootChangeResponse {
				cancelled: false,
				changed: true,
				rebased_file_count,
				maintenance: None,
				maintenance_error: Some(
					"保存先の変更は完了しましたが、再スキャンと検索索引の再構築に失敗しました。ブラウザを閉じ、選択したフォルダーを確認して再構築を実行してください。"
						.to_string(),
				),
			})
		}
	}
}

#[tauri::command]
async fn export_backup(app: AppHandle) -> Result<BackupExportResponse, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		export_backup_blocking(&app, state.inner())
	})
	.await
}

fn export_backup_blocking(
	app: &AppHandle,
	state: &AppState,
) -> Result<BackupExportResponse, String> {
	let selected = app
		.dialog()
		.file()
		.add_filter("Fuzzy SQLiteバックアップ", &["sqlite3", "db"])
		.set_file_name("Fuzzy-backup.sqlite3")
		.blocking_save_file();
	let Some(selected) = selected else {
		return Ok(BackupExportResponse {
			cancelled: true,
			file_path: None,
		});
	};
	let destination = dialog_path(selected, "バックアップの保存先")?;
	let database_state = state.database.lock().map_err(|_| {
		eprintln!("バックアップ書き出し時にSQLiteの状態ロックが破損しています");
		"バックアップを書き出せませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	let database = database_state.ready()?;
	database.export_to(&destination).map_err(|error| {
		eprintln!(
			"SQLiteバックアップを {} へ書き出せませんでした: {error}",
			destination.display()
		);
		"バックアップを書き出せませんでした。既存ファイルを上書きしない保存先を選んでください。"
			.to_string()
	})?;
	Ok(BackupExportResponse {
		cancelled: false,
		file_path: Some(destination.to_string_lossy().into_owned()),
	})
}

#[tauri::command]
async fn import_backup(app: AppHandle) -> Result<BackupImportResponse, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		import_backup_blocking(&app, state.inner())
	})
	.await
}

fn import_backup_blocking(
	app: &AppHandle,
	state: &AppState,
) -> Result<BackupImportResponse, String> {
	let selected = app
		.dialog()
		.file()
		.add_filter("Fuzzy SQLiteバックアップ", &["sqlite3", "db"])
		.blocking_pick_file();
	let Some(selected) = selected else {
		return Ok(cancelled_backup_import());
	};
	let source = dialog_path(selected, "復元するバックアップ")?;
	let confirmed = app
		.dialog()
		.message(
			"現在のFuzzyデータベースを選択したバックアップで置き換えます。保存済みの資料ファイルは移動・削除しません。続行しますか？",
		)
		.title("バックアップから復元")
		.kind(MessageDialogKind::Warning)
		.buttons(MessageDialogButtons::OkCancelCustom(
			"復元する".to_string(),
			"キャンセル".to_string(),
		))
		.blocking_show();
	if !confirmed {
		return Ok(cancelled_backup_import());
	}

	let mut database_state = state.database.lock().map_err(|_| {
		eprintln!("バックアップ復元時にSQLiteの状態ロックが破損しています");
		"バックアップから復元できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	let recovery_copy_path = if database_state.database.is_some() {
		database_state
			.ready_mut()?
			.import_from(&source)
			.map_err(|error| {
				eprintln!(
					"SQLiteバックアップ {} の検証または復元に失敗しました: {error}",
					source.display()
				);
				"バックアップから復元できませんでした。Fuzzyが書き出したSQLiteファイルか確認してください。"
					.to_string()
			})?;
		None
	} else {
		Some(recover_unavailable_database_from_backup(
			&mut database_state,
			&source,
		)?)
	};

	let mut index_state = match state.index_engine.lock() {
		Ok(index_state) => index_state,
		Err(_) => {
			eprintln!("バックアップ復元時に全文索引の状態ロックが破損しています");
			return Ok(BackupImportResponse {
				cancelled: false,
				imported: true,
				recovery_copy_path: recovery_copy_path
					.as_ref()
					.map(|path| path.to_string_lossy().into_owned()),
				maintenance: None,
				maintenance_error: Some(
					"バックアップの復元は完了しましたが、検索索引の状態を更新できませんでした。Fuzzyを再起動してください。"
						.to_string(),
				),
			});
		}
	};
	if let Err(error) = reset_search_index_for_database_change(&mut index_state) {
		eprintln!("バックアップ復元後に検索索引を空にできませんでした: {error}");
		return Ok(BackupImportResponse {
			cancelled: false,
			imported: true,
			recovery_copy_path: recovery_copy_path
				.as_ref()
				.map(|path| path.to_string_lossy().into_owned()),
			maintenance: None,
			maintenance_error: Some(
				"バックアップの復元は完了しましたが、検索索引を準備できませんでした。「検索索引を再構築」を実行してください。"
					.to_string(),
			),
		});
	}

	let database = database_state.ready_mut()?;
	let setup_exists = match database.initial_setup_saved_at() {
		Ok(saved_at) => saved_at.is_some(),
		Err(error) => {
			eprintln!("バックアップ復元後に初期設定状態を確認できませんでした: {error}");
			return Ok(BackupImportResponse {
				cancelled: false,
				imported: true,
				recovery_copy_path: recovery_copy_path
					.as_ref()
					.map(|path| path.to_string_lossy().into_owned()),
				maintenance: None,
				maintenance_error: Some(
					"バックアップの復元は完了しましたが、初期設定状態を確認できませんでした。Fuzzyを再起動してください。"
						.to_string(),
				),
			});
		}
	};
	if !setup_exists {
		index_state.needs_rebuild = false;
		return Ok(BackupImportResponse {
			cancelled: false,
			imported: true,
			recovery_copy_path: recovery_copy_path
				.as_ref()
				.map(|path| path.to_string_lossy().into_owned()),
			maintenance: Some(LibraryMaintenanceSummary::default()),
			maintenance_error: None,
		});
	}

	let maintenance_result = match index_state.ready_mut() {
		Ok(index_engine) => LibraryMaintenance::reconcile(database, index_engine, false),
		Err(error) => {
			eprintln!("バックアップ復元後に検索索引へ接続できませんでした: {error}");
			return Ok(BackupImportResponse {
				cancelled: false,
				imported: true,
				recovery_copy_path: recovery_copy_path
					.as_ref()
					.map(|path| path.to_string_lossy().into_owned()),
				maintenance: None,
				maintenance_error: Some(
					"バックアップの復元は完了しましたが、検索索引へ接続できませんでした。検索索引を再構築してください。"
						.to_string(),
				),
			});
		}
	};
	match maintenance_result {
		Ok(maintenance) => {
			index_state.needs_rebuild = false;
			Ok(BackupImportResponse {
				cancelled: false,
				imported: true,
				recovery_copy_path: recovery_copy_path
					.as_ref()
					.map(|path| path.to_string_lossy().into_owned()),
				maintenance: Some(maintenance),
				maintenance_error: None,
			})
		}
		Err(error) => {
			index_state.needs_rebuild = true;
			eprintln!("バックアップ復元後のライブラリ再構築に失敗しました: {error}");
			Ok(BackupImportResponse {
				cancelled: false,
				imported: true,
				recovery_copy_path: recovery_copy_path
					.as_ref()
					.map(|path| path.to_string_lossy().into_owned()),
				maintenance: None,
				maintenance_error: Some(
					"バックアップの復元は完了しましたが、保存先の再スキャンと検索索引の再構築に失敗しました。保存先を確認し、「保存先を再スキャンして検索索引を再構築」を実行してください。"
						.to_string(),
				),
			})
		}
	}
}

#[tauri::command]
async fn create_fresh_database(app: AppHandle) -> Result<FreshDatabaseResponse, String> {
	run_blocking_command(move || {
		let state = app.state::<AppState>();
		create_fresh_database_blocking(&app, state.inner())
	})
	.await
}

fn create_fresh_database_blocking(
	app: &AppHandle,
	state: &AppState,
) -> Result<FreshDatabaseResponse, String> {
	let confirmed = app
		.dialog()
		.message(
			"開けないSQLite正本を別名の復旧用フォルダーへ保全し、新しいFuzzyデータベースを作成します。設定と履歴は初期状態になりますが、保存済みの資料ファイルは移動・削除しません。バックアップがない場合だけ実行してください。",
		)
		.title("破損DBを保全して新しく開始")
		.kind(MessageDialogKind::Warning)
		.buttons(MessageDialogButtons::OkCancelCustom(
			"保全して新しく開始".to_string(),
			"キャンセル".to_string(),
		))
		.blocking_show();
	if !confirmed {
		return Ok(FreshDatabaseResponse {
			cancelled: true,
			created: false,
			recovery_copy_path: None,
			index_error: None,
		});
	}

	let mut database_state = state.database.lock().map_err(|_| {
		eprintln!("新規SQLite作成時に状態ロックが破損しています");
		"新しいデータベースを作成できませんでした。Fuzzyを再起動してください。".to_string()
	})?;
	if database_state.database.is_some() {
		return Err(
			"SQLite正本は正常に利用できるため、新規作成は実行しません。必要な場合は先にバックアップを書き出してください。"
				.to_string(),
		);
	}
	let recovery_copy_path = create_fresh_database_from_unavailable(&mut database_state)?;

	let mut index_state = match state.index_engine.lock() {
		Ok(index_state) => index_state,
		Err(_) => {
			eprintln!("新規SQLite作成後に全文索引の状態ロックが破損しています");
			return Ok(FreshDatabaseResponse {
				cancelled: false,
				created: true,
				recovery_copy_path: Some(
					recovery_copy_path.to_string_lossy().into_owned(),
				),
				index_error: Some(
					"新しいデータベースは作成しましたが、検索索引を初期化できませんでした。Fuzzyを再起動してください。"
						.to_string(),
				),
			});
		}
	};
	let index_error = reset_search_index_for_database_change(&mut index_state)
		.err()
		.map(|error| {
			eprintln!("新規SQLite作成後に検索索引を初期化できませんでした: {error}");
			"検索索引を初期化できませんでした。画面から検索索引を再構築してください。".to_string()
		});
	if index_error.is_none() {
		index_state.needs_rebuild = false;
	}

	Ok(FreshDatabaseResponse {
		cancelled: false,
		created: true,
		recovery_copy_path: Some(recovery_copy_path.to_string_lossy().into_owned()),
		index_error,
	})
}

fn dialog_path(path: FilePath, label: &str) -> Result<PathBuf, String> {
	path.into_path().map_err(|error| {
		eprintln!("{label}をローカルパスへ変換できませんでした: {error}");
		format!("{label}を読み取れませんでした。")
	})
}

fn cancelled_backup_import() -> BackupImportResponse {
	BackupImportResponse {
		cancelled: true,
		imported: false,
		recovery_copy_path: None,
		maintenance: None,
		maintenance_error: None,
	}
}

fn cancelled_library_root_change() -> LibraryRootChangeResponse {
	LibraryRootChangeResponse {
		cancelled: true,
		changed: false,
		rebased_file_count: 0,
		maintenance: None,
		maintenance_error: None,
	}
}

struct DatabaseFileQuarantine {
	original_path: PathBuf,
	directory: PathBuf,
	moved_files: Vec<(PathBuf, PathBuf)>,
}

impl DatabaseFileQuarantine {
	fn restore_original(&mut self) -> Result<(), String> {
		for (original, quarantined) in self.moved_files.iter().rev() {
			std::fs::rename(quarantined, original).map_err(|error| {
				format!(
					"退避したSQLiteファイルを {} へ戻せません: {error}",
					original.display()
				)
			})?;
		}
		self.moved_files.clear();
		if self
			.directory
			.read_dir()
			.map(|mut entries| entries.next().is_none())
			.unwrap_or(false)
		{
			let _ = std::fs::remove_dir(&self.directory);
		}
		Ok(())
	}
}

struct PathQuarantine {
	original_path: PathBuf,
	quarantined_path: PathBuf,
}

impl PathQuarantine {
	fn restore(self) -> Result<(), String> {
		std::fs::rename(&self.quarantined_path, &self.original_path).map_err(|error| {
			format!(
				"退避した検索索引を {} へ戻せません: {error}",
				self.original_path.display()
			)
		})
	}
}

fn recover_unavailable_database_from_backup(
	state: &mut DatabaseRuntimeState,
	source: &Path,
) -> Result<PathBuf, String> {
	let path = unavailable_database_path(state)?;
	let mut quarantine = quarantine_database_files(&path, "recovery")?;
	let recovered = Database::open(&path).and_then(|mut database| {
		database.import_from(source)?;
		Ok(database)
	});
	match recovered {
		Ok(database) => {
			state.database = Some(database);
			state.path = Some(path);
			Ok(quarantine.directory)
		}
		Err(error) => {
			eprintln!(
				"復旧待ちSQLiteへバックアップ {} を取り込めませんでした: {error}",
				source.display()
			);
			rollback_database_recovery_attempt(&path, &mut quarantine)?;
			Err(
				"バックアップから復元できませんでした。Fuzzyが書き出したSQLiteファイルか確認してください。元のDBは変更前の場所へ戻しました。"
					.to_string(),
			)
		}
	}
}

fn create_fresh_database_from_unavailable(
	state: &mut DatabaseRuntimeState,
) -> Result<PathBuf, String> {
	let path = unavailable_database_path(state)?;
	let mut quarantine = quarantine_database_files(&path, "recovery")?;
	match Database::open(&path) {
		Ok(database) => {
			state.database = Some(database);
			state.path = Some(path);
			Ok(quarantine.directory)
		}
		Err(error) => {
			eprintln!(
				"破損SQLiteの退避後に新規DBを {} へ作成できませんでした: {error}",
				path.display()
			);
			rollback_database_recovery_attempt(&path, &mut quarantine)?;
			Err(
				"新しいデータベースを作成できませんでした。元のDBは変更前の場所へ戻しました。"
					.to_string(),
			)
		}
	}
}

fn unavailable_database_path(state: &mut DatabaseRuntimeState) -> Result<PathBuf, String> {
	let path = match state.path.clone() {
		Some(path) => path,
		None => resolve_db_path().map_err(|error| {
			eprintln!("SQLite復旧時にDBパスを決定できませんでした: {error}");
			"SQLite正本の保存先を決定できませんでした。Windowsのアプリデータ保存先を確認してください。"
				.to_string()
		})?,
	};
	state.path = Some(path.clone());
	Ok(path)
}

fn quarantine_database_files(
	database_path: &Path,
	label: &str,
) -> Result<DatabaseFileQuarantine, String> {
	if !database_path.exists() {
		return Err(
			"退避対象のSQLiteファイルが見つかりません。保存先のアクセス権を確認してください。"
				.to_string(),
		);
	}
	let directory = unique_sibling_path(database_path, label)?;
	std::fs::create_dir(&directory).map_err(|error| {
		eprintln!(
			"SQLite退避用フォルダー {} を作成できませんでした: {error}",
			directory.display()
		);
		"破損DBを保全するフォルダーを作成できませんでした。".to_string()
	})?;

	let mut candidates = vec![
		append_path_suffix(database_path, "-wal"),
		append_path_suffix(database_path, "-shm"),
		append_path_suffix(database_path, "-journal"),
		database_path.to_path_buf(),
	];
	candidates.retain(|candidate| candidate.exists());
	let mut moved_files = Vec::new();
	for original in candidates {
		let Some(file_name) = original.file_name() else {
			rollback_moved_files(&moved_files);
			let _ = std::fs::remove_dir(&directory);
			return Err("SQLite退避対象の名前を読み取れませんでした。".to_string());
		};
		let quarantined = directory.join(file_name);
		if let Err(error) = std::fs::rename(&original, &quarantined) {
			eprintln!(
				"SQLiteファイル {} を {} へ退避できませんでした: {error}",
				original.display(),
				quarantined.display()
			);
			rollback_moved_files(&moved_files);
			let _ = std::fs::remove_dir(&directory);
			return Err(
				"破損DBを安全に保全できませんでした。ブラウザを閉じて再試行してください。"
					.to_string(),
			);
		}
		moved_files.push((original, quarantined));
	}
	Ok(DatabaseFileQuarantine {
		original_path: database_path.to_path_buf(),
		directory,
		moved_files,
	})
}

fn rollback_database_recovery_attempt(
	database_path: &Path,
	original_quarantine: &mut DatabaseFileQuarantine,
) -> Result<(), String> {
	if database_path.exists() {
		match quarantine_database_files(database_path, "failed-recovery-attempt") {
			Ok(failed_attempt) => {
				eprintln!(
					"失敗した復旧試行のSQLiteを保全しました: {}",
					failed_attempt.directory.display()
				);
			}
			Err(error) => {
				eprintln!("失敗した復旧試行のSQLiteを退避できませんでした: {error}");
				return Err(
					"復旧に失敗し、元のDBを自動で戻せませんでした。Fuzzyを終了し、復旧用フォルダーを保全してください。"
						.to_string(),
				);
			}
		}
	}
	original_quarantine.restore_original().map_err(|error| {
		eprintln!(
			"SQLite復旧失敗後に元のDB {} を戻せませんでした: {error}",
			original_quarantine.original_path.display()
		);
		"復旧に失敗し、元のDBを自動で戻せませんでした。復旧用フォルダーは削除せず保全されています。"
			.to_string()
	})
}

fn rollback_moved_files(moved_files: &[(PathBuf, PathBuf)]) {
	for (original, quarantined) in moved_files.iter().rev() {
		if let Err(error) = std::fs::rename(quarantined, original) {
			eprintln!(
				"SQLite退避失敗後に {} を戻せませんでした: {error}",
				original.display()
			);
		}
	}
}

fn reset_search_index_for_database_change(
	state: &mut IndexRuntimeState,
) -> Result<Option<PathBuf>, String> {
	if let Some(engine) = state.engine.as_mut() {
		match engine.clear() {
			Ok(()) => {
				state.needs_rebuild = true;
				return Ok(None);
			}
			Err(error) => {
				eprintln!("既存の検索索引を空にできないため保存領域を再作成します: {error}");
			}
		}
	}
	state.engine.take();
	repair_index_storage(state)
}

fn repair_index_storage(state: &mut IndexRuntimeState) -> Result<Option<PathBuf>, String> {
	drop(state.engine.take());
	let path = match state.path.clone() {
		Some(path) => path,
		None => resolve_index_path().map_err(|error| {
			eprintln!("検索索引復旧時に保存先を決定できませんでした: {error}");
			"検索索引の保存先を決定できませんでした。".to_string()
		})?,
	};
	state.path = Some(path.clone());
	let mut quarantine = quarantine_path_entry(&path, "recovery-index")?;

	match DefaultIndexEngine::open(&path) {
		Ok(engine) => {
			state.engine = Some(engine);
			state.needs_rebuild = true;
			Ok(quarantine.take().map(|entry| entry.quarantined_path))
		}
		Err(error) => {
			eprintln!(
				"検索索引の保存領域を {} に再作成できませんでした: {error}",
				path.display()
			);
			if path.exists() {
				match quarantine_path_entry(&path, "failed-index-attempt") {
					Ok(Some(failed)) => eprintln!(
						"失敗した索引再作成の内容を退避しました: {}",
						failed.quarantined_path.display()
					),
					Ok(None) => {}
					Err(backup_error) => {
						eprintln!("失敗した索引再作成の内容を退避できませんでした: {backup_error}");
					}
				}
			}
			if let Some(original) = quarantine {
				if let Err(restore_error) = original.restore() {
					eprintln!("元の検索索引を戻せませんでした: {restore_error}");
				}
			}
			state.engine = None;
			state.needs_rebuild = true;
			Err(
				"検索索引を再生成できませんでした。SQLite正本と資料ファイルは変更していません。"
					.to_string(),
			)
		}
	}
}

fn quarantine_path_entry(path: &Path, label: &str) -> Result<Option<PathQuarantine>, String> {
	if !path.exists() {
		return Ok(None);
	}
	let quarantined_path = unique_sibling_path(path, label)?;
	std::fs::rename(path, &quarantined_path).map_err(|error| {
		eprintln!(
			"検索索引 {} を {} へ退避できませんでした: {error}",
			path.display(),
			quarantined_path.display()
		);
		"検索索引を安全に退避できませんでした。ブラウザを閉じて再試行してください。".to_string()
	})?;
	Ok(Some(PathQuarantine {
		original_path: path.to_path_buf(),
		quarantined_path,
	}))
}

fn unique_sibling_path(path: &Path, label: &str) -> Result<PathBuf, String> {
	let parent = path
		.parent()
		.filter(|parent| !parent.as_os_str().is_empty())
		.ok_or_else(|| "復旧対象の親フォルダーを決定できませんでした。".to_string())?;
	let file_name = path
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or("fuzzy-data");
	let nonce = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis();
	for attempt in 0..1000 {
		let candidate = parent.join(format!(
			"{file_name}.{label}-{nonce}-{}-{attempt}",
			std::process::id()
		));
		if !candidate.exists() {
			return Ok(candidate);
		}
	}
	Err("重複しない復旧用の名前を作成できませんでした。".to_string())
}

fn append_path_suffix(path: &Path, suffix: &str) -> PathBuf {
	let mut value = path.as_os_str().to_os_string();
	value.push(suffix);
	PathBuf::from(value)
}

fn representative_folders(entries: &[FileEntry]) -> Vec<String> {
	entries
		.iter()
		.filter_map(|entry| entry.relative_path.parent())
		.filter(|parent| !parent.as_os_str().is_empty())
		.map(|parent| parent.to_string_lossy().replace('\\', "/"))
		.collect::<BTreeSet<_>>()
		.into_iter()
		.take(8)
		.collect()
}

fn display_pattern_name(template: &str) -> String {
	template
		.split(['/', '\\'])
		.map(|segment| match segment {
			"{year}" => "年度".to_string(),
			"{term}" => "学期".to_string(),
			"{course}" => "科目".to_string(),
			"{assignment}" => "課題".to_string(),
			"{section}" | "第{section}回" => "回次".to_string(),
			other => other
				.replace("{year}", "年度")
				.replace("{term}", "学期")
				.replace("{course}", "科目")
				.replace("{assignment}", "課題")
				.replace("{section}", "回次"),
		})
		.collect::<Vec<_>>()
		.join(" / ")
}

fn display_file_name_pattern(template: &str) -> &'static str {
	match template {
		"{section}_{filename}" => "回次付きファイル名",
		_ => "固有のファイル名規則",
	}
}

fn native_host_registration_status() -> NativeHostInstallationStatus {
	match native_host_installation::register_from_current_executable() {
		Ok(()) => NativeHostInstallationStatus::ready(),
		Err(error) => {
			eprintln!("Native Messagingホストの自動登録に失敗しました: {error}");
			NativeHostInstallationStatus::failed()
		}
	}
}

pub fn register_native_host() -> Result<(), String> {
	native_host_installation::register_from_current_executable()
}

pub fn unregister_native_host() -> Result<(), String> {
	native_host_installation::unregister()
}

fn initialize_database_runtime_state() -> DatabaseRuntimeState {
	match resolve_db_path() {
		Ok(path) => match Database::open(&path) {
			Ok(database) => DatabaseRuntimeState {
				database: Some(database),
				path: Some(path),
			},
			Err(error) => {
				eprintln!(
					"SQLiteデータベース {} を開けませんでした。GUI復旧を待機します: {error}",
					path.display()
				);
				DatabaseRuntimeState {
					database: None,
					path: Some(path),
				}
			}
		},
		Err(error) => {
			eprintln!("SQLiteデータベースの保存先を決定できませんでした: {error}");
			DatabaseRuntimeState {
				database: None,
				path: None,
			}
		}
	}
}

fn database_needs_index_rebuild(state: &DatabaseRuntimeState, index_metadata_exists: bool) -> bool {
	let Some(database) = state.database.as_ref() else {
		return false;
	};
	match database.has_unindexed_active_documents() {
		Ok(true) => return true,
		Ok(false) => {}
		Err(error) => {
			eprintln!("SQLite正本から検索索引の未反映状態を確認できませんでした: {error}");
			return true;
		}
	}

	if index_metadata_exists {
		return false;
	}

	match database.has_indexed_active_documents() {
		Ok(has_indexed_documents) => has_indexed_documents,
		Err(error) => {
			eprintln!("SQLite正本から検索索引の既存反映状態を確認できませんでした: {error}");
			true
		}
	}
}

fn index_storage_metadata_exists(path: &Path) -> bool {
	path.join("meta.json").is_file()
}

fn initialize_index_runtime_state(database_state: &DatabaseRuntimeState) -> IndexRuntimeState {
	match resolve_index_path() {
		Ok(path) => {
			let index_metadata_existed = index_storage_metadata_exists(&path);
			let database_needs_rebuild =
				database_needs_index_rebuild(database_state, index_metadata_existed);
			match DefaultIndexEngine::open(&path) {
				Ok(engine) => IndexRuntimeState {
					engine: Some(engine),
					path: Some(path),
					needs_rebuild: database_needs_rebuild,
				},
				Err(error) => {
					eprintln!(
						"全文検索索引 {} を開けませんでした。GUI復旧を待機します: {error}",
						path.display()
					);
					IndexRuntimeState {
						engine: None,
						path: Some(path),
						needs_rebuild: true,
					}
				}
			}
		}
		Err(error) => {
			eprintln!("全文検索索引の保存先を決定できませんでした: {error}");
			IndexRuntimeState {
				engine: None,
				path: None,
				needs_rebuild: true,
			}
		}
	}
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let native_host_installation = native_host_registration_status();
	let database = initialize_database_runtime_state();
	let index_engine = initialize_index_runtime_state(&database);

	tauri::Builder::default()
		.manage(AppState {
			database: Mutex::new(database),
			index_engine: Mutex::new(index_engine),
			native_host_installation: Mutex::new(native_host_installation),
		})
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_opener::init())
		.invoke_handler(tauri::generate_handler![
			pick_base_folder,
			scan_existing_structure,
			save_initial_setup,
			get_setup_status,
			get_extension_setup_status,
			get_extension_recovery_status,
			get_application_recovery_status,
			get_native_host_installation_status,
			repair_native_host_installation,
			rebuild_library,
			change_library_root,
			export_backup,
			import_backup,
			create_fresh_database
		])
		.run(tauri::generate_context!())
		.expect("Fuzzyデスクトップアプリの実行中にエラーが発生しました");
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;
	use std::time::{SystemTime, UNIX_EPOCH};

	use engine_core::types::SavedFileRegistration;
	use engine_core::Database;

	use super::{
		create_fresh_database_from_unavailable, database_needs_index_rebuild, display_pattern_name,
		index_storage_metadata_exists, quarantine_database_files,
		recover_unavailable_database_from_backup, repair_index_storage, run_blocking_command,
		scan_existing_structure_blocking, DatabaseRuntimeState, IndexRuntimeState,
	};

	fn test_directory(name: &str) -> PathBuf {
		std::env::temp_dir().join(format!(
			"fuzzy-desktop-{name}-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		))
	}

	#[test]
	fn displays_estimated_rule_tokens_in_japanese() {
		assert_eq!(
			display_pattern_name("{term}/{course}/第{section}回"),
			"学期 / 科目 / 回次"
		);
	}

	#[test]
	fn scan_candidates_keep_deep_roles_file_rules_and_candidate_examples() {
		let directory = test_directory("deep-pattern");
		let first = directory.join("2026年度/1年前期/画像処理/第3回/資料.txt");
		let second = directory.join("2026年度/1年前期/画像処理/第4回/演習.txt");
		std::fs::create_dir_all(first.parent().unwrap()).unwrap();
		std::fs::create_dir_all(second.parent().unwrap()).unwrap();
		std::fs::write(&first, "image").unwrap();
		std::fs::write(&second, "filter").unwrap();

		let candidates =
			scan_existing_structure_blocking(directory.to_string_lossy().into_owned()).unwrap();

		assert_eq!(candidates.len(), 1);
		assert_eq!(candidates[0].course_segment_index, Some(2));
		assert_eq!(candidates[0].match_score, Some(100));
		assert_eq!(candidates[0].evaluated_count, 2);
		assert_eq!(candidates[0].file_name_template, None);
		assert!(candidates[0]
			.folders
			.iter()
			.all(|folder| folder.contains("画像処理")));
		assert!(!candidates[0].requires_confirmation);
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn ambiguous_scan_returns_an_unselected_confirmation_candidate_without_zero_percent() {
		let directory = test_directory("ambiguous-pattern");
		for relative in ["資料/共有/A.txt", "配布物/共通/B.txt"] {
			let path = directory.join(relative);
			std::fs::create_dir_all(path.parent().unwrap()).unwrap();
			std::fs::write(path, "sample").unwrap();
		}

		let candidates =
			scan_existing_structure_blocking(directory.to_string_lossy().into_owned()).unwrap();

		assert_eq!(candidates.len(), 1);
		assert_eq!(candidates[0].id, "manual-unclassified");
		assert_eq!(candidates[0].match_score, None);
		assert_eq!(candidates[0].course_segment_index, None);
		assert!(!candidates[0].recommended);
		assert!(candidates[0].requires_confirmation);
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn runs_blocking_commands_outside_the_calling_thread() {
		let caller = std::thread::current().id();
		let worker = tauri::async_runtime::block_on(run_blocking_command(move || {
			Ok(std::thread::current().id())
		}))
		.unwrap();

		assert_ne!(caller, worker);
	}

	#[test]
	fn quarantines_and_restores_sqlite_with_sidecars() {
		let directory = test_directory("quarantine");
		std::fs::create_dir_all(&directory).unwrap();
		let database_path = directory.join("fuzzy.db");
		let wal_path = PathBuf::from(format!("{}-wal", database_path.display()));
		std::fs::write(&database_path, b"corrupt-main").unwrap();
		std::fs::write(&wal_path, b"corrupt-wal").unwrap();

		let mut quarantine = quarantine_database_files(&database_path, "test").unwrap();
		assert!(!database_path.exists());
		assert!(!wal_path.exists());
		assert_eq!(
			std::fs::read(quarantine.directory.join("fuzzy.db")).unwrap(),
			b"corrupt-main"
		);
		assert_eq!(
			std::fs::read(quarantine.directory.join("fuzzy.db-wal")).unwrap(),
			b"corrupt-wal"
		);

		quarantine.restore_original().unwrap();
		assert_eq!(std::fs::read(&database_path).unwrap(), b"corrupt-main");
		assert_eq!(std::fs::read(&wal_path).unwrap(), b"corrupt-wal");
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn restores_backup_into_unavailable_runtime_state() {
		let directory = test_directory("restore");
		std::fs::create_dir_all(&directory).unwrap();
		let source_path = directory.join("source.db");
		let backup_path = directory.join("backup.sqlite3");
		let source = Database::open(&source_path).unwrap();
		source.export_to(&backup_path).unwrap();
		drop(source);

		let target_path = directory.join("fuzzy.db");
		std::fs::write(&target_path, b"corrupt-database").unwrap();
		let mut state = DatabaseRuntimeState {
			database: None,
			path: Some(target_path.clone()),
		};
		let recovery_copy =
			recover_unavailable_database_from_backup(&mut state, &backup_path).unwrap();

		assert!(state.database.is_some());
		assert!(Database::open(&target_path).is_ok());
		assert_eq!(
			std::fs::read(recovery_copy.join("fuzzy.db")).unwrap(),
			b"corrupt-database"
		);
		drop(state);
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn restores_original_database_when_backup_recovery_fails() {
		let directory = test_directory("restore-rollback");
		std::fs::create_dir_all(&directory).unwrap();
		let target_path = directory.join("fuzzy.db");
		let backup_path = directory.join("invalid-backup.sqlite3");
		std::fs::write(&target_path, b"original-corrupt-database").unwrap();
		std::fs::write(&backup_path, b"not-a-sqlite-backup").unwrap();
		let mut state = DatabaseRuntimeState {
			database: None,
			path: Some(target_path.clone()),
		};

		let error = recover_unavailable_database_from_backup(&mut state, &backup_path).unwrap_err();

		assert!(error.contains("元のDBは変更前の場所へ戻しました"));
		assert!(state.database.is_none());
		assert_eq!(
			std::fs::read(&target_path).unwrap(),
			b"original-corrupt-database"
		);
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn creates_fresh_database_only_after_preserving_corrupt_file() {
		let directory = test_directory("fresh");
		std::fs::create_dir_all(&directory).unwrap();
		let target_path = directory.join("fuzzy.db");
		std::fs::write(&target_path, b"corrupt-database").unwrap();
		let mut state = DatabaseRuntimeState {
			database: None,
			path: Some(target_path.clone()),
		};

		let recovery_copy = create_fresh_database_from_unavailable(&mut state).unwrap();
		assert!(state.database.is_some());
		assert!(Database::open(&target_path).is_ok());
		assert_eq!(
			std::fs::read(recovery_copy.join("fuzzy.db")).unwrap(),
			b"corrupt-database"
		);
		drop(state);
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn detects_unindexed_documents_after_restart_and_cross_process_updates() {
		let directory = test_directory("index-state");
		std::fs::create_dir_all(&directory).unwrap();
		let database_path = directory.join("fuzzy.db");
		let index_path = directory.join("search-index");
		std::fs::create_dir(&index_path).unwrap();
		std::fs::write(index_path.join("meta.json"), b"{}").unwrap();
		let native_host_database = Database::open(&database_path).unwrap();
		let file_id = native_host_database
			.register_saved_file(&SavedFileRegistration {
				course_id: None,
				section_no: None,
				moodle_file_id: Some("resource-41".to_string()),
				original_name: "第4回_正規化.txt".to_string(),
				saved_path: directory.join("第4回_正規化.txt"),
				size_bytes: 1,
				mime_type: Some("text/plain".to_string()),
				hash_blake3: "b3:test-41".to_string(),
				simhash: 0,
			})
			.unwrap();
		let restarted_desktop = DatabaseRuntimeState {
			database: Some(Database::open(&database_path).unwrap()),
			path: Some(database_path),
		};

		assert!(index_storage_metadata_exists(&index_path));
		assert!(database_needs_index_rebuild(&restarted_desktop, true));
		native_host_database
			.mark_search_indexed(file_id, Some(1))
			.unwrap();
		assert!(!database_needs_index_rebuild(&restarted_desktop, true));

		std::fs::remove_dir_all(&index_path).unwrap();
		assert!(!index_storage_metadata_exists(&index_path));
		assert!(database_needs_index_rebuild(&restarted_desktop, false));

		drop(restarted_desktop);
		drop(native_host_database);
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn repairs_corrupt_index_storage_without_touching_database() {
		let directory = test_directory("index");
		std::fs::create_dir_all(&directory).unwrap();
		let index_path = directory.join("search-index");
		std::fs::write(&index_path, b"not-a-directory").unwrap();
		let mut state = IndexRuntimeState {
			engine: None,
			path: Some(index_path.clone()),
			needs_rebuild: true,
		};

		let quarantine = repair_index_storage(&mut state).unwrap().unwrap();
		assert!(state.engine.is_some());
		assert!(state.needs_rebuild);
		assert!(index_path.is_dir());
		assert_eq!(std::fs::read(quarantine).unwrap(), b"not-a-directory");
		drop(state);
		std::fs::remove_dir_all(directory).unwrap();
	}
}
