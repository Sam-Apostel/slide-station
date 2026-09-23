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
app bundle must not change. Without the setup below the build is unsigned: on first open,
right-click → Open. The scanner still needs the "Removable Volumes" permission, now asked for
Slide Station itself rather than Terminal.

## Signing and notarising

A signed, notarised build opens with a normal double-click on any Mac, keeps its "Removable
Volumes" permission across updates (macOS ties it to the signature), and is a prerequisite for
auto-update later. Everything in the repo is ready (`build/entitlements.mac.plist`, hardened
runtime, `npm run release:mac`); what's left needs your Apple account and can't be scripted.

### One-time setup (about 20 minutes plus Apple's enrolment wait)

1. **Apple Developer Program.** Enrol at <https://developer.apple.com/programs/enroll/>
   (99 USD/year; as an individual, or an organisation with a D-U-N-S number). You need the
   **Account Holder** role for step 2. Note your **Team ID**: developer.apple.com → Account →
   Membership details (10 characters, e.g. `A1B2C3D4E5`).

2. **"Developer ID Application" certificate** — this signs the app.
   - Easiest: Xcode → Settings → Accounts → add your Apple ID → select the team →
     *Manage Certificates…* → **+** → **Developer ID Application**. Xcode puts the certificate and
     its private key in your login keychain.
   - Check: `security find-identity -v -p codesigning` lists
     `Developer ID Application: Your Name (TEAMID)`.
   - Back up the private key: Keychain Access → My Certificates → right-click it → Export →
     `.p12` with a password, stored in your password manager. Losing it means making a new one;
     signing from another machine or CI uses this file (`CSC_LINK=/path/to.p12`,
     `CSC_KEY_PASSWORD=…`).

3. **Notarisation credentials** — lets `notarytool` submit builds to Apple. Pick one:
   - **Keychain profile (recommended for your Mac).** Create an app-specific password at
     <https://account.apple.com> → Sign-In and Security → App-Specific Passwords, then store it
     once, so no secret ever sits in a shell or file:
     ```bash
     xcrun notarytool store-credentials slide-station --apple-id you@example.com --team-id A1B2C3D4E5
     ```
     (it prompts for the app-specific password). Afterwards: `export APPLE_KEYCHAIN_PROFILE=slide-station`.
   - **App Store Connect API key (for CI).** App Store Connect → Users and Access → Integrations →
     Team Keys → **+**, role *Developer*; download the `.p8` (only possible once) and note the
     Key ID and Issuer ID. Then `APPLE_API_KEY=/path/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX
     APPLE_API_ISSUER=<uuid>`.
   - **Apple ID + app-specific password in the environment** (`APPLE_ID`,
     `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) also works, but leaves the password in your
     shell history / env; prefer the keychain profile.

### Every release

```bash
cd desktop
export APPLE_KEYCHAIN_PROFILE=slide-station   # or the API-key variables
npm version patch                              # bumps the version shown in the DMG name / About
npm run release:mac
```

`scripts/release-mac.sh` checks the certificate and credentials before building (so a missing
piece fails in seconds, not after a 5-minute build), runs `electron-builder` — which signs every
binary with the hardened runtime, submits the app to Apple's notary service, waits (usually 1–5
minutes) and staples the ticket — then verifies the result with `codesign`, `spctl` (the same check
Gatekeeper does) and `stapler`. The DMG itself is left unsigned on purpose: electron-builder
advises against it, and Gatekeeper checks the notarised app inside.

### When something goes wrong

- *"no Developer ID Application certificate"* — step 2, or the key isn't in the login keychain
  (a certificate without its private key doesn't count: re-download from Xcode on the Mac that
  created it, or import the `.p12`).
- *Notarisation "Invalid"* — `xcrun notarytool log <submission-id> --keychain-profile slide-station`
  says which file failed; usually a binary that wasn't signed with the hardened runtime.
- *App crashes on launch after signing (arm64)* — the entitlements file wasn't applied; check
  `codesign -d --entitlements - "dist/mac-arm64/Slide Station.app"` shows `allow-jit`.
- *Intel Macs* — builds are for the architecture you build on. For both:
  `npx electron-builder --mac --universal` (the Python side is per-machine anyway).

### Not done yet

Auto-update needs a place to publish releases (e.g. GitHub Releases: `"publish": {"provider":
"github"}`, a `zip` target next to `dmg`, and `electron-updater` in `main.cjs`). That only works
once builds are signed, so it's the natural next step after the first signed release.

## How it fits together

```
main.cjs      picks a free port, starts `python -m slidestation` (SLIDESTATION_DESKTOP=1, no
              browser), waits for /api/state, loads it; menus, dock, notifications, power
preload.cjs   the bridge: window.slideStation (typed in frontend/src/lib/desktop.ts)
```

The UI feature-detects `window.slideStation`, so the same build runs in a browser tab unchanged.
The server only listens on 127.0.0.1, and the window refuses to navigate anywhere else; IPC
handlers only answer the app's own origin.
