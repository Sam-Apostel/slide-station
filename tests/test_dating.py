"""Dates from people (dating.py): birthdays, the ages faces look, the calibration on dated slides,
the date suggestion, and People & Places (the atlas). The face and age models are stood in for
(people.embed_faces / estimate_ages monkeypatched: no model, no network)."""
from __future__ import annotations

import math

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
    s = [("p1", real * 1.15 + 1.1, real) for real in (20, 30, 40, 50, 25, 35, 45, 28, 33, 38)]
    cal = dating.calibrate(s)
    assert cal["bias"] < -0.1 and cal["sigma"] < dating.PRIOR_SIGMA
    assert 30 < dating.corrected(40, "p2", cal)[0] < 36
    # a person with slides of their own gets a correction of their own, shrunk towards the rest
    cal = dating.calibrate(s + [("p9", 40.0, 30.0)] * 6)
    assert cal["people"]["p9"] < cal["people"]["p1"]
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

    # no birthdays yet: nothing to date by
    d = api.patch(f"/api/sessions/{sid}/groups/{gids[0]}", json={"date": "1980"}).json()
    assert all(g["people_year"] is None for g in d["groups"])

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
