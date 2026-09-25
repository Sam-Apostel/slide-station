"""Boxes: a numbered box holds two trays, left and right, of 50 slides (or 36, the shorter boxes).
A box can have writing on it, a tray can't, a slide's mount can.

The library is shared by every test: each test uses box numbers of its own.
"""
from __future__ import annotations

from conftest import new_tray


def create(api, code=200, **body):
    r = api.post("/api/sessions", json=body)
    assert r.status_code == code, r.text
    return r.json()


def box(api, n) -> dict | None:
    return next((b for b in api.get("/api/state").json()["boxes"] if b["number"] == n), None)


def test_tray_in_a_box_is_named_after_it(api):
    sid = create(api, box=101, side="left")["id"]
    d = api.get(f"/api/sessions/{sid}").json()
    assert d["summary"]["name"] == "Box 101 left" and d["summary"]["album"] == "Box 101 left"
    assert (d["summary"]["box"], d["summary"]["side"]) == (101, "left")
    assert d["box"] == {"number": 101, "size": 50, "writing": ""}
    assert box(api, 101)["trays"] == {"left": sid}


def test_a_given_name_wins(api):
    sid = create(api, name="Italy 1978", box=102, side="right")["id"]
    assert api.get(f"/api/sessions/{sid}").json()["summary"]["name"] == "Italy 1978"


def test_one_tray_per_side(api):
    create(api, box=103, side="left")
    r = api.post("/api/sessions", json={"box": 103, "side": "left"})
    assert r.status_code == 409 and "Box 103 left" in r.json()["detail"]
    create(api, box=103, side="right")
    assert set(box(api, 103)["trays"]) == {"left", "right"}


def test_short_box_and_its_writing(api):
    sid = create(api, box=104, side="left", box_size=36, box_writing="Kerst '79")["id"]
    assert api.get(f"/api/sessions/{sid}").json()["box"] == {"number": 104, "size": 36, "writing": "Kerst '79"}
    # the second tray of the box leaves what's known about it alone
    create(api, box=104, side="right")
    assert box(api, 104)["size"] == 36 and box(api, 104)["writing"] == "Kerst '79"
    r = api.patch("/api/boxes/104", json={"size": 50, "writing": "Kerst '79 + '80"})
    assert r.status_code == 200
    assert box(api, 104)["size"] == 50 and box(api, 104)["writing"] == "Kerst '79 + '80"
    assert api.patch("/api/boxes/104", json={"size": 40}).status_code == 400


def test_bad_box_or_side(api):
    assert api.post("/api/sessions", json={"box": "twelve", "side": "left"}).status_code == 400
    assert api.post("/api/sessions", json={"box": 0}).status_code == 400
    assert api.post("/api/sessions", json={"box": 105, "side": "middle"}).status_code == 400


def test_moving_a_tray_renames_it_unless_named(api):
    sid = create(api, box=106, side="left")["id"]
    d = api.patch(f"/api/sessions/{sid}", json={"box": 107, "side": "right"}).json()
    assert d["summary"]["name"] == "Box 107 right" and d["summary"]["album"] == "Box 107 right"
    assert box(api, 106)["trays"] == {} and box(api, 107)["trays"] == {"right": sid}
    api.patch(f"/api/sessions/{sid}", json={"name": "Wedding"})
    d = api.patch(f"/api/sessions/{sid}", json={"side": "left"}).json()
    assert d["summary"]["name"] == "Wedding" and d["summary"]["album"] == "Box 107 left"
    # taken out of its box: the name stays what it was
    d = api.patch(f"/api/sessions/{sid}", json={"box": None, "side": None}).json()
    assert d["summary"]["box"] is None and d["box"] is None and d["summary"]["name"] == "Wedding"


def test_cant_move_onto_a_taken_side(api):
    create(api, box=108, side="left")
    sid = create(api, box=108, side="right")["id"]
    assert api.patch(f"/api/sessions/{sid}", json={"side": "left"}).status_code == 409


def test_old_trays_have_no_box(api, tmp_path):
    sid, d = new_tray(api, tmp_path)
    assert d["summary"]["box"] is None and d["summary"]["side"] is None and d["box"] is None


def test_writing_on_a_slide(api, tmp_path):
    sid, d = new_tray(api, tmp_path)
    gid = d["groups"][0]["id"]
    r = api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"writing": "  Oma, Knokke  "})
    assert r.status_code == 200, r.text
    g = r.json()["groups"][0]
    assert g["writing"] == "Oma, Knokke" and g["caption"] == ""
    assert g["status"] == "new"  # writing isn't the photo: nothing to upload again
