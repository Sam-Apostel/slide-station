"""HTTP API + static UI. Run with:  python -m slidestation"""
from __future__ import annotations

import json
import os
import threading
import time
import webbrowser
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import accounts, captions, eyes, filmstock, insights, learning
from . import people, places
from . import raw, similar, tether, uploads, watch
from . import store
from . import workflow as wf
from . import imaging as im
from .imaging import Params
from .immich import Immich, ImmichError
from .store import (Session, active_scans, load_config, load_presets, lock, parse_date, render_key, save_config,
                    save_presets, slide_dates, statuses, summary, tone_key)

app = FastAPI(title="Slide Station")


class Accounts:
    """Accounts mode (accounts.py): every /api request but signing in needs a session cookie, and
    runs as that user (store.as_home), so everything it touches — config, library, jobs — is theirs.
    Plain ASGI rather than BaseHTTPMiddleware, so the user reaches the endpoint (and the threads it
    starts) through the context."""

    OPEN = ("/api/health", "/api/auth", "/api/auth/login", "/api/auth/logout")

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not accounts.enabled() or not path.startswith("/api/") or path in self.OPEN:
            return await self.app(scope, receive, send)
        home = await run_in_threadpool(accounts.resolve, _cookie(scope))
        if home is None:
            return await JSONResponse({"error": "Sign in with your Immich API key", "signin": True},
                                      status_code=401)(scope, receive, send)
        with store.as_home(home):
            await self.app(scope, receive, send)


def _cookie(scope) -> str | None:
    for k, v in scope.get("headers", []):
        if k == b"cookie":
            for part in v.decode("latin-1").split(";"):
                name, _, value = part.strip().partition("=")
                if name == accounts.COOKIE:
                    return value
    return None


app.add_middleware(Accounts)
# The UI is the React app in frontend/; its build is committed to slidestation/web so
# the launcher works without Node.
WEB = Path(__file__).parent / "web"


def _session(sid: str) -> Session:
    try:
        return Session(sid)
    except FileNotFoundError:
        raise HTTPException(404, "Session not found")


def _err(e: Exception, code: int = 400):
    return JSONResponse({"error": str(e)}, status_code=code)


# --------------------------------------------------------------------------- state


@app.get("/api/state")
def state():
    cfg = load_config()
    return {
        "config": {k: v for k, v in cfg.items() if k != "immich_key"} | {"has_key": bool(cfg.get("immich_key"))},
        "sources": wf.detect_sources(),
        "sessions": Session.list_all(),
        "job": wf.current_job.as_dict() if wf.current_job else None,
        # what this server can do: accounts (hosted), RAW files, tethered capture (camera rig)
        "server": {"accounts": accounts.enabled(), "raw": raw.available(), "watch": watch.available()},
        "camera": _camera(),
        "watch": watch.summary(),  # watched folders, as the last poll saw them (watch.py)
        "quota": uploads.usage(),  # bytes used / allowed, when the server sets quotas
    }


def _camera() -> dict | None:
    """Tethered capture: None without gphoto2 (or on a hosted server: the camera would be everyone's)."""
    if accounts.enabled() or not tether.available():
        return None
    return {"cameras": tether.cameras()}


@app.get("/api/health")
def health():
    """For the container's healthcheck: answers without signing in."""
    return {"ok": True}


# --------------------------------------------------------------------------- accounts


@app.get("/api/auth")
def auth_state(request: Request):
    """Whether this server has accounts, and who is signed in."""
    if not accounts.enabled():
        return {"accounts": False, "user": None}
    token = request.cookies.get(accounts.COOKIE)
    home = accounts.resolve(token)
    out = {"accounts": True, "user": accounts.profile(home) if home else None, "immich_url": store.USER_IMMICH_URL}
    if home is None and accounts.ended(token):
        out["ended"] = accounts.ended(token)  # e.g. the key was revoked in Immich
    return out


TRUST_PROXY = os.environ.get("SLIDESTATION_TRUST_PROXY", "") not in ("", "0")


def _client_address(request: Request) -> str:
    """Who is signing in, for the rate limit: the peer, or behind a reverse proxy you trust
    (SLIDESTATION_TRUST_PROXY=1) the address it appended to X-Forwarded-For."""
    fwd = request.headers.get("x-forwarded-for", "")
    if TRUST_PROXY and fwd.strip():
        return fwd.split(",")[-1].strip()
    return request.client.host if request.client else ""


