// The colour pipeline, grouping, best of bracket and rotation guesses: slidestation/imaging.py
// function by function (same names, same maths), by way of the Swift port in apple/SlideKit.
// Keep all three in step; frontend/src/standalone/parity.test.ts checks this one against the
// same golden fixtures SlideKit uses.
import type { BrushStroke, Local, Params, Pt } from "@/lib/api";
import type { Curves, Point } from "@/lib/curves";
import { LOCAL_MAX, LOCAL_SLIDERS, MASK_EDGE, localMask } from "@/lib/local";
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
  dust: 0,
  mould: 0,
  newton: 0,
  local: [],
};

const NUMERIC = ["strength", "brightness", "contrast", "warmth", "tint", "saturation", "angle"] as const;

/** Params.from_dict(d).to_dict(): unknown keys dropped, types coerced, curves and crop validated. */
export function cleanParams(d: Partial<Params> | Record<string, unknown> | null | undefined): Params {
  const p: Params = { ...DEFAULT_PARAMS, curves: {}, local: [] };
  const src = (d ?? {}) as Record<string, unknown>;
  for (const k of NUMERIC) if (k in src) p[k] = Number(src[k]) || 0;
  if ("trim" in src) p.trim = !!src.trim;
  if ("curves" in src) p.curves = cleanCurves(src.curves);
  if ("crop" in src) p.crop = cleanCrop(src.crop);
  for (const k of ["dust", "mould", "newton"] as const) if (k in src) p[k] = clamp01(Number(src[k]) || 0);
  if ("local" in src) p.local = cleanLocal(src.local);
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

const RESTORE_MED_MAX = 0.999; // a channel median at white counts as this
const RESTORE_GAMMA = [0.25, 4]; // the midtone gamma stays within these

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
  // a flat channel (an empty, white frame) has no range to stretch: leave its levels alone
  for (let c = 0; c < 3; c++) if (H[c] - L[c] < 1e-3) [L[c], H[c]] = [0, 1];
  // the median of the stretched samples is the stretched median (the stretch is monotonic)
  // a blown-out channel's median (1) is kept just below 1 and the gamma bounded, as in imaging.py
  const med = [0, 1, 2].map((c) =>
    Math.min(RESTORE_MED_MAX, Math.max(1e-4, (percentile(sorted[c], 50) - L[c]) / Math.max(H[c] - L[c], 1e-3))),
  );
  const tgt = Math.exp(med.reduce((s, v) => s + Math.log(v), 0) / 3);
  const g = med.map((v) =>
    Math.min(RESTORE_GAMMA[1], Math.max(RESTORE_GAMMA[0], 1 + (Math.log(tgt) / Math.log(v) - 1) * strength)),
  );
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

/** Rows top..bottom and columns left..right of a straightened h x w frame that `crop` keeps. */
type Box = [number, number, number, number];
export function cropBox(h: number, w: number, crop: Box): Box {
  const [l, t, r, b] = crop;
  const top = Math.trunc(t * h);
  const left = Math.trunc(l * w);
  return [top, Math.max(top + 1, Math.trunc(b * h)), left, Math.max(left + 1, Math.trunc(r * w))];
}

export function geometry(a: RGB, p: Params, crop = true): RGB {
  const out = straighten(a, p.angle ?? 0);
  return crop && p.crop ? cropped(out, ...cropBox(out.height, out.width, p.crop)) : out;
}

/** The image the tone curve works on: auto-restored, trimmed, repaired, straightened and cropped. */
export function toneBase(a: RGB, p: Params, crop = true, inPlace = false): RGB {
  let out = autoRestore(a, p.strength, inPlace);
  if (p.trim) out = cropped(out, ...trimBounds(out));
  if ((p.dust ?? 0) > 0) out = repairDust(out, p.dust, inPlace || out !== a);
  if ((p.mould ?? 0) > 0) out = repairMould(out, p.mould, inPlace || out !== a); // after the dust
  if ((p.newton ?? 0) > 0) out = repairNewton(out, p.newton, inPlace || out !== a);
  return geometry(out, p, crop);
}

// ------------------------------------------------------------------ mount detection

export const MOUNT_EDGE = 800; // the mount is found on the scan shrunk to this (longer edge)
const MOUNT_BAND = 0.2; // its inner edge is looked for this far in from each side of the scan
export const MOUNT_SUGGEST = 0.5; // confidence from which "Straighten to mount" is offered
export const MOUNT_AUTO = 0.8; // ... and from which an import straightens a new slide by itself
const MOUNT_INSET = 0.005; // a tighter trim cuts this much (of the frame) inside the mount's edge

/** The slide mount's tilt (degrees clockwise), confidence 0..1 and sides [l, t, r, b] in 0..1. */
export type Mount = { angle: number; confidence: number; box: (number | null)[] };

/** Area-average down so the longer edge is at most `edge` (imaging.shrink). */
export function shrink(a: RGB, edge: number): RGB {
  const { width: w, height: h } = a;
  if (Math.max(w, h) <= edge) return a;
  const s = edge / Math.max(w, h);
  return resized(a, Math.max(1, Math.trunc(w * s + 0.5)), Math.max(1, Math.trunc(h * s + 0.5)));
}

/** Where a profile (sample k in from the border) first rises through thr for good, sub-pixel; NaN if never. */
function edgeCrossing(at: (k: number) => number, band: number, thr: number): number {
  if (at(0) >= thr) return NaN; // doesn't start on the mount
  for (let i = 1; i + 2 < band; i++)
    if (at(i) >= thr && at(i + 1) >= thr && at(i + 2) >= thr) {
      const lo = at(i - 1);
      const hi = at(i);
      return i - 1 + (thr - lo) / Math.max(hi - lo, 1e-6) + 0.5;
    }
  return NaN;
}

/** v = a + b u through the points, refitted four times without the ones far off it: (a, b, kept). */
function robustLine(u0: number[], v0: number[]): [number, number, number] | null {
  const u: number[] = [];
  const v: number[] = [];
  v0.forEach((x, i) => {
    if (Number.isFinite(x)) (u.push(u0[i]), v.push(x));
  });
  let inl = u.map(() => true);
  let a0 = 0;
  let b = 0;
  for (let it = 0; it < 4; it++) {
    let n = 0;
    let su = 0;
    let sv = 0;
    u.forEach((x, i) => {
      if (inl[i]) (n++, (su += x), (sv += v[i]));
    });
    if (n < 10) return null;
    const um = su / n;
    const vm = sv / n;
    let num = 0;
    let den = 0;
    u.forEach((x, i) => {
      if (inl[i]) ((num += (x - um) * (v[i] - vm)), (den += (x - um) ** 2));
    });
    b = num / Math.max(den, 1e-9);
    a0 = vm - b * um;
    const r = u.map((x, i) => Math.abs(v[i] - (a0 + b * x)));
    const med = percentile(Float64Array.from(r.filter((_, i) => inl[i])).sort(), 50);
    const tol = Math.max(0.5, 3 * 1.4826 * med);
    inl = r.map((x) => x <= tol);
  }
  return [a0, b, inl.filter(Boolean).length];
}

/**
 * The slide mount's inner edge: how far the picture is turned and where the window's sides are
 * (imaging.detect_mount). Straighten by -angle; confidence needs two sides that agree.
 */
export function detectMount(a: RGB): Mount {
  const s = shrink(a, MOUNT_EDGE);
  const { width: w, height: h } = s;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (s.data[i * 3] + s.data[i * 3 + 1] + s.data[i * 3 + 2]) / 3;
  const none: Mount = { angle: 0, confidence: 0, box: [null, null, null, null] };
  const m = Math.max(1, Math.trunc(Math.min(h, w) * 0.01));
  const ring: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (y < m || y >= h - m || x < m || x >= w - m) ring.push(lum[y * w + x]);
  const mount = percentile(Float32Array.from(ring).sort(), 50);
  const centre: number[] = [];
  const qh = Math.trunc(h / 4);
  const qw = Math.trunc(w / 4);
  for (let y = qh; y < h - qh; y++) for (let x = qw; x < w - qw; x++) centre.push(lum[y * w + x]);
  const ref = percentile(Float32Array.from(centre).sort(), 50);
  if (mount > 0.25 || ref - mount < 0.08) return none; // no dark frame around a brighter picture
  const thr = mount + Math.min(0.1, Math.max(0.03, 0.3 * (ref - mount)));
  const bh = Math.max(4, Math.trunc(h * MOUNT_BAND));
  const bw = Math.max(4, Math.trunc(w * MOUNT_BAND));
  const x0 = Math.trunc(w * 0.1);
  const y0 = Math.trunc(h * 0.1);
  const ux: number[] = [];
  const uy: number[] = [];
  for (let x = x0; x < w - x0; x++) ux.push(x + 0.5);
  for (let y = y0; y < h - y0; y++) uy.push(y + 0.5);
  const L = (x: number, y: number) => lum[y * w + x];
  const sides: Record<string, [number[], number[]]> = {
    top: [ux, ux.map((_, j) => edgeCrossing((k) => L(x0 + j, k), bh, thr))],
    bottom: [ux, ux.map((_, j) => h - edgeCrossing((k) => L(x0 + j, h - 1 - k), bh, thr))],
    left: [uy, uy.map((_, j) => edgeCrossing((k) => L(k, y0 + j), bw, thr))],
    right: [uy, uy.map((_, j) => w - edgeCrossing((k) => L(w - 1 - k, y0 + j), bw, thr))],
  };
  const found: Record<string, [number, number, number]> = {};
  let total = 0;
  for (const [name, [u, v]] of Object.entries(sides)) {
    total += u.length;
    const fit = robustLine(u, v);
    if (fit && fit[2] >= Math.max(20, 0.35 * u.length)) found[name] = fit;
  }
  const names = Object.keys(found);
  if (names.length < 2) return none;
  const ang = (k: string) => ((Math.atan(found[k][1]) * 180) / Math.PI) * (k === "top" || k === "bottom" ? 1 : -1);
  const kept = names.reduce((acc, k) => acc + found[k][2], 0);
  const angle = names.reduce((acc, k) => acc + ang(k) * found[k][2], 0) / kept;
  const spread = Math.max(...names.map((k) => Math.abs(ang(k) - angle)));
  let conf = Math.max(0, 1 - spread / 0.5) * Math.min(1, kept / total / 0.6) * (names.length >= 3 ? 1 : 0.8);
  if (Math.abs(angle) > 10) conf = 0;
  const mid = (k: string, c: number, size: number) =>
    found[k] ? round((found[k][0] + found[k][1] * c) / size, 4) : null;
  return {
    angle: round(angle, 2),
    confidence: round(conf, 2),
    box: [mid("left", h / 2, w), mid("top", w / 2, h), mid("right", h / 2, w), mid("bottom", w / 2, h)],
  };
}

/** A mount box [l, t, r, b] of a scan turned clockwise by `rot` (imaging.rotate_box). */
export function rotateBox(box: (number | null)[], rot: number): (number | null)[] {
  let [l, t, r, b] = box;
  const turns = Math.trunc((((rot % 360) + 360) % 360) / 90);
  for (let i = 0; i < turns; i++)
    [l, t, r, b] = [b === null ? null : round(1 - b, 4), l, t === null ? null : round(1 - t, 4), r];
  return [l, t, r, b];
}

/** A mount box [l, t, r, b] of a scan mirrored left-right (imaging.mirror_box). */
export function mirrorBox(box: (number | null)[]): (number | null)[] {
  const [l, t, r, b] = box;
  return [r === null ? null : round(1 - r, 4), t, l === null ? null : round(1 - l, 4), b];
}

/** The crop that trims to the mount's window once straightened by p.angle (imaging.mount_crop). */
export function mountCrop(a: RGB, p: Params, box: (number | null)[]): [number, number, number, number] | null {
  const { width: w, height: h } = a;
  const [t0, b0, l0, r0] = p.trim ? trimBounds(autoRestore(a, p.strength)) : [0, h, 0, w];
  const fw = r0 - l0;
  const fh = b0 - t0;
  const th = Math.abs(p.angle) >= 0.01 ? (p.angle * Math.PI) / 180 : 0; // straighten() leaves tiny angles alone
  const scale = Math.cos(Math.abs(th)) + (Math.sin(Math.abs(th)) * Math.max(fw, fh)) / Math.min(fw, fh);
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const place = (x: number, y: number) => {
    const dx = x - 0.5 - l0 - fw / 2; // pixel-index coordinates, as the straighten
    const dy = y - 0.5 - t0 - fh / 2;
    return [(fw / 2 + scale * (cs * dx - sn * dy) + 0.5) / fw, (fh / 2 + scale * (sn * dx + cs * dy) + 0.5) / fh];
  };
  const [l, t, r, b] = box;
  const out = [0, 0, 1, 1];
  if (l !== null) out[0] = place(l * w, h / 2)[0] + MOUNT_INSET;
  if (t !== null) out[1] = place(w / 2, t * h)[1] + MOUNT_INSET;
  if (r !== null) out[2] = place(r * w, h / 2)[0] - MOUNT_INSET;
  if (b !== null) out[3] = place(w / 2, b * h)[1] - MOUNT_INSET;
  return cleanCrop(out);
}

// ------------------------------------------------------------------ dust & scratches

export const DUST_EDGE = 1600; // specks are found at proxy scale: full resolution is shrunk to this first
const DUST_PASSES = 8;

/**
 * Min (erode) or max (dilate) over the (2r + 1)² window, clipped to the image: cv2.erode / dilate.
 * Along rows, then down columns a whole row at a time (memory in order). Min and max don't round,
 * so this is exactly OpenCV's result.
 */
function morph(src: Float32Array, w: number, h: number, r: number, max: boolean): Float32Array {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const b = Math.min(w - 1, x + r);
      let v = src[row + Math.max(0, x - r)];
      if (max) for (let k = row + Math.max(0, x - r) + 1; k <= row + b; k++) v = src[k] > v ? src[k] : v;
      else for (let k = row + Math.max(0, x - r) + 1; k <= row + b; k++) v = src[k] < v ? src[k] : v;
      tmp[row + x] = v;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const d = y * w;
    const a = Math.max(0, y - r);
    out.set(tmp.subarray(a * w, a * w + w), d);
    for (let k = a + 1; k <= Math.min(h - 1, y + r); k++) {
      const s = k * w;
      if (max) for (let x = 0; x < w; x++) out[d + x] = tmp[s + x] > out[d + x] ? tmp[s + x] : out[d + x];
      else for (let x = 0; x < w; x++) out[d + x] = tmp[s + x] < out[d + x] ? tmp[s + x] : out[d + x];
    }
  }
  return out;
}

