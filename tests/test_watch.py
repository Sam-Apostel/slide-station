"""Watched folders (watch.py, ARCHITECTURE §4e "Watched folders"): sub-folders dropped into a share
become trays once they settle; handled ones are recorded in the library, never in the share.

The watcher's thread is kept out of it: the tests poll by hand (`watch.tick(now)`) with a made-up
clock, so "30 seconds unchanged" takes no time.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import fake_immich
from conftest import _salts, wait_job
from slidestation import accounts, store, watch
from slidestation import workflow as wf
from slidestation.server import app
from synthetic import make_scans

# not test_hosted's Ann and Bob: their libraries (same server home) already hold trays
ANN = {"id": "c3c3c3c3-0000-4000-8000-00000000000c", "name": "Ann", "email": "ann@example.com"}
BOB = {"id": "d4d4d4d4-0000-4000-8000-00000000000d", "name": "Bob", "email": "bob@example.com"}


@pytest.fixture(autouse=True)
def _by_hand(monkeypatch):
    monkeypatch.setattr(watch, "_loop_on", False)
    monkeypatch.delenv("SLIDESTATION_WATCH_ROOT", raising=False)
    monkeypatch.setenv("SLIDESTATION_WATCH_SETTLE", "30")
    watch._seen.clear()
    watch._checked.clear()
    yield


def drop(share: Path, name: str, slides: int = 3) -> Path:
    """A sub-folder of fresh scans, as someone copying a tray into the share would leave it."""
    salt = next(_salts)
    make_scans(share / name, slides, salt=salt, first=salt * 10)
    return share / name


def tree(p: Path) -> dict:
    """Every file under p with its bytes' hash and mtime: the share must never change."""
    return {str(f.relative_to(p)): (hashlib.sha1(f.read_bytes()).hexdigest(), f.stat().st_mtime_ns)
            for f in sorted(p.rglob("*")) if f.is_file()}


def settle(client: TestClient, t0: float) -> dict:
    """Poll as the thread would: first sight, then again after the settle time; wait for the job."""
    watch.tick(t0)
    watch.tick(t0 + 31)
    return wait_job(client)


def sub(client: TestClient, name: str) -> dict:
    return next(s for f in client.get("/api/watch").json()["folders"] for s in f["subfolders"] if s["name"] == name)


def trays_named(client: TestClient, name: str) -> list[dict]:
    return [s for s in client.get("/api/state").json()["sessions"] if s["name"] == name]


def test_date_from_name():
    assert watch.date_from_name("1978-08 Lake Garda") == "1978-08"
    assert watch.date_from_name("1978 Summer") == "1978"
    assert watch.date_from_name("1978-08-14 wedding") == "1978-08-14"
    assert watch.date_from_name("1978.8 x") == "1978-08"
    assert watch.date_from_name("1978-13 x") == "1978"
    assert watch.date_from_name("19780814") == ""
    assert watch.date_from_name("Box 12") == ""
    assert watch.date_from_name("1066 and all that") == ""


