// The Python app's HTTP API (slidestation/server.py + workflow.py), answered inside the page, so
// the same React UI runs with no backend at all. Every route keeps the Python semantics — undo
// history, render keys, locked slides, dedupe, the upload rules — over a Library (library.ts)
// instead of the file system, with the pixel work in web workers (engine.ts).
import type {
  AppState,
  Config,
  FullInfo,
  Job,
  Params,
  Preset,
  SessionPayload,
  Source,
  SuggestionModel,
} from "@/lib/api";
import { DEFAULT_TARGET, libraryStats, slideTimes } from "@/lib/stats";
import { jobs, ui } from "./engine";
import type { ModelRef, Src } from "./engine.worker";
import { exifSegment, readExif, withExif, xmpSegment } from "./exif";
import {
  cleanParams,
  groupSequence,
  mirrorBox,
  mirrorParams,
  MOUNT_AUTO,
  rotateBox,
  turnLocal,
  weakScans,
  type Quality,
} from "./imaging";
import { Immich, ImmichError, NotIndexed, Unsupported, type Asset } from "./immich";
import { dot, LABELS_KEY, MODEL_ID, promptBatch, tagSuggestions, TAGS, Tokenizer, type Learned } from "./clip";
import { cleanStock, effective, label, Labels, views } from "./filmstock";
import {
  cleanTags,
  insightsKey,
  KINDS as INSIGHT_KINDS,
  merge as mergeInsights,
  needsAnalysis,
  pending as pendingInsights,
  setTags,
  slideInsights,
  placeSuggestion,
  suggestBetween,
} from "./insights";
import { Model } from "./learning";
import { canPickFolders, kvGet, kvSet, permission, pickDirectory, type Library } from "./library";
import { CLIP, fetchFiles, filesReady, megabytes, source } from "./models";
import { npy, readNpy } from "./npy";
import {
  emptyPeople,
  faceKey,
  merge as mergePeople,
  MODEL_MB as PEOPLE_MB,
  MODEL_NAME as SFACE_NAME,
  recordFaces,
  refresh as refreshPeopleData,
  removeFaces,
  rename as renamePerson,
  SFACE,
  slideNames,
  stale,
  tagName,
  type FacesFile,
  type PeopleFile,
} from "./people";
import { alphabet, OCR, OCR_DIR, OCR_ID } from "./ocr";
import {
  GAZETTEER,
  GAZETTEER_DIR,
  GAZETTEER_MB,
  Gazetteer,
  placeFromText,
  search as searchPlaces,
  unzipEntry,
} from "./places";
import {
  CANDIDATES,
  DATE_CANDIDATES,
  dateWindow,
  dismiss as dismissSimilar,
  emptyEmbeddings,
  KINDS as SIMILAR_KINDS,
  LOOKALIKE,
  lookalikeView,
  pack,
  pending as pendingEmbeddings,
  slideKey,
  suggest as suggestSimilar,
  threshold as dupThreshold,
  todo as todoEmbeddings,
  unpack,
  type Embeddings,
  type SlideEmb,
} from "./similar";
import { LANDMARKS, MODEL_ID as EYES_MODEL, type EyesEntry } from "./eyes";
import {
  activeScans,
  cleanPlace,
  dumpSession,
  groupStatus,
  metaKey,
  newGroup,
  parseDate,
  randomHex,
  renderKey,
  samePlace,
  sha1Hex,
  slideDates,
  slugify,
  statuses,
  summary,
  toneKey,
  type GroupData,
  type ImmichRecord,
  type Place,
  type Scan,
  type SessionData,
  type Snapshot,
  type StoredInsights,
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
  upload_originals_stacked: boolean;
  stats_target: number;
  /** Scene tags and look-alikes from CLIP (downloads the model), and the look-alike check in Immich. */
  insights_enabled: boolean;
  lookalike_enabled: boolean;
  /** Faces -> people (downloads SFace), names to Immich as tags. */
  people_enabled: boolean;
  /** Look-alikes prefer the shot with open eyes (downloads the face mesh; with the tag model only). */
  eyes_enabled: boolean;
  /** One Immich album for every tray (its id; "" = an album per tray), and its name to show. */
  immich_album: string;
  immich_album_name: string;
  /** Each uploaded photo tagged Trays/<tray name>. */
  tag_trays: boolean;
};

const CONFIG_KEY = "slide-station-config";
const DEFAULT_CONFIG: StoredConfig = {
  immich_url: "",
  immich_key: "",
  keep_originals: true,
  keep_exports: false,
  learning_enabled: true,
  jpeg_quality: 95,
  upload_originals_stacked: false,
  stats_target: DEFAULT_TARGET,
  insights_enabled: false,
  lookalike_enabled: false,
  people_enabled: false,
  eyes_enabled: false,
  immich_album: "",
  immich_album_name: "",
  tag_trays: true,
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
  activeSession = null;
  learningModel = null;
  stockLabels = null;
  importedIndex = null;
  queuedTrays.length = 0;
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
  else if (g.reviewed || g.immich) m.remember(key, g.feat, g.params, effective(d, g));
}

// ------------------------------------------------------------------ film stock (filmstock.ts)

let stockLabels: Labels | null = null;
async function labels(): Promise<Labels> {
  if (!stockLabels) {
    let data: unknown = null;
    try {
      data = JSON.parse((await lib.readText("stocks.json")) ?? "null");
    } catch {
      /* start fresh */
    }
    stockLabels = new Labels(data, (json) => void lib.write("stocks.json", JSON.stringify(json, null, 1)));
  }
  return stockLabels;
}

/** A slide's film stock (or the tray's) changed: its label and its learning example follow. */
async function stockChanged(d: SessionData, gs: GroupData[]) {
  const l = await labels();
  for (const g of gs) {
    label(l, d, g);
    await learn(d, g);
  }
}

function checkedStock(v: unknown): string {
  const s = cleanStock(v);
  if (s === null)
    throw new HttpError(
      400,
      "Film stock must be one of kodachrome, ektachrome, agfachrome, fujichrome, other, unknown",
    );
  return s;
}

function setStock(g: GroupData, v: string) {
  if (v) g.stock = v;
  else delete g.stock;
}

// ------------------------------------------------------------------ insights: scene tags, look-alikes

// The scene-tag model (clip.ts, insights.py) in the jobs worker: downloaded on request into the
// library's models/clip-vit-b32/ (models.ts), the same files and label cache as the desktop app.
const CLIP_DIR = `models/${MODEL_ID}`;
const clipSource = () => source(MODEL_ID, CLIP);
let clipReady: { t: number; lib: Library; ready: boolean } | null = null;

/** Every file of the tag model there at its size (asked on every poll: cached for 2 s). */
async function modelReady(): Promise<boolean> {
  if (clipReady?.lib === lib && Date.now() - clipReady.t < 2000) return clipReady.ready;
  const ready = await filesReady(lib, CLIP_DIR, clipSource());
  clipReady = { t: Date.now(), lib, ready };
  return ready;
}

// The eye model (eyes.ts, eyes.py): MediaPipe's face mesh into models/face-landmarks-478/, on only
// with the tag model; look-alikes prefer the shot where nobody blinked.
const EYES_DIR = `models/${EYES_MODEL}`;
const eyesSource = () => source(EYES_MODEL, LANDMARKS);
let eyesReady: { t: number; lib: Library; ready: boolean } | null = null;

async function eyesModelReady(): Promise<boolean> {
  if (eyesReady?.lib === lib && Date.now() - eyesReady.t < 2000) return eyesReady.ready;
  const ready = await filesReady(lib, EYES_DIR, eyesSource());
  eyesReady = { t: Date.now(), lib, ready };
  return ready;
}

const eyesEnabled = () => !!loadConfig().eyes_enabled && !!loadConfig().insights_enabled;
const eyesOn = async () => eyesEnabled() && (await eyesModelReady());

/** What analyses a slide now (insights.active_models): the tag model turned on and downloaded; the
 *  text reader once it and the place names are there. Part of every slide's insights key. */
async function activeModels(): Promise<string[]> {
  const out = loadConfig().insights_enabled && (await modelReady()) ? [MODEL_ID, LABELS_KEY] : [];
  if (await ocrOn()) out.push(OCR_ID); // signs are read for places
  return out;
}

async function modelFile(name: string, dir = CLIP_DIR): Promise<ModelRef> {
  const f = await lib.read(`${dir}/${name}`);
  if (!f) throw new Error(`The model file ${dir}/${name} is missing`);
  return { key: `${lib.name}/${dir}/${name}:${f.size}:${f.lastModified}`, blob: f };
}

// Places: GeoNames' cities (places.ts) and the text reader (ocr.ts), into data/geonames/ and
// models/ppocr/ like the desktop app. A gazetteer the desktop app downloaded (another day's files,
// other sizes) counts too: ready = the three files are there, as in places.gazetteer_ready.
const ocrSource = () => source(OCR_ID, OCR);
const gazSource = () => source("geonames", GAZETTEER);
let ocrState: { t: number; lib: Library; gaz: boolean; ocr: boolean } | null = null;

async function placesState() {
  if (ocrState?.lib !== lib || Date.now() - ocrState.t > 2000) {
    let gaz = true;
    for (const [, name] of gazSource().files) gaz &&= await lib.exists(`${GAZETTEER_DIR}/${name}`);
    ocrState = { t: Date.now(), lib, gaz, ocr: await filesReady(lib, OCR_DIR, ocrSource()) };
  }
  return ocrState;
}
const gazetteerReady = async () => (await placesState()).gaz;
/** Signs are read for places once the text reader and the place names are downloaded. */
const ocrOn = async () => {
  const s = await placesState();
  return s.gaz && s.ocr;
};

let gazCache: { lib: Library; stamp: number; gaz: Promise<Gazetteer> } | null = null;

/** The loaded gazetteer (parsed once, again when the files change), or null while it isn't there. */
async function gazetteer(): Promise<Gazetteer | null> {
  if (!(await gazetteerReady())) return null;
  const zip = await lib.read(`${GAZETTEER_DIR}/cities15000.zip`);
  if (!zip) return null;
  if (gazCache?.lib !== lib || gazCache.stamp !== zip.lastModified) {
    const gaz = (async () => {
      const cities = new TextDecoder().decode(await unzipEntry(zip, "cities15000.txt"));
      const [country, admin] = [
        await lib.readText(`${GAZETTEER_DIR}/countryInfo.txt`),
        await lib.readText(`${GAZETTEER_DIR}/admin1CodesASCII.txt`),
      ];
      return new Gazetteer(cities, country ?? "", admin ?? "");
    })();
    const entry = { lib, stamp: zip.lastModified, gaz };
    gazCache = entry;
    gaz.catch(() => gazCache === entry && (gazCache = null));
  }
  return gazCache.gaz;
}

/** Fetch the place names that are missing (a job; the pinned snapshot is checked against its checksums). */
async function downloadGazetteer(job: Job) {
  const src = gazSource();
  const missing = [];
  for (const f of src.files) if (!(await lib.exists(`${GAZETTEER_DIR}/${f[1]}`))) missing.push(f);
  if (missing.length) await fetchFiles(lib, job, { ...src, files: missing }, GAZETTEER_DIR, "place names");
  ocrState = null;
  job.message = "Place names ready";
}

let ocrChars: { key: string; chars: string[] } | null = null;

/** The text in a slide's upright blend, a line each (places.read_text). */
async function readText(d: SessionData, g: GroupData) {
  const [det, rec, dict] = [
    await modelFile("det.onnx", OCR_DIR),
    await modelFile("rec.onnx", OCR_DIR),
    await modelFile("dict.txt", OCR_DIR),
  ];
  if (ocrChars?.key !== dict.key) ocrChars = { key: dict.key, chars: alphabet(await dict.blob.text()) };
  const src = await fusedSrc(d, g, jobs);
  return jobs.call("ocrRead", { det, rec, chars: ocrChars.chars, src, rotation: g.rotation, mirror: !!g.mirror }, -1);
}

let labelCache: { lib: Library; rows: Promise<Float32Array> } | null = null;

/** The label prompts' embeddings, computed once with the text model and kept as
 *  labels-<key>.npy next to it (the desktop app reads and writes the same file). */
