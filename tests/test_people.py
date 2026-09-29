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


def test_nobody_twice_on_a_slide():
    a = person(4, seed=1)
    # faces 1 and 2 are on the same slide: however alike, they don't join, nor join a group holding the other
    groups = people.agglomerate(a, [], slides=["s0", "s1", "s1", "s2"])
    assert sorted(map(sorted, groups)) == [[0, 1, 3], [2]] or sorted(map(sorted, groups)) == [[0, 2, 3], [1]]
    # nor an existing person already on that slide
    groups = people.agglomerate(a, [[0, 1]], slides=["s0", "s1", "s1", "s2"])
    assert sorted(groups[0]) == [0, 1, 3] and groups[1:] == [[2]]


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

    # name them
    out = api.patch(f"/api/people/{ann['id']}", json={"name": "  Ann  Smith "}).json()
    assert out["people"][0]["name"] == "Ann Smith"
    api.patch(f"/api/people/{bob['id']}", json={"name": "Bob/Robert"})

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

    # a face that went back to someone it was taken out of (as a name from Immich once did it) leaves again
    d = people.load_people()
    assert wrong in d["people"][ann["id"]]["faces"] and wrong not in d["rejected"]  # (naming it Ann said so)
    d["rejected"][wrong] = [ann["id"]]
    people.save_people(d)
    out = people.refresh()["people"]
    assert wrong not in out[ann["id"]]["faces"]
    again = next(p for p, v in out.items() if wrong in v["faces"])
    api.patch(f"/api/people/{again}", json={"name": "Ann Smith"})

    # merge: Bob is Ann (for the test's sake); she can't be on slide 2 twice, so one face there drops out
    out = api.post(f"/api/people/{ann['id']}/merge", json={"people": [bob["id"]]}).json()
    assert [(p["name"], len(p["faces"])) for p in out["people"]] == [("Ann Smith", 3), ("", 1)]
    assert {f["id"].split("/")[1] for f in out["people"][0]["faces"]} == set(gids[:3])
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


CROWD = [person(1, seed=20 + i)[0] for i in range(3)]


def test_ignoring_a_crowd(api, tmp_path, faces_on, monkeypatch):
    # slide 1: Ann in a crowd of three; slide 2: Ann and one of the crowd again; slide 3: that one alone
    faces_on += [[face(ANN), face(CROWD[0], 0.4), face(CROWD[1], 0.6), face(CROWD[2], 0.8)],
                 [face(ANN), face(CROWD[0], 0.5)], [face(CROWD[0])], []]
    sid, d = tray_without_helper(api, tmp_path, monkeypatch)
    g0, g1, g2 = (g["id"] for g in d["groups"][:3])
    out = api.get("/api/people").json()
    ann = next(p for p in out["people"] if f"{sid}/{g0}/0" in [f["id"] for f in p["faces"]])
    api.patch(f"/api/people/{ann['id']}", json={"name": "Ann"})
    d = api.get(f"/api/sessions/{sid}").json()
    faces = d["groups"][0]["faces"]
    assert [f["label"] for f in faces][0] == "Ann" and len(faces) == 4

    # the slide's strangers, all at once: gone from this slide and from the others they're on
    d = api.post("/api/people/faces/ignore", json={"faces": [f["id"] for f in faces if not f["named"]]}).json()
    assert [f["label"] for f in d["groups"][0]["faces"]] == ["Ann"]
    assert [f["label"] for f in d["groups"][1]["faces"]] == ["Ann"]
    assert d["groups"][2]["faces"] == []
    out = api.get("/api/people").json()
    ignored = [p for p in out["people"] if p["ignored"]]
    assert len(ignored) == 3 and not next(p for p in out["people"] if p["id"] == ann["id"])["ignored"]
    assert ann["id"] not in [p["id"] for p in ignored]
    # nobody ignored is offered as who a face is, nor is anyone Ann is "often with"
    assert all(p["id"] not in {x["id"] for x in ignored}
               for p in api.get("/api/people/names").json()["people"])
    assert api.get(f"/api/people/{ann['id']}").json()["with"] == []
    stranger = next(p for p in ignored if len(p["faces"]) == 3)  # CROWD[0], on all three slides
    assert api.get(f"/api/people/{stranger['id']}").json()["ignored"]

    # changed my mind: back on the slides
    out = api.post("/api/people/ignore", json={"people": [stranger["id"]], "ignored": False}).json()
    assert sum(p["ignored"] for p in out["people"]) == 2
    d = api.get(f"/api/sessions/{sid}").json()
    assert len(d["groups"][0]["faces"]) == 2 and len(d["groups"][2]["faces"]) == 1

    # naming an ignored person, or merging them into someone who isn't, means they matter after all
    other = next(p for p in out["people"] if p["ignored"])
    out = api.patch(f"/api/people/{other['id']}", json={"name": "Carl"}).json()
    assert not next(p for p in out["people"] if p["id"] == other["id"])["ignored"]
    last = next(p for p in out["people"] if p["ignored"])
    out = api.post(f"/api/people/{ann['id']}/merge", json={"people": [last["id"]]}).json()
    assert not any(p["ignored"] for p in out["people"])
    assert api.post("/api/people/faces/ignore", json={"faces": []}).status_code == 400


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

    assert api.get("/api/people").json()["people"][0]["name"] == "Ann"


