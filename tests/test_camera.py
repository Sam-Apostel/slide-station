"""Camera rig mode (ARCHITECTURE "Camera rig mode"): RAW files as scans, tethered capture.

RAW: synthetic DNGs (tests/synthetic.py save_dng: a Bayer mosaic LibRaw decodes back to the scene
within ~1 %), skipped without rawpy / tifffile. Tethered capture: a stand-in `gphoto2` script with
the real one's output format — no camera was harmed, or used: untested with real hardware.
"""
from __future__ import annotations

import io
import stat
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from conftest import wait_job
from slidestation import imaging as im
from slidestation import raw, store, tether
from slidestation import workflow as wf
from synthetic import save_scan, scene

rawpy = pytest.importorskip("rawpy", reason="RAW support is optional (uv run --extra raw)")
pytest.importorskip("tifffile", reason="the synthetic DNGs are written with tifffile")
from synthetic import save_dng  # noqa: E402

T0 = datetime(1978, 8, 14, 12, 0, 0)


def test_raw_decodes_to_float_from_16_bits(tmp_path):
    a = scene(1234, 240, 160)
    save_dng(a, tmp_path / "shot.dng", T0, exposure=1 / 125)
    assert raw.is_raw(tmp_path / "shot.DNG") and not raw.is_raw(tmp_path / "shot.jpg")
    full = im.load_rgb(str(tmp_path / "shot.dng"))
    assert full.dtype == np.float32 and full.shape == (160, 240, 3)
    assert np.abs(full[4:-4, 4:-4] - a[4:-4, 4:-4]).mean() < 0.02  # the scene back, as a JPEG scan would be
    # more than 8 bits survive: a smooth ramp has far more distinct levels than 256
    assert len(np.unique(full[..., 1])) > 1000
    assert im.load_full(str(tmp_path / "shot.dng")).dtype == np.float32  # full res: float, no 8-bit step
    proxy = im.load_rgb(str(tmp_path / "shot.dng"), 100)  # proxies: half-size decode, then shrunk
    assert max(proxy.shape[:2]) == 100 and abs(proxy.mean() - a.mean()) < 0.02
    m = raw.metadata(tmp_path / "shot.dng")
    assert m["make"] == "SynthCo" and m["model"] == "Synthetic Cam" and m["datetime"] == "1978:08:14 12:00:00"
    assert m["iso"] == 100 and abs(m["exposure"] - 1 / 125) < 1e-9
    ex = raw.exif_for_export(tmp_path / "shot.dng")
    assert ex[271] == "SynthCo" and ex.get_ifd(0x8769)[34855] == 100


def test_raw_metadata_never_throws(tmp_path):
    (tmp_path / "junk.nef").write_bytes(b"not a raw file at all")
    assert raw.metadata(tmp_path / "junk.nef") == {}
    assert raw.metadata(tmp_path / "missing.cr3") == {}


