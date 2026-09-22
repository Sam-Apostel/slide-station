import * as React from "react";
import { Scissors } from "lucide-react";
import { ProButton } from "@/components/ui/pro-button";
import { Spinner } from "@/components/ui/spinner";
import { previewUrl, scanThumbUrl, type Group, type SessionPayload } from "@/lib/api";
import { cn } from "@/lib/utils";
import { STATUS_DOT, STATUS_LABEL } from "@/components/filmstrip";

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

export function Stage({
  session,
  sessionId,
  sel,
  before,
  onBefore,
  onToggleScan,
  onSplit,
}: {
  session: SessionPayload;
  sessionId: string;
  sel: number;
  before: boolean;
  onBefore: (on: boolean) => void;
  onToggleScan: (scan: string) => void;
  onSplit: (scan: string) => void;
}) {
  const g: Group | undefined = session.groups[sel];
  const next = session.groups[sel + 1];
  const { shown, loading } = usePreloadedImage(
    g ? previewUrl(sessionId, g, 1600, before) : null,
    next && !before ? previewUrl(sessionId, next, 1600) : null,
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--pro-well)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#202020] bg-[#303030] px-3.5">
        <div className="text-[12px] font-semibold text-white/90" aria-live="polite">
          {g ? `Slide ${sel + 1} of ${session.groups.length}` : "No slides yet — import some scans"}
        </div>
        {g && (
          <div className="flex items-center gap-2">
            <span
              data-testid="slide-status"
              className="flex items-center gap-1.5 rounded-full border border-white/10 px-2 py-px text-[11px] text-white/70"
            >
              <span className={cn("size-[7px] rounded-full border border-transparent", STATUS_DOT[g.status])} />
              {STATUS_LABEL[g.status]}
            </span>
            <ProButton
              active={before}
              title="Hold B to compare"
              onPointerDown={() => onBefore(true)}
              onPointerUp={() => onBefore(false)}
              onPointerLeave={() => onBefore(false)}
            >
              Before
            </ProButton>
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {g && shown && (
          <img
            src={shown}
            alt={`Slide ${sel + 1}`}
            draggable={false}
            className="absolute inset-3.5 h-[calc(100%-28px)] w-[calc(100%-28px)] object-contain"
          />
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
          className="flex min-h-[72px] shrink-0 items-center gap-1.5 overflow-x-auto border-t border-[#202020] bg-[#303030] px-3.5 py-2"
          aria-label="Scans in this slide"
        >
          <span className="mr-1.5 text-[11px] whitespace-nowrap text-white/50">
            {g.scans.length > 1 ? `Stack of ${g.scans.length} scans · click to leave one out` : "Single scan"}
          </span>
          {g.scans.map((sc, k) => {
            const off = g.excluded.includes(sc);
            return (
              <React.Fragment key={sc}>
                {k > 0 && (
                  <button
                    type="button"
                    onClick={() => onSplit(sc)}
                    title="Split: this scan and the ones after it are a different slide"
                    aria-label={`Split before scan ${k + 1}`}
                    className="group grid h-[52px] w-4 shrink-0 cursor-default place-items-center rounded border border-dashed border-transparent text-transparent hover:border-white/30 hover:text-white/60 focus-visible:border-white/30 focus-visible:text-white/60"
                  >
                    <Scissors className="size-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onToggleScan(sc)}
                  title={sc}
                  aria-pressed={!off}
                  aria-label={`Scan ${k + 1}${off ? " (left out)" : ""}`}
                  className={cn(
                    "relative shrink-0 cursor-default overflow-hidden rounded border-2 border-[#4c4c4c]",
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
