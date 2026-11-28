import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, DATA_TABLES } from "@/lib/db";
import { ensureDefaults, postPurchase, postSale, returnSale, returnPurchase, recordPayment, saveExpense, saveItem, saveParty, customerBalance, supplierBalance, stockQty } from "@/lib/ops";
import { correctSale, correctPurchase, correctSaleReturn, correctPurchaseReturn, correctItem, correctParty, correctPayment, correctExpense } from "@/lib/corrections";
import { summarize, stockSnapshot } from "@/lib/reports";
import { pkDateToMs, DAY } from "@/lib/dates";

const T0 = pkDateToMs("2026-03-10");
const RANGE = { from: T0 - DAY, to: T0 + 10 * DAY };
let shop = 0, sup = 0, cust = 0, item = 0, other = 0;

async function reset(opening = 0, openingCost = 0) {
  await db.delete(); await db.open();
  await ensureDefaults();
  shop = (await db.locations.toArray())[0]!.id!;
  sup = await saveParty("suppliers", { name: "Sup" });
  cust = await saveParty("customers", { name: "Cust" });
  item = await saveItem({ sku: "BP-1", name: "Brake pad", unit: "pc", reorderLevel: 2, cost: 0, price: 2000 }, undefined, opening ? { qty: opening, locationId: shop, unitCost: openingCost, date: T0 - 1000 } : undefined);
  other = await saveItem({ sku: "OF-1", name: "Oil filter", unit: "pc", reorderLevel: 2, cost: 0, price: 900 });
}
const buy = (qty: number, unitCost: number, at = 0, itemId = item) =>
  postPurchase({ billNo: "B" + at, supplierId: sup, date: T0 + at, locationId: shop, lines: [{ itemId, qty, unitCost, discount: 0 }], discount: 0, paid: 0, method: "cash" });
const sell = (qty: number, price = 2000, at = 5000, paid = 0) =>
  postSale({ lines: [{ itemId: item, qty, price, discount: 0 }], discount: 0, customerId: cust, paid, method: "cash", locationId: shop, date: T0 + at });
const saleFix = (qty: number, price = 2000, paid = 0, at = 5000) =>
  ({ lines: [{ itemId: item, qty, price, discount: 0 }], discount: 0, customerId: cust, paid, method: "cash" as const, date: T0 + at });
async function billFix(id: number, qty: number, unitCost: number, discount = 0) {
  const p = (await db.purchases.get(id))!;
  return { billNo: p.billNo, supplierId: p.supplierId, date: p.date, paid: 0, method: "cash" as const, discount, lines: [{ batchId: p.lines[0]!.batchId, itemId: p.lines[0]!.itemId, qty, unitCost, discount: 0 }] };
}
/** Everything the owner sees: stock, value, balances and the profit report. */
async function figures() {
  const stock = await stockSnapshot();
  const batches = await db.batches.toArray();
  return {
    summary: await summarize(RANGE),
    value: stock.totalValue,
    qty: [await stockQty(item), await stockQty(other)],
    remaining: [item, other].map((id) => batches.filter((b) => b.itemId === id).reduce((n, b) => n + b.remaining, 0)),
    customer: await customerBalance(cust),
    supplier: await supplierBalance(sup),
    ledgerCost: (await db.ledger.toArray()).reduce((n, l) => n + Math.sign(l.qty) * l.cost, 0),
  };
}
async function dump() {
  const out: Record<string, unknown> = {};
  for (const t of DATA_TABLES) out[t] = await db.table(t).toArray();
  return JSON.stringify(out);
}
/** A corrected entry must give the same figures as entering it right the first time. */
async function sameAs(wrongThenFixed: () => Promise<void>, right: () => Promise<void>) {
  await reset(); await wrongThenFixed(); const a = await figures();
  await reset(); await right(); const b = await figures();
  expect(a).toEqual(b);
}

