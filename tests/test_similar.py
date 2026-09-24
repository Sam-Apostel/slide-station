"""Look-alikes (similar.py): CLIP embeddings per slide and scan, near-duplicates with "keep the best",
the grouping safety net (split / merge), scenes, and look-alikes already in Immich.

The embedding function is replaced: most tests plant synthetic unit vectors straight into the tray's
embeddings.json (so the cosine between two slides is exactly what the test says), the background
test uses a fake model. SS_REAL_CLIP=1 adds a smoke test with the real model on synthetic scenes
(it downloads ~155 MB into the scratch library).
Run: uv run --python 3.12 pytest tests/test_similar.py -q
"""
from __future__ import annotations

import io
import os

import numpy as np
import pytest
from PIL import Image

import fake_immich
from conftest import new_tray, wait_job
from slidestation import imaging as im
from slidestation import insights, similar, store
from slidestation import workflow as wf
from slidestation.store import active_scans

DIM = 16
STEP = insights.step


def unit(v) -> np.ndarray:
    v = np.asarray(v, np.float32)
    return v / np.linalg.norm(v)


def near(base: np.ndarray, cos: float, seed: int) -> np.ndarray:
    """A unit vector at exactly `cos` from `base`."""
    r = np.random.default_rng(seed).normal(size=base.shape).astype(np.float32)
    r -= (r @ base) * base
    r /= np.linalg.norm(r)
    return unit(cos * base + np.sqrt(1 - cos * cos) * r)


def axis(k: int) -> np.ndarray:
    v = np.zeros(DIM, np.float32)
    v[k] = 1
    return v


def plant(sid: str, slides: dict | None = None, scans: dict | None = None) -> None:
    """Put embeddings for slides ({gid: (vector, sharpness)}) and scans ({scan: (vector, lum)}),
    keyed like the background helper would."""
    s = store.Session(sid)

    def fn(e):
        for gid, (v, sharp) in (slides or {}).items():
            e["slides"][gid] = {"key": similar.slide_key(s.group(gid)), "emb": similar._pack(v),
                                "q": {"sharp": sharp, "clipped": 0.0}}
        for x, (v, lum) in (scans or {}).items():
            e["scans"][x] = {"emb": similar._pack(v), "lum": lum}

    similar.update(sid, fn)


def payload(api, sid):
    return api.get(f"/api/sessions/{sid}").json()


def decide(api, sid, code=200, **body):
    r = api.post(f"/api/sessions/{sid}/insights/decide", json=body)
    assert r.status_code == code, r.text
    return r.json()


@pytest.fixture
def on(monkeypatch):
    """Insights on and "the model downloaded" (a fake backend); the background thread kept out."""
    monkeypatch.setattr(insights, "model_ready", lambda: True)
    monkeypatch.setattr(insights, "backend", lambda: None)
    monkeypatch.setattr(insights, "step", lambda: False)
    with insights.worker_busy:  # a slide the background worker was already analysing: let it finish
        pass
    store.save_config({**store.load_config(), "insights_enabled": True})
    (store.library() / "insights.json").unlink(missing_ok=True)


def gids(d):
    return [g["id"] for g in d["groups"]]


# --------------------------------------------------------------------------- near-duplicates


