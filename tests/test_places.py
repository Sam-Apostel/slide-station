"""Places (ROADMAP §1 "Location recognition"): a slide's place typed from the gazetteer, propagated
along the tray, suggested from text in the photo and from tray neighbours, written as EXIF GPS and
sent to Immich as latitude / longitude without re-uploading, and pulled back.

The gazetteer is a made-up GeoNames extract written into the scratch library and the text reader
is replaced by a fake (no model, no network). SS_REAL_OCR=1 adds a smoke test that downloads the
real text reader (~10 MB) and GeoNames' cities15000 (~3 MB) into the scratch library and reads
signs rendered into synthetic photos. Run: uv run --python 3.12 pytest tests -q
"""
from __future__ import annotations

import io
import os
import shutil
import zipfile

import httpx
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

import fake_immich
from conftest import new_tray, wait_job
from slidestation import insights, places, store
from slidestation import workflow as wf
from slidestation.store import Session

# geonameid, name, asciiname, alternate names, lat, lon, country, admin1, population
CITIES = [
    (3164603, "Venice", "Venice", "VCE,Venecia,Venedig,Venezia", 45.43713, 12.33265, "IT", "20", 51298),
    (5405841, "Venice", "Venice", "", 33.99084, -118.46008, "US", "CA", 40885),
    (4176380, "Venice", "Venice", "", 27.09978, -82.45426, "US", "FL", 22211),
    (4259418, "Dayton", "Dayton", "Gem City,Venice", 39.75895, -84.19161, "US", "OH", 135512),  # sic GeoNames
    (3176959, "Florence", "Florence", "Firenze,Florenz", 43.77925, 11.24626, "IT", "16", 349296),
    (2775220, "Innsbruck", "Innsbruck", "Innsbrucco", 47.26266, 11.39454, "AT", "07", 132493),
    (3204541, "Bar", "Bar", "Antivari", 42.0931, 19.10013, "ME", "02", 17727),
    (3169070, "Rome", "Rome", "Roma,Rom", 41.89193, 12.51133, "IT", "07", 2318895),
    (3448439, "Plagetown", "Plagetown", "Plage", 10.0, 10.0, "BR", "27", 20000),  # a word among small names
]
COUNTRIES = {"IT": "Italy", "US": "United States", "AT": "Austria", "ME": "Montenegro", "BR": "Brazil"}
ADMINS = {"IT.20": "Veneto", "US.CA": "California", "US.FL": "Florida", "US.OH": "Ohio", "IT.16": "Tuscany",
          "AT.07": "Tyrol", "ME.02": "Bar", "IT.07": "Latium", "BR.27": "São Paulo"}


def geonames_files() -> dict[str, bytes]:
    rows = "".join(f"{i}\t{n}\t{a}\t{alt}\t{lat}\t{lon}\tP\tPPL\t{cc}\t\t{adm}\t\t\t\t{pop}\t\t0\tEurope/Rome\t2026-01-01\n"
                   for i, n, a, alt, lat, lon, cc, adm, pop in CITIES)
    z = io.BytesIO()
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("cities15000.txt", rows * 1)
    country = "#ISO\tISO3\tISO-Numeric\tfips\tCountry\n" + "".join(
        f"{cc}\tXXX\t000\t{cc}\t{name}\tCapital\n" for cc, name in COUNTRIES.items()) * 30
    admin = "".join(f"{k}\t{v}\t{v}\t1\n" for k, v in ADMINS.items())
    return {"cities15000.zip": z.getvalue(), "countryInfo.txt": country.encode(), "admin1CodesASCII.txt": admin.encode()}


@pytest.fixture
def gazetteer():
    d = places.data_dir()
    d.mkdir(parents=True, exist_ok=True)
    for name, data in geonames_files().items():
        (d / name).write_bytes(data)
    places._gaz = None
    yield places.gazetteer()
    shutil.rmtree(d, ignore_errors=True)
    places._gaz = None


def groups(api, sid) -> list[dict]:
    return api.get(f"/api/sessions/{sid}").json()["groups"]


