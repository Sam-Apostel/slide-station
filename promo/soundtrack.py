"""The launch video's sound: the music (music/, public domain) with the page's sound effects on top
(window.SFX: key presses, clicks, the slide dropping into the scanner's holder, dings), which are
synthesised here, so there are no samples to license.

    python3 soundtrack.py cues.json out.wav      (render.cjs writes cues.json and calls this)

Needs numpy, scipy and ffmpeg (FFMPEG=/path/to/ffmpeg if it isn't on the PATH).
"""

import json
import os
import subprocess
import sys
import wave

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
rng = np.random.default_rng(7)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n, a, r, sustain=True):
    """Attack, then hold (or decay exponentially) and release over n samples."""
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4))
    if sustain:
        e *= np.clip((n / SR - t) / max(r, 1e-4), 0, 1)
    else:
        e *= np.exp(-t / max(r, 1e-4))
    return e


def lp(x, hz, order=2):
    return sosfilt(butter(order, hz, "low", fs=SR, output="sos"), x)


def hp(x, hz, order=2):
    return sosfilt(butter(order, hz, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def add(buf, at, sig, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= buf.shape[1] or i + len(sig) <= 0:
        return
    j = min(buf.shape[1], i + len(sig))
    seg = sig[: j - i] * gain
    buf[0, i:j] += seg * np.sqrt((1 - pan) / 2) * 1.414
    buf[1, i:j] += seg * np.sqrt((1 + pan) / 2) * 1.414


def bell(freq, dur=1.6, gain=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = sum(a * np.sin(2 * np.pi * freq * r * t) * np.exp(-t / (d * dur)) for r, a, d in ((1, 1, 0.5), (2.76, 0.4, 0.25), (5.4, 0.2, 0.12), (2, 0.3, 0.35)))
    return x * env(n, 0.002, 0.05) * 0.13 * gain


def noise_swell(dur, lo, hi, rise=0.7):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    # sweep a band-pass by filtering in chunks
    out = np.zeros(n)
    chunks = 24
    for c in range(chunks):
        a, b = c * n // chunks, (c + 1) * n // chunks
        f = lo * (hi / lo) ** (c / chunks)
        out[a:b] = bp(x[max(0, a - 2000):b], f * 0.7, min(f * 1.4, SR / 2 - 100))[-(b - a):]
    shape = np.where(t < rise * dur, (t / (rise * dur)) ** 2, np.exp(-(t - rise * dur) / (0.25 * dur)))
    return out * shape


SFX = {
    # the slide landing in the holder, and the holder sliding into the scanner
    "thud": lambda: (np.sin(2 * np.pi * 150 * np.arange(int(0.12 * SR)) / SR) + bp(rng.standard_normal(int(0.12 * SR)), 400, 3000) * 0.5)
    * np.exp(-np.arange(int(0.12 * SR)) / SR / 0.02) * 0.4,
    "slide": lambda: noise_swell(0.5, 600, 3000, rise=0.5) * 0.1,
    # a slide projector advancing: the latch, then the slide dropping into the gate
    "clack": lambda: np.concatenate([
        bp(rng.standard_normal(int(0.03 * SR)), 1200, 5000) * np.exp(-np.arange(int(0.03 * SR)) / SR / 0.006) * 0.5,
        np.zeros(int(0.05 * SR)),
        (bp(rng.standard_normal(int(0.12 * SR)), 300, 2500) * 0.6 + np.sin(2 * np.pi * 120 * np.arange(int(0.12 * SR)) / SR))
        * np.exp(-np.arange(int(0.12 * SR)) / SR / 0.025) * 0.45,
    ]),
    "whoosh": lambda: noise_swell(0.55, 300, 5000) * 0.22,
    "whoosh-soft": lambda: noise_swell(0.5, 250, 2500) * 0.12,
    "sweep": lambda: noise_swell(1.1, 400, 9000, rise=0.85) * 0.12,
    "scan": lambda: noise_swell(0.5, 800, 6000, rise=0.9) * 0.1 + np.concatenate([np.sin(2 * np.pi * np.cumsum(np.linspace(600, 1600, int(0.4 * SR))) / SR) * 0.03, np.zeros(int(0.1 * SR))]),
    "tick": lambda: np.sin(2 * np.pi * 2400 * np.arange(int(0.03 * SR)) / SR) * np.exp(-np.arange(int(0.03 * SR)) / SR / 0.006) * 0.12,
    "click": lambda: bp(rng.standard_normal(int(0.02 * SR)), 1500, 6000) * np.exp(-np.arange(int(0.02 * SR)) / SR / 0.003) * 0.5,
    "key": lambda: (bp(rng.standard_normal(int(0.06 * SR)), 500, 4000) * 0.7 + np.sin(2 * np.pi * 180 * np.arange(int(0.06 * SR)) / SR))
    * np.exp(-np.arange(int(0.06 * SR)) / SR / 0.012) * 0.35,
    "pop": lambda: np.sin(2 * np.pi * np.cumsum(np.geomspace(900, 300, int(0.08 * SR))) / SR) * np.exp(-np.arange(int(0.08 * SR)) / SR / 0.03) * 0.2,
    "ding": lambda: bell(midi(93), 0.9, 0.9),
    "chime": lambda: sum_at([(0, bell(midi(81), 2.2)), (0.09, bell(midi(85), 2.2)), (0.18, bell(midi(88), 2.2)), (0.27, bell(midi(93), 2.2))]),
}


def sum_at(parts):
    n = max(int(o * SR) + len(p) for o, p in parts)
    out = np.zeros(n)
    for o, p in parts:
        i = int(o * SR)
        out[i : i + len(p)] += p
    return out


def reverb(x, secs=2.2, mix=0.25):
    n = int(secs * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((2, n)) * np.exp(-t / (secs / 5))
    ir = np.stack([lp(ir[0], 6000), lp(ir[1], 6000)])
    ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
    wet = np.stack([fftconvolve(x[c], ir[c])[: x.shape[1]] for c in range(2)])
    return x * (1 - mix) + wet * mix


# ------------------------------------------------------------------ mix

def load_music(path, seconds, offset=0.0):
    ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
    raw = subprocess.run([ffmpeg, "-v", "error", "-ss", str(offset), "-i", path, "-t", str(seconds), "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).T.astype(np.float64)


def main(cues_path, out_path):
    cues = json.load(open(cues_path))
    dur = cues["duration"]
    total = int(dur * SR)
    music = np.zeros((2, total))
    m = load_music(cues["music"], dur, cues.get("offset", 0))
    music[:, : m.shape[1]] = m[:, :total]
    # fade out over the last 1.6 s (the committed excerpt already does; another track may not)
    n = int(1.6 * SR)
    music[:, total - n :] *= np.linspace(1, 0, n)

    fx = np.zeros((2, total + SR))
    for at, kind in cues["sfx"]:
        make = SFX.get(kind)
        if make is not None:
            add(fx, at, make(), 1.0, pan=rng.uniform(-0.25, 0.25))
    fx = reverb(fx, 1.2, 0.18)[:, :total]

    mix = music * 0.85 + fx * 0.55
    peak = np.max(np.abs(mix))
    if peak > 0.97:
        mix = np.tanh(mix / peak * 1.2) / np.tanh(1.2) * 0.97
    pcm = (np.clip(mix, -1, 1).T * 32767).astype("<i2")
    with wave.open(out_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
