# Phase 2 TX — transactional layer and migration preparation

Dexie remains the default and only live store. No UI code calls this layer.

## Commands

| Command | Behaviour |
|---------|-----------|
| `apply_db_mutations(path, requestId, mutations)` | One `IMMEDIATE` transaction. Any error rolls back all. Update/delete must hit exactly one row. A replayed `requestId` returns the first result with `duplicate: true`; reuse with different content is an error. |
| `import_db_snapshot(path, tables, confirmOverwrite)` | All-or-nothing. Ids preserved. No row is skipped or replaced. Foreign keys, payment parties and integrity are verified before commit. Overwrite needs confirmation, every table in the snapshot, and first writes a verified `*.pre-import-*` copy. |
| `backup_database(source, destination)` | SQLite online backup API (includes WAL), verified, never overwrites. |
| `restore_database(backupPath, targetPath, confirmRestore)` | Stages and verifies a copy, moves the current files to `*.pre-restore-*`, then publishes. |
| `export_db_table`, `get_db_row`, `list_db_rows`, `query_batches_fifo`, `query_stock_qty` | Read-only. |

All database access except `check_database_path` refuses files that are not a
schema-v1 Akhtar Autos database. Table and column names are validated against the schema.

## Value rules

- INTEGER columns (paisa, epoch ms, ids): integers within JavaScript's safe range; booleans become 0/1.
- REAL: numbers. TEXT: strings.
- `lines_json`: a JSON array whose money fields are integers.

## Migration (`src/lib/migration.ts`)

- Exports Dexie in one read transaction and never changes it.
- Rejects NaN, Infinity and other values JSON would silently alter.
- Encodes every meta value as JSON; skips the browser-only `localFolderHandle`.
- Creates a database only with `createIfMissing`; transforms the data first.
- Compares imported counts with the source and never changes the persistence mode.

## Keeping both sides in step

- `src-tauri/tests/fixtures/ipc-contract.json`: exact frontend IPC calls, replayed in Rust.
  After an intended change run `UPDATE_IPC_CONTRACT=1 bunx vitest run src/test/ipc-contract.test.ts`.
- `migration-snapshot.json`: real `ops.ts` data imported by the Rust tests. CI regenerates it
  on Linux; the committed copy is the default for local runs and Windows. Regenerate with
  `MIGRATION_FIXTURE_OUT=$PWD/src-tauri/tests/fixtures/migration-snapshot.json bunx vitest run src/test/migration.test.ts`.
