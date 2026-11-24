#!/usr/bin/env python3
from pathlib import Path
import base64, zlib
root = Path(__file__).resolve().parents[1]
parts = sorted(root.glob("tools/db.rs.template.zlib.part*"), key=lambda p: p.name)
blob = "".join(p.read_text().strip() for p in parts)
template = zlib.decompress(base64.b64decode(blob)).decode()
sql = zlib.decompress(base64.b64decode((root/"tools/schema.sql.zlib.b64").read_text().strip())).decode()
out = root / "src-tauri/src/db.rs"
out.write_text(template.replace("@@INIT_SCHEMA_SQL@@", sql))
print("wrote", out, out.stat().st_size)
text = out.read_text()
assert "create_new_database" in text and "PLACEHOLDER" not in text and "CREATE TABLE" in text
