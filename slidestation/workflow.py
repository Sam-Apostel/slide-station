"""Import from the scanner, render previews/exports, upload to Immich, clean up the card."""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image

from . import imaging as im
from .imaging import Params
from . import learning
from .immich import Immich, ImmichError
from .store import (Session, active_scans, add_to_index, group_status, imported_index, load_config, lock,
                    meta_key, parse_date, render_key, sha1_file, slide_dates, slugify, statuses)

VOLUMES = Path(os.environ.get("SLIDESTATION_VOLUMES", "/Volumes"))
SCANNER_MODELS = {"RODFS50"}  # Kodak Slide N Scan
SCANNER_MAKES = {"GCMC"}
JPG = (".jpg", ".jpeg")

# --------------------------------------------------------------------------- job runner


class Job:
    def __init__(self, kind: str, session: str | None, total: int = 0):
        self.kind, self.session, self.total = kind, session, total
        self.done = 0
        self.message = ""
        self.error = ""
        self.finished = False
        self.started = time.time()

    def as_dict(self):
        return {k: getattr(self, k) for k in ("kind", "session", "total", "done", "message", "error", "finished", "started")}


current_job: Job | None = None
_job_lock = threading.Lock()


def start_job(kind: str, session: str | None, fn, *args) -> Job:
    global current_job
    with _job_lock:
        if current_job and not current_job.finished:
            raise RuntimeError(f"Busy with {current_job.kind} - wait for it to finish.")
        job = Job(kind, session)
        current_job = job

    def run():
        try:
            fn(job, *args)
        except Exception as e:  # surfaced in the UI
            import traceback

            traceback.print_exc()
            job.error = str(e) or e.__class__.__name__
        finally:
            job.finished = True

    threading.Thread(target=run, daemon=True).start()
    return job


# --------------------------------------------------------------------------- sources


def exif_info(path: str) -> dict:
    try:
        ex = Image.open(path).getexif()
        return {"make": str(ex.get(271, "")).strip(), "model": str(ex.get(272, "")).strip(), "datetime": str(ex.get(306, ""))}
    except Exception:
        return {"make": "", "model": "", "datetime": ""}


def list_jpegs(root: Path) -> list[Path]:
    out = []
    for dirpath, dirnames, files in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in files:
            if f.lower().endswith(JPG) and not f.startswith("._"):
                out.append(Path(dirpath) / f)
    return sorted(out)


def detect_sources() -> list[dict]:
    """Mounted volumes that look like a camera/scanner card (have a DCIM folder with JPEGs)."""
    found = []
    if not VOLUMES.exists():
        return found
    idx = imported_index()
    for vol in sorted(VOLUMES.iterdir()):
        dcim = vol / "DCIM"
        try:
            if not dcim.is_dir():
                continue
            files = list_jpegs(dcim)
        except OSError:
            continue
        if not files:
            found.append({"path": str(vol), "name": vol.name, "count": 0, "new": 0, "scanner": False, "removable": True})
            continue
        info = exif_info(str(files[0]))
        # "new" = not yet imported; identified by name+size+mtime fingerprint to stay fast
        fps = idx.get("_fp", {})
        new = 0
        for f in files:
            try:
                new += _quick_fp(f) not in fps
            except OSError:  # file vanished (e.g. during card cleanup)
                pass
        found.append({
            "path": str(vol), "name": vol.name, "count": len(files), "new": new,
            "scanner": info["model"] in SCANNER_MODELS or info["make"] in SCANNER_MAKES,
            "removable": True,
        })
    return found


def _quick_fp(p: Path) -> str:
    st = p.stat()
    return f"{p.name}:{st.st_size}:{int(st.st_mtime)}"


def eject(path: str) -> str:
    if sys.platform == "darwin":
        r = subprocess.run(["diskutil", "eject", path], capture_output=True, text=True)
        if r.returncode:
            raise RuntimeError(r.stderr.strip() or r.stdout.strip())
        return r.stdout.strip()
    raise RuntimeError("Eject is only supported on macOS.")


# --------------------------------------------------------------------------- import


def _taken(path: Path) -> str:
    dt = exif_info(str(path))["datetime"]
    return dt or datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y:%m:%d %H:%M:%S")


