"""Faces -> people: clustering on synthetic vectors, and the API with the face model stood in for
(people.embed_faces monkeypatched: no model, no network). Shared fixtures: conftest.py."""
from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image
from conftest import CONFIG, new_tray, wait_job

import fake_immich
from slidestation import people, store
from slidestation import workflow as wf
from slidestation.store import Session

rng = np.random.default_rng(7)


def unit(v):
    v = np.asarray(v, np.float32)
    return v / np.linalg.norm(v)


def person(n: int, noise: float = 0.5, seed: int = 0) -> np.ndarray:
    """n faces of one made-up identity: a random direction plus noise (pairwise cosine ~0.8)."""
    r = np.random.default_rng(seed)
    centre = r.normal(size=128)
    centre /= np.linalg.norm(centre)
    return np.stack([unit(centre + noise * r.normal(size=128) / np.sqrt(128)) for _ in range(n)])


# --------------------------------------------------------------------------- clustering


def test_clusters_identities():
    a, b, c = person(5, seed=1), person(3, seed=2), person(1, seed=3)
    emb = np.concatenate([a, b, c])
    order = rng.permutation(len(emb))
    groups = people.agglomerate(emb[order], [])
    found = sorted(sorted(int(order[i]) for i in g) for g in groups)
    assert found == [[0, 1, 2, 3, 4], [5, 6, 7], [8]]


def test_same_person_threshold():
    x = unit(rng.normal(size=128))
    y = unit(x + unit(rng.normal(size=128)) * 1.6)  # cosine ~0.5: above SFace's 0.363
    z = unit(rng.normal(size=128))  # unrelated: ~0
    assert float(x @ y) > people.SAME_PERSON > float(x @ z)
    assert sorted(map(sorted, people.agglomerate(np.stack([x, y, z]), []))) == [[0, 1], [2]]


def test_existing_people_keep_members_and_never_merge():
    a = person(4, seed=1)
    # the user split one identity into two people: clustering respects that, new faces join one
    groups = people.agglomerate(a, [[0], [1]])
    assert groups[0][0] == 0 and groups[1][0] == 1 and len(groups) == 2
    assert sorted(groups[0] + groups[1]) == [0, 1, 2, 3]
    # an empty (named) person stays, with nobody
    assert people.agglomerate(a, [[], [0, 1]])[:2] == [[], [0, 1, 2, 3]]


def test_rejected_face_stays_out():
    a = person(4, seed=1)
    groups = people.agglomerate(a, [[0, 1, 2]], rejected={3: {0}})
    assert groups == [[0, 1, 2], [3]]
    # nor does a group it is part of
    b = np.concatenate([a, a[3:4]])
    groups = people.agglomerate(b, [[0, 1, 2]], rejected={3: {0}})
    assert groups[0] == [0, 1, 2] and sorted(groups[1]) == [3, 4]


# --------------------------------------------------------------------------- through the API

ANN, BOB = person(1, seed=11)[0], person(1, seed=12)[0]


def face(identity, x=0.2):
    return {"box": [x, 0.2, 0.2, 0.3], "score": 0.9, "emb": unit(identity + rng.normal(size=128) * 0.02)}


@pytest.fixture
def faces_on(monkeypatch):
    """People on, the model 'downloaded', no faces or people from earlier tests. Slides get the
    faces queued in the returned list, one entry per slide in import order."""
    store.save_config({**CONFIG, "people_enabled": True})
    lib = store.library()
    (lib / "people.json").unlink(missing_ok=True)
    for f in lib.glob("sessions/*/faces.json"):
        f.unlink()
    monkeypatch.setattr(people, "model_ready", lambda: True)
    # the background helper catches up on the open tray's faces: an earlier test's tray (its
    # faces.json just deleted) would take the queued faces
    monkeypatch.setattr(wf, "active_session", None)
    queue: list[list[dict]] = []
    monkeypatch.setattr(people, "embed_faces", lambda rgb: queue.pop(0) if queue else [])
    return queue


def tray_without_helper(api, tmp_path, monkeypatch):
    """A fresh tray, and the background helper kept off it (it would take the queued faces)."""
    out = new_tray(api, tmp_path / "scans")
    monkeypatch.setattr(wf, "active_session", None)
    return out


