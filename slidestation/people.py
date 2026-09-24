"""Faces -> people: a face embedding per face on every slide, clustered across all trays, named once.

Faces are found with YuNet (imaging.detect_faces) on the upright, blended proxy and described by
OpenCV's SFace (FaceRecognizerSF: alignCrop on YuNet's landmarks, then a 128-d feature). The model is
downloaded on first use into the library's models/ folder. Per tray the faces live next to
session.json in faces.json (derived data, never written into the session itself); the people -
clusters with an optional name - live in the library's people.json.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
from pathlib import Path

import numpy as np

from . import imaging as im
from .store import _atomic_write, active_scans, library

MODEL_NAME = "face_recognition_sface_2021dec.onnx"
# opencv_zoo's SFace (Apache-2.0), mirrored by OpenCV on Hugging Face
MODEL_URL = "https://huggingface.co/opencv/face_recognition_sface/resolve/main/" + MODEL_NAME
MODEL_SHA256 = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"
MODEL_MB = 39

SAME_PERSON = 0.363  # SFace's recommended cosine-similarity threshold for "same identity"
MIN_SCORE = 0.7  # the detector confidence a face needs (as for the rotation vote)
MIN_SIZE = 0.03  # and its size, as a share of the picture's width: tiny faces describe badly
MATCH = 0.8  # a face found again (after the slide was turned) keeps its id above this similarity

_lock = threading.RLock()  # faces.json files and people.json


# --------------------------------------------------------------------------- model


def model_file() -> Path:
    return library() / "models" / MODEL_NAME


def model_ready() -> bool:
    return model_file().exists()


def download_model(progress=None) -> Path:
    """Fetch SFace into the library (checked against its SHA-256). progress(done_mb, total_mb)."""
    import httpx

    dest = model_file()
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    h = hashlib.sha256()
    with httpx.stream("GET", MODEL_URL, follow_redirects=True, timeout=120) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0)) or MODEL_MB << 20
        done = 0
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
                h.update(chunk)
                done += len(chunk)
                if progress:
                    progress(done >> 20, total >> 20)
    if h.hexdigest() != MODEL_SHA256:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("The downloaded face model didn't match its checksum - try again.")
    os.replace(tmp, dest)
    return dest


_recognizer = None
_recognizer_lock = threading.Lock()


def embed_faces(rgb: np.ndarray) -> list[dict]:
    """Every clear face in an upright picture: {"box": [l, t, w, h] (0..1), "score", "emb": unit 128-d}."""
    import cv2

    global _recognizer
    with _recognizer_lock:
        if _recognizer is None:
            _recognizer = cv2.FaceRecognizerSF.create(str(model_file()), "")
    faces = im.detect_faces(rgb)
    height, width = rgb.shape[:2]
    bgr = None
    out = []
    for f in faces:
        if f[14] < MIN_SCORE or f[2] < MIN_SIZE * width:
            continue
        if bgr is None:
            bgr = cv2.cvtColor((np.clip(rgb, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
        with _recognizer_lock:
            e = _recognizer.feature(_recognizer.alignCrop(bgr, f)).flatten().astype(np.float32)
        e /= np.linalg.norm(e) or 1
        box = [f[0] / width, f[1] / height, f[2] / width, f[3] / height]
        out.append({"box": [round(float(v), 4) for v in box], "score": round(float(f[14]), 3), "emb": e})
    return out


# --------------------------------------------------------------------------- faces per tray


def face_key(g: dict) -> str:
    """What a slide's faces were found on: its blended scans, turned upright."""
    return hashlib.sha1(json.dumps([active_scans(g), g["rotation"]]).encode()).hexdigest()[:12]


def _pack(e: np.ndarray) -> str:
    return base64.b64encode(np.asarray(e, np.float16).tobytes()).decode()


def unpack(s: str) -> np.ndarray:
    e = np.frombuffer(base64.b64decode(s), np.float16).astype(np.float32)
    return e / (np.linalg.norm(e) or 1)


def faces_file(sid: str) -> Path:
    return library() / "sessions" / sid / "faces.json"


def load_faces(sid: str) -> dict:
    """{gid: {"key", "rot", "faces": [{"id", "box", "score", "emb"}]}} for one tray."""
    f = faces_file(sid)
    try:
        return json.loads(f.read_text()) if f.exists() else {}
    except ValueError:
        return {}


def update_faces(sid: str, fn) -> dict:
    """Apply fn(faces) to a freshly loaded faces.json under the lock, then save (like update_session)."""
    with _lock:
        d = load_faces(sid)
        fn(d)
        _atomic_write(faces_file(sid), d)
        return d


def stale(g: dict, entry: dict | None) -> bool:
    return not g.get("skip") and (not entry or entry.get("key") != face_key(g))


