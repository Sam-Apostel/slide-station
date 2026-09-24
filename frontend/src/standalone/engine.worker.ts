// The pixel work of the browser version, off the UI thread: decoding scans, proxies, fusing
// brackets, rendering previews and full-resolution exports. The page keeps storage and state
// (server.ts); this worker only turns blobs into blobs and numbers. Decoded proxies are kept in
// a small cache, so moving a slider re-renders without decoding again.
import type { Params } from "@/lib/api";
import * as im from "./imaging";
import { fuseSources, materialise, rgba8Source, type RowSource } from "./fusion";
import { features } from "./learning";
import { fitting, rgb, rotated, type RGB } from "./pixels";

/** An image to work on: `key` names its decoded pixels in the cache, `blob` decodes them on a miss. */
export type Src = { key: string; blob: Blob };

const cache = new Map<string, RGB>();
const CACHE_MAX = 12; // 1600 px proxies are ~20 MB each as floats

/** Width and height from a JPEG's frame header, without decoding it. */
async function jpegSize(blob: Blob): Promise<[number, number] | null> {
  const v = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer());
  let o = 2;
  while (o + 9 < v.byteLength) {
    const m = v.getUint16(o);
    if ((m & 0xff00) !== 0xff00) return null;
    if (m >= 0xffc0 && m <= 0xffcf && m !== 0xffc4 && m !== 0xffc8 && m !== 0xffcc)
      return [v.getUint16(o + 7), v.getUint16(o + 5)];
    o += 2 + v.getUint16(o + 2);
  }
  return null;
}

/** RGBA bytes of an image, optionally shrunk on decode (the browser's fast path, like PIL's draft). */
async function decodeRGBA(
  blob: Blob,
  maxEdge?: number,
): Promise<{ width: number; height: number; bytes: Uint8ClampedArray }> {
  let opts: ImageBitmapOptions = { colorSpaceConversion: "none" };
  if (maxEdge) {
    const size = await jpegSize(blob);
    if (size && Math.max(...size) > maxEdge) {
      const s = maxEdge / Math.max(...size);
      opts = {
        ...opts,
        resizeWidth: Math.max(1, Math.round(size[0] * s)),
        resizeHeight: Math.max(1, Math.round(size[1] * s)),
        resizeQuality: "high",
      };
    }
  }
  const bmp = await createImageBitmap(blob, opts);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, bytes: d.data };
}

async function decode(blob: Blob, maxEdge?: number): Promise<RGB> {
  const { width, height, bytes } = await decodeRGBA(blob, maxEdge);
  const out = rgb(width, height);
  for (let i = 0, n = width * height; i < n; i++) {
    out.data[i * 3] = bytes[i * 4] / 255;
    out.data[i * 3 + 1] = bytes[i * 4 + 1] / 255;
    out.data[i * 3 + 2] = bytes[i * 4 + 2] / 255;
  }
  return out;
}

async function load(src: Src): Promise<RGB> {
  const hit = cache.get(src.key);
  if (hit) {
    cache.delete(src.key); // most recently used goes last
    cache.set(src.key, hit);
    return hit;
  }
  const a = await decode(src.blob);
  cache.set(src.key, a);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return a;
}

/** JPEG of float RGB, shrunk (area average) to fit maxEdge first. */
async function encode(a: RGB, quality: number, maxEdge?: number): Promise<Blob> {
  const s = maxEdge ? fitting(a, maxEdge) : a;
  const px = new Uint8ClampedArray(s.width * s.height * 4);
  // Uint8ClampedArray clamps and rounds to nearest: Python's clip, * 255 + 0.5, astype(uint8)
  for (let i = 0, n = s.width * s.height; i < n; i++) {
    px[i * 4] = s.data[i * 3] * 255;
    px[i * 4 + 1] = s.data[i * 3 + 1] * 255;
    px[i * 4 + 2] = s.data[i * 3 + 2] * 255;
    px[i * 4 + 3] = 255;
  }
  const c = new OffscreenCanvas(s.width, s.height);
  c.getContext("2d")!.putImageData(new ImageData(px, s.width, s.height), 0, 0);
  return c.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
}

