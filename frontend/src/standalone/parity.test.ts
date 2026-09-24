// The browser pipeline against the Python one, on the synthetic slides SlideKit's parity tests use
// (apple/SlideKit/Tests/make_golden.py writes them). Same tolerances as ParityTests.swift.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import * as im from "./imaging";
import { fuse, mtbShift, materialise, rgbSource, shiftedSource } from "./fusion";
import { features, Model } from "./learning";
import { localMask } from "@/lib/local";
import { cropped, gray, rotated, type RGB } from "./pixels";

const DIR = new URL("../../../apple/SlideKit/Tests/SlideKitTests/Golden/", import.meta.url);
const golden = JSON.parse(readFileSync(new URL("golden.json", DIR), "utf8"));

/** 8-bit RGB, non-interlaced PNG (what make_golden.py writes) to float RGB. */
function png(name: string): RGB {
  const d = readFileSync(new URL(name, DIR));
  const w = d.readUInt32BE(16);
  const h = d.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let o = 8; o < d.length; ) {
    const len = d.readUInt32BE(o);
    if (d.toString("ascii", o + 4, o + 8) === "IDAT") chunks.push(d.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const bpp = 3;
  const stride = w * bpp;
  const px = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      px[y * stride + x] = (v + pred) & 255;
    }
  }
  return { width: w, height: h, data: Float32Array.from(px, (v) => v / 255) };
}

const floats = (name: string) => {
  const b = readFileSync(new URL(name, DIR));
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

function diff(a: Float32Array, b: Float32Array): [number, number] {
  expect(a.length).toBe(b.length);
  let sum = 0;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    worst = Math.max(worst, d);
  }
  return [sum / a.length, worst];
}

const scene = png("scene.png");