def record(sid: str, g: dict, rgb: np.ndarray) -> list[dict]:
    """Find and describe the faces on one slide (rgb = its upright blend) and store them. A face found
    again keeps its id, so a name or a removal made in the People dialog stays with it."""
    found = embed_faces(rgb)
    key, gid = face_key(g), g["id"]

    def commit(d: dict):
        old = (d.get(gid) or {}).get("faces", [])
        used, taken = set(), {int(f["id"].rsplit("/", 1)[1]) for f in old}
        faces = []
        for f in found:
            match = None
            if old:
                sims = [float(unpack(o["emb"]) @ f["emb"]) if o["id"] not in used else -1 for o in old]
                best = int(np.argmax(sims))
                if sims[best] >= MATCH:
                    match = old[best]["id"]
            if match is None:
                n = next(i for i in range(len(taken) + len(found) + 1) if i not in taken)
                taken.add(n)
                match = f"{sid}/{gid}/{n}"
            used.add(match)
            faces.append({"id": match, "box": f["box"], "score": f["score"], "emb": _pack(f["emb"])})
        d[gid] = {"key": key, "rot": g["rotation"], "faces": faces}

    update_faces(sid, commit)
    return found


# --------------------------------------------------------------------------- clustering


def agglomerate(emb: np.ndarray, clusters: list[list[int]], rejected: dict[int, set[int]] | None = None,
                threshold: float = SAME_PERSON) -> list[list[int]]:
    """Average-linkage clustering of unit vectors on cosine similarity.

    `clusters` are the existing people (lists of indices into emb): they keep their members and
    never merge with each other - that's for the user to decide. Every other face starts alone.
    Groups then merge, most similar pair first, while the average similarity between their members
    is at least `threshold` (for unit vectors that is sum_a . sum_b / (n_a n_b)). `rejected[i]` holds
    the existing clusters (by position) face i was taken out of: a group holding it never joins them.
    Returns the existing clusters (same order, possibly grown), then the new groups."""
    emb = np.asarray(emb, np.float64)
    rejected = rejected or {}
    taken = {i for c in clusters for i in c}
    members = [list(c) for c in clusters] + [[i] for i in range(len(emb)) if i not in taken]
    k, fixed = len(members), len(clusters)
    if not k:
        return []
    dim = emb.shape[1] if emb.ndim == 2 else 1
    S = np.stack([emb[m].sum(0) if m else np.zeros(dim) for m in members])
    n = np.array([len(m) for m in members], np.float64)
    forbid = [set() if g < fixed else set(rejected.get(members[g][0], ())) for g in range(k)]
    alive = n > 0
    free = np.zeros(k, bool)
    free[fixed:] = True
    best_v = np.full(k, -np.inf)
    best_c = np.zeros(k, int)

    def row(r: int):
        v = S @ S[r] / (np.maximum(n, 1) * n[r])
        v[~alive] = -np.inf
        v[r] = -np.inf
        for c in forbid[r]:
            v[c] = -np.inf
        best_c[r] = int(np.argmax(v))
        best_v[r] = v[best_c[r]]

    for r in range(fixed, k):
        row(r)
    while free.any():
        rows = np.flatnonzero(free)
        r = rows[np.argmax(best_v[rows])]
        if best_v[r] < threshold:
            break
        c = best_c[r]
        keep, gone = (c, r) if c < fixed else (min(r, c), max(r, c))
        S[keep] += S[gone]
        n[keep] += n[gone]
        members[keep] += members[gone]
        forbid[keep] |= forbid[gone]
        alive[gone] = free[gone] = False
        n[gone] = 0
        # the other groups' similarity to the merged one changed; their best may have moved
        rows = np.flatnonzero(free)
        vals = S[rows] @ S[keep] / (n[rows] * n[keep])
        for j, rr in enumerate(rows):
            if rr == keep or keep in forbid[rr]:
                vals[j] = -np.inf
        up = vals > best_v[rows]
        best_v[rows[up]], best_c[rows[up]] = vals[up], keep
        for rr in rows[~up & np.isin(best_c[rows], (keep, gone))]:
            row(rr)
        if free[keep]:
            row(keep)
    return members[:fixed] + [members[g] for g in range(fixed, k) if alive[g]]


# --------------------------------------------------------------------------- people


def people_file() -> Path:
    return library() / "people.json"


def load_people() -> dict:
    """{"people": {pid: {"name", "faces": [face ids]}}, "rejected": {face id: [pids]}, "next": int}"""
    f = people_file()
    d = json.loads(f.read_text()) if f.exists() else {}
    return {"people": d.get("people", {}), "rejected": d.get("rejected", {}), "next": d.get("next", 1)}


def save_people(d: dict) -> None:
    _atomic_write(people_file(), d)


_face_cache: dict[str, tuple[int, dict]] = {}


def all_faces() -> dict[str, dict]:
    """Every face in the library: {face id: {"sid", "gid", "emb", "box", "key"}}."""
    out = {}
    for f in sorted((library() / "sessions").glob("*/faces.json")):
        sid = f.parent.name
        try:
            mt = f.stat().st_mtime_ns
            hit = _face_cache.get(sid)
            if not hit or hit[0] != mt:  # only re-read trays whose faces changed
                faces = {}
                for gid, e in json.loads(f.read_text()).items():
                    for x in e.get("faces", []):
                        faces[x["id"]] = {"sid": sid, "gid": gid, "emb": unpack(x["emb"]), "box": x["box"],
                                          "key": e.get("key", "")}
                hit = (mt, faces)
                _face_cache[sid] = hit
        except (OSError, ValueError):
            continue
        out.update(hit[1])
    return out


