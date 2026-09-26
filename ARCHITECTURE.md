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
  stats.py                progress across the library: slides per hour, projected finish (§4)
  insights.py             suggestions per slide: scene tags from CLIP, background analysis (§5a)
  filmstock.py            film stock per slide: fade-signature guess / k-NN, eras for dating (§5d)
  similar.py              look-alikes from the CLIP embeddings: duplicates, split / merge, scenes, Immich (§5e)
  eyes.py                 eyes open for look-alikes' "keep the best": face mesh + eye aspect ratio (§5e)
  captions.py             a caption per slide from Florence-2 (ONNX), for the insights (§5b)
  people.py               faces -> people: SFace embeddings, clustering, names, birthdays, ages (§5c)
  dating.py               dates from people's birthdays + ages; the places map (§5g)
  places.py               places: GeoNames gazetteer, sign OCR, tray neighbours (§5f)
  uploads.py, accounts.py folders uploaded from the browser; Immich-user accounts (§4e)
  watch.py                watched folders: sub-folders dropped into a share become trays (§4e)
  raw.py, tether.py       camera RAW files via rawpy; tethered capture via gphoto2 (§4f)
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
chmod 600) with this machine's downloads next to it (`models/`, §5a–§5g, and `data/geonames/`,
§5f: `store.models_dir` / `data_dir`, moved out of the library the first time they're asked for,
so a library in iCloud Drive shared with the iPad doesn't carry half a gigabyte of models; an
account on a hosted server keeps them in its library, or `SLIDESTATION_MODELS`), and the library folder (default `~/Pictures/Slide Station`), which holds
`sessions/<id>/{session.json,faces.json,embeddings.json,originals,cache,export}`, `imported.json`
(dedupe index), `learning.json`, `presets.json`, `people.json` (§5c), `insights.json` (§5a),
`stocks.json` (§5d) and `boxes.json` (below).

## 3. Architecture notes that matter

- **A "group" is a slide**; a "scan" is one JPEG from the card. `session.json` is the whole truth
  for a tray: scans, groups, params, rotation, review/skip flags, export and Immich records.
