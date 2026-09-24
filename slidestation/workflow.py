"""Import from the scanner, render previews/exports, upload to Immich, clean up the card."""
from __future__ import annotations

import base64
import hashlib
import io
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
from . import people
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
    new_ids, skipped, restored, fp_index, sha_index, records = [], 0, 0, {}, {}, {}
    for f in files:
        job.done += 1
        # always by content: the quick fingerprint (name+size+mtime) only estimates "new" on the
        # card, and a different scan can share it (the scanner restarting its numbering)
        sha = sha1_file(f)
        if sha in idx or sha in sha_index:
            # already imported - but if this tray lost that original (deleted after upload), put
            # it back: that unlocks the slide for editing again
            for scan_id, rec in s.data["scans"].items():
                if rec.get("sha1") == sha and not s.original_path(scan_id).exists():
                    shutil.copy2(f, s.original_path(scan_id))
                    if sha1_file(s.original_path(scan_id)) != sha:
                        s.original_path(scan_id).unlink(missing_ok=True)
                        raise RuntimeError(f"Copy of {f.name} did not verify - card or disk problem?")
                    restored += 1
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
        mount = {**im.detect_mount(fused), "scans": active_scans(g)}
        suggestion, neighbours = (None, 0)
        if load_config().get("learning_enabled", True):
            suggestion, neighbours = learning.model().suggest(feats)

        def commit(fresh: Session, g=g, ids=ids, extend=extend, rot=rot, feats=feats, mount=mount,
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
            target["mount"] = mount
            if not extend and straighten_to_mount(target):
                target["params"]["angle"] = -mount["angle"]
            if suggestion and not target.get("reviewed") and target.get("params_source") != "manual":
                target["params"] = Params.from_dict({**target["params"], **suggestion}).to_dict()
                target["params_source"] = f"learned:{neighbours}"

        update_session(sid, commit)  # slides appear in the UI one by one
        if people_on():
            _faces_quietly(sid, last["id"] if extend else g["id"])
        job.done += 1
    update_session(sid, lambda fresh: fresh.log(f"Imported {len(new_ids)} scans from {root} ({skipped} already imported)"))
    if restored:
        update_session(sid, sync_locks)
    job.message = f"Imported {len(new_ids)} scans into {len(idx_groups)} slides" + (
        f" ({skipped} were already imported)" if skipped else "") + (
        f"; restored {restored} deleted originals, those slides can be edited again" if restored else "")


def straighten_to_mount(g: dict) -> bool:
    """A new slide is straightened to its mount by itself only when the mount is found with
    confidence and the slide isn't framed or developed yet; otherwise it stays a suggestion."""
    m = g.get("mount") or {}
    return (m.get("confidence", 0) >= im.MOUNT_AUTO and abs(m.get("angle", 0)) >= 0.1 and not g.get("reviewed")
            and not g["params"].get("angle") and not g["params"].get("crop"))


def mount_of(s: Session, g: dict) -> dict:
    """The slide's mount (imaging.detect_mount on the blended proxy), found now if the import
    didn't (trays from before mount detection) or the active scans changed since."""
    m = g.get("mount")
    if m and m.get("scans") == active_scans(g):
        return m
    return {**im.detect_mount(fused_proxy(s, g)), "scans": active_scans(g)}


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
    if g.get("locked") and not before and g.get("immich") and g["immich"].get("key") != render_key(g):
        shown = immich_preview(s, g)  # the local settings don't reproduce the upload: show Immich's
        if shown is not None:
            return im.to_jpeg_bytes(shown, 85, size)
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


def xmp_subjects(tags: list[str]) -> bytes:
    """An XMP packet with the slide's tags as dc:subject (keywords; Immich reads them as tags too)."""
    from xml.sax.saxutils import escape

    items = "".join(f"<rdf:li>{escape(t)}</rdf:li>" for t in tags)
    return ('<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>'
            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">'
            f"<dc:subject><rdf:Bag>{items}</rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>"
            '<?xpacket end="w"?>').encode("utf-8")


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
    else:
        exif.pop(270, None)  # a photo pulled in from Immich may carry its old description
    when = _photo_datetime(s, g, index).strftime("%Y:%m:%d %H:%M:%S")
    exif[306] = when
    sub = exif.get_ifd(0x8769)
    sub[36867] = when  # DateTimeOriginal (what Immich uses for the timeline)
    sub[36868] = when
    name = f"{slugify(s.data['name'])}_{scans[0]}.jpg"
    s.export_dir.mkdir(exist_ok=True)
    tmp = s.export_dir / (name + ".part")
    extra = {"xmp": xmp_subjects(g["tags"])} if g.get("tags") else {}  # Pillow >= 11 writes it
    out.save(tmp, "JPEG", quality=quality, exif=exif.tobytes(), subsampling=0, **extra)
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


# --------------------------------------------------------------------------- 1:1 zoom

TILE = 512  # zoom tiles are TILE x TILE pixels of the full-resolution render, on a fixed grid
_full: dict = {}  # {"key": (session, slide, render key), "img": uint8 H x W x 3}: one slide only
_full_lock = threading.Lock()


def full_image(s: Session, gid: str) -> np.ndarray:
    """The slide developed at full resolution, for 1:1 zoom (uint8, ~65 MB for 22 MP).

    Only the slide last zoomed into is kept. A finished export of the same render is decoded
    instead of fusing again; otherwise it renders like an export, under the same one-at-a-time
    lock (a 5-scan stack peaks around 3 GB). Raises FileNotFoundError when the originals are gone
    and there is no export to show."""
    g = s.group(gid)
    key = (s.id, gid, render_key(g))
    with _full_lock:  # concurrent tile requests wait for one render instead of starting their own
        if _full.get("key") == key:
            return _full["img"]
        _full.clear()  # free the previous slide before rendering this one
        ex = g.get("export")
        if ex and ex.get("key") == key[2] and (s.export_dir / ex["file"]).exists():
            a = im.load_u8(str(s.export_dir / ex["file"]))  # same pixels (the key covers the render)
        elif originals_missing(s, g):
            raise FileNotFoundError("The original scans were deleted after upload: no full resolution to zoom into.")
        else:
            with _export_lock:
                f = im.fuse([im.load_u8(str(s.original_path(x))) for x in active_scans(g)])
                f = im.develop(im.rotate_arr(f, g["rotation"]), im.Params.from_dict(g["params"]))
                a = (f * 255 + 0.5).astype(np.uint8)
                del f
        _full.update(key=key, img=a)
        return a


def full_tile(s: Session, gid: str, col: int, row: int) -> bytes:
    """One TILE x TILE piece (smaller at the right / bottom edge) of the full-resolution render."""
    a = full_image(s, gid)
    t = a[row * TILE:(row + 1) * TILE, col * TILE:(col + 1) * TILE]
    if col < 0 or row < 0 or not t.size:
        raise KeyError("tile")
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(t)).save(buf, "JPEG", quality=90)
    return buf.getvalue()


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
            else:  # nothing to render: catch up on faces (slides turned since, trays from before)
                if people_on():
                    todo = faces_pending([s.id])
                    if todo:
                        _faces_quietly(*todo[0])
        except Exception as e:  # never let the helper thread die
            print("background render:", e)


