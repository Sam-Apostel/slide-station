// The insights plumbing of the browser version (slidestation/insights.py and the parts of server.py
// that decide suggestions): a slide's insights key, merging fresh suggestions with the decisions
// already made, tags removed by hand, place suggestions from the tray's neighbours (places.py
// suggest_between / merge). The same `g["insights"]` in session.json, so a tray analysed in one app
// isn't analysed again in the other.
import type { Suggestion } from "@/lib/api";
import { MODEL_ID } from "./clip";
import {
  activeScans,
  pyDumps,
  PyInt,
  samePlace,
  sha1Hex,
  type GroupData,
  type Place,
  type StoredInsights,
} from "./store";

export const KINDS = ["tags", "caption", "date", "place", "stock"] as const;
export const CAPTIONS_ID = "florence-2-base"; // captions.MODEL_ID (desktop app only)

/** What a slide's suggestions were computed from (insights.insights_key): active scans, rotation,
 *  the models that ran; with captions, whether the slide has a caption of its own. */
export function insightsKey(g: GroupData, models: string[]): string {
  const k: unknown[] = [activeScans(g), new PyInt(g.rotation), ...models];
  if (g.mirror) k.push("mirror"); // sign OCR reads the right way round
  if (models.includes(CAPTIONS_ID)) k.push(!!g.caption);
  return sha1Hex(pyDumps(k)).slice(0, 12);
}

export const needsAnalysis = (g: GroupData, models: string[]) => !g.skip && g.insights?.key !== insightsKey(g, models);

export const pending = (groups: GroupData[], models: string[]) =>
  models.length ? groups.filter((g) => needsAnalysis(g, models)).length : 0;

/** places.merge: a decision on the same place stands, an accepted place is never replaced, a slide
 *  with its own place gets nothing new (or it counts as accepted when it names that place). */
export function mergePlace(
  old: Suggestion | null | undefined,
  fresh: Suggestion | null | undefined,
  own: Place | null | undefined,
): Suggestion | null {
  if (fresh == null) return old ?? null;
  if (old && (old.state === "accepted" || old.state === "dismissed") && samePlace(old.place, fresh.place))
    return { ...fresh, state: old.state };
  if (own) return samePlace(own, fresh.place) ? { ...fresh, state: "accepted" } : (old ?? null);
  if (old?.state === "accepted") return old;
  return fresh;
}

/** insights.merge: fresh suggestions with the decisions already made kept. */
export function merge(
  old: StoredInsights | undefined,
  fresh: StoredInsights & { key: string },
  ownTags: string[],
  ownCaption = "",
  ownPlace: Place | null = null,
): StoredInsights {
  const o = old ?? {};
  let tags: Suggestion[];
  if (fresh.tags) {
    const kept = new Map(
      (o.tags ?? []).filter((e) => e.state === "accepted" || e.state === "dismissed").map((e) => [e.value, e]),
    );
    tags = fresh.tags.map((e) => {
      const was = kept.get(e.value);
      if (was) {
        kept.delete(e.value);
        return { ...e, state: was.state };
      }
      return { ...e, state: ownTags.includes(e.value) ? "accepted" : "suggested" };
    });
    tags.push(...kept.values());
  } else tags = o.tags ?? []; // the tag model is off: leave the tags as they were
  const out: StoredInsights = { key: fresh.key, tags };
  for (const k of ["caption", "date", "stock"] as const) out[k] = fresh[k] != null ? fresh[k] : (o[k] ?? null);
  out.place = mergePlace(o.place, fresh.place, ownPlace);
  const text = "text" in fresh ? fresh.text : o.text;
  if (text != null) out.text = text;
  const [cap, was] = [fresh.caption, o.caption];
  if (cap && was && was.state !== "suggested" && was.value === cap.value) out.caption = { ...cap, state: was.state };
  if (ownCaption && out.caption?.state === "suggested") out.caption = null;
  return out;
}

