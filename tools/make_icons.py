#!/usr/bin/env python3
"""Draw the PNG app icons (same design as public/icons/icon.svg). Needs Pillow."""
import math, pathlib
from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "icons"
for size in (180, 192, 512):
    k = 4  # supersample
    S = size * k
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    f = S / 512
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(112 * f) if size != 180 else 0, fill="#0f6e8c")
    wave = [(x * f, (352 + 10 * math.sin(x / 512 * 4 * math.pi + math.pi)) * f) for x in range(0, 513, 8)]
    d.polygon(wave + [(512 * f, 512 * f), (0, 512 * f)], fill="#0b4d63")
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(112 * f) if size != 180 else 0, fill=255)
    im.putalpha(mask)
    d = ImageDraw.Draw(im)
    d.polygon([(256 * f, 70 * f), (352 * f, 330 * f), (256 * f, 286 * f), (160 * f, 330 * f)], fill="#ffffff")
    d.ellipse([238 * f, 208 * f, 274 * f, 244 * f], fill="#0f6e8c")
    im.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png", optimize=True)
    print("wrote", OUT / f"icon-{size}.png")
