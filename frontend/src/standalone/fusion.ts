// Align and exposure-fuse several scans of one slide (imaging.fuse): Mertens as OpenCV's
// MergeMertens does it with its defaults, ported from apple/SlideKit's Fusion.swift, and a
// median-threshold-bitmap alignment in the spirit of OpenCV's AlignMTB.
import { plane, reflect101, type Plane, type RGB } from "./pixels";

/** Hands out one row of float RGB at a time: a decoded 8-bit scan, a shifted view, or an RGB. */
export type RowSource = { width: number; height: number; row(y: number, out: Float32Array): void };

export const rgbSource = (a: RGB): RowSource => ({
  width: a.width,
  height: a.height,
  row: (y, out) => out.set(a.data.subarray(y * a.width * 3, (y + 1) * a.width * 3)),
});

/** 8-bit RGBA (ImageData) — a quarter of the memory of float RGB, for full-resolution work. */
export const rgba8Source = (width: number, height: number, bytes: Uint8ClampedArray): RowSource => ({
  width,
  height,
  row: (y, out) => {
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      out[x * 3] = bytes[base + x * 4] / 255;
      out[x * 3 + 1] = bytes[base + x * 4 + 1] / 255;
      out[x * 3 + 2] = bytes[base + x * 4 + 2] / 255;
    }
  },
});

/** The top-left width × height of a larger source (brackets whose scans differ by a pixel). */
const croppedSource = (base: RowSource, width: number, height: number): RowSource => {
  const tmp = new Float32Array(base.width * 3);
  return {
    width,
    height,
    row: (y, out) => {
      base.row(y, tmp);
      out.set(tmp.subarray(0, width * 3));
    },
  };
};

/** A source moved by (dx, dy) pixels, edges repeated — alignment without a copy. */
export const shiftedSource = (base: RowSource, dx: number, dy: number): RowSource => {
  const tmp = new Float32Array(base.width * 3);
  const w = base.width;
  return {
    width: w,
    height: base.height,
    row: (y, out) => {
      base.row(Math.min(base.height - 1, Math.max(0, y - dy)), tmp);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(w - 1, Math.max(0, x - dx)) * 3;
        out[x * 3] = tmp[sx];
        out[x * 3 + 1] = tmp[sx + 1];
        out[x * 3 + 2] = tmp[sx + 2];
      }
    },
  };
};

export function materialise(src: RowSource): RGB {
  const out = new Float32Array(src.width * src.height * 3);
  const buf = new Float32Array(src.width * 3);
  for (let y = 0; y < src.height; y++) {
    src.row(y, buf);
    out.set(buf, y * src.width * 3);
  }
  return { width: src.width, height: src.height, data: out };
}

// ------------------------------------------------------------------ Mertens

export function fuse(images: RGB[], align = true): RGB {
  return fuseSources(images.map(rgbSource), align);
}

/**
 * Mertens over row sources, one colour channel at a time: the peak is one channel's pyramids
 * (result, scan, weights) plus the output, never a whole RGB pyramid per scan.
 */