/** Clockwise rotation of RGBA bytes (a quarter of the memory of rotating floats). */
function rotateRGBA(width: number, height: number, bytes: Uint8ClampedArray, degrees: number) {
  const rot = ((degrees % 360) + 360) % 360;
  if (!rot) return { width, height, bytes };
  const src = new Uint32Array(bytes.buffer, bytes.byteOffset, width * height);
  const ow = rot === 180 ? width : height;
  const oh = rot === 180 ? height : width;
  const out = new Uint32Array(ow * oh);
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const [sx, sy] =
        rot === 90 ? [y, height - 1 - x] : rot === 180 ? [width - 1 - x, height - 1 - y] : [width - 1 - y, x];
      out[y * ow + x] = src[sy * width + sx];
    }
  return { width: ow, height: oh, bytes: new Uint8ClampedArray(out.buffer) };
}

/** Full resolution: blend the originals, turn, develop (what an export and 1:1 zoom show). */
async function renderFull(blobs: Blob[], rotation: number, params: Params): Promise<RGB> {
  const decoded = [];
  for (const b of blobs) {
    const d = await decodeRGBA(b);
    decoded.push(rotateRGBA(d.width, d.height, d.bytes, rotation)); // turning bytes first is cheaper than floats after
  }
  const sources = decoded.map((d) => rgba8Source(d.width, d.height, d.bytes));
  const a = sources.length === 1 ? materialise(sources[0]) : fuseSources(sources);
  decoded.length = 0;
  return im.develop(a, params, true, true);
}

/** The slide last zoomed into at full resolution, as RGBA bytes (one slide only: ~90 MB at 22 MP). */
let zoomed: { key: string; width: number; height: number; bytes: Uint8ClampedArray } | null = null;

