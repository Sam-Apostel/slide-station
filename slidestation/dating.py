"""Dates from people: a person's birthday plus the age their face looks gives the year of the slide.

Every face gets an age from the age model (people.estimate_ages). Once the person it belongs to has
a birthday (People & Places), birthday + age is a year. The model has its own habits (it guesses
most adults a few years too old, some people always look younger than they are), so it is
**calibrated on the slides you dated yourself** (and, at half the weight, the ones in a tray you
dated: a tray is one stretch of time): there the real age is known, and the difference
between real and guessed age (in log(1 + age), where the error is about proportional to the age)
gives a correction for everyone (`bias`) and, as more of their slides are dated, for each person.
With nothing dated it falls back to the model as it is, with a wide spread. Someone without a
birthday who is on a slide you dated gets a birth year from it (that date minus the age they look).

Per slide the years of its people are combined weighted by their certainty (a 4-year-old dates a
slide to a year or so, a 50-year-old to ten). A tray is one stretch of time, so the people on the
slides around it count too (less, the further away) - and a scene of look-alike slides (an event,
similar.scenes) is one moment: its people are pooled and all its slides take their year - and so does the ordinary estimate from the
dated slides around it (store.slide_dates). The result is offered as a date suggestion (source
`people`) through the same plumbing as the film-stock guesses (filmstock.views): only for slides
without their own date, never outside the film stock's era, and only when it tells more than the
estimate already there (they contradict it, or are surer than it and put it outside its range). Birthdays are also a hard floor: a slide can't be older than anyone on it.
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
TRAY_WEIGHT = 0.5  # a face on a slide dated only by its tray teaches the calibration this much
PRIOR_SIGMA = 0.2  # the model's spread in log(1 + age) before any dated slide: ±20 %, ±6 y at 30
MIN_SD = 0.5  # years: nobody's age is known better than this from a face
NEAR = 12  # slides either side whose people count for this one
AGREE = 2.5  # two estimates this many (combined) SDs apart contradict: one of them is wrong
DRIFT = (0.5, 0.1)  # a neighbour's year counts as ± (a + b · distance) years less certain
MAX_SD = 8.0  # years: a vaguer guess isn't offered
MISNAMED = 6  # years: a face that looks this far from the person's age then (and AGREE SDs) isn't them…
WEAK_FIT = 0.35  # …if the slide is dated by hand, or it's this unlike (cosine) the average of their other faces


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
    {sid: {"name", "date" (the tray's, (year, SD) | None), "groups": {gid: {"index", "date", "own_from", "place", "key", "skip", "when"}}}}.
    `own_from` = the slide's own date came from accepting a people suggestion (so the calibration
    doesn't learn from its own guesses). `when` = (year, SD) the slide goes with without the people:
    its own date or the ordinary estimate (store.slide_dates, _prior), None when there's neither."""
    from .store import slide_dates

    out = {}
    with _slides_lock:
        for f in sorted((library() / "sessions").glob("*/session.json")):
            sid = f.parent.name
            try:
                mt = f.stat().st_mtime_ns
                hit = _slides.get(sid)
                if not hit or hit[0] != mt:
                    d = json.loads(f.read_text())
                    groups = d.get("groups", [])
                    dates = slide_dates(d)
                    gs = {}
                    for i, g in enumerate(groups):
                        ins = (g.get("insights") or {}).get("date") or {}
                        own_from = SOURCE if ins.get("source") == SOURCE and ins.get("state") == "accepted" \
                            and ins.get("value") == g.get("date") else ""
                        own = _span(g.get("date", ""))
                        gs[g["id"]] = {
                            "index": i, "date": g.get("date", ""), "place": g.get("place"),
                            "key": render_key(g), "skip": bool(g.get("skip")), "own_from": own_from,
                            "when": None if own_from else (own[0], max(0.25, own[1])) if own
                            else _prior(dates[i], i, groups),
                        }
                    hit = (mt, {"name": d.get("name", ""), "date": _span(d.get("date", "")), "groups": gs})
                    _slides[sid] = hit
            except (OSError, ValueError, KeyError):
                continue
            out[sid] = hit[1]
    return out


