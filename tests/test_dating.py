"""Dates from people (dating.py): birthdays, the ages faces look, the calibration on dated slides,
the date suggestion, and People & Places (the atlas). The face and age models are stood in for
(people.embed_faces / estimate_ages monkeypatched: no model, no network)."""
from __future__ import annotations

import math

import numpy as np

import pytest
from conftest import CONFIG, new_tray
from test_people import ANN, BOB, face

from slidestation import dating, people, store
from slidestation import workflow as wf

# --------------------------------------------------------------------------- the maths


def test_calibration_starts_neutral_and_learns():
    cal = dating.calibrate([])
    assert cal["bias"] == 0 and cal["sigma"] == pytest.approx(dating.PRIOR_SIGMA) and cal["n"] == 0
    assert dating.corrected(30, "p1", cal) == (pytest.approx(30), pytest.approx(0.2 * 31))
    # the model sees everyone ~15 % older: the bias pulls its guesses down, the spread narrows
    s = [(f"p{i}", real * 1.15 + 1.1, real) for i, real in enumerate((20, 30, 40, 50, 25, 35, 45, 28, 33, 38))]
    cal = dating.calibrate(s)
    assert cal["bias"] < -0.1 and cal["sigma"] < dating.PRIOR_SIGMA
    assert 30 < dating.corrected(40, "p20", cal)[0] < 36
    # one person on many slides who looks twice their age is their own habit, not everyone's
    kid = dating.calibrate([("p30", 2 * real + 1, real) for real in (6, 7, 8, 9, 7, 8, 9, 8)] + s[:2])
    assert dating.corrected(18, "p30", kid)[0] < 12 and dating.corrected(30, "p20", kid)[0] > 26
    # a person with slides of their own gets a correction of their own, shrunk towards the rest
    cal = dating.calibrate(s + [("p9", 40.0, 30.0)] * 6)
    assert cal["people"]["p9"] < cal["people"]["p1"]
    # one wild sample (a mask, a misnamed face) moves neither the correction nor the spread much
    wild = dating.calibrate(s + [("p9", 5.0, 60.0)])
    assert wild["bias"] == pytest.approx(dating.calibrate(s)["bias"], abs=0.02) and wild["sigma"] < dating.PRIOR_SIGMA
    # a tray's date teaches at the weight given
    half = dating.calibrate([(p, g, r, 0.5) for p, g, r in s])
    assert dating.calibrate(s)["bias"] < half["bias"] < 0
    # small children: known to about half a year, never less
    assert dating.corrected(0.5, "p1", dating.calibrate([]))[1] == dating.MIN_SD


def test_combine_and_span():
    y, sd = dating._combine([(1980.0, 1.0), (1984.0, 2.0)])
    assert y == pytest.approx(1980.8) and sd == pytest.approx(math.sqrt(1 / 1.25))
    assert dating._span("1978") == (pytest.approx(1978.5), pytest.approx(1 / math.sqrt(12)))
    assert dating._span("1978-07")[0] == pytest.approx(1978 + 181 / 365 + 1 / 24, abs=0.01)
    assert dating._span("") is None


def test_birthdays_are_validated():
    assert people.clean_birthday(" 1952/03/14 ") == "1952-03-14"
    assert people.clean_birthday("1952") == "1952" and people.clean_birthday("") == ""
    for junk in ("soon", "1700", "52"):
        with pytest.raises(ValueError):
            people.clean_birthday(junk)


# --------------------------------------------------------------------------- through the API


@pytest.fixture
def aged(monkeypatch):
    """People and ages on, both models 'downloaded', nothing left from earlier tests. Returns
    (faces, ages): per slide in import order, the faces found and the ages they look."""
    store.save_config({**CONFIG, "people_enabled": True, "ages_enabled": True})
    lib = store.library()
    (lib / "people.json").unlink(missing_ok=True)
    for f in lib.glob("sessions/*/faces.json"):
        f.unlink()
    monkeypatch.setattr(people, "model_ready", lambda: True)
    monkeypatch.setattr(people, "age_ready", lambda: True)
    monkeypatch.setattr(wf, "active_session", None)
    faces: list[list[dict]] = []
    ages: list[list[float]] = []
    monkeypatch.setattr(people, "embed_faces", lambda rgb: faces.pop(0) if faces else [])
    monkeypatch.setattr(people, "estimate_ages", lambda rgb, boxes: ages.pop(0)[:len(boxes)] if ages and boxes else [])
    return faces, ages


