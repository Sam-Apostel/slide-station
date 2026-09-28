"""Finds a track's tempo and its drop, and prints the render command that puts the drop on the
video's first step (3 bars in), so every cut lands on a bar.

    python3 music/beats.py ~/Music/track.mp3

Needs numpy and ffmpeg (FFMPEG=/path/to/ffmpeg if it isn't on the PATH). It's an estimate: listen,
and nudge --offset by a bar (60 / bpm * 4 seconds) either way if the drop feels early or late.
"""

import os
import subprocess
import sys

import numpy as np

SR = 11025
HOP = 128
FPS = SR / HOP
FIRST_STEP_BARS = 3  # the video's first step starts 3 bars in (index.html, T.steps)


def main(path: str) -> None:
    ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    n = len(x) // HOP
    energy = np.sqrt((x[: n * HOP].reshape(n, HOP) ** 2).mean(1))
    onset = np.maximum(0, np.diff(np.log(energy + 1e-4)))

    # tempo and beat phase: the beat grid that lines up with the most onsets
    best = (0.0, 120.0, 0.0)
    for bpm in np.arange(80, 170, 0.05):
        period = 60 / bpm * FPS
        beats = int((len(onset) - period) / period)
        for phase in np.linspace(0, period, 32, endpoint=False):
            score = onset[(phase + np.arange(beats) * period).astype(int)].mean()
            if score > best[0]:
                best = (score, bpm, phase / FPS)
    _, bpm, phase = best
    if bpm < 95:  # half time reads as the same grid at double speed
        bpm *= 2
    beat = 60 / bpm
    bar = 4 * beat

    # the drop: the bar line after which the music gets loudest, compared with the bars before it
    per_bar = [energy[int((phase + i * bar) * FPS): int((phase + (i + 1) * bar) * FPS)].mean()
               for i in range(int((len(x) / SR - phase) / bar))]
    jumps = [(np.mean(per_bar[i:i + 2]) / (np.mean(per_bar[max(0, i - 2):i]) + 1e-6), i) for i in range(FIRST_STEP_BARS, len(per_bar) - 2)]
    _, drop_bar = max(jumps)
    drop = phase + drop_bar * bar
    offset = drop - FIRST_STEP_BARS * bar

    print(f"tempo  {bpm:.2f} BPM (a bar is {bar:.3f} s)")
    print(f"drop   {drop:.2f} s into the track")
    print(f"offset {offset:.3f} s (the video starts {FIRST_STEP_BARS} bars before the drop)\n")
    print(f"node render.cjs --music {path} --bpm {bpm:.2f} --offset {offset:.3f} --out slide-station-youtube.mp4")
    print(f"preview: index.html?music={path}&bpm={bpm:.2f}&offset={offset:.3f}  (the path relative to promo/)")


if __name__ == "__main__":
    main(sys.argv[1])
