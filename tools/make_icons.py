"""Draw the home-screen icons: a white plate with a green protein wedge on near-black."""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "docs"


def icon(size):
    s = size * 4  # draw large, downsample for smooth edges
    img = Image.new("RGB", (s, s), "#0F1110")
    d = ImageDraw.Draw(img)
    c = s // 2
    r = int(s * 0.34)
    d.ellipse((c - r, c - r, c + r, c + r), fill="#E9ECEA")
    ri = int(r * 0.74)
    d.ellipse((c - ri, c - ri, c + ri, c + ri), fill="#F7F8F7")
    # calorie ring wedge: two thirds filled, in the app's accent green
    rw = int(r * 0.62)
    d.pieslice((c - rw, c - rw, c + rw, c + rw), start=-90, end=150, fill="#3DDC84")
    rh = int(rw * 0.62)
    d.ellipse((c - rh, c - rh, c + rh, c + rh), fill="#F7F8F7")
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
    icon(size).save(OUT / name)
    print("wrote", name)
