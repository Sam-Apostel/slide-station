"""Mock Immich server for development. Run: uv run --with fastapi --with uvicorn python tests/fake_immich.py

Set MOCK_IMMICH_MAJOR=1|2|3 to test the version-dependent upload fields (v1/v2 require
deviceAssetId + deviceId, v3 rejects them).
"""
import os
import uuid

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request

MAJOR = int(os.environ.get("MOCK_IMMICH_MAJOR", "3"))
KEY = os.environ.get("MOCK_IMMICH_KEY", "testkey")
app = FastAPI()
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


@app.get("/debug")
def debug():
    return DB


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("MOCK_IMMICH_PORT", "2283")))