function labelEmbeds(): Promise<Float32Array> {
  if (labelCache?.lib !== lib) {
    const rows = (async () => {
      const path = `${CLIP_DIR}/labels-${LABELS_KEY}.npy`;
      const hit = await lib.read(path);
      if (hit) return readNpy(hit);
      const [vocab, merges] = [
        await lib.readText(`${CLIP_DIR}/vocab.json`),
        await lib.readText(`${CLIP_DIR}/merges.txt`),
      ];
      const b = promptBatch(new Tokenizer(JSON.parse(vocab ?? "{}"), merges ?? ""));
      const out = await jobs.call(
        "clipText",
        { model: await modelFile("text.onnx"), ids: b.ids, length: b.length },
        -1,
      );
      await lib.write(path, npy(out, [TAGS.length, out.length / TAGS.length]));
      return out;
    })();
    const entry = { lib, rows };
    labelCache = entry;
    rows.catch(() => labelCache === entry && (labelCache = null)); // try again next time
  }
  return labelCache!.rows;
}

// insights.json: accepts and dismisses counted per label (tags) or kind (look-alikes); the
// thresholds rise with dismissals. Writes are queued, so one read-modify-write follows another.
let learnedQueue: Promise<void> = Promise.resolve();

async function learned(): Promise<Learned> {
  await learnedQueue;
  try {
    const d = JSON.parse((await lib.readText("insights.json")) ?? "null");
    return d && typeof d === "object" ? { labels: {}, ...d } : { labels: {} };
  } catch {
    return { labels: {} };
  }
}

/** Count an accept / dismiss (insights.record). */
function record(kind: string, value: string, action: string, n = 1) {
  if (!["tags", "duplicates", "split", "merge"].includes(kind) || !["accept", "dismiss"].includes(action) || n <= 0)
    return;
  const l = lib;
  learnedQueue = learnedQueue
    .then(async () => {
      let d: Learned = { labels: {} };
      try {
        d = { labels: {}, ...JSON.parse((await l.readText("insights.json")) ?? "{}") };
      } catch {
        /* start fresh */
      }
      const c = (d.labels[value] ??= { accepted: 0, dismissed: 0 });
      c[action === "accept" ? "accepted" : "dismissed"] += n;
      await l.write("insights.json", JSON.stringify(d, null, 1));
    })
    .catch((e) => console.warn("insights.json:", e));
}

// embeddings.json per tray (similar.py): derived data next to session.json, never in it; its own
// queue for reload-apply-save, so the background helper never waits for the session lock
const embPath = (sid: string) => `${sessionDir(sid)}/embeddings.json`;
let embQueue: Promise<unknown> = Promise.resolve();

async function loadEmb(sid: string): Promise<Embeddings> {
  try {
    const e = JSON.parse((await lib.readText(embPath(sid))) ?? "{}");
    return { slides: e.slides ?? {}, scans: e.scans ?? {} };
  } catch {
    return emptyEmbeddings();
  }
}

function updateEmb(sid: string, fn: (e: Embeddings) => void): Promise<void> {
  const run = embQueue.then(async () => {
    const e = await loadEmb(sid);
    fn(e);
    await lib.write(embPath(sid), JSON.stringify(e, null, 1));
  });
  embQueue = run.catch(() => undefined);
  return run;
}

/** Keep a slide's embedding (of its upright blend) and the blend's sharpness / clipping, and how open
 *  its faces' eyes are when the eye model is on (similar.record_slide). */
const recordSlide = async (sid: string, d: SessionData, g: GroupData, emb: Float32Array, q: Quality) => {
  const entry: SlideEmb = { key: slideKey(g), emb: pack(emb), q };
  if (await eyesOn()) entry.eyes = await measureEyes(d, g);
  return updateEmb(sid, (e) => void (e.slides[g.id] = entry));
};

/** eyes.measure in the jobs worker; a failure noted (so it isn't retried forever) rather than thrown. */
async function measureEyes(d: SessionData, g: GroupData): Promise<EyesEntry> {
  try {
    const model = await modelFile(LANDMARKS.files[0][1], EYES_DIR);
    return await jobs.call("eyes", { model, src: await fusedSrc(d, g, jobs), rotation: g.rotation, mirror: !!g.mirror }, -1);
  } catch (e) {
    console.warn("eyes:", e);
    return { model: EYES_MODEL, ear: [], error: (e instanceof Error ? e.message : String(e)) || "error" };
  }
}

/** A scan's grouping signature, for the merge check (null when it isn't cached). */
const sigOf = (sid: string) => async (scan: string) => {
  const f = await lib.read(cachePath(sid, `${scan}.sig.npy`));
  return f ? readNpy(f) : null;
};

/** One slide analysed: CLIP on its upright blend -> tag suggestions, kept only if the slide is still
 *  the same slide afterwards (insights.analyse_slide). The embedding is kept for look-alikes. */
async function analyseSlide(sid: string, gid: string, models: string[]) {
  const d = await loadSession(sid);
  const g = group(d, gid);
  const fresh: StoredInsights & { key: string } = { key: insightsKey(g, models) };
  if (models.includes(MODEL_ID)) {
    const model = await modelFile("vision.onnx");
    const r = await jobs.call("clipImage", { model, src: await fusedSrc(d, g, jobs), rotation: g.rotation, mirror: !!g.mirror }, -1);
    fresh.tags = tagSuggestions(await labelEmbeds(), r.emb, await learned());
    await recordSlide(sid, d, g, r.emb, r.quality);
  }
  if (models.includes(OCR_ID)) {
    // signs: the text in the photo, and a place it names
    const [lines, gaz] = [await readText(d, g), await gazetteer()];
    if (gaz) {
      fresh.text = lines.slice(0, 20);
      const hit = placeFromText(lines, gaz);
      if (hit) fresh.place = placeSuggestion(hit.place, hit.confidence, OCR_ID, hit.text);
    }
  }
  await update(sid, (f) => {
    const fg = f.groups.find((x) => x.id === gid);
    if (!fg || insightsKey(fg, models) !== fresh.key || fg.insights?.key === fresh.key) return;
    fg.insights = mergeInsights(fg.insights, fresh, fg.tags ?? [], fg.caption ?? "", fg.place ?? null);
  });
}

/** The embeddings of slides from before (or turned since) and of every scan (similar.step). A slide or
 *  scan that fails gets an entry with `error`, so it isn't tried forever. */
async function similarStep(d: SessionData): Promise<boolean> {
  const { g, scan, look } = todoEmbeddings(d, await loadEmb(d.id), await eyesOn());
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "error";
  if (g) {
    try {
      const model = await modelFile("vision.onnx");
      const r = await jobs.call("clipImage", { model, src: await fusedSrc(d, g, jobs), rotation: g.rotation, mirror: !!g.mirror }, -1);
      await recordSlide(d.id, d, g, r.emb, r.quality);
    } catch (e) {
      console.warn("similar:", e);
      const entry = { key: slideKey(g), error: why(e) };
      await updateEmb(d.id, (x) => void (x.slides[g.id] = entry));
    }
    return true;
  }
  if (scan) {
    let entry: Embeddings["scans"][string];
    try {
      await ensureProxies(d, scan);
      const blob = await readCache(d.id, `${scan}.proxy.jpg`);
      const r = await jobs.call("clipScan", { model: await modelFile("vision.onnx"), blob }, -1);
      entry = { emb: pack(r.emb), lum: r.lum };
    } catch (e) {
      console.warn("similar:", e);
      entry = { error: why(e) };
    }
    await updateEmb(d.id, (x) => void (x.scans[scan] = entry));
    return true;
  }
  if (look) {
    // the eye model came later: measure the slide's eyes, kept only if it is still the same slide
    const found = await measureEyes(d, look);
    const key = slideKey(look);
    await updateEmb(d.id, (x) => {
      if (x.slides[look.id]?.key === key) x.slides[look.id].eyes = found;
    });
    return true;
  }
  return false;
}

// Background analysis (insights.step / _worker): the open tray first, then trays queued with
// "Analyse", one slide at a time, only while no job runs (imports reshape slides, uploads need the
// memory). Runs next to the background renderer; the jobs worker takes its calls last.
const queuedTrays: string[] = [];
let insightsBusy: Promise<void> | null = null;
let clipLoaded = false;

async function insightsStep(): Promise<boolean> {
  const models = await activeModels();
  if (!models.length) {
    if (clipLoaded) void jobs.call("clipRelease", undefined).catch(() => undefined); // turned off: let go of it
    clipLoaded = false;
    return false;
  }
  if (jobRunning()) return false;
  for (const sid of [...new Set([activeSession, ...queuedTrays])]) {
    if (!sid) continue;
    let d: SessionData | null = null;
    try {
      d = await loadSession(sid);
    } catch {
      /* deleted */
    }
    const g = d?.groups.find((x) => needsAnalysis(x, models));
    clipLoaded = true;
    if (!g) {
      // analysed: then the embeddings for look-alikes (slides from before, scans)
      if (d && models.includes(MODEL_ID) && (await similarStep(d))) return true;
      if (queuedTrays.includes(sid)) queuedTrays.splice(queuedTrays.indexOf(sid), 1);
      continue;
    }
    try {
      await analyseSlide(sid, g.id, models);
    } catch (e) {
      // e.g. an unreadable scan: note it, don't try that slide forever
      console.warn("insights:", e);
      const key = insightsKey(g, models);
      const err = (e instanceof Error ? e.message : String(e)) || "error";
      await update(sid, (f) => {
        const fg = f.groups.find((x) => x.id === g.id);
        if (fg && insightsKey(fg, models) === key)
          fg.insights = {
            ...mergeInsights(fg.insights, { key }, fg.tags ?? [], fg.caption ?? "", fg.place ?? null),
            error: err,
          };
      });
    }
    return true;
  }
  return false;
}

function kickInsights() {
  if (insightsBusy || !lib) return;
  const l = lib;
  insightsBusy = (async () => {
    while (lib === l && (await insightsStep()));
  })()
    .catch((e) => console.warn("insights:", e))
    .finally(() => (insightsBusy = null));
}

/** Top-level insights state for the tray payload, and the look-alike suggestions once the tag model
 *  is there (server._insights_payload). `pending` counts slides to analyse plus slides and scans
 *  to embed: the UI keeps reloading the tray while it's above 0. */
async function insightsPayload(d: SessionData, models: string[]) {
  const on = !!loadConfig().insights_enabled;
  const ready = on && (await modelReady());
  const status = {
    enabled: on,
    ready,
    pending: pendingInsights(d.groups, models),
    missing: [
      ...(on && !ready ? ["tags"] : []),
      ...(eyesEnabled() && !(await eyesModelReady()) ? ["eyes"] : []),
    ] as SuggestionModel[],
  };
  if (!ready) return { insights: status, similar: null };
  const e = await loadEmb(d.id);
  const all = await suggestSimilar(d, e, dupThreshold(await learned()), sigOf(d.id));
  // a slide still to analyse gets its embedding from that same analysis: count it once
  const overlap = d.groups.filter(
    (g) => !g.skip && needsAnalysis(g, models) && e.slides[g.id]?.key !== slideKey(g),
  ).length;
  status.pending += pendingEmbeddings(d, e, await eyesOn()) - overlap;
  return { insights: status, similar: all };
}

/** Give a slide its own caption (server._set_caption): an open caption suggestion goes, and
 *  suggestions that were up to date stay so. */
function setCaption(g: GroupData, caption: string, models: string[]) {
  const fresh = !!g.insights && !needsAnalysis(g, models);
  g.caption = caption;
  const ins = g.insights;
  if (!ins || !caption) return;
  if (ins.caption?.state === "suggested") ins.caption = null;
  if (fresh) ins.key = insightsKey(g, models);
}

/** Set (or clear) a slide's place; an open place suggestion is settled by it (server._set_place). */
function setPlace(g: GroupData, p: Place | null) {
  if (p) g.place = p;
  else delete g.place;
  const e = g.insights?.place;
  if (p && e?.state === "suggested") e.state = samePlace(e.place, p) ? "accepted" : "dismissed";
}

