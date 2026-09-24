// The Python app's HTTP API (slidestation/server.py + workflow.py), answered inside the page, so
// the same React UI runs with no backend at all. Every route keeps the Python semantics — undo
// history, render keys, locked slides, dedupe, the upload rules — over a Library (library.ts)
// instead of the file system, with the pixel work in web workers (engine.ts).
import type { AppState, Config, Job, Params, SessionPayload, Source } from "@/lib/api";
import { jobs, ui } from "./engine";
import type { Src } from "./engine.worker";
import { exifSegment, readExif, withExif } from "./exif";
import { cleanParams, groupSequence, MOUNT_AUTO, rotateBox, weakScans, type Quality } from "./imaging";
import { Immich, ImmichError } from "./immich";
import { Model } from "./learning";
import { canPickFolders, kvGet, kvSet, permission, pickDirectory, type Library } from "./library";
import { npy, readNpy } from "./npy";
import {
  activeScans,
  dumpSession,
  groupStatus,
  metaKey,
  newGroup,
  parseDate,
  randomHex,
  renderKey,
  sha1Hex,
  slideDates,
  slugify,
  statuses,
  summary,
  toneKey,
  type GroupData,
  type Scan,
  type SessionData,
  type Snapshot,
} from "./store";
import { zip } from "./zip";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ config (this browser only)

type StoredConfig = {
  immich_url: string;
  immich_key: string;
  keep_originals: boolean;
  keep_exports: boolean;
  learning_enabled: boolean;
  jpeg_quality: number;
};

const CONFIG_KEY = "slide-station-config";
const DEFAULT_CONFIG: StoredConfig = {
  immich_url: "",
  immich_key: "",
  keep_originals: true,
  keep_exports: false,
  learning_enabled: true,
  jpeg_quality: 95,
};

function loadConfig(): StoredConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(c: StoredConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
  } catch {
    /* private mode: kept for this tab only */
  }
}

// ------------------------------------------------------------------ library and sessions

let lib: Library;
let onLibraryChange: ((l: Library) => void) | null = null;

export function setLibrary(l: Library, onChange?: (l: Library) => void) {
  lib = l;
  if (onChange) onLibraryChange = onChange;
  cache.clear();
  learningModel = null;
  importedIndex = null;
}

const sessionDir = (sid: string) => `sessions/${sid}`;
const originalPath = (d: SessionData, scan: string) => `${sessionDir(d.id)}/originals/${d.scans[scan].file}`;
const cachePath = (sid: string, name: string) => `${sessionDir(sid)}/cache/${name}`;

/** Sessions as last read, with the file's modification time: a changed file is read again. */
const cache = new Map<string, { t: number; d: SessionData }>();

async function loadSession(sid: string): Promise<SessionData> {
  const f = await lib.read(`${sessionDir(sid)}/session.json`);
  if (!f) throw new HttpError(404, "Session not found");
  const hit = cache.get(sid);
  if (hit && hit.t === f.lastModified && lib.kind !== "memory") return structuredClone(hit.d);
  const d = JSON.parse(await f.text()) as SessionData;
  cache.set(sid, { t: f.lastModified, d: structuredClone(d) });
  return d;
}

async function saveSession(d: SessionData) {
  await lib.write(`${sessionDir(d.id)}/session.json`, dumpSession(d));
  const f = await lib.read(`${sessionDir(d.id)}/session.json`);
  cache.set(d.id, { t: f?.lastModified ?? Date.now(), d: structuredClone(d) });
}

// One writer at a time (the Python app's lock): long jobs never save a stale copy.
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Apply fn to a freshly loaded session under the lock, then save (workflow.update_session). */
function update<T = void>(sid: string, fn: (d: SessionData) => T | Promise<T>): Promise<{ d: SessionData; r: T }> {
  return locked(async () => {
    const d = await loadSession(sid);
    const r = await fn(d);
    await saveSession(d);
    return { d, r };
  });
}

function group(d: SessionData, gid: string): GroupData {
  const g = d.groups.find((x) => x.id === gid);
  if (!g) throw new HttpError(404, "Slide not found");
  return g;
}
const groupIndex = (d: SessionData, gid: string) => d.groups.findIndex((g) => g.id === gid);

function log(d: SessionData, msg: string) {
  d.log = [...(d.log ?? []), [Date.now() / 1000, msg] as [number, string]].slice(-200);
}