def _who(out: dict, sid: str, gid: str) -> dict:
    return next(p for p in out["people"] if any(f["sid"] == sid and f["gid"] == gid for f in p["faces"]))


def test_people_date_a_tray(api, tmp_path, aged, monkeypatch):
    faces, ages = aged
    # 1: Ann (looks 30), dated 1980 by hand; 2: Ann looks 34; 3: Bob, a child who looks 7; 4: nobody
    faces += [[face(ANN)], [face(ANN)], [face(BOB)], []]
    ages += [[30.0], [34.0], [7.0]]
    sid, d = new_tray(api, tmp_path / "scans", slides=4)
    monkeypatch.setattr(wf, "active_session", None)
    gids = [g["id"] for g in d["groups"]]
    assert [f.get("age") for g in gids for f in people.load_faces(sid)[g]["faces"]] == [30.0, 34.0, 7.0]

    out = api.get("/api/people").json()
    assert out["ages"]["enabled"] and out["ages"]["model"] and out["ages"]["calibrated"] == 0
    ann, bob = _who(out, sid, gids[0]), _who(out, sid, gids[2])
    assert ann["ages"] == [30, 34] and ann["faces"][0]["age"] == 30

    # no birthdays yet, but slide 1 is dated: Ann looks 30 there, so she was born around 1950 and
    # looking 34 says slide 2 is from around 1984 - vague (± 7 y), so the dated neighbour's 1980 weighs more
    d = api.patch(f"/api/sessions/{sid}/groups/{gids[0]}", json={"date": "1980"}).json()
    g2 = d["groups"][1]
    assert 1980 < g2["people_year"][0] < 1982 and g2["people_year"][1] < 2
    assert g2["people"] == [] and g2["born_floor"] is None  # an implied birth year is no floor

    assert api.patch(f"/api/people/{ann['id']}", json={"birthday": "someday"}).status_code == 400
    api.patch(f"/api/people/{ann['id']}", json={"name": "Ann", "birthday": "1950"})
    out = api.patch(f"/api/people/{bob['id']}", json={"birthday": "1976-05-02"}).json()
    assert _who(out, sid, gids[2])["birthday"] == "1976-05-02"
    assert _who(out, sid, gids[0])["name"] == "Ann"
    # slide 1 (Ann really 30, looked 30) calibrates: no correction
    assert out["ages"]["calibrated"] == 1 and out["ages"]["bias"] == 0

    d = api.get(f"/api/sessions/{sid}").json()
    g1, g2, g3, g4 = d["groups"]
    assert [p["name"] for p in g1["people"]] == ["Ann"] and g1["people"][0]["age"] == 30
    assert g3["people"] == [{"id": bob["id"], "name": "", "age": 7}] and g3["born_floor"] == 1976
    assert g4["people"] == [] and g4["born_floor"] is None
    # slide 3: Bob at 7 says ~1983.8; the dated slide two back says 1980: they meet around 1982
    year, sd = g3["people_year"]
    assert 1981 < year < 1984 and sd < 2
    sug = g3["insights"]["date"]
    assert sug["source"] == "people" and sug["state"] == "suggested" and sug["value"] == str(int(year))
    assert "≈ 7" in sug["text"] and 0.3 <= sug["confidence"] <= 0.9
    assert g3["date_est"]["value"] == "1980"  # a suggestion only: what goes to Immich is unchanged
    # slide 4 has nobody but sits next to Bob's slide: it gets a (vaguer) year from him too
    assert g4["people_year"] is not None and g4["people_year"][1] > sd

    # accepting it dates the slide; that date doesn't teach the calibration (it's its own guess)
    d = api.post(f"/api/sessions/{sid}/insights/decide",
                 json={"kind": "date", "action": "accept", "groups": [gids[2]]}).json()
    assert d["decided"] == 1 and d["groups"][2]["date"] == sug["value"]
    assert api.get("/api/people").json()["ages"]["calibrated"] == 1
    # dated by hand it does
    api.patch(f"/api/sessions/{sid}/groups/{gids[2]}", json={"date": "1983-06"})
    assert api.get("/api/people").json()["ages"]["calibrated"] == 2


