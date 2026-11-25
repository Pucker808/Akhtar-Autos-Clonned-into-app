import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  ensureDefaults,
  postPurchase,
  postSale,
  saveItem,
  saveParty,
  stockQty,
} from "@/lib/ops";
import {
  compareCounts,
  dexieRowToSqlite,
  exportDexieSnapshot,
  transformSnapshotForSqlite,
} from "@/lib/migration";
import { toPaisa } from "@/lib/money";
import { pkDateToMs } from "@/lib/dates";

const T0 = pkDateToMs("2026-03-10");

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

describe("dexieRowToSqlite mapping", () => {
  it("converts camelCase and lines to lines_json", () => {
    const row = dexieRowToSqlite("sales", {
      id: 1,
      invoiceNo: "AA-1",
      customerId: 2,
      lines: [{ itemId: 1, qty: 2, price: 100, discount: 0, cogs: 50, allocs: [], returnedQty: 0, name: "x", sku: "s" }],
      total: 200,
      paid: 100,
    });
    expect(row.invoice_no).toBe("AA-1");
    expect(row.customer_id).toBe(2);
    expect(typeof row.lines_json).toBe("string");
    expect(JSON.parse(row.lines_json as string)[0].itemId).toBe(1);
    expect(row.total).toBe(200);
  });

  it("maps booleans to 0/1", () => {
    const row = dexieRowToSqlite("items", { id: 1, name: "A", sku: "S", archived: true, unit: "pc", reorderLevel: 0, cost: 0, price: 0 });
    expect(row.archived).toBe(1);
    expect(row.reorder_level).toBe(0);
  });
});

describe("export + transform preserves counts and IDs", () => {
  it("exports populated shop data and maps all tables", async () => {
    const shop = (await db.locations.toArray())[0]!.id!;
    const sup = await saveParty("suppliers", { name: "Sup" });
    const item = await saveItem({ sku: "BP-1", name: "Brake pad", unit: "pc", reorderLevel: 2, cost: 0, price: toPaisa(2000) });
    await postPurchase({
      billNo: "B1",
      supplierId: sup,
      date: T0,
      locationId: shop,
      lines: [{ itemId: item, qty: 10, unitCost: toPaisa(1000), discount: 0 }],
      discount: 0,
      paid: 0,
      method: "cash",
    });
    await postSale({
      lines: [{ itemId: item, qty: 3, price: toPaisa(2000), discount: 0 }],
      discount: 0,
      paid: toPaisa(6000),
      method: "cash",
      locationId: shop,
      date: T0 + 5000,
    });
    expect(await stockQty(item)).toBe(7);

    const snap = await exportDexieSnapshot();
    expect(snap.source).toBe("dexie");
    expect(snap.counts.items).toBeGreaterThanOrEqual(1);
    expect(snap.counts.sales).toBe(1);
    expect(snap.counts.batches).toBeGreaterThanOrEqual(1);

    const sqlTables = transformSnapshotForSqlite(snap);
    expect(sqlTables["items"].length).toBe(snap.counts.items);
    expect(sqlTables["sales"].length).toBe(1);
    expect(sqlTables["sale_returns"]).toEqual([]);
    // IDs preserved
    const itemRow = sqlTables["items"].find((r) => r.sku === "BP-1");
    expect(itemRow?.id).toBe(item);
    // lines_json present
    expect(typeof sqlTables["sales"][0]!.lines_json).toBe("string");

    const cmp = compareCounts(snap.counts, {
      meta: sqlTables["meta"].length,
      locations: sqlTables["locations"].length,
      customers: sqlTables["customers"].length,
      suppliers: sqlTables["suppliers"].length,
      items: sqlTables["items"].length,
      batches: sqlTables["batches"].length,
      ledger: sqlTables["ledger"].length,
      sales: sqlTables["sales"].length,
      sale_returns: sqlTables["sale_returns"].length,
      purchases: sqlTables["purchases"].length,
      purchase_returns: sqlTables["purchase_returns"].length,
      payments: sqlTables["payments"].length,
      expenses: sqlTables["expenses"].length,
      audit: sqlTables["audit"].length,
    });
    expect(cmp.ok).toBe(true);
  });
});
