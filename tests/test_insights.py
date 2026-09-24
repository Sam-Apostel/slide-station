"""Insights: scene tags from CLIP as suggestions, accept / dismiss, learning from dismissals,
propagation along the tray, the model download, and tags going to Immich.

CLIP is replaced by a fake embedding (no model, no network). The one real-model test runs only with
SS_REAL_CLIP=1: it downloads the ~155 MB model into the scratch library and tags two synthetic
scenes. Run: uv run --python 3.12 pytest tests -q   (SS_REAL_CLIP=1 for the real model too)
"""
from __future__ import annotations

import hashlib
import os
import threading

import httpx
import numpy as np
import pytest
from PIL import Image

import fake_immich
from conftest import new_tray, wait_job
from slidestation import insights, store
from slidestation import workflow as wf

N = len(insights.TAGS)


class FakeClip:
    """Labels are one-hot directions; `picks(rgb)` says which labels an image points at (equally)."""

    def __init__(self, picks=lambda rgb: ["beach", "sea"]):
        self.picks = picks
        self.calls = 0

    def label_embeds(self) -> np.ndarray:
        return np.eye(N, dtype=np.float32)

    def image_embed(self, rgb: np.ndarray) -> np.ndarray:
        self.calls += 1
        v = np.zeros(N, np.float32)
        for t in self.picks(rgb):
            v[insights.TAGS.index(t)] = 1
        return v / np.linalg.norm(v)


STEP = insights.step


@pytest.fixture
def clip(monkeypatch):
    """Insights on, with the fake model. The background thread is kept out of it (it calls the
    module's `step`, patched to do nothing), so the tests decide when slides are analysed."""
    fake = FakeClip()
    monkeypatch.setattr(insights, "backend", lambda: fake)
    monkeypatch.setattr(insights, "model_ready", lambda: True)
    monkeypatch.setattr(insights, "step", lambda: False)
    with insights.worker_busy:  # a slide the background worker was already analysing: let it finish
        pass
    store.save_config({**store.load_config(), "insights_enabled": True})
    (store.library() / "insights.json").unlink(missing_ok=True)
    return fake


def analyse_all():
    while STEP():
        pass


def payload(api, sid):
    return api.get(f"/api/sessions/{sid}").json()  # also makes it the open tray (wf.active_session)


