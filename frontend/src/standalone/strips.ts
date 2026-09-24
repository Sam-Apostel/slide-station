// Big scans where a canvas can't hold them: Safari on iPad / iPhone refuses canvases over about
// 16.7 MP (4096²). engine.worker.ts then decodes a full-resolution scan in horizontal strips
// (one small canvas per strip) and encodes the export with a JPEG encoder in JavaScript (jpeg-js,
// loaded only when needed). Slower than the browser's own codecs, so it is the fallback only.

/** Pixels per strip canvas: well under any browser's limit. */
export const STRIP_AREA = 4 << 20;

/** Rows per strip for an image `width` wide, with strips of at most `area` pixels. */
export const stripRows = (width: number, area = STRIP_AREA) => Math.max(8, Math.floor(area / width));

/** RGBA bytes of a width × height image, read strip by strip (`read` returns one strip's RGBA). */
export async function assembleStrips(
  width: number,
  height: number,
  rows: number,
  read: (sy: number, sh: number) => Promise<Uint8ClampedArray>,
): Promise<Uint8ClampedArray> {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let sy = 0; sy < height; sy += rows) {
    const sh = Math.min(rows, height - sy);
    const strip = await read(sy, sh);
    if (strip.length !== width * sh * 4) throw new Error(`Strip at row ${sy} came back the wrong size`);
    out.set(strip, sy * width * 4);
  }
  return out;
}

/** Baseline JPEG of RGBA bytes without a canvas (4:4:4, like the Python app's exports). */
export async function encodeJpegJS(width: number, height: number, rgba: Uint8ClampedArray, quality: number) {
  // bundled as CommonJS, jpeg-js hands its bytes to Buffer.from, which browsers don't have
  const g = globalThis as { Buffer?: { from(a: ArrayLike<number>): Uint8Array } };
  g.Buffer ??= { from: (a) => Uint8Array.from(a) };
  const { encode } = await import("jpeg-js");
  const { data } = encode({ width, height, data: rgba }, quality);
  return new Blob([data as BlobPart], { type: "image/jpeg" });
}