/** Accept or dismiss a slide's open suggestion(s) of one kind (server._decide). Whether anything changed. */
function decideOne(
  g: GroupData,
  kind: string,
  action: string,
  value: string | null,
  text: string | null,
  models: string[],
) {
  const ins = g.insights ?? {};
  if (kind === "tags") {
    const hits = (ins.tags ?? []).filter((e) => (value === null || e.value === value) && e.state === "suggested");
    if (!hits.length) return false;
    const tags = [...(g.tags ?? [])];
    for (const e of hits) {
      e.state = action === "accept" ? "accepted" : "dismissed";
      record("tags", e.value, action);
      if (action === "accept" && !tags.includes(e.value)) tags.push(e.value);
      else if (action === "dismiss" && tags.includes(e.value)) tags.splice(tags.indexOf(e.value), 1);
    }
    if (tags.length) g.tags = tags;
    else delete g.tags;
    return true;
  }
  const k = kind as "caption" | "date" | "place" | "stock";
  const e = ins[k];
  if (!e || (value !== null && e.value !== value) || e.state !== "suggested") return false;
  if (action === "accept") {
    if (k === "date") g.date = cleanDate(e.value);
    else if (k === "caption") {
      if (g.caption) return false; // typed (or pulled from Immich) meanwhile: that one stays
      const caption = String(text ?? e.value)
        .split(/\s+/)
        .filter(Boolean)
        .join(" ")
        .slice(0, 2000);
      if (!caption) return false;
      e.state = "accepted";
      setCaption(g, caption, models);
      return true;
    } else if (k === "stock") setStock(g, e.value);
    else g.place = placeOf(e.place) ?? undefined;
  }
  e.state = action === "accept" ? "accepted" : "dismissed";
  return true;
}

/** Scans from `scan` on become a new slide right after this one (server._split). */
function splitAt(d: SessionData, g: GroupData, scan: string) {
  const at = g.scans.indexOf(scan);
  if (at <= 0) return false;
  const tail = newGroup(d, g.scans.slice(at), g.rotation, g.rot_reason);
  tail.params = { ...g.params };
  tail.mirror = !!g.mirror;
  tail.excluded = (g.excluded ?? []).filter((x) => tail.scans.includes(x));
  if (g.tags?.length) tail.tags = [...g.tags];
  if (g.stock) tail.stock = g.stock; // one piece of film
  g.scans = g.scans.slice(0, at);
  g.excluded = (g.excluded ?? []).filter((x) => g.scans.includes(x));
  d.groups.splice(groupIndex(d, g.id) + 1, 0, tail);
  return true;
}

/** The slide after slide i becomes more scans of it (server._merge_next). */
function mergeNext(d: SessionData, i: number) {
  const [nxt] = d.groups.splice(i + 1, 1);
  const g = d.groups[i];
  g.scans.push(...nxt.scans);
  g.excluded.push(...(nxt.excluded ?? []));
  if (nxt.tags?.length) g.tags = [...(g.tags ?? []), ...nxt.tags.filter((t) => !(g.tags ?? []).includes(t))];
  if (nxt.immich) (d.orphan_assets ??= []).push(nxt.immich.asset_id);
  if (nxt.immich?.stack_id) (d.orphan_stacks ??= []).push(nxt.immich.stack_id); // restacked under the merged one
}

/** A look-alike suggestion by its id (server._decide_similar). Accept: duplicates keep one slide
 *  (`keep`, default the best) and skip the rest; split cuts the stack; merge joins the two. */
async function decideSimilar(sid: string, kind: string, action: string, value: string, keep: string | null) {
  const { d } = await update(sid, async (d) => {
    const all = await suggestSimilar(d, await loadEmb(sid), dupThreshold(await learned()), sigOf(sid));
    const sug = all[kind as "duplicates" | "split" | "merge"].find((x) => x.id === value);
    if (!sug) throw new HttpError(404, "That suggestion no longer applies (the slides changed)");
    if (action === "dismiss") dismissSimilar(d, sug);
    else if (kind === "duplicates") {
      const k = keep && sug.groups.includes(keep) ? keep : sug.best;
      for (const gid of sug.groups)
        if (gid !== k) {
          const g = group(d, gid);
          g.skip = true;
          await learn(d, g);
        }
    } else if (kind === "split") {
      const g = group(d, sug.groups[0]);
      editable(g);
      splitAt(d, g, sug.scan!);
    } else {
      const i = groupIndex(d, sug.groups[0]);
      if (i + 1 >= d.groups.length || d.groups[i + 1].id !== sug.groups[1])
        throw new HttpError(409, "These slides are no longer next to each other");
      mergeNext(d, i);
    }
  });
  record(kind, kind, action);
  return { ...(await payload(d)), decided: 1 };
}

/** A photo in Immich that looks like this slide's upload (server._decide_lookalike). Accept =
 *  replace it: the new upload joins its albums (and becomes a favourite if it was), it goes to the
 *  Immich trash. Dismiss: keep both. */
async function decideLookalike(sid: string, action: string, value: string, gids: string[]) {
  if (gids.length !== 1) throw new HttpError(400, "Give the slide (groups: [id])");
  const g = group(await loadSession(sid), gids[0]);
  const match = g.immich?.lookalike?.matches.find((x) => x.id === value);
  if (!match || match.state !== "suggested") throw new HttpError(404, "No such look-alike for this slide");
  if (action === "accept") {
    const c = immichClient();
    const carry = await carryOver(c, value);
    for (const a of carry.albums) await c.addToAlbum(a, [g.immich!.asset_id]);
    if (carry.favorite) await c.updateAsset(g.immich!.asset_id, { isFavorite: true });
    await c.trash([value]);
  }
  const { d } = await update(sid, (fresh) => {
    for (const x of group(fresh, g.id).immich?.lookalike?.matches ?? [])
      if (x.id === value) x.state = action === "accept" ? "accepted" : "dismissed";
  });
  return { ...(await payload(d)), decided: 1 };
}

/**
 * After upload: does Immich hold a photo that looks like each of these slides (similar.check_lookalikes)?
 * Candidates from Immich's smart search by image (no scores), else the photos taken around the
 * slide's date; each verified here, its thumbnail and the upload's through the local CLIP.
 */
async function checkLookalikes(c: Immich, sid: string, gids: string[], job?: Job) {
  let d = await loadSession(sid);
  const dates = slideDates(d);
  const own = new Set<string>();
  for (const g of d.groups) {
    for (const x of [g.immich?.asset_id, g.source_asset?.id]) if (x) own.add(x);
    for (const x of Object.values(g.immich?.originals ?? {})) own.add(x);
  }
  const model = await modelFile("vision.onnx");
  const cache = new Map<string, Float32Array | null>();
  const thumb = async (id: string) => {
    if (!cache.has(id))
      try {
        cache.set(id, await jobs.call("clipThumb", { model, blob: await c.thumbnail(id) }));
      } catch (e) {
        console.warn("look-alike thumbnail:", e); // a video, a missing thumbnail, a key without asset.view
        cache.set(id, null);
      }
    return cache.get(id)!;
  };
  const byWindow = new Map<string, Asset[]>();
  const out = { checked: 0, found: 0, pending: 0 };
  for (const [n, gid] of gids.entries()) {
    if (job) {
      job.message = `Looking for look-alikes in Immich: slide ${n + 1} of ${gids.length}`;
      if (job.kind === "lookalike") job.done = n;
    }
    d = await loadSession(sid);
    const g = d.groups.find((x) => x.id === gid);
    const aid = g?.immich?.asset_id;
    if (!g || !aid) continue;
    let [via, state]: ["smart" | "date", "checked" | "pending" | "unsupported"] = ["smart", "checked"];
    let candidates: Asset[] = [];
    try {
      candidates = await c.similarAssets(aid, CANDIDATES + 1);
    } catch (e) {
      if (e instanceof NotIndexed) state = "pending";
      else if (e instanceof Unsupported || e instanceof ImmichError) {
        console.warn("smart search:", e);
        via = "date";
        const win = dateWindow(dates[groupIndex(d, gid)]?.value ?? "");
        if (!win) state = "unsupported";
        else {
          const k = win.join("|");
          if (!byWindow.has(k))
            byWindow.set(
              k,
              await c.takenBetween(win[0], win[1], DATE_CANDIDATES).catch((e2) => {
                console.warn("date search:", e2);
                return [];
              }),
            );
          candidates = byWindow.get(k)!;
        }
      } else throw e;
    }
    let matches: { id: string; similarity: number; name: string; date: string; state: "suggested" }[] = [];
    if (state === "checked") {
      const mine = await thumb(aid);
      for (const x of candidates) {
        if (own.has(x.id) || x.id === aid || x.isTrashed || (x.type ?? "IMAGE") !== "IMAGE" || !mine) continue;
        const v = await thumb(x.id);
        if (!v) continue;
        const sim = dot(mine, v);
        if (sim >= LOOKALIKE)
          matches.push({
            id: x.id,
            similarity: Math.round(sim * 1000) / 1000,
            name: x.originalFileName ?? "",
            date: (x.localDateTime || x.fileCreatedAt || "").slice(0, 10),
            state: "suggested",
          });
      }
      matches = matches.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
    }
    out[state === "pending" ? "pending" : "checked"]++;
    if (matches.length) out.found++;
    await update(sid, (fresh) => {
      const fr = fresh.groups.find((x) => x.id === gid)?.immich;
      if (fr?.asset_id !== aid) return; // uploaded again meanwhile
      const old = new Map((fr.lookalike?.matches ?? []).map((x) => [x.id, x.state]));
      const kept = matches.map((x) => {
        const was = old.get(x.id);
        return was === "accepted" || was === "dismissed" ? { ...x, state: was } : x;
      });
      fr.lookalike = { asset: aid, state, via, matches: kept };
    });
  }
  return out;
}

const slidesWord = (n: number) => `${n} slide${n === 1 ? "" : "s"}`;
const lookalikeNote = (n: { found: number; pending: number }) =>
  (n.found ? `; ${slidesWord(n.found)} may already be in Immich (see Insights)` : "") +
  (n.pending ? `; ${slidesWord(n.pending)} to check for look-alikes once Immich has indexed them` : "");

/** The look-alike check after an upload: best effort, never fails the upload. */
async function lookalikesQuietly(c: Immich, sid: string, gids: string[], job: Job) {
  if (!(await modelReady())) return "; look-alikes not checked: the tag model isn't downloaded";
  try {
    return lookalikeNote(await checkLookalikes(c, sid, gids, job));
  } catch (e) {
    console.warn("look-alikes:", e);
    return `; look-alikes not checked (${e instanceof Error ? e.message : e})`;
  }
}

// ------------------------------------------------------------------ people (faces -> names, people.ts)

// SFace in models/ (like the desktop app), faces per tray in faces.json next to session.json (never
// in it), the people in the library's people.json. Their own queue for reload-apply-save.
const SFACE_PATH = `models/${SFACE_NAME}`;
const sfaceSource = () => source("sface", SFACE);
const facesPath = (sid: string) => `${sessionDir(sid)}/faces.json`;
let peopleQueue: Promise<unknown> = Promise.resolve();

function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = peopleQueue.then(fn);
  peopleQueue = run.catch(() => undefined);
  return run;
}

/** Recognising people is opt-in (Settings), and needs the face model downloaded. */
const peopleOn = async () => !!loadConfig().people_enabled && (await lib.exists(SFACE_PATH));

async function loadFaces(sid: string): Promise<FacesFile> {
  try {
    return JSON.parse((await lib.readText(facesPath(sid))) ?? "{}");
  } catch {
    return {};
  }
}

const updateFaces = (sid: string, fn: (d: FacesFile) => void) =>
  queued(async () => {
    const d = await loadFaces(sid);
    fn(d);
    await lib.write(facesPath(sid), JSON.stringify(d, null, 1));
  });

/** Record one slide's faces if they aren't up to date (workflow.find_faces). Only faces.json is written. */
async function findFaces(sid: string, gid: string): Promise<boolean> {
  const d = await loadSession(sid);
  const g = d.groups.find((x) => x.id === gid);
  if (!g || !stale(g, (await loadFaces(sid))[gid])) return false;
  const sface = await modelFile(SFACE_NAME, "models");
  const found = await jobs.call("faces", { sface, src: await fusedSrc(d, g, jobs), rotation: g.rotation, mirror: !!g.mirror }, -1);
  const [key, rot, mirror] = [faceKey(g), g.rotation, !!g.mirror];
  await updateFaces(sid, (f) => {
    f[gid] = { key, rot, mirror, faces: recordFaces(sid, gid, f[gid]?.faces ?? [], found, unpack, pack) };
  });
  return true;
}

async function facesQuietly(sid: string, gid: string) {
  try {
    await findFaces(sid, gid);
  } catch (e) {
    console.warn("faces:", e); // faces are extra: never let them fail an import
  }
}

