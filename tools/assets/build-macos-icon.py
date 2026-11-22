#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Draws the macOS app icon (assets/default/macos/AppIcon-1024.png).

The brand bolt from assets/default/brand/capricore.svg on a rounded square that
follows the macOS icon grid (824 of 1024 pixels). The release build turns this
PNG into Capri.icns with sips and iconutil. Requires Pillow.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
S = 4  # supersample
N = 1024 * S
img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
# macOS Big Sur grid: 824x824 rounded square centred on a 1024 canvas.
inset, size, radius = 100 * S, 824 * S, 185 * S
# Soft drop shadow
shadow = Image.new('RGBA', (N, N), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((inset, inset + 12 * S, inset + size, inset + size + 12 * S), radius, fill=(0, 0, 0, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(14 * S))
img.alpha_composite(shadow)
# Vertical gradient body (#0F2633 -> #07131C)
body = Image.new('RGBA', (N, N), (0, 0, 0, 0))
grad = Image.new('RGBA', (1, size))
top, bottom = (21, 52, 68), (7, 19, 28)
for y in range(size):
    t = y / (size - 1)
    grad.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
grad = grad.resize((size, size))
mask = Image.new('L', (N, N), 0)
ImageDraw.Draw(mask).rounded_rectangle((inset, inset, inset + size, inset + size), radius, fill=255)
body.paste(grad, (inset, inset))
img.alpha_composite(Image.composite(body, Image.new('RGBA', (N, N), (0, 0, 0, 0)), mask))
# Hairline cyan rim
rim = Image.new('RGBA', (N, N), (0, 0, 0, 0))
ImageDraw.Draw(rim).rounded_rectangle((inset, inset, inset + size, inset + size), radius, outline=(109, 247, 242, 70), width=3 * S)
img.alpha_composite(rim)
# The brand bolt from assets/default/brand/capricore.svg (viewBox 0 0 64 64).
bolt = [(27, 1), (3, 26), (18, 26), (12, 47), (38, 17), (23, 17)]
def place(points, dx=0, dy=0):
    # Bolt bbox in SVG units: x 3..42, y 1..50 (with the red offset). Fit into 560 px.
    scale = 560 * S / 49
    ox = N / 2 - (3 + 42) / 2 * scale
    oy = N / 2 - (1 + 50) / 2 * scale
    return [(ox + (x + dx) * scale, oy + (y + dy) * scale) for x, y in points]
draw = ImageDraw.Draw(img)
draw.polygon(place(bolt, 4, 3), fill=(255, 0, 61, 255))
draw.polygon(place(bolt), fill=(0, 244, 82, 255))
img = img.resize((1024, 1024), Image.LANCZOS)
OUTPUT = Path(__file__).resolve().parents[2] / 'assets/default/macos/AppIcon-1024.png'
img.save(OUTPUT, optimize=True)
print(img.size)