threading.Thread(target=_background_renderer, daemon=True).start()


def _immich_time(t: datetime) -> str:
    """A slide's date for `PUT /assets/{id}`: naive local time, like the EXIF the upload carries."""
    return t.strftime("%Y-%m-%dT%H:%M:%S")


def _pushed(s: Session, g: dict, index: int) -> dict:
    """What Immich was told about a slide besides its pixels: the day and the caption. Pulling edits
    back compares against this, so only what someone changed in Immich comes back."""
    return {"date": _photo_datetime(s, g, index).strftime("%Y-%m-%d"), "caption": g.get("caption", "")}


def _meta_only(g: dict) -> bool:
    """Immich already has this slide's pixels: only its date or caption can have changed. A locked
    slide's Immich copy is final, so it only ever gets its metadata updated."""
    im = g.get("immich")
    return bool(im) and (bool(g.get("locked")) or im.get("key") == render_key(g))


def _carry_over(client: Immich, asset_id: str | None) -> dict:
    """What a replacement keeps of the asset it replaces: its albums and whether it's a favourite
    (faces are Immich's own: it finds them again on the new photo)."""
    try:
        a = client.asset(asset_id) if asset_id else None
    except ImmichError as e:  # a key without asset.read: replace it as before, carrying nothing
        print("carry over:", e)
        a = None
    if a is None:  # nothing replaced, or deleted in Immich meanwhile
        return {"albums": [], "favorite": False}
    return {"albums": client.albums_of(asset_id), "favorite": bool(a.get("isFavorite"))}


