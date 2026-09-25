// Faces -> people in the browser version (slidestation/people.py, function by function): the faces
// YuNet finds on a slide, each described by SFace (OpenCV's alignCrop to its 112 × 112 template,
// then the network, in the jobs worker), kept per tray in faces.json; clustered across the
// library into people.json with the same average-linkage rule, named once. The same files as the
// desktop app, so a library moves between them with its people.
import type { ModelSource } from "./models";
import { pyDumps, PyInt, sha1Hex, activeScans, parseDate, formatDate, type GroupData } from "./store";
import { dot, unit } from "./clip";

export const MODEL_NAME = "face_recognition_sface_2021dec.onnx";
// opencv_zoo's SFace (Apache-2.0), mirrored by OpenCV on Hugging Face (pinned; people.py takes main)
export const SFACE: ModelSource = {
  repo: "https://huggingface.co/opencv/face_recognition_sface/resolve/3d7082438a6e4551e840c9b2bb60b71e8da4b524/",
  files: [
    [MODEL_NAME, MODEL_NAME, 38696353, "sha256:0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"],
  ],
};
export const MODEL_MB = 39;

export const SAME_PERSON = 0.363; // SFace's recommended cosine-similarity threshold for "same identity"
export const MIN_SCORE = 0.7; // the detector confidence a face needs (as for the rotation vote)
export const MIN_SIZE = 0.03; // and its size, as a share of the picture's width
export const MATCH = 0.8; // a face found again (after the slide was turned) keeps its id above this

export type Found = { box: number[]; score: number; emb: Float32Array };
export type StoredFace = { id: string; box: number[]; score: number; emb: string };
export type FacesFile = Record<string, { key: string; rot: number; mirror?: boolean; faces: StoredFace[] }>;
export type Person = { name: string; faces: string[]; birthday?: string };
export type PeopleFile = { people: Record<string, Person>; rejected: Record<string, string[]>; next: number };

/** What a slide's faces were found on: its blended scans, turned upright (people.face_key). */
export const faceKey = (g: GroupData) =>
  sha1Hex(pyDumps([activeScans(g), new PyInt(g.rotation), ...(g.mirror ? ["mirror"] : [])])).slice(0, 12);

export const stale = (g: GroupData, entry?: { key: string } | null) => !g.skip && (!entry || entry.key !== faceKey(g));

/** The stored faces of a slide found again (people.record): a face like one found before (≥ MATCH)
 *  keeps its id, so names and removals stay with it; new faces get the next free number. */
export function recordFaces(
  sid: string,
  gid: string,
  old: StoredFace[],
  found: Found[],
  unpack: (s: string) => Float32Array,
  pack: (v: Float32Array) => string,
): StoredFace[] {
  const used = new Set<string>();
  const taken = new Set(old.map((f) => Number(f.id.slice(f.id.lastIndexOf("/") + 1))));
  const olds = old.map((o) => unpack(o.emb));
  return found.map((f) => {
    let match: string | null = null;
    if (old.length) {
      const sims = old.map((o, i) => (used.has(o.id) ? -1 : dot(olds[i], f.emb)));
      const best = sims.reduce((b, v, i) => (v > sims[b] ? i : b), 0);
      if (sims[best] >= MATCH) match = old[best].id;
    }
    if (match === null) {
      let n = 0;
      while (taken.has(n)) n++;
      taken.add(n);
      match = `${sid}/${gid}/${n}`;
    }
    used.add(match);
    return { id: match, box: f.box, score: f.score, emb: pack(f.emb) };
  });
}

// ------------------------------------------------------------------ clustering

/**
 * Average-linkage clustering of unit vectors on cosine similarity (people.agglomerate): the existing
 * people keep their members and never merge with each other; every other face starts alone; groups
 * merge, most similar pair first, while the average similarity of their members is at least
 * `threshold`. `rejected[i]`: the existing clusters face i was taken out of. Returns the existing
 * clusters (same order), then the new groups.
 */
