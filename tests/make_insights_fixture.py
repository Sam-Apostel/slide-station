"""Write frontend/src/standalone/insights.fixture.json: inputs for the scene tags, insights plumbing and
look-alikes, with what insights.py / similar.py / places.py make of them, for insights.test.ts (the
browser's port must agree).

    uv run --python 3.12 python tests/make_insights_fixture.py [<folder with the real vocab.json and merges.txt>]

With the folder (the CLIP model as downloaded into <library>/models/clip-vit-b32/), the real
tokenizer's ids for the label prompts are recorded too; insights.test.ts checks them against the same
files when SS_CLIP_DIR points there. Nothing of the model goes into the fixture but those ids.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["SLIDESTATION_HOME"] = tempfile.mkdtemp()  # never the real library (insights starts a thread)
(Path(os.environ["SLIDESTATION_HOME"]) / "config.json").write_text(
    json.dumps({"library": tempfile.mkdtemp(), "learning_enabled": False}))

from slidestation import insights, places, similar  # noqa: E402

sys.path.insert(0, str(ROOT / "tests"))
from make_fake_clip import vocabulary  # noqa: E402  (a small BPE vocabulary learned from the prompts)

OUT = ROOT / "frontend/src/standalone/insights.fixture.json"
DIM = 16


def pattern(w: int, h: int) -> np.ndarray:
    """A made-up 8-bit picture both languages compute with integers alone."""
    y, x = np.mgrid[0:h, 0:w]
    return np.stack([(x * 7 + y * 13 + c * 50 + (x * y % 17) * 3) % 256 for c in range(3)], -1).astype(np.uint8)


def f32(a) -> list[float]:
    """float32 values as their shortest decimals (they read back as the same float32)."""
    return [float(str(np.float32(x))) for x in np.asarray(a, np.float32).reshape(-1)]


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def unit(v) -> np.ndarray:
    v = np.asarray(v, np.float32)
    return (v / np.linalg.norm(v)).astype(np.float32)


def tokenizer_cases(tmp: Path) -> dict:
    vocab, merges = vocabulary([p for _, p in insights.LABELS])
    (tmp / "vocab.json").write_text(json.dumps(vocab))
    (tmp / "merges.txt").write_text(merges)
    tok = insights.Tokenizer(tmp / "vocab.json", tmp / "merges.txt")
    texts = [p for _, p in insights.LABELS] + [
        "It's a DOG's   life,\tisn't it?", "  café au lait — naïve über 12 ", "under_score __x__ 3.14!!",
        "A photo of " + "very " * 30 + "long prompts"]
    return {"vocab": vocab, "merges": merges, "texts": texts, "ids": [tok.encode(t) for t in texts]}


def resize_cases() -> list[dict]:
    out = []
    for w, h, ow, oh in [(17, 13, 7, 5), (5, 4, 11, 9), (23, 31, 9, 40), (64, 48, 64, 21), (300, 200, 336, 224)]:
        a = pattern(w, h)
        r = np.asarray(Image.fromarray(a).resize((ow, oh), Image.BICUBIC))
        out.append({"w": w, "h": h, "ow": ow, "oh": oh, "sha1": hashlib.sha1(r.tobytes()).hexdigest(),
                    **({"out": b64(r)} if ow * oh < 500 else {})})
    return out


def preprocess_cases() -> list[dict]:
    out = []
    for w, h in [(90, 60), (260, 300), (400, 229), (224, 224)]:
        x = insights.preprocess(pattern(w, h).astype(np.float32) / 255)
        out.append({"w": w, "h": h, "sha1": hashlib.sha1(x.tobytes()).hexdigest(),
                    "sample": [float(v) for v in x.reshape(-1)[:: 9973]]})
    return out


def tag_cases(rng) -> dict:
    dim = 48
    labels = np.stack([unit(rng.normal(size=dim)) for _ in insights.TAGS])
    images = []
    for k in [0, 5, 9, 27, 34]:  # CLIP-like: a few prompts a little closer than the rest, shares spread out
        v = labels[k] * 0.06 + labels[(k + 3) % len(labels)] * 0.05 + labels[(k + 7) % len(labels)] * 0.04
        images.append(unit(v + unit(rng.normal(size=dim)) * 0.08))
    images.append(unit(rng.normal(size=dim)))
    stats = {"labels": {"beach": {"accepted": 1, "dismissed": 5}, "city": {"accepted": 4, "dismissed": 0},
                        "sea": {"accepted": 0, "dismissed": 1}}}

    class B:
        def label_embeds(self):
            return labels

    out = []
    for e in images:
        ranked = insights.scene_tags(B(), None, e)
        sug = [{"value": t, "confidence": round(p, 3), "source": insights.MODEL_ID, "state": "suggested"}
               for t, p in ranked if p >= insights.threshold(t, stats)][: insights.MAX_TAGS]
        out.append({"emb": f32(e), "ranked": ranked, "suggested": sug})
    return {"labels": [f32(r) for r in labels], "stats": stats, "images": out,
            "thresholds": {t: insights.threshold(t, stats) for t in ("beach", "city", "sea", "dog")}}


def key_cases() -> list[dict]:
    gs = [{"id": "a", "scans": ["s1"], "excluded": [], "rotation": 0},
          {"id": "b", "scans": ["s2", "s3"], "excluded": ["s3"], "rotation": 90},
          {"id": "c", "scans": ["s4", "s5"], "excluded": [], "rotation": 270, "caption": "hi"}]
    models = [[], [insights.MODEL_ID, insights.LABELS_KEY],
              [insights.MODEL_ID, insights.LABELS_KEY, "florence-2-base"], [insights.MODEL_ID, insights.LABELS_KEY, places.OCR_ID]]
    return [{"g": g, "models": m, "key": insights.insights_key(g, m), "slide_key": similar.slide_key(g)}
            for g in gs for m in models]


def merge_cases() -> list[dict]:
    t = lambda v, s, c=0.3: {"value": v, "confidence": c, "source": "clip-vit-b32", "state": s}  # noqa: E731
    venice = {"name": "Venice", "lat": 45.43713, "lon": 12.33265, "country": "Italy"}
    rome = {"name": "Rome", "lat": 41.89193, "lon": 12.51133, "country": "Italy"}
    ps = lambda p, s: places.suggestion(p, 0.6, places.OCR_ID, "x") | {"state": s}  # noqa: E731
    cases = [
        (None, {"key": "k1", "tags": [t("beach", "suggested"), t("sea", "suggested")]}, ["sea"], "", None),
        ({"key": "k0", "tags": [t("beach", "dismissed"), t("dog", "accepted"), t("cat", "suggested")]},
         {"key": "k1", "tags": [t("beach", "suggested", 0.5)]}, [], "", None),
        ({"key": "k0", "tags": [t("dog", "accepted")], "caption": t("A dog.", "dismissed")},
         {"key": "k1", "caption": t("A dog.", "suggested")}, [], "", None),
        ({"key": "k0", "tags": [], "caption": t("A dog.", "suggested")}, {"key": "k1"}, [], "My caption", None),
        ({"key": "k0", "place": ps(venice, "dismissed")}, {"key": "k1", "place": ps(venice, "suggested"),
                                                          "text": [{"text": "VENICE", "confidence": 0.9}]}, [], "", None),
        ({"key": "k0", "place": ps(venice, "accepted")}, {"key": "k1", "place": ps(rome, "suggested")}, [], "", None),
        (None, {"key": "k1", "place": ps(rome, "suggested")}, [], "", rome),
        (None, {"key": "k1", "place": ps(rome, "suggested")}, [], "", venice),
        ({"key": "k0", "stock": t("ektachrome", "accepted"), "text": [{"text": "OLD", "confidence": 1}]},
         {"key": "k1", "tags": []}, [], "", None),
    ]
    return [{"old": o, "new": n, "own_tags": ot, "own_caption": oc, "own_place": op,
             "out": insights.merge(o, n, ot, oc, op)} for o, n, ot, oc, op in cases]


def between_cases() -> list[dict]:
    venice = {"name": "Venice", "lat": 45.43713, "lon": 12.33265, "country": "Italy"}
    rome = {"name": "Rome", "lat": 41.89193, "lon": 12.51133, "country": "Italy"}
    g = lambda i, **kw: {"id": f"g{i}", **kw}  # noqa: E731
    trays = [
        [g(0, place=venice), g(1), g(2), g(3, place=venice), g(4), g(5, place=rome)],
        [g(0, place=venice), g(1, skip=True), g(2, insights={"key": "", "tags": [], "place": places.suggestion(
            venice, 0.9, "tray", "slides 1 and 4") | {"state": "dismissed"}}), g(3, place=venice)],
        [g(0, place=venice), g(1, insights={"key": "k", "tags": [], "place": places.suggestion(
            rome, 0.5, places.OCR_ID, "ROMA")}), g(2, insights={"key": "k", "tags": [], "place": places.suggestion(
                venice, 0.9, "tray", "old")}), g(3, place=rome)],
    ]
    out = []
    for tr in trays:
        before = json.loads(json.dumps(tr))
        n = places.suggest_between({"groups": tr})
        out.append({"groups": before, "after": tr, "n": n})
    return out


def pack_cases(rng) -> dict:
    vs = [unit(rng.normal(size=DIM)) for _ in range(4)] + [np.array([1e-6, -2.5e-5, 65504, 0.1, -0.3333, 1 / 3], np.float32)]
    return {"vectors": [f32(v) for v in vs], "packed": [similar._pack(v) for v in vs],
            "unpacked": [f32(similar.unpack(similar._pack(v))) for v in vs]}


def near(base, cos, rng):
    r = rng.normal(size=base.shape).astype(np.float32)
    r -= (r @ base) * base
    r /= np.linalg.norm(r)
    return unit(cos * base + np.sqrt(1 - cos * cos) * r)


def similar_cases(rng) -> dict:
    """A tray with planted embeddings: duplicates (one dismissed as a pair), a split, a merge (with and
    without a structural match), scenes with labels."""
    beach, snow, city = unit(rng.normal(size=DIM)), unit(rng.normal(size=DIM)), unit(rng.normal(size=DIM))
    groups, slides, scans, sigs = [], {}, {}, {}

    def add(gid, vec, scan_vecs, sharp=1.0, tags=None, sugs=None, skip=False, lums=None, excluded=None):
        xs = [f"{gid}s{k}" for k in range(len(scan_vecs))]
        g = {"id": gid, "scans": xs, "excluded": excluded or [], "rotation": 0, "skip": skip}
        if tags:
            g["tags"] = tags
        if sugs:
            g["insights"] = {"key": "", "tags": [{"value": v, "confidence": c, "source": "clip-vit-b32", "state": s}
                                                 for v, c, s in sugs]}
        groups.append(g)
        if vec is not None:
            slides[gid] = {"key": similar.slide_key(g), "emb": similar._pack(vec), "q": {"sharp": sharp, "clipped": 0.1}}
        for k, (x, v) in enumerate(zip(xs, scan_vecs)):
            scans[x] = {"emb": similar._pack(v), "lum": (lums or [0.5] * len(xs))[k]}

    add("a", beach, [beach], 1.0, tags=["beach"])
    add("b", near(beach, 0.96, rng), [beach], 2.0, sugs=[("beach", 0.5, "suggested"), ("sea", 0.2, "dismissed")])
    add("c", near(beach, 0.95, rng), [beach], 1.5, sugs=[("sea", 0.3, "suggested")])
    add("d", near(beach, 0.97, rng), [beach, near(beach, 0.6, rng)], 0.5)  # a split, and a duplicate of c
    add("e", near(snow, 0.99, rng), [snow], 1.0, sugs=[("snow", 0.4, "suggested")])
    add("f", near(snow, 0.98, rng), [near(snow, 0.9, rng)], 1.0, skip=True)
    add("g", near(snow, 0.97, rng), [snow], 1.0, sugs=[("mountains", 0.4, "suggested")])
    add("h", near(snow, 0.96, rng), [near(snow, 0.95, rng)], 1.0, lums=[0.2])  # merge with i (exposures apart)
    add("i", near(snow, 0.955, rng), [near(snow, 0.94, rng)], 1.0, lums=[0.6])
    add("j", near(city, 0.99, rng), [city], 1.0, tags=["city"])
    add("k", near(city, 0.98, rng), [near(city, 0.96, rng)], 1.0, tags=["city"], lums=[0.1])
    add("l", None, [near(city, 0.97, rng)], lums=[0.5])  # not embedded yet: merge with k blocked by structure
    add("m", near(beach, 0.5, rng), [beach], 1.0)  # one odd slide at the end
    sig = unit(rng.normal(size=12))
    sigs.update({"hs0": sig.tolist(), "is0": near(sig, 0.9, rng).tolist(), "ks0": sig.tolist(),
                 "ls0": near(sig, 0.2, rng).tolist()})
    tray = {"id": "t", "groups": groups, "similar": {"apart": ["a|b"], "dismissed": []}}
    e = {"slides": slides, "scans": scans}

    class S:
        id = "t"
        data = tray

    orig = similar._sig
    similar._sig = lambda s, x: np.asarray(sigs[x], np.float32) if x in sigs else None
    try:
        out = {"tray": tray, "embeddings": e, "sigs": sigs, "suggest": similar.suggest(S(), e, 0.93),
               "suggest_strict": similar.suggest(S(), e, 0.96)}
        tray2 = json.loads(json.dumps(tray))
        similar.dismiss(tray2, out["suggest"]["duplicates"][0])
        for x in out["suggest"]["split"] + out["suggest"]["merge"]:
            similar.dismiss(tray2, x)
        S.data = tray2
        out["dismissed_tray"] = tray2["similar"]
        out["suggest_after_dismiss"] = similar.suggest(S(), e, 0.93)
    finally:
        similar._sig = orig
    out["thresholds"] = [[st, similar.threshold(st)] for st in (
        {"labels": {}}, {"labels": {"duplicates": {"accepted": 0, "dismissed": 3}}},
        {"labels": {"duplicates": {"accepted": 1, "dismissed": 20}}})]
    return out


def image_cases() -> dict:
    a = pattern(31, 17).astype(np.float32) / 255
    a[0, 0] = [1, 1, 1]
    return {"w": 31, "h": 17, "normalise": f32(similar.normalise(a).reshape(-1)),
            "levels": f32(similar.levels(a).reshape(-1)),
            "windows": {d: similar._date_window(d) for d in ("1978", "1978-12", "1978-06-30", "junk", "")}}


# the made-up GeoNames extract of test_places.py (geonameid, name, asciiname, alternates, lat, lon, country,
# admin1, population), plus a few names that exercise folding and the alternate-name rules
CITIES = [
    (3164603, "Venice", "Venice", "VCE,Venecia,Venedig,Venezia", 45.43713, 12.33265, "IT", "20", 51298),
    (5405841, "Venice", "Venice", "", 33.99084, -118.46008, "US", "CA", 40885),
    (4176380, "Venice", "Venice", "", 27.09978, -82.45426, "US", "FL", 22211),
    (4259418, "Dayton", "Dayton", "Gem City,Venice", 39.75895, -84.19161, "US", "OH", 135512),
    (3176959, "Florence", "Florence", "Firenze,Florenz", 43.77925, 11.24626, "IT", "16", 349296),
    (2775220, "Innsbruck", "Innsbruck", "Innsbrucco", 47.26266, 11.39454, "AT", "07", 132493),
    (3204541, "Bar", "Bar", "Antivari", 42.0931, 19.10013, "ME", "02", 17727),
    (3169070, "Rome", "Rome", "Roma,Rom", 41.89193, 12.51133, "IT", "07", 2318895),
    (3448439, "Plagetown", "Plagetown", "Plage", 10.0, 10.0, "BR", "27", 20000),
    (2657896, "Zürich", "Zurich", "Zuerich,Zurigo,ZRH,Цюрих", 47.36667, 8.55, "CH", "ZH", 341730),
    (3093133, "Łódź", "Lodz", "Lodsch,Litzmannstadt", 51.75, 19.46667, "PL", "74", 768755),
    (2761369, "Vienna", "Vienna", "Wien,Vienne,Bécs", 48.20849, 16.37208, "AT", "09", 1691468),
    (2995469, "Marseille", "Marseille", "Marseilles,Marsiglia", 43.29695, 5.38107, "FR", "93", 870731),
    (3021670, "Dijon", "Dijon", "", 47.31667, 5.01667, "FR", "27", 151212),
    (5128581, "New York City", "New York City", "NYC,New York,Nueva York", 40.71427, -74.00597, "US", "NY", 8804190),
]
COUNTRIES = {"IT": "Italy", "US": "United States", "AT": "Austria", "ME": "Montenegro", "BR": "Brazil",
             "CH": "Switzerland", "PL": "Poland", "FR": "France"}
ADMINS = {"IT.20": "Veneto", "US.CA": "California", "US.FL": "Florida", "US.OH": "Ohio", "IT.16": "Tuscany",
          "AT.07": "Tyrol", "ME.02": "Bar", "IT.07": "Latium", "BR.27": "São Paulo", "CH.ZH": "Zurich",
          "PL.74": "Łódź Voivodeship", "AT.09": "Vienna", "FR.93": "Provence-Alpes-Côte d'Azur",
          "FR.27": "Bourgogne-Franche-Comté", "US.NY": "New York"}


def places_cases() -> dict:
    import io
    import zipfile

    rows = "".join(f"{i}\t{n}\t{a}\t{alt}\t{lat}\t{lon}\tP\tPPL\t{cc}\t\t{adm}\t\t\t\t{pop}\t\t0\tEurope/Rome\t2026-01-01\n"
                   for i, n, a, alt, lat, lon, cc, adm, pop in CITIES)
    z = io.BytesIO()
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("cities15000.txt", rows)
    country = "#ISO\tISO3\tISO-Numeric\tfips\tCountry\n" + "".join(
        f"{cc}\tXXX\t000\t{cc}\t{name}\tCapital\n" for cc, name in COUNTRIES.items())
    admin = "".join(f"{k}\t{v}\t{v}\t1\n" for k, v in ADMINS.items())
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "cities15000.zip").write_bytes(z.getvalue())
        (d / "countryInfo.txt").write_text(country)
        (d / "admin1CodesASCII.txt").write_text(admin)
        gaz = places.Gazetteer(d)
    orig = places.gazetteer
    places.gazetteer = lambda: gaz
    try:
        queries = ["venice", "Venice, united", "venice, flor", "firen", "ROMA", "ven", "", "zzz", "Innsbr", "zurich",
                   "Zürich", "zuer", "lodz", "łódź", "wien", "bécs", "new york", "nueva", "marseil", "d", "45.44, 12.34",
                   "0.5, 0.5", "48.2 16.37", "-33.9; 151.2", "95, 10", "Rome, lat", "rom, it"]
        search = {q: places.search(q) for q in queries}
    finally:
        places.gazetteer = orig
    signs = [["WELCOME TO", "VENICE"], ["Benvenuti a Firenze"], ["INNSBRUCK", "Hauptbahnhof"], ["OPEN", "BAR"],
             ["Plage"], ["Hotel Innsbruck"], ["Via Roma 12"], ["Welcome to Bar"], [], ["Gelato", "Pizza"],
             ["Grüsse aus Wien"], ["WIEN"], ["Marseille Airport"], ["Souvenir de Dijon"], ["DIJON"], ["NEW YORK CITY"],
             ["I LOVE NEW YORK"], ["Zürich Hauptbahnhof"], ["Rue de Marseille"], ["Bienvenue à", "Marseille"], ["1978"],
             ["ROMA TERMINI"], ["Lodz 1974"], ["Venezia", "Stazione"]]
    text = []
    for lines in signs:
        for conf in (0.99, 0.6):
            ls = [{"text": t, "confidence": conf} for t in lines]
            text.append({"lines": ls, "hit": places.place_from_text(ls, gaz)})
    folds = {s: places.fold(s) for s in ["Zürich-Flughafen", "Łódź", "Straße", "Ærøskøbing", "Đakovo", "  São  Paulo! ",
                                          "L'Aquila", "Bécs", "İstanbul", "ﬁnal"]}
    return {"zip": base64.b64encode(z.getvalue()).decode(), "cities": rows, "country": country, "admin": admin,
            "size": len(gaz), "search": search, "text": text, "fold": folds,
            "nearest": {f"{a},{b}": gaz.nearest(a, b) for a, b in [(45.44, 12.34), (0.5, 0.5), (48.3, 16.5), (40.9, -73.9)]}}


def ocr_cases() -> dict:
    """PaddleOCR's plumbing around the two networks (places.Ocr), with the networks replaced: a planted
    probability map for the detector, planted per-step probabilities for the recogniser."""
    import cv2

    out: dict = {"resize": [], "det_size": {}, "warp": []}
    for w, h, ow, oh in [(100, 60, 50, 30), (97, 61, 40, 23), (40, 30, 96, 64), (1600, 1067, 960, 640), (31, 48, 24, 48),
                         (13, 7, 1920, 48)]:
        a = pattern(w, h)
        r = cv2.resize(a, (ow, oh), interpolation=cv2.INTER_LINEAR)
        out["resize"].append({"w": w, "h": h, "ow": ow, "oh": oh, "sha1": hashlib.sha1(r.tobytes()).hexdigest(),
                              "sum": int(r.astype(np.int64).sum())})
    for w, h in [(1600, 1067), (1067, 1600), (800, 530), (20, 10), (961, 961), (1600, 900)]:
        f = min(1.0, places.DET_SIDE / max(h, w))
        out["det_size"][f"{w}x{h}"] = [max(32, round(w * f / 32) * 32), max(32, round(h * f / 32) * 32)]
    img = pattern(120, 80)
    for pts in ([[10.5, 8.2], [90.3, 12.7], [88.1, 40.4], [8.9, 36.0]], [[-5, -4], [50, 2], [48, 30], [-3, 25]],
                [[30, 10], [60, 10], [60, 70], [30, 70]]):
        p = np.array(pts, np.float32)
        tw = int(max(np.linalg.norm(p[0] - p[1]), np.linalg.norm(p[3] - p[2])))
        th = int(max(np.linalg.norm(p[0] - p[3]), np.linalg.norm(p[1] - p[2])))
        dst = np.array([[0, 0], [tw, 0], [tw, th], [0, th]], np.float32)
        c = cv2.warpPerspective(img, cv2.getPerspectiveTransform(p, dst), (tw, th), borderMode=cv2.BORDER_REPLICATE,
                                flags=cv2.INTER_CUBIC)
        out["warp"].append({"pts": pts, "tw": tw, "th": th, "out": b64(c)})

    # a probability map (8-bit, zlib in the fixture): three text lines (one tilted), a ring with a hole,
    # a speck, a faint blob, and a little texture everywhere
    h, w = 266, 400
    dw, dh = out["det_size"].setdefault(f"{w}x{h}", [max(32, round(w / 32) * 32), max(32, round(h / 32) * 32)])
    p8 = np.zeros((dh, dw), np.uint8)
    cv2.fillPoly(p8, [np.array([[20, 20], [150, 20], [150, 34], [20, 34]], np.int32)], 230)
    cv2.fillPoly(p8, [cv2.boxPoints(((200, 90), (120, 14), 7.0)).astype(np.int32)], 205)
    cv2.fillPoly(p8, [np.array([[30, 150], [330, 153], [330, 175], [30, 172]], np.int32)], 240)
    cv2.circle(p8, (300, 50), 20, 180, 6)  # a ring: its hole counts in the mean
    cv2.circle(p8, (20, 220), 1, 230, -1)  # too small
    cv2.fillPoly(p8, [np.array([[100, 200], [250, 200], [250, 230], [100, 230]], np.int32)], 100)  # too faint
    y, x = np.mgrid[0:dh, 0:dw]
    p8 = p8 + ((x * 7 + y * 13) % 13).astype(np.uint8)
    pred = p8.astype(np.float32) / 255
    steps, classes = 40, 504
    rec_inputs = []

    class Det:
        def get_inputs(self):
            return [type("I", (), {"name": "x"})()]

        def run(self, _, feed):
            return [pred[None, None]]

    class Rec(Det):
        def run(self, _, feed):
            x = feed["x"]
            levels = np.rint((x * 0.5 + 0.5) * 255).astype(np.int64)  # back to 8-bit levels
            rec_inputs.append({"shape": list(x.shape), "sum": int(levels.sum()), "sha1": hashlib.sha1(x.tobytes()).hexdigest()})
            k = len(rec_inputs)
            p = np.full((1, steps, classes), 0.001, np.float32)
            for t in range(steps):  # "k" letters with blanks and repeats between
                p[0, t, [0, 1 + (t // 3 + k) % 26 * 3][t % 3 != 0]] = 0.9 - 0.01 * (t % 5)
            return [p]

    o = places.Ocr.__new__(places.Ocr)
    o.det, o.rec = Det(), Rec()
    o.chars = [""] + [chr(33 + i) for i in range(classes - 3)] + [" "]
    rgb8 = pattern(w, h)
    bxs = o.boxes(rgb8)
    lines = o.read(rgb8)
    pred8 = base64.b64encode(__import__("zlib").compress(p8.tobytes(), 9)).decode()
    out["det"] = {"w": w, "h": h, "dw": dw, "dh": dh, "pred": pred8, "boxes": [b.tolist() for b in bxs],
                  "lines": lines, "rec_inputs": rec_inputs, "chars": len(o.chars), "steps": steps, "classes": classes}
    return out


def people_cases() -> dict:
    """Faces -> people (people.py): clustering, the people.json edits, and alignCrop's warp."""
    import cv2

    from slidestation import people

    def person(n, noise, seed):
        r = np.random.default_rng(seed)
        c = unit(r.normal(size=128))
        return [unit(c + noise * r.normal(size=128) / np.sqrt(128)) for _ in range(n)]

    def packed(vs):
        return [similar._pack(v) for v in vs]

    def vecs(ps):
        return np.stack([similar.unpack(p) for p in ps])

    out: dict = {"agglomerate": []}
    rng = np.random.default_rng(11)
    ab = person(5, 0.5, 1) + person(3, 0.5, 2) + person(1, 0.5, 3)
    ab = [ab[i] for i in rng.permutation(len(ab))]
    many = [v for k in range(6) for v in person(4 + k, 0.9 + 0.1 * k, 20 + k)]
    many = [many[i] for i in rng.permutation(len(many))]
    x = unit(rng.normal(size=128))
    for emb, clusters, rejected in [(packed(ab), [], {}), (packed(person(4, 0.5, 1)), [[0], [1]], {}),
                                     (packed(person(4, 0.5, 1)), [[], [0, 1]], {}),
                                     (packed(person(4, 0.5, 1)), [[0, 1, 2]], {3: [0]}),
                                     (packed(person(4, 0.5, 1) + person(1, 0.5, 1)[:1]), [[0, 1, 2]], {3: [0]}),
                                     (packed([x, unit(x + unit(rng.normal(size=128)) * 1.6), unit(rng.normal(size=128))]), [], {}),
                                     (packed(many), [[0, 5], [9]], {3: [0], 7: [1]}), ([], [], {})]:
        e = vecs(emb) if emb else np.zeros((0, 128), np.float32)
        out["agglomerate"].append({"emb": emb, "clusters": clusters, "rejected": rejected,
                                   "out": people.agglomerate(e, clusters, {k: set(v) for k, v in rejected.items()})})

    # people.json through refresh and the dialog's edits, the faces and the file kept in memory
    ann, bob, cat = person(4, 0.4, 31), person(3, 0.4, 32), person(2, 0.4, 33)
    faces = {}
    for k, v in enumerate(ann + bob + cat):
        sid, gid = ("t1", f"g{k}") if k < 6 else ("t2", f"h{k}")
        faces[f"{sid}/{gid}/{k % 2}"] = {"sid": sid, "gid": gid, "emb": similar._pack(v), "box": [0.1, 0.1, 0.2, 0.2],
                                         "key": "k"}
    state = {"file": {}}
    orig = (people.all_faces, people.load_people, people.save_people)
    shown = {}
    people.all_faces = lambda: {f: {**v, "emb": similar.unpack(v["emb"])} for f, v in shown.items()}
    people.load_people = lambda: {"people": json.loads(json.dumps(state["file"].get("people", {}))),
                                  "rejected": json.loads(json.dumps(state["file"].get("rejected", {}))),
                                  "next": state["file"].get("next", 1)}
    people.save_people = lambda d: state.__setitem__("file", json.loads(json.dumps(d)))
    steps = []
    try:
        ids = list(faces)
        shown.update({f: faces[f] for f in ids[:7]})
        steps.append({"op": "refresh", "faces": dict(shown), "out": people.refresh()})
        p1 = next(p for p, v in state["file"]["people"].items() if ids[0] in v["faces"])
        steps.append({"op": "rename", "args": [p1, "  Ann  Smith "], "out": people.rename(p1, "  Ann  Smith ")})
        steps.append({"op": "remove", "args": [p1, [ids[1]]], "out": people.remove_faces(p1, [ids[1]])})
        other = next(p for p in state["file"]["people"] if p != p1)
        steps.append({"op": "rename", "args": [other, "ann smith"], "out": people.rename(other, "ann smith")})
        shown.update({f: faces[f] for f in ids[7:]})
        steps.append({"op": "refresh", "faces": dict(shown), "out": people.refresh()})
        ps = list(state["file"]["people"])
        steps.append({"op": "merge", "args": [ps[-1], ps[:1]], "out": people.merge(ps[-1], ps[:1])})
        for f in ids[:3]:
            shown.pop(f)
        steps.append({"op": "refresh", "faces": dict(shown), "out": people.refresh()})
    finally:
        people.all_faces, people.load_people, people.save_people = orig
    out["steps"] = steps

    # alignCrop: the similarity transform to SFace's template and the 112 x 112 warp (the network
    # itself isn't needed for it: any ONNX file loads)
    rec = cv2.FaceRecognizerSF.create(str(ROOT / "tests" / "fake_clip" / "vision.onnx"), "")
    img = pattern(200, 160)
    out["align"] = []
    for row in ([60, 40, 70, 80, 78.3, 70.1, 112.6, 69.4, 95.2, 88.8, 82.0, 104.5, 109.7, 103.9, 0.93],
                [20, 30, 40, 50, 30.5, 45.2, 49.8, 49.9, 39.1, 58.3, 31.7, 66.2, 47.5, 69.0, 0.8],
                [100, 20, 90, 120, 180.2, 60.0, 190.3, 100.4, 170.8, 90.7, 150.0, 70.1, 160.9, 120.3, 0.75]):
        a = rec.alignCrop(img, np.array([row], np.float32))
        out["align"].append({"face": row, "sha1": hashlib.sha1(a.tobytes()).hexdigest(), "sum": int(a.astype(np.int64).sum())})
    # the face crop for the People dialog: INTER_AREA to 128
    rgb = pattern(300, 200).astype(np.float32) / 255
    out["crop"] = []
    for box in ([0.2, 0.3, 0.1, 0.15], [0.9, 0.85, 0.2, 0.3], [0.0, 0.0, 0.05, 0.05]):
        c = people.face_crop(rgb, box)
        out["crop"].append({"box": box, "sum": float(c.astype(np.float64).sum()), "shape": list(c.shape)})
    return out


def main() -> None:
    rng = np.random.default_rng(7)
    with tempfile.TemporaryDirectory() as tmp:
        out = {
            "labels_key": insights.LABELS_KEY,
            "tokenizer": tokenizer_cases(Path(tmp)),
            "resize": resize_cases(),
            "preprocess": preprocess_cases(),
            "tags": tag_cases(rng),
            "keys": key_cases(),
            "merge": merge_cases(),
            "between": between_cases(),
            "pack": pack_cases(rng),
            "similar": similar_cases(rng),
            "images": image_cases(),
            "places": places_cases(),
            "ocr": ocr_cases(),
            "people": people_cases(),
        }
    if len(sys.argv) > 1:
        d = Path(sys.argv[1])
        tok = insights.Tokenizer(d / "vocab.json", d / "merges.txt")
        out["real_prompt_ids"] = [tok.encode(p) for _, p in insights.LABELS]
    elif OUT.exists():  # keep the ones recorded before
        old = json.loads(OUT.read_text())
        if "real_prompt_ids" in old:
            out["real_prompt_ids"] = old["real_prompt_ids"]
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print("wrote", OUT, f"{OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