describe("corrections match a correct first entry", () => {
  it("sale quantity raised across two batches", () => sameAs(
    async () => { await buy(10, 1000); await buy(10, 1200, 1); const id = await sell(3); await correctSale(id, saleFix(12)); },
    async () => { await buy(10, 1000); await buy(10, 1200, 1); await sell(12); }));
  it("sale quantity lowered", () => sameAs(
    async () => { await buy(10, 1000); await buy(10, 1200, 1); const id = await sell(15); await correctSale(id, saleFix(4)); },
    async () => { await buy(10, 1000); await buy(10, 1200, 1); await sell(4); }));
  it("sale rate and paid amount", () => sameAs(
    async () => { await buy(10, 1000); const id = await sell(3, 20000, 5000, 500); await correctSale(id, saleFix(3, 2000, 700)); },
    async () => { await buy(10, 1000); await sell(3, 2000, 5000, 700); }));
  it("purchase cost after part of it was sold and returned", () => sameAs(
    async () => { const b = await buy(10, 9000); const s = await sell(6); await returnSale({ saleId: s, lines: [{ itemId: item, qty: 2 }], refundCash: 0, method: "cash", date: T0 + 6000 }); await correctPurchase(b, await billFix(b, 10, 1000)); },
    async () => { await buy(10, 1000); const s = await sell(6); await returnSale({ saleId: s, lines: [{ itemId: item, qty: 2 }], refundCash: 0, method: "cash", date: T0 + 6000 }); }));
  it("purchase cost reaches stock sold again after a return", () => sameAs(
    async () => { const b = await buy(4, 9000); const s = await sell(4); await returnSale({ saleId: s, lines: [{ itemId: item, qty: 2 }], refundCash: 0, method: "cash", date: T0 + 6000 }); await sell(2, 2000, 7000); await correctPurchase(b, await billFix(b, 4, 1000)); },
    async () => { await buy(4, 1000); const s = await sell(4); await returnSale({ saleId: s, lines: [{ itemId: item, qty: 2 }], refundCash: 0, method: "cash", date: T0 + 6000 }); await sell(2, 2000, 7000); }));
  it("purchase quantity and bill discount", () => sameAs(
    async () => { const b = await buy(100, 1000); await sell(6); await correctPurchase(b, await billFix(b, 10, 1000, 500)); },
    async () => { await postPurchase({ billNo: "B0", supplierId: sup, date: T0, locationId: shop, lines: [{ itemId: item, qty: 10, unitCost: 1000, discount: 0 }], discount: 500, paid: 0, method: "cash" }); await sell(6); }));
  it("sale return quantity and refund", () => sameAs(
    async () => { await buy(10, 1000); const s = await sell(6, 2000, 5000, 6000); const r = await returnSale({ saleId: s, lines: [{ itemId: item, qty: 5 }], refundCash: 0, method: "cash", date: T0 + 6000 }); await correctSaleReturn(r, { qtys: [2], refundCash: 1000, method: "cash" }); },
    async () => { await buy(10, 1000); const s = await sell(6, 2000, 5000, 6000); await returnSale({ saleId: s, lines: [{ itemId: item, qty: 2 }], refundCash: 1000, method: "cash", date: T0 + 6000 }); }));
  it("cancelled sale return", () => sameAs(
    async () => { await buy(10, 1000); const s = await sell(6); const r = await returnSale({ saleId: s, lines: [{ itemId: item, qty: 2 }], refundCash: 0, method: "cash", date: T0 + 6000 }); await correctSaleReturn(r, { qtys: [0], refundCash: 0, method: "cash" }); },
    async () => { await buy(10, 1000); await sell(6); }));
  it("purchase return quantity", () => sameAs(
    async () => { const b = await buy(10, 1000); const r = await returnPurchase({ purchaseId: b, lines: [{ itemId: item, qty: 7 }], refundCash: 0, date: T0 + 6000 }); await correctPurchaseReturn(r, { qtys: [3], refundCash: 500 }); },
    async () => { const b = await buy(10, 1000); await returnPurchase({ purchaseId: b, lines: [{ itemId: item, qty: 3 }], refundCash: 500, date: T0 + 6000 }); }));
  it("opening stock quantity and cost after a sale", async () => {
    await reset(50, 7000); const s = await sell(4);
    await correctItem(item, { name: "Brake pad", sku: "BP-1", cost: 0, price: 2000, reorderLevel: 2, openingQty: 5, openingCost: 700 });
    const a = await figures();
    expect((await db.sales.get(s))!.lines[0]!.cogs).toBe(2800);
    await reset(5, 700); await sell(4);
    expect(a).toEqual(await figures());
  });
});

describe("refused corrections change nothing", () => {
  async function refused(run: () => Promise<unknown>, message: RegExp) {
    const before = await dump();
    await expect(run()).rejects.toThrow(message);
    expect(await dump()).toBe(before);
  }
  beforeEach(() => reset());
  it("bill quantity below what was sold", async () => {
    const b = await buy(10, 1000); await sell(6);
    const fix = await billFix(b, 5, 800);
    await refused(() => correctPurchase(b, fix), /pehle hi bik/);
  });
  it("sale quantity above stock", async () => {
    await buy(10, 1000); const s = await sell(6);
    await refused(() => correctSale(s, saleFix(11)), /Not enough stock/);
  });
  it("rate change on an invoice that has a return", async () => {
    await buy(10, 1000); const s = await sell(6);
    await returnSale({ saleId: s, lines: [{ itemId: item, qty: 1 }], refundCash: 0, method: "cash" });
    await refused(() => correctSale(s, saleFix(6, 1500)), /return mojood/);
  });
  it("cost change when part of the batch went back to the supplier from another bill", async () => {
    const first = await buy(5, 1000); const second = await buy(5, 1000, 1);
    await sell(5); await returnPurchase({ purchaseId: first, lines: [{ itemId: item, qty: 2 }], refundCash: 0 });
    const fix = await billFix(second, 5, 800);
    await refused(() => correctPurchase(second, fix), /cost change nahi/);
  });
  it("cancelling a sale return whose stock was sold again", async () => {
    await buy(4, 1000); const s = await sell(4);
    const r = await returnSale({ saleId: s, lines: [{ itemId: item, qty: 2 }], refundCash: 0, method: "cash" });
    await sell(2, 2000, 7000);
    await refused(() => correctSaleReturn(r, { qtys: [0], refundCash: 0, method: "cash" }), /aage nikal/);
  });
});

