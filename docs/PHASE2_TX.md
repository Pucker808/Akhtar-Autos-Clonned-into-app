# Phase 2 TX — Transactional data-access & migration prep

**Status:** Implemented behind feature flag. Dexie remains the **default live** store.  
**No cutover. No Dexie removal.**

## What was added

### Rust (`src-tauri/src/db_tx.rs` + `lib.rs` commands)

| Command | Purpose |
|---------|---------|
| `apply_db_mutations` | Ordered insert/update/delete in **one SQLite transaction** (full rollback on error) |
| `import_db_snapshot` | Bulk import with ID preservation; safety backup when overwriting |
| `export_db_table` | Read table as JSON rows |
| `backup_database` | WAL checkpoint + file copy |
| `restore_database` | Validate backup, safety-rename current, copy (requires `confirm_restore`) |
| `query_batches_fifo` | Batches for item+location ordered by date/id (remaining > 0) |
| `query_stock_qty` | Ledger sum |
| `get_db_row` / `list_db_rows` | Generic reads |

### Frontend

| File | Role |
|------|------|
| `src/lib/data-access/types.ts` | Mutation, ImportReport, BackupReport, table order |
| `src/lib/data-access/sqlite-adapter.ts` | All Tauri invokes above |
| `src/lib/data-access/index.ts` | Facade; `applyMutationsIfSqlite` no-ops unless mode=sqlite |
| `src/lib/migration.ts` | Dexie export → snake_case transform → import orchestration |

### Safety rules (unchanged / strengthened)

- Missing DB is **not** treated as empty install.
- Create requires `confirm_create: true`.
- Import into non-empty DB requires `confirm_overwrite: true` and creates `*.pre-import-*` safety copy.
- Restore requires `confirm_restore: true` and renames current to `*.pre-restore-*`.
- Dexie data is **never** deleted by migration helpers.

## Accounting / FIFO

- **Formulas remain in TypeScript `ops.ts`.**
- SQLite provides batch FIFO reads and atomic mutation apply so a future sqlite-backed ops path can:
  1. Read batches via `query_batches_fifo`
  2. Compute allocs with the same algorithm as `consumeFIFO`
  3. Submit all resulting row changes via `apply_db_mutations` in one transaction

Live UI still uses Dexie until cutover approval.

## Migration workflow (manual / settings UI later)

1. `exportDexieSnapshot()` — pure Dexie read.
2. User confirms target path + overwrite if needed.
3. `importDexieSnapshotToSqlite(snapshot, { confirmOverwrite, createIfMissing })`.
4. `compareCounts` — verify table row counts.
5. **Do not** flip `persistenceMode` until operator sign-off.

## Tests

- `src/test/migration.test.ts` — mapping, export, ID preservation, count compare (runs in Node/vitest with fake-indexeddb).
- Python sqlite3 checks for schema + mutation rollback semantics (environment-local).
- Full Tauri invoke + Windows installer tests: **not executed in CI sandbox** — run on Windows.

## Explicit non-goals (this stage)

- Default mode still `dexie`.
- ops.ts not switched to SQLite.
- No Android.
- No Google Drive changes.
