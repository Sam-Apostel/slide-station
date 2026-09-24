"""Synthetic slide scans for the tests: no real photos in the repo.

    python tests/synthetic.py <folder> [slides] [--size 1200x800]

Each slide is a made-up scene (smooth colour field + a few shapes + grain) with a faded-film cast,
so auto restore and "Fit to data" have something to do. Every other slide is bracketed: the same
scene scanned twice at two brightnesses, which import must group into one slide. EXIF names the
Kodak Slide N Scan (make GCMC, model RODFS50) so a folder of these on a fake card is detected as
the scanner, and the scan times keep the order.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
from PIL import Image

EXIF_MAKE, EXIF_MODEL = "GCMC", "RODFS50"


def scene(seed: int, w: int = 240, h: int = 160) -> np.ndarray:
    """A distinct picture per seed, float32 RGB inside 0.15..0.85 (so a bracket never clips)."""
    rng = np.random.default_rng(seed)
    coarse = rng.random((4, 6, 3)).astype(np.float32)  # low-frequency layout: what grouping keys on
    a = np.asarray(Image.fromarray((coarse * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255
    yy, xx = np.mgrid[0:h, 0:w]
    for _ in range(4):  # a few hard-edged shapes, so the scan has something sharp in it
        cx, cy, r = rng.random() * w, rng.random() * h, (0.08 + rng.random() * 0.15) * h
        a[(xx - cx) ** 2 + (yy - cy) ** 2 < r * r] = rng.random(3)
    a += rng.normal(0, 0.02, a.shape).astype(np.float32)  # film grain
    # faded film: each channel squeezed into its own band, with a magenta-ish cast
    lo, hi = np.array([0.30, 0.18, 0.25], np.float32), np.array([0.85, 0.62, 0.75], np.float32)
    return np.clip(lo + np.clip(a, 0, 1) * (hi - lo), 0.15, 0.85)


def save_scan(a: np.ndarray, path: Path, taken: datetime, salt: int = 0) -> None:
    """Write a scan as the scanner would: JPEG with make/model/time in EXIF. `salt` changes the bytes
    (not the picture) so the same scene can be imported again as a new scan."""
    u8 = (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
    if salt:
        noise = np.random.default_rng(salt).integers(0, 2, u8.shape[:2], dtype=np.uint8)
        u8[..., 0] = np.clip(u8[..., 0].astype(np.int16) + noise, 0, 255).astype(np.uint8)
    ex = Image.Exif()
    ex[271], ex[272], ex[306] = EXIF_MAKE, EXIF_MODEL, taken.strftime("%Y:%m:%d %H:%M:%S")
    Image.fromarray(u8).save(path, "JPEG", quality=92, exif=ex.tobytes())


def make_scans(folder: Path, slides: int = 4, size: tuple[int, int] = (240, 160), salt: int = 0,
               first: int = 1) -> list[list[str]]:
    """Write `slides` slides as scans IMG_0001.JPG… into folder; even-numbered slides (0, 2, …) are
    bracketed pairs (bright + dark). Returns the file names per slide, in import order."""
    folder.mkdir(parents=True, exist_ok=True)
    t = datetime(2024, 1, 1, 12, 0, 0) + timedelta(minutes=first)
    n, out = first, []
    for k in range(slides):
        base = scene(1000 + k * 7919, *size)
        exposures = (1.0, 0.6) if k % 2 == 0 else (1.0,)
        names = []
        for e in exposures:
            name = f"IMG_{n:04d}.JPG"
            save_scan(base * e, folder / name, t, salt * 100_000 + n if salt else 0)
            names.append(name)
            n += 1
            t += timedelta(seconds=10)
        out.append(names)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("folder", type=Path)
    ap.add_argument("slides", type=int, nargs="?", default=8)
    ap.add_argument("--size", default="1200x800", help="WxH of each scan")
    a = ap.parse_args()
    w, h = (int(x) for x in a.size.split("x"))
    made = make_scans(a.folder, a.slides, (w, h))
    print(f"{sum(map(len, made))} scans of {len(made)} slides in {a.folder}")