@app.post("/api/auth/login")
def auth_login(request: Request, body: dict = Body(...)):
    """Sign in with an API key of the server's Immich; your Immich user is your account. Failed
    tries slow down per address and per key (429 with Retry-After, accounts.check_rate)."""
    if not accounts.enabled():
        return _err(RuntimeError("This server has no accounts"), 404)
    try:
        token, user = accounts.login(str(body.get("api_key") or ""), _client_address(request))
    except accounts.RateLimited as e:
        return JSONResponse({"error": str(e), "retry_after": e.retry_after}, status_code=429,
                            headers={"Retry-After": str(e.retry_after)})
    except ImmichError as e:
        return _err(e, 401)
    except Exception as e:  # Immich unreachable, no SLIDESTATION_IMMICH_URL
        return _err(e, 502)
    r = JSONResponse({"accounts": True, "user": user, "immich_url": store.USER_IMMICH_URL})
    r.set_cookie(accounts.COOKIE, token, max_age=accounts.TTL, httponly=True, samesite="lax",
                 secure=request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https")
    return r


@app.post("/api/auth/logout")
def auth_logout(request: Request):
    accounts.logout(request.cookies.get(accounts.COOKIE))
    r = JSONResponse({"ok": True})
    r.delete_cookie(accounts.COOKIE)
    return r


@app.post("/api/config")
def set_config(body: dict = Body(...)):
    cfg = load_config()
    # an account's library and Immich are the server's to decide (accounts.py)
    own = () if store.user_home() is not None else ("library", "immich_url")
    new_key = str(body.get("immich_key") or "").strip()
    if store.user_home() is not None and new_key and new_key != cfg.get("immich_key"):
        try:  # an account's key has to stay theirs: it is who they are (accounts.py)
            accounts.key_owner_ok(new_key)
        except ImmichError as e:
            return _err(e, 400)
        except Exception as e:  # Immich unreachable
            return _err(e, 502)
    for k in (*own, "immich_key", "keep_originals", "keep_exports", "jpeg_quality",
              "learning_enabled", "upload_originals_stacked", "insights_enabled", "captions_enabled",
              "people_enabled", "lookalike_enabled", "eyes_enabled"):
        if k in body and not (k == "immich_key" and body[k] == ""):
            cfg[k] = body[k]
    if "stats_target" in body:  # slides to digitise in all, for the stats' projected finish
        try:
            cfg["stats_target"] = max(1, int(body["stats_target"]))
        except (TypeError, ValueError):
            raise HTTPException(400, "The target is a number of slides")
    save_config(cfg)
    return {"ok": True}


@app.post("/api/immich/test")
def immich_test(body: dict = Body(default={})):
    cfg = load_config()
    try:
        url = cfg["immich_url"] if store.user_home() is not None else body.get("immich_url") or cfg["immich_url"]
        c = Immich(url, body.get("immich_key") or cfg["immich_key"])
        v = c.version()
        who = c.whoami()
        c.close()
        return {"ok": True, "message": f"Connected to Immich {v} as {who}"}
    except Exception as e:
        return {"ok": False, "message": str(e)}


# --------------------------------------------------------------------------- round trip: Immich -> trays


def _immich() -> Immich:
    cfg = load_config()
    if not cfg.get("immich_url") or not cfg.get("immich_key"):
        raise HTTPException(400, "Set your Immich URL and API key in Settings first.")
    return Immich(cfg["immich_url"], cfg["immich_key"])


@app.get("/api/immich/albums")
def immich_albums():
    """Albums to pull photos back in from, by name."""
    c = _immich()
    try:
        albums = c.albums()
    except Exception as e:  # ImmichError, or Immich unreachable
        return _err(e, 502)
    finally:
        c.close()
    return sorted(({"id": a["id"], "name": a.get("albumName", ""), "count": a.get("assetCount", 0),
                    "thumb": a.get("albumThumbnailAssetId")} for a in albums), key=lambda a: a["name"].lower())


@app.get("/api/immich/albums/{aid}/assets")
def immich_album_assets(aid: str):
    """The photos in an album (videos left out), in date order, marked when a tray has them already."""
    c = _immich()
    try:
        assets = c.album_assets(aid)
    except Exception as e:  # ImmichError, or Immich unreachable
        return _err(e, 502)
    finally:
        c.close()
    pulled = {}
    for t in Session.list_all():
        for sc in Session(t["id"]).data["scans"].values():
            if sc.get("immich_asset"):
                pulled[sc["immich_asset"]] = t["name"]
    out = [{"id": a["id"], "name": a.get("originalFileName", ""), "date": (a.get("localDateTime") or "")[:10],
            "favorite": bool(a.get("isFavorite")), "tray": pulled.get(a["id"], "")}
           for a in assets if a.get("type", "IMAGE") == "IMAGE" and not a.get("isTrashed")]
    return sorted(out, key=lambda a: (a["date"], a["name"]))


@app.get("/api/immich/assets/{aid}/thumb.jpg")
def immich_thumb(aid: str):
    c = _immich()
    try:
        data = c.thumbnail(aid)
    except Exception as e:  # ImmichError, or Immich unreachable
        return _err(e, 502)
    finally:
        c.close()
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


@app.post("/api/immich/import")
def immich_import(body: dict = Body(...)):
    """A new tray with these Immich photos as its scans: {"assets": [...], "name", "album", "date"}."""
    ids = [str(x) for x in body.get("assets") or []]
    if not ids:
        return _err(RuntimeError("Pick at least one photo."))
    if wf.current_job and not wf.current_job.finished:
        return _err(RuntimeError(f"Busy with {wf.current_job.kind} - wait for it to finish."), 409)
    name = str(body.get("name") or "").strip() or "From Immich"
    s = Session.create(name, str(body.get("album") or "").strip() or None, str(body.get("date") or "").strip())
    try:
        wf.start_job("import", s.id, wf.pull_in, s.id, ids)
    except RuntimeError as e:
        return _err(e, 409)
    return {"id": s.id}


@app.post("/api/sessions/{sid}/pull")
def pull_from_immich(sid: str):
    """Bring captions and dates edited in Immich back into the tray."""
    _session(sid)
    try:
        pulled = wf.pull_metadata(sid)
    except Exception as e:  # ImmichError, or Immich unreachable
        return _err(e, 502)
    return {**_session_payload(_session(sid)), "pulled": pulled}


# --------------------------------------------------------------------------- sessions


# each slide's own: Copy previous, Apply to rest, presets, "develop like" and learning never carry
# these over (local adjustments are drawn on this picture, like a crop)
FRAMING = {"angle": 0.0, "crop": None, "local": []}


def _learn(s: Session, g: dict) -> None:
    """Remember an approved slide's settings; drop it again if it gets skipped."""
    if not load_config().get("learning_enabled", True) or not g.get("feat"):
        return
    key = f"{s.id}:{g['id']}"
    if g.get("skip"):
        learning.model().forget(key)
    elif g.get("reviewed") or g.get("immich"):
        learning.model().remember(key, g["feat"], g["params"], filmstock.effective(s.data, g))


def _stock_changed(s: Session, gs: list[dict]) -> None:
    """A slide's film stock (or the tray's) changed: its label and its learning example follow."""
    for g in gs:
        filmstock.label(s.data, g, s.id)
        _learn(s, g)


def _clean_stock(v) -> str:
    try:
        return filmstock.clean(v)
    except ValueError as e:
        raise HTTPException(400, str(e))


def _mount_view(g: dict) -> dict | None:
    m = g.get("mount")
    if not m or m.get("scans") != active_scans(g):
        return None
    return {k: m[k] for k in ("angle", "confidence", "box")}


def _session_payload(s: Session) -> dict:
    d = s.data
    groups = []
    models = insights.active_models()  # once: every slide's insights key depends on it
    dates = slide_dates(d)
    st = statuses(d)
    live = filmstock.views(d, dates)  # film stock and date guesses: no model, always on
    for i, g in enumerate(d["groups"]):
        groups.append({
            **{k: g[k] for k in ("id", "scans", "excluded", "rotation", "rot_reason", "params", "reviewed", "skip")},
            "mirror": bool(g.get("mirror")),
            "params_source": g.get("params_source", ""),
            "auto_excluded": g.get("auto_excluded", {}),  # scan -> "blurry" / "clipped"
            # original scans deleted after upload: read-only, Immich has the final version
            "locked": bool(g.get("locked")),
            # pulled in from Immich: its upload replaces that photo
            "from_immich": bool(g.get("source_asset")),
            "status": st[i],
            "date": g.get("date", ""),
            "caption": g.get("caption", ""),
            "tags": g.get("tags", []),
            "stock": g.get("stock", ""),  # its own ("" = the tray's, below)
            "insights": _slide_insights(g, live[i], models),
            # after upload: photos already in Immich that look like this one (similar.check_lookalikes)
            "lookalike": similar.lookalike_view(g),
            "place": g.get("place"),  # {"name", "lat", "lon", "country"} or None
            "date_est": dates[i],  # {"value", "source": own|between|near|tray|scan, "from": [indices]}
            "active": active_scans(g),
            "key": render_key(g),  # preview cache key: the UI must use this, not its own guess
            "tone_key": tone_key(g),  # histogram cache key
            "can_undo": bool((g.get("history") or {}).get("undo")),
            "can_redo": bool((g.get("history") or {}).get("redo")),
            # the slide mount's tilt {"angle", "confidence", "box"}; None = not looked for yet (an
            # older tray, or the scans changed): POST …/mount finds it
            "mount": _mount_view(g),
            "index": i,
        })
    return {
        "summary": summary(d),
        "defaults": d["defaults"],
        "groups": groups,
        "cleanup_blockers": wf.cleanup_blockers(s),
        "log": d.get("log", [])[-20:],
        "stock": d.get("stock", ""),  # the tray's film stock, for slides without their own
        **_insights_payload(s, models),
        # place suggestions from signs: the text reader + place names are there (else ocr_mb to download)
        "places": {"ocr": insights.ocr_on(),
                   "ocr_mb": places.OCR_MB + (0 if places.gazetteer_ready() else places.GAZETTEER_MB)},
    }


def _insights_payload(s: Session, models: list[str]) -> dict:
    """Top-level insights state (_insights_status), and the look-alike suggestions (tray-level:
    duplicates, split, merge, scenes) once the tag model is there. `pending` counts slides to analyse
    plus slides and scans to embed: the UI keeps reloading the tray while it's above 0."""
    status = _insights_status(s.data, models)
    sim = similar.payload(s) if insights.enabled() and insights.model_ready() else None
    if sim:
        # a slide still to analyse gets its embedding from that same analysis: count it once
        e = similar.load(s.id)
        overlap = sum(1 for g in s.data["groups"] if not g.get("skip") and insights.needs_analysis(g, models)
                      and e["slides"].get(g["id"], {}).get("key") != similar.slide_key(g))
        status["pending"] += sim["pending"] - overlap
    return {"insights": status, "similar": {k: v for k, v in sim.items() if k != "pending"} if sim else None}


@app.post("/api/sessions")
def create_session(body: dict = Body(...)):
    s = Session.create(body.get("name", "").strip(), (body.get("album") or "").strip() or None, body.get("date", "").strip())
    return {"id": s.id}


@app.get("/api/sessions/{sid}")
def get_session(sid: str, peek: int = 0):
    s = _session(sid)
    if peek:  # a look into another tray (the "develop like" picker), not the one you work on
        return _session_payload(s)
    wf.active_session = sid  # the background renderer works on the tray you're looking at
    if wf.sync_locks(s):  # originals deleted (or restored) since we last looked
        s = wf.update_session(sid, wf.sync_locks)
    return _session_payload(s)


@app.patch("/api/sessions/{sid}")
def patch_session(sid: str, body: dict = Body(...)):
    with lock:
        s = _session(sid)
        for k in ("name", "album", "date"):
            if k in body:
                s.data[k] = str(body[k]).strip()
        if "defaults" in body:
            s.data["defaults"] = Params.from_dict(body["defaults"]).to_dict()
        if "stock" in body:
            s.data["stock"] = _clean_stock(body["stock"])
            _stock_changed(s, s.data["groups"])
        s.save()
    return _session_payload(s)


@app.post("/api/sessions/{sid}/import")
def import_into(sid: str, body: dict = Body(...)):
    """Import from a source: a card or folder path, or `upload:<id>` (a folder uploaded from the
    browser). An account can only import what it uploaded: the server's disks aren't theirs."""
    _session(sid)
    source = str(body.get("source") or "")
    upload = uploads.id_of(source)
    try:
        if upload is not None:
            uploads.folder(upload)  # 404 now rather than a failed job
            wf.start_job("import", sid, wf.import_upload, sid, upload, resume={"source": source})
        elif store.user_home() is not None:
            return _err(RuntimeError("Upload the scans from your browser: this server's folders aren't yours"), 403)
        else:
            wf.start_job("import", sid, wf.import_scans, sid, source, resume={"source": source})
    except uploads.UploadError as e:
        return _err(e, e.status)
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True}


