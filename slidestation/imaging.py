"""Image processing: signatures for grouping, rotation guesses, HDR fusion, colour restoration."""
from __future__ import annotations

import io
from dataclasses import dataclass, asdict
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

PROXY_EDGE = 1600
THUMB_EDGE = 360

# --------------------------------------------------------------------------- loading


def load_rgb(path: str, max_edge: int | None = None) -> np.ndarray:
    """Load a JPEG as float32 RGB 0..1, optionally downscaled (fast via JPEG draft mode)."""
    im = Image.open(path)
    if max_edge:
        im.draft("RGB", (max_edge, max_edge))
    im = im.convert("RGB")
    if max_edge and max(im.size) > max_edge:
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def to_jpeg_bytes(arr: np.ndarray, quality: int = 88, max_edge: int | None = None) -> bytes:
    im = Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8))
    if max_edge and max(im.size) > max_edge:
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


# --------------------------------------------------------------------------- grouping


def signature(rgb: np.ndarray) -> np.ndarray:
    """Brightness-independent structural signature used to detect repeated scans of one slide."""
    g = cv2.cvtColor((rgb * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    g = cv2.resize(g, (96, 64), interpolation=cv2.INTER_AREA).astype(np.float32)
    g = (g - g.mean()) / (g.std() + 1e-6)
    return g


def similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float((a * b).mean())


SAME_SLIDE = 0.86


def group_sequence(sigs: list[np.ndarray], prev_group: list[np.ndarray] | None = None) -> tuple[list[list[int]], bool]:
    """Chain consecutive scans that look like the same slide (compared against every scan in the current group).

    Returns (groups of indices, whether the first scan continues the caller's previous group)."""
    groups: list[list[int]] = []
    continues = False
    for i, s in enumerate(sigs):
        members = [sigs[j] for j in groups[-1]] if groups else (prev_group or [])
        if members and max(similarity(s, m) for m in members) > SAME_SLIDE:
            if groups:
                groups[-1].append(i)
            else:
                continues = True
                groups.append([i])
        else:
            groups.append([i])
    return groups, continues


# --------------------------------------------------------------------------- rotation

_MODEL = str(Path(__file__).parent / "models" / "face_detection_yunet_2023mar.onnx")
_detector = None


def rotate_arr(a: np.ndarray, rot: int) -> np.ndarray:
    """Rotate clockwise by rot degrees (0/90/180/270)."""
    k = {0: 0, 90: 3, 180: 2, 270: 1}[rot % 360]
    return np.ascontiguousarray(np.rot90(a, k))


def face_votes(rgb: np.ndarray) -> dict[int, float]:
    """Sum of confident face scores found at each candidate rotation."""
    global _detector
    if _detector is None:
        _detector = cv2.FaceDetectorYN.create(_MODEL, "", (320, 320), 0.6, 0.3, 5000)
    small = cv2.resize(rgb, (800, int(800 * rgb.shape[0] / rgb.shape[1])), interpolation=cv2.INTER_AREA)
    bgr = cv2.cvtColor((small * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    votes = {}
    for r in (0, 90, 180, 270):
        x = rotate_arr(bgr, r)
        _detector.setInputSize((x.shape[1], x.shape[0]))
        _, faces = _detector.detect(x)
        votes[r] = 0.0 if faces is None else float(sum(f[14] for f in faces if f[14] >= 0.7))
    return votes


def sky_votes(rgb: np.ndarray) -> dict[int, float]:
    """Bright, smooth, blue-ish edge = sky. Score per candidate rotation (which edge would become the top)."""
    s = cv2.resize(rgb, (480, 320), interpolation=cv2.INTER_AREA)
    lum = s.mean(2)
    blue = s[..., 2] - s[..., 0]
    tex = np.abs(cv2.Laplacian(cv2.GaussianBlur(lum, (0, 0), 1), cv2.CV_32F))
    h, w = lum.shape
    sh, sw = h // 5, w // 5
    strips = {0: (slice(0, sh), slice(None)), 90: (slice(None), slice(0, sw)),
              270: (slice(None), slice(w - sw, w)), 180: (slice(h - sh, h), slice(None))}
    return {r: float(lum[x].mean() + 0.5 * blue[x].mean() - 8.0 * tex[x].mean()) for r, x in strips.items()}


def suggest_rotation(images: list[np.ndarray]) -> tuple[int, str]:
    """Clockwise rotation to make a slide upright, from one or more scans of it.

    Returns (degrees, reason) where reason is 'faces', 'sky' or '' (no confident guess -> 0).
    Tuned on hand-labelled trays: only guesses when it is very likely right."""
    fv = {0: 0.0, 90: 0.0, 180: 0.0, 270: 0.0}
    for im in images:
        for r, v in face_votes(im).items():
            fv[r] += v
    best = max(fv, key=fv.get)
    second = sorted(fv.values())[-2]
    n = len(images)
    if fv[best] / n >= 0.7 and fv[best] >= second * 2 + 0.3 * n:
        return best, "faces"
    sv = {0: 0.0, 90: 0.0, 180: 0.0, 270: 0.0}
    for im in images:
        for r, v in sky_votes(im).items():
            sv[r] += v / n
    ranked = sorted(sv, key=sv.get, reverse=True)
    if ranked[0] in (90, 270) and sv[ranked[0]] - sv[ranked[1]] >= 0.2:
        return ranked[0], "sky"
    return 0, ""


# --------------------------------------------------------------------------- HDR


def load_u8(path: str) -> np.ndarray:
    """Full-resolution RGB uint8 (a quarter of the memory of float32)."""
    return np.asarray(Image.open(path).convert("RGB"))


def fuse(images: list[np.ndarray]) -> np.ndarray:
    """Align and exposure-fuse (Mertens) several scans of one slide.

    Accepts float32 0..1 or uint8 RGB; returns float32 RGB 0..1."""
    if len(images) == 1:
        im = images[0]
        return im.astype(np.float32) / 255 if im.dtype == np.uint8 else im
    ims8 = [cv2.cvtColor(im if im.dtype == np.uint8 else (im * 255 + 0.5).astype(np.uint8), cv2.COLOR_RGB2BGR)
            for im in images]
    del images
    h = min(i.shape[0] for i in ims8)
    w = min(i.shape[1] for i in ims8)
    ims8 = [i[:h, :w] for i in ims8]
    cv2.createAlignMTB().process(ims8, ims8)
    out = cv2.createMergeMertens().process(ims8)
    return np.clip(out[..., ::-1], 0, 1).astype(np.float32)


# --------------------------------------------------------------------------- colour


@dataclass
class Params:
    strength: float = 0.6  # auto fade restoration 0..1
    brightness: float = 0.0  # -1..1
    contrast: float = 0.0  # -1..1
    warmth: float = 0.0  # -1..1
    tint: float = 0.0  # -1..1 (+ = magenta)
    saturation: float = 0.0  # -1..1
    trim: bool = True  # crop dark slide-mount edges

    @classmethod
    def from_dict(cls, d: dict | None) -> "Params":
        p = cls()
        for k, v in (d or {}).items():
            if hasattr(p, k):
                setattr(p, k, type(getattr(p, k))(v))
        return p

    def to_dict(self) -> dict:
        return asdict(self)


def auto_restore(a: np.ndarray, strength: float) -> np.ndarray:
    """Per-channel levels + partial grey-world midtone balance, with a guard against yellow skies."""
    if strength <= 0:
        return a.copy()
    h, w, _ = a.shape
    m = int(min(h, w) * 0.04)
    step = max(1, int(np.sqrt(h * w / 250_000)))
    s = a[m : h - m : step, m : w - m : step].reshape(-1, 3)
    L = np.percentile(s, 0.4, 0)
    H = np.percentile(s, 99.6, 0)
    # blend levels toward identity by strength so low strength is gentle
    k = min(1.0, strength * 2.5)  # levels reach full stretch from strength 0.4 upward
    L = L * k
    H = 1 - (1 - H) * k
    b = np.clip((a - L) / np.maximum(H - L, 1e-3), 0, 1)
    sb = np.clip((s - L) / np.maximum(H - L, 1e-3), 1e-4, 1)
    med = np.median(sb, 0)
    tgt = np.exp(np.log(med).mean())
    g = 1 + (np.log(tgt) / np.log(med) - 1) * strength
    out = b ** g.astype(np.float32)
    Hb = np.percentile(s[:, 2], 99.6)
    mask = np.clip((a[..., 2] - (Hb - 0.10)) / 0.08, 0, 1).astype(np.float32)
    mask = cv2.GaussianBlur(mask, (0, 0), 3) * strength
    out[..., 2] = np.maximum(out[..., 2], out[..., 2] * (1 - mask) + out[..., :2].max(2) * mask * 0.98)
    return out


def trim_borders(a: np.ndarray, max_frac: float = 0.05) -> np.ndarray:
    """Remove dark mount edges (rows/cols that are much darker than the picture)."""
    lum = a.mean(2)
    ref = float(np.median(lum))
    thr = min(0.12, ref * 0.35)
    h, w = lum.shape

    def cut(profile, limit):
        n = 0
        while n < limit and profile[n] < thr:
            n += 1
        return n + (2 if n else 0)

    rows, cols = lum.mean(1), lum.mean(0)
    t = cut(rows, int(h * max_frac))
    b = cut(rows[::-1], int(h * max_frac))
    l = cut(cols, int(w * max_frac))
    r = cut(cols[::-1], int(w * max_frac))
    return a[t : h - b or None, l : w - r or None]


def develop(a: np.ndarray, p: Params) -> np.ndarray:
    out = auto_restore(a, p.strength)
    if p.trim:
        out = trim_borders(out)
    eps = 1e-5
    if p.warmth or p.tint:
        gam = np.array([1 - 0.25 * p.warmth, 1 + 0.25 * p.tint, 1 + 0.25 * p.warmth], np.float32)
        out = np.clip(out, eps, 1) ** gam
    if p.brightness:
        out = np.clip(out, eps, 1) ** (2.0 ** (-p.brightness))
    if p.contrast:
        c = p.contrast
        if c > 0:
            s = out * out * (3 - 2 * out)  # smoothstep S-curve
            out = out + (s - out) * c * 1.5
        else:
            out = out + (0.5 - out) * (-c) * 0.5
    lum = (out * np.array([0.299, 0.587, 0.114], np.float32)).sum(2, keepdims=True)
    out = lum + (out - lum) * (1.1 + p.saturation)
    return np.clip(out, 0, 1).astype(np.float32)