export function fuseSources(input: RowSource[], align = true): RGB {
  if (input.length === 1) return materialise(input[0]);
  const w = Math.min(...input.map((s) => s.width));
  const h = Math.min(...input.map((s) => s.height));
  const same = input.map((s) => (s.width === w && s.height === h ? s : croppedSource(s, w, h)));
  const sources = align ? alignSources(same) : same;

  const weightSum = plane(w, h);
  for (const src of sources) {
    const wt = weights(src);
    for (let i = 0; i < w * h; i++) weightSum.data[i] += wt.data[i];
  }
  const levels = Math.trunc(Math.log(Math.min(w, h)) / Math.log(2));
  const out = new Float32Array(w * h * 3);
  for (let c = 0; c < 3; c++) {
    const result: Plane[] = [];
    for (const src of sources) {
      // the weights are cheap to recompute; keeping three weight pyramids is not
      const wt = weights(src);
      for (let i = 0; i < w * h; i++) wt.data[i] /= weightSum.data[i];
      const wPyr = gaussianPyramid(wt, levels);
      const lap = gaussianPyramid(channelOf(src, c), levels);
      for (let l = 0; l < levels; l++) combine(lap[l], pyrUp(lap[l + 1], lap[l].width, lap[l].height), (a, b) => a - b);
      for (let l = 0; l <= levels; l++) {
        combine(lap[l], wPyr[l], (a, b) => a * b);
        if (result.length <= l) result.push(lap[l]);
        else combine(result[l], lap[l], (a, b) => a + b);
      }
    }
    for (let l = levels; l > 0; l--) {
      combine(result[l - 1], pyrUp(result[l], result[l - 1].width, result[l - 1].height), (a, b) => a + b);
      result.pop();
    }
    const p = result[0].data;
    for (let i = 0; i < w * h; i++) out[i * 3 + c] = Math.min(1, Math.max(0, p[i]));
  }
  return { width: w, height: h, data: out };
}

function combine(a: Plane, b: Plane, f: (x: number, y: number) => number) {
  const x = a.data;
  const y = b.data;
  for (let i = 0; i < x.length; i++) x[i] = f(x[i], y[i]);
}

/** contrast × saturation + 1e-12, per pixel. */
function weights(src: RowSource): Plane {
  const { width: w, height: h } = src;
  const g = plane(w, h);
  const sat = plane(w, h);
  const row = new Float32Array(w * 3);
  for (let y = 0; y < h; y++) {
    src.row(y, row);
    for (let x = 0; x < w; x++) {
      const r = row[x * 3];
      const gg = row[x * 3 + 1];
      const b = row[x * 3 + 2];
      g.data[y * w + x] = 0.299 * r + 0.587 * gg + 0.114 * b;
      const m = (r + gg + b) / 3;
      sat.data[y * w + x] = Math.sqrt((r - m) * (r - m) + (gg - m) * (gg - m) + (b - m) * (b - m));
    }
  }
  const lapl = laplacianOf(g);
  for (let i = 0; i < w * h; i++) sat.data[i] = Math.abs(lapl.data[i]) * sat.data[i] + 1e-12;
  return sat;
}

function laplacianOf(p: Plane): Plane {
  const { width: w, height: h } = p;
  const out = plane(w, h);
  for (let y = 0; y < h; y++) {
    const yu = reflect101(y - 1, h) * w;
    const yd = reflect101(y + 1, h) * w;
    const r = y * w;
    for (let x = 0; x < w; x++)
      out.data[r + x] =
        p.data[yu + x] +
        p.data[yd + x] +
        p.data[r + reflect101(x - 1, w)] +
        p.data[r + reflect101(x + 1, w)] -
        4 * p.data[r + x];
  }
  return out;
}

function channelOf(src: RowSource, c: number): Plane {
  const out = plane(src.width, src.height);
  const row = new Float32Array(src.width * 3);
  for (let y = 0; y < src.height; y++) {
    src.row(y, row);
    for (let x = 0; x < src.width; x++) out.data[y * src.width + x] = row[x * 3 + c];
  }
  return out;
}

const K = [1 / 16, 4 / 16, 6 / 16];

function gaussianPyramid(p: Plane, levels: number): Plane[] {
  const out = [p];
  for (let l = 0; l < levels; l++) out.push(pyrDown(out[l]));
  return out;
}

