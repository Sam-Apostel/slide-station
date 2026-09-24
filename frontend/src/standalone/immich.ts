// Minimal Immich client for the browser (slidestation/immich.py): same endpoints, same v1/v2 vs
// v3 field rules. Immich only allows cross-origin requests in development builds, so this works
// when Slide Station is served from the same origin as Immich, or when the reverse proxy in front
// of Immich adds CORS headers for this page (docs: README "Slide Station in the browser").

export class ImmichError extends Error {}

export class Immich {
  private base: string;
  private major: number | null = null;

  constructor(url: string, private key: string) {
    if (!url || !key) throw new ImmichError("Immich URL and API key are not set (Settings).");
    let u = url.trim().replace(/\/+$/, "");
    if (u.endsWith("/api")) u = u.slice(0, -4);
    this.base = u + "/api";
    this.key = key.trim();
  }

  private async req(method: string, path: string, body?: BodyInit | object, accept = "application/json"): Promise<Response> {
    const headers: Record<string, string> = { "x-api-key": this.key, Accept: accept };
    let payload: BodyInit | undefined;
    if (body instanceof FormData || body instanceof Blob) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let r: Response;
    try {
      r = await fetch(this.base + path, { method, headers, body: payload });
    } catch {
      throw new ImmichError(unreachable(this.base));
    }
    if (r.status === 401) throw new ImmichError("Immich rejected the API key (401).");
    if (r.status === 403)
      throw new ImmichError(
        `The API key lacks a permission for ${path} (403). Give it asset.upload, asset.delete, album.read, album.create and albumAsset.create.`,
      );
    if (r.status >= 400) throw new ImmichError(`Immich ${method} ${path} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r;
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

  async findOrCreateAlbum(name: string): Promise<string> {
    const albums = await (await this.req("GET", "/albums")).json();
    const hit = albums.find((a: { albumName: string }) => a.albumName === name);
    if (hit) return hit.id;
    return (await (await this.req("POST", "/albums", { albumName: name })).json()).id;
  }

  async addToAlbum(album: string, ids: string[]) {
    for (let i = 0; i < ids.length; i += 200) await this.req("PUT", `/albums/${album}/assets`, { ids: ids.slice(i, i + 200) });
  }

  /** Upload a JPEG. Returns [asset id, created / duplicate / replaced]. */
  async upload(file: Blob, name: string, taken: Date, deviceAssetId: string): Promise<[string, string]> {
    if (this.major === null) await this.version();
    const ts = taken.toISOString().replace(/\.\d{3}Z$/, ".000Z");
    const f = new FormData();
    f.set("fileCreatedAt", ts);
    f.set("fileModifiedAt", ts);
    f.set("isFavorite", "false");
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

  /** Immich's own preview JPEG of an asset (needs the asset.view permission). */
  async preview(id: string): Promise<Blob> {
    return (await this.req("GET", `/assets/${id}/thumbnail?size=preview`, undefined, "image/*")).blob();
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
  if (location.protocol === "https:" && origin.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin))
    return `This page is served over https, so the browser won't talk to ${origin} over plain http. Use Immich's https address.`;
  return (
    `Couldn't reach Immich at ${origin} from the browser. Either it's offline, or it doesn't allow requests ` +
    `from ${location.origin} (CORS): serve Slide Station from Immich's own address, or let its reverse proxy ` +
    `allow this page — or save the slides to disk and drop them into Immich yourself.`
  );
}
