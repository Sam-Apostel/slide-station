// Auto-update: new versions are published to GitHub Releases by CI on every push to main
// (.github/workflows/release.yml). The app downloads an update in the background and installs it
// only when you're not using it: no import / render / upload running and nobody has touched the
// keyboard or mouse for a while. Quitting installs a downloaded update too.

const { app, dialog, powerMonitor, Notification } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const CHECK_EVERY_MS = 60 * 60 * 1000; // an hour
const FIRST_CHECK_MS = 30 * 1000; // leave startup alone
const IDLE_SECONDS = 5 * 60; // "not actively working": no input for this long
const POLL_IDLE_MS = 60 * 1000;

/**
 * @param {{ isBusy: () => boolean, beforeInstall: () => void, getWindow: () => Electron.BrowserWindow | null }} hooks
 *   isBusy: a job is running (the UI holds a power-save blocker for exactly that).
 *   beforeInstall: let the app quit without asking (it stops the Python server on quit).
 */
function setupAutoUpdate(hooks) {
  announceIfUpdated();
  if (!app.isPackaged || process.env.SLIDESTATION_DEV_URL) return { checkNow: () => {} };

  // Loaded lazily: only a packaged, signed app can update itself.
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  let ready = null; // UpdateInfo once an update is downloaded
  let manual = false; // the current check came from the menu: report the outcome
  let idleTimer = null;

  const installWhenIdle = () => {
    if (!ready || hooks.isBusy()) return;
    if (powerMonitor.getSystemIdleTime() < IDLE_SECONDS) return;
    clearInterval(idleTimer);
    hooks.beforeInstall();
    // silent: no installer UI; forceRunAfter: open again on the new version
    autoUpdater.quitAndInstall(true, true);
  };

  autoUpdater.on("update-downloaded", (info) => {
    ready = info;
    if (manual) {
      manual = false;
      const w = hooks.getWindow();
      const r = dialog.showMessageBoxSync(w ?? undefined, {
        type: "info",
        message: `Slide Station ${info.version} is ready`,
        detail: hooks.isBusy()
          ? "It will install when the current job has finished and you've stepped away, or when you quit."
          : "Restart now to use it, or it installs by itself when you've stepped away for a few minutes.",
        buttons: hooks.isBusy() ? ["OK"] : ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: hooks.isBusy() ? 0 : 1,
      });
      if (r === 0 && !hooks.isBusy()) {
        hooks.beforeInstall();
        return autoUpdater.quitAndInstall(true, true);
      }
    }
    clearInterval(idleTimer);
    idleTimer = setInterval(installWhenIdle, POLL_IDLE_MS);
  });
  autoUpdater.on("update-not-available", () => {
    if (!manual) return;
    manual = false;
    dialog.showMessageBox(hooks.getWindow() ?? undefined, {
      type: "info",
      message: "Slide Station is up to date",
      detail: `You have version ${app.getVersion()}.`,
    });
  });
  autoUpdater.on("error", (e) => {
    if (manual) {
      manual = false;
      dialog.showMessageBox(hooks.getWindow() ?? undefined, {
        type: "warning",
        message: "Couldn't check for updates",
        detail: String(e?.message || e).slice(0, 400),
      });
    } else console.warn("auto-update:", e?.message || e);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
  // Coming back from sleep is a good moment: laptops often sleep through the hourly check.
  powerMonitor.on("resume", () => setTimeout(check, FIRST_CHECK_MS));

  return {
    checkNow() {
      if (ready) {
        manual = true;
        autoUpdater.emit("update-downloaded", ready);
        return;
      }
      manual = true;
      check();
    },
  };
}

/** After an update-restart, say so once (the version changed since the last launch). */
function announceIfUpdated() {
  const file = path.join(app.getPath("userData"), "last-version");
  let last = "";
  try {
    last = fs.readFileSync(file, "utf8").trim();
  } catch {
    /* first launch */
  }
  const now = app.getVersion();
  if (last === now) return;
  try {
    fs.writeFileSync(file, now);
  } catch {
    /* read-only home: no announcement, no harm */
  }
  if (last && Notification.isSupported()) {
    app.whenReady().then(() =>
      new Notification({ title: `Slide Station updated to ${now}`, body: "The update installed while you were away." }).show(),
    );
  }
}

module.exports = { setupAutoUpdate };
