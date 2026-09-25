"""The JSON API against a scratch library: curves, crop & straighten, undo, dates, locked slides,
upload. Run with:  uv run --python 3.12 pytest tests -q

Scans are tiny synthetic JPEGs (tests/synthetic.py), Immich is tests/fake_immich.py in-process.
"""
from __future__ import annotations

import io
from types import SimpleNamespace

import pytest
from PIL import Image

from conftest import new_tray, wait_job
from slidestation import imaging as im
from slidestation import server
from slidestation.store import NEUTRAL_EXTRAS, Session, render_key, slide_dates


def patch(api, sid, gid, body, code=200):
    r = api.patch(f"/api/sessions/{sid}/groups/{gid}", json=body)
    assert r.status_code == code, r.text
    return r.json()


def groups(api, sid) -> list[dict]:
    return api.get(f"/api/sessions/{sid}").json()["groups"]


def image_size(api, url) -> tuple[int, int]:
    r = api.get(url)
    assert r.status_code == 200, r.text
    return Image.open(io.BytesIO(r.content)).size


# --------------------------------------------------------------------------- import


def test_import_groups_brackets(tray):
    sid, d = tray
    assert [len(g["scans"]) for g in d["groups"]] == [2, 1, 2, 1]
    assert d["summary"]["slides"] == 4 and d["summary"]["scans"] == 6
    assert all(g["status"] == "new" and not g["locked"] for g in d["groups"])


def test_reimport_skips_known_scans(api, tray, tmp_path):
    sid, _ = tray
    assert api.post(f"/api/sessions/{sid}/import", json={"source": str(tmp_path / "scans")}).json() == {"ok": True}
    assert "6 were already imported" in wait_job(api)["message"]
    assert len(groups(api, sid)) == 4


# --------------------------------------------------------------------------- tone curves


def test_clean_curves():
    assert im.clean_curves({"rgb": [[1, 1], [0, 0]], "r": [[0, 0], [1, 1]]}) == {}  # straight: dropped
    assert im.clean_curves({"g": [[0.5, 0.7], [-1, 0.1], [2, 3], [0.501, 0.2]]}) == {
        "g": [[0.0, 0.1], [0.5, 0.7], [1.0, 1.0]]}  # sorted, clamped, near-duplicate x dropped
    assert im.clean_curves({"x": [[0, 0.2], [1, 1]], "b": "junk", "r": [[0, 0.1]]}) == {}
    assert im.clean_curves("junk") == {}
    assert len(im.clean_curves({"rgb": [[i / 40, i / 40 + 0.01] for i in range(40)]})["rgb"]) == 16


def test_patch_curves(api, tray):
    sid, d = tray
    g = d["groups"][0]
    out = patch(api, sid, g["id"], {"params": {"curves": {"rgb": [[0, 0.1], [0.5, 0.6], [1, 1]], "r": [[0, 0], [1, 1]]}}})
    g2 = out["groups"][0]
    assert g2["params"]["curves"] == {"rgb": [[0.0, 0.1], [0.5, 0.6], [1.0, 1.0]]}
    assert g2["params_source"] == "manual" and g2["key"] != g["key"]
    assert g2["tone_key"] == g["tone_key"]  # the curve's input didn't change
    other = [x for x in out["groups"][1:]]
    assert all(x["params"]["curves"] == {} for x in other)


def test_render_key_ignores_neutral_extras():
    g = {"scans": ["a", "b"], "excluded": [], "rotation": 0, "params": {"strength": 0.6, "warmth": 0.1}}
    old = render_key(g)  # a slide uploaded before curves / straighten / crop existed
    assert render_key({**g, "params": {**g["params"], **NEUTRAL_EXTRAS}}) == old
    assert render_key({**g, "params": {**g["params"], "curves": {"rgb": [[0, 0.1], [1, 1]]}}}) != old
    assert render_key({**g, "params": {**g["params"], "angle": 1.0}}) != old
    assert render_key({**g, "params": {**g["params"], "crop": [0.1, 0.1, 0.9, 0.9]}}) != old