def test_sync_with_immich(api, tmp_path, faces_on, immich_db, monkeypatch):
    """Our people onto Immich's People page and Immich's names back, face by face."""
    # slides 1-4: Ann; Ann and Bob; Bob and Ann; Ann
    faces_on += [[face(ANN)], [face(ANN), face(BOB, 0.6)], [face(BOB, 0.6), face(ANN)], [face(ANN)]]
    sid, d = tray_without_helper(api, tmp_path, monkeypatch)
    gids = [g["id"] for g in d["groups"]]
    ann = next(p for p in api.get("/api/people").json()["people"] if p["faces"][0]["id"] == f"{sid}/{gids[0]}/0")
    api.patch(f"/api/people/{ann['id']}", json={"name": "Ann Smith"})
    api.post(f"/api/sessions/{sid}/finish", json={})
    wait_job(api)
    s = Session(sid)
    asset = [g["immich"]["asset_id"] for g in s.data["groups"]]
    # where our faces are on the uploaded slides, and Immich's own faces there (a little off, as its detector is)
    at = {fid: [v + 0.01 for v in box] for g in s.data["groups"] for fid, box in wf.uploaded_faces(s, g)}
    face_of = lambda i, n: at[f"{sid}/{gids[i]}/{n}"]  # noqa: E731
    fi = fake_immich
    same_name = fi.add_person("ann smith")  # typed in Immich, in other letters
    lumped = fi.add_person()  # Immich's unnamed group of Ann, on two slides
    robert = fi.add_person("Robert", "1950-02-03")
    fi.add_face(asset[0], face_of(0, 0), lumped)
    fi.add_face(asset[1], face_of(1, 0), lumped)
    fi.add_face(asset[1], face_of(1, 1), robert)
    fi.add_face(asset[2], face_of(2, 0), robert)  # (Ann on slide 3: Immich didn't find her)
    loose = fi.add_face(asset[3], face_of(3, 0))  # found, not grouped
    elsewhere = fi.add_face(fi.add_asset(b"another photo"), [0.1, 0.1, 0.3, 0.3], lumped)  # not a slide
    # names as tags, as earlier versions sent them
    fi.DB["tags"]["People/Ann Smith"] = {"id": "t-ann", "name": "Ann Smith", "value": "People/Ann Smith",
                                         "parentId": "t-people", "assets": [asset[0], asset[1]]}
    fi.DB["tags"]["People"] = {"id": "t-people", "name": "People", "value": "People", "parentId": None, "assets": []}

    assert api.post("/api/people/sync").json() == {"ok": True}
    msg = wait_job(api)["message"]
    assert "named 1 here from Immich (Robert)" in msg and "1 unnamed Immich people merged in" in msg, msg
    assert "2 faces given their names (1 Immich hadn't found)" in msg and "the People tags taken off" in msg, msg
    assert "1 birthdays shared" in msg and "left alone" not in msg, msg
    ppl, faces = fi.DB["people"], fi.DB["faces"]
    assert sorted((p["name"], p["birthDate"]) for p in ppl.values()) == [("Robert", "1950-02-03"), ("ann smith", None)]
    on_ann = [f for f in faces.values() if f["personId"] == same_name]
    assert sorted(f["assetId"] for f in on_ann if f["assetId"] in asset) == sorted([asset[0], asset[1], asset[2], asset[3]])
    assert faces[loose]["personId"] == same_name and faces[elsewhere]["personId"] == same_name  # merged whole
    manual = next(f for f in on_ann if f["sourceType"] == "manual")
    assert manual["assetId"] == asset[2] and people_named(api) == {"Ann Smith": 4, "Robert": 2}
    assert not [t for t in fi.DB["tags"] if t.startswith("People")]
    bob = next(p for p in people.load_people()["people"].values() if p["name"] == "Robert")
    assert bob["birthday"] == "1950-02-03" and bob["immich"] == {"id": robert, "name": "Robert"}

    # again: nothing to do
    api.post("/api/people/sync")
    assert wait_job(api)["message"] == "People in Immich are up to date"

    # Immich's detection finds the face added by hand after all: that face takes over, the double goes
    found = fi.add_face(asset[2], [v - 0.005 for v in face_of(2, 1)])
    # renamed here: Immich follows; renamed there: we follow
    api.patch(f"/api/people/{ann['id']}", json={"name": "Ann Jones"})
    ppl[robert]["name"] = "Bob"
    api.post("/api/people/sync")
    msg = wait_job(api)["message"]
    assert "named 1 here from Immich (Bob)" in msg and "1 doubled faces removed" in msg, msg
    assert manual["id"] not in faces and faces[found]["personId"] == same_name
    assert ppl[same_name]["name"] == "Ann Jones" and people_named(api) == {"Ann Jones": 4, "Bob": 2}

    # renamed on both sides: left alone and listed
    api.patch(f"/api/people/{ann['id']}", json={"name": "Annie"})
    ppl[same_name]["name"] = "Anna"
    api.post("/api/people/sync")
    assert "Named differently in Immich, left alone: Annie is Anna there" in wait_job(api)["message"]
    assert ppl[same_name]["name"] == "Anna" and "Annie" in people_named(api)


