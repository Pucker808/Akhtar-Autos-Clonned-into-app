#!/usr/bin/env python3
from pathlib import Path
import base64, zlib
root = Path(__file__).resolve().parents[1]
parts = sorted(root.glob("tools/db.zlib.part*"), key=lambda p: p.name)
blob = "".join(p.read_text().strip() for p in parts)
raw = zlib.decompress(base64.b64decode(blob))
out = root / "src-tauri/src/db.rs"
out.write_bytes(raw)
print("wrote", out, len(raw))
assert b"create_new_database" in raw
assert b"PLACEHOLDER" not in raw
assert b"INIT_SCHEMA_SQL" in raw
