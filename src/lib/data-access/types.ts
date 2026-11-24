/** Shared read models for the data-access layer (Dexie or SQLite). */

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
