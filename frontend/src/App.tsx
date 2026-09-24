import * as React from "react";
import { toast } from "sonner";
import { useDefaultLayout } from "react-resizable-panels";
import { Toaster } from "@/components/ui/sonner";
import { ProStatusbar } from "@/components/ui/pro-statusbar";
import { Kbd } from "@/components/ui/kbd";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ConfirmProvider, useConfirm } from "@/components/confirm";
import { ActivityWell, AppActions, TopBar, TraySwitcher } from "@/components/top-bar";
import { Filmstrip, type Filter } from "@/components/filmstrip";
import { Stage } from "@/components/stage";
import { Inspector } from "@/components/inspector";
import { EmptyState } from "@/components/empty-state";
import { SlideMenu } from "@/components/slide-menu";
import { CommandPalette } from "@/components/command-palette";
import { DateRangeDialog, HelpDialog, NewTrayDialog, SettingsDialog } from "@/components/dialogs";
import { PanelToggles, WindowTitlebar } from "@/components/window-titlebar";
import { useSlideStation, type SlideStation } from "@/hooks/use-slide-station";
import { useDesktop, useFolderDrop, type DesktopHandlers } from "@/hooks/use-desktop";
import { needsReview, plural, standalone, type Source } from "@/lib/api";
import { desktop, isMac } from "@/lib/desktop";

type Panels = { filmstrip: boolean; inspector: boolean };
const ALL_PANELS: Panels = { filmstrip: true, inspector: true };