# --------------------------------------------------------------------------- calibration


def _ln(a: float) -> float:
    return math.log1p(max(a, 0.0))


def _wmedian(xs: list[tuple[float, float]]) -> float:
    """The weighted median of (value, weight) pairs (0 for none)."""
    xs = sorted(xs)
    half, acc = sum(w for _, w in xs) / 2, 0.0
    for i, (x, w) in enumerate(xs):
        acc += w
        if acc > half + 1e-9:
            return x
        if abs(acc - half) <= 1e-9:  # exactly half: between this one and the next
            return (x + xs[i + 1][0]) / 2 if i + 1 < len(xs) else x
    return 0.0


def calibrate(samples: list[tuple]) -> dict:
    """samples = (person, guessed age, real age[, weight]) on dated slides -> {"bias", "sigma", "n",
    "people"}: real ≈ exp(log1p(guess) + bias + people[p]) - 1, spread sigma in that log space - what
    is left after both corrections (someone the model always sees older is corrected, not vague).
    Medians, not means: a mask, a misnamed face or a slide from another year in a dated tray is
    one wild sample, and it mustn't move everyone's correction or widen everyone's spread. The
    common correction is the typical *person's*, each counting at most once: a child on fifty dated
    slides whom the model sees twice their age says nothing about how old their mother looks.
    n = the faces it learned from."""
    r = [(s[0], _ln(s[2]) - _ln(s[1]), s[3] if len(s) > 3 else 1.0) for s in samples]
    w = sum(x[2] for x in r)
    per: dict[str, list[tuple[float, float]]] = {}
    for p, x, wi in r:
        per.setdefault(p, []).append((x, wi))
    weight = {p: sum(wi for _, wi in xs) for p, xs in per.items()}
    k = sum(min(v, 1.0) for v in weight.values())  # people, each at most one
    bias = _wmedian([(_wmedian(xs), min(weight[p], 1.0)) for p, xs in per.items()]) * k / (k + PRIOR_N)
    own = {p: _wmedian([(x - bias, wi) for x, wi in xs]) * weight[p] / (weight[p] + PERSON_N) for p, xs in per.items()}
    spread = 1.4826 * _wmedian([(abs(x - bias - own[p]), wi) for p, x, wi in r])  # the MAD, as an SD
    sigma = math.sqrt((w * spread ** 2 + PRIOR_N * PRIOR_SIGMA ** 2) / (w + PRIOR_N))
    return {"bias": bias, "sigma": sigma, "n": len(r), "people": own}


def corrected(age: float, pid: str, cal: dict) -> tuple[float, float]:
    """A guessed age corrected by the calibration: (age, its SD in years)."""
    a = math.expm1(_ln(age) + cal["bias"] + cal["people"].get(pid, 0.0))
    return max(a, 0.0), max(MIN_SD, cal["sigma"] * (1 + a))


def samples(pdata: dict, faces: dict, slides: dict) -> list[tuple[str, float, float, float]]:
    """(person, guessed age, real age, weight) for every aged face of someone with a birthday on a
    slide with its own date (not one taken from a people suggestion), or else in a tray with a date
    (TRAY_WEIGHT: most of a tray is from when it says, not all)."""
    out = []
    for pid, p in pdata["people"].items():
        born = _span(p.get("birthday", ""))
        if not born:
            continue
        for f in p["faces"]:
            x = faces.get(f)
            if not x or "age" not in x:
                continue
            t = slides.get(x["sid"]) or {}
            s = t.get("groups", {}).get(x["gid"])
            if not s or s["own_from"]:
                continue
            when, weight = _span(s["date"]), 1.0
            if not when and not s["date"]:
                when, weight = t.get("date"), TRAY_WEIGHT
            if when and 0 <= when[0] - born[0] <= 110:
                out.append((pid, float(x["age"]), when[0] - born[0], weight))
    return out


