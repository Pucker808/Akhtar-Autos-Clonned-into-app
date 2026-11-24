# Akhtar Autos Desktop — Architecture

## Separation from web

- Original web repo: `Pucker808/akhtar-autoparts-manager` (IndexedDB / Dexie, Vercel)
- This repo: desktop-only. Do not push desktop changes into the web repo.

## Stack

| Layer | Technology |
|-------|------------|
| UI | React 19 + TypeScript + Tailwind + Radix (from web) |
| Desktop shell | Tauri 2 |
| Native | Rust |
| DB | SQLite (`rusqlite`, bundled) |
| Money | Integer paisa (unchanged from web) |

## Storage policy (non-negotiable)

1. Default DB path: `%LOCALAPPDATA%\\AkhtarAutos\\Database\\akhtar-autos.db`
2. User may choose a custom primary data folder and an independent backup folder.
3. **Never** auto-create an empty database when the configured path is missing or corrupt.
4. Recovery UI must offer: Locate existing DB · Restore from backup · Create new (explicit confirm) · Retry.
5. Backups must use SQLite-safe snapshot methods (not raw copy of a live WAL DB without care).

## Schema

Initial SQLite schema mirrors the Dexie model in `src/lib/db.ts` (items, locations, batches, ledger, parties, sales, returns, purchases, payments, expenses, audit, meta). Schema version is stored in `meta.schema_version` and `PRAGMA user_version`.

## Migration path

Phase 1 (done): Tauri shell + path helpers + health-check commands + schema SQL constant.
Frontend still uses Dexie so existing business tests and UI keep working.

Later phases: data-access adapter → Rust/SQLite commands; dual-read period optional; cut over; backup/restore; recovery screens.

## Android

Deferred until Windows installer, SQLite migration, and recovery/backup are verified.