const DUST_MARK = 0.05; // top-hat from which a pixel belongs to a mark (its whole extent, rim included)
const DUST_GRAIN = 0.03; // ... and from which it counts towards texture

/**
 * Dust specks and thin scratches (imaging.dust_mask): marks a morphological opening / closing takes
 * away, 8-connected, found the same whatever `amount` is. Dust when small (at most r (2 + 6 amount)
 * across) or a scratch (longer, at most r min(1, 2 amount) wide on average), faint no more than `amount` allows,
 * and not touching texture; grown by a pixel. The arithmetic is float32 like numpy's, so the mask
 * is the same pixel for pixel.
 */
export function dustMask(a: RGB, amount: number): { mask: Uint8Array; r: number } {
  const { width: w, height: h } = a;
  const f = Math.fround;
  const [c0, c1, c2] = [f(0.299), f(0.587), f(0.114)];
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    lum[i] = f(f(f(a.data[i * 3] * c0) + f(a.data[i * 3 + 1] * c1)) + f(a.data[i * 3 + 2] * c2));
  const r = Math.max(1, Math.trunc((3 * Math.max(w, h)) / DUST_EDGE + 0.5));
  const opened = morph(morph(lum, w, h, r, false), w, h, r, true);
  const closed = morph(morph(lum, w, h, r, true), w, h, r, false);
  const hat = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) hat[i] = Math.max(f(lum[i] - opened[i]), f(closed[i] - lum[i]));
  const [markThr, grainThr, strongThr] = [f(DUST_MARK), f(DUST_GRAIN), f(0.3 - 0.24 * amount)];
  // texture: more than a fifth of the (8r + 1)² neighbourhood responds at all
  const ii = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += hat[y * w + x] > grainThr ? 1 : 0;
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
    }
  }
  const rad = 4 * r;
  const textured = (i: number) => {
    const y = Math.trunc(i / w);
    const x = i - y * w;
    const [ya, yb, xa, xb] = [Math.max(0, y - rad), Math.min(h, y + rad + 1), Math.max(0, x - rad), Math.min(w, x + rad + 1)];
    const cnt = ii[yb * (w + 1) + xb] - ii[ya * (w + 1) + xb] - ii[yb * (w + 1) + xa] + ii[ya * (w + 1) + xa];
    return cnt * 5 > (yb - ya) * (xb - xa);
  };
  // the marks: 8-connected shapes, found by flood fill; their size, extent, strength, texture
  const label = new Int32Array(w * h);
  const shapes: { area: number; x0: number; x1: number; y0: number; y1: number; strong: boolean; textured: boolean }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (label[i] || !(hat[i] > markThr)) continue;
    const s = { area: 0, x0: w, x1: 0, y0: h, y1: 0, strong: false, textured: false };
    shapes.push(s);
    label[i] = shapes.length;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const [y, x] = [Math.trunc(j / w), j % w];
      s.area++;
      [s.x0, s.x1, s.y0, s.y1] = [Math.min(s.x0, x), Math.max(s.x1, x), Math.min(s.y0, y), Math.max(s.y1, y)];
      if (hat[j] > strongThr) s.strong = true;
      if (!s.textured && textured(j)) s.textured = true;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const k = yy * w + xx;
          if (!label[k] && hat[k] > markThr) {
            label[k] = shapes.length;
            stack.push(k);
          }
        }
    }
  }
  const keep = shapes.map(({ area, x0, x1, y0, y1, strong, textured }) => {
    const ext = Math.max(x1 - x0 + 1, y1 - y0 + 1);
    return strong && !textured && (ext <= r * (2 + 6 * amount) || area <= r * ext * Math.min(1, 2 * amount));
  });
  const kept = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (label[i] && keep[label[i] - 1]) kept[i] = 1;
  // grown by a pixel: a 3×3 max, along rows then down columns
  const across = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      across[i] = kept[i] | (x > 0 ? kept[i - 1] : 0) | (x < w - 1 ? kept[i + 1] : 0);
    }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      mask[i] = across[i] | (y > 0 ? across[i - w] : 0) | (y < h - 1 ? across[i + w] : 0);
    }
  return { mask, r };
}

