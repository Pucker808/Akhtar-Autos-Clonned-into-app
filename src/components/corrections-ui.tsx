import { useEffect, useState } from "react";
import { db, type Expense, type Item, type Party, type PayMethod, type Purchase, type Sale } from "@/lib/db";
import {
  correctExpense, correctItem, correctParty, correctPayment, correctPurchase,
  correctPurchaseReturn, correctSale, correctSaleReturn, openingBatch,
} from "@/lib/corrections";
import { formatPKR, fromPaisa, toPaisa } from "@/lib/money";
import { fDate, fDateTime, msToPkDate, pkDateToMs, pkDayStart } from "@/lib/dates";

export type EntryKind =
  | "item" | "sale" | "purchase" | "saleReturn" | "purchaseReturn"
  | "customers" | "suppliers" | "payment" | "expense";

type Values = Record<string, string>;
interface Field { key: string; label: string; type?: "text" | "date" | "select"; options?: [string, string][] }
interface Column extends Field { width?: string }
interface Form {
  title: string;
  note?: string;
  fields: Field[];
  values: Values;
  lines?: { columns: Column[]; rows: Values[]; blank?: Values };
  save: (values: Values, rows: Values[]) => Promise<unknown>;
}

const METHOD_OPTIONS: [string, string][] = ["cash", "bank", "easypaisa", "jazzcash"].map((m) => [m, m]);

function money(text: string | undefined, label: string): number {
  const v = toPaisa((text ?? "").trim() || "0");
  if (!Number.isInteger(v) || v < 0) throw new Error(`${label}: sahi raqam likhein`);
  return v;
}
function whole(text: string | undefined, label: string): number {
  const s = (text ?? "").trim();
  if (!/^\d+$/.test(s)) throw new Error(`${label}: poora number likhein`);
  return Number(s);
}
/** Keeps the original time of day; an unchanged date stays exactly as saved. */
function dateValue(text: string | undefined, original: number): number {
  if (!text) throw new Error("Date likhein");
  return text === msToPkDate(original) ? original : pkDateToMs(text) + (original - pkDayStart(original));
}

function partyOptions(rows: Party[]): [string, string][] {
  return rows.map((p) => [String(p.id), p.name]);
}
async function itemOptions(): Promise<[string, string][]> {
  return (await db.items.toArray()).map((i: Item) => [String(i.id), `${i.name} (${i.sku})`]);
}

async function saleForm(s: Sale): Promise<Form> {
  const customers = await db.customers.toArray();
  return {
    title: `Invoice ${s.invoiceNo}`,
    fields: [
      { key: "date", label: "Date", type: "date" },
      { key: "customer", label: "Customer", type: "select", options: [["", "Walk-in customer"], ...partyOptions(customers)] },
      { key: "discount", label: "Discount Rs" },
      { key: "paid", label: "Paid Rs" },
      { key: "method", label: "Method", type: "select", options: METHOD_OPTIONS },
    ],
    values: {
      date: msToPkDate(s.date), customer: String(s.customerId ?? ""), discount: fromPaisa(s.discount),
      paid: fromPaisa(s.paid), method: s.method === "credit" ? "cash" : s.method,
    },
    lines: {
      columns: [
        { key: "item", label: "Item", type: "select", options: await itemOptions(), width: "min-w-52" },
        { key: "qty", label: "Qty", width: "w-20" },
        { key: "price", label: "Rate Rs", width: "w-28" },
        { key: "discount", label: "Line discount Rs", width: "w-28" },
      ],
      rows: s.lines.map((l) => ({ item: String(l.itemId), qty: String(l.qty), price: fromPaisa(l.price), discount: fromPaisa(l.discount) })),
      blank: { item: "", qty: "1", price: "0", discount: "0" },
    },
    save: (v, rows) => correctSale(s.id!, {
      date: dateValue(v["date"], s.date),
      customerId: v["customer"] ? Number(v["customer"]) : undefined,
      discount: money(v["discount"], "Discount"),
      paid: money(v["paid"], "Paid"),
      method: v["method"] as PayMethod,
      notes: s.notes,
      lines: rows.map((r) => {
        if (!r["item"]) throw new Error("Har line mein item select karein");
        return { itemId: Number(r["item"]), qty: whole(r["qty"], "Qty"), price: money(r["price"], "Rate"), discount: money(r["discount"], "Line discount") };
      }),
    }),
  };
}