def _originals_in_immich(client: Immich, s: Session, g: dict, when: datetime) -> tuple[dict, list[str]]:
    """Every scan of a slide in Immich, untouched: ({scan: asset}, the assets this uploaded). Scans
    Immich already has byte for byte are reused, not sent again - including a pulled-in photo's own
    asset; ones in its trash come back out."""
    scans = [x for x in g["scans"] if x in s.data["scans"]]
    have = client.existing({x: s.data["scans"][x]["sha1"] for x in scans})
    client.restore([h["asset_id"] for h in have.values() if h["trashed"]])
    out, created = {}, []
    for x in scans:
        if x in have:
            out[x] = have[x]["asset_id"]
            continue
        p = s.original_path(x)
        if not p.exists():  # deleted after an earlier upload ("keep originals" off)
            continue
        asset_id, status = client.upload(str(p), when, f"{s.id}-{x}")
        out[x] = asset_id
        if status != "duplicate":
            created.append(asset_id)
    return out, created
# --------------------------------------------------------------------------- people (faces)


def people_on() -> bool:
    """Recognising people is opt-in (Settings), and needs the face model downloaded."""
    return bool(load_config().get("people_enabled")) and people.model_ready()


def find_faces(sid: str, gid: str) -> bool:
    """Record one slide's faces, if they aren't up to date. Only faces.json is written, never the
    session: the slide is read fresh and the result is stored under the key it was found for."""
    s = Session(sid)
    try:
        g = s.group(gid)
    except KeyError:
        return False
    if not people.stale(g, people.load_faces(sid).get(gid)):
        return False
    people.record(sid, g, im.rotate_arr(fused_proxy(s, g), g["rotation"]))
    return True


def _faces_quietly(sid: str, gid: str) -> None:
    try:
        find_faces(sid, gid)
    except Exception as e:  # faces are extra: never let them fail an import
        print("faces:", e)


def faces_pending(sids: list[str] | None = None) -> list[tuple[str, str]]:
    """Slides (not skipped) whose faces are missing or were found before an edit (turned, scans
    changed). Forgets faces of slides that no longer exist (merged, split off and back)."""
    todo = []
    for sid in sids if sids is not None else [x["id"] for x in Session.list_all()]:
        try:
            s = Session(sid)
        except (FileNotFoundError, ValueError):
            continue
        faces = people.load_faces(sid)
        gids = {g["id"] for g in s.data["groups"]}
        if set(faces) - gids:
            people.update_faces(sid, lambda d: [d.pop(k) for k in list(d) if k not in gids])
        todo += [(sid, g["id"]) for g in s.data["groups"] if people.stale(g, faces.get(g["id"]))]
    return todo


def scan_people(job: Job) -> None:
    """Download the face model if needed, then find the faces on every slide in the library."""
    if not people.model_ready():
        def progress(done, total):
            job.done, job.total = done, total
            job.message = f"Downloading the face model ({done} of {total} MB)"

        progress(0, people.MODEL_MB)
        people.download_model(progress)
    todo = faces_pending()
    job.done, job.total = 0, len(todo)
    for sid, gid in todo:
        job.message = f"Finding faces: slide {job.done + 1} of {len(todo)}"
        _faces_quietly(sid, gid)
        job.done += 1
    d = people.refresh()
    named = sum(1 for p in d["people"].values() if p.get("name"))
    job.message = f"Looked for faces on {len(todo)} slides: {len(d['people'])} people ({named} named)"


def _tag_people(client: Immich, sid: str, slides: dict[str, str], names: dict) -> tuple[int, str]:
    """Named people as Immich tags (People/<name>) on uploaded slides. (assets tagged, problem)"""
    try:
        return people.tag_uploaded(client, slides, names, sid), ""
    except ImmichError as e:
        return 0, str(e)