describe("parity with imaging.py", () => {
  it("auto restore", () => {
    const [mean, worst] = diff(im.autoRestore(scene, 0.6).data, floats("restored.f32"));
    expect(mean).toBeLessThan(0.002);
    expect(worst).toBeLessThan(0.05);
  });

  it("auto restore of over-exposed scans (a channel's median at white)", () => {
    const { scales, strength } = golden.restore_blown;
    const want = floats("restored_blown.f32");
    const n = scene.data.length;
    scales.forEach((k: number, i: number) => {
      const over = { ...scene, data: scene.data.map((v) => Math.min(1, Math.max(0, v * k))) };
      const out = im.autoRestore(over, strength).data;
      expect(out.every(Number.isFinite)).toBe(true);
      const [mean, worst] = diff(out, want.subarray(i * n, (i + 1) * n));
      expect(mean).toBeLessThan(0.002);
      expect(worst).toBeLessThan(0.05);
    });
    // an empty, white frame stays white (a flat channel keeps its levels)
    const white = { width: 96, height: 64, data: new Float32Array(96 * 64 * 3).fill(1) };
    expect(im.autoRestore(white, 1).data.every((v) => v === 1)).toBe(true);
  });

  it("trim bounds", () => {
    const restored = { width: golden.width, height: golden.height, data: floats("restored.f32") };
    expect(im.trimBounds(restored)).toEqual(golden.trim_bounds);
  });

  it("develop", () => {
    const out = im.develop(scene, im.cleanParams(golden.params));
    expect([out.height, out.width]).toEqual(golden.developed_shape);
    const [mean, worst] = diff(out.data, floats("developed.f32"));
    expect(mean).toBeLessThan(0.003);
    expect(worst).toBeLessThan(0.06);
  });

  it("develop with negative contrast and no trim", () => {
    const [mean] = diff(im.develop(scene, im.cleanParams(golden.params_neg)).data, floats("developed_neg.f32"));
    expect(mean).toBeLessThan(0.003);
  });

  it("develop with straighten and crop", () => {
    const out = im.develop(scene, im.cleanParams(golden.params_crop));
    expect([out.height, out.width]).toEqual(golden.developed_crop_shape);
    const [mean] = diff(out.data, floats("developed_crop.f32"));
    expect(mean).toBeLessThan(0.01);
  });

  it("curve LUT", () => {
    const lut = im.curveLut(golden.curve_points, 64);
    golden.curve_lut.forEach((v: number, i: number) => expect(lut[i]).toBeCloseTo(v, 5));
  });

  it("fit curves", () => {
    const fit = im.fitCurves(im.toneBase(scene, im.cleanParams({})), {});
    expect(Object.keys(fit).sort()).toEqual(Object.keys(golden.fit_curves).sort());
    for (const [k, pts] of Object.entries(golden.fit_curves as Record<string, number[][]>))
      pts.forEach((p, i) => {
        expect(Math.abs(fit[k as "r"]![i][0] - p[0])).toBeLessThan(0.01);
        expect(fit[k as "r"]![i][1]).toBeCloseTo(p[1], 6);
      });
  });

  it("neutral balance", () => {
    const [w, t] = im.neutralBalance(scene, im.cleanParams({}), 0.2, 0.2);
    expect(Math.abs(w - golden.neutral[0])).toBeLessThan(0.02);
    expect(Math.abs(t - golden.neutral[1])).toBeLessThan(0.02);
  });

  it("grouping", () => {
    const a = im.signature(scene);
    const d = im.signature(png("scene_dark.png"));
    const o = im.signature(png("scene_other.png"));
    expect(Math.abs(im.similarity(a, d) - golden.sim_same)).toBeLessThan(0.01);
    expect(Math.abs(im.similarity(a, o) - golden.sim_other)).toBeLessThan(0.03);
    expect(im.groupSequence([a, d, o, o])).toEqual([
      [
        [0, 1],
        [2, 3],
      ],
      false,
    ]);
    expect(im.groupSequence([d, o], [a])).toEqual([[[0], [1]], true]);
  });

  it("scan quality and weak scans", () => {
    const q = [im.scanQuality(scene), im.scanQuality(png("scene_dark.png"))];
    q.forEach((x, i) => {
      expect(Math.abs(x.clipped - golden.quality[i].clipped)).toBeLessThan(0.01);
      expect(Math.abs(x.sharp - golden.quality[i].sharp)).toBeLessThan(golden.quality[i].sharp * 0.15);
    });
    expect(
      im.weakScans([
        { sharp: 1, clipped: 0 },
        { sharp: 0.4, clipped: 0 },
        { sharp: 0.9, clipped: 0.9 },
      ]),
    ).toEqual({ 1: "blurry", 2: "clipped" });
    expect(
      im.weakScans([
        { sharp: 1, clipped: 0.9 },
        { sharp: 0.5, clipped: 0.95 },
      ]),
    ).toEqual({ 1: "clipped" });
  });

  it("Mertens fusion", () => {
    const fused = fuse([png("scene_dark.png"), scene, png("scene_bright.png")], false);
    const [mean] = diff(fused.data, floats("fused.f32"));
    expect(mean).toBeLessThan(0.01);
  });

  it("alignment undoes a shift and leaves identical scans alone", () => {
    const bright = png("scene_bright.png");
    const moved = materialise(shiftedSource(rgbSource(bright), 3, -2));
    expect(mtbShift(gray(scene), gray(moved))).toEqual([-3, 2]);
    expect(mtbShift(gray(scene), gray(scene))).toEqual([0, 0]);
  });

  it("straighten", () => {
    const out = im.straighten(scene, 4);
    const ref = floats("straight4.f32");
    let sum = 0;
    let n = 0;
    for (let y = 10; y < out.height - 10; y++)
      for (let x = 10; x < out.width - 10; x++)
        for (let c = 0; c < 3; c++, n++)
          sum += Math.abs(out.data[(y * out.width + x) * 3 + c] - ref[(y * out.width + x) * 3 + c]);
    expect(sum / n).toBeLessThan(0.01);
  });

  it("rotation round trip, clockwise", () => {
    const r = rotated(scene, 90);
    expect([r.width, r.height]).toEqual([scene.height, scene.width]);
    expect(rotated(r, 270).data).toEqual(scene.data);
    expect(Array.from(r.data.subarray((r.width - 1) * 3, r.width * 3))).toEqual(Array.from(scene.data.subarray(0, 3)));
  });

  it("mount detection and the tighter trim", () => {
    const mnt = png("mount.png");
    const m = im.detectMount(mnt);
    expect(Math.abs(m.angle - golden.mount.angle)).toBeLessThan(0.02);
    expect(Math.abs(m.confidence - golden.mount.confidence)).toBeLessThan(0.03);
    m.box.forEach((v, i) => expect(Math.abs(v! - golden.mount.box[i])).toBeLessThan(0.002));
    expect(im.rotateBox(golden.mount.box, 90)).toEqual(golden.mount_box_rot90);
    expect(im.rotateBox(im.rotateBox(golden.mount.box, 180), 180)).toEqual(golden.mount.box);
    const crop = im.mountCrop(rotated(mnt, 90), im.cleanParams(golden.mount_params), golden.mount_box_rot90)!;
    crop.forEach((v, i) => expect(Math.abs(v - golden.mount_crop_rot90[i])).toBeLessThan(0.002));
    expect(im.detectMount(cropped(scene, 8, scene.height - 8, 8, scene.width - 8))).toEqual(golden.mount_none);
  });

  it("dust and scratch repair", () => {
    const dusty = png("dusty.png");
    const { mask, r } = im.dustMask(dusty, golden.dust_amount);
    expect(r).toBe(golden.dust_r);
    expect(mask.reduce((s, v) => s + v, 0)).toBe(golden.dust_marked);
    const before = Float32Array.from(dusty.data);
    const [mean, worst] = diff(im.repairDust(dusty, golden.dust_amount).data, floats("dust.f32"));
    expect(mean).toBeLessThan(1e-5);
    expect(worst).toBeLessThan(1e-3);
    expect(dusty.data).toEqual(before); // not in place unless asked
    expect(im.repairDust(dusty, 0)).toBe(dusty);
  });

  it("mould repair", () => {
    const mouldy = png("mouldy.png");
    const { mask, r } = im.mouldMask(mouldy, golden.mould_amount);
    expect(r).toBe(golden.mould_r);
    expect(mask.reduce((s, v) => s + v, 0)).toBe(golden.mould_marked);
    const before = Float32Array.from(mouldy.data);
    const [mean, worst] = diff(im.repairMould(mouldy, golden.mould_amount).data, floats("mould.f32"));
    expect(mean).toBeLessThan(1e-5);
    expect(worst).toBeLessThan(1e-3);
    expect(mouldy.data).toEqual(before); // not in place unless asked
    expect(im.repairMould(mouldy, 0)).toBe(mouldy);
  });

  it("Newton ring removal", () => {
    const ringed = png("rings.png");
    const { weight } = im.newtonWeight(ringed, golden.newton_amount);
    expect(Math.abs(weight.reduce((s, v) => s + v, 0) - golden.newton_weight_sum)).toBeLessThan(1e-6 * weight.length);
    const at = [
      [100, 96],
      [40, 40],
      [170, 260],
      [200, 300],
    ];
    at.forEach(([y, x], k) =>
      expect(Math.abs(weight[y * ringed.width + x] - golden.newton_weight_samples[k])).toBeLessThan(1e-6),
    );
    const before = Float32Array.from(ringed.data);
    const [mean, worst] = diff(im.repairNewton(ringed, golden.newton_amount).data, floats("newton.f32"));
    expect(mean).toBeLessThan(1e-5);
    expect(worst).toBeLessThan(1e-3);
    expect(ringed.data).toEqual(before);
    expect(im.repairNewton(ringed, 0)).toBe(ringed);
  });

  it("local adjustment masks", () => {
    const local = im.cleanParams(golden.params_local).local!;
    expect(local).toEqual(golden.params_local.local); // clean_local keeps what Python kept
    const [w, h] = golden.local_mask_size;
    local.forEach((adj, n) => {
      const want = golden.local_masks[n];
      const m = localMask(adj, w, h);
      expect([m.height, m.width]).toEqual(want.shape);
      expect(Math.abs(m.data.reduce((s, v) => s + v, 0) - want.sum) / Math.max(1, want.sum)).toBeLessThan(1e-5);
      const at = [
        [0, 0],
        [300, 400],
        [500, 200],
        [100, 900],
        [600, 1000],
        [437, 409],
        [437, 609],
        [156, 859],
        [156, 767],
      ];
      at.forEach(([j, i], k) => expect(Math.abs(m.data[j * m.width + i] - want.samples[k])).toBeLessThan(1e-6));
    });
    expect(im.turnLocal(local, 90)).toEqual(golden.local_turned);
    expect(im.turnLocal(im.turnLocal(local, 180), 180)).toEqual(local);
  });

  it("develop with local adjustments", () => {
    const out = im.develop(png("local.png"), im.cleanParams(golden.params_local));
    expect([out.height, out.width]).toEqual(golden.developed_local_shape);
    const [mean, worst] = diff(out.data, floats("developed_local.f32"));
    expect(mean).toBeLessThan(0.003);
    expect(worst).toBeLessThan(0.06);
    // no local adjustments: exactly the develop from before
    const plain = im.cleanParams({ ...golden.params_local, local: [] });
    const withNone = im.develop(png("local.png"), plain);
    expect(diff(withNone.data, out.data)[0]).toBeGreaterThan(0.01);
  });

  it("learning features and k-NN", () => {
    const f = features(scene, 2);
    f.forEach((v, i) => expect(Math.abs(v - golden.features[i])).toBeLessThan(0.01));
    const m = new Model({ examples: golden.learning_examples }, () => {});
    const [sugg, n] = m.suggest(golden.learning_query);
    expect(n).toBe(golden.learning_neighbours);
    for (const [k, v] of Object.entries(golden.learning_suggestion as Record<string, number | boolean>))
      if (typeof v === "boolean") expect(sugg![k as "trim"]).toBe(v);
      else expect(Math.abs((sugg as Record<string, number>)[k] - v)).toBeLessThan(0.002);
  });

  it("learning per film stock", () => {
    const m = new Model({ examples: golden.learning_stock.examples }, () => {});
    const cases = golden.learning_stock.cases as Record<
      string,
      { suggestion: Record<string, number | boolean>; neighbours: number }
    >;
    for (const [stock, want] of Object.entries(cases)) {
      const [sugg, n] = m.suggest(golden.learning_query, stock === "none" ? "" : stock);
      expect(n, stock).toBe(want.neighbours);
      for (const [k, v] of Object.entries(want.suggestion))
        if (typeof v === "boolean") expect(sugg![k as "trim"]).toBe(v);
        else expect(Math.abs((sugg as Record<string, number>)[k] - v), `${stock} ${k}`).toBeLessThan(0.002);
    }
  });

  it("learned tone curves", () => {
    const m = new Model({ examples: golden.learning_curve_examples }, () => {});
    const [sugg] = m.suggest(golden.learning_query);
    const want = golden.learning_curve_suggestion as Record<string, number[][]>;
    expect(Object.keys(sugg!.curves!)).toEqual(Object.keys(want));
    for (const [ch, pts] of Object.entries(want))
      pts.forEach((p, i) => {
        expect(sugg!.curves![ch as "r"]![i][0]).toBeCloseTo(p[0], 4);
        expect(Math.abs(sugg!.curves![ch as "r"]![i][1] - p[1])).toBeLessThan(0.002);
      });
  });
});
