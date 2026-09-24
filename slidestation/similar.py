"""Look-alikes: what CLIP image embeddings say about slides that belong together (or don't).

The scene-tag model (insights.py) already embeds every slide's upright blend; that embedding is kept
here, per tray, in `sessions/<id>/embeddings.json` (derived data next to session.json, never in it,
like faces.json):

    {"slides": {gid: {"key", "emb", "q": {"sharp", "clipped"},     the upright blend (+ its quality,
                      "eyes": {"model", "ear": [...]}}},           and its faces' eyes: eyes.py)
     "scans": {scan: {"emb", "lum"}}}                               each scan unturned, exposure-normalised

`emb` is a unit vector as base64 float16. A slide's `key` is its active scans + rotation: turned or
re-stacked, it is embedded again. Scans never change, so theirs are keyed by the scan alone.

From those, suggestions (all tray-level, none applied silently; accepted / dismissed through
`POST …/insights/decide` like the tags):

- **duplicates**: slides a few places apart whose blends are nearly the same picture (the same shot
  taken twice, not a bracket): "keep the best, skip the rest", best = sharpest and least clipped,
  and - with the eye model on (eyes.py) - the one where nobody blinked.
- **split**: a bracket the structural signature merged whose scans CLIP says are different pictures.
- **merge**: neighbouring slides the signature kept apart whose scans CLIP says are one frame at
  two exposures.
- **scenes**: runs of similar slides (change points of the embeddings), shown in the filmstrip.

And after upload, optionally, a look-alike check against Immich (`check_lookalikes`).
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import threading
from datetime import timedelta
from pathlib import Path

import numpy as np

from . import eyes
from . import imaging as im
from .store import Session, _atomic_write, active_scans, library, parse_date, slide_dates

KINDS = ("duplicates", "split", "merge")
MODEL_ID = "clip-vit-b32"  # insights.MODEL_ID: the embeddings come from the scene-tag model

# Thresholds on cosine similarity of CLIP ViT-B/32 image embeddings. Measured with the real model on
# synthetic scenes (tests/test_similar.py, SS_REAL_CLIP=1; ARCHITECTURE "Look-alikes"): a bracket's
# scans, exposure-normalised, 0.85-1.0 (median 0.97-0.996); the same scene re-shot (moved, zoomed,
# turned a little) 0.90-0.99; different scenes 0.70-0.90. Synthetic scenes are simpler than photos
# (two different cartoon beaches score 0.98), so the duplicate threshold sits where CLIP near-duplicate
# work puts real photos rather than at the synthetic gap, and it learns from dismissals.
DUPLICATE = 0.93  # two slides' blends: the same shot
DUPLICATE_MAX = 0.97  # ... raised up to this by dismissals (like a tag's threshold)
WINDOW = 3  # duplicates are looked for this many slides apart at most (the same shot twice sits close)
SPLIT = 0.80  # a scan of a bracket this unlike all the scans before it: possibly another slide
# merge: the signature (SAME_SLIDE 0.86) came close and CLIP agrees. A clipped bracket scan loses
# both: 1.6-1.8x over-exposed, signatures fall to 0.77-0.82 and CLIP (normalised) to 0.85-0.87,
# while different scenes rarely score high on both (signature median 0.12).
MERGE = 0.85  # neighbouring slides' touching scans this alike, exposure-normalised...
MERGE_STOPS = 0.3  # ... at exposures at least this far apart (log2 of mean brightness)...
MERGE_STRUCT = 0.6  # ... and structurally close (imaging.similarity of the signatures)
SCENE = 0.80  # a slide this unlike its scene's last few slides (and so is the next): a new scene
SCENE_SPAN = 4  # the scene's "last few"
# "keep the best" of duplicates with faces: quality (as a share of the cluster's best) x
# (1 - EYES_WEIGHT + EYES_WEIGHT x how open the eyes are). Eyes closed keep 40 %: a blink loses unless
# the open-eyed shot is under 40 % as sharp (best-of-bracket already drops a scan below 60 %).
EYES_WEIGHT = 0.6

_lock = threading.RLock()


# --------------------------------------------------------------------------- storage


def _pack(e: np.ndarray) -> str:
    return base64.b64encode(np.asarray(e, np.float16).tobytes()).decode()


def unpack(s: str) -> np.ndarray:
    e = np.frombuffer(base64.b64decode(s), np.float16).astype(np.float32)
    return e / (np.linalg.norm(e) or 1)


def emb_file(sid: str) -> Path:
    return library() / "sessions" / sid / "embeddings.json"


def load(sid: str) -> dict:
    f = emb_file(sid)
    try:
        d = json.loads(f.read_text()) if f.exists() else {}
    except ValueError:
        d = {}
    d.setdefault("slides", {})
    d.setdefault("scans", {})
    return d


def update(sid: str, fn) -> dict:
    """Apply fn(embeddings) to a freshly loaded embeddings.json under the lock, then save."""
    with _lock:
        d = load(sid)
        fn(d)
        _atomic_write(emb_file(sid), d)
        return d


def slide_key(g: dict) -> str:
    """What a slide's embedding was computed from: its blended scans, turned upright."""
    return hashlib.sha1(json.dumps([active_scans(g), g["rotation"], MODEL_ID]).encode()).hexdigest()[:12]


