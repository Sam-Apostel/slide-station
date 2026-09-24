// The pixel work of the browser version, off the UI thread: decoding scans, proxies, fusing
// brackets, rendering previews and full-resolution exports. The page keeps storage and state
// (server.ts); this worker only turns blobs into blobs and numbers. Decoded proxies are kept in
// a small cache, so moving a slider re-renders without decoding again.
import type { Params } from "@/lib/api";
import * as im from "./imaging";
import { readExif } from "./exif";
import { fuseSources, materialise, rgba8Source, type RowSource } from "./fusion";
import { features } from "./learning";
import { cropped, fitting, resized, rgb, rotated, type RGB } from "./pixels";
import { assembleStrips, encodeJpegJS, stripRows, STRIP_AREA } from "./strips";
import { detect, detectorFrame, faceVotes, freeInputSize, type Run } from "./yunet";
import * as people from "./people";
import { preprocess, toBytes, unit } from "./clip";
import * as ocr from "./ocr";
import { levels, normalise } from "./similar";
// served with the static site (web build only), fetched on the first import
import yunetUrl from "../../../slidestation/models/face_detection_yunet_2023mar.onnx?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

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

// Canvases this big may not exist (Safari on iPad / iPhone: about 16.7 MP). Tests set a small
// limit to run the strip fallback anywhere (engine.ts, localStorage "slide-station-canvas-limit").
let canvasLimit = Infinity;

/** A 2D context of that size, or null where the browser can't make one (strips.ts takes over). */
function context(width: number, height: number, read: boolean): OffscreenCanvasRenderingContext2D | null {
  if (width * height > canvasLimit) return null;
  try {
    const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: read });
    if (!ctx || width * height <= STRIP_AREA) return ctx;
    // an oversized canvas can also come back fine on paper and draw nothing: try its far corner
    ctx.fillStyle = "#fff";
    ctx.fillRect(width - 1, height - 1, 1, 1);
    const ok = ctx.getImageData(width - 1, height - 1, 1, 1).data[3] === 255;
    ctx.clearRect(width - 1, height - 1, 1, 1);
    return ok ? ctx : null;
  } catch {
    return null;
  }
}

/** RGBA bytes of a bitmap, through one canvas or, failing that, strip by strip. Closes the bitmap. */
async function bitmapRGBA(bmp: ImageBitmap, canvas?: OffscreenCanvasRenderingContext2D) {
  const { width, height } = bmp;
  const ctx = canvas ?? context(width, height, true);
  let bytes: Uint8ClampedArray;
  if (ctx) {
    ctx.drawImage(bmp, 0, 0);
    bytes = ctx.getImageData(0, 0, width, height).data;
  } else {
    const rows = stripRows(width, Math.min(STRIP_AREA, canvasLimit));
    const strip = context(width, rows, true)!;
    bytes = await assembleStrips(width, height, rows, async (sy, sh) => {
      strip.clearRect(0, 0, width, rows);
      strip.drawImage(bmp, 0, sy, width, sh, 0, 0, width, sh);
      return strip.getImageData(0, 0, width, sh).data;
    });
  }
  bmp.close();
  return { width, height, bytes };
}

/** Full resolution without a full-size canvas or bitmap: each strip is decoded from the file. */
async function decodeStrips(blob: Blob, width: number, height: number) {
  // strips are cut in the file's own frame; a scan turned by its EXIF tag would come out scrambled
  // (scanner scans never are, and the Python app ignores the tag as well)
  if ((readExif(await blob.slice(0, 128 * 1024).arrayBuffer()).orientation ?? 1) !== 1)
    throw new Error("This scan is too large for this browser and turned by its EXIF orientation");
  const rows = stripRows(width, Math.min(STRIP_AREA, canvasLimit));
  const strip = context(width, rows, true);
  if (!strip) throw new Error("This browser can't make a canvas for decoding the scan");
  const bytes = await assembleStrips(width, height, rows, async (sy, sh) => {
    const bmp = await createImageBitmap(blob, 0, sy, width, sh, { colorSpaceConversion: "none" });
    strip.clearRect(0, 0, width, rows);
    strip.drawImage(bmp, 0, 0);
    bmp.close();
    return strip.getImageData(0, 0, width, sh).data;
  });
  return { width, height, bytes };
}