- **Boxes.** The slides are kept in numbered boxes of two trays, left and right: trays of 50, or 36
  in the shorter boxes. A tray's `box` (number) and `side` ("left" / "right") are in its
  `session.json` (both null: not in a box, like trays from before); `boxes.json` has each box's
  `size` and `writing` (what's written on it; a tray has nothing written on it). One tray per side
  (409 otherwise). A tray in a box is named after it ("Box 12 left") unless given a name, and a
  name or album that only said where it was follows it when it moves. The tray gauge shows the
  box's empty slots. A slide's `writing` is what's written on its mount: kept, never uploaded, and
  editable on a locked slide. `GET /api/state` lists `boxes`; `PATCH /api/boxes/{n}` sets size and
  writing. The browser version (`standalone/server.ts`) and the iPad app (`Library.move`,
  `Library.saveBox`) do the same.
- **`render_key(group)`** hashes active scans + rotation + params. `group_status()` compares it to
  the key stored at upload time, which is how a slide becomes `changed` after an edit and gets
  re-uploaded (old asset moved to Immich trash).
- **Never save a stale session.** Long jobs (import, render, upload, cleanup) must not hold a
  `Session` across slow work and then write it back — the UI patches the same file. Use
  `workflow.update_session(sid, fn)`: it reloads under the lock, applies `fn`, saves. Renders
  commit only if the group's keys still match (the user may have edited meanwhile).
- **One full-resolution render at a time** (`_export_lock`, a semaphore across every account:
  `SLIDESTATION_FULL_RENDERS`, default 1, §4e). A 5-scan stack at 22 MP peaks around 3 GB; two at
  once OOM-killed the server during testing.
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
- The hook keeps the tray asked for (`openId`, what the tray switcher shows) apart from the tray on
  screen (`sessionId` = the payload's own `summary.id`): while another tray loads the old payload is
  still shown, and pairing it with the new id asked for its previews under the wrong tray (404s).
  Every URL and action uses `sessionId`; `ui_flow.py` ends by creating a tray and asserting no
  failed request.
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

### Auto restore on over-exposed scans

`auto_restore`'s grey-world gamma is `log(target) / log(median)` per channel. A channel whose median
sits at white (over half the picture clipped, a scan ~1.5–1.8× over-exposed) made that NaN / inf in
Python (TypeScript and Swift special-cased it to 1, with a cliff just below). All three now keep the
median at most `RESTORE_MED_MAX` (0.999) and bound the gamma to `RESTORE_GAMMA` (0.25..4): a blown
channel is pulled down as hard as grey-world ever pulls a too-strong channel (the fixture scene's
blue already gets 3.3), a scan blown in every channel gets gamma 1 (levels only: nothing left to
balance), and a flat channel (an empty, white frame) keeps its levels instead of stretching to
black. Golden fixture `restored_blown.f32` (+ `restore_blown` in `golden.json`): scene.png ×1.5,
×2, ×3; `tests/test_restore_blown.py`, `parity.test.ts`, `ParityTests.testAutoRestoreBlownOut`.

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

### Mount detection & damage repair (dust, mould, Newton rings)

All are pixel features, so they exist three times — `imaging.py`, `standalone/imaging.ts`,
`SlideKit/MountAndDust.swift` (mould and rings: `MouldAndRings.swift`) — pinned by the golden
fixtures (`mount.png`, `dusty.png`, `dust.f32` and the `mount*` / `dust_*` keys of `golden.json`;
mould and rings below). Python tests: `tests/test_mount_dust.py`, `tests/test_mould_newton.py`.

**Mount** (`imaging.detect_mount`, on the blended proxy shrunk to 800 px, before rotation — the
tilt is the same at every quarter turn). The mount's darkness is the median of the outer 1 %
ring, the picture's the median of the middle half; no dark ring around a brighter picture = no
mount. Every column / row in the middle 80 % of each side is followed in from the border (up to
20 %) to where it rises through a threshold between the two for three samples in a row, with a
sub-pixel crossing; a robust least-squares line (four refits dropping points beyond 3 × 1.4826 ×
median residual) through those points is that side. A side counts with ≥ 20 points and ≥ 35 % of
its columns. The angle is the kept-points-weighted mean of the sides' angles; `confidence` =
agreement (1 − the worst side's deviation / 0.5°) × coverage (kept points / 60 % of all) × 0.8
with only two sides, and 0 below two sides or beyond ±10°. Synthetic scans turned ±0.5–5° come
out within 0.01–0.02°.

- Stored as `g["mount"] = {"angle", "confidence", "box": [l, t, r, b], "scans"}` at import. `box`
  is each found side's middle in 0..1 of the unturned scan (`None` if not found); `scans` are the
  active scans it was found on. The payload's `mount` is `None` when it is missing (trays from
  before) or stale (scans excluded / split since); the UI then calls `POST …/mount` once when the
  slide is shown, which finds and stores it (`workflow.mount_of`).
- An import applies `params.angle = -angle` by itself only to a **new** slide with confidence ≥
  `MOUNT_AUTO` (0.8), |angle| ≥ 0.1°, no framing, not developed (`workflow.straighten_to_mount`).
  Otherwise the Frame section offers "Straighten to mount" from `MOUNT_SUGGEST` (0.5).
- `POST …/mount {"apply": true}` sets the angle (undoable, `what: "mount"`); `"trim": true` also sets
  `crop` from `imaging.mount_crop`: each side's middle, turned with the slide (`rotate_box`), is sent
  through the same trim and straighten transform as `develop()` and the crop sits 0.5 % inside it.
  The dark-edge trim stays as it was; this is the tighter trim on top.

**Dust** (`Params.dust`, 0..1, default 0; `repair_dust` in `tone_base` after the trim and before
the geometry, so the mount's edge is never taken for a scratch and `before_view`'s trim is
unchanged). Found at proxy scale — larger images are shrunk to 1600 px first, so preview and
full-resolution export mark the same specks:

- luminance in float32 (exactly numpy's arithmetic, so the mask is identical in all three ports);
  white and black top-hats with a (2r + 1)² square, r = round(3 × long edge / 1600) (3 at proxy
  size); a pixel is a mark if a top-hat exceeds `0.25 − 0.19 × dust`; marks where more than a fifth
  of the (8r + 1)² neighbourhood is marked are texture and dropped (integer box counts); grown by a
  3×3 dilation.
- Fill: each marked pixel becomes the per-channel median (numpy's, even counts averaged in float32)
  of the unmarked pixels among (2r + 3)² samples around it; pixels with none wait for the next pass
  (8 passes, each reading only pixels known before it). At full resolution each pixel takes its
  proxy pixel's verdict and the samples are spaced a proxy pixel apart, so the cost stays ~1 s for
  15 MP. No `cv2.inpaint`: this is simple enough to be bit-exact in TypeScript and Swift.
- Keys: `store.NEUTRAL_EXTRAS` has `"dust": 0.0`, so `render_key` of existing slides doesn't change;
  `tone_key` appends dust only when it is on. Not learned (the colour features say nothing about
  dust); "Apply to rest" and "Copy previous" carry it like the colour settings.

**Mould** (`Params.mould`, 0..1, default 0; `repair_mould` in `tone_base` right after the dust,
so specks never sit in its samples). Fungus on the film shows as lighter or darker blotches and
branching filaments a few proxy pixels thick and up to a few mm long, often with a coloured rim —
bigger than dust, and shaped like things in pictures (twigs, birds), so it is found by shape.
Found at proxy scale like the dust (`_find_mould`), **in integers throughout**, so all three ports
mark the same pixels:

- the proxy at 8 bits (`trunc(v × 255 + 0.5)` in float32); r as for the dust (3 at 1600 px);
- the picture without its mould: cells of 4r × 4r px, each cell's integer mean (×9, floored), the
  **lower median of the 9 × 9 cells** around it per channel (a ±54 px window at proxy size: mould
  covers too little of it to move the median), bilinear between cell centres in float64 (the same
  formula, in the same order, in every port: `_bilinear_axis`, rows first);
- each channel's 3 × 3 sum (edge repeated) against that; a pixel is a candidate where the largest
  channel difference exceeds `9 × (30 − 18 × mould) / 2` (8-bit levels) — hysteresis: shapes are
  8-connected candidates at half the threshold with at least one pixel over the full threshold;
- a shape is mould when it is bigger than dust (area ≥ 3r²), at most `MOULD_LONG × r` long (40r =
  120 px, ~2.7 mm of the film) and fills little of its bounding box (area ≤ (35 + 20 × mould) % of
  it: branching, filament-like, ragged). Picture detail joins up into shapes too long or too solid
  for that: a tree's twigs reach its branches and trunk, discs, bars and leaves are solid or dense.
  Grown by a (2g + 1)² dilation, g = round(r / 2), for the soft rims.

Fill: low frequencies are the per-channel median of the clean proxy pixels on a 9 × 9 grid r apart
(`_median_fill`, the dust fill's passes, shared; "clean" = not a candidate of any shape, so mould
left alone isn't sampled), 6 passes, the background where that finds nothing. Grain comes from the
first clean pixel 6r or 12r away (→, ←, ↓, ↑, then the diagonals): its value minus the mean of the
(2g + 1)² around it, g one proxy pixel — so the fill carries the film's grain instead of a flat
patch. At full resolution the mask is the proxy pixel's verdict, the low frequencies are the
proxy's (bilinear) and the grain is the full-resolution picture's, so the cost stays at the
proxy's. What it can't tell apart: a small, thin, isolated shape in the picture (a distant bird
~50 px across at proxy size, a scribble) is removed; mould touching real detail joins its shape
and stays.

**Newton rings** (`Params.newton`, 0..1, default 0; `repair_newton` after the mould). Faint,
rainbow-coloured, concentric fringes where the film touches the mount's glass, their period
changing slowly across the frame. **Spatial, not an FFT**: the period changes across the rings, so
a notch filter would need an FFT per tile (and a radix-2 FFT written identically three times),
while a band-pass and three local statistics of it find the rings wherever they are and are just
box filters. At proxy scale (s = long edge / 1600):

- the band: `blur(x, r1) − blur(x, r2)` per channel, blur = two clipped box means (≈ Gaussian),
  r1 = round(s) (0 = none, for thumbnails), r2 = 14s: grain below, the picture's broad shapes above
  (periods ~8-80 px at proxy size);
- statistics of the band blurred once more (radius max(1, 2 r1)), summed over the channels and
  averaged over r3 = 20s: its energy E0, gradient energy E1 (= trace of the structure tensor J),
  Laplacian energy E2; **narrow-band** = E1² / (E0 E2), ~1 for one local frequency (a sinusoid:
  |∇b|² = k² b², (Δb)² = k⁴ b²) and ~0.3 for an edge's or grain's broad spectrum; **coherence**
  of J (one direction: rings, edges; not texture); **amplitude** √E0, from above the grain
  (0.001-0.003) up to `0.02 + 0.04 × newton` (fading out at twice that: real stripes and edges are
  stronger);
- weight = smoothstep(narrow, 0.6 − 0.15 n, +0.15) × smoothstep(coherence, 0.5 − 0.25 n, +0.25) ×
  the amplitude window; the correction `−weight × band` (luminance and chroma alike — the band is
  per channel) is added at proxy scale, or bilinear at full resolution (it is smooth).
- Python adds with OpenCV's `boxFilter` (fast), the ports with float64 running sums along rows,
  then columns; the results agree to ~1e-15, and the golden and proxy-size outputs came out
  bit-identical in TypeScript.

What it can't tell apart: faint, fine, regular stripes in the picture (corduroy, ripples, a
low-contrast grille) are softened like rings; high-contrast stripes, edges, twigs, leaves and grain
are left alone. The widest rings in the middle of a set (periods over ~80 px) are below the band on
purpose — at that scale they are indistinguishable from shading.

Both: `store.NEUTRAL_EXTRAS` has `"mould": 0.0, "newton": 0.0` (render keys of existing slides
don't change); `tone_key` appends `["mould", v]` / `["newton", v]` only when on (named, so never
confused with a dust value). Not learned; "Apply to rest", "Copy previous" and presets carry them
like dust. UI: two more sliders under Dust in Adjust → Restore, in its reset and in the collapsed
summary's count. Golden fixtures: `mouldy.png` → `mould.f32`, `rings.png` → `newton.f32`, keys
`mould_*` / `newton_*` (added to `golden.json`, older fixtures untouched). Python tests:
`tests/test_mould_newton.py` (synthetic colonies and rings on grainy pictures at proxy and full
resolution: error against the clean picture drops ≥ 10× (mould, low frequencies) and ≥ 5× where
the rings are 25-80 px apart; a bare tree, small discs and bars, dense leaves and a striped
awning untouched). Timings at 1600 × 1067: mould ~0.6 s in the browser (node), ~1 s in Python;
Newton rings ~1 s in either.

### Local adjustments (ROADMAP §6)

`Params.local`: a list (≤ 16) of adjustments, applied in order. Each has `kind` and its own
`exposure`, `contrast`, `warmth`, `tint`, `saturation` (-1..1) plus a mask:

```
graduated {"start": [x, y], "end": [x, y]}              full effect at start, none from end on
radial    {"center": [x, y], "rx", "ry", "angle", "feather", "invert"}
brush     {"strokes": [{"points": [[x, y], ...], "radius", "hardness", "flow", "erase"}]}
```

Pixel code exists three times — `imaging.py` (`clean_local`, `local_mask`, `local_look`,
`apply_local`, `turn_local`), `frontend/src/lib/local.ts` (`localMask`, shared with the stage's
mask overlay) + `standalone/imaging.ts`, `SlideKit/LocalAdjustments.swift` — pinned by `local.png`,
`developed_local.f32` and the `local_*` / `params_local` keys of `golden.json`. Python tests:
`tests/test_local.py`.

- **Where masks live.** Points are 0..1 of the *picture*: the trimmed, turned scan before
  straightening and cropping. Storing them in the straightened frame (like `crop`) would keep them
  put under a new crop but let them slide across the picture when the angle changes; in the
  picture frame they stay on what they cover through both. Each output pixel is traced back
  through the crop offset and the straighten exactly as `straighten()` samples (index coordinates
  about `w / 2`, the same zoom; angles under 0.01° count as none). Lengths (`rx`, `ry`, brush
  `radius`) are fractions of the picture's longer edge, so circles stay round. A quarter turn
  (`PATCH … {"rotation"}`) turns the masks with it (`turn_local`: (x, y) → (1 − y, x) per 90°,
  radial angle + 90), in `server.py`, `server.ts` and `AppModel.rotate`.
- **Resolution independence.** Each mask is drawn on a grid of `MASK_EDGE` (1024) cells along the
  picture's longer edge (`ceil` of each side), whatever the image's size, and sampled bilinearly
  (edge cells repeated) at each pixel; the proxy, previews and the full-resolution export get the
  same mask. Cell (i, j) is centred on picture point ((i + 0.5) / kx, (j + 0.5) / ky), kx = 1024 ×
  w / max(w, h). Graduated: `1 − smoothstep(t)`, t the projection on start→end. Radial: d = the
  elliptical distance in the ellipse's own axes (turned `angle`° clockwise), `smoothstep((1 − d) /
  feather)` (feather 0 = hard edge, clamped to 1e-3), `1 − m` when inverted. Brush: per stroke
  the distance to its polyline (each segment only in its own box grown by the radius), coverage
  `flow × (1 − smoothstep((d / radius − hardness) / (1 − hardness)))`; strokes combine like
  layers of paint (`m + c(1 − m)`), an erase stroke multiplies by `1 − c`. Masks are computed in
  float64, stored float32.
- **After the global develop** (`develop()`: `tone_base(crop=False)`, cut to the crop, curves,
  `finish`, then `apply_local`): the adjustment acts on the photo as it looks, so a dodge does
  the same thing whatever the global settings, and the histogram, curve fit and eyedropper
  (which read the image before `finish`) don't move when you paint. Per pixel, `local_look`
  runs the global formulas with the adjustment's values (white-balance gammas, contrast, a
  saturation factor of `1 + s`) and the result is blended in by the mask: `out += (look − out) ×
  m`. Exposure is asymmetric on purpose: a lift is a gamma `x^(2^(−1.5e))` (shadows come up,
  white stays white: dodging never clips), a cut scales `x × 2^(1.5e)` (whites come down too:
  burning a pale sky back in works like a grad ND filter). Python works in bands of 256 rows and
  only on the pixels a mask reaches, so a full-resolution export makes no full-size temporaries
  (13.5 MP, three masks: ~2 s extra).
- **Keys.** `store.NEUTRAL_EXTRAS` has `"local": []`, so `render_key` of slides without local
  adjustments (and of trays from before) doesn't change; `tone_key` ignores them. Every number is
  a float (`_num` rounds to 4 places and never gives `-0.0`) so `store.ts` hashes the same bytes;
  `store.test.ts` pins a key with all three kinds. SlideKit appends its sorted-key JSON to its own
  render key when there are any.
- **Framing-like, per slide.** `local` is in `server.FRAMING` (and `server.ts`' `framing()`):
  Apply to rest, tray defaults, presets and "develop like" keep each slide's own; learning never
  sees it; Copy previous (client side, `copyPrev`) leaves it out; `0` (reset colour) keeps it.
- **UI** (`components/local.tsx`). The inspector's **Local** section: add Graduated / Radial /
  Brush, the list (click selects and opens the tool), the selected one's sliders (the Adjust
  panel's `AdjustSlider`, named "Local exposure" … for screen readers), feather + invert for a
  radial, brush size / hardness / flow / paint-erase (tool state, stored per stroke). **A** (or the
  section's sun button, or ⌘K) opens the Local tool over the photo: `LocalOverlay` draws in the
  picture's own frame — a layer the size of the straightened frame, shifted by the crop, CSS
  `rotate(angle) scale(zoom)` — so its handles, lines and the red mask wash (`localMask` at 256
  cells, on a canvas) sit where the renderer puts them; pointer positions go back to the picture
  through `PictureView.fromShown`. Graduated: start, middle (moves both) and end handles; radial:
  centre, and one handle per radius whose direction also turns it; brush: drag to paint (a point
  every quarter radius, committed on release). While `.ss-local` exists the app's keyboard map
  stands aside (like the crop tool); the tool takes Esc, A and Enter (not on a button) to close, O
  (mask), ⌫ (delete). Edits go through `setParam("local", …)` — optimistic, debounced, one undo step per
  drag (`_remember` coalesces `params:local`). The split view and loupe are off while it's open,
  and moving to another slide closes it.
- **Not done:** auto masks (sky / subject), a mask per adjustment kind combination (e.g. radial ∩
  brush), feathering a graduated filter separately from its length. The iPad app decodes, renders
  and keeps local adjustments (uncompiled here) but has no UI for them yet.

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
  neighbours, rather than `group_status(g)` wherever that matters). Such a slide's next upload only
  updates Immich's date / description in place (§6a).
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

### Review grid, 1:1 zoom, presets, stats (ROADMAP §6)

- **Review grid** (G, `components/review-grid.tsx`): replaces the stage with every slide of the
  tray as a tile (`preview.jpg?size=400`, the quick small-render path), 2–6 columns by the stage's
  width (≥ 230 px a tile; 4 on a laptop). Its cursor *is* the selection, so the keyboard map in
  `App.tsx` drives it: ← → by one, ↑ ↓ by a row (the grid writes its column count into a ref the
  map reads), Space = `developStep` (selects the next tile first, then marks the one it left
  developed, so quick presses each move on), X / R / ⇧R / C / 0 / F / M act on the tile as usual,
  Enter / Esc / G go back to the single slide. B, W, K, Y, Z, L and 1–9 need the stage and do
  nothing in the grid. Double-click a tile opens it; right-click is the slide menu.
- **1:1 zoom and loupe** (Z or double-click the photo at the spot; L; `components/zoom.tsx`):
  the *full-resolution* render, not the 1600 px proxy. `GET …/groups/{gid}/full` →
  `{width, height, tile: 512, key}` renders it once (seconds), then `GET …/tile.jpg?col&row&v=key`
  hands out 512 px squares on a fixed grid (cached forever when `v` is the render key, like
  previews). One image pixel is one device pixel. Drag pans (the window is clamped to the photo);
  moving to another slide, Z, Esc or a double-click leave. The loupe is a 240 px circle of the same
  tiles under the pointer. Server: `workflow.full_image` keeps **one** slide's render (uint8, ~65 MB
  at 22 MP) keyed by (tray, slide, render key); it decodes the export when `g["export"]["key"]`
  matches the render key and the file exists, else fuses the originals under `_export_lock` (the
  one-full-render-at-a-time rule, §3). `_full_lock` makes concurrent tile requests wait for one
  render. Originals gone and no export: 409. Browser version: the jobs worker keeps the zoomed
  slide as RGBA (`zoomImage` / `tile` ops in `engine.worker.ts`), re-rendering on a miss; the
  1:1 view shares the ~16 MP canvas ceiling of Safari noted in §4c.
- **Presets** (library-wide `presets.json`: `{"presets": [{"name", "params", "created"}]}`): colour
  only — `params` minus `angle` / `crop` (`server._colour`), trim and curves included, like "Copy
  previous". `GET /api/presets`; `POST /api/presets` with `{"name", "params"}` or
  `{"name", "session", "group"}` (the slide's *saved* params; the UI flushes pending slider
  edits first); the same name replaces; `DELETE /api/presets/{name}`. UI: the bookmark icon in the
  Adjust header (`PresetsDialog` in `components/looks.tsx`) and ⌘K ("Apply preset “…”", "… to this
  and the rest").
- **Develop like…** any slide of any tray (`DevelopLikeDialog`: tray → slide thumbnails). The tray
  is read with `GET /api/sessions/{id}?peek=1`, which doesn't make it the background renderer's
  `active_session`.
- Both apply through `POST /api/sessions/{sid}/groups/{gid}/look` with `{"preset": name}` or
  `{"like": {"session", "group"}}` and `scope` `"this"` (409 if locked) or `"rest"` (this slide and
  every following one not yet developed; locked ones skipped). Each changed slide gets an undo
  step (`_remember(g, "preset" | "like")`), keeps its own framing, is re-learned (`_learn`), and
  gets `params_source` `preset:<name>` or `like:<slide number>:<tray name>` (the Adjust summary
  says so). Answers the payload plus `"applied": n`.
- **Stats** (`slidestation/stats.py`, mirrored in `frontend/src/lib/stats.ts` for the browser
  version — keep them identical; `stats.test.ts` runs the same cases as `test_tool.py`):
  `GET /api/stats?target=` across every tray. A slide's time is `g["developed_at"]` (set by
  `PATCH …/groups/{gid}` when `reviewed` turns true, dropped when it turns false) or, for slides
  uploaded without being developed, `g["immich"]["at"]` (set at upload). Trays from before either
  field have no times and just don't count towards the rate — nothing else reads them. Slides per
  hour = intervals between consecutive slide times, each capped at 10 min (longer is a break);
  none below 5 min of work. The projected finish uses slides a day over the last 14 days (over the
  days since the first of those when fewer, at least one day). `target` defaults to the config's
  `stats_target` (10,000; `POST /api/config {"stats_target": n}`). `Session._scan_all` caches each
  tray's summary and times by `session.json` mtime, shared with `list_all`. UI: the chart icon in
  the top bar, and ⌘K.

Tests: `tests/test_tool.py` (tiles and their cache headers, re-render on edit, export reuse,
409 without originals, presets, looks with undo / scope / locked, peek, `developed_at`, upload
time, the stats maths and endpoint). `tests/ui_flow.py` zooms, pans, uses the loupe, saves and
applies a preset (and undoes it), drives the grid with the keyboard and opens the stats;
`tests/web_flow.py` zooms, applies a preset to the rest and uses the grid in the browser version.

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
  strips.ts          scans bigger than a canvas: strip decode, JPEG encoder in JS (§4d)
  library.ts         the library: a folder on disk (File System Access) or the browser's OPFS
  boot.tsx, pick.ts  start-up (re-allowing a disk folder takes a click) and picking / dropping folders
  exif.ts, npy.ts,   reading scan EXIF / writing the export's (incl. GPS); the .sig.npy signature cache;
  zip.ts, immich.ts  the save-to-disk zip; the Immich client (fetch)
  filmstock.ts       filmstock.py: the fade guess, k-NN, eras (§5d)
  yunet.ts           rotation from faces: YuNet on onnxruntime-web (below)
  models.ts          downloading models into the library (insights.fetch_files)
  clip.ts, insights.ts  scene tags (insights.py): tokenizer, preprocessing, labels; the suggestion plumbing
  similar.ts         look-alikes (similar.py); eyes.ts: eyes open (eyes.py, §5e)
  places.ts, ocr.ts  gazetteer, sign OCR (places.py)
  people.ts          faces -> people (people.py); all of these: "Suggestion models in the browser" below
```

- **Same library, same keys.** The library layout is the Python app's (`sessions/<id>/...`,
  `imported.json`, `learning.json`, `.sig.npy`). `store.ts` computes render / tone / meta keys byte
  for byte like Python (`pyDumps` mimics `json.dumps`, float formatting included) and writes
  `session.json` with params as floats, so a tray moves between the browser and the desktop app
  without every slide turning `changed`. `store.test.ts` pins the keys to values computed in Python.
- **Keep the three pipelines in step:** `imaging.py`, SlideKit and `imaging.ts`.
  `parity.test.ts` (`npm test`) runs the TypeScript pipeline on SlideKit's golden fixtures with the
  same tolerances as `ParityTests.swift`: restore, trim, develop, crop, curves, fit, eyedropper,
  grouping, best of bracket, fusion, alignment, straighten, learning (incl. learned curves), mount
  detection, dust, mould and Newton ring repair and local adjustments.
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
- **Ported without a model:** film stock and its date hints (`filmstock.ts`, §5d), places typed,
  propagated, sent to Immich and written as EXIF GPS (§5f). Rotation from faces runs too (`yunet.ts`,
  below). **With downloaded models** (below): scene tags, look-alikes, the GeoNames search, sign
  OCR and people.
- **Not ported:** captions (§5b; why: below), scanner detection and eject, reveal in Finder. The
  background renderer and scans bigger than a canvas are in §4d.
- Config (Immich URL and key, keep originals, learning) is in `localStorage` of that browser only.

## 4d. Browser version: background renders, large scans, crop keys

- **Background renderer** (`server.ts`, after `renderExport`): the Python `_background_renderer`
  in the page. `GET /api/sessions/{id}` marks the open tray (`watchTray`); every 1.5 s, if no job
  runs and no render is in flight, the first developed, not skipped, not locked, not uploaded slide
  (by `statuses`, so a re-dated upload counts) whose export isn't fresh is rendered by
  `renderExport` in the jobs worker. One at a time; it reads the session only, and `renderExport`
  commits through `update` only if the slide's render and export keys still match, so an edit
  during the render leaves it for the next round. A job started while a render is in flight waits
  for it ("Finishing a background render") — full resolution stays one at a time. The upload then
  finds the export fresh and only sends it. `tests/web_flow.py` waits for three exports after
  developing three slides, before uploading.
- **Scans bigger than a canvas** (`strips.ts`, `engine.worker.ts`): Safari on iPad / iPhone
  refuses canvases over ~16.7 MP. `context()` tries the canvas (and, above 4 MP, that its far
  corner really draws); when it can't, a full-resolution decode reads the file in horizontal strips
  (`createImageBitmap(blob, 0, y, w, h)` per strip into one small canvas, never a full-size bitmap)
  and the encode falls back to jpeg-js (4:4:4, lazily loaded, needs a `Buffer.from` shim in the
  browser). Strips use the JPEG frame header's size, so an EXIF-turned scan would fail loudly
  (scanner scans aren't turned; Python ignores the tag too). To run the fallback anywhere, set
  `localStorage["slide-station-canvas-limit"]` (pixels): `SS_CANVAS_LIMIT=250000 python
  tests/web_flow.py` does, and checks the saved JPEGs decode, have the scan's size and are 4:4:4.
  `strips.test.ts` covers strip assembly and the encoder. Not tried on a real iPad yet.
- **Crop keys on Windows / Linux:** Alt+← is also the browser's Back. The crop tool's capture-phase
  `keydown` handler calls `preventDefault`, which is enough in Chromium: with real key presses
  (XTEST under Xvfb, headed Chromium on Linux) Alt+← goes back outside the crop tool and resizes
  the frame inside it. Playwright's `keyboard.press` never reaches the browser's own shortcuts, so
  `web_flow.py` only checks the page side. Firefox and Edge on Windows untested.

### Rotation from faces in the browser (`standalone/yunet.ts`)

The worker runs the repo's own YuNet file (`slidestation/models/face_detection_yunet_2023mar.onnx`)
with onnxruntime-web (wasm backend, one thread), and `yunet.ts` reproduces what
`cv2.FaceDetectorYN` does around the network, so the browser votes like `imaging.face_votes`:

- **Frame:** the proxy area-resized to 800 px wide (`pixels.resized`, OpenCV's INTER_AREA), `* 255`
  in float32 then truncated to uint8 (numpy's `astype`), BGR, turned 0/90/180/270, zero-padded
  right/bottom to a multiple of 32, planar float 0..255 (blobFromImage without scaling or mean).
- **Decode** per stride 8/16/32 over `cols = padW / s`, `rows = padH / s` anchors: score =
  `sqrt(clamp(cls) * clamp(obj))`, kept from 0.6; box centre `(c + dx) * s`, size `exp(dw) * s`;
  landmarks `(kps + c) * s`. **NMS** is `cv::dnn::NMSBoxes` on the boxes truncated to integers
  (Rect2i): candidates *above* 0.6, best first (stable), IoU ≤ 0.3 kept, top 5000; a single face
  skips NMS. Votes sum the scores ≥ 0.7 in float32. `suggestRotation(images, faceVotes)` then
  applies Python's rule; face votes are computed first because inference is asynchronous.
- **Free input size.** The ONNX file declares a fixed 1×3×640×640 input; OpenCV ignores that,
  onnxruntime refuses anything else. The graph itself reshapes with -1, so `freeInputSize` rewrites
  the protobuf before loading (input height/width become named dimensions, the declared output and
  intermediate shapes are dropped); the weights are untouched.
- **Loading.** The model and ORT's `ort-wasm-simd-threaded.wasm` (14 MB, 3.7 MB gzipped) are `?url`
  imports in `engine.worker.ts`, so only the web build emits them into `dist-web/assets` (the regular
  build aliases `@/standalone/*` away, and never contains them); ORT's JS is a dynamic import. All
  three load on the first rotation guess of an import. If anything fails the worker logs a warning
  and the sky rule guesses alone. `vite.config.ts` lets the web dev server read
  `slidestation/models`.
- **Tests / parity.** `yunet.test.ts` checks decoding, NMS, the padded input for each turn and the
  vote on made-up network outputs, plus the protobuf rewrite on the real file. Parity was checked by
  hand on 27 WIDER FACE validation photos (Hugging Face dataset viewer, kept out of the repo), each
  turned 0/90/180/270: (1) `yunet.ts` + onnxruntime-web in Node on the same decoded proxies as
  Python: 108/108 identical guesses, per-rotation votes within 0.004 of `face_votes` (OpenCV's own
  decode reimplemented in Python on onnxruntime matched `FaceDetectorYN` to 1e-6 first, confirming
  the decode and NMS reading); (2) the built web app in headless Chromium importing 80 of those
  turned photos: 79/80 identical guesses, the one difference a borderline case (the winning vote
  missed Python's `2 × second + 0.3` margin by 0.02) where the browser's JPEG decode tipped it.

### Suggestion models in the browser (ROADMAP §1 "Models in the browser version")

The browser version runs the desktop app's suggestion models — scene tags and look-alikes (CLIP,
§5a/§5e), the GeoNames search and sign OCR (§5f), faces → people (SFace, §5c) — through the same
onnxruntime-web that runs YuNet, with the same files, keys and JSON, so a library (a folder on
disk) moves between the apps with its suggestions, decisions, embeddings and people. Captions
(§5b) are the one model left out.

**Downloads** (`models.ts`, `insights.fetch_files`): the same files from the same pinned Hugging
Face revisions into the same library folders (`models/clip-vit-b32/`, `models/ppocr/`,
`models/face_recognition_sface_2021dec.onnx`, `data/geonames/`). The browser can only reach the
folder it was given, so it keeps them there; the local app keeps its own in `~/.slidestation/`
(§2) and moves a library's out when it first needs them, after which the browser downloads again. Hugging Face answers other origins: `resolve/` URLs and the CDN they
redirect to both send `Access-Control-Allow-Origin`, and the preflight allows `Range` (checked with
`curl -I` / `OPTIONS`). Each file goes to `<name>.part`, written through a `FileSystemWritableFileStream`
that is closed and reopened every 16 MB (`Library.writer`: what arrived survives a closed tab; a
writable only lands on close), resumed with `Range` next time (a 200 to a range starts over),
checked against its sha256 / git blob sha1 with WebCrypto, copied into place, the part removed. A
job in the activity pill (`model`, `places`, `ocr`, `faces`), progress in MB. Tests replace the
sources: `localStorage["slide-station-models"] = {"<id>": {repo, files}}` (ids `clip-vit-b32`,
`geonames`, `ppocr-v5-latin`, `sface`), like the canvas limit.

**Where they run.** The page (`server.ts`) keeps the state; the pixels and networks are in the jobs
worker (`engine.worker.ts` ops `clipImage`, `clipScan`, `clipThumb`, `clipText`, `ocrRead`,
`faces`, `faceCrop`; ORT sessions cached by file version, wasm, one thread, errors-only logging:
SFace's initializers would log warnings as console errors). The background analysis is
`insights.step` in the page: `watchTray`'s 1.5 s timer also starts `kickInsights`, which walks the
open tray, then trays queued by "Analyse", one slide at a time, only while no job runs, alongside
the background renderer; its worker calls have priority −1, so previews, imports and renders go
first. Each slide commits through `update` only if its insights key still matches (§5a); a failure is
stored as `error`. After the tags, `similarStep` embeds slides from before and every scan
(`embeddings.json`, its own write queue). When nothing is left to render, the renderer catches up on
faces (`findFaces`), as `workflow._render_next` does.

- **Scene tags** (`clip.ts`, `insights.ts`): `LABELS` / `LABELS_KEY`, CLIP's BPE (`Tokenizer`, the
  regex in Unicode classes), the label embeddings computed once with the text model and cached as
  `labels-<key>.npy` (the file Python writes and reads), the softmax, thresholds learned from
  `insights.json`, `merge` / `insightsKey` / `slideInsights` / `suggestBetween` as in insights.py and
  places.py. The preprocessing is **bit-exact**: `(clip × 255 + 0.5)` to bytes, then Pillow's
  `ImagingResample` (bicubic, a = −0.5, 22-bit fixed point, horizontal pass then vertical, each
  clipped to 8 bits) and CLIP's mean / std in float32. Accept / dismiss / propagate / tags edited in
  Details work as in server.py; tags now also go to Immich from the browser (`Immich.tagEach`) and into
  the export as XMP `dc:subject` (`exif.xmpSegment`), like the desktop app.
- **Look-alikes** (`similar.ts`): `embeddings.json` (float16 packing with numpy's round-to-even),
  duplicates / split / merge / scenes computed per payload (signatures read from `.sig.npy` for
  merge candidates), decisions (`d.similar`), `insights.json` counts, and the Immich check after
  upload / on demand (`/search/smart`, the date window fallback, thumbnails through CLIP levelled).
- **Place names** (`places.ts`): download.geonames.org sends no CORS headers, so the page downloads
  the same three files of one daily dump (2026-09-15) from `huggingface.co/datasets/DataDock/geonames`
  (CC BY 4.0, a pinned revision; sha256 / git sha1 checked, which the ever-changing originals don't
  allow). "Ready" is "the three files are there", as in Python, so a desktop-downloaded gazetteer of
  another day counts. The zip is read with `DecompressionStream("deflate-raw")`; `Gazetteer`,
  `search`, `nearest`, `placeFromText` port places.py rule by rule. Parsing the 34k cities takes ~1.3 s
  on the page's thread, once per library (a worker would be the fix if that shows).
- **Sign OCR** (`ocr.ts`): the DB detector and CTC recogniser on onnxruntime-web, with OpenCV's steps
  in TypeScript. `resizeLinear` is **bit-exact** with `cv2.resize(INTER_LINEAR)` on 8-bit images,
  including OpenCV's vectorised rounding (`((S0 >> 4) · b0 >> 16) + ((S1 >> 4) · b1 >> 16) + 2 >> 2`) and
  its vertical edge rule (rows past the edge keep their weights and repeat the edge row; columns are
  clamped with the weight on the edge). OpenCV 5's `warpPerspective(INTER_CUBIC)` samples the exact
  float point with float weights (unlike `remap` with fixed-point maps, which uses the 1/32 table):
  `crop` does the same, equal but for a level on the odd pixel. Boxes: 8-connected blobs of the
  thresholded map (what `findContours` outlines), the minimum-area rectangle of their hull (rotating
  calipers, as `minAreaRect`), the score over the blob with its holes (what `fillPoly` of the contour
  covers), the unclip, the corners ordered as `_order`.
- **People** (`people.ts`): faces from YuNet as `detect_faces` (the rotation vote's frame, scaled back
  in float32), `alignCrop` as OpenCV computes it — `getSimilarityTransformMatrix`'s Umeyama fit, with
  the 2 × 2 SVD in closed form (the rotation maximising trace(Rᵀ A), scale from |(a00 + a11, a10 − a01)|),
  and OpenCV 5's float bilinear `warpAffine` (a level off on a few pixels) — then SFace (fp32) and a
  unit vector. `faces.json`, face ids kept across re-finds (`recordFaces`), `agglomerate` and
  `refresh` / `rename` / `merge` / `removeFaces` / `slideNames` as people.py, the People dialog and
  routes (`/api/people…`, face crops through `image()`), and "Sync with Immich" as immich_people.py. Faces are found during import (each slide as
  it is committed), in the background and by "Find faces".
- **Captions stay desktop-only**: 276 MB in every browser's storage, and Florence's vision encoder
  alone takes ~3 s a slide on two native threads (§5b); single-threaded WebAssembly (threads need a
  cross-origin isolated page) would make that well over 10 s, plus a decoder pass per word. Settings
  doesn't offer it and `/api/insights/model` refuses it.

**Parity, measured** (scratch scripts, models and photos kept out of the repo):

- CLIP: `npm test` pins the tokenizer (a vocabulary learned from the prompts, and — with
  `SS_CLIP_DIR` — the real one on every prompt), Pillow's resize and the preprocessing bit for bit.
  With the real model on 7 synthetic scenes (beach, snow, waves; Node and headless Chromium give
  identical numbers), the browser's embeddings are within cosine 0.993–0.996 of Python's, the label
  embeddings within 0.9992: the 8-bit dynamically quantised graph amplifies float rounding, and
  Python's own ORT differs from itself by the same amount between graph optimisation levels (0.995).
  Tag shares agree within 0.035; the suggested tags (≥ 0.12) were identical on 5 of 7 scenes, the
  other two differing at the threshold (a third tag, a near tie). ~0.3 s a slide in Chromium.
- Sign OCR: 7 synthetic sign photos (straight and tilted ±6°, accents) read in headless Chromium
  exactly as Python reads them, text and confidence to 3 decimals, 0.7–1.7 s a slide. Gazetteer on
  the real cities15000: 713 searches (every two-letter prefix, accents, other scripts, coordinates)
  and 31 signs give identical results.
- People: 40 LFW photos (Hugging Face) on grey cards: the same 48 faces, boxes within 1e-4, SFace
  embeddings at cosine 1.0000, and the same 26 clusters; ~0.27 s a photo. In the app with the real
  SFace: 16 photos imported with faces, named in the People dialog.

**Tests.** `frontend/src/standalone/insights.test.ts` against `insights.fixture.json`, written by
`tests/make_insights_fixture.py` (Python's own code on planted inputs: tokenizer, resize,
preprocessing, softmax / thresholds, keys, merge, neighbours, float16 packing, similar.suggest /
scenes / dismiss / thresholds, normalise / levels, date windows, gazetteer / search / nearest /
place_from_text on a made-up extract, OpenCV's resize and warp, the DB post-processing with a
planted probability map through to CTC with planted probabilities, agglomerate and a sequence of
people.json edits, alignCrop). `tests/web_flow.py` downloads a stand-in CLIP (`tests/fake_clip`,
`tests/make_fake_clip.py`: CLIP's inputs and outputs, 25 KB) and a GeoNames extract from its own
server, accepts a tag, dismisses a look-alike, turns people on, and checks the tag in the fake
Immich and in the saved JPEG's XMP; `SS_REAL_CLIP_DIR` / `SS_REAL_OCR_DIR` use the real models (the
latter paints "WELCOME TO VENICE" on the last slide and expects the place suggestion).

Found on the way: the review dialog's and the look-alike cards' thumbnails were plain `<img src>`
of API URLs, which the browser version can't serve (now `PreviewImg`), and `setLibrary` kept the
previous library's film stock labels.


## 4e. Hosted container: uploads from the browser, accounts (ROADMAP §4)

The Python app as a container next to Immich (`Dockerfile`, `docker-compose.example.yml`): the
same server and UI, bound to `0.0.0.0` (`SLIDESTATION_HOST`; the default stays `127.0.0.1` for the
launcher and the desktop app), everything it keeps under `/data` (`SLIDESTATION_HOME`, with
`SLIDESTATION_LIBRARY=/data/library` as the single user's default library), `GET /api/health` for
the healthcheck (answers without signing in). python:3.12-slim + uv, `uv sync --frozen --no-dev
--extra raw`, the committed UI build, runs as uid 1000. Built and run here with the synthetic flow
below (two accounts, uploads, a DNG, upload to the mock Immich), not yet next to a real Immich.

**Uploads** (`uploads.py`, `lib/upload.ts`). A browser tab can't hand the server a path, so the
UI's drop / "Choose folder" — in the server app in a browser tab, not the desktop app (which has
paths) and not the browser version (which reads the folder itself) — uploads the files into a
staging folder `<library>/uploads/<id>/` and imports that:

- `POST /api/uploads {"name"}` → `{id}`; `POST /api/uploads/{id}/check {"files": [{"path", "size",
  "sha1"?}]}` → per file `{"have": true}` (here whole, or `"imported": true` when the library's
  dedupe index has that SHA-1: not sent at all) or `{"offset": n}` (bytes here so far);
  `PUT /api/uploads/{id}/files/{path}?offset=&size=&sha1=` appends one chunk (≤ 64 MB; the UI sends
  8 MB, three files at a time) to `<path>.part`. A wrong offset answers 409 with the right one, so a
  lost chunk just resumes; the chunk that completes the file checks the SHA-1 (422 and start over
  on a mismatch) and moves it into place; `upload.json` records the complete files.
- The UI remembers the upload id per folder (name, file count, bytes) in localStorage, so dropping
  the same folder after a reload or a dropped connection continues that upload. The SHA-1 comes
  from WebCrypto, which exists only in a secure context: over plain `http://` on the LAN the UI
  sends none and the size is the only check (and "already imported" can't be told apart).
- Paths are relative, without `..`, hidden parts, a leading `/` or a drive; only scan extensions
  (JPEG, and RAW when rawpy is there, §4f); `SLIDESTATION_MAX_UPLOAD_MB` (300) per file.
- Unimported uploads are listed as sources `upload:<id>` (`removable: false`, `upload: true`), so an
  interrupted session finds its folder in the activity well. `POST …/import {"source":
  "upload:<id>"}` runs `workflow.import_upload`: `import_scans` on the staging folder with
  `label="upload:<name>"` (the tray records that instead of server paths; **never removable**, so
  card cleanup refuses), then the staging folder is deleted. tus wasn't needed for this.

**Accounts** (`accounts.py`, `SLIDESTATION_AUTH=immich`, off by default). Sign in with an API key of
*the* Immich (`SLIDESTATION_IMMICH_URL`, required; the server won't start without it): `GET
/api/users/me` with that key gives the user id, and `<home>/users/<id>/` holds that user's
`config.json` (the key, their settings), `user.json` and `library/`. The URL is the server's, never the user's:
whoever answers `/users/me` decides the folder, so a user-chosen "Immich" could claim any id.
Immich's own OAuth isn't usable (Immich is an OAuth client of an identity provider, not a provider);
putting Slide Station behind the same IdP would be the next step if API keys are too clumsy.

- Sessions: a random token in an HttpOnly, SameSite=Lax cookie (Secure over https / behind a proxy
  that says `X-Forwarded-Proto: https`); `<home>/auth.json` keeps only its SHA-256, the user id and
  last use (a month from the last visit). `GET /api/auth` (who, and the server's Immich URL),
  `POST /api/auth/login {"api_key"}`, `POST /api/auth/logout`.
- **Per-user scope is a context variable**, `store.as_home(path)`: `load_config`, `library()` and
  everything built on them (sessions, learning, presets, people, insights, uploads) follow it. The
  `Accounts` middleware in `server.py` (plain ASGI, so the context reaches sync endpoints in the
  thread pool) answers 401 `{"signin": true}` to every `/api/` request but health / auth without a
  valid cookie, and runs the rest inside `as_home`. `start_job` copies the context into the job's
  thread. An account's `load_config` forces `library = <home>/library` and `immich_url` = the
  server's, and `POST /api/config` ignores both. **Tray ids** are checked to be one plain name
  (`store.SID_RE`), so no URL can reach outside the caller's library.
- **Jobs and background work per library**: `workflow` keeps a job and an open tray per home
  (`_jobs`, `_active`); `wf.current_job` / `wf.active_session` are module properties that read and
  write the caller's, so existing code and tests keep working. One job at a time *per user* (two
  users import at once); the background renderer and the insights worker visit every library's open
  tray in turn, and full-resolution work still waits while any job runs (the memory rule, §3).
  Caches keyed by tray id (`_fused_cache`, the 1:1 `_full`) are keyed by the tray's folder now.
- An account never sees the server's drives: `detect_sources` lists only its uploads, importing a
  path answers 403, eject 403, "show in Finder" doesn't open anything, and tethered capture is off
  (the camera would be everyone's). `SLIDESTATION_MODELS` puts downloaded models (CLIP, SFace) in
  one shared folder instead of each user's library.
- UI: `components/sign-in.tsx` (`AccountGate` around the app in `main.tsx`; a 401 with `signin` from
  any call fires `SIGNED_OUT` and the gate shows the sign-in screen again; the app remounts per user).
  Settings shows who is signed in with "Sign out", the Immich URL read-only and no library folder;
  the empty state and activity well offer "Choose a folder of scans" instead of waiting for a
  scanner. The browser version never asks `/api/auth`.

What's left for a real multi-user service: a job *queue* (a second job of the same user is refused
with 409 as before; a restart reports and resumes the job it cut off, below, but doesn't queue),
memory limits beyond the render semaphore, and removing a user's data when they leave Immich.
Sign-in rate limits, revoked keys, quotas, jobs across restarts and the render limit are in
"Limits" below.

Tests: `tests/test_hosted.py` (TestClient): health, the host default, upload + import as a folder
(grouping, never removable, staging removed), resume at an offset / 409 / damaged 422 / skip what
the library has, path escapes and limits, sign-in (bad key, cookie flags, only hashes on disk,
forged cookie), an account can't move its library or Immich, **two users**: separate sources,
trays, uploads, jobs at the same time, and every route into Ann's tray by id — payload, peek,
previews, histogram, 1:1, thumbs, edits, upload, "develop like", presets from her slide, path tricks
— answers Bob 404; imports of server paths 403. `tests/hosted_flow.py` (Playwright, against a
running server in accounts mode, docstring) signs in in the real UI, uploads a folder through the
folder picker, creates the tray, checks Settings, signs out, a wrong key, a second user who sees
nothing of the first. Verified bound to `0.0.0.0` and reached over the machine's LAN address, and in
the built image (`docker build`, healthcheck healthy, the same two-user flow over HTTP).

### Limits: sign-in, revoked keys, quotas, restarts, full-resolution renders

- **Sign-in rate limit** (`accounts.check_rate` / `failed` / `succeeded`, in memory). Every key
  Immich rejects (401, `immich.Rejected`) counts against two buckets: the client address and the
  key's first 8 characters (only a hash of them is kept). `SIGNIN_FREE` (3,
  `SLIDESTATION_SIGNIN_FREE`) failures are free, then each try waits `2^(n-2)` s after the last
  failure, up to 15 minutes; an hour without failures forgets the bucket. While a bucket waits,
  `POST /api/auth/login` answers **429** with `Retry-After` and `retry_after` and never asks Immich,
  even for a good key from that address. A good key clears its own prefix's bucket, not the
  address's (it could be guessing others' keys between its own sign-ins). The address is the peer;
  behind a reverse proxy set `SLIDESTATION_TRUST_PROXY=1` and the last `X-Forwarded-For` entry (the
  one the proxy appended) counts instead. The sign-in screen shows the server's message.
- **Revoked keys end the session.** Each token record in `auth.json` has `checked`; `resolve`
  (every request, in the middleware) asks `GET /users/me` with the user's stored key once
  `KEY_RECHECK` (10 min, `SLIDESTATION_KEY_RECHECK_MINUTES`) has passed, claiming the check first
  so concurrent requests don't all ask. Rejected (401) or a key of another user → `end_sessions`:
  every record of that user gets `ended` (the reason), the key is removed from their config, the
  request answers 401 `signin` and `GET /api/auth` returns `ended`, which the sign-in screen shows.
  Immich unreachable, 5xx or 403 is not a revocation: the session stays and it is asked again a
  minute later (`KEY_RETRY`). `POST /api/config` in accounts mode only takes a key whose `/users/me`
  is the same user (400 otherwise), so Settings can't switch an account to someone else's Immich.
- **Quotas** (`uploads.check_room`, `SLIDESTATION_QUOTA_LIBRARY_GB` / `_UPLOADS_GB`, 0 = none, per
  library, so per account). The library counts everything under it except `models/` and `data/`
  (the server's downloads); uploads count `<library>/uploads`. Sizes are walked at most once a
  minute per folder (`_size`, ~10 files a slide) and bytes written since are added (`_grew`);
  deleting an upload forgets the cache. `check` refuses a folder whose remaining bytes don't fit
  before anything is sent, and every chunk is checked again (a client that sends anyway): **413**
  with `quota: "library" | "uploads"` and a message that says what to do. The UI shows it as the
  upload's error without "drop the folder again" (`lib/upload.ts` `isQuota`; `api()` now throws an
  `ApiError` with the status and body). `/api/state` has `quota: {library?, uploads?: {used,
  limit}}` when set, shown in Settings. Imports from the staging folder aren't checked (their bytes
  are already counted, and the staging copy goes when the import ends); exports aren't either (an
  upload to Immich must never fail for room: exports are deleted after upload by default).
- **Jobs across restarts** (`workflow._record` / `_unrecord` / `_interrupted`). `start_job` writes
  `<home>/job.json` (`{id, kind, session, started, resume}`, the user's folder or
  `SLIDESTATION_HOME`) and the job removes it when it ends, if the id is still its own. The first
  `job_now()` for a library in a new process finds a leftover file = a job the restart cut off, and
  reports it as a finished job with `interrupted: true` and an error saying to run it again. Imports
  (`resume: {"source"}`) and uploads (`{"only_ready"}`) are `resumable`: `POST /api/job/resume` runs
  them again through the normal endpoints, which is safe because an import skips what the dedupe
  index has (an upload's staging folder stays until its import finishes) and an upload skips slides
  Immich already has. The activity well shows "Import cut off by a server restart" with
  **Resume**; other kinds just say so. Nothing else is queued or retried by itself.
- **Full-resolution renders**: `_export_lock` is a `BoundedSemaphore(SLIDESTATION_FULL_RENDERS)`
  (default 1) shared by exports and 1:1 zoom across every account. The zoom cache (`_full`, one
  slide) and its lock stay server-wide, so zooms still take turns; the background renderer still
  waits while any job runs.

Tests: `tests/test_accounts_limits.py` — per-address backoff (429, Retry-After doubling to the cap,
Immich not asked while waiting, another address unaffected, forgotten after an hour), per-prefix
limit across addresses and its reset by the key's owner, `X-Forwarded-For` only when trusted; a key
revoked in the mock Immich (`DELETE /debug/keys/{key}`) ends both of Ann's sessions after the
interval but not before, forgets the key, Bob stays, a new key works; Immich down keeps the session;
Settings refuses Bob's key for Ann; upload and library quotas (announced and per chunk, per account,
models not counted, room again after deleting); an import and an upload interrupted by a simulated
restart are reported and resumed (no slide sent twice), other kinds not resumable; two users'
exports take turns with the default semaphore and overlap with 2. Checked in the real UI too (vite
against a server in accounts mode): the 429 message, the quota toast and Settings line, the
sign-in screen after revoking the key, and Resume after a restart with a job left behind.

### Watched folders: an "external library" in a share (ROADMAP §4, `watch.py`)

Every sub-folder that appears in a watched folder becomes a tray of its own. Desktop app and server
alike (the same Python); not in the browser version (below).

- **Where folders may be.** Config `watch: [{"id", "path", "auto_upload", "require_done",
  "settle"?}]` per user (config.json, so per account). `check_path` resolves the path (symlinks and
  `..` included) and refuses the library itself (or a folder containing it). With
  `SLIDESTATION_WATCH_ROOT` set, only folders under that root (a relative path is taken relative
  to it; `{user}` in the root becomes the account's Immich user id, so each person can have their
  own); in accounts mode without a root the feature is off (`server.watch: false`, adding one 403):
  an account never names a path of the server's. The root is checked again at every poll, and a
  scan that is a symlink out of it makes that sub-folder an error instead of an import (it could
  point at another user's share). Without a root (desktop), any folder.
- **Polling, no new dependency.** `watch.start()` (from `server.main`, so also before anyone signs
  in) runs `tick()` every `SLIDESTATION_WATCH_INTERVAL` s (10): for each library with watched folders
  (the single user, or every `users/*/config.json` that has some) it lists the sub-folders (not
  hidden, not `@eaDir` / `#recycle`) and fingerprints each one's scans (`list_scans`: relative path,
  size, mtime → SHA-1). inotify would miss changes made on an SMB / NFS server, so this is a poll
  on purpose. **Debounce:** a sub-folder is ready when its fingerprint hasn't changed for `settle`
  seconds (`SLIDESTATION_WATCH_SETTLE`, 30; per folder via the API) and has at least one scan, and,
  with `require_done`, once a `.done` file is in it. A handled sub-folder is only re-fingerprinted
  every `RECHECK` (5 min).
- **Import.** A ready sub-folder starts the user's one job, kind `watch` (`start_job`; while any
  job of theirs runs it just stays "queued" and the next poll tries again: one import per poll, in
  name order). `import_watched` creates the tray (name = album = folder name, date from
  `date_from_name`: `1978-08 Lake Garda` → `1978-08`, `1978 Summer` → `1978`, `1978-08-14 …`; a
  year 1800–2099 at the start, then a month that exists), then runs `import_scans(label="watch:<name>")`
  — the normal folder import, so never removable, verified copies, grouping and dedupe as always.
  With `auto_upload` it runs `finish_session` (everything, not just developed slides: nobody has
  looked at them) in the same job.
- **Handled = recorded in the library**, `watched.json` `{<sub-folder path>: {"state", "tray", "fp",
  "slides", "scans", "folder", "name", "error"?, "upload_error"?, "note"?, "at"}}`, never a file in
  the share (which may be read-only; nothing there is written, moved or deleted — the tests compare
  the share's bytes and mtimes before and after). Keyed by path, so removing and re-adding a watched
  folder doesn't import it again.
- **Crash-safe marking.** The record says `importing` with its tray before the first copy and
  `imported` only when the import (and the upload) finished. A restart in between leaves
  `importing`: the sub-folder counts as not handled, settles again and is imported into the *same*
  tray, where the dedupe index skips every scan already copied (a leftover job.json of kind `watch`
  is reported as interrupted, not resumable by hand: the watcher resumes it). If the record is lost
  altogether the import finds nothing new and the tray it just created is removed again (`note:
  already in the library`). A handled sub-folder whose fingerprint changes (scans added later) is
  imported again into its tray; a failed one stays `error` until its scans change or **Retry**
  (`POST /api/watch/{id}/retry`). Same caveat as any import: a crash between copying and grouping
  leaves those scans in the tray without slides (`import_scans`' order, not this module's).
- **API.** `GET /api/watch` → `{available, root, settle, interval, folders: [{…, error, subfolders:
  [{name, state: waiting|importing|imported|error, tray?, slides?, scans?, note?, error?}]}]}`
  (states from `watched.json` and the in-memory fingerprints); `POST /api/watch {path, auto_upload?,
  require_done?, settle?}` (polls that user's folders once at once), `PATCH` / `DELETE
  /api/watch/{id}`, `POST …/retry {name}`. `/api/state` has `server.watch` and `watch`: counts from
  the last poll (`folders, waiting, queued, importing, imported, errors`), no disk access, since it
  is asked every second.
- **UI.** `components/watch.tsx` in Settings (under the library; changes apply at once, not on
  Save): the folders with "Only once a .done file is in it" and "Upload to Immich once imported",
  each sub-folder's state, Stop watching, Retry; in the desktop app a native Choose… picker. The
  activity well shows "Watched folders · N waiting · N queued · N errors" with **Show** (opens
  Settings) while nothing else is going on; a running watched import shows as any job.
- **Browser version: hidden.** `server` is absent from its `/api/state`, and Settings leaves the
  section out when `standalone`. A persisted `FileSystemDirectoryHandle` could be polled while the
  tab is open (Chrome), but it only works with that tab open and a permission re-granted after each
  reload, which is what the folder picker already does by hand: not worth a second path.

Tests: `tests/test_watch.py` (a hand-driven clock; the thread stays off): a sub-folder settles and
becomes a named, dated, never-removable tray while the share stays byte-for-byte the same; polled
again, forgotten in memory, or the folder removed and re-added: no second tray; changes restart the
clock and `.done` is waited for; empty folders wait; queued behind the user's job, one per poll; an
interrupted import resumes into its tray without duplicates, later scans join it, a lost record
leaves no empty tray; a failed import shows and retries; auto upload into the mock Immich; path
checks (missing, relative, the library, outside the root, `..`, a symlink out); accounts without a
root get 403; two accounts under `share/{user}` each watch only their own folder, both imported by
one poll with nobody signed in, each into their own library, a symlink to the other's scan refused.
`tests/watch_flow.py` (Playwright, docstring): add a folder in Settings, drop a sub-folder, the
well's "1 waiting", `.done`, the tray named and dated after it, the share unchanged, Stop watching.

## 4f. Camera rig mode: RAW files, tethered capture (ROADMAP §5)

A camera over a light panel is just another source of scans; everything after import is the same.

**RAW** (`raw.py`, optional `rawpy`: `uv run --extra raw`; in the Dockerfile; in the dev group for
the tests). DNG, CR2, CR3, NEF, ARW, ORF and RAF import as scans when rawpy is installed
(`workflow.scan_exts()`; otherwise they're simply not listed, and the upload filter leaves them out).

- Decode: LibRaw `postprocess` with the camera's as-shot white balance, no auto brightening, sRGB
  primaries and the sRGB curve (`gamma=(2.4, 12.92)`), 16 bits → float32 0..1. The pipeline expects
  display-referred values like a decoded JPEG, so a RAW enters exactly where a JPEG scan does; the
  Adjust panel, learning and fusion work unchanged. `imaging.load_rgb` dispatches on the extension
  (proxies: LibRaw's half-size decode, no demosaicing, then INTER_AREA to 1600 px, cached as JPEG like
  every proxy); `imaging.load_full` gives full-resolution float32 for a RAW (no 8-bit step) and uint8
  for a JPEG. A single RAW develops in float from its 16 bits; a bracket of RAWs is fused like JPEGs
  (Mertens takes 8-bit exposures). The camera's orientation flag is applied by LibRaw (unlike JPEG
  scans, whose EXIF orientation Python ignores; the scanner doesn't set it).
- Metadata (`raw.metadata`): make, model, capture time, exposure, f-number, ISO, focal length from
  the TIFF header (DNG, CR2, NEF, ARW, ORF: IFD0 and the EXIF IFD, a ~40-line parser), else from the
  EXIF of the embedded JPEG preview (CR3, RAF). It orders the import (`taken`), is stored on the scan
  (`scans[id]["camera"]`), and the export's EXIF carries make / model / exposure / ISO
  (`raw.exif_for_export`) where a scan's EXIF would be copied.
- Originals keep their extension (`<scan>.dng`). A camera shooting RAW + JPEG writes pairs: the JPEG
  with the same name next to a RAW is left out (`list_scans`).
- Not in the browser version (no LibRaw in the page: RAW files aren't listed there) nor SlideKit.

**Tethered capture** (`tether.py`, the `gphoto2` command line; `SLIDESTATION_GPHOTO2` overrides the
binary). **Untested with a real camera**: the tests use a stand-in script that prints gphoto2's
`--auto-detect` table and writes files like `--capture-image-and-download --filename` does.

- `GET /api/state` has `camera: {"cameras": [{"model", "port"}]}` when gphoto2 is installed (null
  otherwise, and on a hosted server); `--auto-detect` runs at most every 5 s, never during a capture.
- `POST /api/sessions/{sid}/capture {"port"?}` starts a `capture` job: gphoto2 captures and
  downloads into `<library>/captures/<time-id>/` (a fresh folder per shot, so nothing is hashed
  twice), `import_scans(label="camera")` imports it into the tray, the folder is removed. Grouping is
  the import's: a darker shot of the same slide right after continues the last slide (a bracket),
  a new slide starts a new one — exactly like scans arriving from the card in two batches.
- UI: when a camera is connected and a tray is open, the activity well shows the camera and
  **Capture**; **P** captures (help dialog, ⌘K "Capture with …").
- Not done: auto-advance of a projector / carousel, live view, setting exposure from the app (do it
  on the camera), and camera-specific colour profiles (LibRaw's matrices are used).

Tests: `tests/test_camera.py` — a synthetic DNG (`synthetic.save_dng`: an RGGB mosaic whose camera
space is linear sRGB, so a neutral decode returns the scene within ~1 %) decodes to float with far
more than 256 levels, metadata and export EXIF, a folder of RAW brackets + a JPEG twin + a JPEG
imports as 2 + 1 + 1 slides with previews, 1:1 and exports; without rawpy RAW is hidden; the gphoto2
parser; three captures group as a bracket + a slide; a failing capture reports gphoto2's message.
Checked in the browser too: Capture and P into a new tray (a bracket of two DNGs → "HDR ×2").

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

`state` is `suggested`, `accepted` (the value became the slide's own tag / caption / date / place,
§5f; a film stock, §5d) or `dismissed`. A stale `key` (other scans, a rotation) means "analyse
again": `insights.merge` keeps every accepted / dismissed entry, so a dismissed suggestion never
comes back for that slide, and a fresh suggestion of a tag the slide already has counts as accepted. Removing a tag in the Details section dismisses its suggestion.

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

**Ported to the browser version** (§4c "Suggestion models in the browser"): the same model, keys,
`insights.json` and `session.json` entries, so a tray analysed in one app isn't analysed again in the
other. The Swift app (§4b) is not ported: its `Slide` Codable only encodes the keys it knows, so a tray saved there loses `tags` /
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

## 5b. Captions: a local vision-language model (`captions.py`, ROADMAP §1 "Descriptions")

A one-sentence caption per slide ("A rocket is on a launch pad at night."), made on this computer
and offered through the insights plumbing (§5a) as the `caption` suggestion: editable, accepted into
the slide's own `caption`, which already goes to Immich as the description (EXIF ImageDescription
in the export, `PUT /assets/{id}` when only the metadata changed, §6a). Opt-in on its own: config
`captions_enabled` (Settings → "Suggest captions (downloads a ~276 MB model)"), off by default,
independent of the tag setting. Desktop / server app only.

**Model.** Microsoft's Florence-2 base, fine-tuned (MIT), as exported to ONNX by onnx-community
(`onnx-community/Florence-2-base-ft` at a pinned revision), the 8-bit quantized variants of its
four parts: `vision_encoder` (94 MB, DaViT), `embed_tokens` (39 MB), `encoder_model` (44 MB) and
`decoder_model_merged` (98 MB, BART with a key / value cache), plus `vocab.json` (1 MB). Downloaded
like the tag model with `insights.fetch_files` (now shared: resumable `.part` + Range, sha256 / git
blob sha1, atomic) into `<library>/models/florence-2-base/`; `POST /api/insights/model` takes
`{"models": ["tags", "captions"]}` (default: the ones turned on) and fetches them in one `model` job.

**Pipeline** (`Florence.generate`, no transformers / torch at runtime):
1. The slide's blended proxy turned upright (the same array the tags get) → 768 × 768 bicubic,
   squashed not cropped, ImageNet mean / std (Florence's `CLIPImageProcessor` settings; checked
   bit-identical to transformers' pixels).
2. Vision encoder → 577 image tokens; the `<CAPTION>` prompt "What does the image describe?" is a
   fixed id list (`PROMPT`, `<s>…</s>`), embedded and appended; encoder over the 585 tokens.
3. Decoder, greedy: starts from `</s>`, `<s>` forced first (the model's `forced_bos_token_id`),
   then argmax with transformers' `no_repeat_ngram_size=3` rule, until `</s>` or 40 tokens. The
   first step runs `use_cache_branch=false` with empty past tensors; after that the self-attention
   cache is fed back and the cross-attention cache from step 1 is kept.
4. `Vocab.decode`: BART's byte-level BPE backwards (vocab table + the GPT-2 byte map shared with
   CLIP's tokenizer in `insights.py`); `<s>`, `</s>`, `<pad>`, `<unk>` and Florence's task /
   location tokens (ids past the vocabulary) are skipped. `tidy`: whitespace collapsed, capital
   first letter, a full stop, ≤ 200 characters. English only: that's what the model writes.
5. Confidence = the geometric mean of the chosen tokens' probabilities (≈ 0.4–0.7 in practice).

**Trap: the ONNX export's baked scale.** The export traced DaViT on a 224 × 224 image, which froze
each channel-attention block's `N ** -0.5` (N = tokens: 56², 28², 14², 7²) as constants. At 768 × 768
the features then correlate only 0.91 with PyTorch's and the captions change. `Florence.__init__`
overrides those 12 initializers (`/blocks.{s}/blocks.{s}.{j}/channel_block/channel_attn/fn/Constant_6_output_0`
→ 1/192, 1/96, 1/48, 1/24) with `SessionOptions.add_initializer`. With that fix the fp32 ONNX parts
give **token-identical** output to transformers (both the native `Florence2ForConditionalGeneration`
and Microsoft's original remote code, greedy) on 8 test images (scikit-image's public-domain /
CC0 samples + the synthetic beach and snow scenes; references made with `uv run --with transformers
--with torch` in scratch, never a dependency). The 8-bit parts the app downloads give different but
equally good words ("A cup of coffee on a saucer with a spoon." for "A cup of coffee and a spoon
on a saucer."); fp32 would be 1.1 GB on disk and ~2 GB RSS for that.

**Cost** (4-core container, 2 threads, other jobs running): ~3–4 s per slide unloaded, of which
~2.8 s is the vision encoder and ~0.2 s the encoder, ~12 ms per decoder token; 8–15 s when the
machine is busy. The loaded model adds ~0.5 GB RSS (peak ~0.9 GB while a slide runs); the CPU
memory arena is off so the image-sized buffers go back after each slide, and `captions.release()`
drops the model when captions are turned off.

**Where it runs.** In the insights worker (§5a), one slide at a time, only while no job runs.
`insights.active_models()` = the models turned on *and* downloaded; it is part of every slide's
insights key, so turning captions on (or the download finishing) re-analyses the trays (the tags
of a tray that only had tags keep their old key: same hash as before). The key also includes
whether the slide has a caption of its own when captions are active. `analyse` runs each active
model on the same upright proxy; a kind no model computed is left out and `merge` keeps what was
there (turning captions off doesn't drop caption suggestions; turning tags off doesn't drop tags).
The commit still goes through `update_session` and only if the key still matches: a slide turned,
re-stacked or captioned while the model ran is not saved, it is picked up again next step.

**Never over the user's caption.**
- A slide with a caption (typed, propagated or pulled from Immich) isn't captioned at all.
- Typing a caption (`PATCH …/groups/{gid}`, `server._set_caption`) removes an open caption
  suggestion and, when the suggestions were up to date, refreshes the key so the slide isn't sent
  back to the models for nothing; clearing the caption makes it stale, so a suggestion comes.
- Accepting a caption suggestion on a slide that has a caption does nothing (`decided` 0), also in
  the review's "Accept all"; the UI hides a caption suggestion on a captioned slide.
- `merge`: a decided (accepted / dismissed) caption keeps its state while the model says the same
  words ("Analyse again"); new words (the slide turned) are a new suggestion.

**API.** `POST …/insights/decide {"kind": "caption", "action": "accept", "groups": [gid], "text":
"…"}` — `text` (one slide) is the suggestion as the user edited it; without it the model's words.
`GET /api/insights` has `captions: {enabled, ready, model_mb}`. The tray payload's `insights` is
`{enabled (any model on), ready (one of those downloaded), pending, missing: ["captions"…]}`.

**UI.** The inspector's Insights section shows the caption suggestion in an editable box
(`CaptionSuggestion`): Enter or ✓ accepts the text as it stands (then "Apply to 12–31…" offers it
to the neighbours, like a tag), Escape restores the model's words, × dismisses. The review dialog
puts all caption suggestions in one "Captions" pile, a row per slide with its words; Accept all /
Dismiss all act on every open caption. Settings has the checkbox with the size; saving downloads
what's turned on and missing. The Settings dialog now scrolls (it had outgrown a 900 px window).

**Not done / not ported.** The browser version keeps it hidden (settings, `/api/insights/model`
answers 400 for it): 276 MB per browser, and ~3 s of vision encoder per slide on 2 native threads
would be well over 10 s in single-threaded WebAssembly, before a decoder step per word (§4c). The Swift app: not ported
(Apple's route would be a Vision / Core ML captioner; its `Slide` Codable drops `insights`). "Era
cues" for date estimation are not extracted: Florence's captions rarely say anything datable
("an old photo of…" at best), so it was skipped.

**Tests** (`tests/test_captions.py`): the model faked: suggested never applied, edited accept →
Immich description, never over a typed caption (not captioned, suggestion removed, accept refused,
accept-all skips, clearing asks again), dismissed stays / new words are new, a slide turned while
captioning isn't saved, tags + captions together (turning captions on keeps tag decisions), missing
model reported, settings; the decoding: `tidy`, the no-repeat rule, byte-level decoding, the greedy
loop against scripted ONNX sessions (prompt, forced `<s>`, cache growth, no-repeat, stop), the
preprocessing, and the download endpoint. `SS_REAL_CAPTIONS=1` adds a smoke test that downloads
the real model into the scratch library and captions the synthetic beach and snow scenes (verified:
"A blue and yellow background with a blue sky.", "A white mountain with trees on it and a blue sky.").

## 5c. People: faces → names (`people.py`)

Opt-in (`people_enabled`, Settings → "Recognise people"), desktop / server app only.

- **Faces per slide.** `imaging.detect_faces` runs YuNet exactly like `face_votes` (800 px frame)
  on the slide's blended proxy turned upright, scaled back to the proxy's pixels. Faces scoring
  ≥ 0.7 and at least 3 % of the width get an SFace feature (`cv2.FaceRecognizerSF`: `alignCrop` on
  YuNet's five landmarks, 128-d, stored unit length as base64 float16) — `people.embed_faces`, the
  one function tests replace. The model (`face_recognition_sface_2021dec.onnx`, Apache 2.0, 39 MB)
  is downloaded on first use from OpenCV's Hugging Face mirror into `<library>/models/`, checked
  against its SHA-256, never committed.
- **Where they live:** `sessions/<id>/faces.json` = `{gid: {"key", "rot", "faces": [{"id", "box",
  "score", "emb"}]}}`, next to `session.json` but never in it, so finding faces never writes a
  session (§3). `people.update_faces` is the reload-apply-save for it. `key` = `face_key(g)` (active
  scans + rotation): a slide turned or re-stacked is stale and is looked at again. Face ids are
  `sid/gid/n`; a face found again (cosine ≥ 0.8, e.g. after turning) keeps its id, so names and
  removals stay with it. Faces of slides that no longer exist (merged) are dropped by
  `workflow.faces_pending`.
- **When:** during import, right after each slide is committed (if the model is there); the
  background helper catches up on the open tray when it has nothing to render (turned slides, trays
  from before); "Find faces" (`POST /api/people/scan`, job `faces`) downloads the model if needed
  and does every tray. Turning the feature on in Settings starts that job.
- **Clustering** (`people.agglomerate`, `people.refresh` on every `GET /api/people`): average
  linkage on cosine similarity with SFace's recommended threshold 0.363 (for unit vectors the average
  pairwise similarity of two groups is `sum_a · sum_b / (n_a n_b)`, so groups are just running
  sums). Existing people keep their faces and never merge with each other automatically (that's the
  user's call); new faces join them or form new people. `people.json` = `{"people": {pid: {"name",
  "faces", "birthday"?, "immich"?}}, "rejected": {face: [pids]}, "next"}`; `immich` = `{"id", "name"}`,
  the Immich person last synced with and the name both had then (a merge keeps it). Unnamed people left without faces disappear; named
  ones stay.
- **Editing** (People dialog, `components/people.tsx`): `PATCH /api/people/{pid}` names (a name
  another person already has merges the two), `POST …/{pid}/merge {"people": [...]}`,
  `POST …/{pid}/remove {"faces": [...]}` takes faces out and remembers they're not that person (the
  clustering never puts them back there; they join someone else or stand alone).
  `GET /api/people/faces/{sid}/{gid}/{n}.jpg?v=<key>` cuts the face from the proxy.
- **Who is who on the slide** (inspector section "People", `components/slide-people.tsx`): every face
  on the slide (payload `faces`, `dating.slide_faces`: id, url, box, person, label, age, `odd`), left
  to right; hovering or picking one outlines it on the photo (`FaceOnPhoto`: the box through
  `PictureView`, ignoring the trim — near enough to point). A picked face gets "Not <name>", a search
  of everyone named or with a birthday (`GET /api/people/names`) and "Someone new: “…”".
  `POST /api/people/faces/assign {"face", "person": pid | "new" | null, "name"}` (`people.assign`)
  answers the tray's payload: the face leaves whoever it was with (remembered in `rejected`), joins
  its person and is `sure` there (`people[pid].sure`: the age check never doubts it); "new" with a
  name someone has is them. Only while people are on (`people_enabled`); not ported to the browser
  version (its payload has no `faces`).
- **Immich** (`immich_people.py`, "Sync with Immich" = `POST /api/people/sync`, job `people`): Immich
  finds and groups faces on the uploaded slides itself; the sync lines the two up rather than
  replacing either. Our boxes are on the turned scan, the upload is the developed slide, so
  `imaging.developed_boxes` takes them through develop()'s trim, straighten (`straightened_point`,
  shared with `mount_crop`) and crop; `match` pairs them with Immich's faces (`GET /faces?id=`,
  pixels of `imageWidth` × `imageHeight`) by overlap, IoU ≥ 0.3, detected faces before manual ones.
  On a real library 292 of 313 faces paired at IoU ≥ 0.5 (median 0.86); the rest Immich hadn't found.
  Then, in order: names come back (a name changed in Immich since the last sync; an unnamed person
  whose named Immich faces are ≥ 2 and ≥ ⅔ one name — `rename`, so they join our person of that
  name); each named person gets an Immich person (the linked one, renamed if we renamed; else the one
  of the same name, case aside; else an unnamed one holding only their slide faces; else
  `POST /people`); other unnamed Immich people holding only their faces (≥ 2) are merged in whole
  (`POST /people/merge`, v3.2.1+, else `POST /people/{id}/merge`), which brings their faces on
  non-slide photos along; the remaining paired faces move one by one (`PUT /faces/{person}` with
  `{"id": face}`); faces Immich didn't find are created (`POST /faces`, v1.127+, `sourceType`
  "manual", which Immich's re-detection keeps) unless the asset has no faces and was uploaded in
  the last hour (its face detection may be pending; job queues need an admin key); a manual face
  lying on a detected one is deleted. Birthdays fill the empty side (a year or year-month here agrees
  with any date in it). A name or birthday that differs on both sides, a face on a differently named
  Immich person, or a person whose faces Immich mostly has under another name: left alone, listed in
  the job message. Last, the `People/<name>` tags earlier versions sent come off our slides (and
  empty ones are deleted). Uploading no longer sends names: Immich hasn't looked at a fresh upload.
- **Browser version:** ported (§4c "Suggestion models in the browser"): the same faces.json and
  people.json. **Not ported:** the native app (Apple's Vision framework is the route there).
- **Tests:** `tests/test_people.py` — clustering on synthetic vectors (identities, the threshold,
  fixed people, rejected faces) and the API with `embed_faces` replaced (faces per slide, ids kept
  after turning, merged slides forgotten, naming / merging / removing, the scan job, the model checksum) and
  `test_sync_with_immich` against tests/fake_immich.py's people and faces (linking by name, merging
  an unnamed group, a name coming back, a face added by hand and its double removed later, renames
  either way, a rename on both sides left alone, the old tags removed). The real model was run once on 48 LFW photos of
  six people (Hugging Face, scratch only) imported as a tray: 52 faces, one clean cluster of 6–8
  faces per person, 6 faces on their own (mostly people in the background) and one two-face cluster
  mixing two of those.

## 5d. Film stock (ROADMAP §1 "Film-stock profiles", "Date estimation")

`filmstock.py`, mirrored function by function in `standalone/filmstock.ts` (no model, so the
browser version has all of it). Three parts: a stock per slide with a guess, per-stock learning,
and the stock's era as a dating hint.

**Data.** `g["stock"]` (the slide's own) and `d["stock"]` (the tray's), each one of `kodachrome`,
`ektachrome`, `agfachrome`, `fujichrome`, `other`, `unknown`; missing / `""` = not set.
`filmstock.effective(d, g)` = own, else the tray's; `unknown` on a slide means "can't tell" and does
*not* take the tray's. `PATCH …/groups/{gid} {"stock"}` and `PATCH /api/sessions/{sid} {"stock"}`
(400 on anything else; `""` clears), split copies it to both halves. Payload: per slide `stock`,
top level `stock`. Neither is in any key: setting a stock never makes a slide `changed`.

**Labels** (`stocks.json` in the library, `{"version": 1, "examples": [{"key": "tray:slide", "f":
[14 features], "s": stock, "t"}]}`): every slide whose effective stock is one of the five classes
and that has `feat` (set at import, like learning). `filmstock.label` keeps a slide's entry in
step whenever its stock, its tray's stock, or its skip flag changes (and after accept / propagate);
`remember` doesn't rewrite the file when nothing changed.

**The guess** (`stock_suggestions(d)`, a tray at a time):

- *Heuristic* (`heuristic(f)`, source `fade-heuristic`) on the learning features of the blended,
  undeveloped scan. The cast against green is measured three ways and averaged: the median
  log-ratio (`f[11]`, `f[12]`), 3 × the difference of the channels' 1st percentiles and the
  difference of their 99th (a scene's own colour sits mostly in the midtones; a lost dye shows at
  the black and white points too). Scores, each a product of logistic ramps: *Ektachrome* = red
  over green and blue not below green (magenta), stronger with lifted blacks (min 1st percentile);
  *Agfachrome* = red below green, blue not below green (cyan / blue-green); *Kodachrome* = little
  cast, 5–95 % luminance range ≥ ~0.45, dense blacks (< 0.04). Fujichrome has no rule. The basis is
  the usual fading of these dyes (Ektachrome's cyan dye fades first → red / magenta; Agfa's magenta
  → cyan; Kodachrome is stable in the dark), **not** a fit to real scans: the thresholds were set
  on synthetic fades (`tests/test_filmstock.py`). Well-kept E-6 Ektachrome or Fujichrome looks like
  Kodachrome to it. Probabilities = score / (Σ scores + 0.3 "no signature"), × 0.75
  (`HEURISTIC_TRUST`: it never claims more).
- *k-NN* (`Labels.predict`, source `knn:<n>`) once ≥ 5 labels (`MIN_PER_STOCK`) of **two or more**
  stocks exist: features 0–12 (not the stack depth) standardised over those labels, k = 7,
  weights 1/(d + 0.25), cutoff 3.0 (RMS in standardised space), like `learning.py`; shares ×
  n/(n + 1). Only stocks with enough labels are known to it; `_guess` gives the heuristic's share
  for every *other* stock to the heuristic and scales the k-NN's shares into the rest, so a
  Kodachrome/Agfa-trained k-NN doesn't force a faded Ektachrome into Agfa (the suggestion's source
  is then `fade-heuristic`).
- *Tray*: a slide's probabilities are mixed 50/50 with the tray's mean (labelled slides count as
  one-hot there, skipped ones not at all). The best stock is offered from 0.3 (`SUGGEST_FROM`),
  confidence = its mixed probability (3 decimals). Only for slides with no effective stock (or
  `unknown`), not skipped, with features.

**Suggestions through the insights plumbing.** The guesses are computed live for every payload
(`filmstock.views`: a few hundred numbers, no file) and shown as `insights.stock` / `insights.date`
entries `{value, confidence, source, state: "suggested"}` next to the models' (a slide with such a
guess gets an `insights` object even when the tag model is off; `stale` still says whether CLIP
has looked at it). `insights.KINDS` gained `stock`; `insights.merge` keeps a stored `stock` like
caption / date / place. A decision is stored only when made: `POST …/insights/decide` with kind
`stock` or `date` first writes the shown live entry into `g["insights"][kind]`, then decides as
usual (accept: the slide's `stock` / `date`). A stored accepted / dismissed entry hides the live
guess while that is the same value; a different value is offered again. A *model's* stored open
suggestion (e.g. a future mount-OCR date) wins over the live guess. `POST …/insights/propagate`
takes kind `stock` (value validated, `""` clears) and marks a matching live guess accepted. UI:
**Details → Film stock** (a select whose first option is the tray's stock, the "Looks like
Ektachrome · 58 %" row with ✓ / ×, and a range button that opens the propagate dialog), **Tray →
Film stock**; the Review dialog piles stock and date guesses too ("film: Ektachrome · 36 slides")
and is now in the browser version (without "Analyse again"); the Insights section lists only the
models' suggestions (`openSuggestions(g, true)`).

**Per-stock learning** (`learning.py`, `learning.ts`, `Learning.swift`). Examples get `"s"` (the
effective stock at `_learn` time, only one of the five classes); `_stock_changed` re-learns a
developed slide when its stock changes. `suggest(feats, stock)`: with a known stock and ≥ 5
(`MIN_EXAMPLES`) examples of it, only those take part (the others' distance becomes ∞; the
standardisation stays over all examples); with fewer, examples of *another known* stock weigh
`OTHER_STOCK_WEIGHT` = 0.3 × (examples without a stock count fully). No stock (or `unknown`, or
`learning.json` from before) is exactly the old behaviour. Import (tray stock), resuggest and the
Swift importer / "Use learned" pass the stock. Parity: `golden.json` key `learning_stock` (added at
the end by the last block of `make_golden.py`; no existing byte changed), checked by
`parity.test.ts` and `testLearningPerStockMatchesPython` (uncompiled here).

**Eras and dates.** `ERAS` (35 mm, approximate, wide on purpose): Kodachrome 1936–2010 (made to
2009, processed to the end of 2010; K-II / X from 1961, Kodachrome 25 / 64 from 1974), Ektachrome
1955– (sheet film 1946, E-6 from 1977, gone 2012–2018, so open-ended), Agfachrome / Agfacolor
1936–2005, Fujichrome 1948– (Fuji's first colour reversal film). The sub-eras (K64, E-6) can't be
told apart from colour, so they are documentation only — mount stamps are the route there.
`store.slide_dates` is unchanged except that every slide whose effective stock has an era gets
`era: {"stock", "from", "to" (null = open), "fits"}` (`fits`: the shown value's year inside the
era; null without a value). Keys only use `value`, so no key moved (`store.test.ts` unchanged);
`store.estimate` is the interpolation factored out. `date_suggestions(d, dates)` (source
`neighbours+stock`): for an undated, not skipped slide whose stock has an era — the dated slides
**of the same stock** around it, interpolated like `slide_dates` (between 0.6, near 0.45: a
Kodachrome roll in a tray of Agfa is its own stretch of time), else its ordinary estimate
(between 0.45, near 0.35, tray 0.3); nothing when the value falls outside the era (one of the two is
wrong) or there's no estimate. UI: the Date placeholder adds "· Kodachrome 1936–2010", a line
warns when the date or estimate is outside the era, and the date guess has its own ✓ / × row.

**Tests.** `tests/test_filmstock.py`: the heuristic on synthetic fades (per slide and per tray),
no signature → nothing, stock per slide / tray / unknown / split and the labels, accept / dismiss /
propagate, the k-NN taking over (and not forcing an unknown stock), per-stock learning (restricted,
weighted, old examples unchanged, `s` remembered and re-learned), era hints leaving `slide_dates`
values alone, same-stock date suggestions and the era bound, accepting a date guess.
`frontend/src/standalone/filmstock.test.ts` checks the port against `filmstock.fixture.json`
(written by `tests/make_filmstock_fixture.py`: heuristic, k-NN, tray suggestions, `slide_dates`
with hints, date suggestions). `tests/web_flow.py` accepts the Ektachrome guess in the browser
version and gives it to the whole tray. **Not done:** the Swift app keeps `stock` on slides and
trays and learns per stock, but has no stock UI, guess or era hint; the heuristic's thresholds and
confidences are uncalibrated against real scans (the owner's trays are the first real test).

## 5e. Look-alikes: near-duplicates, grouping safety net, scenes, Immich (`similar.py`)

ROADMAP §1 "Smart grouping 2.0" / "Best-of-burst" and §2's CLIP-match against Immich. Built on the
scene-tag model (§5a Insights): on with `insights_enabled` and the CLIP download, nothing extra to
turn on except the Immich check. Everything is a suggestion, decided through the insights plumbing.

**Embeddings** live in `sessions/<id>/embeddings.json` (derived data next to `session.json`, never
in it, like `faces.json`; `similar.update` is its reload-apply-save):

```
{"slides": {gid: {"key", "emb", "q": {"sharp", "clipped"}}},   the upright blend, and its quality
 "scans":  {scan: {"emb", "lum"}}}                              each scan unturned, exposure-normalised
```

`emb` is a unit 512-d vector as base64 float16 (~1 KB). A slide's `key` (`slide_key`: active scans +
rotation + model) goes stale when it is turned or re-stacked; scans never change. The slide embedding
is **the same CLIP call as the tags**: `insights._analyse` embeds the upright blend once, tags from it
and `similar.record_slide` keeps it with `imaging.scan_quality` of the blend. Scan embeddings are for
the grouping checks: each scan's proxy with its exposure taken out (`normalise`: luminance 1st–99th
percentile to 0.02–0.98) so a bracket's dark and bright scans agree, plus its mean brightness `lum`.
The background helper (`insights.step`) does the tags first, then `similar.step` catches up one
slide (trays from before, turned slides) or one scan at a time; a failure is stored with `error` and
not retried. `payload.insights.pending` counts both, so the UI keeps polling until they're done.

**Suggestions** (`similar.suggest`, computed per payload from the embeddings, cached by the two
files' mtimes; payload `similar: {duplicates, split, merge, scenes}`, `null` while insights are off
or the model is missing). Each is `{kind, id, groups, confidence, source, state: "suggested"}`:

- *duplicates* (the same shot taken twice): non-skipped slides at most `WINDOW` (3) places apart
  whose blend embeddings are ≥ `DUPLICATE` (0.93) alike, joined into clusters (connected pairs).
  `best` = the highest `sharp × (1 − clipped)` of the blend (`imaging.scan_quality`, the same measure
  as best-of-bracket), `scores` per slide. Accept (`keep` = any member, default `best`) skips the
  others (`_learn` forgets them; X brings one back). With the eye model on, `best` also weighs how
  open the eyes are ("Eyes open" below).
- *split* (the signature merged two slides): in a stack, a scan whose best similarity to the scans
  before it is < `SPLIT` (0.80) → split before it (`server._split`, the ✂ endpoint's code).
- *merge* (the signature split one slide): neighbours whose touching scans (last of one, first of
  the next) are ≥ `MERGE` (0.85) alike exposure-normalised, ≥ `MERGE_STOPS` (0.3) stops apart in
  brightness, and structurally close (`imaging.similarity` of the signatures ≥ `MERGE_STRUCT` 0.6,
  below `SAME_SLIDE` 0.86 or they'd be merged already) → `server._merge_next`. Same exposure = the
  same shot twice, which is a duplicates question; a merge pair is never also offered as duplicates.
- Decisions: `POST …/insights/decide {"kind": "duplicates"|"split"|"merge", "action", "value": id,
  "keep"?}`; a stale id answers 404. Dismissed duplicates are kept as pairs
  (`d["similar"]["apart"]`, so a cluster that later gains a slide only brings that slide back),
  split / merge by id (`d["similar"]["dismissed"]`). Accept / dismiss counts go to `insights.json`
  under the kind; the duplicate threshold rises with dismissals like a tag's (`similar.threshold`:
  up to `DUPLICATE_MAX` 0.97).
- *scenes* (`similar.scenes`): walking the non-skipped embedded slides in tray order, a slide starts
  a new scene when its similarity to the mean of the current scene's last `SCENE_SPAN` (4) slides is
  < `SCENE` (0.80) and so is the next slide's (one odd slide doesn't cut a scene). Skipped and
  not-yet-embedded slides stay with the scene before them. `label` = the tag (own or suggested) more
  than half the scene's slides have. `[]` when the tray is one scene.

**Thresholds**, measured with the real model on synthetic pictures (8 scene kinds × 4, scratch
script; `test_real_clip_similarities` pins the clear cases): a bracket's scans exposure-normalised
0.85–1.0 (median 0.996 at −0.9 stops, 0.967 when over-exposed 1.8× and clipped); the same scene
re-shot (moved, zoomed, turned ≤ 2°) 0.90–0.99; different kinds of scene 0.70–0.90 (normalised
0.70–0.87); signatures of a clipped bracket 0.82–1.0, of different scenes median 0.12. Synthetic
pictures are simpler than photos (two different cartoon beaches score 0.98), so `DUPLICATE` sits where
CLIP near-duplicate work puts real photo bursts rather than at a synthetic gap, and learns from
dismissals. Smoke run of the whole thing (real model, synthetic trays imported through
`import_scans`): a beach and its re-shot two slides later → duplicates (0.96–0.975), a city scan and
the same scan 1.9× over-exposed that the signature split (0.77) → merge (0.88, 0.55 stops), three
runs of beach / snow / city → three scenes labelled beach / mountains / city; no false merges. A
stack of two different slides that CLIP flags wasn't reproducible synthetically (two synthetic
forests merged by the signature also look alike to CLIP, 0.96): split is tested with planted vectors.
**Not tuned on real trays** — the constants are at the top of `similar.py`.

**Look-alikes in Immich** (config `lookalike_enabled`, Settings, off by default; needs the model).
After an upload (`finish_session` → `_lookalikes_quietly`, best effort: a failure is a note in the
job message) and on demand (`POST /api/sessions/{sid}/lookalikes {"all"?}`, job `lookalike`: the
slides not checked yet or `pending`), `similar.check_lookalikes` looks at each uploaded slide:

1. *Candidates.* The v3.2 spec's `POST /search/smart {"queryAssetId", "size"}` (nearest by Immich's
   own CLIP embeddings, the asset itself included) — Immich returns **no distances** and always the
   nearest N, so every candidate is verified here. `/duplicates` wasn't used: Immich's own duplicate
   detection only groups near-identical files (default max distance 0.01) and needs
   `duplicate.read`. A 400 mentioning "embedding" means Immich hasn't indexed the new upload yet
   (its machine learning runs after upload): the slide is `pending` and the next check retries. Any
   other 400 / 404 (an older server rejecting `queryAssetId`, "Smart search is not enabled") falls
   back to the photos **taken in the slide's date window** (`POST /search/metadata {takenAfter,
   takenBefore, type: IMAGE, size: 200}`; its day / month / year ± a day, from `slide_dates`); a slide
   with no date at all is `unsupported`. The classification goes by the message text, recalled from
   Immich's server code (`Asset … has no embedding`) and not checked against a running Immich.
2. *Verification.* Candidates that are this tray's own assets (uploads, stacked scans, pulled-in
   sources), trashed or not images are dropped. The rest: Immich's thumbnail of the candidate and of
   the new upload, each `levels`-stretched per channel (1st–99th percentile: a crude restore, because
   an old faded scan and today's restored slide differ most in colour — synthetic beach: 0.83 as
   they are, 0.98 levelled, other slides 0.66–0.76), through the local CLIP; ≥ `LOOKALIKE` (0.92) is a
   match. Up to 3 per slide, best first.
3. `g["immich"]["lookalike"] = {"asset", "state": checked|pending|unsupported, "via": smart|date,
   "matches": [{"id", "similarity", "name", "date", "state"}]}` (payload: `lookalike`, `null` when not
   checked or the slide was uploaded again since). Decisions survive a re-check of the same asset.
4. `POST …/insights/decide {"kind": "lookalike", "action", "value": asset id, "groups": [gid]}`.
   Accept = **replace**: the new upload joins the old photo's albums and takes its favourite
   (`workflow._carry_over`), the old one goes to Immich's trash. Dismiss = keep both.

Permissions: `asset.read` (search), `asset.view` (thumbnails), plus the round trip's for replacing.
Limits: at most 8 smart-search candidates per slide (the Immich index may rank a look-alike lower),
the date fallback only sees one page of 200 photos and depends on the slide's date being right,
thumbnails are ~250 px, and Immich's smart search needs its machine learning enabled.

**UI** (`components/similar.tsx`). In the Insights section, under the tag suggestions, cards for the
slide's look-alike suggestions: "Slides 12, 13 and 15 look like the same shot" with thumbnails
(click one to keep it instead; the best is preselected) and "Keep 13 (sharpest), skip 12 and 15" /
"Not the same"; "…from scan 2 on it may be another slide" → Split; "Slides 4 and 5 look like one
slide at two exposures" → Merge; "Looks like a photo already in Immich" (Immich's thumbnail via
`/api/immich/assets/{id}/thumb.jpg`, name, date) → "Replace it" / "Keep both", and "Check" while
Immich hasn't indexed the upload. The **Review suggestions** dialog lists all of them above the tag
piles. The filmstrip draws a **scene separator** ("Scene 2 · mountains · 4–6", before the first shown
slide of each scene, also when filtered) whose "Apply to scene…" opens `PropagateDialog` in `pick`
mode (tag / date / caption + value, from / to prefilled) → `POST …/insights/propagate`. Place isn't
offered: slides have no place field to propagate yet.

**Ported to the browser version** (§4c "Suggestion models in the browser"), the Immich check included
(it needs Immich to allow the page, like uploads). The Swift app has
none of it (its `Slide` Codable drops `similar` / the `lookalike` record; `embeddings.json` is left
alone).

**Tests** (`tests/test_similar.py`): planted synthetic unit vectors at exact cosines — duplicates
with best / keep / dismiss-as-pairs / window / skip / threshold learning, staleness after turning,
split and merge (incl. the exposure and structure gates, and merge pairs not doubling as
duplicates), scenes (outlier, skipped slide, label, one-scene tray) and propagating over one; the
background helper with a fake model (8×8 grey thumbnails as vectors: one embedding per slide serves
tags and look-alikes, bracket scans agree after normalising); look-alikes against the fake Immich
(smart search ranked by a crude thumbnail distance, `SMART = "old" | "off"`, `UNINDEXED`): found
and replaced (albums, favourite, trash), pending → checked by the job, dismiss kept across checks,
the date fallback, a slide without a date, off by default. `SS_REAL_CLIP=1` runs the real model:
bracket scans ≥ `MERGE`, beach vs snow < `SPLIT` / `DUPLICATE`.

### Eyes open (`eyes.py`, ROADMAP §1 "Eyes open")

"Keep the best" of duplicates prefers the shot where nobody blinked. Opt-in: config `eyes_enabled`
(Settings → "Prefer the shot with open eyes", shown under Suggest tags; it counts as on only with
`insights_enabled`, since duplicates come from CLIP).

**Model.** YuNet's five landmarks say nothing about eyelids, and the ready-made open / closed eye
classifiers on Hugging Face are CC BY-NC, so: a permissively licensed landmark model plus the eye
aspect ratio. Google's MediaPipe Face Landmarker face mesh (478 points incl. irises, Apache 2.0),
as ONNX converted from the TFLite with unchanged weights by `senty-au/face_landmarks_detector-ONNX`
(Apache 2.0; the card names the `.task` bundle and the TFLite's sha256; pinned revision, 4.9 MB,
sha256 checked, `insights.fetch_files` into `<library>/models/face-landmarks-478/model.onnx`; NOTICE.md).
Also looked at: `fernandotonon/QtMeshEditor-facemesh-onnx` (the same graph, Apache 2.0, less
documented), `astaileyyoung/FaceMeshONNX` (says MIT for Google's weights: not taken),
`py-feat/mp_facemesh_v2` (PyTorch only), Qualcomm AI Hub's MediaPipe-Face-Detection (Apache 2.0,
but the ONNX zip is on S3 without CORS, so the browser couldn't fetch it), `qualcomm/HRNetFace`
(MIT code, COFW-trained weights of unclear terms), InsightFace's 2d106 (non-commercial upstream).
Input `[1, 256, 256, 3]` RGB 0..1, outputs the 478 × 3 points in crop pixels and a face-presence logit.

**Measuring a slide** (`eyes.measure`, on the upright blend): `imaging.detect_faces` (as people and
the rotation vote); `prominent` keeps faces ≥ 0.7, ≥ 4 % of the width and ≥ half the largest face's
width, largest first, at most 8 (someone in the background doesn't decide). Each is cut out as
MediaPipe cuts a detection: `crop_matrix` = a square 1.5 × the box's longer side around its centre,
turned so YuNet's eye points are level, `cv2.warpAffine` (bilinear, border 0) of the 8-bit picture
to 256 px. Presence < 0.5 → skipped. Per eye the EAR of Soukupová & Čech (2016),
`(|p2 − p6| + |p3 − p5|) / (2 |p1 − p4|)` on mesh points 33/160/158/133/153/144 and
362/385/387/263/373/380; per face the mean of the two (a ratio: the same in crop and picture pixels).
Stored per slide next to its embedding: `embeddings.json` `slides[gid].eyes = {"model":
"face-landmarks-478", "ear": [per face, 3 decimals]}` (`[]` = no faces that count; `error` when it
failed, not retried). Raw EARs, so the thresholds can change without measuring again.

**When.** `similar.record_slide` measures with the embedding (the blend is at hand) when `eyes.on()`;
slides embedded before the model arrived are caught up by `similar.step` after the scans (`_todo`'s
third answer, counted in `pending`), committed only if the slide's key still matches. Turning / re-
stacking replaces the whole entry, so the eyes are measured again with it.

**Scores.** `openness(ear)` ramps 0 at `CLOSED_EAR` 0.10 to 1 at `OPEN_EAR` 0.18; a slide's eyes =
its least open face (`slide_open`, `None` without faces). `similar.best_of`: each member's quality
as a share of the cluster's best × (1 − `EYES_WEIGHT` + `EYES_WEIGHT` × open), `EYES_WEIGHT` = 0.6;
unmeasured / faceless members count as open, the first wins a tie. So a blink keeps 40 % and loses
unless the open-eyed shot is under 40 % as sharp (best-of-bracket already drops scans under 60 %);
without faces `best` is exactly as before. The suggestion gains `eyes` ({gid: open, 2 decimals},
measured slides only) and `closed` (open < `CLOSED` 0.5, i.e. EAR < 0.14) when any member has faces;
`scores` stay the plain quality. The card (`components/similar.tsx`) says "Eyes closed on slide 13"
and why the preselected one: "(sharpest)", "(sharpest, eyes open)", "(eyes open)".

**Measured** (scratch scripts; photos from Hugging Face kept out of the repo): 700 AI-generated
portraits labelled open / closed (`MichalMlodawski/closed-open-eyes`, ODC-BY, 4 + 3 shards):
closed EAR median 0.04, open never below 0.22 (median 0.33); with the shipped rules 378 of 398 closed
faces are called closed (most of the 20 others wear sunglasses or squint) and 0 of 300 open ones.
1648 real photos (LFW, `bitmind/lfw`): median 0.27; looked at by hand, those below 0.10 are closed
or screwed up in a laugh, 0.12–0.18 mostly open but narrow (smiles, 250 px photos), which is why the
ramp sits lower than the AI set alone suggests; 12 % are called closed. ~65 ms a photo in Python with
YuNet, ~55 ms a face in onnxruntime-web (Node). Refining the crop from a first pass's own points (as
MediaPipe tracks) changed the EARs by < 0.01 and was left out. **Not measured on real slide scans**:
faded, grainy 35 mm portraits may read lower; the constants are at the top of `eyes.py`.

**Browser version** (`standalone/eyes.ts`, op `eyes` in `engine.worker.ts`): the same file from the
same pinned revision (source id `face-landmarks-478` for tests), YuNet as for people, `prominent` /
`cropMatrix` / `faceEar` / `bestOf` ported, the crop through `people.warpAffine` (OpenCV 5's float
bilinear warp) of the 8-bit RGB picture. Checked in Node on 90 of those photos (92 faces) with Python's
own YuNet rows: every EAR within 0.001 (the rounding). Settings shows the same checkbox; the tray's
`insights.missing` names the eye model while it isn't downloaded. Swift: not ported (no look-alikes there).

**Tests.** `tests/test_eyes.py`: EAR on synthetic eyes (turned, scaled, degenerate), the mesh's two
eyes, the ramp and a slide's least open face, the crop matrix (centre, eyes level, scale), `measure`
with the detector and the landmark model replaced (which faces count, presence, no faces), `best_of`,
duplicates in the payload with planted EARs (best, `eyes`, `closed`, another model ignored), the
background catching up when the model arrives and re-measuring a turned slide, a failure stored, the
settings / status / download. `frontend/src/standalone/eyes.test.ts` against `eyes.fixture.json`
(`tests/make_eyes_fixture.py`: EAR, `crop_matrix`, OpenCV's 256 px warp, `prominent`, `best_of`,
`similar.suggest` with eyes). `tests/web_flow.py` turns it on and waits for every slide's `eyes`
(a stand-in file; the synthetic slides have no faces, so the network itself isn't run there).
## 5f. Places (ROADMAP §1 "Location recognition")

`places.py`. A slide's place is `g["place"] = {"name", "lat", "lon", "country"}` (+ `"admin"`, the
region, and `"id"`, the GeoNames id, when picked from the gazetteer). `places.clean_place` validates
it (lat ±90, lon ±180, finite; rounded to 5 decimals; no name → "lat, lon" to 4 decimals); `same(a,
b)` = same name within 1e-3°.

**Gazetteer.** GeoNames `cities15000.zip` (~34k places, 3.4 MB) + `countryInfo.txt` +
`admin1CodesASCII.txt`, CC BY 4.0 (NOTICE, and a credit line under the autocomplete), downloaded by
`POST /api/places/download` (job `places`) into `<library>/data/geonames/`, never committed.
GeoNames rebuilds them daily, so there is no checksum: each goes to `.part`, must parse as a
tab-separated table with ≥ `MIN_ROWS` rows of the right width, then `os.replace`. `Gazetteer` loads
the zip in ~2 s (lazily, again when the file's mtime changes) and indexes every place under its
folded name, ASCII name and Latin-script alternate names (`fold`: NFKD without accents, ß→ss, ø/ł/đ,
lower case, non-alphanumerics → space; alternates in other scripts and ≤ 4-letter all-caps codes like
IATA "VCE" are left out). `search(q)`: prefix match over the sorted keys, ranked exact name before
longer, a city's own name before an alternate (GeoNames lists "Venice" among *Dayton*'s names), then
population; `"Venice, flor"` narrows by country / region prefix. Typed coordinates come back first,
named after the nearest city within 25 km (haversine over all of them). `GET /api/places?q=` →
`{ready, downloading, mb, results}`.

**Setting it.** `PATCH …/groups/{gid} {"place": {...} | null}` (400 on junk; locked → 409 like every
edit). An open place suggestion is settled by it: the same place → accepted, another → dismissed.
`POST …/insights/propagate {"kind": "place", "value": {...}}` gives a range the place (locked
skipped). UI: `components/place.tsx` (combobox + listbox, debounced search, "Name lat, lon" parsed
client-side so a typed name wins over the nearest city), the pin icon → `PropagateDialog` with an
`Offer` whose `value` is the label and `place` the place.

**Suggestions** go through the insights plumbing (§5a); a place entry is `{"value": "Venice, Italy",
"place": {...}, "confidence", "source", "state", "text"}` — `value` is the label accept / dismiss /
review piles use, `place` what accepting stores, `text` why (the OCR'd line or "slides 11 and 14").
`places.merge` replaces `insights.merge`'s old "newest wins" for places: a decision on the same
place stands, an accepted place is never replaced, a slide with its own place gets nothing new
(or `accepted` when it names that place).

- *Text in the photo* (`OCR_ID = "ppocr-v5-latin"`): PaddleOCR's PP-OCRv3 mobile detector (2.4 MB)
  + PP-OCRv5 Latin recogniser (7.9 MB) + its 502-character dict, ONNX from `monkt/paddleocr-onnx` at a
  pinned revision, checksummed like CLIP's files (`insights.fetch_files`, the CLIP downloader made
  generic). `POST /api/places/download {"ocr": true}` (job `ocr`) fetches them into
  `<library>/models/ppocr/`, plus the gazetteer if missing. `places.Ocr` is PaddleOCR's pipeline in
  ~80 lines on onnxruntime CPU: DB detection on the upright proxy shrunk to ≤ 960 px (multiples of
  32, BGR, ImageNet mean/std as Paddle feeds it), threshold 0.3, contours → `minAreaRect`, box score
  = mean probability inside ≥ 0.6, unclip = grow the rectangle by area × 1.5 / perimeter (what
  pyclipper's offset does to a rectangle); each box is perspective-cropped from the 1600 px proxy
  (turned when taller than 1.5× wide), resized to height 48, (x/255 − 0.5)/0.5, CTC greedy decode
  (blank 0, dict, then space). ~0.2–0.5 s a slide. It runs inside `insights.analyse` only when
  `ocr_on()` (text reader + gazetteer present; cached 2 s since `pending()` asks per slide); the
  OCR id then joins `insights_key`, so downloading it re-analyses the trays (decisions kept). The
  lines are kept as `insights.text` (the payload shows the strings).
- *Matching* (`place_from_text`): every 1–3-word run of each line, and of each pair of consecutive
  lines ("WELCOME TO" / "VENICE"), looked up by exact folded name, longest first. After a cue
  (`CUES`: "welcome to", "bienvenue à", "grüsse aus", "benvenuti a" …, folded) base 0.9. Without
  one it must have ≥ 4 letters, not be a sign word that is also some town's name (`COMMON`: bar,
  nice, split, marina, kodak, fuji, europa …), not follow a street / business word (`NOT_AFTER`: via,
  rue, hotel …) nor precede one (`NOT_BEFORE`: road, airlines, station …), and be a city's own name
  or an alternate of a city ≥ 100k (`BIG`: "Wien", "Nizza" yes; GeoNames' alternates of small places
  are full of words: "Coca", "Plage", "Metro"); base 0.6 (≥ 6 letters) or 0.45. Homonyms go to the
  most populous city *called* that (own names first), and confidence = base × OCR confidence ×
  (0.5 + 0.5 × its share of the homonyms' population): "WELCOME TO VENICE" → Venice, Italy at 0.65,
  "Benvenuti a Firenze" → Florence at 0.90. Below 0.3 nothing is suggested. Checked on 163
  everyday sign texts (against the real cities15000): no suggestion for sign words, streets, hotels, brands; what's left are real
  place names (Verona, Wien, Brugge) and a few region / landmark names that are also some town's name
  (Andalucia → a town in Colombia, Alhambra → Arizona, Florida → Cuba) at 0.4–0.6.
- *Tray neighbours* (`suggest_between`, run after every place change: PATCH, decide, propagate): a
  slide without a place between two slides with the same place and no other place between them
  gets it suggested (source `tray`, 0.9, text "slides 11 and 14"). Tray suggestions that no longer
  hold are withdrawn; a dismissed one stays dismissed; an open text suggestion is never overwritten.
  It needs no model, so an open place suggestion is also shown (✓ / ×) in the Place field itself,
  not only in the Insights section (which needs the tag model).
- *Landmarks via CLIP*: **not done.** Zero-shot CLIP over a closed list of landmarks is softmax over
  that list, so any tower or cathedral comes out as *some* landmark with a high share; keeping that
  honest needs a calibration set of real slides (landmark and not) that the repo can't hold. Sign
  text and neighbours carry the suggestions; a landmark list is the obvious next step once real
  trays exist to calibrate against.

**Where it goes.**
- `store.meta_key` appends `{"gps": ["45.43713", "12.33265"]}` (coordinates formatted to 5
  decimals, so `store.ts` hashes the same string; the name isn't sent anywhere) only when there is a
  place, so slides uploaded before stay `uploaded`; a place edit after upload makes the slide
  `changed`.
- Export: EXIF GPS IFD (`workflow.gps_ifd`: version 2.3, N/S/E/W refs, degrees / minutes / seconds as
  rationals); a pulled-in photo's own GPS is dropped first, so the slide's place decides. Immich reads
  it on upload.
- Metadata-only sync (§6a): `PUT /api/assets/{id}` gets `latitude` / `longitude` (UpdateAssetDto in
  v3.2, also v1/v2) with the date and description. The API can't *remove* a location (the fields
  aren't nullable), so a slide whose place was removed after upload is rendered and uploaded again
  (replacing the old asset as usual). `pushed` gained `"place": [lat, lon] | null`.
- Pull from Immich: `exifInfo.latitude / longitude` differing from `pushed.place` by > 1e-4° become
  the slide's place (named after `exifInfo.city`, else its coordinates; `country`, `state` as admin);
  records from before places compare against the slide's own. `pulled.places` counts them. Pull
  back in: a photo with GPS starts with that place.

**Browser version.** download.geonames.org sends no CORS headers, so the page downloads a pinned
snapshot of the same files from a Hugging Face mirror; search, sign OCR and neighbours work as here
(§4c "Suggestion models in the browser"). Places are set, propagated (`/insights/propagate` for
place / caption / date), keyed (`metaKey`), written as EXIF GPS (`exifSegment(…, gps)`, checked with
Pillow), synced to Immich, pulled back and kept on pull-in exactly like the desktop app;
`tests/web_flow.py` downloads place names, searches them, types a place, applies it to a range and
checks the uploaded JPEGs' GPS. **Swift app:** not ported (its `Slide` Codable drops `place`, and
its meta key has no place).

**Tests:** `tests/test_places.py` — a made-up GeoNames extract in the scratch library: search
(ranking, narrowing, alternates, coordinates), the endpoint with / without the gazetteer, set /
clear / validate, meta key, propagation, neighbours (suggest, accept, dismiss, withdraw), a typed
place settling a suggestion, `place_from_text` rules, OCR through insights with a fake reader
(suggested, re-analysis keeping decisions, stale without the reader, accept all), EXIF GPS + Immich
lat / lon on upload, in-place update, removal re-uploading, no `asset.update` → re-upload, pull and
pull-in, the gazetteer and text-reader downloads through `httpx.MockTransport`. `SS_REAL_OCR=1`
downloads the real text reader and GeoNames and reads four rendered signs (verified: all four
read word for word, Venice / Annecy / Florence found, "OPEN BAR" nothing). By hand, on 13
synthetic 1600 px sign photos (faded, grainy, blurred, tilted ±6°): 13/13 right, including
"Hotel Zürich" and "Via Roma 12" → nothing; and in the server app with the real CLIP + text
reader: a "WELCOME TO VENICE" slide got Venice at 0.65 and, after placing slides 1 and 3 in Venice,
slide 2 got the tray suggestion.

## 5g. People & Places, dates from people (`dating.py`)

A full-window view (top bar people icon, ⌘K "People & Places…"; `components/people.tsx`) that takes
the place of filmstrip, stage and inspector while it's open. Always there: the places need no
model. It carries `data-ss-atlas`, which `useKeyboard` treats like an open dialog (no slide keys);
Esc steps back: out of placing, then the picked slides, then the page, then the view.

- **Sidebar:** People or Places, a search, a sort (A–Z / most slides / people without a birthday),
  200 rows then "Show all" (one cover face per person — `cover`, their clearest face — so a long
  list stays light), faces seen once hidden behind a link, and a checkbox per person (on hover) to
  merge the ones picked ("These N are one person").
- **Overviews:** People = a face grid (named, then "Who are they?"), the face search / Immich tag
  actions and the ages note; Places = the map of every place, a click opens the place.
- **Unnamed people** are "Person 12" everywhere (`people.label` / `personLabel`: the number in their
  id, which a person keeps across refreshes and merges into them).
- **A person's page** (`GET /api/people/{pid}` → `dating.person`): name and birthday editable in
  the header, slides / places / "looks 21–23", "Often with" (the people on the same slides, most
  first; a click goes to them). Their slides grouped by year (the date each goes to Immich with,
  estimates marked ≈ — or, where the people's guess says another year and isn't dismissed, that
  year, `date_source` `people`: "age 2 · looks 27" meant the tray's neighbours had it wrong), each card with their face in the corner, "age 21 · looks 23" (the age from
  the birthday and the slide's date, and the age the face looks), the place and the tray; × on a
  card = "not this person". Beside it a map of their places and the list of those (a click keeps
  only that place's slides; → opens the place's page).
- **A place's page:** its region / country / coordinates, who is there (chips with counts), its
  slides, and the map of every place with this one picked.
- **Placing slides:** ⌘ / ⇧-click cards (or the checkbox) to pick them, or "Pick them" for a
  person's slides without a place; "Place on the map", then a click on the map — or on an existing
  place, which reuses it exactly — gives every picked slide that place (`PATCH …/groups/{gid}`
  each; locked ones are counted and left). A point is named like typed coordinates in the Place
  field (`placeAt` → `GET /api/places?q=lat, lon`: the nearest city within 25 km when the place
  names are downloaded, else the coordinates). The open tray reloads if any of its slides moved.
- **The inspector's Place field** has a map button: a 160 px map (`PlaceMiniMap`, shown or not
  remembered in localStorage `place-map`) with the slide's place as a pin; click the map or drag
  the pin to set it (same naming).
- Maps are Leaflet on OpenStreetMap's tiles (no key; CARTO's basemaps now need one), darkened with a
  CSS filter in `theme.css`, which also undoes Tailwind's `img { max-width: 100% }` (it squashes
  Leaflet's tiles to nothing). **Trap:** Leaflet adds its own classes to the map's div, so React
  must never render a changing `className` on it (that wiped them when placing mode toggled and
  the map went blank); `useLeaflet` maps sit on an inner div inside a React-styled wrapper.
  Offline the dots and pins still show on a blank map.

**Birthdays:** `PATCH /api/people/{pid} {"birthday": "1952" | "1952-03" | "1952-03-14" | ""}` (400
on junk, via `people.clean_birthday`; can come with `name`) stores `people.json`
`people[pid].birthday`; a birthday alone keeps an otherwise empty person (like a name), a merge
keeps the first birthday.

**Ages** (desktop / server app, opt-in `ages_enabled`, Settings under "Recognise people"): **MiVOLO v2**
(Kuprashevich & Tolstykh, Apache-2.0), which reads the face *and* the body below it — a child's body
says as much about their age as their face. Our ONNX export of its age output (opset 18, batch 1,
input `faces_bodies` [1, 6, 384, 384]: face then body, each letterboxed to 384 px on black, RGB,
ImageNet mean / std; output `age` [1, 1] years), 118 MB, hosted on the owner's Hugging Face
(`Sam-Apostel/mivolo-v2-age-onnx`, a pinned commit; its model card says how it was exported),
checksummed and downloaded like SFace (`people._download`) by the face-search job when turned on;
the model it replaced (`OLD_AGE_NAMES`) is deleted then. `people.estimate_ages(rgb, boxes)` (the
function tests replace) cuts `age_crops` — the face's box, and a body box 3 faces wide from 0.3
above to 6.5 faces below it, clipped (MiVOLO's own pipeline finds bodies with YOLO; this is near
enough) — and `age_input` prepares them as MiVOLO's image processor does (checked against PyTorch:
≤ 0.01 y apart); ~0.1 s a face on a CPU. `faces.json` keeps `faces[].age` (years, 1 decimal) and,
per slide, `ages_by` (`people.AGE_BY`): `record(…, ages=True)` ages new faces; faces found before,
or aged by another model (`people.unaged`), are aged in place by `add_ages` without detecting again
(ids untouched) — `faces_pending` counts them, so the background helper and "Find faces" catch up.

Why MiVOLO: the ViT-B/16 trained on UTKFace it replaced (329 MB) was fed exactly as trained, but
on the owner's slides — faded, grainy, children's faces 60–160 px across — it read everyone ~11
years too old (a girl of 7 "looked" 63). On 20 faces of a tray labelled 1977 with birthdays (a
holiday, checked by eye) it was off by 13.1 years on average and within 3 years for 15 %; MiVOLO:
1.9 years, 85 % within 3. Levelling the eyes, the crop's margin, the developed look instead of the
faded scan, full-resolution scans instead of the proxy, mirrored copies: none moved the old model
by more than a year.

**The date** (`dating.tray_view`, computed per payload; no file):
- A face of someone with a birthday gives `born + age`. Ages are corrected by a **calibration on the
  slides dated by hand** (`calibrate`) — and, at half the weight (`TRAY_WEIGHT`), on the slides of
  a tray with a date (a tray is one stretch of time; in the owner's "Box 5 - Tray 1", labelled 1977,
  the model saw Tom, 8, as 11–50): residuals r = log1p(real) − log1p(guess) (error ∝ age). **Medians,
  not means** (`_wmedian`): a mask, a misnamed face or a slide from another year is one wild sample.
  The common bias is the median of each *person's* median residual (each person counts at most
  once), shrunk by k / (k + 3) with k the people: a child on many slides whom the model sees
  twice their age says nothing about their mother. Each person's own correction is the median of
  the rest, shrunk with 4 pseudo-slides; the spread is the MAD left after both, with a prior of
  0.2 (3 pseudo-slides). SD in years = sigma × (1 + age), at least 0.5, plus
  the birthday's own spread (a year-only birthday is ±0.29). A slide whose own date came from
  accepting a people suggestion (`insights.date` source `people`, accepted, same value) is left out,
  so the calibration never learns from its own guesses. Cached on people.json's and every
  session / faces file's mtime (`library_slides` re-reads only trays that changed).
- **Birth years without a birthday** (`implied_births`): someone on a slide you dated (not one
  dated by accepting a people suggestion) was born around that date minus the age they look there;
  their faces then date their other slides. Their own habit (looking older) is in both and mostly
  cancels. Only a given birthday is a floor (`born_floor`).
- **Events:** the tray's scenes (`similar.scenes`, runs of look-alike slides; `_events`, cached on
  embeddings.json's mtime and the slides' keys) of 2+ slides are one moment. Their people are pooled —
  each person once, at the median of the years their faces there say (a mask that "looks 46" doesn't
  drag it), SD shrunk by √(slides, at most 3) — and every slide of the scene takes that year, also the
  ones with nobody on them; a slide whose own people contradict its scene stays on its own. A slide of
  the scene dated by hand dates the rest (± 0.25 y) when the people don't contradict it. Several
  people on a slide or in a scene are combined by `_consensus` (the ones agreeing with the most
  others; the rest are left out, not averaged).
- Per slide: its own (or its scene's) people are the **anchor** (else a dated slide of its scene,
  else the most certain neighbour). Up to 12 undated slides either side join with their SD grown by 0.5 + 0.1 × distance —
  but only the nearest slide of each *set of people*, and none whose people are all on this slide
  (someone who looks older does so on every slide: repeating them isn't new evidence). The
  ordinary estimate (`store.slide_dates`: between → SD a quarter of the gap, ≥ 0.5; near → 1.5 +
  0.1 × distance; tray → 1.5) joins too. **Anything more than 2.5 combined SDs from the anchor is left
  out**, not averaged: in a real run, Lena (~1974) and Messi (~2015) interleaved in a tray dated
  1972 had averaged to a meaningless 1982; now each slide says its own person's year, and the text
  says "the dated slides around it say 1972".
- **Misnamed faces** (`suspects`): a face whose corrected age is more than 2.5 combined SDs and at
  least 6 years from its person's age when the slide was taken (their birth year, and the slide's
  date *without* the people: own, else `_prior` of the ordinary estimate — `library_slides` keeps it
  as `when`). That alone could as well be a wrong date (trays aren't in order; that's what the
  people's dates are for), so it also takes the slide being dated by hand, or the face being a weak
  match for them: cosine < 0.35 to the average of their other faces (3+). In the owner's library,
  "Tom (born 1968)" looking 37 in a tray labelled 1977 matched at 0.19, while his faces looking
  13–27 in a tray labelled 1971 matched at 0.46–0.60 (him, slides from later). A suspect gives no
  age (no date, no calibration sample, no implied birth year); they're found first with the neutral
  calibration (a misnamed face on a dated slide would widen the calibration enough to hide
  itself), then again. Shown as `odd` {age, year} on the slide's faces and the person's page cards.
  "It is <name>" on a marked face keeps the name and records the age as wrong (`people.json`
  `ages_off`: no mark, no date); "Not <name>" takes it out.
- Payload per slide: `people` [{id, name, age}] (named or with a birthday), `people_year` [year,
  SD], `born_floor` (the latest birth year on it: the UI warns when the date or estimate is older).
- **Suggestion**: `{value: "YYYY", source: "people", confidence: 0.9 − 0.08 × SD (0.3..0.9), text:
  "Ann ≈ 30, Bob ≈ 7 (± 2 y)"}` for undated, not skipped slides with SD ≤ 8, lifted to
  `born_floor`, inside the film stock's era, and only when its year differs from the year the
  slide already goes with — and, where there is an estimate already (the ordinary one), only when
  the people contradict it, or are surer than it *and* put the slide outside its range (more than its
  SD away). A tray labelled 1977 whose children the model reads a year young was otherwise
  "1976" on every slide; a toddler in it still dates their slide. `dating.views` wraps `filmstock.views`: the people's guess replaces the
  neighbours+stock one (it already includes that estimate) through `filmstock._merged`, which
  treats source `people` as a live guess like the stock ones; decide / review / "accept all" work
  unchanged. Nothing moves a slide's date or `meta_key` until accepted.

**The places:** `GET /api/atlas` → every slide with `g["place"]` (not skipped) grouped by name +
coordinates (3 decimals), with tray, index, own date, render key and the people on it; one circle
per place, area ∝ slides.

**Browser version:** birthdays (`standalone/people.ts` `cleanBirthday` / `setBirthday`, the same
people.json), the atlas and the person's page (`personPage`, no `looks`) are ported; ages are not (118 MB in every browser's storage, like
captions), so the payload has no `people` / `people_year` there and nothing is dated by people.
**Swift app:** not ported.

**Tests:** `tests/test_dating.py` — calibration maths (neutral start, learning a bias, per person,
the floor on SD), dates from people through the API with `embed_faces` / `estimate_ages` replaced
(birthdays validated, calibration counts, the suggestion and its text, accepting it not feeding the
calibration, a neighbour without people getting a vaguer year), the birth-year floor, ages added to
faces found before (ids kept), birthdays surviving merges, conflicting people not averaged, an
event dating its slides (faces pooled, a mask not dragging it, the person's page showing that year
until it's dismissed), the (grouping, people, skipped slides) and a person's page (order, ages, place, who they're with,
404). `tests/web_flow.py` opens the view in the browser version (no faces, no places yet) and
leaves it with Esc.

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
  The round trip (§6a) also uses `asset.read`, `asset.update`, `asset.view`, `asset.download`,
  `albumAsset.delete`, `stack.read`, `stack.create`, `stack.delete`; without them it falls back to
  the plain upload behaviour instead of failing.

## 6a. Round trip with Immich (ROADMAP §2)

**Album and tray tag** (`workflow._place_tray` / `placeTray`). Settings' `immich_album` (an album
id, `immich_album_name` to show it) sends every tray into that one album, shared albums included
(`GET /albums` answers only the user's own; `GET /albums?shared=true` the ones shared with them,
both are listed). Unset, each tray goes to its own album by name, as before. A gone album stops
the upload with a message rather than creating a new one. After every upload the whole tray is put
right: all its photos in Immich join the album (`PUT /albums/{id}/assets` answers "duplicate" for
those already in it), the untouched scans stacked under them leave it (adding a stack to an album
in Immich takes the scans along, and albums show each photo of a stack on its own), and they get
the tag `Trays/<tray name>` ("/" in a name becomes "-"; `tag_trays`, on by default). A renamed tray
moves the tag: the old one is taken off (`GET /tags` for its id, `DELETE /tags/{id}/assets`). The
session remembers `placed` (album|tag) and `tray_tag`; when `placement(cfg, d)` differs (the setting
changed, the tray was renamed) the payload says `placement_stale` and the upload button offers "Put
in '<album>' in Immich", which runs the upload with nothing to send. Missing permissions
(`albumAsset.delete`, `tag.create` / `tag.asset`) or a server without tags only add a note.

`workflow.finish_session` / `pull_in` / `pull_metadata`, mirrored in `standalone/server.ts`
(`finishSession`, `pullIn`, `pullMetadata`); client calls in `immich.py` / `standalone/immich.ts`.
A slide's `g["immich"]` record grew to:

```
{"asset_id", "key", "status", "meta",
 "pushed": {"date": "YYYY-MM-DD", "caption"},     what Immich was told besides the pixels
 "stack_id", "originals": {scan: asset_id},        only when its scans are stacked under it
 "own_originals": [asset_id, ...]}                 the originals this app uploaded (vs. reused)
```

and a pulled-in slide has `g["source_asset"] = {"id"}` (its scan record `immich_asset`,
`source: "immich:<id>"`, `source_root: "immich"`, `removable: false`).

**Upload, per slide** (the order matters):

1. *Metadata only.* A slide whose pixels Immich has (`immich.key == render_key`, or locked) and whose
   `meta` differs is not rendered: `PUT /api/assets/{id}` with `dateTimeOriginal` (naive local time,
   `YYYY-MM-DDTHH:MM:SS`, the same wall clock the EXIF upload carries) and `description`. The
   file's own EXIF in Immich keeps the old values (Immich writes edits to its sidecar). `PUT
   /assets/{id}` is marked deprecated in v3 with itself as the replacement, i.e. still the way. A
   403 (no `asset.update`) falls back to re-rendering and uploading as before. The tray-date
   "redate" case is the same path now, and slides whose `meta` didn't move are skipped.
2. *What it replaces:* the slide's last upload, or the photo it was pulled in from. Its albums
   (`GET /albums?assetId=`) and favourite (`GET /assets/{id}` → `isFavorite`, uploaded as
   `isFavorite`) carry over; faces aren't copied (Immich detects and recognises them again).
3. *Exact duplicate:* `POST /assets/bulk-upload-check` with the export's hex SHA-1. If Immich has
   those bytes, that asset is used (restored from the trash if it's there: undoing an edit renders
   the same bytes as the trashed copy) and nothing is sent. Servers without the endpoint (404) just
   upload. Only byte-identical files are recognised here; look-alikes ("a scan you uploaded in
   2021") are an optional check *after* the upload (§5e).
4. *Stacks* (`upload_originals_stacked`, Settings, default off): the slide's scans — all of
   `g["scans"]`, brackets included, never edited — are checked with bulk-upload-check (reusing any
   Immich has, e.g. a pulled-in photo's own asset or raw scans uploaded some other way) and the
   rest uploaded with the slide's date; then `POST /api/stacks {"assetIds": [developed, *scans]}`
   (the first id is the primary, per the spec). Scans don't go into the album. **Re-upload rule:**
   the old stack is deleted (`DELETE /stacks/{id}`, which only unstacks), a new one is made under
   the new photo with the same scan assets, then the old photo is trashed. This is the simplest
   order that never leaves a stack headed by a trashed asset; the scans are never re-uploaded
   (bulk-upload-check finds them). Scans already in Immich stay stacked even after the setting is
   turned off. Split / merge need nothing special: each slide's next upload stacks its current scans
   (merge also queues the merged-away slide's stack in `orphan_stacks`). Skipping an uploaded slide
   trashes its photo and the scans in `own_originals` that no other slide stacks.
   Stacks need an Immich with the `/stacks` API and `stack.*` permissions: `has_stacks` probes `GET /stacks?primaryAssetId=<random>`
   once per upload; 404 (older server) or 403 means nothing is stacked and no scans are uploaded,
   and the job message says so. `create_stack` / `delete_stack` also treat 403/404 as "can't".
5. The replaced asset goes to the trash — except a pulled-in photo that is itself one of the stacked
   scans: that one stays, under the new photo, and is taken out of the albums the new one joined
   (`DELETE /albums/{id}/assets`, best effort).

**Pull from Immich** (`POST /api/sessions/{sid}/pull`, Tray section / ⌘K): `GET /assets/{id}` for
every uploaded slide; where `exifInfo.description` or the day of `localDateTime` (Immich's wall
clock, v1–v3) differs from `pushed`, the slide's caption / own date take Immich's value — only
fields someone changed in Immich come back, and Immich wins over an unsent local edit of the same
field. `meta` is then recorded as sent (unless the slide's resulting date still differs, e.g. a
neighbour moved). Assets without `exifInfo` (not read by Immich yet) are left alone; missing or
trashed ones are counted as `gone`. Slides uploaded before this have no `pushed`: the current
values stand in. Answers the payload plus `pulled: {checked, captions, dates, gone}`.

**Pull back in** (`GET /api/immich/albums`, `GET /api/immich/albums/{id}/assets`,
`GET /api/immich/assets/{id}/thumb.jpg`, `POST /api/immich/import {"assets", "name", "album"}`;
dialog `components/immich-import.tsx`, from ⌘K or New tray → "From Immich…"). Listing an album:
v1/v2 return its assets in `GET /albums/{id}`, v3 doesn't, so the client falls back to
`POST /search/metadata {"albumIds": [id]}` (deprecated in 3.2 but working), following `nextPage`
(v1/v2) or `nextCursor` (3.2+). The import creates a tray (its album defaults to the Immich album,
so uploads land back in it) and runs as an `import` job: each JPEG / PNG image (videos, RAW, HEIC
left out) is downloaded with `GET /assets/{id}/original`, verified against Immich's base64 SHA-1,
and becomes one slide (no bracket grouping, no rotation guess; the Python app turns EXIF
orientation 3/6/8 into `rotation` because PIL doesn't apply it, the browser decodes upright
already — so a pulled photo with an orientation tag differs between the two apps) with the
photo's date (day of `localDateTime`) and description. Learned colour settings apply as on import.
These scans are **never removable** and are not added to `imported.json` (card imports stay as
they were). Pulling the same asset into one tray twice is skipped; the album list shows which
tray already has a photo.

Tests: `tests/test_immich_roundtrip.py`; the mock (`tests/fake_immich.py`) keeps asset bytes,
checksums, trash, EXIF description / date, stacks (`STACKS = False` = an older server), v2 vs v3
album listing with search paging (`PAGE`), and `DENY` for a key missing permissions.
`tests/web_flow.py` runs pull-captions, pull-back-in and the replacing upload in the browser
version. **Not ported to the Swift app** (`apple/`): stacks, metadata-only sync, pull from Immich,
duplicate check, pull back in, carrying albums / favourites over.

  With people on, also `tag.create` and `tag.asset` (names go as tags, §5c).

## 7. Testing

`tests/` contains what was used during development:

- `tests/test_tool.py` — pytest: zoom tiles, presets and "develop like", stats (§4, "Review grid,
  1:1 zoom, presets, stats").
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
  worth for the browser test. Each tray in the tests gets new bytes: the dedupe index skips by
  content (SHA-1). The name + size + mtime fingerprint only counts "new" scans on a card; import
  hashes every file (`test_dedupe.py`: a different scan sharing all three is still imported).
- `tests/fake_immich.py` — FastAPI mock implementing version/users/albums/assets/tags, with a
  `/debug` endpoint; set `MOCK_IMMICH_MAJOR=3` to exercise the v3 field rules, `TAGS = False` for a
  server without the tags API. It reads an upload's EXIF GPS into latitude / longitude like Immich,
  and covers the round-trip endpoints (§6a), tested in `tests/test_immich_roundtrip.py`.
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
  undo), local adjustments, date a range, a film stock guess accepted and given to the tray, place
  names downloaded and searched, a place given to a range, the tag model downloaded (a stand-in, or
  the real one with `SS_REAL_CLIP_DIR`) and a tag accepted, look-alikes, people turned on, upload
  (GPS and the tag checked), save to disk (EXIF
  checked), card cleanup and a reload all run through the real code. `SS_NO_FS_ACCESS=1` hides the
  picker API, as in Firefox and Safari: a folder `<input>`, a zip download, cleaning locked. Command in its docstring.

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
