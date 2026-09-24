import * as React from "react";
import { LayoutGrid, Lock } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { ProButton } from "@/components/ui/pro-button";
import { Tip } from "@/components/tip";
import { PreviewImg, STATUS_DOT, STATUS_LABEL } from "@/components/filmstrip";
import { needsReview, previewUrl, type SessionPayload } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Rendered size of the grid's previews: big enough to judge a slide, still the quick small render. */
export const GRID_SIZE = 400;
const MIN_TILE = 230; // px; the column count follows the stage's width (4 on a laptop)

/**
 * The batch review grid (G): every slide of the tray as a tile, for the quick "all good" pass.
 * The cursor is the selection, so the keyboard map drives it (App.tsx): arrows move it, Space
 * develops and steps on, X skips, R turns, Enter opens the slide in the normal view.
 */
export function ReviewGrid({
  session,
  sessionId,
  sel,
  onSelect,
  onOpen,
  onClose,
  columns,
  slideMenu,
}: {
  session: SessionPayload;
  sessionId: string;
  sel: number;
  onSelect: (i: number) => void;
  /** Open slide i in the normal view. */
  onOpen: (i: number) => void;
  onClose: () => void;
  /** Written with the current column count, for ↑ ↓ in the keyboard map. */
  columns: React.MutableRefObject<number>;
  slideMenu: (index: number, el: React.ReactElement) => React.ReactElement;
}) {
  const [el, setEl] = React.useState<HTMLDivElement | null>(null);
  const [cols, setCols] = React.useState(4);
  React.useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setCols(Math.max(2, Math.min(6, Math.floor(e.contentRect.width / MIN_TILE)))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  columns.current = cols;

  const selRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const todo = session.groups.filter(needsReview).length;
  return (
    <section className="flex size-full min-h-0 min-w-0 flex-col bg-[var(--pro-well)]" aria-label="Review grid">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-(--ss-bar) px-3.5 text-[11px] text-muted-foreground">
        <span className="text-[12px] font-semibold text-foreground/90">
          {sel + 1}
          <span className="font-normal text-(--ss-dim)"> / {session.groups.length}</span>
        </span>
        <span>{todo ? `${todo} to develop` : "✓ All developed"}</span>
        <span className="ml-auto flex items-center gap-2.5 whitespace-nowrap [&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:text-[10px] max-lg:[&>span]:hidden">
          <span>
            <Kbd>Space</Kbd> develop
          </span>
          <span>
            <Kbd>X</Kbd> skip
          </span>
          <span>
            <Kbd>R</Kbd> turn
          </span>
          <span>
            <Kbd>Enter</Kbd> open
          </span>
          <Tip label="Back to the single slide" keys="G">
            <ProButton aria-label="Close review grid" aria-pressed data-on onClick={onClose}>
              <LayoutGrid />
            </ProButton>
          </Tip>
        </span>
      </div>
      <div
        ref={setEl}
        className="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-y-auto p-3.5 scrollbar-thin"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        role="grid"
        aria-label="Slides"
        aria-colcount={cols}
      >
        {session.groups.map((g) => {
          const isSel = g.index === sel;
          return slideMenu(
            g.index,
            <button
              key={g.id}
              ref={isSel ? selRef : undefined}
              type="button"
              role="gridcell"
              aria-selected={isSel}
              aria-label={`Slide ${g.index + 1}, ${STATUS_LABEL[g.status]}`}
              data-status={g.status}
              onClick={() => onSelect(g.index)}
              onDoubleClick={() => onOpen(g.index)}
              className={cn(
                "ss-grid-tile relative flex aspect-[3/2] cursor-default items-center justify-center overflow-hidden rounded-md border-2 border-transparent bg-black/40",
                isSel && "border-primary",
              )}
            >
              <PreviewImg
                url={previewUrl(sessionId, g, GRID_SIZE)}
                alt=""
                draggable={false}
                className={cn("size-full object-contain", g.skip && "opacity-25 grayscale")}
              />
              <span className="absolute bottom-1 left-1.5 flex items-center gap-1.5 rounded bg-black/65 px-1.5 py-px text-[10px] text-white">
                <span className={cn("size-[7px] rounded-full border border-transparent", STATUS_DOT[g.status])} />
                {String(g.index + 1).padStart(2, "0")}
                {g.skip && <span className="text-(--ss-dim)">skipped</span>}
              </span>
              {g.locked && <Lock className="absolute top-1.5 right-1.5 size-3 text-white/80" aria-label="Locked" />}
            </button>,
          );
        })}
      </div>
    </section>
  );
}
