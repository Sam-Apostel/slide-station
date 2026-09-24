"""Mock Immich server for development. Run: uv run --with fastapi --with uvicorn python tests/fake_immich.py

Set MOCK_IMMICH_MAJOR=1|2|3 to test the version-dependent upload fields (v1/v2 require
deviceAssetId + deviceId, v3 rejects them). MOCK_IMMICH_CORS=1 lets other origins in (the browser
version calls Immich from the page). MOCK_IMMICH_USERS=ann-key,bob-key adds users with those API keys
(accounts mode: tests/hosted_flow.py).

Beyond uploads it keeps what the round trip needs: assets with their bytes, checksum, favourite,
trash flag and the description / date Immich would read from the EXIF (`PUT /assets/{id}` changes
them), albums (`GET /albums/{id}` lists its assets before v3; v3 only answers `POST /search/metadata`,
paged by `PAGE`), bulk-upload-check, originals, thumbnails (not previews: the locked-slide test
relies on the local fallback) and stacks (`STACKS = False` answers 404, like servers before them).
"""
import base64
import hashlib
import io
import os
import re
import uuid

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response

MAJOR = int(os.environ.get("MOCK_IMMICH_MAJOR", "3"))
KEY = os.environ.get("MOCK_IMMICH_KEY", "testkey")
STACKS = True  # False: a server from before stacks (404)
PAGE = 1000  # search page size cap, lowered by tests to exercise paging
TAGS = True  # False: a server without the tags API (404)
app = FastAPI()
if os.environ.get("MOCK_IMMICH_CORS"):
    # a real Immich only allows other origins in development builds; the browser version's test
    # (tests/web_flow.py) plays a reverse proxy that allows them
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
DB = {"albums": {}, "assets": {}, "stacks": {}, "data": {}, "log": []}
DENY: list[tuple[str, str]] = []  # (method, path regex) answered 403: a key without that permission


@app.middleware("http")
async def deny(request: Request, call_next):
    for method, path in DENY:
        if request.method == method and re.fullmatch(path, request.url.path):
            return JSONResponse({"message": "Missing required permission"}, status_code=403)
    return await call_next(request)


# API key -> its user (/users/me); accounts mode (tests/test_hosted.py) signs in several of them
USERS = {KEY: {"id": "5b7c3a0e-0000-4000-8000-000000000001", "name": "Test user", "email": "test@example.com"}}
for _n, _k in enumerate(filter(None, os.environ.get("MOCK_IMMICH_USERS", "").split(",")), 2):  # more keys = users
    USERS[_k] = {"id": f"5b7c3a0e-0000-4000-8000-{_n:012d}", "name": _k.split("-")[0].title(),
                 "email": f"{_k}@example.com"}


def auth(k):
    if k not in USERS:
        raise HTTPException(401, "bad key")


def _exif(data: bytes) -> tuple[str, str]:
    """(description, DateTimeOriginal as ISO) read from a JPEG, as Immich's metadata extraction would."""
    try:
        from PIL import Image

        ex = Image.open(io.BytesIO(data)).getexif()
        when = ex.get_ifd(0x8769).get(36867) or ""
        iso = f"{when[:4]}-{when[5:7]}-{when[8:10]}T{when[11:19]}" if len(when) >= 19 else ""
        return str(ex.get(270, "") or ""), iso
    except Exception:
        return "", ""


def add_asset(data: bytes, name: str = "photo.jpg", created: str = "2020-01-01T00:00:00.000Z", **extra) -> str:
    """Put an asset in as if some other tool had uploaded it; returns its id."""
    aid = str(uuid.uuid4())
    desc, when = _exif(data)
    DB["data"][aid] = data
    DB["assets"][aid] = {
        "fields": {}, "bytes": len(data), "name": name, "sha1": hashlib.sha1(data).hexdigest(),
        "type": "IMAGE", "mime": "image/png" if name.lower().endswith(".png") else "image/jpeg",
        "favorite": False, "trashed": False, "description": desc,
        "local": (when + ".000Z") if when else created, "stack": None, **extra,
    }
    return aid


