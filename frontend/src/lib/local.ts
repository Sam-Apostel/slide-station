// Local adjustments: masks and where they sit on screen. The mask maths is imaging.local_mask
// (slidestation/imaging.py), shared by the browser pipeline (standalone/imaging.ts) and the stage's
// mask overlay; keep it identical to Python and SlideKit (parity.test.ts checks).
import type { Local, LocalSlider, Params, Pt } from "@/lib/api";

/** Masks are drawn on a grid this many cells along the picture's longer edge, at any resolution. */
export const MASK_EDGE = 1024;
export const LOCAL_SLIDERS: LocalSlider[] = ["exposure", "contrast", "warmth", "tint", "saturation"];
export const LOCAL_MAX = 16;

export type Mask = { width: number; height: number; data: Float32Array };

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * An adjustment's mask (0..1) for a w x h picture, on the mask grid: `edge` cells along the longer
 * edge (MASK_EDGE for rendering; the overlay may ask for fewer). Cell (i, j) is centred on picture
 * point ((i + 0.5) / kx, (j + 0.5) / ky).
 */
export function localMask(adj: Local, w: number, h: number, edge = MASK_EDGE): Mask {
  const s = Math.max(w, h);
  const kx = (edge * w) / s; // 0..1 of the picture -> cells
  const ky = (edge * h) / s;
  const gw = Math.ceil(kx);
  const gh = Math.ceil(ky);
  const m = new Float32Array(gw * gh);
  const cell = (p: Pt): Pt => [p[0] * kx - 0.5, p[1] * ky - 0.5];
  if (adj.kind === "brush") {
    const acc = new Float64Array(gw * gh);
    for (const st of adj.strokes) {
      const rad = st.radius * edge;
      const pts = st.points.map(cell);
      const segs: [Pt, Pt][] = pts.length > 1 ? pts.slice(1).map((q, i) => [pts[i], q]) : [[pts[0], pts[0]]];
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const x0 = Math.max(0, Math.floor(Math.min(...xs) - rad));
      const x1 = Math.min(gw, Math.ceil(Math.max(...xs) + rad) + 1);
      const y0 = Math.max(0, Math.floor(Math.min(...ys) - rad));
      const y1 = Math.min(gh, Math.ceil(Math.max(...ys) + rad) + 1);
      if (x0 >= x1 || y0 >= y1) continue;
      const bw = x1 - x0;
      const d2 = new Float64Array(bw * (y1 - y0)).fill(Infinity);
      for (const [[ax, ay], [bx, by]] of segs) {
        // each segment only near itself
        const sx0 = Math.max(x0, Math.floor(Math.min(ax, bx) - rad));
        const sx1 = Math.min(x1, Math.ceil(Math.max(ax, bx) + rad) + 1);
        const sy0 = Math.max(y0, Math.floor(Math.min(ay, by) - rad));
        const sy1 = Math.min(y1, Math.ceil(Math.max(ay, by) + rad) + 1);
        const vx = bx - ax;
        const vy = by - ay;
        const ll = vx * vx + vy * vy;
        for (let y = sy0; y < sy1; y++) {
          for (let x = sx0; x < sx1; x++) {
            const t = ll > 0 ? clamp(((x - ax) * vx + (y - ay) * vy) / ll, 0, 1) : 0;
            const dx = x - (ax + t * vx);
            const dy = y - (ay + t * vy);
            const i = (y - y0) * bw + (x - x0);
            const d = dx * dx + dy * dy;
            if (d < d2[i]) d2[i] = d;
          }
        }
      }
      const hard = st.hardness;
      const soft = Math.max(1 - hard, 1e-3);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const u = Math.sqrt(d2[(y - y0) * bw + (x - x0)]) / rad;
          const c = st.flow * (1 - smooth(clamp((u - hard) / soft, 0, 1)));
          const i = y * gw + x;
          acc[i] = st.erase ? acc[i] * (1 - c) : acc[i] + c * (1 - acc[i]);
        }
      }
    }
    m.set(acc);
    return { width: gw, height: gh, data: m };
  }
  if (adj.kind === "graduated") {
    const [ax, ay] = cell(adj.start);
    const [bx, by] = cell(adj.end);
    const vx = bx - ax;
    const vy = by - ay;
    const ll = Math.max(vx * vx + vy * vy, 1e-9);
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) m[y * gw + x] = 1 - smooth(clamp(((x - ax) * vx + (y - ay) * vy) / ll, 0, 1));
  } else {
    const [cx, cy] = cell(adj.center);
    const th = (adj.angle * Math.PI) / 180; // clockwise on screen
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const rx = adj.rx * edge;
    const ry = adj.ry * edge;
    const f = Math.max(adj.feather, 1e-3);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const qx = ((x - cx) * cs + (y - cy) * sn) / rx;
        const qy = (-(x - cx) * sn + (y - cy) * cs) / ry;
        const v = smooth(clamp((1 - Math.sqrt(qx * qx + qy * qy)) / f, 0, 1));
        m[y * gw + x] = adj.invert ? 1 - v : v;
      }
    }
  }
  return { width: gw, height: gh, data: m };
}

