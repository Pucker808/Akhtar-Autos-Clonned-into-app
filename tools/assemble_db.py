#!/usr/bin/env python3
from pathlib import Path
root = Path(__file__).resolve().parents[1]
parts = sorted(root.glob("tools/db.rs.part*"))
assert parts, "missing parts"
out = root / "src-tauri/src/db.rs"
out.write_text("".join(p.read_text() for p in parts))
print("wrote", out, "bytes", out.stat().st_size)
