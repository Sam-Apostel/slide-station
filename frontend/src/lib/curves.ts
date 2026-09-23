// Tone curves: the same monotone cubic as slidestation/imaging.py (curve_lut), so what is drawn is
// what gets rendered.

export type CurveChannel = "rgb" | "r" | "g" | "b";
export type Point = [number, number];
export type Curves = Partial<Record<CurveChannel, Point[]>>;

export const CHANNELS: CurveChannel[] = ["rgb", "r", "g", "b"];
export const STRAIGHT: Point[] = [
  [0, 0],
  [1, 1],
];
/** Closest two points may sit on the input axis (the server drops the second of a closer pair). */
export const MIN_GAP = 0.01;

export const curveOf = (c: Curves | undefined, ch: CurveChannel): Point[] => c?.[ch] ?? STRAIGHT;

export const isStraight = (pts: Point[] | undefined) =>
  !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1);

/** Drops straight channels, so an untouched curve is `{}` like on the server. */
export function withChannel(c: Curves | undefined, ch: CurveChannel, pts: Point[] | null): Curves {
  const next: Curves = { ...c };
  if (!pts || isStraight(pts)) delete next[ch];
  else next[ch] = pts;
  return next;
}

/** Evaluator for a curve: Fritsch–Carlson monotone cubic, flat beyond the end points. */
export function spline(pts: Point[]): (x: number) => number {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const n = xs.length;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  if (n === 2) {
    return (x) => {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[1]) return ys[1];
      return clamp(ys[0] + ((ys[1] - ys[0]) * (x - xs[0])) / (xs[1] - xs[0]));
    };
  }
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  const d = ys.slice(1).map((y, i) => (y - ys[i]) / h[i]);
  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const r = a * a + b * b;
    if (r > 9) {
      const k = 3 / Math.sqrt(r);
      m[i] = k * a * d[i];
      m[i + 1] = k * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x >= xs[i + 1]) i++;
    const u = (x - xs[i]) / h[i];
    const u2 = u * u;
    const u3 = u2 * u;
    return clamp(
      (2 * u3 - 3 * u2 + 1) * ys[i] +
        (u3 - 2 * u2 + u) * h[i] * m[i] +
        (-2 * u3 + 3 * u2) * ys[i + 1] +
        (u3 - u2) * h[i] * m[i + 1],
    );
  };
}
