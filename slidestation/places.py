"""Places: where a slide was taken.

A slide's place is `g["place"] = {"name", "lat", "lon", "country"}` (plus "admin" and the GeoNames
"id" when it came from the gazetteer). It is typed with autocomplete from an offline gazetteer,
propagated along the tray like dates and tags, written into the export as EXIF GPS and sent to
Immich as latitude / longitude (`PUT /assets/{id}`, no re-upload).

- **Gazetteer:** GeoNames `cities15000` (every place with 15,000+ people, ~34k; CC BY 4.0) plus
  `countryInfo.txt` and `admin1CodesASCII.txt` for the country / region names, downloaded on first
  use into `~/.slidestation/data/geonames/`, never committed. Searched by name, ASCII name and the
  Latin-script alternate names ("Venezia", "München").
- **Suggestions** (through insights, never applied silently): text read from the photo (signs,
  "WELCOME TO …") matched against the gazetteer, by PaddleOCR's detector + Latin recogniser as ONNX
  on CPU (`~/.slidestation/models/ppocr/`); and tray neighbours: a slide between two slides with the same
  confirmed place is offered that place.
"""
from __future__ import annotations

import io
import math
import os
import re
import threading
import unicodedata
import zipfile
from bisect import bisect_left
from pathlib import Path

import numpy as np

from .store import data_dir as _data_root
from .store import library, models_dir

# ------------------------------------------------------------------------------------ a place


