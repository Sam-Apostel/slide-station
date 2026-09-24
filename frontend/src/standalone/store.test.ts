// The tray keys must come out byte for byte like slidestation/store.py's, so a library folder can
// move between the browser and the desktop app. Expected values computed with the Python app.
import { describe, expect, it } from "vitest";
import { cleanParams } from "./imaging";
import {
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
  it("meta key", () => expect(metaKey(g, { value: "1978-08", source: "own" })).toBe("468575a4ce75"));
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
      '{\n "params": {\n  "strength": 0.6,\n  "brightness": 0.0,\n  "contrast": 0.0,\n  "warmth": 0.0,\n  "tint": 1e-05,\n  "saturation": 0.0,\n  "trim": true,\n  "curves": {},\n  "angle": 0.0,\n  "crop": null,\n  "dust": 0.0\n },\n "n": 3,\n "f": 1.5\n}',
    );
  });
});
