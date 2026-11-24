#!/usr/bin/env python3
"""Decode tools/icon-assets.b64.json into src-tauri/icons/."""
import base64, json, pathlib
root = pathlib.Path(__file__).resolve().parents[1]
assets = json.loads((root / "tools" / "icon-assets.b64.json").read_text())
dest = root / "src-tauri" / "icons"
dest.mkdir(parents=True, exist_ok=True)
for name, b64 in assets.items():
    (dest / name).write_bytes(base64.b64decode(b64))
    print("wrote", dest / name)