def clean_place(v) -> dict | None:
    """A slide's place as sent by the UI (or None / {} to clear it): name, lat, lon, country, plus
    admin and id when known. Coordinates are rounded to 5 decimals (about a metre). ValueError when
    it isn't one."""
    if not v:
        return None
    if not isinstance(v, dict):
        raise ValueError("A place is {name, lat, lon, country}")
    try:
        lat, lon = float(v["lat"]), float(v["lon"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("A place needs its latitude and longitude") from None
    if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Latitude goes from -90 to 90, longitude from -180 to 180")
    lat, lon = round(lat, 5), round(lon, 5)
    name = " ".join(str(v.get("name") or "").split())[:200] or coords_label(lat, lon)
    out = {"name": name, "lat": lat, "lon": lon, "country": " ".join(str(v.get("country") or "").split())[:100]}
    if v.get("admin"):
        out["admin"] = " ".join(str(v["admin"]).split())[:100]
    if v.get("id"):
        out["id"] = int(v["id"])
    return out


def coords_label(lat: float, lon: float) -> str:
    return f"{lat:.4f}, {lon:.4f}"


def label(p: dict) -> str:
    """How a place reads: "Venice, Italy" (the region only when the UI asks for it)."""
    return ", ".join(dict.fromkeys(x for x in (p.get("name"), p.get("country")) if x))  # not "Singapore, Singapore"


def same(a: dict | None, b: dict | None) -> bool:
    """The same place: same name and within ~100 m (typed twice, or from the gazetteer twice)."""
    if not a or not b:
        return False
    return (a.get("name") == b.get("name") and abs(a["lat"] - b["lat"]) < 1e-3
            and abs(a["lon"] - b["lon"]) < 1e-3)


def parse_coords(q: str) -> tuple[float, float] | None:
    """ "45.4371, 12.3326" (or with a space / semicolon) as (lat, lon); None if it isn't that."""
    m = re.fullmatch(r"\s*(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)\s*", q)
    if not m:
        return None
    lat, lon = float(m[1]), float(m[2])
    return (lat, lon) if -90 <= lat <= 90 and -180 <= lon <= 180 else None


def fold(s: str) -> str:
    """Search form of a name: accents off, lower case, anything but letters and digits a space."""
    s = unicodedata.normalize("NFKD", s.replace("ß", "ss").replace("ø", "o").replace("Ø", "o")
                              .replace("ł", "l").replace("Ł", "l").replace("đ", "d").replace("Đ", "d"))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return " ".join(re.sub(r"[^0-9a-z]+", " ", s).split())


# ------------------------------------------------------------------------------------ gazetteer

GEONAMES = "https://download.geonames.org/export/dump/"
GAZETTEER_FILES = ["cities15000.zip", "countryInfo.txt", "admin1CodesASCII.txt"]
GAZETTEER_MB = 4
MIN_ROWS = 100  # a GeoNames table has thousands (cities15000 ~34k, admin1 ~3.8k, countries ~250)


def data_dir() -> Path:
    return _data_root() / "geonames"


def gazetteer_ready() -> bool:
    return all((data_dir() / f).is_file() for f in GAZETTEER_FILES)


def _check_gazetteer_file(name: str, path: Path) -> None:
    """GeoNames rebuilds these files daily (no fixed checksum): check they are what they claim,
    tab-separated rows with enough columns."""
    if name.endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            text = z.read(name.replace(".zip", ".txt")).decode("utf-8")
        cols = 19
    else:
        text = path.read_text(encoding="utf-8")
        cols = 4
    rows = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    if len(rows) < MIN_ROWS or any(len(r.split("\t")) < cols for r in rows[:50]):
        raise ValueError("not a GeoNames table")


OFFLINE = ("Couldn't reach download.geonames.org to download the place names ({}). Check the internet "
           "connection and try again.")


def download_gazetteer(job) -> None:
    """Fetch the GeoNames files (a job). Each goes to a .part file, is checked,
    then moved into place, so a broken download is never used."""
    import httpx

    d = data_dir()
    d.mkdir(parents=True, exist_ok=True)
    job.total = GAZETTEER_MB
    job.message = "Downloading place names from GeoNames (MB)"
    done = 0
    try:
        with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30, read=60)) as client:
            for name in GAZETTEER_FILES:
                dest = d / name
                if dest.is_file():
                    continue
                part = d / (name + ".part")
                with client.stream("GET", GEONAMES + name) as r:
                    if r.status_code != 200:
                        raise RuntimeError(f"Downloading {name} failed: HTTP {r.status_code}")
                    with open(part, "wb") as f:
                        for chunk in r.iter_bytes(1 << 20):
                            f.write(chunk)
                            done += len(chunk)
                            job.done = min(job.total, round(done / 1e6))
                try:
                    _check_gazetteer_file(name, part)
                except (ValueError, zipfile.BadZipFile, KeyError, UnicodeDecodeError):
                    part.unlink(missing_ok=True)
                    raise RuntimeError(f"The downloaded {name} isn't a GeoNames file; try again.") from None
                os.replace(part, dest)
    except httpx.TransportError as e:
        raise RuntimeError(OFFLINE.format(e.__class__.__name__)) from None
    job.done = job.total
    job.message = "Place names ready"


