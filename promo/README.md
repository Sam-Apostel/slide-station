# Launch video

`slide-station-launch.mp4`: 40 seconds, 1920×1080, 30 fps, with music. Every cut is on a bar of
the music.

| Time | Scene |
| --- | --- |
| 0:00 | Thousands of slides, in a shoebox, slowly fading (the developed slides fade to the real scans) |
| 0:06 | Plug in the scanner: a slide goes into the Slide N Scan's holder, the card is imported |
| 0:10 | Brackets blended, colour restored, turned upright from the faces it finds |
| 0:15 | Review with the keyboard (Space, R, C, X) |
| 0:19 | Upload to an Immich album, then clean the card |
| 0:23 | Every device: Mac app, browser, iPad & iPhone, server, one library |
| 0:29 | Learning, people, dust, places from signs, tags, privacy |
| 0:33 | Logo, "Bring your slides back to life.", platforms, GitHub link |

The slides are real: 35 mm Kodachromes and Ektachromes from the EPA's DOCUMERICA project
(1971–1977), public domain, fetched from the National Archives and developed by Slide Station
itself: `slides/prepare.py` runs the app's `develop` with its default settings and its face
detector on each scan, so the before/after and the face boxes in the video are the app's own
output. Credits are in `slides/CREDITS.md`. The music is public domain too (`music/CREDITS.md`).

## Editing it

It's all in `index.html`: HTML and CSS for the scenes, with every animation on one timeline that
can be stepped to any moment. The slides are in `slides/`, the music in `music/` and the fonts
(Inter, Fraunces, Caveat, JetBrains Mono, all under the SIL Open Font License) in `fonts/`, so
nothing loads from the network. `soundtrack.py` mixes the music with sound effects it synthesises (key presses, clicks,
the slide landing in the holder), cued by the page.

Open `index.html` in a browser to play it (click for sound, Space pauses, ←/→ jump a second,
`index.html?t=20` starts at 0:20). To render:

```bash
cd promo
npm install && npx playwright install chromium
npm run stills -- 12,21.5      # PNGs of single moments into stills/, to check a layout
npm run render                 # slide-station-launch.mp4
```

Rendering needs `ffmpeg` on the PATH (or `FFMPEG=/path/to/ffmpeg`), and Python 3 with `numpy`
and `scipy` for the sound; without them it writes the video silently. It takes a few minutes.

The scenes start on bars of the music (`T` at the top of the `<script>`), and every
`A(target, keyframes, start, duration, easing)` call is one animation. `sfx(time, kind)` cues a
sound; the kinds are in `SFX` in `soundtrack.py`. To change the slides, edit
`slides/sources.json` and run `uv run --python 3.12 python promo/slides/prepare.py` from the
repository root.