def test_people_across_a_tray(api, tmp_path, faces_on, immich_db, monkeypatch):
    # slides 1-4: Ann; Ann and Bob; Bob; nobody
    faces_on += [[face(ANN)], [face(ANN), face(BOB, 0.6)], [face(BOB)], []]
    sid, d = tray_without_helper(api, tmp_path, monkeypatch)
    gids = [g["id"] for g in d["groups"]]
    stored = people.load_faces(sid)
    assert [len(stored[g]["faces"]) for g in gids] == [1, 2, 1, 0]
    assert stored[gids[1]]["faces"][1]["id"] == f"{sid}/{gids[1]}/1"

    out = api.get("/api/people").json()
    assert out["enabled"] and out["model"] and not wf.faces_pending([sid])  # (other tests' trays wait)
    assert sorted(p["slides"] for p in out["people"]) == [2, 2]
    ann = next(p for p in out["people"] if f"{sid}/{gids[0]}/0" in [f["id"] for f in p["faces"]])
    bob = next(p for p in out["people"] if p is not ann)
    r = api.get(ann["faces"][0]["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"

    # name them; Bob's slides and Ann's go to Immich as People/<name> tags
    out = api.patch(f"/api/people/{ann['id']}", json={"name": "  Ann  Smith "}).json()
    assert out["people"][0]["name"] == "Ann Smith"
    api.patch(f"/api/people/{bob['id']}", json={"name": "Bob/Robert"})
    api.post(f"/api/sessions/{sid}/finish", json={})
    job = wait_job(api)
    assert "3 tagged with the people on them" in job["message"], job["message"]
    s = Session(sid)
    asset = {g["id"]: g["immich"]["asset_id"] for g in s.data["groups"]}
    tags = immich_db["tags"]
    assert tags["People/Ann Smith"]["assets"] == sorted([asset[gids[0]], asset[gids[1]]])
    assert tags["People/Bob-Robert"]["assets"] == sorted([asset[gids[1]], asset[gids[2]]])
    assert tags["People/Ann Smith"]["parentId"] == tags["People"]["id"]

    # a face that isn't Ann: out, and it doesn't come back to her
    wrong = f"{sid}/{gids[1]}/0"
    out = api.post(f"/api/people/{ann['id']}/remove", json={"faces": [wrong]}).json()
    ann_now = next(p for p in out["people"] if p["id"] == ann["id"])
    assert [f["id"] for f in ann_now["faces"]] == [f"{sid}/{gids[0]}/0"]
    alone = next(p for p in out["people"] if wrong in [f["id"] for f in p["faces"]])
    assert alone["id"] not in (ann["id"], bob["id"]) and alone["name"] == ""

    # naming it Ann after all joins it back: the name says it's the same person
    out = api.patch(f"/api/people/{alone['id']}", json={"name": "ann smith"}).json()
    named = [p for p in out["people"] if p["name"]]
    assert len(named) == 2 and sorted(len(p["faces"]) for p in named) == [2, 2]

    # merge: Bob is Ann (for the test's sake)
    out = api.post(f"/api/people/{ann['id']}/merge", json={"people": [bob["id"]]}).json()
    assert [(p["name"], len(p["faces"])) for p in out["people"]] == [("Ann Smith", 4)]
    assert api.patch("/api/people/nobody", json={"name": "x"}).status_code == 404


def test_turned_slide_finds_its_faces_again(api, tmp_path, faces_on, monkeypatch):
    faces_on += [[face(ANN)], [], [], []]
    sid, d = tray_without_helper(api, tmp_path, monkeypatch)
    gid = d["groups"][0]["id"]
    before = people.load_faces(sid)[gid]
    assert api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"rotation": 90}).status_code == 200
    assert wf.faces_pending([sid]) == [(sid, gid)]
    faces_on.append([face(ANN, 0.5), face(BOB)])  # found again (moved: the slide turned), and someone new
    assert wf.find_faces(sid, gid) and not wf.faces_pending([sid])
    after = people.load_faces(sid)[gid]
    assert after["rot"] == 90 and after["key"] != before["key"]
    assert [f["id"] for f in after["faces"]] == [before["faces"][0]["id"], f"{sid}/{gid}/1"]