def test_nobody_before_their_birth(api, tmp_path, aged, monkeypatch):
    faces, ages = aged
    faces += [[face(BOB)], []]
    ages += [[1.0]]
    sid, d = new_tray(api, tmp_path / "scans", slides=2)
    monkeypatch.setattr(wf, "active_session", None)
    gid = d["groups"][0]["id"]
    bob = _who(api.get("/api/people").json(), sid, gid)
    api.patch(f"/api/people/{bob['id']}", json={"birthday": "1990-12-20"})
    api.patch(f"/api/sessions/{sid}/groups/{d['groups'][1]['id']}", json={"date": "1985"})  # a wrong neighbour
    g = api.get(f"/api/sessions/{sid}").json()["groups"][0]
    assert g["born_floor"] == 1990 and int(g["insights"]["date"]["value"]) >= 1990


def test_a_vague_face_leaves_the_trays_date(api, tmp_path, aged, monkeypatch):
    """The tray says 1977; Ann (born 1946) looks 20 (≈ 1970 ± 8 even after the tray taught the ages
    a little): that agrees with 1977 and knows less, so it offers nothing - but a child's face, as
    sure as a year, still does."""
    faces, ages = aged
    faces += [[face(ANN)], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [],
              [], [], [], [], [face(BOB)]]
    ages += [[20.0], [1.0]]
    sid, d = new_tray(api, tmp_path / "scans", slides=27)
    monkeypatch.setattr(wf, "active_session", None)
    out = api.get("/api/people").json()
    ann, bob = (_who(out, sid, d["groups"][i]["id"]) for i in (0, 26))
    api.patch(f"/api/people/{ann['id']}", json={"birthday": "1946-06-23"})
    api.patch(f"/api/people/{bob['id']}", json={"birthday": "1974-03-01"})
    api.patch(f"/api/sessions/{sid}", json={"date": "1977"})
    gs = api.get(f"/api/sessions/{sid}").json()["groups"]
    assert (gs[0]["insights"].get("date") or {}).get("source") != "people"
    assert gs[0]["date_est"]["value"] == "1977"
    assert gs[26]["insights"]["date"]["source"] == "people" and gs[26]["insights"]["date"]["value"] in ("1975", "1976")


def test_a_trays_date_teaches_the_ages(api, tmp_path, aged, monkeypatch):
    """Nothing dated by hand, but the tray says 1977: Tom (born 1968, so about 8) 'looks' 15-20 on
    its slides - the model sees him twice his age. The tray's date corrects that: he's about 8 on
    them again, so they aren't dated to the mid-1980s."""
    faces, ages = aged
    faces += [[face(ANN)] for _ in range(10)]
    ages += [[a] for a in (15.0, 16.0, 17.0, 20.0, 18.0, 15.0, 19.0, 16.0, 17.0, 18.0)]
    sid, d = new_tray(api, tmp_path / "scans", slides=10)
    monkeypatch.setattr(wf, "active_session", None)
    tom = _who(api.get("/api/people").json(), sid, d["groups"][0]["id"])["id"]
    api.patch(f"/api/people/{tom}", json={"name": "Tom", "birthday": "1968-11-25"})
    gs = api.get(f"/api/sessions/{sid}").json()["groups"]
    assert all(g["faces"][0]["age"] >= 15 for g in gs) and gs[0]["insights"]["date"]["value"] >= "1983"
    api.patch(f"/api/sessions/{sid}", json={"date": "1977"})
    assert api.get("/api/people").json()["ages"]["calibrated"] == 10
    gs = api.get(f"/api/sessions/{sid}").json()["groups"]
    assert all(g["faces"][0]["age"] <= 13 for g in gs), [g["faces"][0]["age"] for g in gs]
    assert all(abs(g["people_year"][0] - 1977.5) < 3 for g in gs)


