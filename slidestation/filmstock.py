"""Film stock per slide: what it was shot on, a guess from how it faded, and the years it was sold.

A slide's stock is `g["stock"]` (its own), else the tray's `d["stock"]`: one of STOCKS, "" = not
set. "unknown" on a slide means "looked, can't tell" and doesn't take the tray's stock.

**The guess** (never applied: an insights suggestion to accept or dismiss) comes from the learned
colour features (`learning.features`: per-channel 1/50/99 percentiles, brightness, contrast, red/
green and blue/green cast of the blended, undeveloped scan):

- until the library has at least MIN_PER_STOCK labelled slides of two or more stocks, a
  transparent heuristic from the way the dyes of each stock are known to fade (`heuristic`);
- from then on, distance-weighted k-NN over those labelled slides, like `learning.py`, for the
  stocks it has labels of; the heuristic still speaks for the others (`_guess`).

Either way a slide's guess is blended half and half with its tray's average (a tray is usually one
stock, and a red sunset or a blue sea on one slide shouldn't decide it), and only a guess of at
least SUGGEST_FROM is offered. The heuristic's numbers were not fitted to real slides: it is a
guess from fading patterns, and its confidence is capped (HEURISTIC_TRUST) to say so.

**Eras** (ERAS): the years each stock was sold, approximately. They never change a slide's date;
`store.slide_dates` shows them as a hint, and the date suggestion (`date_suggestions`) only offers
a neighbour's date that falls inside the slide's stock era.

No model, no download: this runs in the browser version as it is (`standalone/filmstock.ts`).
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np

STOCKS = ("kodachrome", "ektachrome", "agfachrome", "fujichrome", "other", "unknown")
# what a label (and so a suggestion, and a learning example's "s") can be
CLASSES = ("kodachrome", "ektachrome", "agfachrome", "fujichrome", "other")
NAMES = {"kodachrome": "Kodachrome", "ektachrome": "Ektachrome", "agfachrome": "Agfachrome",
         "fujichrome": "Fujichrome", "other": "Other", "unknown": "Unknown"}

# Years each stock was on sale for 35 mm slides (None: still made). Approximate, and deliberately
# wide: they are a sanity check, not a date.
#   Kodachrome: 35 mm from 1936; K-II / X (1961), Kodachrome 25 / 64 (1974); production ended 2009,
#     the last lab stopped processing it at the end of 2010.
#   Ektachrome: sheet film from 1946, 35 mm from about 1955; process E-6 from 1977; discontinued
#     2012, made again since 2018.
#   Agfachrome / Agfacolor: Agfacolor Neu reversal film from 1936; Agfa's consumer film ended 2005.
#   Fujichrome: Fuji's first colour reversal film came out in 1948; still made.
ERAS: dict[str, tuple[int, int | None]] = {
    "kodachrome": (1936, 2010),
    "ektachrome": (1955, None),
    "agfachrome": (1936, 2005),
    "fujichrome": (1948, None),
}

SOURCE = "fade-heuristic"  # a heuristic guess; a k-NN one is "knn:<n>"
DATE_SOURCE = "neighbours+stock"
HEURISTIC_TRUST = 0.75  # the heuristic never claims more than this
UNKNOWN_MASS = 0.3  # "no signature": what a slide with no fade pattern is left with
SUGGEST_FROM = 0.3
TRAY_WEIGHT = 0.5
MIN_PER_STOCK = 5  # labelled slides a stock needs before the k-NN knows it
K = 7
MAX_DISTANCE = 3.0
N_FEATS = 13  # learning.features without the stack depth, which says nothing about the film


def clean(v) -> str:
    """A stock as sent by the UI: one of STOCKS, or "" (not set). ValueError otherwise."""
    v = str(v or "").strip().lower()
    if v and v not in STOCKS:
        raise ValueError(f"Film stock must be one of {', '.join(STOCKS)}")
    return v


def effective(d: dict, g: dict) -> str:
    """The slide's own stock, else the tray's ("" when neither is set)."""
    return g.get("stock") or d.get("stock", "") or ""


def era(stock: str) -> tuple[int, int | None] | None:
    return ERAS.get(stock)


def fits(year: int, stock: str) -> bool:
    e = ERAS.get(stock)
    return not e or (e[0] <= year and (e[1] is None or year <= e[1]))


# ------------------------------------------------------------------------------------ heuristic


def _sig(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def heuristic(f: list[float]) -> dict[str, float]:
    """A guess from the fade signature, as probabilities per stock (the rest is "unknown").

    - Ektachrome (E-3 / E-4 era especially): the cyan dye fades first, so the slide turns
      red / magenta (red over green, blue not below green) and its blacks lift.
    - Agfachrome / Agfacolor: the magenta dye goes, leaving it cyan / blue-green (red below green,
      blue not below green); the blacks lift less.
    - Kodachrome: kept in the dark it holds its colour: little cast, full contrast, dense blacks.
      Well-stored E-6 Ektachrome and Fujichrome look like that too, which the cap below allows for.
    - Fujichrome: no signature to go on; only the k-NN learns it, from your labels.
    """
    lo, hi = f[0:3], f[6:9]
    black = min(lo)  # the darkest channel's shadows: dense film stays near 0
    contrast = f[10]
    # the cast against green, from the midtones (log ratio of the medians) and, because a scene's
    # own colour (a sunset, the sea) sits mostly in the midtones, from the black and white points
    # too, where a lost dye shows whatever the picture (shadows weighted up: they move less)
    red = (f[11] + 3 * (lo[0] - lo[1]) + (hi[0] - hi[1])) / 3
    blue = (f[12] + 3 * (lo[2] - lo[1]) + (hi[2] - hi[1])) / 3
    cast = math.hypot(red, blue)
    lifted = _sig((black - 0.05) / 0.025)
    s = {
        "kodachrome": _sig((0.06 - cast) / 0.02) * _sig((contrast - 0.45) / 0.08) * _sig((0.04 - black) / 0.015),
        "ektachrome": _sig((red - 0.05) / 0.03) * _sig((blue + 0.04) / 0.04) * (0.4 + 0.6 * lifted),
        "agfachrome": _sig((-red - 0.05) / 0.03) * _sig((blue + 0.04) / 0.04) * (0.5 + 0.5 * lifted),
    }
    total = sum(s.values()) + UNKNOWN_MASS
    return {k: HEURISTIC_TRUST * s[k] / total for k in s}


# ------------------------------------------------------------------------------------ labels, k-NN


class Labels:
    """Slides whose stock you set (on the slide or its tray), as k-NN examples: the library's
    `stocks.json` = {"version": 1, "examples": [{"key": "tray:slide", "f": [14 features], "s": stock}]}."""

    def __init__(self, path: Path):
        self.path = path
        try:
            self.examples: list[dict] = json.loads(path.read_text()).get("examples", [])
        except (OSError, ValueError, AttributeError):
            self.examples = []
        self._fit()

    def _save(self) -> None:
        from .store import _atomic_write, lock

        with lock:
            _atomic_write(self.path, {"version": 1, "examples": self.examples})
        self._fit()

    def _fit(self) -> None:
        n = {}
        for e in self.examples:
            n[e["s"]] = n.get(e["s"], 0) + 1
        self.known = sorted(k for k in CLASSES if n.get(k, 0) >= MIN_PER_STOCK)
        self._X = None
        if len(self.known) < 2:  # one stock alone can't tell anything apart
            return
        self._ex = [e for e in self.examples if e["s"] in self.known and len(e["f"]) >= N_FEATS]
        X = np.array([e["f"][:N_FEATS] for e in self._ex], dtype=np.float64)
        self._mu = X.mean(0)
        self._sd = X.std(0) + 1e-3
        self._X = (X - self._mu) / self._sd

    def counts(self) -> dict[str, int]:
        out = {k: 0 for k in CLASSES}
        for e in self.examples:
            out[e["s"]] = out.get(e["s"], 0) + 1
        return out

    def remember(self, key: str, feats: list[float], stock: str) -> None:
        entry = {"key": key, "f": [round(float(x), 5) for x in feats], "s": stock, "t": time.time()}
        for i, e in enumerate(self.examples):
            if e.get("key") == key:
                if e["s"] == stock and e["f"] == entry["f"]:
                    return  # nothing changed: don't rewrite the file
                self.examples[i] = entry
                break
        else:
            self.examples.append(entry)
        self._save()

    def forget(self, key: str) -> None:
        n = len(self.examples)
        self.examples = [e for e in self.examples if e.get("key") != key]
        if len(self.examples) != n:
            self._save()

    def predict(self, feats: list[float]) -> tuple[dict[str, float] | None, int]:
        """Probabilities per stock from the nearest labelled slides, or None (too few labels, or
        nothing close enough). Shares are shrunk by n / (n + 1): three neighbours say less than seven."""
        if self._X is None or len(feats) < N_FEATS:
            return None, 0
        q = (np.array(feats[:N_FEATS], dtype=np.float64) - self._mu) / self._sd
        d = np.sqrt(((self._X - q) ** 2).mean(1))
        idx = [i for i in np.argsort(d, kind="stable")[:K] if d[i] <= MAX_DISTANCE]
        if not idx:
            return None, 0
        w = 1.0 / (d[idx] + 0.25)
        w = w / w.sum()
        shrink = len(idx) / (len(idx) + 1)
        out = {k: 0.0 for k in self.known}
        for i, wi in zip(idx, w):
            out[self._ex[i]["s"]] += float(wi) * shrink
        return out, len(idx)


_labels: Labels | None = None


def labels() -> Labels:
    from .store import library

    global _labels
    path = library() / "stocks.json"
    if _labels is None or _labels.path != path:
        _labels = Labels(path)
    return _labels


def label(d: dict, g: dict, sid: str) -> None:
    """Keep the slide's label in step with its stock: a known stock teaches the k-NN, anything
    else (not set, unknown, skipped, no features) is forgotten."""
    key = f"{sid}:{g['id']}"
    st = effective(d, g)
    if g.get("skip") or st not in CLASSES or not g.get("feat"):
        labels().forget(key)
    else:
        labels().remember(key, g["feat"], st)


# ------------------------------------------------------------------------------------ suggestions


def _guess(f: list[float], lab: Labels) -> tuple[dict[str, float], str]:
    """Probabilities per stock and where they come from. The k-NN only knows the stocks you
    labelled enough of, and would force anything else into one of those; so the heuristic keeps
    its say on the stocks the k-NN doesn't know, and the k-NN's shares fill the rest."""
    h = heuristic(f)
    p, n = lab.predict(f)
    if p is None:
        return h, SOURCE
    rest = sum(v for k, v in h.items() if k not in p)
    return {**{k: v for k, v in h.items() if k not in p}, **{k: v * (1 - rest) for k, v in p.items()}}, f"knn:{n}"


def stock_suggestions(d: dict, lab: Labels | None = None) -> list[dict | None]:
    """Per slide, the stock to suggest ({"value", "confidence", "source", "state": "suggested"})
    or None: only for slides with no stock (or "unknown"), with features, not skipped."""
    lab = lab or labels()
    groups = d["groups"]
    per: list[tuple[dict[str, float], str] | None] = []
    for g in groups:
        st = effective(d, g)
        if g.get("skip"):
            per.append(None)
        elif st in CLASSES:  # a label counts fully towards the tray's average
            per.append(({st: 1.0}, "label"))
        elif g.get("feat") and len(g["feat"]) >= N_FEATS:
            per.append(_guess(g["feat"], lab))
        else:
            per.append(None)
    known = [p for p, _ in (x for x in per if x)]
    tray = {k: sum(p.get(k, 0.0) for p in known) / len(known) for k in CLASSES} if known else {}
    out: list[dict | None] = []
    for g, x in zip(groups, per):
        if not x or x[1] == "label":
            out.append(None)
            continue
        p, source = x
        mix = {k: (1 - TRAY_WEIGHT) * p.get(k, 0.0) + TRAY_WEIGHT * tray.get(k, 0.0) for k in CLASSES}
        best = max(CLASSES, key=lambda k: mix[k])  # ties: the first in CLASSES
        if best not in lab.known:  # the k-NN doesn't know it: it's the heuristic's guess
            source = SOURCE
        c = round(mix[best], 3)
        out.append({"value": best, "confidence": c, "source": source, "state": "suggested"} if c >= SUGGEST_FROM else None)
    return out


def _year(v: str) -> int:
    return int(v[:4])


def date_suggestions(d: dict, dates: list[dict]) -> list[dict | None]:
    """Per slide, a date to suggest from its tray neighbours, bounded by its stock's era, or None.

    Only for slides with no date of their own whose stock (own or the tray's) has an era. The
    dated slides of the *same* stock around it come first (a roll of Kodachrome in a tray of Agfa
    is its own stretch of time), interpolated like `store.slide_dates`; else the slide's ordinary
    estimate. A value outside the stock's era is not offered: one of the two is wrong."""
    from .store import estimate, parse_date

    groups = d["groups"]
    stocks = [effective(d, g) for g in groups]
    own = [parse_date(g.get("date", "")) for g in groups]
    out: list[dict | None] = []
    for i, g in enumerate(groups):
        st = stocks[i]
        if own[i] or g.get("skip") or st not in ERAS:
            out.append(None)
            continue
        same = [j for j, x in enumerate(own) if x and stocks[j] == st]
        hit = estimate(own, i, same)
        if hit:
            value, how = hit[0], hit[1]
            conf = {"between": 0.6, "near": 0.45}[how]
        elif dates[i]["source"] in ("between", "near", "tray") and dates[i]["value"]:
            value, how = dates[i]["value"], dates[i]["source"]
            conf = {"between": 0.45, "near": 0.35, "tray": 0.3}[how]
        else:
            out.append(None)
            continue
        if not fits(_year(value), st):
            out.append(None)
            continue
        out.append({"value": value, "confidence": conf, "source": DATE_SOURCE, "state": "suggested"})
    return out


def era_hint(d: dict, g: dict, value: str) -> dict | None:
    """For `store.slide_dates`: the slide's stock era and whether the date shown lies inside it."""
    st = effective(d, g)
    e = ERAS.get(st)
    if not e:
        return None
    return {"stock": st, "from": e[0], "to": e[1], "fits": fits(_year(value), st) if value else None}


def _merged(stored: dict | None, live: dict | None) -> dict | None:
    """What a slide shows for one kind: a model's own open suggestion stays; a decision stands
    while the live guess is the same value; a different live guess is new and is offered."""
    if stored and stored.get("state") == "suggested" and stored.get("source") not in (SOURCE, DATE_SOURCE, "people") \
            and not str(stored.get("source", "")).startswith("knn:"):
        return stored
    if live and not (stored and stored.get("value") == live["value"] and stored.get("state") in ("accepted", "dismissed")):
        return live
    return stored


def views(d: dict, dates: list[dict]) -> list[dict]:
    """Per slide {"stock": entry | None, "date": entry | None}: the live guesses merged with the
    decisions stored in g["insights"]."""
    stock = stock_suggestions(d)
    date = date_suggestions(d, dates)
    out = []
    for g, s, t in zip(d["groups"], stock, date):
        ins = g.get("insights") or {}
        out.append({"stock": _merged(ins.get("stock"), s), "date": _merged(ins.get("date"), t)})
    return out
