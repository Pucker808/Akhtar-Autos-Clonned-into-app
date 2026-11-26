import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const written: { path: string; text: string }[] = [];
const writeTextFile = vi.fn(async (path: string, text: string) => {
  calls.push("backup");
  written.push({ path, text });
});

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 1 },
  mkdir: vi.fn(async () => {}),
  writeTextFile: (path: string, text: string) => writeTextFile(path, text),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(async () => {
    calls.push("relaunch");
  }),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));

import { installUpdate } from "../lib/app-update";
import { db, DATA_TABLES } from "../lib/db";

const update = {
  version: "9.9.9",
  downloadAndInstall: vi.fn(async () => {
    calls.push("install");
  }),
};

describe("installUpdate", () => {
  beforeEach(async () => {
    calls.length = 0;
    written.length = 0;
    update.downloadAndInstall.mockClear();
    await db.meta.put({ key: "update-test", value: 42 });
  });

  it("backs up every table before installing", async () => {
    await installUpdate(update as never);
    expect(calls).toEqual(["backup", "install", "relaunch"]);
    expect(written[0]!.path).toMatch(/^pre-update-backups\/before-v9\.9\.9-.*\.json$/);
    const payload = JSON.parse(written[0]!.text);
    for (const name of DATA_TABLES) expect(Array.isArray(payload[name])).toBe(true);
    expect(payload.meta).toContainEqual({ key: "update-test", value: 42 });
    expect(payload.formatVersion).toBe(1);
  });

  it("does not install when the backup cannot be written", async () => {
    writeTextFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(installUpdate(update as never)).rejects.toThrow("disk full");
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
  });
});