def patch(api, sid, gid, body, code=200):
    r = api.patch(f"/api/sessions/{sid}/groups/{gid}", json=body)
    assert r.status_code == code, r.text
    return r.json()


def upload(api, sid, **body) -> str:
    assert api.post(f"/api/sessions/{sid}/finish", json=body).json() == {"ok": True}
    return wait_job(api)["message"]


VENICE = {"name": "Venice", "lat": 45.43713, "lon": 12.33265, "country": "Italy"}
ROME = {"name": "Rome", "lat": 41.89193, "lon": 12.51133, "country": "Italy"}

# --------------------------------------------------------------------------- the place itself


def test_clean_place():
    assert places.clean_place(None) is None and places.clean_place({}) is None
    p = places.clean_place({"name": "  Venice ", "lat": "45.437134", "lon": 12.332651, "country": "Italy", "x": 1})
    assert p == {"name": "Venice", "lat": 45.43713, "lon": 12.33265, "country": "Italy"}
    assert places.clean_place({"lat": 1, "lon": 2})["name"] == "1.0000, 2.0000"  # no name: its coordinates
    for bad in ({"name": "x"}, {"lat": 91, "lon": 0}, {"lat": 0, "lon": 181}, {"lat": "nan", "lon": 0}, "Venice"):
        with pytest.raises(ValueError):
            places.clean_place(bad)
    assert places.parse_coords("45.4371, 12.3326") == (45.4371, 12.3326)
    assert places.parse_coords("-33.9 151.2") == (-33.9, 151.2)
    assert places.parse_coords("Venice") is None and places.parse_coords("95, 10") is None
    assert places.fold("Zürich-Flughafen") == "zurich flughafen" and places.fold("Łódź") == "lodz"


def test_search(gazetteer):
    assert len(gazetteer) == len(CITIES)
    names = lambda q: [f"{p['name']}/{p.get('admin', '')}" for p in places.search(q)]  # noqa: E731
    # own name before an alternate one ("Venice" is also among Dayton's names), then size
    assert names("venice") == ["Venice/Veneto", "Venice/California", "Venice/Florida", "Dayton/Ohio"]
    assert names("Venice, united")[:2] == ["Venice/California", "Venice/Florida"]  # narrowed by country
    assert names("venice, flor") == ["Venice/Florida"]  # ... or region
    assert names("firen") == ["Florence/Tuscany"] and names("ROMA") == ["Rome/Latium"]
    assert names("ven")[0] == "Venice/Veneto" and names("") == [] and names("zzz") == []
    p = places.search("Innsbr")[0]
    assert p == {"name": "Innsbruck", "lat": 47.26266, "lon": 11.39454, "country": "Austria", "id": 2775220,
                 "admin": "Tyrol"}
    # coordinates: named after the nearest city within 25 km, else after themselves
    assert places.search("45.44, 12.34")[0]["name"] == "Venice"
    assert places.search("0.5, 0.5") == [{"name": "0.5000, 0.5000", "lat": 0.5, "lon": 0.5, "country": ""}]


def test_places_endpoint(api, gazetteer):
    r = api.get("/api/places", params={"q": "Firenze"}).json()
    assert r["ready"] and [p["name"] for p in r["results"]] == ["Florence"]
    assert api.get("/api/places").json()["results"] == []
    shutil.rmtree(places.data_dir())
    r = api.get("/api/places", params={"q": "45.1, 12.2"}).json()  # without the gazetteer: coordinates only
    assert not r["ready"] and r["results"][0]["name"] == "45.1000, 12.2000"
    assert api.get("/api/places", params={"q": "Venice"}).json()["results"] == []


def test_set_and_clear_place(api, tray):
    sid, d = tray
    gid = d["groups"][0]["id"]
    g = patch(api, sid, gid, {"place": {**VENICE, "admin": "Veneto", "id": 3164603}})["groups"][0]
    assert g["place"] == {**VENICE, "admin": "Veneto", "id": 3164603}
    patch(api, sid, gid, {"place": {"name": "x", "lat": 100, "lon": 0}}, 400)
    assert patch(api, sid, gid, {"place": None})["groups"][0]["place"] is None
    assert "place" not in Session(sid).group(gid)


