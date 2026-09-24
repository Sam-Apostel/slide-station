// Tray data and the keys derived from it (slidestation/store.py). session.json is the same file
// the Python app writes, and the keys are computed byte for byte like Python's, so a library
// folder can move between the browser and the desktop app without every slide turning "changed".
import type { GroupStatus, Params } from "@/lib/api";

export type Scan = {
  file: string;
  source: string;
  source_root: string;
  removable: boolean;
  size: number;
  sha1: string;
  taken: string;
  source_deleted: boolean;
  /** Pulled in from Immich: the asset it was downloaded from. */
  immich_asset?: string;
};

/** A slide's copy in Immich (see ARCHITECTURE "Round trip with Immich"). */
export type ImmichRecord = {
  asset_id: string;
  key: string;
  status?: string;
  meta?: string;
  /** What Immich was told besides the pixels: the day and the caption. */
  pushed?: { date: string; caption: string };
  /** The untouched scans stacked under it: scan -> asset, the stack, and which ones this app uploaded. */
  stack_id?: string;
  originals?: Record<string, string>;
  own_originals?: string[];
  /** When it went up (seconds), for the stats. */
  at?: number;
};

export type Snapshot = {
  params: Params;
  rotation: number;
  rot_reason: string;
  params_source: string;
  what?: string;
  t?: number;
};

export type GroupData = {
  id: string;
  scans: string[];
  excluded: string[];
  rotation: number;
  rot_reason: string;
  params: Params;
  reviewed: boolean;
  skip: boolean;
  export: { file: string; key: string; ekey: string; sha1: string } | null;
  immich: ImmichRecord | null;
  /** Pulled in from Immich: its upload replaces this asset. */
  source_asset?: { id: string };
  /** When it was marked developed (seconds), for the stats. */
  developed_at?: number;
  params_source?: string;
  auto_excluded?: Record<string, string>;
  locked?: string;
  date?: string;
  caption?: string;
  feat?: number[];
  history?: { undo: Snapshot[]; redo: Snapshot[] };
};

export type SessionData = {
  id: string;
  name: string;
  album: string;
  date: string;
  created: number;
  defaults: Params;
  scans: Record<string, Scan>;
  groups: GroupData[];
  log: [number, string][];
  card_cleaned?: boolean;
  immich_album_id?: string;
  date_key?: string;
  orphan_assets?: string[];
  orphan_stacks?: string[];
};

// ------------------------------------------------------------------ Python-compatible JSON

