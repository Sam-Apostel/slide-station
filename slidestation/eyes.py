"""Eyes open: which of a few near-identical shots has everyone's eyes open (ROADMAP §1 "Eyes open").

Look-alikes (similar.py) group the same shot taken twice; "keep the best" went by sharpness and
clipping alone. With this on, a shot where someone blinked loses to one where nobody did.

How: the faces YuNet already finds (imaging.detect_faces, as for people and the rotation vote), each
cut out as MediaPipe cuts a face out of its detector's box (a square 1.5 x the box, turned so the
eyes are level, 256 px), then Google's MediaPipe face landmarks model (the 478-point face mesh of
Face Landmarker, Apache 2.0, converted to ONNX; ~5 MB, downloaded on first use into the library's
models/ folder) and, per eye, the eye aspect ratio of Soukupová & Čech (2016):

    EAR = (|p2 - p6| + |p3 - p5|) / (2 |p1 - p4|)     p1, p4 the corners, p2 p3 / p6 p5 the lids

An open eye measures ~0.2-0.45 on the mesh, a closed one ~0.01-0.1. Per face the mean of its two
eyes; per slide the faces that matter (at least half as wide as the largest) are kept as a list of
EARs next to the slide's embedding in embeddings.json (`"eyes": {"model", "ear": [...]}`), so the
thresholds below can change without measuring again. How open a slide's eyes are = the least open
of those faces (one person blinking spoils a group photo).
"""
from __future__ import annotations

import math
import threading
from pathlib import Path

import numpy as np

from . import imaging as im
from .store import load_config, models_dir

MODEL_ID = "face-landmarks-478"
# Google's MediaPipe Face Landmarker face mesh (Apache-2.0), converted TFLite -> ONNX with the weights
# unchanged by senty-au (Apache-2.0, a pinned revision; its card names the source bundle and checksums)
_REPO = "https://huggingface.co/senty-au/face_landmarks_detector-ONNX/resolve/337d58218b5b1cc597ca3c67360880b920f6ce7b/"
# (path in the repo, local name, bytes, checksum), as insights.fetch_files takes them
MODEL_FILES = [("onnx/model.onnx", "model.onnx", 4920995,
                "sha256:7d6e82dee82a1dca5fbddb282b3cc74571833a530de317fc22ae325c3358beeb")]
MODEL_MB = round(sum(f[2] for f in MODEL_FILES) / 1e6)

SIZE = 256  # the model's input: a square crop around one face
CROP = 1.5  # the crop is this x the face box's longer side (MediaPipe's ROI from a detection)
MIN_SCORE = 0.7  # a face needs this detector confidence (as for people and the rotation vote)...
MIN_SIZE = 0.04  # ... and this width as a share of the picture's (64 px on the proxy: eyes ~12 px wide)
PROMINENT = 0.5  # of those, the faces at least this share of the largest one's width count
MAX_FACES = 8  # at most this many (the largest) per slide
PRESENCE = 0.5  # the landmark model's own "this is a face" (sigmoid of its logit)

# The mesh's eye contours, p1..p6 in EAR order (outer / inner corner, two upper lid, two lower lid points)
RIGHT_EYE = [33, 160, 158, 133, 153, 144]
LEFT_EYE = [362, 385, 387, 263, 373, 380]

# EAR -> "how open" 0..1, a ramp between these. Measured (ARCHITECTURE §5e "Eyes open"): 700 AI-made
# portraits labelled open / closed - closed median 0.04, open never below 0.22 (median 0.33); 1648
# real photos (LFW): median 0.27, those below 0.10 closed or screwed up in a laugh, 0.12-0.18 mostly
# open but narrow (smiles, low resolution).
CLOSED_EAR = 0.10
OPEN_EAR = 0.18
CLOSED = 0.5  # a slide whose least open face is below this (EAR 0.14) has "eyes closed" (the card says so)


def model_dir() -> Path:
    return models_dir() / MODEL_ID


def model_ready() -> bool:
    d = model_dir()
    return all((d / name).is_file() and (d / name).stat().st_size == size for _, name, size, _ in MODEL_FILES)


def enabled() -> bool:
    """Turned on in Settings (under the tag model: look-alikes come from it)."""
    cfg = load_config()
    return bool(cfg.get("eyes_enabled")) and bool(cfg.get("insights_enabled"))


def on() -> bool:
    return enabled() and model_ready()


def download_model(job) -> None:
    from . import insights

    insights.fetch_files(job, _REPO, MODEL_FILES, model_dir(), "eye model")
    job.message = "Eye model ready: look-alikes now prefer open eyes"


