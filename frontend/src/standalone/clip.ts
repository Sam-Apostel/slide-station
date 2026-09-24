// Scene tags from CLIP (slidestation/insights.py, function by function): the label list and its key,
// CLIP's BPE tokenizer, the image preprocessing (Pillow's bicubic resize, reproduced in integer
// arithmetic like Pillow does it, so the model sees the same 224 × 224 pixels as in the desktop app),
// the zero-shot softmax and the learned thresholds. The ONNX model itself runs in the jobs worker
// (engine.worker.ts); the files are downloaded into the library by models.ts.
import type { RGB } from "./pixels";
import { pyDumps, sha1Hex } from "./store";

// (tag, prompt), exactly insights.LABELS: the tag is what the user sees, the prompt what CLIP compares
export const LABELS: [string, string][] = [
  ["beach", "a photo of a beach"],
  ["sea", "a photo of the sea"],
  ["lake", "a photo of a lake"],
  ["snow", "a photo of snow"],
  ["skiing", "a photo of people skiing"],
  ["mountains", "a photo of mountains"],
  ["forest", "a photo of a forest"],
  ["landscape", "a landscape photo"],
  ["sunset", "a photo of a sunset"],
  ["city", "a photo of a city"],
  ["street", "a photo of a street"],
  ["village", "a photo of a village"],
  ["church", "a photo of a church"],
  ["castle", "a photo of a castle"],
  ["wedding", "a photo of a wedding"],
  ["birthday", "a photo of a birthday party"],
  ["christmas", "a photo of christmas"],
  ["party", "a photo of a party"],
  ["car", "a photo of a car"],
  ["train", "a photo of a train"],
  ["airplane", "a photo of an airplane"],
  ["boat", "a photo of a boat"],
  ["dog", "a photo of a dog"],
  ["cat", "a photo of a cat"],
  ["horse", "a photo of a horse"],
  ["garden", "a photo of a garden"],
  ["flowers", "a photo of flowers"],
  ["family group", "a group photo of a family"],
  ["portrait", "a portrait photo of a person"],
  ["children", "a photo of children playing"],
  ["baby", "a photo of a baby"],
  ["interior", "a photo of a room interior"],
  ["food", "a photo of food on a table"],
  ["camping", "a photo of a tent at a campsite"],
  ["swimming pool", "a photo of a swimming pool"],
];
export const TAGS = LABELS.map(([t]) => t);
export const LABELS_KEY = sha1Hex(pyDumps(LABELS)).slice(0, 8);

export const THRESHOLD = 0.12; // softmax share a label needs before it is suggested
export const MAX_TAGS = 4;
const LOGIT_SCALE = 100; // CLIP's learned temperature

export const MODEL_ID = "clip-vit-b32";
export const MEAN = [0.48145466, 0.4578275, 0.40821073];
export const STD = [0.26862954, 0.26130258, 0.27577711];

// ------------------------------------------------------------------ tokenizer

/** GPT-2's byte -> printable character map (shared by CLIP's and BART's BPE). */
export function bytesToUnicode(): string[] {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++)
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  const out = new Array<string>(256);
  bs.forEach((b, i) => (out[b] = String.fromCodePoint(cs[i])));
  return out;
}

/** CLIP's byte-level BPE (insights.Tokenizer: OpenAI's simple_tokenizer without ftfy). */
export class Tokenizer {
  static SOT = "<|startoftext|>";
  static EOT = "<|endoftext|>";
  // Python's r"'s|'t|'re|'ve|'m|'ll|'d|[^\W\d_]+|\d|[^\s\w]+|_+" with re.IGNORECASE, in Unicode classes
  static PAT = /'s|'t|'re|'ve|'m|'ll|'d|[\p{L}\p{Nl}\p{No}]+|\p{Nd}|[^\s\p{L}\p{N}_]+|_+/giu;
  private ranks = new Map<string, number>();
  private byteEncoder = bytesToUnicode();

  constructor(
    private encoder: Record<string, number>,
    merges: string,
  ) {
    let i = 0;
    for (const m of merges.split("\n")) {
      if (!m || m.startsWith("#version")) continue;
      const p = m.split(/\s+/).filter(Boolean);
      this.ranks.set(`${p[0]} ${p[1]}`, i++);
    }
  }

