"""The launch video's soundtrack, synthesised: a warm pad, bass, soft drums and an arpeggio at the
page's tempo, plus the sound effects the page cues (window.SFX: a projector's clack at each cut,
whooshes, key presses, dings). No samples, so there is nothing to license.

    python3 soundtrack.py cues.json out.wav      (render.cjs writes cues.json and calls this)

Needs numpy and scipy.
"""

import json
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


def section_gain(t, points):
    """Piecewise-linear automation from [(time, gain), ...]."""
    ts, gs = zip(*points)
    return np.interp(t, ts, gs)


# ------------------------------------------------------------------ instruments

def pad_voice(freq, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for det in (-0.07, 0.0, 0.06):  # three detuned saw-ish voices (a few harmonics each)
        f = freq * 2 ** (det / 12)
        for h in range(1, 7):
            x += np.sin(2 * np.pi * f * h * t + rng.uniform(0, 6.28)) / h
    x = lp(x, 1400)
    return x * env(n, 0.9, 0.9) * 0.08


def bass_note(freq, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t) + 0.25 * np.sin(2 * np.pi * freq * 2 * t)
    return np.tanh(1.5 * x) * env(n, 0.01, 0.08) * 0.32


def pluck(freq, dur=0.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * freq * 2 * t) + 0.12 * np.sin(2 * np.pi * freq * 3 * t)
    return x * env(n, 0.003, 0.16, sustain=False) * 0.1


def kick(gain=1.0):
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 48 + 90 * np.exp(-t / 0.035)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.16)
    click = hp(rng.standard_normal(n), 2000) * np.exp(-t / 0.004) * 0.15
    return (x + click) * 0.55 * gain


def hat(gain=1.0):
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7000) * np.exp(-t / 0.018) * 0.06 * gain


def clap():
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    e = np.exp(-t / 0.06) + 0.6 * np.exp(-np.maximum(t - 0.012, 0) / 0.01) * (t > 0.012)
    return bp(rng.standard_normal(n), 900, 3500) * e * 0.12


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


# ------------------------------------------------------------------ arrangement

def main(cues_path, out_path):
    cues = json.load(open(cues_path))
    dur, bpm = cues["duration"], cues["bpm"]
    beat = 60 / bpm
    bar = 4 * beat
    total = int((dur + 0.5) * SR)
    music = np.zeros((2, total))
    drums = np.zeros((2, total))
    fx = np.zeros((2, total))

    # D major, one chord a bar: Dmaj7  A/C#  Bm7  Gmaj7 (roots, and the pad's voicing)
    prog = [(50, [62, 66, 69, 73]), (49, [61, 64, 69, 71]), (47, [62, 66, 69, 71]), (43, [62, 66, 67, 71])]
    bars = int(np.ceil(dur / bar)) + 1

    # where the energy goes: intro (0-6), logo (6-10.8), the steps (10.8-30), devices (30-39.6),
    # features (39.6-46.8), ending (46.8-)
    for b in range(bars):
        t0 = b * bar
        root, chord = prog[b % 4]
        for k, note in enumerate(chord):
            add(music, t0, pad_voice(midi(note), bar + 0.9), 1.0, pan=(k - 1.5) * 0.35)
        add(music, t0, pad_voice(midi(root + 12), bar + 0.9), 0.7)
        if 6.0 <= t0 < 46.8:
            # bass: quarter notes, eighths from the steps on
            step = beat / 2 if t0 >= 10.8 else beat
            for i in range(int(bar / step)):
                t = t0 + i * step
                add(music, t, bass_note(midi(root - 12 + (12 if i % 4 == 3 and step < beat else 0)), step * 0.9), 0.8 if t0 >= 10.8 else 0.6)
        if 10.8 <= t0 < 46.8 and not (30.0 <= t0 < 32.4):
            # arpeggio in sixteenths through the chord
            arp = chord + [chord[1] + 12, chord[2] + 12]
            for i in range(16):
                t = t0 + i * beat / 4
                note = arp[(i * 3) % len(arp)] + 12
                add(music, t, pluck(midi(note)), 0.9 if i % 4 == 0 else 0.6, pan=0.5 * np.sin(i))
    # outro: a last held chord
    add(music, 46.8, sum_at([(i * 0.05, bell(midi(n + 12), 5.0, 0.7)) for i, n in enumerate([62, 66, 69, 73])]))

    # drums
    t = 6.0
    while t < 46.8 - 1e-6:
        in_steps = t >= 10.8
        add(drums, t, kick(1.0 if in_steps else 0.7))
        if in_steps:
            add(drums, t + beat / 2, hat(1.0), pan=0.3)
            add(drums, t + beat / 4, hat(0.4), pan=-0.3)
            add(drums, t + 3 * beat / 4, hat(0.4), pan=-0.3)
            if int(round((t - 10.8) / beat)) % 2 == 1:
                add(drums, t, clap(), pan=-0.1)
        t += beat
    # a riser into the logo and into the ending
    add(fx, 6.0 - 2.4, noise_swell(2.45, 200, 8000, rise=0.98) * 0.12)
    add(fx, 46.8 - 1.8, noise_swell(1.85, 200, 8000, rise=0.98) * 0.1)
    add(drums, 46.8, kick(1.2))

    for at, kind in cues["sfx"]:
        make = SFX.get(kind)
        if make is not None:
            add(fx, at, make(), 1.0, pan=rng.uniform(-0.25, 0.25))

    # side-chain the music under the kick a little
    duck = np.ones(total)
    t = 10.8
    while t < 46.8:
        i = int(t * SR)
        n = int(0.25 * SR)
        duck[i : i + n] = np.minimum(duck[i : i + n], 1 - 0.35 * np.exp(-np.arange(n) / SR / 0.08))
        t += beat
    tt = np.arange(total) / SR
    level = section_gain(tt, [(0, 0.0), (0.8, 0.55), (5.6, 0.8), (6.0, 1.0), (46.8, 1.0), (dur - 1.6, 0.9), (dur, 0.0), (dur + 1, 0.0)])
    music *= duck * level
    drums *= section_gain(tt, [(0, 1), (dur - 1.2, 1), (dur, 0), (dur + 1, 0)])

    mix = reverb(music, 2.6, 0.35) + reverb(drums, 1.2, 0.12) + reverb(fx, 1.6, 0.22)
    mix = hp(mix, 30)
    mix = np.tanh(mix * 1.4) / 1.4
    mix *= 0.89 / np.max(np.abs(mix))
    mix = mix[:, : int(dur * SR)]

    pcm = (mix.T * 32767).astype("<i2")
    with wave.open(out_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
