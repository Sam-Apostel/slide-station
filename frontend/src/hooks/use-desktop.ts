import * as React from "react";
import { desktop, type DesktopCommand } from "@/lib/desktop";
import { needsReview, plural, sourceLabel, type Source } from "@/lib/api";
import type { SlideStation } from "@/hooks/use-slide-station";

export type DesktopHandlers = {
  settings: () => void;
  newTray: () => void;
  importFrom: (src: Source) => void;
  importFolder: (path?: string) => void;
  upload: () => void;
  help: () => void;
  toggleFilmstrip: () => void;
  toggleInspector: () => void;
  focusMode: () => void;
};

const JOB_DONE: Record<string, string> = {
  import: "Import finished",
  finish: "Upload finished",
  upload: "Upload finished",
  cleanup: "Scanner card cleaned",
};

/**
 * Everything the Electron shell adds on top of the web app: menu commands, menu enabled/checked
 * state, dock progress and badge, notifications, staying awake during jobs, and dropping a folder
 * onto the window. A no-op in a browser tab.
 */
export function useDesktop(
  app: SlideStation,
  panels: { filmstrip: boolean; inspector: boolean },
  handlers: DesktopHandlers,
) {
  const { state, session } = app;
  const latest = React.useRef({ app, handlers });
  latest.current = { app, handlers };

  const job = state?.job;
  const running = !!job && !job.finished;
  const source = state?.sources.find((x) => x.new > 0);
  const toReview = session?.groups.filter(needsReview).length ?? 0;

  // ---------------------------------------------------------------- menu commands
  React.useEffect(() => {
    if (!desktop) return;
    return desktop.onCommand((name: DesktopCommand, arg) => {
      const { app: a, handlers: h } = latest.current;
      const src = a.state?.sources.find((x) => x.new > 0) ?? a.state?.sources[0];
      switch (name) {
        case "settings": return h.settings();
        case "new-tray": return h.newTray();
        case "import": return src && h.importFrom(src);
        case "import-folder": return h.importFolder();
        case "upload": return h.upload();
        case "reveal": return a.reveal();
        case "eject": return src && a.eject(src.path);
        case "help": return h.help();
        case "toggle-filmstrip": return h.toggleFilmstrip();
        case "toggle-inspector": return h.toggleInspector();
        case "focus-mode": return h.focusMode();
        case "next": return a.select(a.sel + 1);
        case "prev": return a.select(a.sel - 1);
        case "review": return a.review();
        case "rotate": return a.rotate(typeof arg === "number" ? arg : 90);
        case "copy-prev": return a.copyPrev();
        case "reset-colour": return a.resetColour();
        case "skip": return a.toggleSkip();
        case "merge": return a.mergeNext();
      }
    });
  }, []);

  // ---------------------------------------------------------------- menu state
  const hasTray = !!session;
  const hasSlides = !!session?.groups.length;
  const canUpload = !!session?.summary.pending_upload && !running;
  const canImport = !!source && !running;
  const canEject = !!state?.sources.some((x) => x.removable);
  React.useEffect(() => {
    desktop?.setMenuState({ hasTray, hasSlides, canImport, canUpload, canEject, ...panels });
  }, [hasTray, hasSlides, canImport, canUpload, canEject, panels.filmstrip, panels.inspector]);

  // ---------------------------------------------------------------- dock: progress, badge, awake
  const progress = running ? (job.total ? job.done / job.total : 2) : -1; // >1 = indeterminate
  React.useEffect(() => desktop?.setProgress(progress), [progress]);
  React.useEffect(() => desktop?.setBadge(toReview), [toReview]);
  React.useEffect(() => desktop?.setBusy(running), [running]);

  // ---------------------------------------------------------------- notifications
  const jobKey = job ? `${job.kind}:${job.started}` : "";
  const wasRunning = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!desktop || !job) return;
    if (!job.finished) {
      wasRunning.current = jobKey;
      return;
    }
    if (wasRunning.current !== jobKey) return; // finished before we saw it run, or already told
    wasRunning.current = null;
    if (job.error) desktop.notify({ title: "Slide Station: something went wrong", body: job.error });
    else desktop.notify({ title: JOB_DONE[job.kind] ?? "Done", body: job.message });
  }, [jobKey, job?.finished]);

  // A scanner card with new scans appears: say so, and a click on the notification imports.
  const seen = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    if (!desktop || !state) return;
    const withNew = state.sources.filter((x) => x.new > 0);
    const first = seen.current === null;
    const prev = seen.current ?? new Set<string>();
    seen.current = new Set(withNew.map((x) => x.path));
    if (first) return; // don't announce what was already plugged in when the app started
    const arrived = withNew.find((x) => !prev.has(x.path));
    if (arrived)
      desktop.notify({
        title: `${sourceLabel(arrived)} connected`,
        body: `${plural(arrived.new, "new scan")} ready to import`,
        command: "import",
      });
  }, [state?.sources]);
}

/**
 * Dropping a folder (or any file in it) onto the window starts a new tray from that folder.
 * Only in the desktop app: a browser tab never sees real file paths.
 */
export function useFolderDrop(onFolder: (path: string) => void) {
  const [over, setOver] = React.useState(false);
  const cb = React.useRef(onFolder);
  cb.current = onFolder;

  React.useEffect(() => {
    if (!desktop) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const item = e.dataTransfer?.items[0];
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      const p = desktop!.pathForFile(file);
      if (!p) return;
      const isDir = item?.webkitGetAsEntry?.()?.isDirectory ?? false;
      cb.current(isDir ? p : p.replace(/[\\/][^\\/]*$/, ""));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return over;
}
