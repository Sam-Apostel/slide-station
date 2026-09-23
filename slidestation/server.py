"""HTTP API + static UI. Run with:  python -m slidestation"""
from __future__ import annotations

import os
import threading
import webbrowser
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import learning
from . import workflow as wf
from . import imaging as im
from .imaging import Params
from .immich import Immich, ImmichError
from .store import (Session, active_scans, group_status, load_config, lock, render_key, save_config, summary,
                    tone_key)

app = FastAPI(title="Slide Station")
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
    }


@app.post("/api/config")
def set_config(body: dict = Body(...)):
    cfg = load_config()
    for k in ("library", "immich_url", "immich_key", "keep_originals", "keep_exports", "jpeg_quality",
              "learning_enabled"):
        if k in body and not (k == "immich_key" and body[k] == ""):
            cfg[k] = body[k]
    save_config(cfg)
    return {"ok": True}


@app.post("/api/immich/test")
def immich_test(body: dict = Body(default={})):
    cfg = load_config()
    try:
        c = Immich(body.get("immich_url") or cfg["immich_url"], body.get("immich_key") or cfg["immich_key"])
        v = c.version()
        who = c.whoami()
        c.close()
        return {"ok": True, "message": f"Connected to Immich {v} as {who}"}
    except Exception as e:
        return {"ok": False, "message": str(e)}


# --------------------------------------------------------------------------- sessions


def _learn(s: Session, g: dict) -> None:
    """Remember an approved slide's settings; drop it again if it gets skipped."""
    if not load_config().get("learning_enabled", True) or not g.get("feat"):
        return
    key = f"{s.id}:{g['id']}"
    if g.get("skip"):
        learning.model().forget(key)
    elif g.get("reviewed") or g.get("immich"):
        learning.model().remember(key, g["feat"], g["params"])


def _session_payload(s: Session) -> dict:
    d = s.data
    groups = []
    for i, g in enumerate(d["groups"]):
        groups.append({
            **{k: g[k] for k in ("id", "scans", "excluded", "rotation", "rot_reason", "params", "reviewed", "skip")},
            "params_source": g.get("params_source", ""),
            "status": group_status(g),
            "active": active_scans(g),
            "key": render_key(g),  # preview cache key: the UI must use this, not its own guess
            "tone_key": tone_key(g),  # histogram cache key
            "index": i,
        })
    return {
        "summary": summary(d),
        "defaults": d["defaults"],
        "groups": groups,
        "cleanup_blockers": wf.cleanup_blockers(s),
        "log": d.get("log", [])[-20:],
    }


@app.post("/api/sessions")
def create_session(body: dict = Body(...)):
    s = Session.create(body.get("name", "").strip(), (body.get("album") or "").strip() or None, body.get("date", "").strip())
    return {"id": s.id}


@app.get("/api/sessions/{sid}")
def get_session(sid: str):
    s = _session(sid)
    wf.active_session = sid  # the background renderer works on the tray you're looking at
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
        s.save()
    return _session_payload(s)


@app.post("/api/sessions/{sid}/import")
def import_into(sid: str, body: dict = Body(...)):
    _session(sid)
    try:
        wf.start_job("import", sid, wf.import_scans, sid, body["source"])
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True}


@app.patch("/api/sessions/{sid}/groups/{gid}")
def patch_group(sid: str, gid: str, body: dict = Body(...)):
    with lock:
        s = _session(sid)
        g = s.group(gid)
        if "rotation" in body:
            g["rotation"] = int(body["rotation"]) % 360
            g["rot_reason"] = "manual"
        if "params" in body:
            g["params"] = Params.from_dict({**g["params"], **body["params"]}).to_dict()
            g["params_source"] = "manual"
        for k in ("reviewed", "skip"):
            if k in body:
                g[k] = bool(body[k])
        _learn(s, g)
        if "excluded" in body:
            g["excluded"] = [x for x in body["excluded"] if x in g["scans"]]
            if len(g["excluded"]) >= len(g["scans"]):
                g["excluded"] = g["scans"][1:]
        s.save()
    return _session_payload(s)


@app.post("/api/sessions/{sid}/groups/{gid}/split")
def split_group(sid: str, gid: str, body: dict = Body(...)):
    """Split before the given scan: scans from that one on become a new slide."""
    with lock:
        s = _session(sid)
        g = s.group(gid)
        at = g["scans"].index(body["scan"])
        if at == 0:
            return _session_payload(s)
        tail = s.new_group(g["scans"][at:], g["rotation"], g["rot_reason"])
        tail["params"] = dict(g["params"])
        tail["excluded"] = [x for x in g.get("excluded", []) if x in tail["scans"]]
        g["scans"] = g["scans"][:at]
        g["excluded"] = [x for x in g.get("excluded", []) if x in g["scans"]]
        s.data["groups"].insert(s.group_index(gid) + 1, tail)
        s.save()
    return _session_payload(s)