def record_slide(sid: str, g: dict, emb: np.ndarray, rgb: np.ndarray) -> None:
    """Keep a slide's embedding (of its upright blend `rgb`) and the blend's sharpness / clipping,
    and how open its faces' eyes are when the eye model is on."""
    entry = {"key": slide_key(g), "emb": _pack(emb), "q": im.scan_quality(rgb)}
    if eyes.on():
        entry["eyes"] = measure_eyes(rgb)
    gid = g["id"]
    update(sid, lambda d: d["slides"].__setitem__(gid, entry))


def measure_eyes(rgb: np.ndarray) -> dict:
    """eyes.measure, a failure noted (so it isn't retried forever) rather than raised."""
    try:
        return eyes.measure(rgb)
    except Exception as ex:
        print("eyes:", ex)
        return {"model": eyes.MODEL_ID, "ear": [], "error": str(ex) or "error"}


def _eyes_todo(g: dict, entry: dict | None) -> bool:
    """An embedded slide whose eyes weren't measured (the eye model came later), or by another model."""
    return (bool(entry) and entry.get("key") == slide_key(g) and "emb" in entry
            and (entry.get("eyes") or {}).get("model") != eyes.MODEL_ID)


def normalise(rgb: np.ndarray) -> np.ndarray:
    """A scan with its exposure taken out (luminance 1st..99th percentile to 0.02..0.98), so CLIP
    compares what is in two scans rather than how bright they are."""
    lum = rgb.mean(-1)
    lo, hi = np.percentile(lum, [1, 99])
    return np.clip((rgb - lo) / max(float(hi - lo), 1e-3) * 0.96 + 0.02, 0, 1).astype(np.float32)


def embed_scan(s: Session, scan: str, b) -> dict:
    from . import workflow as wf

    wf.make_proxies(s, scan)
    a = im.load_rgb(str(s.cache / f"{scan}.proxy.jpg"))
    return {"emb": _pack(b.image_embed(normalise(a))), "lum": round(float(a.mean()), 4)}


def _todo(s: Session, e: dict) -> tuple[dict | None, str | None, dict | None]:
    """The next slide whose embedding is missing or stale, else the next scan without one, else
    (the eye model on) the next slide whose eyes weren't measured."""
    groups = [g for g in s.data["groups"] if not g.get("skip")]
    for g in groups:
        if e["slides"].get(g["id"], {}).get("key") != slide_key(g):
            return g, None, None
    for g in groups:
        for x in active_scans(g):
            if x not in e["scans"]:
                return None, x, None
    if eyes.on():
        for g in groups:
            if _eyes_todo(g, e["slides"].get(g["id"])):
                return None, None, g
    return None, None, None


