# Slide Station for iPhone, iPad, Mac and Apple TV

The native apps from ROADMAP.md §3. Plug the Slide N Scan into an iPad, import a tray, keep / skip /
turn, send it to Immich, no Mac needed; the same app runs natively on the Mac and on an iPhone
(the web app's phone layouts). And for everyone an album is shared with: Immich albums as a
slideshow, a Home Screen widget and an Apple TV app (`docs/apple-apps.md` is the user guide).

```
apple/
  project.yml        XcodeGen spec (the .xcodeproj and Support/Info-*.plist are generated)
  App/               iPhone, iPad and Mac: AppModel (all state + actions), Simple, Studio, the
                     phone layouts (Views/Compact), Albums (Views/Albums); Platform.swift for the Mac
  Widget/            the Home Screen widget: a slide from the followed albums, round all of them
  TV/                Apple TV: the albums and the slideshow
  SlideKit/          Swift package. SlideKit: the whole pipeline, no UI, parity-tested against the
                     Python app. SlideAlbums: Immich albums, the keychain, the image cache, the
                     slideshow (shared by the apps, the widget and the TV)
  Vendor/ProUI/      ProUI SwiftUI source, trimmed to what the app uses (see NOTICE.md)
  Support/           entitlements
  Tools/             make_icons.py: every platform's icons from Tools/icon-art.png
  scripts/           testflight.sh: archive and upload
```

| Target | Platform | Bundle id |
| --- | --- | --- |
| SlideStation (+ SlideStationWidget) | iPhone, iPad | `land.sams.slide-station` (`.widget`) |
| SlideStationMac | macOS 14+, sandboxed | `land.sams.slide-station` |
| SlideStationTV | tvOS 17+ | `land.sams.slide-station` |

One bundle id everywhere (universal purchase). The Immich server and key are one keychain item in
the access group `$(AppIdentifierPrefix)land.sams.slide-station`, synced with iCloud Keychain, so
the widget reads it and a TV picks it up from the phone. The widget shares the followed albums and
its cache with the app through the App Group `group.land.sams.slide-station`.

## Build and run

```bash
brew install xcodegen
```

```bash
cd apple && xcodegen && open SlideStation.xcodeproj
```

Schemes: `SlideStation` (iPhone and iPad, with the widget), `SlideStationMac`, `SlideStationTV`.
SlideKit's and SlideAlbums' tests run on the Mac:

```bash
cd apple/SlideKit && swift test
```

TestFlight: `apple/scripts/testflight.sh` archives all three and uploads them, signed with the
Apple account in Xcode (or an App Store Connect API key in `ASC_KEY_ID` / `ASC_ISSUER_ID` /
`ASC_KEY_PATH`); the build number is the UTC time. `.github/workflows/apple.yml` runs it for every
push to main that touches `apple/`.

The golden fixtures in `SlideKit/Tests/SlideKitTests/Golden` are synthetic slides run through
`slidestation/imaging.py`; regenerate them with
`uv run --python 3.12 python apple/SlideKit/Tests/make_golden.py` after changing the Python pipeline.

## How it maps to the Python app

| Python | SlideKit |
| --- | --- |
| `store.Session`, `session.json` | `Tray` / `Slide` — same JSON field names, so a tray folder reads in both |
| `workflow.update_session` | `Library.update(_:_:)` (an actor: reload, apply, save) |
| `workflow.import_scans` | `Importer` — SHA-1 verified copies, `imported.json` dedupe, grouping, best of bracket, rotation |
| `imaging.fuse` (AlignMTB + MergeMertens) | `Fusion` — Vision translational registration + Mertens with OpenCV's exact pyramids |
| `imaging.develop` and friends | `Develop`, `Curves` — function by function, same maths |
| `imaging.detect_mount`, `mount_crop`, `repair_dust` | `MountAndDust.swift` (`Develop.detectMount`, `mountCrop`, `repairDust`), `MountEdge` — written without a Swift toolchain at hand: run `swift test` |
| `imaging.repair_mould`, `repair_newton` | `MouldAndRings.swift` (`Develop.repairMould`, `mouldMask`, `repairNewton`, `newtonWeight`) — likewise uncompiled: run `swift test` |
| YuNet faces | Vision face rectangles (roll-filtered per rotation); the sky heuristic is unchanged |
| `render_export`, `finish_session`, `immich.py` | `Uploader`, `Export`, `ImmichClient` (v1/v2 vs v3 field rules kept) |
| `learning.py` | `Learning` — same features, k-NN and `learning.json` (parity-tested) |
| `server._remember` / undo | `Slide.remember`, `Slide.step` — same `history` format, drags coalesce |
| `cleanup_card`, `sync_locks`, keep originals off | `Originals` — same safety rules; card paths rebuilt from the card's root |
| scanner under `/Volumes` | `CardBookmark` + `CardSource`: the card is picked once in Files, re-checked when the app becomes active |

## Sharing a library with the Mac app

Settings → Library → "Use a folder in Files…" points the app at a library folder (the one with
`sessions/` in it), e.g. the Mac app's library moved to iCloud Drive. `Library` keeps each
`session.json` as read (`JSONValue`) and writes back through `JSONValue.merge`, so fields only the
Python app knows (insights, places, Immich stacks, `export`…) survive a save here; develop settings
stay floats. `renderKey` and `metaKey` are byte-for-byte `store.render_key` / `store.meta_key`, so
both apps agree on what's uploaded. Cloud-only files are fetched with `LocalFiles` (coordinated
reads) before a tray opens. Check a real library with
`SLIDEKIT_LIBRARY=~/Pictures/Slide\ Station swift test --filter LibraryInteropTests`.