/** Median of the first n values (numpy's: the two middle ones averaged, in float32). */
function medianOf(v: Float32Array, n: number): number {
  const s = v.subarray(0, n).sort();
  return n % 2 ? s[n >> 1] : Math.fround((s[n / 2 - 1] + s[n / 2]) / 2);
}

/**
 * Find dust and scratches (at proxy scale) and fill each marked pixel with the per-channel median
 * of the unmarked ones around it, pass by pass (imaging.repair_dust). inPlace: the caller's pixels
 * may be overwritten.
 */
export function repairDust(a: RGB, amount: number, inPlace = false): RGB {
  if (amount <= 0) return a;
  const { width: w, height: h } = a;
  const small = shrink(a, DUST_EDGE);
  const { mask: m0, r } = dustMask(small, amount);
  if (!m0.includes(1)) return a;
  const out = inPlace ? a : rgb(w, h, Float32Array.from(a.data));
  const [mw, mh] = [small.width, small.height];
  let known: Uint8Array;
  if (mw === w && mh === h) known = Uint8Array.from(m0, (v) => 1 - v);
  else {
    // full resolution: every pixel takes its proxy pixel's verdict
    const xs = Int32Array.from({ length: w }, (_, x) => Math.min(Math.trunc(((x + 0.5) * mw) / w), mw - 1));
    known = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const my = Math.min(Math.trunc(((y + 0.5) * mh) / h), mh - 1) * mw;
      for (let x = 0; x < w; x++) known[y * w + x] = 1 - m0[my + xs[x]];
    }
  }
  // the window: (2r + 3)² samples, spread out as far as the proxy's pixels are
  const f = Math.max(h, w) / Math.max(mh, mw);
  const off: number[] = [];
  for (let k = -r - 1; k <= r + 1; k++) off.push((k >= 0 ? 1 : -1) * Math.trunc(Math.abs(k) * f + 0.5));
  const todo: number[] = [];
  for (let i = 0; i < w * h; i++) if (!known[i]) todo.push(i);
  medianFill(out, known, todo, off, DUST_PASSES);
  return out;
}

