"""Every platform's icons from the one artwork (Tools/icon-art.png, the Mac-shaped icon: a rounded
square with a transparent margin and a shadow).

- iOS / iPadOS: opaque and full-bleed (the App Store rejects transparency; iOS rounds the corners).
- macOS: the artwork itself at every size.
- tvOS: a layered 5:3 icon (back: the dark body, front: the slides) and the Top Shelf images.

    uv run --with pillow python apple/Tools/make_icons.py
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "Tools/icon-art.png"
TV = ROOT / "TV/Assets.xcassets"

art = Image.open(ART).convert("RGBA")
# the rounded square inside the margin, just inside its light rim
BODY = (112, 112, 912, 912)
TOP, BOTTOM = (39, 39, 46), (17, 17, 20)


def gradient(w: int, h: int) -> Image.Image:
    g = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(g)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return g


def write(folder: Path, contents: dict):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n")


# ---- iOS and macOS: one appiconset
icons = ROOT / "App/Assets.xcassets/AppIcon.appiconset"
body = art.crop(BODY).resize((1024, 1024), Image.LANCZOS)
ios = gradient(1024, 1024)
ios.paste(body, (0, 0), body)
ios.save(icons / "icon-ios.png")
images = [{"filename": "icon-ios.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}]
for pt in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        px = pt * scale
        name = f"icon-mac-{px}.png"
        art.resize((px, px), Image.LANCZOS).save(icons / name)
        images.append({"filename": name, "idiom": "mac", "scale": f"{scale}x", "size": f"{pt}x{pt}"})
write(icons, {"images": images, "info": {"author": "xcode", "version": 1}})


# ---- tvOS
def front(w: int, h: int) -> Image.Image:
    """The slides and the scanner, cut from the artwork, centred on a transparent layer."""
    piece = art.crop((150, 190, 880, 880))
    s = min(w * 0.62 / piece.width, h * 0.86 / piece.height)
    piece = piece.resize((round(piece.width * s), round(piece.height * s)), Image.LANCZOS)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    layer.paste(piece, ((w - piece.width) // 2, (h - piece.height) // 2), piece)
    return layer


def imagestack(path: Path, size: tuple[int, int], scales: list[int]):
    layers = [("Front", front), ("Back", lambda w, h: gradient(w, h))]
    write(path, {"info": {"author": "xcode", "version": 1}, "layers": [{"filename": f"{n}.imagestacklayer"} for n, _ in layers]})
    for name, make in layers:
        layer = path / f"{name}.imagestacklayer"
        write(layer, {"info": {"author": "xcode", "version": 1}})
        content = layer / "Content.imageset"
        content.mkdir(parents=True, exist_ok=True)
        imgs = []
        for sc in scales:
            fn = f"{name.lower()}@{sc}x.png"
            make(size[0] * sc, size[1] * sc).save(content / fn)
            imgs.append({"filename": fn, "idiom": "tv", "scale": f"{sc}x"})
        write(layer / "Content.imageset", {"images": imgs, "info": {"author": "xcode", "version": 1}})


def shelf(path: Path, size: tuple[int, int]):
    imgs = []
    path.mkdir(parents=True, exist_ok=True)
    for sc in (1, 2):
        w, h = size[0] * sc, size[1] * sc
        im = gradient(w, h).convert("RGBA")
        mark = art.resize((round(h * 0.62), round(h * 0.62)), Image.LANCZOS)
        im.paste(mark, (round(w * 0.5 - h * 0.62 - 40 * sc), round(h * 0.19)), mark)
        d = ImageDraw.Draw(im)
        try:
            font = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", round(h * 0.13))
        except OSError:
            font = ImageFont.load_default()
        d.text((round(w * 0.5), round(h * 0.5)), "Slide Station", font=font, fill=(235, 232, 226), anchor="lm")
        fn = f"shelf@{sc}x.png"
        im.convert("RGB").save(path / fn)
        imgs.append({"filename": fn, "idiom": "tv", "scale": f"{sc}x"})
    write(path, {"images": imgs, "info": {"author": "xcode", "version": 1}})


brand = TV / "App Icon & Top Shelf Image.brandassets"
imagestack(brand / "App Icon.imagestack", (400, 240), [1, 2])
imagestack(brand / "App Icon - App Store.imagestack", (1280, 768), [1])
shelf(brand / "Top Shelf Image.imageset", (1920, 720))
shelf(brand / "Top Shelf Image Wide.imageset", (2320, 720))
write(brand, {
    "assets": [
        {"filename": "App Icon - App Store.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "1280x768"},
        {"filename": "App Icon.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "400x240"},
        {"filename": "Top Shelf Image Wide.imageset", "idiom": "tv", "role": "top-shelf-image-wide", "size": "2320x720"},
        {"filename": "Top Shelf Image.imageset", "idiom": "tv", "role": "top-shelf-image", "size": "1920x720"},
    ],
    "info": {"author": "xcode", "version": 1},
})
write(TV, {"info": {"author": "xcode", "version": 1}})
mark = TV / "Mark.imageset"
mark.mkdir(parents=True, exist_ok=True)
Image.open(ROOT / "App/Assets.xcassets/Mark.imageset/mark.png").save(mark / "mark.png")
write(mark, {"images": [{"filename": "mark.png", "idiom": "universal"}], "info": {"author": "xcode", "version": 1}})
accent = TV / "AccentColor.colorset"
accent.mkdir(parents=True, exist_ok=True)
write(accent, json.loads((ROOT / "App/Assets.xcassets/AccentColor.colorset/Contents.json").read_text()))
print("icons written")