export function agglomerate(
  emb: Float32Array[],
  clusters: number[][],
  rejected: Map<number, Set<number>> = new Map(),
  threshold = SAME_PERSON,
): number[][] {
  const taken = new Set(clusters.flat());
  const members = [
    ...clusters.map((c) => [...c]),
    ...emb
      .map((_, i) => i)
      .filter((i) => !taken.has(i))
      .map((i) => [i]),
  ];
  const [k, fixed] = [members.length, clusters.length];
  if (!k) return [];
  const dim = emb[0]?.length ?? 1;
  const S = members.map((m) => {
    const s = new Float64Array(dim);
    for (const i of m) for (let j = 0; j < dim; j++) s[j] += emb[i][j];
    return s;
  });
  const n = members.map((m) => m.length);
  const forbid = members.map((m, g) => new Set(g < fixed ? [] : (rejected.get(m[0]) ?? [])));
  const alive = n.map((x) => x > 0);
  const free = members.map((_, g) => g >= fixed);
  const bestV = new Array<number>(k).fill(-Infinity);
  const bestC = new Array<number>(k).fill(0);
  const sim = (a: number, b: number) => dot(S[a], S[b]);
  const row = (r: number) => {
    let [bc, bv] = [0, -Infinity];
    let first = true;
    for (let c = 0; c < k; c++) {
      let v = sim(c, r) / (Math.max(n[c], 1) * n[r]);
      if (!alive[c] || c === r || forbid[r].has(c)) v = -Infinity;
      if (first || v > bv) [bc, bv, first] = [c, v, false];
    }
    [bestC[r], bestV[r]] = [bc, bv];
  };
  for (let r = fixed; r < k; r++) row(r);
  for (;;) {
    const rows = free.flatMap((f, i) => (f ? [i] : []));
    if (!rows.length) break;
    const r = rows.reduce((b, i) => (bestV[i] > bestV[b] ? i : b), rows[0]);
    if (bestV[r] < threshold) break;
    const c = bestC[r];
    const [keep, gone] = c < fixed ? [c, r] : [Math.min(r, c), Math.max(r, c)];
    for (let j = 0; j < dim; j++) S[keep][j] += S[gone][j];
    n[keep] += n[gone];
    members[keep].push(...members[gone]);
    for (const x of forbid[gone]) forbid[keep].add(x);
    alive[gone] = free[gone] = false;
    n[gone] = 0;
    // the other groups' similarity to the merged one changed; their best may have moved
    const left = free.flatMap((f, i) => (f ? [i] : []));
    for (const rr of left) {
      let v = sim(rr, keep) / (n[rr] * n[keep]);
      if (rr === keep || forbid[rr].has(keep)) v = -Infinity;
      if (v > bestV[rr]) [bestV[rr], bestC[rr]] = [v, keep];
      else if (bestC[rr] === keep || bestC[rr] === gone) row(rr);
    }
    if (free[keep]) row(keep);
  }
  return [...members.slice(0, fixed), ...members.slice(fixed).filter((_, g) => alive[g + fixed])];
}

// ------------------------------------------------------------------ people.json

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export const emptyPeople = (): PeopleFile => ({ people: {}, rejected: {}, next: 1 });

/**
 * people.refresh: people.json brought up to date with the faces (in library order): faces that are
 * gone leave their person (an unnamed person left empty goes), new faces join the person they
 * resemble or form new people. `changed`: whether the file needs writing.
 */
export function refresh(d: PeopleFile, faces: Map<string, Float32Array>): { d: PeopleFile; changed: boolean } {
  const ids = [...faces.keys()];
  const index = new Map(ids.map((f, i) => [f, i]));
  const pids = Object.keys(d.people);
  const at = new Map(pids.map((p, i) => [p, i]));
  const clusters = pids.map((p) => d.people[p].faces.filter((f) => index.has(f)).map((f) => index.get(f)!));
  const rejected = new Map<number, Set<number>>();
  for (const [f, ps] of Object.entries(d.rejected))
    if (index.has(f)) rejected.set(index.get(f)!, new Set(ps.filter((p) => at.has(p)).map((p) => at.get(p)!)));
  const groups = agglomerate(
    ids.map((f) => faces.get(f)!),
    clusters,
    rejected,
  );
  const people: Record<string, Person> = {};
  pids.forEach((p, i) => {
    if (groups[i].length || d.people[p].name || d.people[p].birthday) people[p] = { ...d.people[p], faces: groups[i].map((x) => ids[x]) };
  });
  let next = d.next;
  for (const g of groups.slice(pids.length)) people[`p${next++}`] = { name: "", faces: g.map((x) => ids[x]) };
  const rej: Record<string, string[]> = {};
  for (const [f, ps] of Object.entries(d.rejected)) if (index.has(f)) rej[f] = ps.filter((p) => p in people);
  const out = { people, next, rejected: rej };
  return { d: out, changed: pyDumps(out, true) !== pyDumps(d, true) };
}