/**
 * Fill pixels `todo` of `out` in place with the per-channel median of the known pixels among the
 * samples at off × off around each (imaging._median_fill); pixels with none wait for the next
 * pass, which can use the ones filled before it. Returns the pixels still unfilled.
 */
function medianFill(out: RGB, known: Uint8Array, todo: number[], off: number[], passes: number): number[] {
  const { width: w, height: h } = out;
  const o = out.data;
  const buf = [0, 1, 2].map(() => new Float32Array(off.length * off.length));
  for (let pass = 0; pass < passes && todo.length; pass++) {
    const vals = new Float32Array(todo.length * 3);
    const done = new Uint8Array(todo.length);
    todo.forEach((i, j) => {
      const y = Math.trunc(i / w);
      const x = i - y * w;
      let n = 0;
      for (const dy of off) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (const dx of off) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || !known[yy * w + xx]) continue;
          const s = (yy * w + xx) * 3;
          buf[0][n] = o[s];
          buf[1][n] = o[s + 1];
          buf[2][n] = o[s + 2];
          n++;
        }
      }
      if (!n) return; // the middle of a larger mark: next pass
      for (let c = 0; c < 3; c++) vals[j * 3 + c] = medianOf(buf[c], n);
      done[j] = 1;
    });
    // a pass reads only pixels known before it
    todo.forEach((i, j) => {
      if (!done[j]) return;
      o.set(vals.subarray(j * 3, j * 3 + 3), i * 3);
      known[i] = 1;
    });
    todo = todo.filter((_, j) => !done[j]);
  }
  return todo;
}

/** A proxy-scale mask at w × h: every pixel takes its proxy pixel's verdict (imaging._verdicts). */
function verdicts(m: Uint8Array, mw: number, mh: number, w: number, h: number): Uint8Array {
  if (mw === w && mh === h) return m;
  const xs = Int32Array.from({ length: w }, (_, x) => Math.min(Math.trunc(((x + 0.5) * mw) / w), mw - 1));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const my = Math.min(Math.trunc(((y + 0.5) * mh) / h), mh - 1) * mw;
    for (let x = 0; x < w; x++) out[y * w + x] = m[my + xs[x]];
  }
  return out;
}

/**
 * For each of n pixels, the two of sn grid centres around it and the weight of the second, the
 * grid spanning the same length, clamped at the ends (imaging._bilinear_axis).
 */
function bilinearAxis(n: number, sn: number): { i0: Int32Array; i1: Int32Array; f: Float64Array } {
  const i0 = new Int32Array(n);
  const i1 = new Int32Array(n);
  const f = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const u = ((k + 0.5) * sn) / n - 0.5;
    i0[k] = Math.min(sn - 1, Math.max(0, Math.floor(u)));
    i1[k] = Math.min(i0[k] + 1, sn - 1);
    f[k] = Math.min(1, Math.max(0, u - i0[k]));
  }
  return { i0, i1, f };
}

// ------------------------------------------------------------------ mould

const MOULD_CELLS = 9; // the picture under the mould: the median of this many cells (4r px each) across
const MOULD_LONG = 40; // × r: the longest colony, in proxy pixels (120 at 1600 px, ~2.7 mm of the film)
const MOULD_PASSES = 6;

/**
 * The picture without its mould, per channel and ×9 (imaging._mould_background): the lower median
 * of the MOULD_CELLS² integer cell means around each cell, bilinear between cells. Interleaved RGB.
 */
function mouldBackground(q: Int32Array, w: number, h: number, cell: number): Float64Array {
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const cells = new Float64Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const [y0, y1, x0, x1] = [gy * cell, Math.min(h, gy * cell + cell), gx * cell, Math.min(w, gx * cell + cell)];
      const n = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += q[(y * w + x) * 3 + c];
        cells[(gy * gw + gx) * 3 + c] = Math.floor((sum * 9) / n);
      }
    }
  const k = MOULD_CELLS >> 1;
  const med = new Float64Array(gw * gh * 3);
  const win = new Float64Array(MOULD_CELLS * MOULD_CELLS);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++)
      for (let c = 0; c < 3; c++) {
        let n = 0;
        for (let y = Math.max(0, gy - k); y <= Math.min(gh - 1, gy + k); y++)
          for (let x = Math.max(0, gx - k); x <= Math.min(gw - 1, gx + k); x++) win[n++] = cells[(y * gw + x) * 3 + c];
        med[(gy * gw + gx) * 3 + c] = win.subarray(0, n).sort()[(n - 1) >> 1];
      }
  // bilinear between the cells' centres, rows first (imaging._upsample)
  const ax = bilinearAxis(gw * cell, gw);
  const ay = bilinearAxis(gh * cell, gh);
  const across = new Float64Array(gh * w * 3);
  for (let gy = 0; gy < gh; gy++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        const [a, b, f] = [med[(gy * gw + ax.i0[x]) * 3 + c], med[(gy * gw + ax.i1[x]) * 3 + c], ax.f[x]];
        across[(gy * w + x) * 3 + c] = a * (1 - f) + b * f;
      }
  const bg = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const [r0, r1, f] = [ay.i0[y] * w * 3, ay.i1[y] * w * 3, ay.f[y]];
    for (let i = 0; i < w * 3; i++) bg[y * w * 3 + i] = across[r0 + i] * (1 - f) + across[r1 + i] * f;
  }
  return bg;
}

