"""Film stock: per slide and per tray, the guess from the fade signature (heuristic, then k-NN over
your labels), per-stock learning, and the stock's era as a dating hint.

Run: uv run --python 3.12 pytest tests/test_filmstock.py -q
"""
from __future__ import annotations

import json

import numpy as np
import pytest
from PIL import Image

from conftest import new_tray
from slidestation import filmstock, learning, store
from slidestation import workflow as wf

# the black and white point each channel ends up at: dense and neutral / faded to red-magenta with
# lifted blacks / faded to cyan-green
FADES = {
    "kodachrome": ([0.01, 0.01, 0.015], [0.95, 0.94, 0.93]),
    "ektachrome": ([0.14, 0.07, 0.12], [0.92, 0.66, 0.8]),
    "agfachrome": ([0.07, 0.11, 0.12], [0.68, 0.86, 0.84]),
}


def picture(seed: int, w: int = 240, h: int = 160) -> np.ndarray:
    """A made-up scene 0..1 with everyday (half-desaturated) colours, a shadow and a highlight."""
    rng = np.random.default_rng(seed)
    coarse = rng.random((4, 6, 3)).astype(np.float32)
    coarse = 0.5 * coarse + 0.5 * coarse.mean(2, keepdims=True)
    a = np.asarray(Image.fromarray((coarse * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255
    a = (a - a.min()) / (a.max() - a.min())
    a[: h // 6, : w // 5] *= 0.05
    a[-h // 8:, -w // 6:] = 0.97 + 0.03 * a[-h // 8:, -w // 6:]
    return a


def faded(stock: str, seed: int) -> list[float]:
    lo, hi = (np.array(x, np.float32) for x in FADES[stock])
    return learning.features(lo + picture(seed) * (hi - lo))


@pytest.fixture(autouse=True)
def _fresh_labels():
    (store.library() / "stocks.json").unlink(missing_ok=True)
    filmstock._labels = None
    yield
    (store.library() / "stocks.json").unlink(missing_ok=True)
    filmstock._labels = None


def set_feats(sid: str, feats: list[list[float]]) -> None:
    def fn(s):
        for g, f in zip(s.data["groups"], feats):
            g["feat"] = f

    wf.update_session(sid, fn)


def get(api, sid):
    return api.get(f"/api/sessions/{sid}").json()


def post(api, url, **body):
    r = api.post(url, json=body)
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- the heuristic


def test_heuristic_reads_the_fade_signature():
    for stock in FADES:
        for seed in range(6):
            p = filmstock.heuristic(faded(stock, seed))
            assert max(p.values()) <= filmstock.HEURISTIC_TRUST
            if stock != "kodachrome":  # a red scene on Kodachrome can look faded on its own (the tray decides)
                assert max(p, key=p.get) == stock, (stock, seed, p)
    # a tray of them: the tray's average decides even the slide that looks like something else
    for stock in FADES:
        d = {"groups": [{"id": str(i), "feat": faded(stock, i)} for i in range(6)]}
        sug = filmstock.stock_suggestions(d, filmstock.Labels(store.library() / "none.json"))
        offered = [s for s in sug if s]
        assert {s["value"] for s in offered} == {stock}, (stock, sug)
        # a dye that faded is the clearer sign; Kodachrome is "nothing faded", often below the bar
        assert len(offered) == 6 or (stock == "kodachrome" and offered)
        assert all(filmstock.SUGGEST_FROM <= s["confidence"] <= filmstock.HEURISTIC_TRUST for s in offered)
        assert {s["source"] for s in offered} == {"fade-heuristic"}


def test_no_signature_no_suggestion():
    grey = learning.features(np.full((100, 150, 3), 0.5, np.float32))  # flat, no contrast, no cast
    d = {"groups": [{"id": "a", "feat": grey}]}
    assert filmstock.stock_suggestions(d, filmstock.Labels(store.library() / "none.json")) == [None]


# --------------------------------------------------------------------------- per slide, per tray, API


def test_stock_per_slide_and_tray(api, tmp_path):
    sid, d = new_tray(api, tmp_path / "scans")
    assert d["stock"] == "" and all(g["stock"] == "" for g in d["groups"])
    gid = d["groups"][1]["id"]
    assert api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"stock": "velvia"}).status_code == 400
    assert api.patch(f"/api/sessions/{sid}", json={"stock": "nope"}).status_code == 400
    d = api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"stock": "Kodachrome"}).json()
    assert d["groups"][1]["stock"] == "kodachrome"
    d = api.patch(f"/api/sessions/{sid}", json={"stock": "agfachrome"}).json()
    assert d["stock"] == "agfachrome"
    # slides with a stock (own or the tray's) get no guess
    assert all(not (g["insights"] or {}).get("stock") for g in d["groups"])
    d = api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"stock": ""}).json()
    assert d["groups"][1]["stock"] == ""
    assert store.Session(sid).data["groups"][1].get("stock") is None
    # labels: every slide with a known stock and features (the tray's counts)
    lab = json.loads((store.library() / "stocks.json").read_text())["examples"]
    assert {e["s"] for e in lab} == {"agfachrome"} and len(lab) == 4
    # "unknown" on a slide doesn't take the tray's, and is no label
    d = api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"stock": "unknown"}).json()
    assert filmstock.effective(store.Session(sid).data, store.Session(sid).group(gid)) == "unknown"
    assert len(json.loads((store.library() / "stocks.json").read_text())["examples"]) == 3
    # splitting a slide keeps its film on both halves
    two = next(g for g in d["groups"] if len(g["scans"]) == 2)
    api.patch(f"/api/sessions/{sid}/groups/{two['id']}", json={"stock": "fujichrome"})
    d = post(api, f"/api/sessions/{sid}/groups/{two['id']}/split", scan=two["scans"][1])
    assert [g["stock"] for g in d["groups"]].count("fujichrome") == 2