def test_a_misnamed_face_is_caught(api, tmp_path, aged, monkeypatch):
    """A tray labelled 1977: Tom (born 1968) looks 8-9 on slides 1-2 and 30 on slide 3, and someone
    else, merged into Tom by mistake, looks 37 on slide 4. That face is far from Tom's age then and
    unlike his other faces: flagged, and it dates nothing. Slide 3's face is far off too but *is*
    like Tom's: that's a slide from later in a mixed tray, it keeps dating the slide - until the
    slide is dated 1977 by hand. Then the slide view corrects who is who."""
    faces, ages = aged
    faces += [[face(ANN)], [face(ANN)], [face(ANN)], [face(BOB)], []]
    ages += [[8.0], [9.0], [30.0], [37.0]]
    sid, d = new_tray(api, tmp_path / "scans", slides=5)
    monkeypatch.setattr(wf, "active_session", None)
    gids = [g["id"] for g in d["groups"]]
    out = api.get("/api/people").json()
    tom, other = _who(out, sid, gids[0])["id"], _who(out, sid, gids[3])["id"]
    api.patch(f"/api/people/{tom}", json={"name": "Tom", "birthday": "1968-11-25"})
    api.patch(f"/api/people/{other}", json={"name": "Tom"})  # the mistake: merges into Tom
    api.patch(f"/api/sessions/{sid}", json={"date": "1977"})

    gs = api.get(f"/api/sessions/{sid}").json()["groups"]
    [f3], [f4] = gs[2]["faces"], gs[3]["faces"]
    assert f4["person"] == tom and f4["label"] == "Tom" and f4["named"] and f4["age"] > 20
    assert f4["odd"] == {"age": 9, "year": 1977} and f4["box"] and f4["url"].startswith(f"/api/people/faces/{sid}/")
    assert gs[3]["people"] == [{"id": tom, "name": "Tom", "age": None}]  # its age isn't Tom's
    assert "≈ 37" not in (gs[3]["insights"].get("date") or {}).get("text", "")  # (its neighbour's Tom may date it)
    assert f3["odd"] is None and 1995 <= int(gs[2]["insights"]["date"]["value"]) <= 2000
    assert gs[0]["faces"][0]["odd"] is None and gs[4].get("faces") == []
    page = {s["gid"]: s for s in api.get(f"/api/people/{tom}").json()["slides"]}
    assert page[gids[3]]["odd"] == {"age": 9, "year": 1977} and page[gids[0]]["odd"] is None

    api.patch(f"/api/sessions/{sid}/groups/{gids[2]}", json={"date": "1977"})
    gs = api.get(f"/api/sessions/{sid}").json()["groups"]
    assert gs[2]["faces"][0]["odd"] == {"age": 9, "year": 1977}  # dated by hand: 30 isn't Tom then

    names = api.get("/api/people/names").json()["people"]
    assert [(p["id"], p["label"]) for p in names] == [(tom, "Tom")] and names[0]["cover"]
    # "it is Tom" on the marked face: the name stays, the age was wrong - it dates nothing any more
    d = api.post("/api/people/faces/assign", json={"face": f4["id"], "person": tom}).json()
    f = d["groups"][3]["faces"][0]
    assert f["person"] == tom and f["odd"] is None and f["age"] is None
    assert people.load_people()["ages_off"] == [f4["id"]]
    assert d["groups"][3]["people"] == [{"id": tom, "name": "Tom", "age": None}]
    # "not Tom": the face leaves him (and stays out), someone of its own
    d = api.post("/api/people/faces/assign", json={"face": f4["id"], "person": None}).json()
    f = d["groups"][3]["faces"][0]
    assert f["person"] not in (None, tom) and f["odd"] is None and not f["named"]
    assert tom in people.load_people()["rejected"][f4["id"]] and people.load_people()["ages_off"] == []
    # someone new with a name, and the same name again is them
    d = api.post("/api/people/faces/assign", json={"face": f4["id"], "person": "new", "name": "Bob"}).json()
    bob = d["groups"][3]["faces"][0]["person"]
    assert d["groups"][3]["faces"][0]["label"] == "Bob"
    d = api.post("/api/people/faces/assign", json={"face": f3["id"], "person": "new", "name": " bob "}).json()
    assert d["groups"][2]["faces"][0]["person"] == bob
    # put with Tom from the picker: his for good - never doubted again, no longer rejected (its age
    # counts: it was Bob's, not a face marked as not fitting Tom)
    d = api.post("/api/people/faces/assign", json={"face": f4["id"], "person": tom}).json()
    f = d["groups"][3]["faces"][0]
    assert f["person"] == tom and f["odd"] is None and f["age"] > 30
    pd = people.load_people()
    assert f4["id"] in pd["people"][tom]["sure"] and pd["rejected"][f4["id"]] == [bob]  # not Bob, now
    assert api.post("/api/people/faces/assign", json={"face": f4["id"], "person": "p999"}).status_code == 404


