"""Accounts mode hardening (ARCHITECTURE §4e "Limits"): sign-in rate limit, a revoked Immich key
ending the session, quotas, jobs that a restart cut off, and the server-wide limit on
full-resolution renders. Two users (Ann, Bob) of the mock Immich, as in test_hosted.py.
"""
from __future__ import annotations

import json
import shutil
import threading
import time

import pytest
from fastapi.testclient import TestClient

import fake_immich
from conftest import wait_job
from slidestation import accounts, server, store, uploads
from slidestation import imaging as im
from slidestation import workflow as wf
from slidestation.server import app
from synthetic import make_scans
from test_hosted import ANN, BOB, hosted, upload_folder  # noqa: F401 (hosted is a fixture)


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(accounts, "_now", c)
    return c


def _forget_users():
    for u in (ANN, BOB):
        shutil.rmtree(store.CONFIG_DIR / "users" / u["id"], ignore_errors=True)
        with store.as_home(store.CONFIG_DIR / "users" / u["id"]):
            wf._jobs.pop(wf._key(), None)
    accounts._attempts.clear()
    uploads.forget_usage()


@pytest.fixture(autouse=True)
def _fresh():
    """Each test starts with Ann and Bob new to the server (test_hosted.py expects that too)."""
    _forget_users()
    yield
    _forget_users()


@pytest.fixture
def me_calls(monkeypatch):
    """Counts the /users/me questions Slide Station asks Immich."""
    calls = []
    orig = accounts.Immich.me

    def me(self):
        calls.append(1)
        return orig(self)

    monkeypatch.setattr(accounts.Immich, "me", me)
    return calls


def login(key: str, address: str = "10.0.0.1", headers: dict | None = None) -> tuple[TestClient, object]:
    c = TestClient(app, client=(address, 50000))
    return c, c.post("/api/auth/login", json={"api_key": key}, headers=headers or {})


# --------------------------------------------------------------------------- sign-in rate limit


def test_failed_sign_ins_slow_down_per_address(hosted, clock, me_calls):
    for i in range(accounts.SIGNIN_FREE):
        assert login(f"guess{i}-xxxx")[1].status_code == 401
    asked = len(me_calls)
    _, r = login("guess9-xxxx")
    assert r.status_code == 429 and r.headers["retry-after"] == "3" and r.json()["retry_after"] == 3
    assert "Too many failed sign-ins" in r.json()["error"]
    _, r = login("ann-key")  # even a good key waits: it's this address that has been guessing
    assert r.status_code == 429
    assert len(me_calls) == asked  # Immich wasn't asked while the address waits
    c, r = login("ann-key", "10.0.0.2")  # another address signs in
    assert r.status_code == 200 and c.get("/api/state").status_code == 200
    # the wait doubles with each further failure, up to SIGNIN_MAX_WAIT
    clock.t += 3
    assert login("guess10-xxx")[1].status_code == 401
    assert login("guess11-xxx")[1].json()["retry_after"] == 5
    for _ in range(12):
        clock.t += accounts.SIGNIN_MAX_WAIT
        assert login("guess12-xxx")[1].status_code == 401
    assert login("guess13-xxx")[1].json()["retry_after"] == accounts.SIGNIN_MAX_WAIT + 1
    # an hour of quiet starts over
    clock.t += accounts.SIGNIN_FORGET + 1
    assert login("ann-key")[1].status_code == 200


def test_failed_sign_ins_slow_down_per_key_prefix(hosted, clock, monkeypatch):
    # the same key guessed from many addresses (a botnet finishing a key it knows the start of)
    for i in range(accounts.SIGNIN_FREE):
        assert login(f"ann-key-{i}", f"10.1.0.{i}")[1].status_code == 401
    _, r = login("ann-key-x", "10.1.0.99")
    assert r.status_code == 429
    assert login("bob-key", "10.1.0.99")[1].status_code == 200  # other keys from that address are fine
    # the key itself signing in clears its prefix: its owner's next typos are free again
    monkeypatch.setattr(fake_immich, "USERS", {**fake_immich.USERS, "ann-key-good": ANN})
    clock.t += 3
    assert login("ann-key-good", "10.1.0.60")[1].status_code == 200
    assert login("ann-key-typo", "10.1.0.61")[1].status_code == 401
    assert login("ann-key-typ0", "10.1.0.62")[1].status_code == 401  # 429 if the count had stayed


