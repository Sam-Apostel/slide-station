// Typed client for the Python API (slidestation/server.py). The browser-only build answers the
// same API inside the page (src/standalone/server.ts) — same routes, same payloads.
import * as React from "react";
import type { Curves } from "@/lib/curves";

/** Built with `npm run build:web`: no backend, everything in the browser. */
export const standalone = import.meta.env.VITE_STANDALONE === "1";

export type Params = {
  strength: number;
  brightness: number;
  contrast: number;
  warmth: number;
  tint: number;
  saturation: number;
  trim: boolean;
  curves: Curves;
  /** Straighten, degrees clockwise. */
  angle: number;
  /** [left, top, right, bottom], 0..1 of the straightened frame; null = whole frame. */
  crop: [number, number, number, number] | null;
  /** Dust & scratch repair 0..1 (0 = off). */
  dust: number;
  /** Mould repair 0..1 (0 = off). */
  mould: number;
  /** Newton ring removal 0..1 (0 = off). */
  newton: number;
  /** Local adjustments, applied in order after the global ones (imaging.clean_local); per slide. */
  local?: Local[];
};
export type ParamKey = Exclude<keyof Params, "trim" | "curves" | "crop" | "angle" | "local">;

/** A point in 0..1 of the picture: the trimmed, turned scan before straightening and cropping. */
export type Pt = [number, number];
export type LocalSliders = { exposure: number; contrast: number; warmth: number; tint: number; saturation: number };
export type LocalSlider = keyof LocalSliders;
export type BrushStroke = {
  points: Pt[];
  /** Fraction of the picture's longer edge. */
  radius: number;
  hardness: number;
  flow: number;
  erase: boolean;
};
/** One local adjustment: a mask plus its own sliders (-1..1). Lengths are fractions of the
 *  picture's longer edge; `angle` is degrees clockwise. */
export type Local = LocalSliders &
  (
    | { kind: "graduated"; start: Pt; end: Pt }
    | { kind: "radial"; center: Pt; rx: number; ry: number; angle: number; feather: number; invert: boolean }
    | { kind: "brush"; strokes: BrushStroke[] }
  );

/** The slide mount's inner edge: how far the picture is turned in it (degrees clockwise; straighten
 *  by -angle), how sure that is (0..1), and its sides [l, t, r, b] in 0..1 of the unturned scan. */
export type Mount = { angle: number; confidence: number; box: (number | null)[] };
/** From this confidence the Frame section offers "Straighten to mount" (imaging.MOUNT_SUGGEST). */
export const MOUNT_SUGGEST = 0.5;

export type GroupStatus = "new" | "reviewed" | "uploaded" | "changed" | "skipped";

/** Kinds of suggestion a slide can get (ARCHITECTURE "Insights"); tags come from a model, places from
 *  signs and neighbours, film stock and date from the fade signature and the tray (ARCHITECTURE
 *  "Film stock"), no model. */
export type InsightKind = "tags" | "caption" | "date" | "place" | "stock";