def pending(s: Session) -> int:
    e = load(s.id)
    groups = [g for g in s.data["groups"] if not g.get("skip")]
    return (sum(e["slides"].get(g["id"], {}).get("key") != slide_key(g) for g in groups)
            + sum(x not in e["scans"] for g in groups for x in active_scans(g))
            + (sum(_eyes_todo(g, e["slides"].get(g["id"])) for g in groups) if eyes.on() else 0))


def step(s: Session, b) -> bool:
    """Embed one slide or scan of this tray that needs it (the background helper, after the tags), or
    measure one slide's eyes. A slide or scan that fails gets an entry with `error`, so it isn't
    retried forever."""
    from . import workflow as wf

    if b is None:
        return False
    g, scan, look = _todo(s, load(s.id))
    if g is not None:
        try:
            rgb = im.rotate_arr(wf.fused_proxy(s, g), g["rotation"])
            record_slide(s.id, g, b.image_embed(rgb), rgb)
        except Exception as ex:  # e.g. an unreadable scan
            print("similar:", ex)
            key = slide_key(g)
            update(s.id, lambda d: d["slides"].__setitem__(g["id"], {"key": key, "error": str(ex) or "error"}))
        return True
    if scan is not None:
        try:
            entry = embed_scan(s, scan, b)
        except Exception as ex:
            print("similar:", ex)
            entry = {"error": str(ex) or "error"}
        update(s.id, lambda d: d["scans"].__setitem__(scan, entry))
        return True
    if look is not None:
        try:
            found = measure_eyes(im.rotate_arr(wf.fused_proxy(s, look), look["rotation"]))
        except Exception as ex:  # an unreadable scan
            print("eyes:", ex)
            found = {"model": eyes.MODEL_ID, "ear": [], "error": str(ex) or "error"}
        key, gid = slide_key(look), look["id"]

        def put(d):
            if (d["slides"].get(gid) or {}).get("key") == key:  # still the same slide
                d["slides"][gid]["eyes"] = found

        update(s.id, put)
        return True
    return False


# --------------------------------------------------------------------------- suggestions


def threshold(stats: dict | None = None) -> float:
    """The duplicate threshold, raised by dismissals like a tag's (insights.threshold): "these are
    the same shot" dismissed more often than accepted needs up to DUPLICATE_MAX."""
    from . import insights

    c = (stats if stats is not None else insights.learned()).get("labels", {}).get("duplicates")
    if not c:
        return DUPLICATE
    f = min(4.0, max(1.0, (1 + c.get("dismissed", 0)) / (1 + c.get("accepted", 0))))
    return DUPLICATE + (DUPLICATE_MAX - DUPLICATE) * (f - 1) / 3


def _pair(a: str, b: str) -> str:
    return "|".join(sorted((a, b)))


def score(q: dict | None) -> float:
    """How good a slide's blend is, for "keep the best": sharpness (exposure-independent, as for the
    best of a bracket) times the share that isn't clipped."""
    q = q or {}
    return float(q.get("sharp", 0)) * (1 - float(q.get("clipped", 0)))


def best_of(scores: dict[str, float], opened: dict[str, float]) -> str:
    """The duplicate to keep: the best quality `scores`, weighed with how open the eyes are (`opened`:
    the slides with faces measured; the others count as eyes open). Each slide's quality as a share
    of the cluster's best, x (1 - EYES_WEIGHT + EYES_WEIGHT x open); the first wins a tie. Without
    faces that is simply the best quality."""
    top = max(scores.values()) or 1.0
    return max(scores, key=lambda x: scores[x] / top * (1 - EYES_WEIGHT + EYES_WEIGHT * opened.get(x, 1.0)))