/** cv::pyrDown: blur with [1 4 6 4 1]/16 and keep every other pixel (BORDER_REFLECT_101). */
function pyrDown(p: Plane): Plane {
  const { width: w, height: h } = p;
  const ow = (w + 1) >> 1;
  const oh = (h + 1) >> 1;
  const s = p.data;
  const tmp = new Float32Array(w * oh);
  for (let oy = 0; oy < oh; oy++) {
    const y = oy * 2;
    const r0 = reflect101(y - 2, h) * w;
    const r1 = reflect101(y - 1, h) * w;
    const r2 = y * w;
    const r3 = reflect101(y + 1, h) * w;
    const r4 = reflect101(y + 2, h) * w;
    for (let x = 0; x < w; x++)
      tmp[oy * w + x] = (s[r0 + x] + s[r4 + x]) * K[0] + (s[r1 + x] + s[r3 + x]) * K[1] + s[r2 + x] * K[2];
  }
  const out = plane(ow, oh);
  for (let oy = 0; oy < oh; oy++) {
    const row = oy * w;
    for (let ox = 0; ox < ow; ox++) {
      const x = ox * 2;
      out.data[oy * ow + ox] =
        (tmp[row + reflect101(x - 2, w)] + tmp[row + reflect101(x + 2, w)]) * K[0] +
        (tmp[row + reflect101(x - 1, w)] + tmp[row + reflect101(x + 1, w)]) * K[1] +
        tmp[row + x] * K[2];
    }
  }
  return out;
}

/**
 * cv::pyrUp to (width, height): per axis, even outputs are (s[i-1] + 6 s[i] + s[i+1]) / 8 and odd
 * ones (s[i] + s[i+1]) / 2, reflecting at the start but repeating at the end.
 */
function pyrUp(p: Plane, width: number, height: number): Plane {
  const axis = (n: number, outN: number) => {
    const a = new Int32Array(outN * 3);
    const wt = new Float32Array(outN * 3);
    for (let d = 0; d < outN; d++) {
      const i = Math.min(n - 1, d >> 1);
      const prev = i === 0 ? Math.min(1, n - 1) : i - 1;
      const next = Math.min(n - 1, i + 1);
      if (d % 2 === 0) (a.set([prev, i, next], d * 3), wt.set([0.125, 0.75, 0.125], d * 3));
      else (a.set([i, next, next], d * 3), wt.set([0.5, 0.5, 0], d * 3));
    }
    return { a, wt };
  };
  const xs = axis(p.width, width);
  const ys = axis(p.height, height);
  const tmp = new Float32Array(width * p.height);
  for (let y = 0; y < p.height; y++) {
    const r = y * p.width;
    for (let x = 0; x < width; x++) {
      const k = x * 3;
      tmp[y * width + x] =
        p.data[r + xs.a[k]] * xs.wt[k] +
        p.data[r + xs.a[k + 1]] * xs.wt[k + 1] +
        p.data[r + xs.a[k + 2]] * xs.wt[k + 2];
    }
  }
  const out = plane(width, height);
  for (let y = 0; y < height; y++) {
    const k = y * 3;
    const r0 = ys.a[k] * width;
    const r1 = ys.a[k + 1] * width;
    const r2 = ys.a[k + 2] * width;
    const w0 = ys.wt[k];
    const w1 = ys.wt[k + 1];
    const w2 = ys.wt[k + 2];
    for (let x = 0; x < width; x++) out.data[y * width + x] = tmp[r0 + x] * w0 + tmp[r1 + x] * w1 + tmp[r2 + x] * w2;
  }
  return out;
}

// ------------------------------------------------------------------ alignment

/** Box-averaged grey copy with the longer edge at most maxEdge, and the factor it shrank by. */
function smallGray(src: RowSource, maxEdge: number): { p: Plane; f: number } {
  const f = Math.max(1, Math.ceil(Math.max(src.width, src.height) / maxEdge));
  const ow = Math.max(1, Math.trunc(src.width / f));
  const oh = Math.max(1, Math.trunc(src.height / f));
  const out = plane(ow, oh);
  const row = new Float32Array(src.width * 3);
  for (let oy = 0; oy < oh; oy++) {
    for (let sy = oy * f; sy < oy * f + f; sy++) {
      src.row(sy, row);
      for (let ox = 0; ox < ow; ox++)
        for (let sx = ox * f; sx < ox * f + f; sx++)
          out.data[oy * ow + ox] += 0.299 * row[sx * 3] + 0.587 * row[sx * 3 + 1] + 0.114 * row[sx * 3 + 2];
    }
    for (let ox = 0; ox < ow; ox++) out.data[oy * ow + ox] /= f * f;
  }
  return { p: out, f };
}

