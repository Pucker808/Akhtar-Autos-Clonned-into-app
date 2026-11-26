/**
 * Corrects a mistake in a saved entry without deleting and re-entering it.
 *
 * Money formulas are the same as in ops.ts. Stock, FIFO batch costs and the
 * ledger are adjusted with the entry, inside one transaction: a refused
 * correction changes nothing. Every correction stores the old and new entry in
 * the audit table.
 */
import { db, type Alloc, type Batch, type PayMethod, type PurchaseLine, type SaleLine, type Expense, type Item } from "./db";
import { OpError, ALL, now, audit, stamp, consumeFIFO, allocCost, addBatch, addLedger, stockQty, computeInvoice, type CartLine } from "./ops";
import { getSettings } from "./settings";

const snapshot = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isMoney = (n: number) => Number.isInteger(n) && n >= 0;

async function logCorrection(entity: string, entityId: number, before: unknown, after: unknown) {
  await audit("correct", entity, entityId, JSON.stringify({ before, after }));
}

// ---------- Shared batch rules ----------
const consumedFrom = (b: Batch) => b.qty - b.remaining;

async function getBatch(id: number): Promise<Batch> {
  const b = await db.batches.get(id);
  if (!b) throw new OpError("Stock record for this entry was not found");
  return b;
}

function assertUntouched(b: Batch, what: string) {
  if (consumedFrom(b) !== 0) throw new OpError(`${what}: is maal mein se ${consumedFrom(b)} aage nikal chuka hai, is liye yeh change nahi ho sakta`);
}

/** Sets a batch quantity. It can never go below what has already left the batch. */
async function setBatchQty(b: Batch, qty: number, what: string) {
  const used = consumedFrom(b);
  if (qty < used) throw new OpError(`${what}: ${used} pehle hi bik ya nikal chuke hain, quantity is se kam nahi ho sakti`);
  await db.batches.update(b.id!, { qty, remaining: qty - used, updatedAt: now() });
}

/**
 * Changes a batch unit cost and carries it to every invoice (and invoice return)
 * that used the batch. Refused when part of the batch went somewhere that does
 * not record its batch, because that cost could not be corrected.
 */
async function recostBatch(batchId: number, unitCost: number): Promise<void> {
  const batch = await getBatch(batchId);
  if (batch.unitCost === unitCost) return;
  const sales = (await db.sales.toArray()).filter((s) => s.lines.some((l) => l.allocs.some((a) => a.batchId === batchId)));
  const traced = sales.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.allocs.filter((a) => a.batchId === batchId).reduce((k, a) => k + a.qty, 0), 0), 0);
  if (traced !== consumedFrom(batch)) throw new OpError("Is maal ka kuch hissa purchase return, transfer ya adjustment mein gaya hai, is liye cost change nahi ho sakti. Pehle woh return theek ya cancel karein.");
  await db.batches.update(batchId, { unitCost, updatedAt: now() });
  for (const sale of sales) {
    const changed: SaleLine[] = [];
    for (const line of sale.lines) {
      if (!line.allocs.some((a) => a.batchId === batchId)) continue;
      line.allocs = line.allocs.map((a) => (a.batchId === batchId ? { ...a, unitCost } : a));
      line.cogs = allocCost(line.allocs);
      changed.push(line);
    }
    await db.sales.update(sale.id!, { lines: sale.lines, updatedAt: now() });
    const rows = await db.ledger.where("refId").equals(sale.id!).and((r) => r.refType === "sale" && r.type === "sale").toArray();
    for (const line of changed) {
      const row = rows.find((r) => r.itemId === line.itemId);
      if (row) await db.ledger.update(row.id!, { cost: line.cogs, updatedAt: now() });
      await recostSaleReturns(sale.id!, line);
    }
  }
}

/** The ledger note of a sale return names the batch that took the stock back. */
async function saleReturnRows(saleId: number) {
  const rows = await db.ledger.where("refId").equals(saleId).and((r) => r.refType === "sale" && r.type === "sale_return").sortBy("id");
  return rows.map((row) => ({ row, batchId: Number(/\(batch (\d+)\)$/.exec(row.note ?? "")?.[1] ?? 0) }));
}