def test_histogram(api, tray):
    sid, d = tray
    g = d["groups"][1]
    url = f"/api/sessions/{sid}/groups/{g['id']}/histogram"
    r = api.get(url, params={"v": g["tone_key"]})
    h = r.json()
    assert set(h) == {"r", "g", "b", "lum"} and all(len(v) == im.HIST_BINS for v in h.values())
    assert sum(h["lum"]) > 0
    assert "max-age" in r.headers["cache-control"]
    assert api.get(url, params={"v": "stale"}).headers["cache-control"] == "no-store"
    assert api.get(f"/api/sessions/{sid}/groups/nope/histogram").status_code == 404


def test_fit_curves_single(api, tray):
    sid, d = tray
    g = d["groups"][0]
    r = api.post(f"/api/sessions/{sid}/groups/{g['id']}/fit_curves", json={})
    assert r.status_code == 200 and r.json()["fitted"] == 1
    out = r.json()["groups"]
    p = out[0]["params"]
    assert p["strength"] == 0 and set(p["curves"]) == {"r", "g", "b"}
    for ch in "rgb":  # the faded scan sits inside 0..1: the end points move in, output levels stay
        (x0, y0), (x1, y1) = p["curves"][ch][0], p["curves"][ch][-1]
        assert 0 < x0 < x1 < 1 and (y0, y1) == (0.0, 1.0)
    assert out[0]["can_undo"] and out[0]["params_source"] == "manual"
    assert all(x["params"]["curves"] == {} for x in out[1:])


def test_fit_curves_all_skips_developed(api, tray):
    sid, d = tray
    patch(api, sid, d["groups"][2]["id"], {"reviewed": True})
    patch(api, sid, d["groups"][3]["id"], {"skip": True})
    r = api.post(f"/api/sessions/{sid}/groups/{d['groups'][0]['id']}/fit_curves", json={"all": True})
    assert r.json()["fitted"] == 2
    fitted = [bool(g["params"]["curves"]) for g in r.json()["groups"]]
    assert fitted == [True, True, False, False]


# --------------------------------------------------------------------------- crop & straighten


def test_clean_crop():
    assert im.clean_crop([0.1, 0.2, 0.9, 0.8]) == [0.1, 0.2, 0.9, 0.8]
    assert im.clean_crop([-1, 0.2, 2, 0.8]) == [0.0, 0.2, 1.0, 0.8]
    for junk in ("junk", None, [0.1, 0.2], [0, 0, 1, 1], [0.1, 0.1, 0.12, 0.9], [0.5, 0.5, 0.2, 0.9], ["a", 0, 1, 1]):
        assert im.clean_crop(junk) is None, junk


def test_patch_crop_and_angle(api, tray):
    sid, d = tray
    g = d["groups"][1]
    out = patch(api, sid, g["id"], {"params": {"angle": 3.5, "crop": [0.1, 0.1, 0.6, 0.9]}})["groups"][1]
    assert out["params"]["angle"] == 3.5 and out["params"]["crop"] == [0.1, 0.1, 0.6, 0.9]
    assert out["tone_key"] != g["tone_key"]  # the histogram sees the cropped picture
    base = f"/api/sessions/{sid}/groups/{g['id']}/preview.jpg"
    cw, ch = image_size(api, base)
    uw, uh = image_size(api, base + "?uncropped=1")
    assert (cw, ch) != (uw, uh) and cw < uw  # half the width is gone
    assert abs(cw / uw - 0.5) < 0.05
    bw, bh = image_size(api, base + "?before=1")  # the before view is framed like the developed one
    assert (bw, bh) == (cw, ch)
    # junk or too small a crop means no crop
    assert patch(api, sid, g["id"], {"params": {"crop": "junk"}})["groups"][1]["params"]["crop"] is None
    assert patch(api, sid, g["id"], {"params": {"crop": [0.1, 0.1, 0.11, 0.9]}})["groups"][1]["params"]["crop"] is None
    assert image_size(api, base) == image_size(api, base + "?uncropped=1")


