use super::support::*;
use crate::db_tx::{self, apply_mutations};
use serde_json::{json, Value};

fn seeded(dir: &TempDir) -> String {
    let path = new_db(dir, "a.db");
    apply(
        &path,
        vec![
            insert("locations", location(1)),
            insert("items", item(1, "A")),
            insert("batches", batch(1, 1, 1, 10, 5)),
        ],
    )
    .unwrap();
    path
}

fn expense(amount: Value) -> Value {
    stamp(json!({"date": 1, "category": "Rent", "amount": amount, "method": "cash"}))
}

#[test]
fn a_successful_batch_commits_every_change() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    let result = apply(
        &path,
        vec![
            mutation("update", "batches", json!({"id": 1, "remaining": 7})),
            insert("expenses", expense(json!(1050))),
            mutation("update", "meta", json!({"key": "counter:AA", "value": "1"})),
        ],
    )
    .unwrap();
    assert_eq!(result.applied, 3);
    assert!(!result.duplicate);
    assert_eq!(result.last_insert_ids.get("expenses:1"), Some(&1));
    assert_eq!(
        db_tx::get_row(&path, "batches", 1).unwrap().unwrap()["remaining"],
        json!(7.0)
    );
    assert_eq!(
        db_tx::get_row(&path, "expenses", 1).unwrap().unwrap()["amount"],
        json!(1050)
    );
}

#[test]
fn any_failure_rolls_back_the_whole_batch() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    let before = dump(&path);
    let failures = [
        insert("items", item(2, "A")),
        insert("batches", batch(2, 999, 1, 1, 1)),
        insert("ghost", json!({"id": 1})),
        mutation("upsert", "items", item(3, "C")),
        mutation("update", "items", json!({"id": 999, "name": "z"})),
        mutation("delete", "items", json!({"id": 999})),
        mutation("update", "items", json!({"id": 1})),
        mutation("update", "items", json!({"name": "no id"})),
        insert("items", json!([1, 2])),
        insert("items", json!({})),
    ];
    for failing in failures {
        let label = format!("{failing:?}");
        let batch = vec![
            mutation("update", "batches", json!({"id": 1, "remaining": 1})),
            insert("expenses", expense(json!(5))),
            failing,
        ];
        let error = apply(&path, batch).unwrap_err().to_string();
        assert!(error.contains("mutation #2"), "{label}: {error}");
        assert_eq!(dump(&path), before, "{label}");
    }
}

#[test]
fn money_dates_and_types_are_strict() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    for amount in [
        json!(10.5),
        json!(10.0),
        json!("1000"),
        json!(9_007_199_254_740_993_i64),
        json!({}),
        json!(-1),
        Value::Null,
    ] {
        assert!(
            apply(&path, vec![insert("expenses", expense(amount.clone()))]).is_err(),
            "{amount}"
        );
    }
    let mut dated = expense(json!(1));
    dated["date"] = json!("2026-03-10");
    assert!(apply(&path, vec![insert("expenses", dated)]).is_err());
    let mut text = expense(json!(1));
    text["category"] = json!(5);
    assert!(apply(&path, vec![insert("expenses", text)]).is_err());
    assert_eq!(count(&path, "expenses"), 0);

    // Millisecond timestamps survive exactly.
    let mut ok = expense(json!(123_456_789_012_i64));
    ok["date"] = json!(1_773_082_800_123_i64);
    apply(&path, vec![insert("expenses", ok)]).unwrap();
    let row = db_tx::get_row(&path, "expenses", 1).unwrap().unwrap();
    assert_eq!(row["date"], json!(1_773_082_800_123_i64));
    assert_eq!(row["amount"], json!(123_456_789_012_i64));
}

