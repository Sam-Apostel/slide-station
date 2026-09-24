// Reading signs in the browser version (slidestation/places.py `Ocr`): PaddleOCR's DB text detector
// and CTC recogniser (the same ONNX files, from Hugging Face into the library's models/ppocr/), with
// the few OpenCV steps around them in plain TypeScript: bilinear resize (OpenCV's fixed-point
// arithmetic), the probability map's blobs -> minimum-area rectangles (what findContours +
// minAreaRect give for a blob), the unclip, the perspective crop (bicubic, replicated border) and
// the greedy CTC decode. The network runs in the jobs worker (engine.worker.ts).
import type { ModelSource } from "./models";

export const OCR_ID = "ppocr-v5-latin";
export const OCR_DIR = "models/ppocr";
export const OCR: ModelSource = {
  repo: "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/",
  files: [
    [
      "detection/v3/det.onnx",
      "det.onnx",
      2429873,
      "sha256:ee40e80071ba3a320d4efda75f3e22047a7d049e9bf7bcaaf9daea23fc21b935",
    ],
    [
      "languages/latin/rec.onnx",
      "rec.onnx",
      7862832,
      "sha256:614ffc2d6d3902d360fad7f1b0dd455ee45e877069d14c4e51a99dc4ef144409",
    ],
    ["languages/latin/dict.txt", "dict.txt", 1634, "git:e2497aec268ef61cac813a7d34181fd960f8ded6"],
  ],
};

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const DET_SIDE = 960; // longest side the detector sees
const [DET_THRESH, BOX_THRESH, UNCLIP] = [0.3, 0.6, 1.5]; // PaddleOCR's DB post-processing defaults
export const REC_H = 48;

/** 8-bit interleaved RGB. */
export type Bytes = { width: number; height: number; data: Uint8Array };
export type Point = [number, number];

/** Python's round() to an integer (halves to even). */
const pyRound = (x: number) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r;
};

// ------------------------------------------------------------------ resize (cv2.INTER_LINEAR, 8-bit)

const COEF = 2048; // INTER_RESIZE_COEF_SCALE

/** OpenCV's source index and fixed-point weights per output pixel along one axis. Columns past the
 *  edge are clamped with the weight on the edge; rows keep their weights and repeat the edge row. */
function linearTab(src: number, dst: number, clamp: boolean): { ofs: Int32Array; a: Int16Array } {
  const scale = src / dst;
  const ofs = new Int32Array(dst);
  const a = new Int16Array(dst * 2);
  for (let d = 0; d < dst; d++) {
    let f = Math.fround((d + 0.5) * scale - 0.5);
    let s = Math.floor(f);
    f = Math.fround(f - s);
    if (clamp && s < 0) [f, s] = [0, 0];
    if (clamp && s >= src - 1) [f, s] = [0, src - 1];
    ofs[d] = s;
    a[d * 2] = pyRound(Math.fround(1 - f) * COEF);
    a[d * 2 + 1] = pyRound(f * COEF);
  }
  return { ofs, a };
}