@app.post("/api/sessions/{sid}/groups/{gid}/merge_next")
def merge_next(sid: str, gid: str):
    with lock:
        s = _session(sid)
        i = s.group_index(gid)
        if i + 1 >= len(s.data["groups"]):
            raise HTTPException(400, "No next slide to merge with")
        nxt = s.data["groups"].pop(i + 1)
        g = s.data["groups"][i]
        g["scans"] += nxt["scans"]
        g["excluded"] += nxt.get("excluded", [])
        if nxt.get("immich"):
            s.data.setdefault("orphan_assets", []).append(nxt["immich"]["asset_id"])
        s.save()
    return _session_payload(s)


@app.post("/api/sessions/{sid}/apply")
def apply_params(sid: str, body: dict = Body(...)):
    """Copy colour settings to other slides. scope: 'rest' (following unreviewed), 'unreviewed', 'all'."""
    with lock:
        s = _session(sid)
        p = Params.from_dict(body["params"]).to_dict()
        start = s.group_index(body["from"]) if body.get("from") else 0
        for i, g in enumerate(s.data["groups"]):
            if body.get("scope") == "all" or (not g["reviewed"] and (body.get("scope") != "rest" or i > start)):
                g["params"] = dict(p)
        if body.get("as_default"):
            s.data["defaults"] = dict(p)
        s.save()
    return _session_payload(s)


@app.get("/api/learning")
def learning_stats():
    return {**learning.model().stats(), "enabled": load_config().get("learning_enabled", True)}


@app.post("/api/learning/reset")
def learning_reset():
    learning.reset()
    return {"ok": True}


@app.post("/api/sessions/{sid}/groups/{gid}/resuggest")
def resuggest(sid: str, gid: str, body: dict = Body(default={})):
    """Re-apply what past edits suggest for this slide (or the whole tray)."""
    with lock:
        s = _session(sid)
        targets = s.data["groups"] if body.get("all") else [s.group(gid)]
        n_applied = 0
        for g in targets:
            if g.get("reviewed") or g.get("skip") or not g.get("feat"):
                continue
            sug, n = learning.model().suggest(g["feat"])
            if sug:
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
    targets = [g for g in s.data["groups"] if not g.get("reviewed") and not g.get("skip")] if body.get("all") \
        else [s.group(gid)]
    fitted = {}
    for g in targets:  # the slow part, outside the lock
        p = Params.from_dict({**g["params"], "strength": 0})
        fitted[g["id"]] = (active_scans(g), im.fit_curves(im.tone_base(wf.fused_proxy(s, g), p), p.curves))
    with lock:
        s = _session(sid)
        for fg in s.data["groups"]:
            if fg["id"] in fitted and active_scans(fg) == fitted[fg["id"]][0]:
                fg["params"] = Params.from_dict({**fg["params"], "strength": 0, "curves": fitted[fg["id"]][1]}).to_dict()
                fg["params_source"] = "manual"
                _learn(s, fg)
        s.save()
    return {**_session_payload(s), "fitted": len(fitted)}


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
def group_preview(sid: str, gid: str, size: int = 1600, before: int = 0, v: str = ""):
    s = _session(sid)
    try:
        g = s.group(gid)
        data = wf.preview(s, gid, min(size, 2400), bool(before))
    except KeyError:
        raise HTTPException(404)
    # Only let the browser keep it if it is the render the URL names. A preview requested while
    # an edit is still being saved renders the older settings and must not be cached as the new.
    fresh = v and v == render_key(g)
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "max-age=31536000" if fresh else "no-store"})


@app.get("/api/sessions/{sid}/scans/{scan}/thumb.jpg")
def scan_thumb(sid: str, scan: str):
    return Response(wf.scan_thumb(_session(sid), scan), media_type="image/jpeg", headers={"Cache-Control": "max-age=31536000"})


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
        wf.start_job("upload", sid, wf.finish_session, sid, bool(body.get("only_ready")))
    except RuntimeError as e:
        return _err(e, 409)
    return {"ok": True}


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
    if os.uname().sysname == "Darwin" and not os.environ.get("SLIDESTATION_DESKTOP"):
        os.system(f'open "{s.export_dir}"')
    return {"ok": True, "path": str(s.export_dir)}


@app.get("/")
def index():
    if not (WEB / "index.html").exists():
        return Response("UI not built: run `npm install && npm run build` in frontend/", status_code=500)
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})


# Vite emits hashed ./assets/... files, so they can be cached forever.
app.mount("/assets", StaticFiles(directory=WEB / "assets", check_dir=False), name="assets")


def main():
    import uvicorn

    port = int(os.environ.get("SLIDESTATION_PORT", "8765"))
    if not os.environ.get("SLIDESTATION_NO_BROWSER"):
        threading.Timer(1.2, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
