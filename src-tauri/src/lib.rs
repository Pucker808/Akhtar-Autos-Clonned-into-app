//! Akhtar Autos Desktop — Tauri library entry.
//!
//! Phase 2: SQLite foundation (schema, health, create-with-confirm, read helpers).
//! Business ops remain in TypeScript (ops.ts) behind an adapter feature flag.
//! Dexie remains available until explicit cutover approval.

mod db;
mod storage;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Akhtar Autos ready, {}!", name)
}

#[tauri::command]
fn get_default_data_root() -> Result<String, String> {
    storage::default_data_root()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_default_database_path() -> Result<String, String> {
    db::default_db_path_string().map_err(|e| e.to_string())
}

/// Health-check status for a database path. Never creates a new DB.
#[tauri::command]
fn check_database_path(path: String) -> Result<db::DbHealth, String> {
    db::check_path(&path).map_err(|e| e.to_string())
}

/// Create a new empty database only when confirm_create is true and path does not exist.
#[tauri::command]
fn create_database(path: String, confirm_create: bool) -> Result<db::DbHealth, String> {
    db::create_new_database(&path, confirm_create).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_schema_info(path: String) -> Result<db::SchemaInfo, String> {
    db::schema_info(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_table_counts(path: String) -> Result<Vec<db::TableCount>, String> {
    db::table_counts(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_meta_value(path: String, key: String) -> Result<Option<String>, String> {
    db::get_meta(&path, &key).map_err(|e| e.to_string())
}

/// Ensure hybrid folder layout under a data root without creating a database file.
#[tauri::command]
fn ensure_data_layout(root: String) -> Result<(), String> {
    db::ensure_layout_for_root(&root).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_default_data_root,
            get_default_database_path,
            check_database_path,
            create_database,
            get_schema_info,
            get_table_counts,
            get_meta_value,
            ensure_data_layout
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Akhtar Autos Desktop");
}