def test_suggestion_accept_dismiss_propagate(api, tmp_path):
    sid, d = new_tray(api, tmp_path / "scans")
    set_feats(sid, [faded("ektachrome", i) for i in range(4)])
    d = get(api, sid)
    sug = [g["insights"]["stock"] for g in d["groups"]]
    assert all(s["value"] == "ektachrome" and s["state"] == "suggested" for s in sug)
    assert "stock" not in (store.Session(sid).data["groups"][0].get("insights") or {})  # live, not stored
    g0, g1 = d["groups"][0]["id"], d["groups"][1]["id"]
    d = post(api, f"/api/sessions/{sid}/insights/decide", kind="stock", action="accept", groups=[g0])
    assert d["decided"] == 1 and d["groups"][0]["stock"] == "ektachrome"
    assert d["groups"][0]["insights"]["stock"]["state"] == "accepted"
    d = post(api, f"/api/sessions/{sid}/insights/decide", kind="stock", action="dismiss", groups=[g1])
    assert d["groups"][1]["insights"]["stock"]["state"] == "dismissed" and d["groups"][1]["stock"] == ""
    d = get(api, sid)
    assert d["groups"][1]["insights"]["stock"]["state"] == "dismissed"  # stays away
    # propagate "ektachrome" to 1..4: sets it everywhere (the dismissed slide too: that's an explicit range)
    d = post(api, f"/api/sessions/{sid}/insights/propagate", kind="stock", value="ektachrome", **{"from": g0},
             to=d["groups"][3]["id"])
    assert d["applied"] == 4 and [g["stock"] for g in d["groups"]] == ["ektachrome"] * 4
    assert d["groups"][2]["insights"]["stock"]["state"] == "accepted"
    assert api.post(f"/api/sessions/{sid}/insights/propagate",
                    json={"kind": "stock", "value": "x", "from": g0, "to": g0}).status_code == 400


