// Look-alikes from the CLIP embeddings (slidestation/similar.py, function by function): the tray's
// embeddings.json (same file, same float16 packing, so a library moves between the apps), near-
// duplicates with "keep the best", the grouping safety net (split / merge), scenes, and the check
// against the photos already in Immich. similar.py's docstrings say why each rule is what it is.
import type { SimilarSuggestion } from "@/lib/api";
import { dot, unit } from "./clip";
import { similarity } from "./imaging";
import { percentile, rgb, sortedCopy, type RGB } from "./pixels";
import { activeScans, parseDate, pyDumps, PyInt, sha1Hex, type GroupData, type SessionData } from "./store";
import type { Learned } from "./clip";
import { bestOf, CLOSED, MODEL_ID as EYES_MODEL, slideOpen, type EyesEntry } from "./eyes";

export const KINDS = ["duplicates", "split", "merge"] as const;
export const MODEL_ID = "clip-vit-b32";

export const DUPLICATE = 0.93;
export const DUPLICATE_MAX = 0.97;
export const WINDOW = 3;
export const SPLIT = 0.8;
export const MERGE = 0.85;
export const MERGE_STOPS = 0.3;
export const MERGE_STRUCT = 0.6;
export const SCENE = 0.8;
export const SCENE_SPAN = 4;

export type Quality = { sharp: number; clipped: number };
export type SlideEmb = { key: string; emb?: string; q?: Quality; eyes?: EyesEntry; error?: string };
export type ScanEmb = { emb?: string; lum?: number; error?: string };
export type Embeddings = { slides: Record<string, SlideEmb>; scans: Record<string, ScanEmb> };
export type Scene = { start: number; end: number; label: string };
export type SimilarAll = {
  duplicates: SimilarSuggestion[];
  split: SimilarSuggestion[];
  merge: SimilarSuggestion[];
  scenes: Scene[];
};

// ------------------------------------------------------------------ storage (base64 float16)

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** numpy's float32 -> float16 (round to nearest, ties to even). */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 112;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && h & 1)) h++;
    return sign | h;
  }
  let h = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++; // a carry moves into the exponent, as it should
  return sign | h;
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** similar._pack: a vector as base64 float16 (little endian). */
export function pack(v: ArrayLike<number>): string {
  const h = new Uint16Array(v.length);
  for (let i = 0; i < v.length; i++) h[i] = toHalf(v[i]);
  return b64(new Uint8Array(h.buffer));
}

/** similar.unpack: base64 float16 back to a unit float32 vector. */
export function unpack(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const h = new Uint16Array(bytes.buffer, 0, bytes.length >> 1);
  return unit(Array.from(h, fromHalf));
}

export const emptyEmbeddings = (): Embeddings => ({ slides: {}, scans: {} });

/** What a slide's embedding was computed from: its blended scans, turned upright. */
export const slideKey = (g: GroupData) =>
  sha1Hex(pyDumps([activeScans(g), new PyInt(g.rotation), MODEL_ID, ...(g.mirror ? ["mirror"] : [])])).slice(0, 12);

/** similar.normalise: exposure taken out (luminance 1st..99th percentile to 0.02..0.98). */
export function normalise(a: RGB): RGB {
  const n = a.width * a.height;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = (a.data[i * 3] + a.data[i * 3 + 1] + a.data[i * 3 + 2]) / 3;
  const s = sortedCopy(lum);
  const [lo, hi] = [percentile(s, 1), percentile(s, 99)];
  const span = Math.max(hi - lo, 1e-3);
  const out = rgb(a.width, a.height);
  for (let i = 0; i < a.data.length; i++)
    out.data[i] = Math.min(1, Math.max(0, ((a.data[i] - lo) / span) * 0.96 + 0.02));
  return out;
}

/** similar.levels: each channel's 1st..99th percentile stretched to 0..1 (a crude restore). */
export function levels(a: RGB): RGB {
  const n = a.width * a.height;
  const out = rgb(a.width, a.height);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = a.data[i * 3 + c];
    const s = ch.sort();
    const [lo, hi] = [percentile(s, 1), percentile(s, 99)];
    const span = Math.max(hi - lo, 1e-3);
    for (let i = 0; i < n; i++) out.data[i * 3 + c] = Math.min(1, Math.max(0, (a.data[i * 3 + c] - lo) / span));
  }
  return out;
}

