import type * as React from "react";
import {
  Camera,
  ChartNoAxesColumn,
  CircleHelp,
  Eye,
  FolderInput,
  HardDriveDownload,
  Plus,
  Settings,
  Users,
} from "lucide-react";
import { ProButton } from "@/components/ui/pro-button";
import { Tip } from "@/components/tip";
import { desktop, isMac } from "@/lib/desktop";
import { ProSeparator, ProToolbar } from "@/components/ui/pro-toolbar";
import { ProTitlebarWell } from "@/components/ui/pro-titlebar";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { plural, sourceLabel, standalone, type AppState, type Source } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Shows a job for a few seconds after it finishes, and failures until the next job. */
export function visibleJob(state: AppState | null) {
  const j = state?.job;
  if (!j) return null;
  return !j.finished || Date.now() / 1000 - j.started < 4 || j.error ? j : null;
}

type TopBarProps = {
  state: AppState | null;
  sessionId: string;
  onSelectSession: (id: string) => void;
  onNewTray: () => void;
  onImport: (src: Source) => void;
  onEject: (src: Source) => void;
  /** Browser version: pick a folder of scans (there is no scanner to wait for). */
  onChooseFolder?: () => void;
  /** Camera rig mode: take a picture with the tethered camera into the open tray. */
  onCapture?: () => void;
  /** An import or upload a server restart cut off: run it again. */
  onResume?: () => void;
  onHelp: () => void;
  /** Progress across the library (slides per hour, projected finish). */
  onStats?: () => void;
  onSettings: () => void;
  /** The People dialog; only when recognising people is on. */
  onPeople?: () => void;
};