def test_face_shows_the_slide_as_edited(api, tmp_path, faces_on, monkeypatch):
    """A person's picture is cut from the developed slide, and a new edit gives it a new URL."""
    faces_on += [[face(ANN)], [], [], []]
    sid, d = tray_without_helper(api, tmp_path, monkeypatch)
    gid = d["groups"][0]["id"]
    ann = next(p for p in api.get("/api/people").json()["people"] if p["faces"][0]["gid"] == gid)
    url = ann["cover"]
    before = api.get(url)
    assert before.headers["cache-control"] == "max-age=31536000"
    params = {**d["groups"][0]["params"], "brightness": 0.8}
    assert api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"params": params}).status_code == 200
    now = next(p for p in api.get("/api/people").json()["people"] if p["id"] == ann["id"])["cover"]
    assert now != url
    after = api.get(now)
    mean = lambda r: np.asarray(Image.open(io.BytesIO(r.content)), np.float32).mean() / 255
    brighter = mean(after) - mean(before)
    assert brighter > 0.05, brighter
    assert api.get(url).headers["cache-control"] == "no-store"  # the old URL isn't cached as the new look


def test_merged_slide_forgets_its_faces(api, tmp_path, faces_on, monkeypatch):
    faces_on += [[face(ANN)], [face(BOB)], [], []]
    sid, d = tray_without_helper(api, tmp_path, monkeypatch)
    g0, g1 = d["groups"][0]["id"], d["groups"][1]["id"]
    api.post(f"/api/sessions/{sid}/groups/{g0}/merge_next")
    faces_on.append([face(ANN)])
    assert wf.faces_pending([sid]) == [(sid, g0)]  # its scans changed
    assert g1 not in people.load_faces(sid)


def test_scan_job_and_old_immich(api, tmp_path, faces_on, immich_db, monkeypatch):
    store.save_config({**CONFIG, "people_enabled": False})
    sid, d = tray_without_helper(api, tmp_path, monkeypatch)  # imported with people off: no faces yet
    assert not people.load_faces(sid)
    assert api.post("/api/people/scan").status_code == 400  # not turned on
    store.save_config({**CONFIG, "people_enabled": True})
    assert api.get("/api/people").json()["pending"] >= 4
    faces_on += [[face(ANN)]] * 50
    assert api.post("/api/people/scan").json() == {"ok": True}
    assert "Looked for faces on" in wait_job(api)["message"]
    assert api.get("/api/people").json()["pending"] == 0
    out = api.get("/api/people").json()
    ann = next(p for p in out["people"] if any(f["id"].startswith(sid) for f in p["faces"]))
    api.patch(f"/api/people/{ann['id']}", json={"name": "Ann"})

    # a server without the tags API: uploads work, names are skipped
    monkeypatch.setattr(fake_immich, "TAGS", False)
    api.post(f"/api/sessions/{sid}/finish", json={})
    job = wait_job(api)
    assert "4 slides uploaded" in job["message"] and "tagged" not in job["message"]
    # and "send names" afterwards, once it has tags
    monkeypatch.setattr(fake_immich, "TAGS", True)
    immich_db["tags"] = {}
    assert api.post("/api/people/tag").json() == {"ok": True}
    assert "Tagged" in wait_job(api)["message"]  # (every uploaded tray: the scan saw Ann everywhere)
    mine = [g["immich"]["asset_id"] for g in Session(sid).data["groups"]]
    assert set(mine) <= set(immich_db["tags"]["People/Ann"]["assets"])


def test_model_download_is_checked(monkeypatch, tmp_path):
    """The model comes from the mirror, is checked against its SHA-256 and only then kept."""
    import contextlib

    import httpx

    body = b"not the model"

    @contextlib.contextmanager
    def stream(method, url, **kw):
        assert url == people.MODEL_URL
        yield httpx.Response(200, content=body, request=httpx.Request(method, url))

    monkeypatch.setattr(httpx, "stream", stream)
    monkeypatch.setattr(people, "model_file", lambda: tmp_path / "models" / people.MODEL_NAME)
    with pytest.raises(RuntimeError, match="checksum"):
        people.download_model()
    assert not people.model_file().exists() and not list((tmp_path / "models").iterdir())
    import hashlib

    monkeypatch.setattr(people, "MODEL_SHA256", hashlib.sha256(body).hexdigest())
    seen = []
    assert people.download_model(lambda done, total: seen.append(done)).read_bytes() == body
