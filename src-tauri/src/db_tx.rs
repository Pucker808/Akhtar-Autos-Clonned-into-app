//! Transactional writes, bulk import, and backup/restore for Akhtar Autos Desktop.
//!
//! Safety:
//! - Never creates a missing database file (open_readwrite refuses).
//! - Import refuses non-empty DBs unless confirm_overwrite is true (after safety backup).
//! - Restore always safety-renames the current DB first when it exists.
//! - Accounting (FIFO, balances) remains in TypeScript; this module applies
//!   pre-validated row mutations atomically.

use crate::db::{self, DbError, DbHealth};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Ordered list of allowed tables for import / mutation (matches schema v1).
pub const TABLE_ORDER: &[&str] = &[
    "meta",
    "locations",
    "customers",
    "suppliers",
    "items",
    "batches",
    "ledger",
    "sales",
    "sale_returns",
    "purchases",
    "purchase_returns",
    "payments",
    "expenses",
    "audit",
];

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    /// insert | update | delete
    pub op: String,
    pub table: String,
    /// Row payload (snake_case keys matching SQLite columns). For update/delete, must include id or key.
    pub row: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TxResult {
    pub applied: usize,
    pub last_insert_ids: HashMap<String, i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub path: String,
    pub tables: HashMap<String, i64>,
    pub warnings: Vec<String>,
    pub safety_backup: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    pub source: String,
    pub destination: String,
    pub size_bytes: u64,
    pub message: String,
}

fn open_rw(path: &str) -> Result<Connection, DbError> {
    db::open_readwrite(path)
}

/// Apply an ordered list of mutations inside a single SQLite transaction.
/// On any error the entire transaction is rolled back.
pub fn apply_mutations(path: &str, mutations: Vec<Mutation>) -> Result<TxResult, DbError> {
    let mut conn = open_rw(path)?;
    let tx = conn.transaction().map_err(DbError::from)?;
    let mut last_insert_ids: HashMap<String, i64> = HashMap::new();
    let mut applied = 0usize;

    for m in &mutations {
        if !TABLE_ORDER.contains(&m.table.as_str()) {
            return Err(DbError::Message(format!("unknown table: {}", m.table)));
        }
        match m.op.as_str() {
            "insert" => {
                let id = insert_row(&tx, &m.table, &m.row)?;
                if let Some(id) = id {
                    last_insert_ids.insert(format!("{}:{}", m.table, applied), id);
                }
            }
            "update" => update_row(&tx, &m.table, &m.row)?,
            "delete" => delete_row(&tx, &m.table, &m.row)?,
            other => return Err(DbError::Message(format!("unknown op: {other}"))),
        }
        applied += 1;
    }

    tx.commit().map_err(DbError::from)?;
    Ok(TxResult {
        applied,
        last_insert_ids,
    })
}

fn row_map(row: &Value) -> Result<&serde_json::Map<String, Value>, DbError> {
    row.as_object()
        .ok_or_else(|| DbError::Message("row must be a JSON object".into()))
}

fn insert_row(conn: &Connection, table: &str, row: &Value) -> Result<Option<i64>, DbError> {
    let map = row_map(row)?;
    let cols: Vec<&str> = map.keys().map(|s| s.as_str()).collect();
    if cols.is_empty() {
        return Err(DbError::Message("empty insert row".into()));
    }
    let placeholders: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        cols.join(", "),
        placeholders.join(", ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let values: Vec<Value> = cols.iter().map(|c| map.get(*c).cloned().unwrap_or(Value::Null)).collect();
    bind_and_execute(&mut stmt, &values)?;
    Ok(Some(conn.last_insert_rowid()))
}

fn update_row(conn: &Connection, table: &str, row: &Value) -> Result<(), DbError> {
    let map = row_map(row)?;
    // meta uses key; others use id
    if table == "meta" {
        let key = map
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| DbError::Message("meta update requires key".into()))?;
        let value = map
            .get("value")
            .ok_or_else(|| DbError::Message("meta update requires value".into()))?;
        let value_s = match value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        conn.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value_s],
        )?;
        return Ok(());
    }
    let id = map
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| DbError::Message(format!("{table} update requires id")))?;
    let sets: Vec<String> = map
        .keys()
        .filter(|k| k.as_str() != "id")
        .enumerate()
        .map(|(i, k)| format!("{k} = ?{}", i + 2))
        .collect();
    if sets.is_empty() {
        return Ok(());
    }
    let sql = format!("UPDATE {table} SET {} WHERE id = ?1", sets.join(", "));
    let mut stmt = conn.prepare(&sql)?;
    let mut values: Vec<Value> = vec![Value::from(id)];
    for k in map.keys().filter(|k| k.as_str() != "id") {
        values.push(map.get(k).cloned().unwrap_or(Value::Null));
    }
    bind_and_execute(&mut stmt, &values)?;
    Ok(())
}

