/**
 * Data-access facade.
 * Phase 2: health/schema helpers route by persistence mode.
 * Business ops still use Dexie via ops.ts until cutover.
 */
import { getPersistenceMode, isTauriRuntime, type PersistenceMode } from "../persistence";
import * as sqlite from "./sqlite-adapter";
import type { DbHealth, SchemaInfo, TableCount } from "./types";

export type { DbHealth, SchemaInfo, TableCount, PersistenceMode };
export {
  getPersistenceMode,
  setPersistenceMode,
  isSqliteMode,
  isTauriRuntime,
  getConfiguredSqlitePath,
  setConfiguredSqlitePath,
} from "../persistence";
export { sqlite };

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
