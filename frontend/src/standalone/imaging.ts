// The colour pipeline, grouping, best of bracket and rotation guesses: slidestation/imaging.py
// function by function (same names, same maths), by way of the Swift port in apple/SlideKit.
// Keep all three in step; frontend/src/standalone/parity.test.ts checks this one against the
// same golden fixtures SlideKit uses.
import type { Params } from "@/lib/api";
import type { Curves, Point } from "@/lib/curves";
import {
  cropped,
  gaussianBlur,
  gray,
  laplacian,
  mean,
  percentile,
  plane,
  resized,
  resizedPlane,
  rgb,
  std,
  type Plane,
  type RGB,
} from "./pixels";

export const PROXY_EDGE = 1600;

// ------------------------------------------------------------------ params

export const DEFAULT_PARAMS: Params = {
  strength: 0.6,
  brightness: 0,
  contrast: 0,
  warmth: 0,
  tint: 0,
  saturation: 0,
  trim: true,
  curves: {},
  angle: 0,
  crop: null,
};

const NUMERIC = ["strength", "brightness", "contrast", "warmth", "tint", "saturation", "angle"] as const;

/** Params.from_dict(d).to_dict(): unknown keys dropped, types coerced, curves and crop validated. */
export function cleanParams(d: Partial<Params> | Record<string, unknown> | null | undefined): Params {
  const p: Params = { ...DEFAULT_PARAMS, curves: {} };
  const src = (d ?? {}) as Record<string, unknown>;
  for (const k of NUMERIC) if (k in src) p[k] = Number(src[k]) || 0;
  if ("trim" in src) p.trim = !!src.trim;
  if ("curves" in src) p.curves = cleanCurves(src.curves);
  if ("crop" in src) p.crop = cleanCrop(src.crop);
  return p;
}

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ------------------------------------------------------------------ tone curves

const CURVE_CHANNELS = ["rgb", "r", "g", "b"] as const;
export const LUT_SIZE = 1024;

/** Sorted points in 0..1, distinct x, straight lines dropped (imaging.clean_curves). */
export function cleanCurves(d: unknown): Curves {
  const out: Curves = {};
  if (!d || typeof d !== "object") return out;
  for (const ch of CURVE_CHANNELS) {
    const pts = (d as Record<string, unknown>)[ch];
    if (!Array.isArray(pts)) continue;
    const valid = pts
      .slice(0, 16)
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => [clamp01(Number(p[0])), clamp01(Number(p[1]))] as Point)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const clean: Point[] = [];
    for (const pt of valid) {
      if (clean.length && pt[0] - clean[clean.length - 1][0] < 0.004) continue;
      clean.push([round(pt[0], 4), round(pt[1], 4)]);
    }
    const straight =
      clean.length === 2 && clean[0][0] === 0 && clean[0][1] === 0 && clean[1][0] === 1 && clean[1][1] === 1;
    if (clean.length >= 2 && !straight) out[ch] = clean;
  }
  return out;
}

/** Monotone cubic (Fritsch-Carlson) through the points, flat beyond the ends, as a LUT. */
export function curveLut(pts: Point[], n = LUT_SIZE): Float32Array {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const out = new Float32Array(n);
  const k = xs.length;
  if (k === 2) {
    for (let j = 0; j < n; j++) {
      const x = j / (n - 1);
      const v = x <= xs[0] ? ys[0] : x >= xs[1] ? ys[1] : ys[0] + ((ys[1] - ys[0]) * (x - xs[0])) / (xs[1] - xs[0]);
      out[j] = clamp01(v);
    }
    return out;
  }
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  const d = ys.slice(1).map((y, i) => (y - ys[i]) / h[i]);
  const m = new Array<number>(k).fill(0);
  m[0] = d[0];
  m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const r = a * a + b * b;
    if (r > 9) {
      const s = 3 / Math.sqrt(r);
      m[i] = s * a * d[i];
      m[i + 1] = s * b * d[i];
    }
  }
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    if (x <= xs[0]) out[j] = clamp01(ys[0]);
    else if (x >= xs[k - 1]) out[j] = clamp01(ys[k - 1]);
    else {
      let i = 0;
      while (i < k - 2 && xs[i + 1] <= x) i++;
      const u = clamp01((x - xs[i]) / h[i]);
      const u2 = u * u;
      const u3 = u2 * u;
      out[j] = clamp01(
        (2 * u3 - 3 * u2 + 1) * ys[i] +
          (u3 - 2 * u2 + u) * h[i] * m[i] +
          (-2 * u3 + 3 * u2) * ys[i + 1] +
          (u3 - u2) * h[i] * m[i + 1],
      );
    }
  }
  return out;
}