/** cv2.resize(…, INTER_LINEAR) of 8-bit RGB: horizontal ints, vertical fixed point, rounded. */
export function resizeLinear(img: Bytes, ow: number, oh: number): Bytes {
  const { width: w, height: h, data } = img;
  const xs = linearTab(w, ow, true);
  const ys = linearTab(h, oh, false);
  const row = (y: number) => {
    const out = new Int32Array(ow * 3);
    for (let x = 0; x < ow; x++) {
      const s = xs.ofs[x];
      const s1 = Math.min(s + 1, w - 1);
      for (let c = 0; c < 3; c++)
        out[x * 3 + c] = data[(y * w + s) * 3 + c] * xs.a[x * 2] + data[(y * w + s1) * 3 + c] * xs.a[x * 2 + 1];
    }
    return out;
  };
  const rows = new Map<number, Int32Array>();
  const get = (y: number) => {
    let r = rows.get(y);
    if (!r) {
      r = row(y);
      rows.set(y, r);
      if (rows.size > 4) rows.delete(rows.keys().next().value!);
    }
    return r;
  };
  const out = new Uint8Array(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    const s = ys.ofs[y];
    const [r0, r1] = [get(Math.min(Math.max(s, 0), h - 1)), get(Math.min(Math.max(s + 1, 0), h - 1))];
    const [b0, b1] = [ys.a[y * 2], ys.a[y * 2 + 1]];
    for (let i = 0; i < ow * 3; i++) {
      // OpenCV's vectorised rows: (S >> 4) * b >> 16 per row, then a rounding shift by 2
      const v = ((((r0[i] >> 4) * b0) >> 16) + (((r1[i] >> 4) * b1) >> 16) + 2) >> 2;
      out[y * ow * 3 + i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return { width: ow, height: oh, data: out };
}

// ------------------------------------------------------------------ detection

/** The detector's input size for an image: longest side ≤ 960, both multiples of 32. */
export function detSize(w: number, h: number): [number, number] {
  const f = Math.min(1, DET_SIDE / Math.max(h, w));
  return [Math.max(32, pyRound((w * f) / 32) * 32), Math.max(32, pyRound((h * f) / 32) * 32)];
}

/** Paddle's input: BGR, ImageNet mean / std (in that order over B, G, R, as it reads it), CHW. */
export function detInput(img: Bytes): Float32Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) {
      const v = Math.fround(data[i * 3 + 2 - c] / 255);
      out[c * n + i] = Math.fround(Math.fround(v - Math.fround(DET_MEAN[c])) / Math.fround(DET_STD[c]));
    }
  return out;
}

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (monotone chain) of points. */
function hull(pts: Point[]): Point[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower: Point[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Point[] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The minimum-area rectangle around points (cv2.minAreaRect): centre, unit axes, side lengths. */
export function minAreaRect(pts: Point[]): { c: Point; u: Point; v: Point; w: number; h: number } {
  const hp = hull(pts);
  let best = { c: hp[0] as Point, u: [1, 0] as Point, v: [0, 1] as Point, w: 0, h: 0, area: Infinity };
  const edges = hp.length > 1 ? hp.length : 1;
  for (let i = 0; i < edges; i++) {
    const [a, b] = [hp[i], hp[(i + 1) % hp.length]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: Point = len ? [(b[0] - a[0]) / len, (b[1] - a[1]) / len] : [1, 0];
    const v: Point = [-u[1], u[0]];
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of hp) {
      const [pu, pv] = [p[0] * u[0] + p[1] * u[1], p[0] * v[0] + p[1] * v[1]];
      [u0, u1, v0, v1] = [Math.min(u0, pu), Math.max(u1, pu), Math.min(v0, pv), Math.max(v1, pv)];
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) {
      const [mu, mv] = [(u0 + u1) / 2, (v0 + v1) / 2];
      best = { c: [mu * u[0] + mv * v[0], mu * u[1] + mv * v[1]], u, v, w: u1 - u0, h: v1 - v0, area };
    }
  }
  return best;
}

/** Corners as top-left, top-right, bottom-right, bottom-left (places._order). */
export function order(pts: Point[]): Point[] {
  const s = pts.map((p) => p[0] + p[1]);
  const d = pts.map((p) => p[1] - p[0]);
  const at = (v: number[], f: (a: number, b: number) => boolean) => v.reduce((k, x, i) => (f(x, v[k]) ? i : k), 0);
  return [
    pts[at(s, (a, b) => a < b)],
    pts[at(d, (a, b) => a < b)],
    pts[at(s, (a, b) => a > b)],
    pts[at(d, (a, b) => a > b)],
  ];
}

/**
 * Text boxes from the detector's probability map (DB post-processing, places.Ocr.boxes): every blob
 * over DET_THRESH, its minimum-area rectangle, kept when the mean probability over the blob (holes
 * filled, as fillPoly of its contour does) is ≥ BOX_THRESH, grown by the unclip ratio, in the
 * image's pixels (w × h), top to bottom.
 */
export function boxes(pred: Float32Array, dw: number, dh: number, w: number, h: number): Point[][] {
  const on = new Uint8Array(dw * dh);
  for (let i = 0; i < on.length; i++) on[i] = pred[i] > DET_THRESH ? 1 : 0;
  const label = new Int32Array(dw * dh).fill(-1);
  const out: Point[][] = [];
  let blobs = 0;
  for (let start = 0; start < on.length && blobs < 1000; start++) {
    if (!on[start] || label[start] >= 0) continue;
    // the blob (8-connected, like findContours' outer borders)
    const pix: number[] = [start];
    label[start] = blobs;
    let [x0, y0, x1, y1] = [dw, dh, 0, 0];
    for (let k = 0; k < pix.length; k++) {
      const [x, y] = [pix[k] % dw, (pix[k] / dw) | 0];
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const [nx, ny] = [x + dx, y + dy];
          if (nx < 0 || ny < 0 || nx >= dw || ny >= dh) continue;
          const j = ny * dw + nx;
          if (on[j] && label[j] < 0) {
            label[j] = blobs;
            pix.push(j);
          }
        }
    }
    blobs++;
    const r = minAreaRect(pix.map((i) => [i % dw, (i / dw) | 0]));
    if (Math.min(r.w, r.h) < 3) continue;
    // mean probability over the blob and its holes: what isn't reached from the box's edge
    const [bw, bh] = [x1 - x0 + 3, y1 - y0 + 3];
    const outside = new Uint8Array(bw * bh);
    const inBlob = (x: number, y: number) => {
      const [gx, gy] = [x + x0 - 1, y + y0 - 1];
      return gx >= 0 && gy >= 0 && gx < dw && gy < dh && label[gy * dw + gx] === blobs - 1;
    };
    const stack = [0];
    outside[0] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const [x, y] = [i % bw, (i / bw) | 0];
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const j = ny * bw + nx;
        if (!outside[j] && !inBlob(nx, ny)) {
          outside[j] = 1;
          stack.push(j);
        }
      }
    }
    let [sum, n] = [0, 0];
    for (let y = 1; y < bh - 1; y++)
      for (let x = 1; x < bw - 1; x++)
        if (!outside[y * bw + x]) {
          sum += pred[(y + y0 - 1) * dw + x + x0 - 1];
          n++;
        }
    if (!n || sum / n < BOX_THRESH) continue;
    const grow = (r.w * r.h * UNCLIP) / (2 * (r.w + r.h)); // pyclipper's offset of a rectangle
    const [gw, gh] = [r.w + 2 * grow, r.h + 2 * grow];
    if (Math.min(gw, gh) < 5) continue;
    const [sx, sy] = [Math.fround(w / dw), Math.fround(h / dh)];
    const corner = (a: number, b: number): Point => [
      Math.fround(r.c[0] + (a * gw * r.u[0]) / 2 + (b * gh * r.v[0]) / 2) * sx,
      Math.fround(r.c[1] + (a * gw * r.u[1]) / 2 + (b * gh * r.v[1]) / 2) * sy,
    ];
    out.push(order([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]));
  }
  const key = (p: Point[]) => [
    pyRound((p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4 / 20),
    Math.min(...p.map((q) => q[0])),
  ];
  return out.sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
}

// ------------------------------------------------------------------ the crop

/** The 3×3 homography taking the four `from` points to the four `to` points (getPerspectiveTransform). */
export function homography(from: Point[], to: Point[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [[x, y], [u, v]] = [from[i], to[i]];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++)
      if (r !== c) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
      }
  }
  return [...A.map((r, i) => r[8] / r[i]), 1];
}