def test_meta_key_includes_place():
    g = {"caption": "x"}
    before = store.meta_key(g, {"value": "1978"})
    assert store.meta_key({**g, "place": None}, {"value": "1978"}) == before  # no place: key as before
    k = store.meta_key({**g, "place": VENICE}, {"value": "1978"})
    assert k != before
    assert store.meta_key({**g, "place": {**VENICE, "name": "Venezia"}}, {"value": "1978"}) == k  # coordinates only
    # the exact string the browser version hashes too (store.test.ts)
    assert store.meta_key({"caption": "", "place": {"lat": 45.4, "lon": -12.0}}, {"value": ""}) == \
        store.meta_key({"caption": "", "place": {"lat": 45.40000, "lon": -12}}, {"value": ""})


# --------------------------------------------------------------------------- propagation + neighbours


def test_propagate_place(api, tray):
    sid, d = tray
    ids = [g["id"] for g in d["groups"]]
    s = Session(sid)
    s.group(ids[2])["locked"] = "originals"
    s.save()
    r = api.post(f"/api/sessions/{sid}/insights/propagate",
                 json={"kind": "place", "value": VENICE, "from": ids[3], "to": ids[0]})
    assert r.status_code == 200, r.text
    assert r.json()["applied"] == 3
    assert [bool(g["place"]) for g in r.json()["groups"]] == [True, True, False, True]  # the locked one kept
    r = api.post(f"/api/sessions/{sid}/insights/propagate",
                 json={"kind": "place", "value": {"lat": 200, "lon": 0}, "from": ids[0], "to": ids[1]})
    assert r.status_code == 400


def test_neighbours_suggest_the_place_between(api, tmp_path):
    sid, d = new_tray(api, tmp_path / "scans", slides=6)
    ids = [g["id"] for g in d["groups"]]
    patch(api, sid, ids[0], {"place": VENICE})
    gs = patch(api, sid, ids[3], {"place": VENICE})["groups"]
    for i in (1, 2):
        e = gs[i]["insights"]["place"]
        assert e["state"] == "suggested" and e["source"] == "tray" and e["value"] == "Venice, Italy"
        assert e["place"] == VENICE and e["text"] == "slides 1 and 4" and e["confidence"] == places.TRAY_CONFIDENCE
    assert not (gs[4]["insights"] or {}).get("place")  # not between two: nothing
    # accept on one, dismiss on the other
    r = api.post(f"/api/sessions/{sid}/insights/decide",
                 json={"kind": "place", "action": "accept", "value": "Venice, Italy", "groups": [ids[1]]}).json()
    assert r["decided"] == 1 and r["groups"][1]["place"] == VENICE
    api.post(f"/api/sessions/{sid}/insights/decide",
             json={"kind": "place", "action": "dismiss", "value": "Venice, Italy", "groups": [ids[2]]})
    # slide 4 moves to Rome: nothing is between two Venices any more; the dismissal stays
    gs = patch(api, sid, ids[3], {"place": ROME})["groups"]
    assert gs[2]["insights"]["place"]["state"] == "dismissed" and not gs[2]["place"]
    gs = patch(api, sid, ids[5], {"place": VENICE})["groups"]  # Rome in between: still nothing
    assert not any(((g["insights"] or {}).get("place") or {}).get("state") == "suggested" for g in gs)
    gs = patch(api, sid, ids[3], {"place": None})["groups"]  # now Venice on 2 and 6, nothing between
    assert [((g["insights"] or {}).get("place") or {}).get("state") for g in gs] == \
        [None, "accepted", "dismissed", "suggested", "suggested", None]
    gs = patch(api, sid, ids[5], {"place": ROME})["groups"]  # withdrawn again
    assert [((g["insights"] or {}).get("place") or {}).get("state") for g in gs][3:5] == [None, None]


