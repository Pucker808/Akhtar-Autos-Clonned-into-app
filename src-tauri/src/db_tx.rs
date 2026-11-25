//! Transactional writes, bulk import, and backup/restore for Akhtar Autos Desktop.
//!
//! Safety:
//! - Never creates a missing database file (open_readwrite refuses).
//! - Only operates on databases that pass `db::verify_app_schema`.
//! - Table and column names are checked against the live schema before they are
//!   placed in SQL. Values are always bound parameters.
//! - Value types are checked: INTEGER columns (money in paisa, dates in ms, ids)
//!   accept integers only, so fractional paisa can never be stored.
//! - Mutation batches and imports are all-or-nothing. No row is skipped or replaced.
//! - Import refuses non-empty DBs unless confirm_overwrite is true (after safety backup).
//! - Backups use SQLite's online backup API (WAL-aware) and never overwrite a file.
//! - Restore stages and validates a copy, then moves the current DB aside (never deletes it).
//! - Accounting (FIFO, balances) remains in TypeScript; this module applies
//!   pre-validated row mutations atomically.

use crate::db::{self, DbError, DbHealth, SIDECARS};
use rusqlite::backup::Backup;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// Ordered list of allowed tables for import / mutation (matches schema v1).
pub const TABLE_ORDER: &[&str] = db::TABLES;

/// Meta keys owned by the schema. Callers can never change or remove them.
const RESERVED_META: &[&str] = &["schema_version", "app"];
/// Meta key prefix recording applied mutation batches (duplicate protection).
const REQUEST_PREFIX: &str = "tx_request:";
/// Largest integer that survives a round trip through JavaScript.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_LIST_LIMIT: i64 = 100_000;
/// Money fields inside `lines_json`; all are integer paisa.
const LINE_MONEY_KEYS: &[&str] = &["price", "discount", "cogs", "unitCost", "amount", "cost"];

/// Serializes file-level operations (writes, backup, restore) within this process.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn write_lock() -> MutexGuard<'static, ()> {
    // The guard protects no in-memory state, so a poisoned lock is safe to reuse.
    WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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
    /// True when this request id had already been committed; nothing was written again.
    #[serde(default)]
    pub duplicate: bool,
}

