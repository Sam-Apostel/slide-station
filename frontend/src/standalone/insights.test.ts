// The browser's scene tags and look-alikes against insights.py / similar.py / places.py:
// insights.fixture.json holds inputs and what Python made of them (tests/make_insights_fixture.py).
// SS_CLIP_DIR=<library>/models/clip-vit-b32 also checks the real tokenizer on the label prompts.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "./insights.fixture.json";
import {
  LABELS,
  LABELS_KEY,
  preprocess,
  promptBatch,
  resizeBicubic,
  sceneTags,
  tagSuggestions,
  threshold,
  Tokenizer,
  type Learned,
} from "./clip";
import { insightsKey, merge, suggestBetween } from "./insights";
import {
  dateWindow,
  dismiss,
  levels,
  normalise,
  pack,
  slideKey,
  suggest,
  threshold as dupThreshold,
  unpack,
} from "./similar";
import { cropped, resized, rgb } from "./pixels";
import {
  agglomerate,
  cropBox,
  emptyPeople,
  merge as mergePeople,
  refresh,
  removeFaces,
  rename,
  similarityTransform,
  slideNames,
  tagName,
  warpAffine,
  type PeopleFile,
} from "./people";
import { fold, Gazetteer, placeFromText, search as searchPlaces, unzipEntry } from "./places";
import { boxes, crop, crops, ctc, detSize, recInput, REC_H, resizeLinear, type Point } from "./ocr";
import { inflateSync } from "node:zlib";
import type { GroupData, SessionData, StoredInsights } from "./store";

const pattern = (w: number, h: number) => {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = (x * 7 + y * 13 + c * 50 + ((x * y) % 17) * 3) % 256;
  return out;
};
const sha1 = (b: ArrayBufferView) =>
  createHash("sha1")
    .update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))
    .digest("hex");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("scene tags, as insights.py", () => {
  it("label key", () => expect(LABELS_KEY).toBe(fixture.labels_key));

  it("CLIP's BPE tokenizer", () => {
    const t = fixture.tokenizer;
    const tok = new Tokenizer(t.vocab, t.merges);
    t.texts.forEach((text, i) => expect(tok.encode(text)).toEqual(t.ids[i]));
  });

  it.runIf(!!process.env.SS_CLIP_DIR && "real_prompt_ids" in fixture)("the real vocabulary on the prompts", () => {
    const d = process.env.SS_CLIP_DIR!;
    expect(existsSync(`${d}/vocab.json`)).toBe(true);
    const tok = new Tokenizer(
      JSON.parse(readFileSync(`${d}/vocab.json`, "utf8")),
      readFileSync(`${d}/merges.txt`, "utf8"),
    );
    const want = (fixture as unknown as { real_prompt_ids: number[][] }).real_prompt_ids;
    LABELS.forEach(([, p], i) => expect(tok.encode(p)).toEqual(want[i]));
    const b = promptBatch(tok);
    expect(b.ids.every((x) => x.length === b.length)).toBe(true);
  });

  it("Pillow's bicubic resize, pixel for pixel", () => {
    for (const c of fixture.resize) {
      const out = resizeBicubic(pattern(c.w, c.h), c.w, c.h, c.ow, c.oh);
      if ("out" in c) expect(Buffer.from(out).toString("base64")).toBe(c.out);
      expect(sha1(out)).toBe(c.sha1);
    }
  });

  it("CLIP's preprocessing, bit for bit", () => {
    for (const c of fixture.preprocess) {
      const bytes = pattern(c.w, c.h);
      const a = rgb(
        c.w,
        c.h,
        Float32Array.from(bytes, (v) => v / 255),
      );
      const x = preprocess(a);
      const sample = Array.from(x.filter((_, i) => i % 9973 === 0));
      sample.forEach((v, i) => expect(v).toBeCloseTo(c.sample[i], 6));
      expect(sha1(x)).toBe(c.sha1);
    }
  });

  it("softmax over the labels and learned thresholds", () => {
    const t = fixture.tags;
    const labels = Float32Array.from(t.labels.flat());
    const stats = t.stats as Learned;
    for (const [k, v] of Object.entries(t.thresholds)) expect(threshold(k, stats)).toBeCloseTo(v, 12);
    for (const im of t.images) {
      const ranked = sceneTags(labels, Float32Array.from(im.emb));
      ranked.slice(0, 5).forEach(([tag, p], i) => {
        expect(tag).toBe(im.ranked[i][0]);
        expect(p).toBeCloseTo(im.ranked[i][1] as number, 5);
      });
      expect(tagSuggestions(labels, Float32Array.from(im.emb), stats)).toEqual(im.suggested);
    }
  });

  it("insights keys and embedding keys", () => {
    for (const c of fixture.keys) {
      expect(insightsKey(c.g as unknown as GroupData, c.models)).toBe(c.key);
      expect(slideKey(c.g as unknown as GroupData)).toBe(c.slide_key);
    }
  });

  it("merging fresh suggestions with decisions", () => {
    for (const c of fixture.merge) {
      const got = merge(
        clone(c.old) as StoredInsights | undefined,
        clone(c.new) as StoredInsights & { key: string },
        c.own_tags,
        c.own_caption,
        c.own_place,
      );
      expect(got).toEqual(c.out);
    }
  });

  it("places from the tray's neighbours", () => {
    for (const c of fixture.between) {
      const groups = clone(c.groups) as unknown as GroupData[];
      expect(suggestBetween(groups)).toBe(c.n);
      expect(groups).toEqual(c.after);
    }
  });
});