def _vec(entry: dict | None) -> np.ndarray | None:
    return unpack(entry["emb"]) if entry and entry.get("emb") else None


def _sig(s: Session, scan: str) -> np.ndarray | None:
    f = s.cache / f"{scan}.sig.npy"
    return np.load(f) if f.exists() else None


def suggest(s: Session, e: dict | None = None, dup_threshold: float | None = None) -> dict:
    """Every look-alike suggestion for the tray, from its embeddings: {"duplicates", "split",
    "merge": [suggestion], "scenes": [{"start", "end", "label"}]}. A suggestion is {"kind", "id",
    "groups", "confidence", "source", "state": "suggested", ...}; dismissed ones are left out."""
    d = s.data
    e = e if e is not None else load(s.id)
    decided = d.get("similar") or {}
    dismissed, apart = set(decided.get("dismissed", [])), set(decided.get("apart", []))
    groups = d["groups"]
    thr = threshold() if dup_threshold is None else dup_threshold

    def sug(kind, sid_, gids, conf, **extra):
        return {"kind": kind, "id": sid_, "groups": gids, "confidence": round(float(conf), 3), "source": MODEL_ID,
                "state": "suggested", **extra}

    scan_vec = {x: _vec(v) for x, v in e["scans"].items()}

    # merge: the signature kept two neighbours apart, CLIP says one frame at two exposures
    merge, merged_pairs = [], set()
    for a, b in zip(groups, groups[1:]):
        if a.get("skip") or b.get("skip") or a.get("locked") or b.get("locked"):
            continue
        xa, xb = active_scans(a), active_scans(b)
        if not xa or not xb:
            continue
        va, vb = scan_vec.get(xa[-1]), scan_vec.get(xb[0])
        if va is None or vb is None:
            continue
        c = float(va @ vb)
        la, lb = e["scans"][xa[-1]].get("lum", 0), e["scans"][xb[0]].get("lum", 0)
        stops = abs(np.log2(max(la, 1e-3) / max(lb, 1e-3)))
        if c < MERGE or stops < MERGE_STOPS:
            continue
        sb = _sig(s, xb[0])
        struct = max((im.similarity(sa, sb) for sa in (_sig(s, x) for x in xa) if sa is not None and sb is not None),
                     default=1.0)
        mid = f"merge:{a['id']}:{b['id']}"
        if struct < MERGE_STRUCT or mid in dismissed:
            continue
        merge.append(sug("merge", mid, [a["id"], b["id"]], c, stops=round(float(stops), 2)))
        merged_pairs.add(_pair(a["id"], b["id"]))

    # split: a scan of a bracket unlike every scan before it in the stack
    split = []
    for g in groups:
        if g.get("skip") or g.get("locked"):
            continue
        xs = active_scans(g)
        for k in range(1, len(xs)):
            vk = scan_vec.get(xs[k])
            before = [scan_vec.get(x) for x in xs[:k]]
            if vk is None or any(v is None for v in before):
                continue
            c = max(float(v @ vk) for v in before)
            sid_ = f"split:{g['id']}:{xs[k]}"
            if c < SPLIT and sid_ not in dismissed:
                split.append(sug("split", sid_, [g["id"]], min(1.0, (SPLIT - c) / 0.3 + 0.5), scan=xs[k],
                                 similarity=round(c, 3)))

    # duplicates: nearly the same picture a few slides apart; clusters are connected pairs
    idx = [i for i, g in enumerate(groups) if not g.get("skip")
           and (e["slides"].get(g["id"]) or {}).get("key") == slide_key(g) and _vec(e["slides"][g["id"]]) is not None]
    vec = {i: _vec(e["slides"][groups[i]["id"]]) for i in idx}
    parent = {i: i for i in idx}

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    sims: dict[tuple[int, int], float] = {}
    for n, i in enumerate(idx):
        for j in idx[n + 1:]:
            if j - i > WINDOW:
                break
            p = _pair(groups[i]["id"], groups[j]["id"])
            if p in apart or p in merged_pairs:
                continue
            c = float(vec[i] @ vec[j])
            if c >= thr:
                sims[(i, j)] = c
                parent[root(j)] = root(i)
    clusters: dict[int, list[int]] = {}
    for i in idx:
        clusters.setdefault(root(i), []).append(i)
    duplicates = []
    for members in clusters.values():
        if len(members) < 2:
            continue
        gids = [groups[i]["id"] for i in members]
        scores = {gid: round(score(e["slides"][gid].get("q")), 4) for gid in gids}
        opened = {gid: v for gid in gids if (v := eyes.slide_open(e["slides"][gid].get("eyes"))) is not None}
        best = best_of(scores, opened)
        conf = np.mean([c for (i, j), c in sims.items() if i in members])
        extra = {}
        if opened:  # faces: how open each slide's eyes are, and the slides where someone blinked
            extra = {"eyes": {gid: round(v, 2) for gid, v in opened.items()},
                     "closed": [gid for gid in gids if opened.get(gid, 1.0) < eyes.CLOSED]}
        duplicates.append(sug("duplicates", "dup:" + ",".join(gids), gids, conf, best=best, scores=scores, **extra))

    return {"duplicates": duplicates, "split": split, "merge": merge, "scenes": scenes(groups, e)}


