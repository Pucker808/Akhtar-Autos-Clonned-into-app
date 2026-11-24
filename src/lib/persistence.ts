/**
 * Persistence mode selection for Akhtar Autos Desktop.
 *
 * Default remains Dexie until explicit SQLite cutover is approved.
 * SQLite is the intended primary store for new desktop installs after cutover.
 * Dual-write is intentionally NOT supported as a permanent architecture.
 */
export type PersistenceMode = "dexie" | "sqlite";

const MODE_KEY = "akhtar.persistenceMode";
const DB_PATH_KEY = "akhtar.sqlitePath";

/** Runtime override (tests / session). Prefer meta/localStorage for durability later. */
let sessionMode: PersistenceMode | null = null;

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Resolve active persistence adapter.
 * - Non-Tauri (browser): always dexie
 * - Tauri: session override, else localStorage flag, else dexie (until cutover)
 */
export function getPersistenceMode(): PersistenceMode {
  if (!isTauriRuntime()) return "dexie";
  if (sessionMode) return sessionMode;
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "sqlite" || v === "dexie") return v;
  } catch {
    /* ignore */
  }
  return "dexie";
}

/** Test / recovery helper. Does not migrate data. */
export function setPersistenceMode(mode: PersistenceMode): void {
  sessionMode = mode;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function getConfiguredSqlitePath(): string | null {
  try {
    return localStorage.getItem(DB_PATH_KEY);
  } catch {
    return null;
  }
}

export function setConfiguredSqlitePath(path: string | null): void {
  try {
    if (path) localStorage.setItem(DB_PATH_KEY, path);
    else localStorage.removeItem(DB_PATH_KEY);
  } catch {
    /* ignore */
  }
}

export function isSqliteMode(): boolean {
  return getPersistenceMode() === "sqlite";
}
