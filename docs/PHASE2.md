# Phase 2 — SQLite foundation (no cutover)

## Finalized architecture decisions

1. **Business logic location:** Keep FIFO, sales, purchases, returns, payments, balances and reports in TypeScript (`ops.ts`, `reports.ts`). Do not reimplement accounting in Rust in this phase.
2. **Persistence location:** Rust + rusqlite owns schema, connections, health checks, explicit create, and (later) transactional writes invoked from TS.
3. **Adapter layer:** `src/lib/persistence.ts` + `src/lib/data-access/*` select Dexie vs SQLite. Ops still call Dexie until cutover.
4. **Primary DB for new installs (intent):** SQLite under hybrid AppData / user folder. Not enabled by default until cutover approval.
5. **Dexie:** Remains default and fully functional for rollback and migration source.
6. **No permanent dual-write.**
7. **Web app:** Unchanged; separate repository.

## Safety

- `check_database_path` never creates files.
- `create_database(path, confirm_create)` requires `confirm_create: true` and refuses existing paths.
- Parent directory must already exist (layout helpers create folders only, not the DB file).

## Commands (Tauri)

| Command | Purpose |
|---------|---------|
| `get_default_data_root` | AppData/AkhtarAutos |
| `get_default_database_path` | .../Database/akhtar-autos.db |
| `check_database_path` | Health, integrity, schema version, counts |
| `create_database` | Explicit new DB + schema v1 |
| `get_schema_info` | Version + tables + FK flag |
| `get_table_counts` | Row counts |
| `get_meta_value` | meta key read |
| `ensure_data_layout` | Folder tree only |

## Schema

Schema v1 mirrors Dexie entities with snake_case columns, INTEGER paisa, JSON line blobs, FKs, CHECKs on money/qty, and indexes aligned to Dexie query patterns. See `src-tauri/src/db.rs` `INIT_SCHEMA_SQL`.

## Not in this phase

- Dexie removal / permanent SQLite switch
- ops.ts write path against SQLite
- Data import UI cutover
- Android
