/**
 * In-app updates for the installed Windows app.
 *
 * The updater reads latest.json from the newest GitHub Release and only installs
 * files signed with the project's private key. Shop data is copied to a backup
 * file first; if that copy fails, nothing is installed.
 */
import { getVersion } from "@tauri-apps/api/app";
import { BaseDirectory, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { db, DATA_TABLES } from "./db";

export const UPDATE_BACKUP_DIR = "pre-update-backups";

export function updatesSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    /windows/i.test(navigator.userAgent)
  );
}

export function currentVersion(): Promise<string> {
  return getVersion();
}

export function findUpdate(): Promise<Update | null> {
  return check({ timeout: 30_000 });
}

/** Writes every table to a new file in the app data folder and returns its name. */
export async function backupBeforeUpdate(nextVersion: string): Promise<string> {
  const data: Record<string, unknown> = {
    app: "Akhtar Autos",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
  };
  // One read transaction, so all tables come from the same moment.
  await db.transaction(
    "r",
    DATA_TABLES.map((name) => db.table(name)),
    async () => {
      for (const name of DATA_TABLES) data[name] = await db.table(name).toArray();
    },
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `before-v${nextVersion}-${stamp}.json`;
  await mkdir(UPDATE_BACKUP_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  await writeTextFile(`${UPDATE_BACKUP_DIR}/${fileName}`, JSON.stringify(data), {
    baseDir: BaseDirectory.AppData,
  });
  return fileName;
}

export async function installUpdate(update: Update): Promise<void> {
  await backupBeforeUpdate(update.version);
  // On Windows the installer closes the app itself; relaunch covers other cases.
  await update.downloadAndInstall();
  await relaunch();
}