def import_scans(job: Job, sid: str, source: str) -> None:
    s = Session(sid)
    root = Path(source).expanduser()
    if not root.exists():
        raise RuntimeError(f"{root} does not exist")
    # only a card itself (a mounted volume with DCIM at its root) may ever be cleaned up afterwards;
    # folders - including ones on external drives - are never deleted from
    removable = root.parent == VOLUMES and (root / "DCIM").is_dir()
    files = list_jpegs(root / "DCIM" if (root / "DCIM").is_dir() else root)
    files.sort(key=lambda p: (_taken(p), p.name))
    idx = imported_index()
    job.total = len(files)
    job.message = f"Copying {len(files)} scans"
    new_ids, skipped, fp_index, sha_index, records = [], 0, {}, {}, {}
    for f in files:
        job.done += 1
        if _quick_fp(f) in idx.get("_fp", {}):
            skipped += 1
            continue
        sha = sha1_file(f)
        if sha in idx or sha in sha_index:
            skipped += 1
            fp_index[_quick_fp(f)] = sha
            continue
        scan_id = f"{f.stem}_{sha[:6]}"
        dest = s.originals / f"{scan_id}.jpg"
        shutil.copy2(f, dest)
        if sha1_file(dest) != sha:
            dest.unlink(missing_ok=True)
            raise RuntimeError(f"Copy of {f.name} did not verify - card or disk problem?")
        records[scan_id] = {
            "file": dest.name, "source": str(f), "source_root": str(root), "removable": removable,
            "size": f.stat().st_size, "sha1": sha, "taken": _taken(f), "source_deleted": False,
        }
        new_ids.append(scan_id)
        fp_index[_quick_fp(f)] = sha
        sha_index[sha] = sid
    s = update_session(sid, lambda fresh: fresh.data["scans"].update(records))
    fp = imported_index().get("_fp", {})
    fp.update(fp_index)
    sha_index["_fp"] = fp
    add_to_index(sha_index)  # recorded straight after copying, so a crash can't cause double imports

    job.message = "Analysing scans"
    job.done, job.total = 0, len(new_ids)
    sigs = {}
    for scan_id in new_ids:
        make_proxies(s, scan_id)
        sigs[scan_id] = np.load(s.cache / f"{scan_id}.sig.npy")
        job.done += 1

    # group, continuing the last group if the first new scan is another exposure of it
    last = s.data["groups"][-1] if s.data["groups"] else None
    prev = None
    if last and not last.get("immich") and new_ids:
        prev = [np.load(s.cache / f"{x}.sig.npy") for x in last["scans"]]
    idx_groups, continues = im.group_sequence([sigs[x] for x in new_ids], prev)
    job.message = "Blending brackets and guessing rotations"
    job.done, job.total = 0, len(idx_groups)
    for k, ig in enumerate(idx_groups):
        ids = [new_ids[i] for i in ig]
        extend = k == 0 and continues
        g = dict(last, scans=last["scans"] + ids) if extend else s.new_group(ids)
        # best of the bracket: leave out scans that are blurry (the slide moved or the focus
        # drifted) or almost entirely clipped; the user can put them back with 1-9
        auto_out = {}
        if len(g["scans"]) > 1 and not g.get("reviewed"):
            qual = [im.scan_quality(im.load_rgb(str(s.cache / f"{x}.proxy.jpg"))) for x in g["scans"]]
            auto_out = {g["scans"][i]: why for i, why in im.weak_scans(qual).items()}
            # scans the user put back after an earlier import left them out stay in
            manual_in = set(g.get("auto_excluded", {})) - set(g.get("excluded", []))
            g["excluded"] = sorted(set(g.get("excluded", [])) | (set(auto_out) - manual_in))
            g["auto_excluded"] = auto_out
        rot = None
        if not g["reviewed"] and g.get("rot_reason") != "manual":
            proxies = [im.load_rgb(str(s.cache / f"{x}.proxy.jpg")) for x in active_scans(g)]
            rot = im.suggest_rotation(proxies)
        fused = fused_proxy(s, g)  # pre-blend the brackets so browsing is instant
        feats = learning.features(fused, len(active_scans(g)))
        suggestion, neighbours = (None, 0)
        if load_config().get("learning_enabled", True):
            suggestion, neighbours = learning.model().suggest(feats)

        def commit(fresh: Session, g=g, ids=ids, extend=extend, rot=rot, feats=feats,
                   suggestion=suggestion, neighbours=neighbours):
            if extend:
                target = fresh.group(last["id"])
                target["scans"] += ids
                if "auto_excluded" in g:
                    target["excluded"], target["auto_excluded"] = g["excluded"], g["auto_excluded"]
            else:
                g["params"] = dict(fresh.data["defaults"])
                fresh.data["groups"].append(g)
                target = g
            if rot and target.get("rot_reason") != "manual":
                target["rotation"], target["rot_reason"] = rot
            target["feat"] = feats
            if suggestion and not target.get("reviewed") and target.get("params_source") != "manual":
                target["params"] = Params.from_dict({**target["params"], **suggestion}).to_dict()
                target["params_source"] = f"learned:{neighbours}"

        update_session(sid, commit)  # slides appear in the UI one by one
        job.done += 1
    update_session(sid, lambda fresh: fresh.log(f"Imported {len(new_ids)} scans from {root} ({skipped} already imported)"))
    job.message = f"Imported {len(new_ids)} scans into {len(idx_groups)} slides" + (
        f" ({skipped} were already imported)" if skipped else "")