def test_typing_a_place_settles_its_suggestion(api, tray):
    sid, d = tray
    ids = [g["id"] for g in d["groups"]]
    s = Session(sid)
    for gid in ids[:2]:
        s.group(gid)["insights"] = {"key": "", "tags": [], "place": places.suggestion(VENICE, 0.7, places.OCR_ID)}
    s.save()
    gs = patch(api, sid, ids[0], {"place": VENICE})["groups"]
    assert gs[0]["insights"]["place"]["state"] == "accepted"
    gs = patch(api, sid, ids[1], {"place": ROME})["groups"]
    assert gs[1]["insights"]["place"]["state"] == "dismissed"  # you chose another one


# --------------------------------------------------------------------------- text in the photo


def test_place_from_text(gazetteer):
    def read(*lines, conf=0.99):
        s = places.place_from_text([{"text": t, "confidence": conf} for t in lines], gazetteer)
        return s and (s["place"]["name"], s["place"].get("admin"), s["confidence"])

    name, admin, c = read("WELCOME TO", "VENICE")  # a cue on the line before
    assert (name, admin) == ("Venice", "Veneto") and 0.6 < c < 0.9  # three Venices share the name
    name, admin, c = read("Benvenuti a Firenze")
    assert name == "Florence" and c > 0.85  # a cue, and one city by that name
    assert read("INNSBRUCK", "Hauptbahnhof")[0] == "Innsbruck"
    assert read("Innsbruck", conf=0.4) is None  # the recogniser wasn't sure
    assert read("OPEN", "BAR") is None and read("Plage") is None  # sign words; a small place's other name
    assert read("Hotel Innsbruck") is None and read("Via Roma 12") is None  # a hotel, a street
    assert read("Welcome to Bar")[0] == "Bar"  # ... unless a cue says it's the place
    assert read() is None and read("Gelato", "Pizza") is None


class FakeClip:
    def label_embeds(self):
        return np.eye(len(insights.TAGS), dtype=np.float32)

    def image_embed(self, rgb):
        v = np.zeros(len(insights.TAGS), np.float32)
        v[insights.TAGS.index("city")] = 1
        return v


class FakeOcr:
    def __init__(self):
        self.lines = [{"text": "WELCOME TO", "confidence": 0.98}, {"text": "VENICE", "confidence": 0.99}]
        self.calls = 0

    def read(self, rgb8):
        assert rgb8.dtype == np.uint8 and rgb8.ndim == 3
        self.calls += 1
        return self.lines


@pytest.fixture
def reader(monkeypatch, gazetteer):
    """Insights on with a fake CLIP and a fake text reader; the tests run the analysis."""
    fake = FakeOcr()
    monkeypatch.setattr(insights, "backend", lambda: FakeClip())
    monkeypatch.setattr(insights, "step", lambda: False)
    monkeypatch.setattr(insights, "ocr_on", lambda: True)
    monkeypatch.setattr(places, "ocr_backend", lambda: fake)
    store.save_config({**store.load_config(), "insights_enabled": True})
    return fake


STEP = insights.step


def analyse_all():
    while STEP():
        pass


