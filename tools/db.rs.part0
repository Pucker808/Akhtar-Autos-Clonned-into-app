//! SQLite access layer for Akhtar Autos Desktop (Phase 2 foundation).
//!
//! Safety rules:
//! - Never silently create a new empty database when a path is missing or corrupt.
//! - `create_new_database` requires an explicit `confirm_create: true` flag.
//! - Business rules (FIFO, payments, balances) stay in TypeScript ops.ts.
//! - This module owns schema, connection, health, and read helpers.

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Current schema version. Bump only with a migration path.
pub const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database file not found at {0}")]
    NotFound(String),
    #[error("path is not a file: {0}")]
    NotAFile(String),
    #[error("database already exists at {0}")]
    AlreadyExists(String),
    #[error("create refused: confirm_create must be true")]
    CreateNotConfirmed,
    #[error("parent directory missing for {0}")]
    ParentMissing(String),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("integrity check failed: {0}")]
    Integrity(String),
    #[error("schema version mismatch: found {found}, expected {expected}")]
    SchemaMismatch { found: i64, expected: i64 },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbHealth {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub size_bytes: u64,
    pub integrity_ok: bool,
    pub schema_version: Option<i64>,
    pub table_counts: Option<std::collections::HashMap<String, i64>>,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub version: i64,
    pub tables: Vec<String>,
    pub foreign_keys_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableCount {
    pub table: String,
    pub count: i64,
}

/// Inspect a path without creating anything. Safe for recovery UI.
pub fn check_path(path: &str) -> Result<DbHealth, DbError> {
    let p = Path::new(path);
    if !p.exists() {
        return Ok(DbHealth {
            path: path.to_string(),
            exists: false,
            is_file: false,
            size_bytes: 0,
            integrity_ok: false,
            schema_version: None,
            table_counts: None,
            message: "Database file not found. Use recovery to locate, restore, or create new."
                .into(),
        });
    }
    if !p.is_file() {
        return Err(DbError::NotAFile(path.to_string()));
    }
    let size_bytes = std::fs::metadata(p)?.len();

    let conn = Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    let integrity_ok = integrity.eq_ignore_ascii_case("ok");

    let schema_version = read_schema_version(&conn);

    let table_counts = if integrity_ok {
        Some(count_all_tables(&conn)?)
    } else {
        None
    };

    Ok(DbHealth {
        path: path.to_string(),
        exists: true,
        is_file: true,
        size_bytes,
        integrity_ok,
        schema_version,
        table_counts,
        message: if integrity_ok {
            "Database is readable and integrity check passed.".into()
        } else {
            format!("Integrity check reported: {integrity}")
        },
    })
}

fn read_schema_version(conn: &Connection) -> Option<i64> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|s| s.parse().ok())
    .or_else(|| conn.query_row("PRAGMA user_version", [], |r| r.get(0)).ok())
}

fn count_all_tables(conn: &Connection) -> Result<std::collections::HashMap<String, i64>, DbError> {
    let tables = [
        "meta",
        "items",
        "locations",
        "batches",
        "ledger",
        "customers",
        "suppliers",
        "sales",
        "sale_returns",
        "purchases",
        "purchase_returns",
        "payments",
        "expenses",
        "audit",
    ];
    let mut map = std::collections::HashMap::new();
    for t in tables {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                [t],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if exists {
            let c: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))?;
            map.insert(t.to_string(), c);
        }
    }
    Ok(map)
}

/// Open an existing database read-only. Does not create the file.
pub fn open_readonly(path: &str) -> Result<Connection, DbError> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(DbError::NotFound(path.to_string()));
    }
    if !p.is_file() {
        return Err(DbError::NotAFile(path.to_string()));
    }
    let conn = Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(conn)
}

/// Open an existing database read-write. Does not create a missing file.
pub fn open_readwrite(path: &str) -> Result<Connection, DbError> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(DbError::NotFound(path.to_string()));
    }
    if !p.is_file() {
        return Err(DbError::NotAFile(path.to_string()));
    }
    let conn = Connection::open_with_flags(
        p,
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;\nPRAGMA busy_timeout = 5000;",
    )?;
    Ok(conn)
}

/// Create a brand-new database only when `confirm_create` is true and the path
/// does not already exist. Refuses to overwrite.
pub fn create_new_database(path: &str, confirm_create: bool) -> Result<DbHealth, DbError> {
    if !confirm_create {
        return Err(DbError::CreateNotConfirmed);
    }
    let p = Path::new(path);
    if p.exists() {
        return Err(DbError::AlreadyExists(path.to_string()));
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(DbError::ParentMissing(parent.display().to_string()));
        }
    }

    let conn = Connection::open_with_flags(
        p,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    conn.execute_batch(INIT_SCHEMA_SQL)?;
    conn.execute(
        "PRAGMA user_version = ?1",
        [SCHEMA_VERSION],
    )?;
    drop(conn);

    check_path(path)
}

/// Schema info for an existing DB (read-only).
pub fn schema_info(path: &str) -> Result<SchemaInfo, DbError> {
