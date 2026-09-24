"""Local adjustments (graduated / radial / brush): validation, the mask maths, where the masks sit
(on the picture, through crop, straighten and quarter turns), resolution independence, render-key
neutrality, and the API around them (undo, turning, never carried to other slides)."""
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
GRAD = {"kind": "graduated", "exposure": -0.7, "warmth": 0.2, "start": [0.5, 0.0], "end": [0.5, 0.4]}
BRUSH = {"kind": "brush", "saturation": -1, "strokes": [
    {"points": [[0.1, 0.8], [0.5, 0.7], [0.9, 0.9]], "radius": 0.05, "hardness": 0.5, "flow": 1}]}


# --------------------------------------------------------------------------- validation


def test_clean_local_fills_defaults_and_clamps():
    out = im.clean_local([
        {"kind": "radial", "exposure": 3, "contrast": "0.5", "rx": -1, "feather": 7, "center": [5, -0.00001],
         "invert": 1},
        {"kind": "graduated", "tint": None, "start": "junk"},
        {"kind": "brush", "strokes": [{"points": [[0.1, 0.2], "x", [0.3]], "radius": 9}, {"points": []}, "x"]},
        {"kind": "lasso"}, "junk", None,
    ])
    assert [a["kind"] for a in out] == ["radial", "graduated", "brush"]
    r, g, b = out
    assert r["exposure"] == 1.0 and r["contrast"] == 0.5 and r["rx"] == 0.005 and r["ry"] == 0.25
    assert r["feather"] == 1.0 and r["invert"] is True and r["angle"] == 0.0
    assert r["center"] == [2.0, 0.0] and str(r["center"][1]) == "0.0"  # never -0.0 in the render key
    assert g["tint"] == 0.0 and g["start"] == [0.5, 0.15] and g["end"] == [0.5, 0.55]
    assert b["strokes"] == [{"points": [[0.1, 0.2]], "radius": 0.5, "hardness": 0.5, "flow": 1.0, "erase": False}]
    for a in out:  # every number a float, so the render key matches the browser version's
        assert all(isinstance(a[k], float) for k in im.LOCAL_SLIDERS)
    assert im.clean_local("junk") == [] and im.clean_local(None) == []
    assert len(im.clean_local([RADIAL] * 40)) == im.LOCAL_MAX
    many = {"kind": "brush", "strokes": [{"points": [[0.5, 0.5]] * 1000}] * 100}
    (b,) = im.clean_local([many])
    assert len(b["strokes"]) == im.BRUSH_STROKES and len(b["strokes"][0]["points"]) == im.BRUSH_POINTS


def test_params_round_trip():
    p = im.Params.from_dict({"local": [RADIAL, GRAD]})
    assert im.Params.from_dict(p.to_dict()).to_dict() == p.to_dict()
    assert im.Params().to_dict()["local"] == []


# --------------------------------------------------------------------------- masks


def test_graduated_mask_runs_from_start_to_end():
    adj = im.clean_local([{**GRAD, "start": [0.5, 0.2], "end": [0.5, 0.6]}])[0]
    m = im.local_mask(adj, 1500, 1000)
    assert m.shape == (683, 1024)  # MASK_EDGE along the longer edge
    col = m[:, 512]
    y = lambda v: int(v * 683)  # noqa: E731
    assert col[: y(0.19)].min() == 1.0 and col[y(0.61) :].max() == 0.0
    assert np.all(np.diff(col) <= 1e-7)  # never rises going down
    assert abs(col[y(0.4)] - 0.5) < 0.02  # half way at the middle
    assert np.allclose(m, m[:, :1])  # the same across a horizontal gradient


