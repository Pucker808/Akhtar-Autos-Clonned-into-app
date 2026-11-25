/** Shared read models and mutation types for the data-access layer. */

export type DbHealth = {
  path: string;
  exists: boolean;
  isFile: boolean;
  sizeBytes: number;
  integrityOk: boolean;
  schemaVersion: number | null;
  tableCounts?: Record<string, number> | null;
  message: string;
};

export type SchemaInfo = {
  version: number;
  tables: string[];
  foreignKeysEnabled: boolean;
};

export type TableCount = {
  table: string;
  count: number;
};

export type Mutation = {
  op: "insert" | "update" | "delete";
  table: string;
  /** Snake_case column keys matching SQLite schema. */
  row: Record<string, unknown>;
};

export type TxResult = {
  applied: number;
  lastInsertIds: Record<string, number>;
  /** True when the request id was already committed; nothing was written again. */
  duplicate: boolean;
};

export type ImportReport = {
  path: string;
  tables: Record<string, number>;
  warnings: string[];
  safetyBackup?: string | null;
  message: string;
};

export type BackupReport = {
  source: string;
  destination: string;
  sizeBytes: number;
  message: string;
};

/** Canonical table order for migration (FK-safe). */
export const SQLITE_TABLE_ORDER = [
  "meta",
  "locations",
  "customers",
  "suppliers",
  "items",
  "batches",
  "ledger",
  "sales",
  "sale_returns",
  "purchases",
  "purchase_returns",
  "payments",
  "expenses",
  "audit",
] as const;

export type SqliteTableName = (typeof SQLITE_TABLE_ORDER)[number];
