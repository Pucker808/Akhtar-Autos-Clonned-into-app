/**
 * Dexie → SQLite migration preparation (explicit, user-confirmed).
 *
 * - Never deletes IndexedDB / Dexie data.
 * - Never overwrites a non-empty SQLite DB without confirmOverwrite.
 * - Preserves integer IDs and relationships.
 * - Converts camelCase Dexie fields to snake_case SQLite columns.
 * - Stores sale/purchase line arrays as JSON text.
 * - Stores every meta value as JSON text (lossless; see decodeMetaValue).
 * - Refuses values SQLite would silently lose (NaN, Infinity, Date, Blob, ...).
 * - Import is all-or-nothing on the Rust side: no row is skipped or replaced.
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

/**
 * Dexie meta keys that only make sense inside this browser profile.
 * A FileSystemDirectoryHandle cannot be serialized; it would be saved as `{}`.
 */
export const DEVICE_LOCAL_META_KEYS: readonly string[] = ["localFolderHandle"];

/**
 * Throw if JSON serialization (used by Tauri IPC) would change a value.
 * e.g. NaN and Infinity silently become null.
 */
function assertJsonSafe(value: unknown, where: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Migration blocked: ${where} is ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonSafe(v, `${where}[${i}]`));
    return;
  }
  const proto = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto === null || (proto !== undefined && Object.getPrototypeOf(proto) === null)) {
    for (const [k, v] of Object.entries(value as object)) {
      if (v !== undefined) assertJsonSafe(v, `${where}.${k}`);
    }
    return;
  }
  throw new Error(`Migration blocked: ${where} has a value that cannot be stored as JSON`);
}

/** Decode a SQLite meta value written by this migration back to its Dexie value. */
export function decodeMetaValue(stored: string): unknown {
  return JSON.parse(stored) as unknown;
}

/** Convert one Dexie row to SQLite snake_case row. */
export function dexieRowToSqlite(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const label = `${table} row ${String(row["id"] ?? row["key"] ?? "?")}`;
  if (table === "meta") {
    const value = row["value"] ?? null;
    assertJsonSafe(value, `${label}.value`);
    return { key: row["key"], value: JSON.stringify(value) };
  }
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    assertJsonSafe(v, `${label}.${k}`);
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
    out[camelToSnake(k)] = v;
  }
  return out;
}

/** Export all Dexie tables to an in-memory snapshot (does not touch SQLite). */
export async function exportDexieSnapshot(): Promise<DexieSnapshot> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};
  // One read transaction: a write in progress cannot produce a half-updated snapshot.
  await db.transaction(
    "r",
    DATA_TABLES.map((name) => db.table(name)),
    async () => {
      for (const name of DATA_TABLES) {
        const rows = (await db.table(name).toArray()) as Record<string, unknown>[];
        tables[name] = rows;
        counts[name] = rows.length;
      }
    },
  );
  return { exportedAt: Date.now(), source: "dexie", tables, counts };
}

/** Transform Dexie snapshot tables into SQLite-shaped tables. */
export function transformSnapshotForSqlite(
  snapshot: DexieSnapshot,
): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [dexieName, rows] of Object.entries(snapshot.tables)) {
    const sqlName = DEXIE_TO_SQLITE[dexieName];
    if (!sqlName) {
      throw new Error(`Migration blocked: no SQLite table is mapped for "${dexieName}"`);
    }
    const portable =
      dexieName === "meta"
        ? rows.filter((r) => !DEVICE_LOCAL_META_KEYS.includes(String(r["key"])))
        : rows;
    out[sqlName] = portable.map((r) => dexieRowToSqlite(dexieName, r));
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
   * Set only after the user has confirmed creating a new database at `path`.
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
  // Transform first: bad source data must fail before any file is created.
  const tables = transformSnapshotForSqlite(snapshot);
  const path = options.path ?? (await sqlite.resolveSqlitePath());
  const health = await sqlite.sqliteCheckPath(path);
  let created = false;
  if (!health.exists) {
    if (!options.createIfMissing) {
      throw new Error(
        `SQLite database not found at ${path}. Create it explicitly or pass createIfMissing: true after user confirmation.`,
      );
    }
    // The default location needs its folder tree; custom folders must already exist.
    if (path === (await sqlite.sqliteDefaultDatabasePath())) {
      await sqlite.sqliteEnsureDataLayout(await sqlite.sqliteDefaultDataRoot());
    }
    await sqlite.sqliteCreateDatabase(path, true);
    created = true;
  }
  let report: ImportReport;
  try {
    report = await sqlite.sqliteImportSnapshot(path, tables, options.confirmOverwrite);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const note = created
      ? ` A new empty database was created at ${path} and left in place. Dexie data is unchanged.`
      : " Dexie data is unchanged.";
    throw new Error(`SQLite import failed: ${reason}.${note}`);
  }
  const expected = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [
      name,
      // The target keeps its own schema_version/app meta rows.
      name === "meta"
        ? rows.filter((r) => r["key"] !== "schema_version" && r["key"] !== "app").length
        : rows.length,
    ]),
  );
  const mismatched = Object.keys(expected).filter((t) => expected[t] !== report.tables[t]);
  if (mismatched.length > 0) {
    throw new Error(`SQLite import count mismatch in: ${mismatched.join(", ")}`);
  }
  return report;
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