#[test]
fn lines_json_must_be_an_array_with_integer_paisa() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    let sale = |lines: &str| {
        stamp(
            json!({"invoice_no": "I-1", "date": 1, "customer_name": "W", "location_id": 1,
            "lines_json": lines, "subtotal": 1, "discount": 0, "total": 1, "paid": 1, "method": "cash"}),
        )
    };
    for bad in [
        "nope",
        "{}",
        r#"[{"price": 1.5}]"#,
        r#"[{"allocs":[{"unitCost": 0.1}]}]"#,
    ] {
        assert!(
            apply(&path, vec![insert("sales", sale(bad))]).is_err(),
            "{bad}"
        );
    }
    apply(
        &path,
        vec![insert("sales", sale(r#"[{"price": 100, "qty": 1}]"#))],
    )
    .unwrap();
}

#[test]
fn injected_identifiers_are_rejected() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    let before = dump(&path);
    let evil = "name = 'PWNED', price";
    assert!(apply(
        &path,
        vec![mutation("update", "items", json!({"id": 1, evil: 5}))]
    )
    .is_err());
    assert!(apply(
        &path,
        vec![insert("items", json!({"sku) VALUES ('x'); --": 1}))]
    )
    .is_err());
    assert!(db_tx::list_rows(
        &path,
        "items",
        Some("1=1 OR id".into()),
        Some(json!(0)),
        None
    )
    .is_err());
    assert!(db_tx::list_rows(&path, "items; DROP TABLE items", None, None, None).is_err());
    assert!(db_tx::export_table(&path, "sqlite_master").is_err());
    assert_eq!(dump(&path), before);
}

#[test]
fn replaying_a_request_id_never_writes_twice() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    let batch = || vec![insert("expenses", expense(json!(500)))];
    let first = apply_mutations(&path, "op-1", batch()).unwrap();
    let again = apply_mutations(&path, "op-1", batch()).unwrap();
    assert!(!first.duplicate && again.duplicate);
    assert_eq!(first.last_insert_ids, again.last_insert_ids);
    assert_eq!(count(&path, "expenses"), 1);

    let reused = apply_mutations(&path, "op-1", vec![insert("expenses", expense(json!(999)))]);
    assert!(reused.unwrap_err().to_string().contains("already used"));
    assert_eq!(count(&path, "expenses"), 1);

    // A failed request is not remembered and may be retried.
    assert!(apply_mutations(&path, "op-2", vec![insert("expenses", expense(json!(-1)))]).is_err());
    apply_mutations(&path, "op-2", batch()).unwrap();
    assert_eq!(count(&path, "expenses"), 2);

    assert!(apply_mutations(&path, "  ", batch()).is_err());
    assert!(apply_mutations(&path, "op-3", vec![]).is_err());
}

#[test]
fn concurrent_replays_commit_exactly_once() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let path = path.clone();
            std::thread::spawn(move || {
                apply_mutations(&path, "same", vec![insert("expenses", expense(json!(1)))])
                    .unwrap()
                    .duplicate
            })
        })
        .collect();
    let fresh = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .filter(|duplicate| !duplicate)
        .count();
    assert_eq!((fresh, count(&path, "expenses")), (1, 1));
}

#[test]
fn reserved_meta_keys_are_protected() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    for key in ["schema_version", "app", "tx_request:x"] {
        for op in ["insert", "update", "delete"] {
            let m = mutation(op, "meta", json!({"key": key, "value": "9"}));
            assert!(apply(&path, vec![m]).is_err(), "{op} {key}");
        }
    }
    assert!(apply(
        &path,
        vec![mutation("delete", "meta", json!({"key": "absent"}))]
    )
    .is_err());
}

#[test]
fn payments_must_point_at_an_existing_party() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    let payment = stamp(
        json!({"party_type": "customer", "party_id": 77, "amount": 1, "method": "cash", "date": 1}),
    );
    assert!(apply(&path, vec![insert("payments", payment.clone())]).is_err());
    let customer = stamp(json!({"id": 77, "name": "C"}));
    apply(
        &path,
        vec![
            insert("customers", customer),
            insert("payments", payment.clone()),
        ],
    )
    .unwrap();
    assert!(apply(
        &path,
        vec![mutation("delete", "customers", json!({"id": 77}))]
    )
    .is_err());
}