/** Per-colour curves first (they fix the cast), then the RGB curve on all three. In place. */
export function applyCurves(a: RGB, curves: Curves): RGB {
  if (!Object.keys(curves).length) return a;
  const top = LUT_SIZE - 1;
  const per = (["r", "g", "b"] as const).map((c) => (curves[c] ? curveLut(curves[c]!) : null));
  const all = curves.rgb ? curveLut(curves.rgb) : null;
  const o = a.data;
  for (let i = 0; i < o.length; i++) {
    let v = o[i];
    const l = per[i % 3];
    if (l) v = l[Math.min(top, Math.max(0, Math.trunc(v * top + 0.5)))];
    if (all) v = all[Math.min(top, Math.max(0, Math.trunc(v * top + 0.5)))];
    o[i] = v;
  }
  return a;
}

/** [l, t, r, b] in 0..1, at least 5 % each way; the whole frame (or junk) means no crop. */
export function cleanCrop(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const c = v.map((x) => clamp01(Number(x)));
  if (c.some((x) => Number.isNaN(x))) return null;
  const [l, t, r, b] = c;
  if (r - l < 0.05 || b - t < 0.05 || (l <= 0.001 && t <= 0.001 && r >= 0.999 && b >= 0.999)) return null;
  return [round(l, 4), round(t, 4), round(r, 4), round(b, 4)];
}

// ------------------------------------------------------------------ restore, trim, geometry

/** Per-channel levels + partial grey-world midtone balance, with a guard against yellow skies. */
export function autoRestore(a: RGB, strength: number, inPlace = false): RGB {
  if (strength <= 0) return a;
  const { width: w, height: h } = a;
  const out = inPlace ? a : rgb(w, h, Float32Array.from(a.data));
  const px = out.data;
  const m = Math.trunc(Math.min(h, w) * 0.04);
  const step = Math.max(1, Math.trunc(Math.sqrt((h * w) / 250_000)));
  const n = Math.ceil((h - 2 * m) / step) * Math.ceil((w - 2 * m) / step);
  const samples = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let k = 0;
  for (let y = m; y < h - m; y += step)
    for (let x = m; x < w - m; x += step, k++) {
      const i = (y * w + x) * 3;
      samples[0][k] = px[i];
      samples[1][k] = px[i + 1];
      samples[2][k] = px[i + 2];
    }
  const sorted = samples.map((s) => s.subarray(0, k).sort());
  const kk = Math.min(1, strength * 2.5); // levels reach full stretch from strength 0.4 upward
  const L = [0, 1, 2].map((c) => percentile(sorted[c], 0.4) * kk);
  const H = [0, 1, 2].map((c) => 1 - (1 - percentile(sorted[c], 99.6)) * kk);
  // the median of the stretched samples is the stretched median (the stretch is monotonic)
  const med = [0, 1, 2].map((c) =>
    Math.min(1, Math.max(1e-4, (percentile(sorted[c], 50) - L[c]) / Math.max(H[c] - L[c], 1e-3))),
  );
  const tgt = Math.exp(med.reduce((s, v) => s + Math.log(v), 0) / 3);
  const g = med.map((v) => (Math.log(v) === 0 ? 1 : 1 + (Math.log(tgt) / Math.log(v) - 1) * strength));
  const hb = percentile(sorted[2], 99.6);
  // the sky guard's mask comes from the untouched blue channel, so build it first
  let mask = plane(w, h);
  for (let i = 0; i < w * h; i++) {
    mask.data[i] = clamp01((px[i * 3 + 2] - (hb - 0.1)) / 0.08);
    for (let c = 0; c < 3; c++) {
      const v = clamp01((px[i * 3 + c] - L[c]) / Math.max(H[c] - L[c], 1e-3));
      px[i * 3 + c] = g[c] === 1 ? v : Math.pow(v, g[c]);
    }
  }
  mask = gaussianBlur(mask, 3);
  for (let i = 0; i < w * h; i++) {
    const mv = mask.data[i] * strength;
    const b = px[i * 3 + 2];
    px[i * 3 + 2] = Math.max(b, b * (1 - mv) + Math.max(px[i * 3], px[i * 3 + 1]) * mv * 0.98);
  }
  return out;
}