def test_apply_to_rest_keeps_framing(api, tray):
    sid, d = tray
    gs = d["groups"]
    patch(api, sid, gs[2]["id"], {"params": {"angle": -2.0, "crop": [0.2, 0.2, 0.8, 0.8]}})
    src = {**gs[0]["params"], "warmth": 0.3, "angle": 5.0, "crop": [0.1, 0.1, 0.5, 0.5]}
    r = api.post(f"/api/sessions/{sid}/apply", json={"params": src, "from": gs[0]["id"], "scope": "rest",
                                                      "as_default": True})
    out = r.json()
    assert out["groups"][0]["params"]["warmth"] == 0  # "rest" = the slides after it
    for i, (angle, crop) in ((1, (0.0, None)), (2, (-2.0, [0.2, 0.2, 0.8, 0.8])), (3, (0.0, None))):
        p = out["groups"][i]["params"]
        assert p["warmth"] == 0.3 and (p["angle"], p["crop"]) == (angle, crop), p
    assert out["defaults"]["warmth"] == 0.3 and out["defaults"]["angle"] == 0 and out["defaults"]["crop"] is None


# --------------------------------------------------------------------------- undo / redo


@pytest.fixture
def clock(monkeypatch):
    """Server time under the test's control, for the 1.5 s undo coalescing."""
    c = SimpleNamespace(now=1_000_000.0)
    monkeypatch.setattr(server, "time", SimpleNamespace(time=lambda: c.now))
    return c


def history(sid, gid) -> dict:
    return Session(sid).group(gid)["history"]


def test_undo_redo(api, tray, clock):
    sid, d = tray
    gid = d["groups"][0]["id"]
    assert not d["groups"][0]["can_undo"]
    patch(api, sid, gid, {"params": {"warmth": 0.4}})
    clock.now += 10
    g = patch(api, sid, gid, {"rotation": 90})["groups"][0]
    assert g["can_undo"] and not g["can_redo"]

    r = api.post(f"/api/sessions/{sid}/groups/{gid}/undo").json()
    assert r["stepped"] == "rotation"
    g = r["groups"][0]
    assert g["rotation"] == 0 and g["params"]["warmth"] == 0.4 and g["can_redo"]
    r = api.post(f"/api/sessions/{sid}/groups/{gid}/undo").json()
    assert r["stepped"] == "params:warmth" and r["groups"][0]["params"]["warmth"] == 0
    assert not r["groups"][0]["can_undo"]
    assert api.post(f"/api/sessions/{sid}/groups/{gid}/undo").json()["stepped"] is None  # nothing left

    r = api.post(f"/api/sessions/{sid}/groups/{gid}/redo").json()
    assert r["stepped"] == "params:warmth" and r["groups"][0]["params"]["warmth"] == 0.4
    # a new edit clears what could be redone
    clock.now += 10
    g = patch(api, sid, gid, {"params": {"saturation": -0.2}})["groups"][0]
    assert not g["can_redo"] and g["rotation"] == 0
    assert api.post(f"/api/sessions/{sid}/groups/{gid}/redo").json()["stepped"] is None


def test_undo_coalesces_a_drag(api, tray, clock):
    sid, d = tray
    gid = d["groups"][1]["id"]
    for v in (0.1, 0.2, 0.3, 0.4):  # one slider drag, 1 s apart: the window slides along
        patch(api, sid, gid, {"params": {"warmth": v}})
        clock.now += 1.0
    assert len(history(sid, gid)["undo"]) == 1
    patch(api, sid, gid, {"params": {"tint": 0.2}})  # another setting: its own step
    clock.now += 2.0
    patch(api, sid, gid, {"params": {"tint": 0.3}})  # same setting, but after a pause
    assert [h["what"] for h in history(sid, gid)["undo"]] == ["params:warmth", "params:tint", "params:tint"]
    api.post(f"/api/sessions/{sid}/groups/{gid}/undo")
    api.post(f"/api/sessions/{sid}/groups/{gid}/undo")
    g = api.post(f"/api/sessions/{sid}/groups/{gid}/undo").json()["groups"][1]
    assert g["params"]["warmth"] == 0 and g["params"]["tint"] == 0  # the whole drag in one step