def decide(api, sid, **body):
    r = api.post(f"/api/sessions/{sid}/insights/decide", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def tag_states(g) -> dict:
    return {e["value"]: e["state"] for e in (g["insights"] or {}).get("tags", [])}


# --------------------------------------------------------------------------- analysis


def test_off_by_default_and_without_model(api, tray, monkeypatch):
    sid, _ = tray
    d = payload(api, sid)
    assert d["insights"] == {"enabled": False, "ready": False, "pending": 4, "missing": []}
    assert not STEP()  # disabled: nothing happens
    store.save_config({**store.load_config(), "insights_enabled": True})
    assert not STEP()  # enabled, but no model downloaded
    # nothing from a model (a film-stock guess needs none: test_filmstock.py)
    assert all(not (g["insights"] or {}).get("tags") and g["tags"] == [] for g in payload(api, sid)["groups"])


def test_suggestions_are_never_applied(api, tray, clip):
    sid, _ = tray
    payload(api, sid)
    analyse_all()
    d = payload(api, sid)
    assert d["insights"]["pending"] == 0
    for g in d["groups"]:
        assert tag_states(g) == {"beach": "suggested", "sea": "suggested"}
        assert g["tags"] == [] and not g["insights"]["stale"]
        e = g["insights"]["tags"][0]
        assert e["source"] == insights.MODEL_ID and 0.4 < e["confidence"] <= 0.5
        assert g["status"] == "new"


def test_accept_dismiss_and_they_stay(api, tray, clip):
    sid, d = tray
    payload(api, sid)
    analyse_all()
    g0 = d["groups"][0]["id"]
    d = decide(api, sid, kind="tags", action="accept", value="beach", groups=[g0])
    assert d["decided"] == 1 and d["groups"][0]["tags"] == ["beach"]
    d = decide(api, sid, kind="tags", action="dismiss", value="sea", groups=[g0])
    assert tag_states(d["groups"][0]) == {"beach": "accepted", "sea": "dismissed"}
    # a decided suggestion is not decided again
    assert decide(api, sid, kind="tags", action="accept", value="sea", groups=[g0])["decided"] == 0

    # analysed again (new scans / rotation / "Analyse again"): the decisions stay
    api.post(f"/api/sessions/{sid}/insights/run", json={"force": True})
    assert payload(api, sid)["insights"]["pending"] == 4
    analyse_all()
    d = payload(api, sid)
    assert tag_states(d["groups"][0]) == {"beach": "accepted", "sea": "dismissed"}
    assert d["groups"][0]["tags"] == ["beach"]
    assert tag_states(d["groups"][1]) == {"beach": "suggested", "sea": "suggested"}
    assert insights.learned()["labels"] == {"beach": {"accepted": 1, "dismissed": 0},
                                            "sea": {"accepted": 0, "dismissed": 1}}


def test_rotation_makes_insights_stale(api, tray, clip):
    sid, d = tray
    payload(api, sid)
    analyse_all()
    g0 = d["groups"][0]["id"]
    decide(api, sid, kind="tags", action="dismiss", value="sea", groups=[g0])
    calls = clip.calls
    api.patch(f"/api/sessions/{sid}/groups/{g0}", json={"rotation": 90})
    d = payload(api, sid)
    assert d["insights"]["pending"] == 1 and d["groups"][0]["insights"]["stale"]
    analyse_all()
    assert clip.calls >= calls + 1
    assert tag_states(payload(api, sid)["groups"][0])["sea"] == "dismissed"


def test_skipped_slides_are_not_analysed(api, tray, clip):
    sid, d = tray
    api.patch(f"/api/sessions/{sid}/groups/{d['groups'][1]['id']}", json={"skip": True})
    payload(api, sid)
    analyse_all()
    d = payload(api, sid)
    assert d["groups"][1]["insights"] is None and d["insights"]["pending"] == 0


def test_a_failing_slide_is_noted_not_retried(api, tray, clip):
    sid, _ = tray

    def broken(rgb):
        raise ValueError("bad pixels")

    clip.picks = broken
    payload(api, sid)
    analyse_all()  # would never end if failed slides were retried
    d = payload(api, sid)
    assert d["insights"]["pending"] == 0
    assert all(g["insights"]["error"] == "bad pixels" for g in d["groups"])


def test_removing_a_tag_dismisses_it(api, tray, clip):
    sid, d = tray
    payload(api, sid)
    analyse_all()
    g0 = d["groups"][0]["id"]
    decide(api, sid, kind="tags", action="accept", groups=[g0])  # every open tag suggestion
    r = api.patch(f"/api/sessions/{sid}/groups/{g0}", json={"tags": ["sea", " Summer  1978 ", "sea", ""]})
    g = r.json()["groups"][0]
    assert g["tags"] == ["sea", "summer 1978"]
    assert tag_states(g) == {"beach": "dismissed", "sea": "accepted"}


def test_dismissing_raises_the_labels_threshold(api, tray, clip):
    assert insights.threshold("dog") == insights.THRESHOLD
    for _ in range(3):
        insights.record("tags", "dog", "dismiss")
    assert insights.threshold("dog") == pytest.approx(insights.THRESHOLD * 4)
    insights.record("tags", "dog", "accept")
    assert insights.threshold("dog") == pytest.approx(insights.THRESHOLD * 2)
    # four equally likely labels (0.25 each): dog now needs 0.24 -> still in; after more dismissals it's out
    clip.picks = lambda rgb: ["dog", "cat", "car", "boat"]
    sid, _ = tray
    payload(api, sid)
    analyse_all()
    assert "dog" in tag_states(payload(api, sid)["groups"][0])
    insights.record("tags", "dog", "dismiss", 5)
    api.post(f"/api/sessions/{sid}/insights/run", json={"force": True})
    analyse_all()
    assert "dog" not in tag_states(payload(api, sid)["groups"][0])


def test_accept_all_of_a_kind(api, tray, clip):
    sid, d = tray
    payload(api, sid)
    analyse_all()
    g1 = d["groups"][1]["id"]
    decide(api, sid, kind="tags", action="dismiss", value="beach", groups=[g1])
    d = decide(api, sid, kind="tags", action="accept", value="beach")  # the review view's "accept all"
    assert d["decided"] == 3  # the dismissed one stays dismissed
    assert [g["tags"] for g in d["groups"]] == [["beach"], [], ["beach"], ["beach"]]
    d = decide(api, sid, kind="tags", action="dismiss", value="sea")
    assert d["decided"] == 4 and all(tag_states(g)["sea"] == "dismissed" for g in d["groups"])
    assert api.post(f"/api/sessions/{sid}/insights/decide", json={"kind": "mood", "action": "accept"}).status_code == 400


def test_caption_and_date_suggestions(api, tray, clip):
    """No model makes these yet (a VLM, mount OCR); the plumbing takes them like tags."""
    sid, d = tray
    g0 = d["groups"][0]["id"]

    def plant(s):
        g = s.group(g0)
        g["insights"] = {"key": insights.insights_key(g), "tags": [],
                         "caption": {"value": "On the beach", "source": "test", "confidence": 0.8, "state": "suggested"},
                         "date": {"value": "1978-08", "source": "test", "confidence": 0.6, "state": "suggested"}}

    wf.update_session(sid, plant)
    d = decide(api, sid, kind="caption", action="accept", groups=[g0])
    d = decide(api, sid, kind="date", action="dismiss", groups=[g0])
    g = d["groups"][0]
    assert g["caption"] == "On the beach" and g["date"] == ""
    assert g["insights"]["caption"]["state"] == "accepted" and g["insights"]["date"]["state"] == "dismissed"


# --------------------------------------------------------------------------- propagation


def test_propagate_along_the_tray(api, tray, clip):
    sid, d = tray
    ids = [g["id"] for g in d["groups"]]
    payload(api, sid)
    analyse_all()
    decide(api, sid, kind="tags", action="accept", value="beach", groups=[ids[1]])
    r = api.post(f"/api/sessions/{sid}/insights/propagate", json={"kind": "tags", "value": "beach", "from": ids[3], "to": ids[0]})
    d = r.json()
    assert d["applied"] == 3  # slide 2 had it already
    assert all(g["tags"] == ["beach"] and tag_states(g)["beach"] == "accepted" for g in d["groups"])
    d = api.post(f"/api/sessions/{sid}/insights/propagate",
                 json={"kind": "date", "value": "1978/08", "from": ids[1], "to": ids[2]}).json()
    assert [g["date"] for g in d["groups"]] == ["", "1978-08", "1978-08", ""]
    d = api.post(f"/api/sessions/{sid}/insights/propagate",
                 json={"kind": "caption", "value": "Lake Garda", "from": ids[0], "to": ids[1]}).json()
    assert [g["caption"] for g in d["groups"]] == ["Lake Garda", "Lake Garda", "", ""]
    bad = api.post(f"/api/sessions/{sid}/insights/propagate", json={"kind": "date", "value": "Aug", "from": ids[0], "to": ids[1]})
    assert bad.status_code == 400


# --------------------------------------------------------------------------- Immich + export


def test_tags_go_to_immich_and_xmp(api, tray, immich_db, monkeypatch):
    sid, d = tray
    fake_immich.DB["tags"] = {}
    store.save_config({**store.load_config(), "keep_exports": True})
    ids = [g["id"] for g in d["groups"]]
    api.patch(f"/api/sessions/{sid}/groups/{ids[0]}", json={"tags": ["beach", "family group"]})
    api.patch(f"/api/sessions/{sid}/groups/{ids[1]}", json={"tags": ["beach"]})
    assert api.post(f"/api/sessions/{sid}/finish", json={}).json() == {"ok": True}
    job = wait_job(api)
    assert "tags not sent" not in job["message"]
    s = store.Session(sid)
    assets = [s.group(x)["immich"]["asset_id"] for x in ids]
    tags = {v["value"]: set(v["assets"]) for v in fake_immich.DB["tags"].values()
            if not v["value"].startswith("Trays")}  # the tray tag: test_immich_album.py
    assert tags == {"beach": {assets[0], assets[1]}, "family group": {assets[0]}}
    xmp = Image.open(s.export_dir / s.group(ids[0])["export"]["file"]).info.get("xmp", b"")
    assert b"<rdf:li>beach</rdf:li>" in xmp and b"<rdf:li>family group</rdf:li>" in xmp
    # a tag changed after upload: the slide is "changed" and goes up again
    d = api.patch(f"/api/sessions/{sid}/groups/{ids[1]}", json={"tags": ["beach", "sea"]}).json()
    assert [g["status"] for g in d["groups"]] == ["uploaded", "changed", "uploaded", "uploaded"]


def test_immich_without_tag_api(api, tray, immich_db, monkeypatch):
    sid, d = tray
    monkeypatch.setattr(fake_immich, "TAGS", False)
    api.patch(f"/api/sessions/{sid}/groups/{d['groups'][0]['id']}", json={"tags": ["beach"]})
    api.post(f"/api/sessions/{sid}/finish", json={})
    job = wait_job(api)
    assert "tags not sent" in job["message"] and "v1.113" in job["message"]
    assert all(g["status"] == "uploaded" for g in payload(api, sid)["groups"])


def test_untagged_meta_key_unchanged():
    """Slides uploaded before tags existed must not turn "changed"."""
    g = {"caption": "x"}
    assert store.meta_key(g, {"value": "1978"}) == store.meta_key({**g, "tags": []}, {"value": "1978"})
    assert store.meta_key(g, {"value": "1978"}) != store.meta_key({**g, "tags": ["a"]}, {"value": "1978"})


# --------------------------------------------------------------------------- model download


BLOB = os.urandom(300_000)
SMALL = b'{"a": 1}'


def _files():
    git = hashlib.sha1(b"blob %d\0" % len(SMALL) + SMALL).hexdigest()
    return [("big.onnx", "vision.onnx", len(BLOB), "sha256:" + hashlib.sha256(BLOB).hexdigest()),
            ("small.json", "vocab.json", len(SMALL), "git:" + git)]


@pytest.fixture
def served(monkeypatch):
    """Model files served by an in-process handler that honours Range; `served.fail` breaks it."""
    state = {"requests": [], "fail": None}
    content = {"big.onnx": BLOB, "small.json": SMALL}

    def handler(req: httpx.Request):
        if state["fail"]:
            raise state["fail"]
        name = req.url.path.rsplit("/", 1)[-1]
        rng = req.headers.get("range")
        state["requests"].append((name, rng))
        body = content[name]
        if rng:
            start = int(rng.split("=")[1].rstrip("-"))
            return httpx.Response(206, content=body[start:])
        return httpx.Response(200, content=body)

    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(insights, "MODEL_FILES", _files())
    monkeypatch.setattr(insights, "MODEL_MB", 1)
    return state


def test_download_resumes_and_verifies(served):
    d = insights.model_dir()
    d.mkdir(parents=True, exist_ok=True)
    for f in d.iterdir():
        f.unlink()
    (d / "vision.onnx.part").write_bytes(BLOB[:100_000])  # an earlier attempt stopped here
    job = wf.Job("model", None)
    insights.download_model(job)
    assert (d / "vision.onnx").read_bytes() == BLOB and (d / "vocab.json").read_bytes() == SMALL
    assert ("big.onnx", "bytes=100000-") in served["requests"]
    assert not list(d.glob("*.part")) and insights.model_ready()
    served["requests"].clear()
    insights.download_model(wf.Job("model", None))  # all there: nothing fetched
    assert served["requests"] == []


def test_download_offline_and_corrupt(served):
    d = insights.model_dir()
    d.mkdir(parents=True, exist_ok=True)
    for f in d.iterdir():
        f.unlink()
    served["fail"] = httpx.ConnectError("no network")
    with pytest.raises(RuntimeError, match="Couldn't reach huggingface.co"):
        insights.download_model(wf.Job("model", None))
    assert not insights.model_ready()
    served["fail"] = None
    (d / "vision.onnx.part").write_bytes(b"x" * 100_000)  # a bad partial file: the checksum catches it
    with pytest.raises(RuntimeError, match="checksum"):
        insights.download_model(wf.Job("model", None))
    assert not (d / "vision.onnx").exists() and not (d / "vision.onnx.part").exists()
    insights.download_model(wf.Job("model", None))  # and the next attempt starts over, cleanly
    assert insights.model_ready()


def test_model_endpoint_runs_a_job(api, served):
    d = insights.model_dir()
    d.mkdir(parents=True, exist_ok=True)
    for f in d.iterdir():
        f.unlink()
    assert api.get("/api/insights").json()["ready"] is False
    assert api.post("/api/insights/model").json() == {"ok": True, "ready": False}
    job = wait_job(api)
    assert job["kind"] == "model" and job["done"] == job["total"]
    assert api.post("/api/insights/model").json() == {"ok": True, "ready": True}


# --------------------------------------------------------------------------- the real model


def _snow_scene(h=300, w=400):
    yy, xx = np.mgrid[0:h, 0:w] / np.array([h, w]).reshape(2, 1, 1)
    a = np.empty((h, w, 3), np.float32)
    a[:] = [0.55, 0.7, 0.92]  # sky
    a[yy > 0.25 + np.abs(xx - 0.5) * 0.9] = [0.97, 0.97, 1.0]  # a snowy peak
    a[yy > 0.6] = [0.95, 0.96, 0.99]  # snowfield
    for cx in np.random.default_rng(0).uniform(0, 1, 14):  # dark firs on the snow
        a[(yy > 0.5) & (yy < 0.75) & (np.abs(xx - cx) < (yy - 0.5) * 0.15)] = [0.08, 0.2, 0.1]
    return np.clip(a + np.random.default_rng(1).normal(0, 0.02, a.shape), 0, 1).astype(np.float32)


def _beach_scene(h=300, w=400):
    a = np.zeros((h, w, 3), np.float32)
    a[: h // 2] = [0.35, 0.6, 0.95]  # sky
    a[h // 2 : int(h * 0.7)] = [0.1, 0.35, 0.7]  # sea
    a[int(h * 0.7) :] = [0.93, 0.83, 0.6]  # sand
    return a


@pytest.mark.skipif(not os.environ.get("SS_REAL_CLIP"), reason="set SS_REAL_CLIP=1 to download and run the real model")
def test_real_clip_on_synthetic_scenes():
    if not insights.model_ready():
        insights.download_model(wf.Job("model", None))
    b = insights.backend()
    assert b is not None and b.label_embeds().shape == (N, 512)
    beach = [t for t, _ in insights.scene_tags(b, _beach_scene())[:2]]
    snow = [t for t, _ in insights.scene_tags(b, _snow_scene())[:3]]
    print("beach:", beach, "snow:", snow)
    assert "beach" in beach
    assert {"snow", "mountains"} & set(snow) and "beach" not in snow
