"""Mount detection & straighten-to-mount, and dust & scratch repair: the pixel functions on
synthetic scans (a mount turned by known angles, specks on a smooth picture) and the API around
them (found at import, lazily for older trays, applied with undo; dust in the render key only when
on)."""
from __future__ import annotations

import io
import json

import numpy as np
import pytest
from PIL import Image

from conftest import new_tray
from slidestation import imaging as im
from slidestation import store
from synthetic import in_mount, scene


def jpeg(a: np.ndarray, quality: int = 88) -> np.ndarray:
    buf = io.BytesIO()
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(buf, "JPEG", quality=quality)
    return np.asarray(Image.open(buf)).astype(np.float32) / 255


# --------------------------------------------------------------------------- mount


@pytest.mark.parametrize("angle", [-5, -3, -1.5, -0.5, 0.5, 1, 2.5, 5])
def test_detect_mount_angle(angle):
    """A slide turned in the scanner by a known angle: found within 0.2°, confidently."""
    a = jpeg(in_mount(scene(int(abs(angle) * 10) + 3, 1200, 800), angle, seed=int(abs(angle) * 10)))
    m = im.detect_mount(a)
    assert abs(m["angle"] - angle) < 0.2, m
    assert m["confidence"] >= im.MOUNT_AUTO, m
    l, t, r, b = m["box"]  # the window is 86 % x 84 % of the scan, centred
    assert abs(l - 0.07) < 0.01 and abs(r - 0.93) < 0.01 and abs(t - 0.08) < 0.01 and abs(b - 0.92) < 0.01