def test_forwarded_for_only_behind_a_trusted_proxy(hosted, clock, monkeypatch):
    for i in range(accounts.SIGNIN_FREE):
        login(f"proxy{i}-xxxx", "10.2.0.1", {"X-Forwarded-For": f"198.51.100.{i}"})
    # untrusted: the header is ignored, every try came from the proxy's own address
    assert login("proxy9-xxxx", "10.2.0.1", {"X-Forwarded-For": "198.51.100.9"})[1].status_code == 429
    accounts._attempts.clear()
    monkeypatch.setattr(server, "TRUST_PROXY", True)
    for i in range(accounts.SIGNIN_FREE + 2):  # each from its own client behind the proxy
        _, r = login(f"proxy{i}-yyyy", "10.2.0.1", {"X-Forwarded-For": f"203.0.113.7, 198.51.100.{i}"})
        assert r.status_code == 401
    for i in range(accounts.SIGNIN_FREE):
        login(f"proxz{i}-zzzz", "10.2.0.1", {"X-Forwarded-For": "198.51.100.200"})
    _, r = login("proxz9-zzzz", "10.2.0.1", {"X-Forwarded-For": "203.0.113.7, 198.51.100.200"})
    assert r.status_code == 429  # the last entry (added by the proxy) counts, not what the client wrote first


# --------------------------------------------------------------------------- a revoked key


def test_a_revoked_key_ends_the_session(hosted, clock, me_calls, monkeypatch):
    ann, ann2, bob = hosted("ann-key"), hosted("ann-key"), hosted("bob-key")
    home = accounts.user_dir(ANN["id"])
    asked = len(me_calls)
    clock.t += accounts.KEY_RECHECK - 5
    assert ann.get("/api/state").status_code == 200
    assert len(me_calls) == asked  # not due yet: no question to Immich per request
    # the key is revoked in Immich
    assert TestClient(fake_immich.app).delete("/debug/keys/ann-key").json() == {"revoked": True}
    assert ann.get("/api/state").status_code == 200  # still within the ten minutes
    clock.t += 10
    r = ann.get("/api/state")
    assert r.status_code == 401 and r.json()["signin"]
    assert len(me_calls) == asked + 1
    auth = ann.get("/api/auth").json()
    assert auth["user"] is None and "no longer accepts" in auth["ended"]
    assert ann2.get("/api/state").status_code == 401  # every session of Ann's ended
    assert "immich_key" not in json.loads((home / "config.json").read_text())  # the dead key is forgotten
    assert bob.get("/api/state").status_code == 200  # Bob's key is still good (checked too)
    assert bob.get("/api/auth").json()["user"] == BOB
    # a new key signs Ann in again
    monkeypatch.setattr(fake_immich, "USERS", {**fake_immich.USERS, "ann-key-2": ANN})
    ann3 = hosted("ann-key-2")
    assert ann3.get("/api/state").status_code == 200 and "ended" not in ann3.get("/api/auth").json()


def test_immich_down_keeps_the_session(hosted, clock, monkeypatch):
    ann = hosted("ann-key")

    def down(self):
        raise OSError("connection refused")

    monkeypatch.setattr(accounts.Immich, "me", down)
    clock.t += accounts.KEY_RECHECK + 1
    assert ann.get("/api/state").status_code == 200
    rec = [r for r in json.loads((store.CONFIG_DIR / "auth.json").read_text()).values() if r["user"] == ANN["id"]]
    # asked again a minute later, not on every request
    assert all(abs(r["checked"] - (clock.t - accounts.KEY_RECHECK + accounts.KEY_RETRY)) < 1e-6
               for r in rec if not r.get("ended"))


