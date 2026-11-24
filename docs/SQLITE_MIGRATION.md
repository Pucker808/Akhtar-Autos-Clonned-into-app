# SQLite Migration Architecture (Planning Only)

**Status:** Design only — Dexie remains the live persistence layer until explicit approval to cut over.  
**Repo:** Akhtar-Autos-Clonned-into-app (desktop only). Original web app is not modified.

## 1. Goals

- Replace IndexedDB/Dexie with local SQLite as the source of truth.
- Preserve FIFO costing, integer-paisa money, balances, audit, and reports.
- Support hybrid storage (default AppData + user-selected folder).
- Never silently create an empty database when an existing one is missing or corrupt.
- Enable consistent backup/restore and future Android sharing of the same schema.

## 2. Current state

| Layer | Implementation |
|-------|----------------|
| Client ops | `src/lib/ops.ts` (transactional business rules) |
| Schema (Dexie) | `src/lib/db.ts` version 1 |
| Reports | `src/lib/reports.ts` |
| Receipts | `src/lib/receipt.ts` |
| Settings | `src/lib/settings.ts` (+ meta table) |
| Rust foundation | `src-tauri/src/db.rs` INIT_SCHEMA_SQL + `check_path` |
| Path layout | `src-tauri/src/storage.rs` |

## 3. Table mapping (Dexie → SQLite)

Naming: Dexie camelCase fields → SQLite snake_case columns. JSON line arrays stored as `*_json TEXT` (already in Rust schema).

| Dexie table | SQLite table | PK | Notes |
|-------------|--------------|----|-------|
| meta | meta | key TEXT | value serialized JSON text |
| items | items | id INTEGER AUTOINCREMENT | UNIQUE sku |
| locations | locations | id | parent_id nullable |
| batches | batches | id | FIFO remaining/qty/unit_cost (paisa) |
| ledger | ledger | id | stock movement audit |
| customers | customers | id | |
| suppliers | suppliers | id | |
| sales | sales | id | UNIQUE invoice_no; lines_json |
| saleReturns | sale_returns | id | |
| purchases | purchases | id | lines_json |
| purchaseReturns | purchase_returns | id | |
| payments | payments | id | party_type + party_id |
| expenses | expenses | id | |
| audit | audit | id | |

### Field mapping principles

- Money: INTEGER paisa (no floats).
- Dates: INTEGER epoch ms.
- Booleans: INTEGER 0/1 (`archived`, `voided`).
- Nested line items: JSON text, same shape as TypeScript interfaces in `db.ts`.
- Optional fields: NULL.

### Indexes (SQLite)

Mirror Dexie indexes:

- items(sku UNIQUE), items(barcode), items(name), items(category), items(brand)
- batches(item_id, location_id), batches(date)
- ledger(item_id, location_id, type, date)
- sales(invoice_no UNIQUE), sales(date), sales(customer_id)
- payments(party_type, party_id, date)
- expenses(date, category)
- audit(at, entity)

Foreign keys (enable `PRAGMA foreign_keys = ON`):

- batches.item_id → items.id
- batches.location_id → locations.id
- sales.customer_id → customers.id (nullable)
- sale_returns.sale_id → sales.id
- purchases.supplier_id → suppliers.id
- purchase_returns.purchase_id → purchases.id
- payments.party_id → customers.id OR suppliers.id (enforced in app layer by party_type)

## 4. Adapter architecture

```
UI / routes
    ↓
ops.ts / reports.ts / receipt.ts / settings.ts   (unchanged signatures)
    ↓
data-access port (new): src/lib/data-access/*
    ├── types.ts          // shared entities
    ├── dexie-adapter.ts  // current implementation (default until cutover)
    └── sqlite-adapter.ts // Tauri invoke wrapper (feature-flagged)
    ↓
Tauri commands (Rust)
    ↓
rusqlite + WAL file under configured data root
```

**Rule:** `ops.ts` must not import rusqlite details. All SQL lives in Rust. Frontend calls `invoke("db_*")`.

### Proposed Rust commands (Phase 2+)

