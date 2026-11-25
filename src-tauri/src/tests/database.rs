use super::support::*;
use crate::db::{self, DbError};
use crate::db_tx;
use rusqlite::Connection;
use serde_json::json;
use std::path::Path;

#[test]
fn create_builds_a_healthy_schema_v1_database() {
    let dir = TempDir::new();
    let path = dir.path("a.db");
    let health = db::create_new_database(&path, true).unwrap();
    assert!(health.integrity_ok);
    assert_eq!(health.schema_version, Some(db::SCHEMA_VERSION));
    let info = db::schema_info(&path).unwrap();
    assert!(info.foreign_keys_enabled);
    for table in db::TABLES {
        assert!(info.tables.iter().any(|t| t == table), "{table}");
    }
    let conn = Connection::open(&path).unwrap();
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(user_version, db::SCHEMA_VERSION);
}

#[test]
fn create_requires_confirmation_parent_and_a_free_path() {
    let dir = TempDir::new();
    let path = dir.path("a.db");
    assert!(matches!(
        db::create_new_database(&path, false),
        Err(DbError::CreateNotConfirmed)
    ));
    assert!(matches!(
        db::create_new_database(&dir.path("missing/a.db"), true),
        Err(DbError::ParentMissing(_))
    ));
    std::fs::write(&path, b"precious").unwrap();
    assert!(matches!(
        db::create_new_database(&path, true),
        Err(DbError::AlreadyExists(_))
    ));
    assert_eq!(std::fs::read(&path).unwrap(), b"precious");
}

#[test]
fn create_refuses_when_a_leftover_wal_suggests_a_lost_database() {
    let dir = TempDir::new();
    std::fs::write(dir.path("a.db-wal"), b"orphan").unwrap();
    assert!(db::create_new_database(&dir.path("a.db"), true).is_err());
    assert_eq!(dir.files(), vec!["a.db-wal"]);
}

#[test]
fn nothing_creates_a_missing_database() {
    let dir = TempDir::new();
    let path = dir.path("none.db");
    assert!(!db::check_path(&path).unwrap().exists);
    assert!(db::open_readonly(&path).is_err());
    assert!(apply(&path, vec![insert("locations", location(1))]).is_err());
    assert!(db_tx::import_snapshot(&path, snapshot(vec![]), true).is_err());
    assert!(db_tx::backup_database(&path, &dir.path("b.db")).is_err());
    assert!(dir.files().is_empty());
}

#[test]
fn corrupt_empty_and_foreign_files_are_reported_and_never_modified() {
    let dir = TempDir::new();
    let corrupt = dir.path("corrupt.db");
    std::fs::write(&corrupt, vec![7u8; 4096]).unwrap();
    let health = db::check_path(&corrupt).unwrap();
    assert!(health.exists && !health.integrity_ok);

    let empty = dir.path("empty.db");
    std::fs::write(&empty, b"").unwrap();
    assert!(db::check_path(&empty)
        .unwrap()
        .message
        .contains("cannot be used"));

    let foreign = dir.path("foreign.db");
    Connection::open(&foreign)
        .unwrap()
        .execute_batch("CREATE TABLE other(x); INSERT INTO other VALUES (1);")
        .unwrap();

    for path in [&corrupt, &empty, &foreign] {
        let before = std::fs::read(path).unwrap();
        assert!(db::open_readwrite(path).is_err(), "{path}");
        assert!(apply(path, vec![insert("locations", location(1))]).is_err());
        assert!(db_tx::import_snapshot(path, snapshot(vec![]), true).is_err());
        assert_eq!(std::fs::read(path).unwrap(), before, "{path}");
    }
}

#[test]
fn a_newer_schema_version_is_refused() {
    let dir = TempDir::new();
    let path = new_db(&dir, "a.db");
    Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE meta SET value = '2' WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
    assert!(matches!(
        db::open_readwrite(&path),
        Err(DbError::SchemaMismatch {
            found: 2,
            expected: 1
        })
    ));
}

#[test]
fn schema_enforces_foreign_keys_checks_and_unique_keys() {
    let dir = TempDir::new();
    let path = new_db(&dir, "a.db");
    apply(
        &path,
        vec![
            insert("locations", location(1)),
            insert("items", item(1, "A")),
        ],
    )
    .unwrap();
    let negative_paid = stamp(
        json!({"invoice_no": "I", "date": 1, "customer_name": "W", "location_id": 1,
        "lines_json": "[]", "subtotal": 1, "discount": 0, "total": 1, "paid": -1, "method": "cash"}),
    );
    for bad in [
        insert("batches", batch(1, 999, 1, 1, 1)),
        insert("batches", batch(1, 1, 999, 1, 1)),
        insert("batches", batch(1, 1, 1, 11, 1)),
        insert("batches", batch(1, 1, 1, -1, 1)),
        insert("items", item(2, "A")),
        insert("sales", negative_paid),
    ] {
        assert!(apply(&path, vec![bad]).is_err());
    }
    assert_eq!(count(&path, "batches"), 0);
    assert_eq!(count(&path, "items"), 1);
    // An item referenced by stock cannot be deleted.
    apply(&path, vec![insert("batches", batch(1, 1, 1, 5, 1))]).unwrap();
    assert!(apply(&path, vec![mutation("delete", "items", json!({"id": 1}))]).is_err());
}

