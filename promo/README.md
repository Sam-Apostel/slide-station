# Launch video

A 1920×1080, 30 fps launch video, rendered here from `index.html`. It is 24 bars long and every cut
and every move sits on the music's bars and beats: a key on each beat, a photo landing on each
sixteenth. No music or rendered video is committed: the track is licensed for YouTube only, so the
video is rendered locally with it (see "Music" below); about 41 seconds at 140 BPM.

| Bars | Scene |
| --- | --- |
| 1–4 | Thousands of slides, in a shoebox, slowly fading; the 4th bar is the hush before the drop |
| 5–6 | Plug in. Import.: a slide lands in the Slide N Scan's holder, the holder goes in, Import |
| 7–8 | Fixed for you.: brackets blended, colour restored, turned upright from the faces it finds |
| 9–10 | Review at speed.: Space, R, C, X |
| 11–12 | Into Immich.: the photos fly into an album, the card is cleaned |
| 13–16 | On every device. One library. |
| 17–20 | Six feature cards, one on each beat |
| 21–24 | Logo, "Bring your slides back to life.", the GitHub link |

The slides are real: 35 mm Kodachromes and Ektachromes from the EPA's DOCUMERICA project
(1971–1977), public domain, fetched from the National Archives and developed by Slide Station
itself: `slides/prepare.py` runs the app's `develop` with its default settings and its face
detector on each scan, so the before/after and the face boxes in the video are the app's own
output. Credits are in `slides/CREDITS.md`.

## Editing it

It's all in `index.html`: HTML and CSS for the scenes, with every animation on one timeline that
can be stepped to any moment. The slides are in `slides/`, the music tools in `music/` and the fonts
(Inter, Fraunces, Caveat, JetBrains Mono, all under the SIL Open Font License) in `fonts/`, so
nothing loads from the network. `soundtrack.py` mixes the music with sound effects it synthesises (key presses, clicks,
the slide landing in the holder), cued by the page.

Open `index.html` in a browser to play it (click for sound, Space pauses, ←/→ jump a second,
`index.html?t=20` starts at 0:20). To render:

```bash
cd promo
npm install && npx playwright install chromium
npm run stills -- 12,21.5      # PNGs of single moments into stills/, to check a layout
node render.cjs --music edit.wav --bpm 140 --out slide-station.mp4   # see Music
```

Rendering needs `ffmpeg` on the PATH (or `FFMPEG=/path/to/ffmpeg`), and Python 3 with `numpy`
and `scipy` for the sound; without them it writes the video silently. It takes a few minutes.

## Another track (e.g. for YouTube)

Any track works; keep it out of the repository if its licence doesn't allow redistribution
(Approaching Nirvana's free-to-use originals, for one, are for YouTube videos, credited in the
description: "Music by Approaching Nirvana", their channel, the song title and a Spotify link).

1. `python3 music/beats.py song.mp3` estimates the tempo, where the bars start and the drop.
2. Cut the song to 24 bars on its bar lines, choosing bars so that its drop is the 5th and the
   phrases join where they end: `music/cut.py` joins whole bars with short crossfades and fades
   the last one. For "Long Past, and Yet to Come" (140 BPM, bars from 0.03 s): the last intro bars
   and the hush (13–16), one 16-bar drop phrase (17–32), then the outro (114–117):

   ```bash
   python3 music/cut.py song.mp3 --bpm 140 --first-beat 0.03 --bars 13-32,114-117 -o edit.wav
   node render.cjs --music edit.wav --bpm 140 --out slide-station-youtube.mp4
   ```

   Or skip the cut and start the song a little before its drop:
   `node render.cjs --music song.mp3 --bpm 128 --offset 31.9` (4 bars before the drop).

The video is timed for 115 BPM and played faster or slower to fit the track, so the cuts stay on
its bars. The sound effects are tuned to the track's key, which `soundtrack.py` finds itself.
The page previews the same way: `index.html?music=<path from promo/>&bpm=140`.

## Timing

The scenes start on bars of the music (`T` at the top of the `<script>`), and every
`A(target, keyframes, start, duration, easing)` call is one animation. `sfx(time, kind)` cues a
sound; the kinds are in `make()` in `soundtrack.py`. To change the slides, edit
`slides/sources.json` and run `uv run --python 3.12 python promo/slides/prepare.py` from the
repository root.
