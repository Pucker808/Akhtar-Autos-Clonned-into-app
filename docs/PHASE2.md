# Phase 2 — SQLite foundation (no cutover)

**Status:** Foundation complete on desktop `main`. Dexie remains the live persistence layer. No cutover.

## Finalized architecture decisions

1. **Business logic location:** Keep FIFO, sales, purchases, returns, payments, balances and reports in TypeScript (`ops.ts`, `reports.ts`). Do not reimplement accounting in Rust in this phase.
2. **Persistence location:** Rust + rusqlite owns schema, connections, health checks, explicit create, and (later) transactional writes invoked from TS.
3. **Adapter layer:** `src/lib/persistence.ts` + `src/lib/data-access/*` select Dexie vs SQLite. Ops still call Dexie until cutover.
4. **Primary DB for new installs (intent):** SQLite under hybrid AppData / user folder. Not enabled by default until cutover approval.
5. **Dexie:** Remains default and fully functional for rollback and migration source.
6. **No permanent dual-write.**
7. **Web app:** Unchanged; separate repository.

## Safety (implemented)

- `check_database_path` never creates files.
- `create_database(path, confirm_create)` requires `confirm_create: true` and refuses existing paths.
- Parent directory must already exist (layout helpers create folders only, not the DB file).
- Integrity check, schema version, and table counts exposed for recovery UI.
- CHECKs on money (≥0), batch remaining ≤ qty, party_type enum.

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

## Schema v1

Mirrors Dexie entities with snake_case columns, INTEGER paisa, JSON line blobs (`lines_json`), FKs, CHECKs, and indexes aligned to Dexie query patterns (including brand). See `src-tauri/src/db.rs` `INIT_SCHEMA_SQL`.

Tables: meta, locations, customers, suppliers, items, batches, ledger, sales, sale_returns, purchases, purchase_returns, payments, expenses, audit.

## Frontend adapter

- `src/lib/persistence.ts` — mode flag (`dexie` default; `sqlite` only when set)
- `src/lib/data-access/sqlite-adapter.ts` — invoke wrappers for health/create/schema/counts
- `src/lib/data-access/index.ts` — facade; returns null when not in sqlite mode
- Business ops continue to use Dexie via `ops.ts`

## Verification performed (sandbox)

- Schema SQL applies cleanly under Python sqlite3.
- Foreign keys block invalid `item_id` on batches.
- CHECK constraints block `remaining > qty` and negative money.
- Integrity pragma returns `ok`.
- Meta `schema_version` = 1.
- Persistence mode tests and paisa precision tests present in `src/test/persistence.test.ts`.

## Not in this phase

- Dexie removal / permanent SQLite switch
- ops.ts write path against SQLite
- Data import UI cutover
- Android
- Dual-write

## Work still required before safe cutover

1. Implement transactional write commands in Rust (or domain-by-domain SQL ops) that preserve FIFO allocation exactly as `ops.ts` does today.
2. Port read paths used by reports and UI through the adapter without changing report formulas.
3. Migration path: Dexie/JSON export → validated SQLite import with ID preservation, count/checksum verification, safety backup, explicit confirm.
4. Recovery UI wired to `check_database_path` / locate / restore / create-new (confirm).
5. Windows: `npm test`, `tauri build`, cold-start missing DB, corrupt DB, external drive scenarios.
6. Explicit product approval before flipping default mode to `sqlite` or removing Dexie.