def test_duplicates_keep_the_best(api, tmp_path, on):
    sid, d = new_tray(api, tmp_path / "scans", slides=6)
    ids = gids(d)
    base = axis(0)
    plant(sid, {ids[0]: (base, 0.5), ids[1]: (near(base, 0.97, 1), 0.9), ids[3]: (near(base, 0.95, 2), 0.7),
                ids[2]: (axis(1), 0.5), ids[4]: (axis(2), 0.5), ids[5]: (near(axis(2), 0.5, 3), 0.5)})
    d = payload(api, sid)
    dup = d["similar"]["duplicates"]
    assert len(dup) == 1
    sug = dup[0]
    assert sug["groups"] == [ids[0], ids[1], ids[3]] and sug["best"] == ids[1]
    assert sug["source"] == similar.MODEL_ID and 0.93 < sug["confidence"] < 1
    assert d["insights"]["pending"] > 0  # scans still to embed: the UI keeps polling
    assert all(g["status"] == "new" for g in d["groups"])  # nothing applied by itself

    d = decide(api, sid, kind="duplicates", action="accept", value=sug["id"])
    assert [g["skip"] for g in d["groups"]] == [True, False, False, True, False, False]
    assert d["similar"]["duplicates"] == []
    assert insights.learned()["labels"]["duplicates"] == {"accepted": 1, "dismissed": 0}
    # gone: a stale id is a 404, not a surprise
    decide(api, sid, 404, kind="duplicates", action="accept", value=sug["id"])


def test_duplicates_keep_another_and_dismiss(api, tmp_path, on):
    sid, d = new_tray(api, tmp_path / "scans", slides=4)
    ids = gids(d)
    plant(sid, {ids[0]: (axis(0), 0.9), ids[1]: (near(axis(0), 0.96, 1), 0.2), ids[2]: (axis(3), 0.5)})
    sug = payload(api, sid)["similar"]["duplicates"][0]
    d = decide(api, sid, kind="duplicates", action="accept", value=sug["id"], keep=ids[1])
    assert [g["skip"] for g in d["groups"]][:2] == [True, False]

    api.patch(f"/api/sessions/{sid}/groups/{ids[0]}", json={"skip": False})
    sug = payload(api, sid)["similar"]["duplicates"][0]
    d = decide(api, sid, kind="duplicates", action="dismiss", value=sug["id"])
    assert d["similar"]["duplicates"] == [] and not any(g["skip"] for g in d["groups"])
    assert store.Session(sid).data["similar"]["apart"] == [similar._pair(ids[0], ids[1])]
    # a third slide like them later: only it comes back with them, the dismissed pair stays apart
    plant(sid, {ids[2]: (near(axis(0), 0.97, 2), 0.5)})
    dup = payload(api, sid)["similar"]["duplicates"]
    assert len(dup) == 1 and ids[2] in dup[0]["groups"]


def test_duplicates_window_skip_and_threshold(api, tmp_path, on):
    sid, d = new_tray(api, tmp_path / "scans", slides=6)
    ids = gids(d)
    base = axis(0)
    # the same picture 5 places apart: not a burst, not suggested
    plant(sid, {ids[0]: (base, 0.5), ids[5]: (base, 0.5), **{x: (axis(k + 1), 0.5) for k, x in enumerate(ids[1:5])}})
    assert payload(api, sid)["similar"]["duplicates"] == []
    # just under the threshold: not suggested; skipped slides never are
    plant(sid, {ids[1]: (near(base, similar.DUPLICATE - 0.01, 1), 0.5)})
    assert payload(api, sid)["similar"]["duplicates"] == []
    plant(sid, {ids[1]: (near(base, similar.DUPLICATE + 0.01, 1), 0.5)})
    assert len(payload(api, sid)["similar"]["duplicates"]) == 1
    api.patch(f"/api/sessions/{sid}/groups/{ids[1]}", json={"skip": True})
    assert payload(api, sid)["similar"]["duplicates"] == []
    # dismissed more than accepted: the threshold rises (up to DUPLICATE_MAX)
    assert similar.threshold() == similar.DUPLICATE
    insights.record("duplicates", "duplicates", "dismiss", 3)
    assert similar.DUPLICATE < similar.threshold() <= similar.DUPLICATE_MAX
    insights.record("duplicates", "duplicates", "dismiss", 30)
    assert similar.threshold() == pytest.approx(similar.DUPLICATE_MAX)


