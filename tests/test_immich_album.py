"""One Immich album for every tray (Settings), each photo tagged Trays/<tray name>, and the
untouched scans kept out of that album. Immich is tests/fake_immich.py in-process.
Run with: uv run --python 3.12 pytest tests -q
"""
from __future__ import annotations

import time
import uuid

import fake_immich
from conftest import wait_job
from slidestation.store import Session


def upload(api, sid) -> str:
    assert api.post(f"/api/sessions/{sid}/finish", json={}).json() == {"ok": True}
    return wait_job(api)["message"]


def shared_album(db, name="Apostel digitalisatie") -> str:
    """An album someone else owns and shared with this user: only `GET /albums?shared=true` has it."""
    aid = str(uuid.uuid4())
    db["albums"][aid] = {"name": name, "assets": [], "shared": True}
    return aid


def tagged(db, value) -> set[str]:
    return set((db.get("tags", {}).get(value) or {}).get("assets", []))


def test_every_tray_goes_into_the_album_from_settings(api, tray, immich_db):
    sid, _ = tray
    aid = shared_album(immich_db)
    names = {a["id"]: a["name"] for a in api.get("/api/immich/albums").json()}
    assert names[aid] == "Apostel digitalisatie"  # shared albums are offered too
    api.post("/api/config", json={"immich_album": aid, "immich_album_name": "Apostel digitalisatie"})
    msg = upload(api, sid)
    assert "uploaded to 'Apostel digitalisatie'" in msg, msg
    assert list(immich_db["albums"]) == [aid]  # no album of its own for the tray
    assets = [g["immich"]["asset_id"] for g in Session(sid).data["groups"]]
    assert sorted(immich_db["albums"][aid]["assets"]) == sorted(assets)
    name = Session(sid).data["name"]
    assert tagged(immich_db, f"Trays/{name}") == set(assets)  # traced back to its tray
    assert api.get(f"/api/sessions/{sid}").json()["placement_stale"] is False


def test_renaming_the_tray_moves_the_tag(api, tray, immich_db):
    sid, _ = tray
    upload(api, sid)
    old = Session(sid).data["name"]
    assets = {g["immich"]["asset_id"] for g in Session(sid).data["groups"]}
    assert tagged(immich_db, f"Trays/{old}") == assets
    api.patch(f"/api/sessions/{sid}", json={"name": "Box 12 / 1978"})
    view = api.get(f"/api/sessions/{sid}").json()
    assert view["placement_stale"] is True and view["summary"]["pending_upload"] == 0
    upload(api, sid)  # nothing to send: only the album and tag are put right
    assert tagged(immich_db, f"Trays/{old}") == set()
    assert tagged(immich_db, "Trays/Box 12 - 1978") == assets  # a "/" would nest it under "Box 12"
    assert api.get(f"/api/sessions/{sid}").json()["placement_stale"] is False


def test_an_uploaded_tray_moves_into_the_album_chosen_later(api, tray, immich_db):
    sid, _ = tray
    api.post("/api/config", json={"upload_originals_stacked": True})
    upload(api, sid)
    recs = [g["immich"] for g in Session(sid).data["groups"]]
    scans = {a for r in recs for a in r["originals"].values()}
    aid = shared_album(immich_db)
    # what Immich does when a stack is added to an album by hand: the scans come along
    immich_db["albums"][aid]["assets"] = [r["asset_id"] for r in recs] + sorted(scans)
    api.post("/api/config", json={"immich_album": aid, "immich_album_name": "Apostel digitalisatie"})
    assert api.get(f"/api/sessions/{sid}").json()["placement_stale"] is True
    upload(api, sid)
    assert sorted(immich_db["albums"][aid]["assets"]) == sorted(r["asset_id"] for r in recs)
    assert all(immich_db["assets"][a].get("stack") for a in scans)  # still stacked, just not in the album


def test_a_missing_album_says_so(api, tray, immich_db):
    sid, _ = tray
    api.post("/api/config", json={"immich_album": str(uuid.uuid4()), "immich_album_name": "Gone"})
    assert api.post(f"/api/sessions/{sid}/finish", json={}).json() == {"ok": True}
    for _ in range(500):
        job = api.get("/api/state").json()["job"]
        if job and job["finished"]:
            break
        time.sleep(0.02)
    assert "('Gone') is gone from Immich" in job["error"], job
    assert not immich_db["assets"]


def test_no_tray_tag_when_turned_off(api, tray, immich_db):
    sid, _ = tray
    api.post("/api/config", json={"tag_trays": False})
    upload(api, sid)
    assert not any(v.startswith("Trays") for v in immich_db.get("tags", {}))


def test_no_tags_api_still_uploads(api, tray, immich_db, monkeypatch):
    sid, _ = tray
    monkeypatch.setattr(fake_immich, "TAGS", False)
    msg = upload(api, sid)
    assert "4 slides uploaded" in msg and "no tray tag" in msg, msg
