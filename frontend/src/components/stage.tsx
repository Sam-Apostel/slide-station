import * as React from "react";
import { Scissors } from "lucide-react";
import { Tip } from "@/components/tip";
import { ProButton } from "@/components/ui/pro-button";
import { Spinner } from "@/components/ui/spinner";
import { previewUrl, scanThumbUrl, type Group, type SessionPayload } from "@/lib/api";
import { cn } from "@/lib/utils";
import { STATUS_DOT, STATUS_LABEL, STATUS_TEXT } from "@/components/filmstrip";

/** Loads the wanted preview off-screen and only swaps it in once decoded, so browsing never flashes. */
function usePreloadedImage(url: string | null, warm: string | null) {
  const [shown, setShown] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => {
    if (!url) {
      setShown(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      setShown(url);
      setLoading(false);
    };
    img.onerror = () => live && setLoading(false);
    img.src = url;
    // warm the next slide so arrow-key browsing feels instant
    if (warm) new Image().src = warm;
    return () => {
      live = false;
    };
  }, [url, warm]);
  return { shown, loading: loading && shown !== url };
}

/** Where a click lands on an object-fit: contain image, as 0..1 of the picture (null: on the letterbox). */
function photoPoint(img: HTMLImageElement, clientX: number, clientY: number): [number, number] | null {
  const r = img.getBoundingClientRect();
  const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const x = (clientX - r.left - (r.width - w) / 2) / w;
  const y = (clientY - r.top - (r.height - h) / 2) / h;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : [x, y];
}

export function Stage({
  session,
  sessionId,
  sel,
  before,
  onBefore,
  onToggleScan,
  onSplit,
  slideMenu,
  picking,
  onPicked,
}: {
  session: SessionPayload;
  sessionId: string;
  sel: number;
  before: boolean;
  onBefore: (on: boolean) => void;
  onToggleScan: (scan: string) => void;
  onSplit: (scan: string) => void;
  /** Wraps the photo in the slide's right-click menu. */
  slideMenu: (index: number, el: React.ReactElement) => React.ReactElement;
  /** Eyedropper armed: a click on the photo reports where (0..1), anything else cancels. */
  picking: boolean;
  onPicked: (x: number | null, y: number | null) => void;
}) {
  const g: Group | undefined = session.groups[sel];
  const next = session.groups[sel + 1];
  const { shown, loading } = usePreloadedImage(
    g ? previewUrl(sessionId, g, 1600, before) : null,
    next && !before ? previewUrl(sessionId, next, 1600) : null,
  );

  return (
    <section className="flex size-full min-h-0 min-w-0 flex-col bg-[var(--pro-well)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-(--ss-bar) px-3.5">
        <div className="text-[12px] font-semibold text-foreground/90" aria-live="polite">
          {g ? `Slide ${sel + 1} of ${session.groups.length}` : "No slides yet — import some scans"}
        </div>
        {g && (
          <div className="flex items-center gap-2">
            <span
              data-testid="slide-status"
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-border px-2 py-px text-[11px]",
                STATUS_TEXT[g.status],
              )}
            >
              <span className={cn("size-[7px] rounded-full border border-transparent", STATUS_DOT[g.status])} />
              {STATUS_LABEL[g.status]}
            </span>
            <Tip label="Hold to compare with the untouched scan" keys="B">
              <ProButton
                active={before}
                onPointerDown={() => onBefore(true)}
                onPointerUp={() => onBefore(false)}
                onPointerLeave={() => onBefore(false)}
              >
                Before
              </ProButton>
            </Tip>
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {g &&
          shown &&
          slideMenu(
            sel,
            <img
              src={shown}
              alt={`Slide ${sel + 1}`}
              draggable={false}
              className={cn(
                "absolute inset-3.5 h-[calc(100%-28px)] w-[calc(100%-28px)] object-contain",
                picking && "cursor-crosshair",
              )}
              onClick={(e) => {
                if (!picking) return;
                const pt = photoPoint(e.currentTarget, e.clientX, e.clientY);
                onPicked(pt?.[0] ?? null, pt?.[1] ?? null);
              }}
            />,
          )}
        {picking && (
          <div className="ss-pick-hint" role="status">
            Click a spot that should be neutral grey or white · <kbd>Esc</kbd>
          </div>
        )}
        {before && (
          <span className="absolute top-5 left-5 rounded bg-black/70 px-2 py-[3px] text-[11px] tracking-[0.08em]">
            BEFORE
          </span>
        )}
        {loading && <Spinner data-testid="preview-loading" className="absolute right-5 bottom-5 text-primary" />}
      </div>

      {g && (
        <div
          className="flex min-h-[72px] shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-(--ss-bar) px-3.5 py-2"
          aria-label="Scans in this slide"
        >
          <span className="mr-1.5 text-[11px] whitespace-nowrap text-muted-foreground">
            {g.scans.length > 1 ? `Stack of ${g.scans.length} scans · click to leave one out` : "Single scan"}
          </span>
          {g.scans.map((sc, k) => {
            const off = g.excluded.includes(sc);
            return (
              <React.Fragment key={sc}>
                {k > 0 && (
                  <Tip label="Split: this scan and the ones after it are a different slide" side="top">
                    <button
                      type="button"
                      onClick={() => onSplit(sc)}
                      aria-label={`Split before scan ${k + 1}`}
                      className="group grid h-[52px] w-4 shrink-0 cursor-default place-items-center rounded border border-dashed border-transparent text-transparent hover:border-(--ss-line) hover:text-muted-foreground focus-visible:border-(--ss-line) focus-visible:text-muted-foreground"
                    >
                      <Scissors className="size-3" />
                    </button>
                  </Tip>
                )}
                <button
                  type="button"
                  onClick={() => onToggleScan(sc)}
                  title={sc}
                  aria-pressed={!off}
                  aria-label={`Scan ${k + 1}${off ? " (left out)" : ""}`}
                  className={cn(
                    "relative shrink-0 cursor-default overflow-hidden rounded border-2 border-border",
                    off && "border-dashed opacity-35",
                  )}
                >
                  <img src={scanThumbUrl(sessionId, sc)} alt="" draggable={false} className="block h-[52px]" />
                  <span className="absolute top-px left-[3px] text-[10px] [text-shadow:0_1px_2px_#000]">{k + 1}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </section>
  );
}
