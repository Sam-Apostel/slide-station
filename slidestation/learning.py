"""Learns your colour corrections and applies them to new slides.

Every slide you approve is stored as one example: a small set of image features describing the
scan (how faded, how dark, what cast) together with the settings you settled on. A new slide is
matched against those examples with distance-weighted k-nearest-neighbours, so a tray of faded
blue slides gets the treatment you gave the last faded blue ones, while a neutral tray does not.

No training step, no dependencies: it is a few hundred numbers on disk and runs in microseconds.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import cv2
import numpy as np

from .imaging import Params
from .store import _atomic_write, library, lock

FEATURES = 14
MIN_EXAMPLES = 5  # below this, stick to the defaults
K = 7
MAX_EXAMPLES = 20_000
# how far a neighbour may be (in standardised feature space) before it stops counting
MAX_DISTANCE = 3.0
LEARNED_KEYS = ("strength", "brightness", "contrast", "warmth", "tint", "saturation")


def features(rgb: np.ndarray, scans: int = 1) -> list[float]:
    """Describe a blended slide in a way that captures fading, cast and contrast."""
    a = cv2.resize(rgb, (160, 107), interpolation=cv2.INTER_AREA).astype(np.float32)
    flat = a.reshape(-1, 3)
    p = np.percentile(flat, [1, 50, 99], axis=0)  # per channel low/mid/high
    lum = flat.mean(1)
    lo, mid, hi = np.percentile(lum, [5, 50, 95])
    eps = 1e-3
    med = p[1]
    return [
        *p.reshape(-1).tolist(),  # 9: per-channel 1/50/99 percentiles
        float(mid),  # overall brightness
        float(hi - lo),  # contrast
        float(np.log((med[0] + eps) / (med[1] + eps))),  # red/green cast
        float(np.log((med[2] + eps) / (med[1] + eps))),  # blue/green cast
        float(min(scans, 5) / 5),  # single scan vs a deep bracket stack
    ]


class Model:
    """Examples + standardisation, persisted as one small JSON file in the library."""

    def __init__(self, path: Path | None = None):
        self.path = path or (library() / "learning.json")
        self.examples: list[dict] = []
        self._X: np.ndarray | None = None
        self._mu = self._sd = None
        self.load()

    # ------------------------------------------------------------------ storage
    def load(self) -> None:
        try:
            data = json.loads(self.path.read_text())
            self.examples = data.get("examples", [])
        except (OSError, ValueError):
            self.examples = []
        self._fit()

    def save(self) -> None:
        with lock:
            _atomic_write(self.path, {"version": 1, "examples": self.examples[-MAX_EXAMPLES:]})

    def _fit(self) -> None:
        if len(self.examples) < MIN_EXAMPLES:
            self._X = None
            return
        X = np.array([e["f"] for e in self.examples], dtype=np.float32)
        self._mu = X.mean(0)
        self._sd = X.std(0) + 1e-3
        self._X = (X - self._mu) / self._sd

    # ------------------------------------------------------------------ use
    def remember(self, key: str, feats: list[float], params: dict) -> None:
        """Record (or update) the settings a slide was approved with."""
        if len(feats) != FEATURES:
            return
        entry = {"key": key, "f": [round(float(x), 5) for x in feats],
                 "p": {k: float(params[k]) for k in LEARNED_KEYS if k in params},
                 "trim": bool(params.get("trim", True)), "t": time.time()}
        with lock:
            for i, e in enumerate(self.examples):
                if e.get("key") == key:
                    self.examples[i] = entry
                    break
            else:
                self.examples.append(entry)
        self.save()
        self._fit()

    def forget(self, key: str) -> None:
        with lock:
            n = len(self.examples)
            self.examples = [e for e in self.examples if e.get("key") != key]
        if len(self.examples) != n:
            self.save()
            self._fit()

    def suggest(self, feats: list[float]) -> tuple[dict | None, int]:
        """Predict settings for a new slide. Returns (params or None, neighbours used)."""
        if self._X is None or len(feats) != FEATURES:
            return None, 0
        q = (np.array(feats, dtype=np.float32) - self._mu) / self._sd
        d = np.sqrt(((self._X - q) ** 2).mean(1))
        idx = np.argsort(d)[: min(K, len(d))]
        idx = [i for i in idx if d[i] <= MAX_DISTANCE]
        if not idx:
            return None, 0
        w = 1.0 / (d[idx] + 0.25)
        w = w / w.sum()
        out: dict = {}
        for k in LEARNED_KEYS:
            vals = np.array([self.examples[i]["p"].get(k, getattr(Params(), k)) for i in idx], dtype=np.float32)
            out[k] = float(np.round((vals * w).sum(), 3))
        trims = np.array([self.examples[i].get("trim", True) for i in idx], dtype=np.float32)
        out["trim"] = bool((trims * w).sum() >= 0.5)
        return out, len(idx)

    def stats(self) -> dict:
        return {
            "examples": len(self.examples),
            "ready": self._X is not None,
            "min_examples": MIN_EXAMPLES,
            "last": max((e.get("t", 0) for e in self.examples), default=0),
        }


_model: Model | None = None


def model() -> Model:
    global _model
    if _model is None or _model.path != (library() / "learning.json"):
        _model = Model()
    return _model


def reset() -> None:
    """Forget everything (used by the Settings screen)."""
    m = model()
    with lock:
        m.examples = []
    m.save()
    m._fit()
