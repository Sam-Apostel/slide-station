// The same cases as tests/test_tool.py's stats tests, so the browser version answers like Python.
import { describe, expect, it } from "vitest";
import { BREAK_S, DEFAULT_TARGET, libraryStats, perHour, slideTimes } from "./stats";

describe("stats", () => {
  it("counts breaks out of the hours worked", () => {
    expect(perHour([])).toEqual([null, 0]);
    const ts = [...Array(31)].map((_, i) => i * 60).concat([...Array(11)].map((_, i) => 30 * 60 + 3 * 3600 + i * 60));
    const [rate, hours] = perHour(ts);
    expect(hours).toBeCloseTo((40 * 60 + BREAK_S) / 3600);
    expect(rate).toBeCloseTo(41 / hours);
    expect(perHour([0, 60])[0]).toBeNull();
  });

  it("projects the finish from the last two weeks", () => {
    const now = 1_800_000_000;
    const summ = [
      { slides: 50, reviewed: 50, uploaded: 48, skipped: 2 },
      { slides: 40, reviewed: 10, uploaded: 0, skipped: 0 },
    ];
    const times = [...Array(56)].map((_, i) => now - 86400 * 3 + i * 30).concat([now - 86400 * 40]);
    const s = libraryStats(summ, times, 1000, now);
    expect(s.trays).toEqual({ total: 2, finished: 1, open: 1 });
    expect(s.slides).toEqual({ total: 90, done: 60, uploaded: 48, skipped: 2, to_develop: 30 });
    expect(s.remaining).toBe(940);
    expect(s.per_day).toBe(18.7);
    const f = new Date((now + (940 / (56 / 3)) * 86400) * 1000);
    expect(s.finish).toBe(
      `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, "0")}-${String(f.getDate()).padStart(2, "0")}`,
    );
    expect(s.per_hour).toBe(89.6);
    expect(s.hours_left).toBe(10.5);
    expect(s.last_7_days).toBe(56);
    expect(s.trays_to_scan).toBe(20);
    const none = libraryStats([], [], undefined, now);
    expect(none.per_hour).toBeNull();
    expect(none.finish).toBeNull();
    expect(none.trays_to_scan).toBeNull();
    expect(none.target).toBe(DEFAULT_TARGET);
  });

  it("reads develop and upload times, and old trays without them", () => {
    expect(slideTimes({ groups: [{ developed_at: 5 }, { immich: { at: 7 } }, { immich: null }, {}] })).toEqual([5, 7]);
    expect(slideTimes({ groups: [{ immich: { at: 7 }, developed_at: 3 }] })).toEqual([3]);
  });
});
