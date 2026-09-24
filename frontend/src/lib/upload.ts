// Sending a folder of scans to the server (slidestation/uploads.py) when the browser can't hand it a
// path: a hosted server, or the local one in a plain browser tab. Each file goes in 8 MB chunks at
// an offset; the server says where each file stands (`check`), so an interrupted upload carries on
// where it stopped — within the page, and after a reload when the same folder is dropped again
// (the upload id is remembered per folder). Files the library already has are not sent at all.
import { api, ApiError } from "@/lib/api";
import type { PickedFile } from "@/lib/files";

const CHUNK = 8 * 1024 * 1024;
const PARALLEL = 3; // files in flight at once
const RETRIES = 5;
const SCAN = /\.(jpe?g)$/i;
const RAW = /\.(dng|cr2|cr3|nef|arw|orf|raf)$/i;

export type UploadProgress = { sent: number; bytes: number; files: number; of: number };
type Status = { have?: boolean; imported?: boolean; offset?: number };

/** The files that are scans: JPEGs, and camera RAW files when the server can read them. */
export function scansOf(files: PickedFile[], raw: boolean): PickedFile[] {
  return files.filter(
    (f) => !f.path.split("/").some((p) => p.startsWith(".")) && (SCAN.test(f.path) || (raw && RAW.test(f.path))),
  );
}

/** The server has no room for this (its quotas, slidestation/uploads.py): sending again won't help. */
export const isQuota = (e: unknown) => e instanceof ApiError && !!e.body.quota;

async function sha1(file: File): Promise<string> {
  // WebCrypto exists only in a secure context (https, localhost): on plain http across the LAN the
  // server checks the size alone
  if (!globalThis.crypto?.subtle) return "";
  const digest = await crypto.subtle.digest("SHA-1", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const memoKey = (name: string, files: PickedFile[]) =>
  `slide-station-upload:${name}:${files.length}:${files.reduce((n, f) => n + f.file.size, 0)}`;

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode
  }
}

function remember(key: string, id: string | null) {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}

async function putChunk(id: string, f: PickedFile, sha: string, offset: number): Promise<number> {
  const body = f.file.slice(offset, offset + CHUNK);
  const q = new URLSearchParams({ offset: String(offset), size: String(f.file.size), sha1: sha });
  const path = f.path.split("/").map(encodeURIComponent).join("/");
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(`/api/uploads/${id}/files/${path}?${q}`, { method: "PUT", body });
    } catch (e) {
      // the connection dropped: wait a little and ask again
      if (attempt >= RETRIES) throw e;
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
      continue;
    }
    const j = await r.json().catch(() => ({}));
    // 409: the server has a different amount of this file (a chunk got lost): carry on from there;
    // 422: it arrived damaged, the server started it over
    if (r.status === 409 || r.status === 422) return j.offset ?? 0;
    if (r.status >= 500 && attempt < RETRIES) {
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
      continue;
    }
    if (!r.ok) throw new ApiError(j.error || `${r.status} ${r.statusText}`, r.status, j);
    return j.offset;
  }
}

/**
 * Upload a folder's scans into a staging folder on the server; resolves to the upload id, which
 * imports as the source `upload:<id>`. `onProgress` gets bytes and files done so far.
 */
export async function uploadFolder(
  name: string,
  files: PickedFile[],
  onProgress: (p: UploadProgress) => void,
): Promise<string> {
  const key = memoKey(name, files);
  let id = remembered(key);
  const shas = new Map<PickedFile, string>();
  for (const f of files) shas.set(f, await sha1(f.file));
  const listing = files.map((f) => ({ path: f.path, size: f.file.size, sha1: shas.get(f) }));
  let status: Record<string, Status> | null = null;
  if (id) {
    // the same folder was being uploaded before (a reload, a lost connection): resume that one
    status = await api<{ files: Record<string, Status> }>("POST", `/api/uploads/${id}/check`, { files: listing })
      .then((r) => r.files)
      .catch((e) => {
        if (isQuota(e)) throw e; // no room: a new upload wouldn't fit either
        return null;
      });
  }
  if (!status) {
    id = (await api<{ id: string }>("POST", "/api/uploads", { name })).id;
    remember(key, id);
    status = (await api<{ files: Record<string, Status> }>("POST", `/api/uploads/${id}/check`, { files: listing }))
      .files;
  }
  const uid = id!;
  const bytes = files.reduce((n, f) => n + f.file.size, 0);
  const p: UploadProgress = { sent: 0, bytes, files: 0, of: files.length };
  const queue = [...files];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const st = status![f.path] ?? {};
      let offset = st.have ? f.file.size : (st.offset ?? 0);
      p.sent += offset;
      while (offset < f.file.size) {
        const next = await putChunk(uid, f, shas.get(f)!, offset);
        p.sent += next - offset;
        offset = next;
        onProgress({ ...p });
      }
      p.files++;
      onProgress({ ...p });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  remember(key, null); // complete: a later drop of the same folder is a new upload
  return uid;
}
