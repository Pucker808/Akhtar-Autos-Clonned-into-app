import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    return null;
  }),
}));

import * as sqlite from "@/lib/data-access/sqlite-adapter";

/**
 * Records exactly what the frontend sends over IPC. The Rust test
 * `frontend_ipc_contract_is_accepted_by_the_real_commands` replays this file
 * through Tauri's command handler, so a renamed command or argument fails CI.
 */
const FIXTURE = resolve(process.cwd(), "src-tauri/tests/fixtures/ipc-contract.json");

describe("frontend → Rust IPC contract", () => {
  beforeAll(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  });

  it("matches the committed contract", async () => {
    const db = "$DIR/contract.db";
    const row = { name: "Main", type: "shop", created_at: 1, updated_at: 1, device_id: "d" };
    await sqlite.sqliteDefaultDatabasePath();
    await sqlite.sqliteDefaultDataRoot();
    await sqlite.sqliteEnsureDataLayout("$DIR/root");
    await sqlite.sqliteCreateDatabase(db, true);
    await sqlite.sqliteCheckPath(db);
    await sqlite.sqliteSchemaInfo(db);
    await sqlite.sqliteTableCounts(db);
    await sqlite.sqliteGetMeta(db, "app");
    await sqlite.sqliteImportSnapshot(db, { locations: [{ id: 1, ...row }] }, false);
    await sqlite.sqliteApplyMutations(db, "req-1", [{ op: "insert", table: "locations", row }]);
    await sqlite.sqliteExportTable(db, "locations");
    await sqlite.sqliteBatchesFifo(db, 1, 1);
    await sqlite.sqliteStockQty(db, 1);
    await sqlite.sqliteStockQty(db, 1, 1);
    await sqlite.sqliteGetRow(db, "locations", 1);
    await sqlite.sqliteListRows(db, "locations");
    await sqlite.sqliteListRows(db, "locations", "name", "Main", 5);
    await sqlite.sqliteBackup(db, "$DIR/backup.db");
    await sqlite.sqliteRestore("$DIR/backup.db", db, true);

    const actual = `${JSON.stringify(calls, null, 2)}\n`;
    if (process.env["UPDATE_IPC_CONTRACT"]) writeFileSync(FIXTURE, actual);
    expect(JSON.parse(actual)).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });

  it("refuses to invoke outside Tauri", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(sqlite.sqliteCheckPath("/x")).rejects.toThrow(/Tauri/);
  });
});
