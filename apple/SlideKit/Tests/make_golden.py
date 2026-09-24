"""Golden fixtures for SlideKit's parity tests: synthetic slides run through the Python pipeline.

Run from the repo root:  uv run --python 3.12 python apple/SlideKit/Tests/make_golden.py
Writes apple/SlideKit/Tests/SlideKitTests/Golden/. Everything is synthetic (no real photos).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from slidestation import imaging as im  # noqa: E402

OUT = Path(__file__).parent / "SlideKitTests" / "Golden"
OUT.mkdir(parents=True, exist_ok=True)
W, H = 192, 128


def scene(seed: int = 1) -> np.ndarray:
    """A faded, magenta-cast 'slide' with sky, a hill, a sun and a dark mount border."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    sky = np.stack([0.45 + 0.1 * y / H, 0.55 + 0.1 * y / H, 0.85 - 0.1 * y / H], -1)
    hill = (y > 70 + 12 * np.sin(x / 17)).astype(np.float32)[..., None]
    ground = np.stack([0.35 + 0.15 * np.sin(x / 9), 0.45 + 0.1 * np.cos(y / 7), 0.2 + 0.05 * np.sin((x + y) / 5)], -1)
    img = sky * (1 - hill) + ground * hill
    sun = ((x - 140) ** 2 + (y - 30) ** 2 < 120).astype(np.float32)[..., None]
    img = img * (1 - sun) + np.array([0.98, 0.95, 0.8]) * sun
    img = img + rng.normal(0, 0.015, img.shape)
    # fade + cast: squeeze each channel into its own band
    img = np.stack([0.25 + img[..., 0] * 0.6, 0.1 + img[..., 1] * 0.55, 0.2 + img[..., 2] * 0.6], -1)
    img[:5] = img[-4:] = 0.03  # mount
    img[:, :6] = img[:, -5:] = 0.03
    return np.clip(img, 0, 1).astype(np.float32)


