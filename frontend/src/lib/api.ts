// Typed client for the Python API (slidestation/server.py).
import type { Curves } from "@/lib/curves";

export type Params = {
  strength: number;
  brightness: number;
  contrast: number;
  warmth: number;
  tint: number;
  saturation: number;
  trim: boolean;
  curves: Curves;
};
export type ParamKey = Exclude<keyof Params, "trim" | "curves">;

export type GroupStatus = "new" | "reviewed" | "uploaded" | "changed" | "skipped";

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
  rotation: number;
  rot_reason: string;
  params: Params;
  params_source: string;
  reviewed: boolean;
  skip: boolean;
  status: GroupStatus;
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
  immich_url: string;
  has_key: boolean;
  keep_originals: boolean;
  keep_exports: boolean;
  learning_enabled?: boolean;
};

export type AppState = {
  config: Config;
  sources: Source[];
  sessions: Summary[];
  job: Job | null;
};

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
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
export const previewUrl = (sid: string, g: Group, size: number, before = false) =>
  `/api/sessions/${sid}/groups/${g.id}/preview.jpg?size=${size}&v=${g.key}${before ? "&before=1" : ""}`;

export const histogramUrl = (sid: string, g: Group) =>
  `/api/sessions/${sid}/groups/${g.id}/histogram?v=${g.tone_key}`;

export const scanThumbUrl = (sid: string, scan: string) => `/api/sessions/${sid}/scans/${scan}/thumb.jpg`;

export const needsReview = (g: Group) => !g.reviewed && !g.skip && g.status !== "uploaded";

export const sourceLabel = (s: Source) => (s.scanner ? "Slide N Scan" : s.name);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