def test_sync_keeps_what_the_user_said(api, tmp_path, faces_on, immich_db, monkeypatch):
    """Immich recognising someone doesn't undo a face taken off them here, nor put them on a slide twice."""
    # slides 1-4: Ann, on slide 2 with someone Immich takes for her too
    faces_on += [[face(ANN)], [face(ANN), face(BOB, 0.6)], [face(ANN)], [face(ANN)]]
    sid, d = tray_without_helper(api, tmp_path, monkeypatch)
    gids = [g["id"] for g in d["groups"]]
    ann = next(p for p in api.get("/api/people").json()["people"] if p["faces"][0]["id"] == f"{sid}/{gids[0]}/0")
    api.patch(f"/api/people/{ann['id']}", json={"name": "Ann Smith"})
    api.post(f"/api/sessions/{sid}/finish", json={})
    wait_job(api)
    s = Session(sid)
    asset = [g["immich"]["asset_id"] for g in s.data["groups"]]
    at = {fid: [v + 0.01 for v in box] for g in s.data["groups"] for fid, box in wf.uploaded_faces(s, g)}
    fi = fake_immich
    immich_ann = fi.add_person("Ann Smith")
    for i in range(4):
        fi.add_face(asset[i], at[f"{sid}/{gids[i]}/0"], immich_ann)
    other = fi.add_face(asset[1], at[f"{sid}/{gids[1]}/1"], immich_ann)  # Ann twice on slide 2
    api.post("/api/people/sync")
    msg = wait_job(api)["message"]
    assert "1 faces taken off people they aren't" in msg and "left alone" not in msg, msg
    faces = fi.DB["faces"]
    assert faces[other]["personId"] not in (immich_ann, None)

    # slides 3 and 4 aren't Ann after all: they stay off her, here and in Immich
    wrong = [f"{sid}/{gids[i]}/0" for i in (2, 3)]
    api.post(f"/api/people/{ann['id']}/remove", json={"faces": wrong})
    api.post("/api/people/sync")
    msg = wait_job(api)["message"]
    assert "named" not in msg and "2 faces taken off people they aren't" in msg, msg
    assert people_named(api) == {"Ann Smith": 2}
    on_ann = sorted(f["assetId"] for f in faces.values() if f["personId"] == immich_ann)
    assert on_ann == sorted([asset[0], asset[1]])
    api.post("/api/people/sync")
    assert wait_job(api)["message"] == "People in Immich are up to date"


def people_named(api) -> dict[str, int]:
    return {p["name"]: len(p["faces"]) for p in api.get("/api/people").json()["people"] if p["name"]}


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


# --------------------------------------------------------------------------- clothes, naming nearby, marking