// ------------------------------------------------------------------ on screen

/**
 * Where the picture (the frame masks live in: trimmed, turned, not yet straightened or cropped)
 * sits in the displayed photo. `aspect` is the displayed photo's width / height; everything else
 * comes from the params. Units: fractions of the displayed photo.
 */
export class PictureView {
  /** Picture width / height. */
  readonly aspect: number;
  private readonly crop: [number, number, number, number];
  private readonly cs: number;
  private readonly sn: number;
  /** straighten()'s zoom. */
  readonly scale: number;
  readonly angle: number;

  constructor(shownAspect: number, p: Pick<Params, "angle" | "crop">) {
    this.crop = p.crop ?? [0, 0, 1, 1];
    const [l, t, r, b] = this.crop;
    this.aspect = (shownAspect * (b - t)) / (r - l);
    this.angle = Math.abs(p.angle ?? 0) >= 0.01 ? (p.angle ?? 0) : 0;
    const th = (Math.abs(this.angle) * Math.PI) / 180;
    const a = this.aspect;
    this.scale = Math.cos(th) + (Math.sin(th) * Math.max(a, 1)) / Math.min(a, 1);
    this.cs = Math.cos((this.angle * Math.PI) / 180);
    this.sn = Math.sin((this.angle * Math.PI) / 180);
  }

  /** The picture's longer edge in units of its height (lengths are fractions of it). */
  get long() {
    return Math.max(this.aspect, 1);
  }

  /** Picture point -> displayed photo (0..1 each way, may fall outside). */
  toShown([u, v]: Pt): Pt {
    const a = this.aspect;
    const [l, t, r, b] = this.crop;
    const dx = u * a - a / 2;
    const dy = v - 0.5;
    const ox = a / 2 + this.scale * (this.cs * dx - this.sn * dy);
    const oy = 0.5 + this.scale * (this.sn * dx + this.cs * dy);
    return [(ox / a - l) / (r - l), (oy - t) / (b - t)];
  }

  /** Displayed photo point -> picture. */
  fromShown([x, y]: Pt): Pt {
    const a = this.aspect;
    const [l, t, r, b] = this.crop;
    const dx = (l + x * (r - l)) * a - a / 2;
    const dy = t + y * (b - t) - 0.5;
    const px = a / 2 + (this.cs * dx + this.sn * dy) / this.scale;
    const py = 0.5 + (-this.sn * dx + this.cs * dy) / this.scale;
    return [px / a, py];
  }
}

// ------------------------------------------------------------------ new adjustments

const NONE = { exposure: 0, contrast: 0, warmth: 0, tint: 0, saturation: 0 };

/** A new adjustment of that kind, placed for the usual job: a graduated filter burns the sky in,
 *  a radial lifts the middle, a brush starts empty. */
export function newLocal(kind: Local["kind"], at?: Pt): Local {
  if (kind === "graduated") return { kind, ...NONE, exposure: -0.35, start: [0.5, 0.05], end: [0.5, 0.45] };
  if (kind === "radial")
    return {
      kind,
      ...NONE,
      exposure: 0.35,
      center: at ?? [0.5, 0.55],
      rx: 0.22,
      ry: 0.16,
      angle: 0,
      feather: 0.6,
      invert: false,
    };
  return { kind, ...NONE, exposure: 0.35, strokes: [] };
}

export const LOCAL_NAMES: Record<Local["kind"], string> = {
  graduated: "Graduated",
  radial: "Radial",
  brush: "Brush",
};

/** "Radial · exposure +35" */
export function localSummary(adj: Local): string {
  const parts = LOCAL_SLIDERS.filter((k) => Math.abs(adj[k]) > 0.004).map((k) => {
    const n = Math.round(adj[k] * 100);
    return `${k} ${n > 0 ? "+" : "−"}${Math.abs(n)}`;
  });
  return parts.join(", ") || "no change yet";
}
