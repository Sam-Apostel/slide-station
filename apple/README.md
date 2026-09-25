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

## Simple and Studio

- **Simple** (default everywhere): full-screen slides, swipe left or Keep, Skip, Turn, Back; hold
  to see the scan before restoring; a finish line with "Send N to Immich".
- **Studio** (iPad, regular width; toggle in the header or Settings): the web app's layout and
  skin — slide mounts that gild when developed, the tray gauge, Frame (rotate, crop & straighten),
  Tone curve (per channel, Fit to data), Adjust (painted rails, white-balance pad, eyedropper),
  Details, Tray, undo / redo, Before and aligned Split, Develop / Upload / Clean card. Hardware keys
  match the desktop app (← → Space R X B Y K W F ⌘Z 1–9). Views in `App/Views/Studio/`.

## Testing in the simulator without tapping

DEBUG builds read a few launch variables (`App/DebugLaunch.swift`), e.g.

```bash
SIMCTL_CHILD_SS_CARD_PATH=/path/to/card SIMCTL_CHILD_SS_AUTOIMPORT="Test tray" SIMCTL_CHILD_SS_OPEN=1 xcrun simctl launch booted dev.slidestation.ios
```

`tests/fake_immich.py` works as the Immich server (`SS_IMMICH_URL=http://127.0.0.1:2283`,
`SS_IMMICH_KEY=testkey`, `SS_UPLOAD=1`).

## Known limits

- The pixel pipeline is plain Swift on all CPU cores. Full-resolution export of a 3-scan 20 MP
  bracket: 1.0 s and a 1.08 GB peak on an M-series Mac (it was 5.8 s / 2.4 GB):
  `SLIDEKIT_PERF=1 swift test -c release --filter PerfTests`. Half-precision pyramids would roughly
  halve the peak again if an older iPad needs it — measure on the real device first.
- Card access is only verified in the simulator with a folder in Files. Phase 1 of the roadmap
  (the real scanner on the real iPad, over USB-C) still needs doing.