def implied_births(pdata: dict, faces: dict, slides: dict, cal: dict) -> dict[str, tuple[float, float]]:
    """Birth years for the people without a birthday, from their slides you dated: the date minus
    the age they look there (corrected), as (year, SD). Someone's own habit (looking older than they
    are) is in that birth year and in every age it later dates, so it mostly cancels out. Faces that
    disagree with the rest (a mask, a misnamed face) are left out (_consensus)."""
    per: dict[str, list[tuple[float, float]]] = {}
    for pid, p in pdata["people"].items():
        if _span(p.get("birthday", "")):
            continue
        for f in p["faces"]:
            x = faces.get(f)
            if not x or "age" not in x:
                continue
            s = (slides.get(x["sid"]) or {}).get("groups", {}).get(x["gid"])
            when = _span(s["date"]) if s and not s["own_from"] else None
            if when:
                age, sd = corrected(x["age"], pid, cal)
                per.setdefault(pid, []).append((when[0] - age, math.hypot(sd, when[1])))
    return {pid: _consensus(parts)[0] for pid, parts in per.items()}


def suspects(pdata: dict, faces: dict, slides: dict, cal: dict, born: dict) -> dict[str, dict]:
    """Faces probably put with the wrong person: the age they look is far from the age that person
    was when the slide was taken (their birth year and the date the slide goes with without the
    people: its own, or the dated slides around it, or the tray's) - more than AGREE combined SDs
    and at least MISNAMED years. That alone could as well be a wrong date (trays aren't always in
    order, and that is what the people's dates are for), so it takes one more thing: the slide is
    dated by hand, or the face is a weak match for the person (WEAK_FIT). In a real tray labelled
    1977, "Tom (born 1968)" looking 37 matched his other faces at 0.19 (someone else); on a tray
    labelled 1971 he looked 13-27 at 0.46-0.60 (him, on slides from later). Faces the user put
    with them by hand are never doubted. {face id: {"pid", "looks", "age" (what they'd be), "year"}}."""
    import numpy as np

    out = {}
    for pid, p in pdata["people"].items():
        b = born.get(pid)
        if not b:
            continue
        sure = set(p.get("sure", ()))
        mine = [f for f in p["faces"] if f in faces]
        total = np.sum([faces[f]["emb"] for f in mine], 0) if len(mine) > 2 else None
        for f in p["faces"]:
            x = faces.get(f)
            if f in sure or not x or "age" not in x:
                continue
            s = (slides.get(x["sid"]) or {}).get("groups", {}).get(x["gid"])
            when = s and s["when"]
            if not when:
                continue
            looks, sd = corrected(x["age"], pid, cal)
            then = when[0] - b[0]
            off = abs(looks - then)
            if off < MISNAMED or off <= AGREE * math.hypot(sd, when[1], b[1]):
                continue
            weak = False
            if total is not None:  # the others' average direction, without this face
                rest = total - x["emb"]
                weak = float(x["emb"] @ rest) / (float(np.linalg.norm(rest)) or 1) < WEAK_FIT
            if weak or (s["date"] and not s["own_from"]):
                out[f] = {"pid": pid, "looks": round(looks), "age": max(0, round(then)), "year": int(when[0])}
    return out


_model_cache: tuple | None = None


