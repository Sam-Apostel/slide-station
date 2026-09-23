# Slide Station for iPad and iPhone

The native app from ROADMAP.md §3: plug the Slide N Scan into an iPad, import a tray, keep / skip /
turn, send it to Immich — no Mac needed. One universal SwiftUI app (iOS 17+).

```
apple/
  project.yml        XcodeGen spec (the .xcodeproj is generated, not committed)
  App/               the app: AppModel (all state + actions), Simple and Studio views
  SlideKit/          Swift package, no UI: the whole pipeline, parity-tested against the Python app
  Vendor/ProUI/      ProUI SwiftUI source, trimmed to what the app uses (see NOTICE.md)
```

## Build and run

```bash
brew install xcodegen
```

```bash
cd apple && xcodegen && open SlideStation.xcodeproj
```

For a device, `export DEVELOPMENT_TEAM=<team id>` before `xcodegen`. SlideKit's tests run on the Mac:

```bash
cd apple/SlideKit && swift test
```

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
| YuNet faces | Vision face rectangles (roll-filtered per rotation); the sky heuristic is unchanged |
| `render_export`, `finish_session`, `immich.py` | `Uploader`, `ImmichClient` (v1/v2 vs v3 field rules kept) |
| scanner under `/Volumes` | `CardBookmark` + `CardSource`: the card is picked once in Files, re-checked when the app becomes active |

Not ported yet: learning (k-NN suggestions), curves and crop editors (the pipeline supports both),
undo, card cleanup, keep-originals off / locked slides' Immich previews.

## Simple and Studio

- **Simple** (default everywhere): full-screen slides, swipe left or Keep, Skip, Turn, Back; hold
  to see the scan before restoring; a finish line with "Send N to Immich".
- **Studio** (iPad, regular width; toggle in the header or Settings): filmstrip | stage |
  inspector on ProUI — histogram, Restore / Light / Colour sliders, rotation, bracket scans (1–9),
  dates and captions. Hardware keys match the desktop app.

## Testing in the simulator without tapping

DEBUG builds read a few launch variables (`App/DebugLaunch.swift`), e.g.

```bash
SIMCTL_CHILD_SS_CARD_PATH=/path/to/card SIMCTL_CHILD_SS_AUTOIMPORT="Test tray" SIMCTL_CHILD_SS_OPEN=1 xcrun simctl launch booted dev.slidestation.ios
```

`tests/fake_immich.py` works as the Immich server (`SS_IMMICH_URL=http://127.0.0.1:2283`,
`SS_IMMICH_KEY=testkey`, `SS_UPLOAD=1`).

## Known limits

- The pixel pipeline is plain Swift on Float buffers (CPU). Previews are fast (a 13-scan synthetic
  tray imports in ~5 s in the simulator), but a full-resolution 22 MP bracket needs ~1 GB while
  fusing. Next: half-precision, tiled Metal fusion, as the roadmap says — and test on the real iPad.
- Card access is only verified in the simulator with a folder in Files. Phase 1 of the roadmap
  (the real scanner on the real iPad, over USB-C) still needs doing.