const ops = {
  /** A new scan: its 1600 px proxy and 240 px thumbnail (JPEG), grouping signature and quality. */
  async proxy({ blob }: { blob: Blob }) {
    const a = await decode(blob, im.PROXY_EDGE);
    return {
      proxy: await encode(a, 92),
      thumb: await encode(a, 80, 240),
      sig: im.signature(a),
      quality: im.scanQuality(a),
    };
  },

  /** Sharpness and clipping of a scan's proxy (best of bracket). */
  async quality({ blob }: { blob: Blob }) {
    return im.scanQuality(await decode(blob));
  },

  /** Blend a bracket's proxies (aligned, Mertens) into one JPEG. */
  async fuse({ blobs }: { blobs: Blob[] }) {
    const imgs = await Promise.all(blobs.map((b) => decode(b)));
    const sources: RowSource[] = imgs.map((a) => ({
      width: a.width,
      height: a.height,
      row: (y, out) => out.set(a.data.subarray(y * a.width * 3, (y + 1) * a.width * 3)),
    }));
    return encode(fuseSources(sources), 95);
  },

  /** Rotation guess from the active scans' proxies, and learning features of the blended slide. */
  async analyse({ proxies, fused, scans }: { proxies: Src[]; fused: Src; scans: number }) {
    const imgs = await Promise.all(proxies.map((p) => decode(p.blob)));
    const [deg, why] = im.suggestRotation(imgs);
    return { rotation: deg, reason: why, features: features(await load(fused), scans) };
  },

  async render(a: { src: Src; rotation: number; params: Params; size: number; before: boolean; uncropped: boolean }) {
    let img = await load(a.src);
    if (a.size <= 400) img = fitting(img, 480); // develop on a smaller image for thumbnails
    img = rotated(img, a.rotation);
    const out = a.before ? im.beforeView(img, a.params, !a.uncropped) : im.develop(img, a.params, !a.uncropped);
    return encode(out, 85, a.size);
  },

  /** Any picture (e.g. Immich's own preview of a locked slide), shrunk to fit. */
  async resize({ blob, size }: { blob: Blob; size: number }) {
    return encode(await decode(blob, size), 85, size);
  },

  async histogram({ src, params }: { src: Src; params: Params }) {
    return im.histogram(im.toneBase(await load(src), params));
  },

  async fit({ src, params }: { src: Src; params: Params }) {
    return im.fitCurves(im.toneBase(await load(src), params), params.curves);
  },

  async neutral({ src, rotation, params, x, y }: { src: Src; rotation: number; params: Params; x: number; y: number }) {
    return im.neutralBalance(rotated(await load(src), rotation), params, x, y);
  },

  /** Full resolution: blend the originals, turn, develop, JPEG (EXIF is added by the page). */
  async full({
    blobs,
    rotation,
    params,
    quality,
  }: {
    blobs: Blob[];
    rotation: number;
    params: Params;
    quality: number;
  }) {
    return encode(await renderFull(blobs, rotation, params), quality);
  },

  /**
   * 1:1 zoom: render the slide at full resolution (or decode its fresh export) and keep it for
   * `tile`. Returns its size. `key` names the render; asking for the same one again is free.
   */
  async zoomImage({
    key,
    exported,
    blobs,
    rotation,
    params,
  }: {
    key: string;
    exported: Blob | null;
    blobs: Blob[];
    rotation: number;
    params: Params;
  }) {
    if (zoomed?.key !== key) {
      zoomed = null; // free the previous slide first
      if (exported) zoomed = { key, ...(await decodeRGBA(exported)) };
      else {
        const a = await renderFull(blobs, rotation, params);
        const bytes = new Uint8ClampedArray(a.width * a.height * 4);
        for (let i = 0, n = a.width * a.height; i < n; i++) {
          bytes[i * 4] = a.data[i * 3] * 255;
          bytes[i * 4 + 1] = a.data[i * 3 + 1] * 255;
          bytes[i * 4 + 2] = a.data[i * 3 + 2] * 255;
          bytes[i * 4 + 3] = 255;
        }
        zoomed = { key, width: a.width, height: a.height, bytes };
      }
    }
    return { width: zoomed.width, height: zoomed.height };
  },

  /** A size x size square (col, row) of the zoomed slide as JPEG; fails if that slide isn't held. */
  async tile({ key, col, row, size }: { key: string; col: number; row: number; size: number }) {
    const z = zoomed;
    if (z?.key !== key) throw new Error("not rendered");
    const [x0, y0] = [col * size, row * size];
    const w = Math.min(size, z.width - x0);
    const h = Math.min(size, z.height - y0);
    if (col < 0 || row < 0 || w <= 0 || h <= 0) throw new Error("No such tile");
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      px.set(z.bytes.subarray(((y0 + y) * z.width + x0) * 4, ((y0 + y) * z.width + x0 + w) * 4), y * w * 4);
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d")!.putImageData(new ImageData(px, w, h), 0, 0);
    return c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  },
};

export type Ops = typeof ops;
export type Op = keyof Ops;

// One task at a time, highest priority first: the photo on screen before filmstrip thumbnails.
type Task = { id: number; op: Op; args: unknown; priority: number };
const queue: Task[] = [];
let running = false;

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
    const t = queue.shift()!;
    try {
      const result = await (ops[t.op] as (a: unknown) => Promise<unknown>)(t.args);
      postMessage({ id: t.id, result });
    } catch (e) {
      postMessage({ id: t.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  running = false;
}

self.onmessage = (e: MessageEvent<Task | { drop: string }>) => {
  if ("drop" in e.data) {
    // a slide's scans changed: forget its decoded pixels
    for (const k of [...cache.keys()]) if (k.startsWith(e.data.drop)) cache.delete(k);
    return;
  }
  queue.push(e.data);
  pump();
};
