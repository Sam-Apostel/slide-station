// Typed client for the Python API (slidestation/server.py).

export type Params = {
  strength: number;
  brightness: number;
  contrast: number;
  warmth: number;
  tint: number;
  saturation: number;
  trim: boolean;
};
export type ParamKey = Exclude<keyof Params, "trim">;

export type GroupStatus = "new" | "reviewed" | "uploaded" | "changed" | "skipped";

export type Group = {
  id: string;
  index: number;
  scans: string[];
  excluded: string[];
  active: string[];
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

function hash(str: string) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Changes whenever the rendered image would change, so previews can be cached forever. */
export const groupKey = (g: Group) => hash(JSON.stringify([g.active, g.rotation, g.params]));

export const previewUrl = (sid: string, g: Group, size: number, before = false) =>
  `/api/sessions/${sid}/groups/${g.id}/preview.jpg?size=${size}&v=${groupKey(g)}${before ? "&before=1" : ""}`;

export const scanThumbUrl = (sid: string, scan: string) => `/api/sessions/${sid}/scans/${scan}/thumb.jpg`;

export const needsReview = (g: Group) => !g.reviewed && !g.skip && g.status !== "uploaded";

export const sourceLabel = (s: Source) => (s.scanner ? "Slide N Scan" : s.name);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