def asset_dto(aid: str) -> dict:
    a = DB["assets"][aid]
    st = a.get("stack")
    return {
        "id": aid, "type": a.get("type", "IMAGE"), "originalFileName": a["name"], "originalMimeType": a.get("mime"),
        "checksum": base64.b64encode(bytes.fromhex(a["sha1"])).decode(), "isFavorite": a.get("favorite", False),
        "isTrashed": a.get("trashed", False), "localDateTime": a.get("local", ""),
        "fileCreatedAt": a["fields"].get("fileCreatedAt", a.get("local", "")),
        "exifInfo": {"description": a.get("description", ""), "dateTimeOriginal": a.get("local", "")},
        "stack": {"id": st, "primaryAssetId": DB["stacks"][st]["primary"],
                  "assetCount": len(DB["stacks"][st]["assets"])} if st in DB["stacks"] else None,
    }


def _asset(aid: str) -> dict:
    if aid not in DB["assets"]:
        raise HTTPException(404, "asset not found")
    return DB["assets"][aid]


@app.get("/api/server/version")
def version():
    return {"major": MAJOR, "minor": 0, "patch": 0}


@app.get("/api/users/me")
def me(x_api_key: str = Header(None)):
    auth(x_api_key)
    return USERS[x_api_key]


# ---------------------------------------------------------------- albums


def album_dto(aid: str, with_assets: bool = False) -> dict:
    v = DB["albums"][aid]
    out = {"id": aid, "albumName": v["name"], "assetCount": len(v["assets"]),
           "albumThumbnailAssetId": v["assets"][0] if v["assets"] else None}
    if with_assets and MAJOR < 3:  # v3 dropped the album's asset list
        out["assets"] = [asset_dto(x) for x in v["assets"] if x in DB["assets"]]
    return out


@app.get("/api/albums")
def albums(assetId: str | None = None, x_api_key: str = Header(None)):
    auth(x_api_key)
    return [album_dto(k) for k, v in DB["albums"].items() if assetId is None or assetId in v["assets"]]


@app.get("/api/albums/{aid}")
def album(aid: str, x_api_key: str = Header(None)):
    auth(x_api_key)
    if aid not in DB["albums"]:
        raise HTTPException(404, "album not found")
    return album_dto(aid, with_assets=True)