async function purchaseForm(p: Purchase): Promise<Form> {
  const suppliers = await db.suppliers.toArray();
  return {
    title: `Purchase bill ${p.billNo}`,
    fields: [
      { key: "billNo", label: "Bill no." },
      { key: "date", label: "Date", type: "date" },
      { key: "supplier", label: "Supplier", type: "select", options: partyOptions(suppliers) },
      { key: "discount", label: "Bill discount Rs" },
      { key: "paid", label: "Paid Rs" },
      { key: "method", label: "Method", type: "select", options: METHOD_OPTIONS },
    ],
    values: {
      billNo: p.billNo, date: msToPkDate(p.date), supplier: String(p.supplierId), discount: fromPaisa(p.discount),
      paid: fromPaisa(p.paid), method: p.method === "credit" ? "cash" : p.method,
    },
    lines: {
      columns: [
        { key: "item", label: "Item", type: "select", options: await itemOptions(), width: "min-w-52" },
        { key: "qty", label: "Qty", width: "w-20" },
        { key: "unitCost", label: "Cost Rs", width: "w-28" },
        { key: "discount", label: "Line discount Rs", width: "w-28" },
      ],
      rows: p.lines.map((l) => ({ batchId: String(l.batchId ?? ""), item: String(l.itemId), qty: String(l.qty), unitCost: fromPaisa(l.unitCost), discount: fromPaisa(l.discount) })),
      blank: { batchId: "", item: "", qty: "1", unitCost: "0", discount: "0" },
    },
    save: (v, rows) => correctPurchase(p.id!, {
      billNo: (v["billNo"] ?? "").trim() || p.billNo,
      date: dateValue(v["date"], p.date),
      supplierId: Number(v["supplier"]),
      discount: money(v["discount"], "Bill discount"),
      paid: money(v["paid"], "Paid"),
      method: v["method"] as PayMethod,
      notes: p.notes,
      lines: rows.map((r) => {
        if (!r["item"]) throw new Error("Har line mein item select karein");
        return { batchId: r["batchId"] ? Number(r["batchId"]) : undefined, itemId: Number(r["item"]), qty: whole(r["qty"], "Qty"), unitCost: money(r["unitCost"], "Cost"), discount: money(r["discount"], "Line discount") };
      }),
    }),
  };
}

function returnForm(
  title: string,
  ret: { lines: { name: string; qty: number }[]; refundCash: number },
  extra: { fields: Field[]; values: Values },
  save: (qtys: number[], refundCash: number, values: Values) => Promise<unknown>,
): Form {
  const values: Values = { refund: fromPaisa(ret.refundCash), ...extra.values };
  ret.lines.forEach((l, i) => (values[`q${i}`] = String(l.qty)));
  return {
    title,
    note: "Poora return cancel karne ke liye sab quantities 0 karein.",
    fields: [
      ...ret.lines.map((l, i) => ({ key: `q${i}`, label: `Returned qty: ${l.name}` })),
      { key: "refund", label: "Cash refund Rs" },
      ...extra.fields,
    ],
    values,
    save: (v) => save(ret.lines.map((_, i) => whole(v[`q${i}`], "Qty")), money(v["refund"], "Refund"), v),
  };
}