def test_undo_steps_of_local_adjustments(api, tray, clock):
    """All local adjustments are one setting ("local"), but adding one, and editing a different
    adjustment or slider, are each their own step, however quickly they follow each other."""
    sid, d = tray
    gid = d["groups"][2]["id"]
    radial = {"kind": "radial", "exposure": 0.0, "center": [0.5, 0.5], "rx": 0.2, "ry": 0.2}
    grad = {"kind": "graduated", "exposure": 0.0, "start": [0.5, 0.0], "end": [0.5, 0.4]}
    local = lambda *a: patch(api, sid, gid, {"params": {"local": list(a)}})["groups"][2]["params"]["local"]  # noqa: E731
    [r] = local(radial)  # added
    clock.now += 0.5
    [r] = local({**r, "exposure": 0.8})
    clock.now += 0.5
    [r] = local({**r, "exposure": 0.9})  # the same slider: one step with the above
    clock.now += 0.5
    [r] = local({**r, "center": [0.5, 0.3]})  # the handle
    clock.now += 0.5
    r, g = local(r, grad)  # added
    clock.now += 0.5
    local(r, {**g, "exposure": -0.9})
    assert len(history(sid, gid)["undo"]) == 5
    undo = lambda: api.post(f"/api/sessions/{sid}/groups/{gid}/undo").json()["groups"][2]["params"]["local"]  # noqa: E731
    assert undo()[1]["exposure"] == 0  # the graduated filter's exposure
    assert len(undo()) == 1  # adding it
    assert undo()[0]["center"] == [0.5, 0.5]  # the drag
    assert undo()[0]["exposure"] == 0  # the exposure slider
    assert undo() == []  # adding the radial


def test_undo_history_is_capped(api, tray, clock):
    sid, d = tray
    gid = d["groups"][3]["id"]
    for i in range(server.HISTORY_MAX + 10):
        patch(api, sid, gid, {"params": {"brightness": round((i + 1) / 100, 2)}})
        clock.now += 2
    h = history(sid, gid)["undo"]
    assert len(h) == server.HISTORY_MAX
    assert h[0]["params"]["brightness"] == 0.1  # the oldest steps fell off
    assert h[-1]["params"]["brightness"] == 0.69


def test_undo_covers_fit_and_apply(api, tray, clock):
    sid, d = tray
    g0, g1 = d["groups"][0], d["groups"][1]
    api.post(f"/api/sessions/{sid}/groups/{g0['id']}/fit_curves", json={})
    g = api.post(f"/api/sessions/{sid}/groups/{g0['id']}/undo").json()["groups"][0]
    assert g["params"] == g0["params"]
    api.post(f"/api/sessions/{sid}/apply", json={"params": {**g0["params"], "contrast": 0.5}, "scope": "unreviewed"})
    r = api.post(f"/api/sessions/{sid}/groups/{g1['id']}/undo").json()
    assert r["stepped"] == "apply" and r["groups"][1]["params"]["contrast"] == 0


# --------------------------------------------------------------------------- dates and captions


def test_date_validation(api, tray):
    sid, d = tray
    gid = d["groups"][0]["id"]
    for junk in ("junk", "78", "1978-6-x", "June 1978"):
        r = api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"date": junk})
        assert r.status_code == 400, junk
    assert patch(api, sid, gid, {"date": "1978/06"})["groups"][0]["date"] == "1978-06"
    assert patch(api, sid, gid, {"date": " 1978-06-14 "})["groups"][0]["date"] == "1978-06-14"
    assert patch(api, sid, gid, {"date": ""})["groups"][0]["date"] == ""
    assert patch(api, sid, gid, {"caption": "  Lake, summer  "})["groups"][0]["caption"] == "Lake, summer"


def test_slide_dates():
    def tray(dates, tray_date=""):
        return {"date": tray_date, "groups": [{"date": x} for x in dates]}

    out = slide_dates(tray(["1978-01-01", "", "", "", "1978-01-09"]))
    assert [x["source"] for x in out] == ["own", "between", "between", "between", "own"]
    assert [x["value"] for x in out[1:4]] == ["1978-01-03", "1978-01-05", "1978-01-07"]
    assert out[2]["from"] == [0, 4]
    # interpolated at the coarser precision of the two ends
    assert slide_dates(tray(["1978", "", "1980-06-01"]))[1] == {"value": "1979", "source": "between", "from": [0, 2]}
    out = slide_dates(tray(["", "1978-08", "", ""], "1990"))
    assert [(x["value"], x["source"]) for x in out] == [("1978-08", "near"), ("1978-08", "own"),
                                                        ("1978-08", "near"), ("1978-08", "near")]
    assert [x["source"] for x in slide_dates(tray(["", ""], "1990-05"))] == ["tray", "tray"]
    assert slide_dates(tray([""]))[0] == {"value": "", "source": "scan"}