/** Which tray is open, and a new one. */
export function TraySwitcher({
  state,
  sessionId,
  onSelectSession,
  onNewTray,
}: Pick<TopBarProps, "state" | "sessionId" | "onSelectSession" | "onNewTray">) {
  const sessions = state?.sessions ?? [];
  return (
    <>
      <NativeSelect
        size="sm"
        aria-label="Tray"
        className="w-[240px] font-medium"
        value={sessions.some((s) => s.id === sessionId) ? sessionId : ""}
        onChange={(e) => onSelectSession(e.target.value)}
        disabled={!sessions.length}
      >
        {!sessions.length && <NativeSelectOption value="">No trays yet</NativeSelectOption>}
        {sessions.map((s) => (
          <NativeSelectOption key={s.id} value={s.id}>
            {s.name} · {plural(s.slides, "slide")}
            {!s.pending_upload && s.slides ? " ✓" : ""}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Tip label="Start a new tray" keys={isMac ? "⌘N" : "Ctrl+N"}>
        <ProButton onClick={onNewTray}>
          <Plus /> New tray
        </ProButton>
      </Tip>
    </>
  );
}

/** The activity well: a running job's progress, or the scanner and its Import button. */
export function ActivityWell({
  state,
  onImport,
  onEject,
  onChooseFolder,
  onCapture,
  onResume,
  onSettings,
  className,
}: Pick<TopBarProps, "state" | "onImport" | "onEject" | "onChooseFolder" | "onCapture" | "onResume"> &
  Partial<Pick<TopBarProps, "onSettings">> & {
    className?: string;
  }) {
  const src = state?.sources.find((x) => x.new > 0) ?? state?.sources[0];
  const job = visibleJob(state);
  // watched folders (Settings): shown while something in them waits or failed, unless a card has news
  const w = state?.watch;
  const watching = w && (w.waiting || w.queued || w.errors) && !src?.new ? w : null;
  // a hosted server has no scanner of yours to wait for: folders are uploaded from the browser
  const pickOnly = standalone || !!state?.server?.accounts;
  const camera = onCapture ? state?.camera?.cameras[0] : undefined;
  return (
    <ProTitlebarWell
      data-tone={job?.error ? "bad" : !job && src ? "ok" : undefined}
      // sized to what it says, like the first version's scanner chip; a job gets room for its bar
      className={cn(
        "ss-well h-[28px] max-w-full flex-row gap-2 text-[12px]",
        job ? "relative w-[320px] px-3" : "w-auto py-0 pr-[3px] pl-3",
        job?.interrupted && job.resumable && onResume && "pr-[3px]",
        className,
      )}
    >
      {job ? (
        <>
          {/* the pill itself is the progress bar: it fills up as the job goes */}
          <span
            aria-hidden
            className="ss-well-fill"
            data-state={job.error ? "error" : job.finished ? "done" : job.total ? "running" : "waiting"}
            style={{ width: `${job.error || job.finished ? 100 : job.total ? (100 * job.done) / job.total : 100}%` }}
          />
          <span
            role="status"
            aria-live="polite"
            className={cn(
              "relative min-w-0 flex-1 truncate text-center font-medium",
              job.error ? "text-destructive" : "text-foreground/90",
            )}
          >
            {job.interrupted && job.resumable && onResume
              ? `${job.kind === "upload" ? "Upload" : "Import"} cut off by a server restart`
              : job.interrupted
                ? job.error
                : job.error
                  ? `Failed: ${job.error}`
                  : job.finished
                    ? job.message
                    : `${job.message} · ${job.done}/${job.total || "?"}`}
          </span>
          {job.interrupted && job.resumable && onResume && (
            <Tip
              label={
                job.kind === "upload"
                  ? "Upload again: slides already in Immich are skipped"
                  : "Import again: scans already imported are skipped"
              }
            >
              <ProButton active className="relative" onClick={onResume}>
                Resume
              </ProButton>
            </Tip>
          )}
        </>
      ) : watching ? (
        <>
          <Eye
            aria-hidden
            className={cn("size-3.5 shrink-0", watching.errors ? "text-destructive" : "text-[var(--pro-green)]")}
          />
          <span role="status" className="min-w-0 truncate">
            Watched folders ·{" "}
            {[
              watching.waiting && `${watching.waiting} waiting`,
              watching.queued && `${watching.queued} queued`,
              watching.errors && `${plural(watching.errors, "error")}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {onSettings && <ProButton onClick={onSettings}>Show</ProButton>}
        </>
      ) : src ? (
        <>
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-[var(--pro-green)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--pro-green)_20%,transparent)]"
          />
          <span className="min-w-0 truncate">
            {sourceLabel(src)} ·{" "}
            {src.new ? <b className="font-semibold text-foreground">{plural(src.new, "new scan")}</b> : "nothing new"}
          </span>
          {src.new ? (
            <ProButton active onClick={() => onImport(src)}>
              <HardDriveDownload /> Import
            </ProButton>
          ) : pickOnly ? (
            <ProButton onClick={onChooseFolder}>
              <FolderInput /> Another folder
            </ProButton>
          ) : (
            <ProButton onClick={() => onEject(src)}>Eject</ProButton>
          )}
        </>
      ) : camera ? (
        <>
          <Camera aria-hidden className="size-3.5 shrink-0 text-[var(--pro-green)]" />
          <span className="min-w-0 truncate">{camera.model}</span>
          <Tip label="Take a picture into this tray" keys="P">
            <ProButton active onClick={onCapture}>
              Capture
            </ProButton>
          </Tip>
        </>
      ) : pickOnly ? (
        <>
          <span className="min-w-0 truncate pl-1 text-muted-foreground">Drop a folder of scans, or</span>
          <ProButton active onClick={onChooseFolder}>
            <FolderInput /> Choose folder
          </ProButton>
        </>
      ) : (
        <span className="px-1 text-muted-foreground">Waiting for the scanner…</span>
      )}
    </ProTitlebarWell>
  );
}

/** Shortcuts and settings, at the right end of whichever bar is on top. */
export function AppActions({
  onHelp,
  onSettings,
  onStats,
  onPeople,
}: Pick<TopBarProps, "onHelp" | "onSettings" | "onStats" | "onPeople">) {
  return (
    <>
      {onStats && (
        <Tip label="Stats: slides per hour, projected finish">
          <ProButton onClick={onStats} aria-label="Stats">
            <ChartNoAxesColumn />
          </ProButton>
        </Tip>
      )}
      {onPeople && (
        <Tip label="People & Places">
          <ProButton onClick={onPeople} aria-label="People and places">
            <Users />
          </ProButton>
        </Tip>
      )}
      <Tip label="Keyboard shortcuts" keys="?">
        <ProButton onClick={onHelp} aria-label="Keyboard shortcuts">
          <CircleHelp />
        </ProButton>
      </Tip>
      <Tip label="Settings" keys={desktop ? (isMac ? "⌘," : "Ctrl+,") : undefined}>
        <ProButton onClick={onSettings} aria-label="Settings">
          <Settings />
        </ProButton>
      </Tip>
    </>
  );
}

/** The top bar in a browser tab. The desktop app puts the same pieces in its window titlebar. */
export function TopBar({ panelToggles, ...props }: TopBarProps & { panelToggles?: React.ReactNode }) {
  return (
    <ProToolbar className="gap-2">
      <div className="flex items-center gap-2 pr-2 text-[13px] font-semibold tracking-[0.01em] text-foreground/90">
        <img src="./favicon.svg" alt="" aria-hidden className="size-[20px]" />
        Slide Station
      </div>
      <ProSeparator />
      <TraySwitcher {...props} />
      <div className="flex min-w-0 flex-1 justify-center px-2">
        <ActivityWell {...props} />
      </div>
      {panelToggles && (
        <>
          {panelToggles}
          <ProSeparator />
        </>
      )}
      <AppActions {...props} />
    </ProToolbar>
  );
}