def test_radial_mask_ellipse_feather_invert():
    adj = im.clean_local([{"kind": "radial", "center": [0.5, 0.5], "rx": 0.25, "ry": 0.1, "feather": 0.4}])[0]
    m = im.local_mask(adj, 1024, 1024)
    assert m[512, 512] == 1.0 and m[0, 0] == 0.0
    # full effect inside (1 - feather) of the radius, nothing past it; wider than tall
    assert m[512, 512 + 150] == 1.0 and m[512, 512 + 262] == 0.0
    assert m[512 + 60, 512] == 1.0 and m[512 + 105, 512] == 0.0
    assert 0 < m[512, 512 + 205] < 1
    turned = im.local_mask({**adj, "angle": 90.0}, 1024, 1024)
    assert np.allclose(turned, m.T, atol=1e-5)  # a quarter turn of the ellipse
    inv = im.local_mask({**adj, "invert": True}, 1024, 1024)
    assert np.allclose(inv, 1 - m, atol=1e-6)
    hard = im.local_mask({**adj, "feather": 0.0}, 1024, 1024)
    assert ((hard > 0) & (hard < 1)).mean() < 0.002  # a hard edge: at most a cell wide


def test_brush_mask_strokes_flow_and_erase():
    paint = {"points": [[0.2, 0.5], [0.8, 0.5]], "radius": 0.05, "hardness": 1.0, "flow": 0.6}
    (adj,) = im.clean_local([{"kind": "brush", "strokes": [paint]}])
    m = im.local_mask(adj, 1024, 1024)
    assert m[512, 512] == pytest.approx(0.6) and m[512, 100] == 0.0 and m[300, 512] == 0.0
    assert m[512 + 45, 512] == pytest.approx(0.6) and m[512 + 60, 512] == 0.0  # hard edge at the radius
    # a second stroke over it adds up like layers of paint, never past 1
    (two,) = im.clean_local([{"kind": "brush", "strokes": [paint, paint]}])
    assert im.local_mask(two, 1024, 1024)[512, 512] == pytest.approx(0.6 + 0.4 * 0.6)
    # erasing through the middle takes it back out
    erase = {"points": [[0.5, 0.3], [0.5, 0.7]], "radius": 0.02, "hardness": 1.0, "flow": 1.0, "erase": True}
    (er,) = im.clean_local([{"kind": "brush", "strokes": [paint, erase]}])
    e = im.local_mask(er, 1024, 1024)
    assert e[512, 512] == 0.0 and e[512, 400] == pytest.approx(0.6)
    # a single dab
    (dab,) = im.clean_local([{"kind": "brush", "strokes": [{"points": [[0.5, 0.5]], "radius": 0.1, "hardness": 0}]}])
    d = im.local_mask(dab, 1024, 1024)
    assert d[512, 512] == pytest.approx(1.0, abs=1e-3) and d[512, 512 + 110] == 0.0 and 0 < d[512, 512 + 50] < 1


def test_mask_grid_is_resolution_independent():
    adj = im.clean_local([RADIAL])[0]
    assert np.array_equal(im.local_mask(adj, 1600, 1066), im.local_mask(adj, 4800, 3198))


# --------------------------------------------------------------------------- develop


def test_no_local_adjustments_is_the_same_develop():
    a = scene(3, 480, 320)
    for extra in ({}, {"angle": 2.0, "crop": [0.1, 0.1, 0.9, 0.8]}):
        plain = im.develop(a, im.Params.from_dict({"strength": 0.5, **extra}))
        assert np.array_equal(plain, im.develop(a, im.Params.from_dict({"strength": 0.5, "local": [], **extra})))


def test_dodge_and_burn_act_where_the_mask_is():
    a = scene(4, 600, 400)
    base = im.develop(a, im.Params())
    lum = lambda x: x.mean(2)  # noqa: E731
    out = im.develop(a, im.Params.from_dict({"local": [RADIAL]}))
    cy, cx = int(0.6 * 400), int(0.35 * 600)
    assert lum(out)[cy, cx] > lum(base)[cy, cx] + 0.05  # dodged in the middle of the ellipse
    assert np.array_equal(out[:40], base[:40]) and np.array_equal(out[:, -60:], base[:, -60:])  # untouched outside
    sky = im.develop(a, im.Params.from_dict({"local": [GRAD]}))
    assert lum(sky)[:40].mean() < lum(base)[:40].mean() - 0.1  # burned in at the top
    assert np.array_equal(sky[200:], base[200:])  # nothing past the end line
    # burning also brings white down (a grad ND on a blown sky); dodging leaves it white
    white = np.ones((100, 150, 3), np.float32)
    p = {"strength": 0, "trim": False, "saturation": -0.1}
    everywhere = {"kind": "graduated", "exposure": -1, "start": [0.5, -0.9], "end": [0.5, -1]}
    assert im.develop(white, im.Params.from_dict({**p, "local": [everywhere]})).max() < 0.4
    assert im.develop(white, im.Params.from_dict({**p, "local": [{**RADIAL, "rx": 2, "ry": 2}]})).min() > 0.99