/** Ledger rows and batches that belong to one sale return, in line order. */
async function rowsOfReturn(returnId: number) {
  const ret = await db.saleReturns.get(returnId);
  if (!ret) throw new OpError("Return not found");
  const all = await saleReturnRows(ret.saleId);
  const earlier = (await db.saleReturns.where("saleId").equals(ret.saleId).sortBy("id")).filter((r) => r.id! < returnId);
  const offset = earlier.reduce((n, r) => n + r.lines.length, 0);
  const mine = all.slice(offset, offset + ret.lines.length);
  if (mine.length !== ret.lines.length || mine.some((m, i) => !m.batchId || m.row.itemId !== ret.lines[i]!.itemId)) {
    throw new OpError("Is return ka stock record match nahi hua, is liye automatic correction nahi ho sakti");
  }
  return { ret, mine };
}

async function recostSaleReturns(saleId: number, line: SaleLine) {
  for (const r of await db.saleReturns.where("saleId").equals(saleId).sortBy("id")) {
    if (!r.lines.some((l) => l.itemId === line.itemId)) continue;
    const { ret, mine } = await rowsOfReturn(r.id!);
    for (const [i, rl] of ret.lines.entries()) {
      if (rl.itemId !== line.itemId) continue;
      const unitCost = Math.round(Math.round((line.cogs * rl.qty) / line.qty) / rl.qty);
      rl.cogs = unitCost * rl.qty;
      await db.ledger.update(mine[i]!.row.id!, { cost: rl.cogs, updatedAt: now() });
      await recostBatch(mine[i]!.batchId, unitCost);
    }
    await db.saleReturns.update(ret.id!, { lines: ret.lines, updatedAt: now() });
  }
}

// ---------- Sale invoice ----------
export interface SaleCorrection {
  lines: CartLine[]; discount: number; customerId?: number | undefined; paid: number;
  method: PayMethod; date: number; notes?: string | undefined;
}

