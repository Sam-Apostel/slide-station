// Film stock per slide: the guess from how it faded, k-NN over labelled slides, and the years each
// stock was sold (slidestation/filmstock.py, function by function; its docstrings say why). No
// model: the same numbers as the desktop app, and the same stocks.json in the library.
import type { Suggestion } from "@/lib/api";
import { estimate, parseDate, type DateEst, type GroupData, type SessionData } from "./store";

export const STOCKS = ["kodachrome", "ektachrome", "agfachrome", "fujichrome", "other", "unknown"] as const;
/** What a label (and so a suggestion, and a learning example's "s") can be. */
export const STOCK_CLASSES = ["kodachrome", "ektachrome", "agfachrome", "fujichrome", "other"] as const;
type Stock = (typeof STOCK_CLASSES)[number];

/** Years each stock was on sale for 35 mm slides (null: still made); approximate, see filmstock.py. */
export const ERAS: Record<string, [number, number | null]> = {
  kodachrome: [1936, 2010],
  ektachrome: [1955, null],
  agfachrome: [1936, 2005],
  fujichrome: [1948, null],
};

export const SOURCE = "fade-heuristic";
export const DATE_SOURCE = "neighbours+stock";
export const HEURISTIC_TRUST = 0.75;
const UNKNOWN_MASS = 0.3;
export const SUGGEST_FROM = 0.3;
const TRAY_WEIGHT = 0.5;
export const MIN_PER_STOCK = 5;
const K = 7;
const MAX_DISTANCE = 3.0;
const N_FEATS = 13;

export type EraHint = { stock: string; from: number; to: number | null; fits: boolean | null };

/** A stock as sent by the UI: one of STOCKS, or "" (not set); null when it's none of those. */
export function cleanStock(v: unknown): string | null {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return !s || (STOCKS as readonly string[]).includes(s) ? s : null;
}

/** The slide's own stock, else the tray's ("" when neither is set). */
export const effective = (d: SessionData, g: GroupData) => g.stock || d.stock || "";

const isClass = (s: string): s is Stock => (STOCK_CLASSES as readonly string[]).includes(s);

export function fits(year: number, stock: string): boolean {
  const e = ERAS[stock];
  return !e || (e[0] <= year && (e[1] === null || year <= e[1]));
}

// ------------------------------------------------------------------ heuristic

const sig = (x: number) => 1 / (1 + Math.exp(-x));

/** A guess from the fade signature, as probabilities per stock (the rest is "unknown"). */
export function heuristic(f: number[]): Record<string, number> {
  const [lo, hi] = [f.slice(0, 3), f.slice(6, 9)];
  const black = Math.min(...lo);
  const contrast = f[10];
  const red = (f[11] + 3 * (lo[0] - lo[1]) + (hi[0] - hi[1])) / 3;
  const blue = (f[12] + 3 * (lo[2] - lo[1]) + (hi[2] - hi[1])) / 3;
  const cast = Math.hypot(red, blue);
  const lifted = sig((black - 0.05) / 0.025);
  const s: Record<string, number> = {
    kodachrome: sig((0.06 - cast) / 0.02) * sig((contrast - 0.45) / 0.08) * sig((0.04 - black) / 0.015),
    ektachrome: sig((red - 0.05) / 0.03) * sig((blue + 0.04) / 0.04) * (0.4 + 0.6 * lifted),
    agfachrome: sig((-red - 0.05) / 0.03) * sig((blue + 0.04) / 0.04) * (0.5 + 0.5 * lifted),
  };
  const total = s.kodachrome + s.ektachrome + s.agfachrome + UNKNOWN_MASS;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, (HEURISTIC_TRUST * v) / total]));
}

// ------------------------------------------------------------------ labels, k-NN

export type StockExample = { key: string; f: number[]; s: string; t: number };

/** Slides whose stock you set, as k-NN examples: the library's stocks.json. `save` persists the JSON. */
export class Labels {
  examples: StockExample[];
  known: string[] = [];
  private ex: StockExample[] = [];
  private X: number[][] | null = null;
  private mu: number[] = [];
  private sd: number[] = [];