def test_turning_a_slide_makes_its_embedding_stale(api, tmp_path, on):
    sid, d = new_tray(api, tmp_path / "scans", slides=4)
    ids = gids(d)
    plant(sid, {ids[0]: (axis(0), 0.5), ids[1]: (axis(0), 0.5)})
    assert payload(api, sid)["similar"]["duplicates"]
    api.patch(f"/api/sessions/{sid}/groups/{ids[1]}", json={"rotation": 90})
    assert payload(api, sid)["similar"]["duplicates"] == []  # until it is embedded again, upright


# --------------------------------------------------------------------------- grouping safety net


def test_split_a_bracket_clip_disagrees_with(api, tmp_path, on):
    sid, d = new_tray(api, tmp_path / "scans", slides=4)  # slide 0 and 2 are brackets of 2 scans
    g0 = d["groups"][0]
    a, b = g0["active"]
    plant(sid, scans={a: (axis(0), 0.5), b: (near(axis(0), 0.5, 1), 0.3)})
    sp = payload(api, sid)["similar"]["split"]
    assert [x["id"] for x in sp] == [f"split:{g0['id']}:{b}"] and sp[0]["scan"] == b
    d = decide(api, sid, kind="split", action="accept", value=sp[0]["id"])
    assert len(d["groups"]) == 5 and d["groups"][0]["scans"] == [a] and d["groups"][1]["scans"] == [b]

    # a bracket whose scans agree is left alone; a dismissed split stays away
    g2 = d["groups"][3]
    c, e = g2["active"]
    plant(sid, scans={c: (axis(1), 0.5), e: (near(axis(1), similar.SPLIT + 0.05, 2), 0.3)})
    assert payload(api, sid)["similar"]["split"] == []
    plant(sid, scans={e: (near(axis(1), 0.3, 2), 0.3)})
    sp = payload(api, sid)["similar"]["split"]
    d = decide(api, sid, kind="split", action="dismiss", value=sp[0]["id"])
    assert d["similar"]["split"] == [] and len(d["groups"]) == 5


def test_merge_neighbours_that_are_one_frame(api, tmp_path, on, monkeypatch):
    sid, d = new_tray(api, tmp_path / "scans", slides=4)
    ids = gids(d)
    last0 = d["groups"][0]["active"][-1]
    first1 = d["groups"][1]["active"][0]
    # the synthetic slides are different pictures: structurally unrelated, so never merged...
    plant(sid, scans={last0: (axis(0), 0.6), first1: (near(axis(0), 0.97, 1), 0.3)})
    assert payload(api, sid)["similar"]["merge"] == []
    # ... unless the signatures agree enough (here: the gate turned off)
    monkeypatch.setattr(similar, "MERGE_STRUCT", -1.0)
    similar._cache.clear()
    mg = payload(api, sid)["similar"]["merge"]
    assert [x["groups"] for x in mg] == [[ids[0], ids[1]]] and mg[0]["stops"] == 1.0
    # at the same exposure it's the same shot twice, not a bracket: a duplicate question, not merge
    plant(sid, scans={first1: (near(axis(0), 0.97, 1), 0.6)})
    assert payload(api, sid)["similar"]["merge"] == []
    plant(sid, scans={first1: (near(axis(0), 0.97, 1), 0.3)})
    # a merge pair isn't offered as duplicates too
    plant(sid, {ids[0]: (axis(5), 0.5), ids[1]: (axis(5), 0.5)})
    d = payload(api, sid)
    assert d["similar"]["duplicates"] == [] and len(d["similar"]["merge"]) == 1
    d = decide(api, sid, kind="merge", action="accept", value=d["similar"]["merge"][0]["id"])
    assert len(d["groups"]) == 3 and d["groups"][0]["scans"][-1] == first1


# --------------------------------------------------------------------------- scenes


