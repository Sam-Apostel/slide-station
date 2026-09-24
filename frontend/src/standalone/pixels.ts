// Pixel containers and the handful of OpenCV operations the pipeline needs, in plain TypeScript.
// Ported from the Swift port (apple/SlideKit/Sources/SlideKit/Pixels.swift), which is parity-tested
// against slidestation/imaging.py: same resize coefficients, same border rules, same percentiles.

/** Interleaved RGB, 0..1 — the counterpart of the float32 numpy arrays in imaging.py. */
export type RGB = { width: number; height: number; data: Float32Array };
/** One channel. */
export type Plane = { width: number; height: number; data: Float32Array };

export const rgb = (width: number, height: number, data?: Float32Array): RGB => ({
  width,
  height,
  data: data ?? new Float32Array(width * height * 3),
});
export const plane = (width: number, height: number): Plane => ({
  width,
  height,
  data: new Float32Array(width * height),
});

/** Rows top..bottom-1, columns left..right-1 (clamped, at least one pixel). */
export function cropped(a: RGB, top: number, bottom: number, left: number, right: number): RGB {
  const t = Math.max(0, Math.min(a.height - 1, top));
  const b = Math.max(t + 1, Math.min(a.height, bottom));
  const l = Math.max(0, Math.min(a.width - 1, left));
  const r = Math.max(l + 1, Math.min(a.width, right));
  if (t === 0 && l === 0 && b === a.height && r === a.width) return a;
  const ow = r - l;
  const out = rgb(ow, b - t);
  for (let y = t; y < b; y++)
    out.data.set(a.data.subarray((y * a.width + l) * 3, (y * a.width + r) * 3), (y - t) * ow * 3);
  return out;
}

/** Clockwise by 0 / 90 / 180 / 270 degrees (imaging.rotate_arr). */
export function rotated(a: RGB, degrees: number): RGB {
  const rot = ((degrees % 360) + 360) % 360;
  if (rot === 0) return a;
  const { width: w, height: h } = a;
  const ow = rot === 180 ? w : h;
  const oh = rot === 180 ? h : w;
  const out = rgb(ow, oh);
  const s = a.data;
  const d = out.data;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let sx: number, sy: number;
      if (rot === 90) ((sx = y), (sy = h - 1 - x));
      else if (rot === 180) ((sx = w - 1 - x), (sy = h - 1 - y));
      else ((sx = w - 1 - y), (sy = x));
      const si = (sy * w + sx) * 3;
      const di = (y * ow + x) * 3;
      d[di] = s[si];
      d[di + 1] = s[si + 1];
      d[di + 2] = s[si + 2];
    }
  }
  return out;
}

/** Luma as OpenCV's RGB2GRAY computes it. */
export function gray(a: RGB): Plane {
  const out = plane(a.width, a.height);
  const s = a.data;
  for (let i = 0; i < out.data.length; i++)
    out.data[i] = 0.299 * s[i * 3] + 0.587 * s[i * 3 + 1] + 0.114 * s[i * 3 + 2];
  return out;
}