function mergeInto(d: PeopleFile, into: string, others: string[]) {
  const target = d.people[into];
  for (const p of others) {
    if (p === into || !(p in d.people)) continue;
    const gone = d.people[p];
    delete d.people[p];
    target.faces.push(...gone.faces);
    target.name = target.name || gone.name || "";
    if (!target.birthday && gone.birthday) target.birthday = gone.birthday;
    for (const [f, ps] of Object.entries(d.rejected))
      d.rejected[f] = [...new Set(ps.map((x) => (x === p ? into : x)))].sort();
  }
}

/** Name a person (people.rename); a name another person already has joins the two. Null: no such person. */
export function rename(d0: PeopleFile, pid: string, name: string): PeopleFile | null {
  const d = clone(d0);
  if (!(pid in d.people)) return null;
  const n = String(name).split(/\s+/).filter(Boolean).join(" ").slice(0, 80);
  d.people[pid].name = n;
  const same = Object.keys(d.people).filter(
    (p) => p !== pid && n && (d.people[p].name ?? "").toLowerCase() === n.toLowerCase(),
  );
  if (same.length) mergeInto(d, same[0], [pid]);
  return d;
}

/** people.clean_birthday: '1952', '1952-03' or '1952-03-14', "" = none; null on junk. */
export function cleanBirthday(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const p = parseDate(s);
  if (!p) return null;
  const y = new Date(p[0]).getUTCFullYear();
  return y >= 1850 && y <= 2100 ? formatDate(...p) : null;
}

/** Someone's birthday (people.set_birthday); "" forgets it. Null: no such person. */
export function setBirthday(d0: PeopleFile, pid: string, birthday: string): PeopleFile | null {
  const d = clone(d0);
  if (!(pid in d.people)) return null;
  if (birthday) d.people[pid].birthday = birthday;
  else delete d.people[pid].birthday;
  return d;
}

export function merge(d0: PeopleFile, into: string, others: string[]): PeopleFile | null {
  const d = clone(d0);
  if (!(into in d.people)) return null;
  mergeInto(d, into, others);
  return d;
}

/** Take wrongly grouped faces out of a person; they won't be put back there (people.remove_faces). */
export function removeFaces(d0: PeopleFile, pid: string, faces: string[]): PeopleFile | null {
  const d = clone(d0);
  if (!(pid in d.people)) return null;
  d.people[pid].faces = d.people[pid].faces.filter((f) => !faces.includes(f));
  for (const f of faces) d.rejected[f] = [...new Set([...(d.rejected[f] ?? []), pid])].sort();
  return d;
}

/** The Immich tag for a named person ("/" would nest tags, so it becomes "-"). */
export const tagName = (name: string) => "People/" + name.replace(/\//g, "-").trim();

/** The named people on each slide: "sid/gid" -> [names]. */
export function slideNames(d: PeopleFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of Object.values(d.people)) {
    if (!p.name) continue;
    for (const f of p.faces) {
      const [sid, gid] = f.split("/");
      const k = `${sid}/${gid}`;
      const names = out.get(k) ?? [];
      if (!names.includes(p.name)) names.push(p.name);
      out.set(k, names);
    }
  }
  return out;
}

// ------------------------------------------------------------------ alignment (FaceRecognizerSF.alignCrop)

const TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
].map((p) => p.map(Math.fround));

/**
 * OpenCV's getSimilarityTransformMatrix: the rotation + scale + shift that takes the five landmarks
 * to SFace's template (Umeyama's least squares; the 2 × 2 SVD in closed form: the rotation that
 * maximises trace(Rᵀ A), and trace(D S) = |(a00 + a11, a10 − a01)|), as a 2 × 3 matrix.
 */