#[derive(Serialize, Deserialize)]
struct RequestRecord {
    fingerprint: String,
    result: TxResult,
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

fn fail<T>(message: impl Into<String>) -> Result<T, DbError> {
    Err(DbError::Message(message.into()))
}

fn ensure_known_table(table: &str) -> Result<(), DbError> {
    if TABLE_ORDER.contains(&table) {
        Ok(())
    } else {
        fail(format!("unknown table: {table}"))
    }
}

/// Column name -> declared type, read from the live schema. `table` must be allow-listed.
fn columns(conn: &Connection, table: &str) -> Result<HashMap<String, String>, DbError> {
    ensure_known_table(table)?;
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn integer_value(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .filter(|i| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(i))
}

fn check_line_money(value: &Value) -> Result<(), DbError> {
    match value {
        Value::Array(items) => items.iter().try_for_each(check_line_money),
        Value::Object(map) => map.iter().try_for_each(|(key, v)| {
            if LINE_MONEY_KEYS.contains(&key.as_str()) && integer_value(v).is_none() {
                return fail(format!(
                    "lines_json field '{key}' must be integer paisa, got {v}"
                ));
            }
            check_line_money(v)
        }),
        _ => Ok(()),
    }
}

/// Convert a JSON value to the SQLite value allowed by the column's declared type.
fn to_sql(column: &str, declared: &str, value: &Value) -> Result<SqlValue, DbError> {
    if value.is_null() {
        return Ok(SqlValue::Null);
    }
    let converted = match declared {
        "INTEGER" => match value {
            Value::Bool(b) => Some(SqlValue::Integer(i64::from(*b))),
            other => integer_value(other).map(SqlValue::Integer),
        },
        "REAL" => value.as_f64().map(SqlValue::Real),
        "TEXT" => value.as_str().map(|s| SqlValue::Text(s.to_owned())),
        _ => None,
    };
    let Some(converted) = converted else {
        return fail(format!(
            "column '{column}' requires {declared}, got {value}"
        ));
    };
    if column == "lines_json" {
        let parsed: Value = match value.as_str().map(serde_json::from_str) {
            Some(Ok(v @ Value::Array(_))) => v,
            _ => return fail("lines_json must be a JSON array"),
        };
        check_line_money(&parsed)?;
    }
    Ok(converted)
}

/// Validated (column, value) pairs for a row. Rejects any key that is not a real column.
fn bind_row(
    conn: &Connection,
    table: &str,
    map: &serde_json::Map<String, Value>,
) -> Result<Vec<(String, SqlValue)>, DbError> {
    let schema = columns(conn, table)?;
    map.iter()
        .map(|(key, value)| match schema.get(key) {
            Some(declared) => Ok((key.clone(), to_sql(key, declared, value)?)),
            None => fail(format!("table {table} has no column named {key:?}")),
        })
        .collect()
}

fn row_map(row: &Value) -> Result<&serde_json::Map<String, Value>, DbError> {
    row.as_object()
        .ok_or_else(|| DbError::Message("row must be a JSON object".into()))
}

fn required_id(table: &str, map: &serde_json::Map<String, Value>) -> Result<i64, DbError> {
    map.get("id")
        .and_then(integer_value)
        .filter(|id| *id > 0)
        .ok_or_else(|| DbError::Message(format!("{table} row requires a positive integer id")))
}

fn meta_key(map: &serde_json::Map<String, Value>) -> Result<&str, DbError> {
    match map.get("key").and_then(Value::as_str) {
        Some(key) if !key.is_empty() => Ok(key),
        _ => fail("meta row requires a non-empty text key"),
    }
}

/// A key the caller is allowed to write.
fn writable_meta_key(map: &serde_json::Map<String, Value>) -> Result<&str, DbError> {
    let key = meta_key(map)?;
    if RESERVED_META.contains(&key) || key.starts_with(REQUEST_PREFIX) {
        return fail(format!("meta key '{key}' is reserved"));
    }
    Ok(key)
}

/// Plain INSERT: duplicate ids / unique keys are errors, never replacements.
fn insert_row(conn: &Connection, table: &str, row: &Value) -> Result<i64, DbError> {
    let map = row_map(row)?;
    if map.is_empty() {
        return fail("empty insert row");
    }
    let bound = bind_row(conn, table, map)?;
    let names: Vec<&str> = bound.iter().map(|(c, _)| c.as_str()).collect();
    let placeholders: Vec<String> = (1..=bound.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        names.join(", "),
        placeholders.join(", ")
    );
    conn.execute(
        &sql,
        rusqlite::params_from_iter(bound.iter().map(|(_, v)| v)),
    )?;
    Ok(conn.last_insert_rowid())
}

fn expect_one_row(changed: usize, table: &str, what: &str) -> Result<(), DbError> {
    if changed == 1 {
        Ok(())
    } else {
        fail(format!("{table} {what}: target row not found"))
    }
}

fn update_row(conn: &Connection, table: &str, row: &Value) -> Result<(), DbError> {
    let map = row_map(row)?;
    // meta uses key and has upsert semantics (like Dexie `put`); others use id.
    if table == "meta" {
        let key = writable_meta_key(map)?;
        let Some(value) = map.get("value").and_then(Value::as_str) else {
            return fail("meta update requires a text value");
        };
        conn.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        return Ok(());
    }
    let id = required_id(table, map)?;
    let mut changes = map.clone();
    changes.remove("id");
    if changes.is_empty() {
        return fail(format!("{table} update has no columns to change"));
    }
    let bound = bind_row(conn, table, &changes)?;
    let sets: Vec<String> = bound
        .iter()
        .enumerate()
        .map(|(i, (column, _))| format!("{column} = ?{}", i + 2))
        .collect();
    let sql = format!("UPDATE {table} SET {} WHERE id = ?1", sets.join(", "));
    let values = std::iter::once(SqlValue::Integer(id)).chain(bound.into_iter().map(|(_, v)| v));
    let changed = conn.execute(&sql, rusqlite::params_from_iter(values))?;
    expect_one_row(changed, table, "update")
}

fn delete_row(conn: &Connection, table: &str, row: &Value) -> Result<(), DbError> {
    let map = row_map(row)?;
    let changed = if table == "meta" {
        let key = writable_meta_key(map)?;
        conn.execute("DELETE FROM meta WHERE key = ?1", params![key])?
    } else {
        let id = required_id(table, map)?;
        conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])?
    };
    expect_one_row(changed, table, "delete")
}