/** (top, bottom, left, right) bounds that trim_borders keeps: dark mount edges cut away. */
export function trimBounds(a: RGB, maxFrac = 0.05): [number, number, number, number] {
  const { width: w, height: h } = a;
  const bins = 65536;
  const rows = new Float32Array(h);
  const cols = new Float64Array(w);
  const hist = new Int32Array(bins);
  const p = a.data;
  for (let y = 0; y < h; y++) {
    let rs = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = (p[i] + p[i + 1] + p[i + 2]) / 3;
      rs += v;
      cols[x] += v;
      hist[Math.max(0, Math.min(bins - 1, Math.trunc(v * (bins - 1) + 0.5)))]++;
    }
    rows[y] = rs / w;
  }
  const colMeans = Float32Array.from(cols, (v) => v / h);
  let ref = 0.5;
  for (let i = 0, acc = 0, half = (w * h + 1) >> 1; i < bins; i++) {
    acc += hist[i];
    if (acc >= half) {
      ref = i / (bins - 1);
      break;
    }
  }
  const thr = Math.min(0.12, ref * 0.35);
  const cut = (profile: ArrayLike<number>, limit: number, reverse: boolean) => {
    let n = 0;
    const at = (i: number) => profile[reverse ? profile.length - 1 - i : i];
    while (n < limit && at(n) < thr) n++;
    return n + (n ? 2 : 0);
  };
  const t = cut(rows, Math.trunc(h * maxFrac), false);
  const b = cut(rows, Math.trunc(h * maxFrac), true);
  const l = cut(colMeans, Math.trunc(w * maxFrac), false);
  const r = cut(colMeans, Math.trunc(w * maxFrac), true);
  return [t, h - b, l, w - r];
}

const reflect = (i: number, n: number) => {
  // BORDER_REFLECT: fedcba|abcdef
  while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1;
  return i;
};

/** Rotate by a small angle about the centre, zoomed just enough that no empty corner shows. */
export function straighten(a: RGB, angle: number): RGB {
  if (Math.abs(angle) < 0.01) return a;
  const { width: w, height: h } = a;
  const th = (Math.abs(angle) * Math.PI) / 180;
  const scale = Math.cos(th) + (Math.sin(th) * Math.max(w, h)) / Math.min(w, h);
  const rad = (angle * Math.PI) / 180; // clockwise on screen (y down)
  const cs = Math.cos(rad) / scale;
  const sn = Math.sin(rad) / scale;
  const cx = w / 2;
  const cy = h / 2;
  const out = rgb(w, h);
  const src = a.data;
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      // inverse of a clockwise rotation: rotate the output point back counter-clockwise
      const sx = cx + cs * dx + sn * dy;
      const sy = cy - sn * dx + cs * dy;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const xa = reflect(x0, w);
      const xb = reflect(x0 + 1, w);
      const ya = reflect(y0, h);
      const yb = reflect(y0 + 1, h);
      const d = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const p00 = src[(ya * w + xa) * 3 + c];
        const p01 = src[(ya * w + xb) * 3 + c];
        const p10 = src[(yb * w + xa) * 3 + c];
        const p11 = src[(yb * w + xb) * 3 + c];
        dst[d + c] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy;
      }
    }
  }
  return out;
}

export function geometry(a: RGB, p: Params, crop = true): RGB {
  let out = straighten(a, p.angle ?? 0);
  if (crop && p.crop) {
    const [l, t, r, b] = p.crop;
    const top = Math.trunc(t * out.height);
    const left = Math.trunc(l * out.width);
    out = cropped(
      out,
      top,
      Math.max(top + 1, Math.trunc(b * out.height)),
      left,
      Math.max(left + 1, Math.trunc(r * out.width)),
    );
  }
  return out;
}

/** The image the tone curve works on: auto-restored, trimmed, straightened and cropped. */
export function toneBase(a: RGB, p: Params, crop = true, inPlace = false): RGB {
  let out = autoRestore(a, p.strength, inPlace);
  if (p.trim) out = cropped(out, ...trimBounds(out));
  return geometry(out, p, crop);
}

/**
 * crop = false: everything but the crop, for the crop tool to draw its frame over. inPlace: the
 * caller's pixels may be overwritten (full-resolution export, where a second copy costs 250 MB).
 */
