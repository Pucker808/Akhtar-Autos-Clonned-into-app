# Phase 2 — SQLite foundation (no cutover)

**Persistence today:** every business operation and every screen reads and writes
**Dexie**. The SQLite layer is not used by the UI. `ops.ts` and `reports.ts` are
unchanged from the web app. There is no dual-write.

Verification status is whatever the latest `Phase 2 Verify` workflow run shows.
All of its steps are required.

## Decisions (unchanged)

- Business rules (FIFO, balances, reports) stay in TypeScript.
- Rust + rusqlite owns schema v1, health, creation, transactions, import, backup.
- Dexie stays the default until an explicitly approved cutover.

## What is where

| Area | Uses |
|------|------|
| UI, `ops.ts`, `reports.ts`, `receipt.ts`, `settings.ts` | Dexie |
| Google Drive and local-folder JSON backups | Dexie |
| `data-access/*` and Tauri SQL commands | SQLite (no UI caller) |
| `migration.ts` | reads Dexie, writes SQLite (no UI caller) |

`persistence.ts` is only a flag. It reports `dexie` outside Tauri, and setting it
to `sqlite` does not move any business data.

## Guarantees and their tests

See `docs/PHASE2_TX.md`. Tests live in `src-tauri/src/tests/` and `src/test/`.

## Known limitations (to resolve before or during Phase 3+)

1. A mutation batch cannot refer to an id generated earlier in the same batch.
   Phase 3 must decide how ids are assigned.
2. Request-id protection exists only for `apply_db_mutations`; `ops.ts` (Dexie) has none.
   Records (`meta` keys `tx_request:*`) are not pruned.
3. Meta values are JSON text in SQLite; readers must use `decodeMetaValue`.
4. `lines_json` item/batch references are not foreign keys.
5. Some foreign keys use `ON DELETE SET NULL`, so deleting a customer through the
   generic mutation API would detach their sales. `ops.ts` never deletes parties.
6. SQL commands accept any file path from the WebView, `csp` is `null`, and the
   fs capability includes `$HOME/**`. Harden in Phase 5 before release.
7. Restore assumes no other process has the database open. If the app stops between
   its two renames, the previous database is at `*.pre-restore-*`.
8. Commands run synchronously and can block the UI on large imports.
9. Migration is not connected to any screen and has not been run on real shop data.
10. No recovery UI yet.
11. Windows installers from CI are unsigned. CI building them is not the same as
    installing and testing the app on a real Windows PC.
