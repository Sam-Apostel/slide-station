"""Camera RAW files as scans (camera rig mode, ROADMAP §5): DNG, CR2, CR3, NEF, ARW, ORF, RAF.

Decoded with rawpy (LibRaw), an optional dependency (`uv run --extra raw ...`); without it RAW files
are simply not offered as scans. A RAW is developed once, neutrally — the camera's white balance,
sRGB primaries and gamma, no auto brightening — to 16 bits per channel and handed to the pipeline as
float32 0..1, so it enters exactly where a decoded JPEG scan does. Proxies decode at half size
(LibRaw skips demosaicing), full-resolution renders at full size.

Metadata (make, model, capture time, exposure) comes from the file's TIFF header where there is one
(DNG, CR2, NEF, ARW, ORF), else from the EXIF of the JPEG preview embedded in it (CR3, RAF).
"""
from __future__ import annotations

import io
import struct
from pathlib import Path

import numpy as np
from PIL import Image

RAW_EXTS = (".dng", ".cr2", ".cr3", ".nef", ".arw", ".orf", ".raf")

try:  # optional: pip install rawpy / uv run --extra raw
    import rawpy
except ImportError:  # pragma: no cover - depends on the installation
    rawpy = None


def available() -> bool:
    return rawpy is not None


def is_raw(path: str | Path) -> bool:
    return str(path).lower().endswith(RAW_EXTS)


def decode(path: str | Path, half: bool = False) -> np.ndarray:
    """The RAW developed neutrally, as float32 RGB 0..1 (from 16 bits, no 8-bit step in between).
    `half`: half the width and height, without demosaicing (proxies)."""
    if rawpy is None:
        raise RuntimeError("RAW files need the optional rawpy package (uv run --extra raw)")
    with rawpy.imread(str(path)) as r:
        rgb = r.postprocess(
            output_bps=16,
            use_camera_wb=True,  # the camera's as-shot white balance; the Adjust panel does the rest
            no_auto_bright=True,  # exposure is the photographer's (and bracketing's) business
            output_color=rawpy.ColorSpace.sRGB,
            gamma=(2.4, 12.92),  # sRGB's curve: the pipeline expects display-referred values, like a JPEG
            half_size=half,
            user_flip=None,  # the camera's orientation, as it was held
        )
    return rgb.astype(np.float32) / 65535.0


def load_rgb(path: str | Path, max_edge: int | None = None) -> np.ndarray:
    """imaging.load_rgb for a RAW: float32 RGB 0..1, shrunk to max_edge (half-size decode first)."""
    half = bool(max_edge)
    a = decode(path, half=half)
    if max_edge and max(a.shape[:2]) > max_edge:
        h, w = a.shape[:2]
        f = max_edge / max(h, w)
        import cv2

        a = cv2.resize(a, (max(1, round(w * f)), max(1, round(h * f))), interpolation=cv2.INTER_AREA)
    return a


# --------------------------------------------------------------------------- metadata

_TAGS = {271: "make", 272: "model", 306: "datetime"}
_EXIF_TAGS = {36867: "datetime_original", 33434: "exposure", 33437: "fnumber", 34855: "iso", 37386: "focal"}


def _tiff_tags(data: bytes) -> dict:
    """Make, model, times and exposure from a TIFF-based RAW's first IFD and its EXIF IFD."""
    if len(data) < 8 or data[:2] not in (b"II", b"MM"):
        return {}
    e = "<" if data[:2] == b"II" else ">"
    sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}

    def ifd(off: int, names: dict) -> tuple[dict, int | None]:
        out, exif = {}, None
        if off <= 0 or off + 2 > len(data):
            return out, exif
        (n,) = struct.unpack_from(e + "H", data, off)
        for i in range(min(n, 512)):
            p = off + 2 + 12 * i
            if p + 12 > len(data):
                break
            tag, typ, count = struct.unpack_from(e + "HHI", data, p)
            size = sizes.get(typ, 1) * count
            vp = p + 8 if size <= 4 else struct.unpack_from(e + "I", data, p + 8)[0]
            if vp + size > len(data):
                continue
            if tag == 34665:  # the EXIF IFD
                exif = struct.unpack_from(e + "I", data, vp)[0]
            elif tag in names:
                if typ == 2:
                    out[names[tag]] = data[vp:vp + count].split(b"\0")[0].decode("latin-1").strip()
                elif typ in (5, 10) and count:
                    a, b = struct.unpack_from(e + ("II" if typ == 5 else "ii"), data, vp)
                    out[names[tag]] = a / b if b else 0.0
                elif typ == 3 and count:
                    out[names[tag]] = struct.unpack_from(e + "H", data, vp)[0]
                elif typ == 4 and count:
                    out[names[tag]] = struct.unpack_from(e + "I", data, vp)[0]
        return out, exif

    head = data[:2] + b"*\0" if e == "<" else data[:2] + b"\0*"
    if data[:4] != head and data[2:4] not in (b"RO", b"RS", b"OR"):  # ORF has its own magic
        return {}
    (first,) = struct.unpack_from(e + "I", data, 4)
    out, exif = ifd(first, {**_TAGS, **_EXIF_TAGS})  # TIFF/EP files keep exposure tags in IFD0
    if exif:
        out.update(ifd(exif, _EXIF_TAGS)[0])
    return out


def _thumb_exif(path: str | Path) -> dict:
    """EXIF of the JPEG preview LibRaw finds in the file (CR3, RAF and others)."""
    if rawpy is None:
        return {}
    try:
        with rawpy.imread(str(path)) as r:
            t = r.extract_thumb()
        if t.format != rawpy.ThumbFormat.JPEG:
            return {}
        ex = Image.open(io.BytesIO(t.data)).getexif()
    except Exception:
        return {}
    out = {v: str(ex[k]).strip() for k, v in _TAGS.items() if ex.get(k)}
    sub = ex.get_ifd(0x8769)
    for k, v in _EXIF_TAGS.items():
        if sub.get(k) is not None:
            out[v] = sub[k] if isinstance(sub[k], str) else float(sub[k])
    return out


def metadata(path: str | Path) -> dict:
    """{"make", "model", "datetime" (EXIF "YYYY:MM:DD HH:MM:SS"), "exposure" (s), "fnumber", "iso",
    "focal" (mm)} as far as the file tells; missing keys are left out."""
    try:
        with open(path, "rb") as f:
            head = f.read(1 << 20)  # the IFDs sit near the start
    except OSError:
        return {}
    m = _tiff_tags(head) or _thumb_exif(path)
    if m.get("datetime_original"):
        m["datetime"] = m.pop("datetime_original")
    m.pop("datetime_original", None)
    return {k: v for k, v in m.items() if v not in ("", None)}


def exif_for_export(path: str | Path) -> Image.Exif:
    """EXIF for a render of this RAW: the camera and exposure, like a scan's EXIF carries over."""
    m = metadata(path)
    ex = Image.Exif()
    for tag, key in _TAGS.items():
        if isinstance(m.get(key), str):
            ex[tag] = m[key]
    sub = ex.get_ifd(0x8769)
    for tag, key in _EXIF_TAGS.items():
        v = m.get(key)
        if isinstance(v, (int, float)) and v:
            sub[tag] = int(v) if key == "iso" else float(v)
    return ex
