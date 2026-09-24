"""Persistent state: config, sessions (one per tray/box), scans and slide groups."""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from . import stats
from .imaging import Params

CONFIG_DIR = Path(os.environ.get("SLIDESTATION_HOME", Path.home() / ".slidestation"))
CONFIG_FILE = CONFIG_DIR / "config.json"

DEFAULT_CONFIG = {
    "library": str(Path.home() / "Pictures" / "Slide Station"),
    "immich_url": "",
    "immich_key": "",
    "keep_originals": True,
    "keep_exports": False,
    "learning_enabled": True,
    "jpeg_quality": 95,
    "stats_target": stats.DEFAULT_TARGET,  # slides to digitise in all, for the projected finish
}

lock = threading.RLock()


def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, path)


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_FILE.exists():
        cfg.update(json.loads(CONFIG_FILE.read_text()))
    return cfg


def save_config(cfg: dict) -> None:
    _atomic_write(CONFIG_FILE, cfg)
    try:
        os.chmod(CONFIG_FILE, 0o600)  # holds the Immich API key
    except OSError:
        pass


def library() -> Path:
    p = Path(load_config()["library"]).expanduser()
    (p / "sessions").mkdir(parents=True, exist_ok=True)
    return p


def sha1_file(path: str | Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def slugify(s: str) -> str:
    s = re.sub(r"[^\w\-]+", "-", s.strip().lower()).strip("-")
    return s or "session"


# --------------------------------------------------------------------------- imported index (dedupe)


def _index_file() -> Path:
    return library() / "imported.json"


def imported_index() -> dict:
    f = _index_file()
    return json.loads(f.read_text()) if f.exists() else {}


def add_to_index(entries: dict) -> None:
    with lock:
        idx = imported_index()
        idx.update(entries)
        _atomic_write(_index_file(), idx)


# --------------------------------------------------------------------------- presets


def _presets_file() -> Path:
    return library() / "presets.json"


def load_presets() -> list[dict]:
    """Named colour looks, library-wide: [{"name", "params", "created"}], in the order saved."""
    f = _presets_file()
    try:
        return json.loads(f.read_text()).get("presets", []) if f.exists() else []
    except (ValueError, AttributeError):
        return []


def save_presets(presets: list[dict]) -> None:
    with lock:
        _atomic_write(_presets_file(), {"presets": presets})


# --------------------------------------------------------------------------- sessions


class Session:
    """A batch of slides (typically a tray or box) that becomes one Immich album."""

    def __init__(self, sid: str):
        self.id = sid
        self.dir = library() / "sessions" / sid
        self.file = self.dir / "session.json"
        self.data = json.loads(self.file.read_text())

    # paths
    @property
    def originals(self) -> Path:
        return self.dir / "originals"

    @property
    def cache(self) -> Path:
        return self.dir / "cache"

    @property
    def export_dir(self) -> Path:
        return self.dir / "export"

    def original_path(self, scan_id: str) -> Path:
        return self.originals / self.data["scans"][scan_id]["file"]

    @classmethod
    def create(cls, name: str, album: str | None = None, date: str = "") -> "Session":
        sid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        d = library() / "sessions" / sid
        for sub in ("originals", "cache", "export"):
            (d / sub).mkdir(parents=True, exist_ok=True)
        data = {
            "id": sid,
            "name": name or "Untitled tray",
            "album": album if album is not None else (name or "Untitled tray"),
            "date": date,
            "created": time.time(),
            "defaults": Params().to_dict(),
            "scans": {},
            "groups": [],
            "log": [],
        }
        _atomic_write(d / "session.json", data)
        return cls(sid)

    _summaries: dict = {}

    @staticmethod
    def _scan_all() -> list[tuple]:
        """(mtime, summary, slide times) of every tray, re-reading only the trays that changed."""
        out = []
        for f in sorted((library() / "sessions").glob("*/session.json"), reverse=True):
            try:
                mt = f.stat().st_mtime_ns
                hit = Session._summaries.get(str(f))
                if not hit or hit[0] != mt:
                    d = json.loads(f.read_text())
                    hit = (mt, summary(d), stats.slide_times(d))
                    Session._summaries[str(f)] = hit
            except Exception:
                continue
            out.append(hit)
        return out

    @staticmethod
    def list_all() -> list[dict]:
        return [hit[1] for hit in Session._scan_all()]

    @staticmethod
    def library_stats(target: int) -> dict:
        """Progress across every tray (stats.library_stats)."""
        all_ = Session._scan_all()
        return stats.library_stats([h[1] for h in all_], [t for h in all_ for t in h[2]], target)

    def save(self) -> None:
        with lock:
            _atomic_write(self.file, self.data)

    def group(self, gid: str) -> dict:
        for g in self.data["groups"]:
            if g["id"] == gid:
                return g
        raise KeyError(gid)

    def group_index(self, gid: str) -> int:
        return [g["id"] for g in self.data["groups"]].index(gid)

    def new_group(self, scans: list[str], rotation: int = 0, rot_reason: str = "") -> dict:
        return {
            "id": uuid.uuid4().hex[:8],
            "scans": scans,
            "excluded": [],
            "rotation": rotation,
            "rot_reason": rot_reason,
            "params": dict(self.data["defaults"]),
            "reviewed": False,
            "skip": False,
            "export": None,  # {"file","sha1","key"}
            "immich": None,  # {"asset_id","key"}
        }

    def log(self, msg: str) -> None:
        self.data.setdefault("log", []).append([time.time(), msg])
        self.data["log"] = self.data["log"][-200:]


def active_scans(g: dict) -> list[str]:
    s = [x for x in g["scans"] if x not in g.get("excluded", [])]
    return s or g["scans"][:1]


NEUTRAL_EXTRAS = {"curves": {}, "angle": 0.0, "crop": None}


def render_key(g: dict) -> str:
    """Identifies the exact output of a group; changes whenever the result would change."""
    # settings still at their neutral value are left out, so slides uploaded before a setting
    # existed (curves, straighten, crop) don't become "changed"
    params = {k: v for k, v in g["params"].items() if not (k in NEUTRAL_EXTRAS and v == NEUTRAL_EXTRAS[k])}
    k = json.dumps([active_scans(g), g["rotation"], params], sort_keys=True)
    return hashlib.sha1(k.encode()).hexdigest()[:12]


def tone_key(g: dict) -> str:
    """Identifies the tone curve's input (what its histogram shows): scans, restore, trim, geometry."""
    p = g["params"]
    k = json.dumps([active_scans(g), g["rotation"], p.get("strength"), p.get("trim"), p.get("angle", 0.0),
                    p.get("crop")])
    return hashlib.sha1(k.encode()).hexdigest()[:12]


# --------------------------------------------------------------------------- dates


DATE_RE = re.compile(r"^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$")


def parse_date(v: str) -> tuple[datetime, int] | None:
    """'1978', '1978-06' or '1978-06-14' -> (start of that period, precision 1..3)."""
    m = DATE_RE.match((v or "").strip().replace("/", "-"))
    if not m:
        return None
    y, mo, d = int(m[1]), int(m[2] or 1), int(m[3] or 1)
    try:
        return datetime(y, max(1, min(12, mo)), max(1, min(31, d))), 1 + bool(m[2]) + bool(m[3])
    except ValueError:
        return None


def format_date(t: datetime, precision: int) -> str:
    return t.strftime(["%Y", "%Y-%m", "%Y-%m-%d"][precision - 1])


def slide_dates(d: dict) -> list[dict]:
    """The date each slide goes to Immich with, and where it came from.

    A slide's own date wins. Slides without one are estimated from the dated slides around them in
    tray order — a tray is one stretch of time, so slides between an August 1978 and a July 1979
    slide are interpolated between the two — then the tray's date, then (empty) the scan's EXIF."""
    groups = d["groups"]
    own = [parse_date(g.get("date", "")) for g in groups]
    dated = [i for i, x in enumerate(own) if x]
    tray = parse_date(d.get("date", ""))
    out = []
    for i, g in enumerate(groups):
        if own[i]:
            out.append({"value": format_date(*own[i]), "source": "own"})
            continue
        before = max((j for j in dated if j < i), default=None)
        after = min((j for j in dated if j > i), default=None)
        if before is not None and after is not None:
            (t0, p0), (t1, p1) = own[before], own[after]
            t = t0 + (t1 - t0) * ((i - before) / (after - before))
            out.append({"value": format_date(t, min(p0, p1)), "source": "between", "from": [before, after]})
        elif before is not None or after is not None:
            j = before if before is not None else after
            out.append({"value": format_date(*own[j]), "source": "near", "from": [j]})
        elif tray:
            out.append({"value": format_date(*tray), "source": "tray"})
        else:
            out.append({"value": "", "source": "scan"})
    return out


def meta_key(g: dict, date: dict) -> str:
    """What besides the pixels goes to Immich with a slide: its date and caption."""
    return hashlib.sha1(json.dumps([date.get("value", ""), g.get("caption", "")]).encode()).hexdigest()[:12]


def group_status(g: dict, meta: str | None = None) -> str:
    if g.get("skip"):
        return "skipped"
    im = g.get("immich")
    if im and g.get("locked"):
        return "uploaded"  # originals gone: Immich's copy is the final one
    if im and im.get("key") == render_key(g) and (meta is None or im.get("meta", meta) == meta):
        return "uploaded"
    if im:
        return "changed"
    return "reviewed" if g.get("reviewed") else "new"


def statuses(d: dict) -> list[str]:
    dates = slide_dates(d)
    return [group_status(g, meta_key(g, dt)) for g, dt in zip(d["groups"], dates)]


def summary(d: dict) -> dict:
    groups = d["groups"]
    st = statuses(d)
    return {
        "id": d["id"],
        "name": d["name"],
        "album": d["album"],
        "date": d.get("date", ""),
        "created": d["created"],
        "slides": len(groups),
        "scans": len(d["scans"]),
        "reviewed": sum(1 for g, s in zip(groups, st) if g.get("reviewed") or s in ("uploaded", "skipped")),
        "uploaded": st.count("uploaded"),
        "skipped": st.count("skipped"),
        "pending_upload": sum(1 for s in st if s in ("new", "reviewed", "changed")),
        # developed (marked ready) and not in Immich yet: what "upload the ready ones" sends
        "ready_upload": sum(1 for g, s in zip(groups, st) if g.get("reviewed") and s in ("reviewed", "changed")),
        "card_cleaned": d.get("card_cleaned", False),
        "sources": sorted({s.get("source_root", "") for s in d["scans"].values()}),
    }
