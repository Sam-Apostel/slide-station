"""Dates from people: a person's birthday plus the age their face looks gives the year of the slide.

Every face gets an age from the age model (people.estimate_ages). Once the person it belongs to has
a birthday (People & Places), birthday + age is a year. The model has its own habits (it guesses
most adults a few years too old, some people always look younger than they are), so it is
**calibrated on the slides you dated yourself**: there the real age is known, and the difference
between real and guessed age (in log(1 + age), where the error is about proportional to the age)
gives a correction for everyone (`bias`) and, as more of their slides are dated, for each person.
With nothing dated it falls back to the model as it is, with a wide spread.

Per slide the years of its people are combined weighted by their certainty (a 4-year-old dates a
slide to a year or so, a 50-year-old to ten). A tray is one stretch of time, so the people on the
slides around it count too (less, the further away), and so does the ordinary estimate from the
dated slides around it (store.slide_dates). The result is offered as a date suggestion (source
`people`) through the same plumbing as the film-stock guesses (filmstock.views): only for slides
without their own date, never outside the film stock's era, and only when it tells more than the
estimate already there. Birthdays are also a hard floor: a slide can't be older than anyone on it.
"""
from __future__ import annotations

import json
import math
import threading
from datetime import datetime

from . import filmstock, people
from .store import library, parse_date, render_key

SOURCE = "people"

PRIOR_N = 3  # the calibration's bias starts at 0 as if from this many slides
PERSON_N = 4  # a person's own correction, shrunk towards the common one like this
PRIOR_SIGMA = 0.2  # the model's spread in log(1 + age) before any dated slide: ±20 %, ±6 y at 30
MIN_SD = 0.5  # years: nobody's age is known better than this from a face
NEAR = 12  # slides either side whose people count for this one
AGREE = 2.5  # two estimates this many (combined) SDs apart contradict: one of them is wrong
DRIFT = (0.5, 0.1)  # a neighbour's year counts as ± (a + b · distance) years less certain
MAX_SD = 8.0  # years: a vaguer guess isn't offered


def years(t: datetime) -> float:
    """A date as a fractional year."""
    start = datetime(t.year, 1, 1)
    return t.year + (t - start).total_seconds() / (datetime(t.year + 1, 1, 1) - start).total_seconds()


def _span(v: str) -> tuple[float, float] | None:
    """A typed date as (middle, spread in years): '1978' is mid-1978 give or take a year's third."""
    p = parse_date(v)
    if not p:
        return None
    t, precision = p
    width = [1.0, 1 / 12, 1 / 365][precision - 1]
    return years(t) + width / 2, width / math.sqrt(12)  # the SD of a uniform over the period


# --------------------------------------------------------------------------- the library's slides

_slides_lock = threading.Lock()
_slides: dict[str, tuple[int, dict]] = {}


def library_slides() -> dict[str, dict]:
    """Every tray's slides as far as people and places go, re-read only for trays that changed:
    {sid: {"name", "groups": {gid: {"index", "date", "own_from", "place", "key", "skip"}}}}.
    `own_from` = the slide's own date came from accepting a people suggestion (so the calibration
    doesn't learn from its own guesses)."""
    out = {}
    with _slides_lock:
        for f in sorted((library() / "sessions").glob("*/session.json")):
            sid = f.parent.name
            try:
                mt = f.stat().st_mtime_ns
                hit = _slides.get(sid)
                if not hit or hit[0] != mt:
                    d = json.loads(f.read_text())
                    gs = {}
                    for i, g in enumerate(d.get("groups", [])):
                        ins = (g.get("insights") or {}).get("date") or {}
                        gs[g["id"]] = {
                            "index": i, "date": g.get("date", ""), "place": g.get("place"),
                            "key": render_key(g), "skip": bool(g.get("skip")),
                            "own_from": SOURCE if ins.get("source") == SOURCE and ins.get("state") == "accepted"
                            and ins.get("value") == g.get("date") else "",
                        }
                    hit = (mt, {"name": d.get("name", ""), "groups": gs})
                    _slides[sid] = hit
            except (OSError, ValueError, KeyError):
                continue
            out[sid] = hit[1]
    return out


# --------------------------------------------------------------------------- calibration


def _ln(a: float) -> float:
    return math.log1p(max(a, 0.0))


