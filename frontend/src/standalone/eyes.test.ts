// The browser's eyes-open measure and "keep the best" against eyes.py / similar.py: eyes.fixture.json
// holds inputs and what Python made of them (tests/make_eyes_fixture.py).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "./eyes.fixture.json";
import {
  bestOf,
  cropMatrix,
  ear,
  faceEar,
  landmarkInput,
  MODEL_ID,
  openness,
  prominent,
  SIZE,
  slideOpen,
  type EyesEntry,
} from "./eyes";
import { warpAffine } from "./people";
import { suggest } from "./similar";
import type { SessionData } from "./store";

const pattern = (w: number, h: number) => {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = (x * 7 + y * 13 + c * 50 + ((x * y) % 17) * 3) % 256;
  return out;
};
const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");

describe("eyes open, as eyes.py", () => {
  it("the eye aspect ratio, per eye and per face", () => {
    expect(MODEL_ID).toBe(fixture.model);
    for (const c of fixture.ear) expect(ear(c.p.map((r) => r.map(Math.fround)))).toBeCloseTo(c.ear, 12);
    expect(faceEar(Float32Array.from(fixture.mesh.pts))).toBeCloseTo(fixture.mesh.ear, 12);
  });

  it("how open, per slide", () => {
    for (const [x, o] of fixture.openness) expect(openness(x)).toBeCloseTo(o, 12);
    for (const [e, o] of fixture.slide_open) expect(slideOpen(e as EyesEntry | null)).toBe(o);
  });

  it("the crop around a face: the affine, and the 256 px warp", () => {
    const img = { width: 300, height: 200, data: pattern(300, 200) };
    for (const c of fixture.crop) {
      const m = cropMatrix(c.face.map(Math.fround)); // a float32 row, as the detector gives it
      m.forEach((v, i) => expect(v).toBeCloseTo(c.m[i], 9));
      const out = warpAffine(img, m, SIZE);
      const sum = out.data.reduce((a, b) => a + b, 0);
      // OpenCV and the port agree but for a level on the odd pixel (as for alignCrop)
      if (sha1(out.data) !== c.sha1) expect(Math.abs(sum - c.sum)).toBeLessThanOrEqual(out.data.length / 1000);
      const input = landmarkInput(out);
      expect(input.length).toBe(SIZE * SIZE * 3);
      expect(input[5]).toBe(Math.fround(out.data[5] / 255));
    }
  });

  it("the faces that count", () => {
    const p = fixture.prominent;
    const faces = p.faces.map(([w, score]) => ({ w: Math.fround(w), score: Math.fround(score) }));
    expect(prominent(faces, p.width).map((f) => f.w)).toEqual(p.kept);
  });
});

describe("keep the best, as similar.py", () => {
  it("quality weighed with open eyes", () => {
    for (const c of fixture.best_of) expect(bestOf(c.ids, c.scores, c.opened as Record<string, number>)).toBe(c.best);
  });

  it("duplicates with eyes measured", async () => {
    const s = fixture.similar;
    const tray = JSON.parse(JSON.stringify(s.tray)) as SessionData;
    const all = await suggest(tray, s.embeddings, 0.93, async () => null);
    expect(all.duplicates).toEqual(s.duplicates);
  });
});
