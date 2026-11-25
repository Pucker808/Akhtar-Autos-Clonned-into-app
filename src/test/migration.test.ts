import "fake-indexeddb/auto";
import { writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, DATA_TABLES } from "@/lib/db";
import {
  adjustStock,
  ensureDefaults,
  postPurchase,
  postSale,
  recordPayment,
  returnPurchase,
  returnSale,
  saveExpense,
  saveItem,
  saveLocation,
  saveParty,
  stockQty,
  transferStock,
} from "@/lib/ops";
import {
  compareCounts,
  decodeMetaValue,
  dexieRowToSqlite,
  exportDexieSnapshot,
  importDexieSnapshotToSqlite,
  transformSnapshotForSqlite,
  type DexieSnapshot,
} from "@/lib/migration";
import * as sqlite from "@/lib/data-access/sqlite-adapter";
import { SQLITE_TABLE_ORDER, type ImportReport } from "@/lib/data-access/types";
import { toPaisa } from "@/lib/money";
import { pkDateToMs } from "@/lib/dates";

const T0 = pkDateToMs("2026-03-10");

type Rows = Record<string, Record<string, unknown>[]>;
function table(tables: Rows, name: string): Record<string, unknown>[] {
  const rows = tables[name];
  if (!rows) throw new Error(`missing table ${name}`);
  return rows;
}
function first(rows: Record<string, unknown>[]): Record<string, unknown> {
  const row = rows[0];
  if (!row) throw new Error("expected at least one row");
  return row;
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

/** Drive every business operation so the snapshot has every table and optional field. */
async function seedShop() {
  const shop = (await db.locations.toArray())[0]!.id!;
  const rack = await saveLocation({ name: "Rack A", type: "rack", parentId: shop });
  const supplier = await saveParty("suppliers", { name: "Sup", phone: "0300", address: "Kohat", notes: "n" });
  const customer = await saveParty("customers", { name: "Cust" });
  const item = await saveItem(
    { sku: "BP-1", name: "Brake pad", unit: "pc", reorderLevel: 2, cost: 0, price: toPaisa(2000), supplierId: supplier, locationId: shop, brand: "B", category: "C", barcode: "111", compat: "x", oem: "y", notes: "z", archived: false },
    undefined,
    { qty: 2, locationId: shop, unitCost: toPaisa(900), date: T0 - 1000 },
  );
  const purchase = await postPurchase({ billNo: "B1", supplierId: supplier, date: T0, dueDate: T0 + 86_400_000, locationId: shop, lines: [{ itemId: item, qty: 10, unitCost: toPaisa("1000.01"), discount: 7 }], discount: 13, paid: 0, method: "cash", notes: "p" });
  const sale = await postSale({ lines: [{ itemId: item, qty: 3, price: toPaisa(2000), discount: 0 }], discount: 0, paid: toPaisa(1000), method: "cash", customerId: customer, locationId: shop, date: T0 + 5000, notes: "s" });
  await returnSale({ saleId: sale, lines: [{ itemId: item, qty: 1 }], refundCash: 0, method: "cash", date: T0 + 6000 });
  await returnPurchase({ purchaseId: purchase, lines: [{ itemId: item, qty: 1 }], refundCash: 0, date: T0 + 7000 });
  await transferStock({ itemId: item, fromId: shop, toId: rack, qty: 2, note: "t", date: T0 + 8000 });
  await adjustStock({ itemId: item, locationId: shop, qty: -1, reason: "damaged", date: T0 + 9000 });
  await recordPayment({ partyType: "customer", partyId: customer, amount: 500, method: "cash", date: T0 + 10_000 });
  await recordPayment({ partyType: "supplier", partyId: supplier, amount: 700, method: "bank", date: T0 + 11_000, note: "n" });
  await saveExpense({ date: T0, category: "Rent", amount: 1234, method: "cash", payee: "L", recurring: "monthly", voided: false });
  await db.meta.put({ key: "settings", value: { shopName: "Akhtar Autos", taxEnabled: false } });
  await db.meta.put({ key: "driveAutoUpload", value: true });
  await db.meta.put({ key: "driveLastSync", value: "2026-03-10T00:00:00Z" });
  return { shop, item };
}

describe("dexieRowToSqlite mapping", () => {
  it("converts camelCase and lines to lines_json", () => {
    const row = dexieRowToSqlite("sales", {
      id: 1,
      invoiceNo: "AA-1",
      customerId: 2,
      lines: [{ itemId: 1, qty: 2, price: 100 }],
      total: 200,
      notes: undefined,
    });
    expect(row).toEqual({ id: 1, invoice_no: "AA-1", customer_id: 2, lines_json: '[{"itemId":1,"qty":2,"price":100}]', total: 200 });
  });

  it("maps booleans to 0/1", () => {
    const row = dexieRowToSqlite("items", { id: 1, archived: true, reorderLevel: 0 });
    expect(row["archived"]).toBe(1);
    expect(row["reorder_level"]).toBe(0);
  });

  it.each([["dev-abc"], ["5"], [5], [true], [false], [null], [{ a: [1, "2"] }]])(
    "round-trips meta value %j without losing its type",
    (value) => {
      const row = dexieRowToSqlite("meta", { key: "k", value });
      expect(typeof row["value"]).toBe("string");
      expect(decodeMetaValue(row["value"] as string)).toEqual(value);
    },
  );

  it.each([
    ["NaN", { id: 4, cost: Number.NaN }],
    ["Infinity", { id: 4, cost: Number.POSITIVE_INFINITY }],
    ["a nested NaN", { id: 4, lines: [{ price: Number.NaN }] }],
    ["a Date", { id: 4, date: new Date() }],
    ["a Map", { id: 4, extra: new Map() }],
  ])("refuses %s instead of silently losing it", (_label, row) => {
    expect(() => dexieRowToSqlite("sales", row)).toThrow(/Migration blocked: sales row 4/);
  });
});

describe("export + transform", () => {
  it("handles an empty shop and lists every table", async () => {
    const snap = await exportDexieSnapshot();
    const tables = transformSnapshotForSqlite(snap);
    expect(Object.keys(tables).sort()).toEqual([...SQLITE_TABLE_ORDER].sort());
    expect(table(tables, "sales")).toEqual([]);
    expect(table(tables, "locations")).toHaveLength(1);
  });

  it("preserves counts, IDs, relationships and money for a populated shop", async () => {
    const { item } = await seedShop();
    const snap = await exportDexieSnapshot();
    const tables = transformSnapshotForSqlite(snap);

    for (const name of DATA_TABLES) expect(snap.counts[name], name).toBeGreaterThan(0);

    const itemRow = table(tables, "items").find((r) => r["sku"] === "BP-1");
    expect(itemRow?.["id"]).toBe(item);

    const sale = first(table(tables, "sales"));
    const dexieSale = (await db.sales.toArray())[0]!;
    expect(sale["id"]).toBe(dexieSale.id);
    expect(sale["customer_id"]).toBe(dexieSale.customerId);
    expect(sale["total"]).toBe(dexieSale.total);
    expect(JSON.parse(sale["lines_json"] as string)).toEqual(dexieSale.lines);
    expect(first(table(tables, "sale_returns"))["sale_id"]).toBe(dexieSale.id);

    // The same snapshot is consumed by the Rust tests to prove a real SQLite import.
    const out = process.env["MIGRATION_FIXTURE_OUT"];
    if (out) {
      const stock = await stockQty(item);
      writeFileSync(out, `${JSON.stringify({ itemId: item, stock, tables }, null, 1)}\n`);
    }
  });

  it("does not modify Dexie and gives identical output when repeated", async () => {
    await seedShop();
    const a = await exportDexieSnapshot();
    const b = await exportDexieSnapshot();
    expect(transformSnapshotForSqlite(b)).toEqual(transformSnapshotForSqlite(a));
    expect(b.counts).toEqual(a.counts);
  });

  it("excludes the browser-only folder handle", async () => {
    await db.meta.put({ key: "localFolderHandle", value: { kind: "directory" } });
    const tables = transformSnapshotForSqlite(await exportDexieSnapshot());
    expect(table(tables, "meta").map((r) => r["key"])).not.toContain("localFolderHandle");
    expect(await db.meta.get("localFolderHandle")).toBeDefined();
  });

  it("refuses an unmapped table instead of skipping it", () => {
    const snap: DexieSnapshot = { exportedAt: 0, source: "dexie", counts: {}, tables: { mystery: [] } };
    expect(() => transformSnapshotForSqlite(snap)).toThrow(/mystery/);
  });
});

describe("compareCounts", () => {
  it("reports differences", () => {
    expect(compareCounts({ items: 2 }, { items: 1 })).toEqual({ ok: false, diffs: ["items/items: dexie=2 sqlite=1"] });
    expect(compareCounts({ saleReturns: 1 }, { sale_returns: 1 }).ok).toBe(true);
  });
});

describe("import orchestration and failure handling", () => {
  const health = (exists: boolean) => ({ path: "/x/a.db", exists, isFile: exists, sizeBytes: 0, integrityOk: exists, schemaVersion: 1, message: "" });
  const reportFor = (tables: Rows): ImportReport => ({
    path: "/x/a.db",
    tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    warnings: [],
    message: "ok",
  });

  function setup(exists: boolean) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    vi.restoreAllMocks();
    return {
      check: vi.spyOn(sqlite, "sqliteCheckPath").mockResolvedValue(health(exists)),
      create: vi.spyOn(sqlite, "sqliteCreateDatabase").mockResolvedValue(health(true)),
      defaultPath: vi.spyOn(sqlite, "sqliteDefaultDatabasePath").mockResolvedValue("/default/a.db"),
      importer: vi.spyOn(sqlite, "sqliteImportSnapshot").mockImplementation(async (_p, tables) => reportFor(tables)),
    };
  }

  it("never creates a missing database without explicit permission", async () => {
    const m = setup(false);
    const snap = await exportDexieSnapshot();
    await expect(importDexieSnapshotToSqlite(snap, { path: "/x/a.db", confirmOverwrite: false })).rejects.toThrow(/not found/);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.importer).not.toHaveBeenCalled();
  });

  it("creates only with createIfMissing, and passes confirmOverwrite through unchanged", async () => {
    const m = setup(false);
    await importDexieSnapshotToSqlite(await exportDexieSnapshot(), { path: "/x/a.db", confirmOverwrite: false, createIfMissing: true });
    expect(m.create).toHaveBeenCalledWith("/x/a.db", true);
    expect(m.importer).toHaveBeenCalledWith("/x/a.db", expect.anything(), false);
  });

  it("creates nothing when the source data is invalid", async () => {
    const m = setup(false);
    const snap: DexieSnapshot = { exportedAt: 0, source: "dexie", counts: {}, tables: { items: [{ id: 1, cost: Number.NaN }] } };
    await expect(importDexieSnapshotToSqlite(snap, { path: "/x/a.db", confirmOverwrite: false, createIfMissing: true })).rejects.toThrow(/Migration blocked/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("gives a meaningful error on failure and leaves Dexie intact", async () => {
    await seedShop();
    const before = (await exportDexieSnapshot()).counts;
    const m = setup(true);
    m.importer.mockRejectedValue("items row #0: boom");
    await expect(importDexieSnapshotToSqlite(await exportDexieSnapshot(), { path: "/x/a.db", confirmOverwrite: false })).rejects.toThrow(/boom.*Dexie data is unchanged/);
    expect((await exportDexieSnapshot()).counts).toEqual(before);
  });

  it("fails when the imported counts differ from the source", async () => {
    const m = setup(true);
    m.importer.mockImplementation(async (_p, tables) => ({ ...reportFor(tables), tables: { ...reportFor(tables).tables, locations: 0 } }));
    await expect(importDexieSnapshotToSqlite(await exportDexieSnapshot(), { path: "/x/a.db", confirmOverwrite: false })).rejects.toThrow(/count mismatch.*locations/);
  });
});