export function develop(a: RGB, p: Params, crop = true, inPlace = false): RGB {
  let out = toneBase(a, p, crop, inPlace);
  if (out === a && !inPlace) out = rgb(a.width, a.height, Float32Array.from(a.data)); // never write into the caller's pixels
  applyCurves(out, p.curves ?? {});
  finish(out, p);
  return out;
}

/** Everything after the tone curves: white balance, brightness, contrast, saturation. In place. */
function finish(out: RGB, p: Params) {
  const eps = 1e-5;
  const gam = [1 - 0.25 * p.warmth, 1 + 0.25 * p.tint, 1 + 0.25 * p.warmth];
  const wb = p.warmth !== 0 || p.tint !== 0;
  const bright = Math.pow(2, -p.brightness);
  const con = p.contrast;
  const sat = 1.1 + p.saturation;
  const o = out.data;
  const c01 = (v: number) => Math.min(1, Math.max(eps, v));
  for (let i = 0; i < o.length; i += 3) {
    let r = o[i];
    let g = o[i + 1];
    let b = o[i + 2];
    if (wb) {
      r = Math.pow(c01(r), gam[0]);
      g = Math.pow(c01(g), gam[1]);
      b = Math.pow(c01(b), gam[2]);
    }
    if (p.brightness !== 0) {
      r = Math.pow(c01(r), bright);
      g = Math.pow(c01(g), bright);
      b = Math.pow(c01(b), bright);
    }
    if (con > 0) {
      r += (r * r * (3 - 2 * r) - r) * con * 1.5;
      g += (g * g * (3 - 2 * g) - g) * con * 1.5;
      b += (b * b * (3 - 2 * b) - b) * con * 1.5;
    } else if (con < 0) {
      r += (0.5 - r) * -con * 0.5;
      g += (0.5 - g) * -con * 0.5;
      b += (0.5 - b) * -con * 0.5;
    }
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    o[i] = clamp01(lum + (r - lum) * sat);
    o[i + 1] = clamp01(lum + (g - lum) * sat);
    o[i + 2] = clamp01(lum + (b - lum) * sat);
  }
}

/** The untouched scan in the developed photo's exact frame, so before and after line up. */
export function beforeView(a: RGB, p: Params, crop = true): RGB {
  let out = a;
  if (p.trim) out = cropped(a, ...trimBounds(autoRestore(a, p.strength)));
  return geometry(out, p, crop);
}

// ------------------------------------------------------------------ analysis

function inner(a: RGB, frac = 0.03): RGB {
  const m = Math.trunc(Math.min(a.width, a.height) * frac);
  return m === 0 ? a : cropped(a, m, a.height - m, m, a.width - m);
}

export const HIST_BINS = 128;

/** Per-channel histograms of the curve's input (away from the edges), for drawing behind it. */
export function histogram(a: RGB): Record<"r" | "g" | "b" | "lum", number[]> {
  const s0 = inner(a);
  const s = resized(s0, 360, Math.max(1, Math.trunc((360 * a.height) / a.width)));
  const bins = [0, 1, 2, 3].map(() => new Array<number>(HIST_BINS).fill(0));
  const bin = (v: number) => Math.max(0, Math.min(HIST_BINS - 1, Math.trunc(v * HIST_BINS)));
  const d = s.data;
  for (let i = 0; i < d.length; i += 3) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    bins[0][bin(r)]++;
    bins[1][bin(g)]++;
    bins[2][bin(b)]++;
    bins[3][bin(r * 0.299 + g * 0.587 + b * 0.114)]++;
  }
  return { r: bins[0], g: bins[1], b: bins[2], lum: bins[3] };
}

/** Pull each colour channel's end points in to where its data actually starts and ends. */
export function fitCurves(a: RGB, curves: Curves, clip = 0.1): Curves {
  const s = inner(a);
  const step = Math.max(1, Math.trunc(Math.sqrt((s.width * s.height) / 250_000)));
  const ch: number[][] = [[], [], []];
  for (let y = 0; y < s.height; y += step)
    for (let x = 0; x < s.width; x += step) {
      const i = (y * s.width + x) * 3;
      ch[0].push(s.data[i]);
      ch[1].push(s.data[i + 1]);
      ch[2].push(s.data[i + 2]);
    }
  const out: Curves = { ...curves };
  (["r", "g", "b"] as const).forEach((c, k) => {
    const sorted = Float32Array.from(ch[k]).sort();
    const l = percentile(sorted, clip);
    const h = percentile(sorted, 100 - clip);
    if (h - l < 0.05) return; // a nearly flat channel: stretching would only amplify noise
    const old = curves[c] ?? [
      [0, 0],
      [1, 1],
    ];
    const mid = old.slice(1, -1).filter((pt) => l < pt[0] && pt[0] < h);
    out[c] = [[l, old[0][1]], ...mid, [h, old[old.length - 1][1]]]; // output levels (a lifted black) stay
  });
  return cleanCurves(out);
}

