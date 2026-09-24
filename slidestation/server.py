"""HTTP API + static UI. Run with:  python -m slidestation"""
from __future__ import annotations

import json
import os
import threading
import time
import webbrowser
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import learning
from . import people
from . import workflow as wf
from . import imaging as im
from .imaging import Params
from .immich import Immich, ImmichError
from .store import (Session, active_scans, load_config, lock, parse_date, render_key, save_config, slide_dates,
                    statuses, summary, tone_key)

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
              "learning_enabled", "people_enabled"):
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


FRAMING = {"angle": 0.0, "crop": None}


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
    dates = slide_dates(d)
    st = statuses(d)
    for i, g in enumerate(d["groups"]):
        groups.append({
            **{k: g[k] for k in ("id", "scans", "excluded", "rotation", "rot_reason", "params", "reviewed", "skip")},
            "params_source": g.get("params_source", ""),
            "auto_excluded": g.get("auto_excluded", {}),  # scan -> "blurry" / "clipped"
            # original scans deleted after upload: read-only, Immich has the final version
            "locked": bool(g.get("locked")),
            "status": st[i],
            "date": g.get("date", ""),
            "caption": g.get("caption", ""),
            "date_est": dates[i],  # {"value", "source": own|between|near|tray|scan, "from": [indices]}
            "active": active_scans(g),
            "key": render_key(g),  # preview cache key: the UI must use this, not its own guess
            "tone_key": tone_key(g),  # histogram cache key
            "can_undo": bool((g.get("history") or {}).get("undo")),
            "can_redo": bool((g.get("history") or {}).get("redo")),
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


HISTORY_MAX = 60
COALESCE_S = 1.5  # edits to the same settings closer together than this are one undo step


def _snapshot(g: dict) -> dict:
    return {"params": json.loads(json.dumps(g["params"])), "rotation": g["rotation"],
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
    g["params"], g["rotation"] = snap["params"], snap["rotation"]
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
            g["rotation"] = int(body["rotation"]) % 360
            g["rot_reason"] = "manual"
        if "params" in body:
            g["params"] = Params.from_dict({**g["params"], **body["params"]}).to_dict()
            g["params_source"] = "manual"
        for k in ("reviewed", "skip"):
            if k in body:
                g[k] = bool(body[k])
        if "date" in body:
            g["date"] = _clean_date(body["date"])
        if "caption" in body:
            g["caption"] = str(body["caption"]).strip()[:2000]
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


@app.post("/api/sessions/{sid}/groups/{gid}/split")
def split_group(sid: str, gid: str, body: dict = Body(...)):
    """Split before the given scan: scans from that one on become a new slide."""
    with lock:
        s = _session(sid)
        g = s.group(gid)
        _editable(g)
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
        _editable(s.data["groups"][i])
        _editable(s.data["groups"][i + 1])
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
    a = people.face_crop(im.rotate_arr(wf.fused_proxy(s, g), entry.get("rot", 0)), face["box"])
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
            sug, n = learning.model().suggest(g["feat"])
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
    a = im.rotate_arr(wf.fused_proxy(s, g), g["rotation"])  # the preview's frame
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
    if not os.environ.get("SLIDESTATION_NO_BROWSER"):
        threading.Timer(1.2, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
