/**
 * SQLite adapter — Tauri invoke wrappers.
 * Phase 2 TX: health, create, mutations, import/export, backup/restore, FIFO reads.
 * Write path for live ops is behind the persistence flag; Dexie remains default.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  BackupReport,
  DbHealth,
  ImportReport,
  Mutation,
  SchemaInfo,
  TableCount,
  TxResult,
} from "./types";
import { getConfiguredSqlitePath, isTauriRuntime } from "../persistence";

function requireTauri(): void {
  if (!isTauriRuntime()) {
    throw new Error("SQLite adapter requires the Tauri desktop runtime");
  }
}

export async function sqliteDefaultDatabasePath(): Promise<string> {
  requireTauri();
  return invoke<string>("get_default_database_path");
}

export async function sqliteDefaultDataRoot(): Promise<string> {
  requireTauri();
  return invoke<string>("get_default_data_root");
}

export async function sqliteEnsureDataLayout(root: string): Promise<void> {
  requireTauri();
  await invoke("ensure_data_layout", { root });
}

export async function sqliteCheckPath(path: string): Promise<DbHealth> {
  requireTauri();
  return invoke<DbHealth>("check_database_path", { path });
}

export async function sqliteCreateDatabase(
  path: string,
  confirmCreate: boolean,
): Promise<DbHealth> {
  requireTauri();
  return invoke<DbHealth>("create_database", { path, confirmCreate });
}

export async function sqliteSchemaInfo(path: string): Promise<SchemaInfo> {
  requireTauri();
  return invoke<SchemaInfo>("get_schema_info", { path });
}

export async function sqliteTableCounts(path: string): Promise<TableCount[]> {
  requireTauri();
  return invoke<TableCount[]>("get_table_counts", { path });
}

export async function sqliteGetMeta(path: string, key: string): Promise<string | null> {
  requireTauri();
  return invoke<string | null>("get_meta_value", { path, key });
}

export async function resolveSqlitePath(): Promise<string> {
  const configured = getConfiguredSqlitePath();
  if (configured) return configured;
  return sqliteDefaultDatabasePath();
}

export async function sqliteHealthConfigured(): Promise<DbHealth> {
  const path = await resolveSqlitePath();
  return sqliteCheckPath(path);
}

/** Apply ordered mutations in one SQLite transaction (full rollback on error). */
export async function sqliteApplyMutations(
  path: string,
  mutations: Mutation[],
): Promise<TxResult> {
  requireTauri();
  return invoke<TxResult>("apply_db_mutations", { path, mutations });
}

export async function sqliteImportSnapshot(
  path: string,
  tables: Record<string, Record<string, unknown>[]>,
  confirmOverwrite: boolean,
): Promise<ImportReport> {
  requireTauri();
  return invoke<ImportReport>("import_db_snapshot", {
    path,
    tables,
    confirmOverwrite,
  });
}

export async function sqliteExportTable(
  path: string,
  table: string,
): Promise<Record<string, unknown>[]> {
  requireTauri();
  return invoke<Record<string, unknown>[]>("export_db_table", { path, table });
}

export async function sqliteBackup(
  source: string,
  destination: string,
): Promise<BackupReport> {
  requireTauri();
  return invoke<BackupReport>("backup_database", { source, destination });
}

export async function sqliteRestore(
  backupPath: string,
  targetPath: string,
  confirmRestore: boolean,
): Promise<DbHealth> {
  requireTauri();
  return invoke<DbHealth>("restore_database", {
    backupPath,
    targetPath,
    confirmRestore,
  });
}

export async function sqliteBatchesFifo(
  path: string,
  itemId: number,
  locationId: number,
): Promise<Record<string, unknown>[]> {
  requireTauri();
  return invoke<Record<string, unknown>[]>("query_batches_fifo", {
    path,
    itemId,
    locationId,
  });
}

export async function sqliteStockQty(
  path: string,
  itemId: number,
  locationId?: number | null,
): Promise<number> {
  requireTauri();
  return invoke<number>("query_stock_qty", {
    path,
    itemId,
    locationId: locationId ?? null,
  });
}

export async function sqliteGetRow(
  path: string,
  table: string,
  id: number,
): Promise<Record<string, unknown> | null> {
  requireTauri();
  return invoke<Record<string, unknown> | null>("get_db_row", { path, table, id });
}

export async function sqliteListRows(
  path: string,
  table: string,
  filterCol?: string,
  filterVal?: unknown,
  limit?: number,
): Promise<Record<string, unknown>[]> {
  requireTauri();
  return invoke<Record<string, unknown>[]>("list_db_rows", {
    path,
    table,
    filterCol: filterCol ?? null,
    filterVal: filterVal ?? null,
    limit: limit ?? null,
  });
}