def test_knn_takes_over_from_enough_labels(api, tmp_path):
    lab = filmstock.labels()
    for i in range(5):
        lab.remember(f"x:k{i}", faded("kodachrome", 10 + i), "kodachrome")
        lab.remember(f"x:a{i}", faded("agfachrome", 10 + i), "agfachrome")
    assert lab.known == ["agfachrome", "kodachrome"]
    p, n = lab.predict(faded("agfachrome", 3))
    assert n == filmstock.K and max(p, key=p.get) == "agfachrome"
    sid, _ = new_tray(api, tmp_path / "scans")
    set_feats(sid, [faded("kodachrome", i) for i in range(4)])
    sug = [g["insights"]["stock"] for g in get(api, sid)["groups"]]
    assert all(s["value"] == "kodachrome" and s["source"].startswith("knn:") for s in sug), sug
    # a stock the k-NN has no labels of isn't forced into one it knows: the heuristic keeps it
    d = {"groups": [{"id": str(i), "feat": faded("ektachrome", i)} for i in range(3)]}
    assert [(s["value"], s["source"]) for s in filmstock.stock_suggestions(d, lab)] == [("ektachrome", "fade-heuristic")] * 3
    # one stock alone isn't enough to tell anything apart
    only = filmstock.Labels(store.library() / "one.json")
    for i in range(8):
        only.remember(f"x:{i}", faded("kodachrome", i), "kodachrome")
    assert only.predict(faded("kodachrome", 1)) == (None, 0)


# --------------------------------------------------------------------------- per-stock learning


def _examples(stock_of, feats, value_of):
    m = learning.Model(path=store.library() / "learn-test.json")
    m.examples = [{"key": f"t:{i}", "f": f, "p": {"strength": value_of(i)}, "trim": True, "t": 0,
                   **({"s": stock_of(i)} if stock_of(i) else {})} for i, f in enumerate(feats)]
    m._fit()
    return m


def test_learning_prefers_the_same_stock():
    base = np.array(faded("ektachrome", 1))
    rng = np.random.default_rng(3)
    feats = [(base + rng.normal(0, 0.03, 14)).round(5).tolist() for _ in range(16)]
    # even examples are Kodachrome (strength 0.2), odd ones Ektachrome (0.9)
    m = _examples(lambda i: "kodachrome" if i % 2 == 0 else "ektachrome", feats, lambda i: 0.2 if i % 2 == 0 else 0.9)
    q = base.tolist()
    mixed, n = m.suggest(q)
    assert 0.25 < mixed["strength"] < 0.85 and n == learning.K
    k, _ = m.suggest(q, "kodachrome")
    e, _ = m.suggest(q, "ektachrome")
    assert k["strength"] == pytest.approx(0.2) and e["strength"] == pytest.approx(0.9)
    # a stock with too few examples of its own: the others count less, not nothing
    few = _examples(lambda i: "agfachrome" if i < 3 else "kodachrome", feats, lambda i: 0.9 if i < 3 else 0.2)
    plain, _ = few.suggest(q)
    agfa, _ = few.suggest(q, "agfachrome")
    assert agfa["strength"] > plain["strength"]
    # examples from before stocks (no "s") and slides of unknown stock: exactly as before
    old = _examples(lambda i: None, feats, lambda i: 0.2 if i % 2 == 0 else 0.9)
    assert old.suggest(q, "kodachrome") == old.suggest(q) == old.suggest(q, "unknown")


def test_learning_remembers_the_stock(api, tmp_path):
    store.save_config({**store.load_config(), "learning_enabled": True})
    learning._model = None
    (store.library() / "learning.json").unlink(missing_ok=True)
    sid, d = new_tray(api, tmp_path / "scans")
    api.patch(f"/api/sessions/{sid}", json={"stock": "kodachrome"})
    gid = d["groups"][0]["id"]
    api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"reviewed": True})
    ex = {e["key"]: e for e in learning.model().examples}
    assert ex[f"{sid}:{gid}"]["s"] == "kodachrome"
    api.patch(f"/api/sessions/{sid}/groups/{gid}", json={"stock": "ektachrome"})  # re-learned with the new stock
    assert {e["key"]: e for e in learning.model().examples}[f"{sid}:{gid}"]["s"] == "ektachrome"
    (store.library() / "learning.json").unlink(missing_ok=True)
    learning._model = None


