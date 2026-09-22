import { CircleHelp, HardDriveDownload, Plus, Settings, Usb } from "lucide-react";
import { ProButton } from "@/components/ui/pro-button";
import { ProSeparator, ProToolbar } from "@/components/ui/pro-toolbar";
import { ProTitlebarWell } from "@/components/ui/pro-titlebar";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { plural, sourceLabel, type AppState, type Source } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Shows a job for a few seconds after it finishes, and failures until the next job. */
export function visibleJob(state: AppState | null) {
  const j = state?.job;
  if (!j) return null;
  return !j.finished || Date.now() / 1000 - j.started < 4 || j.error ? j : null;
}

export function TopBar({
  state,
  sessionId,
  onSelectSession,
  onNewTray,
  onImport,
  onEject,
  onHelp,
  onSettings,
}: {
  state: AppState | null;
  sessionId: string;
  onSelectSession: (id: string) => void;
  onNewTray: () => void;
  onImport: (src: Source) => void;
  onEject: (src: Source) => void;
  onHelp: () => void;
  onSettings: () => void;
}) {
  const sessions = state?.sessions ?? [];
  const src = state?.sources.find((x) => x.new > 0) ?? state?.sources[0];
  const job = visibleJob(state);

  return (
    <ProToolbar className="gap-2">
      <div className="flex items-center gap-2 pr-2 text-[13px] font-semibold tracking-[0.01em] text-white/90">
        <span aria-hidden className="relative size-[18px] rounded-[3px] bg-primary">
          <span className="absolute inset-x-[4px] inset-y-[5px] rounded-[1px] bg-[#262626]" />
        </span>
        Slide Station
      </div>
      <ProSeparator />
      <NativeSelect
        size="sm"
        aria-label="Tray"
        className="w-[260px]"
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
      <ProButton onClick={onNewTray} title="New tray">
        <Plus /> New tray
      </ProButton>

      <div className="flex min-w-0 flex-1 justify-center px-2">
        <ProTitlebarWell className="h-[31px] w-full max-w-[440px] flex-row gap-2.5 px-3 text-[11px]">
          {job ? (
            <div className="flex w-full min-w-0 flex-col gap-[3px]" role="status" aria-live="polite">
              <span
                className={cn("truncate text-center font-medium", job.error ? "text-destructive" : "text-white/80")}
              >
                {job.error
                  ? `Failed: ${job.error}`
                  : job.finished
                    ? job.message
                    : `${job.message} (${job.done}/${job.total || "?"})`}
              </span>
              {!job.error && (
                <Progress
                  aria-label="Job progress"
                  value={job.total ? (100 * job.done) / job.total : job.finished ? 100 : 5}
                  className="h-[3px]"
                />
              )}
            </div>
          ) : src ? (
            <>
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-[var(--pro-green)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--pro-green)_20%,transparent)]"
              />
              <Usb className="size-3.5 shrink-0 text-white/50" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-white/80">
                {sourceLabel(src)} ·{" "}
                {src.new ? <b className="font-semibold text-white">{plural(src.new, "new scan")}</b> : "nothing new"}
              </span>
              {src.new ? (
                <ProButton active onClick={() => onImport(src)}>
                  <HardDriveDownload /> Import
                </ProButton>
              ) : (
                <ProButton onClick={() => onEject(src)}>Eject</ProButton>
              )}
            </>
          ) : (
            <span className="text-white/45">Waiting for the scanner…</span>
          )}
        </ProTitlebarWell>
      </div>

      <ProButton onClick={onHelp} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        <CircleHelp />
      </ProButton>
      <ProButton onClick={onSettings}>
        <Settings /> Settings
      </ProButton>
    </ProToolbar>
  );
}