def save_png(a: np.ndarray, name: str) -> np.ndarray:
    q = (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(q).save(OUT / name)
    return q.astype(np.float32) / 255  # exactly what the Swift side will load


def save_f32(a: np.ndarray, name: str) -> None:
    (OUT / name).write_bytes(np.ascontiguousarray(a, np.float32).tobytes())
    return None


base = save_png(scene(1), "scene.png")
meta: dict = {"width": W, "height": H}

# restore + trim
restored = im.auto_restore(base, 0.6)
save_f32(restored, "restored.f32")
meta["trim_bounds"] = list(im.trim_bounds(restored))

# the whole develop
params = im.Params(strength=0.6, brightness=0.2, contrast=0.3, warmth=0.3, tint=-0.2, saturation=0.1,
                   curves={"rgb": [[0, 0.02], [0.5, 0.55], [1, 1]], "b": [[0.05, 0], [1, 0.95]]})
developed = im.develop(base, params)
save_f32(developed, "developed.f32")
meta["developed_shape"] = list(developed.shape[:2])
meta["params"] = params.to_dict()
neg = im.Params(strength=0.3, contrast=-0.4, saturation=-0.5, trim=False)
save_f32(im.develop(base, neg), "developed_neg.f32")
meta["params_neg"] = neg.to_dict()

cropped = im.Params(strength=0.6, angle=3.0, crop=[0.1, 0.12, 0.9, 0.85])
dc = im.develop(base, cropped)
save_f32(dc, "developed_crop.f32")
meta["developed_crop_shape"] = list(dc.shape[:2])
meta["params_crop"] = cropped.to_dict()

# curves
pts = [[0.0, 0.0], [0.25, 0.35], [0.6, 0.55], [1.0, 1.0]]
meta["curve_points"] = pts
meta["curve_lut"] = im.curve_lut(pts, 64).tolist()
meta["fit_curves"] = im.fit_curves(im.tone_base(base, im.Params()), {})
meta["neutral"] = list(im.neutral_balance(base, im.Params(), 0.2, 0.2))

# grouping: two exposures of one scene vs another scene
dark = save_png(np.clip(scene(1) * 0.55, 0, 1), "scene_dark.png")
other = save_png(np.clip(scene(7)[::-1, ::-1] * 0.9, 0, 1), "scene_other.png")
sa, sd, so = im.signature(base), im.signature(dark), im.signature(other)
meta["sim_same"] = im.similarity(sa, sd)
meta["sim_other"] = im.similarity(sa, so)
meta["quality"] = [im.scan_quality(base), im.scan_quality(dark)]

# fusion of a bracket
bright = save_png(np.clip(scene(1) * 1.5, 0, 1), "scene_bright.png")
# Mertens alone: im.fuse also runs AlignMTB, which invents a 1 px shift on these identical scans.
# SlideKit aligns with Vision instead; that is tested on its own.
import cv2  # noqa: E402
bgr = [cv2.cvtColor((a * 255 + 0.5).astype(np.uint8), cv2.COLOR_RGB2BGR) for a in (dark, base, bright)]
fused = np.clip(cv2.createMergeMertens().process(bgr)[..., ::-1], 0, 1)
save_f32(fused, "fused.f32")

# straighten
save_f32(im.straighten(base, 4.0), "straight4.f32")

# learning: features, and a k-NN suggestion from a small synthetic set of examples
from slidestation import learning  # noqa: E402
meta["features"] = learning.features(base, 2)
rng = np.random.default_rng(5)
model = learning.Model(path=OUT / "_learning_unused.json")
model.examples = []
for i in range(12):
    f = (np.array(meta["features"]) + rng.normal(0, 0.05, 14)).round(5).tolist()
    p = {k: round(float(rng.uniform(-0.5, 0.8)), 3) for k in learning.LEARNED_KEYS}
    model.examples.append({"key": f"t:{i}", "f": f, "p": p, "trim": bool(i % 3), "t": 0})
model._fit()
meta["learning_examples"] = model.examples
meta["learning_query"] = (np.array(meta["features"]) + 0.01).tolist()
sugg, n = model.suggest(meta["learning_query"])
meta["learning_suggestion"] = sugg
meta["learning_neighbours"] = n
# learned tone curves: most neighbours curved red, a few blue (under half the weight: dropped)
model.examples = [dict(e) for e in model.examples]  # learning_examples above stay without curves
for i, e in enumerate(model.examples):
    e["c"] = {"r": [[0.08 + 0.01 * i, 0.0], [0.5, 0.55], [0.9 - 0.01 * i, 1.0]]} if i % 4 else {}
    if i % 5 == 0:
        e["c"]["b"] = [[0.0, 0.05], [1.0, 0.95]]
model._fit()
meta["learning_curve_examples"] = model.examples
sugg, _ = model.suggest(meta["learning_query"])
meta["learning_curve_suggestion"] = sugg["curves"]


# mount detection: the scene turned 2.5° clockwise inside a dark mount window
def mounted(a: np.ndarray, angle: float, inner=(0.84, 0.8)) -> np.ndarray:
    h, w = a.shape[:2]
    y, x = np.mgrid[0:h, 0:w].astype(np.float64) + 0.5
    t = np.deg2rad(angle)
    dx, dy = x - w / 2, y - h / 2
    xr, yr = np.cos(t) * dx + np.sin(t) * dy, -np.sin(t) * dx + np.cos(t) * dy
    alpha = np.clip(0.5 + np.minimum(inner[0] * w / 2 - np.abs(xr), inner[1] * h / 2 - np.abs(yr)), 0, 1)[..., None]
    return a * alpha + 0.03 * (1 - alpha)


big = np.asarray(Image.fromarray((scene(3) * 255 + 0.5).astype(np.uint8)).resize((360, 240), Image.BICUBIC),
                 np.float32) / 255
mnt = save_png(mounted(big, 2.5), "mount.png")
meta["mount"] = im.detect_mount(mnt)
meta["mount_box_rot90"] = im.rotate_box(meta["mount"]["box"], 90)
mp = im.Params(angle=-meta["mount"]["angle"])
meta["mount_params"] = mp.to_dict()
meta["mount_crop_rot90"] = im.mount_crop(im.rotate_arr(mnt, 90), mp, meta["mount_box_rot90"])
meta["mount_none"] = im.detect_mount(base[8:-8, 8:-8])  # no mount left around the picture

# dust & scratches: specks and a scratch on a smooth picture with a patch of fine texture
rng = np.random.default_rng(11)
DW, DH = 256, 176
y, x = np.mgrid[0:DH, 0:DW].astype(np.float32)
clean = np.stack([0.5 + 0.3 * np.sin(x / DW * 3 + 1), 0.45 + 0.25 * np.cos(y / DH * 4),
                  0.4 + 0.2 * np.sin((x + y) / (DW + DH) * 5)], -1) + rng.normal(0, 0.008, (DH, DW, 3))
clean[120:170, 10:90] += (0.12 * np.sin(x[120:170, 10:90] * 2.1) * np.sin(y[120:170, 10:90] * 1.7))[..., None]
dusty = clean.copy()
for _ in range(40):
    cx, cy, r = rng.random() * DW, rng.random() * DH, 0.6 + rng.random() * 0.8
    al = np.clip(r + 0.5 - np.hypot(x - cx, y - cy), 0, 1)[..., None]
    dusty = dusty * (1 - al) + (0.03 if rng.random() < 0.7 else 0.97) * al
al = np.clip(1.0 - np.abs((y - 30) - 0.4 * (x - 100)), 0, 1)[..., None] * ((x > 100) & (x < 220))[..., None]
dusty = dusty * (1 - 0.9 * al) + 0.95 * 0.9 * al
dusty = save_png(dusty, "dusty.png")
meta["dust_amount"] = 0.7
dm, dr = im.dust_mask(dusty, 0.7)
meta["dust_marked"], meta["dust_r"] = int(dm.sum()), dr
save_f32(im.repair_dust(dusty, 0.7), "dust.f32")

# learning per film stock (added later: computed from the keys above only, so the rest of this file
# didn't have to be regenerated). Even examples are Kodachrome (6: learns from those only), two
# are Ektachrome (too few: the others count OTHER_STOCK_WEIGHT), the rest have no stock.
# --- stock fixture start
stock_ex = [dict(e) for e in meta["learning_examples"]]
for i, e in enumerate(stock_ex):
    if i % 2 == 0:
        e["s"] = "kodachrome"
    elif i in (1, 3):
        e["s"] = "ektachrome"
stock_model = learning.Model(path=OUT / "_learning_unused.json")
stock_model.examples = stock_ex
stock_model._fit()
stock_cases = {}
for st in ("kodachrome", "ektachrome", "fujichrome", ""):
    sugg, n = stock_model.suggest(meta["learning_query"], st)
    stock_cases[st or "none"] = {"suggestion": sugg, "neighbours": n}
meta["learning_stock"] = {"examples": stock_ex, "cases": stock_cases}
# --- stock fixture end

(OUT / "golden.json").write_text(json.dumps(meta, indent=1))
print("wrote", OUT)
