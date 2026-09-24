# Slide Station

Digitise 35mm slides without the tedium: import from a Kodak Slide N Scan, blend bracketed scans
into one HDR image, straighten, restore faded colour, upload to Immich, clean the card. It runs
locally in your browser, keyboard-first, built for working through thousands of slides.

- Groups repeated scans of one slide automatically and exposure-fuses them
- Guesses rotation from faces and skies, and leaves slides alone when it isn't sure
- Restores faded film, and **learns your corrections** to pre-set the next slides
- Optionally recognises people across all your trays: name someone once, Immich gets it as a tag
- Straightens slides that sit crooked in their mount, and takes out dust, scratches, mould and Newton rings
- Local adjustments: graduated filters, radials and a brush to dodge and burn one part of a slide
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
  recognising people, the suggestion models (tags, captions, look-alikes, places from signs),
  "show in Finder". Rotation from faces does run: the face detector (about 15 MB with its runtime)
  loads the first time you import. Film stock and date guesses need no model and work there too.

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

## Next to Immich, as a container

Run Slide Station on the server that runs Immich, and use it from any browser: folders of scans are
uploaded from the browser to the server, which does the work and sends the slides to Immich.

1. Add the service in `docker-compose.example.yml` (and its volume) to Immich's `docker-compose.yml`,
   then `docker compose up -d`. Or build and run it on its own:

   ```bash
   docker build -t slide-station .
   docker run -d -p 8765:8765 -v slide-station:/data \
     -e SLIDESTATION_AUTH=immich -e SLIDESTATION_IMMICH_URL=http://immich-server:2283 slide-station
   ```
2. Open `http://<server>:8765` (or give it a hostname on the reverse proxy in front of Immich, with
   large request bodies allowed: the browser sends 8 MB pieces).
3. **Sign in with an Immich API key** (Immich → Account settings → API keys, with the permissions
   below). Your Immich user is your account: each person has their own trays, settings and library
   on the server, and nobody signed in there sees anyone else's.