def tag_people(job: Job) -> None:
    """Put the names of the people on every slide already in Immich as tags."""
    cfg = load_config()
    names = people.slide_names(people.refresh())
    client = Immich(cfg["immich_url"], cfg["immich_key"])
    try:
        job.message = f"Connecting to Immich {client.version()}"
        sids = sorted({sid for sid, _ in names})
        job.total, tagged = len(sids), 0
        for sid in sids:
            try:
                s = Session(sid)
            except FileNotFoundError:
                continue
            slides = {g["id"]: g["immich"]["asset_id"] for g in s.data["groups"] if g.get("immich") and not g.get("skip")}
            n, problem = _tag_people(client, sid, slides, names)
            if problem:
                raise RuntimeError(problem)
            tagged += n
            job.done += 1
        job.message = f"Tagged {tagged} slides in Immich with the people on them" if client.tags_supported is not False \
            else "This Immich server has no tags API: names were not sent"
    finally:
        client.close()


def finish_session(job: Job, sid: str, only_ready: bool = False) -> None:
    """Export every slide that is not skipped and upload new/changed ones to the session's Immich album.

    only_ready: just the slides marked developed; the others stay behind to keep working on.
    Slides whose pixels Immich already has only get their date / caption updated there."""
    cfg = load_config()
    s = Session(sid)
    redate = s.data.get("date_key") != s.data.get("date")  # tray date changed: every slide may have a new date
    st = dict(zip((g["id"] for g in s.data["groups"]), statuses(s.data)))
    todo = [g["id"] for g in s.data["groups"] if not g.get("skip") and (redate or st[g["id"]] != "uploaded")
            and (g.get("reviewed") or not only_ready)]
    meta_only = [g["id"] for g in s.data["groups"] if g["id"] in todo and _meta_only(g)]
    lost = [g["id"] for g in s.data["groups"] if g["id"] in todo and g["id"] not in meta_only
            and originals_missing(s, g)]
    todo = [x for x in todo if x not in lost and x not in meta_only]  # lost: nothing to render them from
    job.total = len(todo) * 2 + len(meta_only)
    client = Immich(cfg["immich_url"], cfg["immich_key"])
    want_originals = bool(cfg.get("upload_originals_stacked"))
    stacks: list[bool] = []  # asked once, and only if needed

    def has_stacks() -> bool:
        if not stacks:
            stacks.append(client.has_stacks())
        return stacks[0]

    try:
        job.message = f"Connecting to Immich {client.version()}"
        album = client.find_or_create_album(s.data["album"] or s.data["name"])
        update_session(sid, lambda f: f.data.__setitem__("immich_album_id", album))
        to_trash, uploaded, synced, duplicates, no_update = [], 0, 0, 0, False
        tagged: dict[str, list[str]] = {}  # tag -> asset ids to tag, uploaded or updated now
        sent: dict[str, str] = {}  # slide -> asset uploaded now, for the names of the people on it

        for n, gid in enumerate(meta_only, 1):
            job.message = f"Updating date and caption {n} of {len(meta_only)}"
            job.done += 1
            s = Session(sid)
            try:
                g = s.group(gid)
            except KeyError:
                continue
            idx = s.group_index(gid)
            meta, asset = slide_meta(s, g, idx), g["immich"]["asset_id"]
            if g["immich"].get("meta") == meta:
                continue  # only the tray date moved, and not this slide's
            try:
                client.update_asset(asset, dateTimeOriginal=_immich_time(_photo_datetime(s, g, idx)),
                                    description=g.get("caption", ""))
            except ImmichError as e:
                # a key without asset.update: upload it again with the new EXIF, as before
                print("metadata update:", e)
                if not g.get("locked") and not originals_missing(s, g):
                    todo.append(gid)
                    job.total += 2
                    no_update = True
                continue
            pushed = _pushed(s, g, idx)

            def commit_meta(fresh: Session, asset=asset, meta=meta, pushed=pushed):
                fg = fresh.group(gid)
                if (fg.get("immich") or {}).get("asset_id") == asset:
                    fg["immich"].update(meta=meta, pushed=pushed)

            update_session(sid, commit_meta)
            for t in g.get("tags") or []:  # tags are part of the meta key: a new tag comes this way too
                tagged.setdefault(t, []).append(asset)
            synced += 1

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
            when = _photo_datetime(s, g, idx)
            old = g.get("immich") or {}
            # the asset this one takes the place of: the slide's last upload, or the Immich photo it
            # was pulled in from
            replaces = old.get("asset_id") or (g.get("source_asset") or {}).get("id")
            carry = _carry_over(client, replaces)
            # exact duplicate: Immich has these very bytes already (an identical render), so use that
            hit = client.existing({"slide": g["export"]["sha1"]}).get("slide")
            if hit:
                asset_id, status = hit["asset_id"], "duplicate"
                if hit["trashed"]:
                    client.restore([asset_id])
                if carry["favorite"]:
                    client.update_asset(asset_id, isFavorite=True)
                duplicates += 1
            else:
                asset_id, status = client.upload(str(path), when, f"{sid}-{gid}-{g['export']['sha1'][:8]}",
                                                 favorite=carry["favorite"])
            client.add_to_album(album, [asset_id])
            for a in carry["albums"]:
                if a != album:
                    client.add_to_album(a, [asset_id])

            # Stacks: the untouched scans under the developed photo. A new upload replaces the whole
            # stack (the old one is dissolved, the scans are stacked again under the new photo), so
            # the scans Immich has stay stacked even once the setting is turned off.
            originals = {k: v for k, v in (old.get("originals") or {}).items() if k in g["scans"]}
            own = list(old.get("own_originals") or [])
            stack_id = None
            if (want_originals or originals or old.get("stack_id")) and has_stacks():
                if old.get("stack_id"):
                    client.delete_stack(old["stack_id"])
                if want_originals:
                    originals, created = _originals_in_immich(client, s, g, when)
                    own += created
                ids = [a for a in dict.fromkeys(originals.values()) if a != asset_id]
                stack_id = client.create_stack([asset_id] + ids)
            own = [a for a in dict.fromkeys(own) if a in originals.values()]
            kept = set(originals.values()) if stack_id else set()
            if replaces and replaces != asset_id:
                if replaces in kept:
                    # a pulled-in photo is itself the untouched scan: it stays, stacked under the new
                    # one, and leaves the albums the new one took its place in
                    for a in carry["albums"] + [album]:
                        try:
                            client.remove_from_album(a, [replaces])
                        except ImmichError as e:  # albumAsset.delete missing: it just stays there too
                            print("remove from album:", e)
                else:
                    to_trash.append(replaces)
            # "at": when it went up, for the stats (slides uploaded without being developed)
            rec = {"asset_id": asset_id, "key": g["export"]["key"], "status": status, "meta": slide_meta(s, g, idx),
                   "pushed": _pushed(s, g, idx), "at": time.time()}
            if originals and stack_id:
                rec.update(originals=originals, own_originals=own, stack_id=stack_id)

            def commit(fresh: Session, rec=rec):
                fresh.group(gid)["immich"] = rec

            update_session(sid, commit)
            for t in g.get("tags", []):
                tagged.setdefault(t, []).append(asset_id)
            sent[gid] = asset_id
            if not cfg.get("keep_exports", False):
                path.unlink(missing_ok=True)  # it's in Immich; can be re-rendered from the originals
            uploaded += 1
            job.done += 1

        stacks_gone: list[str] = []

        def tidy(fresh: Session):
            # slides merged away or skipped after uploading: move their old Immich copies to the trash
            to_trash.extend(fresh.data.pop("orphan_assets", []))
            stacks_gone.extend(fresh.data.pop("orphan_stacks", []))
            used = {a for g in fresh.data["groups"] if not g.get("skip")
                    for a in ((g.get("immich") or {}).get("originals") or {}).values()}
            for g in fresh.data["groups"]:
                if g.get("skip") and g.get("immich"):
                    to_trash.append(g["immich"]["asset_id"])
                    if g["immich"].get("stack_id"):
                        stacks_gone.append(g["immich"]["stack_id"])
                    # the scans this uploaded for it go too, unless another slide stacks them
                    to_trash.extend(a for a in g["immich"].get("own_originals", []) if a not in used)
                    g["immich"] = None
            if not only_ready or all(g.get("reviewed") or g.get("skip") for g in fresh.data["groups"]):
                fresh.data["date_key"] = fresh.data.get("date")  # every slide now carries the date
            fresh.log(f"Uploaded {uploaded} slides to album '{fresh.data['album']}'"
                      + (f", updated {synced} in place" if synced else ""))

        update_session(sid, tidy)
        for x in stacks_gone:
            client.delete_stack(x)
        client.trash(to_trash)
        tag_note = ""
        if tagged:
            job.message = "Tagging in Immich"
            try:
                client.tag_each(tagged)
            except ImmichError as e:  # an older Immich or a key without tag permissions: the upload stands
                print("immich tags:", e)
                tag_note = f"; tags not sent ({e})"
        people_tagged, problem = 0, ""
        if cfg.get("people_enabled") and sent:  # named people go along as tags (People/<name>)
            people_tagged, problem = _tag_people(client, sid, sent, people.slide_names(people.refresh()))
        look_note = ""
        if cfg.get("lookalike_enabled") and sent:  # photos in Immich that look like what just went up
            look_note = _lookalikes_quietly(client, sid, list(sent), job)
        if not cfg.get("keep_originals", True):
            _drop_local_originals(Session(sid))
        job.message = f"Done - {uploaded} slides uploaded to '{s.data['album']}'" + (
            f"; {synced} updated in place (date, caption)" if synced else "") + (
            "; dates / captions went up as new copies: give the API key asset.update to change them in place"
            if no_update else "") + (
            f"; {duplicates} were in Immich already, not sent again" if duplicates else "") + (
            "; original scans not stacked: this Immich has no stacks, or the API key lacks stack.read / "
            "stack.create" if want_originals and uploaded and stacks and not stacks[0] else "") + (
            f"; {len(lost)} skipped: their original scans were deleted after the last upload" if lost else "") + tag_note + (
            f"; {people_tagged} tagged with the people on them" if people_tagged else "") + (
            f"; names not sent: {problem}" if problem else "") + look_note
    finally:
        client.close()