export function channel(a: RGB, c: number): Plane {
  const out = plane(a.width, a.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = a.data[i * 3 + c];
  return out;
}

type Taps = { idx: Int32Array; w: Float32Array; start: Int32Array };

/** OpenCV INTER_AREA coefficients, per output index: which inputs and how much of each. */
function areaWeights(n: number, m: number): Taps {
  const scale = n / m;
  const idx: number[] = [];
  const wt: number[] = [];
  const start = new Int32Array(m + 1);
  for (let j = 0; j < m; j++) {
    start[j] = idx.length;
    if (scale <= 1) {
      // enlarging: nearest with a one-pixel ramp
      const sx = Math.floor(j * scale);
      let f = j + 1 - (sx + 1) / scale;
      f = f <= 0 ? 0 : f - Math.floor(f);
      const i0 = Math.min(n - 1, sx);
      const i1 = Math.min(n - 1, sx + 1);
      if (i0 === i1 || f === 0) (idx.push(i0), wt.push(1));
      else (idx.push(i0, i1), wt.push(1 - f, f));
      continue;
    }
    const a = j * scale;
    const b = a + scale;
    for (let i = Math.floor(a); i < b && i < n; i++) {
      const cover = Math.min(b, i + 1) - Math.max(a, i);
      if (cover > 1e-9) (idx.push(i), wt.push(cover / scale));
    }
  }
  start[m] = idx.length;
  return { idx: Int32Array.from(idx), w: Float32Array.from(wt), start };
}

/** Area-average resize of `channels` interleaved channels (cv2.resize INTER_AREA). */
function resizeInterleaved(src: Float32Array, w: number, h: number, ow: number, oh: number, ch: number): Float32Array {
  const cols = areaWeights(w, ow);
  const rows = areaWeights(h, oh);
  const tmp = new Float32Array(ow * h * ch);
  for (let y = 0; y < h; y++) {
    const row = y * w * ch;
    for (let x = 0; x < ow; x++) {
      for (let c = 0; c < ch; c++) {
        let acc = 0;
        for (let k = cols.start[x]; k < cols.start[x + 1]; k++) acc += src[row + cols.idx[k] * ch + c] * cols.w[k];
        tmp[(y * ow + x) * ch + c] = acc;
      }
    }
  }
  const out = new Float32Array(ow * oh * ch);
  for (let y = 0; y < oh; y++) {
    for (let k = rows.start[y]; k < rows.start[y + 1]; k++) {
      const wv = rows.w[k];
      const s = rows.idx[k] * ow * ch;
      const d = y * ow * ch;
      for (let i = 0; i < ow * ch; i++) out[d + i] += tmp[s + i] * wv;
    }
  }
  return out;
}

export function resized(a: RGB, ow: number, oh: number): RGB {
  if (ow === a.width && oh === a.height) return a;
  return rgb(ow, oh, resizeInterleaved(a.data, a.width, a.height, ow, oh, 3));
}

export function resizedPlane(p: Plane, ow: number, oh: number): Plane {
  if (ow === p.width && oh === p.height) return p;
  return { width: ow, height: oh, data: resizeInterleaved(p.data, p.width, p.height, ow, oh, 1) };
}

/** Shrink so the longer edge is at most maxEdge. */
export function fitting(a: RGB, maxEdge: number): RGB {
  const edge = Math.max(a.width, a.height);
  if (edge <= maxEdge) return a;
  const s = maxEdge / edge;
  return resized(a, Math.max(1, Math.round(a.width * s)), Math.max(1, Math.round(a.height * s)));
}

export function mean(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return s / Math.max(1, v.length);
}

export function std(v: Float32Array): number {
  const m = mean(v);
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] - m) * (v[i] - m);
  return Math.sqrt(s / Math.max(1, v.length));
}

// ------------------------------------------------------------------ filters (BORDER_REFLECT_101)

export function reflect101(i: number, n: number): number {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
  return i;
}

/** The kernel OpenCV builds for GaussianBlur(ksize 0, sigma) on float images. */
function gaussianKernel(sigma: number): Float32Array {
  const size = Math.max(1, Math.round(sigma * 4 * 2 + 1)) | 1;
  const half = size >> 1;
  const k = new Float64Array(size);
  let s = 0;
  for (let i = 0; i < size; i++) s += k[i] = Math.exp(-((i - half) ** 2) / (2 * sigma * sigma));
  return Float32Array.from(k, (v) => v / s);
}

export function gaussianBlur(p: Plane, sigma: number): Plane {
  const k = gaussianKernel(sigma);
  const half = k.length >> 1;
  const { width: w, height: h } = p;
  const src = p.data;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      if (x >= half && x < w - half) for (let j = 0; j < k.length; j++) acc += src[row + x + j - half] * k[j];
      else for (let j = 0; j < k.length; j++) acc += src[row + reflect101(x + j - half, w)] * k[j];
      tmp[row + x] = acc;
    }
  }
  const out = plane(w, h);
  const taps = new Int32Array(k.length);
  for (let y = 0; y < h; y++) {
    for (let j = 0; j < k.length; j++) taps[j] = reflect101(y + j - half, h) * w;
    const d = y * w;
    for (let j = 0; j < k.length; j++) {
      const kv = k[j];
      const s = taps[j];
      for (let x = 0; x < w; x++) out.data[d + x] += tmp[s + x] * kv;
    }
  }
  return out;
}

/** cv2.Laplacian with ksize=1: the 4-neighbour kernel. */
export function laplacian(p: Plane): Plane {
  const { width: w, height: h } = p;
  const s = p.data;
  const out = plane(w, h);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const yu = reflect101(y - 1, h) * w;
    const yd = reflect101(y + 1, h) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xl = x === 0 ? reflect101(-1, w) : x - 1;
      const xr = x === w - 1 ? reflect101(w, w) : x + 1;
      d[row + x] = s[yu + x] + s[yd + x] + s[row + xl] + s[row + xr] - 4 * s[row + x];
    }
  }
  return out;
}

// ------------------------------------------------------------------ percentiles

/** numpy's default (linear) percentile of an already sorted array. */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return 0;
  const pos = (q / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Sorted copy (typed-array sort is numeric). */
export const sortedCopy = (v: Float32Array) => Float32Array.from(v).sort();
