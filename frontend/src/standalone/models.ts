// Downloaded models in the browser version (insights.fetch_files): fetched from Hugging Face (which
// answers other origins, CORS) into the library's models/ folder — the same folder and files as the
// desktop app, so a library on disk downloaded by either app is ready in both. Each file goes to
// <name>.part, is resumed with an HTTP Range request on the next attempt, checked against its sha256
// (LFS files) or git blob sha1 (small files) and only then put in place.
import type { Job } from "@/lib/api";
import type { Library, Writer } from "./library";

/** (path in the repo, local name, bytes, checksum "sha256:…" | "git:…") */
export type ModelFile = [string, string, number, string];
export type ModelSource = { repo: string; files: ModelFile[] };

export const CLIP: ModelSource = {
  repo: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/",
  files: [
    [
      "onnx/vision_model_quantized.onnx",
      "vision.onnx",
      89117001,
      "sha256:583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299",
    ],
    [
      "onnx/text_model_quantized.onnx",
      "text.onnx",
      64504507,
      "sha256:73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a",
    ],
    ["vocab.json", "vocab.json", 862328, "git:182766ce89b439768edadda342519f33802f5364"],
    ["merges.txt", "merges.txt", 524619, "git:76e821f1b6f0a9709293c3b6b51ed90980b3166b"],
  ],
};

/**
 * A model's source; tests replace it (`localStorage["slide-station-models"]` = {"<id>": {repo,
 * files}}, like the canvas limit in engine.ts) to serve a tiny stand-in model.
 */
export function source(id: string, fallback: ModelSource): ModelSource {
  try {
    const o = JSON.parse(localStorage.getItem("slide-station-models") || "{}");
    return o[id] ?? fallback;
  } catch {
    return fallback;
  }
}

export const megabytes = (s: ModelSource) => Math.round(s.files.reduce((n, f) => n + f[2], 0) / 1e6);

/** Every file there at its exact size. */
export async function filesReady(lib: Library, dir: string, s: ModelSource): Promise<boolean> {
  if (!s.files.length) return false;
  for (const [, name, size] of s.files) if ((await lib.read(`${dir}/${name}`))?.size !== size) return false;
  return true;
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function checksum(f: Blob, want: string): Promise<boolean> {
  const [algo, digest] = want.split(":");
  if (!crypto.subtle) return true; // not a secure context (the size was checked): nothing to hash with
  const bytes = await f.arrayBuffer();
  if (algo === "sha256") return hex(await crypto.subtle.digest("SHA-256", bytes)) === digest;
  const head = new TextEncoder().encode(`blob ${f.size}\0`);
  const all = new Uint8Array(head.length + bytes.byteLength);
  all.set(head);
  all.set(new Uint8Array(bytes), head.length);
  return hex(await crypto.subtle.digest("SHA-1", all)) === digest;
}

const OFFLINE = (what: string, why: string) =>
  `Couldn't reach huggingface.co to download the ${what} (${why}). Check the internet connection and try ` +
  "again; the download continues where it stopped.";
const FLUSH = 16 << 20; // the part file is saved every 16 MB, so a closed tab resumes from there

/** Fetch model files into `dir` of the library (a job: progress in MB). */
export async function fetchFiles(lib: Library, job: Job, s: ModelSource, dir: string, what: string) {
  job.total = megabytes(s);
  job.message = `Downloading the ${what} (MB)`;
  let done = 0;
  for (const [remote, name, size, want] of s.files) {
    const dest = `${dir}/${name}`;
    if ((await lib.read(dest))?.size === size) {
      done += size;
      job.done = Math.round(done / 1e6);
      continue;
    }
    const partPath = `${dest}.part`;
    let have = (await lib.read(partPath))?.size ?? 0;
    if (have > size) {
      await lib.remove(partPath);
      have = 0;
    }
    if (have < size) {
      let r: Response;
      try {
        r = await fetch(s.repo + remote, have ? { headers: { Range: `bytes=${have}-` } } : undefined);
      } catch (e) {
        throw new Error(OFFLINE(what, e instanceof Error ? e.message : String(e)));
      }
      if (r.status === 200 && have)
        have = 0; // the server ignored the range: start over
      else if (r.status !== 200 && r.status !== 206) throw new Error(`Downloading ${name} failed: HTTP ${r.status}`);
      let w: Writer = await lib.writer(partPath, have > 0);
      let unsaved = 0;
      try {
        const reader = r.body!.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          await w.write(value);
          have += value.length;
          unsaved += value.length;
          job.done = Math.round((done + have) / 1e6);
          if (unsaved >= FLUSH) {
            await w.close();
            w = await lib.writer(partPath, true);
            unsaved = 0;
          }
        }
      } catch (e) {
        await w.close().catch(() => undefined); // keep what arrived for the next try
        throw new Error(OFFLINE(what, e instanceof Error ? e.message : String(e)));
      }
      await w.close();
    }
    const part = await lib.read(partPath);
    if (!part || part.size < size) throw new Error(OFFLINE(what, "the download stopped early"));
    if (part.size !== size || !(await checksum(part, want))) {
      await lib.remove(partPath);
      throw new Error(`The downloaded ${name} didn't match its checksum; try again.`);
    }
    await lib.write(dest, part);
    await lib.remove(partPath);
    done += size;
    job.done = Math.round(done / 1e6);
  }
  job.done = job.total;
}
