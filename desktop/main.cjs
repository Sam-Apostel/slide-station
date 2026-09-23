// Slide Station desktop shell: starts the Python server, shows the UI in a native window, and
// gives the UI what a browser tab can't have — native menus, folder pickers, dock progress,
// notifications, and keeping the Mac awake through long uploads. See desktop/README.md.

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  dialog,
  ipcMain,
  nativeTheme,
  powerSaveBlocker,
  screen,
  shell,
} = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const isMac = process.platform === "darwin";
const DEV_URL = process.env.SLIDESTATION_DEV_URL; // e.g. http://localhost:5173 (Vite)
const BG = "#0e0e10"; // --ss-bg, so the window never flashes white
const TITLEBAR_HEIGHT = 44; // WindowTitlebar (frontend/src/components/window-titlebar.tsx)

nativeTheme.themeSource = "dark";
if (!app.requestSingleInstanceLock()) app.quit();

/** @type {BrowserWindow | null} */
let win = null;
/** @type {import("node:child_process").ChildProcess | null} */
let server = null;
let serverLog = "";
let quitting = false;
let origin = "";
let blockerId = -1;
// What the renderer last told us, so menu items can be enabled/checked to match.
let menuState = {
  hasTray: false,
  hasSlides: false,
  canImport: false,
  canUpload: false,
  canEject: false,
  filmstrip: true,
  inspector: true,
};

// ------------------------------------------------------------------ backend

/** The repo root in development, the bundled copy (extraResources) in a packaged app. */
const backendDir = () =>
  app.isPackaged ? path.join(process.resourcesPath, "backend") : path.resolve(__dirname, "..");