def calibrate(samples: list[tuple[str, float, float]]) -> dict:
    """samples = (person, guessed age, real age) on dated slides -> {"bias", "sigma", "n", "people"}:
    real ≈ exp(log1p(guess) + bias + people[p]) - 1, spread sigma in that log space."""
    r = [(p, _ln(real) - _ln(guess)) for p, guess, real in samples]
    n = len(r)
    bias = sum(x for _, x in r) / (n + PRIOR_N)
    sigma = math.sqrt((sum((x - bias) ** 2 for _, x in r) + PRIOR_N * PRIOR_SIGMA ** 2) / (n + PRIOR_N))
    per: dict[str, list[float]] = {}
    for p, x in r:
        per.setdefault(p, []).append(x - bias)
    return {"bias": bias, "sigma": sigma, "n": n,
            "people": {p: sum(xs) / (len(xs) + PERSON_N) for p, xs in per.items()}}


def corrected(age: float, pid: str, cal: dict) -> tuple[float, float]:
    """A guessed age corrected by the calibration: (age, its SD in years)."""
    a = math.expm1(_ln(age) + cal["bias"] + cal["people"].get(pid, 0.0))
    return max(a, 0.0), max(MIN_SD, cal["sigma"] * (1 + a))


def samples(pdata: dict, faces: dict, slides: dict) -> list[tuple[str, float, float]]:
    """(person, guessed age, real age) for every aged face of someone with a birthday on a slide
    with its own date (not one taken from a people suggestion)."""
    out = []
    for pid, p in pdata["people"].items():
        born = _span(p.get("birthday", ""))
        if not born:
            continue
        for f in p["faces"]:
            x = faces.get(f)
            if not x or "age" not in x:
                continue
            s = (slides.get(x["sid"]) or {}).get("groups", {}).get(x["gid"])
            when = _span(s["date"]) if s and not s["own_from"] else None
            if when and 0 <= when[0] - born[0] <= 110:
                out.append((pid, float(x["age"]), when[0] - born[0]))
    return out


_cal_cache: tuple | None = None


def calibration(pdata: dict | None = None, faces: dict | None = None) -> dict:
    """The library's calibration, recomputed when people.json, a faces.json or a session changed."""
    global _cal_cache
    pdata = pdata or people.load_people()
    faces = faces if faces is not None else people.all_faces()
    slides = library_slides()
    pf = people.people_file()
    stamp = (pf.stat().st_mtime_ns if pf.exists() else 0, len(faces),
             tuple(sorted((k, v[0]) for k, v in _slides.items())),
             tuple(sorted((k, v[0]) for k, v in people._face_cache.items())))
    if _cal_cache and _cal_cache[0] == stamp:
        return _cal_cache[1]
    cal = calibrate(samples(pdata, faces, slides))
    _cal_cache = (stamp, cal)
    return cal


# --------------------------------------------------------------------------- per tray


def _on_slides(sid: str, pdata: dict, faces: dict) -> dict[str, list[dict]]:
    """The recognised people on each slide of one tray: {gid: [{"pid", "name", "born", "age"?}]},
    one entry per person (their clearest face)."""
    best: dict[tuple[str, str], dict] = {}
    for pid, p in pdata["people"].items():
        for f in p["faces"]:
            x = faces.get(f)
            if not x or x["sid"] != sid:
                continue
            k = (x["gid"], pid)
            if k not in best or x.get("score", 0) > best[k]["score"]:
                best[k] = {"pid": pid, "name": p.get("name", ""), "born": p.get("birthday", ""),
                           "score": x.get("score", 0), **({"age": x["age"]} if "age" in x else {})}
    out: dict[str, list[dict]] = {}
    for (gid, _), e in sorted(best.items(), key=lambda kv: -kv[1]["score"]):
        out.setdefault(gid, []).append(e)
    return out


def _combine(parts: list[tuple[float, float]]) -> tuple[float, float] | None:
    """Inverse-variance mean of (value, SD) pairs."""
    if not parts:
        return None
    w = [1 / sd ** 2 for _, sd in parts]
    return sum(v * wi for (v, _), wi in zip(parts, w)) / sum(w), math.sqrt(1 / sum(w))


def _prior(e: dict, i: int, groups: list[dict]) -> tuple[float, float] | None:
    """The ordinary estimate (store.slide_dates) as (year, SD): between two dated slides it is good
    to a quarter of their gap; the nearest one's or the tray's date much less."""
    v = _span(e.get("value", "")) if e.get("source") in ("between", "near", "tray") else None
    if not v:
        return None
    if e["source"] == "between":
        a, b = (_span(groups[j].get("date", "")) for j in e["from"])
        return v[0], max(0.5, abs(a[0] - b[0]) / 4)
    if e["source"] == "near":
        return v[0], 1.5 + 0.1 * abs(i - e["from"][0])
    return v[0], 3.0