/** Max over the (2g + 1)² window, clipped to the image (cv2.dilate of a 0/1 mask). */
function grow(m: Uint8Array, w: number, h: number, g: number): Uint8Array {
  const across = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, x - g); k <= Math.min(w - 1, x + g) && !v; k++) v = m[y * w + k];
      across[y * w + x] = v;
    }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, y - g); k <= Math.min(h - 1, y + g) && !v; k++) v = across[k * w + x];
      out[y * w + x] = v;
    }
  return out;
}

/**
 * Mould (imaging._find_mould): candidates where a channel's 3×3 sum differs from the picture without
 * its mould by more than `amount` asks, joined into 8-connected shapes (hysteresis: at half the
 * threshold, with a pixel over it); shapes bigger than dust, at most MOULD_LONG × r long and filling
 * little of their bounding box are mould, grown by r / 2. All in integers, so the same pixels as
 * Python. Returns the mask, every candidate, the background (×9) and r.
 */
function findMould(a: RGB, amount: number): { mask: Uint8Array; busy: Uint8Array; bg: Float64Array; r: number } {
  const { width: w, height: h } = a;
  const f = Math.fround;
  const q = new Int32Array(w * h * 3);
  for (let i = 0; i < q.length; i++) q[i] = Math.trunc(f(f(Math.min(1, Math.max(0, a.data[i])) * 255) + 0.5));
  const r = Math.max(1, Math.trunc((3 * Math.max(w, h)) / DUST_EDGE + 0.5));
  const bg = mouldBackground(q, w, h, 4 * r);
  const thr = 9 * (30 - 18 * amount);
  // the 3×3 sums, the edge repeated: across, then down
  const s3 = new Int32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [i, l, rt] = [(y * w + x) * 3, (y * w + Math.max(0, x - 1)) * 3, (y * w + Math.min(w - 1, x + 1)) * 3];
      for (let c = 0; c < 3; c++) s3[i + c] = q[l + c] + q[i + c] + q[rt + c];
    }
  const dev = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const [up, down] = [Math.max(0, y - 1) * w * 3, Math.min(h - 1, y + 1) * w * 3];
    for (let x = 0; x < w; x++) {
      let d = 0;
      for (let c = 0; c < 3; c++) {
        const i = (y * w + x) * 3 + c;
        const s9 = s3[up + x * 3 + c] + s3[i] + s3[down + x * 3 + c];
        d = Math.max(d, Math.abs(s9 - bg[i]));
      }
      dev[y * w + x] = d;
    }
  }
  // 8-connected shapes of the weak candidates, found by flood fill; their size, extent, strength
  const label = new Int32Array(w * h);
  const shapes: { area: number; x0: number; x1: number; y0: number; y1: number; strong: boolean }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (label[i] || !(dev[i] > thr / 2)) continue;
    const s = { area: 0, x0: w, x1: 0, y0: h, y1: 0, strong: false };
    shapes.push(s);
    label[i] = shapes.length;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const [y, x] = [Math.trunc(j / w), j % w];
      s.area++;
      [s.x0, s.x1, s.y0, s.y1] = [Math.min(s.x0, x), Math.max(s.x1, x), Math.min(s.y0, y), Math.max(s.y1, y)];
      if (dev[j] > thr) s.strong = true;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const k = yy * w + xx;
          if (!label[k] && dev[k] > thr / 2) {
            label[k] = shapes.length;
            stack.push(k);
          }
        }
    }
  }
  const fill = Math.trunc(35 + 20 * amount);
  const keep = shapes.map(({ area, x0, x1, y0, y1, strong }) => {
    const [bw, bh] = [x1 - x0 + 1, y1 - y0 + 1];
    return strong && area >= 3 * r * r && Math.max(bw, bh) <= MOULD_LONG * r && area * 100 <= bw * bh * fill;
  });
  const kept = new Uint8Array(w * h);
  const busy = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    if (label[i]) {
      busy[i] = 1;
      if (keep[label[i] - 1]) kept[i] = 1;
    }
  return { mask: grow(kept, w, h, Math.max(1, Math.trunc(r / 2 + 0.5))), busy, bg, r };
}

/** The mould findMould keeps (imaging.mould_mask). */
export function mouldMask(a: RGB, amount: number): { mask: Uint8Array; r: number } {
  const { mask, r } = findMould(a, amount);
  return { mask, r };
}

/**
 * Find mould (at proxy scale) and paint it out without leaving flat patches (imaging.repair_mould):
 * low frequencies from the median of the clean proxy pixels around (9 × 9 samples r apart, pass by
 * pass), grain from the first clean spot 6r or 12r away round the compass (its pixel minus its local
 * mean). At full resolution the low frequencies are the proxy's, bilinear. inPlace: the caller's
 * pixels may be overwritten.
 */