def refresh() -> dict:
    """Bring people.json up to date with the faces on disk: faces that are gone leave their person
    (an unnamed person left empty goes too), new faces join the person they resemble or form new ones."""
    with _lock:
        d = load_people()
        faces = all_faces()
        ids = list(faces)
        index = {f: i for i, f in enumerate(ids)}
        pids = list(d["people"])
        at = {p: i for i, p in enumerate(pids)}
        clusters = [[index[f] for f in d["people"][p]["faces"] if f in index] for p in pids]
        rejected = {index[f]: {at[p] for p in ps if p in at} for f, ps in d["rejected"].items() if f in index}
        emb = np.stack([faces[f]["emb"] for f in ids]) if ids else np.zeros((0, 128))
        groups = agglomerate(emb, clusters, rejected)
        people = {}
        for p, g in zip(pids, groups):
            if g or d["people"][p].get("name"):
                people[p] = {**d["people"][p], "faces": [ids[i] for i in g]}
        for g in groups[len(pids):]:
            people[f"p{d['next']}"] = {"name": "", "faces": [ids[i] for i in g]}
            d["next"] += 1
        new = {"people": people, "next": d["next"],
               "rejected": {f: [p for p in ps if p in people] for f, ps in d["rejected"].items() if f in index}}
        if new != d:
            save_people(new)
        return new


def _edit(fn) -> dict:
    with _lock:
        d = load_people()
        fn(d)
        save_people(d)
    return refresh()


def rename(pid: str, name: str) -> dict:
    """Name a person. A name another person already has joins the two: it's the same person."""
    name = " ".join(str(name).split())[:80]

    def fn(d):
        if pid not in d["people"]:
            raise KeyError(pid)
        d["people"][pid]["name"] = name
        same = [p for p, v in d["people"].items() if p != pid and name and v.get("name", "").lower() == name.lower()]
        if same:
            _merge(d, same[0], [pid])

    return _edit(fn)


def _merge(d: dict, into: str, others: list[str]) -> None:
    target = d["people"][into]
    for p in others:
        if p == into or p not in d["people"]:
            continue
        gone = d["people"].pop(p)
        target["faces"] += gone["faces"]
        target["name"] = target.get("name") or gone.get("name", "")
        for f, ps in d["rejected"].items():
            d["rejected"][f] = sorted({into if x == p else x for x in ps})


def merge(into: str, others: list[str]) -> dict:
    def fn(d):
        if into not in d["people"]:
            raise KeyError(into)
        _merge(d, into, others)

    return _edit(fn)


def remove_faces(pid: str, face_ids: list[str]) -> dict:
    """Take wrongly grouped faces out of a person; they won't be put back there."""
    def fn(d):
        if pid not in d["people"]:
            raise KeyError(pid)
        d["people"][pid]["faces"] = [f for f in d["people"][pid]["faces"] if f not in face_ids]
        for f in face_ids:
            d["rejected"][f] = sorted(set(d["rejected"].get(f, [])) | {pid})

    return _edit(fn)


def tag_name(name: str) -> str:
    """The Immich tag for a named person ("/" would nest tags, so it becomes "-")."""
    return "People/" + name.replace("/", "-").strip()


def slide_names(d: dict | None = None) -> dict[tuple[str, str], list[str]]:
    """The named people on each slide: {(sid, gid): [names]}."""
    d = d or load_people()
    out: dict[tuple[str, str], list[str]] = {}
    for p in d["people"].values():
        if not p.get("name"):
            continue
        for f in p["faces"]:
            sid, gid, _ = f.split("/")
            names = out.setdefault((sid, gid), [])
            if p["name"] not in names:
                names.append(p["name"])
    return out


def tag_uploaded(client, slides: dict[str, list[str]], names: dict[tuple[str, str], list[str]], sid: str) -> int:
    """Tag the uploaded slides {gid: asset id} of one tray with their people. Returns assets tagged."""
    by_name: dict[str, list[str]] = {}
    for gid, asset in slides.items():
        for name in names.get((sid, gid), []):
            by_name.setdefault(name, []).append(asset)
    done = set()
    for name, assets in sorted(by_name.items()):
        if client.tag_assets([tag_name(name)], assets):
            done.update(assets)
    return len(done)


def face_crop(rgb: np.ndarray, box: list[float], size: int = 128) -> np.ndarray:
    """A square around a face (box as stored: 0..1 of the upright picture), for the People dialog."""
    import cv2

    h, w = rgb.shape[:2]
    cx, cy = (box[0] + box[2] / 2) * w, (box[1] + box[3] / 2) * h
    half = max(box[2] * w, box[3] * h) * 0.8
    x0, x1 = int(max(0, cx - half)), int(min(w, cx + half))
    y0, y1 = int(max(0, cy - half)), int(min(h, cy + half))
    crop = rgb[y0:max(y1, y0 + 1), x0:max(x1, x0 + 1)]
    return cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