def test_sign_suggests_a_place(api, tray, reader, monkeypatch):
    sid, d = tray
    ids = [g["id"] for g in d["groups"]]
    api.get(f"/api/sessions/{sid}")  # the open tray is analysed
    analyse_all()
    gs = groups(api, sid)
    e = gs[0]["insights"]["place"]
    assert e["state"] == "suggested" and e["source"] == places.OCR_ID and e["value"] == "Venice, Italy"
    assert e["text"] == "WELCOME TO VENICE" and gs[0]["insights"]["text"] == ["WELCOME TO", "VENICE"]
    assert not gs[0]["place"]  # never applied by itself
    assert reader.calls == 4
    # the key names the text reader: without it, the slides are analysed again
    monkeypatch.setattr(insights, "ocr_on", lambda: False)
    assert groups(api, sid)[0]["insights"]["stale"]
    monkeypatch.setattr(insights, "ocr_on", lambda: True)
    # dismiss on 1, accept on 2; analysing again keeps both, and a slide with its own place gets nothing
    r = api.post(f"/api/sessions/{sid}/insights/decide",
                 json={"kind": "place", "action": "dismiss", "value": "Venice, Italy", "groups": [ids[0]]})
    assert r.json()["decided"] == 1
    r = api.post(f"/api/sessions/{sid}/insights/decide",
                 json={"kind": "place", "action": "accept", "value": "Venice, Italy", "groups": [ids[1]]})
    assert r.json()["groups"][1]["place"]["name"] == "Venice"
    patch(api, sid, ids[2], {"place": ROME})
    assert api.post(f"/api/sessions/{sid}/insights/run", json={"force": True}).status_code == 200
    analyse_all()
    gs = groups(api, sid)
    # slide 3: typing Rome settled its Venice suggestion as dismissed, and it stays that way
    assert [g["insights"]["place"]["state"] for g in gs] == ["dismissed", "accepted", "dismissed", "suggested"]
    assert gs[2]["place"] == ROME
    # accept all that's open (the review view)
    r = api.post(f"/api/sessions/{sid}/insights/decide", json={"kind": "place", "action": "accept",
                                                               "value": "Venice, Italy"}).json()
    assert r["decided"] == 1 and [g["place"]["name"] if g["place"] else None for g in r["groups"]] == \
        [None, "Venice", "Rome", "Venice"]


def test_sign_without_a_place(api, tray, reader):
    sid, d = tray
    reader.lines = [{"text": "Gelato", "confidence": 0.99}]
    api.get(f"/api/sessions/{sid}")
    analyse_all()
    g = groups(api, sid)[0]
    assert g["insights"]["place"] is None and g["insights"]["text"] == ["Gelato"]


# --------------------------------------------------------------------------- Immich + EXIF


def exif_gps(data: bytes):
    gps = Image.open(io.BytesIO(data)).getexif().get_ifd(0x8825)
    if not gps:
        return None
    deg = lambda v: float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600  # noqa: E731
    return (round(deg(gps[2]) * (-1 if gps[1] == "S" else 1), 5), round(deg(gps[4]) * (-1 if gps[3] == "W" else 1), 5))


def test_place_goes_to_immich(api, tray, immich_db):
    sid, d = tray
    ids = [g["id"] for g in d["groups"]]
    patch(api, sid, ids[0], {"place": VENICE})
    patch(api, sid, ids[1], {"place": {"name": "Somewhere", "lat": -33.85678, "lon": -151.21528}})
    upload(api, sid)
    s = Session(sid)
    a0 = immich_db["assets"][s.group(ids[0])["immich"]["asset_id"]]
    a1 = immich_db["assets"][s.group(ids[1])["immich"]["asset_id"]]
    # the export carries EXIF GPS, which is how Immich learns it on upload
    assert exif_gps(immich_db["data"][s.group(ids[0])["immich"]["asset_id"]]) == (45.43713, 12.33265)
    assert (a0["lat"], a0["lon"]) == (45.43713, 12.33265) and (a1["lat"], a1["lon"]) == (-33.85678, -151.21528)
    assert s.group(ids[0])["immich"]["pushed"]["place"] == [45.43713, 12.33265]
    assert s.group(ids[2])["immich"]["pushed"]["place"] is None
    assert all(g["status"] == "uploaded" for g in groups(api, sid))

    # a new place after upload: "changed", and only the location is updated (no new asset)
    n = len(immich_db["assets"])
    gs = patch(api, sid, ids[0], {"place": ROME})["groups"]
    patch(api, sid, ids[2], {"place": VENICE})
    assert gs[0]["status"] == "changed"
    msg = upload(api, sid)
    assert "2 updated in place (date, caption, place)" in msg and len(immich_db["assets"]) == n
    assert (a0["lat"], a0["lon"]) == (41.89193, 12.51133)
    a2 = immich_db["assets"][s.group(ids[2])["immich"]["asset_id"]]
    assert (a2["lat"], a2["lon"]) == (45.43713, 12.33265)
    sent = [(e[2]["latitude"], e[2]["longitude"]) for e in immich_db["log"] if e[0] == "update" and "latitude" in e[2]]
    assert sorted(sent) == [(41.89193, 12.51133), (45.43713, 12.33265)]
    assert all(g["status"] == "uploaded" for g in groups(api, sid))

    # removing a place: Immich's API can't clear a location, so a new copy without GPS goes up
    old = s.group(ids[1])["immich"]["asset_id"]
    patch(api, sid, ids[1], {"place": None})
    msg = upload(api, sid)
    s = Session(sid)
    new = s.group(ids[1])["immich"]["asset_id"]
    assert new != old and immich_db["assets"][old]["trashed"]
    assert exif_gps(immich_db["data"][new]) is None and immich_db["assets"][new]["lat"] is None
    assert s.group(ids[1])["immich"]["pushed"]["place"] is None