class Gazetteer:
    """The cities of GeoNames' cities15000, searchable by any of their Latin-script names."""

    def __init__(self, d: Path):
        countries, admins = {}, {}
        for ln in (d / "countryInfo.txt").read_text(encoding="utf-8").splitlines():
            if ln and not ln.startswith("#"):
                f = ln.split("\t")
                countries[f[0]] = f[4]
        for ln in (d / "admin1CodesASCII.txt").read_text(encoding="utf-8").splitlines():
            f = ln.split("\t")
            if len(f) >= 2:
                admins[f[0]] = f[1]
        self.names, self.admin, self.country, self.pop = [], [], [], []
        self.ids, lat, lon = [], [], []
        keys: dict[str, set[int]] = {}
        primary: set[tuple[str, int]] = set()
        with zipfile.ZipFile(d / "cities15000.zip") as z:
            text = io.TextIOWrapper(z.open("cities15000.txt"), encoding="utf-8")
            for ln in text:
                f = ln.rstrip("\n").split("\t")
                if len(f) < 15:
                    continue
                i = len(self.names)
                self.ids.append(int(f[0]))
                self.names.append(f[1])
                lat.append(float(f[4]))
                lon.append(float(f[5]))
                self.country.append(countries.get(f[8], f[8]))
                self.admin.append(admins.get(f"{f[8]}.{f[10]}", ""))
                self.pop.append(int(f[14] or 0))
                for n in (f[1], f[2]):
                    k = fold(n)
                    if k:
                        keys.setdefault(k, set()).add(i)
                        primary.add((k, i))
                for n in f[3].split(","):
                    # alternate names: Latin script only, and not codes (IATA "VCE", "ALV")
                    if len(n) < 3 or (n.isupper() and len(n) <= 4) or not _latin(n):
                        continue
                    k = fold(n)
                    if k:
                        keys.setdefault(k, set()).add(i)
        self.lat = np.array(lat)
        self.lon = np.array(lon)
        self.primary = primary
        # a city's own name before an alternate one (GeoNames lists "Venice" among Dayton's names), then size
        self.exact = {k: sorted(v, key=lambda i: ((k, i) not in primary, -self.pop[i])) for k, v in keys.items()}
        self.sorted_keys = sorted(self.exact)

    def __len__(self) -> int:
        return len(self.names)

    def place(self, i: int) -> dict:
        p = {"name": self.names[i], "lat": round(float(self.lat[i]), 5), "lon": round(float(self.lon[i]), 5),
             "country": self.country[i], "id": self.ids[i]}
        if self.admin[i]:
            p["admin"] = self.admin[i]
        return p

    def search(self, q: str, limit: int = 8) -> list[dict]:
        """Places whose name starts with what was typed, best first: an exact name before a longer
        one, a city's own name before an alternate one, then the bigger city. "Venice, Italy" (or
        ", Veneto") narrows by country / region."""
        name, _, where = q.partition(",")
        key, where = fold(name), fold(where)
        if not key:
            return []
        hits: dict[int, tuple] = {}
        for k in self.sorted_keys[bisect_left(self.sorted_keys, key) : bisect_left(self.sorted_keys, key + "~")]:
            for i in self.exact[k]:
                if where and not (fold(self.country[i]).startswith(where) or fold(self.admin[i]).startswith(where)):
                    continue
                rank = (k != key, (k, i) not in self.primary, -self.pop[i])
                if i not in hits or rank < hits[i]:
                    hits[i] = rank
        best = sorted(hits, key=lambda i: hits[i])[:limit]
        return [self.place(i) for i in best]

    def nearest(self, lat: float, lon: float, within_km: float = 25) -> dict | None:
        """The closest city to a point, if one is within `within_km`."""
        la, lo = np.radians(self.lat), np.radians(self.lon)
        a = (np.sin((la - math.radians(lat)) / 2) ** 2
             + np.cos(la) * math.cos(math.radians(lat)) * np.sin((lo - math.radians(lon)) / 2) ** 2)
        km = 12742 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))
        i = int(np.argmin(km))
        return self.place(i) if km[i] <= within_km else None


def _latin(s: str) -> bool:
    return all(ord(c) < 0x250 or unicodedata.combining(c) or c in "ʼ’‘ " for c in s)


_gaz: tuple[float, Gazetteer] | None = None
_gaz_lock = threading.Lock()


def gazetteer() -> Gazetteer | None:
    """The loaded gazetteer (parsed once, ~1 s; again when the files change), or None while it
    isn't downloaded."""
    global _gaz
    if not gazetteer_ready():
        return None
    stamp = (data_dir() / "cities15000.zip").stat().st_mtime
    with _gaz_lock:
        if _gaz is None or _gaz[0] != stamp:
            _gaz = (stamp, Gazetteer(data_dir()))
        return _gaz[1]


