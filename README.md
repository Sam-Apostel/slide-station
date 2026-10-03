# Slide Station

Digitise 35mm slides without the tedium. Import a tray from the Kodak Slide N Scan, and Slide
Station blends the brackets, turns the slides upright and brings faded colour back. Check them
with a few keys, and they go to [Immich](https://immich.app) with dates, places and people.

**[slide-station.sams.land](https://slide-station.sams.land)**

- **[Download for Mac](https://slide-station.sams.land/download/mac)** (Apple silicon). It
  updates itself.
- **[Try it in your browser](https://slide-station.sams.land/app/)**. Nothing to install.
- **iPhone, iPad, Mac and Apple TV**: native apps in beta, with a slideshow of your Immich albums,
  a Home Screen widget and the TV. [Join the TestFlight waitlist](https://slide-station.sams.land/#testflight).
- **[Run it on your server](docs/self-hosting.md)** next to Immich, for the whole household.

## What it does

- Groups repeated scans of one slide and blends them into one photo with more detail
- Turns slides upright from faces and skies, and leaves them alone when it isn't sure
- Restores faded colour, and learns from your corrections
- Straightens slides that sit crooked in their mount; removes dust, scratches, mould and Newton rings
- Local adjustments: graduated filters, radials and a brush
- Recognises people across all your trays, and syncs them with Immich's People page
- Suggests tags, captions, places and film stock, all on your own computer
- Uploads each tray to an Immich album, and cleans the scanner's card only once everything is safe

## Documentation

The docs are in [`docs/`](docs/) and on [the website](https://slide-station.sams.land/docs):
[getting started](docs/getting-started.md), [working through a tray](docs/workflow.md),
[Immich](docs/immich.md), [suggestions](docs/suggestions.md),
[people and places](docs/people-and-places.md), [the browser version](docs/browser.md),
[iPhone, iPad, Mac and Apple TV](docs/apple-apps.md),
[self-hosting](docs/self-hosting.md) and [tips](docs/tips.md).

Found a problem? [Open an issue](https://github.com/Sam-Apostel/slide-station/issues).

## Development

A Python backend (`slidestation/`) and a React UI (`frontend/`), wrapped in Electron for the Mac
(`desktop/`). There's also a browser-only build of the same UI and native apps for iPhone, iPad,
Mac and Apple TV (`apple/`).
[`ARCHITECTURE.md`](ARCHITECTURE.md) explains how it all fits together, and
[`ROADMAP.md`](ROADMAP.md) what's next.

```bash
uv run --python 3.12 python -m slidestation           # the app on http://localhost:8765
cd frontend && npm install && npm run dev             # the UI with hot reload
uv run --python 3.12 pytest tests -q                  # tests
```

## Licence

MIT for this project's code, see [`LICENSE`](LICENSE). Third-party components, including the ProUI
files under `frontend/src/components/ui`, are covered by [`NOTICE.md`](NOTICE.md): they are not
licensed for reuse outside this project.
