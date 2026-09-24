// Talking to the pixel workers (engine.worker.ts). One worker answers the UI (previews, curves,
// eyedropper), a second does imports and exports, so browsing stays quick while a job runs.
import type { Op, Ops } from "./engine.worker";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class Engine {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.error !== undefined) p.reject(new Error(e.data.error));
        else p.resolve(e.data.result);
      };
      this.worker.onerror = (e) => {
        // a crash (usually out of memory on a huge export) fails everything waiting, and the next
        // call starts a fresh worker
        for (const p of this.pending.values()) p.reject(new Error(e.message || "The image worker stopped (out of memory?)"));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      };
    }
    return this.worker;
  }

  call<K extends Op>(op: K, args: Parameters<Ops[K]>[0], priority = 0): ReturnType<Ops[K]> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.w.postMessage({ id, op, args, priority });
    }) as ReturnType<Ops[K]>;
  }

  /** Forget cached pixels whose key starts with `prefix`. */
  drop(prefix: string) {
    this.worker?.postMessage({ drop: prefix });
  }
}

export const ui = new Engine();
export const jobs = new Engine();
