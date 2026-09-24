// Eyes open in the browser version (slidestation/eyes.py, function by function): the faces YuNet
// finds, each cut out as MediaPipe does (a square 1.5 × the box, eyes level, 256 px) and run through
// MediaPipe's face mesh (ONNX, in the jobs worker); per eye the eye aspect ratio, per face the mean of
// its two, kept in embeddings.json as the desktop app keeps it. Look-alikes (similar.ts) weigh it
// into "keep the best". eyes.py's docstrings say why each rule is what it is.
import type { ModelSource } from "./models";

export const MODEL_ID = "face-landmarks-478";
// Google's MediaPipe Face Landmarker face mesh (Apache-2.0), converted to ONNX by senty-au (pinned)
export const LANDMARKS: ModelSource = {
  repo: "https://huggingface.co/senty-au/face_landmarks_detector-ONNX/resolve/337d58218b5b1cc597ca3c67360880b920f6ce7b/",
  files: [
    [
      "onnx/model.onnx",
      "model.onnx",
      4920995,
      "sha256:7d6e82dee82a1dca5fbddb282b3cc74571833a530de317fc22ae325c3358beeb",
    ],
  ],
};

export const SIZE = 256;
export const CROP = 1.5;
export const MIN_SCORE = 0.7;
export const MIN_SIZE = 0.04;
export const PROMINENT = 0.5;
export const MAX_FACES = 8;
export const PRESENCE = 0.5;
export const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
export const LEFT_EYE = [362, 385, 387, 263, 373, 380];
export const CLOSED_EAR = 0.1;
export const OPEN_EAR = 0.18;
export const CLOSED = 0.5;

/** What embeddings.json keeps per slide: the EAR of each face that counts, largest first. */
export type EyesEntry = { model: string; ear: number[]; error?: string };

/** The eye aspect ratio of six points p1..p6 (eyes.ear). */
export function ear(p: ArrayLike<number>[]): number {
  const d = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const width = d(p[0], p[3]);
  if (width < 1e-6) return 0;
  return (d(p[1], p[5]) + d(p[2], p[4])) / (2 * width);
}

/** A face's EAR from the mesh's flat output (478 × `stride`): the mean of its two eyes. */
export function faceEar(pts: ArrayLike<number>, stride = 3): number {
  const at = (i: number) => [pts[i * stride], pts[i * stride + 1]];
  return (ear(RIGHT_EYE.map(at)) + ear(LEFT_EYE.map(at))) / 2;
}

export const openness = (e: number) => Math.min(1, Math.max(0, (e - CLOSED_EAR) / (OPEN_EAR - CLOSED_EAR)));

/** How open the eyes on a slide are (its least open face); null: no faces, not measured, another model. */
export function slideOpen(entry?: EyesEntry | null): number | null {
  if (!entry || entry.model !== MODEL_ID || !entry.ear?.length) return null;
  return Math.min(...entry.ear.map(openness));
}

/** The 2 × 3 affine from the picture to the 256 px crop around a YuNet row (eyes.crop_matrix). */
export function cropMatrix(face: ArrayLike<number>): number[] {
  const [x, y, w, h] = [face[0], face[1], face[2], face[3]];
  const angle = Math.atan2(face[7] - face[5], face[6] - face[4]);
  const [cx, cy, k] = [x + w / 2, y + h / 2, (Math.max(w, h) * CROP) / SIZE];
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  return [c / k, s / k, SIZE / 2 - (c * cx + s * cy) / k, -s / k, c / k, SIZE / 2 - (-s * cx + c * cy) / k];
}

/** Of the faces (width in the picture's pixels, detector score), the ones that count, largest first
 *  (eyes.measure): confident, not tiny, at least half as wide as the largest, at most MAX_FACES. */
export function prominent<T extends { w: number; score: number }>(faces: T[], width: number): T[] {
  const ok = faces.filter((f) => f.score >= MIN_SCORE && f.w >= MIN_SIZE * width).sort((a, b) => b.w - a.w);
  return ok.length ? ok.filter((f) => f.w >= PROMINENT * ok[0].w).slice(0, MAX_FACES) : [];
}

/** The model's input from the warped crop's 8-bit RGB: NHWC float 0..1. */
export const landmarkInput = (crop: { data: Uint8Array }) => Float32Array.from(crop.data, (v) => v / 255);

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The duplicate to keep (similar.best_of): quality as a share of the cluster's best, × (1 −
 *  EYES_WEIGHT + EYES_WEIGHT × open), slides without measured faces as open; the first of `ids` (tray
 *  order: an id of digits alone would come first in Object.keys) wins a tie. */
export const EYES_WEIGHT = 0.6;
export function bestOf(ids: string[], scores: Record<string, number>, opened: Record<string, number>): string {
  const top = Math.max(...ids.map((x) => scores[x])) || 1;
  const value = (x: string) => (scores[x] / top) * (1 - EYES_WEIGHT + EYES_WEIGHT * (opened[x] ?? 1));
  return ids.reduce((a, b) => (value(b) > value(a) ? b : a));
}