def test_date_estimates_in_payload(api, tray):
    sid, d = tray
    gs = d["groups"]
    patch(api, sid, gs[0]["id"], {"date": "1978-01-01"})
    out = patch(api, sid, gs[3]["id"], {"date": "1978-01-31"})["groups"]
    assert [g["date_est"]["source"] for g in out] == ["own", "between", "between", "own"]
    assert out[1]["date_est"]["value"] == "1978-01-11"


# --------------------------------------------------------------------------- upload


def assets_in(db) -> list[dict]:
    return list(db["assets"].values())


@pytest.mark.parametrize("major", [2, 3])
def test_upload_field_rules(api, tray, immich_db, monkeypatch, major):
    import fake_immich

    monkeypatch.setattr(fake_immich, "MAJOR", major)
    sid, d = tray
    assert api.post(f"/api/sessions/{sid}/finish", json={}).json() == {"ok": True}
    assert "4 slides uploaded" in wait_job(api)["message"]
    assets = assets_in(immich_db)
    assert len(assets) == 4
    for a in assets:
        if major < 3:  # v1/v2 require the device fields, v3 rejects them
            assert a["fields"]["deviceId"] == "slide-station" and "deviceAssetId" in a["fields"]
        else:
            assert "deviceAssetId" not in a["fields"] and "deviceId" not in a["fields"]
            assert a["fields"]["filename"].endswith(".jpg")
    (album,) = immich_db["albums"].values()
    assert album["name"] == "Test tray" and len(album["assets"]) == 4
    out = api.get(f"/api/sessions/{sid}").json()
    assert [g["status"] for g in out["groups"]] == ["uploaded"] * 4
    assert out["summary"]["uploaded"] == 4 and out["summary"]["pending_upload"] == 0
    # the tray's folder import can't be cleaned from a card
    assert out["cleanup_blockers"] == ["these scans were imported from a folder, not from a card"]


def test_upload_only_developed(api, tray, immich_db):
    sid, d = tray
    patch(api, sid, d["groups"][1]["id"], {"reviewed": True})
    assert api.get(f"/api/sessions/{sid}").json()["summary"]["ready_upload"] == 1
    api.post(f"/api/sessions/{sid}/finish", json={"only_ready": True})
    wait_job(api)
    assert len(immich_db["assets"]) == 1
    assert [g["status"] for g in groups(api, sid)] == ["new", "uploaded", "new", "new"]


def test_reupload_after_edit_trashes_old(api, tray, immich_db):
    sid, d = tray
    api.post(f"/api/sessions/{sid}/finish", json={})
    wait_job(api)
    before = {g["id"]: Session(sid).group(g["id"])["immich"]["asset_id"] for g in d["groups"]}
    gid = d["groups"][2]["id"]
    assert patch(api, sid, gid, {"params": {"warmth": 0.25}})["groups"][2]["status"] == "changed"
    api.post(f"/api/sessions/{sid}/finish", json={})
    assert "1 slides uploaded" in wait_job(api)["message"]
    new = Session(sid).group(gid)["immich"]["asset_id"]
    assert new != before[gid] and len(immich_db["assets"]) == 5
    assert ("trash", {"ids": [before[gid]], "force": False}) in immich_db["log"]
    assert [g["status"] for g in groups(api, sid)] == ["uploaded"] * 4


