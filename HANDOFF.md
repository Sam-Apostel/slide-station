# Handoff — Slide Station

Written for whoever picks this up next (human or coding agent). It covers what exists, why it is
built this way, what is unfinished, and the traps that already cost time.

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
4. **Restore** — auto colour restoration for faded film + manual sliders.
5. **Review** — keyboard-first: →, Space, R, B, C, X, M, 1–9.
6. **Upload** — full-resolution JPEG with EXIF date into a per-tray Immich album.
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
  store.py                config + session persistence (JSON on disk)
  immich.py               minimal Immich client (v1/v2/v3 compatible)
  models/                 YuNet face detector (MIT, from opencv_zoo)
  static/                 current UI: plain HTML/CSS/JS, no build step
  web/                    React build output (created by `npm run build`; served when present)
frontend/                 React 19 + Tailwind 4 + ProUI (scaffolded, NOT ported yet — §4)
tests/                    fake scanner card + mock Immich + Playwright flow (§7)
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

## 4. UI: what is done and what is left

The owner wants the UI rebuilt on **ProUI** (<https://pro-ui.dev>, paid, shadcn-style registry).

Done:
- `frontend/` scaffolded: Vite 7, React 19, TypeScript, Tailwind 4, path alias `@/*`.
- The ProUI components the UI needs are in `frontend/src/components/ui` (e.g. `pro-inspector`,
  `pro-slider`, `pro-toolbar`, `pro-titlebar`, `pro-statusbar`, `pro-button`, dialogs, inputs,
  sonner), installed from ProUI's registry with a licence.
- `frontend/src/index.css` generated from the ProUI `pro-theme` registry item (theme tokens,
  `:root`/`.dark` variables, base layers).
- `vite.config.ts` builds to `../slidestation/web` and proxies `/api` to the Python server in dev.

Left to do:
- Port the UI itself. The plain-JS app in `slidestation/static/app.js` (~700 lines) is the complete
  functional spec: top bar (tray picker, scanner chip, job progress), filmstrip with status dots
  and HDR/auto-rotate badges, stage (preview, before-on-hold, stack strip with split/exclude),
  inspector (rotation, colour sliders, slide actions, tray panel), three dialogs, toasts,
  keyboard map. Suggested mapping: `ProTitlebar` for the top bar, `ProInspector*` for the right
  rail, `ProSlider` for colour, `sonner` for toasts, `ProStatusbar` for job progress.
- `server.py` already prefers `slidestation/web` when it contains `index.html`, so the port can
  land without touching Python. Commit the build output: the launcher must work without Node.
- Keep the keyboard shortcuts identical; they are the main reason the app is fast for 10k slides.

**Licensing caveat (unresolved).** ProUI's stated rule is "you cannot redistribute ProUI itself as
a competing component library or template kit". This repo is public and now contains ProUI source,
which is arguably that. The owner decided to proceed; he was advised to confirm with ProUI. If they
object, the fallback is free shadcn/ui (MIT) — the same primitives ProUI builds on — or fetching
ProUI into a gitignored folder at setup. `NOTICE.md` records the situation.

## 5. Learning from past edits (new, working, untested in the wild)

`learning.py`. Every approved slide is stored as one example: 14 image features from the *blended,
undeveloped* image (per-channel 1/50/99 percentiles, brightness, contrast, red/green and blue/green
cast in log space, stack depth) plus the settings the user accepted. New slides get settings from
distance-weighted k-NN (k=7) over standardised features, with a distance cutoff so unlike slides
fall back to the defaults, and a 5-example minimum.

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

- `tests/fake_immich.py` — FastAPI mock implementing version/users/albums/assets, with a `/debug`
  endpoint; set `MOCK_IMMICH_MAJOR=3` to exercise the v3 field rules.
- `tests/ui_flow.py` — Playwright script: import from a fake card, browse, edit, review, upload,
  clean the card; asserts no console errors and prints timings.
- Make a fake card with `tests/make_card.sh <folder-with-scans>` → `/tmp/ss-card/DCIM/100MEDIA`,
  then run the server with `SLIDESTATION_HOME`, `SLIDESTATION_VOLUMES`, `SLIDESTATION_PORT`,
  `SLIDESTATION_NO_BROWSER` pointed at scratch dirs. **Never test against the real library.**

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

## 10. Immediate next steps

1. Port the UI to ProUI (§4) and commit `slidestation/web`.
2. Show the learning status in the UI and add per-slide "revert to learned/default".
3. Resolve the ProUI redistribution question.
4. Optional, previously discussed: wrap as a real macOS app so it isn't a Terminal window; an
   ESP32 button macro for the scanner to automate bracketing; a camera-based scanning rig, which
   would make most of the HDR work unnecessary.