def model(pdata: dict | None = None, faces: dict | None = None) -> tuple[dict, dict[str, tuple[float, float, bool]], dict]:
    """The library's calibration, everyone's birth year {pid: (year, SD, given)} — their birthday,
    else implied by their dated slides — and the faces whose age doesn't count: {face: suspects'
    entry, or None for the user's `ages_off`}, recomputed
    when people.json, a faces.json or a session changed. A suspect face teaches neither the
    calibration nor a birth year: they're looked for first with the model uncalibrated, then again."""
    global _model_cache
    pdata = pdata or people.load_people()
    faces = faces if faces is not None else people.all_faces()
    slides = library_slides()
    pf = people.people_file()
    stamp = (pf.stat().st_mtime_ns if pf.exists() else 0, len(faces),
             tuple(sorted((k, v[0]) for k, v in _slides.items())),
             tuple(sorted((k, v[0]) for k, v in people._face_cache.items())))
    if _model_cache and _model_cache[0] == stamp:
        return _model_cache[1]
    given = {pid: (*b, True) for pid, p in pdata["people"].items() if (b := _span(p.get("birthday", "")))}
    # found with the model as it is: a misnamed face on a dated slide would widen the calibration
    # enough to hide itself
    off = {f: None for f in pdata.get("ages_off", ())}  # ages the user said are wrong: no flag, no date
    odd = {**suspects(pdata, faces, slides, calibrate([]), given), **off}
    clean = {k: v for k, v in faces.items() if k not in odd} if odd else faces
    cal = calibrate(samples(pdata, clean, slides))
    born = {**given, **{pid: (*b, False) for pid, b in implied_births(pdata, clean, slides, cal).items()}}
    odd = {**suspects(pdata, faces, slides, cal, born), **off}
    _model_cache = (stamp, (cal, born, odd))
    return cal, born, odd


def calibration(pdata: dict | None = None, faces: dict | None = None) -> dict:
    """The library's calibration (model)."""
    return model(pdata, faces)[0]


# --------------------------------------------------------------------------- per tray


def _on_slides(sid: str, pdata: dict, faces: dict, odd: dict | None = None) -> dict[str, list[dict]]:
    """The recognised people on each slide of one tray: {gid: [{"pid", "name", "label", "born", "age"?}]},
    one entry per person (their clearest face). A face that doesn't fit its person (`odd`, suspects)
    gives no age: it's probably someone else."""
    best: dict[tuple[str, str], dict] = {}
    odd = odd or {}
    for pid, p in pdata["people"].items():
        for f in p["faces"]:
            x = faces.get(f)
            if not x or x["sid"] != sid:
                continue
            k = (x["gid"], pid)
            rank = (f not in odd, x.get("score", 0))
            if k not in best or rank > best[k]["rank"]:
                best[k] = {"pid": pid, "name": p.get("name", ""), "label": people.label(pid, p),
                           "born": p.get("birthday", ""), "score": x.get("score", 0), "rank": rank,
                           **({"age": x["age"]} if "age" in x and f not in odd else {})}
    out: dict[str, list[dict]] = {}
    for (gid, _), e in sorted(best.items(), key=lambda kv: -kv[1]["score"]):
        out.setdefault(gid, []).append(e)
    return out


def slide_faces(sid: str, groups: list[dict], pdata: dict, faces: dict, cal: dict, odd: dict) -> dict[str, list[dict]]:
    """Every face on each slide of a tray, left to right, for correcting who is who on the slide:
    {gid: [{"id", "url", "box" (0..1 of the slide as it's turned now; None when the face was found
    turned otherwise), "person", "label", "named", "age" (looks, corrected; None when the user said it's wrong), "odd" (suspects: {"age",
    "year"}, they'd be `age` in `year`) | None}]}."""
    owner = {f: pid for pid, p in pdata["people"].items() for f in p["faces"]}
    entries = people.load_faces(sid)
    out: dict[str, list[dict]] = {}
    for g in groups:
        e = entries.get(g["id"]) or {}
        upright = e.get("rot", 0) == g["rotation"] and bool(e.get("mirror")) == bool(g.get("mirror"))
        rows = []
        for x in sorted(e.get("faces", []), key=lambda x: x["box"][0]):
            f, pid = x["id"], owner.get(x["id"])
            p = pdata["people"].get(pid) if pid else None
            o = odd.get(f)
            rows.append({
                "id": f, "url": f"/api/people/faces/{f}.jpg?v={render_key(g)}",
                "box": x["box"] if upright else None, "person": pid, "label": people.label(pid, p) if p else "",
                "named": bool(p and p.get("name")),
                "age": round(corrected(x["age"], pid or "", cal)[0]) if "age" in x and not (f in odd and not o) else None,
                "odd": {"age": o["age"], "year": o["year"]} if o else None,
            })
        if rows:
            out[g["id"]] = rows
    return out


