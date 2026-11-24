#!/usr/bin/env python3
from pathlib import Path
import re
p = Path("src/routes/index.tsx")
t = p.read_text()
if "ui-dialogs" not in t:
    needle = 'import { getSettings } from "../lib/settings";\n'
    ins = needle + 'import { askText, askConfirm, printHtml } from "@/lib/ui-dialogs";\n'
    if needle not in t:
        raise SystemExit("settings import not found")
    t = t.replace(needle, ins, 1)

t = t.replace(
    '  const ask = (s: string, d = "") => window.prompt(s, d);',
    '  const ask = async (s: string, d = ""): Promise<string | null> => askText(s, d);',
    1,
)

old_print = (
    '    const w = window.open("", "_blank", "width=480,height=760");\n'
    '    if (!w) { setMsg("Allow pop-ups to print the receipt."); return; }\n'
    '    w.document.open();\n'
    '    w.document.write(html);\n'
    '    w.document.close();\n'
    '    setTimeout(() => { w.focus(); w.print(); }, 300);'
)
new_print = (
    '    try {\n'
    '      printHtml(html);\n'
    '    } catch (e) {\n'
    '      setMsg(e instanceof Error ? e.message : "Could not open print preview.");\n'
    '    }'
)
if old_print not in t:
    raise SystemExit("print block missing")
t = t.replace(old_print, new_print, 1)

pat = (
    r'onClick=\{\(\) => \{ if \(!window\.confirm\("Drive backup will replace all records on this device\. '
    r'Download a local backup first\. Continue\?"\)\) return; void \(async \(\) => \{'
)
repl = 'onClick={() => { void (async () => { if (!(await askConfirm("Drive backup will replace all records on this device. Download a local backup first. Continue?"))) return; '
t2, n = re.subn(pat, repl, t, count=1)
if n != 1:
    raise SystemExit(f"confirm replace count {n}")
t = t2

for name in ["doSaleReturn", "doPurchaseReturn", "addParty", "addExpense", "payment"]:
    t = t.replace(f"  function {name}", f"  async function {name}", 1)

lines = []
for l in t.splitlines(True):
    if "const ask =" in l or "askText" in l or "askConfirm" in l:
        lines.append(l)
        continue
    if "ask(" in l and "await ask(" not in l:
        l = l.replace("ask(", "await ask(")
    lines.append(l)
t = "".join(lines)

old_payee = 'void act(() => saveExpense({ date: Date.now(), category, amount, method, payee: await ask("Paid to", "") || "" }), "Expense saved.");'
new_payee = 'const payee = (await ask("Paid to", "")) || "";\n    void act(() => saveExpense({ date: Date.now(), category, amount, method, payee }), "Expense saved.");'
if old_payee not in t:
    raise SystemExit("payee block missing")
t = t.replace(old_payee, new_payee, 1)

t = t.replace(
    'onClick={() => { const name = await ask("Part name");',
    'onClick={() => { void (async () => { const name = await ask("Part name");',
    1,
)
t = t.replace(
    '}, "Item saved."); }}>Add item</button>}',
    '}, "Item saved."); })(); }}>Add item</button>}',
    1,
)

if "window.prompt" in t or "window.confirm" in t or "window.open" in t:
    raise SystemExit("browser APIs still present")
p.write_text(t)
print("patched", p, "len", len(t))