def scenes(groups: list[dict], e: dict) -> list[dict]:
    """The tray cut into runs of similar slides: [{"start", "end" (slide indices, inclusive),
    "label"}], or [] when it is one scene (or nothing is embedded yet). A slide starts a new scene
    when it is unlike the current scene's last few slides (their mean embedding below SCENE) and the
    slide after it is too; a single odd slide inside a scene doesn't cut it. Skipped and not yet
    embedded slides stay with the scene before them. The label is the tag most of the scene's
    slides have (their own or suggested), if one does."""
    seq = [(i, _vec(e["slides"].get(g["id"])) if (e["slides"].get(g["id"]) or {}).get("key") == slide_key(g) else None)
           for i, g in enumerate(groups) if not g.get("skip")]
    seq = [(i, v) for i, v in seq if v is not None]
    if len(seq) < 2:
        return []
    starts = [0]
    run: list[np.ndarray] = [seq[0][1]]
    for k in range(1, len(seq)):
        c = np.mean(run[-SCENE_SPAN:], axis=0)
        c /= np.linalg.norm(c) or 1
        far = float(seq[k][1] @ c) < SCENE
        nxt_far = k + 1 >= len(seq) or float(seq[k + 1][1] @ c) < SCENE
        if far and nxt_far:
            starts.append(seq[k][0])
            run = [seq[k][1]]
        elif not far:
            run.append(seq[k][1])
    if len(starts) < 2:
        return []
    out = []
    for n, a in enumerate(starts):
        b = starts[n + 1] - 1 if n + 1 < len(starts) else len(groups) - 1
        members = [g for g in groups[a : b + 1] if not g.get("skip")]
        counts: dict[str, list[float]] = {}  # tag -> [slides, confidence summed (own tags count 1)]
        for g in members:
            have = {t: 1.0 for t in g.get("tags", [])}
            for t in (g.get("insights") or {}).get("tags", []):
                if t.get("state") != "dismissed":
                    have.setdefault(t["value"], t.get("confidence", 0))
            for t, conf in have.items():
                c = counts.setdefault(t, [0, 0.0])
                c[0] += 1
                c[1] += conf
        top = max(counts.items(), key=lambda kv: (kv[1][0], kv[1][1]), default=("", [0, 0]))
        out.append({"start": a, "end": b, "label": top[0] if top[1][0] * 2 > len(members) else ""})
    return out


_cache: dict[str, tuple] = {}