async function loadForm(kind: EntryKind, id: number): Promise<Form> {
  const need = <T,>(v: T | undefined): T => {
    if (!v) throw new Error("Entry nahi mili");
    return v;
  };
  switch (kind) {
    case "sale": return saleForm(need(await db.sales.get(id)));
    case "purchase": return purchaseForm(need(await db.purchases.get(id)));
    case "item": {
      const i = need(await db.items.get(id));
      const o = await openingBatch(id);
      return {
        title: `Item ${i.name}`,
        fields: [
          { key: "name", label: "Part name" }, { key: "sku", label: "SKU / code" },
          { key: "cost", label: "Purchase cost Rs" }, { key: "price", label: "Selling price Rs" },
          { key: "reorder", label: "Low stock level" },
          { key: "openingQty", label: "Opening quantity" }, { key: "openingCost", label: "Opening stock cost Rs" },
        ],
        values: {
          name: i.name, sku: i.sku, cost: fromPaisa(i.cost), price: fromPaisa(i.price), reorder: String(i.reorderLevel),
          openingQty: String(o?.qty ?? 0), openingCost: fromPaisa(o?.unitCost ?? i.cost),
        },
        save: (v) => correctItem(id, {
          name: v["name"] ?? "", sku: v["sku"] ?? "", cost: money(v["cost"], "Cost"), price: money(v["price"], "Price"),
          reorderLevel: whole(v["reorder"], "Low stock level"), openingQty: whole(v["openingQty"], "Opening quantity"),
          openingCost: money(v["openingCost"], "Opening cost"),
        }),
      };
    }
    case "customers":
    case "suppliers": {
      const p = need(await db[kind].get(id));
      return {
        title: p.name,
        fields: [{ key: "name", label: "Name" }, { key: "phone", label: "Phone" }, { key: "address", label: "Address" }],
        values: { name: p.name, phone: p.phone ?? "", address: p.address ?? "" },
        save: (v) => correctParty(kind, id, { name: v["name"] ?? "", phone: v["phone"] ?? "", address: v["address"] ?? "" }),
      };
    }
    case "payment": {
      const p = need(await db.payments.get(id));
      const parties = await db[p.partyType === "customer" ? "customers" : "suppliers"].toArray();
      return {
        title: "Payment",
        fields: [
          { key: "party", label: p.partyType, type: "select", options: partyOptions(parties) },
          { key: "amount", label: "Amount Rs" },
          { key: "method", label: "Method", type: "select", options: METHOD_OPTIONS },
          { key: "date", label: "Date", type: "date" },
        ],
        values: { party: String(p.partyId), amount: fromPaisa(p.amount), method: p.method, date: msToPkDate(p.date) },
        save: (v) => correctPayment(id, { partyId: Number(v["party"]), amount: money(v["amount"], "Amount"), method: v["method"] as PayMethod, date: dateValue(v["date"], p.date), ...(p.note !== undefined ? { note: p.note } : {}) }),
      };
    }
    case "expense": {
      const e: Expense = need(await db.expenses.get(id));
      return {
        title: "Expense",
        fields: [
          { key: "category", label: "Category" }, { key: "payee", label: "Paid to" }, { key: "amount", label: "Amount Rs" },
          { key: "method", label: "Method", type: "select", options: METHOD_OPTIONS }, { key: "date", label: "Date", type: "date" },
        ],
        values: { category: e.category, payee: e.payee ?? "", amount: fromPaisa(e.amount), method: e.method, date: msToPkDate(e.date) },
        save: (v) => correctExpense(id, { category: v["category"] ?? "", payee: v["payee"] ?? "", amount: money(v["amount"], "Amount"), method: v["method"] as PayMethod, date: dateValue(v["date"], e.date) }),
      };
    }
    case "saleReturn": {
      const r = need(await db.saleReturns.get(id));
      return returnForm(`Sale return (${r.invoiceNo})`, r,
        { fields: [{ key: "method", label: "Refund method", type: "select", options: METHOD_OPTIONS }], values: { method: r.method === "credit" ? "cash" : r.method } },
        (qtys, refundCash, v) => correctSaleReturn(id, { qtys, refundCash, method: v["method"] as PayMethod }));
    }
    case "purchaseReturn": {
      const r = need(await db.purchaseReturns.get(id));
      return returnForm("Purchase return", r, { fields: [], values: {} },
        (qtys, refundCash) => correctPurchaseReturn(id, { qtys, refundCash }));
    }
  }
}