export async function correctSale(saleId: number, p: SaleCorrection) {
  if (p.lines.length === 0) throw new OpError("Invoice mein kam az kam ek item hona chahiye");
  if (new Set(p.lines.map((l) => l.itemId)).size !== p.lines.length) throw new OpError("Ek item invoice mein do dafa nahi ho sakta");
  for (const l of p.lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw new OpError("Quantities must be positive whole numbers");
    if (!isMoney(l.price) || !isMoney(l.discount) || l.discount > l.qty * l.price) throw new OpError("Invalid price or line discount");
  }
  const settings = await getSettings();
  return db.transaction("rw", ALL(), async () => {
    const sale = await db.sales.get(saleId);
    if (!sale || sale.status !== "posted") throw new OpError("Invoice not found");
    const before = snapshot(sale);
    const { subtotal, tax, total } = computeInvoice(p.lines, p.discount, sale.taxPct);
    if (!isMoney(p.discount) || p.discount > subtotal) throw new OpError("Invalid invoice discount");
    if (!isMoney(p.paid)) throw new OpError("Paid amount is not valid");
    if (p.paid > total) throw new OpError("Paid amount exceeds total");
    if (p.paid < total && !p.customerId) throw new OpError("Select a customer for credit/partial payment");

    const returns = await db.saleReturns.where("saleId").equals(saleId).toArray();
    if (returns.length) {
      const key = (l: CartLine) => `${l.itemId}:${l.qty}:${l.price}:${l.discount}`;
      const same = sale.lines.map(key).sort().join() === p.lines.map(key).sort().join();
      if (!same || p.discount !== sale.discount || p.customerId !== sale.customerId) {
        throw new OpError("Is invoice par return mojood hai. Items, rate, discount ya customer badalne ke liye pehle return cancel karein.");
      }
      if (returns.some((r) => r.date < p.date)) throw new OpError("Invoice ki date return ki date ke baad nahi ho sakti");
    }

    // A line whose item and quantity are unchanged keeps its FIFO cost.
    const keeps = (old: SaleLine) => p.lines.some((l) => l.itemId === old.itemId && l.qty === old.qty);
    for (const old of sale.lines.filter((l) => !keeps(l))) {
      for (const a of old.allocs) {
        if (a.batchId == null) continue;
        const b = await getBatch(a.batchId);
        await db.batches.update(b.id!, { remaining: b.remaining + a.qty, updatedAt: now() });
      }
    }
    const oldRows = await db.ledger.where("refId").equals(saleId).and((r) => r.refType === "sale" && r.type === "sale").primaryKeys();
    await db.ledger.bulkDelete(oldRows);

    const lines: SaleLine[] = [];
    for (const l of p.lines) {
      const old = sale.lines.find((x) => x.itemId === l.itemId);
      if (old && old.qty === l.qty) {
        lines.push({ ...old, price: l.price, discount: l.discount });
        continue;
      }
      const item = await db.items.get(l.itemId);
      if (!item) throw new OpError("Item not found");
      const onHand = await stockQty(l.itemId, sale.locationId);
      if (!settings.allowNegativeStock && onHand < l.qty) throw new OpError(`Not enough stock for ${item.name}: ${onHand} available`);
      const used = (old?.allocs ?? []).flatMap((a: Alloc) => (a.batchId == null ? [] : [a.batchId]));
      const allocs = await consumeFIFO(l.itemId, sale.locationId, l.qty, settings.allowNegativeStock, item.cost, used);
      lines.push({ itemId: l.itemId, name: item.name, sku: item.sku, qty: l.qty, price: l.price, discount: l.discount, cogs: allocCost(allocs), allocs, returnedQty: 0 });
    }

    const cust = p.customerId ? await db.customers.get(p.customerId) : undefined;
    const updated = {
      ...sale, lines, subtotal, discount: p.discount, tax, total, paid: p.paid,
      method: p.paid === 0 ? ("credit" as const) : p.method, date: p.date, notes: p.notes,
      customerId: p.customerId, customerName: cust?.name ?? "Walk-in customer", updatedAt: now(),
    };
    await db.sales.put(updated);
    for (const l of lines) await addLedger({ itemId: l.itemId, locationId: sale.locationId, type: "sale", qty: -l.qty, cost: l.cogs, date: p.date, refType: "sale", refId: saleId, note: sale.invoiceNo });
    await logCorrection("sale", saleId, before, updated);
  });
}

// ---------- Purchase bill ----------
export interface PurchaseCorrection {
  billNo: string; supplierId: number; date: number; paid: number; method: PayMethod; discount: number; notes?: string | undefined;
  /** batchId identifies an existing line; leave it out for a line that was missed. */
  lines: { batchId?: number | undefined; itemId: number; qty: number; unitCost: number; discount: number }[];
}