def test_settings_take_only_the_users_own_key(hosted):
    ann = hosted("ann-key")
    r = ann.post("/api/config", json={"immich_key": "bob-key"})
    assert r.status_code == 400 and "another Immich user" in r.json()["error"]
    assert ann.post("/api/config", json={"immich_key": "wrong"}).status_code == 400
    home = accounts.user_dir(ANN["id"])
    assert json.loads((home / "config.json").read_text())["immich_key"] == "ann-key"
    assert ann.post("/api/config", json={"immich_key": "ann-key", "jpeg_quality": 91}).json() == {"ok": True}


# --------------------------------------------------------------------------- quotas


def files_of(folder):
    return [{"path": p.relative_to(folder).as_posix(), "size": p.stat().st_size} for p in sorted(folder.rglob("*.JPG"))]


def test_upload_quota(hosted, tmp_path, monkeypatch):
    ann, bob = hosted("ann-key"), hosted("bob-key")
    make_scans(tmp_path / "a", 3, salt=9601, first=9601)
    files = files_of(tmp_path / "a")
    total = sum(f["size"] for f in files)
    monkeypatch.setattr(uploads, "QUOTA_UPLOADS", total - 1)
    uid = ann.post("/api/uploads", json={"name": "Box"}).json()["id"]
    r = ann.post(f"/api/uploads/{uid}/check", json={"files": files})
    assert r.status_code == 413 and r.json()["quota"] == "uploads"
    assert "Not enough room for uploads" in r.json()["error"]
    # a client that sends anyway is stopped at the chunk that doesn't fit
    first = (tmp_path / "a" / files[0]["path"]).read_bytes()
    monkeypatch.setattr(uploads, "QUOTA_UPLOADS", len(first) + 1000)
    assert ann.put(f"/api/uploads/{uid}/files/{files[0]['path']}", content=first,
                   params={"offset": 0, "size": len(first)}).status_code == 200
    data = (tmp_path / "a" / files[1]["path"]).read_bytes()
    r = ann.put(f"/api/uploads/{uid}/files/{files[1]['path']}", content=data, params={"offset": 0, "size": len(data)})
    assert r.status_code == 413 and r.json()["quota"] == "uploads"
    q = ann.get("/api/state").json()["quota"]
    assert q["uploads"]["limit"] == len(first) + 1000 and q["uploads"]["used"] >= len(first)
    assert "library" not in q
    # the quota is per account: Bob's uploads have their own room
    (tmp_path / "one").mkdir()
    (tmp_path / "one" / "IMG_1.JPG").write_bytes(first)
    upload_folder(bob, tmp_path / "one", "Bob's copy")  # as much as Ann has, which leaves her no room
    # deleting (or importing) an upload makes room again
    assert ann.delete(f"/api/uploads/{uid}").json() == {"ok": True}
    monkeypatch.setattr(uploads, "QUOTA_UPLOADS", total + 100)
    upload_folder(ann, tmp_path / "a")


def test_library_quota(hosted, tmp_path, monkeypatch):
    ann, bob = hosted("ann-key"), hosted("bob-key")
    make_scans(tmp_path / "a", 2, salt=9701, first=9701)
    make_scans(tmp_path / "b", 2, salt=9801, first=9801)
    up = upload_folder(ann, tmp_path / "a")
    sid = ann.post("/api/sessions", json={"name": "Ann"}).json()["id"]
    assert ann.post(f"/api/sessions/{sid}/import", json={"source": f"upload:{up}"}).json() == {"ok": True}
    wait_job(ann)
    used = ann.get("/api/state").json()["quota"]
    assert used is None  # no quotas set: nothing to report
    monkeypatch.setattr(uploads, "QUOTA_LIBRARY", 1)
    uploads.forget_usage()
    q = ann.get("/api/state").json()["quota"]["library"]
    assert q["limit"] == 1 and q["used"] > 10_000
    # models and place names are the server's, not the user's
    lib = accounts.user_dir(ANN["id"]) / "library"
    (lib / "models").mkdir(exist_ok=True)
    (lib / "models" / "big.onnx").write_bytes(b"x" * 2_000_000)
    uploads.forget_usage()
    assert ann.get("/api/state").json()["quota"]["library"]["used"] == q["used"]
    monkeypatch.setattr(uploads, "QUOTA_LIBRARY", q["used"] + 1000)
    uid = ann.post("/api/uploads", json={"name": "More"}).json()["id"]
    r = ann.post(f"/api/uploads/{uid}/check", json={"files": files_of(tmp_path / "b")})
    assert r.status_code == 413 and r.json()["quota"] == "library"
    assert "Your library is full" in r.json()["error"] and "Keep original scans" in r.json()["error"]
    # Bob's library is empty: the same quota leaves him room
    upload_folder(bob, tmp_path / "b", "Bob's")