/** Film stocks a slide (or tray) can be set to; "" = not set (a slide then takes the tray's). */
export const STOCKS = ["kodachrome", "ektachrome", "agfachrome", "fujichrome", "other", "unknown"] as const;
export const STOCK_NAMES: Record<string, string> = {
  kodachrome: "Kodachrome",
  ektachrome: "Ektachrome",
  agfachrome: "Agfachrome",
  fujichrome: "Fujichrome",
  other: "Other",
  unknown: "Unknown",
};
/** A stock's era (filmstock.ERAS) and whether the slide's date lies inside it. */
export type EraHint = { stock: string; from: number; to: number | null; fits: boolean | null };
/** Tray-level look-alike suggestions (ARCHITECTURE "Look-alikes"), decided by `id`. */
export type SimilarKind = "duplicates" | "split" | "merge";
export type SimilarSuggestion = {
  kind: SimilarKind;
  id: string;
  /** The slides it is about (ids, tray order): the same shot / the bracket to split / the two to merge. */
  groups: string[];
  confidence: number;
  source: string;
  state: "suggested";
  /** duplicates: the one to keep (sharpest, least clipped, eyes open) and each slide's quality score. */
  best?: string;
  scores?: Record<string, number>;
  /** duplicates with faces: how open each measured slide's eyes are (0..1), the slides where someone blinked. */
  eyes?: Record<string, number>;
  closed?: string[];
  /** split: the scan the second slide starts at. */
  scan?: string;
  /** merge: how far apart the two exposures are, in stops. */
  stops?: number;
};
/** A run of similar slides in the tray (indices, inclusive); `label` is the tag most of them have. */
export type Scene = { start: number; end: number; label: string };
export type Similar = {
  duplicates: SimilarSuggestion[];
  split: SimilarSuggestion[];
  merge: SimilarSuggestion[];
  scenes: Scene[];
};
/** Photos already in Immich that look like this slide's upload. */
export type Lookalike = {
  state: "checked" | "pending" | "unsupported";
  /** Found by Immich's search by image, or among the photos taken around the slide's date. */
  via: "smart" | "date";
  matches: { id: string; similarity: number; name: string; date: string; state: Suggestion["state"] }[];
};

/** Where a slide was taken: goes to Immich as latitude / longitude and into the JPEG as EXIF GPS.
 *  `admin` (region) and `id` (GeoNames) come with places picked from the gazetteer. */
export type Place = { name: string; lat: number; lon: number; country: string; admin?: string; id?: number };

/** "Venice, Italy" (with the region when asked: "Venice, Veneto, Italy"). */
export const placeLabel = (p: Place, region = false) =>
  [p.name, ...[region ? p.admin : "", p.country].filter((x) => x && x !== p.name)].join(", ");

export type Suggestion = {
  /** What it suggests, as it reads (a place: "Venice, Italy"). */
  value: string;
  /** 0..1: the model's share for this value. */
  confidence: number;
  /** Which model said so, e.g. "clip-vit-b32". */
  source: string;
  /** Suggestions are never applied silently: accepted ones became the slide's own, dismissed ones stay away. */
  state: "suggested" | "accepted" | "dismissed";
  /** A place suggestion's place. */
  place?: Place;
  /** Why: the text read in the photo ("WELCOME TO VENICE"), or the slides around it ("slides 11 and 14"). */
  text?: string;
};
export type SlideInsights = {
  tags: Suggestion[];
  caption: Suggestion | null;
  date: Suggestion | null;
  place: Suggestion | null;
  /** The film stock guessed from how the slide faded (heuristic or k-NN over your labels). */
  stock?: Suggestion | null;
  /** Text the text reader found in the photo (once downloaded). */
  text?: string[];
  /** Computed from other scans or another rotation: being analysed again. */
  stale: boolean;
  /** Why the slide couldn't be analysed ("" when it was). */
  error: string;
};

export type Group = {
  id: string;
  index: number;
  scans: string[];
  excluded: string[];
  active: string[];
  /** Server's render key for the current scans/rotation/params — the preview cache key. */
  key: string;
  /** Changes when the tone curve's input does (scans, auto restore, trim) — the histogram cache key. */
  tone_key: string;
  can_undo: boolean;
  can_redo: boolean;
  /** null: not looked for yet (a tray from before mount detection, or the scans changed). */
  mount: Mount | null;
  rotation: number;
  rot_reason: string;
  params: Params;
  params_source: string;
  /** Scans the import left out of the blend, and why ("blurry" / "clipped"). */
  auto_excluded: Record<string, string>;
  /** The original scans were deleted after upload ("keep originals" off): read-only, Immich has the
   *  final version. Re-importing the scans into the tray unlocks it. */
  locked: boolean;
  /** Pulled in from an Immich album: its upload replaces that photo there. */
  from_immich?: boolean;
  reviewed: boolean;
  skip: boolean;
  status: GroupStatus;
  /** The slide's own date ("" = none) and caption. */
  date: string;
  caption: string;
  /** The slide's own tags: go to Immich as tags and into the JPEG's XMP keywords. */
  tags: string[];
  /** The slide's own film stock ("" = the tray's, `SessionPayload.stock`). */
  stock: string;
  /** Where it was taken (null = not set). */
  place?: Place | null;
  /** What the models suggest, plus the film stock and date guesses; null when there's nothing. */
  insights?: SlideInsights | null;
  /** After upload: look-alikes already in Immich; null = not checked. */
  lookalike?: Lookalike | null;
  /** The date it goes to Immich with: its own, or estimated from the dated slides around it. */
  date_est: {
    value: string;
    source: "own" | "between" | "near" | "tray" | "scan";
    from?: number[];
    /** Its film stock's era: a hint only, never changes the value. */
    era?: EraHint;
  };
};