export async function correctPurchase(purchaseId: number, p: PurchaseCorrection) {
  if (!p.supplierId) throw new OpError("Select a supplier");
  if (p.lines.length === 0) throw new OpError("Bill mein kam az kam ek item hona chahiye");
  for (const l of p.lines) if (!Number.isInteger(l.qty) || l.qty <= 0 || !isMoney(l.unitCost) || !isMoney(l.discount) || l.discount > l.qty * l.unitCost) throw new OpError("Invalid line quantity/cost/discount");
  const subtotal = p.lines.reduce((s, l) => s + l.qty * l.unitCost - l.discount, 0);
  if (!isMoney(p.discount) || p.discount > subtotal) throw new OpError("Invalid bill discount");
  const total = subtotal - p.discount;
  if (!isMoney(p.paid) || p.paid > total) throw new OpError("Paid must be between 0 and total");

  return db.transaction("rw", ALL(), async () => {
    const pur = await db.purchases.get(purchaseId);
    if (!pur) throw new OpError("Purchase not found");
    const before = snapshot(pur);
    const returns = await db.purchaseReturns.where("purchaseId").equals(purchaseId).toArray();
    if (returns.length) {
      const key = (l: PurchaseCorrection["lines"][number]) => `${l.batchId}:${l.itemId}:${l.qty}:${l.unitCost}:${l.discount}`;
      const same = pur.lines.map(key).sort().join() === p.lines.map(key).sort().join();
      if (!same || p.discount !== pur.discount || p.supplierId !== pur.supplierId) {
        throw new OpError("Is bill par return mojood hai. Items, cost, discount ya supplier badalne ke liye pehle return cancel karein.");
      }
      if (returns.some((r) => r.date < p.date)) throw new OpError("Bill ki date return ki date ke baad nahi ho sakti");
    }

    // The same effective unit cost rule as postPurchase.
    const effective = (l: { qty: number; unitCost: number; discount: number }, sub: number, billDiscount: number) => {
      const net = l.qty * l.unitCost - l.discount;
      const share = sub > 0 ? net - Math.round((billDiscount * net) / sub) : 0;
      return Math.round(share / l.qty);
    };

    for (const old of pur.lines.filter((o) => !p.lines.some((l) => l.batchId === o.batchId))) {
      const b = await getBatch(old.batchId!);
      assertUntouched(b, `${old.name} ko bill se nikalna`);
      await db.batches.delete(b.id!);
    }

    const lines: PurchaseLine[] = [];
    const costChanges: { itemId: number; from: number | null; to: number }[] = [];
    for (const l of p.lines) {
      const item = await db.items.get(l.itemId);
      if (!item) throw new OpError("Item not found");
      const unitCost = effective(l, subtotal, p.discount);
      const old = l.batchId ? pur.lines.find((o) => o.batchId === l.batchId) : undefined;
      if (l.batchId && !old) throw new OpError("Line does not belong to this bill");
      let batchId = old?.batchId;
      if (batchId) {
        let b = await getBatch(batchId);
        if (old!.itemId !== l.itemId) {
          assertUntouched(b, `${old!.name} ko doosre item se badalna`);
          await db.batches.update(batchId, { itemId: l.itemId, updatedAt: now() });
          b = await getBatch(batchId);
        }
        await setBatchQty(b, l.qty, item.name);
        await db.batches.update(batchId, { date: p.date, supplierId: p.supplierId });
        costChanges.push({ itemId: l.itemId, from: b.unitCost, to: unitCost });
        await recostBatch(batchId, unitCost);
      } else {
        batchId = await addBatch({ itemId: l.itemId, locationId: pur.locationId, qty: l.qty, unitCost, date: p.date, supplierId: p.supplierId, source: "purchase", refId: purchaseId });
        costChanges.push({ itemId: l.itemId, from: null, to: unitCost });
      }
      lines.push({ itemId: l.itemId, name: item.name, qty: l.qty, unitCost: l.unitCost, discount: l.discount, batchId, returnedQty: old?.returnedQty ?? 0 });
    }

    const oldRows = await db.ledger.where("refId").equals(purchaseId).and((r) => r.refType === "purchase" && r.type === "purchase").primaryKeys();
    await db.ledger.bulkDelete(oldRows);
    for (const line of lines) {
      const b = await getBatch(line.batchId!);
      await addLedger({ itemId: line.itemId, locationId: pur.locationId, type: "purchase", qty: line.qty, cost: b.unitCost * line.qty, date: p.date, refType: "purchase", refId: purchaseId, note: p.billNo });
    }
    // The item's default cost follows only if it still holds the value this bill set.
    for (const c of costChanges) {
      const item = await db.items.get(c.itemId);
      if (item && c.from !== c.to && (c.from === null || item.cost === c.from)) {
        const newer = await db.batches.where("itemId").equals(c.itemId).and((b) => b.source === "purchase" && b.refId! > purchaseId).count();
        if (!newer) await db.items.update(c.itemId, { cost: c.to, updatedAt: now() });
      }
    }
    const updated = { ...pur, billNo: p.billNo, supplierId: p.supplierId, date: p.date, lines, subtotal, discount: p.discount, total, paid: p.paid, method: p.paid === 0 ? ("credit" as const) : p.method, notes: p.notes, updatedAt: now() };
    await db.purchases.put(updated);
    await logCorrection("purchase", purchaseId, before, updated);
  });
}

