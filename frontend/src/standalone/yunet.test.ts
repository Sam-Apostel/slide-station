// YuNet's decoding and NMS (yunet.ts) on made-up network outputs, and the model file rewrite.
// Parity with cv2.FaceDetectorYN on real photos was checked by hand (ARCHITECTURE.md §4c).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decode, faceVotes, freeInputSize, inputBlob, inputDims, nms, type Face, type Outputs } from "./yunet";
import { rgb, rotated } from "./pixels";

/** Outputs of a padW × padH input with nothing in them; `put` sets one anchor. */
function outputs(padW: number, padH: number) {
  const out: Outputs = {};
  for (const s of [8, 16, 32]) {
    const n = (padW / s) * (padH / s);
    out[`cls_${s}`] = new Float32Array(n);
    out[`obj_${s}`] = new Float32Array(n);
    out[`bbox_${s}`] = new Float32Array(n * 4);
    out[`kps_${s}`] = new Float32Array(n * 10);
  }
  const put = (s: number, r: number, c: number, score: number, bbox = [0.5, 0.5, 0, 0]) => {
    const i = r * (padW / s) + c;
    out[`cls_${s}`][i] = score; // score = sqrt(cls * obj)
    out[`obj_${s}`][i] = score;
    out[`bbox_${s}`].set(bbox, i * 4);
    out[`kps_${s}`].set([0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1], i * 10);
  };
  return { out, put };
}

describe("YuNet decoding", () => {
  it("decodes boxes, landmarks and scores like FaceDetectorYN", () => {
    const { out, put } = outputs(64, 64);
    put(8, 3, 2, 0.9, [0.5, 0.5, Math.log(4), Math.log(2)]);
    put(16, 1, 1, 0.5); // below the 0.6 threshold
    put(32, 0, 1, 1.5); // scores are clamped to 1
    const faces = decode(out, 64, 64);
    expect(faces).toHaveLength(2);
    const [a, b] = faces;
    expect(a.score).toBeCloseTo(0.9, 6);
    expect(a.box).toEqual([4, 20, 32, 16]); // centre ((2 + .5) * 8, (3 + .5) * 8), 4 × 2 strides
    expect(a.landmarks).toEqual([16, 24, 24, 24, 20, 28, 16, 32, 24, 32]);
    expect(b.score).toBe(1);
    expect(b.box).toEqual([32, 0, 32, 32]);
  });

  it("keeps the best of overlapping faces and every separate one", () => {
    const face = (x: number, y: number, w: number, score: number): Face => ({
      box: [x, y, w, w],
      landmarks: [],
      score,
    });
    const faces = [
      face(10, 10, 40, 0.8),
      face(12.9, 11.5, 40, 0.95), // overlaps the first (IoU of the integer boxes ≈ 0.86)
      face(100, 100, 30, 0.7),
      face(30, 10, 40, 0.75), // IoU 0.37 with the second: suppressed (> 0.3)
      face(40, 10, 40, 0.85), // IoU 0.17 with the second: kept
      face(200, 200, 30, 0.6), // not above the score threshold
    ];
    expect(nms(faces).map((f) => f.score)).toEqual([0.95, 0.85, 0.7]);
    expect(nms([faces[5]])).toEqual([faces[5]]); // a single face skips NMS, as in OpenCV
  });

  it("builds the padded, planar BGR input for each rotation", () => {
    const w = 3;
    const h = 2;
    const bgr = Uint8Array.from({ length: w * h * 3 }, (_, i) => i);
    for (const rot of [0, 90, 180, 270]) {
      const b = inputBlob({ width: w, height: h, bgr }, rot);
      expect([b.padW, b.padH]).toEqual([32, 32]);
      // same turn as pixels.rotated
      const img = rgb(w, h, Float32Array.from(bgr));
      const r = rotated(img, rot);
      expect([b.width, b.height]).toEqual([r.width, r.height]);
      for (let y = 0; y < r.height; y++)
        for (let x = 0; x < r.width; x++)
          for (let c = 0; c < 3; c++) expect(b.blob[c * 32 * 32 + y * 32 + x]).toBe(r.data[(y * r.width + x) * 3 + c]);
      expect(b.blob[31]).toBe(0); // padding
    }
  });

  it("votes for the rotation whose frame has confident faces", async () => {
    const img = rgb(1600, 1000); // landscape: turned 90 / 270 it is portrait
    const votes = await faceVotes(img, async (_blob, width, height) => {
      const { out, put } = outputs(width, height);
      if (height > width) put(32, 3, 4, 0.9); // a face only when upright is portrait
      if (height > width) put(32, 10, 10, 0.65); // counts as a face, too weak to vote
      return out;
    });
    expect(votes[0]).toBe(0);
    expect(votes[180]).toBe(0);
    expect(votes[90]).toBeCloseTo(0.9, 6);
    expect(votes[270]).toBeCloseTo(0.9, 6);
  });
});

describe("YuNet model file", () => {
  const model = new Uint8Array(
    readFileSync(new URL("../../../slidestation/models/face_detection_yunet_2023mar.onnx", import.meta.url)),
  );

  it("frees the input's height and width", () => {
    expect(inputDims(model)).toEqual([1, 3, 640, 640]);
    const free = freeInputSize(model);
    expect(inputDims(free)).toEqual([1, 3, "height", "width"]);
    // everything else (the weights) is untouched
    expect(Math.abs(free.length - model.length)).toBeLessThan(4096);
  });
});