def make_proxies(s: Session, scan_id: str) -> None:
    p = s.cache / f"{scan_id}.proxy.jpg"
    if not p.exists():
        a = im.load_rgb(str(s.original_path(scan_id)), im.PROXY_EDGE)
        p.write_bytes(im.to_jpeg_bytes(a, 92))
        (s.cache / f"{scan_id}.thumb.jpg").write_bytes(im.to_jpeg_bytes(a, 80, 240))
        np.save(s.cache / f"{scan_id}.sig.npy", im.signature(a))


# --------------------------------------------------------------------------- previews

_fused_cache: "OrderedDict[str, np.ndarray]" = OrderedDict()
_render_lock = threading.Lock()


def fused_proxy(s: Session, g: dict) -> np.ndarray:
    scans = active_scans(g)
    key = s.id + ":" + ",".join(scans)
    with _render_lock:
        if key in _fused_cache:
            _fused_cache.move_to_end(key)
            return _fused_cache[key]
    f = s.cache / ("fused_" + hashlib.sha1(key.encode()).hexdigest()[:12] + ".jpg")
    if f.exists():
        a = im.load_rgb(str(f))
    elif len(scans) == 1:
        make_proxies(s, scans[0])
        a = im.load_rgb(str(s.cache / f"{scans[0]}.proxy.jpg"))
    else:
        for x in scans:
            make_proxies(s, x)
        a = im.fuse([im.load_rgb(str(s.cache / f"{x}.proxy.jpg")) for x in scans])
        f.write_bytes(im.to_jpeg_bytes(a, 95))
    with _render_lock:
        _fused_cache[key] = a
        while len(_fused_cache) > 48:
            _fused_cache.popitem(last=False)
    return a


def preview(s: Session, gid: str, size: int, before: bool = False, uncropped: bool = False) -> bytes:
    g = s.group(gid)
    a = fused_proxy(s, g)
    if size <= 400:  # develop on a smaller image for thumbnails
        h, w = a.shape[:2]
        f = 480 / max(h, w)
        a = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).resize((int(w * f), int(h * f)), Image.BILINEAR)).astype(np.float32) / 255
    a = im.rotate_arr(a, g["rotation"])
    p = im.Params.from_dict(g["params"])
    # "before" is the untouched scan, but framed like the developed photo so the two line up
    a = im.before_view(a, p, crop=not uncropped) if before else im.develop(a, p, crop=not uncropped)
    return im.to_jpeg_bytes(a, 85, size)


def scan_thumb(s: Session, scan_id: str) -> bytes:
    p = s.cache / f"{scan_id}.thumb.jpg"
    if not p.exists():
        make_proxies(s, scan_id)
    return p.read_bytes()


# --------------------------------------------------------------------------- export + upload


def update_session(sid: str, fn) -> Session:
    """Apply fn(session) to a freshly loaded copy under the lock, then save.

    Long jobs never save a stale copy, so edits made in the UI meanwhile are kept."""
    with lock:
        s = Session(sid)
        fn(s)
        s.save()
        return s


