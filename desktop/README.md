# Slide Station — desktop app

An Electron shell around the same Python server and React UI the browser version uses. It adds
what a browser tab can't do: a real Mac window with native menus, folder pickers, drag-and-drop,
a Dock progress bar and badge, notifications (import finished, scanner plugged in), staying awake
during long jobs, and updating itself.

Users download the signed build from <https://slide-station.sams.land>; this is for working on it.

## Run it from source

```bash
cd desktop && npm install
npm start          # builds the UI, starts the server with uv, opens the window
```

The first start installs uv if needed, then Python 3.12 and the image libraries (about a minute).
`SLIDESTATION_PYTHON=../.venv/bin/python npm start` skips uv.

UI development with hot reload: `npm run dev` in `frontend/`, then `npm run dev` here (the window
loads Vite on :5173; Vite proxies `/api` to the server on :8765).

`npm run dist` builds an unsigned `.dmg` into `desktop/dist/`.

## How it fits together

```
main.cjs      picks a free port, starts `python -m slidestation` (SLIDESTATION_DESKTOP=1, no
              browser), waits for /api/state, loads it; menus, dock, notifications, power
preload.cjs   the bridge: window.slideStation (typed in frontend/src/lib/desktop.ts)
updater.cjs   checks GitHub Releases, downloads in the background, installs when idle
```

The UI feature-detects `window.slideStation`, so the same build runs in a browser tab unchanged.
The server only listens on 127.0.0.1, and the window refuses to navigate anywhere else; IPC
handlers only answer the app's own origin.

In a packaged app the Python sources ship in `Resources/backend`, and the Python environment is
created on first launch in `~/Library/Application Support/Slide Station/python`, because a signed
bundle must not change.

## Releases and updates

Every push to `main` (except docs-only changes) becomes a signed, notarised release on GitHub
Releases (`.github/workflows/release.yml` → `scripts/release-mac.sh`), versioned
`1.0.<run number>`.

The app checks for updates 30 s after launch, every hour and after waking from sleep, and
downloads a newer version in the background. It installs only when you're not working (no job
running and no input for 5 minutes), then restarts and says so in a notification. **Check for
Updates…** in the app menu does it right away. Development runs (`npm start`) never update.