/** An embedded slide whose eyes weren't measured (the eye model came later), or by another model. */
const eyesTodo = (g: GroupData, entry?: SlideEmb) =>
  !!entry && entry.key === slideKey(g) && "emb" in entry && entry.eyes?.model !== EYES_MODEL;

/** The next slide whose embedding is missing or stale, else the next scan without one, else (the eye
 *  model on) the next slide whose eyes weren't measured (similar._todo). */
export function todo(
  d: SessionData,
  e: Embeddings,
  eyesOn = false,
): { g?: GroupData; scan?: string; look?: GroupData } {
  const groups = d.groups.filter((g) => !g.skip);
  for (const g of groups) if (e.slides[g.id]?.key !== slideKey(g)) return { g };
  for (const g of groups) for (const x of activeScans(g)) if (!(x in e.scans)) return { scan: x };
  if (eyesOn) for (const g of groups) if (eyesTodo(g, e.slides[g.id])) return { look: g };
  return {};
}

export function pending(d: SessionData, e: Embeddings, eyesOn = false): number {
  const groups = d.groups.filter((g) => !g.skip);
  return (
    groups.filter((g) => e.slides[g.id]?.key !== slideKey(g)).length +
    groups.reduce((n, g) => n + activeScans(g).filter((x) => !(x in e.scans)).length, 0) +
    (eyesOn ? groups.filter((g) => eyesTodo(g, e.slides[g.id])).length : 0)
  );
}

// ------------------------------------------------------------------ suggestions

/** The duplicate threshold, raised by dismissals like a tag's (similar.threshold). */
export function threshold(stats: Learned): number {
  const c = stats.labels?.duplicates;
  if (!c) return DUPLICATE;
  const f = Math.min(4, Math.max(1, (1 + (c.dismissed ?? 0)) / (1 + (c.accepted ?? 0))));
  return DUPLICATE + ((DUPLICATE_MAX - DUPLICATE) * (f - 1)) / 3;
}

const pair = (a: string, b: string) => [a, b].sort().join("|");
export const score = (q?: Quality) => (q?.sharp ?? 0) * (1 - (q?.clipped ?? 0));
const vec = (entry?: { emb?: string } | null) => (entry?.emb ? unpack(entry.emb) : null);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Every look-alike suggestion for the tray (similar.suggest). `sig(scan)`: the scan's grouping
 *  signature (.sig.npy), null when it isn't there. Dismissed suggestions are left out. */
