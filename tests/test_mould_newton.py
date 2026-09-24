"""Mould and Newton ring repair: the pixel functions on synthetic damage (the error against the
clean picture drops a lot, legitimate detail that looks alike stays), the params and keys, and the
API. Parity with the TypeScript and Swift ports is pinned by the golden fixtures
(apple/SlideKit/Tests/make_golden.py)."""
from __future__ import annotations

import numpy as np
import pytest

from slidestation import imaging as im
from slidestation import store

from conftest import new_tray
from test_mount_dust import smooth


def stamp(al: np.ndarray, cx: float, cy: float, rad: float, v: float = 1.0) -> None:
    """An anti-aliased disc into the alpha map (max)."""
    h, w = al.shape
    x0, x1 = int(max(0, cx - rad - 2)), int(min(w, cx + rad + 3))
    y0, x1b, y1 = int(max(0, cy - rad - 2)), x1, int(min(h, cy + rad + 3))
    if x0 >= x1b or y0 >= y1:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1b]
    d = np.clip(rad + 0.5 - np.hypot(xx - cx, yy - cy), 0, 1) * v
    al[y0:y1, x0:x1b] = np.maximum(al[y0:y1, x0:x1b], d)


def mouldy(clean: np.ndarray, colonies: int = 14, seed: int = 4) -> np.ndarray:
    """Mould colonies: a ragged blotch with a coloured rim and branching filaments running out of
    it (0.5-2 mm across at 36 mm film), lighter or darker than the picture."""
    rng = np.random.default_rng(seed)
    a = clean.astype(np.float32).copy()
    h, w = a.shape[:2]
    s = max(h, w) / 1600
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    for _ in range(colonies):
        cx, cy = w * (0.08 + 0.84 * rng.random()), h * (0.08 + 0.84 * rng.random())
        light = rng.random() < 0.6
        col = np.array([0.88, 0.86, 0.72] if light else [0.2, 0.24, 0.16], np.float32)
        al = np.zeros((h, w), np.float32)
        for _ in range(rng.integers(3, 7)):  # filaments, wandering and forking
            walks = [(cx, cy, rng.random() * 2 * np.pi, (15 + 30 * rng.random()) * s)]
            while walks:
                px, py, th, length = walks.pop()
                rad = (0.6 + 0.6 * rng.random()) * s
                for _ in range(int(length / s * 2)):  # half a proxy pixel a step
                    th += rng.normal(0, 0.12)
                    px, py = px + 0.5 * s * np.cos(th), py + 0.5 * s * np.sin(th)
                    stamp(al, px, py, rad)
                    if rng.random() < 0.02 and length > 8 * s:
                        walks.append((px, py, th + rng.choice([-1, 1]) * (0.5 + rng.random()), length * 0.5))
        r0 = (3 + 5 * rng.random()) * s  # the blotch: a ragged disc
        ang = np.arctan2(y - cy, x - cx)
        rr = r0 * (1 + 0.35 * np.sin(3 * ang + rng.random() * 6) + 0.2 * np.sin(7 * ang + rng.random() * 6))
        dist = np.hypot(x - cx, y - cy)
        al = np.maximum(al, np.clip(rr + 0.5 - dist, 0, 1))
        k = 0.35 + 0.3 * rng.random()
        a = a * (1 - k * al[..., None]) + col * k * al[..., None]
        halo = np.clip(1 - np.abs(dist - rr * 1.6) / (1.5 * s), 0, 1) * (dist < 30 * s)
        a = a + (np.array([0.05, -0.03, 0.04], np.float32) * halo[..., None])  # a magenta rim
    return np.clip(a, 0, 1).astype(np.float32)


def tree(w: int = 1600, h: int = 1067, seed: int = 5) -> np.ndarray:
    """A bare tree against a graded sky, twigs tapering down to a pixel: branching, dark, thin —
    looks like mould filaments, but joined up into one big shape."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    sky = np.stack([0.45 + 0.2 * y / h, 0.6 + 0.15 * y / h, 0.9 - 0.1 * y / h], -1)
    sky = sky + rng.normal(0, 0.008, sky.shape)
    s = max(h, w) / 1600
    al = np.zeros((h, w), np.float32)

    def branch(px, py, th, length, rad):
        steps = int(length * 2)
        for i in range(steps):
            r = rad * (1 - 0.3 * i / steps)
            px, py = px + 0.5 * np.cos(th), py + 0.5 * np.sin(th)
            stamp(al, px, py, r)
        if rad > 0.6 * s:
            for turn in (-1, 1):
                branch(px, py, th + turn * (0.35 + 0.3 * rng.random()), length * (0.62 + 0.15 * rng.random()), rad * 0.68)

    branch(w * 0.5, h * 1.0, -np.pi / 2, 330 * s, 14 * s)
    col = np.array([0.18, 0.14, 0.1], np.float32)
    return np.clip(sky * (1 - al[..., None]) + col * al[..., None], 0, 1).astype(np.float32)


RING_CENTRE = (0.35, 0.4)  # of the frame's width and height


def ring_radius(h: int, w: int) -> np.ndarray:
    """Distance from the rings' centre, in proxy pixels."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    return np.hypot(x - w * RING_CENTRE[0], y - h * RING_CENTRE[1]) / (max(h, w) / 1600)


