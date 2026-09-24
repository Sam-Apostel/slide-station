"""Folders of scans uploaded from the browser into the server (hosted container, ARCHITECTURE
"Hosted container"): the browser can't hand the server a path, so it sends the files.

An upload is a staging folder `<library>/uploads/<id>/` with the files at their relative paths and
`upload.json` = {"name", "created", "files": {path: {"size", "sha1"}}} of the ones that arrived
whole. Files come in chunks (`put`, at an offset, appended to `<path>.part`), so an interrupted
upload resumes where it stopped: `check` tells the browser which files are complete (or already
imported, by SHA-1) and where each partial one ends. A complete file is checked against its size and,
when the browser sent one, its SHA-1 before it counts. The folder is then imported like any folder
(workflow.import_upload) — never as a card, so nothing is ever deleted "from" it — and removed.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from .store import _atomic_write, imported_index, library, sha1_file

MAX_FILE = int(os.environ.get("SLIDESTATION_MAX_UPLOAD_MB", "300")) * 1_000_000
MAX_CHUNK = 64 * 1_000_000
ID_RE = re.compile(r"^[0-9a-f]{12}$")
_lock = threading.Lock()  # upload.json and the .part files
GB = 1_000_000_000
# Per library (= per account on a hosted server), 0 = no limit: the whole library (trays, originals,
# caches, exports, uploads waiting; not downloaded models or place names, which are the server's)
# and the uploads waiting to be imported. Checked when a folder is announced and on every chunk.
QUOTA_LIBRARY = int(float(os.environ.get("SLIDESTATION_QUOTA_LIBRARY_GB", "0")) * GB)
QUOTA_UPLOADS = int(float(os.environ.get("SLIDESTATION_QUOTA_UPLOADS_GB", "0")) * GB)
NOT_COUNTED = ("models", "data")  # library folders that don't count against its quota
USAGE_TTL = 60  # a folder's size is walked again after this many seconds (bytes written meanwhile are added)
_usage: dict[str, tuple[float, int]] = {}  # folder -> (when walked, bytes)
_usage_lock = threading.Lock()


class UploadError(ValueError):
    """A request the upload can't take (bad path, wrong offset, too big, didn't verify)."""

    def __init__(self, message: str, status: int = 400, **extra):
        super().__init__(message)
        self.status, self.extra = status, extra


def _root() -> Path:
    return library() / "uploads"


# --------------------------------------------------------------------------- quotas


def _walk(d: Path, skip: tuple[str, ...] = ()) -> int:
    n = 0
    try:
        with os.scandir(d) as it:
            for e in it:
                try:
                    if e.is_dir(follow_symlinks=False):
                        if e.name not in skip:
                            n += _walk(Path(e.path))
                    elif e.is_file(follow_symlinks=False):
                        n += e.stat(follow_symlinks=False).st_size
                except OSError:  # removed meanwhile
                    pass
    except OSError:
        pass
    return n


def _size(d: Path, skip: tuple[str, ...] = ()) -> int:
    """Bytes under a folder, walked at most every USAGE_TTL seconds (a library has ~10 files a slide)."""
    k = str(d)
    with _usage_lock:
        hit = _usage.get(k)
        if hit and time.time() - hit[0] < USAGE_TTL:
            return hit[1]
    n = _walk(d, skip)
    with _usage_lock:
        _usage[k] = (time.time(), n)
    return n


def _grew(n: int) -> None:
    """Bytes just written into this library's uploads: counted until the next walk."""
    with _usage_lock:
        for k in (str(library()), str(_root())):
            if k in _usage:
                t, b = _usage[k]
                _usage[k] = (t, b + n)


def forget_usage() -> None:
    """Walk again next time (after an import, a deleted upload)."""
    with _usage_lock:
        _usage.clear()


def usage() -> dict | None:
    """{"library": {"used", "limit"}, "uploads": {...}} in bytes for the caller's library, only the
    limits that are set; None without quotas."""
    out = {}
    if QUOTA_LIBRARY:
        out["library"] = {"used": _size(library(), NOT_COUNTED), "limit": QUOTA_LIBRARY}
    if QUOTA_UPLOADS:
        out["uploads"] = {"used": _size(_root()), "limit": QUOTA_UPLOADS}
    return out or None


def _gb(n: int) -> str:
    if n >= GB // 10:
        return f"{n / GB:.1f} GB"
    return f"{round(n / 1_000_000)} MB" if n >= 1_000_000 else f"{round(n / 1000)} KB"


def check_room(more: int) -> None:
    """Raises UploadError 413 (with "quota") when `more` bytes wouldn't fit the library's quotas."""
    if more <= 0 or not (QUOTA_LIBRARY or QUOTA_UPLOADS):
        return
    if QUOTA_UPLOADS:
        used = _size(_root())
        if used + more > QUOTA_UPLOADS:
            raise UploadError(
                f"Not enough room for uploads: this needs {_gb(more)} more, and uploads waiting to be imported may "
                f"take {_gb(QUOTA_UPLOADS)} in all ({_gb(used)} are there now). Import or remove the folders "
                f"uploaded before, or send a smaller part of this one.", 413, quota="uploads")
    if QUOTA_LIBRARY:
        used = _size(library(), NOT_COUNTED)
        if used + more > QUOTA_LIBRARY:
            raise UploadError(
                f"Your library is full: it holds {_gb(used)} of {_gb(QUOTA_LIBRARY)} and this needs {_gb(more)} "
                f"more. Turn off “Keep original scans after upload” in Settings (a slide uploaded to Immich "
                f"from then on lets go of its scans), or ask whoever runs this server for more room.", 413, quota="library")


