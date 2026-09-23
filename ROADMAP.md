# Roadmap — where Slide Station can go

Today it is a very good single-purpose tool: card → restored, upright, grouped slides → Immich.
The scans hold far more than pixels, though. A tray is a *story*: one trip, one summer, one
family, in order, often with handwriting on the mounts. Everything below builds on that, roughly
in the order it pays off. All of it runs locally unless it says otherwise — a recent laptop is
plenty.

---

## 0. Open now

Small, known items (the old handoff's leftovers):

- **Browser test script** — `tests/ui_flow.py` predates the Develop button, the Frame section and
  the panel cleanup; update its selectors, and add backend tests for curves, crop, undo, dates and
  locked slides.
- **Crop tool polish** — with a locked aspect ratio an edge drag that hits the photo's border stops
  instead of sliding along it; keyboard nudging.
- **Learning** — also learn curves (and maybe crop) from developed slides, not only the sliders.
- **Dates** — date a range of slides at once ("12–31: Aug 1978").

## 1. Understand the tray (local models, no cloud)

The laptop does the work while you develop; results are *suggestions* shown in the inspector,
never silently applied, and every one is learned from like the colour settings are.

| Idea | How | Why it matters |
| --- | --- | --- |
| **Smart grouping 2.0** | CLIP / SigLIP image embeddings next to today's structural signature. Detects brackets *and* near-duplicates (the same scene shot twice), and splits "scenes" inside a tray. | Fewer wrong merges; "keep the best of these 3" becomes one click. |
| **Best-of-burst** | Sharpness and clipping per scan already leave weak bracket scans out; next: near-duplicate shots of one scene, eyes-open score. | "Keep the best of these 3" without looking. |
| **Scene tags** | Zero-shot CLIP labels (beach, snow, wedding, birthday, church, car, dog…), plus OCR of signs. | Searchable in Immich as tags; lets you filter the filmstrip. |
| **Descriptions** | Small local VLM (e.g. Qwen2-VL / Moondream / LLaVA via llama.cpp or MLX on Apple silicon). One-sentence caption per slide, editable. | Immich's description field; makes 10 000 slides findable by words. |
| **Faces → people** | Already have YuNet; add an embedding model (ArcFace / SFace) and cluster across trays. Name a cluster once. | Immich people are the #1 way families browse. Push names as Immich faces/people when the API allows, otherwise as tags. |
| **Mount OCR** | Scan / photograph the mount (or read the scanner's frame edge). Handwritten dates, places, lab stamps ("KODAK · JUN 74"). | The single best dating signal there is. |
| **Location recognition** | Landmark retrieval (e.g. CLIP + a GeoNames / Wikimedia landmark index), OCR'd place names, and propagation inside a tray. Confidence shown; accept with one click. | Immich map view for decades-old photos. |
| **Date estimation** | Tray order already works (dated slides anchor the ones between them). Add: mount stamps, film stock (Kodachrome vs Ektachrome fade signature — the learned colour features already separate them), era cues from the VLM. | Slides land in the right year in Immich instead of the scan date. |
| **Tray-level propagation** | Anything confirmed on one slide (place, date, people, event name) is offered to its neighbours: "Apply 'Lake Garda, Aug 1978' to slides 12–31?" | This is what makes 10k slides tractable. |
| **Damage repair** | Dust & scratch detection from the scanner's IR-less scans (morphological + learned mask), inpaint; mould spot removal; Newton-ring reduction. | The biggest remaining quality gap after colour. |
| **Film-stock profiles** | Learn per-stock restore curves (Kodachrome holds up, Ektachrome goes magenta, Agfachrome goes cyan). Auto-detect the stock from colour features + mount type. | Better first guess → fewer edits per slide. |

**Plumbing for all of it:** a job queue with per-slide "insights" stored in `session.json`
(`g["insights"] = {"tags": [...], "caption": ..., "place": {...}, "date": {...}}`), each with a
source and confidence, an Insights section in the inspector, and a batch "review suggestions"
view per tray. Models downloaded on first use into the library folder, never bundled.

## 2. Round-trip with Immich

- **Pull back in.** Browse your Immich albums inside Slide Station, pick assets (including slides
  scanned years ago with other tools), and re-develop them: restore, crop, retag, re-date. Upload
  replaces the original asset (keep the old one in trash) and preserves album membership,
  favourites and faces.
- **Metadata sync.** Push date, description, tags, location and people as Immich metadata
  instead of only baking them into EXIF; pull edits made in Immich back.
- **Duplicates.** Before uploading, hash-match and CLIP-match against what's already in Immich
  ("this looks like a scan you uploaded in 2021 — replace it?").
- **Stacks.** Upload the untouched scan as a hidden stack member under the developed version, so
  nothing is ever lost.

## 3. iPad (and later: one native app for iPad and Mac)

Goal: plug the Slide N Scan into an iPad and let someone who isn't technical do a tray on their
own — import, look through, keep or skip, upload — with the detailed tools there for whoever
wants them.

**Feasibility, piece by piece**

| Piece | On iPad | Notes |
| --- | --- | --- |
| Reading the scanner | Yes, iPadOS mounts USB mass storage (FAT32/exFAT) in Files | The app gets the card through a folder picker once, keeps a security-scoped bookmark and notices when it's reachable again. There is no "drive mounted" event, so the app checks when it becomes active. **Verify first:** plug the scanner in, open Files. USB-C iPad strongly preferred; the scanner may need its own power. |
| Deleting from the card after upload | Yes | The same security scope grants write access. Keep today's re-hash-before-delete safety. |
| Bracket alignment + fusion | Port | Vision `VNTranslationalImageRegistrationRequest` aligns; Mertens fusion is ~300 lines of Metal / vImage (Laplacian pyramids). |
| Rotation, straighten | Better than today | Vision face detection replaces YuNet; `VNDetectHorizonRequest` gives a straighten suggestion for free. |
| Restore, curves, adjustments, crop | Port | Core Image filter chain + a small Metal kernel for per-channel curves; histograms via vImage. |
| Learning (k-NN) | Trivial | A few hundred numbers. |
| AI roadmap (§1) | Largely built in | Vision classification (tags), Live Text / `VNRecognizeTextRequest` (handwriting on mounts), on-device Foundation Models (captions) on Apple-Intelligence iPads, Core ML for faces. |
| Immich | Trivial | URLSession; the API facts in ARCHITECTURE.md §6 carry over. |
| Memory | Care needed | A 5-scan 22 MP stack peaks around 3 GB on the Mac today. On iPad: fuse on the GPU in half precision, in tiles; test on the actual iPad model. |

**Shape**

- `SlideKit` — a Swift package with the whole pipeline (import, grouping, fusion, restore,
  render, sessions, Immich), no UI. Parity-tested against the Python implementation with golden
  images, so both give the same result for the same slide.
- A SwiftUI app on the ProUI Swift components, with two faces:
  - **Simple mode** (default on iPad): one big "Import from scanner", then full-screen slides —
    swipe to keep, "Skip" and "Turn" buttons, a finish line with "Send to Immich". Auto-restore,
    auto-rotate and best-of-bracket do the rest. Immich settings arrive by scanning a QR code
    generated on the Mac, so nobody types an API key on the iPad.
  - **Studio mode**: today's tools (curves, adjust, crop, dates), for pencil and trackpad.
- Distribution: TestFlight (the same Apple Developer account as Mac signing), later the App Store.
- Later: the same SwiftUI app on the Mac could replace Electron + Python, leaving one codebase.
  Keep the Python app as the reference until the Swift one matches it.

**Status (2026-09-24):** `apple/` has SlideKit (the pipeline, parity-tested against Python on
synthetic slides), Simple mode end to end (import → keep/skip/turn → Immich, checked in the
simulator against `tests/fake_immich.py`) and a first Studio mode on the ProUI SwiftUI kit. See
`apple/README.md`. What's open: the real scanner on a real iPad (phase 1), Metal/half-precision
fusion for full-resolution memory, and in Studio: curves, crop, undo, learning. The ProUI template
apps (image editor, video editor, DAW…) had nothing to port beyond the kit itself.

**Phases**

1. *Spike (days):* scanner on the iPad in Files; a tiny app that picks the card, bookmarks it,
   notices reconnection, lists and copies scans.
2. *SlideKit:* port the pipeline with parity tests; run it in the simulator and on the device.
3. *Simple mode* end to end (import → keep/skip → Immich) — the version to hand over.
4. *Studio mode* with the ProUI Swift components.
5. Optional: the Mac on the same code; sync trays between devices (iCloud), so a tray started on
   the iPad can be finished on the Mac.

(The lighter alternative — the iPad as a browser client of the Mac server over the LAN — is still
cheap, but needs the Mac on, which defeats the "on her own" goal.)

## 4. Hosted Slide Station (for other people's Immich)

- **Shape:** a container that sits next to Immich (same docker-compose), not a SaaS that holds
  photos. Users drop folders (or a zip) in the browser; processing happens on their own server;
  output goes straight into their Immich via API key or OAuth.
- **Needed for that:** accounts mapped to Immich users (Immich OAuth), per-user libraries,
  resumable uploads (tus), a real job queue (Redis/RQ or SQLite-backed), GPU optional, and a
  settings page instead of `~/.slidestation/config.json`.
- **Then:** an Immich "external library" watcher (scan folders the user drops into a share), and
  eventually an Immich plugin/app if their plugin system lands.
- **Licensing check first:** ProUI is proprietary — a hosted/distributed version needs its licence
  terms confirmed (or the UI kit swapped) before shipping to other people.

## 5. Capture

- **Scanner automation.** An ESP32 button macro: press the scanner's buttons at
  three exposures per slide automatically, so bracketing costs nothing.
- **Camera rig mode.** A DSLR/mirrorless + macro lens + light panel beats the Slide N Scan by a mile
  (real RAW, 24 MP+). Tethered capture (gphoto2), auto-advance with a carousel projector mechanism,
  RAW decode (rawpy) into the same pipeline. The whole app already works per "scan", so a camera is
  just another source.
- **Mount detection.** Detect the mount edge precisely (not just "dark border") and straighten to it
  automatically.

## 6. The tool itself

- Local adjustments (brush / radial / graduated) for dodging a dark foreground or a blown sky.
- Presets and "develop like slide 12" across trays.
- Loupe and 1:1 zoom on the full-resolution render.
- Batch review grid: 4×4 slides at once for the quick "all good" pass.
- Stats: slides per hour, trays remaining, projected finish date for the 10 000.

---

### Suggested order

Done so far: undo, aligned split compare, best-of-bracket, tray-order date estimation.

1. §0 "Open now" — tests first, since a lot changed quickly
2. iPad spike (§3 phase 1) — cheap, and it decides a lot
3. Insights plumbing + tags (on the Mac with CLIP, or straight into SlideKit with Vision if the
   iPad goes ahead)
4. SlideKit + Simple mode on the iPad
5. Faces → people, location, mount OCR
6. Immich round-trip (pull back, metadata sync, stacks)
7. VLM captions, damage repair, film-stock profiles
8. Hosted container