def rings(clean: np.ndarray, amp: float = 0.05) -> np.ndarray:
    """Newton rings: concentric fringes, their period falling from ~80 to ~10 proxy pixels
    outwards, each channel at its own wavelength (the rainbow), fading out over half the picture."""
    rho = ring_radius(*clean.shape[:2])
    phase = rho * rho / 1300  # period 8168 / rho
    env = np.exp(-((rho / 420) ** 2))
    fr = np.stack([np.cos(phase * 550 / lam) for lam in (620, 550, 460)], -1)
    return np.clip(clean + amp * env[..., None] * fr, 0, 1).astype(np.float32)


def grained(w: int, h: int, seed: int = 9) -> np.ndarray:
    return (smooth(w, h) + np.random.default_rng(seed).normal(0, 0.012, (h, w, 3))).astype(np.float32)


def low_error(a: np.ndarray, clean: np.ndarray) -> float:
    """Mean error against the clean picture once grain-sized differences are blurred away: a fill
    is right when it carries grain, not the same grain."""
    return float(np.abs(im._blur((a.astype(np.float64) - clean).mean(-1), 2)).mean())


def shapes(w: int = 1600, h: int = 1067) -> np.ndarray:
    """Small solid discs and thin bars: picture, however mould-sized."""
    a = smooth(w, h)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    for cx, cy, r in [(300, 300, 30), (800, 500, 15), (600, 200, 8), (1200, 300, 12)]:
        a[(x - cx) ** 2 + (y - cy) ** 2 < r * r] = [0.9, 0.2, 0.1]
    a[500:506, 100:400] = 0.05
    a[700:760, 900:903] = 0.95
    return a


def foliage(w: int = 1600, h: int = 1067, seed: int = 7) -> np.ndarray:
    """Thousands of overlapping leaves: texture, not mould."""
    rng = np.random.default_rng(seed)
    al = np.zeros((h, w), np.float32)
    for _ in range(3000):
        stamp(al, w * (0.12 + 0.45 * rng.random()), h * (0.28 + 0.47 * rng.random()), 2 + 4 * rng.random())
    col = np.array([0.1, 0.3, 0.1], np.float32)
    return (smooth(w, h) * (1 - al[..., None]) + col * al[..., None]).astype(np.float32)


def stripes(w: int = 1600, h: int = 1067) -> np.ndarray:
    """A striped awning: contrast 0.4, a 14 px period — periodic, but picture."""
    a = grained(w, h)
    x = np.arange(w, dtype=np.float32)
    a[200:600, 300:900] = (0.5 + 0.2 * np.sign(np.sin(x[300:900] * 2 * np.pi / 14)))[None, :, None]
    return a


# --------------------------------------------------------------------------- mould


@pytest.mark.parametrize("size", [(1600, 1067), (3200, 2133)])
def test_mould_removed(size):
    """Colonies on a grainy picture: the error against the clean picture drops more than tenfold,
    at proxy size and at full resolution (found on the proxy, filled at full size), the fill
    carries grain (it is not flat) and nothing else changes."""
    clean = grained(*size)
    d = mouldy(clean)
    out = im.repair_mould(d, 0.6)
    before, after = low_error(d, clean), low_error(out, clean)
    assert after < before / 10, (before, after)
    assert out is not d and np.array_equal(d, mouldy(clean))  # the caller's pixels stay
    m = im._verdicts(im.mould_mask(im.shrink(d, im.DUST_EDGE), 0.6)[0], *d.shape[:2])
    assert out[m].std(0).mean() > 0.5 * clean[m].std(0).mean()  # grain in the fill
    assert np.array_equal(out[~m], d[~m])


