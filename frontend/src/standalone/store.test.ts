// The tray keys must come out byte for byte like slidestation/store.py's, so a library folder can
// move between the browser and the desktop app. Expected values computed with the Python app.
import { describe, expect, it } from "vitest";
import { cleanParams } from "./imaging";
import {
  cleanPlace,
  dumpSession,
  metaKey,
  renderKey,
  sha1Hex,
  slideDates,
  toneKey,
  type GroupData,
  type SessionData,
} from "./store";

const group = (over: Partial<GroupData>): GroupData =>
  ({ scans: [], excluded: [], rotation: 0, params: cleanParams({}), ...over }) as GroupData;

describe("keys match the Python app", () => {
  const g = group({
    scans: ["IMG_0001_ab12cd", "ÉTÉ_2"],
    rotation: 90,
    params: cleanParams({
      strength: 0.35,
      warmth: -0.1234,
      curves: {
        r: [
          [0.1, 0],
          [1, 1],
        ],
      },
      crop: [0.1, 0.2, 0.9, 0.8],
    }),
    caption: "Zoë at the lake",
  });
  it("render and tone keys", () => {
    expect(renderKey(g)).toBe("3279595dadce");
    expect(toneKey(g)).toBe("dabc64eacdd4");
    expect(renderKey(group({ scans: ["a"] }))).toBe("d4ec29362fa2");
    expect(toneKey(group({ scans: ["a"] }))).toBe("2d865f31c02a");
  });
  it("dust counts only when on", () => {
    const dusty = { ...g, params: { ...g.params, dust: 0.25 } };
    expect(renderKey(dusty)).toBe("c6fde1de427f");
    expect(toneKey(dusty)).toBe("c23f13e25b53");
  });
  it("mould and Newton rings count only when on", () => {
    const mouldy = { ...g, params: { ...g.params, mould: 0.3 } };
    expect(renderKey(mouldy)).toBe("fb89612b5fb2");
    expect(toneKey(mouldy)).toBe("61ce3ec785e2");
    const both = { ...g, params: { ...g.params, dust: 0.25, newton: 0.45 } };
    expect(renderKey(both)).toBe("b73d49ba65a5");
    expect(toneKey(both)).toBe("2d417148d3f4");
  });
  it("local adjustments count only when there are some, and not in the tone key", () => {
    expect(renderKey({ ...g, params: { ...g.params, local: [] } })).toBe("3279595dadce");
    const local = cleanParams({
      ...g.params,
      local: [
        { kind: "radial", exposure: 0.35, center: [0.3, 0.61234], rx: 0.2, ry: 0.1, angle: -30, invert: true },
        { kind: "graduated", exposure: -0.5, warmth: 0.25 },
        {
          kind: "brush",
          saturation: -1,
          strokes: [
            {
              points: [
                [0.1, 0.1],
                [0.5, 0.6],
              ],
              radius: 0.05,
              erase: true,
            },
          ],
        },
      ],
    });
    expect(renderKey({ ...g, params: local })).toBe("744719c8a4e4");
    expect(toneKey({ ...g, params: local })).toBe("dabc64eacdd4");
  });
  it("meta key", () => {
    expect(metaKey(g, { value: "1978-08", source: "own" })).toBe("468575a4ce75");
    const tagged = { ...g, tags: ["snow", "beach", "café"] };
    expect(metaKey(tagged, { value: "1978-08", source: "own" })).toBe("9a725df29165");
  });
  it("meta key with a place (its coordinates, as Python formats them)", () => {
    const venice = { name: "Venice", lat: 45.43713, lon: 12.33265, country: "Italy" };
    const placed = { caption: "Lake", place: venice } as unknown as GroupData;
    expect(metaKey(placed, { value: "1978-08", source: "own" })).toBe("1c66a5ef98cd");
    const both = { caption: "", tags: ["beach"], place: { name: "x", lat: -33.9, lon: 151, country: "" } };
    expect(metaKey(both as unknown as GroupData, { value: "", source: "own" })).toBe("bd79f63a3f0b");
  });
  it("cleanPlace", () => {
    expect(cleanPlace({ name: " Venice ", lat: "45.437134", lon: 12.332651, country: "Italy" })).toEqual({
      name: "Venice",
      lat: 45.43713,
      lon: 12.33265,
      country: "Italy",
    });
    expect(cleanPlace({ lat: 1, lon: 2 })?.name).toBe("1.0000, 2.0000");
    expect(cleanPlace(null)).toBeNull();
    expect(() => cleanPlace({ lat: 91, lon: 0 })).toThrow();
    expect(() => cleanPlace({ name: "x" })).toThrow();
  });
  it("sha1", () => expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d"));
  it("dates between, near", () => {
    const d = {
      date: "1978",
      groups: [{ date: "1978-08" }, {}, {}, { date: "1979-07-14" }, {}],
    } as unknown as SessionData;
    expect(slideDates(d)).toEqual([
      { value: "1978-08", source: "own" },
      { value: "1978-11", source: "between", from: [0, 3] },
      { value: "1979-03", source: "between", from: [0, 3] },
      { value: "1979-07-14", source: "own" },
      { value: "1979-07-14", source: "near", from: [3] },
    ]);
  });
  it("session.json writes params as floats, like json.dumps(indent=1)", () => {
    expect(dumpSession({ params: cleanParams({ tint: 0.00001 }), n: 3, f: 1.5 })).toBe(
      '{\n "params": {\n  "strength": 0.6,\n  "brightness": 0.0,\n  "contrast": 0.0,\n  "warmth": 0.0,\n  "tint": 1e-05,\n  "saturation": 0.0,\n  "trim": true,\n  "curves": {},\n  "angle": 0.0,\n  "crop": null,\n  "dust": 0.0,\n  "mould": 0.0,\n  "newton": 0.0,\n  "local": []\n },\n "n": 3,\n "f": 1.5\n}',
    );
  });
});