def test_detect_mount_other_sizes_and_a_dark_patch():
    """Proxy and thumbnail sizes, and a dark part of the picture touching the mount."""
    for w, h in [(1600, 1067), (480, 320)]:
        pic = scene(21, w, h)
        pic[h // 3 : h // 2, : w // 4] = 0.06
        m = im.detect_mount(jpeg(in_mount(pic, -2.2)))
        assert abs(m["angle"] + 2.2) < 0.2 and m["confidence"] >= im.MOUNT_SUGGEST, (w, m)


def test_no_mount_no_suggestion():
    assert im.detect_mount(scene(5, 1200, 800))["confidence"] == 0
    # a dark bar along one edge is not a mount (one side can't give a confident angle)
    a = scene(6, 1200, 800)
    a[:60] = 0.03
    assert im.detect_mount(a)["confidence"] < im.MOUNT_SUGGEST


def test_rotate_box():
    box = [0.1, 0.2, 0.85, None]
    assert im.rotate_box(box, 90) == [None, 0.1, 0.8, 0.85]
    assert im.rotate_box(im.rotate_box(box, 90), 270) == box
    assert im.rotate_box(box, 360) == box


@pytest.mark.parametrize("rot", [0, 90, 270])
def test_mount_crop_trims_to_the_window(rot):
    """Straightened by -angle and cropped by mount_crop, no mount is left along any edge."""
    a = jpeg(in_mount(scene(8, 1200, 800), 1.2))
    m = im.detect_mount(a)
    a = im.rotate_arr(a, rot)
    p = im.Params(angle=-m["angle"])
    p.crop = im.mount_crop(a, p, im.rotate_box(m["box"], rot))
    assert p.crop is not None
    out = im.develop(a, p).mean(2)
    edges = np.concatenate([out[0], out[-1], out[:, 0], out[:, -1]])
    assert (edges < 0.08).mean() < 0.01, (edges < 0.08).mean()
    # and it keeps nearly the whole window: the mount was 7-8 % in from each side
    plain = im.develop(a, im.Params(angle=-m["angle"]))
    assert out.size > 0.9 * plain[..., 0].size


# --------------------------------------------------------------------------- dust


def smooth(w: int, h: int, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    a = np.stack([0.5 + 0.3 * np.sin(x / w * 3 + 1), 0.45 + 0.25 * np.cos(y / h * 4),
                  0.4 + 0.2 * np.sin((x + y) / (w + h) * 5)], -1)
    return (a + rng.normal(0, 0.008, a.shape)).astype(np.float32)


def dirty(clean: np.ndarray, specks: int = 150, seed: int = 2) -> np.ndarray:
    """Dark dust and bright specks (1.5-5 proxy pixels across) and two thin bright scratches."""
    rng = np.random.default_rng(seed)
    a = clean.copy()
    h, w = a.shape[:2]
    s = max(h, w) / 1600
    for _ in range(specks):
        cx, cy, r = rng.random() * w, rng.random() * h, (0.8 + rng.random() * 1.7) * s
        x0, x1, y0, y1 = int(max(0, cx - r - 2)), int(min(w, cx + r + 3)), int(max(0, cy - r - 2)), int(min(h, cy + r + 3))
        yy, xx = np.mgrid[y0:y1, x0:x1]
        al = np.clip(r + 0.5 - np.hypot(xx - cx, yy - cy), 0, 1)[..., None]
        a[y0:y1, x0:x1] = a[y0:y1, x0:x1] * (1 - al) + (0.03 if rng.random() < 0.7 else 0.97) * al
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    for k in range(2):
        d = np.abs((y - h * (0.3 + 0.4 * k)) - 0.35 * (x - w * 0.2)) / np.hypot(1, 0.35)
        al = np.clip(0.6 * s + 0.5 - d, 0, 1) * ((x > w * 0.2) & (x < w * 0.7))
        a = a * (1 - 0.9 * al[..., None]) + 0.95 * 0.9 * al[..., None]
    return a.astype(np.float32)


@pytest.mark.parametrize("size", [(1600, 1067), (3200, 2133)])
def test_dust_and_scratches_removed(size):
    """Specks and scratches on a smooth picture: the error against the clean picture drops a lot,
    at proxy size and at full resolution (found on the proxy, filled at full size)."""
    clean = smooth(*size)
    d = dirty(clean)
    out = im.repair_dust(d, 0.6)
    before, after = np.abs(d - clean).mean(), np.abs(out - clean).mean()
    assert after < before / 8, (before, after)
    assert np.abs(out - clean).max(-1).mean() < 0.001
    assert out is not d and np.array_equal(d, dirty(clean))  # the caller's pixels stay


def test_dust_leaves_detail_alone():
    """Fine texture (a grating with grain) and the edges of shapes come through untouched."""
    h, w = 800, 1200
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    tex = 0.5 + 0.25 * np.sin(x * 2.1) * np.sin(y * 1.7)
    tex = np.clip(np.stack([tex, tex * 0.9, tex * 0.8], -1) + np.random.default_rng(3).normal(0, 0.03, (h, w, 3)), 0, 1)
    tex = tex.astype(np.float32)
    assert np.abs(im.repair_dust(tex, 1.0) - tex).mean() < 1e-4
    a = smooth(w, h)
    for cx, cy, r in [(300, 300, 80), (800, 500, 150), (600, 200, 40)]:
        a[(x - cx) ** 2 + (y - cy) ** 2 < r * r] = [0.9, 0.2, 0.1]
    a[500:520, 100:700] = 0.05  # a 20 px bar is picture, not a scratch
    assert np.abs(im.repair_dust(a, 1.0) - a).mean() < 1e-4


def test_dust_off_is_a_no_op():
    a = dirty(smooth(400, 300))
    assert im.repair_dust(a, 0) is a
    assert np.array_equal(im.develop(a, im.Params()), im.develop(a, im.Params(dust=0.0)))
    assert not np.array_equal(im.develop(a, im.Params(dust=0.5)), im.develop(a, im.Params()))


def test_dust_param_and_keys():
    assert im.Params.from_dict({"dust": 3}).dust == 1.0
    assert im.Params.from_dict({"dust": -1}).dust == 0.0
    g = {"scans": ["a"], "excluded": [], "rotation": 0, "params": im.Params().to_dict()}
    old = dict(g, params={k: v for k, v in g["params"].items() if k != "dust"})  # before dust existed
    assert store.render_key(g) == store.render_key(old)
    assert store.tone_key(g) == store.tone_key(old)
    on = dict(g, params={**g["params"], "dust": 0.4})
    assert store.render_key(on) != store.render_key(g)
    assert store.tone_key(on) != store.tone_key(g)


# --------------------------------------------------------------------------- API


def slides(api, sid) -> list[dict]:
    return api.get(f"/api/sessions/{sid}").json()["groups"]


def test_import_finds_mounts_and_straightens_confident_ones(api, tmp_path):
    sid, d = new_tray(api, tmp_path / "scans", slides=3, size=(480, 320), mounts=[2.0, None, -0.05])
    g0, g1, g2 = d["groups"]
    assert abs(g0["mount"]["angle"] - 2.0) < 0.2 and g0["mount"]["confidence"] >= im.MOUNT_AUTO
    assert g0["params"]["angle"] == -g0["mount"]["angle"]  # confident: straightened by itself
    assert g1["mount"]["confidence"] == 0 and g1["params"]["angle"] == 0
    assert abs(g2["mount"]["angle"]) < 0.2 and g2["params"]["angle"] == 0  # level already: left alone


def test_mount_lazily_for_older_trays_then_apply_and_undo(api, tmp_path):
    sid, d = new_tray(api, tmp_path / "scans", slides=1, size=(480, 320), mounts=[-1.6])
    gid = d["groups"][0]["id"]
    # a tray from before mount detection: no mount, not straightened
    f = store.library() / "sessions" / sid / "session.json"
    data = json.loads(f.read_text())
    data["groups"][0].pop("mount")
    data["groups"][0]["params"]["angle"] = 0.0
    f.write_text(json.dumps(data))
    g = slides(api, sid)[0]
    assert g["mount"] is None
    key = g["key"]
    g = next(x for x in api.post(f"/api/sessions/{sid}/groups/{gid}/mount", json={}).json()["groups"])
    assert abs(g["mount"]["angle"] + 1.6) < 0.2 and g["params"]["angle"] == 0 and g["key"] == key  # found, not applied
    g = api.post(f"/api/sessions/{sid}/groups/{gid}/mount", json={"apply": True, "trim": True}).json()["groups"][0]
    assert g["params"]["angle"] == -g["mount"]["angle"] and g["params"]["crop"] and g["can_undo"]
    assert api.get(f"/api/sessions/{sid}/groups/{gid}/preview.jpg?size=400").status_code == 200
    g = api.post(f"/api/sessions/{sid}/groups/{gid}/undo").json()["groups"][0]
    assert g["params"]["angle"] == 0 and g["params"]["crop"] is None and g["key"] == key


def test_mount_needs_a_mount(api, tmp_path):
    sid, d = new_tray(api, tmp_path / "scans", slides=1)
    gid = d["groups"][0]["id"]
    r = api.post(f"/api/sessions/{sid}/groups/{gid}/mount", json={"apply": True})
    assert r.status_code == 400


def test_dust_through_the_api(api, tmp_path):
    sid, d = new_tray(api, tmp_path / "scans", slides=1)
    g = d["groups"][0]
    assert g["params"]["dust"] == 0.0
    url = f"/api/sessions/{sid}/groups/{g['id']}"
    g2 = next(x for x in api.patch(url, json={"params": {"dust": 0.5}}).json()["groups"])
    assert g2["params"]["dust"] == 0.5 and g2["key"] != g["key"] and g2["tone_key"] != g["tone_key"]
    assert api.get(f"{url}/preview.jpg?size=1600").status_code == 200
    assert api.get(f"{url}/histogram").status_code == 200