def test_import_raw_with_brackets_and_jpeg_twins(api, tmp_path):
    card = tmp_path / "card" / "DCIM" / "100CANON"
    card.mkdir(parents=True)
    # slide 1: a bracket of two RAWs (camera shooting RAW + JPEG: the JPEGs are left out);
    # slide 2: one RAW; slide 3: a plain JPEG, which still imports
    s1, s2, s3 = scene(2001, 240, 160), scene(2002, 240, 160), scene(2003, 240, 160)
    save_dng(s1, card / "IMG_0001.DNG", T0, salt=1)
    save_scan(s1, card / "IMG_0001.JPG", T0)
    save_dng(s1 * 0.6, card / "IMG_0002.DNG", T0.replace(second=10), salt=2, exposure=1 / 250)
    save_dng(s2, card / "IMG_0003.DNG", T0.replace(second=20), salt=3)
    save_scan(s3, card / "IMG_0004.JPG", T0.replace(second=30), salt=4)
    assert [p.name for p in wf.list_scans(card)] == ["IMG_0001.DNG", "IMG_0002.DNG", "IMG_0003.DNG", "IMG_0004.JPG"]

    sid = api.post("/api/sessions", json={"name": "Camera"}).json()["id"]
    assert api.post(f"/api/sessions/{sid}/import", json={"source": str(card.parent.parent)}).json() == {"ok": True}
    assert "Imported 4 scans into 3 slides" in wait_job(api)["message"]
    d = api.get(f"/api/sessions/{sid}").json()
    assert [len(g["scans"]) for g in d["groups"]] == [2, 1, 1]  # the RAW bracket is one slide
    s = store.Session(sid)
    rec = s.data["scans"][d["groups"][0]["scans"][0]]
    assert rec["file"].endswith(".dng") and rec["camera"]["model"] == "Synthetic Cam"
    assert rec["taken"] == "1978:08:14 12:00:00"
    assert "camera" not in s.data["scans"][d["groups"][2]["scans"][0]]
    # previews and thumbnails come from the RAW like from a JPEG
    g1 = d["groups"][1]
    r = api.get(f"/api/sessions/{sid}/groups/{g1['id']}/preview.jpg?size=400")
    assert r.status_code == 200 and Image.open(io.BytesIO(r.content)).size[0] > 0
    assert api.get(f"/api/sessions/{sid}/scans/{g1['scans'][0]}/thumb.jpg").status_code == 200
    # full resolution: the RAW's own size, and the camera in the export's EXIF
    info = api.get(f"/api/sessions/{sid}/groups/{g1['id']}/full").json()
    assert (info["width"], info["height"]) == (240, 160)
    out = wf.render_export(sid, g1["id"], 90)
    ex = Image.open(out).getexif()
    assert ex[271] == "SynthCo" and ex[272] == "Synthetic Cam" and ex.get_ifd(0x8769)[36867]
    assert Image.open(out).size == (240, 160)
    # the bracket renders too (fused in 8 bits, like JPEG brackets)
    assert wf.render_export(sid, d["groups"][0]["id"], 90) is not None


def test_raw_needs_rawpy(api, tmp_path, monkeypatch):
    save_dng(scene(2101, 120, 80), tmp_path / "a.dng", T0)
    save_scan(scene(2102, 120, 80), tmp_path / "b.jpg", T0)
    monkeypatch.setattr(raw, "rawpy", None)
    assert wf.scan_exts() == wf.JPG and [p.name for p in wf.list_scans(tmp_path)] == ["b.jpg"]
    assert not api.get("/api/state").json()["server"]["raw"]


# --------------------------------------------------------------------------- tethered capture

FAKE_GPHOTO2 = r'''#!{python}
"""Stands in for gphoto2: --auto-detect prints one camera, --capture-image-and-download writes the
next file of FAKE_CAMERA_SHOTS (one per line) to --filename, as the camera would."""
import os, shutil, sys, time
args = sys.argv[1:]
if "--auto-detect" in args:
    print("Model                          Port")
    print("----------------------------------------------------------")
    if not os.environ.get("FAKE_CAMERA_NONE"):
        print("Synthetic Cam                  usb:001,004")
    sys.exit(0)
if "--capture-image-and-download" in args:
    queue = os.environ["FAKE_CAMERA_SHOTS"]
    shots = open(queue).read().split()
    if not shots:
        print("*** Error: No camera found. ***", file=sys.stderr)
        print("Error (-105: 'Unknown model')", file=sys.stderr)
        sys.exit(1)
    open(queue, "w").write("\n".join(shots[1:]))
    pattern = args[args.index("--filename") + 1]
    name = time.strftime(pattern.replace("%n", "1").replace("%C", shots[0].rsplit(".", 1)[1]))
    shutil.copy(shots[0], name)
    print("Saving file as " + os.path.basename(name))
    sys.exit(0)
sys.exit(2)
'''


