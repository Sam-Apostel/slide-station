"""Slide Station app icon: a slide mount standing in a tray, a sunset in its window.

Regenerate with:  ../../.venv/bin/python make_icon.py .   (from desktop/build; needs numpy + Pillow)
The favicon (frontend/public/favicon.svg) is a hand-simplified vector of the front mount."""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SS = 4  # supersampling
N = 1024 * SS


def s(v):
    return int(round(v * SS))


def vgrad(w, h, top, bottom):
    t = np.linspace(0, 1, h)[:, None, None]
    a = np.array(top, np.float32)[None, None] * (1 - t) + np.array(bottom, np.float32)[None, None] * t
    return Image.fromarray(np.repeat(a, w, 1).astype(np.uint8), "RGBA" if len(top) == 4 else "RGB")


def rrect_mask(size, box, r):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle(box, r, fill=255)
    return m


def paste_grad(canvas, box, r, top, bottom):
    x0, y0, x1, y1 = box
    g = vgrad(x1 - x0, y1 - y0, top, bottom).convert("RGBA")
    m = rrect_mask((x1 - x0, y1 - y0), (0, 0, x1 - x0 - 1, y1 - y0 - 1), r)
    canvas.paste(g, (x0, y0), m)


def shadow(canvas, box, r, blur, offset, alpha):
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    x0, y0, x1, y1 = box
    ImageDraw.Draw(sh).rounded_rectangle((x0, y0 + offset, x1, y1 + offset), r, fill=(0, 0, 0, alpha))
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(blur)))