def search(q: str, limit: int = 8) -> list[dict]:
    """What the place field offers for `q`: typed coordinates first (named after the nearest city
    when there is one), then gazetteer matches."""
    g = gazetteer()
    out = []
    ll = parse_coords(q)
    if ll:
        near = g.nearest(*ll) if g else None
        p = {"name": near["name"] if near else coords_label(*ll), "lat": round(ll[0], 5), "lon": round(ll[1], 5),
             "country": near["country"] if near else ""}
        if near and near.get("admin"):
            p["admin"] = near["admin"]
        out.append(p)
    if g and not ll:
        out += g.search(q, limit)
    return out


# ------------------------------------------------------------------------------------ OCR

OCR_ID = "ppocr-v5-latin"
_OCR_REPO = "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/"
# PP-OCRv3 mobile text detector + PP-OCRv5 Latin recogniser (Apache 2.0), as ONNX; checksums as in
# insights.MODEL_FILES (LFS sha256, small files by git blob sha1)
OCR_FILES = [
    ("detection/v3/det.onnx", "det.onnx", 2429873,
     "sha256:ee40e80071ba3a320d4efda75f3e22047a7d049e9bf7bcaaf9daea23fc21b935"),
    ("languages/latin/rec.onnx", "rec.onnx", 7862832,
     "sha256:614ffc2d6d3902d360fad7f1b0dd455ee45e877069d14c4e51a99dc4ef144409"),
    ("languages/latin/dict.txt", "dict.txt", 1634, "git:e2497aec268ef61cac813a7d34181fd960f8ded6"),
]
OCR_MB = round(sum(f[2] for f in OCR_FILES) / 1e6)


def ocr_dir() -> Path:
    return models_dir() / "ppocr"


def ocr_files_ready() -> bool:
    d = ocr_dir()
    return all((d / name).is_file() and (d / name).stat().st_size == size for _, name, size, _ in OCR_FILES)


def ocr_ready() -> bool:
    """Place suggestions from text need both the text reader and the place names."""
    return ocr_files_ready() and gazetteer_ready()


def download_ocr(job) -> None:
    """The text reader and, if missing, the place names (one job)."""
    from . import insights

    if not gazetteer_ready():
        download_gazetteer(job)
    job.done = 0
    insights.fetch_files(job, _OCR_REPO, OCR_FILES, ocr_dir(), "text reader")
    job.message = "Text reader ready: signs are read for place suggestions in the background"


DET_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
DET_STD = np.array([0.229, 0.224, 0.225], np.float32)
DET_SIDE = 960  # longest side the detector sees
DET_THRESH, BOX_THRESH, UNCLIP = 0.3, 0.6, 1.5  # PaddleOCR's DB post-processing defaults
REC_H = 48