@pytest.mark.parametrize("scene_fn", [tree, shapes, foliage, stripes])
def test_mould_leaves_picture_alone(scene_fn):
    """Look-alikes of mould that are picture: a bare tree (branching, dark, thin — but one shape
    with its trunk), small solid discs and thin bars, dense leaves, stripes."""
    a = scene_fn()
    for amount in (0.3, 1.0):
        assert not im.mould_mask(a, amount)[0].any(), amount
        assert im.repair_mould(a, amount) is a


def test_mould_off_is_a_no_op():
    a = mouldy(grained(400, 300))
    assert im.repair_mould(a, 0) is a
    assert np.array_equal(im.develop(a, im.Params()), im.develop(a, im.Params(mould=0.0)))
    assert not np.array_equal(im.develop(a, im.Params(mould=0.8)), im.develop(a, im.Params()))


# --------------------------------------------------------------------------- Newton rings


@pytest.mark.parametrize("size", [(1600, 1067), (3200, 2133)])
def test_newton_rings_removed(size):
    """Rainbow rings over half a grainy picture: the error against the clean picture (the same
    grain, so any difference is ring or harm) drops more than twofold overall and fivefold where
    the rings are 25-80 px apart. The widest in the middle are broader than the band on purpose
    (broader than that is picture); the finest, faint at the rim, are left partly."""
    clean = grained(*size)
    d = rings(clean)
    out = im.repair_newton(d, 0.6)
    err = lambda a, m=...: float(np.abs(a.astype(np.float64) - clean)[m].mean())  # noqa: E731
    assert err(out) < err(d) / 2.2, (err(d), err(out))
    rho = ring_radius(*clean.shape[:2])
    part = (rho > 100) & (rho < 300)
    assert err(out, part) < err(d, part) / 5, (err(d, part), err(out, part))
    assert out is not d and np.array_equal(d, rings(clean))
    hp = lambda a: a - im._blur(a.astype(np.float64), 1)  # noqa: E731
    assert hp(out).std() > 0.95 * hp(clean).std()  # the finest grain is not blurred away


@pytest.mark.parametrize("scene_fn", [tree, shapes, foliage, stripes, grained])
def test_newton_leaves_picture_alone(scene_fn):
    """Edges of soft shapes, twigs, leaves, high-contrast stripes and plain grain are not rings."""
    a = scene_fn(1600, 1067)
    for amount in (0.3, 1.0):
        d = np.abs(im.repair_newton(a, amount) - a)
        assert d.mean() < 6e-4, (amount, d.mean())


def test_newton_off_is_a_no_op():
    a = rings(grained(400, 300))
    assert im.repair_newton(a, 0) is a
    assert np.array_equal(im.develop(a, im.Params()), im.develop(a, im.Params(newton=0.0)))
    assert not np.array_equal(im.develop(a, im.Params(newton=0.8)), im.develop(a, im.Params()))


# --------------------------------------------------------------------------- params, keys, API


def test_params_and_keys():
    for k in ("mould", "newton"):
        assert getattr(im.Params.from_dict({k: 3}), k) == 1.0
        assert getattr(im.Params.from_dict({k: -1}), k) == 0.0
    g = {"scans": ["a"], "excluded": [], "rotation": 0, "params": im.Params().to_dict()}
    old = dict(g, params={k: v for k, v in g["params"].items() if k not in ("mould", "newton")})  # from before
    assert store.render_key(g) == store.render_key(old)
    assert store.tone_key(g) == store.tone_key(old)
    keys = set()
    for p in ({"mould": 0.4}, {"newton": 0.4}, {"dust": 0.4}, {"mould": 0.4, "newton": 0.4}):
        on = dict(g, params={**g["params"], **p})
        keys.add((store.render_key(on), store.tone_key(on)))
    assert len(keys) == 4 and (store.render_key(g), store.tone_key(g)) not in keys


def test_mould_and_newton_through_the_api(api, tmp_path):
    sid, d = new_tray(api, tmp_path / "scans", slides=1)
    g = d["groups"][0]
    assert g["params"]["mould"] == 0.0 and g["params"]["newton"] == 0.0
    url = f"/api/sessions/{sid}/groups/{g['id']}"
    g2 = api.patch(url, json={"params": {"mould": 0.5, "newton": 0.7}}).json()["groups"][0]
    assert g2["params"]["mould"] == 0.5 and g2["params"]["newton"] == 0.7
    assert g2["key"] != g["key"] and g2["tone_key"] != g["tone_key"]
    assert api.get(f"{url}/preview.jpg?size=1600").status_code == 200
    assert api.get(f"{url}/histogram").status_code == 200