/** server._set_tags: a slide's own tags; an accepted suggestion the user removes counts as
 *  dismissed (returned, to be counted against the label), a suggested one they type is accepted. */
export function setTags(g: GroupData, tags: string[]): string[] {
  const removed = new Set((g.tags ?? []).filter((t) => !tags.includes(t)));
  const dismissed: string[] = [];
  for (const e of g.insights?.tags ?? [])
    if (removed.has(e.value) && e.state === "accepted") {
      e.state = "dismissed";
      dismissed.push(e.value);
    } else if (tags.includes(e.value) && e.state === "suggested") e.state = "accepted";
  if (tags.length) g.tags = tags;
  else delete g.tags;
  return dismissed;
}

/** server._clean_tags: trimmed, lower case, no repeats, at most 30 of 40 characters each. */
export function cleanTags(v: unknown): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const t = String(x).split(/\s+/).filter(Boolean).join(" ").toLowerCase().slice(0, 40);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 30);
}

/** The slide's suggestions for the payload (server._slide_insights): the models' (stored) plus the
 *  film stock and date guesses (`live`), which need no model. */
export function slideInsights(
  g: GroupData,
  live: { stock: Suggestion | null; date: Suggestion | null },
  models: string[],
) {
  const ins = g.insights ?? {};
  const has = Object.keys(ins).length > 0;
  if (!has && !live.stock && !live.date) return null;
  return {
    tags: ins.tags ?? [],
    caption: ins.caption ?? null,
    place: ins.place ?? null,
    ...live, // film stock and date: the live guesses (filmstock.views shows the stored decisions)
    text: (ins.text ?? []).map((t) => t.text),
    stale: has && ins.key !== insightsKey(g, models),
    error: ins.error ?? "",
  };
}

// ------------------------------------------------------------------ places from the tray

export const TRAY_SOURCE = "tray";
const TRAY_CONFIDENCE = 0.9;

/** How a place reads: "Venice, Italy" (places.label). */
export const placeLabel = (p: Place) => [...new Set([p.name, p.country].filter(Boolean))].join(", ");

/** places.suggestion: a place suggestion in the insights shape. */
export function placeSuggestion(place: Place, confidence: number, source: string, text = ""): Suggestion {
  const e: Suggestion = { value: placeLabel(place), place, confidence, source, state: "suggested" };
  if (text) e.text = text.slice(0, 200);
  return e;
}

/** places.suggest_between: a slide between two slides with the same place (no other place in
 *  between) gets it suggested; tray suggestions that no longer hold are withdrawn. */
export function suggestBetween(groups: GroupData[]): number {
  const placed = groups
    .map((g, i) => [i, g] as const)
    .filter(([, g]) => g.place && !g.skip)
    .map(([i, g]) => [i, g.place!] as const);
  const want = new Map<number, [Place, string]>();
  for (let n = 0; n + 1 < placed.length; n++) {
    const [[i, p], [j, q]] = [placed[n], placed[n + 1]];
    if (j > i + 1 && samePlace(p, q)) for (let k = i + 1; k < j; k++) want.set(k, [p, `slides ${i + 1} and ${j + 1}`]);
  }
  let n = 0;
  groups.forEach((g, k) => {
    const ins = g.insights ?? {};
    const e = ins.place;
    const w = want.get(k);
    if (!w || g.skip || g.place) {
      if (e && e.source === TRAY_SOURCE && e.state === "suggested") ins.place = null; // its neighbours changed
      return;
    }
    const [p, why] = w;
    if (e && samePlace(e.place, p) && (e.state === "dismissed" || e.state === "accepted")) return;
    if (e && e.state === "suggested" && e.source !== TRAY_SOURCE) return; // the photo's own evidence stays
    if (e && e.source === TRAY_SOURCE && samePlace(e.place, p) && e.state === "suggested") return;
    (g.insights ??= { key: "", tags: [] }).place = placeSuggestion(p, TRAY_CONFIDENCE, TRAY_SOURCE, why);
    n++;
  });
  return n;
}

export { MODEL_ID };