describe("places, as places.py", () => {
  const f = fixture.places;
  const gaz = new Gazetteer(f.cities, f.country, f.admin);

  it("the GeoNames tables, unzipped in the page", async () => {
    const text = new TextDecoder().decode(
      await unzipEntry(new Blob([Buffer.from(f.zip, "base64")]), "cities15000.txt"),
    );
    expect(text).toBe(f.cities);
    expect(gaz.size).toBe(f.size);
    for (const [s, want] of Object.entries(f.fold)) expect(fold(s)).toBe(want);
  });

  it("search by name and by coordinates", () => {
    for (const [q, want] of Object.entries(f.search)) expect(searchPlaces(gaz, q)).toEqual(want);
    for (const [ll, want] of Object.entries(f.nearest)) {
      const [lat, lon] = ll.split(",").map(Number);
      expect(gaz.nearest(lat, lon)).toEqual(want);
    }
  });

  it("the place a sign names", () => {
    for (const c of f.text) expect(placeFromText(c.lines, gaz)).toEqual(c.hit);
  });
});

describe("reading signs, as places.Ocr (networks planted)", () => {
  const f = fixture.ocr;
  const img = (w: number, h: number) => ({ width: w, height: h, data: pattern(w, h) });

  it("OpenCV's bilinear resize and the detector's size", () => {
    for (const c of f.resize) {
      const r = resizeLinear(img(c.w, c.h), c.ow, c.oh);
      expect(r.data.reduce((a, b) => a + b, 0)).toBe(c.sum);
      expect(sha1(r.data)).toBe(c.sha1);
    }
    for (const [k, want] of Object.entries(f.det_size)) {
      const [w, h] = k.split("x").map(Number);
      expect(detSize(w, h)).toEqual(want);
    }
  });

  it("the perspective crop (bicubic, replicated border)", () => {
    for (const c of f.warp) {
      const out = crop(img(120, 80), c.pts as Point[], c.tw, c.th);
      const want = Buffer.from(c.out, "base64");
      let [worst, off] = [0, 0];
      out.data.forEach((v, i) => ((worst = Math.max(worst, Math.abs(v - want[i]))), (off += +(v !== want[i]))));
      // OpenCV 5 samples at float coordinates; its float rounding decides a rare last level
      expect(worst).toBeLessThanOrEqual(1);
      expect(off).toBeLessThanOrEqual(2);
    }
  });

  it("probability map -> boxes -> crops -> recogniser input -> text", () => {
    const d = f.det;
    const pred = Float32Array.from(inflateSync(Buffer.from(d.pred, "base64")), (v) => v / 255);
    const bs = boxes(pred, d.dw, d.dh, d.w, d.h);
    expect(bs.length).toBe(d.boxes.length);
    bs.forEach((b, i) => b.forEach((p, j) => p.forEach((v, k) => expect(v).toBeCloseTo(d.boxes[i][j][k], 3))));
    const chars = ["", ...Array.from({ length: d.classes - 3 }, (_, i) => String.fromCharCode(33 + i)), " "];
    // the crops from Python's boxes (ours agree to 1e-3 px; float32 corner bits decide the crop's last bits)
    const lines = crops(img(d.w, d.h), d.boxes as Point[][]).map((c, k) => {
      const x = recInput(c);
      // the same pixels reach the network (a level here and there from the crop's float rounding)
      const want = d.rec_inputs[k];
      expect([1, 3, REC_H, x.width]).toEqual(want.shape);
      const levels = x.data.reduce((s, v) => s + Math.round((v * 0.5 + 0.5) * 255), 0);
      if (sha1(x.data) !== want.sha1) expect(Math.abs(levels - want.sum)).toBeLessThanOrEqual(x.data.length / 1000);
      const p = new Float32Array(d.steps * d.classes).fill(0.001);
      for (let t = 0; t < d.steps; t++)
        p[t * d.classes + (t % 3 !== 0 ? 1 + ((Math.floor(t / 3) + k + 1) % 26) * 3 : 0)] = Math.fround(
          0.9 - 0.01 * (t % 5),
        );
      const r = ctc(p, d.steps, d.classes, chars);
      return { text: r.text, confidence: Math.round(r.confidence * 1000) / 1000 };
    });
    expect(lines).toEqual(d.lines);
  });
});

