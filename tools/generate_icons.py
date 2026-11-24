#!/usr/bin/env python3
"""Generate minimal PNG/ICO icons without third-party deps (Akhtar Autos branding)."""
import struct, zlib, pathlib

def png(size, rgba_fn):
    raw = b""
    for y in range(size):
        raw += b"\x00"
        for x in range(size):
            raw += bytes(rgba_fn(x, y, size))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

def color(x, y, size):
    m = max(1, size // 32)
    cx = cy = size / 2
    dx, dy = x - cx, y - cy
    r = (dx * dx + dy * dy) ** 0.5
    outer = size * 0.32
    inner = size * 0.14
    if x < m or y < m or x >= size - m or y >= size - m:
        return (0, 0, 0, 0)
    bg = (15, 23, 42, 255)
    accent = (234, 179, 8, 255)
    if abs(r - outer) < max(1, size / 16):
        return accent
    if r <= inner:
        return accent
    return bg

def ico_from_pngs(pngs_with_sizes):
    count = len(pngs_with_sizes)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries = b""
    data = b""
    for size, png_bytes in pngs_with_sizes:
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(png_bytes), offset)
        data += png_bytes
        offset += len(png_bytes)
    return header + entries + data

def main():
    dest = pathlib.Path("src-tauri/icons")
    dest.mkdir(parents=True, exist_ok=True)
    pngs = {s: png(s, color) for s in (32, 128, 256)}
    (dest / "32x32.png").write_bytes(pngs[32])
    (dest / "128x128.png").write_bytes(pngs[128])
    (dest / "128x128@2x.png").write_bytes(pngs[256])
    (dest / "icon.png").write_bytes(pngs[256])
    ico = ico_from_pngs([(32, pngs[32]), (128, pngs[128]), (256, pngs[256])])
    (dest / "icon.ico").write_bytes(ico)
    for p in sorted(dest.iterdir()):
        print("wrote", p, p.stat().st_size)

if __name__ == "__main__":
    main()
