// Progress across the whole library (slidestation/stats.py, for the browser version) — keep the two
// identical. A slide's work is timed by `developed_at`, or for slides uploaded without being
// developed first, by its upload time (`immich.at`).
import type { Summary } from "@/lib/api";

export const DEFAULT_TARGET = 10_000;
export const BREAK_S = 10 * 60; // a longer gap between two slides is a break, not work
export const PACE_DAYS = 14; // the projected finish uses the pace of the last two weeks
const MIN_ACTIVE_S = 5 * 60; // less work than this says nothing about a rate yet

export type Stats = {
  target: number;
  trays: { total: number; finished: number; open: number };
  slides: { total: number; done: number; uploaded: number; skipped: number; to_develop: number };
  remaining: number;
  per_hour: number | null;
  hours_worked: number;
  hours_left: number | null;
  per_day: number | null;
  today: number;
  last_7_days: number;
  /** YYYY-MM-DD, local time. */
  finish: string | null;
  trays_to_scan: number | null;
};

type TimedGroup = { developed_at?: number; immich?: { at?: number } | null };

/** When each slide of a tray was finished (developed, else uploaded), where that's known. */
export const slideTimes = (d: { groups: TimedGroup[] }): number[] =>
  d.groups.flatMap((g) => {
    const t = g.developed_at || g.immich?.at;
    return t ? [t] : [];
  });

/** Slides per hour of actual work, and the hours worked. Gaps longer than BREAK_S are breaks. */
export function perHour(times: number[]): [number | null, number] {
  const ts = [...times].sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < ts.length; i++) active += Math.min(ts[i] - ts[i - 1], BREAK_S);
  if (ts.length < 2 || active < MIN_ACTIVE_S) return [null, active / 3600];
  return [(ts.length - 1) / (active / 3600), active / 3600];
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;
const ymd = (t: Date) =>
  `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;

type Counts = Pick<Summary, "slides" | "reviewed" | "uploaded" | "skipped">;

/** summaries: every tray's summary; times: slideTimes() of all of them together (seconds). */
export function libraryStats(
  summaries: Counts[],
  times: number[],
  target = DEFAULT_TARGET,
  now = Date.now() / 1000,
): Stats {
  const slides = summaries.reduce((n, s) => n + s.slides, 0);
  const done = summaries.reduce((n, s) => n + s.reviewed, 0); // developed, uploaded or skipped
  const finished = summaries.filter((s) => s.slides && s.uploaded + s.skipped >= s.slides).length;
  const [rate, hours] = perHour(times);
  const recent = times.filter((t) => now - t < PACE_DAYS * 86400);
  // slides a day over the days worked so far, up to the last PACE_DAYS (a first day counts as one)
  const perDay = recent.length
    ? recent.length / Math.min(PACE_DAYS, Math.max(1, (now - Math.min(...recent)) / 86400))
    : null;
  const remaining = Math.max(0, target - done);
  const finish =
    remaining === 0
      ? ymd(new Date(now * 1000))
      : perDay
        ? ymd(new Date((now + (remaining / perDay) * 86400) * 1000))
        : null;
  const perTray = summaries.length && slides ? slides / summaries.length : null;
  const midnight = new Date(now * 1000);
  midnight.setHours(0, 0, 0, 0);
  return {
    target,
    trays: { total: summaries.length, finished, open: summaries.length - finished },
    slides: {
      total: slides,
      done,
      uploaded: summaries.reduce((n, s) => n + s.uploaded, 0),
      skipped: summaries.reduce((n, s) => n + s.skipped, 0),
      to_develop: slides - done,
    },
    remaining,
    per_hour: rate ? round(rate, 1) : null,
    hours_worked: round(hours, 2),
    hours_left: rate ? round(remaining / rate, 1) : null,
    per_day: perDay ? round(perDay, 1) : null,
    today: times.filter((t) => t >= midnight.getTime() / 1000).length,
    last_7_days: times.filter((t) => now - t < 7 * 86400).length,
    finish,
    // trays still to scan, at the slides per tray so far
    trays_to_scan: perTray ? Math.max(0, Math.round((target - slides) / perTray)) : null,
  };
}