export async function suggest(
  d: SessionData,
  e: Embeddings,
  dupThreshold: number,
  sig: (scan: string) => Promise<ArrayLike<number> | null>,
): Promise<SimilarAll> {
  const decided = d.similar ?? {};
  const dismissed = new Set(decided.dismissed ?? []);
  const apart = new Set(decided.apart ?? []);
  const groups = d.groups;
  const sug = (kind: SimilarSuggestion["kind"], id: string, gids: string[], conf: number, extra = {}) =>
    ({
      kind,
      id,
      groups: gids,
      confidence: r3(conf),
      source: MODEL_ID,
      state: "suggested",
      ...extra,
    }) as SimilarSuggestion;
  const scanVec = new Map(Object.entries(e.scans).map(([x, v]) => [x, vec(v)]));

  // merge: the signature kept two neighbours apart, CLIP says one frame at two exposures
  const merge: SimilarSuggestion[] = [];
  const mergedPairs = new Set<string>();
  for (let i = 0; i + 1 < groups.length; i++) {
    const [a, b] = [groups[i], groups[i + 1]];
    if (a.skip || b.skip || a.locked || b.locked) continue;
    const [xa, xb] = [activeScans(a), activeScans(b)];
    if (!xa.length || !xb.length) continue;
    const [va, vb] = [scanVec.get(xa[xa.length - 1]), scanVec.get(xb[0])];
    if (!va || !vb) continue;
    const c = dot(va, vb);
    const [la, lb] = [e.scans[xa[xa.length - 1]].lum ?? 0, e.scans[xb[0]].lum ?? 0];
    const stops = Math.abs(Math.log2(Math.max(la, 1e-3) / Math.max(lb, 1e-3)));
    if (c < MERGE || stops < MERGE_STOPS) continue;
    const sb = await sig(xb[0]);
    let struct = -Infinity;
    if (sb)
      for (const x of xa) {
        const sa = await sig(x);
        if (sa) struct = Math.max(struct, similarity(sa, sb));
      }
    if (struct === -Infinity) struct = 1;
    const mid = `merge:${a.id}:${b.id}`;
    if (struct < MERGE_STRUCT || dismissed.has(mid)) continue;
    merge.push(sug("merge", mid, [a.id, b.id], c, { stops: Math.round(stops * 100) / 100 }));
    mergedPairs.add(pair(a.id, b.id));
  }

  // split: a scan of a bracket unlike every scan before it in the stack
  const split: SimilarSuggestion[] = [];
  for (const g of groups) {
    if (g.skip || g.locked) continue;
    const xs = activeScans(g);
    for (let k = 1; k < xs.length; k++) {
      const vk = scanVec.get(xs[k]);
      const before = xs.slice(0, k).map((x) => scanVec.get(x));
      if (!vk || before.some((v) => !v)) continue;
      const c = Math.max(...before.map((v) => dot(v!, vk)));
      const id = `split:${g.id}:${xs[k]}`;
      if (c < SPLIT && !dismissed.has(id))
        split.push(sug("split", id, [g.id], Math.min(1, (SPLIT - c) / 0.3 + 0.5), { scan: xs[k], similarity: r3(c) }));
    }
  }

  // duplicates: nearly the same picture a few slides apart; clusters are connected pairs
  const idx = groups
    .map((g, i) => [g, i] as const)
    .filter(([g]) => !g.skip && e.slides[g.id]?.key === slideKey(g) && !!e.slides[g.id].emb)
    .map(([, i]) => i);
  const v = new Map(idx.map((i) => [i, vec(e.slides[groups[i].id])!]));
  const parent = new Map(idx.map((i) => [i, i]));
  const root = (i: number): number => {
    while (parent.get(i) !== i) {
      parent.set(i, parent.get(parent.get(i)!)!);
      i = parent.get(i)!;
    }
    return i;
  };
  const sims: [number, number, number][] = [];
  for (let n = 0; n < idx.length; n++)
    for (const j of idx.slice(n + 1)) {
      const i = idx[n];
      if (j - i > WINDOW) break;
      const p = pair(groups[i].id, groups[j].id);
      if (apart.has(p) || mergedPairs.has(p)) continue;
      const c = dot(v.get(i)!, v.get(j)!);
      if (c >= dupThreshold) {
        sims.push([i, j, c]);
        parent.set(root(j), root(i));
      }
    }
  const clusters = new Map<number, number[]>();
  for (const i of idx) {
    const r = root(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(i);
  }
  const duplicates: SimilarSuggestion[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const gids = members.map((i) => groups[i].id);
    const scores = Object.fromEntries(gids.map((gid) => [gid, Math.round(score(e.slides[gid].q) * 1e4) / 1e4]));
    const opened: Record<string, number> = {};
    for (const gid of gids) {
      const o = slideOpen(e.slides[gid].eyes);
      if (o !== null) opened[gid] = o;
    }
    const best = bestOf(gids, scores, opened);
    const cs = sims.filter(([i]) => members.includes(i)).map(([, , c]) => c);
    const conf = cs.reduce((a, b) => a + b, 0) / cs.length;
    const measured = gids.filter((gid) => gid in opened);
    // faces: how open each slide's eyes are, and the slides where someone blinked
    const extra = measured.length
      ? {
          eyes: Object.fromEntries(measured.map((gid) => [gid, Math.round(opened[gid] * 100) / 100])),
          closed: gids.filter((gid) => (opened[gid] ?? 1) < CLOSED),
        }
      : {};
    duplicates.push(sug("duplicates", "dup:" + gids.join(","), gids, conf, { best, scores, ...extra }));
  }
  return { duplicates, split, merge, scenes: scenes(groups, e) };
}

/** The tray cut into runs of similar slides (similar.scenes); [] when it is one scene. */
export function scenes(groups: GroupData[], e: Embeddings): Scene[] {
  const seq: [number, Float32Array][] = [];
  groups.forEach((g, i) => {
    if (g.skip) return;
    const s = e.slides[g.id];
    const x = s?.key === slideKey(g) ? vec(s) : null;
    if (x) seq.push([i, x]);
  });
  if (seq.length < 2) return [];
  const starts = [0];
  let run = [seq[0][1]];
  const centre = () => {
    const last = run.slice(-SCENE_SPAN);
    const c = new Float32Array(last[0].length);
    for (const r of last) for (let k = 0; k < c.length; k++) c[k] += r[k] / last.length;
    return unit(c);
  };
  for (let k = 1; k < seq.length; k++) {
    const c = centre();
    const far = dot(seq[k][1], c) < SCENE;
    const nxtFar = k + 1 >= seq.length || dot(seq[k + 1][1], c) < SCENE;
    if (far && nxtFar) {
      starts.push(seq[k][0]);
      run = [seq[k][1]];
    } else if (!far) run.push(seq[k][1]);
  }
  if (starts.length < 2) return [];
  return starts.map((a, n) => {
    const b = n + 1 < starts.length ? starts[n + 1] - 1 : groups.length - 1;
    const members = groups.slice(a, b + 1).filter((g) => !g.skip);
    const counts = new Map<string, [number, number]>(); // tag -> [slides, confidence summed]
    for (const g of members) {
      const have = new Map<string, number>((g.tags ?? []).map((t) => [t, 1]));
      for (const t of g.insights?.tags ?? [])
        if (t.state !== "dismissed" && !have.has(t.value)) have.set(t.value, t.confidence ?? 0);
      for (const [t, conf] of have) {
        const c = counts.get(t) ?? [0, 0];
        counts.set(t, [c[0] + 1, c[1] + conf]);
      }
    }
    let top: [string, [number, number]] = ["", [0, 0]];
    for (const kv of counts)
      if (kv[1][0] > top[1][0] || (kv[1][0] === top[1][0] && kv[1][1] > top[1][1]) || top[0] === "") top = kv;
    return { start: a, end: b, label: top[1][0] * 2 > members.length ? top[0] : "" };
  });
}

/** Remember a dismissed suggestion: duplicates as pairs that aren't the same shot, split / merge by id. */
export function dismiss(d: SessionData, s: SimilarSuggestion) {
  const rec = (d.similar ??= {});
  if (s.kind === "duplicates") {
    const pairs = new Set(rec.apart ?? []);
    s.groups.forEach((a, n) => s.groups.slice(n + 1).forEach((b) => pairs.add(pair(a, b))));
    rec.apart = [...pairs].sort();
  } else rec.dismissed = [...new Set([...(rec.dismissed ?? []), s.id])].sort();
}

// ------------------------------------------------------------------ look-alikes in Immich

export const LOOKALIKE = 0.92;
export const CANDIDATES = 8;
export const DATE_CANDIDATES = 200;

/** The slide's date as a search window: its day, month or year, a day either side (similar._date_window). */
export function dateWindow(date: string): [string, string] | null {
  const p = parseDate(date);
  if (!p) return null;
  const [t, precision] = p;
  const s = new Date(t);
  const end =
    precision === 1
      ? Date.UTC(s.getUTCFullYear() + 1, s.getUTCMonth(), s.getUTCDate())
      : precision === 2
        ? Date.UTC(s.getUTCFullYear() + (s.getUTCMonth() === 11 ? 1 : 0), (s.getUTCMonth() + 1) % 12, s.getUTCDate())
        : t + 86400e3;
  const fmt = (x: number) => new Date(x).toISOString().slice(0, 10) + "T00:00:00.000Z";
  return [fmt(t - 86400e3), fmt(end + 86400e3)];
}

/** The slide's look-alike check for the payload (null: not checked, or uploaded again since). */
export function lookalikeView(g: GroupData) {
  const rec = g.immich?.lookalike;
  if (!rec || rec.asset !== g.immich?.asset_id) return null;
  return { state: rec.state, via: rec.via, matches: rec.matches };
}
