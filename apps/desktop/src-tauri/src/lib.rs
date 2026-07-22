use std::sync::Mutex;

use engine_core::{Database, ExtensionSetupStatus};
use tauri::State;

struct AppState {
	database: Mutex<Database>,
}

#[tauri::command]
fn get_extension_setup_status(
	since: String,
	state: State<'_, AppState>,
) -> Result<ExtensionSetupStatus, String> {
	let database = state
		.database
		.lock()
		.map_err(|_| "SQLiteの状態ロックを取得できませんでした".to_string())?;
	database
		.extension_setup_status_since(&since)
		.map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let database = Database::open_default().expect("SQLiteデータベースを開けませんでした");

	tauri::Builder::default()
		.manage(AppState {
			database: Mutex::new(database),
		})
		.plugin(tauri_plugin_opener::init())
		.invoke_handler(tauri::generate_handler![get_extension_setup_status])
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