describe("people, as people.py", () => {
  const f = fixture.people;

  it("average-linkage clustering", () => {
    for (const c of f.agglomerate) {
      const rejected = new Map(Object.entries(c.rejected).map(([k, v]) => [Number(k), new Set(v as number[])]));
      expect(agglomerate(c.emb.map(unpack), c.clusters as number[][], rejected)).toEqual(c.out);
    }
  });

  it("people.json through refresh, naming, merging and taking faces out", () => {
    let d: PeopleFile = emptyPeople();
    for (const s of f.steps) {
      if (s.op === "refresh") {
        const faces = new Map(
          Object.entries(s.faces as Record<string, { emb: string }>).map(([k, v]) => [k, unpack(v.emb)]),
        );
        d = refresh(d, faces).d;
      } else {
        const [a, b] = s.args as [string, unknown];
        const next =
          s.op === "rename"
            ? rename(d, a, b as string)
            : s.op === "merge"
              ? mergePeople(d, a, b as string[])
              : removeFaces(d, a, b as string[]);
        // the desktop app refreshes after every edit, with the faces as they were
        const faces = new Map(
          Object.entries(
            (f.steps.filter((x) => x.op === "refresh" && f.steps.indexOf(x) < f.steps.indexOf(s)).pop()!.faces ??
              {}) as Record<string, { emb: string }>,
          ).map(([k, v]) => [k, unpack(v.emb)]),
        );
        d = refresh(next!, faces).d;
      }
      expect(d).toEqual(s.out);
    }
    expect(Object.fromEntries(slideNames(d))).toEqual(f.names);
    expect(["Ann", "A/B", " C "].map(tagName)).toEqual(f.tag);
  });

  it("alignCrop: the similarity transform and the warp to 112 × 112", () => {
    const img = { width: 200, height: 160, data: pattern(200, 160) };
    for (const c of f.align) {
      const pts = [0, 1, 2, 3, 4].map((i) => [c.face[4 + i * 2], c.face[5 + i * 2]]);
      const out = warpAffine(img, similarityTransform(pts));
      const sum = out.data.reduce((a, b) => a + b, 0);
      if (sha1(out.data) !== c.sha1) expect(Math.abs(sum - c.sum)).toBeLessThanOrEqual(out.data.length / 1000);
    }
  });

  it("the face crop for the People dialog", () => {
    const a = rgb(
      300,
      200,
      Float32Array.from(pattern(300, 200), (v) => v / 255),
    );
    for (const c of f.crop) {
      const [x0, y0, x1, y1] = cropBox(a.width, a.height, c.box);
      const crop = resized(cropped(a, y0, y1, x0, x1), 128, 128);
      expect(crop.data.reduce((s, v) => s + v, 0)).toBeCloseTo(c.sum, 0);
    }
  });
});

describe("look-alikes, as similar.py", () => {
  it("embeddings packed as base64 float16", () => {
    const p = fixture.pack;
    p.vectors.forEach((v, i) => {
      expect(pack(Float32Array.from(v))).toBe(p.packed[i]);
      Array.from(unpack(p.packed[i])).forEach((x, j) => expect(x).toBeCloseTo(p.unpacked[i][j], 6));
    });
  });

  it("duplicates, split, merge, scenes; dismissed ones stay away", async () => {
    const s = fixture.similar;
    const sig = async (x: string) => (s.sigs as Record<string, number[]>)[x] ?? null;
    const tray = clone(s.tray) as unknown as SessionData;
    expect(await suggest(tray, s.embeddings, 0.93, sig)).toEqual(s.suggest);
    expect(await suggest(tray, s.embeddings, 0.96, sig)).toEqual(s.suggest_strict);
    const all = await suggest(tray, s.embeddings, 0.93, sig);
    for (const x of [all.duplicates[0], ...all.split, ...all.merge]) dismiss(tray, x);
    expect(tray.similar).toEqual(s.dismissed_tray);
    expect(await suggest(tray, s.embeddings, 0.93, sig)).toEqual(s.suggest_after_dismiss);
    for (const [stats, want] of s.thresholds) expect(dupThreshold(stats as Learned)).toBeCloseTo(want as number, 12);
  });

  it("exposure normalised, levels, date windows", () => {
    const c = fixture.images;
    const a = rgb(
      c.w,
      c.h,
      Float32Array.from(pattern(c.w, c.h), (v) => v / 255),
    );
    a.data.set([1, 1, 1], 0);
    Array.from(normalise(a).data).forEach((v, i) => expect(v).toBeCloseTo(c.normalise[i], 5));
    Array.from(levels(a).data).forEach((v, i) => expect(v).toBeCloseTo(c.levels[i], 5));
    for (const [d, w] of Object.entries(c.windows)) expect(dateWindow(d)).toEqual(w);
  });
});