export function repairMould(a: RGB, amount: number, inPlace = false): RGB {
  if (amount <= 0) return a;
  const { width: w, height: h } = a;
  const small = shrink(a, DUST_EDGE);
  const { mask: m, busy: busy0, bg, r } = findMould(small, amount);
  if (!m.includes(1)) return a;
  const [mw, mh] = [small.width, small.height];
  // samples and grain come from clean picture only, not from mould left alone
  const known = new Uint8Array(mw * mh);
  const todo: number[] = [];
  for (let i = 0; i < mw * mh; i++) {
    if (m[i]) {
      busy0[i] = 1;
      todo.push(i);
    }
    known[i] = 1 - busy0[i];
  }
  const low = rgb(mw, mh, Float32Array.from(small.data));
  const off = Array.from({ length: 9 }, (_, k) => (k - 4) * r);
  for (const i of medianFill(low, known, todo, off, MOULD_PASSES))
    for (let c = 0; c < 3; c++) low.data[i * 3 + c] = Math.fround(bg[i * 3 + c] / (9 * 255));
  const mask = verdicts(m, mw, mh, w, h);
  const busy = verdicts(busy0, mw, mh, w, h);
  const ax = bilinearAxis(w, mw);
  const ay = bilinearAxis(h, mh);
  const f = Math.max(h, w) / Math.max(mh, mw);
  const g = Math.max(1, Math.trunc(f + 0.5));
  const n = (2 * g + 1) ** 2;
  const shifts: [number, number][] = [];
  for (const d of [6 * r, 12 * r]) {
    const s = Math.trunc(d * f + 0.5);
    for (const [sy, sx] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
      [1, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
    ])
      shifts.push([sy * s, sx * s]);
  }
  const src = a.data;
  const L = low.data;
  let count = 0;
  for (let i = 0; i < w * h; i++) count += mask[i];
  const at = new Int32Array(count); // written once every value is known: `out` may be `a`
  const vals = new Float64Array(count * 3);
  let j = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const v = vals.subarray(j * 3, j * 3 + 3);
      at[j++] = y * w + x;
      const [x0, x1, fx, y0, y1, fy] = [ax.i0[x], ax.i1[x], ax.f[x], ay.i0[y], ay.i1[y], ay.f[y]];
      for (let c = 0; c < 3; c++)
        v[c] =
          (L[(y0 * mw + x0) * 3 + c] * (1 - fx) + L[(y0 * mw + x1) * 3 + c] * fx) * (1 - fy) +
          (L[(y1 * mw + x0) * 3 + c] * (1 - fx) + L[(y1 * mw + x1) * 3 + c] * fx) * fy;
      const shift = shifts.find(([dy, dx]) => {
        const [yy, xx] = [y + dy, x + dx];
        return yy >= 0 && yy < h && xx >= 0 && xx < w && !busy[yy * w + xx];
      });
      if (!shift) continue;
      // the grain: that pixel minus the mean of the (2g + 1)² around it, g a proxy pixel
      const [qy, qx] = [y + shift[0], x + shift[1]];
      const mean = [0, 0, 0];
      for (let dy = -g; dy <= g; dy++) {
        const yy = Math.min(h - 1, Math.max(0, qy + dy));
        for (let dx = -g; dx <= g; dx++) {
          const s = (yy * w + Math.min(w - 1, Math.max(0, qx + dx))) * 3;
          for (let c = 0; c < 3; c++) mean[c] += src[s + c];
        }
      }
      for (let c = 0; c < 3; c++) v[c] += src[(qy * w + qx) * 3 + c] - mean[c] / n;
    }
  const out = inPlace ? a : rgb(w, h, Float32Array.from(src));
  at.forEach((i, k) => {
    for (let c = 0; c < 3; c++) out.data[i * 3 + c] = Math.min(1, Math.max(0, vals[k * 3 + c]));
  });
  return out;
}

// ------------------------------------------------------------------ Newton rings

export const NEWTON_EDGE = 1600;

/**
 * Mean over the (2r + 1)² window clipped to the image, in place, in float64 from running sums:
 * along rows, then down columns (imaging._box; OpenCV adds in another order there, ~1e-15 apart).
 * `run` is scratch space for (h + 1) × w values.
 */
function box(a: Float64Array, w: number, h: number, r: number, run: Float64Array): void {
  if (r <= 0) return;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) run[x + 1] = run[x] + a[row + x];
    for (let x = 0; x < w; x++) {
      const lo = Math.max(x - r, 0);
      const hi = Math.min(x + r + 1, w);
      a[row + x] = (run[hi] - run[lo]) / (hi - lo);
    }
  }
  // down the columns: every column's running sum at once, a row at a time (memory in order)
  for (let x = 0; x < w; x++) run[x] = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) run[(y + 1) * w + x] = run[y * w + x] + a[y * w + x];
  for (let y = 0; y < h; y++) {
    const lo = Math.max(y - r, 0) * w;
    const hi = Math.min(y + r + 1, h) * w;
    const n = (hi - lo) / w;
    for (let x = 0; x < w; x++) a[y * w + x] = (run[hi + x] - run[lo + x]) / n;
  }
}

/** Two box means, in place: close to a Gaussian (imaging._blur). */
function blur(a: Float64Array, w: number, h: number, r: number, run: Float64Array): Float64Array {
  box(a, w, h, r, run);
  box(a, w, h, r, run);
  return a;
}

const smoothstep = (x: number, e0: number, e1: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Newton rings (imaging.newton_weight): where the band between two blurs is narrow-band (one
 * frequency: gradient energy² ≈ energy × Laplacian energy), oriented (structure tensor) and faint.
 * Returns the weight 0..1 per pixel and the band per channel (planar), float64.
 */
export function newtonWeight(a: RGB, amount: number): { weight: Float64Array; band: Float64Array[] } {
  const { width: w, height: h } = a;
  const s = Math.max(h, w) / NEWTON_EDGE;
  const r1 = Math.trunc(s + 0.5); // 0: no blur
  const r2 = Math.max(2, Math.trunc(14 * s + 0.5));
  const r3 = Math.max(3, Math.trunc(20 * s + 0.5));
  const run = new Float64Array((h + 1) * w + 1);
  const sums = [0, 1, 2, 3, 4].map(() => new Float64Array(w * h)); // e0, e2, jxx, jyy, jxy
  const hi = new Float64Array(w * h);
  const b = new Float64Array(w * h);
  const band = [0, 1, 2].map((c) => {
    const lo = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) lo[i] = hi[i] = a.data[i * 3 + c];
    blur(lo, w, h, r1, run);
    blur(hi, w, h, r2, run);
    for (let i = 0; i < w * h; i++) b[i] = lo[i] -= hi[i];
    blur(b, w, h, Math.max(1, 2 * r1), run);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const xp = b[y * w + Math.min(x + 1, w - 1)];
        const xm = b[y * w + Math.max(x - 1, 0)];
        const yp = b[Math.min(y + 1, h - 1) * w + x];
        const ym = b[Math.max(y - 1, 0) * w + x];
        const gx = (xp - xm) * 0.5;
        const gy = (yp - ym) * 0.5;
        const lap = xp + xm + yp + ym - 4 * b[i];
        // summed over the channels in order, as (c0 + c1) + c2
        sums[0][i] += b[i] * b[i];
        sums[1][i] += lap * lap;
        sums[2][i] += gx * gx;
        sums[3][i] += gy * gy;
        sums[4][i] += gx * gy;
      }
    return lo;
  });
  const [e0, e2, jxx, jyy, jxy] = sums.map((v) => blur(v, w, h, r3, run));
  const [n0, c0, a1] = [0.6 - 0.15 * amount, 0.5 - 0.25 * amount, 0.02 + 0.04 * amount];
  const weight = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const e1 = jxx[i] + jyy[i];
    const narrow = (e1 * e1) / (e0[i] * e2[i] + 1e-30);
    const coh = ((jxx[i] - jyy[i]) * (jxx[i] - jyy[i]) + 4 * jxy[i] * jxy[i]) / (e1 * e1 + 1e-30);
    const amp = Math.sqrt(e0[i]);
    weight[i] =
      smoothstep(narrow, n0, n0 + 0.15) *
      smoothstep(coh, c0, c0 + 0.25) *
      smoothstep(amp, 0.001, 0.003) *
      (1 - smoothstep(amp, a1, 2 * a1));
  }
  return { weight, band };
}