@pytest.mark.parametrize("angle", [0.0, 3.0])
def test_masks_stay_on_the_picture_through_the_crop(angle):
    """The crop cuts the developed picture; the local adjustment stays on the same pixels."""
    a = scene(5, 600, 400)
    local = [RADIAL, GRAD, BRUSH]
    whole = im.develop(a, im.Params.from_dict({"angle": angle, "local": local}))
    crop = [0.2, 0.15, 0.85, 0.9]
    cut = im.develop(a, im.Params.from_dict({"angle": angle, "crop": crop, "local": local}))
    t, b, l, r = im.crop_box(*whole.shape[:2], crop)
    assert np.array_equal(cut, whole[t:b, l:r])


def test_masks_stay_on_the_picture_when_straightened():
    """Straightening turns the picture; the dodged spot turns with it, it doesn't stay on screen."""
    a = np.full((400, 600, 3), 0.3, np.float32)
    dot = [{"kind": "radial", "exposure": 1.0, "center": [0.75, 0.5], "rx": 0.04, "ry": 0.04, "feather": 0.2}]
    p = dict(strength=0.0, trim=False, local=dot)

    def spot(angle):
        out = im.develop(a, im.Params.from_dict({**p, "angle": angle})).mean(2)
        ys, xs = np.nonzero(out > out.min() + 0.2)
        return xs.mean(), ys.mean()

    x0, y0 = spot(0.0)
    x1, y1 = spot(8.0)
    # the point (0.75, 0.5) of the picture, turned 8° clockwise about the centre and zoomed
    th = np.deg2rad(8.0)
    scale = np.cos(th) + np.sin(th) * 1.5
    dx, dy = x0 - 299.5, y0 - 199.5
    want = 299.5 + scale * (np.cos(th) * dx - np.sin(th) * dy), 199.5 + scale * (np.sin(th) * dx + np.cos(th) * dy)
    assert abs(x1 - want[0]) < 1.5 and abs(y1 - want[1]) < 1.5, ((x1, y1), want)
    assert y1 > y0 + 10  # it moved down with the picture's right side


def test_same_look_at_proxy_and_full_resolution():
    a = scene(6, 1500, 1000)
    p = im.Params.from_dict({"angle": -2.0, "crop": [0.05, 0.1, 0.95, 0.9], "local": [RADIAL, GRAD, BRUSH]})
    full = im.develop(a, p)
    small = im.develop(np.asarray(Image.fromarray((a * 255 + 0.5).astype(np.uint8)).resize((750, 500), Image.LANCZOS),
                                  np.float32) / 255, p)
    down = np.asarray(Image.fromarray((full * 255 + 0.5).astype(np.uint8)).resize(small.shape[1::-1], Image.LANCZOS),
                      np.float32) / 255
    plain = im.develop(a, im.Params.from_dict({"angle": -2.0, "crop": [0.05, 0.1, 0.95, 0.9]}))
    changed = np.abs(full - plain).mean()
    assert changed > 0.03
    assert np.abs(down - small).mean() < 0.012  # the difference is resampling, not where the masks are