/// `payments.party_id` is polymorphic, so SQLite cannot enforce it with a foreign key.
fn check_payment_parties(conn: &Connection) -> Result<(), DbError> {
    let orphan: Option<i64> = conn
        .query_row(
            "SELECT p.id FROM payments p WHERE
               (p.party_type = 'customer' AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = p.party_id)) OR
               (p.party_type = 'supplier' AND NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = p.party_id))
             LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match orphan {
        Some(id) => fail(format!(
            "payment {id} refers to a party that does not exist"
        )),
        None => Ok(()),
    }
}

/// Stable 64-bit FNV-1a, used only to detect a request id reused with different content.
fn fingerprint(mutations: &[Mutation]) -> Result<String, DbError> {
    let bytes = serde_json::to_vec(mutations).map_err(|e| DbError::Message(e.to_string()))?;
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    });
    Ok(format!("{hash:016x}"))
}

/// Apply an ordered list of mutations inside a single SQLite transaction.
/// On any error the entire transaction is rolled back.
///
/// `request_id` identifies one logical business operation. Replaying a committed
/// id returns the original result without writing again.
pub fn apply_mutations(
    path: &str,
    request_id: &str,
    mutations: Vec<Mutation>,
) -> Result<TxResult, DbError> {
    if request_id.trim().is_empty() || request_id.len() > 128 {
        return fail("request_id must contain 1 to 128 characters");
    }
    if mutations.is_empty() {
        return fail("mutation list is empty");
    }
    let print = fingerprint(&mutations)?;
    let record_key = format!("{REQUEST_PREFIX}{request_id}");

    let _guard = write_lock();
    let mut conn = db::open_readwrite(path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let previous: Option<String> = tx
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [&record_key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(stored) = previous {
        let record: RequestRecord =
            serde_json::from_str(&stored).map_err(|e| DbError::Message(e.to_string()))?;
        if record.fingerprint != print {
            return fail(format!(
                "request_id '{request_id}' was already used for different changes"
            ));
        }
        return Ok(TxResult {
            duplicate: true,
            ..record.result
        });
    }

    let mut last_insert_ids = HashMap::new();
    for (index, m) in mutations.iter().enumerate() {
        let outcome = ensure_known_table(&m.table).and_then(|()| match m.op.as_str() {
            "insert" => {
                if m.table == "meta" {
                    writable_meta_key(row_map(&m.row)?)?;
                }
                let id = insert_row(&tx, &m.table, &m.row)?;
                if m.table != "meta" {
                    last_insert_ids.insert(format!("{}:{index}", m.table), id);
                }
                Ok(())
            }
            "update" => update_row(&tx, &m.table, &m.row),
            "delete" => delete_row(&tx, &m.table, &m.row),
            other => fail(format!("unknown op: {other}")),
        });
        // Returning drops `tx`, which rolls back every earlier mutation.
        outcome.map_err(|e| {
            DbError::Message(format!(
                "mutation #{index} ({} {}) failed: {e}",
                m.op, m.table
            ))
        })?;
    }
    check_payment_parties(&tx)?;

    let result = TxResult {
        applied: mutations.len(),
        last_insert_ids,
        duplicate: false,
    };
    let record = serde_json::to_string(&RequestRecord {
        fingerprint: print,
        result: result.clone(),
    })
    .map_err(|e| DbError::Message(e.to_string()))?;
    tx.execute(
        "INSERT INTO meta(key, value) VALUES (?1, ?2)",
        params![record_key, record],
    )?;
    tx.commit()?;
    Ok(result)
}

fn sql_to_json(v: SqlValue) -> Result<Value, DbError> {
    Ok(match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(i) => Value::from(i),
        SqlValue::Real(f) => Value::from(f),
        SqlValue::Text(s) => Value::String(s),
        SqlValue::Blob(_) => return fail("unexpected binary data in database"),
    })
}

fn select_json(
    conn: &Connection,
    sql: &str,
    bind: impl rusqlite::Params,
) -> Result<Vec<Value>, DbError> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|n| n.to_string()).collect();
    let mut rows = stmt.query(bind)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut map = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            map.insert(name.clone(), sql_to_json(row.get(i)?)?);
        }
        out.push(Value::Object(map));
    }
    Ok(out)
}

