"""The round trip with Immich (ROADMAP §2): original scans stacked under the developed photo,
date / caption pushed without re-uploading and pulled back, exact duplicates not sent twice, and
photos pulled back in from Immich albums to develop again. Run with:
uv run --python 3.12 pytest tests -q

Immich is tests/fake_immich.py in-process (conftest's immich_db fixture).
"""
from __future__ import annotations

from datetime import datetime

import pytest

import fake_immich
from conftest import new_tray, wait_job
from slidestation.store import Session
from synthetic import save_scan, scene


def groups(api, sid) -> list[dict]:
    return api.get(f"/api/sessions/{sid}").json()["groups"]


def patch(api, sid, gid, body):
    r = api.patch(f"/api/sessions/{sid}/groups/{gid}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def upload(api, sid, **body) -> str:
    assert api.post(f"/api/sessions/{sid}/finish", json=body).json() == {"ok": True}
    return wait_job(api)["message"]


def live(db) -> dict:
    return {k: a for k, a in db["assets"].items() if not a.get("trashed")}


def stacked(api) -> None:
    api.post("/api/config", json={"upload_originals_stacked": True})


# --------------------------------------------------------------------------- stacks


def test_originals_stacked_under_developed(api, tray, immich_db):
    sid, d = tray
    stacked(api)
    assert "4 slides uploaded" in upload(api, sid)
    s = Session(sid)
    assert len(immich_db["assets"]) == 4 + 6  # developed + every scan, brackets included
    assert len(immich_db["stacks"]) == 4
    for g in s.data["groups"]:
        im = g["immich"]
        st = immich_db["stacks"][im["stack_id"]]
        assert st["primary"] == im["asset_id"]  # the developed photo is what the timeline shows
        assert sorted(st["assets"][1:]) == sorted(im["originals"].values())
        assert set(im["originals"]) == set(g["scans"]) and im["own_originals"]
        for scan, asset in im["originals"].items():
            assert immich_db["assets"][asset]["sha1"] == s.data["scans"][scan]["sha1"]  # untouched
    (album,) = immich_db["albums"].values()
    assert len(album["assets"]) == 4  # only the developed photos go into the album


def test_reupload_restacks_originals(api, tray, immich_db):
    sid, d = tray
    stacked(api)
    upload(api, sid)
    gid = d["groups"][0]["id"]
    old = Session(sid).group(gid)["immich"]
    patch(api, sid, gid, {"params": {"warmth": 0.3}})
    assert "1 slides uploaded" in upload(api, sid)
    new = Session(sid).group(gid)["immich"]
    assert new["asset_id"] != old["asset_id"] and immich_db["assets"][old["asset_id"]]["trashed"]
    assert new["originals"] == old["originals"]  # the scans weren't sent again
    assert len(immich_db["assets"]) == 11
    assert old["stack_id"] not in immich_db["stacks"]
    st = immich_db["stacks"][new["stack_id"]]
    assert st["primary"] == new["asset_id"] and sorted(st["assets"][1:]) == sorted(old["originals"].values())
    assert not any(immich_db["assets"][a]["trashed"] for a in old["originals"].values())

    # with the setting off, what Immich has stays stacked under the next upload too
    api.post("/api/config", json={"upload_originals_stacked": False})
    patch(api, sid, gid, {"params": {"warmth": 0.1}})
    upload(api, sid)
    again = Session(sid).group(gid)["immich"]
    assert immich_db["stacks"][again["stack_id"]]["primary"] == again["asset_id"]
    assert again["originals"] == old["originals"]


def test_split_after_stacking(api, tray, immich_db):
    """Splitting a stacked bracket: each half's upload stacks its own scans, none uploaded twice."""
    sid, d = tray
    stacked(api)
    upload(api, sid)
    g = d["groups"][0]
    api.post(f"/api/sessions/{sid}/groups/{g['id']}/split", json={"scan": g["scans"][1]})
    upload(api, sid)
    s = Session(sid)
    a, b = s.data["groups"][0]["immich"], s.data["groups"][1]["immich"]
    assert set(a["originals"]) == {g["scans"][0]} and set(b["originals"]) == {g["scans"][1]}
    assert len([x for x in immich_db["assets"].values() if not x["trashed"]]) == 5 + 6


def test_skip_after_stacking_trashes_its_scans(api, tray, immich_db):
    sid, d = tray
    stacked(api)
    upload(api, sid)
    im = Session(sid).group(d["groups"][1]["id"])["immich"]
    patch(api, sid, d["groups"][1]["id"], {"skip": True})
    upload(api, sid)
    assert immich_db["assets"][im["asset_id"]]["trashed"]
    assert all(immich_db["assets"][a]["trashed"] for a in im["own_originals"])
    assert im["stack_id"] not in immich_db["stacks"]


def test_no_stacks_on_older_servers(api, tray, immich_db, monkeypatch):
    monkeypatch.setattr(fake_immich, "STACKS", False)
    sid, d = tray
    stacked(api)
    msg = upload(api, sid)
    assert "4 slides uploaded" in msg and "original scans not stacked" in msg
    assert len(immich_db["assets"]) == 4  # no loose originals cluttering the timeline
    assert all("stack_id" not in g["immich"] for g in Session(sid).data["groups"])


# --------------------------------------------------------------------------- metadata sync


def test_caption_and_date_go_to_immich_without_reupload(api, tray, immich_db):
    sid, d = tray
    upload(api, sid)
    gs = d["groups"]
    for g in gs:
        patch(api, sid, g["id"], {"date": "1979-05-0" + str(g["index"] + 1)})
    upload(api, sid)
    before = dict(immich_db["assets"])
    patch(api, sid, gs[1]["id"], {"caption": "Picnic"})
    out = patch(api, sid, gs[2]["id"], {"date": "1978-08-14"})
    assert [g["status"] for g in out["groups"]] == ["uploaded", "changed", "changed", "uploaded"]
    msg = upload(api, sid)
    assert "0 slides uploaded" in msg and "2 updated in place" in msg
    assert immich_db["assets"].keys() == before.keys()  # nothing uploaded, nothing trashed
    s = Session(sid)
    a1 = immich_db["assets"][s.data["groups"][1]["immich"]["asset_id"]]
    a2 = immich_db["assets"][s.data["groups"][2]["immich"]["asset_id"]]
    assert a1["description"] == "Picnic"
    assert a2["local"].startswith("1978-08-14T12:02")  # noon + a minute per slide, like the EXIF
    assert [g["status"] for g in groups(api, sid)] == ["uploaded"] * 4


def test_key_without_round_trip_permissions(api, tray, immich_db, monkeypatch):
    """A key with only the upload permissions still works as before: a caption change goes up as a
    new copy, and nothing is carried over or stacked."""
    monkeypatch.setattr(fake_immich, "DENY", [("GET", r"/api/assets/[^/]+"), ("PUT", r"/api/assets/[^/]+"),
                                              ("GET", r"/api/stacks"), ("POST", r"/api/stacks")])
    sid, d = tray
    stacked(api)
    assert "original scans not stacked" in upload(api, sid)
    old = Session(sid).data["groups"][1]["immich"]["asset_id"]
    patch(api, sid, d["groups"][1]["id"], {"caption": "Picnic"})
    msg = upload(api, sid)
    assert "1 slides uploaded" in msg and "asset.update" in msg
    new = Session(sid).data["groups"][1]["immich"]["asset_id"]
    assert new != old and immich_db["assets"][old]["trashed"] and immich_db["assets"][new]["description"] == "Picnic"
    assert [g["status"] for g in groups(api, sid)] == ["uploaded"] * 4


def test_tray_date_updates_in_place(api, tray, immich_db):
    sid, d = tray
    upload(api, sid)
    api.patch(f"/api/sessions/{sid}", json={"date": "1985-07"})
    assert "4 updated in place" in upload(api, sid)
    assert len(immich_db["assets"]) == 4
    assert all(a["local"].startswith("1985-07-01") for a in immich_db["assets"].values())
    upload(api, sid)  # the tray's date is recorded as sent: nothing to do the next time
    assert sum(1 for x in immich_db["log"] if x[0] == "update") == 4


def test_pull_captions_and_dates_back(api, tray, immich_db):
    sid, d = tray
    gs = d["groups"]
    for g in gs:
        patch(api, sid, g["id"], {"date": "1980", "caption": "Old caption"})
    upload(api, sid)
    s = Session(sid)
    a0 = immich_db["assets"][s.group(gs[0]["id"])["immich"]["asset_id"]]
    a2 = immich_db["assets"][s.group(gs[2]["id"])["immich"]["asset_id"]]
    assert a0["description"] == "Old caption"  # Immich read it from the EXIF
    a0["description"] = "Grandma's garden"  # edited in Immich
    a2["local"] = "1981-03-02T09:00:00.000Z"
    r = api.post(f"/api/sessions/{sid}/pull").json()
    assert r["pulled"] == {"checked": 4, "captions": 1, "dates": 1, "gone": 0}
    out = r["groups"]
    assert out[0]["caption"] == "Grandma's garden" and out[1]["caption"] == "Old caption"
    assert out[2]["date"] == "1981-03-02" and out[3]["date"] == "1980"
    assert [g["status"] for g in out] == ["uploaded"] * 4  # Immich has these already
    # pulling again changes nothing; a local edit still goes up
    assert api.post(f"/api/sessions/{sid}/pull").json()["pulled"]["captions"] == 0
    patch(api, sid, gs[0]["id"], {"caption": "Garden, 1980"})
    upload(api, sid)
    assert a0["description"] == "Garden, 1980"


# --------------------------------------------------------------------------- duplicates


def test_exact_duplicates_not_uploaded_again(api, tray, immich_db):
    sid, d = tray
    api.post("/api/config", json={"keep_exports": True})
    upload(api, sid)
    ids = {g["id"]: g["immich"]["asset_id"] for g in Session(sid).data["groups"]}
    s = Session(sid)
    for g in s.data["groups"]:
        g["immich"] = None  # e.g. the record got lost: Immich still has the very same bytes
    s.save()
    immich_db["assets"][ids[d["groups"][0]["id"]]]["trashed"] = True  # one of them even in the trash
    msg = upload(api, sid)
    assert "4 were in Immich already" in msg
    assert len(immich_db["assets"]) == 4 and not any(a["trashed"] for a in immich_db["assets"].values())
    assert {g["id"]: g["immich"]["asset_id"] for g in Session(sid).data["groups"]} == ids
    assert ("restore", [ids[d["groups"][0]["id"]]]) in immich_db["log"]


def test_originals_already_in_immich_are_reused(api, tmp_path, immich_db):
    """Scans someone uploaded raw before aren't sent again; they get stacked."""
    sid, d = new_tray(api, tmp_path / "scans", slides=1)
    scan = d["groups"][0]["scans"][0]
    raw = fake_immich.add_asset(Session(sid).original_path(scan).read_bytes(), "IMG_raw.JPG")
    stacked(api)
    upload(api, sid)
    im = Session(sid).data["groups"][0]["immich"]
    assert im["originals"][scan] == raw and raw not in im["own_originals"]
    assert len(im["own_originals"]) == 1  # the bracket's other scan was new to Immich
    st = immich_db["stacks"][im["stack_id"]]["assets"]
    assert st[0] == im["asset_id"] and sorted(st[1:]) == sorted([raw] + im["own_originals"])


# --------------------------------------------------------------------------- pull back in


def photo(tmp_path, seed: int, name: str = "old.jpg") -> bytes:
    p = tmp_path / f"{seed}-{name}"
    save_scan(scene(seed), p, datetime(2021, 5, 1, 10, 0))
    return p.read_bytes()


@pytest.fixture
def immich_album(tmp_path, immich_db):
    """An Immich album of 3 photos scanned years ago with another tool, plus a video."""
    ids = [fake_immich.add_asset(photo(tmp_path, 11 + i), f"slide{i}.jpg", local=f"1976-0{i + 1}-15T10:00:00.000Z",
                                 description=["Lake", "", "Wedding"][i], favorite=i == 2) for i in range(3)]
    video = fake_immich.add_asset(b"not a photo", "clip.mp4", type="VIDEO")
    immich_db["albums"]["alb-1"] = {"name": "Slides 1976", "assets": ids + [video]}
    immich_db["albums"]["alb-2"] = {"name": "Family", "assets": ids[:1]}
    return ids


@pytest.mark.parametrize("major", [2, 3])
def test_browse_albums(api, immich_album, monkeypatch, major):
    monkeypatch.setattr(fake_immich, "MAJOR", major)
    monkeypatch.setattr(fake_immich, "PAGE", 2)  # v3 has no asset list in the album: search pages
    albums = api.get("/api/immich/albums").json()
    assert [a["name"] for a in albums] == ["Family", "Slides 1976"]
    assert albums[1]["count"] == 4 and albums[1]["thumb"] == immich_album[0]
    assets = api.get("/api/immich/albums/alb-1/assets").json()
    assert [a["id"] for a in assets] == immich_album  # the video left out, date order
    assert assets[0] == {"id": immich_album[0], "name": "slide0.jpg", "date": "1976-01-15", "favorite": False,
                         "tray": ""}
    r = api.get(f"/api/immich/assets/{immich_album[0]}/thumb.jpg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"


def pull_in(api, ids, **body) -> tuple[str, dict]:
    r = api.post("/api/immich/import", json={"assets": ids, **body})
    assert r.status_code == 200, r.text
    msg = wait_job(api)["message"]
    return r.json()["id"], {"message": msg, **api.get(f"/api/sessions/{r.json()['id']}").json()}


def test_pull_in_makes_a_tray(api, immich_album, immich_db):
    sid, d = pull_in(api, immich_album + ["no-such-asset"], name="Slides 1976", album="Slides 1976")
    assert "Pulled in 3 photos" in d["message"] and "left out 1" in d["message"]
    assert [g["date"] for g in d["groups"]] == ["1976-01-15", "1976-02-15", "1976-03-15"]
    assert [g["caption"] for g in d["groups"]] == ["Lake", "", "Wedding"]
    assert all(g["from_immich"] and g["status"] == "new" and len(g["scans"]) == 1 for g in d["groups"])
    s = Session(sid)
    for g, aid in zip(s.data["groups"], immich_album):
        sc = s.data["scans"][g["scans"][0]]
        assert s.original_path(g["scans"][0]).read_bytes() == immich_db["data"][aid]  # byte for byte
        assert sc["removable"] is False and sc["immich_asset"] == aid
    # never removable from a "card"; pulling the same photos again adds nothing
    assert "these scans were imported from a folder, not from a card" in d["cleanup_blockers"]
    listed = api.get("/api/immich/albums/alb-1/assets").json()
    assert all(a["tray"] == "Slides 1976" for a in listed)


def test_upload_replaces_the_pulled_photo(api, immich_album, immich_db):
    sid, d = pull_in(api, immich_album, name="Slides 1976", album="Slides 1976")
    patch(api, sid, d["groups"][0]["id"], {"params": {"warmth": 0.2}})
    assert "3 slides uploaded" in upload(api, sid)
    s = Session(sid)
    new = [g["immich"]["asset_id"] for g in s.data["groups"]]
    assert all(immich_db["assets"][a]["trashed"] for a in immich_album)  # the old ones in the trash
    albums = immich_db["albums"]
    assert [x for x in albums["alb-1"]["assets"] if x in new] == new  # same album, not a new one
    assert len(albums) == 2 and new[0] in albums["alb-2"]["assets"]  # other albums kept too
    assert immich_db["assets"][new[2]]["favorite"] and not immich_db["assets"][new[1]]["favorite"]
    assert immich_db["assets"][new[0]]["description"] == "Lake"
    assert immich_db["assets"][new[0]]["local"].startswith("1976-01-15")
    # a later re-upload replaces the new one, keeping what was carried over
    patch(api, sid, d["groups"][2]["id"], {"params": {"warmth": -0.2}})
    upload(api, sid)
    newer = Session(sid).data["groups"][2]["immich"]["asset_id"]
    assert immich_db["assets"][new[2]]["trashed"] and immich_db["assets"][newer]["favorite"]


def test_pulled_photo_becomes_the_stacked_original(api, immich_album, immich_db):
    """With stacking on, the pulled-in photo *is* the untouched scan: it stays, under the new one."""
    stacked(api)
    sid, d = pull_in(api, immich_album[:1], name="Slides 1976", album="Slides 1976")
    msg = upload(api, sid)
    assert "1 slides uploaded" in msg
    im = Session(sid).data["groups"][0]["immich"]
    src = immich_album[0]
    assert not immich_db["assets"][src]["trashed"] and im["own_originals"] == []
    assert immich_db["stacks"][im["stack_id"]]["assets"] == [im["asset_id"], src]
    for a in ("alb-1", "alb-2"):  # it hands its place in the albums to the new photo
        assert im["asset_id"] in immich_db["albums"][a]["assets"] and src not in immich_db["albums"][a]["assets"]
    assert len(live(immich_db)) == 3 + 1 + 1  # the album's 3 photos and video, one new photo


def test_pull_in_is_refused_while_busy(api, immich_album, monkeypatch):
    from slidestation import workflow as wf

    monkeypatch.setattr(wf, "current_job", wf.Job("upload", None))
    before = len(api.get("/api/state").json()["sessions"])
    r = api.post("/api/immich/import", json={"assets": immich_album})
    assert r.status_code == 409 and len(api.get("/api/state").json()["sessions"]) == before