def test_folder_becomes_a_tray_once_settled_and_only_once(api, tmp_path):
    share = tmp_path / "share"
    share.mkdir()
    r = api.post("/api/watch", json={"path": str(share)})
    assert r.status_code == 200, r.text
    fid = r.json()["id"]
    assert api.get("/api/state").json()["server"]["watch"] is True
    folder = drop(share, "1978-08 Lake Garda")
    before = tree(share)
    t0 = time.time()
    watch.tick(t0)
    assert sub(api, "1978-08 Lake Garda")["state"] == "waiting"
    assert api.get("/api/state").json()["watch"]["waiting"] == 1
    watch.tick(t0 + 10)  # not settled yet
    assert not trays_named(api, "1978-08 Lake Garda")
    watch.tick(t0 + 31)
    job = wait_job(api)
    assert job["kind"] == "watch" and "Imported 5 scans into 3 slides" in job["message"]
    [tray] = trays_named(api, "1978-08 Lake Garda")
    assert tray["album"] == "1978-08 Lake Garda" and tray["date"] == "1978-08" and tray["slides"] == 3
    s = sub(api, "1978-08 Lake Garda")
    assert s["state"] == "imported" and s["slides"] == 3 and s["tray"] == tray["id"]
    # never removable: card cleanup refuses a watched folder
    d = store.Session(tray["id"]).data
    assert all(not x["removable"] and x["source"].startswith("watch:1978-08 Lake Garda/") for x in d["scans"].values())
    assert api.post(f"/api/sessions/{tray['id']}/cleanup").status_code >= 400
    # the share is exactly as it was: nothing written, moved or deleted, no marker left
    assert tree(share) == before and sorted(p.name for p in share.iterdir()) == ["1978-08 Lake Garda"]
    assert json.loads((store.library() / "watched.json").read_text())[str(folder.resolve())]["state"] == "imported"
    # polled again, forgotten in memory, or the folder removed and added again: never a second tray
    for t in (t0 + 100, t0 + 1000):
        watch.tick(t)
    watch._seen.clear()
    watch._checked.clear()
    watch.tick(t0 + 2000)
    watch.tick(t0 + 2100)
    assert api.delete(f"/api/watch/{fid}").json() == {"ok": True}
    last = api.get("/api/state").json()["job"]
    api.post("/api/watch", json={"path": str(share)})
    watch.tick(t0 + 3000)
    watch.tick(t0 + 3100)
    assert api.get("/api/state").json()["job"] == last  # no job started
    assert len(trays_named(api, "1978-08 Lake Garda")) == 1


def test_changes_restart_the_clock_and_done_marker(api, tmp_path):
    share = tmp_path / "share"
    share.mkdir()
    fid = api.post("/api/watch", json={"path": str(share), "require_done": True}).json()["id"]
    folder = drop(share, "Box 7", slides=2)
    t0 = time.time()
    watch.tick(t0)
    make_scans(folder / "more", 1, salt=next(_salts), first=5000)  # still copying
    watch.tick(t0 + 31)
    watch.tick(t0 + 50)  # 19 s since the last change
    s = sub(api, "Box 7")
    assert s["state"] == "waiting" and s["note"] == "waiting for .done"
    watch.tick(t0 + 70)  # settled, but no marker
    assert not trays_named(api, "Box 7")
    (folder / ".done").write_text("")  # (the test writes the marker; the app never does)
    watch.tick(t0 + 71)
    wait_job(api)
    [tray] = trays_named(api, "Box 7")
    assert tray["slides"] == 3 and tray["date"] == ""
    # without the marker option, a folder with no scans in it yet just waits
    api.patch(f"/api/watch/{fid}", json={"require_done": False})
    (share / "Empty").mkdir()
    watch.tick(t0 + 200)
    watch.tick(t0 + 300)
    assert sub(api, "Empty")["state"] == "waiting" and not trays_named(api, "Empty")


def test_waits_for_the_users_job(api, tmp_path):
    share = tmp_path / "share"
    share.mkdir()
    api.post("/api/watch", json={"path": str(share)})
    drop(share, "Tray A", 1)
    drop(share, "Tray B", 1)
    busy = wf.Job("upload", None)
    wf.current_job = busy  # the user is uploading
    t0 = time.time()
    watch.tick(t0)
    watch.tick(t0 + 31)
    assert wf.current_job is busy
    assert api.get("/api/state").json()["watch"]["queued"] == 2
    assert sub(api, "Tray A")["note"] == "queued behind the current job"
    busy.finished = True
    watch.tick(t0 + 32)  # one at a time: A now, B at a later poll
    wait_job(api)
    assert trays_named(api, "Tray A") and not trays_named(api, "Tray B")
    watch.tick(t0 + 33)
    wait_job(api)
    assert trays_named(api, "Tray B")