def test_ages_added_to_faces_found_before(api, tmp_path, aged, monkeypatch):
    faces, ages = aged
    store.save_config({**CONFIG, "people_enabled": True})  # ages off while importing
    faces += [[face(ANN), face(BOB, 0.6)]]
    sid, d = new_tray(api, tmp_path / "scans", slides=1)
    gid = d["groups"][0]["id"]
    assert all("age" not in f for f in people.load_faces(sid)[gid]["faces"])
    assert not wf.faces_pending([sid])

    store.save_config({**CONFIG, "people_enabled": True, "ages_enabled": True})
    assert wf.faces_pending([sid]) == [(sid, gid)]
    ids = [f["id"] for f in people.load_faces(sid)[gid]["faces"]]
    ages += [[41.0, 12.0]]
    assert wf.find_faces(sid, gid)
    stored = people.load_faces(sid)[gid]["faces"]
    assert [f["id"] for f in stored] == ids and [f["age"] for f in stored] == [41.0, 12.0]
    assert not wf.faces_pending([sid])

    # aged by a model since replaced: every face is aged again, ids untouched
    people.update_faces(sid, lambda d: d[gid].update(ages_by="vit-utkface"))
    assert wf.faces_pending([sid]) == [(sid, gid)]
    ages += [[38.0, 9.0]]
    assert wf.find_faces(sid, gid)
    entry = people.load_faces(sid)[gid]
    assert [f["id"] for f in entry["faces"]] == ids and [f["age"] for f in entry["faces"]] == [38.0, 9.0]
    assert entry["ages_by"] == people.AGE_BY and not wf.faces_pending([sid])


def test_age_input():
    """MiVOLO's input: the face and the body below it, each letterboxed to 384 px, stacked."""
    rgb = np.zeros((400, 600, 3), np.float32)
    rgb[100:140, 300:330] = 1.0  # the face: 30 x 40 px at (300, 100)
    face, body = people.age_crops(rgb, [0.5, 0.25, 0.05, 0.1])
    assert face.shape == (40, 30, 3) and face.min() == 1.0
    assert body.shape == (272, 90, 3)  # 3 faces wide, from 0.3 faces above to 6.5 below
    x = people.age_input(rgb, [0.5, 0.25, 0.05, 0.1])
    assert x.shape == (6, 384, 384) and x.dtype == np.float32
    white = (1 - np.array([0.485, 0.456, 0.406])) / [0.229, 0.224, 0.225]
    black = -np.array([0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    # the face fills the height, centred, black on both sides
    assert np.allclose(x[:3, 192, 192], white, atol=1e-3) and np.allclose(x[:3, 192, 5], black, atol=1e-3)
    # near the picture's edge the body is clipped, never empty
    assert min(people.age_crops(rgb, [0.0, 0.9, 0.05, 0.1])[1].shape[:2]) >= 1


def test_new_age_model_replaces_the_old(monkeypatch, tmp_path):
    monkeypatch.setattr(people, "models_dir", lambda: tmp_path)
    (tmp_path / "age_vit_utkface.onnx").write_bytes(b"old")
    monkeypatch.setattr(people, "_download", lambda url, sha, dest, mb, what, progress=None: dest.write_bytes(b"new") and dest)
    assert people.download_age_model().name == people.AGE_NAME == "mivolo_v2_age.onnx"
    assert sorted(f.name for f in tmp_path.iterdir()) == ["mivolo_v2_age.onnx"]
    assert people.AGE_URL.endswith("/mivolo_v2_age.onnx") and "/resolve/" in people.AGE_URL


def test_merge_keeps_birthday(api, tmp_path, aged, monkeypatch):
    faces, ages = aged
    faces += [[face(ANN)], [face(BOB)]]
    sid, d = new_tray(api, tmp_path / "scans", slides=2)
    monkeypatch.setattr(wf, "active_session", None)
    out = api.get("/api/people").json()
    a, b = (_who(out, sid, g["id"]) for g in d["groups"])
    api.patch(f"/api/people/{b['id']}", json={"birthday": "1961"})
    out = api.post(f"/api/people/{a['id']}/merge", json={"people": [b["id"]]}).json()
    assert [p["birthday"] for p in out["people"]] == ["1961"]
    # a birthday alone keeps an otherwise empty, unnamed person (like a name does)
    assert people.load_people()["people"][a["id"]]["birthday"] == "1961"


def test_atlas(api, tmp_path, aged, monkeypatch):
    faces, _ = aged
    faces += [[face(ANN)], [], [face(ANN)]]
    sid, d = new_tray(api, tmp_path / "scans", slides=3, name="Italy 1978")
    monkeypatch.setattr(wf, "active_session", None)
    gids = [g["id"] for g in d["groups"]]
    venice = {"name": "Venice", "lat": 45.43713, "lon": 12.33265, "country": "IT"}
    for gid in gids[:2]:
        api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"place": venice})
    api.patch(f"/api/sessions/{sid}/groups/{gids[2]}", json={"place": {"name": "Rome", "lat": 41.89, "lon": 12.49}})
    ann = _who(api.get("/api/people").json(), sid, gids[0])["id"]

    out = api.get("/api/atlas").json()
    mine = [p for p in out["places"] if any(s["sid"] == sid for s in p["slides"])]
    assert [(p["name"], len(p["slides"])) for p in mine] == [("Venice", 2), ("Rome", 1)]
    v = mine[0]
    assert v["lat"] == pytest.approx(45.43713) and v["country"] == "IT"
    assert [s["people"] for s in v["slides"]] == [[ann], []]
    assert v["slides"][0]["tray"] == "Italy 1978" and v["slides"][0]["index"] == 0 and v["slides"][0]["key"]
    # a skipped slide isn't on the map
    api.patch(f"/api/sessions/{sid}/groups/{gids[2]}", json={"skip": True})
    assert not any(p["name"] == "Rome" and any(s["sid"] == sid for s in p["slides"])
                   for p in api.get("/api/atlas").json()["places"])