4. Drop a folder of scans on the window, or choose one. It is uploaded (an interrupted upload
   continues when you drop the same folder again; files the server already has aren't sent again),
   then imported into a tray as usual.

Everything is kept in the `/data` volume (`users/<Immich user id>/` per person). Without
`SLIDESTATION_AUTH` it is a single-user server with no sign-in: then anyone who can reach port 8765
can use it, so keep it on a trusted network. The container checks its own health
(`/api/health`). Not there on a server: the scanner itself (plug it into a computer and drop its
folder), eject, show in Finder, tethered capture.

Running the Python app yourself on another machine works the same way:
`SLIDESTATION_HOST=0.0.0.0 uv run --python 3.12 python -m slidestation` (it listens on this
computer only unless told otherwise).

## Camera rig: RAW files and tethered capture

A camera on a copy stand over a light panel gets far more out of a slide than the Slide N Scan.
Slide Station treats a camera as just another source of scans:

- **RAW files** (DNG, CR2, CR3, NEF, ARW, ORF, RAF) import like scans once the optional RAW support
  is installed: start with `uv run --python 3.12 --extra raw python -m slidestation` (the container
  has it). They are decoded in 16 bits with the camera's white balance, then restored and developed
  like any scan; brackets are grouped and blended the same way. Shooting RAW + JPEG is fine: the
  JPEG next to a RAW is skipped. The camera, exposure and ISO go into the finished JPEG's EXIF.
- **Tethered capture** with [gphoto2](http://gphoto.org) (`brew install gphoto2`): connect the camera
  by USB, open a tray, and the top bar shows the camera with a **Capture** button (or press **P**).
  Each picture is downloaded and imported straight into the tray; a darker shot of the same slide
  right after joins it as a bracket. Exposure and focus are set on the camera. *This has only been
  tested with a stand-in for gphoto2, not a real camera yet* — reports welcome.

The browser version doesn't read RAW files.

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

   A slide that sat crooked in the scanner is straightened to its mount's edge on import when the
   app is sure; otherwise the Frame section says how far the mount is turned and offers
   **Straighten to mount** (the frame button next to it also crops to the inside of the mount).
   **Dust** in Adjust → Restore takes out specks and thin scratches (off by default; turn it up
   until they're gone — it leaves texture and fine detail alone). Next to it, **Mould** paints out
   fungus grown on the film (pale or dark blotches and branching threads, keeping the grain), and
   **Newton rings** evens out the faint rainbow rings where the film touched the mount's glass.
   Both are off by default. Mould leaves shapes that join up into something larger (a tree's twigs
   reach its branches) alone; it can take a lone bird or a small scribble for mould, so check
   those slides. Newton rings can also soften faint, fine stripes in the picture (corduroy, ripples).

   **Local adjustments** (the Local section, or **A** for the tool on the photo) fix one part of a
   slide: a **graduated** filter burns a blown sky back in from the edge you drag from, a
   **radial** dodges a dark foreground inside an ellipse (or, inverted, darkens around it like a
   vignette), and a **brush** paints where it applies (Erase takes paint away). Each has its own
   exposure, contrast, warmth, tint and saturation. Drag the handles on the photo: a graduated
   filter's start (full effect), middle and end (none) lines; a radial's centre and its two radii,
   which also turn it. **O** shows the mask in red, **⌫** deletes the selected one, **Esc** closes
   the tool; **⌘Z** undoes. They stay on the picture when you crop, straighten or turn the slide,
   and like the crop they belong to that slide: **C** (copy previous), Apply to rest, presets and
   Develop like… never copy them.
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

Photos Immich already has byte for byte are recognised on upload; a slide that only *looks like* one
you uploaded before ("a scan from 2021") is found by the optional look-alike check below.

## Tag suggestions (optional)

Settings → **Suggest tags (downloads a ~155 MB model)**. The first time, the app downloads a
scene-recognition model (CLIP, from Hugging Face) into the library's `models` folder — the top bar
shows the progress; an interrupted download continues where it stopped. From then on it looks at
each slide on this computer, in the background, and suggests tags like beach, snow, mountains,
wedding, birthday, church, car, dog, family group, portrait or interior. Nothing is applied on its
own:

- The **Insights** section of the inspector lists this slide's suggestions: ✓ adds the tag, ×
  dismisses it (it won't be suggested for that slide again, and a tag you keep dismissing needs a
  surer match before it's suggested anywhere). After accepting, "Apply to 12–31…" offers the same
  tag to the neighbouring slides.
- **Review tray…** (or ⌘K → Review suggestions) shows every suggestion in the tray grouped by tag:
  accept or dismiss a whole group at once, after taking out the slides that don't fit.
- The slide's tags are also in **Details** (type to add, × to remove), and the filmstrip can be
  filtered by tag.
- Tags go to Immich as tags on upload (give the API key `tag.create` and `tag.asset` too; an Immich
  older than v1.113 just skips them) and into the JPEG's keywords (XMP). Changing a slide's tags
  after upload uploads it again, like a caption.

### Look-alikes

The same model also notices slides that belong together, shown under Insights (and in Review
suggestions) as suggestions you accept with one click or dismiss:

- **The same shot twice** — "Slides 12, 13 and 15 look like the same shot": **Keep 13, skip the
  rest** keeps the sharpest, least blown-out one (click another thumbnail to keep that one instead;
  X brings a skipped slide back). Which eyes are open isn't judged.
- **Grouping mistakes** — a stack whose scans show different pictures ("may be another slide" →
  Split), or two neighbouring slides that are one slide at two brightnesses (→ Merge).
- **Scenes** — the filmstrip is divided into runs of similar slides ("Scene 2 · mountains · 4–6");
  **Apply to scene…** gives all of them a tag, date or caption at once.
- **Already in Immich?** Settings → "After uploading, look for photos in Immich that look like the new
  slides" (off by default). After each upload the app asks Immich for similar photos (its search by
  image; on servers without it, the photos taken around the slide's date) and compares them on this
  computer. A match shows as "Looks like a photo already in Immich": **Replace it** moves the old one
  to Immich's trash and puts the new one in its albums (a favourite stays a favourite), **Keep both**
  leaves them. Immich needs a moment to index a new upload; slides it hasn't yet are checked again
  with "Check". The API key needs `asset.read` and `asset.view` for this.

The thresholds were set on synthetic pictures, so expect to dismiss the odd suggestion; dismissing
"same shot" often makes it stricter. Tag suggestions and look-alikes aren't in the browser version yet.

## Film stock

Each slide can say what film it was shot on — Kodachrome, Ektachrome, Agfachrome, Fujichrome,
other or unknown — in **Details → Film stock**; the **Tray** section sets it for every slide
without its own. It is on in both the desktop app and the browser version (no model, no download).

- **A guess from the fading.** A slide with no stock gets a suggestion (✓ accept, × dismiss; ⌘K →
  Review suggestions takes a whole tray at once): Ektachrome tends to go red / magenta with grey
  blacks, Agfachrome cyan / blue-green, Kodachrome keeps its colour. That is a rule of thumb, so the
  guess never claims more than 75 % and weighs the whole tray, not just one slide (a sunset is red
  on any film). Once you've set the stock of five or more slides each of two stocks, the guess
  comes from the slides you labelled that look most like this one instead.
- **Better first colour settings.** Learned colour settings prefer slides of the same stock: a
  Kodachrome tray learns from your Kodachrome corrections, not your Ektachrome ones.
- **A dating hint.** Each stock was sold in certain years (Kodachrome 1936–2010, Agfachrome to
  2005 …). The Date field shows that range, warns when a date falls outside it, and offers a
  date from the dated slides of the same stock around a slide. It never changes a date by itself.
- Accepting a stock offers it to the neighbouring slides; the button next to a slide's stock gives
  it to a range of slides.

## Caption suggestions (optional)

Settings → **Suggest captions (downloads a ~276 MB model)**. The app downloads a small
image-description model (Microsoft's Florence-2, from Hugging Face) into the library's `models`
folder, then writes a one-sentence English caption for each slide on this computer, in the
background — a few seconds a slide ("A woman in an orange space suit with a helmet."). The
**Insights** section shows it in a box you can edit: Enter or ✓ makes it the slide's caption
(which Immich shows as the description), × dismisses it. "Apply to 12–31…" offers it to the
neighbours, and **Review tray…** lists every suggested caption to accept or dismiss together.
A slide that already has a caption — typed by you or pulled from Immich — is never captioned or
overwritten. Not in the browser version yet.
## Places

Every slide can have a **place** (Details → Place), so it shows up on Immich's map.

- **Type a town or city** and pick it from the list ("Venice" offers Venice, Italy before Venice,
  California; "Venice, Florida" narrows it; "Venezia" and "München" work too). The list comes from
  GeoNames' cities with 15,000+ people, downloaded once (~3 MB, the Download button under the field)
  into the library's `data` folder; searching needs no internet after that. Or type **coordinates**
  (`45.4371, 12.3326`, optionally after a name: `Our campsite 45.61, 13.70`).
- **Apply to a range** (the pin icon next to the place) gives a run of slides the same place, like
  "Date a range".
- **Suggestions** (with tag suggestions on, Insights section): the app can read **signs in the
  photo** — "WELCOME TO VENICE", "Benvenuti a Firenze", a station name — and suggest that place
  (Insights → "Suggest places from signs", a ~10 MB text reader, runs on this computer). A slide
  between two slides with the same place (say 11 and 14) gets that place suggested too. Nothing is
  applied until you accept it; the tooltip on the confidence says why it was suggested.
- **In Immich**: the place goes into the JPEG as GPS, and a place changed after upload is updated
  in place (latitude / longitude, no new upload; needs `asset.update`). Immich's API can't remove a
  location, so removing a place uploads the slide again without one. **Pull from Immich** brings back
  places moved on Immich's map, and photos pulled in from Immich keep theirs.

In the browser version you type coordinates (GeoNames doesn't allow downloads from other web pages)
and there are no suggestions; places still go to Immich and into saved JPEGs.

## People

Settings → **Recognise people across my slides** (off by default; the desktop app, not the browser
version). The first time it downloads a 39 MB face model, then finds the faces on every slide,
new imports included, and groups them by person across all your trays. Open **People** (the
people icon in the top bar, or ⌘K) to name each person once, tick two groups that are the same
person and merge them, or take a wrong face out of a group (hover it, ×); naming a group with a
name someone already has merges them too. Everything runs on your computer.

Immich gets the names as **tags** `People/<name>` on the uploaded slides (Immich's API can't
reliably assign its own faces and people to an uploaded photo across versions, so tags are the
dependable way; they show under Tags and are searchable). The API key then also needs `tag.create`
and `tag.asset`. Slides uploaded before you named someone: **Send names to Immich** in the People
dialog. Names are only ever added, never removed from Immich.

## Scanning tips

- One scan per slide is usually enough. For contrasty slides (snow, backlit, dark interiors) add
  one brighter scan (+2 steps) straight after - the app blends them.
- Keep a slide's scans together (don't interleave slides).

## Files

`~/.slidestation/config.json` - settings (incl. API key, readable only by you).
Library folder → `sessions/<tray>/originals`, `cache` (previews), `export` (finished JPEGs),
`session.json` (all edits; safe to back up), `faces.json` (faces found, when people are on),
`embeddings.json` (what the tag model saw, for look-alikes; recomputed if deleted);
`people.json` (who is who) and `models/` (the downloaded face model) at the top.

Face detection uses OpenCV's YuNet model (MIT licence, from opencv_zoo), bundled in
`slidestation/models`. Tag suggestions download OpenAI's CLIP (MIT licence) into the library's
`models` folder when turned on; `insights.json` in the library remembers which tags you accept and dismiss.
`stocks.json` in the library holds the slides whose film stock you set (for the film stock guess).
Places use GeoNames' `cities15000` (CC BY 4.0, <https://www.geonames.org>), downloaded into the
library's `data/geonames` folder, and reading signs uses PaddleOCR's models (Apache 2.0) in `models/ppocr`.

Caption suggestions download Microsoft's Florence-2 (MIT licence) the same way. Recognising people
uses OpenCV's SFace model (Apache 2.0), downloaded when you turn it on.

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