def test_place_update_without_permission_reuploads(api, tray, immich_db, monkeypatch):
    sid, d = tray
    gid = d["groups"][0]["id"]
    upload(api, sid)
    old = Session(sid).group(gid)["immich"]["asset_id"]
    monkeypatch.setattr(fake_immich, "DENY", [("PUT", r"/api/assets/[^/]+")])
    patch(api, sid, gid, {"place": VENICE})
    assert "went up as new copies" in upload(api, sid)
    new = Session(sid).group(gid)["immich"]["asset_id"]
    assert new != old and exif_gps(immich_db["data"][new]) == (45.43713, 12.33265)


def test_pull_place_from_immich(api, tray, immich_db):
    sid, d = tray
    ids = [g["id"] for g in d["groups"]]
    patch(api, sid, ids[0], {"place": VENICE})
    upload(api, sid)
    s = Session(sid)
    a0 = immich_db["assets"][s.group(ids[0])["immich"]["asset_id"]]
    a1 = immich_db["assets"][s.group(ids[1])["immich"]["asset_id"]]
    a0.update(lat=45.4408, lon=12.3155, city="Venezia", country="Italy")  # moved on Immich's map
    a1.update(lat=47.26266, lon=11.39454, city="Innsbruck", country="Austria")  # placed there
    r = api.post(f"/api/sessions/{sid}/pull").json()
    assert r["pulled"]["places"] == 2
    gs = r["groups"]
    assert gs[0]["place"] == {"name": "Venezia", "lat": 45.4408, "lon": 12.3155, "country": "Italy"}
    assert gs[1]["place"]["name"] == "Innsbruck" and gs[1]["status"] == "uploaded"  # Immich has it: not changed
    assert api.post(f"/api/sessions/{sid}/pull").json()["pulled"]["places"] == 0  # nothing new


def test_pull_in_keeps_the_photos_location(api, tmp_path, immich_db):
    from test_immich_roundtrip import photo

    aid = fake_immich.add_asset(photo(tmp_path, 7), "trip.jpg", lat=47.26266, lon=11.39454, city="Innsbruck",
                                country="Austria")
    r = api.post("/api/immich/import", json={"assets": [aid], "name": "Trip"})
    wait_job(api)
    g = groups(api, r.json()["id"])[0]
    assert g["place"] == {"name": "Innsbruck", "lat": 47.26266, "lon": 11.39454, "country": "Austria"}


# --------------------------------------------------------------------------- downloads


@pytest.fixture
def geonames_served(monkeypatch):
    state = {"files": geonames_files(), "requests": []}

    def handler(req: httpx.Request):
        name = req.url.path.rsplit("/", 1)[-1]
        state["requests"].append(name)
        return httpx.Response(200, content=state["files"][name])

    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(places, "MIN_ROWS", 5)  # the made-up tables are short
    shutil.rmtree(places.data_dir(), ignore_errors=True)
    places._gaz = None
    yield state
    shutil.rmtree(places.data_dir(), ignore_errors=True)
    places._gaz = None


