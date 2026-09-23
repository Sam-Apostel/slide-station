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

(OUT / "golden.json").write_text(json.dumps(meta, indent=1))
print("wrote", OUT)