/** Warmth and tint that make the spot at (x, y) (0..1 of the developed frame) neutral grey. */
export function neutralBalance(a: RGB, p: Params, x: number, y: number): [number, number] {
  const base = applyCurves(toneBaseCopy(a, p), p.curves ?? {});
  const { width: w, height: h } = base;
  const r = Math.max(2, Math.trunc(Math.min(h, w) * 0.006));
  const cx = Math.trunc(clamp01(x) * (w - 1));
  const cy = Math.trunc(clamp01(y) * (h - 1));
  const sum = [0, 0, 0];
  let n = 0;
  for (let yy = Math.max(0, cy - r); yy < Math.min(h, cy + r + 1); yy++)
    for (let xx = Math.max(0, cx - r); xx < Math.min(w, cx + r + 1); xx++, n++)
      for (let c = 0; c < 3; c++) sum[c] += base.data[(yy * w + xx) * 3 + c];
  const [lr, lg, lb] = sum.map((v) => Math.log(Math.min(0.98, Math.max(0.02, v / n))));
  const warmth = Math.min(1, Math.max(-1, (4 * (lr - lb)) / (lr + lb)));
  const level = lr * (1 - 0.25 * warmth); // log of where red and blue meet
  const tint = Math.min(1, Math.max(-1, 4 * (level / lg - 1)));
  return [round(warmth, 3), round(tint, 3)];
}

/** tone_base, but never the caller's own pixels (curves are applied in place after it). */
function toneBaseCopy(a: RGB, p: Params): RGB {
  const out = toneBase(a, p);
  return out === a ? rgb(a.width, a.height, Float32Array.from(a.data)) : out;
}

// ------------------------------------------------------------------ grouping

/** Brightness-independent structural signature (96 × 64, zero mean, unit variance). */
export function signature(a: RGB): Float32Array {
  const g = gray(a);
  for (let i = 0; i < g.data.length; i++) g.data[i] = Math.trunc(g.data[i] * 255); // uint8, as OpenCV sees it
  const s = resizedPlane(g, 96, 64);
  const m = mean(s.data);
  const sd = std(s.data);
  return Float32Array.from(s.data, (v) => (v - m) / (sd + 1e-6));
}

export function similarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += a[i] * b[i];
  return acc / a.length;
}

export const SAME_SLIDE = 0.86;

/** Chain consecutive scans that look like the same slide; also whether the first continues `prev`. */
export function groupSequence(sigs: ArrayLike<number>[], prev?: ArrayLike<number>[] | null): [number[][], boolean] {
  const groups: number[][] = [];
  let continues = false;
  sigs.forEach((s, i) => {
    const members = groups.length ? groups[groups.length - 1].map((j) => sigs[j]) : (prev ?? []);
    if (members.length && Math.max(...members.map((m) => similarity(s, m))) > SAME_SLIDE) {
      if (groups.length) groups[groups.length - 1].push(i);
      else {
        continues = true;
        groups.push([i]);
      }
    } else groups.push([i]);
  });
  return [groups, continues];
}

// ------------------------------------------------------------------ best of a bracket

export type Quality = { sharp: number; clipped: number };

