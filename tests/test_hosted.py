"""Hosted container (ARCHITECTURE "Hosted container"): folders uploaded from the browser, and
accounts — each Immich user their own library, never anyone else's.

Accounts are switched on per test (accounts.MODE, store.USER_IMMICH_URL); the users are keys of the
mock Immich (fake_immich.USERS), each with its own TestClient and so its own session cookie.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import fake_immich
from conftest import new_tray, wait_job
from slidestation import accounts, store, uploads
from slidestation import workflow as wf
from slidestation.server import app
from synthetic import make_scans

ANN = {"id": "a1a1a1a1-0000-4000-8000-00000000000a", "name": "Ann", "email": "ann@example.com"}
BOB = {"id": "b2b2b2b2-0000-4000-8000-00000000000b", "name": "Bob", "email": "bob@example.com"}


def upload_folder(client: TestClient, folder: Path, name: str = "Box 1", chunk: int = 4096) -> str:
    """What the UI does (lib/upload.ts): create, check, send every file in chunks with its SHA-1."""
    uid = client.post("/api/uploads", json={"name": name}).json()["id"]
    files = [{"path": p.relative_to(folder).as_posix(), "size": p.stat().st_size,
              "sha1": hashlib.sha1(p.read_bytes()).hexdigest()} for p in sorted(folder.rglob("*.JPG"))]
    have = client.post(f"/api/uploads/{uid}/check", json={"files": files}).json()["files"]
    for f in files:
        if have[f["path"]].get("have"):
            continue
        data = (folder / f["path"]).read_bytes()
        off = have[f["path"]]["offset"]
        while off < len(data):
            r = client.put(f"/api/uploads/{uid}/files/{f['path']}", content=data[off:off + chunk],
                           params={"offset": off, "size": f["size"], "sha1": f["sha1"]})
            assert r.status_code == 200, r.text
            off = r.json()["offset"]
    return uid


def wait(client: TestClient, timeout: float = 60) -> dict:
    return wait_job(client, timeout)


# --------------------------------------------------------------------------- the server itself


def test_health_and_no_accounts_by_default(api):
    assert api.get("/api/health").json() == {"ok": True}
    assert api.get("/api/auth").json() == {"accounts": False, "user": None}
    st = api.get("/api/state").json()
    assert st["server"]["accounts"] is False and "raw" in st["server"]


def test_binds_to_localhost_unless_told(monkeypatch):
    from slidestation import server

    seen = {}
    monkeypatch.setattr("uvicorn.run", lambda app, **kw: seen.update(kw))
    monkeypatch.setenv("SLIDESTATION_NO_BROWSER", "1")
    monkeypatch.delenv("SLIDESTATION_HOST", raising=False)
    server.main()
    assert seen["host"] == "127.0.0.1"
    monkeypatch.setenv("SLIDESTATION_HOST", "0.0.0.0")
    server.main()
    assert seen["host"] == "0.0.0.0"


# --------------------------------------------------------------------------- uploads


def test_upload_then_import_as_a_folder(api, tmp_path):
    folder = tmp_path / "Box 1"
    make_scans(folder / "100MEDIA", 3, salt=9101, first=9101)  # 2 + 1 + 2 scans
    uid = upload_folder(api, folder)
    src = next(x for x in api.get("/api/state").json()["sources"] if x["path"] == f"upload:{uid}")
    assert src == {"path": f"upload:{uid}", "name": "Box 1", "count": 5, "new": 5, "scanner": False,
                   "removable": False, "upload": True}
    sid = api.post("/api/sessions", json={"name": "Uploaded"}).json()["id"]
    assert api.post(f"/api/sessions/{sid}/import", json={"source": f"upload:{uid}"}).json() == {"ok": True}
    assert "Imported 5 scans into 3 slides" in wait(api)["message"]
    d = api.get(f"/api/sessions/{sid}").json()
    assert [len(g["scans"]) for g in d["groups"]] == [2, 1, 2]  # grouped like any import
    scans = store.Session(sid).data["scans"].values()
    assert all(not s["removable"] and s["source_root"] == "upload:Box 1" for s in scans)
    assert all(s["source"].startswith("upload:Box 1/") for s in scans)  # no server paths in the tray
    assert any("not from a card" in b for b in d["cleanup_blockers"])  # never "cleaned" like a card
    # the staging copy is gone once the tray has its verified copies
    assert not any(x["path"] == f"upload:{uid}" for x in api.get("/api/state").json()["sources"])
    assert not (store.library() / "uploads" / uid).exists()


def test_upload_resumes_and_verifies(api, tmp_path):
    folder = tmp_path / "scans"
    make_scans(folder, 2, salt=9201, first=9201)  # 3 files
    files = sorted(folder.glob("*.JPG"))
    uid = api.post("/api/uploads", json={"name": "Resume"}).json()["id"]
    a, b = files[0].read_bytes(), files[1].read_bytes()
    sha_a = hashlib.sha1(a).hexdigest()
    put = lambda name, data, off, size, sha="": api.put(f"/api/uploads/{uid}/files/{name}", content=data,
                                                        params={"offset": off, "size": size, "sha1": sha})
    # half of the first file, then the connection "drops"
    assert put(files[0].name, a[:1000], 0, len(a), sha_a).json() == {"offset": 1000, "done": False}
    listing = [{"path": f.name, "size": f.stat().st_size, "sha1": hashlib.sha1(f.read_bytes()).hexdigest()}
               for f in files]
    have = api.post(f"/api/uploads/{uid}/check", json={"files": listing}).json()["files"]
    assert have[files[0].name] == {"offset": 1000} and have[files[1].name] == {"offset": 0}
    # a chunk at the wrong offset is refused with where to carry on
    r = put(files[0].name, a[500:1500], 500, len(a), sha_a)
    assert r.status_code == 409 and r.json()["offset"] == 1000
    assert put(files[0].name, a[1000:], 1000, len(a), sha_a).json() == {"offset": len(a), "done": True}
    # damaged on the way: refused, and it starts again
    bad = bytearray(b)
    bad[200] ^= 0xFF
    r = put(files[1].name, bytes(bad), 0, len(b), hashlib.sha1(b).hexdigest())
    assert r.status_code == 422 and r.json()["offset"] == 0
    assert put(files[1].name, b, 0, len(b), hashlib.sha1(b).hexdigest()).json()["done"]
    have = api.post(f"/api/uploads/{uid}/check", json={"files": listing}).json()["files"]
    assert have[files[0].name] == {"have": True} and have[files[1].name] == {"have": True}
    assert have[files[2].name] == {"offset": 0}
    # the same file sent again once it is complete: nothing to do
    assert put(files[0].name, a, 0, len(a), sha_a).json() == {"offset": len(a), "done": True}
    # scans already imported somewhere in the library don't need sending
    sid, _ = new_tray(api, tmp_path / "other", slides=1)
    known = next(iter(store.Session(sid).data["scans"].values()))
    have = api.post(f"/api/uploads/{uid}/check", json={"files": [
        {"path": "known.jpg", "size": known["size"], "sha1": known["sha1"]}]}).json()["files"]
    assert have["known.jpg"] == {"have": True, "imported": True}
    assert api.delete(f"/api/uploads/{uid}").json() == {"ok": True}
    assert api.post(f"/api/uploads/{uid}/check", json={"files": []}).status_code == 404


@pytest.mark.parametrize("path", ["../escape.jpg", "a/../../b.jpg", ".hidden/x.jpg", "notes.txt", "/etc/x.jpg",
                                  "a/.x.jpg", "..", "x.JPG/../../y.jpg"])
def test_upload_paths_stay_inside(api, path):
    uid = api.post("/api/uploads", json={}).json()["id"]
    r = api.put(f"/api/uploads/{uid}/files/{path}", content=b"x", params={"offset": 0, "size": 1})
    assert r.status_code in (400, 404, 405), (path, r.status_code)  # 404/405: never routed at all
    assert [p.name for p in (store.library() / "uploads" / uid).iterdir()] == ["upload.json"]
    assert not (store.library() / "escape.jpg").exists()


def test_upload_limits(api, monkeypatch):
    uid = api.post("/api/uploads", json={}).json()["id"]
    monkeypatch.setattr(uploads, "MAX_FILE", 10)
    r = api.put(f"/api/uploads/{uid}/files/a.jpg", content=b"x" * 5, params={"offset": 0, "size": 11})
    assert r.status_code == 413
    r = api.put(f"/api/uploads/{uid}/files/a.jpg", content=b"x" * 12, params={"offset": 0, "size": 10})
    assert r.status_code == 400 and not (store.library() / "uploads" / uid / "a.jpg.part").exists()
    assert api.post("/api/uploads/nothere12345/check", json={"files": []}).status_code == 404
    assert api.post("/api/sessions/x/import", json={"source": "upload:0123456789ab"}).status_code == 404


# --------------------------------------------------------------------------- accounts


@pytest.fixture
def hosted(monkeypatch, immich_db):
    """Accounts on, with Ann and Bob as users of the (mock) Immich; yields a client factory."""
    monkeypatch.setattr(accounts, "MODE", "immich")
    monkeypatch.setattr(store, "USER_IMMICH_URL", "http://immich.test")
    monkeypatch.setattr(fake_immich, "USERS", {**fake_immich.USERS, "ann-key": ANN, "bob-key": BOB})

    def client(key: str | None = None) -> TestClient:
        c = TestClient(app)
        if key:
            r = c.post("/api/auth/login", json={"api_key": key})
            assert r.status_code == 200, r.text
        return c

    yield client


def test_signing_in(hosted):
    anon = hosted()
    assert anon.get("/api/auth").json() == {"accounts": True, "user": None, "immich_url": "http://immich.test"}
    for url in ("/api/state", "/api/sessions/x", "/api/uploads", "/api/config"):
        r = anon.get(url) if url != "/api/uploads" else anon.post(url, json={})
        assert r.status_code == 401 and r.json()["signin"], url
    assert anon.get("/api/health").status_code == 200
    r = anon.post("/api/auth/login", json={"api_key": "wrong"})
    assert r.status_code == 401 and "rejected" in r.json()["error"]
    ann = hosted("ann-key")
    assert ann.get("/api/auth").json()["user"] == ANN
    cookie = TestClient(app).post("/api/auth/login", json={"api_key": "ann-key"}).headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    home = store.CONFIG_DIR / "users" / ANN["id"]
    cfg = json.loads((home / "config.json").read_text())
    assert cfg["immich_key"] == "ann-key"
    tokens = (store.CONFIG_DIR / "auth.json").read_text()
    assert ann.cookies.get(accounts.COOKIE) not in tokens  # only hashes on disk
    st = ann.get("/api/state").json()
    assert st["config"]["library"] == str(home / "library") and st["config"]["immich_url"] == "http://immich.test"
    assert st["sessions"] == [] and st["server"]["accounts"] and st["camera"] is None
    # an account can't move its library or point at another Immich
    ann.post("/api/config", json={"library": "/tmp/elsewhere", "immich_url": "http://evil.test", "jpeg_quality": 90})
    st = ann.get("/api/state").json()
    assert st["config"]["library"] == str(home / "library") and st["config"]["immich_url"] == "http://immich.test"
    assert st["config"]["jpeg_quality"] == 90
    assert ann.post("/api/immich/test", json={"immich_url": "http://evil.test"}).json()["ok"]  # the server's Immich
    assert ann.post("/api/auth/logout").json() == {"ok": True}
    assert ann.get("/api/state").status_code == 401
    # a forged or stale cookie is nobody
    forged = TestClient(app, cookies={accounts.COOKIE: "made-up"})
    assert forged.get("/api/state").status_code == 401


def test_users_never_see_each_others_trays(hosted, tmp_path):
    ann, bob = hosted("ann-key"), hosted("bob-key")
    make_scans(tmp_path / "a", 2, salt=9301, first=9301)
    make_scans(tmp_path / "b", 1, salt=9401, first=9401)
    a_up, b_up = upload_folder(ann, tmp_path / "a", "Ann's box"), upload_folder(bob, tmp_path / "b", "Bob's box")
    # each sees only their own uploads, and can't touch the other's
    assert [x["path"] for x in ann.get("/api/state").json()["sources"]] == [f"upload:{a_up}"]
    assert [x["path"] for x in bob.get("/api/state").json()["sources"]] == [f"upload:{b_up}"]
    assert bob.post(f"/api/uploads/{a_up}/check", json={"files": []}).status_code == 404
    assert bob.put(f"/api/uploads/{a_up}/files/x.jpg", content=b"x", params={"size": 1}).status_code == 404
    assert bob.delete(f"/api/uploads/{a_up}").status_code == 404

    a_sid = ann.post("/api/sessions", json={"name": "Ann's tray"}).json()["id"]
    b_sid = bob.post("/api/sessions", json={"name": "Bob's tray"}).json()["id"]
    # Bob can't import Ann's upload into his tray either
    assert bob.post(f"/api/sessions/{b_sid}/import", json={"source": f"upload:{a_up}"}).status_code == 404
    assert ann.post(f"/api/sessions/{a_sid}/import", json={"source": f"upload:{a_up}"}).json() == {"ok": True}
    assert bob.post(f"/api/sessions/{b_sid}/import", json={"source": f"upload:{b_up}"}).json() == {"ok": True}
    wait(ann), wait(bob)  # each account has its own job: both imports ran at the same time

    assert [t["name"] for t in ann.get("/api/state").json()["sessions"]] == ["Ann's tray"]
    assert [t["name"] for t in bob.get("/api/state").json()["sessions"]] == ["Bob's tray"]
    a = ann.get(f"/api/sessions/{a_sid}").json()
    assert len(a["groups"]) == 2
    gid, scan = a["groups"][0]["id"], a["groups"][0]["scans"][0]
    # every way into a tray by id answers Bob "not found"
    for url in (f"/api/sessions/{a_sid}", f"/api/sessions/{a_sid}?peek=1",
                f"/api/sessions/{a_sid}/groups/{gid}/preview.jpg", f"/api/sessions/{a_sid}/groups/{gid}/histogram",
                f"/api/sessions/{a_sid}/groups/{gid}/full", f"/api/sessions/{a_sid}/scans/{scan}/thumb.jpg"):
        assert bob.get(url).status_code == 404, url
        assert ann.get(url).status_code == 200, url
    assert bob.patch(f"/api/sessions/{a_sid}/groups/{gid}", json={"skip": True}).status_code == 404
    assert bob.patch(f"/api/sessions/{a_sid}", json={"name": "mine now"}).status_code == 404
    assert bob.post(f"/api/sessions/{a_sid}/finish", json={}).status_code == 404
    assert bob.post(f"/api/sessions/{b_sid}/groups/x/look",
                    json={"like": {"session": a_sid, "group": gid}}).status_code == 404  # "develop like" Ann's
    assert bob.post("/api/presets", json={"name": "stolen", "session": a_sid, "group": gid}).status_code == 404
    # nor through the path: a tray id is one plain name
    for sid in ("..", f"..%2F..%2Fusers%2F{ANN['id']}%2Flibrary%2Fsessions%2F{a_sid}"):
        assert bob.get(f"/api/sessions/{sid}").status_code == 404
    assert ann.get(f"/api/sessions/{a_sid}").json()["summary"]["name"] == "Ann's tray"  # untouched
    # the libraries are separate folders
    assert (store.CONFIG_DIR / "users" / ANN["id"] / "library" / "sessions" / a_sid).is_dir()
    assert not (store.CONFIG_DIR / "users" / BOB["id"] / "library" / "sessions" / a_sid).exists()
    # and each uploads with their own key
    ann.patch(f"/api/sessions/{a_sid}/groups/{gid}", json={"reviewed": True})
    assert ann.post(f"/api/sessions/{a_sid}/finish", json={"only_ready": True}).json() == {"ok": True}
    assert "1" in wait(ann)["message"]


def test_accounts_import_only_their_uploads(hosted, tmp_path):
    ann = hosted("ann-key")
    sid = ann.post("/api/sessions", json={"name": "Ann"}).json()["id"]
    make_scans(tmp_path / "server-folder", 1, salt=9501, first=9501)
    for source in (str(tmp_path / "server-folder"), str(store.CONFIG_DIR / "users" / BOB["id"]), "/"):
        r = ann.post(f"/api/sessions/{sid}/import", json={"source": source})
        assert r.status_code == 403, source
    assert ann.post("/api/eject", json={"path": "/Volumes/x"}).status_code == 403


def test_jobs_are_per_account(hosted, monkeypatch):
    ann, bob = hosted("ann-key"), hosted("bob-key")
    release = []

    def slow(job):
        while not release:
            time.sleep(0.01)

    with store.as_home(accounts.user_dir(ANN["id"])):
        wf.start_job("slow", None, slow)
        assert wf.current_job.kind == "slow" and not wf.current_job.finished
    try:
        assert ann.get("/api/state").json()["job"]["kind"] == "slow"
        job = bob.get("/api/state").json()["job"]
        assert job is None or (job["kind"] != "slow" and job["finished"])  # Bob isn't busy with Ann's job
        sid = ann.post("/api/sessions", json={"name": "x"}).json()["id"]
        assert ann.post(f"/api/sessions/{sid}/import", json={"source": "upload:0123456789ab"}).status_code == 404
        up = ann.post("/api/uploads", json={}).json()["id"]
        assert ann.post(f"/api/sessions/{sid}/import", json={"source": f"upload:{up}"}).status_code == 409
    finally:
        release.append(1)