/**
 * Take the ring band out where newtonWeight finds rings, at proxy scale; at full resolution the
 * proxy's correction is laid on bilinear (imaging.repair_newton). inPlace: the caller's pixels may
 * be overwritten.
 */
export function repairNewton(a: RGB, amount: number, inPlace = false): RGB {
  if (amount <= 0) return a;
  const { width: w, height: h } = a;
  const small = shrink(a, NEWTON_EDGE);
  const [mw, mh] = [small.width, small.height];
  const { weight, band } = newtonWeight(small, amount);
  const corr = new Float64Array(mw * mh * 3);
  for (let i = 0; i < mw * mh; i++) for (let c = 0; c < 3; c++) corr[i * 3 + c] = -weight[i] * band[c][i];
  const out = inPlace ? a : rgb(w, h, new Float32Array(a.data.length));
  const ax = bilinearAxis(w, mw);
  const ay = bilinearAxis(h, mh);
  // bilinear, along rows first, then down (imaging._upsample); two proxy rows brought across at a time
  const rows = new Map<number, Float64Array>();
  const across = (y: number) => {
    let row = rows.get(y);
    if (!row) {
      row = new Float64Array(w * 3);
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          const [p, q, f] = [corr[(y * mw + ax.i0[x]) * 3 + c], corr[(y * mw + ax.i1[x]) * 3 + c], ax.f[x]];
          row[x * 3 + c] = p * (1 - f) + q * f;
        }
      for (const k of rows.keys()) if (k < y - 1) rows.delete(k);
      rows.set(y, row);
    }
    return row;
  };
  for (let y = 0; y < h; y++) {
    const [r0, r1, f] = [across(ay.i0[y]), across(ay.i1[y]), ay.f[y]];
    for (let i = 0; i < w * 3; i++) {
      const k = y * w * 3 + i;
      out.data[k] = Math.min(1, Math.max(0, a.data[k] + (r0[i] * (1 - f) + r1[i] * f)));
    }
  }
  return out;
}

/**
 * crop = false: everything but the crop, for the crop tool to draw its frame over. inPlace: the
 * caller's pixels may be overwritten (full-resolution export, where a second copy costs 250 MB).
 */
export function develop(a: RGB, p: Params, crop = true, inPlace = false): RGB {
  let out = toneBase(a, p, false, inPlace);
  // the picture's frame, which local masks are drawn in (straighten keeps the size)
  const frame: [number, number] = [out.width, out.height];
  let at: [number, number] = [0, 0];
  if (crop && p.crop) {
    const [t, b, l, r] = cropBox(out.height, out.width, p.crop);
    out = cropped(out, t, b, l, r);
    at = [l, t];
  }
  if (out === a && !inPlace) out = rgb(a.width, a.height, Float32Array.from(a.data)); // never write into the caller's pixels
  applyCurves(out, p.curves ?? {});
  finish(out, p);
  if (p.local?.length) applyLocal(out, p.local, frame, at, p.angle ?? 0);
  return out;
}

/**
 * The photo's look (restore, repairs, tone, colour) on its whole frame (imaging.develop_look): no
 * trim, straighten or crop, so a point found on `a` is still where it was (the faces in People).
 * local = false leaves out the local adjustments (their masks are drawn for another turn of the slide).
 */
export function developLook(a: RGB, p: Params, local = true): RGB {
  return develop(a, { ...p, trim: false, angle: 0, crop: null, local: local ? p.local : [] });
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

// ------------------------------------------------------------------ local adjustments

const BRUSH_STROKES = 64;
const BRUSH_POINTS = 400;
const EXPOSURE_STOPS = 1.5; // what a local exposure of ±1 does (see localLook)

/** imaging._num: a number clamped to lo..hi and rounded to 4 places; junk is the default. */
function num(v: unknown, lo: number, hi: number, dflt = 0): number {
  if (typeof v === "string" ? !v.trim() : typeof v !== "number" && typeof v !== "boolean") return dflt;
  const x = Number(v);
  if (!Number.isFinite(x)) return dflt;
  return round(Math.min(hi, Math.max(lo, x)), 4) || 0; // || 0: never -0 in the render key
}

function point(v: unknown): Pt | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  return [num(v[0], -1, 2, 0.5), num(v[1], -1, 2, 0.5)];
}

/** imaging.clean_local: validate local adjustments (masks in 0..1 of the picture before straightening). */
export function cleanLocal(v: unknown): Local[] {
  const out: Local[] = [];
  if (!Array.isArray(v)) return out;
  for (const a of v.slice(0, LOCAL_MAX) as Record<string, unknown>[]) {
    if (!a || typeof a !== "object" || !["graduated", "radial", "brush"].includes(a.kind as string)) continue;
    const sliders = Object.fromEntries(LOCAL_SLIDERS.map((k) => [k, num(a[k] ?? 0, -1, 1)])) as Record<
      (typeof LOCAL_SLIDERS)[number],
      number
    >;
    if (a.kind === "graduated") {
      const [start, end]: Pt[] = [point(a.start) ?? [0.5, 0.15], point(a.end) ?? [0.5, 0.55]];
      out.push({ kind: "graduated", ...sliders, start, end });
    } else if (a.kind === "radial") {
      out.push({
        kind: "radial",
        ...sliders,
        center: point(a.center) ?? [0.5, 0.5],
        rx: num(a.rx ?? 0.25, 0.005, 2, 0.25),
        ry: num(a.ry ?? 0.25, 0.005, 2, 0.25),
        angle: num(a.angle ?? 0, -180, 180),
        feather: num(a.feather ?? 0.5, 0, 1, 0.5),
        invert: !!(a.invert ?? false),
      });
    } else {
      const strokes: BrushStroke[] = [];
      for (const s of Array.isArray(a.strokes) ? (a.strokes as Record<string, unknown>[]) : []) {
        if (strokes.length >= BRUSH_STROKES) break;
        if (!s || typeof s !== "object" || !Array.isArray(s.points)) continue;
        const pts = s.points.slice(0, BRUSH_POINTS).flatMap((q) => {
          const p = point(q);
          return p ? [p] : [];
        });
        if (pts.length)
          strokes.push({
            points: pts,
            radius: num(s.radius ?? 0.05, 0.002, 0.5, 0.05),
            hardness: num(s.hardness ?? 0.5, 0, 1, 0.5),
            flow: num(s.flow ?? 1, 0, 1, 1),
            erase: !!(s.erase ?? false),
          });
      }
      out.push({ kind: "brush", ...sliders, strokes });
    }
  }
  return out;
}

