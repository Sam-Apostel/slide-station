// Minimal Immich client for the browser (slidestation/immich.py): same endpoints, same v1/v2 vs
// v3 field rules. Immich only allows cross-origin requests in development builds, so this works
// when Slide Station is served from the same origin as Immich, or when the reverse proxy in front
// of Immich adds CORS headers for this page (docs: README "Slide Station in the browser").

export class ImmichError extends Error {}

// What the API key needs (slidestation/immich.py PERMISSIONS).
const PERMISSIONS =
  "asset.upload, asset.delete, album.read, album.create and albumAsset.create; for the round trip also " +
  "asset.read, asset.update, asset.view, asset.download, albumAsset.delete, stack.read, stack.create and stack.delete";

/** An Immich asset as the round trip reads it (AssetResponseDto, the fields used). */
export type Asset = {
  id: string;
  type?: string;
  originalFileName?: string;
  originalMimeType?: string;
  checksum?: string;
  isFavorite?: boolean;
  isTrashed?: boolean;
  localDateTime?: string;
  exifInfo?: {
    description?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
  } | null;
};

type Found = Record<string, { asset_id: string; trashed: boolean }>;

/** A random v4 UUID (crypto.randomUUID only exists on https pages). */
function uuid4() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class Immich {
  private base: string;
  private major: number | null = null;

  constructor(
    url: string,
    private key: string,
  ) {
    if (!url || !key) throw new ImmichError("Immich URL and API key are not set (Settings).");
    let u = url.trim().replace(/\/+$/, "");
    if (u.endsWith("/api")) u = u.slice(0, -4);
    this.base = u + "/api";
    this.key = key.trim();
  }

  /** A request; a failed fetch (offline, CORS, mixed content) is explained, HTTP errors aren't checked. */
  private async raw(method: string, path: string, body?: BodyInit | object, accept = "application/json") {
    const headers: Record<string, string> = { "x-api-key": this.key, Accept: accept };
    let payload: BodyInit | undefined;
    if (body instanceof FormData || body instanceof Blob) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    try {
      return await fetch(this.base + path, { method, headers, body: payload });
    } catch {
      throw new ImmichError(unreachable(this.base));
    }
  }

  private async check(r: Response, method: string, path: string): Promise<Response> {
    if (r.status === 401) throw new ImmichError("Immich rejected the API key (401).");
    if (r.status === 403)
      throw new ImmichError(`The API key lacks a permission for ${method} ${path} (403). Give it ${PERMISSIONS}.`);
    if (r.status >= 400)
      throw new ImmichError(`Immich ${method} ${path} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r;
  }

  private async req(method: string, path: string, body?: BodyInit | object, accept = "application/json") {
    return this.check(await this.raw(method, path, body, accept), method, path.split("?")[0]);
  }

  async version(): Promise<string> {
    const v = await (await this.req("GET", "/server/version")).json();
    this.major = Number(v.major ?? 0);
    return `${v.major}.${v.minor}.${v.patch}`;
  }

  async whoami(): Promise<string> {
    const j = await (await this.req("GET", "/users/me")).json();
    return j.name || j.email || "?";
  }

  // ---------------------------------------------------------------- albums

  async findOrCreateAlbum(name: string): Promise<string> {
    const albums = await (await this.req("GET", "/albums")).json();
    const hit = albums.find((a: { albumName: string }) => a.albumName === name);
    if (hit) return hit.id;
    return (await (await this.req("POST", "/albums", { albumName: name })).json()).id;
  }

  async addToAlbum(album: string, ids: string[]) {
    for (let i = 0; i < ids.length; i += 200)
      await this.req("PUT", `/albums/${album}/assets`, { ids: ids.slice(i, i + 200) });
  }

  async removeFromAlbum(album: string, ids: string[]) {
    await this.req("DELETE", `/albums/${album}/assets`, { ids });
  }

  /** Every album the user can see. */
  async albums(): Promise<{ id: string; albumName: string; assetCount?: number; albumThumbnailAssetId?: string }[]> {
    return (await this.req("GET", "/albums")).json();
  }

  /** Ids of the albums an asset is in (`GET /albums?assetId=`, v1 through v3). */
  async albumsOf(asset: string): Promise<string[]> {
    return (await (await this.req("GET", `/albums?assetId=${asset}`)).json()).map((a: { id: string }) => a.id);
  }

  /**
   * An album's assets. v1/v2 list them in `GET /albums/{id}`; v3 dropped that, so the album is
   * searched instead (`albumIds`, paged by `nextPage` before 3.2, `nextCursor` since).
   */
  async albumAssets(album: string): Promise<Asset[]> {
    const a = await (await this.req("GET", `/albums/${album}`)).json();
    if (a.assets?.length) return a.assets;
    const out: Asset[] = [];
    let body: Record<string, unknown> = { albumIds: [album], size: 1000, withExif: true };
    for (let i = 0; i < 1000; i++) {
      const page = (await (await this.req("POST", "/search/metadata", body)).json()).assets;
      out.push(...(page.items ?? []));
      if (page.nextCursor) {
        const { page: _p, ...rest } = body;
        body = { ...rest, cursor: page.nextCursor };
      } else if (page.nextPage) body = { ...body, page: Number(page.nextPage) };
      else break;
    }
    return out;
  }

  // ---------------------------------------------------------------- assets

  /** Upload a JPEG. Returns [asset id, created / duplicate / replaced]. */
  async upload(
    file: Blob,
    name: string,
    taken: Date,
    deviceAssetId: string,
    favorite = false,
  ): Promise<[string, string]> {
    if (this.major === null) await this.version();
    const ts = taken.toISOString().replace(/\.\d{3}Z$/, ".000Z");
    const f = new FormData();
    f.set("fileCreatedAt", ts);
    f.set("fileModifiedAt", ts);
    f.set("isFavorite", favorite ? "true" : "false");
    if ((this.major ?? 0) < 3) {
      // v1/v2 require these, v3 rejects them
      f.set("deviceAssetId", deviceAssetId);
      f.set("deviceId", "slide-station");
    } else f.set("filename", name);
    f.set("assetData", file, name);
    const j = await (await this.req("POST", "/assets", f)).json();
    return [j.id, j.status ?? "created"];
  }

  async trash(ids: string[]) {
    if (ids.length) await this.req("DELETE", "/assets", { ids, force: false });
  }

  /** Take assets back out of the trash. */
  async restore(ids: string[]) {
    if (ids.length) await this.req("POST", "/trash/restore/assets", { ids });
  }

  /** Which of these files (key -> hex SHA-1) Immich has byte for byte; empty if the server can't tell. */
  async existing(checksums: Record<string, string>): Promise<Found> {
    const assets = Object.entries(checksums).map(([id, checksum]) => ({ id, checksum }));
    if (!assets.length) return {};
    const path = "/assets/bulk-upload-check";
    const r = await this.raw("POST", path, { assets });
    if (r.status === 404 || r.status === 405) return {};
    const out: Found = {};
    for (const x of (await (await this.check(r, "POST", path)).json()).results ?? [])
      if (x.action === "reject" && x.reason === "duplicate" && x.assetId)
        out[x.id] = { asset_id: x.assetId, trashed: !!x.isTrashed };
    return out;
  }

  /** An asset's details (exifInfo, localDateTime, isFavorite…); null if it no longer exists. */
  async asset(id: string): Promise<Asset | null> {
    const r = await this.raw("GET", `/assets/${id}`);
    if (r.status === 400 || r.status === 404) return null;
    return (await this.check(r, "GET", "/assets/{id}")).json();
  }

  /** `PUT /assets/{id}`: dateTimeOriginal, description, isFavorite… (v3 marks it deprecated, no replacement). */
  async updateAsset(id: string, fields: Record<string, unknown>) {
    await this.req("PUT", `/assets/${id}`, fields);
  }

  /** The asset's original file, byte for byte as it was uploaded. */
  async download(id: string): Promise<Blob> {
    return (await this.req("GET", `/assets/${id}/original`, undefined, "application/octet-stream")).blob();
  }

  /** Immich's small thumbnail of an asset (needs asset.view). */
  async thumbnail(id: string): Promise<Blob> {
    return (await this.req("GET", `/assets/${id}/thumbnail?size=thumbnail`, undefined, "image/*")).blob();
  }

  /** Immich's own preview JPEG of an asset (needs the asset.view permission). */
  async preview(id: string): Promise<Blob> {
    return (await this.req("GET", `/assets/${id}/thumbnail?size=preview`, undefined, "image/*")).blob();
  }

  // ---------------------------------------------------------------- stacks

  /** Whether this server has stacks and the key may use them (404 before stacks, 403 without stack.read). */
  async hasStacks(): Promise<boolean> {
    return (await this.raw("GET", `/stacks?primaryAssetId=${uuid4()}`)).status === 200;
  }

  /** Stack assets, the first one the primary (the one the timeline shows); null where that can't be done. */
  async createStack(ids: string[]): Promise<string | null> {
    if (ids.length < 2) return null;
    const r = await this.raw("POST", "/stacks", { assetIds: ids });
    if ([403, 404, 405].includes(r.status)) return null;
    return (await (await this.check(r, "POST", "/stacks")).json()).id;
  }

  /** Unstack; the assets stay. A stack that is gone already is fine. */
  async deleteStack(id: string) {
    const r = await this.raw("DELETE", `/stacks/${id}`);
    if (![400, 403, 404, 405].includes(r.status)) await this.check(r, "DELETE", "/stacks/{id}");
  }
}

/** Why a fetch to Immich failed before any response: offline, mixed content, or no CORS. */
export function unreachable(base: string): string {
  const origin = (() => {
    try {
      return new URL(base).origin;
    } catch {
      return base;
    }
  })();
  if (
    location.protocol === "https:" &&
    origin.startsWith("http:") &&
    !/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin)
  )
    return `This page is served over https, so the browser won't talk to ${origin} over plain http. Use Immich's https address.`;
  return (
    `Couldn't reach Immich at ${origin} from the browser. Either it's offline, or it doesn't allow requests ` +
    `from ${location.origin} (CORS): serve Slide Station from Immich's own address, or let its reverse proxy ` +
    `allow this page — or save the slides to disk and drop them into Immich yourself.`
  );
}
