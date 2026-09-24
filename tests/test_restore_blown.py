"""auto_restore on over-exposed scans: a channel whose median is at white (ROADMAP §0)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

from slidestation import imaging as im

GOLDEN = Path(__file__).resolve().parents[1] / "apple/SlideKit/Tests/SlideKitTests/Golden"


def scene() -> np.ndarray:
    return np.asarray(Image.open(GOLDEN / "scene.png"), np.float32) / 255


def test_blown_out_scans_stay_finite():
    base = scene()
    for k in (1.5, 1.8, 2.0, 2.5, 3.0, 10.0):
        a = np.clip(base * k, 0, 1)
        with np.errstate(all="raise"):  # no division by zero, no invalid log / power
            out = im.auto_restore(a, 0.6)
        assert np.isfinite(out).all(), k
        assert out.min() >= 0 and out.max() <= 1, k
        dev = im.develop(a, im.Params(strength=1.0))
        assert np.isfinite(dev).all(), k


def test_all_white_scan_is_left_alone():
    # every channel blown: nothing to balance, so the midtones aren't bent (levels only)
    a = np.clip(scene() * 3, 0, 1)
    out = im.auto_restore(a, 0.6)
    assert abs(float(out.mean()) - float(a.mean())) < 0.05
    white = np.ones((64, 96, 3), np.float32)
    assert np.array_equal(im.auto_restore(white, 1.0)[..., :2], white[..., :2])


def test_a_blown_channel_is_pulled_down_no_harder_than_the_bound():
    # blue at white over most of the picture: grey-world darkens it, bounded by RESTORE_GAMMA[1]
    a = scene().copy()
    a[..., 2] = np.clip(a[..., 2] * 1.5, 0, 1)
    out = im.auto_restore(a, 0.6)
    assert np.isfinite(out).all()
    assert out[..., 2].mean() > 0.2  # not collapsed to black


def test_golden_fixture_matches():
    meta = json.loads((GOLDEN / "golden.json").read_text())["restore_blown"]
    want = np.fromfile(GOLDEN / "restored_blown.f32", np.float32).reshape(len(meta["scales"]), -1)
    base = scene()
    for k, w in zip(meta["scales"], want):
        got = im.auto_restore(np.clip(base * k, 0, 1), meta["strength"]).ravel()
        assert np.abs(got - w).max() < 1e-5, k
