# Architecture — Slide Station

For whoever works on this next (human or coding agent): what exists, why it is built this way,
the invariants worth keeping, and the traps that already cost time. What's still to do lives in
`ROADMAP.md`.

Repo: <https://github.com/Sam-Apostel/slide-station> · owner drives a Kodak Slide N Scan (RODFS50)
and has ~10,000 35mm slides to digitise into a self-hosted Immich.

---

## 1. What the app does

One window that takes a tray of slides from the scanner's SD card to an Immich album:

1. **Import** — detects the scanner as a mounted volume (`/Volumes/*/DCIM` with scanner EXIF),
   copies scans into a library, verifies every copy by SHA-1, never imports the same scan twice.
2. **Group** — consecutive scans of one slide at different brightness (the owner brackets by hand)
   are detected and exposure-fused (Mertens) into one image.
3. **Orient** — rotation guessed from faces (OpenCV YuNet) and, failing that, from where the sky is.
4. **Restore** — auto colour restoration for faded film + manual adjustments (Adjust panel).
5. **Develop** — keyboard-first: →, Space (develop = mark ready), R, B, C, X, M, F, 1–9. Tone curves
   per channel, with "Fit to data" (F, ⇧F for the tray) pulling each channel's ends in to the scan.
6. **Upload** — full-resolution JPEG with EXIF date into a per-tray Immich album; either only the
   developed slides (the rest stay to work on) or everything.
7. **Clean the card** — deletes only scans that still match verified local copies.

Status: **working end to end** and tested (see §7). The owner has run it on his own Mac.

## 2. Layout

```
Slide Station.command     double-click launcher (installs uv, runs the server)
pyproject.toml            Python deps; uv run --python 3.12 python -m slidestation
slidestation/
  server.py               FastAPI: JSON API + serves the UI
  workflow.py             import, preview/export rendering, upload, card cleanup, job runner
  imaging.py              signatures/grouping, rotation guessing, HDR fusion, colour pipeline
  learning.py             learns colour settings from approved slides (§5)
  insights.py             suggestions per slide: scene tags from CLIP, background analysis (§5a)
  store.py                config + session persistence (JSON on disk)
  immich.py               minimal Immich client (v1/v2/v3 compatible)
  models/                 YuNet face detector (MIT, from opencv_zoo)
  web/                    UI build output (`npm run build` in frontend/), committed
frontend/                 the UI: React 19 + Vite 7 + Tailwind 4 + ProUI (§4)
  src/standalone/         the browser-only version: the API and pipeline in the page (§4c)
desktop/                  Electron shell around server + UI (§4a, desktop/README.md)
tests/                    API tests (pytest), synthetic scans, mock Immich, Playwright flow (§7)
```

State lives outside the repo: `~/.slidestation/config.json` (settings, incl. the Immich API key,
chmod 600) and the library folder (default `~/Pictures/Slide Station`), which holds
`sessions/<id>/{session.json,originals,cache,export}`, `imported.json` (dedupe index) and
`learning.json`.

## 3. Architecture notes that matter

- **A "group" is a slide**; a "scan" is one JPEG from the card. `session.json` is the whole truth
  for a tray: scans, groups, params, rotation, review/skip flags, export and Immich records.
- **`render_key(group)`** hashes active scans + rotation + params. `group_status()` compares it to
  the key stored at upload time, which is how a slide becomes `changed` after an edit and gets
  re-uploaded (old asset moved to Immich trash).
- **Never save a stale session.** Long jobs (import, render, upload, cleanup) must not hold a
  `Session` across slow work and then write it back — the UI patches the same file. Use
  `workflow.update_session(sid, fn)`: it reloads under the lock, applies `fn`, saves. Renders
  commit only if the group's keys still match (the user may have edited meanwhile).
- **One full-resolution render at a time** (`_export_lock`). A 5-scan stack at 22 MP peaks around
  3 GB; two at once OOM-killed the server during testing.
- **Background renderer** renders approved-but-not-uploaded slides while the user keeps reviewing,
  so uploading is mostly network time. It skips while a job runs and works on `active_session`
  (set by `GET /api/sessions/{id}`).
- **Preview pipeline**: proxies (1600 px) and fused proxies are cached as JPEG in
  `sessions/*/cache`; previews are rendered per request from the cached blend, so slider changes
  feel instant while full-res work stays off the interactive path.
- **Card cleanup safety** (do not weaken): only volumes whose root is `/Volumes/<name>` with a
  `DCIM` folder are ever deletable; every file is re-hashed against the stored SHA-1 immediately
  before deletion; cleanup is blocked until every slide is uploaded or skipped. Folder imports
  (including from external drives) are never deletable.

## 4. UI