# --------------------------------------------------------------------------- uploads from the browser


def _upload_err(e: uploads.UploadError):
    return JSONResponse({"error": str(e), **e.extra}, status_code=e.status)


@app.post("/api/uploads")
def upload_create(body: dict = Body(default={})):
    """Start uploading a folder of scans: {"name"} -> {"id"}; import it later as `upload:<id>`."""
    return {"id": uploads.create(str(body.get("name") or ""))}


@app.post("/api/uploads/{uid}/check")
def upload_check(uid: str, body: dict = Body(...)):
    """{"files": [{"path", "size", "sha1"?}]} -> {"files": {path: {"have"} | {"offset"}}}: what to
    send (and from where) to finish this upload, e.g. after the connection dropped."""
    try:
        return {"files": uploads.check(uid, list(body.get("files") or []))}
    except uploads.UploadError as e:
        return _upload_err(e)


@app.put("/api/uploads/{uid}/files/{path:path}")
async def upload_put(uid: str, path: str, request: Request, offset: int = 0, size: int = 0, sha1: str = ""):
    """One chunk of a file (the request body), written at `offset` of `size` bytes in all."""
    data = await request.body()
    try:
        return await run_in_threadpool(uploads.put, uid, path, offset, size, sha1, data)
    except uploads.UploadError as e:
        return _upload_err(e)


@app.delete("/api/uploads/{uid}")
def upload_delete(uid: str):
    try:
        uploads.folder(uid)
    except uploads.UploadError as e:
        return _upload_err(e)
    uploads.delete(uid)
    return {"ok": True}


# --------------------------------------------------------------------------- watched folders


def _watch_err(e: watch.WatchError):
    return JSONResponse({"error": str(e)}, status_code=e.status)


@app.get("/api/watch")
def watch_state():
    """Watched folders (watch.py) and what became of every sub-folder in them."""
    return watch.status()


@app.post("/api/watch")
def watch_add(body: dict = Body(...)):
    """Watch a folder: each sub-folder dropped into it becomes a tray. On a server only under
    SLIDESTATION_WATCH_ROOT (403 elsewhere, and for accounts when it isn't set)."""
    try:
        f = watch.add(str(body.get("path") or ""), bool(body.get("auto_upload")), bool(body.get("require_done")),
                      body.get("settle"))
    except watch.WatchError as e:
        return _watch_err(e)
    watch.poll_mine()  # see what's in it now, rather than at the next poll
    return f


@app.patch("/api/watch/{fid}")
def watch_change(fid: str, body: dict = Body(...)):
    try:
        return watch.change(fid, body)
    except watch.WatchError as e:
        return _watch_err(e)


@app.delete("/api/watch/{fid}")
def watch_remove(fid: str):
    try:
        watch.remove(fid)
    except watch.WatchError as e:
        return _watch_err(e)
    return {"ok": True}


@app.post("/api/watch/{fid}/retry")
def watch_retry(fid: str, body: dict = Body(...)):
    try:
        watch.retry(fid, str(body.get("name") or ""))
    except watch.WatchError as e:
        return _watch_err(e)
    return {"ok": True}


# --------------------------------------------------------------------------- tethered capture


@app.post("/api/sessions/{sid}/capture")
def capture(sid: str, body: dict = Body(default={})):
    """Camera rig mode: take a picture with the tethered camera and import it into this tray."""
    _session(sid)
    if _camera() is None:
        return _err(RuntimeError("No tethered capture here (install gphoto2 and connect the camera by USB)"), 404)
    try:
        wf.start_job("capture", sid, wf.capture_into, sid, body.get("port") or None)
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True}


HISTORY_MAX = 60
COALESCE_S = 1.5  # edits to the same settings closer together than this are one undo step


def _snapshot(g: dict) -> dict:
    return {"params": json.loads(json.dumps(g["params"])), "rotation": g["rotation"], "mirror": bool(g.get("mirror")),
            "rot_reason": g.get("rot_reason", ""), "params_source": g.get("params_source", "")}


def _remember(g: dict, what: str) -> None:
    """Push the slide's look before an edit onto its undo stack (a slider drag is one step)."""
    h = g.setdefault("history", {"undo": [], "redo": []})
    now = time.time()
    last = h["undo"][-1] if h["undo"] else None
    if last and last.get("what") == what and now - last.get("t", 0) < COALESCE_S:
        last["t"] = now  # same drag: keep the state from before it started
    else:
        h["undo"] = (h["undo"] + [{**_snapshot(g), "what": what, "t": now}])[-HISTORY_MAX:]
    h["redo"] = []


def _restore(g: dict, snap: dict) -> None:
    g["params"], g["rotation"], g["mirror"] = snap["params"], snap["rotation"], snap.get("mirror", False)
    g["rot_reason"], g["params_source"] = snap.get("rot_reason", ""), snap.get("params_source", "")


@app.post("/api/sessions/{sid}/groups/{gid}/undo")
def undo(sid: str, gid: str):
    return _step(sid, gid, "undo")


@app.post("/api/sessions/{sid}/groups/{gid}/redo")
def redo(sid: str, gid: str):
    return _step(sid, gid, "redo")


def _step(sid: str, gid: str, direction: str):
    """Step a slide's look (settings + rotation) back or forward through its history."""
    with lock:
        s = _session(sid)
        g = s.group(gid)
        _editable(g)
        h = g.setdefault("history", {"undo": [], "redo": []})
        src, dst = (h["undo"], h["redo"]) if direction == "undo" else (h["redo"], h["undo"])
        if not src:
            return {**_session_payload(s), "stepped": None}
        snap = src.pop()
        dst.append({**_snapshot(g), "what": snap.get("what"), "t": 0})
        _restore(g, snap)
        _learn(s, g)
        s.save()
    return {**_session_payload(s), "stepped": snap.get("what")}


LOCKED = ("This slide's original scans were deleted after it was uploaded, so it can't be edited "
          "(Immich has the final version). Re-import its scans into this tray to edit it again.")


def _editable(g: dict) -> None:
    if g.get("locked"):
        raise HTTPException(409, LOCKED)


def _edit_label(body: dict) -> str | None:
    if "rotation" in body:
        return "rotation"
    if "mirror" in body:
        return "mirror"
    if "params" in body:
        return "params:" + ",".join(sorted(body["params"]))
    return None