export type Summary = {
  id: string;
  name: string;
  album: string;
  date: string;
  created: number;
  slides: number;
  scans: number;
  reviewed: number;
  uploaded: number;
  skipped: number;
  pending_upload: number;
  /** Developed and not in Immich yet. */
  ready_upload: number;
  card_cleaned: boolean;
  sources: string[];
};

export type SessionPayload = {
  summary: Summary;
  defaults: Params;
  groups: Group[];
  cleanup_blockers: string[];
  log: unknown[];
  /** The tray's film stock ("" = not set), for slides without their own. */
  stock: string;
  /** Background analysis: a model turned on, one of those downloaded, slides still to
   *  analyse, and the models turned on but not downloaded yet. */
  insights?: { enabled: boolean; ready: boolean; pending: number; missing?: SuggestionModel[] };
  /** Look-alike suggestions for the tray (once the model is there). */
  similar?: Similar | null;
  /** Signs are read for place suggestions (else `ocr_mb` to download for that). */
  places?: { ocr: boolean; ocr_mb: number };
};

/** The models that make suggestions: scene tags (CLIP), captions (Florence-2), and the eye model
 *  (a face mesh) that look-alikes pick the shot with open eyes with. */
export type SuggestionModel = "tags" | "captions" | "eyes";

export type InsightsState = {
  /** The tag model: turned on, downloaded. */
  enabled: boolean;
  ready: boolean;
  downloading: boolean;
  model_mb: number;
  labels: string[];
  learned: Record<string, { accepted: number; dismissed: number }>;
  captions: { enabled: boolean; ready: boolean; model_mb: number };
  /** Look-alikes prefer the shot with open eyes (on only with the tag model). */
  eyes?: { enabled: boolean; ready: boolean; model_mb: number };
  /** Place suggestions from signs: the text reader and the place names are downloaded. */
  ocr_ready?: boolean;
  /** What that download still weighs. */
  ocr_mb?: number;
  ocr_downloading?: boolean;
};

/** `GET /api/places?q=`: the gazetteer (GeoNames cities) and what matches. */
export type PlacesAnswer = { ready: boolean; downloading: boolean; mb: number; results: Place[] };

export type Source = {
  path: string;
  name: string;
  count: number;
  new: number;
  scanner: boolean;
  removable: boolean;
  /** A folder uploaded from the browser, not imported yet (`upload:<id>`). */
  upload?: boolean;
};

/** A camera gphoto2 sees (camera rig mode: tethered capture). */
export type Camera = { model: string; port: string };

export type Job = {
  kind: string;
  session: string | null;
  total: number;
  done: number;
  message: string;
  error: string;
  finished: boolean;
  started: number;
  /** Cut off by a server restart (reported as an error); `resumable`: POST /api/job/resume runs it again. */
  interrupted?: boolean;
  resumable?: boolean;
};