/** RGBA bytes of an image, optionally shrunk on decode (the browser's fast path, like PIL's draft). */
async function decodeRGBA(
  blob: Blob,
  maxEdge?: number,
): Promise<{ width: number; height: number; bytes: Uint8ClampedArray }> {
  let opts: ImageBitmapOptions = { colorSpaceConversion: "none" };
  const size = await jpegSize(blob);
  let ctx: OffscreenCanvasRenderingContext2D | null | undefined;
  if (!maxEdge && size && size[0] * size[1] > Math.min(STRIP_AREA, canvasLimit)) {
    ctx = context(size[0], size[1], true);
    if (!ctx) return decodeStrips(blob, size[0], size[1]); // too big for one canvas here
  }
  if (maxEdge) {
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
  return bitmapRGBA(bmp, ctx?.canvas.width === bmp.width && ctx.canvas.height === bmp.height ? ctx : undefined);
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
  const ctx = context(s.width, s.height, false);
  if (ctx) {
    ctx.putImageData(new ImageData(px, s.width, s.height), 0, 0);
    try {
      return await (ctx.canvas as OffscreenCanvas).convertToBlob({ type: "image/jpeg", quality: quality / 100 });
    } catch {
      /* the browser's encoder gave up on the size: the one in JS below */
    }
  }
  return encodeJpegJS(s.width, s.height, px, quality);
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

type Ort = typeof import("onnxruntime-web/wasm");
let ortLib: Promise<Ort> | null = null;

/** onnxruntime-web (wasm backend, one thread), imported the first time a model runs. */
function onnx(): Promise<Ort> {
  ortLib ??= import("onnxruntime-web/wasm").then((ort) => {
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
    ort.env.wasm.numThreads = 1; // threads need a cross-origin isolated page
    return ort;
  });
  return ortLib;
}

let yunet: Promise<Run | null> | null = null;

/**
 * YuNet through onnxruntime-web, loaded the first time a slide's rotation is guessed. Null when it
 * can't run here (no WebAssembly, the model didn't load): the sky rule then guesses alone.
 */
function faceDetector(): Promise<Run | null> {
  yunet ??= (async () => {
    try {
      const ort = await onnx();
      const model = freeInputSize(new Uint8Array(await (await fetch(yunetUrl)).arrayBuffer()));
      const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
      const run: Run = async (blob, width, height) => {
        const input = new ort.Tensor("float32", blob, [1, 3, height, width]);
        const out = await session.run({ [session.inputNames[0]]: input });
        return Object.fromEntries(Object.entries(out).map(([k, t]) => [k, t.data as Float32Array]));
      };
      return run;
    } catch (e) {
      console.warn("Face detection is unavailable, rotation guesses use the sky only:", e);
      return null;
    }
  })();
  return yunet;
}

/** A model file from the library: `key` names its version (size and date), `blob` loads it on a miss. */
export type ModelRef = { key: string; blob: Blob };

// The suggestion models kept loaded while slides are analysed (CLIP's image half, the text
// reader's two networks), by file version; CLIP's text half only runs once per library, to embed
// the label prompts, and isn't kept.
type Session = import("onnxruntime-web/wasm").InferenceSession;
const sessions = new Map<string, Promise<Session>>();

function session(m: ModelRef): Promise<Session> {
  let s = sessions.get(m.key);
  if (!s) {
    // log errors only: the graph optimiser's warnings (SFace's initializers) would be console errors
    s = Promise.all([onnx(), m.blob.arrayBuffer()]).then(([ort, b]) =>
      ort.InferenceSession.create(new Uint8Array(b), { executionProviders: ["wasm"], logSeverityLevel: 3 }),
    );
    sessions.set(m.key, s);
    s.catch(() => sessions.delete(m.key)); // try again next time
  }
  return s;
}

async function clipEmbed(m: ModelRef, a: RGB): Promise<Float32Array> {
  const [ort, s] = await Promise.all([onnx(), session(m)]);
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", preprocess(a), [1, 3, 224, 224]) });
  return unit(out[s.outputNames[0]].data as Float32Array);
}

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

  /** Rotation guess from the active scans' proxies; learning features and mount of the blended slide. */
  async analyse({ proxies, fused, scans }: { proxies: Src[]; fused: Src; scans: number }) {
    const imgs = await Promise.all(proxies.map((p) => decode(p.blob)));
    const run = await faceDetector();
    const votes = [];
    if (run) for (const a of imgs) votes.push(await faceVotes(a, run));
    const [deg, why] = im.suggestRotation(imgs, run ? votes : undefined);
    const blend = await load(fused);
    return { rotation: deg, reason: why, features: features(blend, scans), mount: im.detectMount(blend) };
  },

  /** The slide mount's tilt and sides on the blended (unturned) slide. */
  async mount({ src }: { src: Src }) {
    return im.detectMount(await load(src));
  },

  /** The crop that trims to the mount's window (box already turned like the slide). */
  async mountCrop({
    src,
    rotation,
    params,
    box,
  }: {
    src: Src;
    rotation: number;
    params: Params;
    box: (number | null)[];
  }) {
    return im.mountCrop(rotated(await load(src), rotation), params, box);
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

  /** CLIP's embedding of a slide's blend turned upright (the scene tags and look-alikes, insights.py),
   *  with its sharpness / clipping for "keep the best" (similar.record_slide). */
  async clipImage({ model, src, rotation }: { model: ModelRef; src: Src; rotation: number }) {
    const a = rotated(await load(src), rotation);
    return { emb: await clipEmbed(model, a), quality: im.scanQuality(a) };
  },

  /** A scan's embedding with its exposure taken out, and its mean brightness (similar.embed_scan). */
  async clipScan({ model, blob }: { model: ModelRef; blob: Blob }) {
    const a = await decode(blob);
    let sum = 0;
    for (const v of a.data) sum += v;
    return { emb: await clipEmbed(model, normalise(a)), lum: Math.round((sum / a.data.length) * 1e4) / 1e4 };
  },

  /** An Immich thumbnail's embedding, levelled (similar._thumb_embedding). */
  async clipThumb({ model, blob }: { model: ModelRef; blob: Blob }) {
    return clipEmbed(model, levels(await decode(blob)));
  },

  /** The label prompts' text embeddings (insights.Clip.text_embed), one unit row each. */
  async clipText({ model, ids, length }: { model: ModelRef; ids: number[][]; length: number }) {
    const ort = await onnx();
    const session = await ort.InferenceSession.create(new Uint8Array(await model.blob.arrayBuffer()), {
      executionProviders: ["wasm"],
      logSeverityLevel: 3,
    });
    const input = new ort.Tensor(
      "int64",
      BigInt64Array.from(ids.flat(), (x) => BigInt(x)),
      [ids.length, length],
    );
    const out = (await session.run({ [session.inputNames[0]]: input }))[session.outputNames[0]];
    await session.release();
    const d = out.dims[1];
    const rows = new Float32Array(ids.length * d);
    for (let i = 0; i < ids.length; i++) rows.set(unit((out.data as Float32Array).subarray(i * d, (i + 1) * d)), i * d);
    return rows;
  },

  /** The text in a slide's blend turned upright (places.read_text): PaddleOCR's detector, then the
   *  recogniser on each box. Lines top to bottom, {text, confidence}. */
  async ocrRead({
    det,
    rec,
    chars,
    src,
    rotation,
  }: {
    det: ModelRef;
    rec: ModelRef;
    chars: string[];
    src: Src;
    rotation: number;
  }) {
    const ort = await onnx();
    const a = rotated(await load(src), rotation);
    const img = { width: a.width, height: a.height, data: toBytes(a) };
    const [dw, dh] = ocr.detSize(a.width, a.height);
    const d = await session(det);
    const input = new ort.Tensor("float32", ocr.detInput(ocr.resizeLinear(img, dw, dh)), [1, 3, dh, dw]);
    const pred = (await d.run({ [d.inputNames[0]]: input }))[d.outputNames[0]].data as Float32Array;
    const r = await session(rec);
    const lines: { text: string; confidence: number }[] = [];
    for (const c of ocr.crops(img, ocr.boxes(pred, dw, dh, a.width, a.height))) {
      const x = ocr.recInput(c);
      const out = (await r.run({ [r.inputNames[0]]: new ort.Tensor("float32", x.data, [1, 3, ocr.REC_H, x.width]) }))[
        r.outputNames[0]
      ];
      const t = ocr.ctc(out.data as Float32Array, out.dims[1], out.dims[2], chars);
      if (t.text) lines.push({ text: t.text, confidence: Math.round(t.confidence * 1000) / 1000 });
    }
    return lines;
  },

  /** The clear faces on a slide's blend turned upright, each described by SFace (people.embed_faces):
   *  YuNet as for the rotation vote, faces ≥ 0.7 and ≥ 3 % of the width, alignCrop, the network. */
  async faces({ sface, src, rotation }: { sface: ModelRef; src: Src; rotation: number }) {
    const run = await faceDetector();
    if (!run) throw new Error("Face detection is unavailable in this browser");
    const a = rotated(await load(src), rotation);
    const frame = detectorFrame(a);
    const [sx, sy] = [Math.fround(a.width / frame.width), Math.fround(a.height / frame.height)]; // numpy: float32
    let bgr: { width: number; height: number; data: Uint8Array } | null = null;
    const out: { box: number[]; score: number; emb: Float32Array }[] = [];
    for (const f of await detect(frame, 0, run)) {
      // the detector's row in the picture's own pixels, float32 like the numpy array it is in Python
      const [x, y, w, h] = [f.box[0] * sx, f.box[1] * sy, f.box[2] * sx, f.box[3] * sy].map(Math.fround);
      if (f.score < people.MIN_SCORE || w < people.MIN_SIZE * a.width) continue;
      if (!bgr) {
        const data = new Uint8Array(a.width * a.height * 3);
        for (let i = 0; i < a.width * a.height; i++)
          for (let c = 0; c < 3; c++)
            data[i * 3 + c] = Math.trunc(Math.fround(Math.min(1, Math.max(0, a.data[i * 3 + 2 - c])) * 255));
        bgr = { width: a.width, height: a.height, data };
      }
      const marks = [0, 1, 2, 3, 4].map((k) => [
        Math.fround(f.landmarks[k * 2] * sx),
        Math.fround(f.landmarks[k * 2 + 1] * sy),
      ]);
      const aligned = people.warpAffine(bgr, people.similarityTransform(marks));
      const [ort, s] = [await onnx(), await session(sface)]; // loaded once there is a face
      const res = await s.run({
        [s.inputNames[0]]: new ort.Tensor("float32", people.sfaceInput(aligned), [1, 3, 112, 112]),
      });
      const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
      out.push({
        box: [r4(x / a.width), r4(y / a.height), r4(w / a.width), r4(h / a.height)],
        score: Math.round(f.score * 1000) / 1000,
        emb: unit(res[s.outputNames[0]].data as Float32Array),
      });
    }
    return out;
  },

  /** A face cut from the picture for the People dialog (people.face_crop): 128 px JPEG. */
  async faceCrop({ src, rotation, box }: { src: Src; rotation: number; box: number[] }) {
    const a = rotated(await load(src), rotation);
    const [x0, y0, x1, y1] = people.cropBox(a.width, a.height, box);
    return encode(resized(cropped(a, y0, y1, x0, x1), 128, 128), 85);
  },

  /** Let go of the suggestion models (turned off, or another library). */
  async clipRelease() {
    const all = [...sessions.values()];
    sessions.clear();
    for (const s of all) await s.then((x) => x.release()).catch(() => undefined);
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

self.onmessage = (e: MessageEvent<Task | { drop: string } | { canvasLimit: number }>) => {
  if ("canvasLimit" in e.data) {
    canvasLimit = e.data.canvasLimit;
    return;
  }
  if ("drop" in e.data) {
    // a slide's scans changed: forget its decoded pixels
    for (const k of [...cache.keys()]) if (k.startsWith(e.data.drop)) cache.delete(k);
    return;
  }
  queue.push(e.data);
  pump();
};
