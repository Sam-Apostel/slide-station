// Mirror (a slide scanned the wrong way round) must do what slidestation/imaging.py and store.py do:
// the same flipped settings and, for a mirrored slide, the same keys. Expected values from the Python app.
import { describe, expect, it } from "vitest";
import { cleanParams, mirrorBox, mirrorParams } from "./imaging";
import { oriented, rgb } from "./pixels";
import { CAPTIONS_ID, insightsKey } from "./insights";
import { renderKey, toneKey, type GroupData } from "./store";

const group = (over: Partial<GroupData>): GroupData =>
  ({ scans: [], excluded: [], rotation: 0, params: cleanParams({}), ...over }) as GroupData;

describe("mirror", () => {
  it("flips straighten, crop and masks like imaging.mirror_params", () => {
    const p = cleanParams({
      angle: 2.5,
      crop: [0.1, 0.1, 0.6, 0.8],
      local: [
        { kind: "radial", exposure: 0.8, center: [0.35, 0.6], rx: 0.2, ry: 0.12, angle: 25, feather: 0.5 },
        { kind: "graduated", start: [0.2, 0], end: [0.25, 0.4] },
      ],
    });
    const q = mirrorParams(p);
    expect(q.angle).toBe(-2.5);
    expect(q.crop).toEqual([0.4, 0.1, 0.9, 0.8]);
    const [r, g] = q.local as { center?: number[]; angle?: number; start?: number[]; end?: number[] }[];
    expect([r.center, r.angle]).toEqual([[0.65, 0.6], -25]);
    expect([g.start, g.end]).toEqual([
      [0.8, 0],
      [0.75, 0.4],
    ]);
    expect(mirrorParams(q)).toEqual(p); // twice is none
    expect(mirrorBox([0.1, 0.2, null, 0.9])).toEqual([null, 0.2, 0.9, 0.9]);
  });

  it("mirrors before turning, like imaging.orient", () => {
    const a = rgb(3, 2, Float32Array.from({ length: 18 }, (_, i) => i));
    const px = (b: typeof a, x: number, y: number) => b.data[(y * b.width + x) * 3];
    const m = oriented(a, 0, true);
    expect([px(m, 0, 0), px(m, 2, 1)]).toEqual([6, 9]);
    const t = oriented(a, 90, true); // mirrored, then a quarter turn clockwise: 2 × 3
    expect([t.width, t.height, px(t, 0, 0), px(t, 1, 0)]).toEqual([2, 3, 15, 6]);
  });

  it("keys: the same while off, the Python app's while on", () => {
    const params = cleanParams({ crop: [0.4, 0.1, 0.9, 0.8], angle: -2.5 });
    const g = group({ scans: ["IMG_0001_ab12cd"], rotation: 270, params });
    expect(renderKey({ ...g, mirror: false })).toBe(renderKey(g));
    expect(toneKey({ ...g, mirror: false })).toBe(toneKey(g));
    expect(renderKey({ ...g, mirror: true })).toBe("fe8ff8d28c36");
    expect(toneKey({ ...g, mirror: true })).toBe("c5bca2b0011e");
    const captioned = { ...group({ scans: ["a"], rotation: 90 }), mirror: true, caption: "x" };
    expect(insightsKey(captioned, ["clip-x", CAPTIONS_ID])).toBe("a013344307aa");
  });
});