/// Read all rows of a table as JSON objects (snake_case column names).
pub fn export_table(path: &str, table: &str) -> Result<Vec<Value>, DbError> {
    ensure_known_table(table)?;
    let conn = db::open_readonly(path)?;
    select_json(&conn, &format!("SELECT * FROM {table} ORDER BY rowid"), [])
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// A new sibling path that cannot collide with an earlier safety copy.
fn unique_sibling(path: &Path, label: &str) -> PathBuf {
    let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
    let random = uuid::Uuid::new_v4().simple().to_string();
    sidecar(path, &format!(".{label}-{stamp}-{}", &random[..8]))
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn create_parent(path: &Path) -> Result<(), DbError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    Ok(())
}

fn remove_with_sidecars(path: &Path) {
    let _ = std::fs::remove_file(path);
    for suffix in SIDECARS {
        let _ = std::fs::remove_file(sidecar(path, suffix));
    }
}

/// Integrity, ownership, and referential checks for an open database.
fn verify_contents(conn: &Connection) -> Result<(), DbError> {
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if !integrity.eq_ignore_ascii_case("ok") {
        return Err(DbError::Integrity(integrity));
    }
    db::verify_app_schema(conn)?;
    check_foreign_keys(conn)
}

fn check_foreign_keys(conn: &Connection) -> Result<(), DbError> {
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let violations: Vec<String> = stmt
        .query_map([], |r| {
            Ok(format!(
                "{} row {} -> missing {}",
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?.unwrap_or(-1),
                r.get::<_, String>(2)?
            ))
        })?
        .collect::<Result<_, _>>()?;
    if violations.is_empty() {
        Ok(())
    } else {
        fail(format!(
            "foreign key check failed ({} violation(s)): {}",
            violations.len(),
            violations[..violations.len().min(5)].join("; ")
        ))
    }
}

/// Consistent single-file copy of an open database, including committed WAL content.
/// Writes to a temporary sibling, verifies it, and only then publishes `destination`.
fn copy_database(source: &Connection, destination: &Path) -> Result<(), DbError> {
    if destination.exists() {
        return Err(DbError::AlreadyExists(destination.display().to_string()));
    }
    if SIDECARS.iter().any(|s| sidecar(destination, s).exists()) {
        return fail(format!(
            "leftover SQLite files exist next to {}",
            destination.display()
        ));
    }
    create_parent(destination)?;
    let temp = unique_sibling(destination, "partial");
    let written = (|| -> Result<(), DbError> {
        let mut target = Connection::open(&temp)?;
        Backup::new(source, &mut target)?.run_to_completion(
            256,
            Duration::from_millis(10),
            None,
        )?;
        // Self-contained file: no -wal needed to read it.
        target.query_row("PRAGMA journal_mode = DELETE", [], |_| Ok(()))?;
        verify_contents(&target)
    })();
    let published = written.and_then(|()| {
        if destination.exists() {
            return Err(DbError::AlreadyExists(destination.display().to_string()));
        }
        Ok(std::fs::rename(&temp, destination)?)
    });
    if published.is_err() {
        remove_with_sidecars(&temp);
    }
    published
}

/// Data rows in any table, or any non-schema meta key.
fn has_user_data(conn: &Connection) -> Result<bool, DbError> {
    for table in TABLE_ORDER {
        let sql = if *table == "meta" {
            "SELECT COUNT(*) FROM meta WHERE key NOT IN ('schema_version', 'app')".to_string()
        } else {
            format!("SELECT COUNT(*) FROM {table}")
        };
        if conn.query_row(&sql, [], |r| r.get::<_, i64>(0))? > 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Import a full snapshot. Preserves IDs. All-or-nothing.
///
/// A non-empty target requires `confirm_overwrite`, a snapshot that names every
/// table, and a verified safety backup taken before anything is cleared.
pub fn import_snapshot(
    path: &str,
    tables: HashMap<String, Vec<Value>>,
    confirm_overwrite: bool,
) -> Result<ImportReport, DbError> {
    if let Some(unknown) = tables.keys().find(|t| !TABLE_ORDER.contains(&t.as_str())) {
        return fail(format!("snapshot contains unknown table: {unknown}"));
    }

    let _guard = write_lock();
    let mut conn = db::open_readwrite(path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Parents may arrive after children (e.g. locations.parent_id); checked at the end.
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;

    let mut safety_backup = None;
    if has_user_data(&tx)? {
        if !confirm_overwrite {
            return fail(
                "Database is not empty. Pass confirm_overwrite=true after user confirmation. A safety backup will be taken.",
            );
        }
        if let Some(missing) = TABLE_ORDER.iter().find(|t| !tables.contains_key(**t)) {
            return fail(format!(
                "overwrite refused: snapshot is incomplete (table '{missing}' is absent)"
            ));
        }
        let backup_path = unique_sibling(Path::new(path), "pre-import");
        // A second reader sees the last committed state while we hold the write lock.
        copy_database(&db::open_readonly(path)?, &backup_path)?;
        safety_backup = Some(backup_path.to_string_lossy().into_owned());

        for table in TABLE_ORDER.iter().rev() {
            if *table == "meta" {
                tx.execute(
                    "DELETE FROM meta WHERE key NOT IN ('schema_version', 'app')",
                    [],
                )?;
            } else {
                tx.execute(&format!("DELETE FROM {table}"), [])?;
            }
        }
    }

    let mut result_counts = HashMap::new();
    let mut warnings = Vec::new();
    for table in TABLE_ORDER {
        let rows = tables.get(*table).map(Vec::as_slice).unwrap_or_default();
        let mut inserted = 0i64;
        for (index, row) in rows.iter().enumerate() {
            let outcome = row_map(row).and_then(|map| {
                if *table == "meta" {
                    let key = meta_key(map)?;
                    if RESERVED_META.contains(&key) {
                        warnings.push(format!("meta: kept the target's own '{key}' value"));
                        return Ok(false);
                    }
                } else {
                    required_id(table, map)?;
                }
                insert_row(&tx, table, row).map(|_| true)
            });
            match outcome {
                Ok(true) => inserted += 1,
                Ok(false) => {}
                Err(e) => {
                    return fail(format!(
                        "import aborted, nothing was changed: {table} row #{index}: {e}"
                    ))
                }
            }
        }
        result_counts.insert((*table).to_string(), inserted);
    }

    // Verify everything BEFORE committing so a bad snapshot leaves the target untouched.
    verify_contents(&tx)
        .and_then(|()| check_payment_parties(&tx))
        .map_err(|e| DbError::Message(format!("import aborted, nothing was changed: {e}")))?;
    tx.commit()?;

    Ok(ImportReport {
        path: path.to_string(),
        tables: result_counts,
        warnings,
        safety_backup,
        message:
            "Import completed. Verify counts against source before switching persistence mode."
                .into(),
    })
}

/// WAL-aware backup of a live database. Never overwrites an existing file.
pub fn backup_database(source: &str, destination: &str) -> Result<BackupReport, DbError> {
    let src = Path::new(source);
    let dest = Path::new(destination);
    if same_file(src, dest) {
        return fail("backup destination must differ from the source database");
    }
    let _guard = write_lock();
    let conn = db::open_readonly(source)?;
    copy_database(&conn, dest)?;
    Ok(BackupReport {
        source: source.to_string(),
        destination: destination.to_string(),
        size_bytes: std::fs::metadata(dest)?.len(),
        message: "Backup written and verified.".into(),
    })
}

/// Rename `from` and its sidecars to `to`; undoes partial work on failure.
fn move_database(from: &Path, to: &Path) -> Result<(), DbError> {
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let pairs = std::iter::once((from.to_path_buf(), to.to_path_buf()))
        .chain(SIDECARS.iter().map(|s| (sidecar(from, s), sidecar(to, s))));
    for (a, b) in pairs {
        if !a.exists() {
            continue;
        }
        if let Err(e) = std::fs::rename(&a, &b) {
            for (a, b) in moved.iter().rev() {
                let _ = std::fs::rename(b, a);
            }
            return Err(e.into());
        }
        moved.push((a, b));
    }
    Ok(())
}

/// Restore from a backup into target. The current target is moved aside, not deleted.
/// The caller must make sure no other process has the target open.
pub fn restore_database(
    backup_path: &str,
    target_path: &str,
    confirm_restore: bool,
) -> Result<DbHealth, DbError> {
    if !confirm_restore {
        return fail("Restore refused: confirm_restore must be true");
    }
    let backup = Path::new(backup_path);
    let target = Path::new(target_path);
    if !backup.exists() {
        return Err(DbError::NotFound(backup_path.to_string()));
    }
    if same_file(backup, target) {
        return fail("restore source must differ from the target database");
    }
    if target.exists() && !target.is_file() {
        return Err(DbError::NotAFile(target_path.to_string()));
    }

    let _guard = write_lock();
    // 1. Stage a verified copy first; the target is untouched if anything here fails.
    let staged = unique_sibling(target, "restore-staged");
    {
        let source = Connection::open_with_flags(backup, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        verify_contents(&source)?;
        copy_database(&source, &staged)?;
    }

    // 2. Move the current database (and any stale sidecars) out of the way.
    let safety = unique_sibling(target, "pre-restore");
    if let Err(e) = move_database(target, &safety) {
        remove_with_sidecars(&staged);
        return Err(e);
    }

    // 3. Publish the staged copy; put the original back if that fails.
    if let Err(e) = std::fs::rename(&staged, target) {
        let _ = move_database(&safety, target);
        remove_with_sidecars(&staged);
        return Err(e.into());
    }

    let mut health = db::check_path(target_path)?;
    if safety.exists() {
        health.message = format!(
            "Restored. The previous database was kept at {}",
            safety.display()
        );
    }
    Ok(health)
}

/// Query batches for FIFO (ordered by date, id). Read-only.
pub fn query_batches_fifo(
    path: &str,
    item_id: i64,
    location_id: i64,
) -> Result<Vec<Value>, DbError> {
    let conn = db::open_readonly(path)?;
    select_json(
        &conn,
        "SELECT * FROM batches
         WHERE item_id = ?1 AND location_id = ?2 AND remaining > 0
         ORDER BY date ASC, id ASC",
        params![item_id, location_id],
    )
}

/// Stock quantity from ledger sum (optional location filter).
pub fn query_stock_qty(path: &str, item_id: i64, location_id: Option<i64>) -> Result<f64, DbError> {
    let conn = db::open_readonly(path)?;
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(qty), 0) FROM ledger
         WHERE item_id = ?1 AND (?2 IS NULL OR location_id = ?2)",
        params![item_id, location_id],
        |r| r.get(0),
    )?)
}

/// Fetch a single row by id as JSON.
pub fn get_row(path: &str, table: &str, id: i64) -> Result<Option<Value>, DbError> {
    ensure_known_table(table)?;
    if table == "meta" {
        return fail("get_row supports entity tables with id");
    }
    let conn = db::open_readonly(path)?;
    let rows = select_json(
        &conn,
        &format!("SELECT * FROM {table} WHERE id = ?1"),
        params![id],
    )?;
    Ok(rows.into_iter().next())
}

/// List rows from a table with optional simple equality filter on one column.
pub fn list_rows(
    path: &str,
    table: &str,
    filter_col: Option<String>,
    filter_val: Option<Value>,
    limit: Option<i64>,
) -> Result<Vec<Value>, DbError> {
    ensure_known_table(table)?;
    let limit = limit.unwrap_or(10_000);
    if !(1..=MAX_LIST_LIMIT).contains(&limit) {
        return fail(format!("limit must be between 1 and {MAX_LIST_LIMIT}"));
    }
    let conn = db::open_readonly(path)?;
    match (filter_col, filter_val) {
        (None, None) => select_json(
            &conn,
            &format!("SELECT * FROM {table} ORDER BY rowid LIMIT ?1"),
            params![limit],
        ),
        (Some(column), Some(value)) if !value.is_null() => {
            let schema = columns(&conn, table)?;
            let Some(declared) = schema.get(&column) else {
                return fail(format!("table {table} has no column named {column:?}"));
            };
            // Filtering compares values only, so lines_json content rules do not apply.
            let bound = to_sql("filter", declared, &value)?;
            select_json(
                &conn,
                &format!("SELECT * FROM {table} WHERE {column} = ?1 ORDER BY rowid LIMIT ?2"),
                params![bound, limit],
            )
        }
        // Never silently drop a half-specified filter and return everything.
        _ => fail("filter_col and a non-null filter_val must be provided together"),
    }
}