fn delete_row(conn: &Connection, table: &str, row: &Value) -> Result<(), DbError> {
    let map = row_map(row)?;
    if table == "meta" {
        let key = map
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| DbError::Message("meta delete requires key".into()))?;
        conn.execute("DELETE FROM meta WHERE key = ?1", params![key])?;
        return Ok(());
    }
    let id = map
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| DbError::Message(format!("{table} delete requires id")))?;
    conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])?;
    Ok(())
}

fn bind_and_execute(stmt: &mut rusqlite::Statement<'_>, values: &[Value]) -> Result<(), DbError> {
    use rusqlite::types::Value as SqlValue;
    let params: Vec<SqlValue> = values
        .iter()
        .map(|v| match v {
            Value::Null => SqlValue::Null,
            Value::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    SqlValue::Integer(i)
                } else if let Some(f) = n.as_f64() {
                    SqlValue::Real(f)
                } else {
                    SqlValue::Text(n.to_string())
                }
            }
            Value::String(s) => SqlValue::Text(s.clone()),
            other => SqlValue::Text(other.to_string()),
        })
        .collect();
    stmt.execute(rusqlite::params_from_iter(params.iter()))?;
    Ok(())
}

/// Read all rows of a table as JSON objects (snake_case column names).
pub fn export_table(path: &str, table: &str) -> Result<Vec<Value>, DbError> {
    if !TABLE_ORDER.contains(&table) {
        return Err(DbError::Message(format!("unknown table: {table}")));
    }
    let conn = db::open_readonly(path)?;
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table}"))?;
    let col_count = stmt.column_count();
    let names: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut map = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let v: rusqlite::types::Value = row.get(i)?;
            map.insert(name.clone(), sql_to_json(v));
        }
        out.push(Value::Object(map));
    }
    Ok(out)
}

fn sql_to_json(v: rusqlite::types::Value) -> Value {
    match v {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(i) => Value::from(i),
        rusqlite::types::Value::Real(f) => Value::from(f),
        rusqlite::types::Value::Text(s) => Value::String(s),
        rusqlite::types::Value::Blob(b) => Value::String(format!("blob:{}bytes", b.len())),
    }
}

/// Import a full snapshot. Preserves IDs. Requires confirm_overwrite if target has any data rows.
/// Creates a safety backup of the existing DB file when overwriting.
pub fn import_snapshot(
    path: &str,
    tables: HashMap<String, Vec<Value>>,
    confirm_overwrite: bool,
) -> Result<ImportReport, DbError> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(DbError::NotFound(path.to_string()));
    }

    // Detect non-empty
    let health = db::check_path(path)?;
    let mut non_empty = false;
    if let Some(counts) = &health.table_counts {
        non_empty = counts.iter().any(|(t, c)| t != "meta" && *c > 0)
            || counts.get("meta").copied().unwrap_or(0) > 2; // schema_version + app allowed
    }

    let mut safety_backup = None;
    if non_empty {
        if !confirm_overwrite {
            return Err(DbError::Message(
                "Database is not empty. Pass confirm_overwrite=true after user confirmation. A safety backup will be taken."
                    .into(),
            ));
        }
        let backup_path = format!(
            "{}.pre-import-{}",
            path,
            chrono::Utc::now().format("%Y%m%d%H%M%S")
        );
        std::fs::copy(path, &backup_path)?;
        safety_backup = Some(backup_path);
    }

    let mut conn = open_rw(path)?;
    let mut warnings = Vec::new();

    // Disable FK during bulk load; re-enable and verify after.
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let tx = conn.transaction().map_err(DbError::from)?;

    // Clear existing data in reverse dependency order when overwriting
    if non_empty {
        for t in TABLE_ORDER.iter().rev() {
            if *t == "meta" {
                // keep schema_version/app; clear other meta keys later via replace
                continue;
            }
            tx.execute(&format!("DELETE FROM {t}"), [])?;
        }
    }

    let mut result_counts: HashMap<String, i64> = HashMap::new();

    for table in TABLE_ORDER {
        let rows = match tables.get(*table) {
            Some(r) => r,
            None => continue,
        };
        let mut n = 0i64;
        for row in rows {
            match insert_row_preserve_id(&tx, table, row) {
                Ok(()) => n += 1,
                Err(e) => {
                    warnings.push(format!("{table}: skipped row ({e})"));
                }
            }
        }
        result_counts.insert((*table).to_string(), n);
    }

    // Ensure schema_version meta
    tx.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1')",
        [],
    )?;
    tx.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('app', 'Akhtar Autos Desktop')",
        [],
    )?;

    tx.commit().map_err(DbError::from)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    // Integrity
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if !integrity.eq_ignore_ascii_case("ok") {
        return Err(DbError::Integrity(integrity));
    }

    // FK check
    let mut fk_stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let fk_rows: Vec<String> = fk_stmt
        .query_map([], |r| {
            Ok(format!(
                "{}:{} -> {}",
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?
            ))
        })?
        .filter_map(|x| x.ok())
        .collect();
    if !fk_rows.is_empty() {
        warnings.push(format!(
            "foreign_key_check reported {} issue(s): {}",
            fk_rows.len(),
            fk_rows.into_iter().take(5).collect::<Vec<_>>().join("; ")
        ));
    }

    Ok(ImportReport {
        path: path.to_string(),
        tables: result_counts,
        warnings,
        safety_backup,
        message: "Import completed. Verify counts against source before switching persistence mode."
            .into(),
    })
}

