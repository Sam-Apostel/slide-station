"""Watched folders: an "external library" of scans dropped into a share (ROADMAP §4, ARCHITECTURE §4e
"Watched folders").

The user names folders to watch in Settings (config.json `watch`: [{"id", "path", "auto_upload",
"require_done"}]); every sub-folder that appears in one becomes a tray of its own, named after the
folder ("1978-08 Lake Garda" → tray and album "1978-08 Lake Garda", dated 1978-08). A background
thread polls (no inotify: shares mounted over SMB / NFS don't tell), and a sub-folder is *ready* once
its scans (names, sizes, times) haven't changed for `settle` seconds — and, for a folder that asks
for it, once a `.done` file is in it. It is then imported through the normal folder import as this
user's one job (a job already running: it waits for the next poll), optionally uploaded straight
after, and marked handled in the library's `watched.json`, keyed by the sub-folder's path — never by
writing into the share. Nothing in a watched folder is ever deleted or changed: the import only reads
(`label="watch:<name>"`, so the tray is never removable and card cleanup refuses it).

Crash safety: the record says "importing" with its tray before the first scan is copied, and
"imported" only after the import (and the upload, when asked) ended. A restart in between finds
"importing" and runs the import again into the same tray: the dedupe index skips every scan already
copied, so nothing is imported twice. A handled sub-folder whose scans change later (more added) is
imported again into its tray the same way.

Where folders may be: on the desktop anywhere; on a server with SLIDESTATION_WATCH_ROOT set, only
under that root (`{user}` in it becomes the account's Immich user id); in accounts mode without a
root, not at all — an account never names a path of the server's.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from . import accounts, store
from . import workflow as wf
from .store import Session, _atomic_write, as_home, library, load_config, save_config, user_home

MARKER = ".done"  # optional: the sub-folder is complete once this file is in it
RECHECK = 300  # seconds between looks at a sub-folder already imported (did more scans arrive?)
_lock = threading.RLock()  # watched.json
_tick_lock = threading.Lock()
# in memory, per library: sub-folder path -> (fingerprint, since when unchanged); what the last poll saw
_seen: dict[tuple[str, str], tuple[str, float]] = {}
_checked: dict[tuple[str, str], float] = {}
_summary: dict[str, dict] = {}
_loop_on = True  # the tests poll by hand (tick)
_started = False


class WatchError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def interval() -> float:
    return max(1.0, float(os.environ.get("SLIDESTATION_WATCH_INTERVAL", "10")))


def default_settle() -> float:
    return max(0.0, float(os.environ.get("SLIDESTATION_WATCH_SETTLE", "30")))


def root() -> Path | None:
    """The folder watched folders must be in (SLIDESTATION_WATCH_ROOT), or None: anywhere."""
    r = os.environ.get("SLIDESTATION_WATCH_ROOT", "").strip()
    if not r:
        return None
    h = user_home()
    return Path(r.replace("{user}", h.name if h is not None else "")).expanduser().resolve()


def available() -> bool:
    """Accounts never watch server paths unless the server set a root for them."""
    return not accounts.enabled() or bool(os.environ.get("SLIDESTATION_WATCH_ROOT", "").strip())


def _inside(p: Path, r: Path) -> bool:
    return p == r or r in p.parents


def check_path(path: str) -> Path:
    """The real folder `path` names, if this user may watch it (WatchError otherwise). Relative paths
    are relative to the root."""
    if not available():
        raise WatchError("This server doesn't watch folders (SLIDESTATION_WATCH_ROOT isn't set)", 403)
    path = (path or "").strip()
    if not path:
        raise WatchError("Name a folder to watch")
    r = root()
    p = Path(path).expanduser()
    if not p.is_absolute():
        if r is None:
            raise WatchError("Give the folder's full path")
        p = r / p
    real = p.resolve()
    if r is not None and not _inside(real, r):
        raise WatchError(f"Only folders in {r} can be watched on this server", 403)
    if not real.is_dir():
        raise WatchError(f"{real} is not a folder")
    lib = library().resolve()
    if _inside(real, lib) or _inside(lib, real):
        raise WatchError("The library itself can't be watched")
    return real


def date_from_name(name: str) -> str:
    """'1978-08 Lake Garda' -> '1978-08'; '1978 Summer' -> '1978'; '1978-08-14 x' -> '1978-08-14'."""
    m = re.match(r"\s*((?:18|19|20)\d\d)(?:[-._](\d{1,2})(?:[-._](\d{1,2}))?)?(?!\d)", name)
    if not m:
        return ""
    y, mo, d = int(m[1]), m[2] and int(m[2]), m[3] and int(m[3])
    try:
        datetime(y, mo or 1, d or 1)
    except ValueError:
        return f"{y}" if not (mo and 1 <= mo <= 12) else f"{y}-{mo:02d}"
    return f"{y}" + (f"-{mo:02d}" if mo else "") + (f"-{d:02d}" if d else "")


# --------------------------------------------------------------------------- the user's folders


def folders() -> list[dict]:
    return [dict(f) for f in load_config().get("watch") or []]


def _save_folders(fs: list[dict]) -> None:
    with store.lock:
        cfg = load_config()
        cfg["watch"] = fs
        save_config(cfg)


def add(path: str, auto_upload: bool = False, require_done: bool = False, settle: float | None = None) -> dict:
    real = check_path(path)
    fs = folders()
    if any(Path(f["path"]) == real for f in fs):
        raise WatchError("That folder is watched already")
    f = {"id": uuid.uuid4().hex[:8], "path": str(real), "auto_upload": bool(auto_upload),
         "require_done": bool(require_done)}
    if settle is not None:
        f["settle"] = max(0.0, float(settle))
    _save_folders(fs + [f])
    return f


def change(fid: str, body: dict) -> dict:
    fs = folders()
    f = next((x for x in fs if x["id"] == fid), None)
    if f is None:
        raise WatchError("No such watched folder", 404)
    for k in ("auto_upload", "require_done"):
        if k in body:
            f[k] = bool(body[k])
    if "settle" in body:
        try:
            f["settle"] = max(0.0, float(body["settle"]))
        except (TypeError, ValueError):
            raise WatchError("settle is a number of seconds")
    _save_folders(fs)
    return f


def remove(fid: str) -> None:
    """Stop watching (what was imported stays handled: adding it again doesn't import it again)."""
    fs = folders()
    if not any(f["id"] == fid for f in fs):
        raise WatchError("No such watched folder", 404)
    _save_folders([f for f in fs if f["id"] != fid])


# --------------------------------------------------------------------------- handled sub-folders


def _records_file() -> Path:
    return library() / "watched.json"


def records() -> dict:
    try:
        return json.loads(_records_file().read_text())
    except (OSError, ValueError):
        return {}


def _mark(key: str, **rec) -> None:
    with _lock:
        rs = records()
        rs[key] = {**rs.get(key, {}), **rec, "at": time.time()}
        _atomic_write(_records_file(), rs)


def retry(fid: str, name: str) -> None:
    """Forget a sub-folder's failed import, so the next poll tries it again."""
    f = next((x for x in folders() if x["id"] == fid), None)
    if f is None:
        raise WatchError("No such watched folder", 404)
    key = str(Path(f["path"]) / name)
    with _lock:
        rs = records()
        if rs.get(key, {}).get("state") == "error":
            rs[key]["state"], rs[key]["fp"] = "retry", ""
            _atomic_write(_records_file(), rs)


def fingerprint(sub: Path, r: Path | None) -> tuple[str, int]:
    """(hash of every scan's path, size and mtime, how many) of a sub-folder. Under a root, a scan
    that is a link out of it is refused: it would import a file the user has no business reading."""
    items = []
    for f in wf.list_scans(sub):
        if r is not None and not _inside(f.resolve(), r):
            raise WatchError(f"{f.name} links outside {r}")
        st = f.stat()
        items.append([f.relative_to(sub).as_posix(), st.st_size, st.st_mtime_ns])
    return hashlib.sha1(json.dumps(items).encode()).hexdigest()[:16], len(items)


def _subfolders(folder: Path) -> list[Path]:
    return sorted(d for d in folder.iterdir() if d.is_dir() and not d.name.startswith((".", "@", "#")))


# --------------------------------------------------------------------------- polling


def _homes() -> list[Path | None]:
    """Whose folders to poll: the single user, or every account that watches something (also
    after a restart, before anyone signs in)."""
    if not accounts.enabled():
        return [None]
    if not available():
        return []
    users = store.CONFIG_DIR / "users"
    out = []
    for d in sorted(users.iterdir()) if users.is_dir() else []:
        try:
            if json.loads((d / "config.json").read_text()).get("watch"):
                out.append(d)
        except (OSError, ValueError):
            continue
    return out


def tick(now: float | None = None) -> None:
    """One poll of every library's watched folders; starts at most one import per library."""
    now = time.time() if now is None else now
    with _tick_lock:
        for h in _homes():
            try:
                with as_home(h):
                    _tick_library(now)
            except Exception as e:  # never let the watcher die
                print("watched folders:", e)


def poll_mine() -> None:
    """One poll of the caller's own folders (after adding one: its state shows at once)."""
    with _tick_lock:
        _tick_library(time.time())


def _tick_library(now: float) -> None:
    k = str(user_home())
    fs = folders()
    rs = records()
    job = wf.job_now()
    busy = bool(job and not job.finished)
    running = getattr(job, "watching", None) if busy and job.kind == "watch" else None
    summary = {"folders": len(fs), "waiting": 0, "queued": 0, "importing": "", "imported": 0, "errors": 0}
    ready: list[tuple[dict, Path, str]] = []
    try:
        r = root()
    except OSError:
        r = None
    for f in fs:
        try:
            folder = check_path(f["path"])
            subs = _subfolders(folder)
        except (WatchError, OSError) as e:
            summary["errors"] += 1
            _seen[(k, "folder:" + f["id"])] = (str(e), now)
            continue
        _seen.pop((k, "folder:" + f["id"]), None)
        settle = float(f.get("settle", default_settle()))
        for sub in subs:
            key = str(sub)
            rec = rs.get(key, {})
            if key == running:
                summary["importing"] = sub.name
                continue
            if rec.get("state") == "imported" and now - _checked.get((k, key), 0) < RECHECK:
                summary["imported"] += 1
                continue
            try:
                if r is not None and not _inside(sub.resolve(), r):
                    raise WatchError(f"{sub.name} links outside {r}")
                fp, n = fingerprint(sub, r)
            except (WatchError, OSError) as e:
                _seen[(k, key)] = ("error:" + str(e), now)
                summary["errors"] += 1
                continue
            if rec.get("fp") == fp and rec.get("state") in ("imported", "error"):
                _checked[(k, key)] = now  # unchanged since: looked at again in RECHECK seconds
                _seen.pop((k, key), None)
                summary["imported" if rec["state"] == "imported" else "errors"] += 1
                continue
            seen = _seen.get((k, key))
            if not n or not seen or seen[0] != fp:
                _seen[(k, key)] = (fp, now)  # new, or still changing: the clock starts again
                summary["waiting"] += 1
                continue
            if now - seen[1] < settle or (f.get("require_done") and not (sub / MARKER).exists()):
                summary["waiting"] += 1
                continue
            ready.append((f, sub, fp))
    summary["queued"] = len(ready) - (0 if busy or not ready else 1)
    _summary[k] = summary
    if ready and not busy:
        f, sub, fp = ready[0]
        try:
            job = wf.start_job("watch", None, import_watched, f, str(sub), fp)
            job.watching = str(sub)  # type: ignore[attr-defined]
            summary["importing"] = sub.name
        except RuntimeError:  # a job started meanwhile: next time
            summary["queued"] += 1


def import_watched(job: wf.Job, folder: dict, sub: str, fp: str) -> None:
    """Import one ready sub-folder into its tray (a new one, or the one an earlier or interrupted
    import of it made), then upload it when the folder says so, and mark it handled."""
    job.watching = sub  # type: ignore[attr-defined]
    path = Path(sub)
    name = path.name
    rec = records().get(sub, {})
    sid = rec.get("tray")
    if not (sid and (library() / "sessions" / sid / "session.json").exists()):
        s = Session.create(name, name, date_from_name(name))
        sid, new = s.id, True
    else:
        new = False
    job.session = sid
    _mark(sub, state="importing", tray=sid, folder=folder["id"], name=name, fp=fp, error="", note="")
    job.message = f"Importing {name}"
    try:
        wf.import_scans(job, sid, sub, label=f"watch:{name}")
    except Exception as e:
        _mark(sub, state="error", error=str(e) or e.__class__.__name__)
        raise
    s = Session(sid)
    if new and not s.data["scans"]:  # everything in it was imported before (elsewhere): no empty tray
        shutil.rmtree(s.dir, ignore_errors=True)
        _mark(sub, state="imported", tray=None, slides=0, scans=0, note="already in the library")
        job.session = None
        job.message = f"{name}: every scan is in the library already"
        return
    slides, scans = len(s.data["groups"]), len(s.data["scans"])
    done = job.message
    if folder.get("auto_upload") and slides:
        try:
            wf.finish_session(job, sid)
        except Exception as e:
            _mark(sub, state="imported", slides=slides, scans=scans, upload_error=str(e) or "upload failed")
            raise
        done = f"{done}; uploaded"
    _mark(sub, state="imported", slides=slides, scans=scans, upload_error="")
    job.message = f"{name}: {done}"


def status() -> dict:
    """The user's watched folders and each sub-folder's state, for Settings (GET /api/watch)."""
    k = str(user_home())
    out = {"available": available(), "root": None, "settle": default_settle(), "interval": interval(),
           "folders": []}
    if not out["available"]:
        return out
    r = root()
    out["root"] = str(r) if r else None
    rs = records()
    job = wf.job_now()
    running = getattr(job, "watching", None) if job and not job.finished and job.kind == "watch" else None
    for f in folders():
        item = {**f, "error": "", "subfolders": []}
        err = _seen.get((k, "folder:" + f["id"]))
        if err:
            item["error"] = err[0]
        try:
            subs = _subfolders(Path(f["path"]))
        except OSError as e:
            item["error"] = item["error"] or str(e)
            subs = []
        for sub in subs:
            key = str(sub)
            rec = rs.get(key, {})
            seen = _seen.get((k, key))
            e = {"name": sub.name}
            if key == running:
                e["state"] = "importing"
                e["tray"] = rec.get("tray")
            elif seen and seen[0].startswith("error:"):
                e.update(state="error", error=seen[0][6:])
            elif rec.get("state") == "error" and (not seen or rec.get("fp") == seen[0]):
                e.update(state="error", error=rec.get("error", ""))
            elif rec.get("state") == "imported" and (not seen or rec.get("fp") == seen[0]):
                e.update(state="imported", tray=rec.get("tray"), slides=rec.get("slides", 0),
                         scans=rec.get("scans", 0))
                if rec.get("upload_error"):
                    e["error"] = rec["upload_error"]
                if rec.get("note"):
                    e["note"] = rec["note"]
            else:
                e["state"] = "waiting"
                if rec.get("state") == "importing":
                    e["note"] = "interrupted: imports again"
                elif f.get("require_done") and not (sub / MARKER).exists():
                    e["note"] = f"waiting for {MARKER}"
                elif seen and job and not job.finished:
                    e["note"] = "queued behind the current job"
            item["subfolders"].append(e)
        out["folders"].append(item)
    return out


def summary() -> dict | None:
    """What the activity well shows (from the last poll; /api/state is asked every second)."""
    s = _summary.get(str(user_home()))
    return s if s and s["folders"] else None


def _loop() -> None:
    while True:
        time.sleep(interval())
        if _loop_on:
            tick()


def start() -> None:
    """The polling thread (server.main)."""
    global _started
    if not _started:
        _started = True
        threading.Thread(target=_loop, daemon=True, name="watch").start()