def _combine(parts: list[tuple[float, float]]) -> tuple[float, float] | None:
    """Inverse-variance mean of (value, SD) pairs."""
    if not parts:
        return None
    w = [1 / sd ** 2 for _, sd in parts]
    return sum(v * wi for (v, _), wi in zip(parts, w)) / sum(w), math.sqrt(1 / sum(w))


def _consensus(parts: list[tuple[float, float]]) -> tuple[tuple[float, float] | None, list[int]]:
    """The (value, SD) pairs that agree with the most others (ties: the surest) combined, and which
    those were; the ones that contradict them are left out, not averaged in."""
    if not parts:
        return None, []
    friends = [[j for j, b in enumerate(parts) if _agree(a, b)] for a in parts]
    best = max(range(len(parts)), key=lambda i: (len(friends[i]), -parts[i][1]))
    return _combine([parts[j] for j in friends[best]]), friends[best]


def _prior(e: dict, i: int, groups: list[dict]) -> tuple[float, float] | None:
    """The ordinary estimate (store.slide_dates) as (year, SD): between two dated slides it is good
    to a quarter of their gap; the nearest one's or the tray's date less."""
    v = _span(e.get("value", "")) if e.get("source") in ("between", "near", "tray") else None
    if not v:
        return None
    if e["source"] == "between":
        a, b = (_span(groups[j].get("date", "")) for j in e["from"])
        return v[0], max(0.5, abs(a[0] - b[0]) / 4)
    if e["source"] == "near":
        return v[0], 1.5 + 0.1 * abs(i - e["from"][0])
    return v[0], 1.5  # what's written on a tray: most of it is from then (a few slides may not be)


_events_cache: dict[str, tuple] = {}


def _events(sid: str, groups: list[dict]) -> list[tuple[int, int]]:
    """The tray's events: its scenes (similar.scenes, runs of look-alike slides) of two or more
    slides, as (first, last) slide indices; [] before the slides are embedded."""
    from . import similar

    f = similar.emb_file(sid)
    try:
        stamp = (f.stat().st_mtime_ns if f.exists() else 0,
                 tuple((g["id"], similar.slide_key(g), bool(g.get("skip"))) for g in groups))
        hit = _events_cache.get(sid)
        if not hit or hit[0] != stamp:
            sc = similar.scenes(groups, similar.load(sid)) if stamp[0] else []
            hit = (stamp, [(x["start"], x["end"]) for x in sc if x["end"] > x["start"]])
            _events_cache[sid] = hit
        return hit[1]
    except (OSError, ValueError, KeyError):
        return []


def _median(xs: list[float]) -> float:
    xs = sorted(xs)
    m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2


def _say(ps: dict[str, tuple]) -> tuple[tuple[float, float], frozenset, list[str]] | None:
    """People {pid: (year, SD, age, label)} -> (their year, who, "Ann ≈ 30" for the ones it rests on)."""
    if not ps:
        return None
    pids = list(ps)
    year, keep = _consensus([ps[p][:2] for p in pids])
    return year, frozenset(pids), [f"{ps[pids[j]][3]} ≈ {round(ps[pids[j]][2])}" for j in keep]