export type Config = {
  library: string;
  /** Browser version only: where the library lives. */
  storage?: "disk" | "browser" | "memory";
  immich_url: string;
  has_key: boolean;
  keep_originals: boolean;
  keep_exports: boolean;
  learning_enabled?: boolean;
  /** Also upload the untouched scans, stacked under each developed photo in Immich. */
  upload_originals_stacked?: boolean;
  /** Slides to digitise in all, for the stats' projected finish. */
  stats_target?: number;
  insights_enabled?: boolean;
  /** After upload, look for photos in Immich that look like the new slides. */
  lookalike_enabled?: boolean;
  /** Suggest a caption per slide (desktop app only; opt-in, downloads a caption model). */
  captions_enabled?: boolean;
  /** Faces → people (opt-in, downloads a face model). */
  people_enabled?: boolean;
  /** Look-alikes: prefer the shot where nobody blinked (opt-in, downloads a small face mesh model). */
  eyes_enabled?: boolean;
};

/** Someone found on the slides: faces grouped by likeness across every tray (People dialog). */
export type Person = {
  id: string;
  /** "" until named. */
  name: string;
  /** How many slides they are on. */
  slides: number;
  faces: { id: string; url: string }[];
};

export type PeoplePayload = {
  enabled: boolean;
  /** The face model is downloaded. */
  model: boolean;
  model_mb: number;
  /** Slides whose faces haven't been looked for yet (or were before an edit). */
  pending: number;
  people: Person[];
};

/** An Immich album to pull photos back in from (`GET /api/immich/albums`). */
export type ImmichAlbum = { id: string; name: string; count: number; thumb: string | null };

/** A photo in an Immich album; `tray` names the tray that has it already ("" = none). */
export type ImmichAsset = { id: string; name: string; date: string; favorite: boolean; tray: string };

/** What "Pull from Immich" brought back into a tray. */
export type Pulled = { checked: number; captions: number; dates: number; places?: number; gone: number };

/** A named colour look (never framing), library-wide. */
export type Preset = { name: string; params: Omit<Params, "crop" | "angle" | "local">; created: number };

/** The full-resolution render of a slide, for 1:1 zoom: loaded in `tile`-pixel squares. */
export type FullInfo = { width: number; height: number; tile: number; key: string };

export type AppState = {
  config: Config;
  sources: Source[];
  sessions: Summary[];
  job: Job | null;
  /** What the Python server can do (absent in the browser version): accounts (a hosted server,
   *  each Immich user their own library), camera RAW files. */
  server?: { accounts: boolean; raw: boolean; watch?: boolean };
  /** Tethered capture: null without gphoto2 (or on a hosted server). */
  camera?: { cameras: Camera[] } | null;
  /** Room used and allowed in bytes, when the server sets quotas (a hosted server, per account). */
  quota?: { library?: Quota; uploads?: Quota } | null;
  /** Watched folders as the server's last poll saw them (null: none watched). */
  watch?: WatchSummary | null;
};

/** Watched folders at a glance, for the activity well: sub-folders by state. */
export type WatchSummary = {
  folders: number;
  waiting: number;
  queued: number;
  /** The sub-folder being imported now ("" = none). */
  importing: string;
  imported: number;
  errors: number;
};

/** A sub-folder of a watched folder: each becomes a tray of its own. */
export type WatchedSub = {
  name: string;
  state: "waiting" | "importing" | "imported" | "error";
  tray?: string | null;
  slides?: number;
  scans?: number;
  /** Why it waits ("waiting for .done", "queued behind the current job"…), or what happened. */
  note?: string;
  error?: string;
};

export type WatchedFolder = {
  id: string;
  path: string;
  auto_upload: boolean;
  require_done: boolean;
  settle?: number;
  /** The folder itself can't be read (gone, unmounted, outside the allowed root). */
  error: string;
  subfolders: WatchedSub[];
};

/** GET /api/watch: the server app only (the browser version has no folders to watch). */
export type WatchState = {
  /** False on a hosted server without SLIDESTATION_WATCH_ROOT. */
  available: boolean;
  /** Folders must be in here (a server), or null (anywhere: the desktop app). */
  root: string | null;
  /** Seconds a sub-folder must stay unchanged before it is imported. */
  settle: number;
  interval: number;
  folders: WatchedFolder[];
};

export type Quota = { used: number; limit: number };