Not ported yet: a locked slide shows the local render rather than fetching Immich's own preview.

## Albums, the widget and the TV (`SlideAlbums`)

- `AlbumClient` reads Immich v1.118 through v3: own albums plus `?shared=true`, an album's photos
  from `GET /albums/{id}` (v1/v2) or `POST /search/metadata` paged by `nextPage` / `nextCursor`
  (v3), images as thumbnail / preview / fullsize with the original as the fallback. Needs
  `album.read`, `asset.read`, `asset.view`, `asset.download`.
- `AlbumLibrary` (observable): the connection, all albums, the followed ones and their photos.
  Albums shared by another account are followed by themselves until the user chooses.
- Photos sort oldest first, which is tray order (`Uploader.photoDate`: noon plus a minute per slide).
  `ImmichDate.text` reads that back: noon on the 1st is "August 1978", on 1 January "1978".
- `Rotation`: the widget's way round every photo once, in a seeded shuffle kept in the App Group,
  six entries 45 minutes apart per timeline. Images are written at the widget's size (its memory is
  ~30 MB).
- `SlideshowView`: cross-fade and a slight drift over a blurred copy of the photo; touch, keys and
  the Siri Remote. iPhone and iPad use `preview`, the Mac and TV `fullsize` (3200 / 3840 px).

## Simple and Studio

- **Simple** (default on iPhone and iPad): full-screen slides, swipe left or Keep, Skip, Turn, Back; hold
  to see the scan before restoring; a finish line with "Send N to Immich".
- **Studio** (default on the Mac; toggle in the header or Settings): at regular width the web app's layout and
  skin — slide mounts that gild when developed, the tray gauge, Frame (rotate, crop & straighten),
  Tone curve (per channel, Fit to data), Adjust (painted rails, white-balance pad, eyedropper),
  Details, Tray, undo / redo, Before and aligned Split, Develop / Upload / Clean card. Hardware keys
  match the desktop app (← → Space R X B Y K W F ⌘Z 1–9). Views in `App/Views/Studio/`.
- **Studio on a phone** (compact width, `App/Views/Compact/`): the web app's phone layouts
  (`frontend/src/components/compact.tsx`). Upright: the photo (swipe, double-tap to zoom,
  long-press menu), the row of slides or the open tool's panel, the tool row, ‹ Skip Turn Develop.
  On its side (compact height): the photo, the panel beside it, the tools in a rail. The tools are
  the inspector's sections (`FrameSection`, `CurveSection`, `AdjustPanel`, `MetaFields`, `TrayFields`,
  `UploadControls`) one at a time, plus Slides (the filmstrip) and Scans. Crop takes the screen.

## Testing in the simulator without tapping

DEBUG builds read a few launch variables (`App/DebugLaunch.swift`), e.g.

```bash
SIMCTL_CHILD_SS_CARD_PATH=/path/to/card SIMCTL_CHILD_SS_AUTOIMPORT="Test tray" SIMCTL_CHILD_SS_OPEN=1 xcrun simctl launch booted land.sams.slide-station
```

`tests/fake_immich.py` works as the Immich server (`SS_IMMICH_URL=http://127.0.0.1:2283`,
`SS_IMMICH_KEY=testkey`, `SS_UPLOAD=1`; the TV app reads the first two too, and `SS_PLAY=1` starts
its slideshow). `xcrun simctl openurl booted slidestation://photo/<album>/<photo>` is what the
widget opens.

## Known limits

- The pixel pipeline is plain Swift on all CPU cores. Full-resolution export of a 3-scan 20 MP
  bracket: 1.0 s and a 1.08 GB peak on an M-series Mac (it was 5.8 s / 2.4 GB):
  `SLIDEKIT_PERF=1 swift test -c release --filter PerfTests`. Half-precision pyramids would roughly
  halve the peak again if an older iPad needs it — measure on the real device first.
- Card access is only verified in the simulator with a folder in Files. Phase 1 of the roadmap
  (the real scanner on the real iPad, over USB-C) still needs doing.
