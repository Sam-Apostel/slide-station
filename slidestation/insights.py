"""Insights: suggestions about what is on a slide, computed in the background, never applied silently.

Per slide, `g["insights"]` holds what the models suggest:

    {"key": ..., "tags": [{"value": "beach", "confidence": 0.41, "source": "clip-vit-b32", "state": "suggested"}],
     "caption": None | {...}, "place": None | {...}, "date": None | {...}}

`state` is "suggested", "accepted" (the value became the slide's own tag / caption / date) or
"dismissed" (it never comes back for that slide, and counts against the label, below). `key` names
what the suggestions were computed from (active scans, rotation, model, labels): a slide whose key
is stale is analysed again, keeping every decision already made.

Scene tags come from zero-shot CLIP (ViT-B/32, ONNX, quantized) on the blended proxy. The model is
downloaded on first use into the library's `models/` folder (resumable, verified, atomic), the
label text embeddings are computed once and cached next to it. A background thread analyses the
open tray (and trays queued with `queue_tray`) one slide at a time while no job runs; it commits
through `workflow.update_session`, so it never saves over an edit made meanwhile.

Learning: every accept / dismiss is counted per label in the library's `insights.json`; a label
dismissed more often than accepted needs a higher confidence before it is suggested again.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

from . import imaging as im
from . import workflow as wf
from .store import Session, _atomic_write, active_scans, as_home, library, load_config, lock, models_dir

KINDS = ("tags", "caption", "date", "place")

# ------------------------------------------------------------------------------------ labels

# (tag, prompt). The tag is what the user sees and what goes to Immich; the prompt is what CLIP
# compares the photo with. Order doesn't matter; changing the list re-analyses every slide.
LABELS: list[tuple[str, str]] = [
    ("beach", "a photo of a beach"),
    ("sea", "a photo of the sea"),
    ("lake", "a photo of a lake"),
    ("snow", "a photo of snow"),
    ("skiing", "a photo of people skiing"),
    ("mountains", "a photo of mountains"),
    ("forest", "a photo of a forest"),
    ("landscape", "a landscape photo"),
    ("sunset", "a photo of a sunset"),
    ("city", "a photo of a city"),
    ("street", "a photo of a street"),
    ("village", "a photo of a village"),
    ("church", "a photo of a church"),
    ("castle", "a photo of a castle"),
    ("wedding", "a photo of a wedding"),
    ("birthday", "a photo of a birthday party"),
    ("christmas", "a photo of christmas"),
    ("party", "a photo of a party"),
    ("car", "a photo of a car"),
    ("train", "a photo of a train"),
    ("airplane", "a photo of an airplane"),
    ("boat", "a photo of a boat"),
    ("dog", "a photo of a dog"),
    ("cat", "a photo of a cat"),
    ("horse", "a photo of a horse"),
    ("garden", "a photo of a garden"),
    ("flowers", "a photo of flowers"),
    ("family group", "a group photo of a family"),
    ("portrait", "a portrait photo of a person"),
    ("children", "a photo of children playing"),
    ("baby", "a photo of a baby"),
    ("interior", "a photo of a room interior"),
    ("food", "a photo of food on a table"),
    ("camping", "a photo of a tent at a campsite"),
    ("swimming pool", "a photo of a swimming pool"),
]
TAGS = [t for t, _ in LABELS]
LABELS_KEY = hashlib.sha1(json.dumps(LABELS).encode()).hexdigest()[:8]

THRESHOLD = 0.12  # softmax share a label needs before it is suggested
MAX_TAGS = 4
LOGIT_SCALE = 100.0  # CLIP's learned temperature

# ------------------------------------------------------------------------------------ the model

MODEL_ID = "clip-vit-b32"
_REPO = "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/"
# (path in the repo, local name, bytes, checksum): LFS files by sha256, small ones by git blob sha1
MODEL_FILES = [
    ("onnx/vision_model_quantized.onnx", "vision.onnx", 89117001,
     "sha256:583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299"),
    ("onnx/text_model_quantized.onnx", "text.onnx", 64504507,
     "sha256:73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a"),
    ("vocab.json", "vocab.json", 862328, "git:182766ce89b439768edadda342519f33802f5364"),
    ("merges.txt", "merges.txt", 524619, "git:76e821f1b6f0a9709293c3b6b51ed90980b3166b"),
]
MODEL_MB = round(sum(f[2] for f in MODEL_FILES) / 1e6)
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)


def model_dir() -> Path:
    return models_dir() / MODEL_ID


def model_ready() -> bool:
    d = model_dir()
    return all((d / name).is_file() and (d / name).stat().st_size == size for _, name, size, _ in MODEL_FILES)


def enabled() -> bool:
    return bool(load_config().get("insights_enabled", False))


def _checksum(path: Path, want: str) -> bool:
    algo, digest = want.split(":", 1)
    h = hashlib.sha256() if algo == "sha256" else hashlib.sha1(b"blob %d\0" % path.stat().st_size)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest() == digest


OFFLINE = ("Couldn't reach huggingface.co to download the tag model ({}). Check the internet connection "
           "and try again; the download continues where it stopped.")


def download_model(job) -> None:
    """Fetch the model files into the library (a job: progress in MB). Each file is written to a
    .part file that a later attempt resumes (HTTP Range), checked against its checksum, then moved
    into place, so a half-downloaded model is never used."""
    import httpx

    d = model_dir()
    d.mkdir(parents=True, exist_ok=True)
    job.total = MODEL_MB
    job.message = "Downloading the tag model (MB)"
    done = 0
    try:
        with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30, read=60)) as client:
            for remote, name, size, want in MODEL_FILES:
                dest = d / name
                if dest.is_file() and dest.stat().st_size == size:
                    done += size
                    job.done = round(done / 1e6)
                    continue
                part = d / (name + ".part")
                have = part.stat().st_size if part.exists() else 0
                if have > size:
                    part.unlink()
                    have = 0
                if have < size:
                    headers = {"Range": f"bytes={have}-"} if have else {}
                    with client.stream("GET", _REPO + remote, headers=headers) as r:
                        if r.status_code == 200 and have:  # the server ignored the range: start over
                            have = 0
                        elif r.status_code not in (200, 206):
                            raise RuntimeError(f"Downloading {name} failed: HTTP {r.status_code}")
                        with open(part, "ab" if have else "wb") as f:
                            for chunk in r.iter_bytes(1 << 20):
                                f.write(chunk)
                                have += len(chunk)
                                job.done = round((done + have) / 1e6)
                if part.stat().st_size < size:  # the connection ended early: keep it for the next try
                    raise RuntimeError(OFFLINE.format("the download stopped early"))
                if part.stat().st_size != size or not _checksum(part, want):
                    part.unlink(missing_ok=True)
                    raise RuntimeError(f"The downloaded {name} didn't match its checksum; try again.")
                os.replace(part, dest)
                done += size
                job.done = round(done / 1e6)
    except httpx.TransportError as e:  # offline, DNS, proxy, a dropped connection, a timeout
        raise RuntimeError(OFFLINE.format(e.__class__.__name__)) from None
    job.done = job.total
    job.message = "Tag model ready: slides are analysed in the background"


# ------------------------------------------------------------------------------------ tokenizer


def _bytes_to_unicode() -> dict[int, str]:
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, map(chr, cs)))


class Tokenizer:
    """CLIP's byte-level BPE (OpenAI's simple_tokenizer, without ftfy: the labels are plain ASCII)."""

    SOT, EOT = "<|startoftext|>", "<|endoftext|>"
    PAT = re.compile(r"'s|'t|'re|'ve|'m|'ll|'d|[^\W\d_]+|\d|[^\s\w]+|_+", re.IGNORECASE)

    def __init__(self, vocab: Path, merges: Path):
        self.encoder = json.loads(vocab.read_text(encoding="utf-8"))
        lines = merges.read_text(encoding="utf-8").split("\n")
        pairs = [tuple(m.split()) for m in lines if m and not m.startswith("#version")]
        self.ranks = {p: i for i, p in enumerate(pairs)}
        self.byte_encoder = _bytes_to_unicode()

    def _bpe(self, token: str) -> list[str]:
        word = list(token[:-1]) + [token[-1] + "</w>"]
        while len(word) > 1:
            pairs = {(word[i], word[i + 1]) for i in range(len(word) - 1)}
            best = min(pairs, key=lambda p: self.ranks.get(p, float("inf")))
            if best not in self.ranks:
                break
            out, i = [], 0
            while i < len(word):
                if i < len(word) - 1 and (word[i], word[i + 1]) == best:
                    out.append(word[i] + word[i + 1])
                    i += 2
                else:
                    out.append(word[i])
                    i += 1
            word = out
        return word

    def encode(self, text: str) -> list[int]:
        text = " ".join(text.split()).lower()
        ids = [self.encoder[self.SOT]]
        for tok in self.PAT.findall(text):
            tok = "".join(self.byte_encoder[b] for b in tok.encode("utf-8"))
            ids += [self.encoder[t] for t in self._bpe(tok)]
        return (ids + [self.encoder[self.EOT]])[:77]


# ------------------------------------------------------------------------------------ embeddings


class Clip:
    """The ONNX CLIP: image and text embeddings, unit length. The text half only runs once, to
    embed the label prompts (cached as labels-<key>.npy next to the model)."""

    def __init__(self, d: Path):
        import onnxruntime as ort

        self.dir = d
        self.opts = ort.SessionOptions()
        self.opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)  # leave room for the UI's renders
        self.vision = ort.InferenceSession(str(d / "vision.onnx"), self.opts, providers=["CPUExecutionProvider"])
        self._labels: np.ndarray | None = None

    def image_embed(self, rgb: np.ndarray) -> np.ndarray:
        e = self.vision.run(None, {"pixel_values": preprocess(rgb)[None]})[0][0]
        return e / np.linalg.norm(e)

    def text_embed(self, texts: list[str]) -> np.ndarray:
        import onnxruntime as ort

        tok = Tokenizer(self.dir / "vocab.json", self.dir / "merges.txt")
        text = ort.InferenceSession(str(self.dir / "text.onnx"), self.opts, providers=["CPUExecutionProvider"])
        ids = [tok.encode(t) for t in texts]
        n = max(map(len, ids))
        eot = ids[0][-1]
        # padded with end-of-text: the model pools at the first (highest-id) end-of-text token
        batch = np.array([x + [eot] * (n - len(x)) for x in ids], np.int64)
        e = text.run(None, {"input_ids": batch})[0]
        return e / np.linalg.norm(e, axis=1, keepdims=True)

    def label_embeds(self) -> np.ndarray:
        if self._labels is None:
            f = self.dir / f"labels-{LABELS_KEY}.npy"
            if f.exists():
                self._labels = np.load(f)
            else:
                self._labels = self.text_embed([p for _, p in LABELS]).astype(np.float32)
                tmp = f.with_name(f.stem + ".part.npy")
                np.save(tmp, self._labels)
                os.replace(tmp, f)
        return self._labels


def preprocess(rgb: np.ndarray) -> np.ndarray:
    """CLIP's input: shortest side to 224 (bicubic), centre crop, normalised, CHW float32."""
    img = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8))
    w, h = img.size
    f = 224 / min(w, h)
    img = img.resize((max(224, round(w * f)), max(224, round(h * f))), Image.BICUBIC)
    w, h = img.size
    left, top = (w - 224) // 2, (h - 224) // 2
    a = np.asarray(img.crop((left, top, left + 224, top + 224)), np.float32) / 255
    return ((a - MEAN) / STD).transpose(2, 0, 1).copy()


