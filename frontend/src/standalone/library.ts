// Where the browser version keeps its library: a folder on disk the user picks (File System
// Access API — Chrome, Edge, Opera) or, everywhere else, the browser's own private storage (OPFS).
// Both are directory handles with the same layout as the Python app's library folder:
//   sessions/<id>/{session.json, originals/, cache/, export/}, imported.json, learning.json
// so a folder picked here can later be opened by the desktop app, and the other way round.

export type LibraryKind = "disk" | "browser" | "memory";

export interface Library {
  kind: LibraryKind;
  name: string;
  read(path: string): Promise<File | null>;
  readText(path: string): Promise<string | null>;
  write(path: string, data: Blob | string | BufferSource): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Names of the entries in a folder ([] if it doesn't exist). */
  list(path: string): Promise<{ name: string; kind: "file" | "directory" }[]>;
}

const split = (path: string) => path.split("/").filter(Boolean);

export function handleLibrary(root: FileSystemDirectoryHandle, kind: LibraryKind): Library {
  const dirs = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
  const dir = (parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> => {
    const key = parts.join("/");
    const hit = dirs.get(key);
    if (hit) return hit;
    const p = (async () => {
      let d = root;
      for (const part of parts) d = await d.getDirectoryHandle(part, { create });
      return d;
    })().catch(() => null);
    // only cache found folders: a missing one may be created later
    p.then((d) => (d ? undefined : dirs.delete(key)));
    dirs.set(key, p);
    return p;
  };
  const file = async (path: string, create = false) => {
    const parts = split(path);
    const d = await dir(parts.slice(0, -1), create);
    if (!d) return null;
    try {
      return await d.getFileHandle(parts[parts.length - 1], { create });
    } catch {
      return null;
    }
  };
  const lib: Library = {
    kind,
    name: root.name || "Browser storage",
    async read(path) {
      const h = await file(path);
      return h ? h.getFile() : null;
    },
    async readText(path) {
      const f = await lib.read(path);
      return f ? f.text() : null;
    },
    async write(path, data) {
      const h = await file(path, true);
      if (!h) throw new Error(`Couldn't write ${path}`);
      // createWritable writes to a swap file and swaps it in on close: a crash never leaves half a file
      const w = await h.createWritable();
      await w.write(data as FileSystemWriteChunkType);
      await w.close();
    },
    async remove(path) {
      const parts = split(path);
      const d = await dir(parts.slice(0, -1), false);
      await d?.removeEntry(parts[parts.length - 1], { recursive: true }).catch(() => undefined);
    },
    async exists(path) {
      if (await file(path)) return true;
      return !!(await dir(split(path), false));
    },
    async list(path) {
      const d = await dir(split(path), false);
      const out: { name: string; kind: "file" | "directory" }[] = [];
      if (!d) return out;
      for await (const [name, h] of d as unknown as AsyncIterable<[string, FileSystemHandle]>)
        out.push({ name, kind: h.kind });
      return out;
    },
  };
  return lib;
}

/** Nothing persists (a private window without OPFS): enough to try the app. */
export function memoryLibrary(): Library {
  const files = new Map<string, File>();
  const norm = (p: string) => split(p).join("/");
  const lib: Library = {
    kind: "memory",
    name: "This tab only",
    read: async (p) => files.get(norm(p)) ?? null,
    readText: async (p) => (await lib.read(p))?.text() ?? null,
    async write(p, data) {
      const parts = split(p);
      files.set(norm(p), new File([data as BlobPart], parts[parts.length - 1]));
    },
    async remove(p) {
      const n = norm(p);
      for (const k of [...files.keys()]) if (k === n || k.startsWith(n + "/")) files.delete(k);
    },
    exists: async (p) => {
      const n = norm(p);
      return [...files.keys()].some((k) => k === n || k.startsWith(n + "/"));
    },
    async list(p) {
      const n = norm(p);
      const prefix = n ? n + "/" : "";
      const seen = new Map<string, "file" | "directory">();
      for (const k of files.keys())
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length).split("/");
          seen.set(rest[0], rest.length > 1 ? "directory" : "file");
        }
      return [...seen].map(([name, kind]) => ({ name, kind }));
    },
  };
  return lib;
}

// ------------------------------------------------------------------ choosing and remembering

export const canPickFolders = typeof window !== "undefined" && "showDirectoryPicker" in window;

type Picker = (opts?: {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: string;
}) => Promise<FileSystemDirectoryHandle>;
export const pickDirectory = (opts: { id?: string; mode?: "read" | "readwrite"; startIn?: string }) =>
  (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker(opts);

type Permissioned = FileSystemHandle & {
  queryPermission(o: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(o: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};
export const permission = (h: FileSystemHandle, mode: "read" | "readwrite", ask: boolean) =>
  ask ? (h as Permissioned).requestPermission({ mode }) : (h as Permissioned).queryPermission({ mode });

// A tiny IndexedDB key/value store: directory handles survive reloads there (not in localStorage).
const DB = "slide-station";
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const r = db.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return undefined;
  }
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      if (value === undefined) tx.objectStore("kv").delete(key);
      else tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* private mode: nothing is remembered */
  }
}

/** The browser's private storage, or null where it isn't available (older Safari, some private modes). */
export async function browserLibrary(): Promise<Library | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const probe = await root.getFileHandle(".probe", { create: true });
    if (!("createWritable" in probe)) return null; // Safari before 18.4 can only write from a worker
    await root.removeEntry(".probe");
    navigator.storage.persist?.().catch(() => undefined); // ask not to be evicted under storage pressure
    return handleLibrary(root, "browser");
  } catch {
    return null;
  }
}
