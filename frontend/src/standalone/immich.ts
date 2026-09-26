// Minimal Immich client for the browser (slidestation/immich.py): same endpoints, same v1/v2 vs
// v3 field rules. Immich only allows cross-origin requests in development builds, so this works
// when Slide Station is served from the same origin as Immich, or when the reverse proxy in front
// of Immich adds CORS headers for this page (docs: README "Slide Station in the browser").
import { pyRound } from "./clip";

export class ImmichError extends Error {}
/** Immich hasn't computed this asset's CLIP embedding yet (its machine learning runs after upload). */
export class NotIndexed extends ImmichError {}
/** This Immich can't search by image: older than `queryAssetId`, or smart search is turned off. */
export class Unsupported extends ImmichError {}

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
  fileCreatedAt?: string;
  createdAt?: string; // when it was uploaded to Immich
  width?: number | null;
  height?: number | null;
  exifInfo?: {
    exifImageWidth?: number | null;
    exifImageHeight?: number | null;
    description?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
  } | null;
};

/** An Immich person (PersonResponseDto, the fields used). */
export type ImmichPerson = { id: string; name?: string; birthDate?: string | null; isHidden?: boolean };

/** A face on an asset (AssetFaceResponseDto): its box in pixels of an imageWidth × imageHeight picture. */
export type ImmichFace = {
  id: string;
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
  imageWidth: number;
  imageHeight: number;
  person?: { id: string; name?: string } | null;
  sourceType?: string;
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
    const hit = (await this.albums()).find((a) => a.albumName === name);
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

  /** Every album the user can see: `GET /albums` answers the user's own, albums others shared with
   *  them only come with `shared=true`. */
  async albums(): Promise<{ id: string; albumName: string; assetCount?: number; albumThumbnailAssetId?: string }[]> {
    const out = new Map<string, { id: string; albumName: string; assetCount?: number; albumThumbnailAssetId?: string }>();
    for (const path of ["/albums", "/albums?shared=true"])
      for (const a of await (await this.req("GET", path)).json()) if (!out.has(a.id)) out.set(a.id, a);
    return [...out.values()];
  }

  /** One album, null when it is gone or this key can't see it. */
  async album(id: string): Promise<{ id: string; albumName: string } | null> {
    const r = await this.raw("GET", `/albums/${id}${(this.major ?? 0) >= 3 ? "" : "?withoutAssets=true"}`);
    if ([400, 403, 404].includes(r.status)) return null;
    return (await this.check(r, "GET", "/albums/{id}")).json();
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

  // ---------------------------------------------------------------- search, tags

  /**
   * The assets nearest to this one by Immich's own CLIP embeddings, nearest first, no distances
   * (`POST /search/smart {"queryAssetId"}`, needs asset.read). NotIndexed while Immich hasn't embedded
   * it yet; Unsupported when the server rejects the field (older) or smart search is off.
   */
  async similarAssets(id: string, size = 8): Promise<Asset[]> {
    const r = await this.raw("POST", "/search/smart", { queryAssetId: id, size });
    if (r.status === 400) {
      const text = await r.text();
      if (text.toLowerCase().includes("embedding")) throw new NotIndexed(`Immich hasn't indexed ${id} yet`);
      throw new Unsupported(`smart search by image: ${text.slice(0, 200)}`);
    }
    if ([404, 405, 501].includes(r.status)) throw new Unsupported(`smart search by image: ${r.status}`);
    return (await (await this.check(r, "POST", "/search/smart")).json()).assets?.items ?? [];
  }

  /** Photos taken in a time window (ISO timestamps), one page of at most `size`. */
  async takenBetween(after: string, before: string, size = 200): Promise<Asset[]> {
    const body = { takenAfter: after, takenBefore: before, size: Math.min(size, 1000), type: "IMAGE" };
    return ((await (await this.req("POST", "/search/metadata", body)).json()).assets?.items ?? []).slice(0, size);
  }

  /** Scene tags on assets, {tag: [asset ids]}, creating the tags that don't exist yet (`PUT /tags`
   *  upserts). Needs tag.create and tag.asset; Immich before v1.113 has no tag API. */
  async tagEach(tags: Record<string, string[]>) {
    const names = Object.keys(tags).sort();
    if (!names.length) return;
    const r = await this.raw("PUT", "/tags", { tags: names });
    if (r.status === 404) throw new ImmichError("this Immich has no tag API; update it to v1.113 or later");
    if (r.status === 403) throw new ImmichError("the API key needs the tag.create and tag.asset permissions");
    const ids = new Map<string, string>(
      (await (await this.check(r, "PUT", "/tags")).json()).map((t: { value?: string; name?: string; id: string }) => [
        t.value || t.name,
        t.id,
      ]),
    );
    for (const [name, assets] of Object.entries(tags)) {
      const id = ids.get(name);
      if (!id) continue;
      for (let i = 0; i < assets.length; i += 200) {
        const q = await this.raw("PUT", `/tags/${id}/assets`, { ids: assets.slice(i, i + 200) });
        if (q.status === 403) throw new ImmichError("the API key needs the tag.asset permission");
        await this.check(q, "PUT", "/tags/{id}/assets");
      }
    }
  }

  /** Take the tag `name` (its full value) off these assets; a tag that doesn't exist is fine. */
  async untagAssets(name: string, assets: string[]) {
    if (!assets.length || this.tagsSupported === false) return;
    const r = await this.raw("GET", "/tags");
    if (r.status === 404 || r.status === 405) {
      this.tagsSupported = false;
      return;
    }
    const tag = ((await (await this.check(r, "GET", "/tags")).json()) as { id: string; value?: string }[]).find(
      (t) => t.value === name,
    );
    if (!tag) return;
    for (let i = 0; i < assets.length; i += 200) {
      const q = await this.raw("DELETE", `/tags/${tag.id}/assets`, { ids: assets.slice(i, i + 200) });
      if (q.status === 403)
        throw new ImmichError("The API key can't tag photos (403): give it tag.create and tag.asset to send names.");
      await this.check(q, "DELETE", "/tags/{id}/assets");
    }
  }

  /** Undefined until tried; false on a server without the tags API. */
  tagsSupported: boolean | undefined;

  /**
   * Tag assets with each of `names`, full tag values ("People/Ann" is Ann under People), creating
   * the tags that don't exist yet (immich.tag_assets). Returns how many assets were tagged; a server
   * without the tags API is skipped (0), a key without the tag permissions is an error.
   */
  async tagAssets(names: string[], assets: string[]): Promise<number> {
    if (!names.length || !assets.length || this.tagsSupported === false) return 0;
    const noPermission = "The API key can't tag photos (403): give it tag.create and tag.asset to send names.";
    const r = await this.raw("PUT", "/tags", { tags: names });
    if (r.status === 404 || r.status === 405) {
      this.tagsSupported = false;
      return 0;
    }
    if (r.status === 403) throw new ImmichError(noPermission);
    this.tagsSupported = true;
    const tags: { id: string; value?: string }[] = await (await this.check(r, "PUT", "/tags")).json();
    const ids = tags.filter((t) => names.includes(t.value ?? "")).map((t) => t.id);
    const tagIds = ids.length ? ids : tags.map((t) => t.id);
    for (let i = 0; i < assets.length; i += 200) {
      const q = await this.raw("PUT", "/tags/assets", { tagIds, assetIds: assets.slice(i, i + 200) });
      if (q.status === 403) throw new ImmichError(noPermission);
      await this.check(q, "PUT", "/tags/assets");
    }
    return assets.length;
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

  // ---------------------------------------------------------------- people & faces

  static NO_PEOPLE_PERMISSION =
    "The API key can't manage people (403): give it person.read, person.create, " +
    "person.update, person.merge, face.read, face.create, face.update and face.delete.";

  private async peopleCheck(r: Response, method: string, path: string): Promise<Response> {
    if (r.status === 403) throw new ImmichError(Immich.NO_PEOPLE_PERMISSION);
    return this.check(r, method, path);
  }

  /** Everyone Immich knows, hidden people too (immich.people). */
  async people(): Promise<ImmichPerson[]> {
    const out: ImmichPerson[] = [];
    for (let page = 1; page < 1000; page++) {
      const r = await this.raw("GET", `/people?withHidden=true&page=${page}&size=1000`);
      const j = await (await this.peopleCheck(r, "GET", "/people")).json();
      out.push(...(j.people ?? []));
      if (!j.hasNextPage) break;
    }
    return out;
  }

  /** The faces on an asset (immich.faces). */
  async faces(asset: string): Promise<ImmichFace[]> {
    return (await this.peopleCheck(await this.raw("GET", `/faces?id=${asset}`), "GET", "/faces")).json();
  }

  async createPerson(name: string, birthDate?: string | null): Promise<ImmichPerson> {
    const body = { name, ...(birthDate ? { birthDate } : {}) };
    return (await this.peopleCheck(await this.raw("POST", "/people", body), "POST", "/people")).json();
  }

  /** `PUT /people/{id}`: name, birthDate (YYYY-MM-DD), isHidden… */
  async updatePerson(id: string, fields: Record<string, unknown>) {
    await this.peopleCheck(await this.raw("PUT", `/people/${id}`, fields), "PUT", "/people/{id}");
  }

  /** Merge people into `into`, which keeps its name and birthday (immich.merge_people). `POST
   *  /people/merge` since v3.2.1 (the first id is kept); `POST /people/{id}/merge` before (deprecated since). */
  async mergePeople(into: string, others: string[]) {
    if (!others.length) return;
    let r = await this.raw("POST", "/people/merge", { ids: [into, ...others] });
    if (r.status === 404 || r.status === 405) r = await this.raw("POST", `/people/${into}/merge`, { ids: others });
    await this.peopleCheck(r, "POST", "/people/merge");
  }

  /** Put a face on a person (`PUT /faces/{person id}` with the face's id in the body). */
  async assignFace(face: string, person: string) {
    await this.peopleCheck(await this.raw("PUT", `/faces/${person}`, { id: face }), "PUT", "/faces/{id}");
  }

  /** A face Immich's own detection didn't find: box [x1, y1, x2, y2] in 0..1 of the asset, width ×
   *  height its size in pixels (v1.127+; a "manual" face, which re-detection leaves alone). */
  async createFace(asset: string, person: string, box: number[], width: number, height: number) {
    const [x1, y1] = [Math.max(0, box[0]), Math.max(0, box[1])];
    const [x2, y2] = [Math.min(1, box[2]), Math.min(1, box[3])];
    const body = {
      assetId: asset,
      personId: person,
      imageWidth: width,
      imageHeight: height,
      x: pyRound(x1 * width),
      y: pyRound(y1 * height),
      width: Math.max(1, pyRound((x2 - x1) * width)),
      height: Math.max(1, pyRound((y2 - y1) * height)),
    };
    const r = await this.raw("POST", "/faces", body);
    if (r.status === 404 || r.status === 405)
      throw new ImmichError("this Immich can't add faces by hand; update it to v1.127 or later");
    await this.peopleCheck(r, "POST", "/faces");
  }

  async deleteFace(id: string) {
    const r = await this.raw("DELETE", `/faces/${id}`, { force: false });
    if (r.status !== 400 && r.status !== 404) await this.peopleCheck(r, "DELETE", "/faces/{id}"); // gone already
  }

  /**
   * Take tags whose value starts with `prefix` off these assets, and delete those left on nothing
   * (then their parent, if it's empty too) (immich.remove_tag_everywhere). Returns how many tags were
   * taken off.
   */
  async removeTagEverywhere(prefix: string, assets: string[]): Promise<number> {
    const r = await this.raw("GET", "/tags");
    if ([403, 404, 405].includes(r.status)) return 0;
    type Tag = { id: string; value?: string; parentId?: string | null };
    const tags: Tag[] = await (await this.check(r, "GET", "/tags")).json();
    const mine = tags.filter((t) => (t.value || "").startsWith(prefix));
    for (const t of mine)
      for (let i = 0; i < assets.length; i += 200) {
        const q = await this.raw("DELETE", `/tags/${t.id}/assets`, { ids: assets.slice(i, i + 200) });
        if (q.status === 403) throw new ImmichError("The API key can't take the People tags off (403): give it tag.asset.");
        await this.check(q, "DELETE", "/tags/{id}/assets");
      }
    const parents = new Set(mine.map((t) => t.parentId));
    const gone = new Set<string>();
    for (const t of [...mine, ...tags.filter((x) => parents.has(x.id))]) {
      if (tags.some((x) => x.parentId === t.id && !gone.has(x.id))) continue; // a parent with tags still under it
      const page = await this.raw("POST", "/search/metadata", { tagIds: [t.id], size: 1 });
      if (page.status === 200 && !(await page.json()).assets?.items?.length)
        if ((await this.raw("DELETE", `/tags/${t.id}`)).status < 400) gone.add(t.id); // (a key without tag.delete leaves the empty tag)
    }
    return mine.length;
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
