// The only door between the UI and the operating system. Kept deliberately small; the UI feature-
// detects it (`window.slideStation`) and works as a plain web page without it.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("slideStation", {
  platform: process.platform,

  /** Native folder picker; resolves to the path, or null when cancelled. */
  pickFolder: (opts) => ipcRenderer.invoke("pick-folder", opts),
  /** Opens a folder in Finder / Explorer. */
  showFolder: (path) => ipcRenderer.invoke("show-folder", path),
  /** Absolute path of a file or folder dropped onto the window. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  setMenuState: (state) => ipcRenderer.send("menu-state", state),
  setProgress: (fraction) => ipcRenderer.send("progress", fraction),
  setBadge: (count) => ipcRenderer.send("badge", count),
  setBusy: (busy) => ipcRenderer.send("busy", !!busy),
  notify: (n) => ipcRenderer.send("notify", n),

  /** Menu items and notification clicks. Returns an unsubscribe function. */
  onCommand: (fn) => {
    const h = (_e, name, arg) => fn(name, arg);
    ipcRenderer.on("command", h);
    return () => ipcRenderer.removeListener("command", h);
  },
  onWindow: (fn) => {
    const h = (_e, s) => fn(s);
    ipcRenderer.on("window", h);
    return () => ipcRenderer.removeListener("window", h);
  },
});