- `db_health(path) -> DbHealth` (exists)
- `db_open_configured() -> Result<SessionInfo>` — opens only if file exists or user confirmed create
- `db_exec_tx(ops: TransactionRequest) -> Result<TxResult>` — batch mutations
- CRUD/query commands grouped by domain: items, stock, sales, purchases, parties, payments, expenses, reports snapshots
- `db_export_json() / db_import_json()` — bridge for migration and backup
- `db_backup_sqlite(dest) / db_restore_sqlite(src)` — use SQLite backup API (not raw file copy while hot)

### Transaction handling

- One SQLite transaction per business operation that today uses Dexie `db.transaction(...)`.
- Map `postSale`, `returnSale`, `postPurchase`, `returnPurchase`, `adjustStock`, `transferStock`, `recordPayment` to single atomic transactions updating: batches, ledger, sale/purchase rows, payments, audit.
- On failure: full rollback; UI shows error; no partial stock movement.

## 5. Domain coverage checklist

| Domain | Dexie ops today | SQLite requirement |
|--------|-----------------|--------------------|
| Items + opening stock | saveItem | Insert item + optional batch + ledger |
| Adjust / transfer | adjustStock, transferStock | Batch remaining + ledger rows |
| Sale FIFO | postSale | Consume batches oldest-first; COGS; sale row; optional payment |
| Sale return | returnSale | Restock batches; sale_returns; payment/credit |
| Purchase | postPurchase | New batches; purchase row; supplier balance via payments |
| Purchase return | returnPurchase | Reduce remaining; purchase_returns |
| Parties | saveParty | customers/suppliers |
| Payments | recordPayment | payments + balance derivation |
| Expenses | saveExpense, voidExpense | expenses + void flag |
| Reports | reports.ts pure reads | Same aggregations over SQL or loaded snapshots |
| Receipts | receipt.ts | No DB schema change; read sale + settings |
| Settings | settings.ts via meta | meta key/value JSON |

## 6. IndexedDB → SQLite data migration

1. Detect Dexie data present (browser) or export JSON already on disk (`akhtar-autos-backup.json` from localFolder).
2. User-triggered **Import into SQLite** from recovery/settings (never automatic wipe).
3. Steps:
   - Create safety backup of any existing SQLite file (rename `.pre-migrate-timestamp`).
   - Open target SQLite (user-confirmed path).
   - Apply schema if empty; refuse if schema version incompatible without migration scripts.
   - Insert tables in order: meta → locations → items → parties → batches → ledger → purchases → sales → returns → payments → expenses → audit.
   - Preserve IDs where possible so references stay valid.
   - Verify counts + checksums (row counts, sum of batch.remaining, sum of sales.subtotal).
   - Only then flip app setting `persistence = sqlite`.
4. Rollback: restore pre-migrate SQLite file; keep Dexie data intact until user deletes it.

## 7. Backups, restore, recovery

- **Automatic/manual backup:** SQLite Online Backup API or consistent checkpoint then copy `akhtar-autos.db` (+ `-wal`/`-shm` after checkpoint).
- **Restore:** validate file with `check_path`; safety-copy current DB; replace; reopen; integrity_check.
- **Recovery UI (later phase):** Locate DB / Restore backup / Create new (explicit confirm) / Retry — already required by project rules; must not call schema init except on confirmed create.

## 8. Testing strategy (before cutover)

1. Keep `src/test/ops.test.ts` running against Dexie adapter.
2. Add `ops.sqlite.test.ts` (or Rust integration tests) with the same scenarios: FIFO partial consume, partial payment, sale return, purchase return, balances, expense void.
3. Golden fixtures: export JSON from Dexie after each scenario; import into SQLite; compare report totals and stock remaining.
4. Manual Windows checklist: cold start missing DB, corrupt DB, external drive disconnect, migrate folder.

## 9. Implementation sequence (after approval)

1. Expand Rust schema (indexes, FKs, schema_version table) — still no cutover.
2. Implement read-only Tauri queries + feature flag.
3. Implement transactional writes for one domain (items/stock) behind flag.
4. Port remaining ops domain by domain.
5. Dual-run verification harness.
6. Migration UI + path config.
7. Default to SQLite on new installs; Dexie import path for existing web exports.
8. Remove Dexie only after sign-off.

## 10. Explicit non-goals for this stage

- No deletion of Dexie.
- No change to production ops behavior.
- No Android implementation.
- No Google Drive redesign.