# --------------------------------------------------------------------------- jobs cut off by a restart


def restart(user: dict) -> None:
    """What a restart does to the jobs: this process forgets them (job.json stays on disk)."""
    with store.as_home(accounts.user_dir(user["id"])):
        wf._jobs.pop(wf._key(), None)


def blocking(release: list):
    def fn(job, *args):
        job.message = "Working"
        while not release:  # the restart: this thread stands for the process that died
            time.sleep(0.01)

    return fn


def test_an_interrupted_import_is_reported_and_resumes(hosted, tmp_path, monkeypatch):
    ann, bob = hosted("ann-key"), hosted("bob-key")
    make_scans(tmp_path / "a", 3, salt=9901, first=9901)
    up = upload_folder(ann, tmp_path / "a", "Box 9")
    sid = ann.post("/api/sessions", json={"name": "Ann"}).json()["id"]
    release: list = []
    real = wf.import_upload
    monkeypatch.setattr(wf, "import_upload", blocking(release))
    try:
        assert ann.post(f"/api/sessions/{sid}/import", json={"source": f"upload:{up}"}).json() == {"ok": True}
        rec = json.loads((accounts.user_dir(ANN["id"]) / "job.json").read_text())
        assert rec["kind"] == "import" and rec["session"] == sid and rec["resume"] == {"source": f"upload:{up}"}
        assert not (accounts.user_dir(BOB["id"]) / "job.json").exists()
        restart(ANN)
        monkeypatch.setattr(wf, "import_upload", real)
        job = ann.get("/api/state").json()["job"]
        assert job["finished"] and job["interrupted"] and job["resumable"]
        assert "interrupted by a server restart" in job["error"] and "import again" in job["error"]
        assert bob.get("/api/state").json()["job"] is None or not bob.get("/api/state").json()["job"].get("interrupted")
        assert ann.get(f"/api/sessions/{sid}").json()["groups"] == []
        assert ann.post("/api/job/resume").json() == {"ok": True}
        assert "Imported" in wait_job(ann)["message"]
        assert len(ann.get(f"/api/sessions/{sid}").json()["groups"]) == 3
        assert f"upload:{up}" not in [s["path"] for s in ann.get("/api/state").json()["sources"]]  # staging gone
        assert not (accounts.user_dir(ANN["id"]) / "job.json").exists()  # a job that ended leaves nothing
        assert ann.post("/api/job/resume").status_code == 404  # nothing left to resume
    finally:
        release.append(1)