def test_gazetteer_download(api, geonames_served):
    assert not api.get("/api/places").json()["ready"]
    assert api.post("/api/places/download").json() == {"ok": True, "ready": False}
    wait_job(api)
    assert places.gazetteer_ready() and not list(places.data_dir().glob("*.part"))
    assert api.post("/api/places/download").json() == {"ok": True, "ready": True}
    assert [p["name"] for p in api.get("/api/places", params={"q": "venezia"}).json()["results"]] == ["Venice"]


def test_gazetteer_download_rejects_junk(geonames_served):
    geonames_served["files"]["cities15000.zip"] = b"<html>maintenance</html>"
    with pytest.raises(RuntimeError, match="isn't a GeoNames file"):
        places.download_gazetteer(wf.Job("places", None))
    assert not places.gazetteer_ready() and not list(places.data_dir().glob("*.part"))


def test_ocr_download(api, geonames_served, monkeypatch):
    blob = os.urandom(1000)
    import hashlib

    geonames_served["files"]["det.onnx"] = blob
    monkeypatch.setattr(places, "OCR_FILES", [("x/det.onnx", "det.onnx", len(blob),
                                               "sha256:" + hashlib.sha256(blob).hexdigest())])
    monkeypatch.setattr(places, "OCR_MB", 1)
    assert not api.get("/api/insights").json()["ocr_ready"]
    assert api.post("/api/places/download", json={"ocr": True}).json() == {"ok": True, "ready": False}
    job = wait_job(api)
    assert job["kind"] == "ocr" and "Text reader ready" in job["message"]
    assert places.ocr_ready() and places.gazetteer_ready()  # the place names came along
    shutil.rmtree(places.ocr_dir())


# --------------------------------------------------------------------------- the real text reader


def sign(lines: list[str], angle: float = 0, w: int = 1600, h: int = 1067) -> np.ndarray:
    """A synthetic photo: sky and ground, a sign board with the text, grain and a faded cast."""
    rng = np.random.default_rng(len(lines))
    y = np.linspace(0, 1, h)[:, None, None]
    img = Image.fromarray(((np.array([0.45, 0.6, 0.85]) * (1 - y) + np.array([0.35, 0.4, 0.25]) * y)
                           * np.ones((h, w, 3)) * 255).astype(np.uint8))
    board = Image.new("RGBA", (w // 2 + 200, 140 + 90 * len(lines)), (235, 235, 225, 255))
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 70)
    except OSError:  # no DejaVu (macOS): Pillow's own font
        font = ImageFont.load_default(70)
    for k, t in enumerate(lines):
        ImageDraw.Draw(board).text((40, 40 + k * 90), t, font=font, fill=(20, 40, 120))
    board = board.rotate(angle, expand=True, resample=Image.BICUBIC)
    img.paste(board, (w // 5, h // 4), board)
    a = np.asarray(img, np.float32) / 255 + rng.normal(0, 0.04, (h, w, 3))
    return np.clip(a * np.array([1.0, 0.85, 0.8]) + np.array([0.08, 0.02, 0.0]), 0, 1)


@pytest.mark.skipif(not os.environ.get("SS_REAL_OCR"), reason="set SS_REAL_OCR=1 to download and run the text reader")
def test_real_ocr_reads_signs():
    places._gaz = None
    if not places.ocr_ready():
        places.download_ocr(wf.Job("ocr", None))
    gaz = places.gazetteer()
    for lines, angle, want in [(["WELCOME TO", "VENICE"], 0, "Venice"), (["BIENVENUE À", "ANNECY"], -3, "Annecy"),
                               (["Benvenuti a Firenze"], 0, "Florence"), (["OPEN", "BAR"], 0, None)]:
        text = places.read_text(sign(lines, angle))
        assert [t["text"].upper() for t in text] == [x.upper() for x in lines], text
        hit = places.place_from_text(text, gaz)
        assert (hit["place"]["name"] if hit else None) == want
