"""Persistent state: config, sessions (one per tray/box), scans and slide groups."""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

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
    def list_all() -> list[dict]:
        out = []
        for f in sorted((library() / "sessions").glob("*/session.json"), reverse=True):
            try:
                mt = f.stat().st_mtime_ns
                hit = Session._summaries.get(str(f))
                if not hit or hit[0] != mt:  # only re-read trays that changed
                    hit = (mt, summary(json.loads(f.read_text())))
                    Session._summaries[str(f)] = hit
            except Exception:
                continue
            out.append(hit[1])
        return out

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


def render_key(g: dict) -> str:
    """Identifies the exact output of a group; changes whenever the result would change."""
    # straight curves are left out, so slides uploaded before curves existed don't become "changed"
    params = {k: v for k, v in g["params"].items() if not (k == "curves" and not v)}
    k = json.dumps([active_scans(g), g["rotation"], params], sort_keys=True)
    return hashlib.sha1(k.encode()).hexdigest()[:12]


def tone_key(g: dict) -> str:
    """Identifies the tone curve's input (what its histogram shows): scans, auto restore, trim."""
    p = g["params"]
    k = json.dumps([active_scans(g), p.get("strength"), p.get("trim")])
    return hashlib.sha1(k.encode()).hexdigest()[:12]


def group_status(g: dict) -> str:
    if g.get("skip"):
        return "skipped"
    im = g.get("immich")
    if im and im.get("key") == render_key(g):
        return "uploaded"
    if im:
        return "changed"
    return "reviewed" if g.get("reviewed") else "new"


def summary(d: dict) -> dict:
    groups = d["groups"]
    st = [group_status(g) for g in groups]
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