// ---------- Returns ----------
export interface ReturnCorrection { qtys: number[]; refundCash: number }

/** Corrects returned quantities and refund. All quantities zero cancels the return. */
export async function correctSaleReturn(returnId: number, p: ReturnCorrection & { method: PayMethod }) {
  return db.transaction("rw", ALL(), async () => {
    const { ret, mine } = await rowsOfReturn(returnId);
    const sale = await db.sales.get(ret.saleId);
    if (!sale) throw new OpError("Invoice not found");
    if (p.qtys.length !== ret.lines.length || p.qtys.some((q) => !Number.isInteger(q) || q < 0)) throw new OpError("Invalid quantity");
    const cancel = p.qtys.every((q) => q === 0);
    if (!cancel && p.qtys.some((q) => q === 0)) throw new OpError("Ek line zero nahi ho sakti. Poora return cancel karne ke liye sab quantities zero karein.");
    const before = snapshot(ret);
    const ratio = sale.subtotal > 0 ? (sale.subtotal - sale.discount) / sale.subtotal : 0;
    const lines = [...ret.lines];
    for (const [i, old] of ret.lines.entries()) {
      const qty = p.qtys[i]!;
      const line = sale.lines.find((l) => l.itemId === old.itemId);
      if (!line) throw new OpError("Item not on invoice");
      const returned = line.returnedQty - old.qty + qty;
      if (returned > line.qty) throw new OpError(`Cannot return more than sold for ${line.name}`);
      line.returnedQty = returned;
      const batch = await getBatch(mine[i]!.batchId);
      if (cancel) {
        assertUntouched(batch, `${old.name} ka return cancel karna`);
        await db.batches.delete(batch.id!);
        await db.ledger.delete(mine[i]!.row.id!);
        continue;
      }
      if (qty === old.qty) continue;
      await setBatchQty(batch, qty, old.name);
      const amount = Math.round((((line.qty * line.price - line.discount) * qty) / line.qty) * ratio * (1 + sale.taxPct / 100));
      const unitCost = Math.round(Math.round((line.cogs * qty) / line.qty) / qty);
      await recostBatch(batch.id!, unitCost);
      await db.ledger.update(mine[i]!.row.id!, { qty, cost: unitCost * qty, updatedAt: now() });
      lines[i] = { ...old, qty, amount, cogs: unitCost * qty };
    }
    await db.sales.update(sale.id!, { lines: sale.lines, updatedAt: now() });
    if (cancel) {
      await db.saleReturns.delete(returnId);
      await logCorrection("saleReturn", returnId, before, null);
      return;
    }
    const amount = lines.reduce((s, l) => s + l.amount, 0);
    if (!isMoney(p.refundCash) || p.refundCash > amount) throw new OpError("Refund must be between 0 and the return value");
    if (amount - p.refundCash > 0 && !sale.customerId) throw new OpError("Walk-in returns must be fully refunded");
    const updated = { ...ret, lines, amount, refundCash: p.refundCash, creditAmount: amount - p.refundCash, method: p.method, updatedAt: now() };
    await db.saleReturns.put(updated);
    await logCorrection("saleReturn", returnId, before, updated);
  });
}