_clip: Clip | None = None
_model_lock = threading.Lock()


def backend():
    """The loaded model (image_embed, label_embeds), or None while it isn't downloaded. Tests
    replace this with a fake."""
    global _clip
    if not model_ready():
        return None
    with _model_lock:
        if _clip is None or _clip.dir != model_dir():
            _clip = Clip(model_dir())
            _clip.label_embeds()
        return _clip


def scene_tags(b, rgb: np.ndarray) -> list[tuple[str, float]]:
    """Every label with its zero-shot probability (softmax over the label list), best first."""
    logits = LOGIT_SCALE * (b.label_embeds() @ b.image_embed(rgb))
    p = np.exp(logits - logits.max())
    p /= p.sum()
    return [(TAGS[i], float(p[i])) for i in np.argsort(-p)]


# ------------------------------------------------------------------------------------ learning


def _learn_file() -> Path:
    return library() / "insights.json"


def learned() -> dict:
    f = _learn_file()
    try:
        return json.loads(f.read_text()) if f.exists() else {"labels": {}}
    except ValueError:
        return {"labels": {}}


def record(kind: str, value: str, action: str, n: int = 1) -> None:
    """Count an accept / dismiss of a suggestion (tags only: that's what the threshold is per)."""
    if kind != "tags" or action not in ("accept", "dismiss") or n <= 0:
        return
    with lock:
        d = learned()
        c = d.setdefault("labels", {}).setdefault(value, {"accepted": 0, "dismissed": 0})
        c["accepted" if action == "accept" else "dismissed"] += n
        _atomic_write(_learn_file(), d)