def test_people_who_disagree_arent_averaged(api, tmp_path, aged, monkeypatch):
    """A tray out of order: Ann (born 1950) looks 24 on slides 1 and 3, Bob (born 1987) looks 28 on
    slide 2, and slide 1 is dated 1974. Bob's slide isn't dragged to a year between the two (nor
    clipped to his birth year): it says what Bob says, and that the dated slides disagree."""
    faces, ages = aged
    faces += [[face(ANN)], [face(BOB)], [face(ANN)]]
    ages += [[24.0], [28.0], [24.0]]
    sid, d = new_tray(api, tmp_path / "scans", slides=3)
    monkeypatch.setattr(wf, "active_session", None)
    gids = [g["id"] for g in d["groups"]]
    out = api.get("/api/people").json()
    api.patch(f"/api/people/{_who(out, sid, gids[0])['id']}", json={"birthday": "1950"})
    api.patch(f"/api/people/{_who(out, sid, gids[1])['id']}", json={"birthday": "1987"})
    api.patch(f"/api/sessions/{sid}/groups/{gids[0]}", json={"date": "1974"})
    g1, g2, g3 = api.get(f"/api/sessions/{sid}").json()["groups"]
    assert 2012 <= g2["people_year"][0] <= 2019, g2["people_year"]
    sug = g2["insights"]["date"]
    assert 2012 <= int(sug["value"]) <= 2019 and "say 1974" in sug["text"]
    # Ann's slide agrees with its dated neighbour: 1974, as it goes already - nothing to suggest
    assert 1973 <= g3["people_year"][0] <= 1976 and g3["date_est"]["value"] == "1974"
    assert (g3["insights"] or {}).get("date") is None