@app.patch("/api/sessions/{sid}/groups/{gid}")
def patch_group(sid: str, gid: str, body: dict = Body(...)):
    with lock:
        s = _session(sid)
        g = s.group(gid)
        if set(body) - {"reviewed", "skip"}:  # developed / left out are fine; changing the photo is not
            _editable(g)
        what = _edit_label(body)
        if what:
            _remember(g, what)
        if "rotation" in body:
            rot = int(body["rotation"]) % 360
            if g["params"].get("local"):  # the masks turn with the picture
                g["params"]["local"] = im.turn_local(g["params"]["local"], rot - g["rotation"])
            g["rotation"] = rot
            g["rot_reason"] = "manual"
        if "mirror" in body and bool(body["mirror"]) != bool(g.get("mirror")):
            # flip what's on screen left-right: the scan is mirrored before it's rotated, so the
            # rotation, straighten, crop and masks all turn the other way to keep the photo in place
            g["mirror"] = bool(body["mirror"])
            g["rotation"] = -g["rotation"] % 360
            g["params"] = im.mirror_params(Params.from_dict(g["params"])).to_dict()
        if "params" in body:
            g["params"] = Params.from_dict({**g["params"], **body["params"]}).to_dict()
            g["params_source"] = "manual"
        if "reviewed" in body:  # when, for the stats (slides per hour, projected finish)
            if body["reviewed"] and not g.get("reviewed"):
                g["developed_at"] = time.time()
            elif not body["reviewed"]:
                g.pop("developed_at", None)
        for k in ("reviewed", "skip"):
            if k in body:
                g[k] = bool(body[k])
        if "date" in body:
            g["date"] = _clean_date(body["date"])
        if "caption" in body:
            _set_caption(g, str(body["caption"]).strip()[:2000])
        if "tags" in body:
            _set_tags(g, _clean_tags(body["tags"]))
        if "stock" in body:
            _set_stock(g, _clean_stock(body["stock"]))
        if "stock" in body or "skip" in body:
            filmstock.label(s.data, g, s.id)
        if "place" in body:
            _set_place(g, _clean_place(body["place"]))
            places.suggest_between(s.data)
        _learn(s, g)
        if "excluded" in body:
            g["excluded"] = [x for x in body["excluded"] if x in g["scans"]]
            if len(g["excluded"]) >= len(g["scans"]):
                g["excluded"] = g["scans"][1:]
        s.save()
    return _session_payload(s)


def _clean_date(v) -> str:
    """A slide date as typed: 1978, 1978-06 or 1978-06-14 ("/" works too); "" clears it."""
    v = str(v).strip().replace("/", "-")
    if v and not parse_date(v):
        raise HTTPException(400, "Use a year, year-month or full date: 1978, 1978-06, 1978-06-14")
    return v


@app.post("/api/sessions/{sid}/dates")
def date_range(sid: str, body: dict = Body(...)):
    """Date a run of slides at once ("12-31: Aug 1978"): `from` .. `to` (group ids, either order,
    both included, in tray order) all get `date`. Locked slides are left as they are."""
    v = _clean_date(body.get("date", ""))
    with lock:
        s = _session(sid)
        try:
            a, b = sorted((s.group_index(body.get("from")), s.group_index(body.get("to"))))
        except (KeyError, ValueError):
            raise HTTPException(404, "Slide not found")
        n = 0
        for g in s.data["groups"][a : b + 1]:
            if g.get("locked"):
                continue
            g["date"] = v
            n += 1
        s.save()
    return {**_session_payload(s), "dated": n}


# --------------------------------------------------------------------------- insights (tags, suggestions)


def _clean_tags(v) -> list[str]:
    """A slide's own tags: trimmed, lower case, no repeats, at most 30 of 40 characters each."""
    out = []
    for t in v if isinstance(v, list) else []:
        t = " ".join(str(t).split()).lower()[:40]
        if t and t not in out:
            out.append(t)
    return out[:30]


def _set_tags(g: dict, tags: list[str]) -> None:
    """Set a slide's tags; a suggested tag the user removes counts as dismissed (it stays away)."""
    removed = set(g.get("tags", [])) - set(tags)
    for e in (g.get("insights") or {}).get("tags", []):
        if e["value"] in removed and e.get("state") == "accepted":
            e["state"] = "dismissed"
            insights.record("tags", e["value"], "dismiss")
        elif e["value"] in tags and e.get("state") == "suggested":
            e["state"] = "accepted"
    if tags:
        g["tags"] = tags
    else:
        g.pop("tags", None)


def _clean_place(v) -> dict | None:
    try:
        return places.clean_place(v)
    except ValueError as e:
        raise HTTPException(400, str(e))


def _set_place(g: dict, p: dict | None) -> None:
    """Set (or clear) a slide's place. An open place suggestion is settled by it: the same place
    accepted, another one dismissed (you chose)."""
    if p:
        g["place"] = p
    else:
        g.pop("place", None)
    e = (g.get("insights") or {}).get("place")
    if p and e and e.get("state") == "suggested":
        e["state"] = "accepted" if places.same(e.get("place"), p) else "dismissed"


def _set_stock(g: dict, v: str) -> None:
    if v:
        g["stock"] = v
    else:
        g.pop("stock", None)


def _set_caption(g: dict, caption: str) -> None:
    """Give a slide its own caption. An open caption suggestion goes (it's never offered over the
    slide's own), and suggestions that were up to date stay so: no new look at the slide just for
    that. Clearing the caption does make it stale, so a caption is suggested for it again."""
    models = insights.active_models()
    fresh = bool(g.get("insights")) and not insights.needs_analysis(g, models)
    g["caption"] = caption
    ins = g.get("insights")
    if not ins or not caption:
        return
    if (ins.get("caption") or {}).get("state") == "suggested":
        ins["caption"] = None
    if fresh:
        ins["key"] = insights.insights_key(g, models)


def _slide_insights(g: dict, live: dict, models: list[str]) -> dict | None:
    """The slide's suggestions: the models' (stored), plus the film stock and date guesses (`live`,
    filmstock.views), which need no model."""
    ins = g.get("insights") or {}
    if not ins and not live["stock"] and not live["date"]:
        return None
    return {**{k: ins.get(k) for k in insights.KINDS}, **live, "tags": ins.get("tags", []),
            "text": [t["text"] for t in ins.get("text") or []],  # what the text reader read in the photo
            "stale": bool(ins) and ins.get("key") != insights.insights_key(g, models), "error": ins.get("error", "")}


# the suggestion models: whether each is turned on, and downloaded. The eye model (eyes.py) only
# helps look-alikes pick the best shot: it counts as on with the tag model, never on its own.
MODELS = {"tags": insights, "captions": captions, "eyes": eyes}


def _insights_status(d: dict, models: list[str]) -> dict:
    """For the tray payload: `enabled` any model turned on, `ready` one of those downloaded (the
    analysis runs), `missing` the ones turned on but not downloaded yet, `pending` slides to go."""
    on = [k for k, m in MODELS.items() if m.enabled()]
    missing = [k for k in on if not MODELS[k].model_ready()]
    analysing = [k for k in on if k != "eyes"]
    return {"enabled": bool(on), "ready": len([k for k in missing if k != "eyes"]) < len(analysing),
            "pending": insights.pending(d, models), "missing": missing}


@app.get("/api/insights")
def insights_state():
    job = wf.current_job
    return {
        "enabled": insights.enabled(),
        "ready": insights.model_ready(),
        "downloading": bool(job and job.kind == "model" and not job.finished),
        "model_mb": insights.MODEL_MB,
        "labels": insights.TAGS,
        "learned": insights.learned().get("labels", {}),
        "captions": {"enabled": captions.enabled(), "ready": captions.model_ready(), "model_mb": captions.MODEL_MB},
        # look-alikes prefer the shot with open eyes (eyes.py)
        "eyes": {"enabled": eyes.enabled(), "ready": eyes.model_ready(), "model_mb": eyes.MODEL_MB},
        # place suggestions from signs: the text reader + the place names
        "ocr_ready": places.ocr_ready(),
        "ocr_mb": places.OCR_MB + (0 if places.gazetteer_ready() else places.GAZETTEER_MB),
        "ocr_downloading": bool(job and job.kind == "ocr" and not job.finished),
    }


@app.post("/api/insights/model")
def insights_model(body: dict = Body(default={})):
    """Download suggestion models (one job, progress in MB) unless they are already there:
    `models` ["tags", "captions", "eyes"]; by default the ones turned on (the tag model when none is)."""
    want = body.get("models") or [k for k, m in MODELS.items() if m.enabled()] or ["tags"]
    if any(k not in MODELS for k in want):
        raise HTTPException(400, "models are tags, captions and / or eyes")
    todo = [MODELS[k] for k in want if not MODELS[k].model_ready()]
    if not todo:
        return {"ok": True, "ready": True}

    def run(job):
        for m in sorted(todo, key=lambda m: m is not eyes):  # the small eye model first: the job ends
            m.download_model(job)  # saying what the tag / caption model's arrival means

    try:
        wf.start_job("model", None, run)
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True, "ready": False}


