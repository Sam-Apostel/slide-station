import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Eraser,
  FolderInput,
  FolderOpen,
  HardDriveDownload,
  Keyboard,
  Layers,
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
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: SlideStation;
  handlers: DesktopHandlers;
  onClean: () => void;
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
            { id: "review", label: "Looks good, next", icon: <ArrowRight />, keys: "Space", run: app.review },
            { id: "next", label: "Next slide", icon: <ArrowRight />, keys: "→", run: () => app.select(sel + 1) },
            { id: "prev", label: "Previous slide", icon: <ArrowLeft />, keys: "←", run: () => app.select(sel - 1) },
            { id: "rot-r", label: "Rotate right", icon: <RotateCw />, keys: "R", run: () => app.rotate(90) },
            { id: "rot-l", label: "Rotate left", icon: <RotateCcw />, keys: "⇧R", run: () => app.rotate(-90) },
            { id: "rot-180", label: "Rotate upside down", icon: <RotateCw />, run: () => app.rotate(180) },
            { id: "copy", label: "Copy colour from previous", icon: <Copy />, keys: "C", hidden: sel === 0, run: app.copyPrev },
            { id: "reset", label: "Reset colour", icon: <Undo2 />, keys: "0", run: app.resetColour },
            { id: "learned", label: "Use learned colour", icon: <Sparkles />, hidden: g.reviewed, run: app.resuggest },
            { id: "rest", label: "Apply colour to the rest", icon: <Layers />, run: app.applyRest },
            {
              id: "skip",
              label: g.skip ? "Unskip slide" : "Skip slide",
              icon: <SkipForward />,
              keys: "X",
              run: app.toggleSkip,
            },
            { id: "merge", label: "Merge with next", icon: <Merge />, keys: "M", hidden: sel >= count - 1, run: app.mergeNext },
          ]
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
          id: "upload",
          label: sm?.pending_upload ? `Upload ${plural(sm.pending_upload, "slide")} to Immich` : "Upload to Immich",
          icon: <Upload />,
          keys: `${mod}U`,
          hidden: !sm?.pending_upload || busy,
          run: handlers.upload,
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
      ],
    ],
    [
      "Slide Station",
      [
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