  constructor(
    data: unknown,
    private save: (json: unknown) => void = () => {},
  ) {
    const ex = (data as { examples?: StockExample[] } | null)?.examples;
    this.examples = Array.isArray(ex) ? ex : [];
    this.fit();
  }

  private fit() {
    const n: Record<string, number> = {};
    for (const e of this.examples) n[e.s] = (n[e.s] ?? 0) + 1;
    this.known = STOCK_CLASSES.filter((k) => (n[k] ?? 0) >= MIN_PER_STOCK).sort();
    this.X = null;
    if (this.known.length < 2) return; // one stock alone can't tell anything apart
    this.ex = this.examples.filter((e) => this.known.includes(e.s) && e.f.length >= N_FEATS);
    const rows = this.ex.map((e) => e.f.slice(0, N_FEATS));
    const m = rows.length;
    this.mu = Array.from({ length: N_FEATS }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / m);
    this.sd = Array.from(
      { length: N_FEATS },
      (_, j) => Math.sqrt(rows.reduce((s, r) => s + (r[j] - this.mu[j]) ** 2, 0) / m) + 1e-3,
    );
    this.X = rows.map((r) => r.map((v, j) => (v - this.mu[j]) / this.sd[j]));
  }

  private persist() {
    this.save({ version: 1, examples: this.examples });
    this.fit();
  }

  remember(key: string, feats: number[], stock: string) {
    const entry = { key, f: feats.map((x) => Math.round(x * 1e5) / 1e5), s: stock, t: Date.now() / 1000 };
    const i = this.examples.findIndex((e) => e.key === key);
    if (i >= 0) {
      const e = this.examples[i];
      if (e.s === stock && e.f.length === entry.f.length && e.f.every((v, j) => v === entry.f[j])) return;
      this.examples[i] = entry;
    } else this.examples.push(entry);
    this.persist();
  }

  forget(key: string) {
    const n = this.examples.length;
    this.examples = this.examples.filter((e) => e.key !== key);
    if (this.examples.length !== n) this.persist();
  }

  /** Probabilities per stock from the nearest labelled slides (shrunk by n / (n + 1)), or null. */
  predict(feats: number[]): [Record<string, number> | null, number] {
    if (!this.X || feats.length < N_FEATS) return [null, 0];
    const q = feats.slice(0, N_FEATS).map((v, j) => (v - this.mu[j]) / this.sd[j]);
    const d = this.X.map((x) => Math.sqrt(x.reduce((s, v, j) => s + (v - q[j]) ** 2, 0) / N_FEATS));
    const idx = d
      .map((_, i) => i)
      .sort((a, b) => d[a] - d[b] || a - b) // stable, like numpy's kind="stable"
      .slice(0, K)
      .filter((i) => d[i] <= MAX_DISTANCE);
    if (!idx.length) return [null, 0];
    const w0 = idx.map((i) => 1 / (d[i] + 0.25));
    const ws = w0.reduce((s, v) => s + v, 0);
    const shrink = idx.length / (idx.length + 1);
    const out: Record<string, number> = Object.fromEntries(this.known.map((k) => [k, 0]));
    idx.forEach((i, n) => (out[this.ex[i].s] += (w0[n] / ws) * shrink));
    return [out, idx.length];
  }
}

/** Keep the slide's label in step with its stock (filmstock.label). */
export function label(labels: Labels, d: SessionData, g: GroupData) {
  const key = `${d.id}:${g.id}`;
  const st = effective(d, g);
  if (g.skip || !isClass(st) || !g.feat?.length) labels.forget(key);
  else labels.remember(key, g.feat, st);
}

