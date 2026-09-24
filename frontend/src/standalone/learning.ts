// Learns your colour corrections and applies them to new slides (slidestation/learning.py):
// 14 image features per developed slide plus the settings you accepted, distance-weighted k-NN.
// The examples are stored in the library's learning.json in the same format as the Python app's.
import type { Params } from "@/lib/api";
import { percentile, resized, type RGB } from "./pixels";

export const FEATURES = 14;
export const MIN_EXAMPLES = 5; // below this, stick to the defaults
const K = 7;
const MAX_EXAMPLES = 20_000;
const MAX_DISTANCE = 3.0; // in standardised feature space
export const LEARNED_KEYS = ["strength", "brightness", "contrast", "warmth", "tint", "saturation"] as const;
const DEFAULTS: Record<string, number> = { strength: 0.6, brightness: 0, contrast: 0, warmth: 0, tint: 0, saturation: 0 };

/** Describe a blended slide in a way that captures fading, cast and contrast. */
export function features(a: RGB, scans = 1): number[] {
  const s = resized(a, 160, 107);
  const n = s.width * s.height;
  const ch = [0, 1, 2].map((c) => Float32Array.from({ length: n }, (_, i) => s.data[i * 3 + c]).sort());
  const lum = Float32Array.from({ length: n }, (_, i) => (s.data[i * 3] + s.data[i * 3 + 1] + s.data[i * 3 + 2]) / 3).sort();
  const p = ch.map((v) => [1, 50, 99].map((q) => percentile(v, q)));
  const [lo, mid, hi] = [5, 50, 95].map((q) => percentile(lum, q));
  const eps = 1e-3;
  const med = p.map((x) => x[1]);
  return [
    ...[0, 1, 2].flatMap((q) => p.map((c) => c[q])), // 9: per-channel 1/50/99 percentiles, quantile-major like numpy
    mid, // overall brightness
    hi - lo, // contrast
    Math.log((med[0] + eps) / (med[1] + eps)), // red/green cast
    Math.log((med[2] + eps) / (med[1] + eps)), // blue/green cast
    Math.min(scans, 5) / 5, // single scan vs a deep bracket stack
  ];
}

export type Example = { key: string; f: number[]; p: Record<string, number>; trim: boolean; t: number };

/** Examples + standardisation. `save` is called with the JSON to persist after every change. */
export class Model {
  examples: Example[] = [];
  private X: Float32Array[] | null = null;
  private mu: number[] = [];
  private sd: number[] = [];

  constructor(data: unknown, private save: (json: unknown) => void) {
    const ex = (data as { examples?: Example[] } | null)?.examples;
    this.examples = Array.isArray(ex) ? ex : [];
    this.fit();
  }

  private fit() {
    if (this.examples.length < MIN_EXAMPLES) {
      this.X = null;
      return;
    }
    const n = this.examples.length;
    this.mu = new Array(FEATURES).fill(0);
    this.sd = new Array(FEATURES).fill(0);
    for (const e of this.examples) e.f.forEach((v, j) => (this.mu[j] += v / n));
    for (const e of this.examples) e.f.forEach((v, j) => (this.sd[j] += (v - this.mu[j]) ** 2 / n));
    this.sd = this.sd.map((v) => Math.sqrt(v) + 1e-3);
    this.X = this.examples.map((e) => Float32Array.from(e.f, (v, j) => (v - this.mu[j]) / this.sd[j]));
  }

  private persist() {
    this.save({ version: 1, examples: this.examples.slice(-MAX_EXAMPLES) });
    this.fit();
  }

  /** Record (or update) the settings a slide was developed with. */
  remember(key: string, feats: number[], params: Params) {
    if (feats.length !== FEATURES) return;
    const p: Record<string, number> = {};
    for (const k of LEARNED_KEYS) if (k in params) p[k] = Number(params[k]);
    const entry: Example = { key, f: feats.map((x) => Math.round(x * 1e5) / 1e5), p, trim: params.trim !== false, t: Date.now() / 1000 };
    const i = this.examples.findIndex((e) => e.key === key);
    if (i >= 0) this.examples[i] = entry;
    else this.examples.push(entry);
    this.persist();
  }

  forget(key: string) {
    const n = this.examples.length;
    this.examples = this.examples.filter((e) => e.key !== key);
    if (this.examples.length !== n) this.persist();
  }

  reset() {
    this.examples = [];
    this.persist();
  }

  /** Predict settings for a new slide: the settings, and how many neighbours they came from. */
  suggest(feats: number[]): [Partial<Params> | null, number] {
    if (!this.X || feats.length !== FEATURES) return [null, 0];
    const q = feats.map((v, j) => (v - this.mu[j]) / this.sd[j]);
    const d = this.X.map((x) => Math.sqrt(x.reduce((s, v, j) => s + (v - q[j]) ** 2, 0) / FEATURES));
    const idx = d
      .map((v, i) => i)
      .sort((a, b) => d[a] - d[b])
      .slice(0, Math.min(K, d.length))
      .filter((i) => d[i] <= MAX_DISTANCE);
    if (!idx.length) return [null, 0];
    const w0 = idx.map((i) => 1 / (d[i] + 0.25));
    const ws = w0.reduce((s, v) => s + v, 0);
    const w = w0.map((v) => v / ws);
    const out: Record<string, unknown> = {};
    for (const k of LEARNED_KEYS) {
      const v = idx.reduce((s, i, n) => s + (this.examples[i].p[k] ?? DEFAULTS[k]) * w[n], 0);
      out[k] = Math.round(v * 1000) / 1000;
    }
    out.trim = idx.reduce((s, i, n) => s + (this.examples[i].trim !== false ? 1 : 0) * w[n], 0) >= 0.5;
    return [out as Partial<Params>, idx.length];
  }

  stats() {
    return {
      examples: this.examples.length,
      ready: this.X !== null,
      min_examples: MIN_EXAMPLES,
      last: Math.max(0, ...this.examples.map((e) => e.t || 0)),
    };
  }
}
