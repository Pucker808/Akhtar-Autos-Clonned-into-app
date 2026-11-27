import { BaseDirectory, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { db, DATA_TABLES } from "./db";

/** Every table, read in one transaction so they all come from the same moment. */
export async function buildBackupPayload(): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = { app: "Akhtar Autos", formatVersion: 1, exportedAt: new Date().toISOString() };
  await db.transaction("r", DATA_TABLES.map((name) => db.table(name)), async () => {
    for (const name of DATA_TABLES) data[name] = await db.table(name).toArray();
  });
  return data;
}

/** Writes a backup into a folder under the app data directory; returns the file name. */
export async function writeSafetyBackup(folder: string, prefix: string): Promise<string> {
  const text = JSON.stringify(await buildBackupPayload());
  const fileName = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await mkdir(folder, { baseDir: BaseDirectory.AppData, recursive: true });
  await writeTextFile(`${folder}/${fileName}`, text, { baseDir: BaseDirectory.AppData });
  return fileName;
}