describe("purchase date and line safety", () => {
  beforeEach(() => reset());
  async function dated(id: number, date: number) {
    const p = (await db.purchases.get(id))!;
    return { ...(await billFix(id, p.lines[0]!.qty, p.lines[0]!.unitCost)), date };
  }
  async function refusedUnchanged(id: number, fix: Parameters<typeof correctPurchase>[1], message: RegExp) {
    const before = await dump();
    await expect(correctPurchase(id, fix)).rejects.toThrow(message);
    expect(await dump()).toBe(before);
  }
  it("refuses a date that puts a bill ahead of stock already sold", async () => {
    await buy(5, 1000, DAY); const second = await buy(5, 2000, 2 * DAY); await sell(5, 2000, 3 * DAY);
    await refusedUnchanged(second, await dated(second, T0), /FIFO order/);
  });
  it("refuses a date that moves a sold bill behind another one", async () => {
    const first = await buy(5, 1000, DAY); await buy(5, 2000, 2 * DAY); await sell(3, 2000, 3 * DAY);
    await refusedUnchanged(first, await dated(first, T0 + 3 * DAY), /FIFO order/);
  });
  it("allows a date change that keeps the order", async () => {
    const first = await buy(5, 1000, DAY); await buy(5, 2000, 3 * DAY); await sell(3, 2000, 4 * DAY);
    await correctPurchase(first, await dated(first, T0 + 2 * DAY));
    expect((await db.purchases.get(first))!.date).toBe(T0 + 2 * DAY);
  });
  it("allows reordering stock that has not moved", async () => {
    await buy(5, 1000, DAY); const second = await buy(5, 2000, 2 * DAY);
    await correctPurchase(second, await dated(second, T0));
    const s = await sell(5, 2000, 3 * DAY);
    expect((await db.sales.get(s))!.lines[0]!.cogs).toBe(10000);
  });
  it("refuses the same stock line twice", async () => {
    const id = await buy(10, 1000);
    const fix = await billFix(id, 6, 1000);
    await refusedUnchanged(id, { ...fix, lines: [fix.lines[0]!, { ...fix.lines[0]!, qty: 4 }] }, /do dafa/);
  });
  it("carries a cost fix through stock that was sold and returned twice", () => {
    const history = async (cost: number) => {
      const b = await buy(4, cost);
      for (const at of [5000, 7000]) {
        const s = await sell(4, 2000, at);
        await returnSale({ saleId: s, lines: [{ itemId: item, qty: 4 }], refundCash: 0, method: "cash", date: T0 + at + 1000 });
      }
      await sell(3, 2000, 9500);
      return b;
    };
    return sameAs(
      async () => { const b = await history(9000); await correctPurchase(b, await billFix(b, 4, 1000)); },
      async () => { await history(1000); });
  });
});

describe("simple corrections", () => {
  beforeEach(() => reset());
  it("renames reach saved invoices, and each correction is logged", async () => {
    await buy(10, 1000); const s = await sell(1);
    await correctParty("customers", cust, { name: "Customer Ali" });
    await correctItem(item, { name: "Brake pad front", sku: "BP-2", cost: 1000, price: 2500, reorderLevel: 2, openingQty: 0, openingCost: 0 });
    const sale = (await db.sales.get(s))!;
    expect([sale.customerName, sale.lines[0]!.name, sale.lines[0]!.sku, sale.lines[0]!.price]).toEqual(["Customer Ali", "Brake pad front", "BP-2", 2000]);
    expect(await db.audit.filter((a) => a.action === "correct").count()).toBe(2);
  });
  it("payment and expense amounts", async () => {
    await buy(10, 1000); await sell(2);
    const pay = await recordPayment({ partyType: "customer", partyId: cust, amount: 30000, method: "cash", date: T0 });
    await correctPayment(pay, { partyId: cust, amount: 3000, method: "bank", date: T0 });
    expect(await customerBalance(cust)).toBe(1000);
    const exp = await saveExpense({ date: T0, category: "Tea", amount: 50000, method: "cash" });
    await correctExpense(exp, { date: T0, category: "Tea", amount: 500, method: "cash", payee: "" });
    expect((await summarize(RANGE)).expenses).toBe(500);
  });
});
