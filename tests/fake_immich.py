"""Mock Immich server for development. Run: uv run --with fastapi --with uvicorn python tests/fake_immich.py

Set MOCK_IMMICH_MAJOR=1|2|3 to test the version-dependent upload fields (v1/v2 require
deviceAssetId + deviceId, v3 rejects them). MOCK_IMMICH_CORS=1 lets other origins in (the browser
version calls Immich from the page).
"""
import os
import uuid

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request

MAJOR = int(os.environ.get("MOCK_IMMICH_MAJOR", "3"))
KEY = os.environ.get("MOCK_IMMICH_KEY", "testkey")
app = FastAPI()
if os.environ.get("MOCK_IMMICH_CORS"):
    # a real Immich only allows other origins in development builds; the browser version's test
    # (tests/web_flow.py) plays a reverse proxy that allows them
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
DB = {"albums": {}, "assets": {}, "log": []}


def auth(k):
    if k != KEY:
        raise HTTPException(401, "bad key")


@app.get("/api/server/version")
def version():
    return {"major": MAJOR, "minor": 0, "patch": 0}


@app.get("/api/users/me")
def me(x_api_key: str = Header(None)):
    auth(x_api_key)
    return {"name": "Test user", "email": "test@example.com"}


@app.get("/api/albums")
def albums(x_api_key: str = Header(None)):
    auth(x_api_key)
    return [{"id": k, "albumName": v["name"]} for k, v in DB["albums"].items()]


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
    DB["albums"][aid]["assets"] += ids
    return [{"id": i, "success": True} for i in ids]


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
    aid = str(uuid.uuid4())
    DB["assets"][aid] = {"fields": fields, "bytes": len(data), "name": form["assetData"].filename}
    return {"id": aid, "status": "created"}


@app.delete("/api/assets")
async def trash(req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    DB["log"].append(("trash", await req.json()))


TAGS = True  # False: an Immich without the tag API (404), like before v1.113


@app.put("/api/tags")
async def upsert_tags(req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    if not TAGS:
        raise HTTPException(404, "Cannot PUT /api/tags")
    tags = DB.setdefault("tags", {})
    out = []
    for name in (await req.json())["tags"]:
        tid = next((k for k, v in tags.items() if v["value"] == name), None) or str(uuid.uuid4())
        tags.setdefault(tid, {"value": name, "assets": []})
        out.append({"id": tid, "name": name.split("/")[-1], "value": name, "createdAt": "", "updatedAt": ""})
    return out


@app.put("/api/tags/{tid}/assets")
async def tag_assets(tid: str, req: Request, x_api_key: str = Header(None)):
    auth(x_api_key)
    ids = (await req.json())["ids"]
    DB["tags"][tid]["assets"] += [i for i in ids if i not in DB["tags"][tid]["assets"]]
    return [{"id": i, "success": True} for i in ids]


@app.get("/debug")
def debug():
    return DB


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("MOCK_IMMICH_PORT", "2283")))
