// The Electron bridge (desktop/preload.cjs). Absent in a plain browser tab, where every desktop
// feature quietly switches off and the app works exactly as before.

export type DesktopCommand =
  | "settings"
  | "new-tray"
  | "import"
  | "import-folder"
  | "upload"
  | "reveal"
  | "eject"
  | "help"
  | "palette"
  | "toggle-filmstrip"
  | "toggle-inspector"
  | "focus-mode"
  | "next"
  | "prev"
  | "review"
  | "rotate"
  | "mirror"
  | "copy-prev"
  | "reset-colour"
  | "skip"
  | "merge"
  | "undo"
  | "redo";

export type MenuState = {
  hasTray: boolean;
  hasSlides: boolean;
  canImport: boolean;
  canUpload: boolean;
  canEject: boolean;
  filmstrip: boolean;
  inspector: boolean;
};

export type DesktopBridge = {
  platform: string;
  pickFolder(opts?: { title?: string; buttonLabel?: string; defaultPath?: string }): Promise<string | null>;
  showFolder(path: string): Promise<boolean>;
  pathForFile(file: File): string | null;
  setMenuState(state: MenuState): void;
  /** 0–1, or -1 to clear. */
  setProgress(fraction: number): void;
  setBadge(count: number): void;
  setBusy(busy: boolean): void;
  notify(n: { title: string; body?: string; command?: DesktopCommand; onlyInBackground?: boolean }): void;
  onCommand(fn: (name: DesktopCommand, arg?: unknown) => void): () => void;
  onWindow(fn: (s: { fullscreen: boolean }) => void): () => void;
};

declare global {
  interface Window {
    slideStation?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = typeof window !== "undefined" ? window.slideStation : undefined;
export const isMac = desktop ? desktop.platform === "darwin" : /Mac/.test(navigator.platform);
