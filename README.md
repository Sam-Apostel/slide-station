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

**Or as a desktop app:** `cd desktop && npm install && npm start` (or `npm run dist` for a .dmg).
Same app in its own window, with native menus, folder pickers, drag-and-drop import, dock
progress, notifications when uploads finish or the scanner is plugged in, and no Terminal window.
See `desktop/README.md`.

The first time the scanner is plugged in, macOS asks whether Terminal may access removable
volumes - allow it, otherwise the scanner is not detected.

## In the browser, nothing to install

The same app also runs entirely in the browser, as a static web page with no backend: build it with
`cd frontend && npm run build:web` and host `frontend/dist-web` anywhere (or `npm run dev:web` to
try it locally). Drop a folder of scans on the window — the scanner's card or any folder of JPEGs —
or pick one, develop the slides, then send them to Immich or save the finished JPEGs to disk.
Nothing leaves your computer except what you send to your own Immich.

- **Library.** In Chrome and Edge you can keep it in a folder on your disk (Settings → Library →
  Choose folder…); it has the same layout as the desktop app's library, so either app can open it.
  Elsewhere (Firefox, Safari) it lives in the browser's own storage on this computer.
- **Saving to disk.** The download button next to "Clean card" saves the developed slides (with
  their dates in EXIF) into a folder you pick (Chrome, Edge) or as a zip.
- **Cleaning the card** works in Chrome and Edge when the card was picked or dropped as a folder.
- **Developed slides are rendered in the background** while you keep working on the tray, as in
  the desktop app, so uploading or saving is mostly the time it takes to send them.
- **Large scans** that are more than a browser can hold in one canvas (Safari on iPad and iPhone
  stops at about 16 megapixels) are read and written in strips instead: slower, but they work.
- **Not in the browser version:** scanner detection (pick the card's folder instead), eject,
  rotation from faces (the sky rule still runs), "show in Finder".

**Connecting Immich.** Immich only answers requests from its own web address (it allows other
origins in development builds only), so the page has to reach it in one of two ways:

1. *Serve Slide Station from Immich's address* (simplest). With Caddy in front of Immich:

   ```
   photos.example.com {
     handle_path /slide-station/* {
       root * /srv/slide-station   # the contents of frontend/dist-web
       file_server
     }
     reverse_proxy immich-server:2283
   }
   ```

   Open `https://photos.example.com/slide-station/` and use `https://photos.example.com` as the
   Immich URL.
2. *Let the reverse proxy allow the page's origin* (CORS), answering the browser's preflight
   itself. With nginx:

   ```
   location /api/ {
     if ($request_method = OPTIONS) {
       add_header Access-Control-Allow-Origin "https://slides.example.com";
       add_header Access-Control-Allow-Headers "x-api-key, content-type";
       add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE";
       return 204;
     }
     add_header Access-Control-Allow-Origin "https://slides.example.com" always;
     proxy_pass http://immich-server:2283;
   }
   ```

A page served over https can't reach an `http://` Immich (other than on localhost). Or skip Immich
in the browser altogether: save to disk and drop the JPEGs into an Immich album yourself.

## Set up once

Settings → Immich URL (e.g. `http://your-server:2283`) and an API key
(Immich → Account settings → API keys) with the permissions
`asset.upload`, `asset.delete`, `album.read`, `album.create`, `albumAsset.create`.
For the round trip below also `asset.read`, `asset.update`, `asset.view`, `asset.download`,
`albumAsset.delete`, `stack.read`, `stack.create`, `stack.delete` (without them uploads work as
before). Test connection, Save. Works with Immich v1.118 and later, including v2 and v3.

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
   - **G** opens the review grid, every slide of the tray at once for the quick "all good" pass:
     arrows move the cursor, **Space** develops and steps on, **X** skips, **R** turns, **Enter**
     opens the slide, **G** or **Esc** goes back.
   - **Z** (or double-click the photo) zooms to 100 % of the full-resolution render. Drag to look
     around, **Z** or **Esc** to leave. **L** turns on a loupe that shows 100 % under the pointer.
   - **Presets** (bookmark icon in Adjust, or ⌘K): save a slide's colour under a name and apply it
     to a slide or to the rest of the tray. **Develop like…** copies the colour of any slide in
     any tray. Crop and straighten are never copied, and **⌘Z** undoes it on each slide.
   - **Stats** (chart icon in the top bar): slides per hour, trays left and a projected finish
     date for your target (10,000 slides unless you change it).
4. **Upload to Immich**. Editing a slide after uploading marks it "edited"; the next upload
   replaces the old copy in Immich (the old one goes to the Immich trash, its albums and favourite
   carry over). A new date or caption alone is changed in Immich in place, nothing re-uploaded.
   Photos Immich already has byte for byte aren't sent again.
5. **Clean scanner card** unlocks once every slide is uploaded or skipped. It only deletes files
   that still match the verified local copies. Then eject.

Importing the same card twice never duplicates: every scan is fingerprinted.

## Round trip with Immich

- **Keep the scans too.** Settings → "Upload the untouched scans too": each slide's original scans
  go to Immich as well, stacked under the developed photo, so nothing is ever lost. Needs an Immich
  with stacks; older servers just get the developed photos.
- **Pull from Immich** (Tray section, or ⌘K): captions and dates you changed in Immich come back
  into the tray.
- **Pull photos back in** (⌘K, or New tray → "From Immich…"): pick an Immich album and some or all
  of its photos — slides scanned years ago with other tools — and they become a new tray to
  restore, crop and re-date. Uploading one replaces it in Immich (same albums, favourite kept, the
  old one to the trash; with "keep the scans" on it stays, stacked under the new one).

Look-alike detection ("a scan you uploaded in 2021") isn't done: only exact duplicates are.

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

Backend (serves the committed UI build in `slidestation/web`):

```bash
uv run --python 3.12 python -m slidestation
```

The UI is a React + Tailwind + ProUI app (see `NOTICE.md`) in `frontend/`:

```bash
cd frontend && npm install
npm run dev     # Vite on :5173, proxies /api to the Python server on :8765
npm run build   # writes slidestation/web - commit it, the launcher runs without Node
```

ProUI components are added with the shadcn CLI and a licence key in `frontend/.env.local`
(`PROUI_LICENSE_KEY=...`, gitignored): `scripts/proui-add.sh <name>...` from `frontend/`.

The browser version is the same UI built with `npm run build:web` (see above); its pipeline lives
in `frontend/src/standalone` and `npm test` checks it against the Python one.

Tests and a mock Immich live in `tests/` (`uv run --python 3.12 pytest tests -q`).
`ARCHITECTURE.md` documents how it works and the invariants worth keeping; `ROADMAP.md` what's next.

## Licence

MIT for this project's code — see `LICENSE`. Third-party components, including the ProUI files
under `frontend/src/components/ui`, are covered by `NOTICE.md`.
