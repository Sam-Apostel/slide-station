"""Minimal Immich API client (works with Immich v1.118+ through v3)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import httpx


class ImmichError(RuntimeError):
    pass


# What the API key needs. Uploading needs the first part; the rest is for the round trip (metadata
# sync, pulling back in, duplicates, stacks), and each of those says so when it's missing.
PERMISSIONS = ("asset.upload, asset.delete, album.read, album.create and albumAsset.create; for the round trip "
               "also asset.read, asset.update, asset.view, asset.download, albumAsset.delete, stack.read, "
               "stack.create and stack.delete")


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
            raise ImmichError(f"The API key lacks a permission for {r.request.method} {r.request.url.path} (403). "
                              f"Give it {PERMISSIONS}.")
        if r.status_code >= 400:
            raise ImmichError(f"Immich {r.request.method} {r.request.url.path} failed: {r.status_code} {r.text[:300]}")
        return r

    def version(self) -> str:
        r = self._check(self.client.get(self.base + "/server/version"))
        v = r.json()
        self._major = int(v.get("major", 0))
        return f'{v.get("major")}.{v.get("minor")}.{v.get("patch")}'

    def whoami(self) -> str:
        j = self.me()
        return j.get("name") or j.get("email") or "?"

    def me(self) -> dict:
        """The key's user: {"id", "name", "email", ...} (every version has id, name and email)."""
        return self._check(self.client.get(self.base + "/users/me")).json()

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

    def remove_from_album(self, album_id: str, asset_ids: list[str]) -> None:
        self._check(self.client.request("DELETE", f"{self.base}/albums/{album_id}/assets", json={"ids": asset_ids}))

    def albums(self) -> list[dict]:
        """Every album the user can see: [{"id", "albumName", "assetCount", "albumThumbnailAssetId", ...}]."""
        return self._check(self.client.get(self.base + "/albums")).json()

    def albums_of(self, asset_id: str) -> list[str]:
        """Ids of the albums an asset is in (`GET /albums?assetId=`, v1 through v3)."""
        r = self._check(self.client.get(self.base + "/albums", params={"assetId": asset_id}))
        return [a["id"] for a in r.json()]

    def album_assets(self, album_id: str) -> list[dict]:
        """The assets in an album. v1/v2 list them in `GET /albums/{id}`; v3 dropped that, so the
        album is searched instead (`albumIds`, paged by `nextPage` before 3.2, `nextCursor` since)."""
        album = self._check(self.client.get(f"{self.base}/albums/{album_id}")).json()
        if album.get("assets"):
            return album["assets"]
        out, body = [], {"albumIds": [album_id], "size": 1000, "withExif": True}
        for _ in range(1000):  # 1000 pages of 1000: more than any album
            page = self._check(self.client.post(self.base + "/search/metadata", json=body)).json()["assets"]
            out += page.get("items", [])
            if page.get("nextCursor"):
                body = {**{k: v for k, v in body.items() if k != "page"}, "cursor": page["nextCursor"]}
            elif page.get("nextPage"):
                body = {**body, "page": int(page["nextPage"])}
            else:
                break
        return out

    # ------------------------------------------------------------------ tags
    def tag_each(self, tags: dict[str, list[str]]) -> None:
        """Put scene tags on assets, {tag: [asset ids]}, creating the tags that don't exist yet
        (`PUT /tags` upserts). Needs tag.create and tag.asset; Immich before v1.113 has no tag API."""
        if not tags:
            return
        r = self.client.put(self.base + "/tags", json={"tags": sorted(tags)})
        if r.status_code == 404:
            raise ImmichError("this Immich has no tag API; update it to v1.113 or later")
        if r.status_code == 403:
            raise ImmichError("the API key needs the tag.create and tag.asset permissions")
        ids = {t.get("value") or t.get("name"): t["id"] for t in self._check(r).json()}
        for name, assets in tags.items():
            if name not in ids:
                continue
            for i in range(0, len(assets), 200):
                r = self.client.put(f"{self.base}/tags/{ids[name]}/assets", json={"ids": assets[i : i + 200]})
                if r.status_code == 403:
                    raise ImmichError("the API key needs the tag.asset permission")
                self._check(r)

    # ------------------------------------------------------------------ assets
    def upload(self, path: str, taken: datetime, device_asset_id: str, favorite: bool = False) -> tuple[str, str]:
        """Upload a JPEG. Returns (asset_id, status) where status is created/duplicate/replaced."""
        ts = taken.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        fields = {"fileCreatedAt": ts, "fileModifiedAt": ts, "isFavorite": "true" if favorite else "false",
                  "filename": os.path.basename(path)}
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

    def restore(self, asset_ids: list[str]) -> None:
        """Take assets back out of the trash."""
        if asset_ids:
            self._check(self.client.post(self.base + "/trash/restore/assets", json={"ids": asset_ids}))

    def existing(self, checksums: dict[str, str]) -> dict[str, dict]:
        """Which of these files (key -> hex SHA-1) Immich already has, byte for byte:
        {key: {"asset_id", "trashed"}}. Empty if the server can't tell (no bulk-upload-check)."""
        if not checksums:
            return {}
        items = [{"id": k, "checksum": v} for k, v in checksums.items()]
        r = self.client.post(self.base + "/assets/bulk-upload-check", json={"assets": items})
        if r.status_code in (404, 405):
            return {}
        out = {}
        for x in self._check(r).json().get("results", []):
            if x.get("action") == "reject" and x.get("reason") == "duplicate" and x.get("assetId"):
                out[x["id"]] = {"asset_id": x["assetId"], "trashed": bool(x.get("isTrashed"))}
        return out

    def asset(self, asset_id: str) -> dict | None:
        """An asset's details (exifInfo, localDateTime, isFavorite, ...); None if it no longer exists."""
        r = self.client.get(f"{self.base}/assets/{asset_id}")
        if r.status_code in (400, 404):
            return None
        return self._check(r).json()

    def update_asset(self, asset_id: str, **fields) -> None:
        """`PUT /assets/{id}`: dateTimeOriginal, description, isFavorite… (v1 through v3; v3 marks it
        deprecated but has no replacement)."""
        self._check(self.client.put(f"{self.base}/assets/{asset_id}", json=fields))

    def download(self, asset_id: str, dest: str) -> None:
        """The asset's original file, byte for byte as it was uploaded."""
        with self.client.stream("GET", f"{self.base}/assets/{asset_id}/original") as r:
            if r.status_code >= 400:
                r.read()
                self._check(r)
            with open(dest, "wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)

    def thumbnail(self, asset_id: str) -> bytes:
        """Immich's small thumbnail of an asset (needs asset.view)."""
        r = self._check(self.client.get(f"{self.base}/assets/{asset_id}/thumbnail", params={"size": "thumbnail"}))
        return r.content

    def preview(self, asset_id: str) -> bytes:
        """Immich's own preview JPEG of an asset (needs the asset.view permission)."""
        r = self._check(self.client.get(f"{self.base}/assets/{asset_id}/thumbnail", params={"size": "preview"}))
        return r.content

    # ------------------------------------------------------------------ stacks
    def has_stacks(self) -> bool:
        """Whether this server has stacks and the key may use them. Servers before stacks answer
        404, a key without stack.read 403: either way nothing is stacked."""
        r = self.client.get(self.base + "/stacks", params={"primaryAssetId": str(uuid.uuid4())})
        return r.status_code == 200

    def create_stack(self, asset_ids: list[str]) -> str | None:
        """Stack assets; the first one is the primary, the one the timeline shows. (An asset that is
        the primary of another stack brings that stack along: Immich merges them.)"""
        if len(asset_ids) < 2:
            return None
        r = self.client.post(self.base + "/stacks", json={"assetIds": asset_ids})
        if r.status_code in (403, 404, 405):  # no stacks here, or a key without stack.create: unstacked
            return None
        return self._check(r).json()["id"]

    def delete_stack(self, stack_id: str) -> None:
        """Unstack; the assets stay. A stack that is gone already is fine."""
        r = self.client.request("DELETE", f"{self.base}/stacks/{stack_id}")
        if r.status_code not in (400, 403, 404, 405):  # 403: stack.delete missing, Immich merges instead
            self._check(r)
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