def tray_view(sid: str, d: dict, dates: list[dict], pdata: dict | None = None, faces: dict | None = None) -> list[dict]:
    """Per slide of a tray {"people": [{"id", "name", "age" (corrected, or None)}], "faces": every face
    on it (slide_faces), "year": (value, SD) | None, "floor": year | None, "suggestion": entry | None}."""
    pdata = pdata or people.load_people()
    faces = faces if faces is not None else people.all_faces()
    groups = d["groups"]
    n = len(groups)
    cal, born, odd = model(pdata, faces)
    on = _on_slides(sid, pdata, faces, odd)
    every = slide_faces(sid, groups, pdata, faces, cal, odd)
    # the year each person on a slide puts it in: {pid: (year, age SD, birth SD, age, label)}
    per: list[dict[str, tuple]] = []
    views = []
    for g in groups:
        ppl, mine, floor = [], {}, None
        for e in on.get(g["id"], []):
            b = born.get(e["pid"])
            age = e.get("age")
            if age is not None and b:
                age, sd = corrected(age, e["pid"], cal)
                mine[e["pid"]] = (b[0] + age, sd, b[1], age, e["label"])
            if b and b[2]:  # nobody is on a slide from before they were born
                floor = max(floor or 0, int(b[0]))
            if e["name"] or e["born"]:
                ppl.append({"id": e["pid"], "name": e["name"], "age": None if age is None else round(age)})
        per.append(mine)
        views.append({"people": ppl, "faces": every.get(g["id"], []), "floor": floor, "year": None, "suggestion": None})

    # an event (a scene of look-alike slides) is one moment: its people are pooled - each person
    # once, at the median of the years their faces there say (a mask or a turned head that looks
    # 46 doesn't count), surer the more slides they're on - and its slides without people share it
    unit = list(range(n))
    for k, (a, b) in enumerate(_events(sid, groups)):
        for i in range(a, b + 1):
            unit[i] = n + k
    members: dict[int, list[int]] = {}
    for i, u in enumerate(unit):
        members.setdefault(u, []).append(i)
    own = [_say({p: (x[0], math.hypot(x[1], x[2]), x[3], x[4]) for p, x in m.items()}) for m in per]
    event, event_date = {}, {}
    for u, idx in members.items():
        if len(idx) < 2:
            continue
        seen: dict[str, list[tuple]] = {}
        for i in idx:
            for p, x in per[i].items():
                seen.setdefault(p, []).append(x)
        event[u] = _say({p: (_median([x[0] for x in xs]),
                             math.hypot(_median([x[1] for x in xs]) / math.sqrt(min(len(xs), 3)), xs[0][2]),
                             _median([x[3] for x in xs]), xs[0][4]) for p, xs in seen.items()})
        # a slide of it dated by hand dates the rest, give or take a season
        dated = [_span(groups[i].get("date", "")) for i in idx]
        event_date[u] = _consensus([(x[0], max(0.25, x[1])) for x in dated if x])[0]
    # what each slide's people say: its event's (when it agrees with it) or its own
    says, joined = [], []
    for i in range(n):
        e, o = event.get(unit[i]), own[i]
        j = unit[i] >= n and not (e and o and not _agree(o[0], e[0]))
        joined.append(j)
        says.append(e if j and e else o)

    for i, (g, v) in enumerate(zip(groups, views)):
        # the slide's own people (or its event's) anchor it, else a dated slide of its event, else
        # the most certain neighbour; the people around it and the ordinary estimate join only when
        # they agree - a tray isn't always in order, and a misnamed face shouldn't be averaged into a
        # year nobody says. A person's slides share their error (someone who looks older does on
        # every slide), so a neighbour only counts with someone new: the nearest slide of each set of people
        mine = says[i]
        who = mine[1] if mine else frozenset()
        near, seen_sets = [], {who}
        for j in sorted(range(max(0, i - NEAR), min(n, i + NEAR + 1)), key=lambda j: abs(i - j)):
            s = says[j]
            if j == i or not s or parse_date(groups[j].get("date", "")) or s[1] in seen_sets or s[1] <= who:
                continue
            seen_sets.add(s[1])
            near.append((s[0][0], math.hypot(s[0][1], DRIFT[0] + DRIFT[1] * abs(i - j))))
        sib = event_date.get(unit[i]) if joined[i] and not parse_date(g.get("date", "")) else None
        anchor = mine[0] if mine else sib or min(near, key=lambda x: x[1], default=None)
        if not anchor:
            continue
        parts = [anchor] + [x for x in near if x is not anchor and _agree(x, anchor)]
        against = None
        if sib and sib is not anchor:
            if _agree(sib, anchor):
                parts.append(sib)
            else:
                against = int(sib[0])
        base = _combine(parts)
        prior = _prior(dates[i], i, groups)
        if prior and _agree(prior, base):
            parts.append(prior)
        elif prior and against is None:
            against = int(prior[0])  # the slides around it say otherwise
        y, sd = _combine(parts)
        v["year"] = (round(y, 2), round(sd, 2))
        if prior and against is None and (base[1] >= prior[1] or abs(base[0] - prior[0]) <= prior[1]):
            continue  # the people agree with the estimate already there, and know less or say what it says
        by = mine[2] if mine else []
        v["suggestion"] = _suggest(d, g, dates[i], y, sd, v, by, against, anchor is sib)
    return views