# --------------------------------------------------------------------------- dates


def tray_data(stocks, dates, tray_stock="", tray_date=""):
    return {"stock": tray_stock, "date": tray_date,
            "groups": [{"id": str(i), **({"stock": s} if s else {}), "date": t} for i, (s, t) in enumerate(zip(stocks, dates))]}


def test_slide_dates_era_hint_keeps_the_estimate():
    d = tray_data(["", "", "", ""], ["1978-08", "", "", "1979-07"])
    before = store.slide_dates(d)
    assert all("era" not in e for e in before)
    d["stock"] = "agfachrome"
    after = store.slide_dates(d)
    assert [{k: v for k, v in e.items() if k != "era"} for e in after] == before
    assert after[1]["era"] == {"stock": "agfachrome", "from": 1936, "to": 2005, "fits": True}
    d["groups"][0]["date"] = "2008"  # an own date outside the era is flagged, not changed
    e = store.slide_dates(d)[0]
    assert e["value"] == "2008" and e["era"]["fits"] is False
    assert store.slide_dates(tray_data(["ektachrome"], [""]))[0]["era"] == \
        {"stock": "ektachrome", "from": 1955, "to": None, "fits": None}
    assert "era" not in store.slide_dates(tray_data(["other"], [""]))[0]


def test_date_suggestion_from_same_stock_neighbours():
    # a Kodachrome roll (slides 0-2) inside a tray of Agfa dated 1990 at the end
    d = tray_data(["kodachrome", "kodachrome", "kodachrome", "agfachrome", "agfachrome"],
                  ["1975-06", "", "", "", "1990"])
    dates = store.slide_dates(d)
    assert dates[2]["value"].startswith("1982")  # the ordinary estimate interpolates across the rolls
    sug = filmstock.date_suggestions(d, dates)
    assert sug[0] is None  # has its own
    assert sug[1]["value"] == "1975-06" and sug[2]["value"] == "1975-06"  # the Kodachrome neighbour
    assert sug[1]["confidence"] == 0.45 and sug[1]["source"] == "neighbours+stock"
    assert sug[3]["value"] == "1990"
    # outside the era: not offered (Kodachrome was gone by 2012)
    late = tray_data(["kodachrome", "kodachrome"], ["2012", ""])
    assert filmstock.date_suggestions(late, store.slide_dates(late)) == [None, None]
    # no stock with an era: nothing (the ordinary estimate is shown as before)
    plain = tray_data(["", ""], ["1975", ""])
    assert filmstock.date_suggestions(plain, store.slide_dates(plain)) == [None, None]


def test_date_suggestion_accept(api, tmp_path):
    sid, d = new_tray(api, tmp_path / "scans")
    api.patch(f"/api/sessions/{sid}", json={"stock": "kodachrome", "date": "1974"})
    d = get(api, sid)
    assert d["groups"][0]["date_est"]["era"]["fits"] is True
    sug = d["groups"][1]["insights"]["date"]
    assert sug["value"] == "1974" and sug["state"] == "suggested"
    gid = d["groups"][1]["id"]
    d = post(api, f"/api/sessions/{sid}/insights/decide", kind="date", action="accept", groups=[gid])
    assert d["groups"][1]["date"] == "1974" and d["groups"][1]["date_est"]["source"] == "own"
    d = post(api, f"/api/sessions/{sid}/insights/decide", kind="date", action="dismiss")
    assert d["decided"] == 3
    assert all(g["insights"]["date"]["state"] in ("accepted", "dismissed") for g in d["groups"])