/** Sharpness (independent of exposure) and how much of the frame is clipped, for one scan. */
export function scanQuality(a: RGB): Quality {
  let g = gray(a);
  for (let i = 0; i < g.data.length; i++) g.data[i] = Math.trunc(clamp01(g.data[i]) * 255);
  g = resizedPlane(g, 800, Math.trunc((800 * g.height) / g.width));
  for (let i = 0; i < g.data.length; i++) g.data[i] = Math.round(g.data[i]);
  const { width: w, height: h } = g;
  const t = Math.trunc(h / 10);
  const l = Math.trunc(w / 10);
  const core = plane(w - 2 * l, h - 2 * t);
  for (let y = 0; y < core.height; y++)
    core.data.set(g.data.subarray((y + t) * w + l, (y + t) * w + l + core.width), y * core.width);
  const lit: number[] = [];
  const mask = new Uint8Array(core.data.length);
  core.data.forEach((v, i) => {
    if (v > 12 && v < 243) {
      mask[i] = 1;
      lit.push(v);
    }
  });
  const clipped = 1 - lit.length / core.data.length;
  if (lit.length < core.data.length * 0.05) return { sharp: 0, clipped: round(clipped, 3) };
  const lap = laplacian(gaussianBlur(core, 0.8));
  let acc = 0;
  mask.forEach((m, i) => {
    if (m) acc += Math.abs(lap.data[i]);
  });
  const sd = std(Float32Array.from(lit));
  // edge energy relative to local contrast, so a darker exposure of a sharp slide still scores high
  return { sharp: round(acc / lit.length / (sd + 1e-3), 4), clipped: round(clipped, 3) };
}

const BLURRY = 0.6; // below this share of the stack's sharpest scan, a scan is left out
const CLIPPED = 0.85;

/** Which scans of a bracket to leave out, and why ("blurry" / "clipped"). Always keeps one. */
export function weakScans(q: Quality[]): Record<number, string> {
  if (q.length < 2) return {};
  const best = Math.max(...q.map((x) => x.sharp)) || 1;
  const out: Record<number, string> = {};
  q.forEach((x, i) => {
    if (x.clipped > CLIPPED) out[i] = "clipped";
    else if (x.sharp < BLURRY * best) out[i] = "blurry";
  });
  if (Object.keys(out).length === q.length) {
    let keep = 0;
    q.forEach((x, i) => {
      if (x.sharp > q[keep].sharp) keep = i;
    });
    delete out[keep];
  }
  return out;
}

// ------------------------------------------------------------------ rotation

/** Bright, smooth, blue-ish edge = sky. Score per rotation (which edge would become the top). */
export function skyVotes(a: RGB): Record<number, number> {
  const s = resized(a, 480, 320);
  const { width: w, height: h } = s;
  const lum = plane(w, h);
  const blue = plane(w, h);
  for (let i = 0; i < w * h; i++) {
    lum.data[i] = (s.data[i * 3] + s.data[i * 3 + 1] + s.data[i * 3 + 2]) / 3;
    blue.data[i] = s.data[i * 3 + 2] - s.data[i * 3];
  }
  const tex = laplacian(gaussianBlur(lum, 1));
  const sh = Math.trunc(h / 5);
  const sw = Math.trunc(w / 5);
  const score = (x0: number, x1: number, y0: number, y1: number) => {
    let l = 0;
    let b = 0;
    let t = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        l += lum.data[i];
        b += blue.data[i];
        t += Math.abs(tex.data[i]);
      }
    const n = (x1 - x0) * (y1 - y0);
    return l / n + (0.5 * b) / n - (8 * t) / n;
  };
  return { 0: score(0, w, 0, sh), 90: score(0, sw, 0, h), 270: score(w - sw, w, 0, h), 180: score(0, w, h - sh, h) };
}

/**
 * Clockwise rotation that makes a slide upright, and why ("faces", "sky", or "" = no confident
 * guess). Faces are optional: the browser has no YuNet, so `faceVotes` is whatever detector the
 * caller has (none yet); the sky rule is the Python one.
 */
export function suggestRotation(images: RGB[], faceVotes?: (a: RGB) => Record<number, number>): [number, string] {
  const n = images.length;
  if (!n) return [0, ""];
  if (faceVotes) {
    const fv: Record<number, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };
    for (const im of images) for (const [r, v] of Object.entries(faceVotes(im))) fv[+r] += v;
    const ranked = Object.entries(fv).sort((a, b) => b[1] - a[1]);
    const [best, bestV] = [+ranked[0][0], ranked[0][1]];
    if (bestV / n >= 0.7 && bestV >= ranked[1][1] * 2 + 0.3 * n) return [best, "faces"];
  }
  const sv: Record<number, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };
  for (const im of images) for (const [r, v] of Object.entries(skyVotes(im))) sv[+r] += v / n;
  const ranked = Object.entries(sv).sort((a, b) => b[1] - a[1]);
  const top = +ranked[0][0];
  if ((top === 90 || top === 270) && ranked[0][1] - ranked[1][1] >= 0.2) return [top, "sky"];
  return [0, ""];
}