def test_clothes_tell_outfits_apart():
    """The chest below a face: the same shirt on another slide (lit a little differently, the person
    moved) is alike, another colour isn't; no room below the face, no description."""
    def slide(shirt, x=0.4, light=1.0):
        a = np.full((300, 400, 3), 0.55, np.float32)  # a grey wall
        a[60:120, int(x * 400):int(x * 400) + 50] = (0.8, 0.6, 0.5)  # the face
        a[130:300, int(x * 400) - 50:int(x * 400) + 100] = shirt
        return np.clip(a * light, 0, 1)

    box = lambda x: [x, 0.2, 0.125, 0.2]  # noqa: E731
    red = people.describe_clothes(slide((0.7, 0.1, 0.1)), box(0.4))
    red2 = people.describe_clothes(slide((0.7, 0.1, 0.1), 0.45, 0.9), box(0.45))
    blue = people.describe_clothes(slide((0.1, 0.2, 0.7)), box(0.4))
    assert red.shape == (int(np.prod(people.CLOTHES_BINS)),) and red.sum() == pytest.approx(1)
    assert people.clothes_like(red, red2) >= people.SAME_CLOTHES > people.clothes_like(red, blue)
    assert people.describe_clothes(slide((0.7, 0.1, 0.1)), [0.4, 0.9, 0.1, 0.1]) is None
    assert people.clothes_like(red, None) is None


def like(identity, cos, seed):
    """A face `cos` like `identity` (another photo of them, bad light, the years between)."""
    r = np.random.default_rng(seed).normal(size=128)
    r -= (r @ identity) * identity
    return unit(cos * identity + np.sqrt(1 - cos * cos) * unit(r))


RED, BLUE = np.eye(int(np.prod(people.CLOTHES_BINS)), dtype=np.float32)[[3, 40]]


@pytest.fixture
def dressed(faces_on, monkeypatch):
    """Faces with their clothes chosen by the test: by the face box's top (y) - 0.2 red, 0.25 blue."""
    monkeypatch.setattr(people, "describe_clothes", lambda rgb, box: {0.2: RED, 0.25: BLUE}.get(round(box[1], 2)))
    return faces_on


def shirt(identity, colour, x=0.2):
    f = face(identity, x)
    f["box"][1] = {"red": 0.2, "blue": 0.25}[colour]
    return f


def test_a_name_spreads_to_the_same_person_nearby(api, tmp_path, dressed, monkeypatch):
    """Slides 1-4: Ann in red; a blurry Ann (a little like her) in red; the same blurry face in
    blue; Bob. Named on slide 1, she's recognised on slide 2 (her, in the same clothes), not on 3
    (maybe her, another day) nor Bob; and the picker on slide 3 offers Ann first."""
    blurry = [{**shirt(ANN, "red"), "emb": like(ANN, 0.3, 1)}, {**shirt(ANN, "blue"), "emb": like(ANN, 0.3, 2)}]
    dressed += [[shirt(ANN, "red")], [blurry[0]], [blurry[1]], [shirt(BOB, "red")]]
    sid, d = tray_without_helper(api, tmp_path, monkeypatch)
    api.get("/api/people")  # (grouped)
    gs = api.get(f"/api/sessions/{sid}").json()["groups"]
    assert len({g["faces"][0]["person"] for g in gs}) == 4  # not alike enough to group by face alone

    out = api.post("/api/people/faces/assign", json={"face": gs[0]["faces"][0]["id"], "person": "new", "name": "Ann"}).json()
    got = [g["faces"][0]["label"] for g in out["groups"]]
    assert got[:2] == ["Ann", "Ann"] and "Ann" not in got[2:] and out["named_along"] == 1
    # the one named along isn't "sure": "not Ann" still works on it, and it stays out
    f2 = out["groups"][1]["faces"][0]["id"]
    assert f2 not in people.load_people()["people"][out["groups"][0]["faces"][0]["person"]].get("sure", [])

    api.patch(f"/api/people/{gs[3]['faces'][0]['person']}", json={"name": "Bob"})
    names = api.get("/api/people/names", params={"face": gs[2]["faces"][0]["id"]}).json()["people"]
    assert [p["label"] for p in names] == ["Ann", "Bob"] and names[0]["score"] > names[1]["score"]
    # Ann's face on slide 1 is surely her; Bob, on a slide nearby in red too, isn't
    names = api.get("/api/people/names", params={"face": gs[0]["faces"][0]["id"]}).json()["people"]
    assert [(p["label"], p["likely"]) for p in names] == [("Ann", True), ("Bob", False)]
    # without a face: by name, as before
    assert [p["label"] for p in api.get("/api/people/names").json()["people"]] == ["Ann", "Bob"]


