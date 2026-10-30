#!/usr/bin/env python3
"""Generate the extension icons (icons/icon-{16,32,48,128}.png).

Blue rounded square with a white download arrow. Standard library only (zlib PNG writer),
4x4 supersampling for anti-aliasing. Run: python3 tools/make_icons.py
"""
import os
import struct
import zlib

BLUE = (37, 99, 235)
WHITE = (255, 255, 255)
SIZES = (16, 32, 48, 128)
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")


def inside_rounded_square(x, y, radius=0.22):
    # Unit coordinates in [0, 1].
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def inside_arrow(x, y):
    stem = 0.43 <= x <= 0.57 and 0.18 <= y <= 0.55
    # Arrow head: triangle with apex at (0.5, 0.74), base from x=0.26..0.74 at y=0.47.
    head = 0.47 <= y <= 0.74 and abs(x - 0.5) <= 0.24 * (0.74 - y) / 0.27
    tray = 0.24 <= x <= 0.76 and 0.79 <= y <= 0.87
    return stem or head or tray


def render(size, samples=4):
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter type: none
        for px in range(size):
            bg = fg = 0
            for sy in range(samples):
                for sx in range(samples):
                    x = (px + (sx + 0.5) / samples) / size
                    y = (py + (sy + 0.5) / samples) / size
                    if inside_rounded_square(x, y):
                        bg += 1
                        if inside_arrow(x, y):
                            fg += 1
            n = samples * samples
            alpha = bg / n
            mix = fg / bg if bg else 0
            color = [round(b + (w - b) * mix) for b, w in zip(BLUE, WHITE)]
            row += bytes(color + [round(alpha * 255)])
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, "icon-%d.png" % size)
        with open(path, "wb") as f:
            f.write(png(size, render(size)))
        print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