def _slides(n: int) -> str:
    return f"{n} slide{'' if n == 1 else 's'}"


def _lookalike_note(n: dict) -> str:
    return ((f"; {_slides(n['found'])} may already be in Immich (see Insights)" if n["found"] else "")
            + (f"; {_slides(n['pending'])} to check for look-alikes once Immich has indexed them"
               if n["pending"] else ""))


def _lookalikes_quietly(client: Immich, sid: str, gids: list[str], job: Job) -> str:
    """The look-alike check after an upload: best effort, never fails the upload."""
    from . import insights, similar

    b = insights.backend()
    if b is None:
        return "; look-alikes not checked: the tag model isn't downloaded"
    try:
        return _lookalike_note(similar.check_lookalikes(client, sid, gids, b, job))
    except Exception as e:  # the upload stands whatever happens here
        print("look-alikes:", e)
        return f"; look-alikes not checked ({e})"


def check_lookalikes(job: Job, sid: str, everything: bool = False) -> None:
    """A job: look for photos in Immich like this tray's uploaded slides - those not checked yet or
    that Immich hadn't indexed at the last check (`everything`: all of them again)."""
    from . import insights, similar

    cfg = load_config()
    s = Session(sid)
    gids = [g["id"] for g in s.data["groups"] if not g.get("skip") and (g.get("immich") or {}).get("asset_id")
            and (everything or (similar.lookalike_view(g) or {}).get("state") in (None, "pending"))]
    job.total = len(gids)
    client = Immich(cfg["immich_url"], cfg["immich_key"])
    try:
        n = similar.check_lookalikes(client, sid, gids, insights.backend(), job)
    finally:
        client.close()
    job.done = job.total
    job.message = f"Checked {_slides(n['checked'])} for look-alikes in Immich" + _lookalike_note(n)