  private bpe(token: string): string[] {
    const chars = Array.from(token);
    let word = [...chars.slice(0, -1), chars[chars.length - 1] + "</w>"];
    while (word.length > 1) {
      let best: string | null = null;
      let bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) {
        const r = this.ranks.get(`${word[i]} ${word[i + 1]}`);
        if (r !== undefined && r < bestRank) [best, bestRank] = [`${word[i]} ${word[i + 1]}`, r];
      }
      if (best === null) break;
      const out: string[] = [];
      for (let i = 0; i < word.length; ) {
        if (i < word.length - 1 && `${word[i]} ${word[i + 1]}` === best) {
          out.push(word[i] + word[i + 1]);
          i += 2;
        } else out.push(word[i++]);
      }
      word = out;
    }
    return word;
  }

  encode(text: string): number[] {
    const t = text.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
    const ids = [this.encoder[Tokenizer.SOT]];
    for (const m of t.matchAll(Tokenizer.PAT)) {
      const tok = Array.from(new TextEncoder().encode(m[0]), (b) => this.byteEncoder[b]).join("");
      for (const piece of this.bpe(tok)) ids.push(this.encoder[piece]);
    }
    return [...ids, this.encoder[Tokenizer.EOT]].slice(0, 77);
  }
}

/** The label prompts as one batch of token ids, padded with end-of-text (the model pools at the
 *  first, highest-id end-of-text token), as insights.Clip.text_embed feeds them. */
export function promptBatch(tok: Tokenizer, prompts = LABELS.map(([, p]) => p)): { ids: number[][]; length: number } {
  const ids = prompts.map((p) => tok.encode(p));
  const n = Math.max(...ids.map((x) => x.length));
  const eot = ids[0][ids[0].length - 1];
  return { ids: ids.map((x) => [...x, ...new Array(n - x.length).fill(eot)]), length: n };
}

// ------------------------------------------------------------------ preprocessing (Pillow's resize)

const PRECISION_BITS = 32 - 8 - 2; // Pillow's fixed point for 8-bit images

function bicubic(x: number) {
  const a = -0.5;
  if (x < 0) x = -x;
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}

/** Pillow's precompute_coeffs + normalize_coeffs_8bpc: per output pixel its first input pixel,
 *  count, and integer weights. */
function coeffs(inSize: number, outSize: number) {
  const scale = inSize / outSize;
  const filterscale = Math.max(1, scale);
  const support = 2 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const w = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const ss = 1 / filterscale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5)) - xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      w[x] = bicubic((x + xmin - center + 0.5) * ss);
      ww += w[x];
    }
    for (let x = 0; x < xmax; x++) {
      const k = ww !== 0 ? w[x] / ww : w[x];
      kk[xx * ksize + x] = Math.trunc(k < 0 ? -0.5 + k * (1 << PRECISION_BITS) : 0.5 + k * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

const clip8 = (v: number) => {
  const s = Math.floor(v / (1 << PRECISION_BITS));
  return s < 0 ? 0 : s > 255 ? 255 : s;
};

/** Image.resize(size, Image.BICUBIC) of 8-bit RGB (interleaved bytes): horizontal pass, then
 *  vertical, each rounded to 8 bits, as Pillow's ImagingResample does. */
export function resizeBicubic(src: Uint8Array, w: number, h: number, ow: number, oh: number): Uint8Array {
  let cur = src;
  let cw = w;
  if (ow !== w) {
    const { ksize, bounds, kk } = coeffs(w, ow);
    const out = new Uint8Array(ow * h * 3);
    for (let y = 0; y < h; y++)
      for (let xx = 0; xx < ow; xx++) {
        const [xmin, xmax] = [bounds[xx * 2], bounds[xx * 2 + 1]];
        for (let c = 0; c < 3; c++) {
          let ss = 1 << (PRECISION_BITS - 1);
          for (let x = 0; x < xmax; x++) ss += cur[(y * w + x + xmin) * 3 + c] * kk[xx * ksize + x];
          out[(y * ow + xx) * 3 + c] = clip8(ss);
        }
      }
    cur = out;
    cw = ow;
  }
  if (oh !== h) {
    const { ksize, bounds, kk } = coeffs(h, oh);
    const out = new Uint8Array(cw * oh * 3);
    for (let yy = 0; yy < oh; yy++) {
      const [ymin, ymax] = [bounds[yy * 2], bounds[yy * 2 + 1]];
      for (let x = 0; x < cw; x++)
        for (let c = 0; c < 3; c++) {
          let ss = 1 << (PRECISION_BITS - 1);
          for (let y = 0; y < ymax; y++) ss += cur[((y + ymin) * cw + x) * 3 + c] * kk[yy * ksize + y];
          out[(yy * cw + x) * 3 + c] = clip8(ss);
        }
    }
    cur = out;
  }
  return cur === src ? src.slice() : cur;
}

/** Python's round() of a float to an int: halves to even. */
export const pyRound = (x: number) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r;
};

/** 0..1 float RGB as uint8, like `(np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8)` in float32. */
export function toBytes(a: RGB): Uint8Array {
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < a.data.length; i++) {
    const v = Math.min(1, Math.max(0, a.data[i]));
    out[i] = Math.trunc(Math.fround(Math.fround(v * 255) + 0.5));
  }
  return out;
}