fn insert_row_preserve_id(conn: &Connection, table: &str, row: &Value) -> Result<(), DbError> {
    let map = row_map(row)?;
    if table == "meta" {
        let key = map
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| DbError::Message("meta row missing key".into()))?;
        let value = map.get("value").cloned().unwrap_or(Value::Null);
        let value_s = match value {
            Value::String(s) => s,
            other => other.to_string(),
        };
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)",
            params![key, value_s],
        )?;
        return Ok(());
    }
    let cols: Vec<&str> = map.keys().map(|s| s.as_str()).collect();
    let placeholders: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "INSERT OR REPLACE INTO {table} ({}) VALUES ({})",
        cols.join(", "),
        placeholders.join(", ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let values: Vec<Value> = cols.iter().map(|c| map.get(*c).cloned().unwrap_or(Value::Null)).collect();
    bind_and_execute(&mut stmt, &values)?;
    Ok(())
}

/// Checkpoint WAL and copy DB to destination (simple consistent backup for offline use).
pub fn backup_database(source: &str, destination: &str) -> Result<BackupReport, DbError> {
    let src = Path::new(source);
    if !src.exists() {
        return Err(DbError::NotFound(source.to_string()));
    }
    if let Some(parent) = Path::new(destination).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    // Checkpoint so the main file is consistent.
    {
        let conn = open_rw(source)?;
        conn.execute_batch("PRAGMA wal_checkpoint(FULL);")?;
    }
    std::fs::copy(source, destination)?;
    // Best-effort: copy -wal/-shm if still present (should be empty after FULL)
    for suffix in ["-wal", "-shm"] {
        let s = format!("{source}{suffix}");
        let d = format!("{destination}{suffix}");
        if Path::new(&s).exists() {
            let _ = std::fs::copy(&s, &d);
        }
    }
    let size_bytes = std::fs::metadata(destination)?.len();
    Ok(BackupReport {
        source: source.to_string(),
        destination: destination.to_string(),
        size_bytes,
        message: "Backup written after WAL checkpoint.".into(),
    })
}