def test_person_page(api, tmp_path, aged, monkeypatch):
    faces, ages = aged
    # Ann alone, Ann with Bob, Bob alone; slide 2 dated 1980 and placed in Venice
    faces += [[face(ANN)], [face(ANN), face(BOB, 0.6)], [face(BOB)]]
    ages += [[29.0], [31.0, 5.0], [6.0]]
    sid, d = new_tray(api, tmp_path / "scans", slides=3, name="Summer")
    monkeypatch.setattr(wf, "active_session", None)
    gids = [g["id"] for g in d["groups"]]
    out = api.get("/api/people").json()
    ann, bob = _who(out, sid, gids[0]), _who(out, sid, gids[2])
    assert ann["cover"] and ann["cover"].startswith(f"/api/people/faces/{sid}/")
    api.patch(f"/api/people/{ann['id']}", json={"name": "Ann", "birthday": "1950"})
    api.patch(f"/api/people/{bob['id']}", json={"name": "Bob"})
    venice = {"name": "Venice", "lat": 45.43713, "lon": 12.33265, "country": "IT"}
    api.patch(f"/api/sessions/{sid}/groups/{gids[1]}", json={"date": "1980", "place": venice})

    p = api.get(f"/api/people/{ann['id']}").json()
    assert p["name"] == "Ann" and p["birthday"] == "1950"
    # dated slides first (by date; the undated one borrows "1980" from its neighbour), tray order after
    assert [s["gid"] for s in p["slides"]] == [gids[0], gids[1]]
    s1 = next(s for s in p["slides"] if s["gid"] == gids[1])
    assert s1["date"] == "1980" and s1["date_source"] == "own" and s1["age"] == 30.0 and s1["looks"] == 31
    assert s1["place"]["name"] == "Venice" and s1["tray"] == "Summer" and s1["index"] == 1 and s1["key"]
    assert s1["face"]["url"].startswith(f"/api/people/faces/{sid}/{gids[1]}/")
    assert p["with"] == [{"id": bob["id"], "name": "Bob", "slides": 1}]
    assert api.get("/api/people/nobody").status_code == 404


def test_an_event_dates_its_slides(api, tmp_path, aged, monkeypatch):
    """The tray's one dated slide says 1971 and Tom (born 1968) looks 3 next to it, but slides 3-6
    are one scene where he looks 27, 46 (a mask) and 29: that scene is from the late 1990s. His
    faces there are pooled (the median, so the mask doesn't drag it), the scene's slide without
    anyone on it gets the same year, and his page shows it instead of the neighbours' 1971."""
    faces, ages = aged
    faces += [[], [face(ANN)], [face(ANN)], [face(ANN)], [], [face(ANN)]]
    ages += [[3.0], [27.0], [46.0], [29.0]]
    sid, d = new_tray(api, tmp_path / "scans", slides=6)
    monkeypatch.setattr(wf, "active_session", None)
    monkeypatch.setattr(dating, "_events", lambda sid_, groups: [(2, 5)])
    gids = [g["id"] for g in d["groups"]]
    tom = _who(api.get("/api/people").json(), sid, gids[1])["id"]
    api.patch(f"/api/people/{tom}", json={"name": "Tom", "birthday": "1968-11-25"})
    api.patch(f"/api/sessions/{sid}/groups/{gids[0]}", json={"date": "1971"})

    gs = api.get(f"/api/sessions/{sid}").json()["groups"]
    assert gs[1]["date_est"]["value"] == "1971" and (gs[1]["insights"] or {}).get("date") is None  # looks 3: fits
    for g in gs[2:]:
        assert 1995 <= g["people_year"][0] <= 2000, g["people_year"]
        sug = g["insights"]["date"]
        assert sug["source"] == "people" and 1995 <= int(sug["value"]) <= 2000
        assert "Tom ≈ 29" in sug["text"] and "say 1971" in sug["text"]
    assert len({g["insights"]["date"]["value"] for g in gs[2:]}) == 1  # one event, one year

    p = api.get(f"/api/people/{tom}").json()
    by = {s["gid"]: s for s in p["slides"]}
    assert by[gids[1]]["date"] == "1971" and by[gids[1]]["date_source"] == "near"
    s = by[gids[2]]
    assert s["date_source"] == "people" and s["date"] == gs[2]["insights"]["date"]["value"]
    assert 26 <= s["age"] <= 32 and s["looks"] == 27
    # turned down, the page goes back to what the slide goes with
    api.post(f"/api/sessions/{sid}/insights/decide", json={"kind": "date", "action": "dismiss", "groups": [gids[2]]})
    s = next(x for x in api.get(f"/api/people/{tom}").json()["slides"] if x["gid"] == gids[2])
    assert s["date"] == "1971" and s["date_source"] == "near"


def test_unnamed_people_have_a_number():
    assert people.label("p12", {"name": ""}) == "Person 12"
    assert people.label("p12", {"name": "Tom"}) == "Tom"
