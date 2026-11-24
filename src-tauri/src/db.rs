//! SQLite health checks and open policy.
//!
//! Critical rule: never silently create a new empty database when the
//! configured path is missing or the file is corrupt. Callers must present
//! recovery options (locate existing, restore backup, create new with confirm).

use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database file not found at {0}")]
    NotFound(String),
    #[error("path is not a file: {0}")]
    NotAFile(String),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("integrity check failed: {0}")]
    Integrity(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbHealth {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub size_bytes: u64,
    pub integrity_ok: bool,
    pub schema_version: Option<i64>,
    pub message: String,
}

/// Inspect a path without creating anything.
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
            message: "Database file not found. Use recovery to locate, restore, or create new."
                .into(),
        });
    }
    if !p.is_file() {
        return Err(DbError::NotAFile(path.to_string()));
    }
    let size_bytes = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);

    let conn = Connection::open_with_flags(
        p,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;

    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    let integrity_ok = integrity.eq_ignore_ascii_case("ok");

    let schema_version: Option<i64> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| s.parse().ok())
        .or_else(|| {
            conn.query_row("PRAGMA user_version", [], |r| r.get(0))
                .ok()
        });

    Ok(DbHealth {
        path: path.to_string(),
        exists: true,
        is_file: true,
        size_bytes,
        integrity_ok,
        schema_version,
        message: if integrity_ok {
            "Database is readable and integrity check passed.".into()
        } else {
            format!("Integrity check reported: {integrity}")
        },
    })
}

/// Schema version constant for migrations (Phase 3+).
pub const SCHEMA_VERSION: i64 = 1;

/// SQL to create the initial schema. Only call after explicit user confirmation
/// that a *new* database should be created.
pub const INIT_SCHEMA_SQL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
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
  unit TEXT NOT NULL DEFAULT 'pc',
  reorder_level REAL NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 0,
  supplier_id INTEGER,
  location_id INTEGER,
  notes TEXT,
  image TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  parent_id INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  remaining REAL NOT NULL,
  unit_cost INTEGER NOT NULL,
  date INTEGER NOT NULL,
  supplier_id INTEGER,
  source TEXT NOT NULL,
  ref_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  qty REAL NOT NULL,
  cost INTEGER NOT NULL,
  date INTEGER NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  note TEXT,
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

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL UNIQUE,
  date INTEGER NOT NULL,
  customer_id INTEGER,
  customer_name TEXT NOT NULL,
  location_id INTEGER NOT NULL,
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
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  invoice_no TEXT NOT NULL,
  customer_id INTEGER,
  date INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  amount INTEGER NOT NULL,
  refund_cash INTEGER NOT NULL,
  credit_amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no TEXT NOT NULL,
  supplier_id INTEGER NOT NULL,
  date INTEGER NOT NULL,
  due_date INTEGER,
  location_id INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  total INTEGER NOT NULL,
  paid INTEGER NOT NULL,
  method TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  date INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  amount INTEGER NOT NULL,
  refund_cash INTEGER NOT NULL,
  credit_amount INTEGER NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL
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
  device_id TEXT NOT NULL
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
  device_id TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_batches_item_loc ON batches(item_id, location_id);
CREATE INDEX IF NOT EXISTS idx_ledger_item ON ledger(item_id, location_id, date);
CREATE INDEX IF NOT EXISTS idx_sales_invoice ON sales(invoice_no);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_type, party_id);

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1');
INSERT OR REPLACE INTO meta(key, value) VALUES ('app', 'Akhtar Autos Desktop');
"#;