def test_interrupted_import_resumes_into_its_tray(api, tmp_path):
    share = tmp_path / "share"
    share.mkdir()
    api.post("/api/watch", json={"path": str(share)})
    folder = drop(share, "Crash")
    t0 = time.time()
    settle(api, t0)
    [tray] = trays_named(api, "Crash")
    # the process died after copying, before the folder was marked imported (and in memory, all gone)
    rec = json.loads((store.library() / "watched.json").read_text())
    rec[str(folder.resolve())]["state"] = "importing"
    (store.library() / "watched.json").write_text(json.dumps(rec))
    watch._seen.clear()
    watch._checked.clear()
    assert sub(api, "Crash")["note"] == "interrupted: imports again"
    job = settle(api, t0 + 100)
    assert job["session"] == tray["id"] and "Imported 0 scans" in job["message"]
    [again] = trays_named(api, "Crash")  # the same tray, nothing twice
    assert again["id"] == tray["id"] and again["slides"] == 3 and again["scans"] == 5
    assert sub(api, "Crash")["state"] == "imported"
    # more scans put into a handled folder later (a bracket): they join its tray
    make_scans(folder / "late", 1, salt=next(_salts), first=7000)
    watch._checked.clear()
    job = settle(api, t0 + 200)
    assert job["session"] == tray["id"] and "Imported 2 scans" in job["message"]
    assert [t["slides"] for t in trays_named(api, "Crash")] == [4]
    # the record lost altogether: a new tray would be empty (everything is in the library), so none
    (store.library() / "watched.json").write_text("{}")
    watch._seen.clear()
    watch._checked.clear()
    job = settle(api, t0 + 300)
    assert "in the library already" in job["message"] and len(trays_named(api, "Crash")) == 1
    assert sub(api, "Crash")["note"] == "already in the library"