#[test]
fn fifo_and_stock_queries_are_ordered_and_filtered() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    apply(
        &path,
        vec![
            insert("locations", location(2)),
            insert("batches", batch(2, 1, 1, 4, 1)),
            insert("batches", batch(3, 1, 1, 0, 0)),
            insert("batches", batch(4, 1, 1, 4, 5)),
            insert("batches", batch(5, 1, 2, 4, 0)),
        ],
    )
    .unwrap();
    let ids: Vec<i64> = db_tx::query_batches_fifo(&path, 1, 1)
        .unwrap()
        .iter()
        .map(|b| b["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, vec![2, 1, 4]);
    assert_eq!(db_tx::query_stock_qty(&path, 1, None).unwrap(), 0.0);
    for (location_id, qty) in [(1, 10), (1, -3), (2, 4)] {
        let row = stamp(
            json!({"item_id": 1, "location_id": location_id, "type": "adjust",
            "qty": qty, "cost": 0, "date": 1}),
        );
        apply(&path, vec![insert("ledger", row)]).unwrap();
    }
    assert_eq!(db_tx::query_stock_qty(&path, 1, None).unwrap(), 11.0);
    assert_eq!(db_tx::query_stock_qty(&path, 1, Some(1)).unwrap(), 7.0);

    let filtered = db_tx::list_rows(
        &path,
        "ledger",
        Some("location_id".into()),
        Some(json!(2)),
        None,
    )
    .unwrap();
    assert_eq!(filtered.len(), 1);
    assert!(db_tx::list_rows(&path, "ledger", Some("qty".into()), None, None).is_err());
    assert!(db_tx::list_rows(&path, "ledger", None, None, Some(-1)).is_err());
}

#[test]
fn import_preserves_ids_and_allows_children_before_parents() {
    let dir = TempDir::new();
    let path = new_db(&dir, "a.db");
    let mut child = location(1);
    child["parent_id"] = json!(2);
    let report = db_tx::import_snapshot(
        &path,
        snapshot(vec![
            ("locations", vec![child, location(2)]),
            ("items", vec![item(41, "Z")]),
            ("meta", vec![json!({"key": "settings", "value": "{}"})]),
        ]),
        false,
    )
    .unwrap();
    assert_eq!(report.tables["locations"], 2);
    assert!(report.safety_backup.is_none());
    assert!(db_tx::get_row(&path, "items", 41).unwrap().is_some());
    assert_eq!(
        db_tx::get_row(&path, "locations", 1).unwrap().unwrap()["parent_id"],
        json!(2)
    );
}

#[test]
fn one_bad_row_aborts_the_entire_import() {
    let dir = TempDir::new();
    let path = new_db(&dir, "a.db");
    let before = dump(&path);
    let mut unknown_column = item(2, "B");
    unknown_column["legacy"] = json!(1);
    let mut no_id = item(3, "C");
    no_id.as_object_mut().unwrap().remove("id");
    let orphan_payment = stamp(
        json!({"id": 1, "party_type": "supplier", "party_id": 5, "amount": 1, "method": "cash", "date": 1}),
    );
    let cases = vec![
        ("items", vec![item(1, "A"), unknown_column]),
        ("items", vec![item(1, "A"), no_id]),
        ("items", vec![item(1, "A"), item(1, "B")]),
        ("items", vec![item(1, "A"), item(2, "A")]),
        ("batches", vec![batch(1, 999, 999, 1, 1)]),
        ("payments", vec![orphan_payment]),
    ];
    for (table, rows) in cases {
        let tables = snapshot(vec![("locations", vec![location(1)]), (table, rows)]);
        let error = db_tx::import_snapshot(&path, tables, false)
            .unwrap_err()
            .to_string();
        assert!(error.contains("nothing was changed"), "{table}: {error}");
        assert_eq!(dump(&path), before, "{table}");
    }
    let mut extra = snapshot(vec![]);
    extra.insert("mystery".into(), vec![]);
    assert!(db_tx::import_snapshot(&path, extra, false).is_err());
}

#[test]
fn overwrite_needs_confirmation_a_full_snapshot_and_makes_a_wal_safe_backup() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    let holder = rusqlite::Connection::open(&path).unwrap();
    holder
        .execute_batch("PRAGMA wal_autocheckpoint = 0; UPDATE items SET name = 'ONLY-IN-WAL';")
        .unwrap();
    let before = dump(&path);
    let replacement = || {
        snapshot(vec![
            ("locations", vec![location(1)]),
            ("items", vec![item(9, "NEW")]),
        ])
    };

    assert!(db_tx::import_snapshot(&path, replacement(), false).is_err());
    let mut partial = replacement();
    partial.remove("sales");
    assert!(db_tx::import_snapshot(&path, partial, true)
        .unwrap_err()
        .to_string()
        .contains("incomplete"));
    assert_eq!(dump(&path), before);

    let first = db_tx::import_snapshot(&path, replacement(), true).unwrap();
    // Repeating the same import replaces rather than duplicates.
    let second = db_tx::import_snapshot(&path, replacement(), true).unwrap();
    assert_eq!((count(&path, "items"), count(&path, "batches")), (1, 0));
    assert_ne!(first.safety_backup, second.safety_backup);

    let copy = dir.path("check.db");
    std::fs::copy(first.safety_backup.unwrap(), &copy).unwrap();
    assert_eq!(dump(&copy), before);
}