def test_scenes_cut_at_change_points():
    rng = np.random.default_rng(0)
    groups = [{"id": f"g{i}", "scans": [f"s{i}"], "excluded": [], "rotation": 0} for i in range(11)]
    a, b, c = axis(0), axis(1), axis(2)
    seq = [a, a, a, b, a, a, c, c, c, c, a]  # an odd slide (3) inside scene a doesn't cut it
    vecs = [near(v, 0.95, int(rng.integers(1e6))) for v in seq]
    e = {"slides": {g["id"]: {"key": similar.slide_key(g), "emb": similar._pack(v)} for g, v in zip(groups, vecs)},
         "scans": {}}
    for g in groups[6:10]:
        g["tags"] = ["beach"] if g["id"] != "g9" else []
    groups[7]["skip"] = True  # skipped: stays with the scene around it
    sc = similar.scenes(groups, e)
    assert [(x["start"], x["end"]) for x in sc] == [(0, 5), (6, 9), (10, 10)]
    assert [x["label"] for x in sc] == ["", "beach", ""]
    # one scene only: no cuts at all
    same = {"slides": {g["id"]: {"key": similar.slide_key(g), "emb": similar._pack(near(a, 0.95, i))}
                       for i, g in enumerate(groups)}, "scans": {}}
    assert similar.scenes(groups, same) == []


def test_scenes_in_the_payload_and_propagation(api, tmp_path, on):
    sid, d = new_tray(api, tmp_path / "scans", slides=6)
    ids = gids(d)
    plant(sid, {x: (near(axis(0 if k < 3 else 1), 0.97, k), 0.5) for k, x in enumerate(ids)})
    sc = payload(api, sid)["similar"]["scenes"]
    assert [(x["start"], x["end"]) for x in sc] == [(0, 2), (3, 5)]
    # "Apply to this scene": the propagation endpoint over the scene's slides
    r = api.post(f"/api/sessions/{sid}/insights/propagate",
                 json={"kind": "date", "value": "1978-08", "from": ids[sc[1]["start"]], "to": ids[sc[1]["end"]]})
    assert r.json()["applied"] == 3
    assert [g["date"] for g in r.json()["groups"]] == ["", "", "", "1978-08", "1978-08", "1978-08"]


# --------------------------------------------------------------------------- background embedding


class FakeModel:
    """Label embeddings for the tags (as in test_insights), and image embeddings from the picture
    itself: a normalised 8x8 grey thumbnail, so the same picture (any exposure) points the same way."""

    def __init__(self):
        self.calls = 0

    def label_embeds(self):
        return np.eye(len(insights.TAGS), 64, dtype=np.float32)

    def image_embed(self, rgb):
        self.calls += 1
        g = np.asarray(Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).convert("L").resize((8, 8)),
                       np.float32)
        return unit((g - g.mean()) / (g.std() + 1e-6)).ravel()


def test_background_embeds_slides_and_scans(api, tmp_path, on, monkeypatch):
    fake = FakeModel()
    monkeypatch.setattr(insights, "backend", lambda: fake)
    sid, d = new_tray(api, tmp_path / "scans", slides=4)
    payload(api, sid)  # the open tray
    while STEP():
        pass
    e = similar.load(sid)
    s = store.Session(sid)
    assert set(e["slides"]) == set(gids(d))
    assert all(e["slides"][g["id"]]["key"] == similar.slide_key(g) for g in s.data["groups"])
    assert set(e["scans"]) == {x for g in s.data["groups"] for x in active_scans(g)}
    assert all(0 < v["lum"] < 1 and "sharp" in e["slides"][k]["q"] for k, v in zip(e["slides"], e["scans"].values()))
    d = payload(api, sid)
    assert d["insights"]["pending"] == 0 and d["similar"] is not None
    # a bracket's scans are the same picture at two exposures: exposure-normalised, they agree
    a, b = d["groups"][0]["active"]
    assert similar.unpack(e["scans"][a]["emb"]) @ similar.unpack(e["scans"][b]["emb"]) > 0.99
    assert d["similar"]["split"] == []
    # turned: embedded again (the tags too), nothing else
    n = fake.calls
    api.patch(f"/api/sessions/{sid}/groups/{d['groups'][1]['id']}", json={"rotation": 90})
    assert payload(api, sid)["insights"]["pending"] == 1  # to analyse, and that embeds it too: once
    while STEP():
        pass
    assert fake.calls == n + 1  # one embedding serves the tags and the look-alikes
    assert payload(api, sid)["insights"]["pending"] == 0
    # off: no look-alike suggestions in the payload at all
    store.save_config({**store.load_config(), "insights_enabled": False})
    assert payload(api, sid)["similar"] is None