def _drop_local_originals(s: Session) -> None:
    if any(group_status(g) not in ("uploaded", "skipped") for g in s.data["groups"]):
        return
    for sc in s.data["scans"].values():
        (s.originals / sc["file"]).unlink(missing_ok=True)
    update_session(s.id, sync_locks)


def sync_locks(s: Session) -> bool:
    """Lock slides whose original scans are gone (they can't be rendered again, so not edited), and
    unlock them once the originals are back. Returns whether anything changed."""
    changed = False
    for g in s.data["groups"]:
        missing = originals_missing(s, g)
        if missing and not g.get("locked"):
            g["locked"] = "originals"
            changed = True
        elif not missing and g.get("locked"):
            g.pop("locked")
            changed = True
    return changed


_immich_failed: dict[str, float] = {}


def immich_preview(s: Session, g: dict) -> np.ndarray | None:
    """What Immich actually has for a slide, cached; None if it can't be fetched (then the local
    render stands in). Used for locked slides whose settings no longer reproduce the upload."""
    asset = (g.get("immich") or {}).get("asset_id")
    if not asset or time.time() - _immich_failed.get(asset, 0) < 300:
        return None
    f = s.cache / f"immich_{asset}.jpg"
    if not f.exists():
        cfg = load_config()
        try:
            client = Immich(cfg.get("immich_url", ""), cfg.get("immich_key", ""))
            try:
                f.write_bytes(client.preview(asset))
            finally:
                client.close()
        except Exception as e:
            print("immich preview:", e)
            _immich_failed[asset] = time.time()
            return None
    return im.load_rgb(str(f))


