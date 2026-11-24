/**
 * Data-access facade.
 * Phase 2 TX: health/schema/mutations/import route by persistence mode.
 * Business ops still use Dexie via ops.ts until cutover.
 */
import { getPersistenceMode, isTauriRuntime, type PersistenceMode } from "../persistence";
import * as sqlite from "./sqlite-adapter";
import type {
  BackupReport,
  DbHealth,
  ImportReport,
  Mutation,
  SchemaInfo,
  TableCount,
  TxResult,
} from "./types";

export type {
  DbHealth,
  SchemaInfo,
  TableCount,
  Mutation,
  TxResult,
  ImportReport,
  BackupReport,
  PersistenceMode,
};
export {
  getPersistenceMode,
  setPersistenceMode,
  isSqliteMode,
  isTauriRuntime,
  getConfiguredSqlitePath,
  setConfiguredSqlitePath,
} from "../persistence";
export { sqlite };
export {
  SQLITE_TABLE_ORDER,
} from "./types";

export async function checkActiveDatabaseHealth(): Promise<DbHealth | null> {
  if (getPersistenceMode() !== "sqlite" || !isTauriRuntime()) {
    return null;
  }
  return sqlite.sqliteHealthConfigured();
}

export async function getActiveSchemaInfo(): Promise<SchemaInfo | null> {
  if (getPersistenceMode() !== "sqlite" || !isTauriRuntime()) {
    return null;
  }
  const path = await sqlite.resolveSqlitePath();
  return sqlite.sqliteSchemaInfo(path);
}

export async function getActiveTableCounts(): Promise<TableCount[] | null> {
  if (getPersistenceMode() !== "sqlite" || !isTauriRuntime()) {
    return null;
  }
  const path = await sqlite.resolveSqlitePath();
  return sqlite.sqliteTableCounts(path);
}

/** Apply mutations only when sqlite mode is active (no dual-write). */
export async function applyMutationsIfSqlite(
  mutations: Mutation[],
): Promise<TxResult | null> {
  if (getPersistenceMode() !== "sqlite" || !isTauriRuntime()) {
    return null;
  }
  const path = await sqlite.resolveSqlitePath();
  return sqlite.sqliteApplyMutations(path, mutations);
}