# --------------------------------------------------------------------------- look-alikes in Immich


def _jpeg(a: np.ndarray) -> bytes:
    out = io.BytesIO()
    Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).save(out, "JPEG", quality=92)
    return out.getvalue()


@pytest.fixture
def looking(api, tmp_path, on, immich_db, monkeypatch):
    """A 4-slide tray and, already in Immich, an old scan of slide 0's picture (plus an unrelated
    photo), in an album and a favourite. Look-alike checks on, the fake model."""
    from synthetic import scene

    fake = FakeModel()
    monkeypatch.setattr(insights, "backend", lambda: fake)
    monkeypatch.setattr(fake_immich, "SMART", "ok")
    monkeypatch.setattr(fake_immich, "UNINDEXED", set())
    old = fake_immich.add_asset(_jpeg(scene(1000, 480, 320) * 1.1), "old-scan.jpg", "2020-01-05T00:00:00.000Z",
                                favorite=True)
    other = fake_immich.add_asset(_jpeg(scene(4242, 480, 320)), "other.jpg", "2020-01-06T00:00:00.000Z")
    fake_immich.DB["albums"]["alb-old"] = {"name": "Scanned in 2021", "assets": [old, other]}
    store.save_config({**store.load_config(), "lookalike_enabled": True})
    sid, d = new_tray(api, tmp_path / "scans", slides=4)
    api.patch(f"/api/sessions/{sid}", json={"date": "2020-01"})
    return sid, d, old, other


def test_lookalike_after_upload_and_replace(api, looking):
    sid, d, old, other = looking
    api.post(f"/api/sessions/{sid}/finish", json={})
    job = wait_job(api)
    assert "1 slide may already be in Immich" in job["message"], job["message"]
    d = payload(api, sid)
    look = d["groups"][0]["lookalike"]
    assert look["state"] == "checked" and look["via"] == "smart"
    assert [m["id"] for m in look["matches"]] == [old] and look["matches"][0]["name"] == "old-scan.jpg"
    assert all(not g["lookalike"]["matches"] for g in d["groups"][1:])  # its own tray's assets never count
    new = store.Session(sid).group(d["groups"][0]["id"])["immich"]["asset_id"]

    d = decide(api, sid, kind="lookalike", action="accept", value=old, groups=[d["groups"][0]["id"]])
    assert d["groups"][0]["lookalike"]["matches"][0]["state"] == "accepted"
    a = fake_immich.DB["assets"]
    assert a[old]["trashed"] and not a[other]["trashed"]
    assert new in fake_immich.DB["albums"]["alb-old"]["assets"] and a[new]["favorite"]
    decide(api, sid, 404, kind="lookalike", action="accept", value=old, groups=[d["groups"][0]["id"]])


