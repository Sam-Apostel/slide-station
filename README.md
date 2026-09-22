# Slide Station

Digitise 35mm slides without the tedium: import from a Kodak Slide N Scan, blend bracketed scans
into one HDR image, straighten, restore faded colour, upload to Immich, clean the card. It runs
locally in your browser, keyboard-first, built for working through thousands of slides.

- Groups repeated scans of one slide automatically and exposure-fuses them
- Guesses rotation from faces and skies, and leaves slides alone when it isn't sure
- Restores faded film, and **learns your corrections** to pre-set the next slides
- Uploads to a per-tray Immich album (works with Immich v1.118 → v3)
- Deletes scans from the card only after they are verified and uploaded

Import Kodak Slide N Scan scans, blend brackets into HDR, turn slides upright, restore faded
colour, upload to Immich and clean the scanner's card - in one window.

## Start

Double-click **Slide Station.command**. The first time, macOS may say it is from an unidentified
developer: right-click it → Open → Open. The first start installs `uv`, Python 3.12 and the image
libraries (about a minute); after that it starts in a couple of seconds and opens
http://localhost:8765 in your browser. Keep the Terminal window open while you work.

Terminal equivalent: `uv run --python 3.12 python -m slidestation`

The first time the scanner is plugged in, macOS asks whether Terminal may access removable
volumes - allow it, otherwise the scanner is not detected.

## Set up once

Settings → Immich URL (e.g. `http://your-server:2283`) and an API key
(Immich → Account settings → API keys) with the permissions
`asset.upload`, `asset.delete`, `album.read`, `album.create`, `albumAsset.create`.
Test connection, Save. Works with Immich v1.118 and later, including v2 and v3.

Pick a library folder with room to spare: about 6 MB per slide with the defaults
(the original scans are kept; the finished JPEGs are deleted once they are in Immich because they
can be re-rendered from the originals at any time).

## Workflow per tray

1. Scanner in **USB mode** → the top bar shows "Slide N Scan · N new scans" → **Import**.
   Create a tray: name, Immich album (defaults to the name) and optionally the photo date
   (`1985`, `1985-07` or `1985-07-14`). The date goes into the EXIF so Immich puts the slides in
   the right year; slides get one-minute steps so they stay in tray order.
2. Scans of the same slide at different brightness are grouped automatically and exposure-fused.
   Rotation is guessed from faces (and bright skies); anything it isn't sure about is left alone.
3. Review with the keyboard: **→** next, **Space** looks good/next, **R** / **Shift-R** rotate,
   hold **B** for before, **C** copy colour from the previous slide, **X** skip (never uploaded),
   **M** merge with next, **1–9** leave a scan out of the stack, ✂ between stack scans splits a
   slide. Reviewed slides are rendered at full resolution in the background.
4. **Upload to Immich**. Editing a slide after uploading marks it "edited"; the next upload
   replaces the old copy in Immich (the old one goes to the Immich trash).
5. **Clean scanner card** unlocks once every slide is uploaded or skipped. It only deletes files
   that still match the verified local copies. Then eject.

Importing the same card twice never duplicates: every scan is fingerprinted.

## Scanning tips

- One scan per slide is usually enough. For contrasty slides (snow, backlit, dark interiors) add
  one brighter scan (+2 steps) straight after - the app blends them.
- Keep a slide's scans together (don't interleave slides).

## Files

`~/.slidestation/config.json` - settings (incl. API key, readable only by you).
Library folder → `sessions/<tray>/originals`, `cache` (previews), `export` (finished JPEGs),
`session.json` (all edits; safe to back up).

Face detection uses OpenCV's YuNet model (MIT licence, from opencv_zoo), bundled in
`slidestation/models`.

## Development

Backend only (the plain-JS UI in `slidestation/static` is served as-is):

```bash
uv run --python 3.12 python -m slidestation
```

The React UI (ProUI, see `NOTICE.md`) lives in `frontend/`:

```bash
cd frontend && npm install
npm run dev     # Vite on :5173, proxies /api to the Python server
npm run build   # writes slidestation/web, which the server prefers when present
```

Tests and a mock Immich live in `tests/`. `HANDOFF.md` documents the architecture, the invariants
worth keeping, and what is unfinished.

## Licence

MIT for this project's code — see `LICENSE`. Third-party components, including the ProUI files
under `frontend/src/components/ui`, are covered by `NOTICE.md`.
