"""Mirror: a slide scanned the wrong way round flips left-right as it looks on screen, whatever it was
turned, straightened, cropped or masked to; keys stay the same while it's off; the API round trip."""
from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from slidestation import imaging as im
from slidestation import store
from synthetic import scene

RADIAL = {"kind": "radial", "exposure": 0.8, "center": [0.35, 0.6], "rx": 0.2, "ry": 0.12, "angle": 25,
          "feather": 0.5}
BRUSH = {"kind": "brush", "saturation": -1, "strokes": [
    {"points": [[0.1, 0.8], [0.5, 0.7], [0.9, 0.9]], "radius": 0.05, "hardness": 0.5, "flow": 1}]}


@pytest.mark.parametrize("rot", [0, 90, 180, 270])
@pytest.mark.parametrize("mirror", [False, True])
def test_toggling_flips_what_is_shown(rot, mirror):
    a = scene(7, 420, 280)
    p = im.Params.from_dict({"strength": 0.0, "trim": False, "crop": [0.1, 0.2, 0.7, 0.9],
                             "local": [RADIAL, BRUSH]})
    shown = im.develop(im.orient(a, rot, mirror), p)
    q = im.mirror_params(im.Params.from_dict(p.to_dict()))
    flipped = im.develop(im.orient(a, -rot % 360, not mirror), q)
    assert shown.shape == flipped.shape
    assert np.abs(shown[:, ::-1] - flipped).mean() < 0.002
    assert im.mirror_params(im.Params.from_dict(q.to_dict())).to_dict() == p.to_dict()  # twice is none


def test_mirror_straighten_and_mount_box():
    p = im.mirror_params(im.Params.from_dict({"angle": 3.5}))
    assert p.angle == -3.5 and p.crop is None
    assert im.mirror_box([0.1, 0.2, None, 0.9]) == [None, 0.2, 0.9, 0.9]


def test_keys_unchanged_while_off():
    g = {"scans": ["a"], "excluded": [], "rotation": 90, "params": im.Params().to_dict()}
    on = {**g, "mirror": True}
    assert store.render_key({**g, "mirror": False}) == store.render_key(g) != store.render_key(on)
    assert store.tone_key({**g, "mirror": False}) == store.tone_key(g) != store.tone_key(on)


def preview(api, sid, gid, key):
    r = api.get(f"/api/sessions/{sid}/groups/{gid}/preview.jpg?size=400&v={key}")
    assert r.status_code == 200
    return np.asarray(Image.open(io.BytesIO(r.content))).astype(np.float32) / 255


def test_api_mirror(api, tray):
    sid, d = tray
    g0 = d["groups"][0]
    url = f"/api/sessions/{sid}/groups/{g0['id']}"
    g = api.patch(url, json={"rotation": 90, "params": {"crop": [0.1, 0.1, 0.6, 0.8]}}).json()["groups"][0]
    before = preview(api, sid, g0["id"], g["key"])

    g = api.patch(url, json={"mirror": True}).json()["groups"][0]
    assert g["mirror"] is True and g["rotation"] == 270 and g["params"]["crop"] == [0.4, 0.1, 0.9, 0.8]
    after = preview(api, sid, g0["id"], g["key"])
    assert before.shape == after.shape and np.abs(before[:, ::-1] - after).mean() < 0.01

    d = api.post(f"{url}/undo").json()
    assert d["stepped"] == "mirror"
    g = d["groups"][0]
    assert g["mirror"] is False and g["rotation"] == 90 and g["params"]["crop"] == [0.1, 0.1, 0.6, 0.8]

    # a slide split off a mirrored one is mirrored too
    g = api.patch(url, json={"mirror": True}).json()["groups"][0]
    d = api.post(f"{url}/split", json={"scan": g["scans"][1]}).json()
    assert d["groups"][1]["mirror"] is True
