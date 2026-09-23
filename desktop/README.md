# Slide Station — desktop app

An Electron shell around the same Python server and React UI the browser version uses. It adds
what a browser tab can't do:

- **A real Mac window.** ProUI's `ProTitlebar` is the window's top edge and drag region. macOS
  draws its own traffic lights over it (`trafficLights={false}`); on Windows and Linux the native
  caption buttons sit on its right end. The window remembers its size and position.
- **Native menus** with every action and its shortcut. The single-key review keys (→, Space, R,
  C, X, M…) are *shown* in the Slide menu but still handled by the UI, so typing in a text field
  never triggers them. ⌘N new tray, ⌘I import, ⇧⌘O import folder, ⌘U upload, ⇧⌘R show files,
  ⌘E eject, ⌘, settings.
- **View → Filmstrip / Inspector / Focus on the Photo** (⌥⌘1, ⌥⌘2, ⌥⌘F), also as toggles in the
  titlebar. The layout is remembered.
- **Folder pickers** instead of typing paths (New tray → "A folder on this Mac", Settings →
  Library folder), and **drop a folder of scans onto the window** to start a tray from it.
- **Dock** progress bar while a job runs and a badge with the slides left to review.
- **Notifications** when an import, upload or card cleanup finishes (or fails) while you're in
  another app, and when the scanner is plugged in with new scans. Click one to import.
- **Stays awake** during imports and uploads, and asks before quitting mid-job.

## Run it

```bash
cd desktop && npm install
npm start          # builds the UI, starts the server with uv, opens the window
```

The first start installs uv if needed, then Python 3.12 and the image libraries (about a minute),
exactly like `Slide Station.command`. `SLIDESTATION_PYTHON=../.venv/bin/python npm start` skips uv.

UI development with hot reload: `npm run dev` in `frontend/`, then `npm run dev` here (the window
loads Vite on :5173; Vite proxies `/api` to the server on :8765).

## Build a .app / .dmg

```bash
npm run dist       # → desktop/dist/Slide Station-<version>.dmg (build on a Mac)
```

The Python sources are bundled (`extraResources` → `Resources/backend`); the Python environment is
created on first launch in `~/Library/Application Support/Slide Station/python`, because a signed
app bundle must not change. The build is unsigned: on first open, right-click → Open. The
scanner still needs the "Removable Volumes" permission, now asked for Slide Station itself rather
than Terminal.

## How it fits together

```
main.cjs      picks a free port, starts `python -m slidestation` (SLIDESTATION_DESKTOP=1, no
              browser), waits for /api/state, loads it; menus, dock, notifications, power
preload.cjs   the bridge: window.slideStation (typed in frontend/src/lib/desktop.ts)
```

The UI feature-detects `window.slideStation`, so the same build runs in a browser tab unchanged.
The server only listens on 127.0.0.1, and the window refuses to navigate anywhere else; IPC
handlers only answer the app's own origin.