The UI is a React SPA on **ProUI** (<https://pro-ui.dev>, paid, shadcn-style registry), ported
from the original plain-JS app (removed; it is in git history before the port if you need it).

```
frontend/src/
  main.tsx, App.tsx          shell: layout, confirm flows, the keyboard map (useKeyboard)
  hooks/use-slide-station.ts all state + every API action (polling, selection, optimistic edits)
  lib/api.ts                 typed API client, payload types, preview URL/cache key
  components/                top-bar, filmstrip, stage, inspector, dialogs, empty-state, confirm
  components/ui/             ProUI registry files — installed by the CLI, don't hand-edit
```

- Layout: `ProToolbar` top bar with an activity well (job progress, or scanner + Import);
  filmstrip with `ProScopebar` filters; stage (preview, hold-B before, scan stack with split and
  1–9 toggles); `ProInspector` right rail with the tone curve, the Adjust panel and a pinned upload/clean footer;
  `ProStatusbar`. Toasts are sonner; `window.confirm` became a promise-based `AlertDialog`
  (`components/confirm.tsx`).
- Filmstrip | stage | inspector sit in a `resizable` panel group. The side panels keep their pixel
  width when the window resizes; widths are saved per combination of visible panels
  (`useDefaultLayout`, key `panel-widths`), and the group remounts when a panel is shown/hidden.
- Inspector sections are `ProDisclosureGroup`s (collapsed state in localStorage,
  `inspector-sections`), with a one-line summary when collapsed.
- Right-click a filmstrip tile or the photo: `components/slide-menu.tsx` (`context-menu`). Opening
  it selects that slide, then items call the same actions as the keys.
- ⌘K / Ctrl+K: `components/command-palette.tsx` (`command`) lists every action plus the other
  trays. In the desktop app it is also View → Command Palette.
- Tooltips: `components/tip.tsx` wraps ProUI's `tooltip` and shows the shortcut as a `Kbd`. Use it
  instead of `title=` on controls.
- `useKeyboard` ignores keys while a dialog **or a menu** is open (`[role=menu]`), so arrow keys
  and typeahead in the context menu don't move between slides.
- **Keyboard shortcuts are identical to the original** — they are why the app is fast for 10k
  slides. ← → always move between slides, even from a focused slider; ↑ ↓ nudge a focused
  adjustment value field (Shift: by 10).
- Slider edits are optimistic and debounced (140 ms). Pending edits are tied to the slide they
  were made on, so pressing → mid-debounce can't save them onto the next slide.
- Learning is surfaced: the Colour section says where the settings came from (tray defaults /
  learned from N slides / by hand) and "Use learned" calls `resuggest`.
- **Look:** `frontend/src/theme.css` is the Slide Station skin — the original UI's near-black
  cool tones, warm off-white text and amber (#f2b34b) primary actions with dark ink. It is
  unlayered and loaded after `index.css`, so it overrides ProUI's tokens *and* the hex colours
  ProUI hardcodes in its class lists, without touching the CLI-owned files. `ProButton active` =
  amber primary action. Restyle there, not in `components/ui/`.
- `slidestation/web` is committed so the launcher works without Node. Rebuild after UI changes.

**Adding ProUI components.** `components.json` has the `@proui` registry with
`Authorization: Bearer ${PROUI_LICENSE_KEY}`; the key lives in `frontend/.env.local` (gitignored).
Plain `npx shadcn add @proui/<name>` currently fails: every ProUI item lists its dependency as
`https://pro-ui.dev/r/r/pro-theme.json` (doubled `/r/`, 404). Use `frontend/scripts/proui-add.sh
<name>...`, which fetches the items, points dependencies at local copies and runs the CLI
(verified idempotent). It leaves the ProUI theme out unless you pass `--with-theme` (see below).

**ProUI licensing — agreed with ProUI's owner.** Including the components this app genuinely uses
is fine; bundling the whole kit is not ("don't leak the product"). So, in this public repo:
- `components/ui/` holds only components the app imports (directly or via another shipped one).
  When a component stops being used, delete it in the same commit.
- `src/index.css` holds the ProUI theme **trimmed** to those components (no knob, drawer, action
  bar, menu, disclosure, button/toggle/input groups…). Don't re-merge the full theme; if a new
  component needs trimmed rules, add back only those.
- The licence key stays in `frontend/.env.local` (gitignored); never commit registry JSON dumps.
- Git history was rewritten (2026-09-23) so no commit contains unused ProUI components or the
  old notes on fetching the registry. `NOTICE.md` records this.

### Tone curves

`Params.curves` = `{"rgb"|"r"|"g"|"b": [[x, y], ...]}` (0..1, missing channel = straight). Applied in
`imaging.develop` right after `tone_base` (auto restore + trim), per-colour curves first, then RGB.
The spline is a monotone cubic implemented twice — `imaging.curve_lut` and `frontend/src/lib/curves.ts`
— keep them identical. `render_key` leaves out empty curves so slides uploaded before curves existed
don't turn `changed`.

- `GET …/histogram?v=<tone_key>`: histograms of the curve's input, cached by `tone_key` (scans,
  strength, trim).
- `POST …/fit_curves` (`{"all": true}` = every undeveloped slide): sets strength to 0 and puts each
  colour channel's end points at its 0.1 / 99.9 percentile, keeping inner points and output levels.
  Setting strength 0 is deliberate: the curves take over from auto restore, so the histogram shows
  the scan itself.
- Editor: `components/tone-curve.tsx`. Click adds, drag moves, double-click or dragging an inner
  point out of the box removes. Curves are learned along with the sliders (§5).

### Adjust panel

`components/adjust.tsx` replaced the six `ProSlider`s (ProSlider was then removed, per the
licensing rule). Three groups — Restore (auto restore, trim), Light (brightness, contrast), Colour
(white-balance pad + saturation) — each with its own reset. Sliders are a native range input over a
painted rail (what the control does), with a centre notch, an amber bar from neutral to the value,
a typable value (↑ ↓ nudge) and double-click reset. The white-balance pad is warmth × tint in 2D.
The eyedropper (W, Esc cancels) sends the clicked point (0..1 of the preview) to
`POST …/neutral`, which solves `imaging.neutral_balance`: warmth/tint that make that spot grey,
sampled after restore + trim + curves (what the warmth/tint gammas act on), clamped to ±1.

### Crop & straighten

`Params.angle` (degrees, zoomed to hide corners) and `Params.crop` (`[l, t, r, b]` of the
straightened frame) are applied in `imaging.geometry`, inside `tone_base`, so the histogram, curve
fit and eyedropper all see the cropped picture. `preview.jpg?uncropped=1` renders everything but
the crop, for the crop tool (`components/crop.tsx`, K / Enter / Esc) to draw its frame over.
Framing is per slide: Copy previous, Apply to rest, tray defaults and learning never carry it over.

The pure geometry is `moveRect` / `resizeRect` in `crop.tsx`. With a locked aspect ratio a handle
drag sizes from whichever axis the pointer moved further along, keeps the opposite corner / edge
put, and at the photo's border stops growing instead of freezing: a side handle's centred axis
slides along the border to stay inside. Keys while the tool is open (handled in `stage.tsx`; the
app's keyboard map ignores keys while `.ss-crop` exists): arrows move the frame 0.5 % (⇧: 5 %),
⌥ / Alt + arrows resize it from the bottom-right corner (ratio and bounds respected), Enter / Esc.
A focused straighten slider keeps its own arrow keys.

### Tactile details

Filmstrip tiles are slide mounts (`.ss-mount`), the filmstrip header shows the tray from above
(`TrayGauge`, one slot per slide by status), the Develop / upload buttons are dimpled, and the
activity pill fills up as a job runs (`.ss-well-fill`). All in `theme.css`.

### Undo, split view, best of bracket, dates

- **Undo / redo** per slide: `g["history"] = {"undo": [...], "redo": [...]}` of `{params, rotation}`
  snapshots, pushed by every edit endpoint (`server._remember`), up to 60; edits to the same
  settings within 1.5 s coalesce, so a slider drag is one step. `POST …/undo`, `…/redo`. ⌘Z / ⇧⌘Z;
  in the desktop app the Edit menu sends `undo` / `redo` and the UI decides (text field → native
  undo, else the slide).
- **Split view** (Y): `imaging.before_view` renders the untouched scan through the same trim /
  straighten / crop as the developed one, so before and after line up; the stage clips one over
  the other at a draggable divider. Hold-B uses the same aligned "before".
- **Best of bracket**: at import, `imaging.scan_quality` (exposure-independent sharpness,
  clipped share) and `weak_scans` leave blurry or blown-out scans of a stack out
  (`g["auto_excluded"] = {scan: "blurry" | "clipped"}`), shown on the scan thumbnails; 1–9 puts
  them back and a later import respects that.
- **Dates and captions** per slide (`g["date"]`, `g["caption"]`). `store.slide_dates` gives every
  slide the date it goes to Immich with: its own, else interpolated between the dated slides
  around it in tray order, else the nearest dated one, else the tray date, else the scanner EXIF.
  The caption goes into EXIF ImageDescription (Immich's description). `meta_key` of date + caption
  is stored at upload; a change makes the slide `changed` (use `store.statuses(d)`, which knows the
  neighbours, rather than `group_status(g)` wherever that matters).
- **Date a range** ("12–31: Aug 1978"): `POST /api/sessions/{sid}/dates` with
  `{"from": gid, "to": gid, "date": "1978-08"}` sets the date of every slide from..to in tray order
  (either order, both included), validated like `PATCH …/groups/{gid}` (400 on junk, `""` clears),
  skipping locked slides; answers the session payload plus `"dated": n`. UI: "Date a range…" under
  the slide's Date field and in ⌘K (`DateRangeDialog` in `dialogs.tsx`, 1-based slide numbers,
  opening on this slide through the one before the next slide with its own date). The Swift app
  has the same as a popover in `MetaFields` (`AppModel.dateRange`).

### Locked slides

With "keep originals" off, originals are deleted once a tray is fully uploaded. Such a slide can't
be rendered at full resolution again, so it is **locked** (`g["locked"] = "originals"`, synced by
`workflow.sync_locks` on opening a tray and after deleting originals): every edit endpoint answers
409, batch operations skip it, its status is `uploaded` (Immich's copy is final), and if its local
settings don't reproduce the upload the preview shows Immich's own preview
(`GET /api/assets/{id}/thumbnail?size=preview`, needs the `asset.view` permission; falls back to
the local render). Marking it developed or skipping it is still allowed. Re-importing the same
scans into the tray restores the originals (the dedupe index no longer skips a scan whose
original this tray lost) and unlocks it.

### Icons

`desktop/build/icon.png` is generated by `desktop/build/make_icon.py` (mount in a tray, sunset in
the window). `frontend/public/favicon.svg` is its hand-simplified vector, also used as the app mark
in the bars; `favicon-32.png` and `apple-touch-icon.png` sit next to it.

"Reviewed" is called **developed** in the UI (the Space button is "Develop"); the data field is
still `reviewed`. `POST /finish {"only_ready": true}` uploads developed slides only;
`summary.ready_upload` counts them.

## 4a. Desktop app (`desktop/`)

Electron, plain CommonJS (no build step): `main.cjs` starts the Python server on a free port with
`SLIDESTATION_DESKTOP=1` and loads it; `preload.cjs` exposes `window.slideStation`, typed in
`frontend/src/lib/desktop.ts`. **The UI must keep working without the bridge** — every desktop
feature is behind `if (desktop)`, and the browser build is the same bundle.

- `ProTitlebar` renders only in the desktop app (`components/window-titlebar.tsx`), as ProUI
  intends for Electron: drag region, `trafficLights={false}` because macOS draws the real ones
  (`trafficLightPosition` in `main.cjs` centres them on the 44 px bar), `pro-no-drag` on controls.
  It is the desktop app's only bar: tray switcher + New tray, the activity well, panel toggles,
  help and settings (the same pieces `TopBar` shows in a browser tab).
- Menu → UI goes through `onCommand` (`hooks/use-desktop.ts`); UI → menu enabled/checked state
  through `setMenuState`. Single-letter shortcuts are menu *hints* only
  (`registerAccelerator: false`): the keyboard map in `App.tsx` stays the single source of truth.
- `/api/reveal` creates the export folder and, in desktop mode, leaves opening it to
  `shell.openPath` instead of shelling out to `open`.
- Packaged: the Python sources ship in `Resources/backend`; uv builds the venv under the app's
  userData (`UV_PROJECT_ENVIRONMENT`), never inside the signed bundle.
- Quitting kills the server's whole process group (uv → python); verified nothing is left behind.
- **Releases and updates:** every push to `main` is built, signed, notarised and published to
  GitHub Releases by a self-hosted runner on Sam's Mac (`.github/workflows/release.yml`); the app
  updates itself from there when idle (`updater.cjs`). Details, runner upkeep and the safety rule
  for a public repo: `desktop/README.md` → "Automatic releases and updates".

Tested under Xvfb on Linux with Playwright's Electron driver (menus, commands, panel toggles,
import, packaged uv first start). Not yet tried on a real Mac: traffic-light position, dock badge
and the Removable Volumes prompt for the .app are the things to look at first.

## 4b. Native app (`apple/`)

A universal iPad/iPhone SwiftUI app with the pipeline ported to Swift (`apple/SlideKit`); see
`apple/README.md` for the mapping. Invariants carried over: trays use the same JSON field names;
every change goes through `Library.update` (reload, apply, save); imports verify each copy by SHA-1
and record the dedupe index straight after copying; the Immich v1/v2 vs v3 field rules. **Keep
`imaging.py` and SlideKit in step** (and the browser's `imaging.ts`, §4c): change all of them, then
regenerate the golden fixtures (`apple/SlideKit/Tests/make_golden.py`) and run `swift test` and
`npm test` in `frontend`. The fusion fixture is Mertens without
alignment, because AlignMTB shifts identical synthetic scans by a pixel.

## 4c. Browser version (`frontend/src/standalone`)

The same UI as a static site with no backend (`npm run build:web` → `frontend/dist-web`; `npm run
dev:web`). The build flag `VITE_STANDALONE` (set by `--mode web` in `vite.config.ts`) makes
`lib/api.ts` answer every `/api/...` call inside the page instead of over HTTP, so the React code
is the same in both builds; in the regular build `@/standalone/*` resolves to an empty stub and
none of it is bundled.

```
standalone/
  server.ts          server.py + workflow.py as one module: every route, jobs, import, upload
  store.ts           store.py: render / tone / meta keys, dates, statuses, session.json writer
  imaging.ts         imaging.py function by function; pixels.ts: resize, blur, percentiles
  fusion.ts          Mertens (OpenCV's exact pyramids, from SlideKit) + median-threshold alignment
  learning.ts        learning.py, same learning.json
  engine.worker.ts   the pixel work in a worker; engine.ts talks to it (one worker for the UI,
                     one for jobs, so browsing stays quick during an import or upload)
  library.ts         the library: a folder on disk (File System Access) or the browser's OPFS
  boot.tsx, pick.ts  start-up (re-allowing a disk folder takes a click) and picking / dropping folders
  exif.ts, npy.ts,   reading scan EXIF / writing the export's; the .sig.npy signature cache;
  zip.ts, immich.ts  the save-to-disk zip; the Immich client (fetch)
```

- **Same library, same keys.** The library layout is the Python app's (`sessions/<id>/...`,
  `imported.json`, `learning.json`, `.sig.npy`). `store.ts` computes render / tone / meta keys byte
  for byte like Python (`pyDumps` mimics `json.dumps`, float formatting included) and writes
  `session.json` with params as floats, so a tray moves between the browser and the desktop app
  without every slide turning `changed`. `store.test.ts` pins the keys to values computed in Python.
- **Keep the three pipelines in step:** `imaging.py`, SlideKit and `imaging.ts`.
  `parity.test.ts` (`npm test`) runs the TypeScript pipeline on SlideKit's golden fixtures with the
  same tolerances as `ParityTests.swift`: restore, trim, develop, crop, curves, fit, eyedropper,
  grouping, best of bracket, fusion, alignment, straighten, learning (incl. learned curves).
- **Images.** Preview URLs stay the same; `imageSrc()` / `useImageSrc()` in `lib/api.ts` render them
  in the worker and hand out object URLs, cached only when the render matches the URL's key (the
  server's cache rule). The stage asks with high priority, filmstrip tiles only once scrolled into
  view, so the photo on screen never waits behind thumbnails.
- **Browser gestures.** Folder pickers and permission prompts need a click that just happened, so
  `finish` (save to disk) and `cleanup` ask for their folder in the route itself, before the job
  starts; dropped items are read inside the drop event (`pick.fromDrop`).
- **Immich from the page** needs CORS or the same origin (Immich enables CORS in development only);
  `immich.ts` turns a failed fetch into an explanation (mixed content, CORS). README has proxy
  snippets. Saving to disk (a picked folder, the library's export folder, or a zip) is the way
  around it.
- **Card cleanup** keeps the safety rules: only folders picked or dropped as a directory with
  `DCIM` at the root are removable (their handle is remembered in IndexedDB), write access is asked
  for at cleanup time, and each file is re-hashed before it is deleted.
- **Not ported:** YuNet faces (the sky rule runs), scanner detection and eject, the background
  renderer, reveal in Finder. Full resolution decodes and encodes through one canvas, so Safari on
  iPad / iPhone tops out around 16 MP (ROADMAP §0).
- Config (Immich URL and key, keep originals, learning) is in `localStorage` of that browser only.

## 5. Learning from past edits (new, working, untested in the wild)

`learning.py`. Every approved slide is stored as one example: 14 image features from the *blended,
undeveloped* image (per-channel 1/50/99 percentiles, brightness, contrast, red/green and blue/green
cast in log space, stack depth) plus the settings the user accepted. New slides get settings from
distance-weighted k-NN (k=7) over standardised features, with a distance cutoff so unlike slides
fall back to the defaults, and a 5-example minimum.

What is learned: the six sliders, trim, and the **tone curves**; never crop or straighten (framing
is each slide's own). `learning.json` examples are `{"key", "f", "p", "trim", "c", "t"}` where `c`
is the slide's cleaned `params.curves` (`{}` for straight); examples written before curves were
learned have no `c` and simply don't vote on curves. Curve suggestion (`learned_curves`, mirrored in
`Learning.swift`):

- Only neighbours with a `c` take part; their k-NN weights are renormalised to sum to 1. If none has
  one, the suggestion has no `curves` key and the slide keeps its curves.
- Per channel (`rgb`, `r`, `g`, `b`): if neighbours holding ≥ 0.5 of that weight have a curve for it,
  sample every neighbour's `curve_lut` (the straight line where it has none) at x = 0, 1/8 … 1 (9
  points, linear interpolation into the 1024-entry LUT) and weight-average; drop the channel if the
  average is within 0.005 of the diagonal everywhere; run the result through `clean_curves`.
- The suggestion's `curves` replaces the slide's whole curve set (so `{}` straightens it).

Curves are kept in absolute input levels, so a "Fit to data" curve sits at its own scan's
percentiles. That transfers because the neighbours are picked on those same per-channel 1/50/99
percentiles (features 0–8): they are scans faded like this one. (Re-mapping each curve relative to
its scan's percentiles was considered, but fit curves use 0.1/99.9 % of the trimmed, cropped
image and the curve's input depends on the learned strength, so it would add error, not remove it.)

- Recorded on review/upload, updated on re-edit, forgotten on skip (`server._learn`).
- Applied at import time; the group then carries `params_source: "learned:<n>"`. Any manual slider
  change sets `params_source: "manual"` and the suggestion never overrides it.
- `POST /api/sessions/{sid}/groups/{gid}/resuggest` (`{"all": true}` for the tray) re-applies.
- `GET /api/learning`, `POST /api/learning/reset`, config flag `learning_enabled`.

Offline validation on 41 slides from three real trays (60/40 splits, 60 trials): mean absolute
error on the restore strength **0.082 vs 0.146** for a fixed default — roughly half the error.
Warmth showed no gain there (0.019 vs 0.014), because the synthetic targets barely varied; revisit
once real edits exist.

Worth doing next: surface it in the UI (a "learned from N slides" badge on the inspector plus an
undo), and consider learning rotation corrections per film type once enough examples exist.

## 5a. Insights: suggestions from local models (ROADMAP §1)

`insights.py`. Models look at each slide in the background and make **suggestions**; nothing is
applied until the user accepts it. Opt-in: config `insights_enabled` (Settings → "Suggest tags
(downloads a ~155 MB model)"), off by default. The first model is zero-shot CLIP scene tags; the
plumbing is shared by what comes next (VLM captions, mount OCR dates, places).

**Data.** Per slide, next to the slide's own `date` / `caption` and new `g["tags"]` (a list of
lower-case strings):

```
g["insights"] = {"key": "<active scans + rotation + model + labels>",
                 "tags": [{"value": "beach", "confidence": 0.41, "source": "clip-vit-b32", "state": "suggested"}, ...],
                 "caption": null | {value, confidence, source, state}, "date": ..., "place": ...,
                 "error": "..."}          # only when the slide couldn't be analysed
```

`state` is `suggested`, `accepted` (the value became the slide's own tag / caption / date; a place
is kept as `g["place"]`, not sent anywhere yet) or `dismissed`. A stale `key` (other scans, a
rotation) means "analyse again": `insights.merge` keeps every accepted / dismissed entry, so a
dismissed suggestion never comes back for that slide, and a fresh suggestion of a tag the slide
already has counts as accepted. Removing a tag in the Details section dismisses its suggestion.

**Background analysis.** A daemon thread like the background renderer (§3): `insights.step()`
analyses one slide at a time — the open tray (`wf.active_session`) first, then trays queued with
`POST …/insights/run` — only while no job runs (imports reshape slides; uploads need the memory).
Each slide: `fused_proxy` (the blended 1600 px proxy) rotated upright → CLIP → commit through
`update_session`, only if the slide's key still matches (never a stale save). A slide that throws
gets `error` and the key, so it isn't retried forever. The UI reloads the tray every poll while
`payload.insights.pending` > 0.

**Scene tags (CLIP).** `Xenova/clip-vit-base-patch32` at a pinned revision, the quantized vision
(89 MB) and text (65 MB) ONNX models plus `vocab.json` / `merges.txt`, run with `onnxruntime`
(CPU, half the cores). `insights.Tokenizer` is CLIP's BPE in ~40 lines (checked token-for-token
against Hugging Face's tokenizer for the label prompts). `LABELS` is a fixed English list of
(tag, prompt) pairs — beach, sea, lake, snow, skiing, mountains, forest, landscape, sunset, city,
street, village, church, castle, wedding, birthday, christmas, party, car, train, airplane, boat,
dog, cat, horse, garden, flowers, family group, portrait, children, baby, interior, food, camping,
swimming pool. The prompts' text embeddings are computed once and cached as
`models/clip-vit-b32/labels-<hash>.npy` (the text model is only loaded for that). Per slide: CLIP's
preprocessing (short side 224 bicubic, centre crop, CLIP mean/std), cosine × 100, softmax over the
labels; up to 4 labels whose share ≥ the threshold (0.12) are suggested with that share as
`confidence`. Changing `LABELS` changes every slide's key, so trays are re-analysed.

**Download.** `POST /api/insights/model` starts a `model` job (progress in MB in the activity
pill) that fetches the files into `<library>/models/clip-vit-b32/` — never into the repo. Each file
goes to `<name>.part`, resumed with an HTTP Range request on the next attempt, checked against its
sha256 (LFS files) or git blob sha1 (small files), then `os.replace`d into place; a mismatch
deletes the part. Offline (any `httpx.TransportError`) the job fails with "Couldn't reach
huggingface.co … the download continues where it stopped". `model_ready()` = every file present
at its exact size.

**Learning.** Every accept / dismiss of a tag is counted per label in `<library>/insights.json`
(`{"labels": {"beach": {"accepted": n, "dismissed": m}}}`). A label's threshold is
`0.12 × clamp((1 + dismissed) / (1 + accepted), 1, 4)`: a label you keep dismissing needs up to 4×
the confidence before it is suggested again. `GET /api/insights` shows the counts.

**API.**
- `GET /api/insights` — enabled, ready, downloading, model size, labels, learned counts.
- `POST /api/sessions/{sid}/insights/run` (`{"force": true}`: analyse every slide again, keeping decisions).
- `POST /api/sessions/{sid}/insights/decide` `{"kind": "tags"|"caption"|"date"|"place", "action":
  "accept"|"dismiss", "value"?, "groups"?: [gid]}` — only open (`suggested`) entries; without
  `groups`, the whole tray (the review view's "accept all"); locked slides don't take accepted values.
- `POST /api/sessions/{sid}/insights/propagate` `{"kind": "tags"|"caption"|"date", "value", "from",
  "to"}` — tray-level propagation: every unlocked slide from..to gets the tag (added) / caption /
  date (replaced, validated like `/dates`); the same suggestion there turns accepted.
- `PATCH …/groups/{gid}` takes `"tags": [...]` (trimmed, lower case, deduped, ≤ 30 × 40 chars).
- Session payload: per slide `tags` and `insights` (without the key, plus `stale` and `error`);
  top level `insights: {enabled, ready, pending}`.

**Tags leave the app** two ways. `store.meta_key` includes the sorted tags *when there are any*
(so untagged slides uploaded earlier don't turn `changed`; `store.ts` mirrors it byte for byte), so a
tag edit after upload makes the slide `changed` and it goes up again. The export writes them as XMP
`dc:subject` (Pillow ≥ 11's `xmp=`; Immich also reads those as tags), and after uploading,
`finish_session` calls `Immich.tag_assets`: `PUT /api/tags` (upsert by name) then
`PUT /api/tags/{id}/assets {"ids": [...]}` for the assets uploaded in that run. Needs the
`tag.create` and `tag.asset` permissions; on a 404 (Immich before v1.113, no tag API) or 403 the
upload still succeeds and the job message ends "tags not sent (…)". `tests/fake_immich.py` has both
endpoints (`fake_immich.TAGS = False` plays an old server).

**UI** (`components/insights.tsx`). The inspector's **Insights** section: off → "Turn on in
Settings"; no model → "Download model"; else this slide's open suggestions with a confidence meter,
✓ accept / × dismiss, "Accept all" and "Review tray…". Details shows the slide's **tags** as chips
(× removes, a field adds). Accepting on one slide shows a toast "Apply to 12–31…" that opens
`PropagateDialog` (the "Date a range" pattern: from / to slide numbers); the offered run is the
neighbours that have or were suggested the same value (a date: up to the next slide with its own
date, `rangeEnd`), else just the next slide. **Review suggestions** (`ReviewDialog`, also in ⌘K)
lists the tray's open suggestions in piles by value ("mountains · 3 slides · ≈48 %") with Accept
all / Dismiss all and per-slide × — click a thumbnail to go to that slide; "Analyse again" forces a
re-run. The filmstrip gets a **tag filter** (own tags and open suggestions, with counts) under the
status scopes.

**Not ported.** The browser version (§4c) hides the Insights section, review view and setting (the
models would have to run in the page through onnxruntime-web: a follow-up); it shows a library's
tags read-only and keeps them in `session.json` and the meta key. The Swift app (§4b) is not
ported: its `Slide` Codable only encodes the keys it knows, so a tray saved there loses `tags` /
`insights`, and its meta key doesn't include tags. On the iPad the roadmap's route is Vision
classification (`VNClassifyImageRequest`) rather than this model.

**Tests** (`tests/test_insights.py`): CLIP replaced by a fake embedding (labels are one-hot
directions), the background thread kept out (`insights.step` patched; the tests call the real one):
suggestions never applied, accept / dismiss and re-analysis keeping them, rotation making a slide
stale, skipped slides, a failing slide not retried, tag removal dismissing, the threshold learning,
accept-all, caption / date plumbing, propagation, tags to Immich + XMP + `changed` after a tag edit,
an Immich without the tag API, the meta key, and the download (resume with Range, verify, offline,
corrupt part) through `httpx.MockTransport`. `SS_REAL_CLIP=1` adds a smoke test that downloads the
real model into the scratch library and checks a synthetic beach scene gets "beach" in its top 2
and a snowy mountain scene gets "snow" or "mountains" (not "beach") in its top 3 (verified:
beach → beach, sea; snow → mountains, snow, forest).

## 6. Immich integration facts (hard-won)

- Upload is `POST /api/assets`, multipart, header `x-api-key`.
- **v1 and v2 require `deviceAssetId` + `deviceId`; v3 rejects them** (whitelist validation). The
  client checks `GET /api/server/version` and sends the right field set — keep that behaviour.
- Album: `GET/POST /api/albums`, then `PUT /api/albums/{id}/assets {"ids": [...]}`.
- Re-upload after an edit returns a new asset id; the old one is trashed via
  `DELETE /api/assets {"ids": [...], "force": false}`.
- Immich takes the timeline date from EXIF `DateTimeOriginal`, which the exporter writes (tray date
  override, one minute per slide to keep tray order); `fileCreatedAt` is the fallback.
- API key needs: `asset.upload`, `asset.delete`, `album.read`, `album.create`, `albumAsset.create`.

## 7. Testing

`tests/` contains what was used during development:

- `tests/test_api.py` — pytest, the API under FastAPI's `TestClient` against a scratch library
  (`uv run --python 3.12 pytest tests -q`, ~15 s): bracket grouping and re-import dedupe; curves
  (`clean_curves`, `fit_curves` single / all, histogram caching, `render_key` ignoring neutral
  extras); crop & straighten (`clean_crop`, `uncropped=1`, apply-to-rest keeps framing); undo /
  redo (coalescing with the server's clock monkeypatched, redo cleared, the 60-step cap); dates
  (validation, `slide_dates` sources, caption / date making an uploaded slide `changed`); upload
  (v2 vs v3 fields, developed-only, re-upload trashes the old asset); locked slides (409s,
  develop / skip allowed, re-import unlocks). `tests/conftest.py` sets `SLIDESTATION_HOME` (with a
  `config.json`, learning off) and `SLIDESTATION_VOLUMES` to a temp dir *before* importing
  `slidestation`, and routes the real Immich client to `fake_immich.app` in-process by swapping
  `immich.httpx.Client` for a `TestClient`.
- `tests/synthetic.py` — made-up scans (smooth colour field + shapes + grain, a faded cast, scanner
  EXIF), every other slide a bracketed pair. `python tests/synthetic.py <folder> 8` writes a card's
  worth for the browser test. Each tray in the tests gets new bytes *and* new file names: the
  dedupe index also skips by a name + size + mtime fingerprint.
- `tests/fake_immich.py` — FastAPI mock implementing version/users/albums/assets, with a `/debug`
  endpoint; set `MOCK_IMMICH_MAJOR=3` to exercise the v3 field rules.
- `tests/ui_flow.py` — Playwright script: import from a fake card, browse, rotate, edit warmth and
  saturation, toggle a scan, hold-B before, Fit the tone curve (F), crop and straighten (K, 1:1,
  Enter), undo / redo (Ctrl/⌘Z), split view (Y), Develop (Space), upload, clean the card; asserts
  no console errors and prints timings. Selectors are roles/labels. `SS_APP`, `SS_SHOTS`,
  `SS_BROWSER_CHANNEL=chrome` (the installed Chrome) and `SS_BROWSER_PATH` (any Chromium, e.g.
  `/opt/pw-browsers/chromium` when the pip Playwright wants a newer build) are configurable; no
  `playwright install` needed.
- Make a fake card with `tests/synthetic.py <vol>/SS-CARD/DCIM/100MEDIA` (or `tests/make_card.sh
  <folder-with-scans>` → `/tmp/ss-card/DCIM/100MEDIA`), then run the server with
  `SLIDESTATION_HOME`, `SLIDESTATION_VOLUMES` (the card's parent), `SLIDESTATION_PORT`,
  `SLIDESTATION_NO_BROWSER` pointed at scratch dirs. **Never test against the real library** —
  and note `SLIDESTATION_HOME` alone isn't enough: without a `config.json` in it the library
  defaults to `~/Pictures/Slide Station`. Write one with a scratch `library` (plus the mock's
  `immich_url` and `"immich_key": "testkey"`, and `"learning_enabled": false`) first.

- `frontend`: `npm test` (vitest) — the browser pipeline against the golden fixtures and the tray
  keys against Python (§4c).
- `tests/web_flow.py` — the browser version end to end in headless Chromium: it serves
  `frontend/dist-web` (build it first) and the mock Immich with CORS on (`MOCK_IMMICH_CORS=1`), and
  stands in folders in the page's OPFS for the pickers, so import, develop (rotate, fit, crop,
  undo), date a range, upload, save to disk (EXIF checked), card cleanup and a reload all run
  through the real code. `SS_NO_FS_ACCESS=1` hides the picker API, as in Firefox and Safari: a
  folder `<input>`, a zip download, cleaning locked. Command in its docstring.

Things to re-check after changes: grouping across two imports (a bracket set split over two card
reads must merge), rotation suggestions, upload of a `changed` slide, skip-after-upload, and that
cleanup refuses when anything is unuploaded.

## 8. Traps

- `pkill -f "python3 -m slidestation"` also matches the shell running it. Use `pkill -fx`.
- OpenCV 5.0 resolves by default and works (verified: YuNet, MergeMertens, AlignMTB). Don't pin
  down to 4.x without re-testing rotation.
- macOS: the `.command` launcher is quarantined after download (right-click → Open), and Terminal
  needs the "Removable Volumes" permission before the scanner is visible.
- `Image.thumbnail` + `draft()` is what keeps proxy generation fast; don't load full-res for previews.
- The owner's scanner writes EXIF with a deliberately wrong clock (he sets it to the slide's year),
  so EXIF time is useful for ordering, not for dating.

## 9. Repo hygiene (public repo)

No personal data in the repo: no real paths, hostnames, API keys, library contents or family
photos. Test fixtures must be synthetic or user-supplied at runtime. `~/.slidestation/config.json`
and the library folder are outside the repo by design — keep it that way. `.gitignore` covers
`.venv/`, `node_modules/`, `__pycache__/`, `.DS_Store`.

Licences: project code MIT (`LICENSE`); third-party components recorded in `NOTICE.md` (ProUI —
proprietary, see §4; YuNet — MIT).