/** A number json.dumps prints as a float ("0.0", "1e-05"), as Python holds params. */
export function pyFloat(x: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : x < 0 ? "-Infinity" : "NaN";
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  const a = Math.abs(x);
  if (a >= 1e-4 && a < 1e16) return String(x);
  const [m, e] = x.toExponential().split("e");
  const exp = Number(e);
  return `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** An integer for pyDumps (everything else numeric is printed as a float). */
export class PyInt {
  constructor(public n: number) {}
}

const escape = (s: string) =>
  '"' +
  s.replace(/[\\"\u0000-\u001f\u007f-￿]/g, (c) => {
    const special: Record<string, string> = {
      "\\": "\\\\",
      '"': '\\"',
      "\n": "\\n",
      "\r": "\\r",
      "\t": "\\t",
      "\b": "\\b",
      "\f": "\\f",
    };
    return special[c] ?? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  }) +
  '"';

/** json.dumps(v, sort_keys=sortKeys) with Python's separators and ensure_ascii. */
export function pyDumps(v: unknown, sortKeys = false): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof PyInt) return String(Math.trunc(v.n));
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return pyFloat(v);
  if (typeof v === "string") return escape(v);
  if (Array.isArray(v)) return "[" + v.map((x) => pyDumps(x, sortKeys)).join(", ") + "]";
  const keys = Object.keys(v as object);
  if (sortKeys) keys.sort();
  return (
    "{" + keys.map((k) => `${escape(k)}: ${pyDumps((v as Record<string, unknown>)[k], sortKeys)}`).join(", ") + "}"
  );
}

/**
 * session.json as the Python app writes it (indent=1). Numbers inside params are written as
 * floats, because Python keeps them as floats and hashes them that way in render_key.
 */
export function dumpSession(d: unknown): string {
  const walk = (v: unknown, floats: boolean, ind: string): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return floats ? pyFloat(v) : Number.isFinite(v) ? JSON.stringify(v) : "null";
    if (typeof v === "boolean" || typeof v === "string") return typeof v === "string" ? escape(v) : String(v);
    const inner = ind + " ";
    if (Array.isArray(v))
      return v.length ? "[\n" + v.map((x) => inner + walk(x, floats, inner)).join(",\n") + "\n" + ind + "]" : "[]";
    const entries = Object.entries(v as object).filter(([, x]) => x !== undefined);
    if (!entries.length) return "{}";
    return (
      "{\n" +
      entries
        .map(([k, x]) => `${inner}${escape(k)}: ${walk(x, floats || k === "params" || k === "defaults", inner)}`)
        .join(",\n") +
      "\n" +
      ind +
      "}"
    );
  };
  return walk(d, false, "");
}

// ------------------------------------------------------------------ SHA-1 (sync, for short keys)

export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const words = new Uint32Array((((len + 8) >> 6) + 1) * 16);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  words[words.length - 1] = len * 8;
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < words.length; off += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[off + t];
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

// ------------------------------------------------------------------ keys and statuses

export function activeScans(g: GroupData): string[] {
  const s = g.scans.filter((x) => !(g.excluded ?? []).includes(x));
  return s.length ? s : g.scans.slice(0, 1);
}

const isNeutral = (k: string, v: unknown) =>
  (k === "curves" && v && typeof v === "object" && !Object.keys(v).length) ||
  (k === "angle" && v === 0) ||
  (k === "crop" && v === null);

/** Identifies the exact output of a slide; changes whenever the result would change. */
export function renderKey(g: GroupData): string {
  // settings still at their neutral value are left out, so slides uploaded before a setting
  // existed (curves, straighten, crop) don't become "changed"
  const params = Object.fromEntries(Object.entries(g.params).filter(([k, v]) => !isNeutral(k, v)));
  return sha1Hex(pyDumps([activeScans(g), new PyInt(g.rotation), params], true)).slice(0, 12);
}

/** Identifies the tone curve's input (what its histogram shows). */
export function toneKey(g: GroupData): string {
  const p = g.params;
  return sha1Hex(
    pyDumps([activeScans(g), new PyInt(g.rotation), p.strength, p.trim, p.angle ?? 0, p.crop ?? null]),
  ).slice(0, 12);
}

const DATE_RE = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/;

/** '1978', '1978-06' or '1978-06-14' -> (start of that period in UTC ms, precision 1..3). */
export function parseDate(v: string | undefined): [number, number] | null {
  const m = DATE_RE.exec((v ?? "").trim().replace(/\//g, "-"));
  if (!m) return null;
  const y = +m[1];
  const mo = Math.max(1, Math.min(12, +(m[2] ?? 1)));
  const d = Math.max(1, Math.min(31, +(m[3] ?? 1)));
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null; // e.g. 31 June
  const dt = new Date(t);
  dt.setUTCFullYear(y); // years below 100
  return [dt.getTime(), 1 + (m[2] ? 1 : 0) + (m[3] ? 1 : 0)];
}

export function formatDate(t: number, precision: number): string {
  const d = new Date(t);
  const parts = [
    String(d.getUTCFullYear()).padStart(4, "0"),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ];
  return parts.slice(0, precision).join("-");
}

export type DateEst = { value: string; source: "own" | "between" | "near" | "tray" | "scan"; from?: number[] };

/** The date each slide goes to Immich with, and where it came from (store.slide_dates). */
export function slideDates(d: SessionData): DateEst[] {
  const own = d.groups.map((g) => parseDate(g.date));
  const dated = own.flatMap((x, i) => (x ? [i] : []));
  const tray = parseDate(d.date);
  return d.groups.map((_, i) => {
    const mine = own[i];
    if (mine) return { value: formatDate(...mine), source: "own" };
    const before = dated.filter((j) => j < i).pop();
    const after = dated.find((j) => j > i);
    if (before !== undefined && after !== undefined) {
      const [t0, p0] = own[before]!;
      const [t1, p1] = own[after]!;
      const t = t0 + (t1 - t0) * ((i - before) / (after - before));
      return { value: formatDate(t, Math.min(p0, p1)), source: "between", from: [before, after] };
    }
    const j = before ?? after;
    if (j !== undefined) return { value: formatDate(...own[j]!), source: "near", from: [j] };
    if (tray) return { value: formatDate(...tray), source: "tray" };
    return { value: "", source: "scan" };
  });
}

/** What besides the pixels goes to Immich with a slide: its date and caption. */
export const metaKey = (g: GroupData, date: DateEst) =>
  sha1Hex(pyDumps([date.value ?? "", g.caption ?? ""])).slice(0, 12);

export function groupStatus(g: GroupData, meta?: string): GroupStatus {
  if (g.skip) return "skipped";
  const im = g.immich;
  if (im && g.locked) return "uploaded"; // originals gone: Immich's copy is the final one
  if (im && im.key === renderKey(g) && (meta === undefined || (im.meta ?? meta) === meta)) return "uploaded";
  if (im) return "changed";
  return g.reviewed ? "reviewed" : "new";
}

export function statuses(d: SessionData): GroupStatus[] {
  const dates = slideDates(d);
  return d.groups.map((g, i) => groupStatus(g, metaKey(g, dates[i])));
}

export function summary(d: SessionData) {
  const st = statuses(d);
  const g = d.groups;
  return {
    id: d.id,
    name: d.name,
    album: d.album,
    date: d.date ?? "",
    created: d.created,
    slides: g.length,
    scans: Object.keys(d.scans).length,
    reviewed: g.filter((x, i) => x.reviewed || st[i] === "uploaded" || st[i] === "skipped").length,
    uploaded: st.filter((s) => s === "uploaded").length,
    skipped: st.filter((s) => s === "skipped").length,
    pending_upload: st.filter((s) => s === "new" || s === "reviewed" || s === "changed").length,
    // developed (marked ready) and not in Immich yet: what "upload the ready ones" sends
    ready_upload: g.filter((x, i) => x.reviewed && (st[i] === "reviewed" || st[i] === "changed")).length,
    card_cleaned: d.card_cleaned ?? false,
    sources: [...new Set(Object.values(d.scans).map((s) => s.source_root ?? ""))].sort(),
  };
}

export const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "session";

export const randomHex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2))), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, n);

export function newGroup(d: SessionData, scans: string[], rotation = 0, rotReason = ""): GroupData {
  return {
    id: randomHex(8),
    scans,
    excluded: [],
    rotation,
    rot_reason: rotReason,
    params: structuredClone(d.defaults),
    reviewed: false,
    skip: false,
    export: null,
    immich: null,
  };
}