@app.post("/api/albums")
async def create_album(req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    body = await req.json()
    aid = str(uuid.uuid4())
    DB["albums"][aid] = {"name": body["albumName"], "assets": []}
    return {"id": aid}


@app.put("/api/albums/{aid}/assets")
async def add_assets(aid: str, req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    ids = (await req.json())["ids"]
    have = DB["albums"][aid]["assets"]
    out = [{"id": i, "success": i not in have} | ({} if i not in have else {"error": "duplicate"}) for i in ids]
    have += [i for i in ids if i not in have]
    return out


@app.delete("/api/albums/{aid}/assets")
async def remove_assets(aid: str, req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    ids = (await req.json())["ids"]
    have = DB["albums"][aid]["assets"]
    out = [{"id": i, "success": i in have} for i in ids]
    DB["albums"][aid]["assets"] = [i for i in have if i not in ids]
    return out


@app.post("/api/search/metadata")
async def search(req: Request, x_api_key: str = Header(None)):
    """Only what the client uses: albumIds, paged by `page` / `nextPage` before v3, `cursor` since."""
    auth(x_api_key)
    body = await req.json()
    ids = [x for a in body.get("albumIds", []) for x in DB["albums"].get(a, {"assets": []})["assets"]]
    ids = [x for x in ids if x in DB["assets"] and not DB["assets"][x].get("trashed")]
    size = min(int(body.get("size", 250)), PAGE)
    start = int(body["cursor"]) if body.get("cursor") else (int(body.get("page", 1)) - 1) * size
    items = [asset_dto(x) for x in ids[start : start + size]]
    more = start + size < len(ids)
    page = {"items": items, "count": len(items), "total": len(ids), "facets": [], "nextPage": None}
    if more:
        if MAJOR >= 3:
            page["nextCursor"] = str(start + size)
        else:
            page["nextPage"] = str(start // size + 2)
    return {"albums": {"items": [], "count": 0, "total": 0, "facets": []}, "assets": page}


# ---------------------------------------------------------------- assets


@app.post("/api/assets")
async def upload(req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    form = await req.form()
    fields = {k: v for k, v in form.items() if k != "assetData"}
    for need in ("fileCreatedAt", "fileModifiedAt"):
        if need not in fields:
            raise HTTPException(400, f"missing {need}")
    if MAJOR >= 3 and "deviceAssetId" in fields:
        raise HTTPException(400, "property deviceAssetId should not exist")
    if MAJOR < 3 and "deviceAssetId" not in fields:
        raise HTTPException(400, "deviceAssetId is required")
    data = await form["assetData"].read()
    sha = hashlib.sha1(data).hexdigest()
    for k, a in DB["assets"].items():  # Immich answers "duplicate" for bytes it has
        if a["sha1"] == sha:
            return {"id": k, "status": "duplicate"}
    aid = add_asset(data, form["assetData"].filename, fields["fileCreatedAt"],
                    favorite=fields.get("isFavorite") == "true")
    DB["assets"][aid]["fields"] = fields
    return {"id": aid, "status": "created"}


@app.post("/api/assets/bulk-upload-check")
async def bulk_upload_check(req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    results = []
    for item in (await req.json())["assets"]:
        c = item["checksum"]
        sha = c if len(c) == 40 else base64.b64decode(c).hex()
        hit = next((k for k, a in DB["assets"].items() if a["sha1"] == sha), None)
        results.append({"id": item["id"], "action": "accept"} if hit is None else {
            "id": item["id"], "action": "reject", "reason": "duplicate", "assetId": hit,
            "isTrashed": DB["assets"][hit].get("trashed", False)})
    DB["log"].append(("check", len(results)))
    return {"results": results}


@app.get("/api/assets/{aid}")
def get_asset(aid: str, x_api_key: str = Header(None)):
    auth(x_api_key)
    _asset(aid)
    return asset_dto(aid)


@app.put("/api/assets/{aid}")
async def update_asset(aid: str, req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    a = _asset(aid)
    body = await req.json()
    if "description" in body:
        a["description"] = body["description"]
    if "dateTimeOriginal" in body:  # naive local time: that's the wall clock Immich shows
        a["local"] = body["dateTimeOriginal"][:19] + ".000Z"
    if "isFavorite" in body:
        a["favorite"] = bool(body["isFavorite"])
    DB["log"].append(("update", aid, body))
    return asset_dto(aid)


@app.get("/api/assets/{aid}/original")
def original(aid: str, x_api_key: str = Header(None)):
    auth(x_api_key)
    _asset(aid)
    return Response(DB["data"][aid], media_type="application/octet-stream")


@app.get("/api/assets/{aid}/thumbnail")
def thumbnail(aid: str, size: str = "thumbnail", x_api_key: str = Header(None)):
    auth(x_api_key)
    _asset(aid)
    if size != "thumbnail":
        raise HTTPException(404, "the mock makes no previews")
    from PIL import Image

    im = Image.open(io.BytesIO(DB["data"][aid])).convert("RGB")
    im.thumbnail((250, 250))
    out = io.BytesIO()
    im.save(out, "JPEG")
    return Response(out.getvalue(), media_type="image/jpeg")


@app.delete("/api/assets")
async def trash(req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    body = await req.json()
    DB["log"].append(("trash", body))
    for aid in body["ids"]:
        if aid in DB["assets"]:
            DB["assets"][aid]["trashed"] = True


@app.post("/api/trash/restore/assets")
async def restore(req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    ids = (await req.json())["ids"]
    DB["log"].append(("restore", ids))
    for aid in ids:
        _asset(aid)["trashed"] = False
    return {"count": len(ids)}


# ---------------------------------------------------------------- stacks


def _stacks():
    if not STACKS:
        raise HTTPException(404, "Cannot GET /api/stacks")


@app.get("/api/stacks")
def search_stacks(primaryAssetId: str | None = None, x_api_key: str = Header(None)):
    auth(x_api_key)
    _stacks()
    return [{"id": k, "primaryAssetId": v["primary"], "assets": [asset_dto(x) for x in v["assets"]]}
            for k, v in DB["stacks"].items() if primaryAssetId in (None, v["primary"])]


@app.post("/api/stacks")
async def create_stack(req: Request, x_api_key: str = Header(None)):
    """Like Immich: the first asset is the primary; stacks whose primary is listed are merged in; the
    assets are moved out of whatever stack they were in."""
    auth(x_api_key)
    _stacks()
    ids = (await req.json())["assetIds"]
    if len(ids) < 2:
        raise HTTPException(400, "assetIds must contain at least 2 elements")
    for i in ids:
        _asset(i)
    merged = [k for k, v in DB["stacks"].items() if v["primary"] in ids]
    members = list(dict.fromkeys(ids + [x for k in merged for x in DB["stacks"][k]["assets"]]))
    for k in merged:
        del DB["stacks"][k]
    sid = str(uuid.uuid4())
    DB["stacks"][sid] = {"primary": ids[0], "assets": members}
    for x in members:
        old = DB["assets"][x].get("stack")
        if old in DB["stacks"] and old != sid:
            DB["stacks"][old]["assets"].remove(x)
        DB["assets"][x]["stack"] = sid
    return {"id": sid, "primaryAssetId": ids[0], "assets": [asset_dto(x) for x in members]}


@app.delete("/api/stacks/{sid}")
def delete_stack(sid: str, x_api_key: str = Header(None)):
    auth(x_api_key)
    _stacks()
    st = DB["stacks"].pop(sid, None)
    if st is None:
        raise HTTPException(400, "Not found or no stack.delete access")
    for x in st["assets"]:
        if DB["assets"].get(x, {}).get("stack") == sid:
            DB["assets"][x]["stack"] = None
    return Response(status_code=204)


@app.put("/api/tags")
async def upsert_tags(req: Request, x_api_key: str = Header(None)):
    """Tags by full value ("People/Ann" creates People and Ann under it); answers the leaf tags."""
    auth(x_api_key)
    if not TAGS:
        raise HTTPException(404, "Cannot PUT /api/tags")
    tags = DB.setdefault("tags", {})
    out = []
    for value in (await req.json())["tags"]:
        parent = None
        for i, name in enumerate(value.split("/")):
            path = "/".join(value.split("/")[: i + 1])
            if path not in tags:
                tags[path] = {"id": str(uuid.uuid4()), "name": name, "value": path, "parentId": parent, "assets": []}
            parent = tags[path]["id"]
        out.append({k: v for k, v in tags[value].items() if k != "assets"})
    return out


@app.put("/api/tags/{tid}/assets")
async def tag_one(tid: str, req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    ids = (await req.json())["ids"]
    tag = next(t for t in DB["tags"].values() if t["id"] == tid)
    tag["assets"] = sorted(set(tag["assets"]) | set(ids))
    return [{"id": i, "success": True} for i in ids]


@app.put("/api/tags/assets")
async def tag_assets(req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    body = await req.json()
    by_id = {t["id"]: t for t in DB.setdefault("tags", {}).values()}
    for tid in body["tagIds"]:
        by_id[tid]["assets"] = sorted(set(by_id[tid]["assets"]) | set(body["assetIds"]))
    return {"count": len(body["assetIds"]) * len(body["tagIds"])}


@app.get("/debug")
def debug():
    return {k: v for k, v in DB.items() if k != "data"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("MOCK_IMMICH_PORT", "2283")))