def payload(s: Session) -> dict:
    """What the session payload carries: the suggestions plus how many slides / scans are still to
    embed. Cached per tray by the files' modification times (the payload is polled)."""
    f = emb_file(s.id)
    stamp = (f.stat().st_mtime_ns if f.exists() else 0, (s.dir / "session.json").stat().st_mtime_ns, eyes.on(),
             json.dumps((s.data.get("similar"), [g["id"] for g in s.data["groups"]])))
    hit = _cache.get(s.id)
    if hit and hit[0] == stamp:
        return hit[1]
    e = load(s.id)
    out = {**suggest(s, e), "pending": pending(s)}
    _cache[s.id] = (stamp, out)
    return out


def dismiss(d: dict, sug: dict) -> None:
    """Remember a dismissed suggestion. Duplicates are remembered as pairs that aren't the same shot
    (a cluster that gains a slide later only brings that slide back); split / merge by id."""
    rec = d.setdefault("similar", {})
    if sug["kind"] == "duplicates":
        gids = sug["groups"]
        pairs = set(rec.get("apart", [])) | {_pair(a, b) for n, a in enumerate(gids) for b in gids[n + 1:]}
        rec["apart"] = sorted(pairs)
    else:
        rec["dismissed"] = sorted(set(rec.get("dismissed", [])) | {sug["id"]})


# --------------------------------------------------------------------------- look-alikes in Immich

LOOKALIKE = 0.92  # a photo in Immich this alike (both Immich thumbnails through CLIP): "uploaded before"
CANDIDATES = 8  # nearest assets asked of Immich's smart search per slide
DATE_CANDIDATES = 200  # at most this many photos from the slide's date range, when smart search can't help


def levels(rgb: np.ndarray) -> np.ndarray:
    """Each channel's 1st..99th percentile stretched to 0..1: a crude restore, so a faded scan made
    years ago and today's restored version of the slide are compared on what's in them. (Measured on
    a synthetic beach, old raw scan vs the developed upload: CLIP 0.83 as they are, 0.98 levelled;
    other slides of the tray 0.66-0.76 levelled.)"""
    lo, hi = np.percentile(rgb.reshape(-1, 3), [1, 99], axis=0)
    return np.clip((rgb - lo) / np.maximum(hi - lo, 1e-3), 0, 1).astype(np.float32)


def _thumb_embedding(client, b, asset_id: str, cache: dict) -> np.ndarray | None:
    """The CLIP embedding of Immich's thumbnail of an asset, levelled (both sides of a comparison go
    through the same Immich thumbnail and the same levelling)."""
    if asset_id not in cache:
        from PIL import Image

        try:
            a = np.asarray(Image.open(io.BytesIO(client.thumbnail(asset_id))).convert("RGB"), np.float32) / 255
            cache[asset_id] = b.image_embed(levels(a))
        except Exception as ex:  # a video, a missing thumbnail, a key without asset.view
            print("look-alike thumbnail:", ex)
            cache[asset_id] = None
    return cache[asset_id]


def _date_window(date: str) -> tuple[str, str] | None:
    """The slide's date as a search window: its day, month or year, a day either side."""
    p = parse_date(date or "")
    if not p:
        return None
    t, precision = p
    if precision == 1:
        end = t.replace(year=t.year + 1)
    elif precision == 2:
        end = t.replace(year=t.year + (t.month == 12), month=t.month % 12 + 1)
    else:
        end = t + timedelta(days=1)
    fmt = "%Y-%m-%dT00:00:00.000Z"
    return (t - timedelta(days=1)).strftime(fmt), (end + timedelta(days=1)).strftime(fmt)