def tray_view(sid: str, d: dict, dates: list[dict], pdata: dict | None = None, faces: dict | None = None) -> list[dict]:
    """Per slide of a tray {"people": [{"id", "name", "age" (corrected, or None)}], "year": (value, SD)
    | None, "floor": year | None, "suggestion": entry | None}."""
    pdata = pdata or people.load_people()
    faces = faces if faces is not None else people.all_faces()
    groups = d["groups"]
    on = _on_slides(sid, pdata, faces)
    has_birthdays = any(p.get("birthday") for p in pdata["people"].values())
    cal = calibration(pdata, faces) if has_birthdays else None
    own_years: list[tuple[float, float] | None] = []
    dated_by: list[frozenset] = []  # whose ages date each slide
    views = []
    for g in groups:
        ppl, parts, floor, by, pids = [], [], None, [], set()
        for e in on.get(g["id"], []):
            born = _span(e["born"])
            age = sd = None
            if "age" in e and cal is not None and born:
                age, sd = corrected(e["age"], e["pid"], cal)
                parts.append((born[0] + age, math.hypot(sd, born[1])))
                by.append(f"{e['name'] or 'someone'} ≈ {round(age)}")
                pids.add(e["pid"])
            elif "age" in e:
                age = e["age"]
            if born:  # nobody is on a slide from before they were born
                floor = max(floor or 0, int(born[0]))
            if e["name"] or born:
                ppl.append({"id": e["pid"], "name": e["name"], "age": None if age is None else round(age)})
        own_years.append(_combine(parts))
        dated_by.append(frozenset(pids))
        views.append({"people": ppl, "floor": floor, "year": None, "suggestion": None, "by": by})

    for i, (g, v) in enumerate(zip(groups, views)):
        # the slide's own people anchor it (else the most certain neighbour); the people around it
        # and the ordinary estimate join only when they agree - a tray isn't always in order, and a
        # misnamed face shouldn't be averaged into a year nobody says
        # a person's slides share their error (someone who looks older does on every slide), so a
        # neighbour only counts with someone new: the nearest slide of each set of people
        near, seen = [], {dated_by[i]}
        for j in sorted(range(max(0, i - NEAR), min(len(groups), i + NEAR + 1)), key=lambda j: abs(i - j)):
            if j == i or not own_years[j] or parse_date(groups[j].get("date", "")) \
                    or dated_by[j] in seen or dated_by[j] <= dated_by[i]:
                continue
            seen.add(dated_by[j])
            near.append((own_years[j][0], math.hypot(own_years[j][1], DRIFT[0] + DRIFT[1] * abs(i - j))))
        anchor = own_years[i] or min(near, key=lambda x: x[1], default=None)
        if not anchor:
            continue
        parts = [anchor] + [x for x in near if x is not anchor and _agree(x, anchor)]
        base = _combine(parts)
        prior = _prior(dates[i], i, groups)
        against = None
        if prior and _agree(prior, base):
            parts.append(prior)
        elif prior:
            against = int(prior[0])  # the slides around it say otherwise
        y, sd = _combine(parts)
        v["year"] = (round(y, 2), round(sd, 2))
        v["suggestion"] = _suggest(d, g, dates[i], y, sd, v, against)
    for v in views:
        del v["by"]
    return views


def _agree(a: tuple[float, float], b: tuple[float, float]) -> bool:
    return abs(a[0] - b[0]) <= AGREE * math.hypot(a[1], b[1])


def _suggest(d: dict, g: dict, e: dict, y: float, sd: float, v: dict, against: int | None) -> dict | None:
    """The date to offer: the year, lifted to the birthday floor, inside the stock's era, and only
    when it isn't the year the slide goes with already."""
    if parse_date(g.get("date", "")) or g.get("skip") or sd > MAX_SD:
        return None
    year = int(math.floor(y))
    if v["floor"] is not None and year < v["floor"]:
        year = v["floor"]
    if not filmstock.fits(year, filmstock.effective(d, g)):
        return None
    if e.get("value") and int(e["value"][:4]) == year:
        return None  # what the slide already goes with: nothing to add
    who = v["by"]
    text = ", ".join(who[:3]) + (f" +{len(who) - 3}" if len(who) > 3 else "") if who \
        else "the people on the slides around it"
    if against is not None:
        text += f"; the dated slides around it say {against}"
    conf = round(min(0.9, max(0.3, 0.9 - 0.08 * sd)), 2)
    return {"value": str(year), "confidence": conf, "source": SOURCE, "state": "suggested",
            "text": f"{text} (± {max(1, round(sd))} y)"}


