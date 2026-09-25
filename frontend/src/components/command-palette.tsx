import * as React from "react";
import {
  Aperture,
  Bookmark,
  CalendarRange,
  Camera,
  ChartNoAxesColumn,
  CloudDownload,
  Images,
  LayoutGrid,
  Search,
  SunDim,
  ZoomIn,
  Wand2,
  ArrowLeft,
  ArrowRight,
  Copy,
  Eraser,
  FlipHorizontal2,
  FolderInput,
  FolderOpen,
  HardDriveDownload,
  Keyboard,
  Layers,
  ListChecks,
  Merge,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  RotateCw,
  ScanEye,
  Settings,
  SkipForward,
  Sparkles,
  Undo2,
  Upload,
  Users,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { suggestionPiles } from "@/components/insights";
import type { DesktopHandlers } from "@/hooks/use-desktop";
import type { SlideStation } from "@/hooks/use-slide-station";
import { plural, sourceLabel } from "@/lib/api";
import { isMac } from "@/lib/desktop";

type Entry = {
  id: string;
  label: string;
  icon: React.ReactNode;
  keys?: string;
  hidden?: boolean;
  run: () => void;
};

const mod = isMac ? "⌘" : "Ctrl+";
const alt = isMac ? "⌥⌘" : "Ctrl+Alt+";

/**
 * ⌘K: every action in one searchable list, including switching trays. Items call the same
 * actions as the keyboard map, the menus and the buttons.
 */
export function CommandPalette({
  open,
  onOpenChange,
  app,
  handlers,
  onClean,
  onDateRange,
  onFromImmich,
  views,
  grid,
  onReview,
  onPeople,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: SlideStation;
  handlers: DesktopHandlers;
  onClean: () => void;
  /** Opens the "date a range of slides" dialog. */
  onDateRange: () => void;
  /** Opens "pull photos back in from Immich". */
  onFromImmich: () => void;
  /** The review grid, zoom, loupe, and the stats / presets / develop-like dialogs. */
  views: {
    toggleGrid: () => void;
    toggleZoom: () => void;
    toggleLoupe: () => void;
    /** The Local tool (local adjustments on the photo). */
    toggleLocal: () => void;
    stats: () => void;
    presets: () => void;
    developLike: () => void;
  };
  grid: boolean;
  /** Opens the tray's "review suggestions". */
  onReview?: () => void;
  /** Opens the People dialog (when recognising people is on). */
  onPeople?: () => void;
  busy: boolean;
}) {
  const { state, session, sessionId, sel } = app;
  const g = app.current;
  const count = session?.groups.length ?? 0;
  const src = state?.sources.find((x) => x.new > 0);
  const sm = session?.summary;
  // Controlled so every opening starts empty, even one during the closing animation.
  const [search, setSearch] = React.useState("");
  React.useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  const groups: [string, Entry[]][] = [
    [
      "Slide",
      g
        ? [
            { id: "review", label: "Develop, next", icon: <Aperture />, keys: "Space", run: app.review },
            { id: "next", label: "Next slide", icon: <ArrowRight />, keys: "→", run: () => app.select(sel + 1) },
            { id: "prev", label: "Previous slide", icon: <ArrowLeft />, keys: "←", run: () => app.select(sel - 1) },
            { id: "rot-r", label: "Rotate right", icon: <RotateCw />, keys: "R", run: () => app.rotate(90) },
            { id: "rot-l", label: "Rotate left", icon: <RotateCcw />, keys: "⇧R", run: () => app.rotate(-90) },
            { id: "rot-180", label: "Rotate upside down", icon: <RotateCw />, run: () => app.rotate(180) },
            { id: "mirror", label: "Mirror left-right", icon: <FlipHorizontal2 />, keys: "H", run: app.mirror },
            { id: "copy", label: "Copy colour from previous", icon: <Copy />, keys: "C", hidden: sel === 0, run: app.copyPrev },
            { id: "reset", label: "Reset colour", icon: <Undo2 />, keys: "0", run: app.resetColour },
            { id: "fit", label: "Fit curves to data", icon: <Wand2 />, keys: "F", run: () => app.fitCurves() },
            {
              id: "fit-all",
              label: "Fit curves of every slide to develop",
              icon: <Wand2 />,
              keys: "⇧F",
              run: () => app.fitCurves(true),
            },
            { id: "learned", label: "Use learned colour", icon: <Sparkles />, hidden: g.reviewed, run: () => app.resuggest() },
            {
              id: "learned-all",
              label: "Use learned colour on every slide to develop",
              icon: <Sparkles />,
              run: () => app.resuggest(true),
            },
            { id: "rest", label: "Apply colour to the rest", icon: <Layers />, run: app.applyRest },
            { id: "presets", label: "Presets: save or apply a colour…", icon: <Bookmark />, run: views.presets },
            { id: "like", label: "Develop like another slide…", icon: <Images />, run: views.developLike },
            {
              id: "skip",
              label: g.skip ? "Unskip slide" : "Skip slide",
              icon: <SkipForward />,
              keys: "X",
              run: app.toggleSkip,
            },
            { id: "date-range", label: "Date a range of slides…", icon: <CalendarRange />, run: onDateRange },
            { id: "merge", label: "Merge with next", icon: <Merge />, keys: "M", hidden: sel >= count - 1, run: app.mergeNext },
          ]
        : [],
    ],
    [
      "Presets",
      g
        ? app.presets.flatMap((p) => [
            {
              id: `preset-${p.name}`,
              label: `Apply preset “${p.name}”`,
              icon: <Bookmark />,
              hidden: g.locked,
              run: () => void app.applyLook({ preset: p.name }),
            },
            {
              id: `preset-rest-${p.name}`,
              label: `Apply preset “${p.name}” to this and the rest`,
              icon: <Bookmark />,
              run: () => void app.applyLook({ preset: p.name }, "rest"),
            },
          ])
        : [],
    ],
    [
      "Tray",
      [
        { id: "new", label: "New tray…", icon: <Plus />, keys: `${mod}N`, run: handlers.newTray },
        {
          id: "import",
          label: src ? `Import ${plural(src.new, "scan")} from ${sourceLabel(src)}` : "Import from scanner",
          icon: <HardDriveDownload />,
          keys: `${mod}I`,
          hidden: !src || busy,
          run: () => src && handlers.importFrom(src),
        },
        { id: "folder", label: "Import a folder…", icon: <FolderInput />, keys: `${mod}⇧O`, run: () => handlers.importFolder() },
        {
          id: "capture",
          label: `Capture with ${state?.camera?.cameras[0]?.model ?? "the camera"}`,
          icon: <Camera />,
          keys: "P",
          hidden: !state?.camera?.cameras.length || !session || busy,
          run: app.capture,
        },
        {
          id: "from-immich",
          label: "Pull photos back in from Immich…",
          icon: <Images />,
          hidden: busy,
          run: onFromImmich,
        },
        {
          id: "upload",
          label: `Upload ${plural(sm?.ready_upload ?? 0, "developed slide")} to Immich`,
          icon: <Upload />,
          keys: `${mod}U`,
          hidden: !sm?.ready_upload || busy,
          run: handlers.upload,
        },
        {
          id: "upload-all",
          label: `Upload all ${plural(sm?.pending_upload ?? 0, "slide")} to Immich`,
          icon: <Upload />,
          keys: sm?.ready_upload ? undefined : `${mod}U`,
          hidden: !sm?.pending_upload || sm.pending_upload === sm.ready_upload || busy,
          run: handlers.uploadAll,
        },
        {
          id: "pull-meta",
          label: "Pull captions and dates from Immich",
          icon: <CloudDownload />,
          hidden: !session?.groups.some((x) => x.status === "uploaded" || x.status === "changed"),
          run: app.pullFromImmich,
        },
        {
          id: "review-insights",
          label: "Review suggestions (tags, film stock, dates, look-alikes)…",
          icon: <ListChecks />,
          // film stock and date guesses need no model: reviewable with the tag model off (and in the browser)
          hidden: !session || !onReview || !(session.insights?.enabled || suggestionPiles(session.groups).length),
          run: () => onReview?.(),
        },
        {
          id: "analyse",
          label: "Analyse the tray again",
          icon: <ListChecks />,
          hidden: !session || !onReview || !session.insights?.ready || !session.insights.enabled,
          run: () => app.analyseTray(true),
        },
        {
          id: "lookalikes",
          label: "Look for this tray's slides among the photos already in Immich",
          icon: <ListChecks />,
          // the look-alike check (needs the tag model); runs by itself after uploads when turned on
          hidden:
            !session ||
            !onReview ||
            !session.insights?.ready ||
            busy ||
            !session.groups.some((x) => x.status === "uploaded" || x.status === "changed"),
          run: () => app.checkLookalikes(true),
        },
        { id: "reveal", label: "Show files", icon: <FolderOpen />, hidden: !session, run: app.reveal },
        {
          id: "clean",
          label: "Clean scanner card…",
          icon: <Eraser />,
          hidden: !session || busy || !!sm?.card_cleaned || !!session?.cleanup_blockers.length,
          run: onClean,
        },
      ],
    ],
    [
      "Open tray",
      (state?.sessions ?? [])
        .filter((s) => s.id !== sessionId)
        .map((s) => ({
          id: `tray-${s.id}`,
          label: `${s.name} · ${plural(s.slides, "slide")}`,
          icon: <Layers />,
          run: () => app.loadSession(s.id),
        })),
    ],
    [
      "View",
      [
        { id: "filmstrip", label: "Show or hide filmstrip", icon: <PanelLeft />, keys: `${alt}1`, run: handlers.toggleFilmstrip },
        { id: "inspector", label: "Show or hide inspector", icon: <PanelRight />, keys: `${alt}2`, run: handlers.toggleInspector },
        { id: "focus", label: "Focus on the photo", icon: <ScanEye />, keys: `${alt}F`, run: handlers.focusMode },
        {
          id: "grid",
          label: grid ? "Back to the single slide" : "Review grid",
          icon: <LayoutGrid />,
          keys: "G",
          hidden: !count,
          run: views.toggleGrid,
        },
        { id: "zoom", label: "Zoom to 100 %", icon: <ZoomIn />, keys: "Z", hidden: !g || grid, run: views.toggleZoom },
        { id: "loupe", label: "Loupe", icon: <Search />, keys: "L", hidden: !g || grid, run: views.toggleLoupe },
        {
          id: "local",
          label: "Local adjustments (graduated, radial, brush)",
          icon: <SunDim />,
          keys: "A",
          hidden: !g || grid || !!g.locked,
          run: views.toggleLocal,
        },
      ],
    ],
    [
      "Slide Station",
      [
        {
          id: "stats",
          label: "Stats: slides per hour, projected finish…",
          icon: <ChartNoAxesColumn />,
          run: views.stats,
        },
        { id: "people", label: "People & Places…", icon: <Users />, hidden: !onPeople, run: () => onPeople?.() },
        { id: "settings", label: "Settings…", icon: <Settings />, keys: `${mod},`, run: handlers.settings },
        { id: "help", label: "Keyboard shortcuts", icon: <Keyboard />, keys: "?", run: handlers.help },
      ],
    ],
  ];

  const run = (fn: () => void) => {
    onOpenChange(false);
    // After the palette has closed, so a confirm dialog the action opens gets focus.
    setTimeout(fn, 0);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search for an action"
      showCloseButton={false}
      className="top-[20%] translate-y-0 sm:max-w-[520px]"
    >
      <CommandInput placeholder="Type an action or a tray name…" value={search} onValueChange={setSearch} />
      <CommandList className="max-h-[360px] scrollbar-thin">
        <CommandEmpty>Nothing matches</CommandEmpty>
        {groups.map(([heading, entries]) => {
          const shown = entries.filter((e) => !e.hidden);
          return shown.length ? (
            <CommandGroup key={heading} heading={heading}>
              {shown.map((e) => (
                <CommandItem key={e.id} value={`${heading} ${e.label}`} onSelect={() => run(e.run)}>
                  {e.icon}
                  {e.label}
                  {e.keys && <CommandShortcut>{e.keys}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null;
        })}
      </CommandList>
    </CommandDialog>
  );
}