async function listSessions() {
  const out = [];
  for (const e of await lib.list("sessions")) {
    if (e.kind !== "directory") continue;
    try {
      out.push(summary(await loadSession(e.name)));
    } catch {
      /* not a tray */
    }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

async function createSession(name: string, album: string | null, date: string): Promise<SessionData> {
  const t = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const sid = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}-${randomHex(4)}`;
  const d: SessionData = {
    id: sid,
    name: name || "Untitled tray",
    album: album ?? (name || "Untitled tray"),
    date,
    created: Date.now() / 1000,
    defaults: cleanParams({}),
    scans: {},
    groups: [],
    log: [],
  };
  await saveSession(d);
  return d;
}

// ------------------------------------------------------------------ learning

let learningModel: Model | null = null;
async function model(): Promise<Model> {
  if (!learningModel) {
    let data: unknown = null;
    try {
      data = JSON.parse((await lib.readText("learning.json")) ?? "null");
    } catch {
      /* start fresh */
    }
    learningModel = new Model(data, (json) => void lib.write("learning.json", JSON.stringify(json, null, 1)));
  }
  return learningModel;
}

/** Remember a developed slide's settings; drop it again if it gets skipped. */
async function learn(d: SessionData, g: GroupData) {
  if (!loadConfig().learning_enabled || !g.feat) return;
  const key = `${d.id}:${g.id}`;
  const m = await model();
  if (g.skip) m.forget(key);
  else if (g.reviewed || g.immich) m.remember(key, g.feat, g.params);
}

// ------------------------------------------------------------------ undo

const HISTORY_MAX = 60;
const COALESCE_S = 1.5; // edits to the same settings closer together than this are one undo step

const snapshot = (g: GroupData): Snapshot => ({
  params: structuredClone(g.params),
  rotation: g.rotation,
  rot_reason: g.rot_reason ?? "",
  params_source: g.params_source ?? "",
});

function remember(g: GroupData, what: string) {
  const h = (g.history ??= { undo: [], redo: [] });
  const now = Date.now() / 1000;
  const last = h.undo[h.undo.length - 1];
  if (last && last.what === what && now - (last.t ?? 0) < COALESCE_S) last.t = now;
  else h.undo = [...h.undo, { ...snapshot(g), what, t: now }].slice(-HISTORY_MAX);
  h.redo = [];
}

const LOCKED =
  "This slide's original scans were deleted after it was uploaded, so it can't be edited " +
  "(Immich has the final version). Re-import its scans into this tray to edit it again.";
function editable(g: GroupData) {
  if (g.locked) throw new HttpError(409, LOCKED);
}

const FRAMING = { angle: 0, crop: null };

// ------------------------------------------------------------------ payloads

/** The slide mount's tilt; null = not looked for yet (an older tray, or the scans changed). */
function mountView(g: GroupData) {
  const m = g.mount;
  if (!m || m.scans.join() !== activeScans(g).join()) return null;
  return { angle: m.angle, confidence: m.confidence, box: m.box };
}

/** A new slide straightens to its mount by itself only when that is found with confidence. */
function straightenToMount(g: GroupData) {
  const m = g.mount;
  return (
    !!m && m.confidence >= MOUNT_AUTO && Math.abs(m.angle) >= 0.1 && !g.reviewed && !g.params.angle && !g.params.crop
  );
}

/** The slide's mount, found now if the import didn't (older trays) or its active scans changed. */
async function mountOf(d: SessionData, g: GroupData): Promise<NonNullable<GroupData["mount"]>> {
  if (g.mount && g.mount.scans.join() === activeScans(g).join()) return g.mount;
  return { ...(await ui.call("mount", { src: await fusedSrc(d, g) }, 3)), scans: activeScans(g) };
}

async function payload(d: SessionData): Promise<SessionPayload> {
  const dates = slideDates(d);
  const st = statuses(d);
  return {
    summary: summary(d),
    defaults: d.defaults,
    groups: d.groups.map((g, i) => ({
      id: g.id,
      scans: g.scans,
      excluded: g.excluded ?? [],
      rotation: g.rotation,
      rot_reason: g.rot_reason ?? "",
      params: g.params,
      reviewed: g.reviewed,
      skip: g.skip,
      params_source: g.params_source ?? "",
      auto_excluded: g.auto_excluded ?? {},
      locked: !!g.locked,
      status: st[i],
      date: g.date ?? "",
      caption: g.caption ?? "",
      date_est: dates[i],
      active: activeScans(g),
      key: renderKey(g),
      tone_key: toneKey(g),
      can_undo: !!g.history?.undo.length,
      can_redo: !!g.history?.redo.length,
      mount: mountView(g),
      index: i,
    })),
    cleanup_blockers: cleanupBlockers(d),
    log: (d.log ?? []).slice(-20),
  };
}

// ------------------------------------------------------------------ sources: folders you drop or pick

type PickedFile = { file: File; path: string };
type PickedSource = {
  id: string;
  name: string;
  files: PickedFile[];
  /** Picked with the folder picker, with DCIM at its root: a card, so it may be cleaned later. */
  handle?: FileSystemDirectoryHandle;
  scanner: boolean;
};
const sources = new Map<string, PickedSource>();
let importedIndex: Record<string, unknown> | null = null;

const JPG = /\.jpe?g$/i;
const quickFp = (f: File) => `${f.name}:${f.size}:${Math.trunc(f.lastModified / 1000)}`;

async function index(): Promise<Record<string, unknown> & { _fp?: Record<string, string> }> {
  if (!importedIndex) {
    try {
      importedIndex = JSON.parse((await lib.readText("imported.json")) ?? "{}");
    } catch {
      importedIndex = {};
    }
  }
  return importedIndex!;
}

async function addToIndex(entries: Record<string, unknown>) {
  await locked(async () => {
    const idx = await index();
    Object.assign(idx, entries);
    await lib.write("imported.json", JSON.stringify(idx, null, 1));
  });
}

/** A folder of scans the user dropped or picked; returns the source id to import from. */
export async function addSource(
  name: string,
  files: PickedFile[],
  handle?: FileSystemDirectoryHandle,
): Promise<string> {
  const jpegs = files.filter(
    (f) => JPG.test(f.file.name) && !f.file.name.startsWith("._") && !f.path.split("/").some((p) => p.startsWith(".")),
  );
  jpegs.sort((a, b) => (a.path < b.path ? -1 : 1));
  let scanner = false;
  if (jpegs.length) {
    const info = readExif(await jpegs[0].file.slice(0, 128 * 1024).arrayBuffer());
    scanner = info.model === "RODFS50" || info.make === "GCMC";
  }
  const card = handle && jpegs.some((f) => f.path.startsWith("DCIM/")) ? handle : undefined;
  if (card) await kvSet(`card:${card.name}`, card); // remembered for cleaning the card later
  const id = `picked:${randomHex(6)}`;
  sources.set(id, { id, name, files: jpegs, handle: card, scanner });
  return id;
}

/** Every file in a picked folder, with its path inside it. */
export async function filesOf(dir: FileSystemDirectoryHandle, prefix = ""): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for await (const [name, h] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (name.startsWith(".")) continue;
    if (h.kind === "directory") out.push(...(await filesOf(h as FileSystemDirectoryHandle, `${prefix}${name}/`)));
    else if (JPG.test(name)) out.push({ file: await (h as FileSystemFileHandle).getFile(), path: prefix + name });
  }
  return out;
}

async function sourceList(): Promise<Source[]> {
  const fps = (await index())._fp ?? {};
  return [...sources.values()].map((s) => ({
    path: s.id,
    name: s.name,
    count: s.files.length,
    new: s.files.filter((f) => !(quickFp(f.file) in fps)).length,
    scanner: s.scanner,
    removable: !!s.handle,
  }));
}

// ------------------------------------------------------------------ jobs

let current: Job | null = null;

function startJob(kind: string, session: string | null, fn: (job: Job) => Promise<void>) {
  if (current && !current.finished) throw new HttpError(409, `Busy with ${current.kind} - wait for it to finish.`);
  const job: Job = {
    kind,
    session,
    total: 0,
    done: 0,
    message: "",
    error: "",
    finished: false,
    started: Date.now() / 1000,
  };
  current = job;
  fn(job)
    .catch((e) => {
      console.error(e);
      job.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => (job.finished = true));
}

// ------------------------------------------------------------------ import

async function sha1Blob(b: Blob): Promise<string> {
  const h = await crypto.subtle.digest("SHA-1", await b.arrayBuffer());
  return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** EXIF DateTime, else the file's modification time, as "YYYY:MM:DD HH:MM:SS". */
async function taken(f: File): Promise<string> {
  const dt = readExif(await f.slice(0, 128 * 1024).arrayBuffer()).datetime;
  if (dt) return dt;
  const t = new Date(f.lastModified);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}:${p(t.getMonth() + 1)}:${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

async function makeProxies(sid: string, scanId: string, original: Blob) {
  const r = await jobs.call("proxy", { blob: original });
  await lib.write(cachePath(sid, `${scanId}.proxy.jpg`), r.proxy);
  await lib.write(cachePath(sid, `${scanId}.thumb.jpg`), r.thumb);
  await lib.write(cachePath(sid, `${scanId}.sig.npy`), npy(r.sig, [64, 96]));
  return r;
}

async function ensureProxies(d: SessionData, scanId: string) {
  if (await lib.exists(cachePath(d.id, `${scanId}.proxy.jpg`))) return;
  const orig = await lib.read(originalPath(d, scanId));
  if (!orig) throw new Error(`The original of ${scanId} is missing`);
  await makeProxies(d.id, scanId, orig);
}

async function readCache(sid: string, name: string): Promise<File> {
  const f = await lib.read(cachePath(sid, name));
  if (!f) throw new Error(`Missing ${name}`);
  return f;
}

const lostHere = async (d: SessionData, sha: string) => {
  for (const [k, r] of Object.entries(d.scans))
    if (r.sha1 === sha && !(await lib.exists(originalPath(d, k)))) return true;
  return false;
};

async function importScans(job: Job, sid: string, sourceId: string) {
  const src = sources.get(sourceId);
  if (!src) throw new Error("That folder is no longer available - drop or pick it again.");
  let d = await loadSession(sid);
  const root = `browser:${src.name}`;
  const removable = !!src.handle;
  const withTaken = await Promise.all(src.files.map(async (f) => ({ ...f, taken: await taken(f.file) })));
  withTaken.sort((a, b) => (a.taken === b.taken ? (a.file.name < b.file.name ? -1 : 1) : a.taken < b.taken ? -1 : 1));
  const idx = await index();
  job.total = withTaken.length;
  job.message = `Copying ${withTaken.length} scans`;
  const newIds: string[] = [];
  const records: Record<string, Scan> = {};
  const fpIndex: Record<string, string> = {};
  const shaIndex: Record<string, string> = {};
  let skipped = 0;
  let restored = 0;
  for (const f of withTaken) {
    job.done++;
    const fp = quickFp(f.file);
    if (idx._fp?.[fp] && !(await lostHere(d, idx._fp[fp]))) {
      skipped++;
      continue;
    }
    const sha = await sha1Blob(f.file);
    if (sha in idx || sha in shaIndex) {
      // already imported - but if this tray lost that original (deleted after upload), put it
      // back: that unlocks the slide for editing again
      for (const [scanId, rec] of Object.entries(d.scans))
        if (rec.sha1 === sha && !(await lib.exists(originalPath(d, scanId)))) {
          await lib.write(originalPath(d, scanId), f.file);
          const back = await lib.read(originalPath(d, scanId));
          if (!back || (await sha1Blob(back)) !== sha) {
            await lib.remove(originalPath(d, scanId));
            throw new Error(`Copy of ${f.file.name} did not verify - card or disk problem?`);
          }
          restored++;
        }
      skipped++;
      fpIndex[fp] = sha;
      continue;
    }
    const scanId = `${stem(f.file.name)}_${sha.slice(0, 6)}`;
    const dest = `${sessionDir(sid)}/originals/${scanId}.jpg`;
    await lib.write(dest, f.file);
    const back = await lib.read(dest);
    if (!back || (await sha1Blob(back)) !== sha) {
      await lib.remove(dest);
      throw new Error(`Copy of ${f.file.name} did not verify - card or disk problem?`);
    }
    records[scanId] = {
      file: `${scanId}.jpg`,
      source: f.path,
      source_root: root,
      removable,
      size: f.file.size,
      sha1: sha,
      taken: f.taken,
      source_deleted: false,
    };
    newIds.push(scanId);
    fpIndex[fp] = sha;
    shaIndex[sha] = sid;
  }
  d = (await update(sid, (fresh) => void Object.assign(fresh.scans, records))).d;
  // recorded straight after copying, so a crash can't cause double imports
  await addToIndex({ ...shaIndex, _fp: { ...((await index())._fp ?? {}), ...fpIndex } });

  job.message = "Analysing scans";
  job.done = 0;
  job.total = newIds.length;
  const sigs: Record<string, Float32Array> = {};
  const quality: Record<string, Quality> = {};
  for (const scanId of newIds) {
    const r = await makeProxies(sid, scanId, (await lib.read(originalPath(d, scanId)))!);
    sigs[scanId] = r.sig;
    quality[scanId] = r.quality;
    job.done++;
  }

  // group, continuing the last group if the first new scan is another exposure of it
  const last = d.groups[d.groups.length - 1];
  let prev: Float32Array[] | null = null;
  if (last && !last.immich && newIds.length)
    prev = await Promise.all(last.scans.map(async (x) => readNpy(await readCache(sid, `${x}.sig.npy`))));
  const [idxGroups, continues] = groupSequence(
    newIds.map((x) => sigs[x]),
    prev,
  );
  job.message = "Blending brackets and guessing rotations";
  job.done = 0;
  job.total = idxGroups.length;
  const learning = loadConfig().learning_enabled;
  for (let k = 0; k < idxGroups.length; k++) {
    const ids = idxGroups[k].map((i) => newIds[i]);
    const extend = k === 0 && continues;
    const g: GroupData = extend ? { ...structuredClone(last), scans: [...last.scans, ...ids] } : newGroup(d, ids);
    // best of the bracket: leave out scans that are blurry or almost entirely clipped
    if (g.scans.length > 1 && !g.reviewed) {
      const qual = await Promise.all(
        g.scans.map(
          async (x) => quality[x] ?? (await jobs.call("quality", { blob: await readCache(sid, `${x}.proxy.jpg`) })),
        ),
      );
      const autoOut = Object.fromEntries(Object.entries(weakScans(qual)).map(([i, why]) => [g.scans[+i], why]));
      // scans the user put back after an earlier import left them out stay in
      const manualIn = new Set(Object.keys(g.auto_excluded ?? {}).filter((x) => !(g.excluded ?? []).includes(x)));
      g.excluded = [
        ...new Set([...(g.excluded ?? []), ...Object.keys(autoOut).filter((x) => !manualIn.has(x))]),
      ].sort();
      g.auto_excluded = autoOut;
    }
    let rot: [number, string] | null = null;
    const fused = await fusedSrc(d, g, jobs);
    const analysis = await jobs.call("analyse", {
      proxies: await Promise.all(
        activeScans(g).map(async (x) => ({ key: `${sid}:${x}`, blob: await readCache(sid, `${x}.proxy.jpg`) })),
      ),
      fused,
      scans: activeScans(g).length,
    });
    if (!g.reviewed && g.rot_reason !== "manual") rot = [analysis.rotation, analysis.reason];
    const feats = analysis.features;
    const mount = { ...analysis.mount, scans: activeScans(g) };
    let suggestion: Partial<Params> | null = null;
    let neighbours = 0;
    if (learning) [suggestion, neighbours] = (await model()).suggest(feats);

    await update(sid, (fresh) => {
      let target: GroupData;
      if (extend) {
        target = group(fresh, last.id);
        target.scans.push(...ids);
        if (g.auto_excluded) {
          target.excluded = g.excluded;
          target.auto_excluded = g.auto_excluded;
        }
      } else {
        g.params = structuredClone(fresh.defaults);
        fresh.groups.push(g);
        target = g;
      }
      if (rot && target.rot_reason !== "manual") [target.rotation, target.rot_reason] = rot;
      target.feat = feats;
      target.mount = mount;
      if (!extend && straightenToMount(target)) target.params = { ...target.params, angle: -mount.angle };
      if (suggestion && !target.reviewed && target.params_source !== "manual") {
        target.params = cleanParams({ ...target.params, ...suggestion });
        target.params_source = `learned:${neighbours}`;
      }
    }); // slides appear in the UI one by one
    d = await loadSession(sid);
    job.done++;
  }
  await update(sid, (fresh) =>
    log(fresh, `Imported ${newIds.length} scans from ${src.name} (${skipped} already imported)`),
  );
  if (restored) await update(sid, syncLocks);
  job.message =
    `Imported ${newIds.length} scans into ${idxGroups.length} slides` +
    (skipped ? ` (${skipped} were already imported)` : "") +
    (restored ? `; restored ${restored} deleted originals, those slides can be edited again` : "");
}

// ------------------------------------------------------------------ previews

/** The blended proxy of a slide's active scans, blended (and cached) on first use. */
async function fusedSrc(d: SessionData, g: GroupData, engine = ui): Promise<Src> {
  const scans = activeScans(g);
  const key = `${d.id}:${scans.join(",")}`;
  const name = `fused_${sha1Hex(key).slice(0, 12)}.jpg`;
  const hit = await lib.read(cachePath(d.id, name));
  if (hit) return { key, blob: hit };
  if (scans.length === 1) {
    await ensureProxies(d, scans[0]);
    return { key, blob: await readCache(d.id, `${scans[0]}.proxy.jpg`) };
  }
  for (const x of scans) await ensureProxies(d, x);
  const blob = await engine.call(
    "fuse",
    { blobs: await Promise.all(scans.map((x) => readCache(d.id, `${x}.proxy.jpg`))) },
    5,
  );
  await lib.write(cachePath(d.id, name), blob);
  return { key, blob };
}

const immichFailed = new Map<string, number>();

/** What Immich has for a locked slide whose settings no longer reproduce the upload. */
async function immichPreview(d: SessionData, g: GroupData): Promise<Blob | null> {
  const asset = g.immich?.asset_id;
  if (!asset || Date.now() - (immichFailed.get(asset) ?? 0) < 300_000) return null;
  const name = `immich_${asset}.jpg`;
  const hit = await lib.read(cachePath(d.id, name));
  if (hit) return hit;
  const cfg = loadConfig();
  try {
    const blob = await new Immich(cfg.immich_url, cfg.immich_key).preview(asset);
    await lib.write(cachePath(d.id, name), blob);
    return blob;
  } catch (e) {
    console.warn("immich preview:", e);
    immichFailed.set(asset, Date.now());
    return null;
  }
}

/** A preview JPEG, and whether it shows the render key the URL asked for (only then cache it). */
export async function image(url: string, priority = 0): Promise<{ blob: Blob; fresh: boolean }> {
  const u = new URL(url, location.href);
  let m = u.pathname.match(/\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/preview\.jpg$/);
  if (m) {
    const d = await loadSession(m[1]);
    const g = group(d, m[2]);
    const size = Math.min(Number(u.searchParams.get("size") || 1600), 2400);
    const before = u.searchParams.get("before") === "1";
    const uncropped = u.searchParams.get("uncropped") === "1";
    const fresh = u.searchParams.get("v") === renderKey(g);
    if (g.locked && !before && g.immich && g.immich.key !== renderKey(g)) {
      const shown = await immichPreview(d, g);
      if (shown) return { blob: await ui.call("resize", { blob: shown, size }, priority), fresh };
    }
    const src = await fusedSrc(d, g);
    const blob = await ui.call(
      "render",
      { src, rotation: g.rotation, params: g.params, size, before, uncropped },
      priority,
    );
    return { blob, fresh };
  }
  m = u.pathname.match(/\/api\/sessions\/([^/]+)\/scans\/([^/]+)\/thumb\.jpg$/);
  if (m) {
    const d = await loadSession(m[1]);
    const scan = decodeURIComponent(m[2]);
    const hit = await lib.read(cachePath(d.id, `${scan}.thumb.jpg`));
    if (hit) return { blob: hit, fresh: true };
    await ensureProxies(d, scan);
    return { blob: await readCache(d.id, `${scan}.thumb.jpg`), fresh: true };
  }
  throw new HttpError(404, "Not found");
}

// ------------------------------------------------------------------ export and upload

function photoDate(d: SessionData, g: GroupData, index: number): Date {
  const est = slideDates(d)[index];
  const parsed = parseDate(est.value);
  if (parsed) {
    // noon, one minute per slide to keep tray order (naive local time, like the Python app)
    const u = new Date(parsed[0]);
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 12, index, 0);
  }
  const t = d.scans[activeScans(g)[0]]?.taken ?? "";
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(t);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : new Date();
}

const exifTime = (t: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}:${p(t.getMonth() + 1)}:${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
};

const slideMeta = (d: SessionData, g: GroupData, index: number) => metaKey(g, slideDates(d)[index]);
const exportKey = (d: SessionData, g: GroupData, index: number) =>
  sha1Hex(`${renderKey(g)}|${slideMeta(d, g, index)}|${index}`).slice(0, 12);

async function originalsMissing(d: SessionData, g: GroupData) {
  for (const x of activeScans(g)) if (!(await lib.exists(originalPath(d, x)))) return true;
  return false;
}

/** Render one slide at full resolution (with EXIF) and record it. Null if it changed meanwhile. */
async function renderExport(sid: string, gid: string, quality: number): Promise<{ name: string; blob: Blob } | null> {
  const d = await loadSession(sid);
  const g = group(d, gid);
  const index = groupIndex(d, gid);
  const ekey = exportKey(d, g, index);
  if (g.export?.ekey === ekey) {
    const f = await lib.read(`${sessionDir(sid)}/export/${g.export.file}`);
    if (f) return { name: g.export.file, blob: f };
  }
  const rkey = renderKey(g);
  const scans = activeScans(g);
  const originals = await Promise.all(scans.map((x) => lib.read(originalPath(d, x))));
  if (originals.some((x) => !x)) throw new Error("The original scans for this slide are gone.");
  const jpeg = await jobs.call("full", { blobs: originals as Blob[], rotation: g.rotation, params: g.params, quality });
  const info = readExif(await originals[0]!.slice(0, 128 * 1024).arrayBuffer());
  const when = exifTime(photoDate(d, g, index));
  const ifd0: [number, string][] = [
    [305, "Slide Station"],
    [306, when],
  ];
  if (info.make) ifd0.push([271, info.make]);
  if (info.model) ifd0.push([272, info.model]);
  if (g.caption) ifd0.push([270, g.caption]); // ImageDescription: Immich shows it as the description
  const blob = await withExif(
    jpeg,
    exifSegment(ifd0, [
      [36867, when], // DateTimeOriginal (what Immich uses for the timeline)
      [36868, when],
    ]),
  );
  const name = `${slugify(d.name)}_${scans[0]}.jpg`;
  await lib.write(`${sessionDir(sid)}/export/${name}`, blob);
  const sha = await sha1Blob(blob);
  const { r: ok } = await update(sid, (fresh) => {
    const fg = fresh.groups.find((x) => x.id === gid);
    if (!fg || renderKey(fg) !== rkey || exportKey(fresh, fg, groupIndex(fresh, gid)) !== ekey) return false;
    fg.export = { file: name, key: rkey, ekey, sha1: sha };
    return true;
  });
  return ok ? { name, blob } : null;
}

type Target = "immich" | "disk";

async function finishSession(
  job: Job,
  sid: string,
  onlyReady: boolean,
  target: Target,
  folder?: FileSystemDirectoryHandle,
) {
  const cfg = loadConfig();
  let d = await loadSession(sid);
  const redate = target === "immich" && d.date_key !== d.date; // date changed: every slide needs new EXIF
  const st = Object.fromEntries(d.groups.map((g, i) => [g.id, statuses(d)[i]]));
  let todo = d.groups
    .filter((g) => !g.skip && (target === "disk" || redate || st[g.id] !== "uploaded") && (g.reviewed || !onlyReady))
    .map((g) => g.id);
  const lost: string[] = [];
  for (const gid of todo) if (await originalsMissing(d, group(d, gid))) lost.push(gid);
  todo = todo.filter((x) => !lost.includes(x)); // nothing to render them from: keep what Immich has
  job.total = todo.length * 2;
  const saved: { name: string; blob: Blob }[] = [];
  let client: Immich | null = null;
  let album = "";
  if (target === "immich") {
    client = new Immich(cfg.immich_url, cfg.immich_key);
    job.message = `Connecting to Immich ${await client.version()}`;
    album = await client.findOrCreateAlbum(d.album || d.name);
    await update(sid, (f) => void (f.immich_album_id = album));
  }
  const toTrash: string[] = [];
  let uploaded = 0;
  for (const [n, gid] of todo.entries()) {
    job.message = `Rendering slide ${n + 1} of ${todo.length}`;
    let out: { name: string; blob: Blob } | null = null;
    for (let i = 0; i < 3 && !out; i++) out = await renderExport(sid, gid, cfg.jpeg_quality); // re-render if edited meanwhile
    job.done++;
    d = await loadSession(sid);
    const g = d.groups.find((x) => x.id === gid);
    if (!out || !g || g.skip || (onlyReady && !g.reviewed)) {
      job.done++;
      continue;
    }
    if (target === "disk") {
      job.message = `Saving slide ${n + 1} of ${todo.length}`;
      if (folder) {
        const fh = await folder.getFileHandle(out.name, { create: true });
        const w = await fh.createWritable();
        await w.write(out.blob);
        await w.close();
      }
      saved.push(out);
      // saved elsewhere: the library's copy can go (it can be rendered again from the originals),
      // unless the library itself is the folder on disk it was saved to
      if (folder && lib.kind !== "disk" && !cfg.keep_exports) await lib.remove(`${sessionDir(sid)}/export/${out.name}`);
      uploaded++;
      job.done++;
      continue;
    }
    job.message = `Uploading slide ${n + 1} of ${todo.length}`;
    const idx = groupIndex(d, gid);
    const [assetId, status] = await client!.upload(
      out.blob,
      out.name,
      photoDate(d, g, idx),
      `${sid}-${gid}-${g.export!.sha1.slice(0, 8)}`,
    );
    await client!.addToAlbum(album, [assetId]);
    const rkey = g.export!.key;
    const meta = slideMeta(d, g, idx);
    await update(sid, (fresh) => {
      const fg = group(fresh, gid);
      const old = fg.immich?.asset_id;
      if (old && old !== assetId) toTrash.push(old);
      fg.immich = { asset_id: assetId, key: rkey, status, meta };
    });
    if (!cfg.keep_exports) await lib.remove(`${sessionDir(sid)}/export/${out.name}`); // it's in Immich now
    uploaded++;
    job.done++;
  }

  if (target === "disk") {
    if (!folder && saved.length && lib.kind !== "disk") {
      job.message = "Packing the zip";
      download(await zip(saved.map((s) => ({ name: s.name, data: s.blob }))), `${slugify(d.name)}.zip`);
      if (!cfg.keep_exports) for (const x of saved) await lib.remove(`${sessionDir(sid)}/export/${x.name}`);
    }
    job.message =
      `Saved ${uploaded} slides ` +
      (folder
        ? `to “${folder.name}”`
        : lib.kind === "disk"
          ? `to ${lib.name}/sessions/${sid}/export`
          : "as a zip in your downloads") +
      (lost.length ? `; ${lost.length} skipped: their original scans are gone` : "");
    return;
  }
  await update(sid, (fresh) => {
    // slides merged away or skipped after uploading: move their old Immich copies to the trash
    toTrash.push(...(fresh.orphan_assets ?? []));
    delete fresh.orphan_assets;
    for (const g of fresh.groups)
      if (g.skip && g.immich) {
        toTrash.push(g.immich.asset_id);
        g.immich = null;
      }
    if (!onlyReady || fresh.groups.every((g) => g.reviewed || g.skip)) fresh.date_key = fresh.date; // every slide now carries the date
    log(fresh, `Uploaded ${uploaded} slides to album '${fresh.album}'`);
  });
  await client!.trash(toTrash);
  if (!cfg.keep_originals) await dropLocalOriginals(sid);
  job.message =
    `Done - ${uploaded} slides uploaded to '${d.album}'` +
    (lost.length ? `; ${lost.length} skipped: their original scans were deleted after the last upload` : "");
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function dropLocalOriginals(sid: string) {
  const d = await loadSession(sid);
  if (d.groups.some((g) => !["uploaded", "skipped"].includes(groupStatus(g)))) return;
  for (const sc of Object.values(d.scans)) await lib.remove(`${sessionDir(sid)}/originals/${sc.file}`);
  await update(sid, syncLocks);
}

/** Lock slides whose original scans are gone, unlock them once they're back. Whether anything changed. */
async function syncLocks(d: SessionData): Promise<boolean> {
  let changed = false;
  for (const g of d.groups) {
    const missing = await originalsMissing(d, g);
    if (missing && !g.locked) {
      g.locked = "originals";
      changed = true;
    } else if (!missing && g.locked) {
      delete g.locked;
      changed = true;
    }
  }
  return changed;
}

// ------------------------------------------------------------------ card cleanup

function cleanupBlockers(d: SessionData): string[] {
  const problems: string[] = [];
  const pending = d.groups.flatMap((g, i) => (["uploaded", "skipped"].includes(groupStatus(g)) ? [] : [i + 1]));
  if (pending.length) problems.push(`${pending.length} slide(s) not uploaded yet (e.g. #${pending[0]})`);
  if (!Object.values(d.scans).some((s) => s.removable))
    problems.push("these scans were imported from a folder, not from a card");
  return problems;
}

async function fileAt(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<[FileSystemDirectoryHandle, string] | null> {
  const parts = path.split("/");
  let dir = root;
  try {
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    await dir.getFileHandle(parts[parts.length - 1]);
    return [dir, parts[parts.length - 1]];
  } catch {
    return null;
  }
}

/** Delete this tray's scans from the card - only files that still match the verified copies. */
async function cleanupCard(job: Job, sid: string, cards: Map<string, FileSystemDirectoryHandle>) {
  const d = await loadSession(sid);
  const blockers = cleanupBlockers(d);
  if (blockers.length) throw new Error("Not cleaning the card: " + blockers.join("; "));
  const scans = Object.entries(d.scans).filter(([, s]) => s.removable && !s.source_deleted);
  job.total = scans.length;
  let deleted = 0;
  let missing = 0;
  let mismatched = 0;
  const done: string[] = [];
  for (const [k, sc] of scans) {
    job.done++;
    const card = cards.get(sc.source_root);
    const at = card && (await fileAt(card, sc.source));
    if (!at) {
      missing++;
      done.push(k);
      continue;
    }
    const f = await (await at[0].getFileHandle(at[1])).getFile();
    if (f.size !== sc.size || (await sha1Blob(f)) !== sc.sha1) {
      mismatched++; // a different photo now has that name: leave it alone
      continue;
    }
    await at[0].removeEntry(at[1]);
    done.push(k);
    deleted++;
  }
  await update(sid, (fresh) => {
    for (const k of done) fresh.scans[k].source_deleted = true;
    fresh.card_cleaned = mismatched === 0;
    log(fresh, `Card cleanup: deleted ${deleted}, not found ${missing}, left alone ${mismatched}`);
  });
  job.message =
    `Deleted ${deleted} scans from the card` +
    (missing ? `, ${missing} were already gone` : "") +
    (mismatched ? `, left ${mismatched} that didn't match` : "");
}

// ------------------------------------------------------------------ routes

type Body = Record<string, unknown>;

export async function handle(method: string, url: string, body: Body = {}): Promise<unknown> {
  const u = new URL(url, location.href);
  const path = u.pathname.replace(/^.*?\/api\//, "/api/");
  const is = (m: string, re: RegExp) => (method === m ? path.match(re) : null);
  let m: RegExpMatchArray | null;

  if (is("GET", /^\/api\/state$/)) {
    const cfg = loadConfig();
    const config: Config & Record<string, unknown> = {
      library: lib.name,
      storage: lib.kind,
      immich_url: cfg.immich_url,
      has_key: !!cfg.immich_key,
      keep_originals: cfg.keep_originals,
      keep_exports: cfg.keep_exports,
      learning_enabled: cfg.learning_enabled,
    };
    return { config, sources: await sourceList(), sessions: await listSessions(), job: current } satisfies AppState;
  }
  if (is("POST", /^\/api\/config$/)) {
    const cfg = loadConfig();
    for (const k of [
      "immich_url",
      "immich_key",
      "keep_originals",
      "keep_exports",
      "jpeg_quality",
      "learning_enabled",
    ] as const)
      if (k in body && !(k === "immich_key" && body[k] === "")) (cfg as Record<string, unknown>)[k] = body[k];
    saveConfig(cfg);
    return { ok: true };
  }
  if (is("POST", /^\/api\/immich\/test$/)) {
    const cfg = loadConfig();
    try {
      const c = new Immich(String(body.immich_url || cfg.immich_url), String(body.immich_key || cfg.immich_key));
      const v = await c.version();
      return { ok: true, message: `Connected to Immich ${v} as ${await c.whoami()}` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
  if (is("GET", /^\/api\/learning$/)) return { ...(await model()).stats(), enabled: loadConfig().learning_enabled };
  if (is("POST", /^\/api\/learning\/reset$/)) {
    (await model()).reset();
    return { ok: true };
  }
  if (is("POST", /^\/api\/sessions$/)) {
    const d = await createSession(
      String(body.name ?? "").trim(),
      String(body.album ?? "").trim() || null,
      String(body.date ?? "").trim(),
    );
    return { id: d.id };
  }
  if ((m = is("GET", /^\/api\/sessions\/([^/]+)$/))) {
    const d = await loadSession(m[1]);
    if (await syncLocks(structuredClone(d))) return payload((await update(m[1], syncLocks)).d); // originals deleted (or restored)
    return payload(d);
  }
  if ((m = is("PATCH", /^\/api\/sessions\/([^/]+)$/))) {
    const { d } = await update(m[1], (d) => {
      for (const k of ["name", "album", "date"] as const) if (k in body) d[k] = String(body[k]).trim();
      if ("defaults" in body) d.defaults = cleanParams(body.defaults as Params);
    });
    return payload(d);
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/import$/))) {
    const sid = m[1];
    await loadSession(sid);
    startJob("import", sid, (job) => importScans(job, sid, String(body.source)));
    return { ok: true };
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/(undo|redo)$/))) {
    const [, sid, gid, direction] = m;
    let stepped: string | null = null;
    const { d } = await update(sid, async (d) => {
      const g = group(d, gid);
      editable(g);
      const h = (g.history ??= { undo: [], redo: [] });
      const [src, dst] = direction === "undo" ? [h.undo, h.redo] : [h.redo, h.undo];
      const snap = src.pop();
      if (!snap) return;
      dst.push({ ...snapshot(g), what: snap.what, t: 0 });
      g.params = snap.params;
      g.rotation = snap.rotation;
      g.rot_reason = snap.rot_reason ?? "";
      g.params_source = snap.params_source ?? "";
      stepped = snap.what ?? null;
      await learn(d, g);
    });
    return { ...(await payload(d)), stepped };
  }
  if ((m = is("PATCH", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)$/))) {
    const [, sid, gid] = m;
    const { d } = await update(sid, async (d) => {
      const g = group(d, gid);
      if (Object.keys(body).some((k) => k !== "reviewed" && k !== "skip")) editable(g); // developed / left out are fine
      const what =
        "rotation" in body
          ? "rotation"
          : "params" in body
            ? "params:" +
              Object.keys(body.params as object)
                .sort()
                .join(",")
            : null;
      if (what) remember(g, what);
      if ("rotation" in body) {
        g.rotation = ((Math.trunc(Number(body.rotation)) % 360) + 360) % 360;
        g.rot_reason = "manual";
      }
      if ("params" in body) {
        g.params = cleanParams({ ...g.params, ...(body.params as object) });
        g.params_source = "manual";
      }
      for (const k of ["reviewed", "skip"] as const) if (k in body) g[k] = !!body[k];
      if ("date" in body) g.date = cleanDate(body.date);
      if ("caption" in body) g.caption = String(body.caption).trim().slice(0, 2000);
      await learn(d, g);
      if ("excluded" in body) {
        g.excluded = (body.excluded as string[]).filter((x) => g.scans.includes(x));
        if (g.excluded.length >= g.scans.length) g.excluded = g.scans.slice(1);
      }
    });
    return payload(d);
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/dates$/))) {
    const v = cleanDate(body.date ?? "");
    let dated = 0;
    const { d } = await update(m[1], (d) => {
      const [a, b] = [groupIndex(d, String(body.from)), groupIndex(d, String(body.to))].sort((x, y) => x - y);
      if (a < 0) throw new HttpError(404, "Slide not found");
      for (const g of d.groups.slice(a, b + 1)) {
        if (g.locked) continue;
        g.date = v;
        dated++;
      }
    });
    return { ...(await payload(d)), dated };
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/split$/))) {
    const [, sid, gid] = m;
    const { d } = await update(sid, (d) => {
      const g = group(d, gid);
      editable(g);
      const at = g.scans.indexOf(String(body.scan));
      if (at <= 0) return;
      const tail = newGroup(d, g.scans.slice(at), g.rotation, g.rot_reason);
      tail.params = { ...g.params };
      tail.excluded = (g.excluded ?? []).filter((x) => tail.scans.includes(x));
      g.scans = g.scans.slice(0, at);
      g.excluded = (g.excluded ?? []).filter((x) => g.scans.includes(x));
      d.groups.splice(groupIndex(d, gid) + 1, 0, tail);
    });
    return payload(d);
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/merge_next$/))) {
    const [, sid, gid] = m;
    const { d } = await update(sid, (d) => {
      const i = groupIndex(d, gid);
      if (i < 0 || i + 1 >= d.groups.length) throw new HttpError(400, "No next slide to merge with");
      editable(d.groups[i]);
      editable(d.groups[i + 1]);
      const [nxt] = d.groups.splice(i + 1, 1);
      d.groups[i].scans.push(...nxt.scans);
      d.groups[i].excluded.push(...(nxt.excluded ?? []));
      if (nxt.immich) (d.orphan_assets ??= []).push(nxt.immich.asset_id);
    });
    return payload(d);
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/apply$/))) {
    const { d } = await update(m[1], (d) => {
      const p = cleanParams(body.params as Params);
      const start = body.from ? groupIndex(d, String(body.from)) : 0;
      d.groups.forEach((g, i) => {
        if (g.locked) return;
        if (body.scope === "all" || (!g.reviewed && (body.scope !== "rest" || i > start))) {
          // colour carries over, framing (crop / straighten) is each slide's own
          remember(g, "apply");
          g.params = { ...p, angle: g.params.angle ?? FRAMING.angle, crop: g.params.crop ?? FRAMING.crop };
        }
      });
      if (body.as_default) d.defaults = { ...p, ...FRAMING };
    });
    return payload(d);
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/resuggest$/))) {
    const [, sid, gid] = m;
    let applied = 0;
    const mdl = await model();
    const { d } = await update(sid, (d) => {
      const targets = body.all ? d.groups : [group(d, gid)];
      for (const g of targets) {
        if (g.reviewed || g.skip || g.locked || !g.feat) continue;
        const [sug, n] = mdl.suggest(g.feat);
        if (sug) {
          remember(g, "learned");
          g.params = cleanParams({ ...g.params, ...sug });
          g.params_source = `learned:${n}`;
          applied++;
        }
      }
    });
    return { ...(await payload(d)), applied };
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/fit_curves$/))) {
    const [, sid, gid] = m;
    let d = await loadSession(sid);
    if (!body.all) editable(group(d, gid));
    const targets = body.all ? d.groups.filter((g) => !g.reviewed && !g.skip && !g.locked) : [group(d, gid)];
    const fitted = new Map<string, [string[], Params["curves"]]>();
    for (const g of targets) {
      // the slow part, outside the lock
      const p = cleanParams({ ...g.params, strength: 0 });
      fitted.set(g.id, [activeScans(g), await ui.call("fit", { src: await fusedSrc(d, g), params: p }, 5)]);
    }
    d = (
      await update(sid, async (fresh) => {
        for (const fg of fresh.groups) {
          const f = fitted.get(fg.id);
          if (!f || activeScans(fg).join() !== f[0].join()) continue;
          remember(fg, "fit");
          fg.params = cleanParams({ ...fg.params, strength: 0, curves: f[1] });
          fg.params_source = "manual";
          await learn(fresh, fg);
        }
      })
    ).d;
    return { ...(await payload(d)), fitted: fitted.size };
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/neutral$/))) {
    const [, sid, gid] = m;
    const d0 = await loadSession(sid);
    const g0 = group(d0, gid);
    editable(g0);
    const [warmth, tint] = await ui.call(
      "neutral",
      { src: await fusedSrc(d0, g0), rotation: g0.rotation, params: g0.params, x: Number(body.x), y: Number(body.y) },
      5,
    );
    const { d } = await update(sid, async (d) => {
      const g = group(d, gid);
      remember(g, "neutral");
      g.params = cleanParams({ ...g.params, warmth, tint });
      g.params_source = "manual";
      await learn(d, g);
    });
    return payload(d);
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/mount$/))) {
    // the mount's tilt, found if it isn't yet; apply: straighten to it, trim: also crop to its window
    const [, sid, gid] = m;
    const d0 = await loadSession(sid);
    const g0 = group(d0, gid);
    if (body.apply) editable(g0);
    const mount = await mountOf(d0, g0); // the slow part, outside the lock
    const set: Partial<Params> = {};
    if (body.apply) {
      if (mount.confidence <= 0) throw new HttpError(400, "No slide mount found around this photo");
      set.angle = -mount.angle || 0;
      if (body.trim)
        set.crop = await ui.call(
          "mountCrop",
          {
            src: await fusedSrc(d0, g0),
            rotation: g0.rotation,
            params: cleanParams({ ...g0.params, ...set }),
            box: rotateBox(mount.box, g0.rotation),
          },
          5,
        );
    }
    const { d } = await update(sid, (d) => {
      const g = group(d, gid);
      if (activeScans(g).join() !== mount.scans.join()) return;
      g.mount = mount;
      if (Object.keys(set).length) {
        remember(g, "mount");
        g.params = cleanParams({ ...g.params, ...set });
      }
    });
    return payload(d);
  }
  if ((m = is("GET", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/histogram$/))) {
    const d = await loadSession(m[1]);
    const g = group(d, m[2]);
    return ui.call("histogram", { src: await fusedSrc(d, g), params: g.params }, 4);
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/finish$/))) {
    const sid = m[1];
    const d = await loadSession(sid);
    const cfg = loadConfig();
    const target: Target = body.target === "disk" ? "disk" : "immich";
    if (target === "immich" && (!cfg.immich_url || !cfg.immich_key))
      throw new HttpError(400, "Set your Immich URL and API key in Settings first.");
    if (!d.groups.length) throw new HttpError(400, "Nothing to upload yet.");
    // a folder to save into, picked now while the click that asked for it still counts
    let folder: FileSystemDirectoryHandle | undefined;
    if (target === "disk" && lib.kind !== "disk" && canPickFolders) {
      try {
        folder = await pickDirectory({ id: "export", mode: "readwrite", startIn: "pictures" });
      } catch {
        return { ok: false, cancelled: true };
      }
    }
    startJob(target === "disk" ? "save" : "upload", sid, (job) =>
      finishSession(job, sid, !!body.only_ready, target, folder),
    );
    return { ok: true };
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/cleanup$/))) {
    const sid = m[1];
    const d = await loadSession(sid);
    const b = cleanupBlockers(d);
    if (b.length) throw new HttpError(400, b.join("; "));
    // write access to the card, asked for now while the click that started this still counts
    const cards = new Map<string, FileSystemDirectoryHandle>();
    for (const root of new Set(
      Object.values(d.scans)
        .filter((s) => s.removable)
        .map((s) => s.source_root),
    )) {
      const h = await kvGet<FileSystemDirectoryHandle>(`card:${root.replace(/^browser:/, "")}`);
      if (!h || (await permission(h, "readwrite", true)) !== "granted")
        throw new HttpError(
          400,
          `Pick the card “${root.replace(/^browser:/, "")}” again (Import) so it can be cleaned.`,
        );
      cards.set(root, h);
    }
    startJob("cleanup", sid, (job) => cleanupCard(job, sid, cards));
    return { ok: true };
  }
  if (is("POST", /^\/api\/eject$/))
    return { ok: true, message: "Eject the card from your computer (Finder or Explorer)." };
  if (is("POST", /^\/api\/reveal$/))
    return {
      ok: true,
      path:
        lib.kind === "disk"
          ? `${lib.name}/sessions/${body.session}/export`
          : "Finished slides live in the browser's storage here; use “Save to disk” to get them out.",
    };
  throw new HttpError(404, `No such route: ${method} ${path}`);
}

function cleanDate(v: unknown): string {
  const s = String(v ?? "")
    .trim()
    .replace(/\//g, "-");
  if (s && !parseDate(s)) throw new HttpError(400, "Use a year, year-month or full date: 1978, 1978-06, 1978-06-14");
  return s;
}

// ------------------------------------------------------------------ switching libraries

/** Current library, for the settings screen. */
export const currentLibrary = () => lib;
export const changeLibrary = (l: Library) => {
  setLibrary(l);
  onLibraryChange?.(l);
};
export { ImmichError };
