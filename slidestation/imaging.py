"""Image processing: signatures for grouping, rotation guesses, HDR fusion, colour restoration."""
from __future__ import annotations

import io
import json
import math
import threading
import warnings
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from . import raw

PROXY_EDGE = 1600
THUMB_EDGE = 360

# --------------------------------------------------------------------------- loading


def load_rgb(path: str, max_edge: int | None = None) -> np.ndarray:
    """Load a JPEG as float32 RGB 0..1, optionally downscaled (fast via JPEG draft mode).
    Camera RAW files are decoded by raw.py (16 bits straight to float)."""
    if raw.is_raw(path):
        return raw.load_rgb(path, max_edge)
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


# --------------------------------------------------------------------------- best of a bracket


def scan_quality(rgb: np.ndarray) -> dict:
    """Sharpness (independent of exposure) and how much of the frame is clipped, for one scan."""
    g = cv2.cvtColor((np.clip(rgb, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    g = cv2.resize(g, (800, int(800 * g.shape[0] / g.shape[1])), interpolation=cv2.INTER_AREA)
    h, w = g.shape
    core = g[h // 10 : -h // 10, w // 10 : -w // 10].astype(np.float32)
    lit = core[(core > 12) & (core < 243)]  # detail can only show where nothing is clipped
    clipped = 1 - lit.size / core.size
    if lit.size < core.size * 0.05:
        return {"sharp": 0.0, "clipped": round(float(clipped), 3)}
    lap = cv2.Laplacian(cv2.GaussianBlur(core, (0, 0), 0.8), cv2.CV_32F)
    mask = (core > 12) & (core < 243)
    # edge energy relative to local contrast, so a darker exposure of a sharp slide still scores high
    sharp = float(np.abs(lap[mask]).mean() / (lit.std() + 1e-3))
    return {"sharp": round(sharp, 4), "clipped": round(float(clipped), 3)}


BLURRY = 0.6  # below this share of the stack's sharpest scan, a scan is left out
CLIPPED = 0.85


def weak_scans(q: list[dict]) -> dict[int, str]:
    """Which scans of a bracket to leave out, and why ("blurry" / "clipped"). Always keeps one."""
    if len(q) < 2:
        return {}
    best = max(x["sharp"] for x in q) or 1
    out = {}
    for i, x in enumerate(q):
        if x["clipped"] > CLIPPED:
            out[i] = "clipped"
        elif x["sharp"] < BLURRY * best:
            out[i] = "blurry"
    if len(out) == len(q):
        keep = max(range(len(q)), key=lambda i: q[i]["sharp"])
        out.pop(keep)
    return out


# --------------------------------------------------------------------------- rotation

_MODEL = str(Path(__file__).parent / "models" / "face_detection_yunet_2023mar.onnx")
_detector = None
_detector_lock = threading.Lock()  # one network, used by imports and the background helper


def rotate_arr(a: np.ndarray, rot: int) -> np.ndarray:
    """Rotate clockwise by rot degrees (0/90/180/270)."""
    k = {0: 0, 90: 3, 180: 2, 270: 1}[rot % 360]
    return np.ascontiguousarray(np.rot90(a, k))


def _faces_in(bgr: np.ndarray) -> np.ndarray:
    """YuNet on a uint8 BGR image: rows of (x, y, w, h, 5 landmarks x/y, score)."""
    global _detector
    with _detector_lock:
        if _detector is None:
            _detector = cv2.FaceDetectorYN.create(_MODEL, "", (320, 320), 0.6, 0.3, 5000)
        _detector.setInputSize((bgr.shape[1], bgr.shape[0]))
        _, faces = _detector.detect(bgr)
    return np.zeros((0, 15), np.float32) if faces is None else faces


def _face_frame(rgb: np.ndarray) -> np.ndarray:
    """What the detector looks at: the picture 800 px wide, uint8 BGR."""
    small = cv2.resize(rgb, (800, int(800 * rgb.shape[0] / rgb.shape[1])), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor((small * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)


def face_votes(rgb: np.ndarray) -> dict[int, float]:
    """Sum of confident face scores found at each candidate rotation."""
    bgr = _face_frame(rgb)
    votes = {}
    for r in (0, 90, 180, 270):
        faces = _faces_in(rotate_arr(bgr, r))
        votes[r] = float(sum(f[14] for f in faces if f[14] >= 0.7))
    return votes


def detect_faces(rgb: np.ndarray) -> np.ndarray:
    """Faces in a picture as it stands (upright), found like face_votes does, in the picture's own
    pixel coordinates: rows of (x, y, w, h, right eye, left eye, nose, mouth corners, score)."""
    bgr = _face_frame(rgb)
    faces = _faces_in(bgr).copy()
    sx, sy = rgb.shape[1] / bgr.shape[1], rgb.shape[0] / bgr.shape[0]
    faces[:, 0:14:2] *= sx
    faces[:, 1:14:2] *= sy
    return faces


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


def load_full(path: str) -> np.ndarray:
    """A scan at full resolution for fuse(): uint8 for a JPEG, float32 0..1 for a camera RAW (its 16
    bits go into the pipeline's float without an 8-bit step; a bracket of RAWs is fused in 8 bits
    like JPEGs, since Mertens works on 8-bit exposures)."""
    return raw.decode(path) if raw.is_raw(path) else load_u8(path)


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
    # point curves per channel: {"rgb"|"r"|"g"|"b": [[x, y], ...]} in 0..1; a missing channel is straight
    curves: dict = field(default_factory=dict)
    angle: float = 0.0  # straighten, degrees clockwise (-15..15), zoomed in so no corners show
    crop: list | None = None  # [left, top, right, bottom] in 0..1 of the straightened frame
    dust: float = 0.0  # dust & scratch repair 0..1 (0 = off)
    mould: float = 0.0  # mould repair 0..1 (0 = off)
    newton: float = 0.0  # Newton ring removal 0..1 (0 = off)
    # local adjustments (graduated / radial / brush masks with their own sliders), see clean_local
    local: list = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict | None) -> "Params":
        p = cls()
        for k, v in (d or {}).items():
            if k == "curves":
                p.curves = clean_curves(v)
            elif k == "crop":
                p.crop = clean_crop(v)
            elif k in ("dust", "mould", "newton"):
                setattr(p, k, min(1.0, max(0.0, float(v))))
            elif k == "local":
                p.local = clean_local(v)
            elif hasattr(p, k):
                setattr(p, k, type(getattr(p, k))(v))
        return p

    def to_dict(self) -> dict:
        return asdict(self)


RESTORE_MED_MAX = 0.999  # auto_restore: a channel median at white counts as this
RESTORE_GAMMA = (0.25, 4.0)  # auto_restore: the midtone gamma stays within these


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
    # a flat channel (an empty, white frame) has no range to stretch: leave its levels alone
    flat = H - L < 1e-3
    L, H = np.where(flat, 0, L), np.where(flat, 1, H)
    b = np.clip((a - L) / np.maximum(H - L, 1e-3), 0, 1)
    sb = np.clip((s - L) / np.maximum(H - L, 1e-3), 1e-4, 1)
    # A blown-out channel (over half the picture at white, e.g. a scan ~1.8x over-exposed) has a
    # median of 1, whose log is 0: keep it just below 1 and bound the gamma, so such a channel is
    # pulled down as hard as grey-world ever pulls one (4) instead of turning to NaN / inf, and a
    # scan blown in every channel keeps gamma 1 (levels only: there is nothing left to balance).
    med = np.minimum(np.median(sb, 0), RESTORE_MED_MAX)
    tgt = np.exp(np.log(med).mean())
    g = np.clip(1 + (np.log(tgt) / np.log(med) - 1) * strength, *RESTORE_GAMMA)
    out = b ** g.astype(np.float32)
    Hb = np.percentile(s[:, 2], 99.6)
    mask = np.clip((a[..., 2] - (Hb - 0.10)) / 0.08, 0, 1).astype(np.float32)
    mask = cv2.GaussianBlur(mask, (0, 0), 3) * strength
    out[..., 2] = np.maximum(out[..., 2], out[..., 2] * (1 - mask) + out[..., :2].max(2) * mask * 0.98)
    return out


def trim_borders(a: np.ndarray, max_frac: float = 0.05) -> np.ndarray:
    """Remove dark mount edges (rows/cols that are much darker than the picture)."""
    t, b, l, r = trim_bounds(a, max_frac)
    return a[t:b, l:r]


def trim_bounds(a: np.ndarray, max_frac: float = 0.05) -> tuple[int, int, int, int]:
    """(top, bottom, left, right) slice bounds that trim_borders keeps."""
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
    return t, h - b, l, w - r


# --------------------------------------------------------------------------- mount detection

MOUNT_EDGE = 800  # the mount is found on the scan shrunk to this (longer edge)
MOUNT_BAND = 0.2  # its inner edge is looked for this far in from each side of the scan
MOUNT_SUGGEST = 0.5  # confidence from which "Straighten to mount" is offered
MOUNT_AUTO = 0.8  # confidence from which an import straightens a new slide by itself
MOUNT_INSET = 0.005  # a tighter trim cuts this much (of the frame) inside the mount's edge


def shrink(a: np.ndarray, edge: int) -> np.ndarray:
    """Area-average down so the longer edge is at most `edge` (rounding half up, like the ports)."""
    h, w = a.shape[:2]
    if max(h, w) <= edge:
        return a
    s = edge / max(h, w)
    return cv2.resize(a, (max(1, int(w * s + 0.5)), max(1, int(h * s + 0.5))), interpolation=cv2.INTER_AREA)


def _edge_crossings(prof: np.ndarray, thr: float) -> np.ndarray:
    """Per column of `prof` (rows run from the scan's border inwards): where it first rises through
    `thr` for good (three samples in a row), sub-pixel, in pixels from the border. NaN where the
    column doesn't start on the mount or never leaves it."""
    above = prof >= thr
    ok = above[:-2] & above[1:-1] & above[2:]
    found = ok.any(0) & ~above[0]
    i = np.maximum(np.argmax(ok, 0), 1)
    cols = np.arange(prof.shape[1])
    lo, hi = prof[i - 1, cols].astype(np.float64), prof[i, cols].astype(np.float64)
    pos = i - 1 + (thr - lo) / np.maximum(hi - lo, 1e-6) + 0.5
    return np.where(found, pos, np.nan)


def _robust_line(u: np.ndarray, v: np.ndarray) -> tuple[float, float, int] | None:
    """v = a + b u through the points, refitted four times without the ones far off the line (a
    corner of the picture, a dark patch touching the mount). Returns (a, b, points kept)."""
    keep = np.isfinite(v)
    u, v = u[keep].astype(np.float64), v[keep].astype(np.float64)
    inl = np.ones(len(u), bool)
    a0 = b = 0.0
    for _ in range(4):
        if inl.sum() < 10:
            return None
        uu, vv = u[inl], v[inl]
        um, vm = uu.mean(), vv.mean()
        b = float(((uu - um) * (vv - vm)).sum() / max(((uu - um) ** 2).sum(), 1e-9))
        a0 = float(vm - b * um)
        r = np.abs(v - (a0 + b * u))
        inl = r <= max(0.5, 3 * 1.4826 * float(np.median(r[inl])))
    return a0, b, int(inl.sum())


def detect_mount(a: np.ndarray) -> dict:
    """The slide mount's inner edge: how far it is turned, and where its four sides are.

    The mount is the dark frame around the picture. Every column (row) in the middle 80 % of each
    side is followed inwards from the scan's border to where it leaves the mount's darkness; a
    straight line through those points (robust to the picture's own dark bits) is that side of the
    window. Returns {"angle": degrees clockwise the picture is turned (straighten by -angle),
    "confidence": 0..1, "box": [l, t, r, b]} with each side's middle in 0..1 of the scan (None
    where that side wasn't found). Confidence needs at least two sides that agree on the angle."""
    s = shrink(a, MOUNT_EDGE)
    lum = s.mean(2, dtype=np.float32) if s.ndim == 3 else s
    h, w = lum.shape
    none = {"angle": 0.0, "confidence": 0.0, "box": [None, None, None, None]}
    m = max(1, int(min(h, w) * 0.01))
    ring = np.concatenate([lum[:m].ravel(), lum[h - m :].ravel(), lum[m : h - m, :m].ravel(),
                           lum[m : h - m, w - m :].ravel()])
    mount = float(np.median(ring))
    ref = float(np.median(lum[h // 4 : h - h // 4, w // 4 : w - w // 4]))
    if mount > 0.25 or ref - mount < 0.08:
        return none  # no dark frame around a brighter picture
    thr = mount + min(0.1, max(0.03, 0.3 * (ref - mount)))
    bh, bw = max(4, int(h * MOUNT_BAND)), max(4, int(w * MOUNT_BAND))
    x0, y0 = int(w * 0.1), int(h * 0.1)
    ux = np.arange(x0, w - x0) + 0.5
    uy = np.arange(y0, h - y0) + 0.5
    sides = {  # (positions along the side, edge positions across it, samples)
        "top": (ux, _edge_crossings(lum[:bh, x0 : w - x0], thr)),
        "bottom": (ux, h - _edge_crossings(lum[::-1][:bh, x0 : w - x0], thr)),
        "left": (uy, _edge_crossings(lum[y0 : h - y0, :bw].T, thr)),
        "right": (uy, w - _edge_crossings(lum[y0 : h - y0, ::-1][:, :bw].T, thr)),
    }
    found, total = {}, 0
    for name, (u, v) in sides.items():
        total += len(u)
        fit = _robust_line(u, v)
        if fit and fit[2] >= max(20, 0.35 * len(u)):
            found[name] = fit
    if len(found) < 2:
        return none
    ang = {k: float(np.degrees(np.arctan(b))) * (1 if k in ("top", "bottom") else -1) for k, (_, b, _) in found.items()}
    n = {k: f[2] for k, f in found.items()}
    angle = sum(ang[k] * n[k] for k in found) / sum(n.values())
    spread = max(abs(ang[k] - angle) for k in found)
    conf = max(0.0, 1 - spread / 0.5) * min(1.0, sum(n.values()) / total / 0.6) * (1.0 if len(found) >= 3 else 0.8)
    if abs(angle) > 10:
        conf = 0.0
    mid = lambda k, c, size: round((found[k][0] + found[k][1] * c) / size, 4) if k in found else None  # noqa: E731
    box = [mid("left", h / 2, w), mid("top", w / 2, h), mid("right", h / 2, w), mid("bottom", w / 2, h)]
    return {"angle": round(angle, 2), "confidence": round(conf, 2), "box": box}


def rotate_box(box: list, rot: int) -> list:
    """A mount box [l, t, r, b] (0..1, None = not found) of a scan turned clockwise by `rot`."""
    for _ in range((rot % 360) // 90):
        l, t, r, b = box
        box = [None if b is None else round(1 - b, 4), l, None if t is None else round(1 - t, 4), r]
    return box


def mount_crop(a: np.ndarray, p: Params, box: list) -> list | None:
    """The crop that trims to the mount's window once the photo is straightened by p.angle.

    `a` is the (turned) scan the slide develops from and `box` its mount sides (rotate_box). Each
    side's middle goes through the same trim and straighten as develop(), and the crop sits
    MOUNT_INSET inside it; sides not found stay at the frame's edge."""
    h, w = a.shape[:2]
    t0, b0, l0, r0 = trim_bounds(auto_restore(a, p.strength)) if p.trim else (0, h, 0, w)
    fw, fh = r0 - l0, b0 - t0
    th = np.deg2rad(p.angle) if abs(p.angle) >= 0.01 else 0.0  # straighten() leaves tiny angles alone
    scale = np.cos(abs(th)) + np.sin(abs(th)) * max(fw, fh) / min(fw, fh)
    cs, sn = np.cos(th), np.sin(th)

    def place(x: float, y: float) -> tuple[float, float]:
        """A point (continuous coordinates of `a`) in 0..1 of the straightened frame."""
        dx, dy = x - 0.5 - l0 - fw / 2, y - 0.5 - t0 - fh / 2  # pixel-index coordinates, as warpAffine
        return (fw / 2 + scale * (cs * dx - sn * dy) + 0.5) / fw, (fh / 2 + scale * (sn * dx + cs * dy) + 0.5) / fh

    l, t, r, b = box
    out = [0.0, 0.0, 1.0, 1.0]
    if l is not None:
        out[0] = place(l * w, h / 2)[0] + MOUNT_INSET
    if t is not None:
        out[1] = place(w / 2, t * h)[1] + MOUNT_INSET
    if r is not None:
        out[2] = place(r * w, h / 2)[0] - MOUNT_INSET
    if b is not None:
        out[3] = place(w / 2, b * h)[1] - MOUNT_INSET
    return clean_crop(out)


# --------------------------------------------------------------------------- dust & scratches

DUST_EDGE = 1600  # specks are found at proxy scale: a full-resolution scan is shrunk to this first
DUST_PASSES = 8


def _box_count(m: np.ndarray, rad: int) -> tuple[np.ndarray, np.ndarray]:
    """Per pixel: set pixels of `m` in the (2 rad + 1)² window around it, and that window's area
    (both clipped to the image). Exact integers, so every port agrees."""
    h, w = m.shape
    ii = np.zeros((h + 1, w + 1), np.int64)
    ii[1:, 1:] = m.astype(np.int64).cumsum(0).cumsum(1)
    y, x = np.arange(h), np.arange(w)
    y0, y1 = np.clip(y - rad, 0, h), np.clip(y + rad + 1, 0, h)
    x0, x1 = np.clip(x - rad, 0, w), np.clip(x + rad + 1, 0, w)
    cnt = ii[y1][:, x1] - ii[y0][:, x1] - ii[y1][:, x0] + ii[y0][:, x0]
    return cnt, (y1 - y0)[:, None] * (x1 - x0)[None, :]


def dust_mask(a: np.ndarray, amount: float) -> tuple[np.ndarray, int]:
    """Dust specks and thin scratches: small bright or dark marks a morphological opening / closing
    (a (2r + 1)² square, r scaled with the image) takes away — the top-hats — with more contrast
    than `amount` asks for. Marks where more than a fifth of the neighbourhood responds are texture
    (grass, grain, water), not dust, and stay. Grown by a pixel to catch each speck's soft rim.
    Returns (mask, r)."""
    lum = a[..., 0] * np.float32(0.299) + a[..., 1] * np.float32(0.587) + a[..., 2] * np.float32(0.114)
    r = max(1, int(3 * max(lum.shape) / DUST_EDGE + 0.5))
    k = np.ones((2 * r + 1, 2 * r + 1), np.uint8)
    hat = np.maximum(lum - cv2.dilate(cv2.erode(lum, k), k), cv2.erode(cv2.dilate(lum, k), k) - lum)
    m = hat > np.float32(0.25 - 0.19 * amount)
    cnt, area = _box_count(m, 4 * r)
    m &= cnt * 5 <= area
    return cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool), r


def repair_dust(a: np.ndarray, amount: float, inplace: bool = False) -> np.ndarray:
    """Find dust and scratches (dust_mask, at proxy scale) and fill them in from around them.

    Each marked pixel becomes the per-channel median of the unmarked pixels in the window around
    it; pixels with none (the middle of a larger mark) wait for the next pass, which can use the
    ones filled before it. Simple on purpose: the three pipelines give the same result. At full
    resolution the window keeps the proxy's number of samples, spaced a proxy pixel apart."""
    if amount <= 0:
        return a
    h, w = a.shape[:2]
    m, r = dust_mask(shrink(a, DUST_EDGE), amount)
    if not m.any():
        return a
    out = a if inplace else a.copy()
    mh, mw = m.shape
    if (mh, mw) != (h, w):  # full resolution: every pixel takes its proxy pixel's verdict
        ys = np.minimum(((np.arange(h) + 0.5) * mh / h).astype(np.int64), mh - 1)
        xs = np.minimum(((np.arange(w) + 0.5) * mw / w).astype(np.int64), mw - 1)
        m = m[ys][:, xs]
    # the window: (2r + 3)² samples around the pixel, spread out as far as the proxy's pixels are
    f = max(h, w) / max(mh, mw)
    off = np.array([(1 if k >= 0 else -1) * int(abs(k) * f + 0.5) for k in range(-r - 1, r + 2)])
    _median_fill(out, ~m, *np.nonzero(m), off, DUST_PASSES)
    return out


def _median_fill(out: np.ndarray, known: np.ndarray, ys: np.ndarray, xs: np.ndarray, off, passes: int):
    """Fill pixels (ys, xs) of `out` in place with the per-channel median of the known pixels among
    the samples at `off` × `off` around each; pixels with none wait for the next pass, which can
    use the ones filled before it. Returns the pixels still unfilled after `passes`."""
    h, w = known.shape
    dy, dx = (g.ravel() for g in np.meshgrid(off, off, indexing="ij"))
    for _ in range(passes):
        if not len(ys):
            break
        vals = np.empty((len(ys), 3), np.float32)
        for s in range(0, len(ys), 2048):
            yy, xx = ys[s : s + 2048, None] + dy, xs[s : s + 2048, None] + dx
            inside = (yy >= 0) & (yy < h) & (xx >= 0) & (xx < w)
            yy, xx = np.clip(yy, 0, h - 1), np.clip(xx, 0, w - 1)
            win = np.where((inside & known[yy, xx])[..., None], out[yy, xx], np.float32(np.nan))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN windows: next pass
                vals[s : s + 2048] = np.nanmedian(win, 1)
        done = ~np.isnan(vals[:, 0])
        out[ys[done], xs[done]] = vals[done]  # a pass reads only pixels known before it
        known[ys[done], xs[done]] = True
        ys, xs = ys[~done], xs[~done]
    return ys, xs


def _verdicts(m: np.ndarray, h: int, w: int) -> np.ndarray:
    """A proxy-scale mask at h x w: every pixel takes its proxy pixel's verdict."""
    mh, mw = m.shape
    if (mh, mw) == (h, w):
        return m
    ys = np.minimum(((np.arange(h) + 0.5) * mh / h).astype(np.int64), mh - 1)
    xs = np.minimum(((np.arange(w) + 0.5) * mw / w).astype(np.int64), mw - 1)
    return m[ys][:, xs]


def _bilinear_axis(n: int, sn: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For each of n pixels, the two of sn grid centres around it and the weight of the second:
    grid over the same span, clamped at the ends."""
    u = (np.arange(n) + 0.5) * sn / n - 0.5
    i0 = np.clip(np.floor(u), 0, sn - 1).astype(np.int64)
    return i0, np.minimum(i0 + 1, sn - 1), np.clip(u - i0, 0, 1)


def _bilinear_at(src: np.ndarray, ys: np.ndarray, xs: np.ndarray, h: int, w: int) -> np.ndarray:
    """float64 values of `src` (a coarser grid over the same frame) at pixels (ys, xs) of an
    h x w image: bilinear between the grid's centres, clamped at the edges. At src's own size, src.
    Along rows first, then down: (a (1 - fx) + b fx) (1 - fy) + (c (1 - fx) + d fx) fy."""
    x0, x1, fx = (v[xs] for v in _bilinear_axis(w, src.shape[1]))
    y0, y1, fy = (v[ys] for v in _bilinear_axis(h, src.shape[0]))
    if src.ndim == 3:
        fx, fy = fx[:, None], fy[:, None]
    s = src.astype(np.float64)
    return (s[y0, x0] * (1 - fx) + s[y0, x1] * fx) * (1 - fy) + (s[y1, x0] * (1 - fx) + s[y1, x1] * fx) * fy


def _upsample(src: np.ndarray, h: int, w: int, top: int = 0, bottom: int | None = None) -> np.ndarray:
    """Rows top..bottom of `src` brought to h x w: _bilinear_at for every pixel (the same sums)."""
    x0, x1, fx = _bilinear_axis(w, src.shape[1])
    y0, y1, fy = (v[top:bottom] for v in _bilinear_axis(h, src.shape[0]))
    s = src.astype(np.float64)
    if src.ndim == 3:
        fx, fy = fx[:, None], fy[:, None, None]
    else:
        fy = fy[:, None]
    across = s[:, x0] * (1 - fx) + s[:, x1] * fx
    return across[y0] * (1 - fy) + across[y1] * fy


# --------------------------------------------------------------------------- mould

MOULD_CELLS = 9  # the picture under the mould: the median of this many cells (4r px each) across
MOULD_LONG = 40  # × r: the longest colony, in proxy pixels (120 at 1600 px, ~2.7 mm of the film)
MOULD_PASSES = 6


def _mould_background(q: np.ndarray, cell: int) -> np.ndarray:
    """The picture without its mould, per channel and ×9 (like the 3×3 sums it is compared with):
    the lower median of the MOULD_CELLS² cell means around each cell, bilinear between cells.
    Cell means are integers, so the medians are the same in every port."""
    h, w = q.shape[:2]
    gh, gw = -(-h // cell), -(-w // cell)
    ii = np.zeros((h + 1, w + 1, 3), np.int64)
    ii[1:, 1:] = q.astype(np.int64).cumsum(0).cumsum(1)
    y0, x0 = np.arange(gh) * cell, np.arange(gw) * cell
    y1, x1 = np.minimum(y0 + cell, h), np.minimum(x0 + cell, w)
    sums = ii[y1][:, x1] - ii[y0][:, x1] - ii[y1][:, x0] + ii[y0][:, x0]
    cells = sums * 9 // ((y1 - y0)[:, None] * (x1 - x0)[None, :])[..., None]
    k = MOULD_CELLS // 2
    big = np.int64(1) << 40  # outside the picture: sorts last, never the median
    pad = np.pad(cells, ((k, k), (k, k), (0, 0)), constant_values=big)
    win = np.lib.stride_tricks.sliding_window_view(pad, (MOULD_CELLS, MOULD_CELLS), (0, 1))
    win = np.sort(win.reshape(gh, gw, 3, -1), -1)
    n = (win < big).sum(-1)
    med = np.take_along_axis(win, ((n - 1) // 2)[..., None], -1)[..., 0]
    return _upsample(med, gh * cell, gw * cell, 0, h)[:, :w]


def _find_mould(a: np.ndarray, amount: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Mould: fungus grown on the film — lighter or darker blotches and branching filaments, a few
    proxy pixels thick and up to a few mm long, often with a coloured rim.

    Found in integers (the proxy at 8 bits), so every port marks the same pixels: where any
    channel's 3×3 sum differs from the picture without its mould (_mould_background) by more than
    `amount` asks, the pixel is a candidate. Connected candidates (8-neighbours) count as mould only
    when they look like it: bigger than dust, at most MOULD_LONG × r long, and filling little of
    their bounding box (branching, filament-like, ragged). Picture detail joins up into shapes too
    long or too solid for that — a tree's twigs reach its branches and trunk — and stays. Grown by
    r / 2 for the soft rims. Returns (mask, all candidates, background ×9, r)."""
    q = (np.clip(a, 0, 1) * np.float32(255) + np.float32(0.5)).astype(np.int64)
    h, w = q.shape[:2]
    r = max(1, int(3 * max(h, w) / DUST_EDGE + 0.5))
    pad = np.pad(q, ((1, 1), (1, 1), (0, 0)), mode="edge")
    s9 = sum(pad[dy : dy + h, dx : dx + w] for dy in range(3) for dx in range(3))
    bg = _mould_background(q, 4 * r)
    dev = np.abs(s9 - bg).max(-1)
    thr = 9 * (30 - 18 * amount)
    _, labels, st, _ = cv2.connectedComponentsWithStats((dev > thr / 2).astype(np.uint8), connectivity=8)
    bw, bh, area = (st[:, k].astype(np.int64) for k in (cv2.CC_STAT_WIDTH, cv2.CC_STAT_HEIGHT, cv2.CC_STAT_AREA))
    strong = np.zeros(len(area), bool)
    strong[labels[dev > thr]] = True
    keep = strong & (area >= 3 * r * r) & (np.maximum(bw, bh) <= MOULD_LONG * r)
    keep &= area * 100 <= bw * bh * int(35 + 20 * amount)
    keep[0] = False  # the background label
    g = max(1, int(r / 2 + 0.5))
    m = cv2.dilate(keep[labels].astype(np.uint8), np.ones((2 * g + 1, 2 * g + 1), np.uint8)).astype(bool)
    return m, labels > 0, bg, r


def mould_mask(a: np.ndarray, amount: float) -> tuple[np.ndarray, int]:
    """(mask, r): the mould _find_mould keeps."""
    m, _, _, r = _find_mould(a, amount)
    return m, r


def repair_mould(a: np.ndarray, amount: float, inplace: bool = False) -> np.ndarray:
    """Find mould (mould_mask, at proxy scale) and paint it out without leaving flat patches.

    Low frequencies from around the mark: the per-channel median of the unmarked proxy pixels on a
    9 × 9 grid r apart, pass by pass as in the dust fill, and the background where that finds
    nothing. Grain from the first clean spot 6r or 12r away round the compass: its pixel minus its
    local mean, so the fill carries the film's own grain. At full resolution the low frequencies
    are the proxy's (bilinear) and the grain is the full-resolution picture's."""
    if amount <= 0:
        return a
    h, w = a.shape[:2]
    small = shrink(a, DUST_EDGE)
    m, busy, bg, r = _find_mould(small, amount)
    if not m.any():
        return a
    mh, mw = m.shape
    busy |= m  # samples and grain come from clean picture only, not from mould left alone
    low = small.copy()
    ly, lx = _median_fill(low, ~busy, *np.nonzero(m), np.arange(-4, 5) * r, MOULD_PASSES)
    low[ly, lx] = (bg[ly, lx] / (9 * 255)).astype(np.float32)
    mask, busy = _verdicts(m, h, w), _verdicts(busy, h, w)
    ys, xs = np.nonzero(mask)
    val = _bilinear_at(low, ys, xs, h, w)
    f = max(h, w) / max(mh, mw)
    qy, qx, found = ys.copy(), xs.copy(), np.zeros(len(ys), bool)
    for d in (6 * r, 12 * r):
        d = int(d * f + 0.5)
        for sy, sx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            cy, cx = ys + sy * d, xs + sx * d
            i = np.nonzero(~found & (cy >= 0) & (cy < h) & (cx >= 0) & (cx < w))[0]
            i = i[~busy[cy[i], cx[i]]]
            qy[i], qx[i], found[i] = cy[i], cx[i], True
    # its grain: the pixel minus the mean of the (2g + 1)² around it, g a proxy pixel
    g = max(1, int(f + 0.5))
    i = np.nonzero(found)[0]
    mean = np.zeros((len(i), 3))
    for dy in range(-g, g + 1):
        yy = np.clip(qy[i] + dy, 0, h - 1)
        for dx in range(-g, g + 1):
            mean += a[yy, np.clip(qx[i] + dx, 0, w - 1)]
    val[i] += a[qy[i], qx[i]] - mean / ((2 * g + 1) ** 2)
    out = a if inplace else a.copy()
    out[ys, xs] = np.clip(val, 0, 1)
    return out


# --------------------------------------------------------------------------- Newton rings

NEWTON_EDGE = 1600


def _box(a: np.ndarray, r: int) -> np.ndarray:
    """float64 mean over the (2r + 1)² window, clipped to the image (so the window's own area).
    The ports use running sums along rows then columns; OpenCV adds in another order, which
    changes the last bits only (~1e-15)."""
    h, w = a.shape[:2]
    s = cv2.boxFilter(np.ascontiguousarray(a, np.float64), -1, (2 * r + 1, 2 * r + 1), normalize=False,
                      borderType=cv2.BORDER_CONSTANT)
    i, j = np.arange(h), np.arange(w)
    ny = np.minimum(i + r + 1, h) - np.maximum(i - r, 0)
    nx = np.minimum(j + r + 1, w) - np.maximum(j - r, 0)
    n = (ny[:, None] * nx[None, :]).astype(np.float64)
    return s / (n[..., None] if a.ndim == 3 else n)


def _blur(a: np.ndarray, r: int) -> np.ndarray:
    """Two box means over (2r + 1)²: close to a Gaussian."""
    return _box(_box(a, r), r)


def _smoothstep(x: np.ndarray, e0: float, e1: float) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def newton_weight(a: np.ndarray, amount: float) -> tuple[np.ndarray, np.ndarray]:
    """Newton rings: interference fringes where the film touches the glass of the mount — faint,
    rainbow-coloured, concentric, their period changing slowly across the frame.

    Spatial, not an FFT: the period changes across the rings (a notch would need an FFT per tile,
    and a radix-2 FFT in three ports), while a band-pass and a few local statistics of it find them
    wherever they are. The band is two blurs apart (grain below, the picture's broad shapes above).
    Rings are where that band, smoothed a little more, is (1) narrow-band — one frequency locally,
    so its gradient energy squared equals its energy times its Laplacian energy (the ratio is ~1
    for a sinusoid, ~0.3 for an edge's or grain's broad spectrum); (2) oriented — one direction
    dominating its structure tensor; (3) faint — above the grain, well below real edges and
    stripes. Returns (weight 0..1 per pixel, the band per channel), both float64."""
    x = a.astype(np.float64)
    h, w = x.shape[:2]
    s = max(h, w) / NEWTON_EDGE
    r1, r2, r3 = int(s + 0.5), max(2, int(14 * s + 0.5)), max(3, int(20 * s + 0.5))  # r1 0: no blur
    band = _blur(x, r1) - _blur(x, r2)
    b = _blur(band, max(1, 2 * r1))
    pb = np.pad(b, ((1, 1), (1, 1), (0, 0)), mode="edge")  # neighbours, the edge repeated
    xp, xm, yp, ym = pb[1:-1, 2:], pb[1:-1, :-2], pb[2:, 1:-1], pb[:-2, 1:-1]
    gx, gy = (xp - xm) * 0.5, (yp - ym) * 0.5
    lap = xp + xm + yp + ym - 4 * b

    def energy(u, v):  # summed over the channels, blurred over the neighbourhood
        return _blur(u[..., 0] * v[..., 0] + u[..., 1] * v[..., 1] + u[..., 2] * v[..., 2], r3)

    e0, e2 = energy(b, b), energy(lap, lap)
    jxx, jyy, jxy = energy(gx, gx), energy(gy, gy), energy(gx, gy)
    e1 = jxx + jyy
    narrow = e1 * e1 / (e0 * e2 + 1e-30)
    coh = ((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy) / (e1 * e1 + 1e-30)
    amp = np.sqrt(e0)
    n0, c0, a1 = 0.6 - 0.15 * amount, 0.5 - 0.25 * amount, 0.02 + 0.04 * amount
    wgt = (_smoothstep(narrow, n0, n0 + 0.15) * _smoothstep(coh, c0, c0 + 0.25)
           * _smoothstep(amp, 0.001, 0.003) * (1 - _smoothstep(amp, a1, 2 * a1)))
    return wgt, band


def repair_newton(a: np.ndarray, amount: float, inplace: bool = False) -> np.ndarray:
    """Take the ring band out where newton_weight finds rings (at proxy scale; the band is smooth,
    so at full resolution the proxy's correction is laid on bilinear)."""
    if amount <= 0:
        return a
    h, w = a.shape[:2]
    small = shrink(a, NEWTON_EDGE)
    wgt, band = newton_weight(small, amount)
    corr = -wgt[..., None] * band
    out = a if inplace else a.copy()
    if corr.shape[:2] == (h, w):
        out[:] = np.clip(a + corr, 0, 1)
        return out
    for y in range(0, h, 256):  # in strips: a float64 correction at full size would be 360 MB
        rows = _upsample(corr, h, w, y, y + 256)
        out[y : y + len(rows)] = np.clip(a[y : y + len(rows)] + rows, 0, 1)
    return out


# --------------------------------------------------------------------------- tone curves

CURVE_CHANNELS = ("rgb", "r", "g", "b")
LUT_SIZE = 1024


def clean_curves(d) -> dict:
    """Validate curves from the UI: sorted points in 0..1, distinct x, straight lines dropped."""
    out = {}
    for ch in CURVE_CHANNELS:
        pts = (d or {}).get(ch) if isinstance(d, dict) else None
        if not isinstance(pts, (list, tuple)):
            continue
        clean: list[list[float]] = []
        for pt in sorted((min(1.0, max(0.0, float(x))), min(1.0, max(0.0, float(y)))) for x, y in pts[:16]):
            if clean and pt[0] - clean[-1][0] < 0.004:
                continue  # two points on one input value: keep the first
            clean.append([round(pt[0], 4), round(pt[1], 4)])
        if len(clean) >= 2 and clean != [[0.0, 0.0], [1.0, 1.0]]:
            out[ch] = clean
    return out


def curve_lut(pts: list[list[float]], n: int = LUT_SIZE) -> np.ndarray:
    """Monotone cubic (Fritsch-Carlson) through the points, flat beyond the end points, as a LUT.

    Monotone so dragging a point never makes the curve overshoot and invert tones. The UI draws
    the same spline (frontend/src/lib/curves.ts)."""
    xs = np.array([p[0] for p in pts], np.float64)
    ys = np.array([p[1] for p in pts], np.float64)
    t = np.linspace(0, 1, n)
    if len(xs) == 2:
        return np.clip(np.interp(t, xs, ys), 0, 1).astype(np.float32)
    h = np.diff(xs)
    d = np.diff(ys) / h
    m = np.empty_like(xs)
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, len(xs) - 1):
        m[i] = 0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2
    for i in range(len(d)):
        if d[i] == 0:
            m[i] = m[i + 1] = 0.0
            continue
        a, b = m[i] / d[i], m[i + 1] / d[i]
        r = a * a + b * b
        if r > 9:
            k = 3 / np.sqrt(r)
            m[i], m[i + 1] = k * a * d[i], k * b * d[i]
    i = np.clip(np.searchsorted(xs, t, side="right") - 1, 0, len(xs) - 2)
    u = np.clip((t - xs[i]) / h[i], 0, 1)
    h00, h10, h01, h11 = 2 * u**3 - 3 * u**2 + 1, u**3 - 2 * u**2 + u, -2 * u**3 + 3 * u**2, u**3 - u**2
    y = h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1]
    y = np.where(t <= xs[0], ys[0], np.where(t >= xs[-1], ys[-1], y))
    return np.clip(y, 0, 1).astype(np.float32)


def apply_curves(a: np.ndarray, curves: dict) -> np.ndarray:
    """Per-channel curves first (they fix the cast), then the RGB curve on all three."""
    if not curves:
        return a
    out = a
    idx = lambda x: np.clip(x * (LUT_SIZE - 1) + 0.5, 0, LUT_SIZE - 1).astype(np.int32)
    chans = [c for c in ("r", "g", "b") if c in curves]
    if chans:
        out = out.copy()
        for c in chans:
            k = "rgb".index(c)
            out[..., k] = curve_lut(curves[c])[idx(out[..., k])]
    if "rgb" in curves:
        out = curve_lut(curves["rgb"])[idx(out)]
    return out


def clean_crop(v) -> list | None:
    """[l, t, r, b] in 0..1, at least 5 % each way; the whole frame (or junk) means no crop."""
    try:
        l, t, r, b = (min(1.0, max(0.0, float(x))) for x in v)
    except (TypeError, ValueError):
        return None
    if r - l < 0.05 or b - t < 0.05 or (l <= 0.001 and t <= 0.001 and r >= 0.999 and b >= 0.999):
        return None
    return [round(l, 4), round(t, 4), round(r, 4), round(b, 4)]


def straighten(a: np.ndarray, angle: float) -> np.ndarray:
    """Rotate by a small angle about the centre, zoomed just enough that no empty corner shows."""
    if abs(angle) < 0.01:
        return a
    h, w = a.shape[:2]
    th = np.deg2rad(abs(angle))
    scale = np.cos(th) + np.sin(th) * max(w, h) / min(w, h)
    m = cv2.getRotationMatrix2D((w / 2, h / 2), -angle, scale)
    return cv2.warpAffine(a, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def crop_box(h: int, w: int, crop: list) -> tuple[int, int, int, int]:
    """Rows top..bottom and columns left..right of a straightened h x w frame that `crop` keeps."""
    l, t, r, b = crop
    top, left = int(t * h), int(l * w)
    return top, max(top + 1, int(b * h)), left, max(left + 1, int(r * w))


def geometry(a: np.ndarray, p: Params, crop: bool = True) -> np.ndarray:
    out = straighten(a, p.angle)
    if crop and p.crop:
        t, b, l, r = crop_box(*out.shape[:2], p.crop)
        out = out[t:b, l:r]
    return out


def tone_base(a: np.ndarray, p: Params, crop: bool = True) -> np.ndarray:
    """The image the tone curve works on: auto-restored, trimmed, repaired (dust, mould, Newton
    rings), straightened and cropped. Repairs come after the trim so the mount's edge is never taken
    for damage, and the trim (decided on the restored pixels) stays the one before_view uses."""
    out = auto_restore(a, p.strength)
    if p.trim:
        out = trim_borders(out)
    if p.dust > 0:
        out = repair_dust(out, p.dust, inplace=True)  # out is ours: auto_restore copied
    if p.mould > 0:  # after the dust, so specks don't sit in the mould fill's samples
        out = repair_mould(out, p.mould, inplace=True)
    if p.newton > 0:
        out = repair_newton(out, p.newton, inplace=True)
    return geometry(out, p, crop)


def _inner(a: np.ndarray, frac: float = 0.03) -> np.ndarray:
    h, w = a.shape[:2]
    m = int(min(h, w) * frac)
    return a[m : h - m or None, m : w - m or None]


HIST_BINS = 128


def histogram(a: np.ndarray) -> dict:
    """Per-channel histograms of the curve's input (away from the edges), for drawing behind it."""
    s = cv2.resize(_inner(a), (360, int(360 * a.shape[0] / a.shape[1])), interpolation=cv2.INTER_AREA)
    flat = s.reshape(-1, 3)
    out = {}
    for k, c in enumerate("rgb"):
        out[c] = np.histogram(flat[:, k], HIST_BINS, (0, 1))[0].tolist()
    out["lum"] = np.histogram(flat @ np.array([0.299, 0.587, 0.114], np.float32), HIST_BINS, (0, 1))[0].tolist()
    return out


def fit_curves(a: np.ndarray, curves: dict, clip: float = 0.1) -> dict:
    """Pull each colour channel's end points in to where its data actually starts and ends.

    Faded film leaves every channel squeezed into its own narrow band, each at a different place:
    stretching them separately brings back blacks, whites and neutral colour. `clip` is the
    percentage of pixels allowed to clip at each end. Points already inside the new range stay."""
    s = _inner(a)
    step = max(1, int(np.sqrt(s.shape[0] * s.shape[1] / 250_000)))
    flat = s[::step, ::step].reshape(-1, 3)
    lo = np.percentile(flat, clip, 0)
    hi = np.percentile(flat, 100 - clip, 0)
    out = dict(curves)
    for k, c in enumerate("rgb"):
        l, h = float(lo[k]), float(hi[k])
        if h - l < 0.05:  # a nearly flat channel: stretching would only amplify noise
            continue
        old = curves.get(c) or [[0.0, 0.0], [1.0, 1.0]]
        mid = [pt for pt in old[1:-1] if l < pt[0] < h]
        out[c] = [[l, old[0][1]], *mid, [h, old[-1][1]]]  # output levels (a lifted black) stay
    return clean_curves(out)


def neutral_balance(a: np.ndarray, p: Params, x: float, y: float) -> tuple[float, float]:
    """Warmth and tint that make the spot at (x, y) (0..1 of the developed frame) neutral grey.

    Sampled after restore, trim and curves: exactly what the warmth/tint gammas in develop() act
    on, so solving r^(1-w/4) = b^(1+w/4) = g^(1+t/4) for w and t neutralises it."""
    base = apply_curves(tone_base(a, p), p.curves)
    h, w = base.shape[:2]
    r = max(2, int(min(h, w) * 0.006))
    cx, cy = int(min(max(x, 0), 1) * (w - 1)), int(min(max(y, 0), 1) * (h - 1))
    patch = base[max(0, cy - r) : cy + r + 1, max(0, cx - r) : cx + r + 1].reshape(-1, 3).mean(0)
    lr, lg, lb = np.log(np.clip(patch, 0.02, 0.98))
    warmth = float(np.clip(4 * (lr - lb) / (lr + lb), -1, 1))
    level = lr * (1 - 0.25 * warmth)  # log of where red and blue meet
    tint = float(np.clip(4 * (level / lg - 1), -1, 1))
    return round(warmth, 3), round(tint, 3)


def before_view(a: np.ndarray, p: Params, crop: bool = True) -> np.ndarray:
    """The untouched scan in the developed photo's exact frame (same trim, straighten and crop), so
    before and after line up pixel for pixel in a split view."""
    out = a
    if p.trim:  # trim where the developed image trims, which is decided on the restored pixels
        t, b, l, r = trim_bounds(auto_restore(a, p.strength))
        out = a[t:b, l:r]
    return geometry(out, p, crop)


def develop(a: np.ndarray, p: Params, crop: bool = True) -> np.ndarray:
    """crop=False: everything but the crop, for the crop tool to draw its frame over."""
    base = tone_base(a, p, crop=False)
    h, w = base.shape[:2]  # the picture's frame, which local masks are drawn in (straighten keeps the size)
    t, b, l, r = crop_box(h, w, p.crop) if crop and p.crop else (0, h, 0, w)
    out = apply_curves(base[t:b, l:r], p.curves)
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
    out = np.clip(out, 0, 1).astype(np.float32)
    if p.local:
        apply_local(out, p.local, (w, h), (l, t), p.angle)
    return out


# --------------------------------------------------------------------------- local adjustments

LOCAL_KINDS = ("graduated", "radial", "brush")
LOCAL_SLIDERS = ("exposure", "contrast", "warmth", "tint", "saturation")
LOCAL_MAX = 16  # adjustments per slide
BRUSH_STROKES = 64  # strokes per brush
BRUSH_POINTS = 400  # points per stroke
MASK_EDGE = 1024  # masks are drawn on a grid this many cells along the picture's longer edge
EXPOSURE_STOPS = 1.5  # what a local exposure of ±1 does (see local_look)


def _num(v, lo: float, hi: float, default: float = 0.0) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(x):
        return default
    return round(min(hi, max(lo, x)), 4) + 0.0  # + 0.0: never "-0.0" in the render key


def _point(v) -> list | None:
    """A point in 0..1 of the picture; a little outside is fine (a gradient that starts off it)."""
    try:
        x, y = v
    except (TypeError, ValueError):
        return None
    return [_num(x, -1, 2, 0.5), _num(y, -1, 2, 0.5)]


def clean_local(v) -> list:
    """Validate local adjustments from the UI.

    Each is {"kind", "exposure", "contrast", "warmth", "tint", "saturation"} (-1..1) plus its mask:
    graduated {"start", "end"} (full effect at start, none from end on); radial {"center", "rx",
    "ry", "angle", "feather", "invert"}; brush {"strokes": [{"points", "radius", "hardness", "flow",
    "erase"}]}. Points are 0..1 of the picture — the trimmed, turned scan before straightening — so
    a mask stays on what it covers when the crop or the straighten angle changes. Lengths (rx, ry,
    radius) are fractions of the picture's longer edge, so a circle stays round."""
    out: list = []
    if not isinstance(v, (list, tuple)):
        return out
    for a in v[:LOCAL_MAX]:
        if not isinstance(a, dict) or a.get("kind") not in LOCAL_KINDS:
            continue
        c = {"kind": a["kind"], **{k: _num(a.get(k, 0.0), -1, 1) for k in LOCAL_SLIDERS}}
        if a["kind"] == "graduated":
            c["start"] = _point(a.get("start")) or [0.5, 0.15]
            c["end"] = _point(a.get("end")) or [0.5, 0.55]
        elif a["kind"] == "radial":
            c["center"] = _point(a.get("center")) or [0.5, 0.5]
            c["rx"] = _num(a.get("rx", 0.25), 0.005, 2, 0.25)
            c["ry"] = _num(a.get("ry", 0.25), 0.005, 2, 0.25)
            c["angle"] = _num(a.get("angle", 0.0), -180, 180)
            c["feather"] = _num(a.get("feather", 0.5), 0, 1, 0.5)
            c["invert"] = bool(a.get("invert", False))
        else:
            strokes = []
            for s in a.get("strokes") or []:
                if len(strokes) >= BRUSH_STROKES:
                    break
                if not isinstance(s, dict) or not isinstance(s.get("points"), (list, tuple)):
                    continue
                pts = [q for q in (_point(p) for p in s["points"][:BRUSH_POINTS]) if q]
                if pts:
                    strokes.append({"points": pts, "radius": _num(s.get("radius", 0.05), 0.002, 0.5, 0.05),
                                    "hardness": _num(s.get("hardness", 0.5), 0, 1, 0.5),
                                    "flow": _num(s.get("flow", 1.0), 0, 1, 1.0), "erase": bool(s.get("erase", False))})
            c["strokes"] = strokes
        out.append(c)
    return out


def turn_local(local: list, rot: int) -> list:
    """Local adjustments of a slide turned clockwise by `rot` more degrees, so they stay on the
    picture (a point (x, y) goes to (1 - y, x) per quarter turn, like rotate_box)."""
    k = (rot % 360) // 90
    if not k or not local:
        return local

    def pt(p):
        for _ in range(k):
            p = [round(1 - p[1], 4) + 0.0, p[0]]
        return p

    out = []
    for a in json.loads(json.dumps(local)):
        if a["kind"] == "graduated":
            a["start"], a["end"] = pt(a["start"]), pt(a["end"])
        elif a["kind"] == "radial":
            a["center"] = pt(a["center"])
            a["angle"] = round((a["angle"] + 90 * k + 180) % 360 - 180, 4) + 0.0
        else:
            for s in a["strokes"]:
                s["points"] = [pt(p) for p in s["points"]]
        out.append(a)
    return out


def _smooth(t):
    return t * t * (3 - 2 * t)


def local_mask(adj: dict, w: int, h: int) -> np.ndarray:
    """An adjustment's mask (0..1, float32) for a w x h picture, on the mask grid: MASK_EDGE cells
    along the longer edge whatever the resolution, so a preview and the full-resolution export get
    the same mask. Cell (i, j) is centred on picture point ((i + 0.5) / kx, (j + 0.5) / ky)."""
    s = max(w, h)
    kx, ky = MASK_EDGE * w / s, MASK_EDGE * h / s  # 0..1 of the picture -> cells
    gw, gh = math.ceil(kx), math.ceil(ky)

    def cell(p):
        return p[0] * kx - 0.5, p[1] * ky - 0.5

    if adj["kind"] == "brush":
        m = np.zeros((gh, gw), np.float64)
        for st in adj["strokes"]:
            rad = st["radius"] * MASK_EDGE
            pts = [cell(p) for p in st["points"]]
            segs = list(zip(pts, pts[1:])) or [(pts[0], pts[0])]
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            x0, x1 = max(0, math.floor(min(xs) - rad)), min(gw, math.ceil(max(xs) + rad) + 1)
            y0, y1 = max(0, math.floor(min(ys) - rad)), min(gh, math.ceil(max(ys) + rad) + 1)
            if x0 >= x1 or y0 >= y1:
                continue
            d2 = np.full((y1 - y0, x1 - x0), np.inf)
            for (ax, ay), (bx, by) in segs:  # each segment only near itself
                sx0, sx1 = max(x0, math.floor(min(ax, bx) - rad)), min(x1, math.ceil(max(ax, bx) + rad) + 1)
                sy0, sy1 = max(y0, math.floor(min(ay, by) - rad)), min(y1, math.ceil(max(ay, by) + rad) + 1)
                if sx0 >= sx1 or sy0 >= sy1:
                    continue
                gy, gx = np.mgrid[sy0:sy1, sx0:sx1].astype(np.float64)
                vx, vy = bx - ax, by - ay
                ll = vx * vx + vy * vy
                t = np.clip(((gx - ax) * vx + (gy - ay) * vy) / ll, 0, 1) if ll > 0 else 0.0
                dx, dy = gx - (ax + t * vx), gy - (ay + t * vy)
                sub = d2[sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0]
                np.minimum(sub, dx * dx + dy * dy, out=sub)
            hard = st["hardness"]
            u = np.sqrt(d2) / rad
            c = st["flow"] * (1 - _smooth(np.clip((u - hard) / max(1 - hard, 1e-3), 0, 1)))
            win = m[y0:y1, x0:x1]
            win[...] = win * (1 - c) if st["erase"] else win + c * (1 - win)
        return m.astype(np.float32)
    gy, gx = np.mgrid[0:gh, 0:gw].astype(np.float64)
    if adj["kind"] == "graduated":
        (ax, ay), (bx, by) = cell(adj["start"]), cell(adj["end"])
        vx, vy = bx - ax, by - ay
        t = ((gx - ax) * vx + (gy - ay) * vy) / max(vx * vx + vy * vy, 1e-9)
        m = 1 - _smooth(np.clip(t, 0, 1))
    else:  # radial
        cx, cy = cell(adj["center"])
        th = math.radians(adj["angle"])  # clockwise on screen
        cs, sn = math.cos(th), math.sin(th)
        qx = ((gx - cx) * cs + (gy - cy) * sn) / (adj["rx"] * MASK_EDGE)
        qy = (-(gx - cx) * sn + (gy - cy) * cs) / (adj["ry"] * MASK_EDGE)
        m = _smooth(np.clip((1 - np.sqrt(qx * qx + qy * qy)) / max(adj["feather"], 1e-3), 0, 1))
        if adj["invert"]:
            m = 1 - m
    return m.astype(np.float32)


def local_look(x: np.ndarray, adj: dict) -> np.ndarray:
    """An adjustment's sliders on developed pixels: white balance, exposure, contrast, saturation
    (the global develop's formulas, with saturation centred on 1).

    Exposure lifts with a gamma (shadows and midtones come up, white stays white: dodging) and
    darkens by scaling (whites come down too: burning a pale sky back in, like a grad ND filter)."""
    eps = 1e-5
    if adj["warmth"] or adj["tint"]:
        gam = np.array([1 - 0.25 * adj["warmth"], 1 + 0.25 * adj["tint"], 1 + 0.25 * adj["warmth"]], np.float32)
        x = np.clip(x, eps, 1) ** gam
    e = adj["exposure"]
    if e > 0:
        x = np.clip(x, eps, 1) ** np.float32(2.0 ** (-EXPOSURE_STOPS * e))
    elif e < 0:
        x = x * np.float32(2.0 ** (EXPOSURE_STOPS * e))
    c = adj["contrast"]
    if c > 0:
        x = x + (x * x * (3 - 2 * x) - x) * np.float32(c * 1.5)
    elif c < 0:
        x = x + (0.5 - x) * np.float32(-c * 0.5)
    if adj["saturation"]:
        lum = (x * np.array([0.299, 0.587, 0.114], np.float32)).sum(-1, keepdims=True)
        x = lum + (x - lum) * np.float32(1 + adj["saturation"])
    return np.clip(x, 0, 1)


LOCAL_BAND = 256  # rows at a time, so a full-resolution export makes no full-size temporaries


def apply_local(out: np.ndarray, local: list, frame: tuple[int, int], at: tuple[int, int], angle: float) -> None:
    """Local adjustments, in place, after the global develop: they act on the photo as you see it,
    and the histogram, curve fit and eyedropper (which read the image before) don't move.

    `out` is the developed (cropped) image; `frame` = (w, h) the straightened frame it was cut from
    at `at` = (left, top); `angle` the straighten angle. Each output pixel is traced back through
    the straighten (as straighten() samples) to the picture, where the masks live, and each mask
    is sampled bilinearly from its grid. Adjustments apply in order, each blended by its mask over
    the result of the ones before."""
    w, h = frame
    k = MASK_EDGE / max(w, h)  # picture pixels -> cells
    masks = [local_mask(adj, w, h) for adj in local]
    rows, cols = out.shape[:2]
    turned = abs(angle) >= 0.01  # straighten() leaves tiny angles alone
    if turned:
        th = math.radians(abs(angle))
        scale = math.cos(th) + math.sin(th) * max(w, h) / min(w, h)
        cs, sn = math.cos(math.radians(angle)) / scale, math.sin(math.radians(angle)) / scale
    for y0 in range(0, rows, LOCAL_BAND):
        y1 = min(rows, y0 + LOCAL_BAND)
        py, px = np.mgrid[y0 + at[1] : y1 + at[1], at[0] : at[0] + cols].astype(np.float64)
        if turned:
            dx, dy = px - w / 2, py - h / 2
            px, py = w / 2 + cs * dx + sn * dy, h / 2 - sn * dx + cs * dy
        gx, gy = (px + 0.5) * k - 0.5, (py + 0.5) * k - 0.5
        ix, iy = np.floor(gx), np.floor(gy)
        fx, fy = (gx - ix).astype(np.float32), (gy - iy).astype(np.float32)
        gh, gw = masks[0].shape  # every mask of this picture has the same grid
        xa, xb = np.clip(ix, 0, gw - 1).astype(np.intp), np.clip(ix + 1, 0, gw - 1).astype(np.intp)
        ya, yb = np.clip(iy, 0, gh - 1).astype(np.intp) * gw, np.clip(iy + 1, 0, gh - 1).astype(np.intp) * gw
        corners = ya + xa, ya + xb, yb + xa, yb + xb
        band = out[y0:y1]
        for adj, g in zip(local, masks):
            g00, g01, g10, g11 = (g.ravel().take(c) for c in corners)
            m = (g00 * (1 - fx) + g01 * fx) * (1 - fy) + (g10 * (1 - fx) + g11 * fx) * fy
            hit = m > 0
            if hit.all():
                band += (local_look(band, adj) - band) * m[..., None]
            elif hit.any():  # only where the mask reaches: a small radial or brush costs little
                sel = band[hit]
                band[hit] = sel + (local_look(sel, adj) - sel) * m[hit][:, None]