# --------------------------------------------------------------------------- round trip: back from Immich

PULLABLE = ("image/jpeg", "image/png")
_ORIENTATION = {3: 180, 6: 90, 8: 270}  # EXIF orientation -> clockwise turn (mirrored ones are left alone)


def _exif_time(local: str) -> str:
    """Immich's localDateTime ("1978-08-01T12:00:00.000Z", the wall clock) as a scan's EXIF-style time."""
    try:
        return datetime.strptime(local[:19], "%Y-%m-%dT%H:%M:%S").strftime("%Y:%m:%d %H:%M:%S")
    except ValueError:
        return ""


def pull_in(job: Job, sid: str, asset_ids: list[str]) -> None:
    """Import photos from Immich into a tray as scans, one slide each, to develop them again.

    The originals are downloaded byte for byte (checked against Immich's SHA-1), the slide starts
    with the photo's date and description, and remembers where it came from: its upload replaces
    that asset (see finish_session). These scans never came from a card, so they are never removable."""
    cfg = load_config()
    s = Session(sid)
    have = {sc.get("immich_asset") for sc in s.data["scans"].values()}
    client = Immich(cfg["immich_url"], cfg["immich_key"])
    job.total = len(asset_ids)
    job.message = f"Downloading {len(asset_ids)} photos from Immich"
    new, records, skipped, unusable = [], {}, 0, 0
    try:
        for aid in asset_ids:
            job.done += 1
            if aid in have:
                skipped += 1
                continue
            a = client.asset(aid)
            name = (a or {}).get("originalFileName") or aid
            mime = (a or {}).get("originalMimeType") or ("image/png" if name.lower().endswith(".png") else "image/jpeg")
            if not a or a.get("type") != "IMAGE" or a.get("isTrashed") or mime not in PULLABLE:
                unusable += 1  # videos, RAW / HEIC, or gone
                continue
            scan_id = f"{slugify(Path(name).stem)[:40]}_{aid.replace('-', '')[:6]}"
            dest = s.originals / f"{scan_id}.jpg"
            client.download(aid, str(dest))
            sha = sha1_file(dest)
            try:
                expected = base64.b64decode(a.get("checksum") or "").hex()
            except ValueError:
                expected = ""
            if len(expected) == 40 and expected != sha:
                dest.unlink(missing_ok=True)
                raise RuntimeError(f"The download of {name} did not verify - try again")
            try:
                rotation = _ORIENTATION.get(int(Image.open(dest).getexif().get(274, 1)), 0)
            except Exception:
                rotation = 0
            local = a.get("localDateTime") or ""
            records[scan_id] = {
                "file": dest.name, "source": f"immich:{aid}", "source_root": "immich", "removable": False,
                "size": dest.stat().st_size, "sha1": sha, "taken": _exif_time(local) or _taken(dest),
                "source_deleted": False, "immich_asset": aid,
            }
            day = local[:10] if parse_date(local[:10]) else ""
            caption = ((a.get("exifInfo") or {}).get("description") or "").strip()[:2000]
            new.append((scan_id, aid, rotation, day, caption))
            have.add(aid)
        s = update_session(sid, lambda fresh: fresh.data["scans"].update(records))

        job.message = "Analysing photos"
        job.done, job.total = 0, len(new)
        for scan_id, aid, rotation, day, caption in new:
            make_proxies(s, scan_id)
            g = s.new_group([scan_id], rotation, "exif" if rotation else "")
            g.update(date=day, caption=caption, source_asset={"id": aid})
            feats = learning.features(fused_proxy(s, g), 1)
            suggestion, neighbours = (None, 0)
            if cfg.get("learning_enabled", True):
                suggestion, neighbours = learning.model().suggest(feats)

            def commit(fresh: Session, g=g, feats=feats, suggestion=suggestion, neighbours=neighbours):
                g["params"] = dict(fresh.data["defaults"])
                g["feat"] = feats
                if suggestion:
                    g["params"] = Params.from_dict({**g["params"], **suggestion}).to_dict()
                    g["params_source"] = f"learned:{neighbours}"
                fresh.data["groups"].append(g)

            update_session(sid, commit)  # slides appear in the UI one by one
            job.done += 1
        update_session(sid, lambda fresh: fresh.log(f"Pulled in {len(new)} photos from Immich"))
    finally:
        client.close()
    job.message = f"Pulled in {len(new)} photos from Immich" + (
        f" ({skipped} were in this tray already)" if skipped else "") + (
        f"; left out {unusable} that aren't JPEG or PNG photos" if unusable else "")


