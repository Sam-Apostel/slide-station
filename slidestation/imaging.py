"""Image processing: signatures for grouping, rotation guesses, HDR fusion, colour restoration."""
from __future__ import annotations

import io
import threading
import warnings
from dataclasses import asdict, dataclass, field
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

    @classmethod
    def from_dict(cls, d: dict | None) -> "Params":
        p = cls()
        for k, v in (d or {}).items():
            if k == "curves":
                p.curves = clean_curves(v)
            elif k == "crop":
                p.crop = clean_crop(v)
            elif k == "dust":
                p.dust = min(1.0, max(0.0, float(v)))
            elif hasattr(p, k):
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
    known = ~m
    ys, xs = np.nonzero(m)
    dy, dx = (g.ravel() for g in np.meshgrid(off, off, indexing="ij"))
    for _ in range(DUST_PASSES):
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


def geometry(a: np.ndarray, p: Params, crop: bool = True) -> np.ndarray:
    out = straighten(a, p.angle)
    if crop and p.crop:
        h, w = out.shape[:2]
        l, t, r, b = p.crop
        out = out[int(t * h) : max(int(t * h) + 1, int(b * h)), int(l * w) : max(int(l * w) + 1, int(r * w))]
    return out


def tone_base(a: np.ndarray, p: Params, crop: bool = True) -> np.ndarray:
    """The image the tone curve works on: auto-restored, trimmed, dust repaired, straightened and
    cropped. Dust comes after the trim so the mount's edge is never taken for a scratch, and the
    trim (decided on the restored pixels) stays the one before_view uses."""
    out = auto_restore(a, p.strength)
    if p.trim:
        out = trim_borders(out)
    if p.dust > 0:
        out = repair_dust(out, p.dust, inplace=True)  # out is ours: auto_restore copied
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
    out = apply_curves(tone_base(a, p, crop), p.curves)
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