@app.post("/api/sessions/{sid}/insights/run")
def insights_run(sid: str, body: dict = Body(default={})):
    """Analyse this tray in the background (the open tray is analysed anyway). `force`: analyse
    every slide again; decisions already made are kept."""
    with lock:
        s = _session(sid)
        if body.get("force"):
            for g in s.data["groups"]:
                if g.get("insights"):
                    g["insights"]["key"] = ""
            s.save()
    insights.queue_tray(sid)
    return _session_payload(s)


def _decide(g: dict, kind: str, action: str, value: str | None, text: str | None = None) -> bool:
    """Accept or dismiss a slide's open suggestion(s) of one kind (all its values, or `value`).
    Accepting makes it the slide's own tag / caption / date (a caption as edited: `text`); decided
    ones are never revisited (a tag accepted by mistake is removed from the slide's tags, which
    dismisses it). A suggested caption never replaces one the slide has. Returns whether anything
    changed."""
    ins = g.get("insights") or {}
    if kind == "tags":
        hits = [e for e in ins.get("tags", []) if (value is None or e["value"] == value) and e.get("state") == "suggested"]
        if not hits:
            return False
        tags = list(g.get("tags", []))
        for e in hits:
            e["state"] = "accepted" if action == "accept" else "dismissed"
            insights.record("tags", e["value"], action)
            if action == "accept" and e["value"] not in tags:
                tags.append(e["value"])
            elif action == "dismiss" and e["value"] in tags:
                tags.remove(e["value"])
        if tags:
            g["tags"] = tags
        else:
            g.pop("tags", None)
        return True
    e = ins.get(kind)
    if not e or (value is not None and e.get("value") != value) or e.get("state") != "suggested":
        return False
    if action == "accept":
        if kind == "date":
            g["date"] = _clean_date(e["value"])
        elif kind == "caption":
            if g.get("caption"):  # typed (or pulled from Immich) meanwhile: that one stays
                return False
            caption = " ".join(str(e["value"] if text is None else text).split())[:2000]
            if not caption:
                return False
            e["state"] = "accepted"
            _set_caption(g, caption)
            return True
        elif kind == "stock":
            _set_stock(g, e["value"])
        else:
            g["place"] = places.clean_place(e["place"])  # value is how it reads; place the place
    e["state"] = "accepted" if action == "accept" else "dismissed"
    return True


@app.post("/api/sessions/{sid}/insights/decide")
def insights_decide(sid: str, body: dict = Body(...)):
    """Accept or dismiss suggestions: `kind` (tags / caption / date / place), `action` (accept /
    dismiss), optionally `value` (one tag, say "beach") and `groups` (slide ids; default: the whole
    tray, the review view's "accept all"). Locked slides can't take accepted values. A caption
    accepted on one slide can carry `text`, the suggestion as the user edited it."""
    kind, action, value, text = body.get("kind"), body.get("action"), body.get("value"), body.get("text")
    if action not in ("accept", "dismiss") or kind not in insights.KINDS + similar.KINDS + ("lookalike",):
        raise HTTPException(400, "kind must be tags, caption, date, place, stock, duplicates, split, merge or lookalike; "
                                 "action accept or dismiss")
    if kind in similar.KINDS:
        return _decide_similar(sid, kind, action, str(value or ""), body.get("keep"))
    if kind == "lookalike":
        return _decide_lookalike(sid, action, str(value or ""), body.get("groups") or [])
    with lock:
        s = _session(sid)
        gids = body.get("groups")
        targets = [g for g in s.data["groups"] if gids is None or g["id"] in gids]
        if gids is not None and len(targets) == 1 and action == "accept":
            _editable(targets[0])
        # film stock and date guesses live in no file until decided: write down what is shown
        live = filmstock.views(s.data, slide_dates(s.data)) if kind in ("stock", "date") else None
        n = 0
        for g in targets:
            if action == "accept" and g.get("locked"):
                continue
            if live:
                e = live[s.group_index(g["id"])][kind]
                if e and e.get("state") == "suggested" and (value is None or e["value"] == value):
                    g.setdefault("insights", {})[kind] = dict(e)
            if _decide(g, kind, action, value, text if kind == "caption" and len(targets) == 1 else None):
                n += 1
                if kind == "stock":
                    _stock_changed(s, [g])
        if kind == "place":
            places.suggest_between(s.data)
        s.save()
    return {**_session_payload(s), "decided": n}


def _decide_similar(sid: str, kind: str, action: str, value: str, keep: str | None) -> dict:
    """A look-alike suggestion (similar.py), by its id. Accept: duplicates keep one slide (`keep`,
    default the best) and skip the rest; split cuts the stack before the odd scan; merge joins the
    two neighbours. Dismiss: it isn't suggested again. Counted for the duplicate threshold."""
    with lock:
        s = _session(sid)
        sug = next((x for x in similar.suggest(s)[kind] if x["id"] == value), None)
        if sug is None:
            raise HTTPException(404, "That suggestion no longer applies (the slides changed)")
        if action == "dismiss":
            similar.dismiss(s.data, sug)
        elif kind == "duplicates":
            keep = keep if keep in sug["groups"] else sug["best"]
            for gid in sug["groups"]:
                if gid != keep:
                    g = s.group(gid)
                    g["skip"] = True
                    _learn(s, g)
        elif kind == "split":
            g = s.group(sug["groups"][0])
            _editable(g)
            _split(s, g, sug["scan"])
        else:
            i = s.group_index(sug["groups"][0])
            if i + 1 >= len(s.data["groups"]) or s.data["groups"][i + 1]["id"] != sug["groups"][1]:
                raise HTTPException(409, "These slides are no longer next to each other")
            _merge_next(s, i)
        s.save()
    insights.record(kind, kind, action)
    return {**_session_payload(s), "decided": 1}


def _decide_lookalike(sid: str, action: str, value: str, gids: list) -> dict:
    """A photo in Immich that looks like this slide's upload (`value`: its asset id). Accept =
    replace it: the new upload joins its albums (and becomes a favourite if it was), it goes to the
    Immich trash. Dismiss: keep both."""
    if len(gids) != 1:
        raise HTTPException(400, "Give the slide (groups: [id])")
    s = _session(sid)
    g = s.group(gids[0])
    rec = g.get("immich") or {}
    match = next((m for m in (rec.get("lookalike") or {}).get("matches", []) if m["id"] == value), None)
    if match is None or match.get("state") != "suggested":
        raise HTTPException(404, "No such look-alike for this slide")
    if action == "accept":
        cfg = load_config()
        client = Immich(cfg["immich_url"], cfg["immich_key"])
        try:
            carry = wf._carry_over(client, value)
            for a in carry["albums"]:
                client.add_to_album(a, [rec["asset_id"]])
            if carry["favorite"]:
                client.update_asset(rec["asset_id"], isFavorite=True)
            client.trash([value])
        except ImmichError as e:
            return _err(e, 502)
        finally:
            client.close()

    def commit(fresh: Session):
        for m in ((fresh.group(g["id"]).get("immich") or {}).get("lookalike") or {}).get("matches", []):
            if m["id"] == value:
                m["state"] = "accepted" if action == "accept" else "dismissed"

    s = wf.update_session(sid, commit)
    return {**_session_payload(s), "decided": 1}


@app.post("/api/sessions/{sid}/lookalikes")
def lookalikes(sid: str, body: dict = Body(default={})):
    """Look for photos in Immich that look like this tray's uploaded slides (a job): the ones not
    checked yet or waiting for Immich to index them; `all`: every uploaded slide again."""
    _session(sid)
    if insights.backend() is None:
        return _err(RuntimeError("Download the tag model first (Settings → Suggest tags): it compares the photos."))
    try:
        wf.start_job("lookalike", sid, wf.check_lookalikes, sid, bool(body.get("all")))
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True}


