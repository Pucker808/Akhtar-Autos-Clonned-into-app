//! Akhtar Autos Desktop — Tauri library entry.
//!
//! Phase 2 TX: schema + health + create-with-confirm + transactional mutations,
//! bulk import, backup/restore, FIFO read helpers.
//! Business accounting (FIFO formulas, balances) stays in TypeScript ops.ts.
//! Dexie remains the default persistence until explicit cutover approval.

mod db;
mod db_tx;
mod storage;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Akhtar Autos ready, {name}!")
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

#[tauri::command]
fn check_database_path(path: String) -> Result<db::DbHealth, String> {
    db::check_path(&path).map_err(|e| e.to_string())
}

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

#[tauri::command]
fn ensure_data_layout(root: String) -> Result<(), String> {
    db::ensure_layout_for_root(&root).map_err(|e| e.to_string())
}

#[tauri::command]
fn apply_db_mutations(
    path: String,
    request_id: String,
    mutations: Vec<db_tx::Mutation>,
) -> Result<db_tx::TxResult, String> {
    db_tx::apply_mutations(&path, &request_id, mutations).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_db_snapshot(
    path: String,
    tables: std::collections::HashMap<String, Vec<serde_json::Value>>,
    confirm_overwrite: bool,
) -> Result<db_tx::ImportReport, String> {
    db_tx::import_snapshot(&path, tables, confirm_overwrite).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_db_table(path: String, table: String) -> Result<Vec<serde_json::Value>, String> {
    db_tx::export_table(&path, &table).map_err(|e| e.to_string())
}

#[tauri::command]
fn backup_database(source: String, destination: String) -> Result<db_tx::BackupReport, String> {
    db_tx::backup_database(&source, &destination).map_err(|e| e.to_string())
}

#[tauri::command]
fn restore_database(
    backup_path: String,
    target_path: String,
    confirm_restore: bool,
) -> Result<db::DbHealth, String> {
    db_tx::restore_database(&backup_path, &target_path, confirm_restore).map_err(|e| e.to_string())
}

#[tauri::command]
fn query_batches_fifo(
    path: String,
    item_id: i64,
    location_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    db_tx::query_batches_fifo(&path, item_id, location_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn query_stock_qty(path: String, item_id: i64, location_id: Option<i64>) -> Result<f64, String> {
    db_tx::query_stock_qty(&path, item_id, location_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_db_row(path: String, table: String, id: i64) -> Result<Option<serde_json::Value>, String> {
    db_tx::get_row(&path, &table, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_db_rows(
    path: String,
    table: String,
    filter_col: Option<String>,
    filter_val: Option<serde_json::Value>,
    limit: Option<i64>,
) -> Result<Vec<serde_json::Value>, String> {
    db_tx::list_rows(&path, &table, filter_col, filter_val, limit).map_err(|e| e.to_string())
}

/// Registers every command. Shared by the app and the IPC contract tests.
fn with_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        greet,
        get_default_data_root,
        get_default_database_path,
        check_database_path,
        create_database,
        get_schema_info,
        get_table_counts,
        get_meta_value,
        ensure_data_layout,
        apply_db_mutations,
        import_db_snapshot,
        export_db_table,
        backup_database,
        restore_database,
        query_batches_fifo,
        query_stock_qty,
        get_db_row,
        list_db_rows
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_commands(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running Akhtar Autos Desktop");
}

#[cfg(test)]
mod tests;