/** imaging.turn_local: the adjustments of a slide turned clockwise by `rot` more degrees. */
export function turnLocal(local: Local[], rot: number): Local[] {
  const k = Math.trunc((((rot % 360) + 360) % 360) / 90);
  if (!k || !local.length) return local;
  const pt = (p: Pt): Pt => {
    for (let i = 0; i < k; i++) p = [round(1 - p[1], 4) || 0, p[0]];
    return p;
  };
  return local.map((a) => {
    if (a.kind === "graduated") return { ...a, start: pt(a.start), end: pt(a.end) };
    if (a.kind === "radial") {
      const angle = round(((((a.angle + 90 * k + 180) % 360) + 360) % 360) - 180, 4) || 0;
      return { ...a, center: pt(a.center), angle };
    }
    return { ...a, strokes: a.strokes.map((s) => ({ ...s, points: s.points.map(pt) })) };
  });
}

/** imaging.mirror_local: the adjustments of a slide mirrored left-right. */
export function mirrorLocal(local: Local[]): Local[] {
  const pt = (p: Pt): Pt => [round(1 - p[0], 4) || 0, p[1]];
  return local.map((a) => {
    if (a.kind === "graduated") return { ...a, start: pt(a.start), end: pt(a.end) };
    if (a.kind === "radial") return { ...a, center: pt(a.center), angle: -a.angle || 0 };
    return { ...a, strokes: a.strokes.map((s) => ({ ...s, points: s.points.map(pt) })) };
  });
}

/** imaging.mirror_params: the same frame mirrored left-right (straighten, crop and masks flip across). */
export function mirrorParams(p: Params): Params {
  const out = { ...p, angle: -p.angle || 0 };
  if (p.crop) {
    const [l, t, r, b] = p.crop;
    out.crop = [round(1 - r, 4), t, round(1 - l, 4), b];
  }
  if (p.local?.length) out.local = mirrorLocal(p.local);
  return out;
}

/**
 * imaging.local_look on one pixel, in place in `px`: white balance, exposure (a gamma lift up, a
 * scale down), contrast, saturation.
 */
function localLook(px: Float64Array, adj: Local) {
  const eps = 1e-5;
  const c01 = (v: number) => Math.min(1, Math.max(eps, v));
  if (adj.warmth !== 0 || adj.tint !== 0) {
    px[0] = Math.pow(c01(px[0]), 1 - 0.25 * adj.warmth);
    px[1] = Math.pow(c01(px[1]), 1 + 0.25 * adj.tint);
    px[2] = Math.pow(c01(px[2]), 1 + 0.25 * adj.warmth);
  }
  const e = adj.exposure;
  if (e > 0) {
    const g = Math.pow(2, -EXPOSURE_STOPS * e);
    for (let c = 0; c < 3; c++) px[c] = Math.pow(c01(px[c]), g);
  } else if (e < 0) {
    const f = Math.pow(2, EXPOSURE_STOPS * e);
    for (let c = 0; c < 3; c++) px[c] *= f;
  }
  const con = adj.contrast;
  if (con > 0) for (let c = 0; c < 3; c++) px[c] += (px[c] * px[c] * (3 - 2 * px[c]) - px[c]) * con * 1.5;
  else if (con < 0) for (let c = 0; c < 3; c++) px[c] += (0.5 - px[c]) * -con * 0.5;
  if (adj.saturation !== 0) {
    const lum = px[0] * 0.299 + px[1] * 0.587 + px[2] * 0.114;
    for (let c = 0; c < 3; c++) px[c] = lum + (px[c] - lum) * (1 + adj.saturation);
  }
  for (let c = 0; c < 3; c++) px[c] = clamp01(px[c]);
}

/**
 * imaging.apply_local, in place: after the global develop. `frame` = [w, h] of the straightened
 * frame `out` was cut from at `at` = [left, top]; each pixel is traced back through the straighten
 * to the picture, where the masks are sampled bilinearly from their grids.
 */
export function applyLocal(out: RGB, local: Local[], frame: [number, number], at: [number, number], angle: number) {
  const [w, h] = frame;
  const k = MASK_EDGE / Math.max(w, h); // picture pixels -> cells
  const masks = local.map((adj) => localMask(adj, w, h));
  const { width: gw, height: gh } = masks[0];
  const turned = Math.abs(angle) >= 0.01; // straighten() leaves tiny angles alone
  const th = (Math.abs(angle) * Math.PI) / 180;
  const scale = Math.cos(th) + (Math.sin(th) * Math.max(w, h)) / Math.min(w, h);
  const cs = Math.cos((angle * Math.PI) / 180) / scale;
  const sn = Math.sin((angle * Math.PI) / 180) / scale;
  const o = out.data;
  const px = new Float64Array(3);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      let sx = x + at[0];
      let sy = y + at[1];
      if (turned) {
        const dx = sx - w / 2;
        const dy = sy - h / 2;
        sx = w / 2 + cs * dx + sn * dy;
        sy = h / 2 - sn * dx + cs * dy;
      }
      const gx = (sx + 0.5) * k - 0.5;
      const gy = (sy + 0.5) * k - 0.5;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      const fx = gx - ix;
      const fy = gy - iy;
      const xa = Math.min(gw - 1, Math.max(0, ix));
      const xb = Math.min(gw - 1, Math.max(0, ix + 1));
      const ya = Math.min(gh - 1, Math.max(0, iy)) * gw;
      const yb = Math.min(gh - 1, Math.max(0, iy + 1)) * gw;
      const i = (y * out.width + x) * 3;
      for (let n = 0; n < local.length; n++) {
        const g = masks[n].data;
        const m = (g[ya + xa] * (1 - fx) + g[ya + xb] * fx) * (1 - fy) + (g[yb + xa] * (1 - fx) + g[yb + xb] * fx) * fy;
        if (!(m > 0)) continue;
        px[0] = o[i];
        px[1] = o[i + 1];
        px[2] = o[i + 2];
        localLook(px, local[n]);
        for (let c = 0; c < 3; c++) o[i + c] += (px[c] - o[i + c]) * m;
      }
    }
  }
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
 * guess). `faceVotes` holds each image's face votes (yunet.faceVotes, asynchronous, so the caller
 * runs it first); without them only the sky rule guesses. Both rules are the Python ones.
 */
export function suggestRotation(images: RGB[], faceVotes?: Record<number, number>[]): [number, string] {
  const n = images.length;
  if (!n) return [0, ""];
  if (faceVotes) {
    const fv: Record<number, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };
    for (const votes of faceVotes) for (const [r, v] of Object.entries(votes)) fv[+r] += v;
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
