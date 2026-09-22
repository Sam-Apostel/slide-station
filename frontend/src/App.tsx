import * as React from "react";
import { Toaster } from "@/components/ui/sonner";
import { ProStatusbar } from "@/components/ui/pro-statusbar";
import { Kbd } from "@/components/ui/kbd";
import { ConfirmProvider, useConfirm } from "@/components/confirm";
import { TopBar } from "@/components/top-bar";
import { Filmstrip, type Filter } from "@/components/filmstrip";
import { Stage } from "@/components/stage";
import { Inspector } from "@/components/inspector";
import { EmptyState } from "@/components/empty-state";
import { HelpDialog, NewTrayDialog, SettingsDialog } from "@/components/dialogs";
import { PanelToggles, WindowTitlebar } from "@/components/window-titlebar";
import { useSlideStation, type SlideStation } from "@/hooks/use-slide-station";
import { useDesktop, useFolderDrop } from "@/hooks/use-desktop";
import { needsReview, plural, type Source } from "@/lib/api";
import { desktop } from "@/lib/desktop";

type Panels = { filmstrip: boolean; inspector: boolean };
const ALL_PANELS: Panels = { filmstrip: true, inspector: true };

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
      <SlideStationApp />
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
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
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

  const upload = async () => {
    if (!session || !state) return;
    if (!state.config.has_key || !state.config.immich_url) return setSettingsOpen(true);
    const unreviewed = session.groups.filter(needsReview).length;
    if (
      unreviewed &&
      !(await confirm({
        title: `${plural(unreviewed, "slide")} ${unreviewed === 1 ? "hasn't" : "haven't"} been reviewed yet`,
        description: "Upload them with the automatic settings anyway?",
        confirmLabel: "Upload anyway",
      }))
    )
      return;
    app.startUpload();
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

  useKeyboard(app, setBefore, () => setHelpOpen(true));
  useDesktop(app, panels, {
    settings: () => setSettingsOpen(true),
    newTray: () => openNew(),
    importFrom: openImport,
    importFolder,
    upload,
    help: () => setHelpOpen(true),
    toggleFilmstrip,
    toggleInspector,
    focusMode,
  });
  const dropping = useFolderDrop((path) => importFolder(path));

  const toggles = session ? (
    <PanelToggles
      filmstrip={panels.filmstrip}
      inspector={panels.inspector}
      onFilmstrip={toggleFilmstrip}
      onInspector={toggleInspector}
    />
  ) : null;
  const todo = session ? session.groups.filter(needsReview).length : 0;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {desktop && (
        <WindowTitlebar
          title={session?.summary.name ?? "Slide Station"}
          detail={
            session
              ? todo
                ? `${plural(todo, "slide")} to review`
                : session.summary.pending_upload
                  ? `${session.summary.pending_upload} to upload`
                  : session.summary.slides
                    ? "all in Immich"
                    : undefined
              : undefined
          }
          right={toggles}
        />
      )}
      <TopBar
        compact={!!desktop}
        panelToggles={desktop ? null : toggles}
        state={state}
        sessionId={sessionId}
        onSelectSession={(id) => app.loadSession(id)}
        onNewTray={() => openNew()}
        onImport={openImport}
        onEject={(src) => app.eject(src.path)}
        onHelp={() => setHelpOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />

      <main className="flex min-h-0 flex-1">
        {!state ? null : !hasTrays ? (
          <EmptyState source={source} onImport={openImport} onImportFolder={() => importFolder()} />
        ) : session ? (
          <>
            {panels.filmstrip && (
              <Filmstrip
                session={session}
                sessionId={sessionId}
                sel={app.sel}
                filter={filter}
                onFilter={setFilter}
                onSelect={app.select}
              />
            )}
            <Stage
              session={session}
              sessionId={sessionId}
              sel={app.sel}
              before={before}
              onBefore={setBefore}
              onToggleScan={app.toggleScan}
              onSplit={app.splitAt}
            />
            {panels.inspector && (
              <Inspector app={app} session={session} busy={busy} onUpload={upload} onClean={clean} />
            )}
          </>
        ) : null}
      </main>

      <ProStatusbar>
        {session ? (
          <>
            <span>{plural(session.summary.slides, "slide")}</span>
            <span>{session.summary.reviewed} reviewed</span>
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
            <Kbd>Space</Kbd> looks good
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
      />
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      {dropping && (
        <div className="ss-drop pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
          <div className="rounded-lg border border-primary/60 bg-(--ss-panel) px-6 py-4 text-center shadow-2xl">
            <div className="text-[14px] font-semibold">Drop a folder of scans</div>
            <div className="mt-1 text-[12px] text-muted-foreground">It becomes a new tray</div>
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
function useKeyboard(app: SlideStation, setBefore: (on: boolean) => void, openHelp: () => void) {
  const latest = React.useRef({ app, setBefore, openHelp });
  latest.current = { app, setBefore, openHelp };

  React.useEffect(() => {
    const isTextEntry = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.isContentEditable ||
        t.matches("textarea, select, input:not([type=range]):not([type=checkbox]), [role=spinbutton]"));
    const modalOpen = () => !!document.querySelector("[role=dialog], [role=alertdialog]");

    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextEntry(e.target) || modalOpen()) return;
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
