"""Minimal Immich API client (works with Immich v1.118+ through v3)."""
from __future__ import annotations

import os
from datetime import datetime, timezone

import httpx


class ImmichError(RuntimeError):
    pass


class Immich:
    def __init__(self, url: str, key: str):
        if not url or not key:
            raise ImmichError("Immich URL and API key are not set (Settings).")
        url = url.strip().rstrip("/")
        if url.endswith("/api"):
            url = url[:-4]
        self.base = url + "/api"
        self.client = httpx.Client(headers={"x-api-key": key.strip(), "Accept": "application/json"}, timeout=120)
        self._major: int | None = None

    def close(self):
        self.client.close()

    def _check(self, r: httpx.Response) -> httpx.Response:
        if r.status_code == 401:
            raise ImmichError("Immich rejected the API key (401).")
        if r.status_code == 403:
            raise ImmichError(f"The API key lacks a permission for {r.request.url.path} (403). "
                              "Give it asset.upload, asset.delete, album.read, album.create and albumAsset.create.")
        if r.status_code >= 400:
            raise ImmichError(f"Immich {r.request.method} {r.request.url.path} failed: {r.status_code} {r.text[:300]}")
        return r

    def version(self) -> str:
        r = self._check(self.client.get(self.base + "/server/version"))
        v = r.json()
        self._major = int(v.get("major", 0))
        return f'{v.get("major")}.{v.get("minor")}.{v.get("patch")}'

    def whoami(self) -> str:
        r = self._check(self.client.get(self.base + "/users/me"))
        j = r.json()
        return j.get("name") or j.get("email") or "?"

    @property
    def major(self) -> int:
        if self._major is None:
            self.version()
        return self._major or 0

    # ------------------------------------------------------------------ albums
    def find_or_create_album(self, name: str) -> str:
        r = self._check(self.client.get(self.base + "/albums"))
        for a in r.json():
            if a.get("albumName") == name:
                return a["id"]
        r = self._check(self.client.post(self.base + "/albums", json={"albumName": name}))
        return r.json()["id"]

    def add_to_album(self, album_id: str, asset_ids: list[str]) -> None:
        for i in range(0, len(asset_ids), 200):
            self._check(self.client.put(f"{self.base}/albums/{album_id}/assets", json={"ids": asset_ids[i : i + 200]}))

    # ------------------------------------------------------------------ assets
    def upload(self, path: str, taken: datetime, device_asset_id: str) -> tuple[str, str]:
        """Upload a JPEG. Returns (asset_id, status) where status is created/duplicate/replaced."""
        ts = taken.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        fields = {"fileCreatedAt": ts, "fileModifiedAt": ts, "isFavorite": "false", "filename": os.path.basename(path)}
        if self.major < 3:  # v1/v2 require these, v3 rejects them
            fields.update({"deviceAssetId": device_asset_id, "deviceId": "slide-station"})
            fields.pop("filename")
        with open(path, "rb") as f:
            r = self.client.post(self.base + "/assets", data=fields,
                                 files={"assetData": (os.path.basename(path), f, "image/jpeg")})
        j = self._check(r).json()
        return j["id"], j.get("status", "created")

    def trash(self, asset_ids: list[str]) -> None:
        if asset_ids:
            self._check(self.client.request("DELETE", self.base + "/assets", json={"ids": asset_ids, "force": False}))

    def preview(self, asset_id: str) -> bytes:
        """Immich's own preview JPEG of an asset (needs the asset.view permission)."""
        r = self._check(self.client.get(f"{self.base}/assets/{asset_id}/thumbnail", params={"size": "preview"}))
        return r.content

    # ------------------------------------------------------------------ tags
    tags_supported: bool | None = None  # None until tried; False on a server without the tags API
    NO_TAG_PERMISSION = "The API key can't tag photos (403): give it tag.create and tag.asset to send names."

    def tag_assets(self, names: list[str], asset_ids: list[str]) -> int:
        """Tag assets with each of `names`, full tag values ("People/Ann" is Ann under People), creating
        the tags that don't exist yet. Returns how many assets were tagged. A server without the tags
        API is skipped (0), not an error; a key without the tag permissions is (ImmichError)."""
        if not names or not asset_ids or self.tags_supported is False:
            return 0
        r = self.client.put(self.base + "/tags", json={"tags": names})  # upsert, answers the leaf tags
        if r.status_code in (404, 405):
            self.tags_supported = False
            return 0
        if r.status_code == 403:
            raise ImmichError(self.NO_TAG_PERMISSION)
        self.tags_supported = True
        tags = self._check(r).json()
        ids = [t["id"] for t in tags if t.get("value") in names] or [t["id"] for t in tags]
        for i in range(0, len(asset_ids), 200):
            r = self.client.put(self.base + "/tags/assets", json={"tagIds": ids, "assetIds": asset_ids[i : i + 200]})
            if r.status_code == 403:
                raise ImmichError(self.NO_TAG_PERMISSION)
            self._check(r)
        return len(asset_ids)
