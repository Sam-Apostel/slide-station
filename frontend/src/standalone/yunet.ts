// Faces for the rotation guess: OpenCV's YuNet (slidestation/models, MIT) run through
// onnxruntime-web, with cv2.FaceDetectorYN's pre-processing, decoding and NMS reproduced here so
// the browser votes like imaging.face_votes. The model runtime is loaded by the worker on the first
// import (engine.worker.ts); everything in this file is plain maths and testable without it.
import { resized, type RGB } from "./pixels";

export const SCORE_THRESHOLD = 0.6;
export const NMS_THRESHOLD = 0.3;
export const TOP_K = 5000;
/** A face counts towards a rotation from this score on (imaging.face_votes). */
export const VOTE_SCORE = 0.7;
const STRIDES = [8, 16, 32];

/** One detection, as FaceDetectorYN returns it: box, five landmarks (eyes, nose, mouth corners), score. */
export type Face = { box: [number, number, number, number]; landmarks: number[]; score: number };
/** The network's outputs by name (cls_8, obj_8, bbox_8, kps_8, ... _16, _32). */
export type Outputs = Record<string, Float32Array>;
/** One forward pass: a 1×3×h×w BGR float blob in, the named outputs back. */
export type Run = (blob: Float32Array, width: number, height: number) => Promise<Outputs>;

const f32 = Math.fround;

/**
 * The frame YuNet sees for a slide, as uint8 BGR (interleaved): 800 px wide, area-averaged like
 * `cv2.resize(rgb, (800, int(800 * h / w)), INTER_AREA)`, then `(x * 255).astype(uint8)`.
 */
export function detectorFrame(a: RGB): { width: number; height: number; bgr: Uint8Array } {
  const width = 800;
  const height = Math.trunc((800 * a.height) / a.width);
  const s = resized(a, width, height);
  const bgr = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    // float32 multiply, then truncate, as numpy does
    bgr[i * 3] = Math.trunc(f32(s.data[i * 3 + 2] * 255));
    bgr[i * 3 + 1] = Math.trunc(f32(s.data[i * 3 + 1] * 255));
    bgr[i * 3 + 2] = Math.trunc(f32(s.data[i * 3] * 255));
  }
  return { width, height, bgr };
}

/**
 * The network input for the frame turned clockwise by `rot`: planar (NCHW) float, zero-padded on
 * the right and bottom to a multiple of 32 (FaceDetectorYN's padWithDivisor + blobFromImage).
 */
export function inputBlob(frame: { width: number; height: number; bgr: Uint8Array }, rot: number) {
  const { width: w, height: h, bgr } = frame;
  const r = ((rot % 360) + 360) % 360;
  const width = r === 90 || r === 270 ? h : w;
  const height = r === 90 || r === 270 ? w : h;
  const padW = Math.trunc((width - 1) / 32 + 1) * 32;
  const padH = Math.trunc((height - 1) / 32 + 1) * 32;
  const plane = padW * padH;
  const blob = new Float32Array(3 * plane);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      // the source pixel of (x, y) in the clockwise-turned frame (pixels.rotated)
      const [sx, sy] =
        r === 90 ? [y, h - 1 - x] : r === 180 ? [w - 1 - x, h - 1 - y] : r === 270 ? [w - 1 - y, x] : [x, y];
      const si = (sy * w + sx) * 3;
      const di = y * padW + x;
      blob[di] = bgr[si];
      blob[plane + di] = bgr[si + 1];
      blob[2 * plane + di] = bgr[si + 2];
    }
  return { blob, width, height, padW, padH };
}

/** FaceDetectorYN::postProcess before NMS: every anchor scoring at least the threshold, as a face. */
export function decode(out: Outputs, padW: number, padH: number, scoreThreshold = SCORE_THRESHOLD): Face[] {
  const faces: Face[] = [];
  for (const s of STRIDES) {
    const cols = Math.trunc(padW / s);
    const rows = Math.trunc(padH / s);
    const cls = out[`cls_${s}`];
    const obj = out[`obj_${s}`];
    const bbox = out[`bbox_${s}`];
    const kps = out[`kps_${s}`];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const clsScore = Math.min(Math.max(cls[i], 0), 1);
        const objScore = Math.min(Math.max(obj[i], 0), 1);
        const score = f32(Math.sqrt(f32(clsScore * objScore)));
        if (score < scoreThreshold) continue;
        const cx = f32((c + bbox[i * 4]) * s);
        const cy = f32((r + bbox[i * 4 + 1]) * s);
        const w = f32(Math.exp(bbox[i * 4 + 2]) * s);
        const h = f32(Math.exp(bbox[i * 4 + 3]) * s);
        const landmarks: number[] = [];
        for (let n = 0; n < 5; n++)
          landmarks.push(f32((kps[i * 10 + 2 * n] + c) * s), f32((kps[i * 10 + 2 * n + 1] + r) * s));
        faces.push({ box: [f32(cx - w / 2), f32(cy - h / 2), w, h], landmarks, score });
      }
  }
  return faces;
}

type Rect = [number, number, number, number];

/** Intersection over union of integer rectangles, as cv::Rect's `&` and area() compute it. */
function overlap(a: Rect, b: Rect): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - x1;
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - y1;
  const inter = w <= 0 || h <= 0 ? 0 : w * h;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * cv::dnn::NMSBoxes over the faces' boxes truncated to integers (FaceDetectorYN builds Rect2i):
 * candidates scoring above the threshold, best first (stable), greedily kept while they overlap no
 * kept box by more than `nmsThreshold`. A single face skips NMS, as in OpenCV.
 */
