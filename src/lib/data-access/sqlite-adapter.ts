/**
 * SQLite adapter foundation — Tauri invoke wrappers.
 * Read/health/create only in Phase 2. Write path for ops lands after cutover approval.
 */
import { invoke } from "@tauri-apps/api/core";
import type { DbHealth, SchemaInfo, TableCount } from "./types";
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

/**
 * Create a new empty database. Requires confirmCreate === true.
 * Refuses if the file already exists.
 */
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

/** Resolve the active SQLite path: configured override or platform default. */
export async function resolveSqlitePath(): Promise<string> {
  const configured = getConfiguredSqlitePath();
  if (configured) return configured;
  return sqliteDefaultDatabasePath();
}

/** Health of the configured/default path without creating a file. */
export async function sqliteHealthConfigured(): Promise<DbHealth> {
  const path = await resolveSqlitePath();
  return sqliteCheckPath(path);
}