@app.post("/api/sessions/{sid}/insights/propagate")
def insights_propagate(sid: str, body: dict = Body(...)):
    """Give a run of slides what one of them was confirmed to have ("Apply 'beach' to 12-31"):
    `kind` tags / caption / date / place, `value`, `from` .. `to` (slide ids, either order, both
    included). A tag is added to each slide's own tags (and marks the same suggestion there
    accepted); a caption, date or place ({name, lat, lon, country}; null clears) replaces theirs.
    Locked slides are left as they are."""
    kind = body.get("kind")
    if kind not in ("tags", "caption", "date", "stock", "place"):
        raise HTTPException(400, "kind must be tags, caption, date, stock or place")
    if kind == "place":
        value = _clean_place(body.get("value"))
    elif kind == "date":
        value = _clean_date(body.get("value", ""))
    elif kind == "stock":
        value = _clean_stock(body.get("value", ""))
    else:
        value = str(body.get("value", "")).strip()
    if kind == "tags":
        value = (_clean_tags([value]) or [""])[0]
        if not value:
            raise HTTPException(400, "No tag given")
    with lock:
        s = _session(sid)
        try:
            a, b = sorted((s.group_index(body.get("from")), s.group_index(body.get("to"))))
        except (KeyError, ValueError):
            raise HTTPException(404, "Slide not found")
        n = 0
        live = filmstock.views(s.data, slide_dates(s.data)) if kind == "stock" else None
        for g in s.data["groups"][a : b + 1]:
            if g.get("locked"):
                continue
            if kind == "stock":
                _set_stock(g, value)
                e = live[s.group_index(g["id"])]["stock"]
                if value and e and e.get("value") == value:
                    g.setdefault("insights", {})["stock"] = {**e, "state": "accepted"}
                _stock_changed(s, [g])
                n += 1
            elif kind == "tags":
                if value not in g.get("tags", []):
                    _set_tags(g, g.get("tags", []) + [value])
                    n += 1
            elif kind == "place":
                _set_place(g, value)
                n += 1
            else:
                e = (g.get("insights") or {}).get(kind)
                if e and e.get("value") == value:
                    e["state"] = "accepted"
                if kind == "caption":
                    _set_caption(g, value[:2000])
                else:
                    g[kind] = value[:2000]
                n += 1
        if kind == "place":
            places.suggest_between(s.data)
        s.save()
    return {**_session_payload(s), "applied": n}


# --------------------------------------------------------------------------- places


@app.get("/api/places")
def places_search(q: str = "", limit: int = 8):
    """The place field: whether the place names are downloaded, and what matches `q` (a name,
    "Venice, Italy", or "45.43, 12.33")."""
    job = wf.current_job
    ready = places.gazetteer_ready()
    return {
        "ready": ready,
        "downloading": bool(job and job.kind in ("places", "ocr") and not job.finished),
        "mb": places.GAZETTEER_MB,
        "results": places.search(q, max(1, min(limit, 20))) if q.strip() else [],
    }


@app.post("/api/places/download")
def places_download(body: dict = Body(default={})):
    """Download the place names (job `places`), or with `"ocr": true` the text reader too (job
    `ocr`: place suggestions from signs), unless they're there already."""
    ocr = bool(body.get("ocr"))
    if places.ocr_ready() if ocr else places.gazetteer_ready():
        return {"ok": True, "ready": True}
    try:
        wf.start_job("ocr" if ocr else "places", None, places.download_ocr if ocr else places.download_gazetteer)
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True, "ready": False}


@app.post("/api/sessions/{sid}/groups/{gid}/split")
def split_group(sid: str, gid: str, body: dict = Body(...)):
    """Split before the given scan: scans from that one on become a new slide."""
    with lock:
        s = _session(sid)
        g = s.group(gid)
        _editable(g)
        _split(s, g, body["scan"])
        s.save()
    return _session_payload(s)


def _split(s: Session, g: dict, scan: str) -> bool:
    """Scans from `scan` on become a new slide right after this one (same rotation and settings)."""
    at = g["scans"].index(scan)
    if at == 0:
        return False
    tail = s.new_group(g["scans"][at:], g["rotation"], g["rot_reason"])
    tail["params"] = dict(g["params"])
    tail["mirror"] = bool(g.get("mirror"))
    tail["excluded"] = [x for x in g.get("excluded", []) if x in tail["scans"]]
    if g.get("tags"):
        tail["tags"] = list(g["tags"])
    if g.get("stock"):
        tail["stock"] = g["stock"]  # one piece of film
    g["scans"] = g["scans"][:at]
    g["excluded"] = [x for x in g.get("excluded", []) if x in g["scans"]]
    s.data["groups"].insert(s.group_index(g["id"]) + 1, tail)
    return True


@app.post("/api/sessions/{sid}/groups/{gid}/merge_next")
def merge_next(sid: str, gid: str):
    with lock:
        s = _session(sid)
        i = s.group_index(gid)
        if i + 1 >= len(s.data["groups"]):
            raise HTTPException(400, "No next slide to merge with")
        _editable(s.data["groups"][i])
        _editable(s.data["groups"][i + 1])
        _merge_next(s, i)
        s.save()
    return _session_payload(s)


def _merge_next(s: Session, i: int) -> None:
    """The slide after slide i becomes more scans of it (its Immich copy goes at the next upload)."""
    nxt = s.data["groups"].pop(i + 1)
    g = s.data["groups"][i]
    g["scans"] += nxt["scans"]
    g["excluded"] += nxt.get("excluded", [])
    if nxt.get("tags"):
        g["tags"] = g.get("tags", []) + [t for t in nxt["tags"] if t not in g.get("tags", [])]
    if nxt.get("immich"):
        s.data.setdefault("orphan_assets", []).append(nxt["immich"]["asset_id"])
        if nxt["immich"].get("stack_id"):  # its scans get stacked under the merged slide's upload
            s.data.setdefault("orphan_stacks", []).append(nxt["immich"]["stack_id"])


@app.post("/api/sessions/{sid}/apply")
def apply_params(sid: str, body: dict = Body(...)):
    """Copy colour settings to other slides. scope: 'rest' (following unreviewed), 'unreviewed', 'all'."""
    with lock:
        s = _session(sid)
        p = Params.from_dict(body["params"]).to_dict()
        start = s.group_index(body["from"]) if body.get("from") else 0
        for i, g in enumerate(s.data["groups"]):
            if g.get("locked"):
                continue
            if body.get("scope") == "all" or (not g["reviewed"] and (body.get("scope") != "rest" or i > start)):
                # colour carries over, framing (crop / straighten) is each slide's own
                _remember(g, "apply")
                g["params"] = {**p, **{k: g["params"].get(k, v) for k, v in FRAMING.items()}}
        if body.get("as_default"):
            s.data["defaults"] = {**p, **FRAMING}
        s.save()
    return _session_payload(s)


# --------------------------------------------------------------------------- looks: presets, develop like


def _colour(params: dict) -> dict:
    """A slide's look without its framing: crop, straighten and local adjustments are each slide's own."""
    p = Params.from_dict(params).to_dict()
    for k in FRAMING:
        p.pop(k)
    return p


@app.get("/api/presets")
def list_presets():
    return {"presets": load_presets()}


@app.post("/api/presets")
def save_preset(body: dict = Body(...)):
    """Save a named look (library-wide, presets.json): `params`, or the saved settings of slide
    `group` in tray `session`. Colour only. The same name replaces the old one."""
    name = str(body.get("name", "")).strip()[:80]
    if not name:
        raise HTTPException(400, "Give the preset a name")
    if body.get("session"):
        try:
            params = _session(body["session"]).group(body.get("group", ""))["params"]
        except KeyError:
            raise HTTPException(404, "Slide not found")
    elif isinstance(body.get("params"), dict):
        params = body["params"]
    else:
        raise HTTPException(400, "Nothing to save: send params or a slide")
    with lock:
        presets = [p for p in load_presets() if p["name"] != name]
        presets.append({"name": name, "params": _colour(params), "created": time.time()})
        save_presets(presets)
    return {"presets": presets}


@app.delete("/api/presets/{name}")
def delete_preset(name: str):
    with lock:
        presets = load_presets()
        if not any(p["name"] == name for p in presets):
            raise HTTPException(404, "No such preset")
        presets = [p for p in presets if p["name"] != name]
        save_presets(presets)
    return {"presets": presets}


