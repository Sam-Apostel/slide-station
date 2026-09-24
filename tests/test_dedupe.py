"""The dedupe index: a scan is "already imported" by its content (SHA-1), never by the quick
name + size + mtime fingerprint alone. Run: uv run --python 3.12 pytest tests -q
"""
from __future__ import annotations

import os
from datetime import datetime

from conftest import wait_job
from synthetic import save_scan, scene


def _twins(a, b):
    """Two different scans with the same name, size and modification time (e.g. the scanner
    restarted its numbering): pad the shorter JPEG after its end marker, which decoders ignore."""
    t = datetime(2024, 3, 1, 9, 0, 0)
    for folder, seed in ((a, 4242), (b, 5353)):
        folder.mkdir(parents=True)
        save_scan(scene(seed), folder / "IMG_0001.JPG", t)
    fa, fb = a / "IMG_0001.JPG", b / "IMG_0001.JPG"
    size = max(fa.stat().st_size, fb.stat().st_size)
    for f in (fa, fb):
        with f.open("ab") as fh:
            fh.write(b"\0" * (size - f.stat().st_size))
        os.utime(f, (1_700_000_000, 1_700_000_000))
    assert fa.read_bytes() != fb.read_bytes() and fa.stat().st_size == fb.stat().st_size
    return fa, fb


def _import(api, sid, folder) -> dict:
    assert api.post(f"/api/sessions/{sid}/import", json={"source": str(folder)}).json() == {"ok": True}
    return wait_job(api)


def test_same_fingerprint_different_scan_is_imported(api, tmp_path):
    fa, fb = _twins(tmp_path / "first", tmp_path / "second")
    sid = api.post("/api/sessions", json={"name": "Twins"}).json()["id"]
    _import(api, sid, fa.parent)
    _import(api, sid, fb.parent)
    d = api.get(f"/api/sessions/{sid}").json()
    assert d["summary"]["scans"] == 2, "a different scan with a known fingerprint was skipped"
    # the same file again is still recognised
    assert "already imported" in _import(api, sid, fb.parent)["message"]
    assert api.get(f"/api/sessions/{sid}").json()["summary"]["scans"] == 2
