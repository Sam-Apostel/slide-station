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
};
export type ParamKey = Exclude<keyof Params, "trim" | "curves" | "crop" | "angle">;

export type GroupStatus = "new" | "reviewed" | "uploaded" | "changed" | "skipped";

/** Kinds of suggestion a slide can get (ARCHITECTURE "Insights"); only tags have a model so far. */
export type InsightKind = "tags" | "caption" | "date" | "place";
export type Suggestion = {
  value: string;
  /** 0..1: the model's share for this value. */
  confidence: number;
  /** Which model said so, e.g. "clip-vit-b32". */
  source: string;
  /** Suggestions are never applied silently: accepted ones became the slide's own, dismissed ones stay away. */
  state: "suggested" | "accepted" | "dismissed";
};
export type SlideInsights = {
  tags: Suggestion[];
  caption: Suggestion | null;
  date: Suggestion | null;
  place: Suggestion | null;
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
  rotation: number;
  rot_reason: string;
  params: Params;
  params_source: string;
  /** Scans the import left out of the blend, and why ("blurry" / "clipped"). */
  auto_excluded: Record<string, string>;
  /** The original scans were deleted after upload ("keep originals" off): read-only, Immich has the
   *  final version. Re-importing the scans into the tray unlocks it. */
  locked: boolean;
  reviewed: boolean;
  skip: boolean;
  status: GroupStatus;
  /** The slide's own date ("" = none) and caption. */
  date: string;
  caption: string;
  /** The slide's own tags: go to Immich as tags and into the JPEG's XMP keywords. */
  tags: string[];
  /** What the models suggest (desktop app only); null until analysed. */
  insights?: SlideInsights | null;
  /** The date it goes to Immich with: its own, or estimated from the dated slides around it. */
  date_est: { value: string; source: "own" | "between" | "near" | "tray" | "scan"; from?: number[] };
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
  /** Background analysis (desktop app only): turned on, model downloaded, slides still to analyse. */
  insights?: { enabled: boolean; ready: boolean; pending: number };
};

export type InsightsState = {
  enabled: boolean;
  ready: boolean;
  downloading: boolean;
  model_mb: number;
  labels: string[];
  learned: Record<string, { accepted: number; dismissed: number }>;
};

export type Source = {
  path: string;
  name: string;
  count: number;
  new: number;
  scanner: boolean;
  removable: boolean;
};

export type Job = {
  kind: string;
  session: string | null;
  total: number;
  done: number;
  message: string;
  error: string;
  finished: boolean;
  started: number;
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
  insights_enabled?: boolean;
};

export type AppState = {
  config: Config;
  sources: Source[];
  sessions: Summary[];
  job: Job | null;
};

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
  if (!r.ok) throw new Error(j.error || j.detail || `${r.status} ${r.statusText}`);
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

export const histogramUrl = (sid: string, g: Group) =>
  `/api/sessions/${sid}/groups/${g.id}/histogram?v=${g.tone_key}`;

export const scanThumbUrl = (sid: string, scan: string) => `/api/sessions/${sid}/scans/${scan}/thumb.jpg`;

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
  const [src, setSrc] = React.useState<string | null>(standalone ? (url && (images.get(url) ?? null)) : url);
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