def threshold(label: str, stats: dict | None = None) -> float:
    """How sure the model must be before suggesting `label`: dismissed more than accepted raises it,
    up to 4x (a label you keep dismissing all but disappears)."""
    c = (stats if stats is not None else learned()).get("labels", {}).get(label)
    if not c:
        return THRESHOLD
    return THRESHOLD * min(4.0, max(1.0, (1 + c.get("dismissed", 0)) / (1 + c.get("accepted", 0))))


# ------------------------------------------------------------------------------------ per slide


def insights_key(g: dict) -> str:
    return hashlib.sha1(json.dumps([active_scans(g), g["rotation"], MODEL_ID, LABELS_KEY]).encode()).hexdigest()[:12]


def needs_analysis(g: dict) -> bool:
    return not g.get("skip") and (g.get("insights") or {}).get("key") != insights_key(g)


def analyse(s, g: dict, b) -> dict:
    """Fresh suggestions for one slide (no decisions merged in yet)."""
    rgb = im.rotate_arr(wf.fused_proxy(s, g), g["rotation"])
    stats = learned()
    ranked = scene_tags(b, rgb)
    tags = [{"value": t, "confidence": round(p, 3), "source": MODEL_ID, "state": "suggested"}
            for t, p in ranked if p >= threshold(t, stats)][:MAX_TAGS]
    return {"key": insights_key(g), "tags": tags}