def pull_metadata(sid: str) -> dict:
    """Bring edits made in Immich back: each uploaded slide's description and date, where they
    differ from what this app last sent (so only what someone changed in Immich comes back).
    Immich wins over an unsent local edit of the same field."""
    cfg = load_config()
    s = Session(sid)
    client = Immich(cfg["immich_url"], cfg["immich_key"])
    try:
        found = {g["id"]: client.asset(g["immich"]["asset_id"]) for g in s.data["groups"] if g.get("immich")}
    finally:
        client.close()
    out = {"checked": len(found), "captions": 0, "dates": 0, "gone": 0}

    def commit(fresh: Session):
        touched = []
        for i, g in enumerate(fresh.data["groups"]):
            if g["id"] not in found or not g.get("immich"):
                continue
            a = found[g["id"]]
            if a is None or a.get("isTrashed"):
                out["gone"] += 1
                continue
            if a.get("id") != g["immich"]["asset_id"] or not a.get("exifInfo"):
                continue  # uploaded again meanwhile, or Immich hasn't read the file yet
            pushed = g["immich"].get("pushed") or _pushed(fresh, g, i)
            caption = (a["exifInfo"].get("description") or "").strip()[:2000]
            day = (a.get("localDateTime") or "")[:10]
            new = dict(pushed)
            if caption != pushed.get("caption", ""):
                g["caption"] = caption
                new["caption"] = caption
                out["captions"] += 1
            if parse_date(day) and day != pushed.get("date"):
                g["date"] = day
                new["date"] = day
                out["dates"] += 1
            if new != pushed:
                g["immich"]["pushed"] = new
                touched.append(g)
        # Immich has these already: record them as sent, unless the slide's date still differs from
        # Immich's (then the next upload updates it there)
        for g in touched:
            i = fresh.group_index(g["id"])
            if _photo_datetime(fresh, g, i).strftime("%Y-%m-%d") == g["immich"]["pushed"]["date"]:
                g["immich"]["meta"] = slide_meta(fresh, g, i)
        if touched:
            fresh.log(f"Pulled {out['captions']} captions and {out['dates']} dates from Immich")

    update_session(sid, commit)
    return out


# --------------------------------------------------------------------------- card cleanup


def cleanup_blockers(s: Session) -> list[str]:
    problems = []
    pending = [i + 1 for i, g in enumerate(s.data["groups"]) if group_status(g) not in ("uploaded", "skipped")]
    if pending:
        problems.append(f"{len(pending)} slide(s) not uploaded yet (e.g. #{pending[0]})")
    if not any(sc.get("removable") for sc in s.data["scans"].values()):  # folders, photos pulled in from Immich
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
