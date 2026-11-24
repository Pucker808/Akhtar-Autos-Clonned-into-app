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
    let conn = open_readonly(path)?;
    let version = read_schema_version(&conn).unwrap_or(0);
    let mut tables = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for row in rows {
        tables.push(row?);
    }
    let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    Ok(SchemaInfo {
        version,
        tables,
        foreign_keys_enabled: fk == 1,
    })
}

/// Table row counts (read-only).
pub fn table_counts(path: &str) -> Result<Vec<TableCount>, DbError> {
    let conn = open_readonly(path)?;
    let map = count_all_tables(&conn)?;
    let mut out: Vec<_> = map
        .into_iter()
        .map(|(table, count)| TableCount { table, count })
        .collect();
    out.sort_by(|a, b| a.table.cmp(&b.table));
    Ok(out)
}

/// Read a meta value by key (read-only).
pub fn get_meta(path: &str, key: &str) -> Result<Option<String>, DbError> {
    let conn = open_readonly(path)?;
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v)
}

/// Default DB path string for the platform (does not create files).
pub fn default_db_path_string() -> Result<String, DbError> {
    crate::storage::default_database_path()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| DbError::Message(e.to_string()))
}

/// Ensure data directory layout exists without creating a database file.
pub fn ensure_layout_for_root(root: &str) -> Result<(), DbError> {
    crate::storage::ensure_data_layout(&PathBuf::from(root))
        .map_err(|e| DbError::Message(e.to_string()))
}

/// Initial schema SQL. Only invoked from `create_new_database` after confirmation.
pub const INIT_SCHEMA_SQL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  parent_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT,
  name TEXT NOT NULL,
  category TEXT,
  brand TEXT,
  compat TEXT,
  oem TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  reorder_level REAL NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  notes TEXT,
  image TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty REAL NOT NULL,
  remaining REAL NOT NULL,
  unit_cost INTEGER NOT NULL,
  date INTEGER NOT NULL,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  ref_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  CHECK (qty >= 0),
  CHECK (remaining >= 0),
  CHECK (remaining <= qty),
  CHECK (unit_cost >= 0)
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  type TEXT NOT NULL,
  qty REAL NOT NULL,
  cost INTEGER NOT NULL,
  date INTEGER NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  CHECK (cost >= 0)
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL UNIQUE,
  date INTEGER NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  lines_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  tax_pct REAL NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  paid INTEGER NOT NULL,
  method TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'posted',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  CHECK (subtotal >= 0),
  CHECK (discount >= 0),
  CHECK (tax >= 0),
  CHECK (total >= 0),
  CHECK (paid >= 0)
);

CREATE TABLE IF NOT EXISTS sale_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  invoice_no TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  date INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  amount INTEGER NOT NULL,
  refund_cash INTEGER NOT NULL,
  credit_amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  CHECK (amount >= 0),
  CHECK (refund_cash >= 0),
  CHECK (credit_amount >= 0)
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  date INTEGER NOT NULL,
  due_date INTEGER,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  lines_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  total INTEGER NOT NULL,
  paid INTEGER NOT NULL,
  method TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  CHECK (subtotal >= 0),
  CHECK (discount >= 0),
  CHECK (total >= 0),
  CHECK (paid >= 0)
);

CREATE TABLE IF NOT EXISTS purchase_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  date INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  amount INTEGER NOT NULL,
  refund_cash INTEGER NOT NULL,
  credit_amount INTEGER NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  CHECK (amount >= 0),
  CHECK (refund_cash >= 0),
  CHECK (credit_amount >= 0)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_type TEXT NOT NULL,
  party_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  date INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  CHECK (amount >= 0),
  CHECK (party_type IN ('customer', 'supplier'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date INTEGER NOT NULL,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payee TEXT,
  method TEXT NOT NULL,
  reference TEXT,
  notes TEXT,
  recurring TEXT,
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  CHECK (amount >= 0)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT,
  device_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_batches_item_loc ON batches(item_id, location_id);
CREATE INDEX IF NOT EXISTS idx_batches_date ON batches(date);
CREATE INDEX IF NOT EXISTS idx_ledger_item ON ledger(item_id, location_id, date);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger(type, date);
CREATE INDEX IF NOT EXISTS idx_sales_invoice ON sales(invoice_no);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id, date);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_purchase ON purchase_returns(purchase_id);
CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_type, party_id, date);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date, category);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at, entity);

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1');
INSERT OR REPLACE INTO meta(key, value) VALUES ('app', 'Akhtar Autos Desktop');
"#;
