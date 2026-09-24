// The large-scan fallback (strips.ts): strips reassemble in order, and the JS encoder writes a
// valid JPEG of the right size. The browser side (createImageBitmap per strip) runs in
// tests/web_flow.py with SS_CANVAS_LIMIT.
import { decode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { assembleStrips, encodeJpegJS, stripRows } from "./strips";

function gradient(w: number, h: number) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) px.set([(x * 255) / (w - 1), (y * 255) / (h - 1), 128, 255], (y * w + x) * 4);
  return px;
}

describe("large scans", () => {
  it("reads strips into place", async () => {
    const [w, h] = [37, 101];
    const full = gradient(w, h);
    const rows = stripRows(w, 37 * 10);
    const calls: number[] = [];
    const out = await assembleStrips(w, h, rows, async (sy, sh) => {
      calls.push(sh);
      return full.slice(sy * w * 4, (sy + sh) * w * 4);
    });
    expect(calls).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 1]);
    expect(out).toEqual(full);
    await expect(assembleStrips(w, h, rows, async () => new Uint8ClampedArray(4))).rejects.toThrow("wrong size");
  });

  it("encodes a JPEG without a canvas", async () => {
    const [w, h] = [203, 117]; // not multiples of 8: the encoder pads the edge blocks
    const blob = await encodeJpegJS(w, h, gradient(w, h), 95);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(blob.type).toBe("image/jpeg");
    expect([bytes[0], bytes[1], bytes.at(-2), bytes.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    const back = decode(bytes, { useTArray: true });
    expect([back.width, back.height]).toEqual([w, h]);
    let err = 0;
    const want = gradient(w, h);
    for (let i = 0; i < want.length; i++) if (i % 4 !== 3) err = Math.max(err, Math.abs(back.data[i] - want[i]));
    expect(err).toBeLessThan(12);
  });
});
