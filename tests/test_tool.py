"""The tool itself (ROADMAP §6): 1:1 zoom tiles, presets and "develop like" across trays, stats.
Run with:  uv run --python 3.12 pytest tests -q
"""
from __future__ import annotations

import io
import json
import time

import pytest
from PIL import Image

from conftest import new_tray, wait_job
from slidestation import stats, store
from slidestation import workflow as wf
from slidestation.store import Session

LOOK = {"strength": 0.2, "brightness": 0.3, "warmth": -0.25, "saturation": 0.4,
        "curves": {"rgb": [[0, 0.05], [1, 1]]}}


def patch(api, sid, gid, body, code=200):
    r = api.patch(f"/api/sessions/{sid}/groups/{gid}", json=body)
    assert r.status_code == code, r.text
    return r.json()


def groups(api, sid) -> list[dict]:
    return api.get(f"/api/sessions/{sid}").json()["groups"]


@pytest.fixture
def presets():
    store.save_presets([])
    yield
    store.save_presets([])


# --------------------------------------------------------------------------- 1:1 zoom


def test_full_resolution_tiles(api, tray):
    sid, d = tray
    g = d["groups"][1]  # a single scan: the full render is the original developed
    info = api.get(f"/api/sessions/{sid}/groups/{g['id']}/full").json()
    orig = Image.open(Session(sid).original_path(g["scans"][0])).size
    trimmed = (info["width"], info["height"])
    assert info["tile"] == wf.TILE and info["key"] == g["key"]
    assert trimmed[0] <= orig[0] and trimmed[1] <= orig[1] and trimmed[0] > orig[0] * 0.8  # mount edges trimmed
    # the grid of tiles covers the render exactly; the last ones are the remainder
    cols, rows = -(-info["width"] // wf.TILE), -(-info["height"] // wf.TILE)
    url = f"/api/sessions/{sid}/groups/{g['id']}/tile.jpg"
    first = api.get(f"{url}?col=0&row=0&v={g['key']}")
    assert first.status_code == 200 and "max-age" in first.headers["cache-control"]
    assert Image.open(io.BytesIO(first.content)).size == (min(wf.TILE, info["width"]), min(wf.TILE, info["height"]))
    last = Image.open(io.BytesIO(api.get(f"{url}?col={cols - 1}&row={rows - 1}").content)).size
    assert last == (info["width"] - (cols - 1) * wf.TILE, info["height"] - (rows - 1) * wf.TILE)
    assert api.get(f"{url}?col={cols}&row=0").status_code == 404
    assert api.get(f"{url}?col=0&row=0&v=stale").headers["cache-control"] == "no-store"


def test_full_render_follows_edits_and_reuses_export(api, tray, monkeypatch):
    sid, d = tray
    g = d["groups"][0]
    before = api.get(f"/api/sessions/{sid}/groups/{g['id']}/full").json()
    patch(api, sid, g["id"], {"rotation": 90})
    after = api.get(f"/api/sessions/{sid}/groups/{g['id']}/full").json()
    assert (after["width"], after["height"]) == (before["height"], before["width"])  # rendered again, turned
    # a finished export of the same render is decoded instead of fusing the originals again
    wf.render_export(sid, g["id"], 90)
    wf._full.clear()
    monkeypatch.setattr(wf.im, "fuse", lambda *_: pytest.fail("fused although the export was fresh"))
    again = api.get(f"/api/sessions/{sid}/groups/{g['id']}/full").json()
    assert (again["width"], again["height"]) == (after["width"], after["height"])


def test_full_resolution_needs_originals(api, tray):
    sid, d = tray
    g = d["groups"][1]
    Session(sid).original_path(g["scans"][0]).unlink()
    wf._full.clear()
    r = api.get(f"/api/sessions/{sid}/groups/{g['id']}/full")
    assert r.status_code == 409 and "deleted" in r.json()["detail"]


# --------------------------------------------------------------------------- presets


def test_preset_save_list_replace_delete(api, tray, presets):
    sid, d = tray
    g = d["groups"][0]
    patch(api, sid, g["id"], {"params": {**LOOK, "crop": [0.1, 0.1, 0.9, 0.9], "angle": 3}})
    out = api.post("/api/presets", json={"name": "Faded Ektachrome", "session": sid, "group": g["id"]}).json()
    (p,) = out["presets"]
    assert p["name"] == "Faded Ektachrome"
    assert "crop" not in p["params"] and "angle" not in p["params"]  # never the framing
    assert p["params"]["warmth"] == -0.25 and p["params"]["curves"] == {"rgb": [[0.0, 0.05], [1.0, 1.0]]}
    # from params, and the same name replaces
    api.post("/api/presets", json={"name": "Warm", "params": {"warmth": 0.5}})
    out = api.post("/api/presets", json={"name": "Warm", "params": {"warmth": 0.6}}).json()
    assert [x["name"] for x in out["presets"]] == ["Faded Ektachrome", "Warm"]
    assert out["presets"][1]["params"]["warmth"] == 0.6
    assert json.loads((store.library() / "presets.json").read_text())["presets"][1]["name"] == "Warm"
    assert api.get("/api/presets").json() == out
    assert api.post("/api/presets", json={"name": " ", "params": {}}).status_code == 400
    assert api.post("/api/presets", json={"name": "x"}).status_code == 400
    assert api.post("/api/presets", json={"name": "x", "session": sid, "group": "nope"}).status_code == 404
    assert [x["name"] for x in api.delete("/api/presets/Warm").json()["presets"]] == ["Faded Ektachrome"]
    assert api.delete("/api/presets/Warm").status_code == 404


def test_apply_preset_to_slide_and_rest_with_undo(api, tray, presets):
    sid, d = tray
    a, b, c, e = (g["id"] for g in d["groups"])
    api.post("/api/presets", json={"name": "Look", "params": LOOK})
    patch(api, sid, b, {"params": {"crop": [0.2, 0.2, 0.8, 0.8]}})
    patch(api, sid, c, {"reviewed": True})
    before = groups(api, sid)

    out = api.post(f"/api/sessions/{sid}/groups/{a}/look", json={"preset": "Look"}).json()
    assert out["applied"] == 1
    ga = out["groups"][0]
    assert ga["params"]["brightness"] == 0.3 and ga["params_source"] == "preset:Look" and ga["can_undo"]
    assert out["groups"][1]["params"] == before[1]["params"]  # only this slide

    out = api.post(f"/api/sessions/{sid}/groups/{b}/look", json={"preset": "Look", "scope": "rest"}).json()
    assert out["applied"] == 2  # b and e; c is developed already
    gb, gc, ge = out["groups"][1:]
    assert gb["params"]["saturation"] == 0.4 and gb["params"]["crop"] == [0.2, 0.2, 0.8, 0.8]  # keeps its framing
    assert gc["params"] == before[2]["params"] and ge["params"]["saturation"] == 0.4

    undone = api.post(f"/api/sessions/{sid}/groups/{b}/undo").json()
    assert undone["stepped"] == "preset"
    assert undone["groups"][1]["params"] == before[1]["params"]
    assert undone["groups"][1]["params_source"] == before[1]["params_source"]
    assert api.post(f"/api/sessions/{sid}/groups/{a}/look", json={"preset": "Nope"}).status_code == 404
    assert api.post(f"/api/sessions/{sid}/groups/{a}/look", json={}).status_code == 400


def test_develop_like_a_slide_in_another_tray(api, tray, tmp_path):
    sid, d = tray
    other, od = new_tray(api, tmp_path / "other", slides=3, name="Other tray")
    src = od["groups"][2]
    patch(api, other, src["id"], {"params": {**LOOK, "angle": -4}})
    target = d["groups"][3]
    out = api.post(f"/api/sessions/{sid}/groups/{target['id']}/look",
                   json={"like": {"session": other, "group": src["id"]}}).json()
    g = out["groups"][3]
    assert g["params"]["warmth"] == -0.25 and g["params"]["angle"] == 0
    assert g["params_source"] == "like:3:Other tray"
    assert api.post(f"/api/sessions/{sid}/groups/{target['id']}/undo").json()["stepped"] == "like"
    r = api.post(f"/api/sessions/{sid}/groups/{target['id']}/look", json={"like": {"session": other, "group": "x"}})
    assert r.status_code == 404


def test_look_refuses_locked_slide(api, tray, presets):
    sid, d = tray
    gid = d["groups"][1]["id"]
    api.post("/api/presets", json={"name": "Look", "params": LOOK})
    wf.update_session(sid, lambda s: s.group(gid).__setitem__("locked", "originals"))
    assert api.post(f"/api/sessions/{sid}/groups/{gid}/look", json={"preset": "Look"}).status_code == 409


def test_peek_does_not_switch_the_active_tray(api, tray, tmp_path):
    sid, _ = tray
    other, _ = new_tray(api, tmp_path / "other", slides=1)
    api.get(f"/api/sessions/{sid}")
    assert api.get(f"/api/sessions/{other}?peek=1").json()["summary"]["id"] == other
    assert wf.active_session == sid


# --------------------------------------------------------------------------- stats


def test_developed_at_recorded_and_cleared(api, tray):
    sid, d = tray
    gid = d["groups"][0]["id"]
    t0 = time.time()
    patch(api, sid, gid, {"reviewed": True})
    t = Session(sid).group(gid)["developed_at"]
    assert t0 <= t <= time.time()
    patch(api, sid, gid, {"reviewed": True})  # developing again keeps the first time
    assert Session(sid).group(gid)["developed_at"] == t
    patch(api, sid, gid, {"reviewed": False})
    assert "developed_at" not in Session(sid).group(gid)


def test_upload_records_time(api, tray, immich_db):
    sid, d = tray
    patch(api, sid, d["groups"][0]["id"], {"reviewed": True})
    api.post(f"/api/sessions/{sid}/finish", json={"only_ready": True})
    wait_job(api)
    g = Session(sid).group(d["groups"][0]["id"])
    assert time.time() - g["immich"]["at"] < 60
    assert stats.slide_times(Session(sid).data) == [g["developed_at"]]


def test_per_hour_counts_breaks_out():
    assert stats.per_hour([]) == (None, 0)
    # 31 slides a minute apart (30 min of work), then a 3 h break, then 11 more a minute apart
    ts = [i * 60 for i in range(31)] + [30 * 60 + 3 * 3600 + i * 60 for i in range(11)]
    rate, hours = stats.per_hour(ts)
    # 30 + 10 working minutes, plus the break counted as BREAK_S
    assert hours == pytest.approx((40 * 60 + stats.BREAK_S) / 3600)
    assert rate == pytest.approx(41 / hours)
    assert stats.per_hour([0, 60])[0] is None  # a minute says nothing yet


def test_library_stats_projection():
    now = 1_800_000_000.0
    summ = [
        {"slides": 50, "reviewed": 50, "uploaded": 48, "skipped": 2},
        {"slides": 40, "reviewed": 10, "uploaded": 0, "skipped": 0},
    ]
    times = [now - 86400 * 3 + i * 30 for i in range(56)] + [now - 86400 * 40]  # 56 recent, one old
    s = stats.library_stats(summ, times, target=1000, now=now)
    assert s["trays"] == {"total": 2, "finished": 1, "open": 1}
    assert s["slides"] == {"total": 90, "done": 60, "uploaded": 48, "skipped": 2, "to_develop": 30}
    assert s["remaining"] == 940
    assert s["per_day"] == 18.7  # 56 over the 3 days since the first of the last 14 days
    assert s["finish"] == time.strftime("%Y-%m-%d", time.localtime(now + 940 / (56 / 3) * 86400))
    # 55 half-minute steps plus the gap to the old one counted as a break
    assert s["per_hour"] == 89.6 and s["hours_left"] == 10.5
    assert s["last_7_days"] == 56 and s["trays_to_scan"] == 20  # (1000 - 90) / 45 per tray
    none = stats.library_stats([], [], now=now)
    assert none["per_hour"] is None and none["finish"] is None and none["trays_to_scan"] is None
    assert none["target"] == stats.DEFAULT_TARGET and none["remaining"] == stats.DEFAULT_TARGET


def test_stats_endpoint(api, tray):
    sid, d = tray
    for g in d["groups"][:3]:
        patch(api, sid, g["id"], {"reviewed": True})
    s = api.get("/api/stats").json()
    assert s["target"] == 10_000
    assert s["slides"]["done"] >= 3 and s["today"] >= 3
    assert s["trays"]["total"] == len(api.get("/api/state").json()["sessions"])
    assert api.get("/api/stats?target=50").json()["target"] == 50
    assert api.post("/api/config", json={"stats_target": 2500}).json() == {"ok": True}
    assert api.get("/api/stats").json()["target"] == 2500
    assert api.get("/api/state").json()["config"]["stats_target"] == 2500
    assert api.post("/api/config", json={"stats_target": "lots"}).status_code == 400


def test_old_sessions_without_times():
    """Trays written before developed_at existed: no times, nothing breaks."""
    d = {"groups": [{"reviewed": True, "immich": {"asset_id": "a", "key": "k"}}, {"reviewed": False, "immich": None}]}
    assert stats.slide_times(d) == []