export async function correctPurchaseReturn(returnId: number, p: ReturnCorrection) {
  return db.transaction("rw", ALL(), async () => {
    const ret = await db.purchaseReturns.get(returnId);
    if (!ret) throw new OpError("Return not found");
    const pur = await db.purchases.get(ret.purchaseId);
    if (!pur) throw new OpError("Purchase not found");
    if (p.qtys.length !== ret.lines.length || p.qtys.some((q) => !Number.isInteger(q) || q < 0)) throw new OpError("Invalid quantity");
    const cancel = p.qtys.every((q) => q === 0);
    if (!cancel && p.qtys.some((q) => q === 0)) throw new OpError("Ek line zero nahi ho sakti. Poora return cancel karne ke liye sab quantities zero karein.");
    const before = snapshot(ret);
    const ratio = pur.subtotal > 0 ? pur.total / pur.subtotal : 0;
    const rows = await db.ledger.where("refId").equals(pur.id!).and((r) => r.refType === "purchase" && r.type === "purchase_return").sortBy("id");
    const earlier = (await db.purchaseReturns.where("purchaseId").equals(pur.id!).sortBy("id")).filter((r) => r.id! < returnId);
    const offset = earlier.reduce((n, r) => n + r.lines.length, 0);
    const lines = [...ret.lines];
    for (const [i, old] of ret.lines.entries()) {
      const qty = p.qtys[i]!;
      const row = rows[offset + i];
      if (!row || row.itemId !== old.itemId) throw new OpError("Is return ka stock record match nahi hua");
      const line = pur.lines.find((l) => l.itemId === old.itemId);
      if (!line) throw new OpError("Item not on bill");
      const returned = line.returnedQty - old.qty + qty;
      if (returned > line.qty) throw new OpError(`Cannot return more than purchased for ${line.name}`);
      line.returnedQty = returned;
      if (qty === old.qty) continue;
      if (!old.allocs) throw new OpError("Yeh purana return hai: is ki quantity automatic theek nahi ho sakti, sirf refund theek ho sakta hai");
      for (const a of old.allocs) {
        if (a.batchId == null) continue;
        const b = await getBatch(a.batchId);
        await db.batches.update(b.id!, { remaining: b.remaining + a.qty, updatedAt: now() });
      }
      if (qty === 0) { await db.ledger.delete(row.id!); continue; }
      if ((await stockQty(old.itemId, pur.locationId)) + old.qty < qty) throw new OpError(`Not enough stock for ${old.name}`);
      const item = await db.items.get(old.itemId);
      const allocs = await consumeFIFO(old.itemId, pur.locationId, qty, false, item?.cost ?? 0, line.batchId ? [line.batchId] : []);
      const cost = allocCost(allocs);
      const amount = Math.round((((line.qty * line.unitCost - line.discount) * qty) / line.qty) * ratio);
      await db.ledger.update(row.id!, { qty: -qty, cost, updatedAt: now() });
      lines[i] = { ...old, qty, amount, cost, allocs };
    }
    await db.purchases.update(pur.id!, { lines: pur.lines, updatedAt: now() });
    if (cancel) {
      await db.purchaseReturns.delete(returnId);
      await logCorrection("purchaseReturn", returnId, before, null);
      return;
    }
    const amount = lines.reduce((s, l) => s + l.amount, 0);
    if (!isMoney(p.refundCash) || p.refundCash > amount) throw new OpError("Refund must be between 0 and return value");
    const updated = { ...ret, lines, amount, refundCash: p.refundCash, creditAmount: amount - p.refundCash, updatedAt: now() };
    await db.purchaseReturns.put(updated);
    await logCorrection("purchaseReturn", returnId, before, updated);
  });
}

// ---------- Item and opening stock ----------
export interface ItemCorrection {
  name: string; sku: string; cost: number; price: number; reorderLevel: number;
  openingQty: number; openingCost: number;
}

export async function openingBatch(itemId: number): Promise<Batch | undefined> {
  return db.batches.where("itemId").equals(itemId).and((b) => b.source === "opening").first();
}