#[test]
fn backup_includes_uncheckpointed_wal_data() {
    let dir = TempDir::new();
    let path = new_db(&dir, "a.db");
    let holder = Connection::open(&path).unwrap();
    holder
        .execute_batch("PRAGMA wal_autocheckpoint = 0;")
        .unwrap();
    holder
        .execute(
            "INSERT INTO locations(name, type, created_at, updated_at, device_id) VALUES ('W','shop',1,1,'d')",
            [],
        )
        .unwrap();
    let report = db_tx::backup_database(&path, &dir.path("out/backup.db")).unwrap();
    assert!(report.size_bytes > 0);
    // The backup is one self-contained file.
    let copy = dir.path("copy.db");
    std::fs::copy(dir.path("out/backup.db"), &copy).unwrap();
    assert_eq!(count(&copy, "locations"), 1);
}

#[test]
fn backup_never_overwrites_any_file() {
    let dir = TempDir::new();
    let path = new_db(&dir, "a.db");
    apply(&path, vec![insert("locations", location(1))]).unwrap();
    assert!(db_tx::backup_database(&path, &path).is_err());
    assert!(db_tx::backup_database(&path, &dir.path("./a.db")).is_err());
    assert_eq!(count(&path, "locations"), 1);

    let other = dir.path("other.txt");
    std::fs::write(&other, b"keep me").unwrap();
    assert!(db_tx::backup_database(&path, &other).is_err());
    assert_eq!(std::fs::read(&other).unwrap(), b"keep me");
    assert!(!dir.files().iter().any(|f| f.contains("partial")));
}

#[test]
fn restore_recovers_data_and_keeps_the_previous_database() {
    let dir = TempDir::new();
    let path = new_db(&dir, "a.db");
    apply(&path, vec![insert("locations", location(1))]).unwrap();
    let backup = dir.path("backup.db");
    db_tx::backup_database(&path, &backup).unwrap();
    apply(&path, vec![insert("locations", location(2))]).unwrap();

    assert!(db_tx::restore_database(&backup, &path, false).is_err());
    assert_eq!(count(&path, "locations"), 2);

    // Restore twice in the same second: both safety copies must survive.
    let health = db_tx::restore_database(&backup, &path, true).unwrap();
    db_tx::restore_database(&backup, &path, true).unwrap();
    assert!(health.integrity_ok);
    assert_eq!(count(&path, "locations"), 1);
    let safety: Vec<String> = dir
        .files()
        .into_iter()
        .filter(|f| f.contains("pre-restore") && !f.ends_with("-wal") && !f.ends_with("-shm"))
        .collect();
    assert_eq!(safety.len(), 2, "{safety:?}");
    assert!(safety.iter().any(|f| count(&dir.path(f), "locations") == 2));
    assert!(!dir.files().iter().any(|f| f.contains("staged")));
}

#[test]
fn restore_works_when_the_target_is_missing_or_corrupt() {
    let dir = TempDir::new();
    let path = new_db(&dir, "a.db");
    let backup = dir.path("backup.db");
    db_tx::backup_database(&path, &backup).unwrap();

    assert!(
        db_tx::restore_database(&backup, &dir.path("new/place.db"), true)
            .unwrap()
            .integrity_ok
    );

    let broken = dir.path("broken.db");
    std::fs::write(&broken, b"damaged bytes").unwrap();
    db_tx::restore_database(&backup, &broken, true).unwrap();
    let kept = dir
        .files()
        .into_iter()
        .find(|f| f.starts_with("broken.db.pre-restore"))
        .unwrap();
    assert_eq!(std::fs::read(dir.path(&kept)).unwrap(), b"damaged bytes");
}

#[test]
fn bad_restore_sources_leave_the_target_untouched() {
    let dir = TempDir::new();
    let path = new_db(&dir, "a.db");
    apply(&path, vec![insert("locations", location(1))]).unwrap();

    let empty = dir.path("empty.bin");
    std::fs::write(&empty, b"").unwrap();
    let junk = dir.path("junk.bin");
    std::fs::write(&junk, vec![1u8; 2048]).unwrap();
    let dangling = new_db(&dir, "dangling.db");
    Connection::open(&dangling)
        .unwrap()
        .execute_batch(
            "PRAGMA foreign_keys=OFF; INSERT INTO batches(item_id,location_id,qty,remaining,unit_cost,date,source,created_at,updated_at,device_id) VALUES (9,9,1,1,1,1,'x',1,1,'d');",
        )
        .unwrap();

    for source in [&path, &empty, &junk, &dangling, &dir.path("missing.db")] {
        assert!(
            db_tx::restore_database(source, &path, true).is_err(),
            "{source}"
        );
        assert!(Path::new(&path).exists());
        assert_eq!(count(&path, "locations"), 1);
    }
    assert!(!dir
        .files()
        .iter()
        .any(|f| f.contains("pre-restore") || f.contains("staged")));
}

#[test]
fn data_layout_creates_folders_but_no_database() {
    let dir = TempDir::new();
    db::ensure_layout_for_root(&dir.root()).unwrap();
    assert!(Path::new(&dir.path("Database")).is_dir());
    assert!(!Path::new(&dir.path("Database/akhtar-autos.db")).exists());
}
