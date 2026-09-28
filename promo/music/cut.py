"""Cuts a track down to the video's length on its bar lines: whole bars from wherever in the song,
joined with short crossfades, and the last bar faded out.

    python3 music/cut.py song.mp3 --bpm 140 --first-beat 0.03 --bars 13-32,114-117 -o edit.wav

--first-beat is where a bar starts (music/beats.py prints it, or take a hit you can hear, like the
drop, and step back whole bars). Bars count from 0. The result starts on a bar, so it plays from
the start: node render.cjs --music edit.wav --bpm 140.
Needs numpy and ffmpeg (FFMPEG=/path/to/ffmpeg if it isn't on the PATH).
"""

import argparse
import os
import subprocess
import wave

import numpy as np

SR = 48000
XFADE = 0.012  # seconds: short enough to keep the downbeat's attack, long enough not to click


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("song")
    ap.add_argument("--bpm", type=float, required=True)
    ap.add_argument("--first-beat", type=float, default=0.0)
    ap.add_argument("--bars", required=True, help="ranges of bars, inclusive: 13-32,114-117")
    ap.add_argument("--fade", type=float, default=1.0, help="bars to fade out at the end")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args()

    ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", a.song, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).reshape(-1, 2)
    bar = 240 / a.bpm
    xf = int(XFADE * SR)

    parts = [tuple(int(v) for v in part.split("-")) for part in a.bars.split(",")]
    out = np.zeros((0, 2), np.float32)
    for i, (lo, hi) in enumerate(parts):
        start = int(round((a.first_beat + lo * bar) * SR))
        end = int(round((a.first_beat + (hi + 1) * bar) * SR))
        seg = x[start:end]
        if i:
            # the last part ran xf samples past its bar line; the new part starts on that bar line
            ramp = np.linspace(0, 1, xf, dtype=np.float32)[:, None]
            out[-xf:] = out[-xf:] * (1 - ramp) ** 0.5 + seg[:xf] * ramp ** 0.5
            seg = seg[xf:]
        out = np.concatenate([out, seg])
        if i < len(parts) - 1:
            out = np.concatenate([out, x[end: end + xf]])
    n = int(a.fade * bar * SR)
    out[-n:] *= np.linspace(1, 0, n, dtype=np.float32)[:, None] ** 1.5

    pcm = (np.clip(out, -1, 1) * 32767).astype("<i2")
    with wave.open(a.out, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(f"{a.out}: {len(out) / SR:.3f} s ({len(out) / SR / bar:.2f} bars)")


if __name__ == "__main__":
    main()