def check_lookalikes(client, sid: str, gids: list[str], b, job=None) -> dict:
    """After upload: does Immich hold a photo that looks like each of these slides (a scan uploaded
    years ago with another tool)? Candidates come from Immich's own smart search by image
    (`POST /search/smart {"queryAssetId"}`: nearest first, no scores), and each is verified here: its
    thumbnail and the slide's uploaded thumbnail through the local CLIP, a match from LOOKALIKE.
    A server that can't search by image (older, smart search off) gets the photos taken in the
    slide's date range instead. A slide Immich hasn't indexed yet stays `pending` for a later check.

    Records `g["immich"]["lookalike"] = {"asset", "state": checked | pending | unsupported, "via",
    "matches": [{"id", "similarity", "name", "date", "state"}]}`; decisions on a match are kept when
    the same asset is checked again. Returns counts {"checked", "found", "pending"}."""
    from .immich import ImmichError, NotIndexed, Unsupported
    from . import workflow as wf

    s = Session(sid)
    dates = slide_dates(s.data)
    own = set()
    for g in s.data["groups"]:
        rec = g.get("immich") or {}
        own.update(x for x in [rec.get("asset_id"), (g.get("source_asset") or {}).get("id")] if x)
        own.update((rec.get("originals") or {}).values())
    cache: dict[str, np.ndarray | None] = {}
    by_window: dict[tuple, list[dict]] = {}
    out = {"checked": 0, "found": 0, "pending": 0}
    for n, gid in enumerate(gids, 1):
        if job:
            job.message = f"Looking for look-alikes in Immich: slide {n} of {len(gids)}"
            if job.kind == "lookalike":
                job.done = n - 1
        try:
            g = s.group(gid)
        except KeyError:
            continue
        rec = g.get("immich") or {}
        aid = rec.get("asset_id")
        if not aid:
            continue
        via, state, candidates = "smart", "checked", []
        try:
            candidates = client.similar_assets(aid, CANDIDATES + 1)
        except NotIndexed:
            state = "pending"
        except (Unsupported, ImmichError) as ex:
            print("smart search:", ex)
            via = "date"
            win = _date_window(dates[s.group_index(gid)]["value"])
            if win is None:
                state = "unsupported"
            else:
                if win not in by_window:
                    try:
                        by_window[win] = client.taken_between(*win, DATE_CANDIDATES)
                    except ImmichError as ex2:
                        print("date search:", ex2)
                        by_window[win] = []
                candidates = by_window[win]
        matches = []
        if state == "checked":
            mine = _thumb_embedding(client, b, aid, cache)
            for c in candidates:
                if c.get("id") in own or c.get("id") == aid or c.get("isTrashed") or c.get("type", "IMAGE") != "IMAGE":
                    continue
                v = _thumb_embedding(client, b, c["id"], cache) if mine is not None else None
                if v is None:
                    continue
                sim = float(mine @ v)
                if sim >= LOOKALIKE:
                    matches.append({"id": c["id"], "similarity": round(sim, 3), "name": c.get("originalFileName", ""),
                                    "date": (c.get("localDateTime") or c.get("fileCreatedAt") or "")[:10],
                                    "state": "suggested"})
            matches.sort(key=lambda m: -m["similarity"])
            matches = matches[:3]
        out["pending" if state == "pending" else "checked"] += 1
        out["found"] += bool(matches)
        result = {"asset": aid, "state": state, "via": via, "matches": matches}

        def commit(fresh: Session, gid=gid, aid=aid, result=result):
            try:
                fg = fresh.group(gid)
            except KeyError:
                return
            fr = fg.get("immich") or {}
            if fr.get("asset_id") != aid:
                return  # uploaded again meanwhile
            old = {m["id"]: m.get("state") for m in (fr.get("lookalike") or {}).get("matches", [])}
            for m in result["matches"]:
                if old.get(m["id"]) in ("accepted", "dismissed"):
                    m["state"] = old[m["id"]]
            fr["lookalike"] = result

        wf.update_session(sid, commit)
    return out


def lookalike_view(g: dict) -> dict | None:
    """The slide's look-alike check for the payload (None: not checked)."""
    rec = (g.get("immich") or {}).get("lookalike")
    if not rec or rec.get("asset") != (g.get("immich") or {}).get("asset_id"):
        return None
    return {k: rec.get(k) for k in ("state", "via", "matches")}
