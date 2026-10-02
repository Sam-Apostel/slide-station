import * as React from "react";
import {
  Aperture,
  CalendarDays,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronsUpDown,
  Crop,
  Images,
  Inbox,
  Layers,
  RotateCw,
  Settings,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Spline,
  SunDim,
  Users,
  X,
} from "lucide-react";
import type { SectionId } from "@/components/inspector";
import type { SlideStation } from "@/hooks/use-slide-station";
import type { Layout } from "@/lib/layout";
import { cn } from "@/lib/utils";

/** A phone's tools: the inspector's sections, plus the slides (the filmstrip with its filters and
 *  scenes) and the scans stacked into the slide. */
export type Tool = SectionId | "slides" | "scans";

const TOOLS: { id: Tool; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "slides", label: "Slides", icon: Images },
  { id: "rotation", label: "Frame", icon: Crop },
  { id: "colour", label: "Adjust", icon: SlidersHorizontal },
  { id: "curve", label: "Curve", icon: Spline },
  { id: "local", label: "Local", icon: SunDim },
  { id: "scans", label: "Scans", icon: Layers },
  { id: "details", label: "Details", icon: CalendarDays },
  { id: "people", label: "People", icon: Users },
  { id: "insights", label: "Insights", icon: Sparkles },
  { id: "tray", label: "Tray", icon: Inbox },
];

export const toolLabel = (t: Tool) => TOOLS.find((x) => x.id === t)!.label;

/**
 * The app on a phone. Upright: the photo on top, the open tool's panel under it (or a row of the
 * tray's slides), a row of tools, and the bar with what every slide gets: Skip, Turn, Develop.
 * On its side: the photo full height, the open tool's panel beside it and the tools in a rail at
 * the edge, Develop at the bottom of it where the thumb rests.
 *
 * The tools are the inspector's sections one at a time (the same components as the wide layout),
 * so nothing the editor can do is left out.
 */
