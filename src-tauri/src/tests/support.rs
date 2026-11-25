use crate::db;
use crate::db_tx::{self, Mutation};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("akhtar-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    pub fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
    pub fn root(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
    pub fn files(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn new_db(dir: &TempDir, name: &str) -> String {
    let path = dir.path(name);
    db::create_new_database(&path, true).unwrap();
    path
}

pub fn stamp(mut row: Value) -> Value {
    let map = row.as_object_mut().unwrap();
    map.insert("created_at".into(), json!(1_700_000_000_000_i64));
    map.insert("updated_at".into(), json!(1_700_000_000_000_i64));
    map.insert("device_id".into(), json!("dev-test"));
    row
}

pub fn location(id: i64) -> Value {
    stamp(json!({"id": id, "name": "Shop", "type": "shop"}))
}

pub fn item(id: i64, sku: &str) -> Value {
    stamp(json!({"id": id, "sku": sku, "name": "Part", "cost": 100, "price": 200}))
}

pub fn batch(id: i64, item_id: i64, location_id: i64, remaining: i64, date: i64) -> Value {
    stamp(
        json!({"id": id, "item_id": item_id, "location_id": location_id, "qty": 10,
        "remaining": remaining, "unit_cost": 100, "date": date, "source": "opening"}),
    )
}

pub fn insert(table: &str, row: Value) -> Mutation {
    mutation("insert", table, row)
}

pub fn mutation(op: &str, table: &str, row: Value) -> Mutation {
    Mutation {
        op: op.into(),
        table: table.into(),
        row,
    }
}

pub fn apply(path: &str, mutations: Vec<Mutation>) -> Result<db_tx::TxResult, db::DbError> {
    db_tx::apply_mutations(path, &uuid::Uuid::new_v4().to_string(), mutations)
}

pub fn count(path: &str, table: &str) -> usize {
    db_tx::export_table(path, table).unwrap().len()
}

/// A snapshot naming every table, as the real migration produces.
pub fn snapshot(entries: Vec<(&str, Vec<Value>)>) -> HashMap<String, Vec<Value>> {
    let mut tables: HashMap<String, Vec<Value>> = db_tx::TABLE_ORDER
        .iter()
        .map(|t| (t.to_string(), Vec::new()))
        .collect();
    for (name, rows) in entries {
        tables.insert(name.to_string(), rows);
    }
    tables
}

/// Everything except duplicate-protection bookkeeping, for before/after comparison.
pub fn dump(path: &str) -> Vec<(String, Vec<Value>)> {
    db_tx::TABLE_ORDER
        .iter()
        .map(|t| (t.to_string(), db_tx::export_table(path, t).unwrap()))
        .collect()
}
