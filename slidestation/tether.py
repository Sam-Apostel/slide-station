"""Tethered capture through the gphoto2 command line (camera rig mode, ROADMAP §5).

A camera on a copy stand over a light panel is just another source of scans: `cameras()` lists what
`gphoto2 --auto-detect` sees, `capture()` has the camera take a picture and downloads it (RAW, JPEG
or both, whatever the camera is set to) into a folder, which workflow.capture_into imports into the
open tray. Settings (exposure, focus, RAW / JPEG) stay on the camera.

Only the command line is used (no libgphoto2 binding), so it works wherever gphoto2 is installed
(`brew install gphoto2`, `apt install gphoto2`) and is simply not offered where it isn't.
UNTESTED WITH A REAL CAMERA: the tests run a stand-in script with gphoto2's output format.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

GPHOTO2 = os.environ.get("SLIDESTATION_GPHOTO2", "gphoto2")
DETECT_EVERY = 5.0  # seconds: /api/state is polled every second, the USB scan isn't free
_cache: dict = {"t": 0.0, "cameras": []}
_lock = threading.Lock()  # one gphoto2 at a time: the camera takes one connection


def available() -> bool:
    return shutil.which(GPHOTO2) is not None


def parse_auto_detect(out: str) -> list[dict]:
    """`gphoto2 --auto-detect` prints a table:

        Model                          Port
        ----------------------------------------------------------
        Canon EOS 5D Mark III          usb:001,004
    """
    cams, table = [], False
    for line in out.splitlines():
        if line.startswith("---"):
            table = True
            continue
        if table and line.strip():
            m = re.match(r"^(.*\S)\s{2,}(\S+)\s*$", line)
            if m:
                cams.append({"model": m[1], "port": m[2]})
    return cams


def cameras(fresh: bool = False) -> list[dict]:
    """Cameras connected now ([{"model", "port"}]); remembered for a few seconds."""
    if not available():
        return []
    if not fresh and time.time() - _cache["t"] < DETECT_EVERY:
        return _cache["cameras"]
    if not _lock.acquire(blocking=False):  # a capture is using the camera: it's still there
        return _cache["cameras"]
    try:
        r = subprocess.run([GPHOTO2, "--auto-detect"], capture_output=True, text=True, timeout=15)
        cams = parse_auto_detect(r.stdout) if r.returncode == 0 else []
    except (OSError, subprocess.TimeoutExpired):
        cams = []
    finally:
        _lock.release()
    _cache.update(t=time.time(), cameras=cams)
    return cams


def capture(dest: Path, port: str | None = None, timeout: float = 90) -> list[Path]:
    """Take one picture and download it into dest; the files that arrived (a RAW + JPEG camera
    setting gives two). Raises RuntimeError with gphoto2's own words when it fails."""
    if not available():
        raise RuntimeError("gphoto2 isn't installed (brew install gphoto2 / apt install gphoto2)")
    dest.mkdir(parents=True, exist_ok=True)
    before = set(dest.iterdir())
    cmd = [GPHOTO2, "--capture-image-and-download", "--force-overwrite",
           "--filename", str(dest / "capture-%Y%m%d-%H%M%S-%n.%C")]
    if port:
        cmd += ["--port", port]
    with _lock:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RuntimeError("The camera didn't answer in time (is it switched on and awake?)")
    if r.returncode != 0:
        lines = [x.strip() for x in (r.stderr or r.stdout).splitlines() if x.strip() and not x.startswith("***")]
        raise RuntimeError("gphoto2: " + (lines[-1] if lines else f"failed ({r.returncode})"))
    _cache["t"] = 0.0  # look again soon: a camera that just worked is certainly there
    return sorted(p for p in dest.iterdir() if p not in before and p.is_file())