/// Restore from backup path into target. Safety-renames existing target first.
pub fn restore_database(
    backup_path: &str,
    target_path: &str,
    confirm_restore: bool,
) -> Result<DbHealth, DbError> {
    if !confirm_restore {
        return Err(DbError::Message(
            "Restore refused: confirm_restore must be true".into(),
        ));
    }
    let backup = Path::new(backup_path);
    if !backup.exists() {
        return Err(DbError::NotFound(backup_path.to_string()));
    }
    // Validate backup first
    let health = db::check_path(backup_path)?;
    if !health.integrity_ok {
        return Err(DbError::Integrity(health.message));
    }

    let target = Path::new(target_path);
    if target.exists() {
        let safety = format!(
            "{}.pre-restore-{}",
            target_path,
            chrono::Utc::now().format("%Y%m%d%H%M%S")
        );
        std::fs::rename(target, &safety)?;
        for suffix in ["-wal", "-shm"] {
            let s = format!("{target_path}{suffix}");
            if Path::new(&s).exists() {
                let _ = std::fs::rename(&s, format!("{safety}{suffix}"));
            }
        }
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::copy(backup_path, target_path)?;
    db::check_path(target_path)
}

/// Query batches for FIFO (ordered by date, id). Read-only.
pub fn query_batches_fifo(
    path: &str,
    item_id: i64,
    location_id: i64,
) -> Result<Vec<Value>, DbError> {
    let conn = db::open_readonly(path)?;
    let mut stmt = conn.prepare(
        "SELECT id, item_id, location_id, qty, remaining, unit_cost, date, supplier_id, source, ref_id, created_at, updated_at, device_id
         FROM batches
         WHERE item_id = ?1 AND location_id = ?2 AND remaining > 0
         ORDER BY date ASC, id ASC",
    )?;
    let mut rows = stmt.query(params![item_id, location_id])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut map = serde_json::Map::new();
        map.insert("id".into(), Value::from(row.get::<_, i64>(0)?));
        map.insert("item_id".into(), Value::from(row.get::<_, i64>(1)?));
        map.insert("location_id".into(), Value::from(row.get::<_, i64>(2)?));
        map.insert("qty".into(), Value::from(row.get::<_, f64>(3)?));
        map.insert("remaining".into(), Value::from(row.get::<_, f64>(4)?));
        map.insert("unit_cost".into(), Value::from(row.get::<_, i64>(5)?));
        map.insert("date".into(), Value::from(row.get::<_, i64>(6)?));
        map.insert(
            "supplier_id".into(),
            match row.get::<_, Option<i64>>(7)? {
                Some(v) => Value::from(v),
                None => Value::Null,
            },
        );
        map.insert("source".into(), Value::String(row.get::<_, String>(8)?));
        map.insert(
            "ref_id".into(),
            match row.get::<_, Option<i64>>(9)? {
                Some(v) => Value::from(v),
                None => Value::Null,
            },
        );
        map.insert("created_at".into(), Value::from(row.get::<_, i64>(10)?));
        map.insert("updated_at".into(), Value::from(row.get::<_, i64>(11)?));
        map.insert("device_id".into(), Value::String(row.get::<_, String>(12)?));
        out.push(Value::Object(map));
    }
    Ok(out)
}

/// Stock quantity from ledger sum (optional location filter).
pub fn query_stock_qty(
    path: &str,
    item_id: i64,
    location_id: Option<i64>,
) -> Result<f64, DbError> {
    let conn = db::open_readonly(path)?;
    let qty: f64 = if let Some(loc) = location_id {
        conn.query_row(
            "SELECT COALESCE(SUM(qty), 0) FROM ledger WHERE item_id = ?1 AND location_id = ?2",
            params![item_id, loc],
            |r| r.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COALESCE(SUM(qty), 0) FROM ledger WHERE item_id = ?1",
            params![item_id],
            |r| r.get(0),
        )?
    };
    Ok(qty)
}

/// Fetch a single row by id as JSON.
pub fn get_row(path: &str, table: &str, id: i64) -> Result<Option<Value>, DbError> {
    if !TABLE_ORDER.contains(&table) || table == "meta" {
        return Err(DbError::Message("get_row supports entity tables with id".into()));
    }
    let conn = db::open_readonly(path)?;
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table} WHERE id = ?1"))?;
    let col_count = stmt.column_count();
    let names: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        let mut map = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let v: rusqlite::types::Value = row.get(i)?;
            map.insert(name.clone(), sql_to_json(v));
        }
        Ok(Some(Value::Object(map)))
    } else {
        Ok(None)
    }
}

/// List rows from a table with optional simple equality filter on one column.
pub fn list_rows(
    path: &str,
    table: &str,
    filter_col: Option<String>,
    filter_val: Option<Value>,
    limit: Option<i64>,
) -> Result<Vec<Value>, DbError> {
    if !TABLE_ORDER.contains(&table) {
        return Err(DbError::Message(format!("unknown table: {table}")));
    }
    let conn = db::open_readonly(path)?;
    let lim = limit.unwrap_or(10_000);
    let (sql, use_filter) = if let (Some(col), Some(_)) = (&filter_col, &filter_val) {
        (
            format!("SELECT * FROM {table} WHERE {col} = ?1 LIMIT {lim}"),
            true,
        )
    } else {
        (format!("SELECT * FROM {table} LIMIT {lim}"), false)
    };
    let mut stmt = conn.prepare(&sql)?;
    let col_count = stmt.column_count();
    let names: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();
    let mut rows = if use_filter {
        let v = filter_val.unwrap();
        match v {
            Value::Number(n) if n.as_i64().is_some() => stmt.query(params![n.as_i64().unwrap()])?,
            Value::String(s) => stmt.query(params![s])?,
            _ => stmt.query(params![v.to_string()])?,
        }
    } else {
        stmt.query([])?
    };
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut map = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let v: rusqlite::types::Value = row.get(i)?;
            map.insert(name.clone(), sql_to_json(v));
        }
        out.push(Value::Object(map));
    }
    Ok(out)
}