function Control({ field, value, onChange, label }: { field: Field; value: string; onChange: (v: string) => void; label: string }) {
  const style = "w-full rounded border bg-white p-2 text-sm text-slate-900";
  if (field.type === "select") {
    return (
      <select aria-label={label} className={style} value={value} onChange={(e) => onChange(e.target.value)}>
        {!field.options?.some(([v]) => v === value) && <option value={value}>Select...</option>}
        {field.options?.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    );
  }
  return <input aria-label={label} className={style} type={field.type === "date" ? "date" : "text"} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function Dialog({ form, onClose, onSaved }: { form: Form; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState(form.values);
  const [rows, setRows] = useState(form.lines?.rows ?? []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await form.save(values, rows);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const setCell = (index: number, key: string, v: string) =>
    setRows(rows.map((r, i) => (i === index ? { ...r, [key]: v } : r)));

  return (
    <div role="dialog" aria-label={`Edit: ${form.title}`} className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4">
      <div className="my-6 w-full max-w-3xl rounded-xl bg-white p-5 text-left text-slate-900 shadow-xl">
        <h2 className="text-lg font-bold">Edit: {form.title}</h2>
        <p className="mb-4 text-sm text-slate-600">Sirf ghalat value badlein, baqi waisa hi rehne dein. {form.note}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {form.fields.map((f) => (
            <label key={f.key} className="text-sm capitalize">{f.label}
              <Control field={f} label={f.label} value={values[f.key] ?? ""} onChange={(v) => setValues({ ...values, [f.key]: v })} />
            </label>
          ))}
        </div>
        {form.lines && (
          <div className="mt-4 space-y-2">
            {rows.map((row, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2 border-t pt-2">
                {form.lines!.columns.map((c) => (
                  <label key={c.key} className={`text-xs ${c.width ?? ""}`}>{c.label}
                    <Control field={c} label={`${c.label} ${index + 1}`} value={row[c.key] ?? ""} onChange={(v) => setCell(index, c.key, v)} />
                  </label>
                ))}
                <button className="p-2 text-sm text-red-600" onClick={() => setRows(rows.filter((_, i) => i !== index))}>Remove</button>
              </div>
            ))}
            {form.lines.blank && <button className="rounded border px-3 py-1.5 text-sm" onClick={() => setRows([...rows, { ...form.lines!.blank! }])}>+ Item line</button>}
          </div>
        )}
        {error && <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded border px-4 py-2" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="rounded bg-amber-500 px-4 py-2 font-bold disabled:opacity-40" disabled={busy} onClick={() => void submit()}>Save correction</button>
        </div>
      </div>
    </div>
  );
}

export function EditButton({ kind, id, onSaved }: { kind: EntryKind; id: number | undefined; onSaved: () => void }) {
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  if (id === undefined) return null;
  return (
    <>
      <button className="px-1 text-sm text-blue-700" onClick={() => { setError(""); loadForm(kind, id).then(setForm).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }}>Edit</button>
      {error && <span className="text-xs text-red-600">{error}</span>}
      {form && <Dialog form={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); onSaved(); }} />}
    </>
  );
}

interface Row { id: number; date: number; text: string; amount: number }
const LIST_TITLES = { payment: "Payments", saleReturn: "Sale returns", purchaseReturn: "Purchase returns" } as const;

async function listRows(kind: keyof typeof LIST_TITLES): Promise<Row[]> {
  const suppliers = new Map((await db.suppliers.toArray()).map((p) => [p.id, p.name]));
  if (kind === "payment") {
    const customers = new Map((await db.customers.toArray()).map((p) => [p.id, p.name]));
    return (await db.payments.orderBy("date").reverse().toArray()).map((p) => ({ id: p.id!, date: p.date, amount: p.amount, text: `${(p.partyType === "customer" ? customers : suppliers).get(p.partyId) ?? p.partyType} · ${p.method}` }));
  }
  if (kind === "saleReturn") {
    return (await db.saleReturns.orderBy("date").reverse().toArray()).map((r) => ({ id: r.id!, date: r.date, amount: r.amount, text: `${r.invoiceNo} · ${r.lines.map((l) => `${l.name} x ${l.qty}`).join(", ")}` }));
  }
  return (await db.purchaseReturns.orderBy("date").reverse().toArray()).map((r) => ({ id: r.id!, date: r.date, amount: r.amount, text: `${suppliers.get(r.supplierId) ?? "Supplier"} · ${r.lines.map((l) => `${l.name} x ${l.qty}`).join(", ")}` }));
}

/** Saved payments or returns, each with an Edit button. `version` triggers a reload. */
export function EntryList({ kind, version, onSaved }: { kind: keyof typeof LIST_TITLES; version: unknown; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { void listRows(kind).then(setRows); }, [kind, version]);
  return (
    <section className="app-card rounded-xl border bg-white p-5">
      <h2 className="mb-3 font-bold">{LIST_TITLES[kind]}</h2>
      {rows.length === 0 && <p className="text-sm text-slate-500">Abhi koi entry nahi.</p>}
      <div className="divide-y">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>{fDate(r.date)} · {r.text} · <b>{formatPKR(r.amount)}</b></span>
            <EditButton kind={kind} id={r.id} onSaved={onSaved} />
          </div>
        ))}
      </div>
    </section>
  );
}