/** Slides whose faces are missing or stale (workflow.faces_pending); forgets slides that are gone. */
async function facesPending(sids?: string[]): Promise<[string, string][]> {
  const todo: [string, string][] = [];
  for (const sid of sids ?? (await listSessions()).map((t) => t.id)) {
    let d: SessionData;
    try {
      d = await loadSession(sid);
    } catch {
      continue;
    }
    const faces = await loadFaces(sid);
    const gids = new Set(d.groups.map((g) => g.id));
    if (Object.keys(faces).some((k) => !gids.has(k)))
      await updateFaces(sid, (f) => Object.keys(f).forEach((k) => gids.has(k) || delete f[k]));
    for (const g of d.groups) if (stale(g, faces[g.id])) todo.push([sid, g.id]);
  }
  return todo;
}

const faceCache = new Map<
  string,
  { t: number; faces: Map<string, { sid: string; gid: string; emb: Float32Array; key: string }> }
>();

/** Every face in the library, trays in name order (people.all_faces), re-read only when changed. */
async function allFaces() {
  const out = new Map<string, { sid: string; gid: string; emb: Float32Array; key: string }>();
  const trays = (await lib.list("sessions")).filter((e) => e.kind === "directory").map((e) => e.name);
  for (const sid of trays.sort()) {
    const file = await lib.read(facesPath(sid));
    if (!file) continue;
    let hit = faceCache.get(`${lib.name}/${sid}`);
    if (!hit || hit.t !== file.lastModified) {
      const faces = new Map<string, { sid: string; gid: string; emb: Float32Array; key: string }>();
      try {
        for (const [gid, e] of Object.entries(JSON.parse(await file.text()) as FacesFile))
          for (const x of e.faces ?? []) faces.set(x.id, { sid, gid, emb: unpack(x.emb), key: e.key ?? "" });
      } catch {
        continue;
      }
      hit = { t: file.lastModified, faces };
      faceCache.set(`${lib.name}/${sid}`, hit);
    }
    for (const [k, v] of hit.faces) out.set(k, v);
  }
  return out;
}

async function loadPeople(): Promise<PeopleFile> {
  try {
    const d = JSON.parse((await lib.readText("people.json")) ?? "{}");
    return { people: d.people ?? {}, rejected: d.rejected ?? {}, next: d.next ?? 1 };
  } catch {
    return emptyPeople();
  }
}

/** people.json brought up to date with the faces (people.refresh); `edit` first changes it (null: no such person). */
const refreshPeople = (edit?: (d: PeopleFile) => PeopleFile | null) =>
  queued(async () => {
    let d = await loadPeople();
    if (edit) {
      const e = edit(d);
      if (!e) throw new HttpError(404, "No such person (the list changed meanwhile?)");
      [d] = [e];
      await lib.write("people.json", JSON.stringify(d, null, 1));
    }
    const faces = await allFaces();
    const r = refreshPeopleData(d, new Map([...faces].map(([k, v]) => [k, v.emb])));
    if (r.changed) await lib.write("people.json", JSON.stringify(r.d, null, 1));
    return { d: r.d, faces };
  });

/** What the People dialog shows (server._people_payload). */
async function peoplePayload(r: Awaited<ReturnType<typeof refreshPeople>>) {
  const { d, faces } = r;
  const out = Object.entries(d.people).map(([pid, p]) => {
    const fs = p.faces.filter((f) => faces.has(f));
    return {
      id: pid,
      name: p.name ?? "",
      slides: new Set(fs.map((f) => `${faces.get(f)!.sid}/${faces.get(f)!.gid}`)).size,
      faces: fs.map((f) => ({ id: f, url: `/api/people/faces/${f}.jpg?v=${faces.get(f)!.key}` })),
    };
  });
  // named people first (by name), then the ones seen most
  out.sort(
    (a, b) =>
      +!a.name - +!b.name ||
      (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0) ||
      b.faces.length - a.faces.length,
  );
  const cfg = loadConfig();
  return {
    enabled: !!cfg.people_enabled,
    model: await lib.exists(SFACE_PATH),
    model_mb: PEOPLE_MB,
    pending: cfg.people_enabled ? (await facesPending()).length : 0,
    people: out,
  };
}

/** The job: the face model if needed, then the faces on every slide of the library (workflow.scan_people). */
async function scanPeople(job: Job) {
  if (!(await lib.exists(SFACE_PATH))) await fetchFiles(lib, job, sfaceSource(), "models", "face model");
  const todo = await facesPending();
  [job.done, job.total] = [0, todo.length];
  for (const [sid, gid] of todo) {
    job.message = `Finding faces: slide ${job.done + 1} of ${todo.length}`;
    await facesQuietly(sid, gid);
    job.done++;
  }
  const { d } = await refreshPeople();
  const named = Object.values(d.people).filter((p) => p.name).length;
  job.message = `Looked for faces on ${todo.length} slides: ${Object.keys(d.people).length} people (${named} named)`;
}