/** localStorage for the panel widths, tolerating private mode. */
const layoutStorage = {
  getItem: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

function storedPanels(): Panels {
  try {
    return { ...ALL_PANELS, ...JSON.parse(localStorage.getItem("panels") || "{}") };
  } catch {
    return ALL_PANELS;
  }
}

export default function App() {
  return (
    <ConfirmProvider>
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        <SlideStationApp />
      </TooltipProvider>
      <Toaster theme="dark" position="bottom-center" />
    </ConfirmProvider>
  );
}

function SlideStationApp() {
  const app = useSlideStation();
  const confirm = useConfirm();
  const { state, session, sessionId } = app;

  const [filter, setFilter] = React.useState<Filter>("all");
  const [before, setBefore] = React.useState(false);
  // the neutral-point eyedropper: the next click on the photo sets the white balance
  const [picking, setPicking] = React.useState(false);
  // the crop tool: the photo shows uncropped with a crop frame over it until Done / Cancel
  const [cropping, setCropping] = React.useState(false);
  const [compare, setCompare] = React.useState(false);
  React.useEffect(() => {
    setPicking(false);
    setCropping(false);
  }, [app.sel, sessionId]);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [dateRangeOpen, setDateRangeOpen] = React.useState(false);
  const [newTray, setNewTray] = React.useState<{ open: boolean; source?: Source; folder?: string }>({ open: false });
  const [panels, setPanels] = React.useState(storedPanels);
  // What focus mode hid, so the same shortcut brings exactly that back.
  const beforeFocus = React.useRef<Panels | null>(null);

  const changePanels = (fn: (p: Panels) => Panels) =>
    setPanels((p) => {
      const next = fn(p);
      try {
        localStorage.setItem("panels", JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  const toggleFilmstrip = () => changePanels((p) => ({ ...p, filmstrip: !p.filmstrip }));
  const toggleInspector = () => changePanels((p) => ({ ...p, inspector: !p.inspector }));
  const focusMode = () =>
    changePanels((p) => {
      if (!p.filmstrip && !p.inspector) return beforeFocus.current ?? ALL_PANELS;
      beforeFocus.current = p;
      return { filmstrip: false, inspector: false };
    });

  const busy = !!state?.job && !state.job.finished;
  const hasTrays = !!state?.sessions.length;
  const source = state?.sources.find((x) => x.new > 0) ?? state?.sources[0];

  const openNew = (src?: Source, folder?: string) => setNewTray({ open: true, source: src, folder });
  const importFolder = async (folder?: string) => {
    if (standalone) {
      // the browser version: pick a folder, then import it like a card
      const src = await app.addSource("pick");
      return src ? openImport(src) : undefined;
    }
    const path = folder ?? (await desktop?.pickFolder({ title: "Import scans from a folder", buttonLabel: "Import" }));
    if (desktop && !path) return; // cancelled the picker
    openNew(undefined, path ?? "");
  };

  /** Import into the open tray while it is unfinished (asking first if it has progress), else start a new one. */
  const openImport = async (src: Source) => {
    const sm = session?.summary;
    if (sm && sm.pending_upload + sm.uploaded === 0) return app.startImport(sessionId, src.path);
    if (sm && !sm.card_cleaned && sm.uploaded < sm.slides) {
      const ok = await confirm({
        title: `Import ${plural(src.new, "scan")} into “${sm.name}”?`,
        description: "Or start a new tray for them instead.",
        confirmLabel: "Import into this tray",
        cancelLabel: "New tray",
      });
      if (ok) return app.startImport(sessionId, src.path);
    }
    openNew(src);
  };

  /**
   * "ready": only the developed slides, the rest stay to work on. "all": everything not skipped,
   * undeveloped slides with their automatic settings (asks first). Without a scope, the developed
   * ones if there are any.
   */
  const upload = async (scope?: "ready" | "all") => {
    if (!session || !state) return;
    if (!state.config.has_key || !state.config.immich_url) {
      if (!standalone) return setSettingsOpen(true);
      const toDisk = await confirm({
        title: "No Immich server set up",
        description: "Save the finished slides to your disk instead? Or connect Immich in Settings.",
        confirmLabel: "Save to disk",
        cancelLabel: "Set up Immich",
      });
      return toDisk ? save() : setSettingsOpen(true);
    }
    const undeveloped = session.groups.filter(needsReview).length;
    const ready = session.summary.ready_upload;
    if ((scope ?? (ready ? "ready" : "all")) === "ready" && undeveloped) return app.startUpload(true);
    if (
      undeveloped &&
      !(await confirm({
        title: `${plural(undeveloped, "slide")} ${undeveloped === 1 ? "hasn't" : "haven't"} been developed yet`,
        description: "Upload them with the automatic settings anyway?",
        confirmLabel: "Upload anyway",
      }))
    )
      return;
    app.startUpload();
  };

  /** Browser version: the finished JPEGs to disk — the developed ones, or (asking first) all of them. */
  const save = async () => {
    if (!session) return;
    const developed = session.groups.filter((g) => g.reviewed && !g.skip).length;
    if (!developed) {
      const ok = await confirm({
        title: "No slide has been developed yet",
        description: "Save all of them with the automatic settings?",
        confirmLabel: "Save all",
      });
      if (!ok) return;
    }
    app.startSave(developed > 0);
  };

  /** Import this tray's scans again: from the connected card, else a folder you pick (desktop). */
  const reimport = async () => {
    if (standalone) {
      const picked = await app.addSource("pick");
      return picked ? app.startImport(sessionId, picked.path) : undefined;
    }
    const src = state?.sources.find((x) => x.count > 0);
    if (src) return app.startImport(sessionId, src.path);
    const path = await desktop?.pickFolder({ title: "Folder with this tray's scans", buttonLabel: "Import" });
    if (path) return app.startImport(sessionId, path);
    if (!desktop) toast("Connect the scanner (or use the desktop app to pick a folder) to re-import");
  };

  const clean = async () => {
    if (!session) return;
    const ok = await confirm({
      title: `Delete this tray's ${plural(session.summary.scans, "scan")} from the scanner's card?`,
      description: "They are safely copied and uploaded. This cannot be undone on the card.",
      confirmLabel: "Delete from card",
      destructive: true,
    });
    if (ok) app.startCleanup();
  };

  const handlers: DesktopHandlers = {
    settings: () => setSettingsOpen(true),
    newTray: () => openNew(),
    importFrom: openImport,
    importFolder,
    upload: () => upload(),
    uploadAll: () => upload("all"),
    help: () => setHelpOpen(true),
    palette: () => setPaletteOpen(true),
    toggleFilmstrip,
    toggleInspector,
    focusMode,
  };
  useKeyboard(app, setBefore, () => setHelpOpen(true), () => setPaletteOpen(true), setPicking, setCropping, setCompare);
  useDesktop(app, panels, handlers);
  const dropping = useFolderDrop(
    (path) => importFolder(path),
    standalone ? (dt) => void app.addSource(dt).then((src) => src && openImport(src)) : undefined,
  );

  const toggles = session ? (
    <PanelToggles
      filmstrip={panels.filmstrip}
      inspector={panels.inspector}
      onFilmstrip={toggleFilmstrip}
      onInspector={toggleInspector}
    />
  ) : null;

  // Panel widths are remembered per combination of visible panels; the key remounts the group
  // so showing or hiding a panel restores the widths saved for that combination.
  const panelIds = ["filmstrip", "stage", "inspector"].filter((id) => id === "stage" || panels[id as keyof Panels]);
  const layout = useDefaultLayout({ id: "panel-widths", panelIds, storage: layoutStorage });
  const slideMenu = (index: number, el: React.ReactElement) => (
    <SlideMenu key={el.key ?? index} app={app} index={index}>
      {el}
    </SlideMenu>
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {desktop ? (
        <WindowTitlebar
          title={session?.summary.name ?? "Slide Station"}
          left={
            <TraySwitcher
              state={state}
              sessionId={sessionId}
              onSelectSession={(id) => app.loadSession(id)}
              onNewTray={() => openNew()}
            />
          }
          center={
            <ActivityWell
              state={state}
              onImport={openImport}
              onEject={(src) => app.eject(src.path)}
              onChooseFolder={() => importFolder()}
            />
          }
          right={
            <>
              {toggles}
              <AppActions onHelp={() => setHelpOpen(true)} onSettings={() => setSettingsOpen(true)} />
            </>
          }
        />
      ) : (
        <TopBar
          panelToggles={toggles}
          state={state}
          sessionId={sessionId}
          onSelectSession={(id) => app.loadSession(id)}
          onNewTray={() => openNew()}
          onImport={openImport}
          onEject={(src) => app.eject(src.path)}
          onChooseFolder={() => importFolder()}
          onHelp={() => setHelpOpen(true)}
          onSettings={() => setSettingsOpen(true)}
        />
      )}

      <main className="flex min-h-0 flex-1">
        {!state ? null : !hasTrays ? (
          <EmptyState source={source} onImport={openImport} onImportFolder={() => importFolder()} />
        ) : session ? (
          <ResizablePanelGroup
            key={panelIds.join()}
            id="panel-widths"
            defaultLayout={layout.defaultLayout}
            onLayoutChanged={layout.onLayoutChanged}
          >
            {panels.filmstrip && (
              <>
                <ResizablePanel
                  id="filmstrip"
                  defaultSize={250}
                  minSize={180}
                  maxSize={560}
                  groupResizeBehavior="preserve-pixel-size"
                >
                  <Filmstrip
                    session={session}
                    sessionId={sessionId}
                    sel={app.sel}
                    filter={filter}
                    onFilter={setFilter}
                    onSelect={app.select}
                    slideMenu={slideMenu}
                  />
                </ResizablePanel>
                <ResizableHandle aria-label="Resize filmstrip" />
              </>
            )}
            <ResizablePanel id="stage" minSize={320}>
              <Stage
                session={session}
                sessionId={sessionId}
                sel={app.sel}
                before={before}
                onBefore={setBefore}
                onToggleScan={app.toggleScan}
                onSplit={app.splitAt}
                compare={compare}
                onCompare={() => setCompare((v) => !v)}
                onUndo={app.undo}
                onRedo={app.redo}
                slideMenu={slideMenu}
                cropping={cropping}
                onAngle={(a) => app.setParam("angle", Math.round(a * 10) / 10)}
                onCropEnd={(rect, restoreAngle) => {
                  setCropping(false);
                  if (rect !== undefined) app.setParam("crop", rect, true);
                  else if (restoreAngle !== undefined && restoreAngle !== (app.current?.params.angle ?? 0))
                    app.setParam("angle", restoreAngle, true);
                }}
                picking={picking}
                onPicked={(x, y) => {
                  setPicking(false);
                  if (x !== null && y !== null) app.pickNeutral(x, y);
                }}
              />
            </ResizablePanel>
            {panels.inspector && (
              <>
                <ResizableHandle aria-label="Resize inspector" />
                <ResizablePanel
                  id="inspector"
                  defaultSize={300}
                  minSize={272}
                  maxSize={480}
                  groupResizeBehavior="preserve-pixel-size"
                >
                  <Inspector
                    app={app}
                    session={session}
                    sessionId={sessionId}
                    busy={busy}
                    onUpload={upload}
                    onClean={clean}
                    picking={picking}
                    onPick={() => setPicking((v) => !v)}
                    cropping={cropping}
                    onCrop={() => app.current?.locked || setCropping((v) => !v)}
                    onReimport={reimport}
                    onSave={standalone ? save : undefined}
                    onDateRange={() => setDateRangeOpen(true)}
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        ) : null}
      </main>

      <ProStatusbar>
        {session ? (
          <>
            <span>{plural(session.summary.slides, "slide")}</span>
            {session.summary.slides > 0 && !session.groups.some(needsReview) ? (
              <span className="ss-all-developed">✓ All developed</span>
            ) : (
              <span>{session.groups.filter(needsReview).length} to develop</span>
            )}
            <span>{session.summary.uploaded} in Immich</span>
            {session.summary.skipped > 0 && <span>{session.summary.skipped} skipped</span>}
          </>
        ) : (
          <span>{hasTrays ? "Loading…" : "No trays yet"}</span>
        )}
        <span className="ml-auto flex items-center gap-3 [&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:text-[10px]">
          <span>
            <Kbd>←</Kbd> <Kbd>→</Kbd> browse
          </span>
          <span>
            <Kbd>Space</Kbd> develop
          </span>
          <span>
            <Kbd>?</Kbd> all shortcuts
          </span>
        </span>
      </ProStatusbar>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        config={state?.config}
        onSaved={app.refreshState}
      />
      <NewTrayDialog
        open={newTray.open}
        onOpenChange={(open) => setNewTray((s) => ({ ...s, open }))}
        state={state}
        preferSource={newTray.source}
        preferFolder={newTray.folder}
        onCreate={app.createSession}
        onChooseFolder={standalone ? () => app.addSource("pick") : undefined}
      />
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        app={app}
        handlers={handlers}
        onClean={clean}
        onDateRange={() => setDateRangeOpen(true)}
        busy={busy}
      />
      {session && (
        <DateRangeDialog
          open={dateRangeOpen}
          onOpenChange={setDateRangeOpen}
          groups={session.groups}
          sel={app.sel}
          onApply={app.dateRange}
        />
      )}
      {dropping && (
        <div className="ss-drop pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
          <div className="rounded-lg border border-primary/60 bg-(--ss-panel) px-6 py-4 text-center shadow-2xl">
            <div className="text-[14px] font-semibold">Drop a folder of scans</div>
            <div className="mt-1 text-[12px] text-muted-foreground">
              {standalone ? "Its scans are imported into a tray" : "It becomes a new tray"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The keyboard map is the reason the app is fast for 10,000 slides — keep it identical to the
 * original. Shortcuts win over whatever has focus, except text entry (and open dialogs).
 */
function useKeyboard(
  app: SlideStation,
  setBefore: (on: boolean) => void,
  openHelp: () => void,
  openPalette: () => void,
  setPicking: React.Dispatch<React.SetStateAction<boolean>>,
  setCropping: React.Dispatch<React.SetStateAction<boolean>>,
  setCompare: React.Dispatch<React.SetStateAction<boolean>>,
) {
  const latest = React.useRef({ app, setBefore, openHelp, openPalette, setPicking, setCropping, setCompare });
  latest.current = { app, setBefore, openHelp, openPalette, setPicking, setCropping, setCompare };

  React.useEffect(() => {
    const isTextEntry = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.isContentEditable ||
        t.matches("textarea, select, input:not([type=range]):not([type=checkbox]), [role=spinbutton]"));
    // Open menus count too: their arrow keys and typeahead must not move between slides.
    const modalOpen = () => !!document.querySelector("[role=dialog], [role=alertdialog], [role=menu]");

    const down = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K opens the command palette, from anywhere (in the desktop app the View menu
      // usually catches it first; opening twice is harmless).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        latest.current.openPalette();
        return;
      }
      // ⌘Z / ⇧⌘Z (Ctrl on Windows / Linux): the slide's edit history, unless a text field has focus.
      // In the desktop app the Edit menu catches these first and sends "undo" / "redo".
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
        if (isTextEntry(e.target) || modalOpen() || document.querySelector(".ss-crop")) return;
        e.preventDefault();
        if (e.shiftKey) latest.current.app.redo();
        else latest.current.app.undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextEntry(e.target) || modalOpen()) return;
      // the crop tool takes Enter / Esc itself; nothing else may change the slide under it
      if (document.querySelector(".ss-crop")) return;
      const { app: a, setBefore: sb, openHelp: help } = latest.current;
      const k = e.key;
      if (k === "?") {
        help();
        e.preventDefault();
        return;
      }
      if (!a.session?.groups.length) return;
      if (k === "ArrowRight" || k === "ArrowDown") a.select(a.sel + 1);
      else if (k === "ArrowLeft" || k === "ArrowUp") a.select(a.sel - 1);
      else if (k === " " || k === "Enter") a.review();
      else if (k === "r") a.rotate(90);
      else if (k === "R") a.rotate(-90);
      else if (k === "x" || k === "X") a.toggleSkip();
      else if (k === "m" || k === "M") a.mergeNext();
      else if (k === "c" || k === "C") a.copyPrev();
      else if (k === "0") a.resetColour();
      else if (k === "w" || k === "W") {
        if (!a.current?.locked) latest.current.setPicking((v) => !v);
      }
      else if (k === "k" || k === "K") {
        if (!a.current?.locked) latest.current.setCropping(true);
      }
      else if (k === "y" || k === "Y") latest.current.setCompare((v) => !v);
      else if (k === "Escape") latest.current.setPicking(false);
      else if (k === "f") a.fitCurves();
      else if (k === "F") a.fitCurves(true);
      else if (k === "b" || k === "B") {
        if (!e.repeat) sb(true);
      } else if (/^[1-9]$/.test(k)) {
        const sc = a.current?.scans[+k - 1];
        if (sc) a.toggleScan(sc);
      } else return;
      e.preventDefault();
      // Runs in the capture phase, so a focused slider never sees keys that are shortcuts:
      // after dragging a slider, ← → still move between slides instead of nudging it.
      e.stopPropagation();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "b" || e.key === "B") latest.current.setBefore(false);
    };
    const blur = () => latest.current.setBefore(false);
    document.addEventListener("keydown", down, true);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", down, true);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
}