def mount(canvas, box, top, bottom, window=True, dimples=True):
    x0, y0, x1, y1 = box
    r = s(44)
    shadow(canvas, box, r, s(18), s(14), 150)
    paste_grad(canvas, box, r, top, bottom)
    d = ImageDraw.Draw(canvas)
    # bevel: light top edge, dark bottom edge
    d.rounded_rectangle(box, r, outline=(255, 236, 196, 80), width=s(3))
    w, h = x1 - x0, y1 - y0
    wx0, wy0 = x0 + int(w * 0.17), y0 + int(h * 0.24)
    wx1, wy1 = x1 - int(w * 0.17), y1 - int(h * 0.30)
    if dimples:
        # a field of pressed-in dots on the plastic, not on the window
        step = s(30)
        lay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        rad = s(5.5)
        for yy in range(y0 + step // 2 + s(6), y1 - s(10), step):
            for xx in range(x0 + step // 2 + s(6), x1 - s(10), step):
                if wx0 - s(14) < xx < wx1 + s(14) and wy0 - s(14) < yy < wy1 + s(14):
                    continue
                ld.ellipse((xx - rad, yy - rad - s(1.5), xx + rad, yy + rad - s(1.5)), fill=(90, 50, 0, 60))
                ld.ellipse((xx - rad, yy - rad + s(1.5), xx + rad, yy + rad + s(1.5)), fill=(255, 245, 220, 70))
                ld.ellipse((xx - rad + s(1), yy - rad + s(0.5), xx + rad - s(1), yy + rad - s(0.5)), fill=None)
        m = rrect_mask(canvas.size, box, r)
        canvas.alpha_composite(Image.composite(lay, Image.new("RGBA", canvas.size, (0, 0, 0, 0)), m))
    if not window:
        return
    # the window: a sunset over hills, sunk into the mount
    ww, wh = wx1 - wx0, wy1 - wy0
    sky = vgrad(ww, wh, (38, 52, 110), (247, 150, 70)).convert("RGBA")
    sd = ImageDraw.Draw(sky)
    sun_r = int(wh * 0.17)
    cx, cy = int(ww * 0.64), int(wh * 0.60)
    glow = Image.new("RGBA", (ww, wh), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((cx - sun_r * 2.4, cy - sun_r * 2.4, cx + sun_r * 2.4, cy + sun_r * 2.4), fill=(255, 210, 120, 90))
    sky.alpha_composite(glow.filter(ImageFilter.GaussianBlur(s(18))))
    sd.ellipse((cx - sun_r, cy - sun_r, cx + sun_r, cy + sun_r), fill=(255, 226, 150, 255))
    xs = np.arange(ww)
    far = (wh * (0.66 + 0.06 * np.sin(xs / ww * 5.0 + 1.2))).astype(int)
    near = (wh * (0.78 + 0.08 * np.sin(xs / ww * 3.1 - 0.4))).astype(int)
    arr = np.array(sky)
    yy = np.arange(wh)[:, None]
    arr[yy >= far[None, :]] = (92, 40, 60, 255)
    arr[yy >= near[None, :]] = (38, 18, 34, 255)
    sky = Image.fromarray(arr)
    wr = s(10)
    canvas.paste(sky, (wx0, wy0), rrect_mask((ww, wh), (0, 0, ww - 1, wh - 1), wr))
    d = ImageDraw.Draw(canvas)
    # inner shadow at the top of the window, highlight at the bottom lip
    inner = Image.new("RGBA", (ww, wh), (0, 0, 0, 0))
    ImageDraw.Draw(inner).rectangle((0, 0, ww, s(10)), fill=(0, 0, 0, 150))
    inner = inner.filter(ImageFilter.GaussianBlur(s(6)))
    canvas.alpha_composite(Image.composite(inner, Image.new("RGBA", (ww, wh), (0, 0, 0, 0)),
                                           rrect_mask((ww, wh), (0, 0, ww - 1, wh - 1), wr)), (wx0, wy0))
    d.rounded_rectangle((wx0, wy0, wx1, wy1), wr, outline=(80, 45, 0, 170), width=s(3))
    d.line((wx0 + wr, wy1 + s(3), wx1 - wr, wy1 + s(3)), fill=(255, 240, 210, 110), width=s(2))


def icon(size=1024, body=True):
    c = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    if body:
        # macOS icon grid: 824 px body, 100 px margin
        bx = (s(100), s(100), s(924), s(924))
        br = s(186)
        shadow(c, bx, br, s(20), s(12), 120)
        paste_grad(c, bx, br, (40, 40, 47, 255), (14, 14, 17, 255))
        ImageDraw.Draw(c).rounded_rectangle(bx, br, outline=(255, 255, 255, 16), width=s(3))
        clip = rrect_mask(c.size, bx, br)
    # slides standing on edge in the tray, back to front
    layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    mount(layer, (s(300), s(196), s(768), s(664)), (150, 104, 38, 255), (110, 74, 24, 255), window=False, dimples=False)
    mount(layer, (s(270), s(236), s(738), s(704)), (196, 138, 50, 255), (150, 100, 32, 255), window=False, dimples=False)
    mount(layer, (s(236), s(282), s(724), s(770)), (250, 204, 122, 255), (228, 154, 44, 255))
    # the tray's front lip, hiding the slides' feet
    lip = (s(150), s(700), s(874), s(870))
    shadow(layer, lip, s(40), s(16), -s(8), 170)
    paste_grad(layer, lip, s(40), (54, 54, 62, 255), (24, 24, 28, 255))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle(lip, s(40), outline=(255, 255, 255, 36), width=s(3))
    ld.line((s(190), s(700) + s(2), s(834), s(700) + s(2)), fill=(255, 255, 255, 60), width=s(2))
    # the slot label on the lip, like a carousel tray's numbering
    for i, x in enumerate(range(s(262), s(780), s(86))):
        ld.rounded_rectangle((x, s(772), x + s(46), s(784)), s(6), fill=(255, 255, 255, 22 if i != 0 else 60))
    if body:
        layer = Image.composite(layer, Image.new("RGBA", (N, N), (0, 0, 0, 0)), clip)
    c.alpha_composite(layer)
    return c.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    out = sys.argv[1]
    icon(1024).save(f"{out}/icon.png")
    print("ok")