function freePort() {
  if (process.env.SLIDESTATION_PORT) return Promise.resolve(Number(process.env.SLIDESTATION_PORT));
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

/** GUI apps on macOS don't inherit the shell PATH; look where uv and Homebrew actually live. */
function searchPath() {
  const extra = [path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return [...extra, ...(process.env.PATH || "").split(path.delimiter)].filter(Boolean).join(path.delimiter);
}

function findUv(PATH) {
  for (const dir of PATH.split(path.delimiter)) {
    const p = path.join(dir, process.platform === "win32" ? "uv.exe" : "uv");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Same one-time step as `Slide Station.command`: uv brings its own Python and the libraries. */
async function ensureUv(PATH) {
  const found = findUv(PATH);
  if (found) return found;
  if (process.platform === "win32") throw new Error("uv is not installed: see https://docs.astral.sh/uv/");
  splash("First start: installing uv (a small Python manager, one-time)…");
  const r = spawnSync("/bin/sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"], {
    env: { ...process.env, PATH },
    encoding: "utf8",
  });
  const uv = findUv(PATH);
  if (!uv) throw new Error(`Could not install uv.\n\n${(r.stderr || r.stdout || "").slice(-800)}`);
  return uv;
}

async function startServer(port) {
  const PATH = searchPath();
  const env = {
    ...process.env,
    PATH,
    OPENCV_LOG_LEVEL: "ERROR",
    SLIDESTATION_PORT: String(port),
    SLIDESTATION_NO_BROWSER: "1",
    SLIDESTATION_DESKTOP: "1",
    PYTHONUNBUFFERED: "1",
  };
  // SLIDESTATION_PYTHON (e.g. ".venv/bin/python") skips uv entirely — handy while developing.
  let cmd, args;
  if (process.env.SLIDESTATION_PYTHON) {
    cmd = process.env.SLIDESTATION_PYTHON;
    args = ["-m", "slidestation"];
  } else {
    cmd = await ensureUv(PATH);
    args = ["run", "--quiet", "--python", "3.12", "python", "-m", "slidestation"];
    // The app bundle is read-only once signed: keep the Python environment in Application Support.
    if (app.isPackaged) env.UV_PROJECT_ENVIRONMENT = path.join(app.getPath("userData"), "python");
  }
  splash("Starting Slide Station…", "The first start downloads Python and the image libraries (about a minute).");
  server = spawn(cmd, args, { cwd: backendDir(), env, detached: !isWindows(), stdio: ["ignore", "pipe", "pipe"] });
  const keep = (d) => {
    serverLog = (serverLog + d).slice(-4000);
    process.stdout.write(d);
  };
  server.stdout.on("data", keep);
  server.stderr.on("data", keep);
  server.on("exit", (code) => {
    server = null;
    if (quitting) return;
    dialog.showErrorBox(
      "Slide Station stopped",
      `The image server exited (code ${code}).\n\n${serverLog.slice(-1500) || "No output."}`,
    );
    app.exit(1);
  });
}

const isWindows = () => process.platform === "win32";

function stopServer() {
  if (!server) return;
  const p = server;
  // uv runs python as a child: signal the whole process group so nothing is left behind.
  const kill = (sig) => {
    try {
      if (isWindows()) p.kill(sig);
      else process.kill(-p.pid, sig);
    } catch {
      /* already gone */
    }
  };
  kill("SIGTERM");
  setTimeout(() => kill("SIGKILL"), 3000).unref();
}

async function waitForServer(url, ms = 240_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!server) throw new Error("server exited");
    try {
      const r = await fetch(`${url}/api/state`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`The image server didn't start within ${ms / 1000} s.\n\n${serverLog.slice(-1500)}`);
}

// ------------------------------------------------------------------ window

const stateFile = () => path.join(app.getPath("userData"), "window.json");

function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    // Only restore onto a display that still exists (the laptop may have left its monitor).
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
  } catch {
    return { width: 1440, height: 900 };
  }
}

function saveBounds() {
  if (!win) return;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {
    /* not important */
  }
}

function splash(title, detail = "") {
  if (!win) return;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:${BG};color:#ebe8e2;font:13px -apple-system,system-ui,sans-serif;
      display:flex;align-items:center;justify-content:center;-webkit-app-region:drag;user-select:none}
    .c{text-align:center;max-width:380px}.m{width:40px;height:40px;border-radius:6px;background:#f2b34b;margin:0 auto 18px;position:relative}
    .m:after{content:"";position:absolute;inset:10px 8px;border-radius:2px;background:#1a1305}
    p{color:#9b978e;font-size:12px;line-height:1.5}
    .b{height:3px;width:160px;margin:16px auto 0;background:#2a2a31;border-radius:2px;overflow:hidden}
    .b:after{content:"";display:block;height:100%;width:40%;background:#f2b34b;animation:s 1.1s ease-in-out infinite}
    @keyframes s{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}</style>
    <div class="c"><div class="m"></div><b>${esc(title)}</b><p>${esc(detail)}</p><div class="b"></div></div>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: "Slide Station",
    backgroundColor: BG,
    // The UI draws the titlebar (ProTitlebar); macOS keeps its real traffic lights on top of it,
    // Windows/Linux get native caption buttons as an overlay on its right end.
    titleBarStyle: "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 13, y: Math.round((TITLEBAR_HEIGHT - 12) / 2) } }
      : { titleBarOverlay: { color: "#131316", symbolColor: "#ebe8e2", height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (b.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());
  win.on("close", saveBounds);
  win.on("closed", () => (win = null));
  for (const ev of ["enter-full-screen", "leave-full-screen"]) {
    win.on(ev, () => win?.webContents.send("window", { fullscreen: win.isFullScreen() }));
  }

  // Everything outside the app opens in the real browser; the window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!origin || !url.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === "notifications" || permission === "clipboard-sanitized-write"),
  );
  return win;
}

/** Sends a menu / notification command to the UI (see `onCommand` in frontend/src/lib/desktop.ts). */
function command(name, arg) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send("command", name, arg);
}

// ------------------------------------------------------------------ menu

function buildMenu() {
  const s = menuState;
  const cmd = (name, arg) => () => command(name, arg);
  /** Single-key shortcuts are handled by the UI; the menu only shows them (never registers them),
   *  so typing an "r" into a text field still types an "r". */
  const hint = (accelerator) => ({ accelerator, registerAccelerator: false });

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { label: "Settings…", accelerator: "Cmd+,", click: cmd("settings") },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Tray…", accelerator: "CmdOrCtrl+N", click: cmd("new-tray") },
        { label: "Import from Scanner", accelerator: "CmdOrCtrl+I", enabled: s.canImport, click: cmd("import") },
        { label: "Import Folder…", accelerator: "CmdOrCtrl+Shift+O", click: cmd("import-folder") },
        { type: "separator" },
        {
          label: "Upload to Immich",
          accelerator: "CmdOrCtrl+U",
          enabled: s.canUpload,
          click: cmd("upload"),
        },
        {
          label: isMac ? "Show Files in Finder" : "Show Files",
          accelerator: "CmdOrCtrl+Shift+R",
          enabled: s.hasTray,
          click: cmd("reveal"),
        },
        { label: "Eject Scanner", accelerator: "CmdOrCtrl+E", enabled: s.canEject, click: cmd("eject") },
        ...(isMac
          ? []
          : [
              { type: "separator" },
              { label: "Settings…", accelerator: "Ctrl+,", click: cmd("settings") },
              { type: "separator" },
              { role: "quit" },
            ]),
        ...(isMac ? [{ type: "separator" }, { role: "close" }] : []),
      ],
    },
    {
      // Undo / Redo go to the UI, which undoes the text field being typed in or else the slide's
      // last edit. The rest are the standard roles (copy/paste in text fields needs them on macOS).
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: cmd("undo") },
        { label: "Redo", accelerator: isMac ? "Shift+Cmd+Z" : "Ctrl+Y", click: cmd("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac ? [{ role: "pasteAndMatchStyle" }] : []),
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Slide",
      submenu: [
        { label: "Next Slide", ...hint("Right"), enabled: s.hasSlides, click: cmd("next") },
        { label: "Previous Slide", ...hint("Left"), enabled: s.hasSlides, click: cmd("prev") },
        { label: "Develop, Next", ...hint("Space"), enabled: s.hasSlides, click: cmd("review") },
        { type: "separator" },
        { label: "Rotate Right", ...hint("R"), enabled: s.hasSlides, click: cmd("rotate", 90) },
        { label: "Rotate Left", ...hint("Shift+R"), enabled: s.hasSlides, click: cmd("rotate", -90) },
        { type: "separator" },
        { label: "Copy Colour from Previous", ...hint("C"), enabled: s.hasSlides, click: cmd("copy-prev") },
        { label: "Reset Colour", ...hint("0"), enabled: s.hasSlides, click: cmd("reset-colour") },
        { type: "separator" },
        { label: "Skip Slide", ...hint("X"), enabled: s.hasSlides, click: cmd("skip") },
        { label: "Merge with Next", ...hint("M"), enabled: s.hasSlides, click: cmd("merge") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Command Palette…", accelerator: "CmdOrCtrl+K", click: cmd("palette") },
        { type: "separator" },
        {
          label: "Filmstrip",
          type: "checkbox",
          checked: s.filmstrip,
          accelerator: "CmdOrCtrl+Alt+1",
          click: cmd("toggle-filmstrip"),
        },
        {
          label: "Inspector",
          type: "checkbox",
          checked: s.inspector,
          accelerator: "CmdOrCtrl+Alt+2",
          click: cmd("toggle-inspector"),
        },
        { label: "Focus on the Photo", accelerator: "CmdOrCtrl+Alt+F", click: cmd("focus-mode") },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }]),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Keyboard Shortcuts", ...hint("Shift+/"), click: cmd("help") },
        { type: "separator" },
        {
          label: "Slide Station on GitHub",
          click: () => shell.openExternal("https://github.com/Sam-Apostel/slide-station"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ bridge (see preload.cjs)

function registerIpc() {
  const fromApp = (e) => e.senderFrame && origin && e.senderFrame.url.startsWith(origin);
  const handle = (ch, fn) =>
    ipcMain.handle(ch, (e, ...a) => {
      if (!fromApp(e)) throw new Error("not allowed");
      return fn(...a);
    });
  const on = (ch, fn) =>
    ipcMain.on(ch, (e, ...a) => {
      if (fromApp(e)) fn(...a);
    });

  handle("pick-folder", async (opts = {}) => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: opts.title || "Choose a folder",
      buttonLabel: opts.buttonLabel || "Choose",
      defaultPath: opts.defaultPath || undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle("show-folder", async (p) => {
    if (typeof p !== "string" || !path.isAbsolute(p)) return false;
    return (await shell.openPath(p)) === "";
  });

  on("menu-state", (next) => {
    const changed = Object.keys(next).some((k) => next[k] !== menuState[k]);
    menuState = { ...menuState, ...next };
    if (changed) buildMenu();
  });

  // Dock / taskbar: job progress (0–1, or -1 for none) and how many slides still need you.
  on("progress", (fraction) => win?.setProgressBar(typeof fraction === "number" ? fraction : -1));
  on("badge", (count) => {
    const n = Math.max(0, Number(count) || 0);
    if (isMac) app.dock?.setBadge(n ? String(n) : "");
    else app.setBadgeCount(n);
  });

  // Keep the Mac awake (screen may sleep) while an import, render or upload runs.
  on("busy", (busy) => {
    if (busy && blockerId < 0) blockerId = powerSaveBlocker.start("prevent-app-suspension");
    if (!busy && blockerId >= 0) {
      powerSaveBlocker.stop(blockerId);
      blockerId = -1;
    }
  });

  // Native notifications, only worth showing when the window isn't what you're looking at.
  on("notify", ({ title, body, command: name, onlyInBackground = true } = {}) => {
    if (!Notification.isSupported() || !title) return;
    if (onlyInBackground && win?.isFocused()) return;
    const n = new Notification({ title: String(title), body: String(body || ""), silent: false });
    if (name) n.on("click", () => command(name));
    n.show();
    if (isMac && !win?.isFocused()) app.dock?.bounce("informational");
  });
}

// ------------------------------------------------------------------ lifecycle

app.setName("Slide Station");
app.setAboutPanelOptions?.({
  applicationName: "Slide Station",
  applicationVersion: app.getVersion(),
  copyright: "MIT licence · ProUI components under their own licence (see NOTICE.md)",
});

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  // A packaged app gets its icon from the bundle; while developing, show it in the Dock too.
  if (isMac && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, "build", "icon.png"));
  buildMenu();
  registerIpc();
  createWindow();
  splash("Starting Slide Station…");
  win.show();
  try {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    if (DEV_URL) {
      // `npm run dev` in frontend/ proxies /api to SLIDESTATION_PORT (default 8765).
      if (!process.env.SLIDESTATION_NO_SERVER) await startServer(port);
      await waitForServer(url).catch(() => {});
      origin = new URL(DEV_URL).origin;
      await win.loadURL(DEV_URL);
    } else {
      await startServer(port);
      await waitForServer(url);
      origin = url;
      await win.loadURL(url);
    }
  } catch (e) {
    if (quitting) return;
    dialog.showErrorBox("Slide Station could not start", String(e?.message || e));
    app.exit(1);
  }
});

app.on("activate", () => {
  if (!win && origin) {
    createWindow();
    win.loadURL(DEV_URL || origin);
  }
});

app.on("window-all-closed", () => {
  // The server holds no window state, but a job may be running: quitting stops it, so on macOS
  // keep the app alive in the dock (like any document app) and let Cmd+Q decide.
  if (!isMac) app.quit();
});

app.on("before-quit", (e) => {
  // An import, render or upload is running (the UI holds a power-save blocker for exactly that).
  if (!quitting && blockerId >= 0 && win) {
    const r = dialog.showMessageBoxSync(win, {
      type: "warning",
      message: "Slide Station is still working",
      detail: "Quitting stops the running import or upload. Nothing is lost: you can start it again later.",
      buttons: ["Keep Working", "Quit Anyway"],
      defaultId: 0,
      cancelId: 0,
    });
    if (r === 0) return e.preventDefault();
  }
  quitting = true;
  saveBounds();
  stopServer();
});