// ------------------------------------------------------------------ suggestions

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Per slide, the stock to suggest, or null (filmstock.stock_suggestions). */
export function stockSuggestions(d: SessionData, labels: Labels): (Suggestion | null)[] {
  const per = d.groups.map((g): [Record<string, number>, string] | null => {
    const st = effective(d, g);
    if (g.skip) return null;
    if (isClass(st)) return [{ [st]: 1 }, "label"]; // a label counts fully towards the tray's average
    if ((g.feat?.length ?? 0) < N_FEATS) return null;
    // the heuristic keeps its say on the stocks the k-NN has no labels of (filmstock._guess)
    const h = heuristic(g.feat!);
    const [p, n] = labels.predict(g.feat!);
    if (!p) return [h, SOURCE];
    const unknown = Object.keys(h).filter((k) => !(k in p));
    const rest = unknown.reduce((s, k) => s + h[k], 0);
    return [
      {
        ...Object.fromEntries(unknown.map((k) => [k, h[k]])),
        ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v * (1 - rest)])),
      },
      `knn:${n}`,
    ];
  });
  const known = per.flatMap((x) => (x ? [x[0]] : []));
  const tray: Record<string, number> = Object.fromEntries(
    STOCK_CLASSES.map((k) => [k, known.length ? known.reduce((s, p) => s + (p[k] ?? 0), 0) / known.length : 0]),
  );
  return per.map((x) => {
    if (!x || x[1] === "label") return null;
    const [p, source] = x;
    const mix = STOCK_CLASSES.map((k) => (1 - TRAY_WEIGHT) * (p[k] ?? 0) + TRAY_WEIGHT * tray[k]);
    let best = 0;
    mix.forEach((v, i) => v > mix[best] && (best = i)); // ties: the first
    const c = round3(mix[best]);
    const value = STOCK_CLASSES[best];
    // a stock the k-NN doesn't know is the heuristic's guess
    const from = labels.known.includes(value) ? source : SOURCE;
    return c >= SUGGEST_FROM ? { value, confidence: c, source: from, state: "suggested" } : null;
  });
}

const year = (v: string) => Number(v.slice(0, 4));

/** Per slide, a date from its tray neighbours bounded by its stock's era (filmstock.date_suggestions). */
export function dateSuggestions(d: SessionData, dates: DateEst[]): (Suggestion | null)[] {
  const stocks = d.groups.map((g) => effective(d, g));
  const own = d.groups.map((g) => parseDate(g.date));
  return d.groups.map((g, i) => {
    const st = stocks[i];
    if (own[i] || g.skip || !ERAS[st]) return null;
    const same = own.flatMap((x, j) => (x && stocks[j] === st ? [j] : []));
    const hit = estimate(own, i, same);
    let value: string;
    let conf: number;
    if (hit) [value, conf] = [hit[0], hit[1] === "between" ? 0.6 : 0.45];
    else if (["between", "near", "tray"].includes(dates[i].source) && dates[i].value)
      [value, conf] = [dates[i].value, { between: 0.45, near: 0.35, tray: 0.3 }[dates[i].source as "tray"]];
    else return null;
    if (!fits(year(value), st)) return null;
    return { value, confidence: conf, source: DATE_SOURCE, state: "suggested" };
  });
}

/** For slideDates: the slide's stock era and whether the date shown lies inside it. */
export function eraHint(d: SessionData, g: GroupData, value: string): EraHint | null {
  const st = effective(d, g);
  const e = ERAS[st];
  if (!e) return null;
  return { stock: st, from: e[0], to: e[1], fits: value ? fits(year(value), st) : null };
}

const ours = (s: string) => s === SOURCE || s === DATE_SOURCE || s.startsWith("knn:");

/** What a slide shows for one kind: stored decision or model suggestion vs. the live guess (filmstock._merged). */
function merged(stored: Suggestion | null | undefined, live: Suggestion | null): Suggestion | null {
  if (stored?.state === "suggested" && !ours(stored.source)) return stored;
  if (live && !(stored && stored.value === live.value && stored.state !== "suggested")) return live;
  return stored ?? null;
}

export type StockView = { stock: Suggestion | null; date: Suggestion | null };

/** Per slide, the live film stock and date guesses merged with the decisions stored in g.insights. */
export function views(d: SessionData, dates: DateEst[], labels: Labels): StockView[] {
  const stock = stockSuggestions(d, labels);
  const date = dateSuggestions(d, dates);
  return d.groups.map((g, i) => ({
    stock: merged(g.insights?.stock, stock[i]),
    date: merged(g.insights?.date, date[i]),
  }));
}
