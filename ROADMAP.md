# Roadmap — where Slide Station can go

Today it is a very good single-purpose tool: card → restored, upright, grouped slides → Immich.
The scans hold far more than pixels, though. A tray is a *story*: one trip, one summer, one
family, in order, often with handwriting on the mounts. Everything below builds on that, roughly
in the order it pays off. All of it runs locally unless it says otherwise — a recent laptop is
plenty.

---

## 0. Open now

Built but never run where it matters — the first things to check:

- **Swift parity.** Everything since learned tone curves was ported to SlideKit without a Swift
  toolchain: learned curves and per-stock learning, "Date a range…", mount detection, dust, mould
  and Newton-ring repair, local adjustments, the blown-out restore fix, the dedupe fix. Run `swift test` on a Mac (golden fixtures are in place) and
  try the new pieces in the simulator.
- **Against a real Immich** (only the mock so far): stacks, `PUT /assets/{id}` for dates, captions
  and places (does a naive `dateTimeOriginal` land on the right day?), v3.2 search paging, tags,
  smart search for look-alikes, and the "no embedding yet" error text.
- **On real slides** (only synthetic so far): tag and caption quality, the duplicate threshold
  (0.93), the film-stock heuristic's confidences, sign OCR, face clustering, mount detection.
- **Hardware:** the camera rig's tethered capture (a stand-in script only) and RAW files from a
  real camera; the container on a real server next to Immich.
- **Browsers:** Firefox and Safari themselves (their code path was only simulated in Chromium);
  Safari on iPad / iPhone for the large-scan fallback.

Small known items:

- Publish the browser version: confirm the ProUI licence terms for a hosted copy, then run the
  "Web version" workflow (GitHub Pages).

## 1. Understand the tray

Done: insights plumbing (suggestions with source and confidence, accept / dismiss, review a tray,
propagate to neighbours), scene tags (CLIP), captions (Florence-2), faces → people (SFace), places
(GeoNames, sign OCR, neighbours), film stock (fade signature / k-NN) with era hints for dating,
near-duplicates / split / merge hints / scenes (CLIP embeddings), dust & scratch, mould and
Newton-ring repair. All of it but captions also runs in the browser version (onnxruntime-web).
ARCHITECTURE §4c, §5a–5f.

Left:

| Idea | How | Why it matters |
| --- | --- | --- |
| **Captions in the browser version** | Florence-2 is 276 MB per browser and well over 10 s a slide in single-threaded WebAssembly; worth it with WebGPU, or a smaller captioner. | The last suggestion the no-install version lacks. |
| **Mount OCR** | The mount itself isn't in the scan: photograph or scan the mounts (or a scanner that images the frame edge), then OCR handwritten dates / lab stamps ("KODAK · JUN 74") into the date suggestion. | Still the single best dating signal. |
| **Landmarks** | CLIP zero-shot over a landmark list was too overconfident to ship; needs a calibration set of real slides (or a retrieval index) before it can suggest places honestly. | Immich map view for places without signs. |
| **Era cues** | Florence rarely says anything datable; a model or prompt that does (cars, clothes, signage). | Dates for trays without dated slides. |
| **Eyes open** | Best-of-burst by blink detection needs an eye-state model on top of the face boxes. | "Keep the best" for portraits. |

## 2. Round-trip with Immich

Done: pull photos back in from albums and replace them on upload, metadata sync both ways (date,
caption, place, tags), exact-duplicate check before upload, look-alikes already in Immich, stacks
with the untouched scans (ARCHITECTURE §6a, §5e). Nothing open beyond checking it against a real
server (§0).

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
`apple/README.md`. Studio now matches the web app (curves, crop & straighten, undo, split, learning,
card cleanup, locked slides). Full-resolution export: 1 s / 1.1 GB for a 20 MP bracket. What's open:
the real scanner on a real iPad (phase 1) and measuring memory there. The ProUI template apps
(image editor, video editor, DAW…) had nothing to port beyond the kit itself.

**Phases left** (SlideKit, Simple mode and Studio mode are done, see the status above)

1. *On the device (days):* the scanner on the iPad in Files — the app picks the card, bookmarks
   it, notices reconnection, lists and copies scans; then a real tray through Simple mode, and
   memory measured on that iPad model.
2. Optional: the Mac on the same code; sync trays between devices (iCloud), so a tray started on
   the iPad can be finished on the Mac.

(The lighter alternative — the iPad as a browser client of the Mac server over the LAN — is still
cheap, but needs the Mac on, which defeats the "on her own" goal.)

## 4. Hosted Slide Station

Done: the browser version (static site, no backend — ARCHITECTURE §4c/§4d) and the container next
to Immich (`Dockerfile`, `docker-compose.example.yml`: folder uploads from the browser, optional
accounts per Immich user with sign-in rate limits, key re-checks, quotas, resumable jobs and a
server-wide render limit — §4e). Left: an Immich plugin / app if their plugin system lands; an
"external library" watcher (folders dropped into a share).

## 5. Capture

Done: mount detection and straighten-to-mount; RAW files and tethered capture through gphoto2
(ARCHITECTURE §4f). Left, both hardware:

- **Scanner automation.** An ESP32 button macro: press the Slide N Scan's buttons at three
  exposures per slide automatically, so bracketing costs nothing.
- **Carousel auto-advance** for the camera rig: a projector mechanism stepping the tray between
  captures.

## 6. The tool itself

Done: local adjustments (graduated, radial, brush), presets and "develop like", 1:1 zoom and loupe,
the review grid, stats. Nothing open.

---

### Suggested order

1. §0: run the Swift tests, try a real Immich and a real tray — a lot was built on synthetic data
2. The iPad on the device (§3)
3. Publish the browser version (licence check first)
4. Mount OCR once there are mount photos; landmarks once there's a calibration set
5. Scanner automation (ESP32)