@app.post("/api/sessions/{sid}/groups/{gid}/look")
def apply_look(sid: str, gid: str, body: dict = Body(...)):
    """Give slides another look's colour settings, keeping their own framing. The look is a preset
    (`{"preset": name}`) or any slide of any tray (`{"like": {"session", "group"}}`). scope "this"
    (default) is this slide; "rest" is this slide and every following one still to develop.
    Every slide it changes gets an undo step."""
    if "preset" in body:
        hit = [p for p in load_presets() if p["name"] == body["preset"]]
        if not hit:
            raise HTTPException(404, "No such preset")
        look, source = hit[0]["params"], f"preset:{hit[0]['name']}"
    elif isinstance(body.get("like"), dict):
        try:
            other = _session(str(body["like"].get("session", "")))
            og = other.group(str(body["like"].get("group", "")))
        except KeyError:
            raise HTTPException(404, "Slide not found")
        look = og["params"]
        source = f"like:{other.group_index(og['id']) + 1}:{other.data['name']}"
    else:
        raise HTTPException(400, "Send a preset or a slide to develop like")
    colour = _colour(look)
    rest = body.get("scope") == "rest"
    with lock:
        s = _session(sid)
        try:
            start = s.group_index(gid)
        except ValueError:
            raise HTTPException(404, "Slide not found")
        if not rest:
            _editable(s.data["groups"][start])
        n = 0
        for i, g in enumerate(s.data["groups"]):
            if g.get("locked") or i < start or (i > start and (not rest or g.get("reviewed"))):
                continue
            _remember(g, "preset" if "preset" in body else "like")
            g["params"] = Params.from_dict({**colour, **{k: g["params"].get(k, v) for k, v in FRAMING.items()}}).to_dict()
            g["params_source"] = source
            _learn(s, g)
            n += 1
        s.save()
    return {**_session_payload(s), "applied": n}


# --------------------------------------------------------------------------- stats


@app.get("/api/stats")
def library_stats(target: int = 0):
    """Slides per hour, trays left and the projected finish, across the whole library."""
    return Session.library_stats(target if target > 0 else int(load_config().get("stats_target") or 10_000))


@app.get("/api/learning")
def learning_stats():
    return {**learning.model().stats(), "enabled": load_config().get("learning_enabled", True)}


@app.post("/api/learning/reset")
def learning_reset():
    learning.reset()
    return {"ok": True}


# --------------------------------------------------------------------------- people


def _people_payload(d: dict) -> dict:
    faces = people.all_faces()
    out = []
    for pid, p in d["people"].items():
        fs = [f for f in p["faces"] if f in faces]
        out.append({
            "id": pid,
            "name": p.get("name", ""),
            "slides": len({(faces[f]["sid"], faces[f]["gid"]) for f in fs}),
            "faces": [{"id": f, "url": f"/api/people/faces/{f}.jpg?v={faces[f]['key']}"} for f in fs],
        })
    # named people first (by name), then the ones seen most
    out.sort(key=lambda p: (not p["name"], p["name"].lower(), -len(p["faces"])))
    cfg = load_config()
    return {"enabled": bool(cfg.get("people_enabled")), "model": people.model_ready(), "model_mb": people.MODEL_MB,
            "pending": len(wf.faces_pending()) if cfg.get("people_enabled") else 0, "people": out}


@app.get("/api/people")
def people_list():
    """Everyone found on the slides of every tray, grouped by likeness, named or not."""
    return _people_payload(people.refresh())


@app.post("/api/people/scan")
def people_scan():
    """Download the face model if needed and find the faces on every slide not done yet."""
    if not load_config().get("people_enabled"):
        return _err(RuntimeError("Turn on recognising people in Settings first."))
    try:
        wf.start_job("faces", None, wf.scan_people)
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True}


def _people_edit(fn, *args):
    try:
        return _people_payload(fn(*args))
    except KeyError:
        raise HTTPException(404, "No such person (the list changed meanwhile?)")


@app.patch("/api/people/{pid}")
def people_rename(pid: str, body: dict = Body(...)):
    """Name a person; a name someone else already has joins the two."""
    return _people_edit(people.rename, pid, body.get("name", ""))


@app.post("/api/people/{pid}/merge")
def people_merge(pid: str, body: dict = Body(...)):
    """`people` (ids) are the same person as this one."""
    return _people_edit(people.merge, pid, [str(x) for x in body.get("people", [])])


@app.post("/api/people/{pid}/remove")
def people_remove(pid: str, body: dict = Body(...)):
    """These faces (ids) aren't this person."""
    return _people_edit(people.remove_faces, pid, [str(x) for x in body.get("faces", [])])


@app.post("/api/people/tag")
def people_tag():
    """Send the names to Immich as tags (People/<name>) on every slide already uploaded."""
    cfg = load_config()
    if not cfg.get("immich_url") or not cfg.get("immich_key"):
        return _err(RuntimeError("Set your Immich URL and API key in Settings first."))
    try:
        wf.start_job("tag", None, wf.tag_people)
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True}


@app.get("/api/people/faces/{sid}/{gid}/{n}.jpg")
def people_face(sid: str, gid: str, n: str, v: str = ""):
    """A face, cut from the slide it is on (as it was turned when the face was found)."""
    s = _session(sid)
    entry = people.load_faces(sid).get(gid) or {}
    face = next((f for f in entry.get("faces", []) if f["id"] == f"{sid}/{gid}/{n}"), None)
    try:
        g = s.group(gid)
    except KeyError:
        face = None
    if not face:
        raise HTTPException(404)
    a = people.face_crop(im.orient(wf.fused_proxy(s, g), entry.get("rot", 0), entry.get("mirror", False)), face["box"])
    fresh = v and v == entry.get("key")
    return Response(im.to_jpeg_bytes(a, 85), media_type="image/jpeg",
                    headers={"Cache-Control": "max-age=31536000" if fresh else "no-store"})


@app.post("/api/sessions/{sid}/groups/{gid}/resuggest")
def resuggest(sid: str, gid: str, body: dict = Body(default={})):
    """Re-apply what past edits suggest for this slide (or the whole tray)."""
    with lock:
        s = _session(sid)
        targets = s.data["groups"] if body.get("all") else [s.group(gid)]
        n_applied = 0
        for g in targets:
            if g.get("reviewed") or g.get("skip") or g.get("locked") or not g.get("feat"):
                continue
            sug, n = learning.model().suggest(g["feat"], filmstock.effective(s.data, g))
            if sug:
                _remember(g, "learned")
                g["params"] = Params.from_dict({**g["params"], **sug}).to_dict()
                g["params_source"] = f"learned:{n}"
                n_applied += 1
        s.save()
    return {**_session_payload(s), "applied": n_applied}


@app.post("/api/sessions/{sid}/groups/{gid}/fit_curves")
def fit_curves(sid: str, gid: str, body: dict = Body(default={})):
    """Pull each colour channel's curve end points in to where the scan's data sits.

    The curves take over from auto restore (strength 0), so the histogram behind them is the
    scan itself. `all` fits every slide still to develop in the tray, each to its own data."""
    s = _session(sid)
    if not body.get("all"):
        _editable(s.group(gid))
    targets = [g for g in s.data["groups"] if not g.get("reviewed") and not g.get("skip") and not g.get("locked")] \
        if body.get("all") else [s.group(gid)]
    fitted = {}
    for g in targets:  # the slow part, outside the lock
        p = Params.from_dict({**g["params"], "strength": 0})
        fitted[g["id"]] = (active_scans(g), im.fit_curves(im.tone_base(wf.fused_proxy(s, g), p), p.curves))
    with lock:
        s = _session(sid)
        for fg in s.data["groups"]:
            if fg["id"] in fitted and active_scans(fg) == fitted[fg["id"]][0]:
                _remember(fg, "fit")
                fg["params"] = Params.from_dict({**fg["params"], "strength": 0, "curves": fitted[fg["id"]][1]}).to_dict()
                fg["params_source"] = "manual"
                _learn(s, fg)
        s.save()
    return {**_session_payload(s), "fitted": len(fitted)}


@app.post("/api/sessions/{sid}/groups/{gid}/neutral")
def pick_neutral(sid: str, gid: str, body: dict = Body(...)):
    """White balance from a spot that should be neutral: body {x, y} in 0..1 of the shown photo."""
    s = _session(sid)
    g = s.group(gid)
    _editable(g)
    p = Params.from_dict(g["params"])
    a = im.orient(wf.fused_proxy(s, g), g["rotation"], g.get("mirror", False))  # the preview's frame
    warmth, tint = im.neutral_balance(a, p, float(body["x"]), float(body["y"]))
    with lock:
        s = _session(sid)
        g = s.group(gid)
        _remember(g, "neutral")
        g["params"] = Params.from_dict({**g["params"], "warmth": warmth, "tint": tint}).to_dict()
        g["params_source"] = "manual"
        _learn(s, g)
        s.save()
    return _session_payload(s)