const MONEY_KEYS = new Set(["cost", "price", "unitCost", "discount", "paid", "total", "subtotal", "tax", "amount", "refundCash", "creditAmount", "openingCost"]);
const SHOWN_KEYS: Record<string, string> = {
  name: "Name", sku: "SKU", billNo: "Bill no.", customerName: "Customer", phone: "Phone", address: "Address", category: "Category",
  payee: "Paid to", method: "Method", qty: "Qty", cost: "Cost", price: "Price", unitCost: "Unit cost", discount: "Discount",
  paid: "Paid", total: "Total", amount: "Amount", refundCash: "Cash refund", openingQty: "Opening qty", openingCost: "Opening cost",
  reorderLevel: "Low stock level", date: "Date",
};

/** "Field: old → new" for every visible value that differs. */
export function describeChanges(before: unknown, after: unknown, prefix = ""): string[] {
  if (after === null) return ["Cancel kiya gaya"];
  if (typeof before !== "object" || before === null || typeof after !== "object") return [];
  const out: string[] = [];
  for (const [key, now] of Object.entries(after as Record<string, unknown>)) {
    const old = (before as Record<string, unknown>)[key];
    if (key === "lines" && Array.isArray(old) && Array.isArray(now)) {
      for (let i = 0; i < Math.max(old.length, now.length); i++) {
        const line = (now[i] ?? old[i]) as { name?: string };
        if (!old[i]) out.push(`${line.name ?? "Item"}: line add hui`);
        else if (!now[i]) out.push(`${line.name ?? "Item"}: line hatayi gayi`);
        else out.push(...describeChanges(old[i], now[i], `${line.name ?? "Item"} · `));
      }
    } else if (SHOWN_KEYS[key] && old !== undefined && old !== now) {
      const show = (v: unknown) => (key === "date" ? fDate(v as number) : MONEY_KEYS.has(key) ? formatPKR(v as number) : String(v || "—"));
      out.push(`${prefix}${SHOWN_KEYS[key]}: ${show(old)} → ${show(now)}`);
    }
  }
  return out;
}

/** What was changed, when. Lets the owner check corrections made at the counter. */
export function CorrectionHistory({ version }: { version: unknown }) {
  const [rows, setRows] = useState<{ id: number; at: number; entity: string; changes: string[] }[]>([]);
  useEffect(() => {
    void db.audit.orderBy("at").reverse().filter((a) => a.action === "correct").limit(100).toArray().then((found) =>
      setRows(found.map((a) => {
        const { before, after } = JSON.parse(a.detail ?? "{}") as { before?: unknown; after?: unknown };
        return { id: a.id!, at: a.at, entity: a.entity, changes: describeChanges(before, after) };
      })));
  }, [version]);
  return (
    <section className="app-card rounded-xl border bg-white p-5">
      <h2 className="mb-3 font-bold">Correction history</h2>
      {rows.length === 0 && <p className="text-sm text-slate-500">Abhi koi correction nahi hui.</p>}
      <div className="divide-y">
        {rows.map((r) => (
          <div key={r.id} className="py-2 text-sm">
            <b className="capitalize">{r.entity}</b> · {fDateTime(r.at)}
            {r.changes.map((c, i) => <p key={i} className="text-slate-600">{c}</p>)}
          </div>
        ))}
      </div>
    </section>
  );
}