def test_meta_change_marks_uploaded_changed(api, tray, immich_db):
    sid, d = tray
    api.post(f"/api/sessions/{sid}/finish", json={})
    wait_job(api)
    gs = d["groups"]
    st = [g["status"] for g in patch(api, sid, gs[1]["id"], {"caption": "Picnic"})["groups"]]
    assert st == ["uploaded", "changed", "uploaded", "uploaded"]
    # dating one slide re-dates its undated neighbours too (they are estimated from it)
    st = [g["status"] for g in patch(api, sid, gs[3]["id"], {"date": "1979"})["groups"]]
    assert st == ["changed"] * 4
    api.post(f"/api/sessions/{sid}/finish", json={})
    wait_job(api)
    assert [g["status"] for g in groups(api, sid)] == ["uploaded"] * 4


# --------------------------------------------------------------------------- locked slides


def test_locked_slides(api, tmp_path, immich_db):
    api.post("/api/config", json={"keep_originals": False})
    sid, d = new_tray(api, tmp_path / "scans")
    gs = d["groups"]
    api.post(f"/api/sessions/{sid}/finish", json={})
    wait_job(api)
    s = Session(sid)
    assert not any(s.original_path(x).exists() for x in s.data["scans"])  # dropped after upload
    out = api.get(f"/api/sessions/{sid}").json()
    assert all(g["locked"] for g in out["groups"])
    assert [g["status"] for g in out["groups"]] == ["uploaded"] * 4

    gid = gs[0]["id"]
    base = f"/api/sessions/{sid}/groups/{gid}"
    for body in ({"params": {"warmth": 0.3}}, {"rotation": 90}, {"params": {"crop": [0.1, 0.1, 0.9, 0.9]}},
                 {"reviewed": True, "params": {"warmth": 0.1}}, {"excluded": [gs[0]["scans"][0]]}):
        assert api.patch(base, json=body).status_code == 409, body
    for path, body in (("/undo", None), ("/redo", None), ("/fit_curves", {}), ("/neutral", {"x": 0.5, "y": 0.5}),
                       ("/split", {"scan": gs[0]["scans"][1]}), ("/merge_next", None)):
        assert api.post(base + path, json=body).status_code == 409, path
    # batch operations leave locked slides alone
    r = api.post(f"/api/sessions/{sid}/apply", json={"params": {**gs[0]["params"], "warmth": 0.5}, "scope": "all"})
    assert all(g["params"]["warmth"] == 0 for g in r.json()["groups"])
    assert api.post(f"{base}/fit_curves", json={"all": True}).json()["fitted"] == 0
    # developing and leaving out are still allowed
    assert patch(api, sid, gid, {"reviewed": True})["groups"][0]["reviewed"]
    assert patch(api, sid, gs[1]["id"], {"skip": True})["groups"][1]["status"] == "skipped"
    patch(api, sid, gs[1]["id"], {"skip": False})
    # the preview still renders from the cached proxies
    assert image_size(api, f"{base}/preview.jpg?size=320")[0] > 0
    # a finish renders nothing (no originals) and keeps what Immich has
    api.post(f"/api/sessions/{sid}/finish", json={})
    wait_job(api)
    assert len(immich_db["assets"]) == 4

    # re-importing the same scans restores the originals and unlocks the slides
    api.post(f"/api/sessions/{sid}/import", json={"source": str(tmp_path / "scans")})
    assert "restored 6 deleted originals" in wait_job(api)["message"]
    out = api.get(f"/api/sessions/{sid}").json()
    assert not any(g["locked"] for g in out["groups"]) and len(out["groups"]) == 4
    assert patch(api, sid, gid, {"params": {"warmth": 0.3}})["groups"][0]["status"] == "changed"


def test_locked_preview_falls_back_to_local(api, tmp_path, immich_db):
    """A locked slide whose settings don't reproduce the upload asks Immich for its preview; the
    mock has no thumbnails, so the local render stands in."""
    api.post("/api/config", json={"keep_originals": False})
    sid, d = new_tray(api, tmp_path / "scans", slides=1)
    api.post(f"/api/sessions/{sid}/finish", json={})
    wait_job(api)
    s = Session(sid)
    g = s.data["groups"][0]
    g["params"]["warmth"] = 0.5  # e.g. an edit that was saved after the last upload
    s.save()
    assert api.get(f"/api/sessions/{sid}").json()["groups"][0]["status"] == "uploaded"
    assert image_size(api, f"/api/sessions/{sid}/groups/{g['id']}/preview.jpg?size=320")[0] > 0