def _dir(uid: str) -> Path:
    if not ID_RE.match(uid or "") or not (_root() / uid / "upload.json").is_file():
        raise UploadError("No such upload", 404)
    return _root() / uid


def _manifest(uid: str) -> dict:
    return json.loads((_dir(uid) / "upload.json").read_text())


def _exts() -> tuple[str, ...]:
    from . import workflow  # what counts as a scan (JPEG, and RAW when rawpy is there)

    return workflow.scan_exts()


def clean_path(path: str) -> str:
    """A file's path inside the upload, as the browser sent it: relative, no '..', no hidden parts,
    a scan's extension. Anything else is refused, so a path can never leave the staging folder."""
    p = str(path).replace("\\", "/")
    parts = [x for x in p.split("/") if x not in ("", ".")]
    if (not parts or p.startswith("/") or ":" in parts[0] or len(parts) > 16
            or any(x == ".." or x.startswith(".") or len(x) > 255 for x in parts)):
        raise UploadError(f"Not a usable file path: {path!r}")
    if not parts[-1].lower().endswith(_exts()):
        raise UploadError(f"Not a scan: {parts[-1]} (JPEG{' or camera RAW' if len(_exts()) > 2 else ''} files only)")
    return "/".join(parts)


def create(name: str) -> str:
    uid = uuid.uuid4().hex[:12]
    d = _root() / uid
    d.mkdir(parents=True)
    _atomic_write(d / "upload.json", {"name": (name or "").strip()[:120] or "Uploaded scans",
                                      "created": time.time(), "files": {}})
    return uid


def check(uid: str, files: list[dict]) -> dict:
    """For each {"path", "size", "sha1"?} the browser has: {"have": true} when it is here whole (or
    already imported into the library, by SHA-1), else {"offset": bytes of it here so far}."""
    d, m = _dir(uid), _manifest(uid)
    idx = imported_index()
    out = {}
    more = 0  # bytes still to come, for the quotas
    for f in files:
        rel = clean_path(f.get("path", ""))
        size, sha = int(f.get("size", -1)), str(f.get("sha1") or "").lower()
        rec = m["files"].get(rel)
        if rec and rec["size"] == size and (not sha or rec["sha1"] == sha):
            out[rel] = {"have": True}
        elif sha and sha in idx:
            out[rel] = {"have": True, "imported": True}
        else:
            part = d / (rel + ".part")
            out[rel] = {"offset": part.stat().st_size if part.is_file() else 0}
            more += max(0, size - out[rel]["offset"])
    check_room(more)  # say so before anything is sent, not halfway through
    return out


def put(uid: str, path: str, offset: int, size: int, sha1: str, data: bytes) -> dict:
    """Write one chunk of a file at `offset` (which must be where the file ends so far: 409 with the
    right offset otherwise, and the browser carries on from there). The chunk that completes the
    file (`size` bytes) verifies it and moves it into place. Answers {"offset", "done"}."""
    d = _dir(uid)
    rel = clean_path(path)
    if not 0 < size <= MAX_FILE:
        raise UploadError(f"{rel} is larger than {MAX_FILE // 1_000_000} MB (SLIDESTATION_MAX_UPLOAD_MB)", 413)
    if len(data) > MAX_CHUNK:
        raise UploadError("Chunk too large", 413)
    dest = d / rel
    part = d / (rel + ".part")
    with _lock:
        m = _manifest(uid)
        if rel in m["files"] and m["files"][rel]["size"] == size:
            return {"offset": size, "done": True}
        have = part.stat().st_size if part.is_file() else 0
        if offset != have:
            raise UploadError("Resume from the offset given", 409, offset=have)
        if have + len(data) > size:
            part.unlink(missing_ok=True)
            raise UploadError(f"{rel} is longer than announced", 400, offset=0)
        check_room(len(data))
        part.parent.mkdir(parents=True, exist_ok=True)
        with open(part, "ab") as fh:
            fh.write(data)
        _grew(len(data))
        have += len(data)
        if have < size:
            return {"offset": have, "done": False}
        got = sha1_file(part)
        if sha1 and got != sha1.lower():
            part.unlink(missing_ok=True)
            raise UploadError(f"{rel} arrived damaged (SHA-1 differs): send it again", 422, offset=0)
        os.replace(part, dest)
        m = _manifest(uid)  # re-read: other files of this upload arrive at the same time
        m["files"][rel] = {"size": size, "sha1": got}
        _atomic_write(d / "upload.json", m)
    return {"offset": size, "done": True}


def folder(uid: str) -> tuple[Path, str]:
    """(staging folder, name) of an upload, to import from."""
    return _dir(uid), _manifest(uid)["name"]


def delete(uid: str) -> None:
    shutil.rmtree(_dir(uid), ignore_errors=True)
    forget_usage()


def sources() -> list[dict]:
    """Uploads not imported yet, as import sources: `upload:<id>` (never removable)."""
    out = []
    root = _root()
    if not root.is_dir():
        return out
    for d in sorted(root.iterdir()):
        try:
            m = json.loads((d / "upload.json").read_text())
        except (OSError, ValueError):
            continue
        n = len(m.get("files", {}))
        out.append({"path": f"upload:{d.name}", "name": m.get("name", "Uploaded scans"), "count": n, "new": n,
                    "scanner": False, "removable": False, "upload": True})
    return out


def id_of(source: str) -> str | None:
    """The upload id in an `upload:<id>` source, else None."""
    return source[7:] if source.startswith("upload:") else None