class Ocr:
    """PaddleOCR in ~80 lines: DB text detection (probability map -> rotated boxes, grown by the
    unclip ratio) and CTC recognition of each box, on CPU."""

    def __init__(self, d: Path):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)
        self.det = ort.InferenceSession(str(d / "det.onnx"), opts, providers=["CPUExecutionProvider"])
        self.rec = ort.InferenceSession(str(d / "rec.onnx"), opts, providers=["CPUExecutionProvider"])
        # index 0 is CTC's blank; PaddleOCR appends the space
        self.chars = [""] + (d / "dict.txt").read_text(encoding="utf-8").split("\n")[:-1] + [" "]
        self.dir = d

    def boxes(self, rgb8: np.ndarray) -> list[np.ndarray]:
        """Text boxes as 4 corner points (tl, tr, br, bl) in the image's pixels."""
        import cv2

        h, w = rgb8.shape[:2]
        f = min(1.0, DET_SIDE / max(h, w))
        dh, dw = max(32, round(h * f / 32) * 32), max(32, round(w * f / 32) * 32)
        img = cv2.resize(rgb8, (dw, dh), interpolation=cv2.INTER_LINEAR)[:, :, ::-1]  # BGR, as Paddle reads it
        x = ((img.astype(np.float32) / 255 - DET_MEAN) / DET_STD).transpose(2, 0, 1)[None]
        pred = self.det.run(None, {self.det.get_inputs()[0].name: x})[0][0, 0]
        contours, _ = cv2.findContours((pred > DET_THRESH).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        out = []
        for c in contours[:1000]:
            (cx, cy), (bw, bh), ang = cv2.minAreaRect(c)
            if min(bw, bh) < 3:
                continue
            mask = np.zeros_like(pred, np.uint8)
            cv2.fillPoly(mask, [c.reshape(-1, 2)], 1)
            if pred[mask > 0].mean() < BOX_THRESH:
                continue
            grow = bw * bh * UNCLIP / (2 * (bw + bh))  # pyclipper's offset of a rectangle
            bw, bh = bw + 2 * grow, bh + 2 * grow
            if min(bw, bh) < 5:
                continue
            pts = cv2.boxPoints(((cx, cy), (bw, bh), ang)) * np.array([w / dw, h / dh], np.float32)
            out.append(_order(pts))
        return sorted(out, key=lambda p: (round(p[:, 1].mean() / 20), p[:, 0].min()))

    def recognise(self, crop: np.ndarray) -> tuple[str, float]:
        import cv2

        h, w = crop.shape[:2]
        rw = int(min(REC_H * 40, max(REC_H // 2, math.ceil(REC_H * w / h))))
        img = cv2.resize(crop, (rw, REC_H), interpolation=cv2.INTER_LINEAR)[:, :, ::-1]
        x = ((img.astype(np.float32) / 255 - 0.5) / 0.5).transpose(2, 0, 1)[None]
        p = self.rec.run(None, {self.rec.get_inputs()[0].name: x})[0][0]
        idx, conf = p.argmax(1), p.max(1)
        text, confs, prev = [], [], 0
        for i, c in zip(idx, conf):
            if i != prev and i != 0 and i < len(self.chars):
                text.append(self.chars[i])
                confs.append(c)
            prev = i
        return "".join(text).strip(), float(np.mean(confs)) if confs else 0.0

    def read(self, rgb8: np.ndarray) -> list[dict]:
        """Every line of text found: {"text", "confidence"}, top to bottom."""
        import cv2

        out = []
        for pts in self.boxes(rgb8):
            tw = int(max(np.linalg.norm(pts[0] - pts[1]), np.linalg.norm(pts[3] - pts[2])))
            th = int(max(np.linalg.norm(pts[0] - pts[3]), np.linalg.norm(pts[1] - pts[2])))
            if tw < 4 or th < 4:
                continue
            dst = np.array([[0, 0], [tw, 0], [tw, th], [0, th]], np.float32)
            crop = cv2.warpPerspective(rgb8, cv2.getPerspectiveTransform(pts, dst), (tw, th),
                                       borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
            if th / tw >= 1.5:  # vertical: read it turned
                crop = np.rot90(crop).copy()
            text, conf = self.recognise(crop)
            if text:
                out.append({"text": text, "confidence": round(conf, 3)})
        return out


def _order(pts: np.ndarray) -> np.ndarray:
    """Corners as top-left, top-right, bottom-right, bottom-left."""
    s, d = pts.sum(1), np.diff(pts, axis=1)[:, 0]
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], np.float32)


_ocr: Ocr | None = None
_ocr_lock = threading.Lock()


def ocr_backend():
    """The loaded text reader (`read(rgb8)`), or None while it isn't downloaded. Tests replace it."""
    global _ocr
    if not ocr_files_ready():
        return None
    with _ocr_lock:
        if _ocr is None or _ocr.dir != ocr_dir():
            _ocr = Ocr(ocr_dir())
        return _ocr


def read_text(rgb: np.ndarray) -> list[dict] | None:
    """The text in a photo (0..1 float RGB, upright), or None without the text reader."""
    o = ocr_backend()
    if o is None:
        return None
    return o.read((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8))


# ------------------------------------------------------------------------------------ text -> place

# words that introduce a place on a sign ("WELCOME TO", "BIENVENUE À", "WILLKOMMEN IN" …), folded
CUES = ["welcome to", "greetings from", "bienvenue a", "bienvenue au", "bienvenue en", "willkommen in",
        "benvenuti a", "benvenuti in", "benvenuto a", "bienvenidos a", "bienvenido a", "welkom in", "welkom te",
        "bem vindo a", "bem vindos a", "vitajte v", "witamy w", "velkommen til", "valkommen till", "gruss aus",
        "grusse aus", "souvenir de", "ricordo di", "recuerdo de", "greetings of"]
# common words on signs (and film boxes) that are also the name of some city somewhere: only with a cue
COMMON = set("""
bar nice split best deal mobile reading bath most sale open exit stop taxi bus hotel park post police bank
museum center centre city beach station opera parking central university college victoria orange paradise
hope independence union liberty concord hollywood harmony industry commerce enterprise progress victory
welcome eden mission bay port porto santa san saint st east west north south la le de del el los las
hall market gate bridge church castle lake mountain river valley view avenue street road place plaza
cafe restaurant bakery pizza shop store tourist information entrance ausgang eingang sortie entree
uscita entrata salida entrada zimmer frei rooms camping pension tabac apotheke pharmacie farmacia office
marina airport metro plage playa coca cola castello riviera kodak agfa fuji ilford ektachrome kodachrome
agfachrome sakura polaroid esso shell texaco total mobil garage auto sport grand royal palace imperial
metropol metropole europa bellevue belvedere panorama miramar splendid excelsior savoy ritz astoria
continental majestic ocean harbour harbor pier lido""".split())
# a place name right after these is a street, a hotel, a shop ("Via Roma", "Hotel Europa"), not where
# the photo was taken; and before these ("London Road", "Brussels Airlines", "Paris Match") too
NOT_AFTER = set("""via viale corso piazza piazzale largo vicolo rue avenue boulevard bd place quai chemin allee
calle avenida plaza paseo carrer rua strasse str gasse platz weg straat laan plein hotel albergo pension
gasthof gasthaus restaurant ristorante trattoria pizzeria cafe caffe bar brasserie hostal hostel
pensione""".split())
NOT_BEFORE = set("""road street st avenue ave lane way square station airlines airline airways air express
match hotel restaurant cafe bar strasse str gasse platz weg straat laan plein boulevard bd club fc
bank insurance""".split())
BIG = 100_000  # without a cue, a city's other names ("Wien", "Nizza") count only for cities this big
MIN_CONFIDENCE = 0.3  # below this a place read from text isn't suggested


def place_from_text(lines: list[dict], gaz: Gazetteer) -> dict | None:
    """The best place named in the text of a photo, as a suggestion: {"place", "confidence", "text"}.

    Every run of 1-3 words is looked up by its exact (folded) name. A name after a cue ("WELCOME TO")
    counts most. Without one it needs 4+ letters, not to be a common sign word (COMMON) nor part of a
    street / business name (NOT_AFTER, NOT_BEFORE), and to be a city's own name, or another name of a
    big city ("Wien"): GeoNames' alternate names of small places are full of words ("Coca", "Plage").
    Names shared by several cities go to the biggest one called that, scaled by its share of their
    population (Venice, Italy vs Venice, Florida). The confidence also carries the recogniser's own."""
    best = None
    texts = [(ln["text"], ln.get("confidence", 1.0)) for ln in lines]
    # a cue on one line and the name on the next ("WELCOME TO" / "VENICE"): read those together too
    texts += [(f"{a} {b}", min(ca, cb)) for (a, ca), (b, cb) in zip(texts, texts[1:])]
    for text, ocr_conf in texts:
        words = fold(text).split()
        spans = []
        for n in (3, 2, 1):
            for i in range(len(words) - n + 1):
                key = " ".join(words[i : i + n])
                ids = gaz.exact.get(key)
                if not ids or any(a <= i and i + n <= b for a, b in spans):  # inside a longer match
                    continue
                spans.append((i, i + n))
                before = " ".join(words[max(0, i - 3) : i])
                if any(before.endswith(c) for c in CUES):
                    base = 0.9
                else:
                    prev = words[i - 1] if i else ""
                    nxt = words[i + n] if i + n < len(words) else ""
                    if (len(key.replace(" ", "")) < 4 or key in COMMON or key.isdigit()
                            or prev in NOT_AFTER or nxt in NOT_BEFORE):
                        continue
                    ids = [j for j in ids if (key, j) in gaz.primary or gaz.pop[j] >= BIG]
                    if not ids:
                        continue
                    base = 0.6 if len(key) >= 6 else 0.45
                own = [j for j in ids if (key, j) in gaz.primary] or ids  # cities called that, before nicknames
                pops = [max(gaz.pop[j], 1) for j in own]
                share = pops[0] / sum(pops)
                conf = base * ocr_conf * (0.5 + 0.5 * share)
                if best is None or conf > best["confidence"]:
                    best = {"place": gaz.place(ids[0]), "confidence": round(conf, 3), "text": text}
    return best if best and best["confidence"] >= MIN_CONFIDENCE else None


# ------------------------------------------------------------------------------------ suggestions

TRAY_SOURCE = "tray"
TRAY_CONFIDENCE = 0.9


def suggestion(place: dict, confidence: float, source: str, text: str = "") -> dict:
    """A place suggestion in the insights shape: `value` is how it reads (what accept / dismiss
    name), `place` the place itself."""
    e = {"value": label(place), "place": place, "confidence": confidence, "source": source, "state": "suggested"}
    if text:
        e["text"] = text[:200]
    return e


def suggest_between(d: dict) -> int:
    """Tray neighbours: a slide between two slides with the same place (no other place in between)
    gets it suggested. Earlier tray suggestions that no longer hold are withdrawn; a dismissed one
    stays dismissed. Returns how many slides got a new suggestion."""
    groups = d["groups"]
    placed = [(i, g["place"]) for i, g in enumerate(groups) if g.get("place") and not g.get("skip")]
    want: dict[int, tuple[dict, str]] = {}
    for (i, p), (j, q) in zip(placed, placed[1:]):
        if j > i + 1 and same(p, q):
            for k in range(i + 1, j):
                want[k] = (p, f"slides {i + 1} and {j + 1}")
    n = 0
    for k, g in enumerate(groups):
        ins = g.get("insights") or {}
        e = ins.get("place")
        if k not in want or g.get("skip") or g.get("place"):
            if e and e.get("source") == TRAY_SOURCE and e.get("state") == "suggested":
                ins["place"] = None  # its neighbours changed
            continue
        p, why = want[k]
        if e and same(e.get("place"), p) and e.get("state") in ("dismissed", "accepted"):
            continue  # decided already
        if e and e.get("state") == "suggested" and e.get("source") != TRAY_SOURCE:
            continue  # the photo's own evidence (text) stays in front
        if e and e.get("source") == TRAY_SOURCE and same(e.get("place"), p) and e.get("state") == "suggested":
            continue
        g.setdefault("insights", {"key": "", "tags": []})["place"] = suggestion(p, TRAY_CONFIDENCE, TRAY_SOURCE, why)
        n += 1
    return n


def merge(old: dict | None, new: dict | None, own: dict | None) -> dict | None:
    """A fresh place suggestion merged with what was decided: a decision on the same place stands,
    an accepted place is never replaced, a slide with its own place gets nothing new (or the
    suggestion counts as accepted when it names that place)."""
    if new is None:
        return old
    if old and old.get("state") in ("accepted", "dismissed") and same(old.get("place"), new.get("place")):
        return {**new, "state": old["state"]}
    if own:
        return {**new, "state": "accepted"} if same(own, new.get("place")) else old
    if old and old.get("state") == "accepted":
        return old
    return new