def test_an_interrupted_upload_is_reported_and_resumes(hosted, tmp_path, monkeypatch, immich_db):
    ann = hosted("ann-key")
    make_scans(tmp_path / "a", 2, salt=9951, first=9951)
    up = upload_folder(ann, tmp_path / "a")
    sid = ann.post("/api/sessions", json={"name": "Ann's trip"}).json()["id"]
    ann.post(f"/api/sessions/{sid}/import", json={"source": f"upload:{up}"})
    wait_job(ann)
    gids = [g["id"] for g in ann.get(f"/api/sessions/{sid}").json()["groups"]]
    ann.patch(f"/api/sessions/{sid}/groups/{gids[0]}", json={"reviewed": True})
    # one slide went up before the restart
    assert ann.post(f"/api/sessions/{sid}/finish", json={"only_ready": True}).json() == {"ok": True}
    wait_job(ann)
    sent = len(immich_db["assets"])
    ann.patch(f"/api/sessions/{sid}/groups/{gids[1]}", json={"reviewed": True})
    release: list = []
    real = wf.finish_session
    monkeypatch.setattr(wf, "finish_session", blocking(release))
    try:
        assert ann.post(f"/api/sessions/{sid}/finish", json={"only_ready": True}).json() == {"ok": True}
        restart(ANN)
        monkeypatch.setattr(wf, "finish_session", real)
        job = ann.get("/api/state").json()["job"]
        assert job["kind"] == "upload" and job["interrupted"] and "upload again" in job["error"]
        assert ann.post("/api/job/resume").json() == {"ok": True}
        wait_job(ann)
        slides = ann.get(f"/api/sessions/{sid}").json()["groups"]
        assert all(g["status"] == "uploaded" for g in slides), [g["status"] for g in slides]
        assert len(immich_db["assets"]) == 2 * sent  # the first slide wasn't sent twice
    finally:
        release.append(1)


def test_other_interrupted_jobs_just_say_so(hosted):
    ann = hosted("ann-key")
    (accounts.user_dir(ANN["id"]) / "job.json").write_text(json.dumps(
        {"id": "x", "kind": "faces", "session": None, "started": 1.0, "resume": None}))
    restart(ANN)
    job = ann.get("/api/state").json()["job"]
    assert job["interrupted"] and not job["resumable"] and "faces job was interrupted" in job["error"]
    assert ann.post("/api/job/resume").status_code == 404
    # a new job replaces the report
    sid = ann.post("/api/sessions", json={"name": "x"}).json()["id"]
    assert ann.post(f"/api/sessions/{sid}/finish", json={}).status_code == 400  # nothing to upload: no job
    assert ann.get("/api/state").json()["job"]["interrupted"]


# --------------------------------------------------------------------------- full-resolution renders


def test_full_resolution_renders_are_limited_across_users(hosted, tmp_path, monkeypatch):
    ann, bob = hosted("ann-key"), hosted("bob-key")
    trays = []
    for who, client, salt in ((ANN, ann, 9971), (BOB, bob, 9981)):
        make_scans(tmp_path / who["name"], 1, salt=salt, first=salt)
        up = upload_folder(client, tmp_path / who["name"])
        sid = client.post("/api/sessions", json={"name": who["name"]}).json()["id"]
        client.post(f"/api/sessions/{sid}/import", json={"source": f"upload:{up}"})
        wait_job(client)
        trays.append((who, sid, client.get(f"/api/sessions/{sid}").json()["groups"][0]["id"]))
    assert wf.FULL_RENDERS == 1  # the default: SLIDESTATION_FULL_RENDERS unset

    now, most = [0], [0]
    lock = threading.Lock()
    fuse = im.fuse

    def slow_fuse(images):
        with lock:
            now[0] += 1
            most[0] = max(most[0], now[0])
        time.sleep(0.3)
        with lock:
            now[0] -= 1
        return fuse(images)

    monkeypatch.setattr(im, "fuse", slow_fuse)

    def render_both():
        most[0] = 0
        ts = []
        for who, sid, gid in trays:
            def run(who=who, sid=sid, gid=gid):
                with store.as_home(accounts.user_dir(who["id"])):
                    wf.render_export(sid, gid, 90)
            ts.append(threading.Thread(target=run))
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        return most[0]

    assert render_both() == 1  # Ann's and Bob's renders took turns
    for who, sid, gid in trays:  # render them again
        with store.as_home(accounts.user_dir(who["id"])):
            store.Session(sid)  # still there
            wf.update_session(sid, lambda s, gid=gid: s.group(gid).update(export=None))
    monkeypatch.setattr(wf, "_export_lock", threading.BoundedSemaphore(2))
    assert render_both() == 2  # SLIDESTATION_FULL_RENDERS=2: both at once