export function nms(faces: Face[], scoreThreshold = SCORE_THRESHOLD, nmsThreshold = NMS_THRESHOLD, topK = TOP_K) {
  if (faces.length <= 1) return faces;
  const rects = faces.map((f) => f.box.map(Math.trunc) as Rect);
  let order = faces.map((f, i) => i).filter((i) => faces[i].score > scoreThreshold);
  order.sort((a, b) => faces[b].score - faces[a].score);
  if (topK > 0 && topK < order.length) order = order.slice(0, topK);
  const keep: number[] = [];
  for (const i of order) if (keep.every((k) => overlap(rects[i], rects[k]) <= nmsThreshold)) keep.push(i);
  return keep.map((i) => faces[i]);
}

/** All faces in the frame turned by `rot`, in that turned frame's pixel coordinates. */
export async function detect(frame: ReturnType<typeof detectorFrame>, rot: number, run: Run): Promise<Face[]> {
  const b = inputBlob(frame, rot);
  return nms(decode(await run(b.blob, b.padW, b.padH), b.padW, b.padH));
}

/** Sum of confident face scores at each candidate rotation (imaging.face_votes). */
export async function faceVotes(a: RGB, run: Run): Promise<Record<number, number>> {
  const frame = detectorFrame(a);
  const votes: Record<number, number> = {};
  for (const r of [0, 90, 180, 270]) {
    let v = 0;
    for (const f of await detect(frame, r, run)) if (f.score >= VOTE_SCORE) v = f32(v + f.score);
    votes[r] = v;
  }
  return votes;
}

// ------------------------------------------------------------------ model file

// The ONNX file declares a fixed 640×640 input, which OpenCV ignores but onnxruntime enforces. The
// graph itself works at any size (it reshapes with -1), so before loading we rewrite the input's
// height and width as named (free) dimensions and drop the declared output and intermediate shapes.
// A minimal protobuf rewrite: ModelProto.graph (7) → GraphProto.input (11) / output (12) /
// value_info (13) → ValueInfoProto.type (2) → TypeProto.tensor_type (1) → shape (2) → dim (1).

type Field = { no: number; wire: number; start: number; end: number; body?: Uint8Array };

function varint(buf: Uint8Array, o: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (;;) {
    const b = buf[o++];
    v += (b & 0x7f) * mul;
    if (b < 0x80) return [v, o];
    mul *= 128;
  }
}

function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let o = 0;
  while (o < buf.length) {
    const start = o;
    let tag: number;
    [tag, o] = varint(buf, o);
    const no = Math.floor(tag / 8);
    const wire = tag & 7;
    let body: Uint8Array | undefined;
    if (wire === 0) o = varint(buf, o)[1];
    else if (wire === 1) o += 8;
    else if (wire === 5) o += 4;
    else if (wire === 2) {
      let len: number;
      [len, o] = varint(buf, o);
      body = buf.subarray(o, o + len);
      o += len;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    out.push({ no, wire, start, end: o, body });
  }
  return out;
}

function encodeVarint(v: number): number[] {
  const out: number[] = [];
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

const lenField = (no: number, body: Uint8Array) =>
  concat([Uint8Array.from([...encodeVarint(no * 8 + 2), ...encodeVarint(body.length)]), body]);

/** Rebuild a message, replacing (or with null, dropping) the length-delimited fields `fn` picks. */
function rewrite(buf: Uint8Array, fn: (f: Field) => Uint8Array | null | undefined): Uint8Array {
  return concat(
    fields(buf).flatMap((f) => {
      const body = f.body ? fn(f) : undefined;
      if (body === undefined) return [buf.subarray(f.start, f.end)];
      return body === null ? [] : [lenField(f.no, body)];
    }),
  );
}

/** A tensor ValueInfoProto with its shape rewritten by `shape` (null: no declared shape). */
function withShape(info: Uint8Array, shape: (dims: Uint8Array[]) => Uint8Array[] | null): Uint8Array {
  return rewrite(info, (f) =>
    f.no !== 2
      ? undefined
      : rewrite(f.body!, (t) =>
          t.no !== 1
            ? undefined
            : rewrite(t.body!, (s) => {
                if (s.no !== 2) return undefined;
                const dims = shape(
                  fields(s.body!)
                    .filter((d) => d.no === 1)
                    .map((d) => d.body!),
                );
                return dims && concat(dims.map((d) => lenField(1, d)));
              }),
        ),
  );
}

const dimParam = (name: string) => lenField(2, new TextEncoder().encode(name));

/** The model with a free-size input (N, C, h, w) and no fixed output shapes. */
export function freeInputSize(model: Uint8Array): Uint8Array {
  return rewrite(model, (f) =>
    f.no !== 7
      ? undefined
      : rewrite(f.body!, (g) => {
          if (g.no === 11) return withShape(g.body!, (d) => [d[0], d[1], dimParam("height"), dimParam("width")]);
          if (g.no === 12) return withShape(g.body!, () => null);
          if (g.no === 13) return null;
          return undefined;
        }),
  );
}

/** The declared input dimensions (numbers, or names for free ones): for the tests. */
export function inputDims(model: Uint8Array): (number | string)[] {
  const graph = fields(model).find((f) => f.no === 7)!.body!;
  const input = fields(graph).find((f) => f.no === 11)!.body!;
  const type = fields(input).find((f) => f.no === 2)!.body!;
  const tensor = fields(type).find((f) => f.no === 1)!.body!;
  const shape = fields(tensor).find((f) => f.no === 2)!.body!;
  return fields(shape)
    .filter((d) => d.no === 1)
    .map((d) => {
      const v = fields(d.body!)[0];
      return v.no === 1 ? varint(d.body!, v.start + 1)[0] : new TextDecoder().decode(v.body);
    });
}