@app.post("/api/sessions/{sid}/groups/{gid}/mount")
def straighten_mount(sid: str, gid: str, body: dict = Body(default={})):
    """The slide mount's tilt (imaging.detect_mount), found and stored if it isn't yet.

    {"apply": true} straightens the photo to the mount; with "trim": true it also crops to the
    mount's window (a tighter trim than cutting dark rows and columns)."""
    s = _session(sid)
    try:
        g = s.group(gid)
    except KeyError:
        raise HTTPException(404, "Slide not found")
    if body.get("apply"):
        _editable(g)
    m = wf.mount_of(s, g)  # the slow part, outside the lock
    set_params = {}
    if body.get("apply"):
        if m["confidence"] <= 0:
            raise HTTPException(400, "No slide mount found around this photo")
        mirror = g.get("mirror", False)  # the mount was measured on the scan as it came
        set_params["angle"] = (m["angle"] if mirror else -m["angle"]) or 0.0
        if body.get("trim"):
            a = im.orient(wf.fused_proxy(s, g), g["rotation"], mirror)  # the preview's frame
            p = Params.from_dict({**g["params"], **set_params})
            box = im.mirror_box(m["box"]) if mirror else m["box"]
            set_params["crop"] = im.mount_crop(a, p, im.rotate_box(box, g["rotation"]))
    with lock:
        s = _session(sid)
        g = s.group(gid)
        if active_scans(g) == m["scans"]:
            g["mount"] = m
            if set_params:
                _remember(g, "mount")
                g["params"] = Params.from_dict({**g["params"], **set_params}).to_dict()
        s.save()
    return _session_payload(s)


@app.get("/api/sessions/{sid}/groups/{gid}/histogram")
def group_histogram(sid: str, gid: str, v: str = ""):
    """Histograms of what the tone curve works on, per channel."""
    s = _session(sid)
    try:
        g = s.group(gid)
    except KeyError:
        raise HTTPException(404)
    h = im.histogram(im.tone_base(wf.fused_proxy(s, g), Params.from_dict(g["params"])))
    fresh = v and v == tone_key(g)
    return JSONResponse(h, headers={"Cache-Control": "max-age=31536000" if fresh else "no-store"})


@app.get("/api/sessions/{sid}/groups/{gid}/preview.jpg")
def group_preview(sid: str, gid: str, size: int = 1600, before: int = 0, uncropped: int = 0, v: str = ""):
    s = _session(sid)
    try:
        g = s.group(gid)
        data = wf.preview(s, gid, min(size, 2400), bool(before), bool(uncropped))
    except KeyError:
        raise HTTPException(404)
    # Only let the browser keep it if it is the render the URL names. A preview requested while
    # an edit is still being saved renders the older settings and must not be cached as the new.
    fresh = v and v == render_key(g)
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "max-age=31536000" if fresh else "no-store"})


@app.get("/api/sessions/{sid}/groups/{gid}/full")
def full_info(sid: str, gid: str):
    """Size of the slide's full-resolution render, for 1:1 zoom; renders it (seconds) if needed.
    The zoom then loads it in TILE-pixel squares from tile.jpg."""
    s = _session(sid)
    try:
        g = s.group(gid)
        a = wf.full_image(s, gid)
    except KeyError:
        raise HTTPException(404)
    except FileNotFoundError as e:
        raise HTTPException(409, str(e))
    return {"width": a.shape[1], "height": a.shape[0], "tile": wf.TILE, "key": render_key(g)}


@app.get("/api/sessions/{sid}/groups/{gid}/tile.jpg")
def full_tile(sid: str, gid: str, col: int, row: int, v: str = ""):
    s = _session(sid)
    try:
        g = s.group(gid)
        data = wf.full_tile(s, gid, col, row)
    except KeyError:
        raise HTTPException(404)
    except FileNotFoundError as e:
        raise HTTPException(409, str(e))
    fresh = v and v == render_key(g)  # cached only when it is the render the URL names
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "max-age=31536000" if fresh else "no-store"})


@app.get("/api/sessions/{sid}/scans/{scan}/thumb.jpg")
def scan_thumb(sid: str, scan: str):
    s = _session(sid)
    if scan not in s.data["scans"]:  # e.g. asked for with the next tray's id while the UI switches trays
        raise HTTPException(404)
    return Response(wf.scan_thumb(s, scan), media_type="image/jpeg", headers={"Cache-Control": "max-age=31536000"})


@app.post("/api/sessions/{sid}/finish")
def finish(sid: str, body: dict = Body(default={})):
    """Upload to Immich. `only_ready`: just the developed slides, the rest stay to work on."""
    s = _session(sid)
    cfg = load_config()
    if not cfg.get("immich_url") or not cfg.get("immich_key"):
        return _err(RuntimeError("Set your Immich URL and API key in Settings first."))
    if not s.data["groups"]:
        return _err(RuntimeError("Nothing to upload yet."))
    try:
        only = bool(body.get("only_ready"))
        wf.start_job("upload", sid, wf.finish_session, sid, only, resume={"only_ready": only})
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True}


@app.post("/api/job/resume")
def job_resume():
    """Run the import or upload a server restart cut off again, as it was started. Both are safe to
    repeat: an import skips the scans the dedupe index has, an upload the slides Immich has."""
    job = wf.current_job
    if not job or not job.interrupted or not job.resume or not job.session:
        return _err(RuntimeError("Nothing to resume: start it again yourself."), 404)
    if job.kind == "import":
        return import_into(job.session, {"source": str(job.resume.get("source") or "")})
    return finish(job.session, {"only_ready": bool(job.resume.get("only_ready"))})


@app.post("/api/sessions/{sid}/cleanup")
def cleanup(sid: str):
    s = _session(sid)
    b = wf.cleanup_blockers(s)
    if b:
        return _err(RuntimeError("; ".join(b)))
    try:
        wf.start_job("cleanup", sid, wf.cleanup_card, sid)
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True}


@app.post("/api/eject")
def eject(body: dict = Body(...)):
    if store.user_home() is not None:
        return _err(RuntimeError("Not on a hosted server"), 403)
    try:
        return {"ok": True, "message": wf.eject(body["path"]) or "Ejected"}
    except Exception as e:
        return _err(e)


@app.post("/api/reveal")
def reveal(body: dict = Body(...)):
    """Open the session's export folder in Finder."""
    s = _session(body["session"])
    s.export_dir.mkdir(parents=True, exist_ok=True)  # doesn't exist until the first render
    # The desktop app opens it itself, through the OS shell.
    if os.uname().sysname == "Darwin" and not os.environ.get("SLIDESTATION_DESKTOP") and store.user_home() is None:
        os.system(f'open "{s.export_dir}"')
    return {"ok": True, "path": str(s.export_dir)}


@app.get("/")
def index():
    if not (WEB / "index.html").exists():
        return Response("UI not built: run `npm install && npm run build` in frontend/", status_code=500)
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})


# frontend/public: the favicons, served from the root like Vite does in development
PUBLIC = ("favicon.svg", "favicon-32.png", "apple-touch-icon.png")


@app.get("/{name}")
def public_file(name: str):
    if name not in PUBLIC or not (WEB / name).exists():
        raise HTTPException(404)
    return FileResponse(WEB / name, headers={"Cache-Control": "max-age=86400"})


# Vite emits hashed ./assets/... files, so they can be cached forever.
app.mount("/assets", StaticFiles(directory=WEB / "assets", check_dir=False), name="assets")


def main():
    import uvicorn

    port = int(os.environ.get("SLIDESTATION_PORT", "8765"))
    # this computer only, unless told otherwise (the container: 0.0.0.0, next to Immich)
    host = os.environ.get("SLIDESTATION_HOST", "127.0.0.1")
    if not os.environ.get("SLIDESTATION_NO_BROWSER"):
        threading.Timer(1.2, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    if accounts.enabled() and not store.USER_IMMICH_URL:
        raise SystemExit("SLIDESTATION_AUTH=immich needs SLIDESTATION_IMMICH_URL (the Immich accounts belong to)")
    watch.start()  # watched folders: polls every library's, also before anyone signs in
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
