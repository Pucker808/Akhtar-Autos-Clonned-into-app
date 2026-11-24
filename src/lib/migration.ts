/**
 * Dexie → SQLite migration preparation (explicit, user-confirmed).
 *
 * - Never deletes IndexedDB / Dexie data.
 * - Never overwrites a non-empty SQLite DB without confirmOverwrite.
 * - Preserves integer IDs and relationships.
 * - Converts camelCase Dexie fields to snake_case SQLite columns.
 * - Stores sale/purchase line arrays as JSON text.
 * - Safety backup is created on the Rust side when overwriting.
 *
 * Dexie remains the live default until cutover approval.
 */
import { db, DATA_TABLES } from "./db";
import {
  SQLITE_TABLE_ORDER,
  type ImportReport,
  type SqliteTableName,
} from "./data-access/types";
import * as sqlite from "./data-access/sqlite-adapter";
import { isTauriRuntime } from "./persistence";

export type DexieSnapshot = {
  exportedAt: number;
  source: "dexie";
  tables: Record<string, Record<string, unknown>[]>;
  counts: Record<string, number>;
};

/** Map Dexie table name → SQLite table name. */
const DEXIE_TO_SQLITE: Record<string, SqliteTableName> = {
  meta: "meta",
  locations: "locations",
  customers: "customers",
  suppliers: "suppliers",
  items: "items",
  batches: "batches",
  ledger: "ledger",
  sales: "sales",
  saleReturns: "sale_returns",
  purchases: "purchases",
  purchaseReturns: "purchase_returns",
  payments: "payments",
  expenses: "expenses",
  audit: "audit",
};

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/** Convert one Dexie row to SQLite snake_case row. */
export function dexieRowToSqlite(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    // Line arrays become JSON text columns
    if ((table === "sales" || table === "saleReturns" || table === "purchases" || table === "purchaseReturns") && k === "lines") {
      out["lines_json"] = JSON.stringify(v);
      continue;
    }
    // Booleans → 0/1
    if (typeof v === "boolean") {
      out[camelToSnake(k)] = v ? 1 : 0;
      continue;
    }
    // meta.value may be object — store as JSON string
    if (table === "meta" && k === "value" && typeof v === "object" && v !== null) {
      out["value"] = JSON.stringify(v);
      continue;
    }
    out[camelToSnake(k)] = v;
  }
  return out;
}

/** Export all Dexie tables to an in-memory snapshot (does not touch SQLite). */
export async function exportDexieSnapshot(): Promise<DexieSnapshot> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};
  for (const name of DATA_TABLES) {
    const rows = await (db as unknown as Record<string, { toArray: () => Promise<Record<string, unknown>[]> }>)[name].toArray();
    tables[name] = rows;
    counts[name] = rows.length;
  }
  return { exportedAt: Date.now(), source: "dexie", tables, counts };
}

/** Transform Dexie snapshot tables into SQLite-shaped tables. */
export function transformSnapshotForSqlite(
  snapshot: DexieSnapshot,
): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [dexieName, rows] of Object.entries(snapshot.tables)) {
    const sqlName = DEXIE_TO_SQLITE[dexieName];
    if (!sqlName) continue;
    out[sqlName] = rows.map((r) => dexieRowToSqlite(dexieName, r));
  }
  // Ensure empty arrays for missing tables so import order is complete
  for (const t of SQLITE_TABLE_ORDER) {
    if (!out[t]) out[t] = [];
  }
  return out;
}

export type MigrationOptions = {
  /** Target SQLite path. Defaults to configured / platform default. */
  path?: string;
  /** Required if the target DB already has business data. */
  confirmOverwrite: boolean;
  /**
   * If true and the DB file does not exist, create an empty schema first
   * (still requires confirmOverwrite=false only when empty create is intentional).
   */
  createIfMissing?: boolean;
};

/**
 * Import a Dexie snapshot into SQLite.
 * Requires Tauri. Never deletes Dexie. Requires explicit confirmOverwrite when non-empty.
 */
export async function importDexieSnapshotToSqlite(
  snapshot: DexieSnapshot,
  options: MigrationOptions,
): Promise<ImportReport> {
  if (!isTauriRuntime()) {
    throw new Error("SQLite import requires the Tauri desktop runtime");
  }
  const path = options.path ?? (await sqlite.resolveSqlitePath());
  let health = await sqlite.sqliteCheckPath(path);
  if (!health.exists) {
    if (!options.createIfMissing) {
      throw new Error(
        `SQLite database not found at ${path}. Create it explicitly or pass createIfMissing: true after user confirmation.`,
      );
    }
    // Parent layout: ensure directory exists via layout helper on parent of Database/
    const parent = path.replace(/[\\/][^\\/]+$/, "");
    // create empty DB only with confirm
    await sqlite.sqliteCreateDatabase(path, true);
    health = await sqlite.sqliteCheckPath(path);
  }
  const tables = transformSnapshotForSqlite(snapshot);
  return sqlite.sqliteImportSnapshot(path, tables, options.confirmOverwrite);
}

/**
 * Convenience: export current Dexie → import into SQLite (explicit confirms).
 * Does not flip persistence mode.
 */
export async function migrateDexieToSqlite(options: MigrationOptions): Promise<{
  snapshot: DexieSnapshot;
  report: ImportReport;
}> {
  const snapshot = await exportDexieSnapshot();
  const report = await importDexieSnapshotToSqlite(snapshot, options);
  return { snapshot, report };
}

/** Compare Dexie counts vs SQLite counts after import. */
export function compareCounts(
  dexieCounts: Record<string, number>,
  sqliteTables: Record<string, number>,
): { ok: boolean; diffs: string[] } {
  const diffs: string[] = [];
  for (const [dexieName, sqlName] of Object.entries(DEXIE_TO_SQLITE)) {
    const a = dexieCounts[dexieName] ?? 0;
    const b = sqliteTables[sqlName] ?? 0;
    if (a !== b) diffs.push(`${dexieName}/${sqlName}: dexie=${a} sqlite=${b}`);
  }
  return { ok: diffs.length === 0, diffs };
}
