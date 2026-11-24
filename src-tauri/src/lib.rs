//! Akhtar Autos Desktop — Tauri library entry.
//!
//! Phase 1 foundation:
//! - App shell and identity
//! - Storage path resolution (default AppData + user-configurable)
//! - SQLite open/health-check stubs (no silent empty DB creation)
//!
//! Business ops remain in the React/TS layer (Dexie) until SQLite migration
//! is completed in later phases.

mod db;
mod storage;

use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Akhtar Autos ready, {}!", name)
}

/// Returns the resolved default data root for this platform.
#[tauri::command]
fn get_default_data_root() -> Result<String, String> {
    storage::default_data_root()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// Health-check status for a database path. Never creates a new DB.
#[tauri::command]
fn check_database_path(path: String) -> Result<db::DbHealth, String> {
    db::check_path(&path).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_default_data_root,
            check_database_path
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                let _ = app.handle();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Akhtar Autos Desktop");
}
