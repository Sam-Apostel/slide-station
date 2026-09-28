"""Faces -> people: a face embedding per face on every slide, clustered across all trays, named once.

Faces are found with YuNet (imaging.detect_faces) on the upright, blended proxy and described by
OpenCV's SFace (FaceRecognizerSF: alignCrop on YuNet's landmarks, then a 128-d feature). The model is
downloaded on first use into the library's models/ folder. Per tray the faces live next to
session.json in faces.json (derived data, never written into the session itself); the people -
clusters with an optional name and birthday - live in the library's people.json.

Ages: with the age model downloaded (opt-in, `ages_enabled`), every face also gets the age it looks
(`age`, years; MiVOLO v2 on the face and the body below it), which dating.py turns into a date for
the slide once the person has a birthday. A slide's entry says which model aged it (`ages_by`):
faces aged by a model since replaced are aged again.

Clothes: every face also has what its person wears below it (`clothes`, a colour histogram of the
chest): on the slides around a named face, a face a little like theirs in the same clothes is them
(`spread`). Faces the detector missed can be marked by hand (`add_face`): found again at a lower bar
around the spot, or kept as a box with no face description (the back of a head), clothes only.
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
from .store import _atomic_write, active_scans, library, models_dir

MODEL_NAME = "face_recognition_sface_2021dec.onnx"
# opencv_zoo's SFace (Apache-2.0), mirrored by OpenCV on Hugging Face
MODEL_URL = "https://huggingface.co/opencv/face_recognition_sface/resolve/main/" + MODEL_NAME
MODEL_SHA256 = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"
MODEL_MB = 39

AGE_NAME = "mivolo_v2_age.onnx"
# MiVOLO v2 (Kuprashevich & Tolstykh, Apache-2.0): a face crop and the body below it, 384 px each,
# stacked as 6 channels -> the age. Our ONNX export of its age output (PyTorch has no place in the
# app), on the project's Hugging Face at a pinned commit. On faded, grainy slides of children it is off
# by ~2 years where the ViT trained on UTKFace it replaced was off by 13 (a girl of 7 "looked" 63)
AGE_URL = ("https://huggingface.co/Sam-Apostel/mivolo-v2-age-onnx/resolve/"
           "8eb4cd8f5dd4bd28df2c9a43b24bc54d6d139d36/mivolo_v2_age.onnx")
AGE_SHA256 = "2db5e05be33b3f120518a86f29a4a65eb0a01c2967219b8787a7dead9b796951"
AGE_MB = 118
AGE_SIZE = 384  # each crop: letterboxed to 384 px square, ImageNet mean / std
AGE_BY = "mivolo2"  # faces.json entries say which model aged them: older ages are redone
OLD_AGE_NAMES = ("age_vit_utkface.onnx",)  # models replaced, deleted once the new one is in

SAME_PERSON = 0.363  # SFace's recommended cosine-similarity threshold for "same identity"
MIN_SCORE = 0.7  # the detector confidence a face needs (as for the rotation vote)
MIN_SIZE = 0.03  # and its size, as a share of the picture's width: tiny faces describe badly
MATCH = 0.8  # a face found again (after the slide was turned) keeps its id above this similarity

CLOTHES_BINS = (4, 6, 6)  # the clothes' colour histogram: L, a, b bins (a and b over -40..40)
CLOTHES_V = 1  # faces.json entries say which clothes description they have: older ones are redone
NEAR = 3  # slides either side of someone's face that their name spreads to (the same day)
LOOKS_LIKE = 0.2  # there, a face this like theirs (cosine; unrelated faces are ~0)…
SAME_CLOTHES = 0.8  # …in clothes this alike (Bhattacharyya, 0..1) is them
CLOTHES_ONLY = 0.9  # next to a face marked by hand (no face to compare): the clothes alone, this alike

_lock = threading.RLock()  # faces.json files and people.json


# --------------------------------------------------------------------------- model


def model_file() -> Path:
    return models_dir() / MODEL_NAME


def model_ready() -> bool:
    return model_file().exists()


def download_model(progress=None) -> Path:
    """Fetch SFace into the library (checked against its SHA-256). progress(done_mb, total_mb)."""
    return _download(MODEL_URL, MODEL_SHA256, model_file(), MODEL_MB, "face model", progress)


def age_file() -> Path:
    return models_dir() / AGE_NAME


def age_ready() -> bool:
    return age_file().exists()


def download_age_model(progress=None) -> Path:
    out = _download(AGE_URL, AGE_SHA256, age_file(), AGE_MB, "age model", progress)
    for name in OLD_AGE_NAMES:  # the model it replaces (329 MB) is no use any more
        (models_dir() / name).unlink(missing_ok=True)
    return out


def _download(url: str, sha256: str, dest: Path, mb: int, what: str, progress=None) -> Path:
    import httpx

    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    h = hashlib.sha256()
    with httpx.stream("GET", url, follow_redirects=True, timeout=120) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0)) or mb << 20
        done = 0
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
                h.update(chunk)
                done += len(chunk)
                if progress:
                    progress(done >> 20, total >> 20)
    if h.hexdigest() != sha256:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"The downloaded {what} didn't match its checksum - try again.")
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


_ager = None
_ager_lock = threading.Lock()


def _letterbox(a: np.ndarray, size: int = AGE_SIZE) -> np.ndarray:
    """A crop scaled to fit a size x size square, centred on black (MiVOLO's class_letterbox)."""
    import cv2

    h, w = a.shape[:2]
    r = min(size / h, size / w)
    nw, nh = int(round(w * r)), int(round(h * r))
    if (nw, nh) != (w, h):
        a = cv2.resize(a, (nw, nh), interpolation=cv2.INTER_LINEAR)
    dw, dh = (size - nw) / 2, (size - nh) / 2
    return cv2.copyMakeBorder(a, int(round(dh - 0.1)), int(round(dh + 0.1)), int(round(dw - 0.1)),
                              int(round(dw + 0.1)), cv2.BORDER_CONSTANT, value=(0, 0, 0))


def age_crops(rgb: np.ndarray, box: list[float]) -> tuple[np.ndarray, np.ndarray]:
    """The face (its box) and the body below it (3 faces wide, from just above the head to 6.5 faces
    down: a child's body says as much about their age as their face), clipped to the picture."""
    h, w = rgb.shape[:2]
    x, y, bw, bh = box[0] * w, box[1] * h, box[2] * w, box[3] * h
    cx = x + bw / 2

    def cut(x0, y0, x1, y1):
        x0, y0, x1, y1 = int(max(0, x0)), int(max(0, y0)), int(min(w, x1)), int(min(h, y1))
        return rgb[y0:max(y1, y0 + 1), x0:max(x1, x0 + 1)]

    return cut(x, y, x + bw, y + bh), cut(cx - 1.5 * bw, y - 0.3 * bh, cx + 1.5 * bw, y + 6.5 * bh)


def age_input(rgb: np.ndarray, box: list[float]) -> np.ndarray:
    """MiVOLO's input for one face: face and body letterboxed, 0..1, ImageNet mean / std, (6, 384, 384)."""
    parts = []
    for c in age_crops(rgb, box):
        a = _letterbox((np.clip(c, 0, 1) * 255).astype(np.uint8)).astype(np.float32) / 255
        parts.append(((a - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).transpose(2, 0, 1))
    return np.concatenate(parts).astype(np.float32)


def estimate_ages(rgb: np.ndarray, boxes: list[list[float]]) -> list[float]:
    """The age (years) each face looks, boxes as stored (0..1 of the upright picture). The one
    function tests replace, like embed_faces."""
    import onnxruntime as ort

    global _ager
    if not boxes:
        return []
    out = []
    with _ager_lock:
        if _ager is None:
            _ager = ort.InferenceSession(str(age_file()), providers=["CPUExecutionProvider"])
        name = _ager.get_inputs()[0].name
        for b in boxes:  # the export takes one face at a time
            a = float(np.ravel(_ager.run(None, {name: age_input(rgb, b)[None]})[0])[0])
            out.append(round(float(np.clip(a, 0, 100)), 1))
    return out


def describe_clothes(rgb: np.ndarray, box: list[float]) -> np.ndarray | None:
    """What someone wears: a colour histogram (Lab, CLOTHES_BINS, summing to 1) of the chest below a
    face (box as stored: 0..1 of the upright picture), weighted to its middle so the background
    counts little. None when there's no room below the face (it's at the bottom edge)."""
    import cv2

    h, w = rgb.shape[:2]
    x, y, bw, bh = box[0] * w, box[1] * h, box[2] * w, box[3] * h
    cx, cy = x + bw / 2, y + 2.3 * bh
    x0, x1 = int(max(0, cx - 1.2 * bw)), int(min(w, cx + 1.2 * bw))
    y0, y1 = int(max(0, y + 1.3 * bh)), int(min(h, y + 3.3 * bh))
    if x1 - x0 < 4 or y1 - y0 < max(4, 0.5 * bh):
        return None
    crop = np.clip(rgb[y0:y1, x0:x1], 0, 1).astype(np.float32)
    cw, ch = min(48, x1 - x0), min(48, y1 - y0)
    crop = cv2.resize(crop, (cw, ch), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(crop, cv2.COLOR_RGB2Lab)  # L 0..100, a / b about -127..127
    xs = x0 + (np.arange(cw) + 0.5) * (x1 - x0) / cw
    ys = y0 + (np.arange(ch) + 0.5) * (y1 - y0) / ch
    wt = np.exp(-0.5 * (((ys[:, None] - cy) / bh) ** 2 + ((xs[None, :] - cx) / bw) ** 2))
    nl, na, nb = CLOTHES_BINS
    li = np.clip(lab[..., 0] / 100 * nl, 0, nl - 1).astype(int)
    ai = np.clip((lab[..., 1] + 40) / 80 * na, 0, na - 1).astype(int)
    bi = np.clip((lab[..., 2] + 40) / 80 * nb, 0, nb - 1).astype(int)
    hist = np.bincount(((li * na + ai) * nb + bi).ravel(), wt.ravel(), nl * na * nb)
    total = hist.sum()
    return (hist / total).astype(np.float32) if total > 0 else None


def clothes_like(a: np.ndarray | None, b: np.ndarray | None) -> float | None:
    """How alike two clothes descriptions are: 1 = the same colours, 0 = nothing in common."""
    if a is None or b is None:
        return None
    return float(np.sqrt(np.clip(a, 0, None) * np.clip(b, 0, None)).sum())


# --------------------------------------------------------------------------- faces per tray


def face_key(g: dict) -> str:
    """What a slide's faces were found on: its blended scans, turned upright."""
    k = [active_scans(g), g["rotation"]] + (["mirror"] if g.get("mirror") else [])
    return hashlib.sha1(json.dumps(k).encode()).hexdigest()[:12]


def _pack(e: np.ndarray) -> str:
    return base64.b64encode(np.asarray(e, np.float16).tobytes()).decode()


def unpack(s: str) -> np.ndarray:
    e = np.frombuffer(base64.b64decode(s), np.float16).astype(np.float32)
    return e / (np.linalg.norm(e) or 1)


def unpack_clothes(s: str | None) -> np.ndarray | None:
    if not s:
        return None
    c = np.frombuffer(base64.b64decode(s), np.float16).astype(np.float32)
    return c / (c.sum() or 1)


def faces_file(sid: str) -> Path:
    return library() / "sessions" / sid / "faces.json"


def load_faces(sid: str) -> dict:
    """{gid: {"key", "rot", "mirror", "clothes_v"?, "faces": [{"id", "box", "score", "emb"?, "clothes"?,
    "age"?, "manual"?}]}} for one tray. A face marked by hand (`manual`) has no `emb` when no face
    was found there."""
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


def unaged(entry: dict | None) -> bool:
    """Faces on the slide without an age yet (found before the age model was there), or aged by a
    model since replaced (AGE_BY)."""
    faces = (entry or {}).get("faces", [])
    return bool(faces) and (entry.get("ages_by") != AGE_BY or any("age" not in f for f in faces))


def undressed(entry: dict | None) -> bool:
    """Faces on the slide without a clothes description yet (found before there were any)."""
    return bool((entry or {}).get("faces")) and entry.get("clothes_v") != CLOTHES_V


def _dress(rgb: np.ndarray, f: dict) -> dict:
    c = describe_clothes(rgb, f["box"])
    return {"clothes": _pack(c)} if c is not None else {}


def _turn_box(box: list[float], frm: tuple[int, bool], to: tuple[int, bool]) -> list[float]:
    """A box (0..1) on a slide turned `frm` (rotation, mirrored) as it is on the slide turned `to`."""
    def corners(b):
        return [(b[0], b[1]), (b[0] + b[2], b[1] + b[3])]

    def unturn(pt, rot, mirror):  # oriented -> scan as it is: undo the rotation, then the mirror
        u, v = pt
        u, v = {0: (u, v), 90: (v, 1 - u), 180: (1 - u, 1 - v), 270: (1 - v, u)}[rot % 360]
        return (1 - u, v) if mirror else (u, v)

    def turn(pt, rot, mirror):
        u, v = pt
        u = 1 - u if mirror else u
        return {0: (u, v), 90: (1 - v, u), 180: (1 - u, 1 - v), 270: (v, 1 - u)}[rot % 360]

    pts = [turn(unturn(p, *frm), *to) for p in corners(box)]
    l, t = min(p[0] for p in pts), min(p[1] for p in pts)
    return [round(l, 4), round(t, 4), round(max(p[0] for p in pts) - l, 4), round(max(p[1] for p in pts) - t, 4)]


def record(sid: str, g: dict, rgb: np.ndarray, ages: bool = False) -> list[dict]:
    """Find and describe the faces on one slide (rgb = its upright blend) and store them. A face found
    again keeps its id, so a name or a removal made in the People dialog stays with it; a face marked
    by hand that isn't found stays (turned with the slide). `ages`: the age model is on, every face
    gets the age it looks."""
    found = embed_faces(rgb)
    if ages:
        for f, a in zip(found, estimate_ages(rgb, [f["box"] for f in found])):
            f["age"] = a
    for f in found:
        f.update(_dress(rgb, f))
    key, gid = face_key(g), g["id"]

    def commit(d: dict):
        entry = d.get(gid) or {}
        old = entry.get("faces", [])
        used, taken = set(), {int(f["id"].rsplit("/", 1)[1]) for f in old}
        faces = []
        for f in found:
            match = None
            if old:
                sims = [float(unpack(o["emb"]) @ f["emb"]) if o["id"] not in used and o.get("emb") else -1
                        for o in old]
                best = int(np.argmax(sims))
                if sims[best] >= MATCH:
                    match = old[best]["id"]
            if match is None:
                n = next(i for i in range(len(taken) + len(found) + 1) if i not in taken)
                taken.add(n)
                match = f"{sid}/{gid}/{n}"
            used.add(match)
            faces.append({"id": match, "box": f["box"], "score": f["score"], "emb": _pack(f["emb"]),
                          **({"age": f["age"]} if "age" in f else {}),
                          **({"clothes": f["clothes"]} if "clothes" in f else {})})
        frm = (entry.get("rot", 0), bool(entry.get("mirror")))
        to = (g["rotation"], bool(g.get("mirror")))
        for o in old:  # marked by hand and not found now: kept, where it is on the slide as turned now
            if o.get("manual") and o["id"] not in used:
                box = _turn_box(o["box"], frm, to) if frm != to else o["box"]
                kept = {k: v for k, v in o.items() if k not in ("clothes", "age")}
                faces.append({**kept, "box": box, **_dress(rgb, {"box": box})})
        d[gid] = {"key": key, "rot": g["rotation"], "mirror": bool(g.get("mirror")), "faces": faces,
                  "clothes_v": CLOTHES_V, **({"ages_by": AGE_BY} if ages else {})}

    update_faces(sid, commit)
    return found


def add_clothes(sid: str, gid: str, rgb: np.ndarray) -> None:
    """Describe the clothes of the faces already found on a slide (rgb = the same upright blend)."""
    entry = load_faces(sid).get(gid) or {}
    dressed = {f["id"]: _dress(rgb, f) for f in entry.get("faces", [])}

    def commit(d: dict):
        e = d.get(gid)
        if not e:
            return
        for f in e.get("faces", []):
            f.pop("clothes", None)
            f.update(dressed.get(f["id"], {}))
        e["clothes_v"] = CLOTHES_V

    update_faces(sid, commit)


def find_near(rgb: np.ndarray, point: list[float]) -> dict | None:
    """A face the detector missed, at a spot the user pointed at (0..1 of the upright picture): the
    picture around it looked at closer, at a lower bar (someone is there). {"box", "score", "emb",
    "landmarks"} or None."""
    import cv2

    h, w = rgb.shape[:2]
    px, py = point[0] * w, point[1] * h
    best = None
    for share in (0.18, 0.35, 0.6):  # small faces to large ones: a square this share of the short side
        half = share * min(h, w) / 2
        x0, y0 = int(max(0, px - half)), int(max(0, py - half))
        x1, y1 = int(min(w, px + half)), int(min(h, py + half))
        if x1 - x0 < 8 or y1 - y0 < 8:
            continue
        crop = rgb[y0:y1, x0:x1]
        scale = 480 / max(crop.shape[:2])
        small = cv2.resize(crop, (max(1, int(crop.shape[1] * scale)), max(1, int(crop.shape[0] * scale))),
                           interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        bgr = cv2.cvtColor((np.clip(small, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
        for f in im._faces_in(bgr):
            f = f.copy()
            f[:14] /= scale
            f[[0, 4, 6, 8, 10, 12]] += x0  # points move with the crop; the size (2, 3) doesn't
            f[[1, 5, 7, 9, 11, 13]] += y0
            # the spot is on the face (or just below: a click on the chin, the neck)
            if not (f[0] - 0.3 * f[2] <= px <= f[0] + 1.3 * f[2] and f[1] - 0.3 * f[3] <= py <= f[1] + 1.6 * f[3]):
                continue
            if best is None or f[14] > best[14]:
                best = f
    if best is None:
        return None
    with _recognizer_lock:
        global _recognizer
        if _recognizer is None:
            _recognizer = cv2.FaceRecognizerSF.create(str(model_file()), "")
    bgr = cv2.cvtColor((np.clip(rgb, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    with _recognizer_lock:
        e = _recognizer.feature(_recognizer.alignCrop(bgr, best)).flatten().astype(np.float32)
    e /= np.linalg.norm(e) or 1
    box = [best[0] / w, best[1] / h, best[2] / w, best[3] / h]
    return {"box": [round(float(v), 4) for v in box], "score": round(float(best[14]), 3), "emb": e}


def add_face(sid: str, g: dict, rgb: np.ndarray, point: list[float], ages: bool = False) -> str:
    """Someone the detector missed, at `point` (0..1 of the upright picture, rgb = the slide's upright
    blend): the face there if it can be found at a lower bar (described like the others), else a box
    of the size of the other faces on the slide around the spot, with no face description - the back
    of a head, a face too small or too blurred: their clothes still say who they are nearby. Answers
    its id. Marked `manual`: kept when the slide is looked at again."""
    entry = load_faces(sid).get(g["id"]) or {}
    near = find_near(rgb, point)
    if near is None:
        h, w = rgb.shape[:2]
        sizes = sorted(f["box"][2] * w for f in entry.get("faces", []))
        side = sizes[len(sizes) // 2] if sizes else 0.08 * min(h, w)
        bw, bh = side / w, side / h
        box = [min(max(point[0] - bw / 2, 0), 1 - bw), min(max(point[1] - bh / 2, 0), 1 - bh), bw, bh]
        face = {"box": [round(float(v), 4) for v in box], "score": 0.0}
    else:
        face = {**near, "emb": _pack(near["emb"])}
        if ages:
            face["age"] = estimate_ages(rgb, [face["box"]])[0]
    face.update(_dress(rgb, face))
    out = {}

    def commit(d: dict):
        e = d.get(g["id"])
        if not e or e.get("key") != face_key(g):
            raise RuntimeError("This slide's faces are being looked for: try again in a moment.")
        taken = {int(f["id"].rsplit("/", 1)[1]) for f in e["faces"]}
        n = next(i for i in range(len(taken) + 1) if i not in taken)
        out["id"] = f"{sid}/{g['id']}/{n}"
        e["faces"].append({"id": out["id"], **face, "manual": True})

    update_faces(sid, commit)
    return out["id"]


def drop_face(face: str) -> None:
    """Forget a face marked by hand (nobody there after all). Faces the detector found can't go:
    they'd be found again; those are "not them" instead."""
    sid, gid, _ = face.split("/")

    def commit(d: dict):
        e = d.get(gid) or {}
        f = next((x for x in e.get("faces", []) if x["id"] == face), None)
        if not f or not f.get("manual"):
            raise KeyError(face)
        e["faces"].remove(f)

    update_faces(sid, commit)


def add_ages(sid: str, gid: str, rgb: np.ndarray) -> None:
    """Give the faces already found on a slide their ages (rgb = the same upright blend): the ones
    without, or all of them when another model aged them (ids untouched)."""
    entry = load_faces(sid).get(gid) or {}
    redo = entry.get("ages_by") != AGE_BY
    todo = [f for f in entry.get("faces", []) if redo or "age" not in f]
    ages = dict(zip((f["id"] for f in todo), estimate_ages(rgb, [f["box"] for f in todo])))

    def commit(d: dict):
        e = d.get(gid) or {}
        for f in e.get("faces", []):
            if f["id"] in ages:
                f["age"] = ages[f["id"]]
        if e and all("age" in f for f in e.get("faces", [])):
            e["ages_by"] = AGE_BY

    update_faces(sid, commit)


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
    """{"people": {pid: {"name", "faces": [face ids], "birthday"?, "sure"?: [face ids], "immich"?,
    "ignored"?}}, "rejected": {face id: [pids]}, "next": int, "ages_off": [face ids]}. `sure`: faces the
    user put with them by hand (the age check never doubts those). `ignored`: someone the user doesn't
    care about (a stranger in a crowd, see seen). `ages_off`: faces the user said are who they're
    with although the age they look doesn't fit (dating.suspects): the age model got those wrong, they
    date nothing. "immich": {"id", "name"}, the Immich person they were synced with and the name both
    had then."""
    f = people_file()
    d = json.loads(f.read_text()) if f.exists() else {}
    return {"people": d.get("people", {}), "rejected": d.get("rejected", {}), "next": d.get("next", 1),
            "ages_off": d.get("ages_off", [])}


def save_people(d: dict) -> None:
    _atomic_write(people_file(), d)


_face_cache: dict[str, tuple[int, dict]] = {}


def all_faces() -> dict[str, dict]:
    """Every face in the library: {face id: {"sid", "gid", "emb" (None: marked by hand where no face
    was found), "box", "score", "key", "clothes" (or None), "manual", "age"?}}."""
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
                        faces[x["id"]] = {"sid": sid, "gid": gid, "emb": unpack(x["emb"]) if x.get("emb") else None,
                                          "box": x["box"], "score": x.get("score", 0), "key": e.get("key", ""),
                                          "clothes": unpack_clothes(x.get("clothes")), "manual": bool(x.get("manual")),
                                          **({"age": x["age"]} if "age" in x else {})}
                hit = (mt, faces)
                _face_cache[sid] = hit
        except (OSError, ValueError):
            continue
        out.update(hit[1])
    return out


def refresh() -> dict:
    """Bring people.json up to date with the faces on disk: faces that are gone leave their person
    (an unnamed person left empty goes too), new faces join the person they resemble or form new ones.
    Faces with no description (marked by hand, no face found) stay with whoever they were put with."""
    with _lock:
        d = load_people()
        faces = all_faces()
        ids = [f for f in faces if faces[f]["emb"] is not None]
        index = {f: i for i, f in enumerate(ids)}
        pids = list(d["people"])
        at = {p: i for i, p in enumerate(pids)}
        clusters = [[index[f] for f in d["people"][p]["faces"] if f in index] for p in pids]
        rejected = {index[f]: {at[p] for p in ps if p in at} for f, ps in d["rejected"].items() if f in index}
        emb = np.stack([faces[f]["emb"] for f in ids]) if ids else np.zeros((0, 128))
        groups = agglomerate(emb, clusters, rejected)
        people = {}
        for p, g in zip(pids, groups):
            blind = [f for f in d["people"][p]["faces"] if f in faces and f not in index]
            if g or blind or d["people"][p].get("name") or d["people"][p].get("birthday") or d["people"][p].get("immich"):
                people[p] = {**d["people"][p], "faces": [ids[i] for i in g] + blind}
                if "sure" in people[p]:
                    people[p]["sure"] = [f for f in people[p]["sure"] if f in people[p]["faces"]]
        for g in groups[len(pids):]:
            people[f"p{d['next']}"] = {"name": "", "faces": [ids[i] for i in g]}
            d["next"] += 1
        new = {"people": people, "next": d["next"],
               "rejected": {f: [p for p in ps if p in people] for f, ps in d["rejected"].items() if f in faces},
               "ages_off": [f for f in d["ages_off"] if f in faces]}
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
        if name:  # someone with a name matters after all
            d["people"][pid].pop("ignored", None)
        same = [p for p, v in d["people"].items() if p != pid and name and v.get("name", "").lower() == name.lower()]
        if same:
            _merge(d, same[0], [pid])

    d = _edit(fn)
    return _spread_from(d, [p for p, v in d["people"].items()
                            if p == pid or (name and v.get("name", "").lower() == name.lower())])


def clean_birthday(v) -> str:
    """'1952', '1952-03' or '1952-03-14' (as dates are typed everywhere else), "" = none. ValueError on junk."""
    from .store import format_date, parse_date

    v = str(v or "").strip()
    if not v:
        return ""
    p = parse_date(v)
    if not p or not 1850 <= p[0].year <= 2100:
        raise ValueError("A birthday is a year, year-month or a full date, like 1952-03-14")
    return format_date(*p)


def set_birthday(pid: str, value) -> dict:
    """Someone's birthday (for dating the slides they're on); "" forgets it."""
    b = clean_birthday(value)

    def fn(d):
        if pid not in d["people"]:
            raise KeyError(pid)
        if b:
            d["people"][pid]["birthday"] = b
        else:
            d["people"][pid].pop("birthday", None)

    return _spread_from(_edit(fn), [pid])


def _merge(d: dict, into: str, others: list[str]) -> None:
    target = d["people"][into]
    for p in others:
        if p == into or p not in d["people"]:
            continue
        gone = d["people"].pop(p)
        target["faces"] += gone["faces"]
        if gone.get("sure"):
            target["sure"] = sorted(set(target.get("sure", [])) | set(gone["sure"]))
        target["name"] = target.get("name") or gone.get("name", "")
        if not target.get("birthday") and gone.get("birthday"):
            target["birthday"] = gone["birthday"]
        if not target.get("immich") and gone.get("immich"):
            target["immich"] = gone["immich"]
        if not gone.get("ignored"):  # ignored only if every one of them was
            target.pop("ignored", None)
        for f, ps in d["rejected"].items():
            d["rejected"][f] = sorted({into if x == p else x for x in ps})


def merge(into: str, others: list[str]) -> dict:
    def fn(d):
        if into not in d["people"]:
            raise KeyError(into)
        _merge(d, into, others)

    return _spread_from(_edit(fn), [into])


def remove_faces(pid: str, face_ids: list[str]) -> dict:
    """Take wrongly grouped faces out of a person; they won't be put back there."""
    def fn(d):
        if pid not in d["people"]:
            raise KeyError(pid)
        _take_out(d, pid, face_ids)

    return _edit(fn)


def _take_out(d: dict, pid: str, face_ids: list[str]) -> None:
    p = d["people"][pid]
    p["faces"] = [f for f in p["faces"] if f not in face_ids]
    if p.get("sure"):
        p["sure"] = [f for f in p["sure"] if f not in face_ids]
    for f in face_ids:
        d["rejected"][f] = sorted(set(d["rejected"].get(f, [])) | {pid})


def assign(face: str, to: str | None, name: str = "", age_off: bool = False) -> dict:
    """Say who a face is: `to` = a person, "new" (someone not seen before, called `name`; a name
    someone already has is them), or None (not the person it's with now, nobody in particular).
    Whoever it was with is remembered as not it; the face is `sure` with its new person, so the age
    check (dating.suspects) leaves it alone. The same person as now = "yes, it is them". `age_off`:
    it is them although the age it looks doesn't fit - the age is wrong, it dates nothing."""
    name = " ".join(str(name).split())[:80]

    def fn(d):
        now = next((p for p, v in d["people"].items() if face in v["faces"]), None)
        target = to
        if target == "new":
            target = next((p for p, v in d["people"].items() if name and v.get("name", "").lower() == name.lower()), None)
            if not target:
                target = f"p{d['next']}"
                d["next"] += 1
                d["people"][target] = {"name": name, "faces": []}
        elif target is not None and target not in d["people"]:
            raise KeyError(target)
        if now and now != target:
            _take_out(d, now, [face])
        off = set(d["ages_off"]) - {face}
        d["ages_off"] = sorted(off | {face} if age_off and target == now else off)
        if target:
            p = d["people"][target]
            p.pop("ignored", None)  # a face put with them by hand: they matter
            if face not in p["faces"]:
                p["faces"].append(face)
            p["sure"] = sorted(set(p.get("sure", [])) | {face})
            rej = [x for x in d["rejected"].get(face, []) if x != target]
            if rej:
                d["rejected"][face] = rej
            else:
                d["rejected"].pop(face, None)
            if now and now != target and _known(p) and not _known(d["people"][now]) \
                    and not d["people"][now].get("immich"):
                _follow(d, face, now, target)

    d = _edit(fn)
    return _spread_from(d, [p for p, v in d["people"].items() if face in v["faces"]], [face.split("/")[0]])


def _follow(d: dict, face: str, frm: str, to: str) -> None:
    """A face of an unnamed group was said to be someone: the rest of the group that looks like that
    face (SAME_PERSON) comes along - clustering put them together, the name says who they all are.
    Not onto a slide they're on already, not faces taken out of them before."""
    faces = all_faces()
    me = faces.get(face)
    if not me or me["emb"] is None:
        return
    on = {(faces[f]["sid"], faces[f]["gid"]) for f in d["people"][to]["faces"] if f in faces}
    for f in list(d["people"][frm]["faces"]):
        x = faces.get(f)
        if (not x or x["emb"] is None or to in d["rejected"].get(f, ()) or (x["sid"], x["gid"]) in on
                or float(x["emb"] @ me["emb"]) < SAME_PERSON):
            continue
        d["people"][frm]["faces"].remove(f)
        d["people"][to]["faces"].append(f)
        on.add((x["sid"], x["gid"]))


def _known(p: dict | None) -> bool:
    """Someone the user said who they are: a name or a birthday (the rest are clusters)."""
    return bool(p and (p.get("name") or p.get("birthday")))


def _order(sid: str) -> dict[str, int]:
    """A tray's slides: {gid: position}."""
    from .store import Session

    try:
        return {g["id"]: i for i, g in enumerate(Session(sid).data["groups"])}
    except (FileNotFoundError, ValueError):
        return {}


def _fit(x: dict, y: dict) -> float | None:
    """How sure it is that face x is whoever face y is, on slides close together (the same day, the
    same clothes); None = not sure enough. A clear likeness is enough; a slight one takes the same
    clothes; next to a face marked by hand (nothing to compare) the clothes alone, very alike."""
    look = float(x["emb"] @ y["emb"]) if x["emb"] is not None and y["emb"] is not None else None
    dress = clothes_like(x["clothes"], y["clothes"])
    if look is not None and look >= SAME_PERSON:
        return look + (dress or 0)
    if dress is not None and (dress >= CLOTHES_ONLY if look is None else dress >= SAME_CLOTHES and look >= LOOKS_LIKE):
        return (look or 0) + dress
    return None


def _ignored(d: dict, pid: str | None) -> bool:
    return bool(pid and (d["people"].get(pid) or {}).get("ignored"))


def spread(sids) -> list[str]:
    """Names spread to the slides around them: on a tray, a face whose person has no name (a cluster,
    or alone), within NEAR slides of a named person's face and like it (_fit), is them. Best matches
    first, again from the faces just named, until nothing more fits; never two faces of one person
    on a slide, never a person a face was taken out of, never a face the user placed, never to or
    from someone ignored. Answers the faces named."""
    if not any(_known(p) for p in load_people()["people"].values()):
        return []
    with _lock:
        d = refresh()
        faces = all_faces()
        owner = {f: p for p, v in d["people"].items() for f in v["faces"]}
        sure = {f for v in d["people"].values() for f in v.get("sure", ())}
        moved = []
        for sid in dict.fromkeys(sids):
            pos = _order(sid)
            here = {f: x for f, x in faces.items() if x["sid"] == sid and x["gid"] in pos}
            # every pair close enough to count, best first: (fit, face, the face it'd follow)
            pairs = sorted(((v, f, a) for f, x in here.items() if f not in sure and x["emb"] is not None
                            for a, y in here.items() if 0 < abs(pos[x["gid"]] - pos[y["gid"]]) <= NEAR
                            for v in [_fit(x, y)] if v is not None), key=lambda t: -t[0])
            on = {(owner.get(f), x["gid"]) for f, x in here.items()}
            changed = True
            while changed:
                changed = False
                for _, f, a in pairs:
                    p, now = owner.get(a), owner.get(f)
                    if (not _known(d["people"].get(p)) or _known(d["people"].get(now)) or p == now
                            or p in d["rejected"].get(f, ()) or (p, here[f]["gid"]) in on
                            or _ignored(d, p) or _ignored(d, now)):  # the user said: nobody to us
                        continue
                    if now:
                        d["people"][now]["faces"].remove(f)
                    d["people"][p]["faces"].append(f)
                    owner[f] = p
                    on.add((p, here[f]["gid"]))
                    moved.append(f)
                    changed = True
        if moved:
            save_people(d)
            refresh()
        return moved


def _spread_from(d: dict, pids: list[str], sids: list[str] = ()) -> dict:
    """spread() on the trays these people are on (and `sids`), answering people.json as it is then."""
    faces = all_faces()
    trays = list(sids) + sorted({faces[f]["sid"] for p in pids if p in d["people"]
                                 for f in d["people"][p]["faces"] if f in faces})
    return refresh() if trays and spread(trays) else d


def likely(face: str, d: dict) -> dict[str, float]:
    """How likely a face is each person the user named (the slide view's picker puts the likeliest
    first): how like their faces it looks (the mean of its three best matches: people change over the
    years), and more when they are on the slides around it (up to NEAR away, most on the next one),
    most in the same clothes. -1: they're on its slide already, or it was taken out of them.
    {pid: score}; SAME_PERSON and up is likely them."""
    faces = all_faces()
    me = faces.get(face)
    if not me:
        return {}
    pos = _order(me["sid"])
    here = pos.get(me["gid"])
    out = {}
    for pid, p in d["people"].items():
        if not _known(p):
            continue
        fs = [faces[f] for f in p["faces"] if f in faces and f != face]
        if pid in d["rejected"].get(face, ()) or any(x["sid"] == me["sid"] and x["gid"] == me["gid"] for x in fs):
            out[pid] = -1.0
            continue
        sims = sorted((float(me["emb"] @ x["emb"]) for x in fs if me["emb"] is not None and x["emb"] is not None),
                      reverse=True)
        near = 0.0
        for x in fs:
            dist = abs(pos[x["gid"]] - here) if x["sid"] == me["sid"] and x["gid"] in pos and here is not None else 0
            if 0 < dist <= NEAR:
                dress = clothes_like(me["clothes"], x["clothes"]) or 0.0
                near = max(near, (1 - (dist - 1) / NEAR) * (0.1 + 0.4 * dress))
        out[pid] = round((float(np.mean(sims[:3])) if sims else 0.0) + near, 4)
    return out


def set_ignored(pids: list[str], ignored: bool = True) -> dict:
    """Ignore people (strangers in a crowd, the players on the other team) or stop ignoring them.
    They stay people - their look-alikes on later slides keep joining them, so they stay ignored too -
    but drop out of the lists, the slides' faces, dating, the map and the Immich sync (seen). Unknown
    ids are skipped (joined someone already)."""
    def fn(d):
        for pid in pids:
            if pid not in d["people"]:
                continue
            if ignored:
                d["people"][pid]["ignored"] = True
            else:
                d["people"][pid].pop("ignored", None)

    return _edit(fn)


def face_owners(d: dict, faces: list[str]) -> list[str]:
    """The people these faces are with (each once, in order)."""
    owner = {f: pid for pid, p in d["people"].items() for f in p["faces"]}
    return list(dict.fromkeys(owner[f] for f in faces if f in owner))


def seen(d: dict) -> dict:
    """people.json without the people the user ignored: what dating, the map and the sync go by."""
    if not any(p.get("ignored") for p in d["people"].values()):
        return d
    return {**d, "people": {pid: p for pid, p in d["people"].items() if not p.get("ignored")}}


def label(pid: str, p: dict) -> str:
    """What to call someone: their name, or "Person 12" (the number in their id, which stays
    theirs) until they have one."""
    return p.get("name") or f"Person {pid.removeprefix('p')}"


def set_links(links: dict[str, dict]) -> dict:
    """Remember the Immich person each of these people was synced with: {pid: {"id", "name"}}."""
    def fn(d):
        for pid, link in links.items():
            if pid in d["people"]:
                d["people"][pid]["immich"] = link

    return _edit(fn)


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