@pytest.fixture
def camera(tmp_path, monkeypatch):
    """A fake gphoto2 on hand; returns the list of files the camera will 'take', in order."""
    exe = tmp_path / "gphoto2"
    exe.write_text(FAKE_GPHOTO2.replace("{python}", sys.executable))
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    queue = tmp_path / "shots.txt"
    queue.write_text("")
    monkeypatch.setattr(tether, "GPHOTO2", str(exe))
    monkeypatch.setenv("FAKE_CAMERA_SHOTS", str(queue))
    tether._cache.update(t=0.0, cameras=[])

    def take(*files: Path):
        queue.write_text("\n".join([*queue.read_text().split(), *map(str, files)]))

    return take


def test_parse_auto_detect():
    out = ("Model                          Port\n"
           "----------------------------------------------------------\n"
           "Canon EOS 5D Mark III          usb:001,004\n"
           "Nikon DSC D850 (PTP mode)      usb:002,007\n")
    assert tether.parse_auto_detect(out) == [{"model": "Canon EOS 5D Mark III", "port": "usb:001,004"},
                                             {"model": "Nikon DSC D850 (PTP mode)", "port": "usb:002,007"}]
    assert tether.parse_auto_detect("Model   Port\n-----\n") == []


def test_no_gphoto2_no_camera(api, monkeypatch):
    monkeypatch.setattr(tether, "GPHOTO2", "/nonexistent/gphoto2")
    assert api.get("/api/state").json()["camera"] is None
    sid = api.post("/api/sessions", json={"name": "x"}).json()["id"]
    assert api.post(f"/api/sessions/{sid}/capture").status_code == 404


def test_capture_lands_in_the_tray_grouped_like_scans(api, tmp_path, camera):
    st = api.get("/api/state").json()["camera"]
    assert st == {"cameras": [{"model": "Synthetic Cam", "port": "usb:001,004"}]}
    shots = tmp_path / "shots"
    shots.mkdir()
    a, b = scene(3001, 240, 160), scene(3002, 240, 160)
    save_dng(a, shots / "1.dng", T0, salt=11)
    save_dng(a * 0.6, shots / "2.dng", T0.replace(second=5), salt=12)  # the same slide, darker
    save_dng(b, shots / "3.dng", T0.replace(second=9), salt=13)  # the next slide
    camera(shots / "1.dng", shots / "2.dng", shots / "3.dng")
    sid = api.post("/api/sessions", json={"name": "Rig"}).json()["id"]
    sizes = []
    for _ in range(3):  # three presses of "Capture"
        assert api.post(f"/api/sessions/{sid}/capture", json={}).json() == {"ok": True}
        assert "Imported 1 scans" in wait_job(api)["message"]
        sizes.append([len(g["scans"]) for g in api.get(f"/api/sessions/{sid}").json()["groups"]])
    assert sizes == [[1], [2], [2, 1]]  # the darker shot joined the slide before it: a bracket
    s = store.Session(sid)
    assert all(r["source_root"] == "camera" and not r["removable"] and r["camera"]["make"] == "SynthCo"
               for r in s.data["scans"].values())
    assert not list((store.library() / "captures").iterdir())  # capture folders go once imported
    # the camera has nothing more to give: the job says what gphoto2 said
    assert api.post(f"/api/sessions/{sid}/capture", json={}).json() == {"ok": True}
    with pytest.raises(AssertionError, match="gphoto2: Error"):
        wait_job(api)


def test_capture_not_on_a_hosted_server(api, camera, monkeypatch):
    from slidestation import accounts

    monkeypatch.setattr(accounts, "MODE", "immich")
    monkeypatch.setattr(store, "USER_IMMICH_URL", "http://immich.test")
    # signed out, nothing answers; and a signed-in account gets no camera (it would be everyone's)
    assert api.get("/api/state").status_code == 401
    from slidestation.server import _camera

    assert tether.available() and _camera() is None