/** Named people as Immich tags (People/<name>) on uploaded slides {gid: asset} of one tray. */
async function tagPeople(c: Immich, sid: string, slides: Map<string, string>, names: Map<string, string[]>) {
  const byName = new Map<string, string[]>();
  for (const [gid, asset] of slides)
    for (const name of names.get(`${sid}/${gid}`) ?? []) byName.set(name, [...(byName.get(name) ?? []), asset]);
  const done = new Set<string>();
  for (const [name, assets] of [...byName].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    if (await c.tagAssets([tagName(name)], assets)) assets.forEach((a) => done.add(a));
  return done.size;
}

/** The job: the names of the people on every slide already in Immich, as tags (workflow.tag_people). */
async function tagPeopleJob(job: Job) {
  const names = slideNames((await refreshPeople()).d);
  const c = immichClient();
  job.message = `Connecting to Immich ${await c.version()}`;
  const sids = [...new Set([...names.keys()].map((k) => k.split("/")[0]))].sort();
  [job.total, job.done] = [sids.length, 0];
  let tagged = 0;
  for (const sid of sids) {
    let d: SessionData;
    try {
      d = await loadSession(sid);
    } catch {
      continue;
    }
    const slides = new Map(d.groups.filter((g) => g.immich && !g.skip).map((g) => [g.id, g.immich!.asset_id]));
    tagged += await tagPeople(c, sid, slides, names);
    job.done++;
  }
  job.message =
    c.tagsSupported === false
      ? "This Immich server has no tags API: names were not sent"
      : `Tagged ${tagged} slides in Immich with the people on them`;
}

/** A job: the tray's uploaded slides not checked yet or not indexed at the last check (all: every one). */
async function checkLookalikesJob(job: Job, sid: string, everything: boolean) {
  const d = await loadSession(sid);
  const gids = d.groups
    .filter(
      (g) => !g.skip && g.immich?.asset_id && (everything || [undefined, "pending"].includes(lookalikeView(g)?.state)),
    )
    .map((g) => g.id);
  job.total = gids.length;
  const n = await checkLookalikes(immichClient(), sid, gids, job);
  job.done = job.total;
  job.message = `Checked ${slidesWord(n.checked)} for look-alikes in Immich` + lookalikeNote(n);
}

// ------------------------------------------------------------------ undo

const HISTORY_MAX = 60;
const COALESCE_S = 1.5; // edits to the same settings closer together than this are one undo step

const snapshot = (g: GroupData): Snapshot => ({
  params: structuredClone(g.params),
  rotation: g.rotation, mirror: !!g.mirror,
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

// each slide's own: Copy previous, Apply to rest, presets, "develop like" and learning never carry
// these over (local adjustments are drawn on this picture, like a crop)
const FRAMING = { angle: 0, crop: null, local: [] };
/** A slide's own framing, to keep when another look is applied to it. */
const framing = (p: Params) => ({ angle: p.angle ?? 0, crop: p.crop ?? null, local: p.local ?? [] });

// ------------------------------------------------------------------ looks: presets, develop like

/** A slide's look without its framing: crop, straighten and local adjustments are each slide's own. */
function colour(p: Params): Preset["params"] {
  const { angle: _a, crop: _c, local: _l, ...rest } = cleanParams(p);
  return rest;
}

async function loadPresets(): Promise<Preset[]> {
  try {
    return JSON.parse((await lib.readText("presets.json")) ?? "{}").presets ?? [];
  } catch {
    return [];
  }
}

const savePresets = (presets: Preset[]) => lib.write("presets.json", JSON.stringify({ presets }, null, 1));

// ------------------------------------------------------------------ 1:1 zoom

const TILE = 512;
let zoomKey = ""; // the render the jobs worker holds for zoom tiles

/** Render (or decode the fresh export of) a slide at full resolution in the jobs worker, for zoom. */
async function zoomImage(d: SessionData, g: GroupData): Promise<{ key: string; width: number; height: number }> {
  const key = `${d.id}:${g.id}:${renderKey(g)}`;
  const ex = g.export?.key === renderKey(g) ? await lib.read(`${sessionDir(d.id)}/export/${g.export.file}`) : null;
  let blobs: Blob[] = [];
  if (!ex) {
    const originals = await Promise.all(activeScans(g).map((x) => lib.read(originalPath(d, x))));
    if (originals.some((x) => !x))
      throw new HttpError(409, "The original scans were deleted after upload: no full resolution to zoom into.");
    blobs = originals as Blob[];
  }
  const size = await jobs.call("zoomImage", { key, exported: ex, blobs, rotation: g.rotation, mirror: !!g.mirror, params: g.params }, 5);
  zoomKey = key;
  return { key, ...size };
}

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

/** The Immich tag a tray's photos carry: Trays/<tray name> (a "/" in the name would nest it deeper). */
function trayTag(name: string): string {
  return "Trays/" + ((name || "").replaceAll("/", "-").trim() || "Untitled tray");
}

/** Where a tray's photos belong in Immich: the album and the tray tag (workflow.placement). */
function placement(cfg: StoredConfig, d: SessionData): string {
  const album = cfg.immich_album || "name:" + (d.album || d.name);
  return `${album}|${cfg.tag_trays ?? true ? trayTag(d.name) : ""}`;
}

function placementStale(cfg: StoredConfig, d: SessionData): boolean {
  return d.groups.some((g) => g.immich && !g.skip) && d.placed !== placement(cfg, d);
}

function albumLabel(cfg: StoredConfig, d: SessionData): string {
  return cfg.immich_album ? cfg.immich_album_name || "the album chosen in Settings" : d.album || d.name;
}

/** Every slide of the tray in Immich into `album` with the tray tag, the untouched scans stacked
 *  under them out of it (workflow._place_tray). Answers a note on what couldn't be done. */
async function placeTray(client: Immich, cfg: StoredConfig, sid: string, album: string): Promise<string> {
  const d = await loadSession(sid);
  const recs = d.groups.filter((g) => g.immich && !g.skip).map((g) => g.immich!);
  const assets = [...new Set(recs.map((r) => r.asset_id))];
  const scans = [...new Set(recs.flatMap((r) => Object.values(r.originals ?? {})))]
    .filter((a) => !assets.includes(a))
    .sort();
  const notes: string[] = [];
  let tag = cfg.tag_trays ?? true ? trayTag(d.name) : "";
  if (assets.length) {
    await client.addToAlbum(album, assets); // the ones in it already just answer "duplicate"
    if (scans.length)
      try {
        await client.removeFromAlbum(album, scans);
      } catch (e) {
        console.warn("originals out of the album:", e);
        notes.push("the untouched scans stay in the album: the API key needs albumAsset.delete");
      }
    const old = d.tray_tag;
    try {
      if (old && old !== tag) await client.untagAssets(old, assets);
      if (tag && (await client.tagAssets([tag], assets)) === 0) notes.push("no tray tag: this Immich has no tags API");
    } catch (e) {
      notes.push(`no tray tag (${e instanceof Error ? e.message : e})`);
      tag = old ?? "";
    }
  }
  await update(sid, (fresh) => {
    fresh.placed = placement(cfg, fresh);
    fresh.tray_tag = tag;
  });
  return notes.map((n) => `; ${n}`).join("");
}

async function payload(d: SessionData): Promise<SessionPayload> {
  const dates = slideDates(d);
  const st = statuses(d);
  const live = views(d, dates, await labels()); // film stock and date guesses: no model
  const models = await activeModels(); // once: every slide's insights key depends on it
  return {
    ...(await insightsPayload(d, models)),
    summary: summary(d),
    // its slides in Immich aren't in the album / tagged the way Settings and the tray name say now
    placement_stale: placementStale(loadConfig(), d),
    album_label: albumLabel(loadConfig(), d),
    album_from_settings: !!loadConfig().immich_album,
    defaults: d.defaults,
    stock: d.stock ?? "",
    groups: d.groups.map((g, i) => ({
      id: g.id,
      scans: g.scans,
      excluded: g.excluded ?? [],
      rotation: g.rotation, mirror: !!g.mirror,
      rot_reason: g.rot_reason ?? "",
      params: g.params,
      reviewed: g.reviewed,
      skip: g.skip,
      params_source: g.params_source ?? "",
      auto_excluded: g.auto_excluded ?? {},
      locked: !!g.locked,
      from_immich: !!g.source_asset,
      status: st[i],
      date: g.date ?? "",
      caption: g.caption ?? "",
      tags: g.tags ?? [],
      stock: g.stock ?? "",
      place: g.place ?? null,
      insights: slideInsights(g, live[i], models),
      // after upload: photos already in Immich that look like this one
      lookalike: lookalikeView(g),
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
    // place suggestions from signs: the text reader + place names are there (else ocr_mb to download)
    places: {
      ocr: models.includes(OCR_ID),
      ocr_mb: megabytes(ocrSource()) + ((await gazetteerReady()) ? 0 : GAZETTEER_MB),
    },
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
  (background ? ((job.message = "Finishing a background render"), background.then(() => fn(job))) : fn(job))
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
    // always by content: the quick fingerprint (name+size+mtime) only estimates "new" in the
    // folder, and a different scan can share it (the scanner restarting its numbering)
    const fp = quickFp(f.file);
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

  // scans copied by an import that stopped before grouping them (a closed tab, a crash): the dedupe
  // index skips them from now on, so they are grouped here, in their place among the new ones
  const grouped = new Set(d.groups.flatMap((g) => g.scans));
  const stranded = Object.keys(d.scans).filter((k) => !grouped.has(k) && !newIds.includes(k));
  if (stranded.length) {
    const key = (k: string) => [d.scans[k].taken ?? "", k] as const;
    newIds.push(...stranded);
    newIds.sort((a, b) => {
      const [ta, ka] = key(a);
      const [tb, kb] = key(b);
      return ta < tb ? -1 : ta > tb ? 1 : ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

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
    if (learning) [suggestion, neighbours] = (await model()).suggest(feats, effective(d, g));

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
      if (rot && target.rot_reason !== "manual") {
        // guessed on the scans as they came: a mirrored slide turns the other way
        target.rotation = target.mirror ? (360 - rot[0]) % 360 : rot[0];
        target.rot_reason = rot[1];
      }
      target.feat = feats;
      target.mount = mount;
      if (!extend && straightenToMount(target)) target.params = { ...target.params, angle: -mount.angle };
      if (suggestion && !target.reviewed && target.params_source !== "manual") {
        target.params = cleanParams({ ...target.params, ...suggestion });
        target.params_source = `learned:${neighbours}`;
      }
    }); // slides appear in the UI one by one
    if (await peopleOn()) await facesQuietly(sid, extend ? last.id : g.id);
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
      { src, rotation: g.rotation, mirror: !!g.mirror, params: g.params, size, before, uncropped },
      priority,
    );
    return { blob, fresh };
  }
  m = u.pathname.match(/\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/tile\.jpg$/);
  if (m) {
    const d = await loadSession(m[1]);
    const g = group(d, m[2]);
    const [col, row] = [Number(u.searchParams.get("col")), Number(u.searchParams.get("row"))];
    const fresh = u.searchParams.get("v") === renderKey(g);
    const key = `${d.id}:${g.id}:${renderKey(g)}`;
    if (zoomKey !== key) await zoomImage(d, g);
    try {
      return { blob: await jobs.call("tile", { key, col, row, size: TILE }, 8), fresh };
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "not rendered") throw e;
      await zoomImage(d, g); // the worker let go of it (another slide, or it restarted)
      return { blob: await jobs.call("tile", { key, col, row, size: TILE }, 8), fresh };
    }
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
  m = u.pathname.match(/\/api\/people\/faces\/([^/]+)\/([^/]+)\/([^/]+)\.jpg$/);
  if (m) {
    // a face cut from the slide it is on, as it was turned when the face was found
    const [, sid, gid, n] = m;
    const d = await loadSession(sid);
    const g = d.groups.find((x) => x.id === gid);
    const entry = (await loadFaces(sid))[gid];
    const face = entry?.faces.find((f) => f.id === `${sid}/${gid}/${n}`);
    if (!g || !entry || !face) throw new HttpError(404, "Not found");
    const blob = await ui.call(
      "faceCrop",
      { src: await fusedSrc(d, g), rotation: entry.rot ?? 0, mirror: !!entry.mirror, box: face.box },
      priority,
    );
    return { blob, fresh: u.searchParams.get("v") === entry.key };
  }
  m = u.pathname.match(/\/api\/immich\/assets\/([^/]+)\/thumb\.jpg$/);
  if (m) return { blob: await immichClient().thumbnail(m[1]), fresh: true };
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
  const jpeg = await jobs.call("full", { blobs: originals as Blob[], rotation: g.rotation, mirror: !!g.mirror, params: g.params, quality });
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
    exifSegment(
      ifd0,
      [
        [36867, when], // DateTimeOriginal (what Immich uses for the timeline)
        [36868, when],
      ],
      1,
      g.place ?? undefined, // the slide's place as EXIF GPS
    ),
    ...(g.tags?.length ? [xmpSegment(g.tags)] : []), // tags as XMP keywords (Immich reads them too)
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

// Background renderer (workflow._background_renderer): renders the open tray's developed slides at
// full resolution in the jobs worker while the user keeps developing, so uploading is mostly
// network time. One slide at a time and never while a job runs; a job that starts meanwhile waits
// for the render in flight (full resolution is one at a time). renderExport commits only if the
// slide's keys still match, so an edit made during the render just leaves it for the next round.
let activeSession: string | null = null;
let background: Promise<void> | null = null;
let backgroundTimer: ReturnType<typeof setInterval> | null = null;
const jobRunning = () => !!current && !current.finished;

async function exportFresh(d: SessionData, g: GroupData, index: number) {
  if (!g.export || g.export.ekey !== exportKey(d, g, index)) return false;
  return lib.exists(`${sessionDir(d.id)}/export/${g.export.file}`);
}

async function backgroundStep() {
  const sid = activeSession;
  if (!lib || !sid || jobRunning()) return;
  let d: SessionData;
  try {
    d = await loadSession(sid);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404 && activeSession === sid) activeSession = null; // deleted
    throw e;
  }
  const st = statuses(d);
  for (const [i, g] of d.groups.entries()) {
    if (!g.reviewed || g.skip || g.locked || st[i] === "uploaded") continue;
    if ((await exportFresh(d, g, i)) || (await originalsMissing(d, g))) continue;
    if (jobRunning() || activeSession !== sid) return; // a job started, or another tray opened
    await renderExport(sid, g.id, loadConfig().jpeg_quality);
    return;
  }
  // nothing to render: catch up on faces (slides turned since, trays from before)
  if (await peopleOn()) {
    const [todo] = await facesPending([sid]);
    if (todo && !jobRunning() && activeSession === sid) await facesQuietly(...todo);
  }
}

function watchTray(sid: string) {
  activeSession = sid;
  backgroundTimer ??= setInterval(() => {
    kickInsights(); // scene tags and look-alikes, next to the renders
    if (background) return;
    background = backgroundStep()
      .catch((e) => console.warn("background render:", e))
      .finally(() => (background = null));
  }, 1500);
}

type Target = "immich" | "disk";

const isoDay = (t: Date) =>
  `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;

/** A slide's date for `PUT /assets/{id}`: naive local time, like the EXIF the upload carries. */
const immichTime = (t: Date) => exifTime(t).replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T");

const gps = (g: GroupData): [number, number] | null => (g.place ? [g.place.lat, g.place.lon] : null);

/** What Immich was told about a slide besides its pixels; pulling edits back compares against it. */
const pushedMeta = (d: SessionData, g: GroupData, index: number) => ({
  date: isoDay(photoDate(d, g, index)),
  caption: g.caption ?? "",
  place: gps(g),
});

/** A place from an Immich asset's exifInfo (workflow.immich_place). */
function immichPlace(
  x:
    | {
        latitude?: number | null;
        longitude?: number | null;
        city?: string | null;
        country?: string | null;
        state?: string | null;
      }
    | null
    | undefined,
): Place | null {
  if (x?.latitude == null || x.longitude == null) return null;
  try {
    return cleanPlace({
      name: x.city ?? "",
      lat: x.latitude,
      lon: x.longitude,
      country: x.country ?? "",
      admin: x.state ?? "",
    });
  } catch {
    return null;
  }
}

/** Immich has this slide's pixels already: only its date or caption can have changed. */
const metaOnly = (g: GroupData) => !!g.immich && (!!g.locked || g.immich.key === renderKey(g));

/** What a replacement keeps of the asset it replaces: its albums and whether it's a favourite. */
async function carryOver(client: Immich, asset: string | undefined) {
  let a = null;
  try {
    a = asset ? await client.asset(asset) : null;
  } catch (e) {
    console.warn("carry over:", e); // a key without asset.read: replace it as before, carrying nothing
  }
  if (!a || !asset) return { albums: [] as string[], favorite: false };
  return { albums: await client.albumsOf(asset), favorite: !!a.isFavorite };
}

/** Every scan of a slide in Immich, untouched ({scan: asset}, the ones this uploaded), reusing what Immich has. */
async function originalsInImmich(client: Immich, d: SessionData, g: GroupData, when: Date) {
  const scans = g.scans.filter((x) => d.scans[x]);
  const have = await client.existing(Object.fromEntries(scans.map((x) => [x, d.scans[x].sha1])));
  await client.restore(Object.values(have).flatMap((h) => (h.trashed ? [h.asset_id] : [])));
  const out: Record<string, string> = {};
  const created: string[] = [];
  for (const x of scans) {
    if (have[x]) {
      out[x] = have[x].asset_id;
      continue;
    }
    const blob = await lib.read(originalPath(d, x));
    if (!blob) continue; // deleted after an earlier upload ("keep originals" off)
    const [id, status] = await client.upload(blob, d.scans[x].file, when, `${d.id}-${x}`);
    out[x] = id;
    if (status !== "duplicate") created.push(id);
  }
  return { originals: out, created };
}

async function finishSession(
  job: Job,
  sid: string,
  onlyReady: boolean,
  target: Target,
  folder?: FileSystemDirectoryHandle,
) {
  const cfg = loadConfig();
  let d = await loadSession(sid);
  const redate = target === "immich" && d.date_key !== d.date; // tray date changed: every slide may have a new date
  const st = Object.fromEntries(d.groups.map((g, i) => [g.id, statuses(d)[i]]));
  let todo = d.groups
    .filter((g) => !g.skip && (target === "disk" || redate || st[g.id] !== "uploaded") && (g.reviewed || !onlyReady))
    .map((g) => g.id);
  // slides whose pixels Immich has only get their date / caption / place updated there
  const meta = target === "immich" ? todo.filter((gid) => metaOnly(group(d, gid))) : [];
  todo = todo.filter((x) => !meta.includes(x));
  const lost: string[] = [];
  for (const gid of todo) if (await originalsMissing(d, group(d, gid))) lost.push(gid);
  todo = todo.filter((x) => !lost.includes(x)); // nothing to render them from: keep what Immich has
  job.total = todo.length * 2 + meta.length;
  const saved: { name: string; blob: Blob }[] = [];
  let client: Immich | null = null;
  let album = "";
  if (target === "immich") {
    client = new Immich(cfg.immich_url, cfg.immich_key);
    job.message = `Connecting to Immich ${await client.version()}`;
    if (cfg.immich_album) {
      // one album for every tray, chosen in Settings
      if (!(await client.album(cfg.immich_album)))
        throw new ImmichError(
          `The album chosen in Settings ('${albumLabel(cfg, d)}') is gone from Immich, or this API key can't see it: ` +
            "choose another one in Settings",
        );
      album = cfg.immich_album;
    } else album = await client.findOrCreateAlbum(d.album || d.name);
    await update(sid, (f) => void (f.immich_album_id = album));
  }
  const toTrash: string[] = [];
  let uploaded = 0;
  let synced = 0;
  let duplicates = 0;
  let noUpdate = false;
  const tagged: Record<string, string[]> = {}; // tag -> asset ids to tag, uploaded or updated now
  const sent: string[] = []; // slides uploaded now, for the look-alike check
  const tagAll = (g: GroupData, asset: string) => {
    for (const t of g.tags ?? []) (tagged[t] ??= []).push(asset);
  };
  const wantOriginals = cfg.upload_originals_stacked;
  let stacks: boolean | null = null; // asked once, and only if needed
  const hasStacks = async () => (stacks ??= await client!.hasStacks());

  for (const [n, gid] of meta.entries()) {
    job.message = `Updating date, caption and place ${n + 1} of ${meta.length}`;
    job.done++;
    d = await loadSession(sid);
    const g = d.groups.find((x) => x.id === gid);
    if (!g?.immich) continue;
    const idx = groupIndex(d, gid);
    const mk = slideMeta(d, g, idx);
    const asset = g.immich.asset_id;
    if (g.immich.meta === mk) continue; // only the tray date moved, and not this slide's
    const fields: Record<string, unknown> = {
      dateTimeOriginal: immichTime(photoDate(d, g, idx)),
      description: g.caption ?? "",
    };
    if (g.place) Object.assign(fields, { latitude: g.place.lat, longitude: g.place.lon });
    else if (g.immich.pushed?.place && !g.locked && !(await originalsMissing(d, g))) {
      // Immich's API can set a location but not remove one: a new copy without GPS goes up
      todo.push(gid);
      job.total += 2;
      continue;
    }
    try {
      await client!.updateAsset(asset, fields);
    } catch (e) {
      // a key without asset.update: upload it again with the new EXIF, as before
      console.warn("metadata update:", e);
      if (!g.locked && !(await originalsMissing(d, g))) {
        todo.push(gid);
        job.total += 2;
        noUpdate = true;
      }
      continue;
    }
    const pushed = pushedMeta(d, g, idx);
    await update(sid, (fresh) => {
      const fg = fresh.groups.find((x) => x.id === gid);
      if (fg?.immich?.asset_id === asset) Object.assign(fg.immich, { meta: mk, pushed });
    });
    tagAll(g, asset); // tags are part of the meta key: a new tag comes this way too
    synced++;
  }

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
    const c = client!;
    const idx = groupIndex(d, gid);
    const when = photoDate(d, g, idx);
    const old = g.immich;
    // the asset this one takes the place of: the last upload, or the Immich photo it was pulled in from
    const replaces = old?.asset_id ?? g.source_asset?.id;
    const carry = await carryOver(c, replaces);
    // exact duplicate: Immich has these very bytes already (an identical render), so use that
    const hit = (await c.existing({ slide: g.export!.sha1 })).slide;
    let assetId: string;
    let status: string;
    if (hit) {
      [assetId, status] = [hit.asset_id, "duplicate"];
      if (hit.trashed) await c.restore([assetId]);
      if (carry.favorite) await c.updateAsset(assetId, { isFavorite: true });
      duplicates++;
    } else
      [assetId, status] = await c.upload(
        out.blob,
        out.name,
        when,
        `${sid}-${gid}-${g.export!.sha1.slice(0, 8)}`,
        carry.favorite,
      );
    await c.addToAlbum(album, [assetId]);
    for (const a of carry.albums) if (a !== album) await c.addToAlbum(a, [assetId]);

    // Stacks: the untouched scans under the developed photo. A new upload replaces the whole stack,
    // so the scans Immich has stay stacked even once the setting is turned off.
    let originals = Object.fromEntries(Object.entries(old?.originals ?? {}).filter(([k]) => g.scans.includes(k)));
    let own = [...(old?.own_originals ?? [])];
    let stackId: string | null = null;
    if ((wantOriginals || Object.keys(originals).length || old?.stack_id) && (await hasStacks())) {
      if (old?.stack_id) await c.deleteStack(old.stack_id);
      if (wantOriginals) {
        const r = await originalsInImmich(c, d, g, when);
        originals = r.originals;
        own.push(...r.created);
      }
      const ids = [...new Set(Object.values(originals))].filter((a) => a !== assetId);
      stackId = await c.createStack([assetId, ...ids]);
    }
    own = [...new Set(own)].filter((a) => Object.values(originals).includes(a));
    const kept = new Set(stackId ? Object.values(originals) : []);
    if (replaces && replaces !== assetId) {
      if (kept.has(replaces)) {
        // a pulled-in photo is itself the untouched scan: it stays, stacked under the new one, and
        // leaves the albums the new one took its place in
        for (const a of [...carry.albums, album])
          await c.removeFromAlbum(a, [replaces]).catch((e) => console.warn("remove from album:", e));
      } else toTrash.push(replaces);
    }
    const rec: ImmichRecord = {
      asset_id: assetId,
      key: g.export!.key,
      status,
      meta: slideMeta(d, g, idx),
      pushed: pushedMeta(d, g, idx),
      at: Date.now() / 1000, // when it went up, for the stats
    };
    if (stackId && Object.keys(originals).length)
      Object.assign(rec, { originals, own_originals: own, stack_id: stackId });
    await update(sid, (fresh) => void (group(fresh, gid).immich = rec));
    tagAll(g, assetId);
    sent.push(gid);
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
  const stacksGone: string[] = [];
  await update(sid, (fresh) => {
    // slides merged away or skipped after uploading: move their old Immich copies to the trash
    toTrash.push(...(fresh.orphan_assets ?? []));
    stacksGone.push(...(fresh.orphan_stacks ?? []));
    delete fresh.orphan_assets;
    delete fresh.orphan_stacks;
    const used = new Set(fresh.groups.filter((g) => !g.skip).flatMap((g) => Object.values(g.immich?.originals ?? {})));
    for (const g of fresh.groups)
      if (g.skip && g.immich) {
        toTrash.push(g.immich.asset_id);
        if (g.immich.stack_id) stacksGone.push(g.immich.stack_id);
        // the scans this uploaded for it go too, unless another slide stacks them
        toTrash.push(...(g.immich.own_originals ?? []).filter((a) => !used.has(a)));
        g.immich = null;
      }
    if (!onlyReady || fresh.groups.every((g) => g.reviewed || g.skip)) fresh.date_key = fresh.date; // every slide now carries the date
    log(
      fresh,
      `Uploaded ${uploaded} slides to album '${albumLabel(cfg, fresh)}'` + (synced ? `, updated ${synced} in place` : ""),
    );
  });
  for (const x of stacksGone) await client!.deleteStack(x);
  await client!.trash(toTrash);
  let tagNote = "";
  if (Object.keys(tagged).length) {
    job.message = "Tagging in Immich";
    try {
      await client!.tagEach(tagged);
    } catch (e) {
      // an older Immich or a key without tag permissions: the upload stands
      console.warn("immich tags:", e);
      tagNote = `; tags not sent (${e instanceof Error ? e.message : e})`;
    }
  }
  job.message = "Putting the tray in its album";
  const placeNote = await placeTray(client!, cfg, sid, album);
  let peopleTagged = 0;
  let peopleProblem = "";
  if (cfg.people_enabled && sent.length) {
    // named people go along as tags (People/<name>)
    try {
      const g2a = new Map(
        (await loadSession(sid)).groups
          .filter((g) => sent.includes(g.id) && g.immich)
          .map((g) => [g.id, g.immich!.asset_id]),
      );
      peopleTagged = await tagPeople(client!, sid, g2a, slideNames((await refreshPeople()).d));
    } catch (e) {
      peopleProblem = e instanceof Error ? e.message : String(e);
    }
  }
  // photos in Immich that look like what just went up
  const lookNote = cfg.lookalike_enabled && sent.length ? await lookalikesQuietly(client!, sid, sent, job) : "";
  if (!cfg.keep_originals) await dropLocalOriginals(sid);
  job.message =
    `Done - ${uploaded} slides uploaded to '${albumLabel(cfg, await loadSession(sid))}'` +
    (synced ? `; ${synced} updated in place (date, caption, place)` : "") +
    (noUpdate
      ? "; dates / captions / places went up as new copies: give the API key asset.update to change them in place"
      : "") +
    (duplicates ? `; ${duplicates} were in Immich already, not sent again` : "") +
    (wantOriginals && uploaded && stacks === false
      ? "; original scans not stacked: this Immich has no stacks, or the API key lacks stack.read / stack.create"
      : "") +
    (lost.length ? `; ${lost.length} skipped: their original scans were deleted after the last upload` : "") +
    tagNote +
    (peopleTagged ? `; ${peopleTagged} tagged with the people on them` : "") +
    (peopleProblem ? `; names not sent: ${peopleProblem}` : "") +
    lookNote +
    placeNote;
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

// ------------------------------------------------------------------ round trip: back from Immich

const PULLABLE = ["image/jpeg", "image/png"];

function immichClient() {
  const cfg = loadConfig();
  if (!cfg.immich_url || !cfg.immich_key)
    throw new HttpError(400, "Set your Immich URL and API key in Settings first.");
  return new Immich(cfg.immich_url, cfg.immich_key);
}

const b64Hex = (b64: string) => {
  try {
    return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
};

/** Immich's localDateTime (the wall clock) as a scan's EXIF-style time. */
const exifFromLocal = (local: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(local) ? local.slice(0, 19).replace(/-/g, ":").replace("T", " ") : "";

/**
 * Import photos from Immich into a tray as scans, one slide each, to develop them again
 * (workflow.pull_in). Downloaded byte for byte and checked against Immich's SHA-1; never removable.
 * EXIF orientation needs no rotation here: the browser decodes photos upright already.
 */
async function pullIn(job: Job, sid: string, ids: string[]) {
  const client = immichClient();
  let d = await loadSession(sid);
  const have = new Set(Object.values(d.scans).map((s) => s.immich_asset));
  job.total = ids.length;
  job.message = `Downloading ${ids.length} photos from Immich`;
  const records: Record<string, Scan> = {};
  const fresh: { scanId: string; id: string; day: string; caption: string; place: Place | null }[] = [];
  let skipped = 0;
  let unusable = 0;
  for (const id of ids) {
    job.done++;
    if (have.has(id)) {
      skipped++;
      continue;
    }
    const a = await client.asset(id);
    const name = a?.originalFileName || id;
    const mime = a?.originalMimeType || (/\.png$/i.test(name) ? "image/png" : "image/jpeg");
    if (!a || a.type !== "IMAGE" || a.isTrashed || !PULLABLE.includes(mime)) {
      unusable++; // videos, RAW / HEIC, or gone
      continue;
    }
    const blob = await client.download(id);
    const sha = await sha1Blob(blob);
    const expected = b64Hex(a.checksum ?? "");
    if (expected.length === 40 && expected !== sha)
      throw new Error(`The download of ${name} did not verify - try again`);
    const scanId = `${slugify(stem(name)).slice(0, 40)}_${id.replace(/-/g, "").slice(0, 6)}`;
    const dest = `${sessionDir(sid)}/originals/${scanId}.jpg`;
    await lib.write(dest, blob);
    const local = a.localDateTime ?? "";
    records[scanId] = {
      file: `${scanId}.jpg`,
      source: `immich:${id}`,
      source_root: "immich",
      removable: false,
      size: blob.size,
      sha1: sha,
      taken: exifFromLocal(local) || (await taken(new File([blob], name))),
      source_deleted: false,
      immich_asset: id,
    };
    const day = parseDate(local.slice(0, 10)) ? local.slice(0, 10) : "";
    fresh.push({
      scanId,
      id,
      day,
      caption: (a.exifInfo?.description ?? "").trim().slice(0, 2000),
      place: immichPlace(a.exifInfo), // the photo's location becomes the slide's place
    });
    have.add(id);
  }
  d = (await update(sid, (f) => void Object.assign(f.scans, records))).d;

  job.message = "Analysing photos";
  job.done = 0;
  job.total = fresh.length;
  const learning = loadConfig().learning_enabled;
  for (const x of fresh) {
    await makeProxies(sid, x.scanId, (await lib.read(originalPath(d, x.scanId)))!);
    const g = newGroup(d, [x.scanId]);
    Object.assign(g, { date: x.day, caption: x.caption, source_asset: { id: x.id } });
    if (x.place) g.place = x.place;
    const analysis = await jobs.call("analyse", {
      proxies: [{ key: `${sid}:${x.scanId}`, blob: await readCache(sid, `${x.scanId}.proxy.jpg`) }],
      fused: await fusedSrc(d, g, jobs),
      scans: 1,
    });
    let suggestion: Partial<Params> | null = null;
    let neighbours = 0;
    if (learning) [suggestion, neighbours] = (await model()).suggest(analysis.features, d.stock ?? "");
    await update(sid, (f) => {
      g.params = structuredClone(f.defaults);
      g.feat = analysis.features;
      if (suggestion) {
        g.params = cleanParams({ ...g.params, ...suggestion });
        g.params_source = `learned:${neighbours}`;
      }
      f.groups.push(g);
    }); // slides appear in the UI one by one
    job.done++;
  }
  await update(sid, (f) => log(f, `Pulled in ${fresh.length} photos from Immich`));
  job.message =
    `Pulled in ${fresh.length} photos from Immich` +
    (skipped ? ` (${skipped} were in this tray already)` : "") +
    (unusable ? `; left out ${unusable} that aren't JPEG or PNG photos` : "");
}

/** Captions and dates edited in Immich, back into the tray (workflow.pull_metadata). */
async function pullMetadata(sid: string) {
  const client = immichClient();
  const d0 = await loadSession(sid);
  const found = new Map<string, Awaited<ReturnType<Immich["asset"]>>>();
  for (const g of d0.groups) if (g.immich) found.set(g.id, await client.asset(g.immich.asset_id));
  const out = { checked: found.size, captions: 0, dates: 0, places: 0, gone: 0 };
  const { d } = await update(sid, (fresh) => {
    const touched: GroupData[] = [];
    fresh.groups.forEach((g, i) => {
      if (!found.has(g.id) || !g.immich) return;
      const a = found.get(g.id);
      if (!a || a.isTrashed) return void out.gone++;
      if (a.id !== g.immich.asset_id || !a.exifInfo) return; // uploaded again meanwhile, or not read by Immich yet
      let pushed = g.immich.pushed ?? pushedMeta(fresh, g, i);
      if (!("place" in pushed)) pushed = { ...pushed, place: gps(g) }; // uploaded before places: the slide's stands in
      const caption = (a.exifInfo.description ?? "").trim().slice(0, 2000);
      const day = (a.localDateTime ?? "").slice(0, 10);
      const next = { ...pushed };
      if (caption !== (pushed.caption ?? "")) {
        g.caption = next.caption = caption;
        out.captions++;
      }
      if (parseDate(day) && day !== pushed.date) {
        g.date = next.date = day;
        out.dates++;
      }
      const place = immichPlace(a.exifInfo);
      const was = pushed.place;
      if (place && !(was && Math.abs(place.lat - was[0]) < 1e-4 && Math.abs(place.lon - was[1]) < 1e-4)) {
        g.place = place; // moved (or placed) on Immich's map
        next.place = [place.lat, place.lon];
        out.places++;
      }
      if (next.caption !== pushed.caption || next.date !== pushed.date || next.place !== pushed.place) {
        g.immich.pushed = next;
        touched.push(g);
      }
    });
    // Immich has these already: record them as sent, unless the slide's date still differs from Immich's
    for (const g of touched) {
      const i = groupIndex(fresh, g.id);
      if (isoDay(photoDate(fresh, g, i)) === g.immich!.pushed!.date) g.immich!.meta = slideMeta(fresh, g, i);
    }
    if (touched.length)
      log(fresh, `Pulled ${out.captions} captions, ${out.dates} dates and ${out.places} places from Immich`);
  });
  return { d, pulled: out };
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
      upload_originals_stacked: cfg.upload_originals_stacked,
      stats_target: cfg.stats_target,
      insights_enabled: cfg.insights_enabled,
      lookalike_enabled: cfg.lookalike_enabled,
      people_enabled: cfg.people_enabled,
      eyes_enabled: cfg.eyes_enabled,
      immich_album: cfg.immich_album,
      immich_album_name: cfg.immich_album_name,
      tag_trays: cfg.tag_trays,
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
      "upload_originals_stacked",
      "insights_enabled",
      "lookalike_enabled",
      "people_enabled",
      "eyes_enabled",
      "immich_album",
      "immich_album_name",
      "tag_trays",
    ] as const)
      if (k in body && !(k === "immich_key" && body[k] === "")) (cfg as Record<string, unknown>)[k] = body[k];
    if ("stats_target" in body) {
      // slides to digitise in all, for the stats' projected finish
      const n = Math.trunc(Number(body.stats_target));
      if (!Number.isFinite(n)) throw new HttpError(400, "The target is a number of slides");
      cfg.stats_target = Math.max(1, n);
    }
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
    watchTray(m[1]); // the open tray: the background renderer works on it
    if (await syncLocks(structuredClone(d))) return payload((await update(m[1], syncLocks)).d); // originals deleted (or restored)
    return payload(d);
  }
  if ((m = is("PATCH", /^\/api\/sessions\/([^/]+)$/))) {
    const stock = "stock" in body ? checkedStock(body.stock) : null;
    const { d } = await update(m[1], async (d) => {
      for (const k of ["name", "album", "date"] as const) if (k in body) d[k] = String(body[k]).trim();
      if ("defaults" in body) d.defaults = cleanParams(body.defaults as Params);
      if (stock !== null) {
        d.stock = stock;
        await stockChanged(d, d.groups);
      }
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
      g.mirror = !!snap.mirror;
      g.rot_reason = snap.rot_reason ?? "";
      g.params_source = snap.params_source ?? "";
      stepped = snap.what ?? null;
      await learn(d, g);
    });
    return { ...(await payload(d)), stepped };
  }
  if ((m = is("PATCH", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)$/))) {
    const [, sid, gid] = m;
    const models = await activeModels();
    const { d } = await update(sid, async (d) => {
      const g = group(d, gid);
      if (Object.keys(body).some((k) => k !== "reviewed" && k !== "skip")) editable(g); // developed / left out are fine
      const what =
        "rotation" in body
          ? "rotation"
          : "mirror" in body
            ? "mirror"
            : "params" in body
            ? "params:" +
              Object.keys(body.params as object)
                .sort()
                .join(",")
            : null;
      if (what) remember(g, what);
      if ("rotation" in body) {
        const rot = ((Math.trunc(Number(body.rotation)) % 360) + 360) % 360;
        if (g.params.local?.length) g.params.local = turnLocal(g.params.local, rot - g.rotation); // masks turn with the picture
        g.rotation = rot;
        g.rot_reason = "manual";
      }
      if ("mirror" in body && !!body.mirror !== !!g.mirror) {
        // flip what's on screen left-right: the scan is mirrored before it's turned, so the
        // rotation, straighten, crop and masks all turn the other way to keep the photo in place
        g.mirror = !!body.mirror;
        g.rotation = (360 - g.rotation) % 360;
        g.params = mirrorParams(g.params);
      }
      if ("params" in body) {
        g.params = cleanParams({ ...g.params, ...(body.params as object) });
        g.params_source = "manual";
      }
      if ("reviewed" in body) {
        // when, for the stats (slides per hour, projected finish)
        if (body.reviewed && !g.reviewed) g.developed_at = Date.now() / 1000;
        else if (!body.reviewed) delete g.developed_at;
      }
      for (const k of ["reviewed", "skip"] as const) if (k in body) g[k] = !!body[k];
      if ("date" in body) g.date = cleanDate(body.date);
      if ("caption" in body) setCaption(g, String(body.caption).trim().slice(0, 2000), models);
      if ("tags" in body) for (const t of setTags(g, cleanTags(body.tags))) record("tags", t, "dismiss");
      if ("stock" in body) setStock(g, checkedStock(body.stock));
      if ("stock" in body || "skip" in body) label(await labels(), d, g);
      if ("place" in body) {
        setPlace(g, placeOf(body.place));
        suggestBetween(d.groups);
      }
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
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/insights\/decide$/))) {
    // accept or dismiss suggestions (server.py insights_decide): `kind`, `action`, optionally `value`
    // (one tag) and `groups` (default: the whole tray, the review's "accept all"); look-alikes by id
    const sid = m[1];
    const { kind, action } = body as { kind?: string; action?: string };
    const value = body.value == null ? null : String(body.value);
    if (
      ![...INSIGHT_KINDS, ...SIMILAR_KINDS, "lookalike"].includes(kind ?? "") ||
      !["accept", "dismiss"].includes(action ?? "")
    )
      throw new HttpError(
        400,
        "kind must be tags, caption, date, place, stock, duplicates, split, merge or lookalike; action accept or dismiss",
      );
    if ((SIMILAR_KINDS as readonly string[]).includes(kind!))
      return decideSimilar(sid, kind!, action!, value ?? "", body.keep == null ? null : String(body.keep));
    if (kind === "lookalike")
      return decideLookalike(sid, action!, value ?? "", Array.isArray(body.groups) ? body.groups.map(String) : []);
    const gids = Array.isArray(body.groups) ? (body.groups as string[]) : null;
    const text = body.text == null ? null : String(body.text);
    const models = await activeModels();
    let decided = 0;
    const { d } = await update(sid, async (d) => {
      const targets = d.groups.filter((g) => !gids || gids.includes(g.id));
      if (gids && targets.length === 1 && action === "accept") editable(targets[0]);
      // film stock and date guesses live in no file until decided: write down what is shown
      const live = kind === "stock" || kind === "date" ? views(d, slideDates(d), await labels()) : null;
      for (const g of targets) {
        if (action === "accept" && g.locked) continue;
        if (live) {
          const e = live[groupIndex(d, g.id)][kind as "stock" | "date"];
          if (e?.state === "suggested" && (value === null || e.value === value))
            (g.insights ??= {})[kind as "stock" | "date"] = { ...e };
        }
        if (decideOne(g, kind!, action!, value, kind === "caption" && targets.length === 1 ? text : null, models)) {
          decided++;
          if (kind === "stock") await stockChanged(d, [g]);
        }
      }
      if (kind === "place") suggestBetween(d.groups);
    });
    return { ...(await payload(d)), decided };
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/insights\/propagate$/))) {
    // tray-level propagation (server.py insights_propagate): a tag is added to each slide's own tags;
    // a caption, date, film stock or place replaces theirs. Locked slides are left as they are.
    const kind = String(body.kind);
    if (!["tags", "caption", "date", "place", "stock"].includes(kind))
      throw new HttpError(400, "kind must be tags, caption, date, stock or place");
    let value =
      kind === "place"
        ? placeOf(body.value)
        : kind === "stock"
          ? checkedStock(body.value)
          : kind === "date"
            ? cleanDate(body.value ?? "")
            : String(body.value ?? "").trim();
    if (kind === "tags") {
      value = cleanTags([value])[0] ?? "";
      if (!value) throw new HttpError(400, "No tag given");
    }
    const models = await activeModels();
    let applied = 0;
    const { d } = await update(m[1], async (d) => {
      const [a, b] = [groupIndex(d, String(body.from)), groupIndex(d, String(body.to))].sort((x, y) => x - y);
      if (a < 0) throw new HttpError(404, "Slide not found");
      const live = kind === "stock" ? views(d, slideDates(d), await labels()) : null;
      for (const [i, g] of d.groups.entries()) {
        if (i < a || i > b || g.locked) continue;
        if (kind === "stock") {
          setStock(g, value as string);
          const e = live![i].stock;
          if (value && e?.value === value) (g.insights ??= {}).stock = { ...e, state: "accepted" };
          await stockChanged(d, [g]);
        } else if (kind === "tags") {
          if ((g.tags ?? []).includes(value as string)) continue;
          setTags(g, [...(g.tags ?? []), value as string]);
        } else if (kind === "place") setPlace(g, value as Place | null);
        else {
          const e = g.insights?.[kind as "caption" | "date"];
          if (e && e.value === value) e.state = "accepted";
          if (kind === "caption") setCaption(g, (value as string).slice(0, 2000), models);
          else g.date = (value as string).slice(0, 2000);
        }
        applied++;
      }
      if (kind === "place") suggestBetween(d.groups);
    });
    return { ...(await payload(d)), applied };
  }
  if (is("GET", /^\/api\/insights$/)) {
    const cfg = loadConfig();
    const src = clipSource();
    return {
      enabled: cfg.insights_enabled,
      ready: await modelReady(),
      downloading: current?.kind === "model" && !current.finished,
      model_mb: megabytes(src),
      labels: TAGS,
      learned: (await learned()).labels ?? {},
      // captions (a 276 MB model with a decoder loop) are made by the desktop app only
      captions: { enabled: false, ready: false, model_mb: 276 },
      // look-alikes prefer the shot with open eyes (eyes.ts)
      eyes: { enabled: eyesEnabled(), ready: await eyesModelReady(), model_mb: megabytes(eyesSource()) },
      // place suggestions from signs: the text reader + the place names
      ocr_ready: await ocrOn(),
      ocr_mb: megabytes(ocrSource()) + ((await gazetteerReady()) ? 0 : GAZETTEER_MB),
      ocr_downloading: current?.kind === "ocr" && !current.finished,
    };
  }
  if (is("POST", /^\/api\/insights\/model$/)) {
    // by default the ones turned on (server.insights_model): the tag model, and the eye model with it
    const want: string[] =
      Array.isArray(body.models) && body.models.length
        ? body.models.map(String)
        : eyesEnabled()
          ? ["tags", "eyes"]
          : ["tags"];
    if (want.some((k) => k !== "tags" && k !== "eyes"))
      throw new HttpError(400, "Only the tag and eye models run in the browser; captions are made by the desktop app");
    const tags = want.includes("tags") && !(await modelReady());
    const eyes = want.includes("eyes") && !(await eyesModelReady());
    if (!tags && !eyes) return { ok: true, ready: true };
    startJob("model", null, async (job) => {
      const l = lib;
      // the small eye model first: the job ends saying what the tag model's arrival means
      if (eyes) {
        await fetchFiles(l, job, eyesSource(), EYES_DIR, "eye model");
        eyesReady = null;
        job.message = "Eye model ready: look-alikes now prefer open eyes";
      }
      if (tags) {
        await fetchFiles(l, job, clipSource(), CLIP_DIR, "tag model");
        clipReady = null;
        job.message = "Tag model ready: slides are analysed in the background";
      }
    });
    return { ok: true, ready: false };
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/insights\/run$/))) {
    // analyse this tray in the background (the open tray is anyway); force: every slide again,
    // decisions already made are kept
    const sid = m[1];
    const { d } = await update(sid, (d) => {
      if (body.force) for (const g of d.groups) if (g.insights) g.insights.key = "";
    });
    if (!queuedTrays.includes(sid)) queuedTrays.push(sid);
    kickInsights();
    return payload(d);
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/lookalikes$/))) {
    // look for this tray's uploaded slides among the photos in Immich (a job): the ones not checked
    // yet or waiting for Immich to index them; all: every uploaded slide again
    const sid = m[1];
    await loadSession(sid);
    if (!(await modelReady()))
      throw new HttpError(400, "Download the tag model first (Settings → Suggest tags): it compares the photos.");
    startJob("lookalike", sid, (job) => checkLookalikesJob(job, sid, !!body.all));
    return { ok: true };
  }
  if (is("GET", /^\/api\/people$/)) return peoplePayload(await refreshPeople());
  if (is("POST", /^\/api\/people\/scan$/)) {
    // the face model if needed, then the faces on every slide not done yet
    if (!loadConfig().people_enabled) throw new HttpError(400, "Turn on recognising people in Settings first.");
    startJob("faces", null, scanPeople);
    return { ok: true };
  }
  if (is("POST", /^\/api\/people\/tag$/)) {
    const cfg = loadConfig();
    if (!cfg.immich_url || !cfg.immich_key)
      throw new HttpError(400, "Set your Immich URL and API key in Settings first.");
    startJob("tag", null, tagPeopleJob);
    return { ok: true };
  }
  if ((m = is("PATCH", /^\/api\/people\/([^/]+)$/))) {
    const pid = m[1];
    return peoplePayload(await refreshPeople((d) => renamePerson(d, pid, String(body.name ?? ""))));
  }
  if ((m = is("POST", /^\/api\/people\/([^/]+)\/merge$/))) {
    const pid = m[1];
    const others = ((body.people as unknown[]) ?? []).map(String);
    return peoplePayload(await refreshPeople((d) => mergePeople(d, pid, others)));
  }
  if ((m = is("POST", /^\/api\/people\/([^/]+)\/remove$/))) {
    const pid = m[1];
    const faces = ((body.faces as unknown[]) ?? []).map(String);
    return peoplePayload(await refreshPeople((d) => removeFaces(d, pid, faces)));
  }
  if (is("GET", /^\/api\/places$/)) {
    // GeoNames' cities, from the snapshot the page can download (places.ts); typed coordinates always
    const q = u.searchParams.get("q") ?? "";
    const limit = Math.max(1, Math.min(Math.trunc(Number(u.searchParams.get("limit"))) || 8, 20));
    return {
      ready: await gazetteerReady(),
      downloading: (current?.kind === "places" || current?.kind === "ocr") && !current.finished,
      mb: GAZETTEER_MB,
      results: q.trim() ? searchPlaces(await gazetteer(), q, limit) : [],
    };
  }
  if (is("POST", /^\/api\/places\/download$/)) {
    // the place names (job "places"), or with ocr the text reader too (job "ocr")
    const ocr = !!body.ocr;
    if (ocr ? await ocrOn() : await gazetteerReady()) return { ok: true, ready: true };
    startJob(ocr ? "ocr" : "places", null, async (job) => {
      if (!(await gazetteerReady())) await downloadGazetteer(job);
      if (!ocr) return;
      job.done = 0;
      await fetchFiles(lib, job, ocrSource(), OCR_DIR, "text reader");
      ocrState = null;
      job.message = "Text reader ready: signs are read for place suggestions in the background";
    });
    return { ok: true, ready: false };
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/split$/))) {
    const [, sid, gid] = m;
    const { d } = await update(sid, (d) => {
      const g = group(d, gid);
      editable(g);
      splitAt(d, g, String(body.scan));
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
      mergeNext(d, i);
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
          g.params = { ...p, ...framing(g.params) };
        }
      });
      if (body.as_default) d.defaults = { ...p, ...FRAMING, local: [] };
    });
    return payload(d);
  }
  if (is("GET", /^\/api\/presets$/)) return { presets: await loadPresets() };
  if (is("POST", /^\/api\/presets$/)) {
    const name = String(body.name ?? "")
      .trim()
      .slice(0, 80);
    if (!name) throw new HttpError(400, "Give the preset a name");
    let params: Params;
    if (body.session) params = group(await loadSession(String(body.session)), String(body.group ?? "")).params;
    else if (body.params && typeof body.params === "object") params = body.params as Params;
    else throw new HttpError(400, "Nothing to save: send params or a slide");
    return locked(async () => {
      const presets = (await loadPresets()).filter((p) => p.name !== name);
      presets.push({ name, params: colour(params), created: Date.now() / 1000 });
      await savePresets(presets);
      return { presets };
    });
  }
  if ((m = is("DELETE", /^\/api\/presets\/(.+)$/))) {
    const name = decodeURIComponent(m[1]);
    return locked(async () => {
      const presets = await loadPresets();
      if (!presets.some((p) => p.name === name)) throw new HttpError(404, "No such preset");
      const left = presets.filter((p) => p.name !== name);
      await savePresets(left);
      return { presets: left };
    });
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/look$/))) {
    // another look's colour (a preset, or any slide of any tray) on this slide or on it and the rest
    const [, sid, gid] = m;
    let look: Params;
    let source: string;
    let what: string;
    if ("preset" in body) {
      const hit = (await loadPresets()).find((p) => p.name === body.preset);
      if (!hit) throw new HttpError(404, "No such preset");
      [look, source, what] = [{ ...hit.params, ...FRAMING } as Params, `preset:${hit.name}`, "preset"];
    } else if (body.like && typeof body.like === "object") {
      const like = body.like as { session?: string; group?: string };
      const other = await loadSession(String(like.session ?? ""));
      const og = group(other, String(like.group ?? ""));
      [look, source, what] = [og.params, `like:${groupIndex(other, og.id) + 1}:${other.name}`, "like"];
    } else throw new HttpError(400, "Send a preset or a slide to develop like");
    const c = colour(look);
    const rest = body.scope === "rest";
    let applied = 0;
    const { d } = await update(sid, async (d) => {
      const start = groupIndex(d, gid);
      if (start < 0) throw new HttpError(404, "Slide not found");
      if (!rest) editable(d.groups[start]);
      for (const [i, g] of d.groups.entries()) {
        if (g.locked || i < start || (i > start && (!rest || g.reviewed))) continue;
        remember(g, what);
        g.params = cleanParams({ ...c, ...framing(g.params) });
        g.params_source = source;
        await learn(d, g);
        applied++;
      }
    });
    return { ...(await payload(d)), applied };
  }
  if ((m = is("GET", /^\/api\/stats$/))) {
    const t = Math.trunc(Number(u.searchParams.get("target")));
    const all: SessionData[] = [];
    for (const e of await lib.list("sessions")) {
      if (e.kind !== "directory") continue;
      try {
        all.push(await loadSession(e.name));
      } catch {
        /* not a tray */
      }
    }
    return libraryStats(
      all.map(summary),
      all.flatMap(slideTimes),
      t > 0 ? t : loadConfig().stats_target || DEFAULT_TARGET,
    );
  }
  if ((m = is("GET", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/full$/))) {
    const d = await loadSession(m[1]);
    const { width, height } = await zoomImage(d, group(d, m[2]));
    return { width, height, tile: TILE, key: renderKey(group(d, m[2])) } satisfies FullInfo;
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/groups\/([^/]+)\/resuggest$/))) {
    const [, sid, gid] = m;
    let applied = 0;
    const mdl = await model();
    const { d } = await update(sid, (d) => {
      const targets = body.all ? d.groups : [group(d, gid)];
      for (const g of targets) {
        if (g.reviewed || g.skip || g.locked || !g.feat) continue;
        const [sug, n] = mdl.suggest(g.feat, effective(d, g));
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
      { src: await fusedSrc(d0, g0), rotation: g0.rotation, mirror: !!g0.mirror, params: g0.params, x: Number(body.x), y: Number(body.y) },
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
      set.angle = (g0.mirror ? mount.angle : -mount.angle) || 0; // measured on the scan as it came
      if (body.trim)
        set.crop = await ui.call(
          "mountCrop",
          {
            src: await fusedSrc(d0, g0),
            rotation: g0.rotation, mirror: !!g0.mirror,
            params: cleanParams({ ...g0.params, ...set }),
            box: rotateBox(g0.mirror ? mirrorBox(mount.box) : mount.box, g0.rotation),
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
  if (is("GET", /^\/api\/immich\/albums$/)) {
    const albums = await immichClient().albums();
    return albums
      .map((a) => ({
        id: a.id,
        name: a.albumName ?? "",
        count: a.assetCount ?? 0,
        thumb: a.albumThumbnailAssetId ?? null,
      }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
  if ((m = is("GET", /^\/api\/immich\/albums\/([^/]+)\/assets$/))) {
    const assets = await immichClient().albumAssets(m[1]);
    const pulled = new Map<string, string>();
    for (const t of await listSessions())
      for (const sc of Object.values((await loadSession(t.id)).scans))
        if (sc.immich_asset) pulled.set(sc.immich_asset, t.name);
    return assets
      .filter((a) => (a.type ?? "IMAGE") === "IMAGE" && !a.isTrashed)
      .map((a) => ({
        id: a.id,
        name: a.originalFileName ?? "",
        date: (a.localDateTime ?? "").slice(0, 10),
        favorite: !!a.isFavorite,
        tray: pulled.get(a.id) ?? "",
      }))
      .sort((a, b) => (a.date === b.date ? (a.name < b.name ? -1 : 1) : a.date < b.date ? -1 : 1));
  }
  if (is("POST", /^\/api\/immich\/import$/)) {
    const ids = ((body.assets as unknown[]) ?? []).map(String);
    if (!ids.length) throw new HttpError(400, "Pick at least one photo.");
    if (current && !current.finished) throw new HttpError(409, `Busy with ${current.kind} - wait for it to finish.`);
    const d = await createSession(
      String(body.name ?? "").trim() || "From Immich",
      String(body.album ?? "").trim() || null,
      String(body.date ?? "").trim(),
    );
    startJob("import", d.id, (job) => pullIn(job, d.id, ids));
    return { id: d.id };
  }
  if ((m = is("POST", /^\/api\/sessions\/([^/]+)\/pull$/))) {
    const { d, pulled } = await pullMetadata(m[1]);
    return { ...(await payload(d)), pulled };
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

function placeOf(v: unknown): Place | null {
  try {
    return cleanPlace(v);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
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
