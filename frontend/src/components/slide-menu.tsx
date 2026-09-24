import type * as React from "react";
import { Aperture, ArrowRight, Copy, FlipHorizontal2, Merge, RotateCcw, RotateCw, SkipForward, Sparkles, Undo2, Wand2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { SlideStation } from "@/hooks/use-slide-station";

/**
 * Right-click menu for a slide (a filmstrip tile or the photo on the stage). Opening it selects
 * that slide, so every item acts on it through the same actions as the keyboard map.
 */
export function SlideMenu({
  app,
  index,
  children,
}: {
  app: SlideStation;
  index: number;
  children: React.ReactElement;
}) {
  const g = app.session?.groups[index];
  const count = app.session?.groups.length ?? 0;
  return (
    <ContextMenu onOpenChange={(open) => open && app.select(index)}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {g && (
        <ContextMenuContent className="min-w-[210px]">
          <ContextMenuItem onSelect={app.review}>
            {g.reviewed ? <ArrowRight /> : <Aperture />} {g.reviewed ? "Next to develop" : "Develop"}
            <ContextMenuShortcut>Space</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => app.rotate(90)}>
            <RotateCw /> Rotate right
            <ContextMenuShortcut>R</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => app.rotate(-90)}>
            <RotateCcw /> Rotate left
            <ContextMenuShortcut>⇧R</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => app.rotate(180)}>
            <RotateCw /> Upside down
          </ContextMenuItem>
          <ContextMenuItem onSelect={app.mirror}>
            <FlipHorizontal2 /> Mirror
            <ContextMenuShortcut>H</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={app.copyPrev} disabled={index === 0}>
            <Copy /> Copy colour from previous
            <ContextMenuShortcut>C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={app.resetColour}>
            <Undo2 /> Reset colour
            <ContextMenuShortcut>0</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => app.fitCurves()}>
            <Wand2 /> Fit curves to data
            <ContextMenuShortcut>F</ContextMenuShortcut>
          </ContextMenuItem>
          {!g.reviewed && (
            <ContextMenuItem onSelect={() => app.resuggest()}>
              <Sparkles /> Use learned colour
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={app.toggleSkip}>
            <SkipForward /> {g.skip ? "Unskip slide" : "Skip slide"}
            <ContextMenuShortcut>X</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={app.mergeNext} disabled={index >= count - 1}>
            <Merge /> Merge with next
            <ContextMenuShortcut>M</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
