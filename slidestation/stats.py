"""Progress across the whole library: slides per hour, trays left, when the target is reached.

Pure functions over session.json dicts, mirrored in frontend/src/lib/stats.ts (the browser
version) - keep the two identical. A slide's work is timed by `developed_at` (set when it is marked
developed) or, for slides uploaded without being developed first, by its upload time
(`immich["at"]`). Trays from before either existed simply don't contribute to the rate.
"""
from __future__ import annotations

import time
from datetime import datetime

DEFAULT_TARGET = 10_000
BREAK_S = 10 * 60  # a longer gap between two slides is a break, not work
PACE_DAYS = 14  # the projected finish uses the pace of the last two weeks
MIN_ACTIVE_S = 5 * 60  # less work than this says nothing about a rate yet


def slide_times(d: dict) -> list[float]:
    """When each slide of a tray was finished (developed, else uploaded), where that's known."""
    out = []
    for g in d.get("groups", []):
        t = g.get("developed_at") or (g.get("immich") or {}).get("at")
        if t:
            out.append(float(t))
    return out


def per_hour(times: list[float]) -> tuple[float | None, float]:
    """Slides per hour of actual work, and the hours worked. Gaps longer than BREAK_S are breaks."""
    ts = sorted(times)
    active = sum(min(b - a, BREAK_S) for a, b in zip(ts, ts[1:]))
    if len(ts) < 2 or active < MIN_ACTIVE_S:
        return None, active / 3600
    return (len(ts) - 1) / (active / 3600), active / 3600


def library_stats(summaries: list[dict], times: list[float], target: int = DEFAULT_TARGET,
                  now: float | None = None) -> dict:
    """summaries: store.summary() of every tray; times: slide_times() of all of them together."""
    now = time.time() if now is None else now
    slides = sum(s["slides"] for s in summaries)
    done = sum(s["reviewed"] for s in summaries)  # developed, uploaded or skipped
    finished = [s for s in summaries if s["slides"] and s["uploaded"] + s["skipped"] >= s["slides"]]
    rate, hours = per_hour(times)
    recent = [t for t in times if now - t < PACE_DAYS * 86400]
    # slides a day over the days worked so far, up to the last PACE_DAYS (a first day counts as one)
    per_day = len(recent) / min(PACE_DAYS, max(1.0, (now - min(recent)) / 86400)) if recent else None
    remaining = max(0, target - done)
    finish = None
    if remaining == 0:
        finish = datetime.fromtimestamp(now).strftime("%Y-%m-%d")
    elif per_day:
        finish = datetime.fromtimestamp(now + remaining / per_day * 86400).strftime("%Y-%m-%d")
    per_tray = slides / len(summaries) if summaries and slides else None
    midnight = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    return {
        "target": target,
        "trays": {"total": len(summaries), "finished": len(finished), "open": len(summaries) - len(finished)},
        "slides": {
            "total": slides,
            "done": done,
            "uploaded": sum(s["uploaded"] for s in summaries),
            "skipped": sum(s["skipped"] for s in summaries),
            "to_develop": slides - done,
        },
        "remaining": remaining,
        "per_hour": round(rate, 1) if rate else None,
        "hours_worked": round(hours, 2),
        "hours_left": round(remaining / rate, 1) if rate else None,
        "per_day": round(per_day, 1) if per_day else None,
        "today": sum(1 for t in times if t >= midnight),
        "last_7_days": sum(1 for t in times if now - t < 7 * 86400),
        "finish": finish,
        # trays still to scan, at the slides per tray so far
        "trays_to_scan": max(0, round((target - slides) / per_tray)) if per_tray else None,
    }
