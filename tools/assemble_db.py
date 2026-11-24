#!/usr/bin/env python3
from pathlib import Path
import base64
root = Path(__file__).resolve().parents[1]
a = (root / "tools/db.rs.b64.a").read_text().strip()
b = (root / "tools/db.rs.b64.b").read_text().strip()
raw = base64.b64decode(a + b)
out = root / "src-tauri/src/db.rs"
out.write_bytes(raw)
print("wrote", out, "bytes", len(raw))
assert b"create_new_database" in raw
assert b"INIT_SCHEMA_SQL" in raw
assert b"PLACEHOLDER" not in raw