/** OpenCV's interpolateCubic (A = −0.75), in float. */
const cubic = (x: number) => {
  const f = Math.fround;
  const A = -0.75;
  const [x0, x1, x2] = [f(x + 1), f(x), f(1 - x)];
  const c0 = f(f(f(f(f(A * x0) - 5 * A) * x0) + 8 * A) * x0 - 4 * A);
  const c1 = f(f(f(f((A + 2) * x1) - (A + 3)) * x1) * x1 + 1);
  const c2 = f(f(f(f((A + 2) * x2) - (A + 3)) * x2) * x2 + 1);
  return [c0, c1, c2, f(1 - c0 - c1 - c2)];
};

/** cv2.warpPerspective(img, getPerspectiveTransform(pts, [0,0],[tw,0],[tw,th],[0,th]), (tw, th),
 *  INTER_CUBIC, BORDER_REPLICATE): the box cut out and straightened. */
export function crop(img: Bytes, pts: Point[], tw: number, th: number): Bytes {
  const inv = homography(
    [
      [0, 0],
      [tw, 0],
      [tw, th],
      [0, th],
    ],
    pts.map(([x, y]) => [Math.fround(x), Math.fround(y)]), // float32, as the box is in Python
  );
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(tw * th * 3);
  const f = Math.fround;
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      // OpenCV 5 samples at the exact point with float weights (no 1/32 grid, unlike remap with fixed maps)
      const W = inv[6] * x + inv[7] * y + inv[8];
      const X = f((inv[0] * x + inv[1] * y + inv[2]) / W);
      const Y = f((inv[3] * x + inv[4] * y + inv[5]) / W);
      const [ix, iy] = [Math.floor(X), Math.floor(Y)];
      const [cx, cy] = [cubic(f(X - ix)), cubic(f(Y - iy))];
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let j = 0; j < 4; j++) {
          const py = Math.min(h - 1, Math.max(0, iy - 1 + j));
          let r = 0;
          for (let i = 0; i < 4; i++)
            r = f(r + f(data[(py * w + Math.min(w - 1, Math.max(0, ix - 1 + i))) * 3 + c] * cx[i]));
          acc = f(acc + f(r * cy[j]));
        }
        const v = pyRound(acc);
        out[(y * tw + x) * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  return { width: tw, height: th, data: out };
}

