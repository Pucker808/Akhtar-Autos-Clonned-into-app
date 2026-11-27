/**
 * In-app updates for the installed Windows app.
 *
 * The updater reads latest.json from the newest GitHub Release and only installs
 * files signed with the project's private key. Shop data is copied to a backup
 * file first; if that copy fails, nothing is installed.
 */
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { writeSafetyBackup } from "./backup";

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
export function backupBeforeUpdate(nextVersion: string): Promise<string> {
  return writeSafetyBackup(UPDATE_BACKUP_DIR, `before-v${nextVersion}`);
}

export async function installUpdate(update: Update): Promise<void> {
  await backupBeforeUpdate(update.version);
  // On Windows the installer closes the app itself; relaunch covers other cases.
  await update.downloadAndInstall();
  await relaunch();
}