const half = (p: Plane): Plane => {
  const ow = p.width >> 1;
  const oh = p.height >> 1;
  const out = plane(ow, oh);
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const i = 2 * y * p.width + 2 * x;
      out.data[y * ow + x] = (p.data[i] + p.data[i + 1] + p.data[i + p.width] + p.data[i + p.width + 1]) / 4;
    }
  return out;
};

/** Median threshold bitmap and its exclusion mask (pixels too close to the median to trust). */
function mtb(p: Plane, exclude = 4 / 255) {
  const sorted = Float32Array.from(p.data).sort();
  const med = sorted[sorted.length >> 1];
  const tb = new Uint8Array(p.data.length);
  const eb = new Uint8Array(p.data.length);
  for (let i = 0; i < p.data.length; i++) {
    tb[i] = p.data[i] > med ? 1 : 0;
    eb[i] = Math.abs(p.data[i] - med) > exclude ? 1 : 0;
  }
  return { tb, eb, w: p.width, h: p.height };
}

type Bitmap = ReturnType<typeof mtb>;

function mtbError(a: Bitmap, b: Bitmap, dx: number, dy: number): number {
  let err = 0;
  for (let y = Math.max(0, dy); y < Math.min(a.h, b.h + dy); y++) {
    const ra = y * a.w;
    const rb = (y - dy) * b.w;
    for (let x = Math.max(0, dx); x < Math.min(a.w, b.w + dx); x++) {
      const i = ra + x;
      const j = rb + x - dx;
      err += (a.tb[i] ^ b.tb[j]) & a.eb[i] & b.eb[j];
    }
  }
  return err;
}

/** The (dx, dy) that moves `b` onto `a`, coarse to fine over six levels (Ward's MTB). */
export function mtbShift(a: Plane, b: Plane, maxBits = 6): [number, number] {
  const pa: Plane[] = [a];
  const pb: Plane[] = [b];
  for (let l = 1; l < maxBits && Math.min(pa[l - 1].width, pa[l - 1].height) >= 16; l++) {
    pa.push(half(pa[l - 1]));
    pb.push(half(pb[l - 1]));
  }
  let sx = 0;
  let sy = 0;
  for (let l = pa.length - 1; l >= 0; l--) {
    sx *= 2;
    sy *= 2;
    const ba = mtb(pa[l]);
    const bb = mtb(pb[l]);
    let best = [sx, sy];
    let bestErr = mtbError(ba, bb, sx, sy);
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        if (!i && !j) continue;
        const e = mtbError(ba, bb, sx + i, sy + j);
        if (e < bestErr) ((bestErr = e), (best = [sx + i, sy + j]));
      }
    [sx, sy] = best;
  }
  return [sx, sy];
}

/**
 * Shift every scan onto the first. The scanner holds the slide still, but a hand-bracketed stack
 * can move by a few pixels between presses. Registration runs on small copies and is scaled up.
 */
export function alignSources(sources: RowSource[]): RowSource[] {
  if (sources.length < 2) return sources;
  const ref = smallGray(sources[0], 1200);
  return [
    sources[0],
    ...sources.slice(1).map((src) => {
      const s = smallGray(src, 1200);
      const [dx0, dy0] = mtbShift(ref.p, s.p);
      const dx = dx0 * ref.f;
      const dy = dy0 * ref.f;
      if ((!dx && !dy) || Math.abs(dx) >= src.width / 10 || Math.abs(dy) >= src.height / 10) return src;
      return shiftedSource(src, dx, dy);
    }),
  ];
}