def test_naming_a_face_brings_its_unnamed_group(api, tmp_path, dressed, monkeypatch):
    """Ann on slide 1 of one tray and slide 4 of another: grouped as one unnamed person. Naming the
    face on the first names the other (it looks like her), but not a face of hers taken out before."""
    dressed += [[face(ANN)], [], [], []]
    sid, _ = tray_without_helper(api, tmp_path, monkeypatch)
    dressed += [[], [], [], [face(ANN)]]
    sid2, _ = tray_without_helper(api, tmp_path, monkeypatch)
    api.get("/api/people")
    g1 = api.get(f"/api/sessions/{sid}").json()["groups"][0]["faces"][0]
    g2 = api.get(f"/api/sessions/{sid2}").json()["groups"][3]["faces"][0]
    assert g1["person"] == g2["person"] and not g1["named"]
    out = api.post("/api/people/faces/assign", json={"face": g1["id"], "person": "new", "name": "Ann"}).json()
    assert out["named_along"] == 1
    assert api.get(f"/api/sessions/{sid2}").json()["groups"][3]["faces"][0]["label"] == "Ann"


def test_mark_someone_the_finder_missed(api, tmp_path, dressed, monkeypatch):
    """Slide 1: someone with their back turned (no face found), in red; slide 2: a face in red. Marked
    on slide 1 as Cleo, the face next to it in the same clothes is her too. The mark stays when the
    slide is turned, and can be taken off."""
    dressed += [[], [shirt(BOB, "red")], [], []]
    sid, d = tray_without_helper(api, tmp_path, monkeypatch)
    gid = d["groups"][0]["id"]
    # the box around the spot clicked: 8 % of the (landscape) slide's height, from y 0.2 (the red shirt)
    out = api.post(f"/api/sessions/{sid}/groups/{gid}/faces",
                   json={"point": [0.5, 0.24], "person": "new", "name": "Cleo"}).json()
    mine = out["groups"][0]["faces"]
    assert [(f["id"], f["label"], f["manual"]) for f in mine] == [(out["face"], "Cleo", True)] and mine[0]["box"]
    assert out["groups"][1]["faces"][0]["label"] == "Cleo" and out["named_along"] == 1
    assert api.post(f"/api/sessions/{sid}/groups/{gid}/faces", json={"point": [2, 0]}).status_code == 400

    # turned: looked at again, nobody found - the mark stays, turned with the slide
    before = people.load_faces(sid)[gid]["faces"][0]["box"]
    api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"rotation": 90})
    assert wf.find_faces(sid, gid)
    [f] = people.load_faces(sid)[gid]["faces"]
    assert f["id"] == out["face"] and f["manual"]
    assert f["box"] == pytest.approx([1 - before[1] - before[3], before[0], before[3], before[2]], abs=1e-3)
    assert api.get(f"/api/sessions/{sid}").json()["groups"][0]["faces"][0]["label"] == "Cleo"

    # a face the finder found can't be taken off (it would come back); the mark can
    other = out["groups"][1]["faces"][0]["id"]
    assert api.delete(f"/api/people/faces/{other}").status_code == 404
    out = api.delete(f"/api/people/faces/{f['id']}").json()
    assert out["groups"][0].get("faces") == [] and out["groups"][1]["faces"][0]["label"] == "Cleo"


def test_a_missed_face_is_looked_for_closer(monkeypatch):
    """Around the spot clicked, the picture is looked at zoomed in: a face found there comes back
    where it is on the whole picture (size and landmarks too); a face elsewhere in the crop doesn't."""
    from slidestation import imaging

    rgb = np.random.default_rng(1).random((600, 900, 3)).astype(np.float32)

    def detect(bgr):  # a face in the middle of whatever it's shown, and one in its corner
        h, w = bgr.shape[:2]
        rows = []
        for x, y in ((0.4 * w, 0.4 * h), (0.0, 0.0)):
            s = 0.2 * w
            rows.append([x, y, s, s] + [x + 0.5 * s, y + 0.5 * s] * 5 + [0.65])
        return np.array(rows, np.float32)

    class Recognizer:
        def alignCrop(self, bgr, f):
            seen.append(f)
            return bgr

        def feature(self, crop):
            return np.ones((1, 128), np.float32)

    seen = []
    monkeypatch.setattr(imaging, "_faces_in", detect)
    monkeypatch.setattr(people, "_recognizer", Recognizer())
    got = people.find_near(rgb, [0.2, 0.3])
    x, y, w, h = got["box"]
    assert (x + w / 2, y + h / 2) == (pytest.approx(0.2, abs=0.002), pytest.approx(0.3, abs=0.002))
    assert w * 900 == pytest.approx(0.2 * 480 / (480 / (0.18 * 600)), rel=0.02)  # the smallest crop's face
    assert seen[0][4] == pytest.approx(0.2 * 900, abs=1) and got["score"] == 0.65
    assert np.linalg.norm(got["emb"]) == pytest.approx(1)
    monkeypatch.setattr(imaging, "_faces_in", lambda bgr: np.zeros((0, 15), np.float32))
    assert people.find_near(rgb, [0.2, 0.3]) is None