def test_failed_import_shows_and_retries(api, tmp_path, monkeypatch):
    share = tmp_path / "share"
    share.mkdir()
    fid = api.post("/api/watch", json={"path": str(share)}).json()["id"]
    drop(share, "Broken", 1)

    def fail(*a, **k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(wf, "import_scans", fail)
    t0 = time.time()
    watch.tick(t0)
    watch.tick(t0 + 31)
    with pytest.raises(AssertionError, match="disk full"):
        wait_job(api)
    s = sub(api, "Broken")
    assert s["state"] == "error" and s["error"] == "disk full"
    watch.tick(t0 + 100)  # not again by itself while nothing changed
    assert api.get("/api/state").json()["job"]["error"] == "disk full"
    monkeypatch.undo()
    monkeypatch.setattr(watch, "_loop_on", False)
    api.post(f"/api/watch/{fid}/retry", json={"name": "Broken"})
    settle(api, t0 + 200)
    s = sub(api, "Broken")
    assert s["state"] == "imported" and len(trays_named(api, "Broken")) == 1


def test_auto_upload(api, tmp_path, immich_db):
    share = tmp_path / "share"
    share.mkdir()
    api.post("/api/watch", json={"path": str(share), "auto_upload": True})
    drop(share, "1981 Upload me", 2)
    job = settle(api, time.time())
    assert job["message"].endswith("uploaded")
    [tray] = trays_named(api, "1981 Upload me")
    assert tray["uploaded"] == 2
    album = next(a for a in immich_db["albums"].values() if a["name"] == "1981 Upload me")
    assert len(album["assets"]) == 2


def test_paths_are_checked(api, tmp_path, monkeypatch):
    assert api.post("/api/watch", json={"path": str(tmp_path / "nope")}).status_code == 400
    assert api.post("/api/watch", json={"path": "relative"}).status_code == 400
    assert api.post("/api/watch", json={"path": str(store.library())}).status_code == 400
    root = tmp_path / "root"
    (root / "inbox").mkdir(parents=True)
    (tmp_path / "outside").mkdir()
    monkeypatch.setenv("SLIDESTATION_WATCH_ROOT", str(root))
    assert api.post("/api/watch", json={"path": str(tmp_path / "outside")}).status_code == 403
    assert api.post("/api/watch", json={"path": str(root / "inbox" / ".." / ".." / "outside")}).status_code == 403
    os.symlink(tmp_path / "outside", root / "sneaky")
    assert api.post("/api/watch", json={"path": str(root / "sneaky")}).status_code == 403
    r = api.post("/api/watch", json={"path": "inbox"})  # relative to the root
    assert r.status_code == 200 and r.json()["path"] == str((root / "inbox").resolve())
    assert api.get("/api/watch").json()["root"] == str(root.resolve())


# --------------------------------------------------------------------------- accounts


@pytest.fixture
def hosted(monkeypatch, immich_db):
    monkeypatch.setattr(accounts, "MODE", "immich")
    monkeypatch.setattr(store, "USER_IMMICH_URL", "http://immich.test")
    monkeypatch.setattr(fake_immich, "USERS", {**fake_immich.USERS, "ann-key": ANN, "bob-key": BOB})

    def client(key: str) -> TestClient:
        c = TestClient(app)
        assert c.post("/api/auth/login", json={"api_key": key}).status_code == 200
        return c

    yield client


def test_accounts_need_a_root(hosted, tmp_path):
    ann = hosted("ann-key")
    (tmp_path / "share").mkdir()
    assert ann.get("/api/state").json()["server"]["watch"] is False
    assert ann.get("/api/watch").json()["available"] is False
    assert ann.post("/api/watch", json={"path": str(tmp_path / "share")}).status_code == 403
    assert ann.post("/api/watch", json={"path": "/"}).status_code == 403


def test_two_users_each_under_their_own_root(hosted, tmp_path, monkeypatch):
    share = tmp_path / "share"
    monkeypatch.setenv("SLIDESTATION_WATCH_ROOT", str(share / "{user}"))
    for u in (ANN, BOB):
        (share / u["id"] / "inbox").mkdir(parents=True)
    ann, bob = hosted("ann-key"), hosted("bob-key")
    assert ann.get("/api/state").json()["server"]["watch"] is True
    assert ann.get("/api/watch").json()["root"] == str((share / ANN["id"]).resolve())
    # Ann can't watch Bob's folder, the server's, or the whole share
    assert ann.post("/api/watch", json={"path": str(share / BOB["id"] / "inbox")}).status_code == 403
    assert ann.post("/api/watch", json={"path": str(share)}).status_code == 403
    assert ann.post("/api/watch", json={"path": "/etc"}).status_code == 403
    assert ann.post("/api/watch", json={"path": "inbox"}).status_code == 200
    assert bob.post("/api/watch", json={"path": "inbox"}).status_code == 200
    assert len(bob.get("/api/watch").json()["folders"]) == 1
    # a scan in Ann's folder that links to a file of Bob's is refused, not imported
    drop(share / ANN["id"] / "inbox", "1990 Ann")
    drop(share / BOB["id"] / "inbox", "1991 Bob")
    theirs = next((share / BOB["id"] / "inbox" / "1991 Bob").glob("*.JPG"))
    (share / ANN["id"] / "inbox" / "Sneaky").mkdir()
    os.symlink(theirs, share / ANN["id"] / "inbox" / "Sneaky" / "IMG_9999.JPG")
    # the thread polls without anyone signed in: every account that watches something
    t0 = time.time()
    watch.tick(t0)
    watch.tick(t0 + 31)
    wait_job(ann)
    wait_job(bob)  # both imports ran at once, each in its own library
    assert [s["name"] for s in ann.get("/api/state").json()["sessions"]] == ["1990 Ann"]
    assert [s["name"] for s in bob.get("/api/state").json()["sessions"]] == ["1991 Bob"]
    sneaky = sub(ann, "Sneaky")
    assert sneaky["state"] == "error" and "links outside" in sneaky["error"]
    assert not (share / BOB["id"] / "inbox" / "1990 Ann").exists()
    assert (store.CONFIG_DIR / "users" / ANN["id"] / "library" / "watched.json").exists()
    assert "1991 Bob" not in (store.CONFIG_DIR / "users" / ANN["id"] / "library" / "watched.json").read_text()