#[test]
fn a_failed_overwrite_keeps_the_original_data() {
    let dir = TempDir::new();
    let path = seeded(&dir);
    let before = dump(&path);
    let tables = snapshot(vec![("batches", vec![batch(1, 5, 5, 1, 1)])]);
    assert!(db_tx::import_snapshot(&path, tables, true).is_err());
    assert_eq!(dump(&path), before);
}

/// Data produced by the real ops.ts, transformed by migration.ts. CI regenerates
/// it from the current frontend and passes it through MIGRATION_FIXTURE.
#[test]
fn real_frontend_migration_snapshot_imports_into_the_real_schema() {
    let text = match std::env::var("MIGRATION_FIXTURE") {
        Ok(file) => std::fs::read_to_string(file).unwrap(),
        Err(_) => include_str!("../../tests/fixtures/migration-snapshot.json").to_string(),
    };
    let fixture: Value = serde_json::from_str(&text).unwrap();
    let tables: std::collections::HashMap<String, Vec<Value>> =
        serde_json::from_value(fixture["tables"].clone()).unwrap();
    let dir = TempDir::new();
    let path = new_db(&dir, "a.db");
    let report = db_tx::import_snapshot(&path, tables.clone(), false).unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    for table in db_tx::TABLE_ORDER {
        let source = &tables[*table];
        assert!(!source.is_empty(), "fixture should cover {table}");
        assert_eq!(report.tables[*table], source.len() as i64, "{table}");
        let stored = db_tx::export_table(&path, table).unwrap();
        // Every source value is present and unchanged.
        for row in source {
            let key = if *table == "meta" { "key" } else { "id" };
            let found = stored.iter().find(|s| s[key] == row[key]).unwrap();
            for (column, value) in row.as_object().unwrap() {
                match (value.as_f64(), found[column].as_f64()) {
                    (Some(a), Some(b)) => assert_eq!(a, b, "{table}.{column}"),
                    _ => match value.as_bool() {
                        Some(b) => assert_eq!(found[column], json!(i64::from(b))),
                        None => assert_eq!(&found[column], value, "{table}.{column}"),
                    },
                }
            }
        }
    }
    let item_id = fixture["itemId"].as_i64().unwrap();
    assert_eq!(
        db_tx::query_stock_qty(&path, item_id, None).unwrap(),
        fixture["stock"].as_f64().unwrap()
    );
}
