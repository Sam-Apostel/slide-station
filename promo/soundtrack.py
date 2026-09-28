"""The launch video's sound: the music with the page's sound effects on top (window.SFX), mixed into
one WAV for render.cjs.

The effects are synthesised here, so there are no samples to license. The physical ones (the
slide landing in the scanner's holder, the holder sliding in and latching, keys and clicks) are
built from a transient and a few damped resonances; the tonal ones (dings, the notes that climb as
photos land or cards appear) are played in the music's own key, found from the track, on its
pentatonic scale, so they sit in the song instead of against it. A riser fills the quiet bar before
the drop and an impact lands on it; the music ducks a little under the big hits.

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


# ------------------------------------------------------------------ building blocks

def t_(dur):
    return np.arange(int(dur * SR)) / SR


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def lp(x, hz, order=2):
    return sosfilt(butter(order, min(hz, SR / 2 - 100), "low", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, min(hi, SR / 2 - 100)], "band", fs=SR, output="sos"), x)


def noise(dur):
    return rng.standard_normal(int(dur * SR))


def modes(dur, parts):
    """A struck object: damped sines [(freq, amp, tau)]."""
    t = t_(dur)
    return sum(a * np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) * np.exp(-t / tau) for f, a, tau in parts)


def click(dur=0.004, lo=2000, hi=12000, amp=1.0):
    return bp(noise(dur), lo, hi) * np.exp(-t_(dur) / (dur / 4)) * amp


def sweep_noise(dur, lo, hi, shape):
    """Noise through a band-pass that sweeps lo → hi, with an envelope shape(u), u from 0 to 1."""
    n = int(dur * SR)
    x = noise(dur)
    out = np.zeros(n)
    chunks = max(8, int(dur * 40))
    for c in range(chunks):
        a, b = c * n // chunks, (c + 1) * n // chunks
        f = lo * (hi / lo) ** (c / chunks)
        out[a:b] = bp(x[max(0, a - 2048):b], f * 0.6, f * 1.6)[-(b - a):]
    return out * shape(np.linspace(0, 1, n))


def cat(*parts):
    """Parts laid out at offsets in seconds: cat((0, sig), (0.03, sig2))."""
    n = max(int(o * SR) + len(p) for o, p in parts)
    out = np.zeros(n)
    for o, p in parts:
        i = int(o * SR)
        out[i:i + len(p)] += p
    return out


# ------------------------------------------------------------------ the key

NAMES = "C C# D D# E F F# G G# A A# B".split()
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def find_key(music):
    """Tonic (0-11) and mode of the music, from its chroma (Krumhansl-Schmuckler profiles)."""
    x = music.mean(0)
    x = x[: len(x) // 8192 * 8192].reshape(-1, 8192)
    spec = np.abs(np.fft.rfft(x * np.hanning(8192), axis=1)).mean(0)
    freqs = np.fft.rfftfreq(8192, 1 / SR)
    chroma = np.zeros(12)
    for f, a in zip(freqs, spec):
        if 60 < f < 2000:
            chroma[int(round(12 * np.log2(f / 440) + 69)) % 12] += a
    scores = [(np.corrcoef(np.roll(MAJOR, k), chroma)[0, 1], k, "major") for k in range(12)]
    scores += [(np.corrcoef(np.roll(MINOR, k), chroma)[0, 1], k, "minor") for k in range(12)]
    _, tonic, mode = max(scores)
    return tonic, mode


class Scale:
    def __init__(self, tonic, mode):
        self.tonic, self.mode = tonic, mode
        self.steps = [0, 3, 5, 7, 10] if mode == "minor" else [0, 2, 4, 7, 9]

    def note(self, i, octave=6):
        """The i-th note up the pentatonic scale from the tonic in `octave`, as MIDI."""
        o, k = divmod(int(i), 5)
        return 12 * (octave + 1 + o) + self.tonic + self.steps[k]

    def chord(self, octave=5):
        base = 12 * (octave + 1) + self.tonic
        return [base, base + (3 if self.mode == "minor" else 4), base + 7, base + 12]


# ------------------------------------------------------------------ the sounds

def bell(f, dur=1.4, amp=1.0):
    return modes(dur, [(f, 1, 0.5), (f * 2, 0.35, 0.28), (f * 2.76, 0.25, 0.16), (f * 5.4, 0.1, 0.06)]) * amp * 0.12


def pluck(f, dur=0.45, amp=1.0):
    t = t_(dur)
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)
    return lp(x * np.exp(-t / 0.11), 6000) * np.minimum(1, t / 0.002) * amp * 0.1


def glass(f, dur=0.9, amp=1.0):
    return modes(dur, [(f, 1, 0.25), (f * 2.02, 0.5, 0.12), (f * 3.9, 0.25, 0.05)]) * amp * 0.08


def make(kind, arg, s):
    if kind == "impact":  # the drop: a sub that falls in pitch, a burst of air, a hit
        t = t_(1.4)
        sub = np.sin(2 * np.pi * np.cumsum(38 + 50 * np.exp(-t / 0.08)) / SR) * np.exp(-t / 0.45)
        air = lp(noise(1.4), 3000) * np.exp(-t / 0.15) * 0.35
        return cat((0, (sub * 0.6 + air * 0.6) * 0.45), (0, click(0.006, 800, 8000, 0.3)))
    if kind == "riser":  # noise that climbs and swells through the hush, cut just before the drop
        d = max(arg, 0.5)
        t = t_(d)
        x = sweep_noise(d, 250, 9000, lambda u: u ** 2.2)
        tone = np.sin(2 * np.pi * np.cumsum(midi(s.note(0, 3)) * 2 ** (2 * t / d)) / SR) * (t / d) ** 3
        out = x * 0.2 + tone * 0.06
        out[-int(0.02 * SR):] *= np.linspace(1, 0, int(0.02 * SR))
        return out
    if kind in ("whoosh", "sweep") or kind.startswith("swish"):
        d = max(arg, 0.15) + 0.25
        peak = 0.7 if kind == "sweep" else 0.55
        lo, hi = (900, 12000) if kind == "sweep" else (300, 5000)
        x = sweep_noise(d, lo, hi, lambda u: np.where(u < peak, (u / peak) ** 2, np.exp(-(u - peak) * 9)))
        if kind == "sweep":  # the colour coming back: a shimmer of the scale's notes over the air
            t = t_(d)
            x = x + sum(np.sin(2 * np.pi * midi(s.note(i, 7)) * t) * np.exp(-((t / d - i / 6) ** 2) / 0.01) for i in range(5)) * 0.25
        return x * {"whoosh": 0.28, "sweep": 0.14}.get(kind, 0.18)
    if kind == "thud":  # the slide landing in the plastic holder
        return cat((0, click(0.003, 2500, 12000, 0.6)),
                   (0, modes(0.12, [(190, 0.8, 0.03), (430, 0.5, 0.02), (1150, 0.3, 0.012), (2600, 0.15, 0.006)])),
                   (0.012, click(0.002, 3000, 9000, 0.25))) * 0.6
    if kind == "slide":  # the holder dragging into the scanner: ridged plastic friction
        d = max(arg, 0.2)
        t = t_(d)
        ridges = 0.5 + 0.5 * np.sign(np.sin(2 * np.pi * (30 + 30 * t / d) * t))
        return bp(noise(d), 1200, 5000) * ridges * np.minimum(1, t / 0.03) * np.minimum(1, (d - t) / 0.04) * 0.12
    if kind in ("latch", "lock"):  # two small metallic clicks
        c = modes(0.04, [(2600, 1, 0.006), (3900, 0.6, 0.004), (6100, 0.3, 0.002)])
        return cat((0, c * 0.5), (0.028, c * 0.35)) * 0.6
    if kind == "scan":  # the scanner's shutter and its beep
        t = t_(0.09)
        beep = np.sin(2 * np.pi * midi(s.note(0, 7)) * t) * np.minimum(1, t / 0.004) * np.minimum(1, (0.09 - t) / 0.01) * 0.08
        return cat((0, click(0.003, 1500, 7000, 0.4)), (0.05, click(0.004, 1200, 6000, 0.3)), (0.1, beep))
    if kind in ("click", "tap"):  # a mouse button: press, then release
        press = cat((0, click(0.002, 3000, 12000, 0.5)), (0, modes(0.012, [(4200, 0.3, 0.003)])))
        return cat((0, press), (0.075, click(0.002, 3500, 12000, 0.25))) * (0.7 if kind == "click" else 0.5)
    if kind in ("key", "space"):  # a mechanical key: the switch's click, then the key bottoming out
        low = 175 if kind == "space" else 260 + rng.uniform(-25, 25)
        body = modes(0.07, [(low, 0.7, 0.018), (low * 2.3, 0.3, 0.01), (low * 5.1, 0.12, 0.005)])
        parts = [(0, click(0.0025, 3000, 12000, 0.45)), (0.006, body)]
        if kind == "space":  # the stabiliser's rattle
            parts.append((0.018, click(0.003, 2000, 8000, 0.15)))
        return cat(*parts) * 0.7
    if kind == "tick":
        return modes(0.05, [(2200, 0.6, 0.008), (3350, 0.3, 0.005)]) * 0.18
    if kind == "ding":
        return cat((0, bell(midi(s.note(0, 6)), amp=0.9)), (0, bell(midi(s.note(2, 6)), amp=0.5)))
    if kind == "merge":  # three brackets becoming one: a low whomp and a glassy chord
        t = t_(0.5)
        whomp = np.sin(2 * np.pi * np.cumsum(midi(s.note(0, 3)) * (1 + 1.5 * np.exp(-t / 0.05))) / SR) * np.exp(-t / 0.15) * 0.25
        return cat((0, whomp), *[(0.02 * i, glass(midi(n + 12), amp=0.7)) for i, n in enumerate(s.chord(5))])
    if kind == "face":
        return glass(midi(s.note(arg + 2, 6)), 0.5, 0.9)
    if kind == "land":  # a photo landing in the album: the notes climb
        return pluck(midi(s.note(arg % 10, 5)), amp=0.8)
    if kind == "sync":
        return glass(midi(s.note(arg + 4, 6)), amp=1.0)
    if kind == "chime":
        return cat(*[(0.07 * i, bell(midi(n + 12), 2.0, 0.8)) for i, n in enumerate(s.chord(5))])
    if kind == "card":
        return cat((0, pluck(midi(s.note(arg + 3, 5)), 0.5, 0.9)), (0, click(0.002, 1500, 6000, 0.08)))
    if kind == "blip":
        return glass(midi(s.note(arg + 5, 6)), 0.35, 0.6)
    if kind == "dust":  # specks crackling away
        d = max(arg, 0.2)
        out = np.zeros(int((d + 0.05) * SR))
        for _ in range(24):
            i = int(rng.uniform(0, d) * SR)
            c = click(0.0015, 2500, 11000, rng.uniform(0.1, 0.3))
            out[i:i + len(c)] += c
        return out * 0.5
    if kind == "pin":
        t = t_(0.18)
        plop = np.sin(2 * np.pi * np.cumsum(900 * np.exp(-t / 0.05) + 200) / SR) * np.exp(-t / 0.05) * 0.2
        return cat((0, plop), (0.05, bell(midi(s.note(4, 6)), 1.0, 0.6)))
    if kind == "logo":  # the ending: a warm chord, its notes rolled
        return cat(*[(0.05 * i, bell(midi(n), 3.0, 0.9) + bell(midi(n + 12), 3.0, 0.4)) for i, n in enumerate(s.chord(4))])
    return None


# ------------------------------------------------------------------ mix

def load_music(path, seconds, offset=0.0):
    ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
    raw = subprocess.run([ffmpeg, "-v", "error", "-ss", str(offset), "-i", path, "-t", str(seconds), "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).T.astype(np.float64)


def reverb(x, secs, mix):
    n = int(secs * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((2, n)) * np.exp(-t / (secs / 5))
    ir = np.stack([lp(ir[0], 7000), lp(ir[1], 7000)])
    ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
    wet = np.stack([fftconvolve(x[c], ir[c])[: x.shape[1]] for c in range(2)])
    return x * (1 - mix) + wet * mix


def main(cues_path, out_path):
    cues = json.load(open(cues_path))
    dur = cues["duration"]
    total = int(dur * SR)
    music = np.zeros((2, total))
    if cues.get("music"):
        m = load_music(cues["music"], dur, cues.get("offset", 0))
        music[:, : m.shape[1]] = m[:, :total]
    # the key is read from the track as it is, before the level automation reweights its sections
    if cues.get("key"):  # e.g. "G minor", when a cut leans on sections that fool the key finder
        name, mode = cues["key"].split()
        scale = Scale(NAMES.index(name), mode)
    else:
        scale = Scale(*find_key(music)) if np.abs(music).max() > 0 else Scale(9, "minor")
    if cues.get("gain"):  # the page's level automation, e.g. the drop coming in lower
        at, g = zip(*cues["gain"])
        music *= np.interp(np.arange(total) / SR, at, g)
    n = int(0.6 * SR)  # a short fade at the very end in case the track doesn't end there itself
    music[:, total - n:] *= np.linspace(1, 0, n) ** 0.5

    print(f"effects tuned to {NAMES[scale.tonic]} {scale.mode}")

    fx = np.zeros((2, total + 3 * SR))
    duck = np.ones(total + 3 * SR)
    for cue in cues["sfx"]:
        at, kind, arg = (list(cue) + [0])[:3]
        sig = make(kind, arg, scale)
        if sig is None:
            continue
        i = int(at * SR)
        if kind == "riser":
            i = int((at + arg) * SR) - len(sig)  # it ends on the beat it leads into
        if i < 0:
            sig, i = sig[-i:], 0
        j = min(fx.shape[1], i + len(sig))
        pan = np.full(j - i, float(kind[5:] or 0) if kind.startswith("swish") else 0.0)
        if kind.startswith("swish"):  # a swish travels across with its device
            pan = np.clip(pan + np.linspace(-0.4, 0.4, j - i), -1, 1)
        fx[0, i:j] += sig[: j - i] * np.sqrt((1 - pan) / 2) * 1.414
        fx[1, i:j] += sig[: j - i] * np.sqrt((1 + pan) / 2) * 1.414
        if kind in ("impact", "merge", "logo"):
            k = min(int(0.35 * SR), len(duck) - i)
            duck[i:i + k] = np.minimum(duck[i:i + k], 1 - 0.3 * np.exp(-np.arange(k) / SR / 0.12))
    fx = reverb(fx, 1.4, 0.2)[:, :total]

    mix = music * 0.82 * duck[:total] + fx * 0.75
    # up to a peak of -1 dB (a platform turns loud videos down but quiet ones not up), and a soft
    # limiter on the few peaks above what the music's own peaks allow
    loud = np.percentile(np.abs(mix), 99.95)  # the music's loud parts, not its rarest peaks
    top = np.max(np.abs(mix)) / loud
    mix = np.tanh(mix / loud * 0.85) / np.tanh(top * 0.85) * 0.89  # the highest peak lands on -1 dB
    pcm = (np.clip(mix, -1, 1).T * 32767).astype("<i2")
    with wave.open(out_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