def _photo_datetime(s: Session, g: dict, index: int) -> datetime:
    """The slide's own or estimated date (see store.slide_dates), one minute per slide to keep tray
    order; the scan's EXIF time when nothing is known."""
    est = slide_dates(s.data)[index]
    parsed = parse_date(est["value"])
    if parsed:
        return datetime.fromtimestamp(parsed[0].replace(hour=12).timestamp() + 60 * index)
    t = s.data["scans"][active_scans(g)[0]]["taken"]
    try:
        return datetime.strptime(t, "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return datetime.now()


def slide_meta(s: Session, g: dict, index: int) -> str:
    return meta_key(g, slide_dates(s.data)[index])


def export_key(s: Session, g: dict, index: int) -> str:
    return hashlib.sha1(f"{render_key(g)}|{slide_meta(s, g, index)}|{index}".encode()).hexdigest()[:12]


def export_fresh(s: Session, g: dict, index: int) -> bool:
    ex = g.get("export")
    return bool(ex and ex.get("ekey") == export_key(s, g, index) and (s.export_dir / ex["file"]).exists())


_export_lock = threading.Lock()


def originals_missing(s: Session, g: dict) -> bool:
    """With "keep originals" off they're deleted after upload: such a slide can still be previewed
    (from the cached proxies) but not rendered at full resolution again."""
    return any(not s.original_path(x).exists() for x in active_scans(g))


def render_export(sid: str, gid: str, quality: int) -> Path | None:
    """Render one slide at full resolution and record it. Returns None if the slide changed meanwhile."""
    s = Session(sid)
    g = s.group(gid)
    index = s.group_index(gid)
    if export_fresh(s, g, index):
        return s.export_dir / g["export"]["file"]
    rkey, ekey = render_key(g), export_key(s, g, index)
    scans = active_scans(g)
    with _export_lock:  # full-resolution blends take a few GB: never run two at once
        a = im.fuse([im.load_u8(str(s.original_path(x))) for x in scans])
        a = im.rotate_arr(a, g["rotation"])
        a = im.develop(a, im.Params.from_dict(g["params"]))
        out = Image.fromarray((a * 255 + 0.5).astype(np.uint8))
        del a
    exif = Image.open(s.original_path(scans[0])).getexif()
    exif[274] = 1  # orientation: pixels are already upright
    exif[305] = "Slide Station"
    if g.get("caption"):
        exif[270] = g["caption"]  # ImageDescription: Immich shows it as the photo's description
    when = _photo_datetime(s, g, index).strftime("%Y:%m:%d %H:%M:%S")
    exif[306] = when
    sub = exif.get_ifd(0x8769)
    sub[36867] = when  # DateTimeOriginal (what Immich uses for the timeline)
    sub[36868] = when
    name = f"{slugify(s.data['name'])}_{scans[0]}.jpg"
    s.export_dir.mkdir(exist_ok=True)
    tmp = s.export_dir / (name + ".part")
    out.save(tmp, "JPEG", quality=quality, exif=exif.tobytes(), subsampling=0)
    os.replace(tmp, s.export_dir / name)
    sha = sha1_file(s.export_dir / name)
    ok = []

    def commit(fresh: Session):
        try:
            fg = fresh.group(gid)
        except KeyError:
            return
        if render_key(fg) == rkey and export_key(fresh, fg, fresh.group_index(gid)) == ekey:
            fg["export"] = {"file": name, "key": rkey, "ekey": ekey, "sha1": sha}
            ok.append(1)

    update_session(sid, commit)
    return s.export_dir / name if ok else None


# background renderer: renders reviewed slides while you keep reviewing, so uploading is quick
active_session: str | None = None


def _background_renderer():
    while True:
        time.sleep(1.5)
        try:
            if not active_session or (current_job and not current_job.finished):
                continue
            s = Session(active_session)
            for i, g in enumerate(s.data["groups"]):
                if (g.get("reviewed") and not g.get("skip") and group_status(g) != "uploaded"
                        and not export_fresh(s, g, i) and not originals_missing(s, g)):
                    render_export(s.id, g["id"], int(load_config().get("jpeg_quality", 95)))
                    break
        except Exception as e:  # never let the helper thread die
            print("background render:", e)


threading.Thread(target=_background_renderer, daemon=True).start()


def finish_session(job: Job, sid: str, only_ready: bool = False) -> None:
    """Export every slide that is not skipped and upload new/changed ones to the session's Immich album.

    only_ready: just the slides marked developed; the others stay behind to keep working on."""
    cfg = load_config()
    s = Session(sid)
    redate = s.data.get("date_key") != s.data.get("date")  # date changed: every slide needs new EXIF
    st = dict(zip((g["id"] for g in s.data["groups"]), statuses(s.data)))
    todo = [g["id"] for g in s.data["groups"] if not g.get("skip") and (redate or st[g["id"]] != "uploaded")
            and (g.get("reviewed") or not only_ready)]
    lost = [g["id"] for g in s.data["groups"] if g["id"] in todo and originals_missing(s, g)]
    todo = [x for x in todo if x not in lost]  # nothing to render them from: keep what Immich has
    job.total = len(todo) * 2
    client = Immich(cfg["immich_url"], cfg["immich_key"])
    try:
        job.message = f"Connecting to Immich {client.version()}"
        album = client.find_or_create_album(s.data["album"] or s.data["name"])
        update_session(sid, lambda f: f.data.__setitem__("immich_album_id", album))
        to_trash, uploaded = [], 0
        for n, gid in enumerate(todo, 1):
            job.message = f"Rendering slide {n} of {len(todo)}"
            path = None
            for _ in range(3):  # re-render if the slide was edited while rendering
                path = render_export(sid, gid, int(cfg.get("jpeg_quality", 95)))
                if path:
                    break
            job.done += 1
            s = Session(sid)
            try:
                g = s.group(gid)
            except KeyError:  # merged away meanwhile
                job.done += 1
                continue
            if not path or g.get("skip") or (only_ready and not g.get("reviewed")):
                job.done += 1
                continue
            job.message = f"Uploading slide {n} of {len(todo)}"
            idx = s.group_index(gid)
            asset_id, status = client.upload(str(path), _photo_datetime(s, g, idx), f"{sid}-{gid}-{g['export']['sha1'][:8]}")
            client.add_to_album(album, [asset_id])
            rkey = g["export"]["key"]

            meta = slide_meta(s, g, idx)

            def commit(fresh: Session, asset_id=asset_id, status=status, rkey=rkey, meta=meta):
                fg = fresh.group(gid)
                old = (fg.get("immich") or {}).get("asset_id")
                if old and old != asset_id:
                    to_trash.append(old)
                fg["immich"] = {"asset_id": asset_id, "key": rkey, "status": status, "meta": meta}

            update_session(sid, commit)
            if not cfg.get("keep_exports", False):
                path.unlink(missing_ok=True)  # it's in Immich; can be re-rendered from the originals
            uploaded += 1
            job.done += 1

        def tidy(fresh: Session):
            # slides merged away or skipped after uploading: move their old Immich copies to the trash
            to_trash.extend(fresh.data.pop("orphan_assets", []))
            for g in fresh.data["groups"]:
                if g.get("skip") and g.get("immich"):
                    to_trash.append(g["immich"]["asset_id"])
                    g["immich"] = None
            if not only_ready or all(g.get("reviewed") or g.get("skip") for g in fresh.data["groups"]):
                fresh.data["date_key"] = fresh.data.get("date")  # every slide now carries the date
            fresh.log(f"Uploaded {uploaded} slides to album '{fresh.data['album']}'")

        update_session(sid, tidy)
        client.trash(to_trash)
        if not cfg.get("keep_originals", True):
            _drop_local_originals(Session(sid))
        job.message = f"Done - {uploaded} slides uploaded to '{s.data['album']}'" + (
            f"; {len(lost)} skipped: their original scans were deleted after the last upload" if lost else "")
    finally:
        client.close()


def _drop_local_originals(s: Session) -> None:
    if any(group_status(g) not in ("uploaded", "skipped") for g in s.data["groups"]):
        return
    for sc in s.data["scans"].values():
        (s.originals / sc["file"]).unlink(missing_ok=True)


# --------------------------------------------------------------------------- card cleanup


def cleanup_blockers(s: Session) -> list[str]:
    problems = []
    pending = [i + 1 for i, g in enumerate(s.data["groups"]) if group_status(g) not in ("uploaded", "skipped")]
    if pending:
        problems.append(f"{len(pending)} slide(s) not uploaded yet (e.g. #{pending[0]})")
    if not any(sc.get("removable") for sc in s.data["scans"].values()):
        problems.append("these scans were imported from a folder, not from a card")
    return problems


def cleanup_card(job: Job, sid: str) -> None:
    """Delete this session's scans from the card - only files that still match the verified local copy."""
    s = Session(sid)
    blockers = cleanup_blockers(s)
    if blockers:
        raise RuntimeError("Not cleaning the card: " + "; ".join(blockers))
    scans = [(k, v) for k, v in s.data["scans"].items() if v.get("removable") and not v.get("source_deleted")]
    job.total = len(scans)
    deleted = missing = mismatched = 0
    done_ids, missing_ids = [], []
    for k, sc in scans:
        job.done += 1
        src = Path(sc["source"])
        if not src.exists():
            missing += 1
            missing_ids.append(k)
            continue
        if src.stat().st_size != sc["size"] or sha1_file(src) != sc["sha1"]:
            mismatched += 1  # a different photo now has that name: leave it alone
            continue
        src.unlink()
        done_ids.append(k)
        deleted += 1

    def commit(fresh: Session):
        for k in done_ids + missing_ids:
            fresh.data["scans"][k]["source_deleted"] = True
        fresh.data["card_cleaned"] = mismatched == 0
        fresh.log(f"Card cleanup: deleted {deleted}, not found {missing}, left alone {mismatched}")

    update_session(sid, commit)
    job.message = f"Deleted {deleted} scans from the card" + (f", {missing} were already gone" if missing else "") + (
        f", left {mismatched} that didn't match" if mismatched else "")