/** A hosted server's accounts: who is signed in (GET /api/auth). */
export type AuthState = {
  accounts: boolean;
  user: { id: string; name: string; email: string } | null;
  immich_url?: string;
  /** Why the last session ended by itself, e.g. its API key was revoked in Immich. */
  ended?: string;
};

/** Fired when the server says the session is gone (accounts): the sign-in screen takes over. */
export const SIGNED_OUT = "slide-station-signed-out";

/** A request the server refused: its status and the rest of its answer (e.g. `quota`). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  if (standalone) {
    const server = await import("@/standalone/server");
    return (await server.handle(method, url, (body ?? {}) as Record<string, unknown>)) as T;
  }
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.signin) window.dispatchEvent(new Event(SIGNED_OUT));
  if (!r.ok) throw new ApiError(j.error || j.detail || `${r.status} ${r.statusText}`, r.status, j);
  return j as T;
}

/**
 * Previews are cached forever under the server's render key, so the URL only changes once the
 * server has saved an edit. Never derive it from optimistic local params: the server renders what
 * it has saved, and an image cached under a key it doesn't match stays wrong.
 */
export const previewUrl = (sid: string, g: Group, size: number, before = false, uncropped = false) =>
  `/api/sessions/${sid}/groups/${g.id}/preview.jpg?size=${size}&v=${g.key}${before ? "&before=1" : ""}${
    uncropped ? "&uncropped=1" : ""
  }`;

export const histogramUrl = (sid: string, g: Group) => `/api/sessions/${sid}/groups/${g.id}/histogram?v=${g.tone_key}`;

/** A square of the slide's full-resolution render (1:1 zoom), on a fixed grid of FullInfo.tile pixels. */
export const tileUrl = (sid: string, g: Group, col: number, row: number) =>
  `/api/sessions/${sid}/groups/${g.id}/tile.jpg?col=${col}&row=${row}&v=${g.key}`;

export const scanThumbUrl = (sid: string, scan: string) => `/api/sessions/${sid}/scans/${scan}/thumb.jpg`;

/** Immich's own thumbnail of a photo, through the app (the browser version fetches it from Immich). */
export const immichThumbUrl = (asset: string) => `/api/immich/assets/${asset}/thumb.jpg`;

// ---------------------------------------------------------------- images

/** Rendered images by URL, as object URLs (browser version), oldest first. */
const images = new Map<string, string>();
const rendering = new Map<string, Promise<string>>();
const IMAGES_MAX = 400;

/**
 * What to put in an <img src> for an API image URL. The server answers those URLs itself; the
 * browser version renders them in a worker and hands back an object URL, cached like the server's
 * HTTP cache: only a render of the key the URL names is kept. `priority` puts the photo on screen
 * ahead of filmstrip thumbnails.
 */
export function imageSrc(url: string, priority = 0): Promise<string> {
  if (!standalone) return Promise.resolve(url);
  const hit = images.get(url);
  if (hit) return Promise.resolve(hit);
  const busy = rendering.get(url);
  if (busy) return busy;
  const p = import("@/standalone/server")
    .then((server) => server.image(url, priority))
    .then(({ blob, fresh }) => {
      const src = URL.createObjectURL(blob);
      if (fresh) {
        images.set(url, src);
        for (const [k, v] of images) {
          if (images.size <= IMAGES_MAX) break;
          images.delete(k);
          URL.revokeObjectURL(v);
        }
      }
      return src;
    })
    .finally(() => rendering.delete(url));
  rendering.set(url, p);
  return p;
}

/** imageSrc as a hook: null until the image is ready. */
export function useImageSrc(url: string | null, priority = 0): string | null {
  const [src, setSrc] = React.useState<string | null>(standalone ? url && (images.get(url) ?? null) : url);
  React.useEffect(() => {
    if (!standalone || !url) return setSrc(url);
    let live = true;
    imageSrc(url, priority).then(
      (s) => live && setSrc(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [url, priority]);
  return src;
}

export const needsReview = (g: Group) => !g.reviewed && !g.skip && g.status !== "uploaded";

export const sourceLabel = (s: Source) => (s.scanner ? "Slide N Scan" : s.name);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