def _agree(a: tuple[float, float], b: tuple[float, float]) -> bool:
    return abs(a[0] - b[0]) <= AGREE * math.hypot(a[1], b[1])


def _suggest(d: dict, g: dict, e: dict, y: float, sd: float, v: dict, who: list[str], against: int | None,
             by_event: bool = False) -> dict | None:
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
    text = ", ".join(who[:3]) + (f" +{len(who) - 3}" if len(who) > 3 else "") if who \
        else "a dated slide of the same scene" if by_event else "the people on the slides around it"
    if against is not None:
        text += f"; the dated slides around it say {against}"
    conf = round(min(0.9, max(0.3, 0.9 - 0.08 * sd)), 2)
    return {"value": str(year), "confidence": conf, "source": SOURCE, "state": "suggested",
            "text": f"{text} (± {max(1, round(sd))} y)"}


def views(sid: str, d: dict, dates: list[dict], pdata: dict | None = None,
          faces: dict | None = None) -> tuple[list[dict], list[dict]]:
    """filmstock.views with the people's date guess in place of the neighbours' where there is one,
    and the per-slide people view (tray_view) for the payload."""
    live = filmstock.views(d, dates)
    try:
        ppl = tray_view(sid, d, dates, pdata, faces)
    except Exception as e:  # dating is extra: never let it break a tray
        print("dating:", e)
        return live, [{"people": [], "faces": [], "floor": None, "year": None, "suggestion": None} for _ in d["groups"]]
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
    their birthday), its place, who they're seen with, and the faces that are probably someone else (`odd`). KeyError: no such person."""
    from .store import Session, slide_dates

    pdata = pdata or people.load_people()
    p = pdata["people"][pid]
    faces = people.all_faces()
    cal, _, odd = model(pdata, faces)
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
        live = views(sid, d, dates, pdata, faces)[0]
        at = {g["id"]: i for i, g in enumerate(d["groups"])}
        for (s, gid), (f, x) in best.items():
            if s != sid or gid not in at:
                continue
            i = at[gid]
            g = d["groups"][i]
            est = dates[i]
            # the people's (and the scene's) year where it says something else and isn't turned down:
            # "age 2, looks 27" means the slides around it got it wrong
            guess = live[i]["date"]
            if guess and guess.get("source") == SOURCE and guess.get("state") == "suggested":
                est = {"value": guess["value"], "source": SOURCE}
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
                # the face looks far from their age then: probably someone else (suspects)
                "odd": {"age": odd[f]["age"], "year": odd[f]["year"]} if odd.get(f) else None,
            })
    slides.sort(key=lambda s: (not s["date"], s["date"], s["tray"], s["index"]))
    with_ = sorted(({"id": q, "name": pdata["people"][q].get("name", ""), "slides": n} for q, n in together.items()
                    if q in pdata["people"]), key=lambda w: -w["slides"])
    return {"id": pid, "name": p.get("name", ""), "birthday": p.get("birthday", ""), "slides": slides,
            "with": with_[:12]}