export function similarityTransform(src: number[][]): number[] {
  const f = Math.fround;
  const pts = src.map((p) => p.map(f));
  const mean = [0, 1].map((j) => f(pts.reduce((s, p) => f(s + p[j]), 0) / 5));
  const dstMean = [f(56.0262), f(71.9008)];
  const sd = pts.map((p) => [f(p[0] - mean[0]), f(p[1] - mean[1])]);
  const dd = TEMPLATE.map((p) => [f(p[0] - dstMean[0]), f(p[1] - dstMean[1])]);
  let [a00, a01, a10, a11] = [0, 0, 0, 0];
  for (let i = 0; i < 5; i++) {
    // float products summed in double, as the C++ does
    a00 += f(dd[i][0] * sd[i][0]);
    a01 += f(dd[i][0] * sd[i][1]);
    a10 += f(dd[i][1] * sd[i][0]);
    a11 += f(dd[i][1] * sd[i][1]);
  }
  [a00, a01, a10, a11] = [a00 / 5, a01 / 5, a10 / 5, a11 / 5];
  const theta = Math.atan2(a10 - a01, a00 + a11);
  const [c, s] = [Math.cos(theta), Math.sin(theta)];
  let [v1, v2] = [0, 0];
  for (const p of sd) [v1, v2] = [v1 + f(p[0] * p[0]), v2 + f(p[1] * p[1])];
  const scale = (1 / (v1 / 5 + v2 / 5)) * Math.hypot(a00 + a11, a10 - a01);
  const t0 = c * mean[0] - s * mean[1];
  const t1 = s * mean[0] + c * mean[1];
  return [c * scale, -s * scale, dstMean[0] - scale * t0, s * scale, c * scale, dstMean[1] - scale * t1];
}

/**
 * cv2.warpAffine(img, M, (112, 112), INTER_LINEAR), border 0, of 8-bit BGR as OpenCV 5 does it: each
 * output pixel's source point in float, bilinear weights in float, rounded.
 */
export function warpAffine(img: { width: number; height: number; data: Uint8Array }, M: number[], size = 112) {
  const f = Math.fround;
  const { width: w, height: h, data } = img;
  // the inverse map (dst -> src)
  const det = M[0] * M[4] - M[1] * M[3];
  const [i0, i1, i3, i4] = [M[4] / det, -M[1] / det, -M[3] / det, M[0] / det];
  const i2 = -(i0 * M[2] + i1 * M[5]);
  const i5 = -(i3 * M[2] + i4 * M[5]);
  const m = [i0, i1, i2, i3, i4, i5].map(f);
  const out = new Uint8Array(size * size * 3);
  const px = (x: number, y: number, c: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 3 + c]);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sx = f(f(f(m[0] * x) + f(m[1] * y)) + m[2]);
      const sy = f(f(f(m[3] * x) + f(m[4] * y)) + m[5]);
      const [x0, y0] = [Math.floor(sx), Math.floor(sy)];
      const [ax, ay] = [f(sx - x0), f(sy - y0)];
      for (let c = 0; c < 3; c++) {
        const top = f(f(px(x0, y0, c) * f(1 - ax)) + f(px(x0 + 1, y0, c) * ax));
        const bot = f(f(px(x0, y0 + 1, c) * f(1 - ax)) + f(px(x0 + 1, y0 + 1, c) * ax));
        const v = Math.round(f(f(top * f(1 - ay)) + f(bot * ay)));
        out[(y * size + x) * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  return { width: size, height: size, data: out };
}

/** SFace's input: blobFromImage(aligned, 1, (112, 112), swapRB = true): planar RGB 0..255. */
export function sfaceInput(aligned: { data: Uint8Array }, size = 112): Float32Array {
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[c * n + i] = aligned.data[i * 3 + 2 - c];
  return out;
}

/** The unit feature of SFace's output. */
export const feature = (v: Float32Array) => unit(v);

/** The square around a face for the People dialog (people.face_crop): 1.6 × the face's longer side. */
export function cropBox(w: number, h: number, box: number[]): [number, number, number, number] {
  const [cx, cy] = [(box[0] + box[2] / 2) * w, (box[1] + box[3] / 2) * h];
  const half = Math.max(box[2] * w, box[3] * h) * 0.8;
  const [x0, x1] = [Math.trunc(Math.max(0, cx - half)), Math.trunc(Math.min(w, cx + half))];
  const [y0, y1] = [Math.trunc(Math.max(0, cy - half)), Math.trunc(Math.min(h, cy + half))];
  return [x0, y0, Math.max(x1, x0 + 1), Math.max(y1, y0 + 1)];
}