def views(sid: str, d: dict, dates: list[dict]) -> tuple[list[dict], list[dict]]:
    """filmstock.views with the people's date guess in place of the neighbours' where there is one,
    and the per-slide people view (tray_view) for the payload."""
    live = filmstock.views(d, dates)
    try:
        ppl = tray_view(sid, d, dates)
    except Exception as e:  # dating is extra: never let it break a tray
        print("dating:", e)
        return live, [{"people": [], "floor": None, "year": None, "suggestion": None} for _ in d["groups"]]
    for g, x, p in zip(d["groups"], live, ppl):
        if p["suggestion"]:
            x["date"] = filmstock._merged((g.get("insights") or {}).get("date"), p["suggestion"])
    return live, ppl


# --------------------------------------------------------------------------- people & places


def atlas() -> dict:
    """Every place in the library with its slides (and who is on them), for the map."""
    slides = library_slides()
    pdata = people.load_people()
    faces = people.all_faces()
    who: dict[tuple[str, str], list[str]] = {}
    for pid, p in pdata["people"].items():
        for f in p["faces"]:
            x = faces.get(f)
            if x:
                ids = who.setdefault((x["sid"], x["gid"]), [])
                if pid not in ids:
                    ids.append(pid)
    places: dict[str, dict] = {}
    for sid, t in slides.items():
        for gid, s in sorted(t["groups"].items(), key=lambda kv: kv[1]["index"]):
            pl = s["place"]
            if not pl or s["skip"]:
                continue
            k = f"{pl.get('name', '')}@{pl['lat']:.3f},{pl['lon']:.3f}"
            e = places.setdefault(k, {"id": k, **{x: pl.get(x) for x in ("name", "lat", "lon", "country", "admin")},
                                      "slides": []})
            e["slides"].append({"sid": sid, "gid": gid, "tray": t["name"], "index": s["index"],
                                "date": s["date"], "key": s["key"], "people": who.get((sid, gid), [])})
    out = sorted(places.values(), key=lambda p: -len(p["slides"]))
    return {"places": out, "slides": sum(len(p["slides"]) for p in out)}


def person(pid: str, pdata: dict | None = None) -> dict:
    """One person's page in People & Places: every slide they're on (their clearest face there),
    the date it goes with, the age they look on it (corrected) and the age they were then (from
    their birthday), its place, and who they're seen with. KeyError: no such person."""
    from .store import Session, slide_dates

    pdata = pdata or people.load_people()
    p = pdata["people"][pid]
    faces = people.all_faces()
    cal = calibration(pdata, faces)
    born = _span(p.get("birthday", ""))
    best: dict[tuple[str, str], tuple[str, dict]] = {}
    for f in p["faces"]:
        x = faces.get(f)
        if x and ((x["sid"], x["gid"]) not in best or x.get("score", 0) > best[(x["sid"], x["gid"])][1].get("score", 0)):
            best[(x["sid"], x["gid"])] = (f, x)
    owner = {f: q for q, v in pdata["people"].items() for f in v["faces"]}
    on_slide: dict[tuple[str, str], set[str]] = {}
    for f, y in faces.items():
        if owner.get(f) not in (None, pid):
            on_slide.setdefault((y["sid"], y["gid"]), set()).add(owner[f])
    together: dict[str, int] = {}
    slides = []
    for sid in sorted({s for s, _ in best}):
        try:
            d = Session(sid).data
        except (FileNotFoundError, ValueError):
            continue
        dates = slide_dates(d)
        at = {g["id"]: i for i, g in enumerate(d["groups"])}
        for (s, gid), (f, x) in best.items():
            if s != sid or gid not in at:
                continue
            i = at[gid]
            g = d["groups"][i]
            est = dates[i]
            when = _span(est["value"])
            for q in on_slide.get((sid, gid), ()):
                together[q] = together.get(q, 0) + 1
            slides.append({
                "sid": sid, "gid": gid, "tray": d.get("name", ""), "index": i, "key": render_key(g),
                "face": {"id": f, "url": f"/api/people/faces/{f}.jpg?v={render_key(g)}"},
                "looks": round(corrected(x["age"], pid, cal)[0]) if "age" in x else None,
                "age": round(when[0] - born[0], 1) if when and born else None,  # from the birthday
                "date": est["value"], "date_source": est["source"], "place": g.get("place"),
                "skip": bool(g.get("skip")), "locked": bool(g.get("locked")),
            })
    slides.sort(key=lambda s: (not s["date"], s["date"], s["tray"], s["index"]))
    with_ = sorted(({"id": q, "name": pdata["people"][q].get("name", ""), "slides": n} for q, n in together.items()
                    if q in pdata["people"]), key=lambda w: -w["slides"])
    return {"id": pid, "name": p.get("name", ""), "birthday": p.get("birthday", ""), "slides": slides,
            "with": with_[:12]}