def test_lookalike_waits_for_immich_to_index(api, looking, monkeypatch):
    sid, d, old, other = looking
    orig = fake_immich.add_asset

    def unindexed(*a, **k):  # every upload arrives before Immich's machine learning has seen it
        aid = orig(*a, **k)
        fake_immich.UNINDEXED.add(aid)
        return aid

    monkeypatch.setattr(fake_immich, "add_asset", unindexed)
    api.post(f"/api/sessions/{sid}/finish", json={})
    assert "4 slides to check for look-alikes once Immich has indexed them" in wait_job(api)["message"]
    assert payload(api, sid)["groups"][0]["lookalike"]["state"] == "pending"
    fake_immich.UNINDEXED.clear()
    assert api.post(f"/api/sessions/{sid}/lookalikes", json={}).json() == {"ok": True}
    assert "1 slide may already be in Immich" in wait_job(api)["message"]
    d = payload(api, sid)
    assert d["groups"][0]["lookalike"]["matches"][0]["id"] == old
    d = decide(api, sid, kind="lookalike", action="dismiss", value=old, groups=[d["groups"][0]["id"]])
    assert d["groups"][0]["lookalike"]["matches"][0]["state"] == "dismissed"
    assert not fake_immich.DB["assets"][old]["trashed"]
    # checked again: the decision stays
    api.post(f"/api/sessions/{sid}/lookalikes", json={"all": True})
    wait_job(api)
    assert payload(api, sid)["groups"][0]["lookalike"]["matches"][0]["state"] == "dismissed"


@pytest.mark.parametrize("mode", ["old", "off"])
def test_lookalike_by_date_without_smart_search(api, looking, monkeypatch, mode):
    sid, d, old, other = looking
    monkeypatch.setattr(fake_immich, "SMART", mode)
    api.post(f"/api/sessions/{sid}/finish", json={})
    wait_job(api)
    look = payload(api, sid)["groups"][0]["lookalike"]
    assert look["via"] == "date" and [m["id"] for m in look["matches"]] == [old]
    # a slide without any date can't be looked for this way
    api.patch(f"/api/sessions/{sid}", json={"date": ""})
    api.post(f"/api/sessions/{sid}/lookalikes", json={"all": True})
    wait_job(api)
    assert payload(api, sid)["groups"][0]["lookalike"]["state"] == "unsupported"


def test_lookalike_off_by_default(api, looking):
    sid, d, old, other = looking
    store.save_config({**store.load_config(), "lookalike_enabled": False})
    api.post(f"/api/sessions/{sid}/finish", json={})
    assert "look-alike" not in wait_job(api)["message"]
    assert all(g["lookalike"] is None for g in payload(api, sid)["groups"])
    assert not any(x[0] == "smart" for x in fake_immich.DB["log"])


def test_date_window():
    assert similar._date_window("1978-08") == ("1978-07-31T00:00:00.000Z", "1978-09-02T00:00:00.000Z")
    assert similar._date_window("1978-12-31") == ("1978-12-30T00:00:00.000Z", "1979-01-02T00:00:00.000Z")
    assert similar._date_window("1978")[1] == "1979-01-02T00:00:00.000Z"
    assert similar._date_window("") is None


# --------------------------------------------------------------------------- the real model


@pytest.mark.skipif(not os.environ.get("SS_REAL_CLIP"), reason="set SS_REAL_CLIP=1 to download and run the real model")
def test_real_clip_similarities():
    """The thresholds against the real model on synthetic pictures: a bracket's scans (exposure-
    normalised) agree above MERGE, a beach and a snowy mountain are far below DUPLICATE and SPLIT."""
    from test_insights import _beach_scene, _snow_scene

    if not insights.model_ready():
        insights.download_model(wf.Job("model", None))
    b = insights.backend()
    beach, snow = _beach_scene(320, 480), _snow_scene(320, 480)
    e = lambda a: b.image_embed(similar.normalise(a))  # noqa: E731
    bracket = float(e(beach) @ e(beach * 0.55))
    bracket_snow = float(e(snow) @ e(snow * 0.55))
    apart = float(e(beach) @ e(snow))
    blend = float(b.image_embed(beach) @ b.image_embed(snow))
    print(f"bracket {bracket:.3f} / {bracket_snow:.3f}, beach vs snow {apart:.3f} (blends {blend:.3f})")
    assert min(bracket, bracket_snow) >= similar.MERGE
    assert apart < similar.SPLIT and blend < similar.DUPLICATE
    assert im.scan_quality(beach)["clipped"] < 0.5  # sanity: the scene isn't clipped
