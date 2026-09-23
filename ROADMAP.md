# Roadmap — where Slide Station can go

Today it is a very good single-purpose tool: card → restored, upright, grouped slides → Immich.
The scans hold far more than pixels, though. A tray is a *story*: one trip, one summer, one
family, in order, often with handwriting on the mounts. Everything below builds on that, roughly
in the order it pays off. All of it runs locally unless it says otherwise — a recent laptop is
plenty.

---

## 1. Understand the tray (local models, no cloud)

The laptop does the work while you develop; results are *suggestions* shown in the inspector,
never silently applied, and every one is learned from like the colour settings are.

| Idea | How | Why it matters |
| --- | --- | --- |
| **Smart grouping 2.0** | CLIP / SigLIP image embeddings next to today's structural signature. Detects brackets *and* near-duplicates (the same scene shot twice), and splits "scenes" inside a tray. | Fewer wrong merges; "keep the best of these 3" becomes one click. |
| **Best-of-bracket / best-of-burst** | Sharpness (Laplacian variance), exposure clipping, face-eyes-open score per scan. | Picks the default active scan in a stack instead of fusing a blurred one in. |
| **Scene tags** | Zero-shot CLIP labels (beach, snow, wedding, birthday, church, car, dog…), plus OCR of signs. | Searchable in Immich as tags; lets you filter the filmstrip. |
| **Descriptions** | Small local VLM (e.g. Qwen2-VL / Moondream / LLaVA via llama.cpp or MLX on Apple silicon). One-sentence caption per slide, editable. | Immich's description field; makes 10 000 slides findable by words. |
| **Faces → people** | Already have YuNet; add an embedding model (ArcFace / SFace) and cluster across trays. Name a cluster once. | Immich people are the #1 way families browse. Push names as Immich faces/people when the API allows, otherwise as tags. |
| **Mount OCR** | Scan / photograph the mount (or read the scanner's frame edge). Handwritten dates, places, lab stamps ("KODAK · JUN 74"). | The single best dating signal there is. |
| **Location recognition** | Landmark retrieval (e.g. CLIP + a GeoNames / Wikimedia landmark index), OCR'd place names, and propagation inside a tray. Confidence shown; accept with one click. | Immich map view for decades-old photos. |
| **Date estimation** | Combine: mount stamps, film stock (Kodachrome vs Ektachrome fade signature — the learned colour features already separate them), fashion/car/era cues from the VLM, and *tray order*: dated slides anchor the undated ones between them. | Slides land in the right year in Immich instead of the scan date. |
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

## 3. Edit anywhere: phone and iPad

The UI is already a web app served by the local server, so the cheapest version is almost free:

1. **LAN / Tailscale mode** — bind to the network with a pairing code, responsive layout (inspector
   as a bottom sheet, filmstrip as a horizontal strip, swipe = next, tap-and-hold = before). Develop
   slides on the iPad on the couch while the laptop does the heavy lifting.
2. **PWA** — installable, offline queue of edits.
3. **Pencil on iPad** — the crop tool and a retouch brush are natural with a pencil.

The server already renders every preview, so the tablet never needs the full-resolution files.

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

- **Scanner automation.** The ESP32 button macro from the handoff: press the scanner's buttons at
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
- Split before/after (aligned: render "before" through the same geometry).
- Loupe and 1:1 zoom on the full-resolution render.
- Undo history per slide (params are tiny: keep every version).
- Batch review grid: 4×4 slides at once for the quick "all good" pass.
- Stats: slides per hour, trays remaining, projected finish date for the 10 000.

---

### Suggested order

1. Undo history + aligned split compare (small, makes everything else safer)
2. Insights plumbing + CLIP tags + best-of-bracket (one model, big wins)
3. Date estimation with tray propagation, mount OCR
4. Faces → people, location
5. LAN/iPad mode
6. Immich round-trip (pull back, metadata sync, stacks)
7. VLM captions, damage repair, film-stock profiles
8. Hosted container