export function CompactShell({
  layout,
  app,
  trayName,
  well,
  onPeople,
  onSettings,
  main,
  stage,
  strip,
  tools,
  tool,
  onTool,
  panel,
  immersive,
}: {
  layout: Exclude<Layout, "wide">;
  app: SlideStation;
  trayName: string;
  /** The activity well (a job's progress, a card with new scans), when it has something to say. */
  well: React.ReactNode;
  onPeople?: () => void;
  onSettings: () => void;
  /** In place of the tray: the empty state, People & Places. */
  main?: React.ReactNode;
  stage: React.ReactNode;
  /** The row of the tray's slides under the photo (upright only). */
  strip: React.ReactNode;
  /** The tools this slide has (People only with faces or recognition on, …). */
  tools: Tool[];
  tool: Tool | null;
  onTool: (t: Tool | null) => void;
  panel: (t: Tool) => React.ReactNode;
  /** A tool that takes over the photo (crop): its own bar under the photo, nothing else. */
  immersive: boolean;
}) {
  const shown = TOOLS.filter((t) => tools.includes(t.id));
  const open = tool && tools.includes(tool) ? tool : null;
  const toggle = (t: Tool) => onTool(open === t ? null : t);
  const [tall, setTall] = React.useState(false);

  const headerActions = (
    <>
      {onPeople && (
        <IconButton label="People and places" onClick={onPeople}>
          <Users />
        </IconButton>
      )}
      <IconButton label="Settings" onClick={onSettings}>
        <Settings />
      </IconButton>
    </>
  );

  const toolPanel = open && (
    <section
      className={cn(
        "ss-compact-panel flex min-h-0 flex-col bg-(--ss-panel)",
        layout === "portrait" ? (tall ? "h-[68dvh]" : "h-[44dvh]") : "w-[min(360px,46vw)] border-l border-border",
      )}
      aria-label={toolLabel(open)}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        {layout === "portrait" ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left text-[13px] font-semibold"
            aria-label={tall ? "Make the panel smaller" : "Make the panel taller"}
            onClick={() => setTall((v) => !v)}
          >
            {toolLabel(open)}
            <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
          </button>
        ) : (
          <span className="flex-1 text-[13px] font-semibold">{toolLabel(open)}</span>
        )}
        <IconButton label="Close" onClick={() => onTool(null)}>
          <X />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">{panel(open)}</div>
    </section>
  );

  const g = app.current;
  const develop = g && (
    <button
      type="button"
      className={cn("ss-develop", layout === "landscape" && "ss-develop-square")}
      data-done={g.reviewed || undefined}
      onClick={app.review}
      aria-label={g.reviewed ? "Developed, go to the next slide to develop" : "Develop and go to next"}
    >
      {g.reviewed ? <CheckCheck aria-hidden /> : <Aperture aria-hidden />}
      <span>{g.reviewed ? "Developed" : "Develop"}</span>
    </button>
  );
  const skip = g && (
    <IconButton
      big
      label={g.skip ? "Unskip slide" : "Skip slide"}
      pressed={g.skip}
      onClick={app.toggleSkip}
    >
      <SkipForward />
    </IconButton>
  );
  const turn = g && (
    <IconButton big label="Rotate right" onClick={() => app.rotate(90)} disabled={g.locked}>
      <RotateCw />
    </IconButton>
  );

  if (layout === "landscape" && !main) {
    return (
      <div className="ss-compact flex h-dvh overflow-hidden bg-background text-foreground" data-layout="landscape">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {stage}
          {well && <div className="pointer-events-none absolute inset-x-0 top-11 z-30 flex justify-center px-3 [&>*]:pointer-events-auto">{well}</div>}
        </div>
        {!immersive && toolPanel}
        {!immersive && (
          <nav className="ss-rail flex w-[76px] shrink-0 flex-col border-l border-border bg-(--ss-bar)" aria-label="Tools">
            <div className="flex shrink-0 justify-center gap-0.5 border-b border-border py-1">{headerActions}</div>
            <div className="flex min-h-0 flex-1 flex-col items-stretch gap-0.5 overflow-y-auto overscroll-contain py-1">
              {shown.map((t) => (
                <ToolButton key={t.id} tool={t} active={open === t.id} onClick={() => toggle(t.id)} />
              ))}
            </div>
            {g && (
              <div className="flex shrink-0 flex-col gap-1.5 border-t border-border p-1.5">
                <div className="flex justify-between">
                  {skip}
                  {turn}
                </div>
                {develop}
              </div>
            )}
          </nav>
        )}
      </div>
    );
  }

  return (
    <div className="ss-compact flex h-dvh flex-col overflow-hidden bg-background text-foreground" data-layout={layout}>
      <header className="ss-compact-head flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-(--ss-bar) pr-1.5 pl-3">
        <img src="./favicon.svg" alt="" aria-hidden className="size-[22px] shrink-0" />
        {main ? (
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">Slide Station</span>
        ) : (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 self-stretch text-left"
            onClick={() => toggle("tray")}
            aria-label={`Tray: ${trayName}. Trays, upload and the card`}
          >
            <span className="truncate text-[15px] font-semibold">{trayName}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        )}
        {headerActions}
      </header>
      {well && <div className="flex shrink-0 justify-center border-b border-border bg-(--ss-bar) px-3 py-1.5">{well}</div>}
      {main ? (
        <main className="flex min-h-0 flex-1 overflow-y-auto">{main}</main>
      ) : (
        <>
          <div className="flex min-h-[28dvh] flex-1 flex-col">{stage}</div>
          {!immersive && (toolPanel || <div className="h-[92px] shrink-0 border-t border-border bg-[var(--pro-canvas)]">{strip}</div>)}
          {!immersive && (
            <nav
              className="ss-tools flex shrink-0 gap-0.5 overflow-x-auto overscroll-x-contain border-t border-border bg-(--ss-bar) px-1.5 py-1"
              aria-label="Tools"
            >
              {shown.map((t) => (
                <ToolButton key={t.id} tool={t} active={open === t.id} onClick={() => toggle(t.id)} />
              ))}
            </nav>
          )}
          {!immersive && g && (
            <div className="ss-compact-bar flex shrink-0 items-center gap-2 border-t border-border bg-(--ss-panel) px-3 pt-2">
              <IconButton big label="Previous slide" onClick={() => app.select(app.sel - 1)} disabled={app.sel <= 0}>
                <ChevronLeft />
              </IconButton>
              {skip}
              {turn}
              <div className="min-w-0 flex-1">{develop}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ToolButton({
  tool,
  active,
  onClick,
}: {
  tool: (typeof TOOLS)[number];
  active: boolean;
  onClick: () => void;
}) {
  const Icon = tool.icon;
  return (
    <button type="button" className="ss-tool" aria-pressed={active} onClick={onClick}>
      <Icon aria-hidden />
      <span>{tool.label}</span>
    </button>
  );
}

function IconButton({
  label,
  big,
  pressed,
  ...props
}: { label: string; big?: boolean; pressed?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      className={cn("ss-icon-btn", big && "ss-icon-btn-big")}
      {...props}
    />
  );
}