export async function correctItem(itemId: number, p: ItemCorrection) {
  const name = p.name.trim(), sku = p.sku.trim();
  if (!name) throw new OpError("Part name is required");
  if (!sku) throw new OpError("SKU is required");
  if (!isMoney(p.cost) || !isMoney(p.price) || !isMoney(p.openingCost)) throw new OpError("Prices are not valid");
  if (!Number.isInteger(p.reorderLevel) || p.reorderLevel < 0 || !Number.isInteger(p.openingQty) || p.openingQty < 0) throw new OpError("Quantities must be whole numbers");
  return db.transaction("rw", ALL(), async () => {
    const item = await db.items.get(itemId);
    if (!item) throw new OpError("Item not found");
    const dup = await db.items.where("sku").equals(sku).first();
    if (dup && dup.id !== itemId) throw new OpError(`SKU "${sku}" already exists`);
    const opening = await openingBatch(itemId);
    const before = { ...snapshot(item), openingQty: opening?.qty ?? 0, openingCost: opening?.unitCost ?? 0 };
    const fields: Partial<Item> = { name, sku, cost: p.cost, price: p.price, reorderLevel: p.reorderLevel, updatedAt: now() };
    await db.items.update(itemId, fields);

    if (opening) {
      const rows = await db.ledger.where("refId").equals(opening.id!).and((r) => r.refType === "batch" && r.type === "opening").toArray();
      if (p.openingQty === 0) {
        assertUntouched(opening, "Opening stock hatana");
        await db.batches.delete(opening.id!);
        await db.ledger.bulkDelete(rows.map((r) => r.id!));
      } else {
        await setBatchQty(opening, p.openingQty, "Opening stock");
        await recostBatch(opening.id!, p.openingCost);
        for (const r of rows) await db.ledger.update(r.id!, { qty: p.openingQty, cost: p.openingQty * p.openingCost, updatedAt: now() });
      }
    } else if (p.openingQty > 0) {
      const locationId = item.locationId ?? (await db.locations.toCollection().first())!.id!;
      const date = item.createdAt;
      const bid = await addBatch({ itemId, locationId, qty: p.openingQty, unitCost: p.openingCost, date, source: "opening", supplierId: item.supplierId });
      await db.ledger.add(stamp({ itemId, locationId, type: "opening" as const, qty: p.openingQty, cost: p.openingQty * p.openingCost, date, refType: "batch", refId: bid, note: "Opening balance" }));
    }

    // Saved invoices keep a copy of the name and SKU; a spelling fix reaches them too.
    if (name !== item.name || sku !== item.sku) {
      await db.sales.toCollection().modify((s) => { for (const l of s.lines) if (l.itemId === itemId) { l.name = name; l.sku = sku; } });
      for (const table of ["saleReturns", "purchases", "purchaseReturns"]) {
        await db.table(table).toCollection().modify((r: { lines: { itemId: number; name: string }[] }) => { for (const l of r.lines) if (l.itemId === itemId) l.name = name; });
      }
    }
    await logCorrection("item", itemId, before, p);
  });
}

// ---------- Customers, suppliers, payments, expenses ----------
export async function correctParty(kind: "customers" | "suppliers", id: number, p: { name: string; phone?: string; address?: string }) {
  const name = p.name.trim();
  if (!name) throw new OpError("Name is required");
  return db.transaction("rw", ALL(), async () => {
    const old = await db[kind].get(id);
    if (!old) throw new OpError("Record not found");
    await db[kind].update(id, { ...p, name, updatedAt: now() });
    if (kind === "customers") await db.sales.where("customerId").equals(id).modify({ customerName: name });
    await logCorrection(kind, id, old, { ...p, name });
  });
}

export async function correctPayment(id: number, p: { partyId: number; amount: number; method: PayMethod; date: number; note?: string }) {
  if (!isMoney(p.amount) || p.amount === 0) throw new OpError("Amount must be greater than zero");
  if (p.method === "credit") throw new OpError("Choose how the money was paid");
  return db.transaction("rw", ALL(), async () => {
    const old = await db.payments.get(id);
    if (!old) throw new OpError("Payment not found");
    const party = await db[old.partyType === "customer" ? "customers" : "suppliers"].get(p.partyId);
    if (!party) throw new OpError("Customer/supplier not found");
    const updated = { ...old, ...p, updatedAt: now() };
    await db.payments.put(updated);
    await logCorrection("payment", id, old, updated);
  });
}

export async function correctExpense(id: number, p: Pick<Expense, "date" | "category" | "amount" | "method" | "payee">) {
  if (!isMoney(p.amount) || p.amount === 0) throw new OpError("Amount must be greater than zero");
  if (!p.category.trim()) throw new OpError("Category is required");
  return db.transaction("rw", ALL(), async () => {
    const old = await db.expenses.get(id);
    if (!old) throw new OpError("Expense not found");
    const updated = { ...old, ...p, updatedAt: now() };
    await db.expenses.put(updated);
    await logCorrection("expense", id, old, updated);
  });
}
