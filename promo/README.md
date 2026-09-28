# Launch video

`slide-station-launch.mp4`: 53 seconds, 1920×1080, 30 fps, with sound. It shows the problem (a
shoebox of fading slides), the four steps (import, develop, review, upload to Immich), the devices
it runs on (Mac, any browser, iPad and iPhone, a server next to Immich), a few highlights, and ends
on the GitHub link.

| Time | Scene |
| --- | --- |
| 0:00 | Thousands of slides, in a shoebox, slowly fading |
| 0:06 | Logo, tagline, the four steps |
| 0:11 | Step 1: plug in the scanner and import |
| 0:16 | Step 2: brackets fused into HDR, colour restored, turned upright from faces |
| 0:20 | Step 3: review with the keyboard (Space, R, C, X) |
| 0:25 | Step 4: upload to an Immich album, then clean the card |
| 0:30 | Every device: Mac app, browser, iPad & iPhone, server, one library |
| 0:40 | Highlights: learnt corrections, people, dust & mould, places from signs, tags, privacy |
| 0:47 | Logo, "Bring your slides back to life.", platforms, GitHub link |

## Editing it

It's all in `index.html`: HTML and CSS for the scenes, with every animation on one timeline that
can be stepped to any moment. The pictures are drawn in SVG and the fonts (Inter, Fraunces,
JetBrains Mono, all under the SIL Open Font License) are in `fonts/`, so nothing loads from the
network. The soundtrack is synthesised by `soundtrack.py` (pad, bass, drums, arpeggio, and the
sound effects the page cues, like a slide projector's clack at each cut), so it has no samples to
license.

Open `index.html` in a browser to play it (Space pauses, ←/→ jump a second, `index.html?t=20`
starts at 0:20). To render:

```bash
cd promo
npm install && npx playwright install chromium
npm run stills -- 12,21.5      # PNGs of single moments into stills/, to check a layout
npm run render                 # slide-station-launch.mp4
```

Rendering needs `ffmpeg` on the PATH (or `FFMPEG=/path/to/ffmpeg`), and Python 3 with `numpy`
and `scipy` for the sound; without them it writes the video silently. It takes a few minutes.

To change the timing, each scene's block in the `<script>` gives its start time (`const s = …`),
and every `A(target, keyframes, start, duration, easing)` call is one animation. A scene is only
visible between its `data-in` and `data-out` times. `sfx(time, kind)` cues a sound; the kinds are
in `SFX` in `soundtrack.py`.