def test_turn_local_follows_quarter_turns():
    local = im.clean_local([RADIAL, GRAD, BRUSH])
    assert im.turn_local(local, 0) == local and im.turn_local(local, 360) == local
    once = im.turn_local(local, 90)
    assert once[0]["center"] == [0.4, 0.35] and once[0]["angle"] == 115.0
    assert once[1]["start"] == [1.0, 0.5] and once[1]["end"] == [0.6, 0.5]
    assert once[2]["strokes"][0]["points"][0] == [0.2, 0.1]
    assert im.turn_local(once, 270) == local and im.turn_local(im.turn_local(once, 90), 180) == local
    assert local[0]["center"] == [0.35, 0.6]  # not changed in place
    # turning the slide with its masks gives the turned photo
    a = scene(7, 420, 280)
    p = dict(strength=0.0, trim=False)
    before = im.develop(a, im.Params.from_dict({**p, "local": local}))
    after = im.develop(im.rotate_arr(a, 90), im.Params.from_dict({**p, "local": once}))
    assert np.abs(im.rotate_arr(before, 90) - after).mean() < 0.002


# --------------------------------------------------------------------------- keys and API


def test_render_key_leaves_out_an_empty_list():
    g = {"scans": ["a", "b"], "excluded": [], "rotation": 0, "params": im.Params().to_dict()}
    old = {**g, "params": {k: v for k, v in g["params"].items() if k != "local"}}  # a tray from before
    assert store.render_key(g) == store.render_key(old)
    with_local = {**g, "params": im.Params.from_dict({"local": [RADIAL]}).to_dict()}
    assert store.render_key(with_local) != store.render_key(g)
    assert store.tone_key(with_local) == store.tone_key(g)  # the histogram doesn't see them


def preview(api, sid, gid, key):
    r = api.get(f"/api/sessions/{sid}/groups/{gid}/preview.jpg?size=400&v={key}")
    assert r.status_code == 200
    return np.asarray(Image.open(io.BytesIO(r.content))).astype(np.float32) / 255


def test_api_local_adjustments(api, tray):
    sid, d = tray
    g0, g1 = d["groups"][0], d["groups"][1]
    url = f"/api/sessions/{sid}/groups/{g0['id']}"
    before = preview(api, sid, g0["id"], g0["key"])
    g = api.patch(url, json={"params": {"local": [RADIAL, {"kind": "junk"}]}}).json()["groups"][0]
    assert [a["kind"] for a in g["params"]["local"]] == ["radial"] and g["key"] != g0["key"] and g["can_undo"]
    assert g["tone_key"] == g0["tone_key"]
    after = preview(api, sid, g0["id"], g["key"])
    assert np.abs(after - before).mean() > 0.005

    # a quarter turn takes the masks along
    g = api.patch(url, json={"rotation": 90}).json()["groups"][0]
    assert g["params"]["local"][0]["center"] == [0.4, 0.35]
    g = api.patch(url, json={"rotation": 0}).json()["groups"][0]
    assert g["params"]["local"][0]["center"] == [0.35, 0.6]

    # apply to the rest, presets and "develop like" carry colour, never local adjustments
    api.patch(f"/api/sessions/{sid}/groups/{g1['id']}", json={"params": {"local": [GRAD]}})
    d = api.post(f"/api/sessions/{sid}/apply", json={"params": g["params"], "scope": "rest", "from": g0["id"],
                                                     "as_default": True}).json()
    assert [a["kind"] for a in d["groups"][1]["params"]["local"]] == ["graduated"]
    assert all(not x["params"]["local"] for x in d["groups"][2:]) and d["defaults"]["local"] == []
    saved = api.post("/api/presets", json={"name": "Local test", "session": sid, "group": g0["id"]}).json()
    assert "local" not in next(p for p in saved["presets"] if p["name"] == "Local test")["params"]
    like = {"like": {"session": sid, "group": g0["id"]}}
    d = api.post(f"/api/sessions/{sid}/groups/{g1['id']}/look", json=like).json()
    assert [a["kind"] for a in d["groups"][1]["params"]["local"]] == ["graduated"]
    api.delete("/api/presets/Local test")

    # undo steps back through them; an empty list is the key of before
    g = api.post(f"{url}/undo").json()["groups"][0]  # the turn back
    g = api.post(f"{url}/undo").json()["groups"][0]  # the turn
    g = api.post(f"{url}/undo").json()["groups"][0]  # adding it
    assert g["params"].get("local", []) == [] and g["key"] == g0["key"]
    g = api.patch(url, json={"params": {"local": []}}).json()["groups"][0]
    assert g["key"] == g0["key"]