def merge(old: dict | None, new: dict, own_tags: list[str]) -> dict:
    """New suggestions with the decisions already made kept: accepted and dismissed entries stay
    (confidence refreshed), a new suggestion for a tag the slide already has counts as accepted."""
    old = old or {}
    kept = {e["value"]: e for e in old.get("tags", []) if e.get("state") in ("accepted", "dismissed")}
    tags = []
    for e in new.get("tags", []):
        if e["value"] in kept:
            tags.append({**e, "state": kept.pop(e["value"])["state"]})
        else:
            tags.append({**e, "state": "accepted" if e["value"] in own_tags else "suggested"})
    tags += kept.values()
    out = {"key": new["key"], "tags": tags}
    for k in ("caption", "date", "place"):
        out[k] = new.get(k) if new.get(k) is not None else old.get(k)
    return out


def analyse_slide(sid: str, gid: str) -> bool:
    """Analyse one slide and commit if it is still the same slide (scans, rotation) afterwards."""
    b = backend()
    if b is None:
        return False
    s = Session(sid)
    g = s.group(gid)
    new = analyse(s, g, b)  # the slow part, outside the lock

    def commit(fresh):
        try:
            fg = fresh.group(gid)
        except KeyError:
            return
        if insights_key(fg) == new["key"] and (fg.get("insights") or {}).get("key") != new["key"]:
            fg["insights"] = merge(fg.get("insights"), new, fg.get("tags", []))

    wf.update_session(sid, commit)
    return True


# ------------------------------------------------------------------------------------ background

queued_by: dict[str, list[str]] = {}  # per library: trays asked for with "Analyse", besides the open one


def _queued() -> list[str]:
    return queued_by.setdefault(wf._key(), [])


def queue_tray(sid: str) -> None:
    if sid not in _queued():
        _queued().append(sid)


def pending(d: dict) -> int:
    return sum(1 for g in d["groups"] if needs_analysis(g))


def step() -> bool:
    """Analyse the next slide that needs it (open tray first). Returns whether it did anything."""
    if not enabled() or backend() is None:
        return False
    if wf.current_job and not wf.current_job.finished:  # imports reshape slides; uploads need the memory
        return False
    queued = _queued()
    for sid in [x for x in [wf.active_session, *queued] if x]:
        try:
            s = Session(sid)
        except FileNotFoundError:
            s = None
        g = next((g for g in s.data["groups"] if needs_analysis(g)), None) if s else None
        if g is None:  # nothing left to do there
            if sid in queued:
                queued.remove(sid)
            continue
        try:
            analyse_slide(sid, g["id"])
        except Exception as e:  # e.g. an unreadable scan: note it, don't try that slide forever
            print("insights:", e)
            key = insights_key(g)

            def failed(fresh, gid=g["id"], key=key, err=str(e) or e.__class__.__name__):
                try:
                    fg = fresh.group(gid)
                except KeyError:
                    return
                if insights_key(fg) == key:
                    fg["insights"] = {**merge(fg.get("insights"), {"key": key, "tags": []}, fg.get("tags", [])),
                                      "error": err}

            wf.update_session(sid, failed)
        return True
    return False


def _worker():
    while True:
        time.sleep(1.0)
        for home in wf.homes():  # every library in use (accounts: each user's), one after the other
            try:
                with as_home(home):
                    while step():
                        pass
            except Exception as e:  # never let the helper thread die
                print("insights:", e)
                time.sleep(10)


threading.Thread(target=_worker, daemon=True, name="insights").start()