/** CLIP's input (insights.preprocess): shortest side to 224 (bicubic), centre crop, normalised, CHW. */
export function preprocess(a: RGB): Float32Array {
  const { width: w, height: h } = a;
  const f = 224 / Math.min(w, h);
  const [rw, rh] = [Math.max(224, pyRound(w * f)), Math.max(224, pyRound(h * f))];
  const img = resizeBicubic(toBytes(a), w, h, rw, rh);
  const [left, top] = [Math.floor((rw - 224) / 2), Math.floor((rh - 224) / 2)];
  const out = new Float32Array(3 * 224 * 224);
  for (let y = 0; y < 224; y++)
    for (let x = 0; x < 224; x++)
      for (let c = 0; c < 3; c++) {
        const v = Math.fround(img[((y + top) * rw + x + left) * 3 + c] / 255);
        out[c * 224 * 224 + y * 224 + x] = Math.fround(Math.fround(v - Math.fround(MEAN[c])) / Math.fround(STD[c]));
      }
  return out;
}

/** A vector scaled to unit length (float32). */
export function unit(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ------------------------------------------------------------------ tags

/** Every label with its zero-shot probability (softmax over the label list), best first.
 *  `labels`: the prompts' unit embeddings, row after row. */
export function sceneTags(labels: Float32Array, emb: ArrayLike<number>): [string, number][] {
  const d = emb.length;
  const logits = TAGS.map((_, i) => LOGIT_SCALE * dot(labels.subarray(i * d, (i + 1) * d), emb));
  const top = Math.max(...logits);
  const p = logits.map((l) => Math.exp(l - top));
  const sum = p.reduce((a, b) => a + b, 0);
  return TAGS.map((t, i) => [t, p[i] / sum] as [string, number]).sort((a, b) => b[1] - a[1]);
}

export type Learned = { labels: Record<string, { accepted: number; dismissed: number }> };

/** How sure the model must be before suggesting `label`: dismissed more than accepted raises it,
 *  up to 4x (insights.threshold). */
export function threshold(label: string, stats: Learned): number {
  const c = stats.labels?.[label];
  if (!c) return THRESHOLD;
  return THRESHOLD * Math.min(4, Math.max(1, (1 + (c.dismissed ?? 0)) / (1 + (c.accepted ?? 0))));
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The tag suggestions of one embedding: up to MAX_TAGS labels over their threshold. */
export function tagSuggestions(labels: Float32Array, emb: ArrayLike<number>, stats: Learned) {
  return sceneTags(labels, emb)
    .filter(([t, p]) => p >= threshold(t, stats))
    .slice(0, MAX_TAGS)
    .map(([t, p]) => ({ value: t, confidence: round3(p), source: MODEL_ID, state: "suggested" as const }));
}