/** np.rot90: a quarter turn counterclockwise. */
export function rot90(img: Bytes): Bytes {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < h; x++)
      for (let c = 0; c < 3; c++) out[(y * h + x) * 3 + c] = data[(x * w + (w - 1 - y)) * 3 + c];
  return { width: h, height: w, data: out };
}

/** The straightened crops of the boxes, ready for the recogniser (turned when taller than wide). */
export function crops(img: Bytes, bs: Point[][]): Bytes[] {
  const out: Bytes[] = [];
  const dist = (a: Point, b: Point) => Math.hypot(Math.fround(a[0] - b[0]), Math.fround(a[1] - b[1]));
  for (const p of bs) {
    const tw = Math.trunc(Math.max(dist(p[0], p[1]), dist(p[3], p[2])));
    const th = Math.trunc(Math.max(dist(p[0], p[3]), dist(p[1], p[2])));
    if (tw < 4 || th < 4) continue;
    const c = crop(img, p, tw, th);
    out.push(th / tw >= 1.5 ? rot90(c) : c);
  }
  return out;
}

// ------------------------------------------------------------------ recognition

/** The recogniser's input for a crop: height 48, width in proportion (24 … 1920), BGR, (x/255 − 0.5)/0.5. */
export function recInput(c: Bytes): { data: Float32Array; width: number } {
  const rw = Math.trunc(Math.min(REC_H * 40, Math.max(REC_H / 2, Math.ceil((REC_H * c.width) / c.height))));
  const r = resizeLinear(c, rw, REC_H);
  const n = rw * REC_H;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++)
    for (let ch = 0; ch < 3; ch++)
      out[ch * n + i] = Math.fround(Math.fround(Math.fround(r.data[i * 3 + 2 - ch] / 255) - 0.5) / 0.5);
  return { data: out, width: rw };
}

/** Greedy CTC over the recogniser's [steps × classes] probabilities: blank 0, repeats merged. */
export function ctc(
  p: Float32Array,
  steps: number,
  classes: number,
  chars: string[],
): { text: string; confidence: number } {
  const text: string[] = [];
  const confs: number[] = [];
  let prev = 0;
  for (let t = 0; t < steps; t++) {
    let [best, conf] = [0, -Infinity];
    for (let k = 0; k < classes; k++) if (p[t * classes + k] > conf) [best, conf] = [k, p[t * classes + k]];
    if (best !== prev && best !== 0 && best < chars.length) {
      text.push(chars[best]);
      confs.push(conf);
    }
    prev = best;
  }
  return { text: text.join("").trim(), confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0 };
}

/** The recogniser's alphabet: CTC's blank, dict.txt, then the space PaddleOCR appends. */
export const alphabet = (dict: string) => ["", ...dict.split("\n").slice(0, -1), " "];
