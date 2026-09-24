"""Eyes open (eyes.py): the eye aspect ratio from the face mesh, and look-alikes' "keep the best"
preferring the shot where nobody blinked.

The landmark model and the face detector are replaced: a fake model answers a synthetic mesh whose
eyes are as open as the test says, so the maths and the plumbing are checked exactly. The real model
was checked by hand on real and AI-made face photos (ARCHITECTURE §5e "Eyes open"), never here.
Run: uv run --python 3.12 pytest tests/test_eyes.py -q
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from conftest import new_tray, wait_job
from slidestation import eyes, insights, server, similar, store
from slidestation import imaging as im
from test_similar import FakeModel, axis, near, payload, plant

STEP = insights.step


def eye_points(ear: float, cx=0.0, cy=0.0, width=30.0, angle=0.0) -> np.ndarray:
    """Six points p1..p6 of an eye with exactly this EAR (the lids at x = 1/3 and 2/3 of the width)."""
    h = ear * width  # the lids h apart: (|p2 - p6| + |p3 - p5|) / (2 |p1 - p4|) = 2h / 2w
    p = np.array([[0, 0], [width / 3, -h / 2], [2 * width / 3, -h / 2], [width, 0],
                  [2 * width / 3, h / 2], [width / 3, h / 2]], np.float64) - [width / 2, 0]
    c, s = math.cos(angle), math.sin(angle)
    return p @ np.array([[c, s], [-s, c]]) + [cx, cy]


def mesh(right: float, left: float, angle=0.0, scale=1.0) -> np.ndarray:
    """A 478-point mesh (x, y, z) in crop pixels with these two EARs, the rest of the face elsewhere."""
    pts = np.full((478, 3), 128.0)
    pts[eyes.RIGHT_EYE, :2] = eye_points(right, 90 * scale, 110, 30 * scale, angle)
    pts[eyes.LEFT_EYE, :2] = eye_points(left, 166 * scale, 110, 30 * scale, angle)
    return pts


# --------------------------------------------------------------------------- the maths


def test_eye_aspect_ratio():
    assert eyes.ear(eye_points(0.3)) == pytest.approx(0.3)
    assert eyes.ear(eye_points(0.02)) == pytest.approx(0.02)
    # a ratio: the same turned, moved, bigger or smaller
    for angle, width in ((0.4, 30), (-1.2, 12), (math.pi, 80)):
        assert eyes.ear(eye_points(0.27, 300, -40, width, angle)) == pytest.approx(0.27)
    assert eyes.ear(np.zeros((6, 2))) == 0.0  # degenerate: no width
    # a face: the mean of its two eyes, from the mesh's eye contours
    assert eyes.face_ear(mesh(0.3, 0.2)) == pytest.approx(0.25)
    assert eyes.face_ear(mesh(0.05, 0.05, angle=0.3, scale=0.5)) == pytest.approx(0.05)


def test_openness_and_the_slide_score():
    assert eyes.openness(0.02) == 0 and eyes.openness(eyes.CLOSED_EAR) == 0
    assert eyes.openness(eyes.OPEN_EAR) == 1 and eyes.openness(0.4) == 1
    mid = (eyes.CLOSED_EAR + eyes.OPEN_EAR) / 2
    assert eyes.openness(mid) == pytest.approx(0.5)
    # a slide: its least open face; no faces / not measured / another model: unknown
    assert eyes.slide_open({"model": eyes.MODEL_ID, "ear": [0.3, eyes.CLOSED_EAR]}) == 0
    assert eyes.slide_open({"model": eyes.MODEL_ID, "ear": [0.3, 0.25]}) == 1
    assert eyes.slide_open({"model": eyes.MODEL_ID, "ear": []}) is None
    assert eyes.slide_open(None) is None
    assert eyes.slide_open({"model": "another", "ear": [0.3]}) is None


def test_crop_follows_the_face():
    # a face box at (100, 200), 80 x 100, eyes tilted 20 degrees
    a = math.radians(20)
    re, le = (120.0, 240.0), (120 + 40 * math.cos(a), 240 + 40 * math.sin(a))
    face = np.array([100, 200, 80, 100, *re, *le, 0, 0, 0, 0, 0, 0, 0.9])
    m = eyes.crop_matrix(face)
    to_crop = lambda p: m[:, :2] @ np.asarray(p) + m[:, 2]  # noqa: E731
    assert to_crop((140, 250)) == pytest.approx([128, 128])  # the box's centre is the crop's
    r, l = to_crop(re), to_crop(le)
    assert r[1] == pytest.approx(l[1])  # the eyes level
    assert l[0] - r[0] == pytest.approx(40 * eyes.SIZE / (100 * eyes.CROP))  # 1.5 x the longer side = 256 px


# --------------------------------------------------------------------------- measuring a picture


class FakeLandmarker:
    """Answers each face (in the order asked: largest first) with a mesh of the next EARs."""

    def __init__(self, ears, presence=None):
        self.ears = list(ears)
        self.presence = list(presence or [1.0] * len(self.ears))
        self.crops = []

    def run(self, crop):
        self.crops.append(crop)
        e = self.ears.pop(0)
        return mesh(e, e), self.presence.pop(0)


def faces(*boxes):
    """YuNet rows for boxes (x, y, w, score): eyes level at a third of the box."""
    out = []
    for x, y, w, score in boxes:
        out.append([x, y, w, w * 1.2, x + w * 0.3, y + w * 0.4, x + w * 0.7, y + w * 0.4, 0, 0, 0, 0, 0, 0, score])
    return np.array(out, np.float32).reshape(-1, 15)


def test_measure_keeps_the_faces_that_matter(monkeypatch):
    rgb = np.full((600, 1000, 3), 0.5, np.float32)
    monkeypatch.setattr(im, "detect_faces", lambda a: faces(
        (100, 100, 200, 0.95),  # the largest
        (500, 100, 120, 0.9),  # more than half its width: counts
        (700, 100, 90, 0.9),  # less than half: a face in the background
        (800, 100, 150, 0.5),  # not sure it is a face
        (900, 300, 30, 0.9),  # tiny
    ))
    fake = FakeLandmarker([0.3, 0.05])
    got = eyes.measure(rgb, fake)
    assert got == {"model": eyes.MODEL_ID, "ear": [0.3, 0.05]}
    assert len(fake.crops) == 2 and fake.crops[0].shape == (256, 256, 3) and fake.crops[0].dtype == np.float32
    assert fake.crops[0].max() == pytest.approx(127 / 255)  # the picture's pixels (0.5 -> 127, as uint8)
    # the landmark model not seeing a face there: left out
    monkeypatch.setattr(im, "detect_faces", lambda a: faces((100, 100, 200, 0.95), (500, 100, 150, 0.9)))
    assert eyes.measure(rgb, FakeLandmarker([0.3, 0.05], [1.0, 0.1]))["ear"] == [0.3]
    # no faces: an empty list (measured, nothing to say)
    monkeypatch.setattr(im, "detect_faces", lambda a: np.zeros((0, 15), np.float32))
    assert eyes.measure(rgb, FakeLandmarker([]))["ear"] == []


# --------------------------------------------------------------------------- keep the best


def test_best_weighs_quality_with_open_eyes():
    q = {"a": 0.9, "b": 0.6, "c": 0.5}
    assert similar.best_of(q, {}) == "a"  # no faces: the sharpest
    assert similar.best_of(q, {"a": 0.0, "b": 1.0, "c": 1.0}) == "b"  # a blinked
    assert similar.best_of(q, {"a": 0.0}) == "b"  # unmeasured slides count as eyes open
    # eyes closed keep 1 - EYES_WEIGHT of their quality: a far sharper blink still wins over a blur
    blur = (1 - similar.EYES_WEIGHT) * 0.9 - 0.01
    assert similar.best_of({"a": 0.9, "b": blur}, {"a": 0.0, "b": 1.0}) == "a"
    assert similar.best_of({"a": 0.9, "b": blur + 0.02}, {"a": 0.0, "b": 1.0}) == "b"
    assert similar.best_of({"a": 0.0, "b": 0.0}, {"a": 0.0, "b": 1.0}) == "a"  # nothing measurable: the first


@pytest.fixture
def on(monkeypatch):
    """Insights and the eye model on ("downloaded"), the background thread kept out."""
    monkeypatch.setattr(insights, "model_ready", lambda: True)
    monkeypatch.setattr(insights, "backend", lambda: None)
    monkeypatch.setattr(insights, "step", lambda: False)
    monkeypatch.setattr(eyes, "model_ready", lambda: True)
    with insights.worker_busy:
        pass
    store.save_config({**store.load_config(), "insights_enabled": True, "eyes_enabled": True})
    (store.library() / "insights.json").unlink(missing_ok=True)


def plant_eyes(sid, ears: dict):
    def fn(e):
        for gid, ear in ears.items():
            e["slides"][gid]["eyes"] = {"model": eyes.MODEL_ID, "ear": ear}

    similar.update(sid, fn)


def test_duplicates_prefer_open_eyes(api, tmp_path, on):
    sid, d = new_tray(api, tmp_path / "scans", slides=4)
    ids = [g["id"] for g in d["groups"]]
    base = axis(0)
    plant(sid, {ids[0]: (base, 0.9), ids[1]: (near(base, 0.97, 1), 0.7), ids[2]: (near(base, 0.96, 2), 0.6),
                ids[3]: (axis(1), 0.5)})
    sug = payload(api, sid)["similar"]["duplicates"][0]
    assert sug["best"] == ids[0] and "eyes" not in sug  # not measured yet: as before
    # slide 1 (the sharpest) has someone blinking; on slide 3 no face was found (counts as open)
    plant_eyes(sid, {ids[0]: [0.3, 0.04], ids[1]: [0.28, 0.31], ids[2]: []})
    sug = payload(api, sid)["similar"]["duplicates"][0]
    assert sug["best"] == ids[1]
    assert sug["eyes"] == {ids[0]: 0.0, ids[1]: 1.0} and sug["closed"] == [ids[0]]
    assert sug["scores"][ids[0]] == 0.9  # the quality itself is unchanged
    # a model other than this one (a library from a later version): not used
    plant_eyes(sid, {ids[0]: [0.04]})
    similar.update(sid, lambda e: e["slides"][ids[0]]["eyes"].__setitem__("model", "other"))
    sug = payload(api, sid)["similar"]["duplicates"][0]
    assert ids[0] not in sug["eyes"] and sug["closed"] == [] and sug["best"] == ids[0]
    # keeping the one with open eyes skips the others, as any keep
    plant_eyes(sid, {ids[0]: [0.04]})
    sug = payload(api, sid)["similar"]["duplicates"][0]
    r = api.post(f"/api/sessions/{sid}/insights/decide",
                 json={"kind": "duplicates", "action": "accept", "value": sug["id"]})
    assert [g["skip"] for g in r.json()["groups"]] == [True, False, True, False]


def test_background_measures_eyes(api, tmp_path, on, monkeypatch):
    fake = FakeModel()
    monkeypatch.setattr(insights, "backend", lambda: fake)
    marks = FakeLandmarker([0.3] * 100)
    monkeypatch.setattr(eyes, "backend", lambda: marks)
    monkeypatch.setattr(im, "detect_faces", lambda a: faces((a.shape[1] * 0.3, 20, a.shape[1] * 0.2, 0.9)))
    store.save_config({**store.load_config(), "eyes_enabled": False})  # the eye model comes later
    sid, d = new_tray(api, tmp_path / "scans", slides=3)
    payload(api, sid)  # the open tray
    while STEP():
        pass
    e = similar.load(sid)
    assert all("eyes" not in v for v in e["slides"].values()) and not marks.crops
    assert payload(api, sid)["insights"]["pending"] == 0
    # turned on: the slides already embedded get their eyes measured, one at a time, no new embedding
    store.save_config({**store.load_config(), "eyes_enabled": True})
    calls = fake.calls
    assert payload(api, sid)["insights"]["pending"] == 3
    while STEP():
        pass
    e = similar.load(sid)
    assert all(v["eyes"] == {"model": eyes.MODEL_ID, "ear": [0.3]} for v in e["slides"].values())
    assert fake.calls == calls and len(marks.crops) == 3
    assert payload(api, sid)["insights"]["pending"] == 0
    # turned: embedded again, and its eyes measured with it
    gid = d["groups"][1]["id"]
    api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"rotation": 180})
    while STEP():
        pass
    assert similar.load(sid)["slides"][gid]["eyes"]["ear"] == [0.3] and len(marks.crops) == 4
    # a failure is noted, not retried
    monkeypatch.setattr(im, "detect_faces", lambda a: 1 / 0)
    api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"rotation": 0})
    while STEP():
        pass
    got = similar.load(sid)["slides"][gid]["eyes"]
    assert got["ear"] == [] and got["error"]


def test_settings_and_download(api, monkeypatch):
    store.save_config({**store.load_config(), "insights_enabled": True})
    monkeypatch.setattr(insights, "model_ready", lambda: True)
    assert api.post("/api/config", json={"eyes_enabled": True}).json() == {"ok": True}
    st = api.get("/api/insights").json()["eyes"]
    assert st == {"enabled": True, "ready": eyes.model_ready(), "model_mb": 5}
    # the tray payload names it as missing, the analysis itself runs (it only picks the best look-alike)
    monkeypatch.setattr(eyes, "model_ready", lambda: False)
    status = server._insights_status({"groups": []}, [])
    assert status["missing"] == ["eyes"] and status["ready"] and status["enabled"]
    # on its own (the tag model off) it is not on at all
    store.save_config({**store.load_config(), "insights_enabled": False})
    assert not eyes.enabled()
    # the download: the pinned file, through the shared fetcher
    seen = []
    monkeypatch.setattr(insights, "fetch_files", lambda job, repo, files, d, what: seen.append((repo, files, d)))
    r = api.post("/api/insights/model", json={"models": ["eyes"]})
    assert r.json() == {"ok": True, "ready": False}
    wait_job(api)
    (repo, files, d), = seen
    assert "senty-au/face_landmarks_detector-ONNX/resolve/337d582" in repo and d == eyes.model_dir()
    assert files == eyes.MODEL_FILES and files[0][3].startswith("sha256:")