# --------------------------------------------------------------------------- maths


def ear(p: np.ndarray) -> float:
    """The eye aspect ratio of one eye's six points (p1..p6, see RIGHT_EYE)."""
    p = np.asarray(p, np.float64)
    width = float(np.linalg.norm(p[0] - p[3]))
    if width < 1e-6:
        return 0.0
    return float((np.linalg.norm(p[1] - p[5]) + np.linalg.norm(p[2] - p[4])) / (2 * width))


def face_ear(pts: np.ndarray) -> float:
    """A face's EAR from its mesh points (478 x 2+): the mean of its two eyes."""
    return (ear(pts[RIGHT_EYE, :2]) + ear(pts[LEFT_EYE, :2])) / 2


def openness(e: float) -> float:
    """How open, 0 (closed) .. 1 (open), from an EAR."""
    return float(min(1.0, max(0.0, (e - CLOSED_EAR) / (OPEN_EAR - CLOSED_EAR))))


def slide_open(entry: dict | None) -> float | None:
    """How open the eyes on a slide are (its least open face), from its stored measurement; None when
    it has no faces that count, wasn't measured, or was measured by another model."""
    if not entry or entry.get("model") != MODEL_ID or not entry.get("ear"):
        return None
    return min(openness(e) for e in entry["ear"])


def crop_matrix(face) -> np.ndarray:
    """The 2 x 3 affine taking the picture to the model's 256 px crop around a YuNet face row (x, y,
    w, h, right eye x y, left eye x y, ...): centred on the box, CROP x its longer side, turned so
    the eyes are level."""
    x, y, w, h = (float(v) for v in face[:4])
    angle = math.atan2(float(face[7]) - float(face[5]), float(face[6]) - float(face[4]))
    cx, cy, k = x + w / 2, y + h / 2, max(w, h) * CROP / SIZE
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c / k, s / k, SIZE / 2 - (c * cx + s * cy) / k],
                     [-s / k, c / k, SIZE / 2 - (-s * cx + c * cy) / k]])


# --------------------------------------------------------------------------- the model


class Landmarker:
    """The ONNX face mesh: a 256 x 256 RGB crop (0..1) -> 478 points in crop pixels, presence."""

    def __init__(self, path: Path):
        import onnxruntime as ort

        self.path = path
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1  # a small model, next to the renders
        self.session = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name

    def run(self, crop: np.ndarray) -> tuple[np.ndarray, float]:
        out = self.session.run(None, {self.input: np.ascontiguousarray(crop, np.float32)[None]})
        pts = out[0].reshape(-1, 3)
        return pts, 0.5 * (1 + math.tanh(float(np.ravel(out[1])[0]) / 2))  # the sigmoid of the logit, never overflowing


_model: Landmarker | None = None
_model_lock = threading.Lock()


def backend():
    """The loaded landmark model (run(crop) -> (points, presence)), or None while it isn't downloaded.
    Tests replace this with a fake."""
    global _model
    if not model_ready():
        return None
    with _model_lock:
        path = model_dir() / MODEL_FILES[0][1]
        if _model is None or _model.path != path:
            _model = Landmarker(path)
        return _model


def prominent(faces, width: int) -> list:
    """Of YuNet's rows, the faces that count, largest first: confident, not tiny, at least PROMINENT
    of the largest one's width (people in the background don't decide), at most MAX_FACES."""
    ok = sorted((f for f in faces if f[14] >= MIN_SCORE and f[2] >= MIN_SIZE * width), key=lambda f: -float(f[2]))
    return [f for f in ok if f[2] >= PROMINENT * ok[0][2]][:MAX_FACES] if ok else []


def measure(rgb: np.ndarray, b=None) -> dict:
    """The eyes on an upright picture: {"model", "ear": [EAR of each face that counts, largest
    first]} ([] when there are none)."""
    import cv2

    b = b if b is not None else backend()
    out = []
    u8 = None
    for f in prominent(im.detect_faces(rgb), rgb.shape[1]):
        if u8 is None:
            u8 = (np.clip(rgb, 0, 1) * 255).astype(np.uint8)
        m = crop_matrix(f)
        crop = cv2.warpAffine(u8, m, (SIZE, SIZE), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        with _model_lock:
            pts, presence = b.run(crop.astype(np.float32) / 255)
        if presence < PRESENCE:
            continue
        out.append(round(face_ear(pts), 3))  # a ratio: the same in crop pixels as in the picture's
    return {"model": MODEL_ID, "ear": out}
