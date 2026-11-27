import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildBackupPayload } from "@/lib/backup";
import { importBackupFile } from "@/lib/localFolder";
import { ensureDefaults, saveParty } from "@/lib/ops";

const file = (data: unknown) => ({ text: async () => JSON.stringify(data) }) as File;

describe("backup file restore", () => {
  beforeEach(async () => {
    await db.delete(); await db.open(); await ensureDefaults();
    await saveParty("customers", { name: "Ali" });
  });
  it("restores a downloaded backup", async () => {
    const payload = await buildBackupPayload();
    await db.customers.clear();
    await importBackupFile(file(payload));
    expect((await db.customers.toArray()).map((c) => c.name)).toEqual(["Ali"]);
  });
  it("accepts files made by the older download button", async () => {
    const { formatVersion: _unused, ...old } = await buildBackupPayload();
    await db.customers.clear();
    await importBackupFile(file({ ...old, version: 1 }));
    expect(await db.customers.count()).toBe(1);
  });
  it("keeps current records when the file is incomplete", async () => {
    const { audit: _unused, ...broken } = await buildBackupPayload();
    await expect(importBackupFile(file({ ...broken, customers: [] }))).rejects.toThrow(/missing table/);
    expect(await db.customers.count()).toBe(1);
  });
});
