"""Learning tone curves, and dating a range of slides (POST /api/sessions/{sid}/dates).

Self-contained: SLIDESTATION_HOME and the library point at temporary folders before any
slidestation module is imported, so the real library is never touched.
Run: uv run --python 3.12 --with pytest pytest tests/test_learning_dates.py -q
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

_HOME = Path(tempfile.mkdtemp(prefix="ss-home-"))
_LIB = Path(tempfile.mkdtemp(prefix="ss-lib-"))
os.environ["SLIDESTATION_HOME"] = str(_HOME)
(_HOME / "config.json").write_text(json.dumps({"library": str(_LIB)}))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from slidestation import imaging as im  # noqa: E402
from slidestation import learning, store  # noqa: E402
from slidestation.server import app  # noqa: E402

assert store.library() == _LIB, "tests must never run against the real library"

client = TestClient(app)
FIT = [[0.1, 0.0], [0.8, 1.0]]  # a "Fit to data"-like red curve


def _model(tmp_path: Path, examples: list[dict]) -> learning.Model:
    m = learning.Model(path=tmp_path / "learning.json")
    m.examples = examples
    m._fit()
    return m


def _examples(n: int, curves_for, rng=None) -> list[dict]:
    """n examples close together in feature space; curves_for(i) gives example i's curves (None: an
    example from before curves were learned, i.e. no "c" key)."""
    rng = rng or np.random.default_rng(1)
    base = np.linspace(0.1, 0.9, learning.FEATURES)
    out = []
    for i in range(n):
        e = {"key": f"t:{i}", "f": (base + rng.normal(0, 0.01, learning.FEATURES)).round(5).tolist(),
             "p": {k: 0.1 for k in learning.LEARNED_KEYS}, "trim": True, "t": 0}
        c = curves_for(i)
        if c is not None:
            e["c"] = c
        out.append(e)
    return out


def _query() -> list[float]:
    return np.linspace(0.1, 0.9, learning.FEATURES).tolist()


# --------------------------------------------------------------------------- learning curves


def test_remember_stores_curves_and_not_framing(tmp_path):
    m = _model(tmp_path, [])
    p = im.Params(curves={"r": FIT}, crop=[0.1, 0.1, 0.9, 0.9], angle=2.0).to_dict()
    m.remember("s:g", _query(), p)
    saved = json.loads((tmp_path / "learning.json").read_text())["examples"][0]
    assert saved["c"] == {"r": FIT}
    assert "crop" not in saved["p"] and "angle" not in saved["p"]


def test_suggest_learns_a_shared_curve(tmp_path):
    m = _model(tmp_path, _examples(8, lambda i: {"r": FIT}))
    sug, n = m.suggest(_query())
    assert n > 0 and "r" in sug["curves"]
    pts = sug["curves"]["r"]
    assert len(pts) == learning.CURVE_SAMPLES
    lut = im.curve_lut(FIT)
    for x, y in pts:  # every neighbour had the same curve: the average is that curve
        assert abs(y - float(np.interp(x, np.linspace(0, 1, len(lut)), lut))) < 1e-3
    assert set(sug["curves"]) == {"r"}
    assert "crop" not in sug and "angle" not in sug  # framing is never learned


def test_minority_curve_is_dropped(tmp_path):
    # only 2 of 8 neighbours curved green: under half the weight, so no green curve
    m = _model(tmp_path, _examples(8, lambda i: {"g": FIT} if i < 2 else {}))
    sug, _ = m.suggest(_query())
    assert sug["curves"] == {}


def test_majority_curve_is_averaged_with_straight_lines(tmp_path):
    m = _model(tmp_path, _examples(8, lambda i: {"b": FIT} if i < 6 else {}))
    sug, _ = m.suggest(_query())
    pts = dict((x, y) for x, y in sug["curves"]["b"])
    # between the fitted curve (1.0 at x=0.875) and the straight line (0.875): pulled towards it
    assert 0.875 < pts[0.875] < 1.0


def test_old_examples_without_curves_leave_curves_alone(tmp_path):
    # a learning.json from before curves were learned: no "c" anywhere
    m = _model(tmp_path, _examples(8, lambda i: None))
    sug, n = m.suggest(_query())
    assert n > 0 and "curves" not in sug
    # the tray's curves survive a suggestion merged the way import / resuggest merge it
    merged = im.Params.from_dict({**im.Params(curves={"rgb": FIT}).to_dict(), **sug})
    assert merged.curves == {"rgb": FIT}


def test_old_learning_json_loads(tmp_path):
    old = {"version": 1, "examples": _examples(6, lambda i: None)}
    (tmp_path / "learning.json").write_text(json.dumps(old))
    m = learning.Model(path=tmp_path / "learning.json")
    assert m.stats()["ready"]
    assert m.suggest(_query())[0] is not None


def test_mixed_old_and_new_examples_use_only_new_for_curves(tmp_path):
    m = _model(tmp_path, _examples(8, lambda i: None if i < 5 else {"rgb": [[0, 0.1], [1, 0.9]]}))
    sug, _ = m.suggest(_query())
    assert "rgb" in sug["curves"]  # all neighbours that know about curves had one


# --------------------------------------------------------------------------- server: session fixture


def _png(path: Path, shade: int) -> None:
    import cv2
    a = np.full((24, 36, 3), shade, np.uint8)
    a[4:12, 6:20] = (shade // 2, shade, 255 - shade)
    cv2.imwrite(str(path), a)


@pytest.fixture()
def tray():
    """A tray of 5 slides written straight into session.json (no import job needed)."""
    s = store.Session.create("Test tray")
    for i in range(5):
        sid = f"scan{i}"
        _png(s.originals / f"{sid}.jpg", 40 + i * 30)
        s.data["scans"][sid] = {"file": f"{sid}.jpg"}
        g = s.new_group([sid])
        g["feat"] = _query()
        s.data["groups"].append(g)
    s.save()
    return s


def _ids(s: store.Session) -> list[str]:
    return [g["id"] for g in s.data["groups"]]


# --------------------------------------------------------------------------- dates


def test_date_range_sets_every_slide_between(tray):
    ids = _ids(tray)
    r = client.post(f"/api/sessions/{tray.id}/dates", json={"from": ids[1], "to": ids[3], "date": "1978-08"})
    assert r.status_code == 200
    j = r.json()
    assert j["dated"] == 3
    assert [g["date"] for g in j["groups"]] == ["", "1978-08", "1978-08", "1978-08", ""]
    assert j["groups"][2]["date_est"]["source"] == "own"


def test_date_range_either_order_and_slash(tray):
    ids = _ids(tray)
    j = client.post(f"/api/sessions/{tray.id}/dates", json={"from": ids[4], "to": ids[2], "date": "1978/08"}).json()
    assert j["dated"] == 3
    assert [g["date"] for g in j["groups"]][2:] == ["1978-08"] * 3


def test_date_range_single_slide_and_clear(tray):
    ids = _ids(tray)
    client.post(f"/api/sessions/{tray.id}/dates", json={"from": ids[0], "to": ids[4], "date": "1979"})
    j = client.post(f"/api/sessions/{tray.id}/dates", json={"from": ids[2], "to": ids[2], "date": ""}).json()
    assert j["dated"] == 1
    assert [g["date"] for g in j["groups"]] == ["1979", "1979", "", "1979", "1979"]


def test_date_range_rejects_junk(tray):
    ids = _ids(tray)
    for bad in ("Aug 1978", "78", "1978-08-14T10", "tomorrow"):
        r = client.post(f"/api/sessions/{tray.id}/dates", json={"from": ids[0], "to": ids[1], "date": bad})
        assert r.status_code == 400, bad
    assert all(not g.get("date") for g in store.Session(tray.id).data["groups"])


def test_date_range_unknown_slide(tray):
    ids = _ids(tray)
    r = client.post(f"/api/sessions/{tray.id}/dates", json={"from": ids[0], "to": "nope", "date": "1978"})
    assert r.status_code == 404


def test_date_range_skips_locked(tray):
    ids = _ids(tray)
    s = store.Session(tray.id)
    s.data["groups"][2]["locked"] = "originals"
    s.save()
    j = client.post(f"/api/sessions/{tray.id}/dates", json={"from": ids[0], "to": ids[4], "date": "1978-08-14"}).json()
    assert j["dated"] == 4
    assert j["groups"][2]["date"] == ""
    assert [g["date"] for i, g in enumerate(j["groups"]) if i != 2] == ["1978-08-14"] * 4


def test_patch_group_date_validation_unchanged(tray):
    gid = _ids(tray)[0]
    assert client.patch(f"/api/sessions/{tray.id}/groups/{gid}", json={"date": "junk"}).status_code == 400
    assert client.patch(f"/api/sessions/{tray.id}/groups/{gid}", json={"date": "1978-6"}).json()["groups"][0]["date"] == "1978-6"


# --------------------------------------------------------------------------- learning through the API


def test_resuggest_applies_learned_curves_but_not_crop(tray, monkeypatch):
    m = learning.model()
    m.examples = _examples(8, lambda i: {"r": FIT})
    m._fit()
    ids = _ids(tray)
    s = store.Session(tray.id)
    s.data["groups"][0]["params"]["crop"] = [0.1, 0.1, 0.9, 0.9]
    s.save()
    j = client.post(f"/api/sessions/{tray.id}/groups/{ids[0]}/resuggest", json={}).json()
    assert j["applied"] == 1
    g = j["groups"][0]
    assert g["params_source"].startswith("learned:")
    assert "r" in g["params"]["curves"]
    assert g["params"]["crop"] == [0.1, 0.1, 0.9, 0.9]  # framing stays the slide's own
    # "Use learned" is one undo step that brings the old curves back
    j = client.post(f"/api/sessions/{tray.id}/groups/{ids[0]}/undo").json()
    assert j["groups"][0]["params"]["curves"] == {}
    learning.reset()


def test_developing_a_slide_teaches_its_curves(tray):
    learning.reset()
    gid = _ids(tray)[1]
    client.patch(f"/api/sessions/{tray.id}/groups/{gid}", json={"params": {"curves": {"g": FIT}}})
    client.patch(f"/api/sessions/{tray.id}/groups/{gid}", json={"reviewed": True})
    ex = [e for e in learning.model().examples if e["key"] == f"{tray.id}:{gid}"]
    assert ex and ex[0]["c"] == {"g": FIT}
    client.patch(f"/api/sessions/{tray.id}/groups/{gid}", json={"skip": True})
    assert not [e for e in learning.model().examples if e["key"] == f"{tray.id}:{gid}"]
