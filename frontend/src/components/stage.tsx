import * as React from "react";
import { Columns2, Lock, Redo2, Scissors, Undo2 } from "lucide-react";
import { isMac } from "@/lib/desktop";
import { Tip } from "@/components/tip";
import { CropBar, CropOverlay, FULL, fitAspect, maxAspect, type Rect } from "@/components/crop";
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
  cropping,
  onCropEnd,
  onAngle,
  onUndo,
  onRedo,
  compare,
  onCompare,
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
  /** Crop tool open: the photo shows uncropped with the crop frame over it. */
  cropping: boolean;
  /** rect: the new crop (null = whole photo), or undefined when cancelled. */
  onCropEnd: (rect: Rect | null | undefined, restoreAngle?: number) => void;
  onAngle: (a: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Split view: before on the left, after on the right, with a draggable divider. */
  compare: boolean;
  onCompare: () => void;
}) {
  const g: Group | undefined = session.groups[sel];
  const next = session.groups[sel + 1];
  const { shown, loading } = usePreloadedImage(
    g ? previewUrl(sessionId, g, 1600, before && !cropping, cropping) : null,
    next && !before && !cropping ? previewUrl(sessionId, next, 1600) : null,
  );

  // ---- split compare: the "before" render is framed like the developed one, so they line up
  const comparing = compare && !cropping && !before && !picking;
  const beforeView = usePreloadedImage(g && comparing ? previewUrl(sessionId, g, 1600, true) : null, null);
  const [divider, setDivider] = React.useState(50);
  const moveDivider = (e: React.PointerEvent) => {
    const r = imgEl?.getBoundingClientRect();
    if (r) setDivider(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
  };

  // ---- crop tool state: a draft until Done
  const [imgEl, setImgEl] = React.useState<HTMLImageElement | null>(null);
  const [rect, setRect] = React.useState<Rect>(FULL);
  const [aspect, setAspect] = React.useState<{ name: string; ratio: number | null }>({ name: "Free", ratio: null });
  const [frame, setFrame] = React.useState(1.5);
  const startAngle = React.useRef(0);
  React.useEffect(() => {
    if (!cropping || !g) return;
    setRect((g.params.crop as Rect | null) ?? FULL);
    setAspect({ name: "Free", ratio: null });
    startAngle.current = g.params.angle ?? 0;
    // only when the tool opens
  }, [cropping]);
  const finish = React.useRef<(ok: boolean) => void>(() => {});
  finish.current = (ok) => {
    if (ok) onCropEnd(rect[0] <= 0.001 && rect[1] <= 0.001 && rect[2] >= 0.999 && rect[3] >= 0.999 ? null : rect);
    else onCropEnd(undefined, startAngle.current);
  };
  React.useEffect(() => {
    if (!cropping) return;
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
      if (e.key === "Enter") finish.current(true);
      else if (e.key === "Escape") finish.current(false);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [cropping]);

  return (
    <section className="flex size-full min-h-0 min-w-0 flex-col bg-[var(--pro-well)]">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-(--ss-bar) px-3.5">
        <div className="truncate text-[12px] font-semibold whitespace-nowrap text-foreground/90" aria-live="polite">
          {g ? (
            <>
              <span className="sr-only">Slide </span>
              {sel + 1}
              <span className="font-normal text-(--ss-dim)"> / {session.groups.length}</span>
            </>
          ) : (
            "No slides yet — import some scans"
          )}
        </div>
        {g && (
          <div className="flex items-center gap-2">
            <span
              data-testid="slide-status"
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-border px-2 py-px text-[11px] whitespace-nowrap",
                STATUS_TEXT[g.status],
              )}
            >
              <span className={cn("size-[7px] rounded-full border border-transparent", STATUS_DOT[g.status])} />
              {STATUS_LABEL[g.status]}
            </span>
            {g.locked && (
              <Tip label="Its original scans were deleted after upload, so it can't be edited. Immich has the final version.">
                <span className="ss-warn-chip flex items-center gap-1">
                  <Lock className="size-3" aria-hidden /> locked
                </span>
              </Tip>
            )}
            <div className="flex">
              <Tip label="Undo this slide's last edit" keys={isMac ? "⌘Z" : "Ctrl+Z"}>
                <ProButton plain aria-label="Undo" disabled={!g.can_undo || g.locked} onClick={onUndo}>
                  <Undo2 />
                </ProButton>
              </Tip>
              <Tip label="Redo" keys={isMac ? "⇧⌘Z" : "Ctrl+Shift+Z"}>
                <ProButton plain aria-label="Redo" disabled={!g.can_redo || g.locked} onClick={onRedo}>
                  <Redo2 />
                </ProButton>
              </Tip>
            </div>
            <Tip label="Split view: before | after" keys="Y">
              <ProButton
                aria-label="Split before and after"
                aria-pressed={compare || undefined}
                data-on={compare || undefined}
                onClick={onCompare}
              >
                <Columns2 />
              </ProButton>
            </Tip>
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
          comparing &&
          beforeView.shown && (
            <img
              src={beforeView.shown}
              alt=""
              aria-hidden
              draggable={false}
              className="ss-photo absolute inset-3.5 h-[calc(100%-28px)] w-[calc(100%-28px)] object-contain"
            />
          )}
        {g &&
          shown &&
          slideMenu(
            sel,
            <img
              ref={setImgEl}
              src={shown}
              alt={`Slide ${sel + 1}`}
              draggable={false}
              onLoad={(e) => setFrame(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight || 1.5)}
              style={comparing && beforeView.shown ? { clipPath: `inset(0 0 0 ${divider}%)`, filter: "none" } : undefined}
              className={cn(
                "ss-photo absolute inset-3.5 h-[calc(100%-28px)] w-[calc(100%-28px)] object-contain",
                picking && !cropping && "cursor-crosshair",
                cropping && "ss-photo-cropping",
              )}
              onClick={(e) => {
                if (!picking || cropping) return;
                const pt = photoPoint(e.currentTarget, e.clientX, e.clientY);
                onPicked(pt?.[0] ?? null, pt?.[1] ?? null);
              }}
            />,
          )}
        {comparing && beforeView.shown && (
          <div
            className="ss-compare"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              moveDivider(e);
            }}
            onPointerMove={(e) => e.buttons === 1 && moveDivider(e)}
            onDoubleClick={() => setDivider(50)}
          >
            <span className="ss-compare-line" style={{ left: `calc(14px + (100% - 28px) * ${divider / 100})` }}>
              <span className="ss-compare-knob" />
            </span>
            <span className="ss-compare-tag left-5">Before</span>
            <span className="ss-compare-tag right-5">After</span>
          </div>
        )}
        {cropping && shown && (
          <CropOverlay img={imgEl} rect={rect} ratio={aspect.ratio} onChange={setRect} />
        )}
        {picking && !cropping && (
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

      {g && cropping && (
        <CropBar
          rect={rect}
          aspect={aspect.name}
          portrait={!!aspect.ratio && aspect.ratio < 1}
          angle={g.params.angle ?? 0}
          frame={frame}
          onAspect={(name, ratio) => {
            setAspect({ name, ratio });
            if (ratio) setRect((r) => (r === FULL || name === "Original" ? maxAspect(ratio, frame) : fitAspect(r, ratio, frame)));
          }}
          onFlip={() =>
            setAspect((a) => {
              if (!a.ratio) return a;
              const ratio = 1 / a.ratio;
              setRect(maxAspect(ratio, frame));
              return { ...a, ratio };
            })
          }
          onAngle={onAngle}
          onRect={setRect}
          onCancel={() => finish.current(false)}
          onDone={() => finish.current(true)}
        />
      )}
      {g && !cropping && (
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
                  title={
                    off && g.auto_excluded?.[sc]
                      ? `Left out automatically: ${g.auto_excluded[sc]}. Click to use it anyway.`
                      : sc
                  }
                  aria-pressed={!off}
                  aria-label={`Scan ${k + 1}${off ? " (left out)" : ""}`}
                  className={cn(
                    "relative shrink-0 cursor-default overflow-hidden rounded border-2 border-border",
                    off && "border-dashed",
                  )}
                >
                  <img
                    src={scanThumbUrl(sessionId, sc)}
                    alt=""
                    draggable={false}
                    className={cn("block h-[52px]", off && "opacity-35")}
                  />
                  <span className="absolute top-px left-[3px] text-[10px] [text-shadow:0_1px_2px_#000]">{k + 1}</span>
                  {off && g.auto_excluded?.[sc] && (
                    <span className="ss-scan-why">{g.auto_excluded[sc]}</span>
                  )}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </section>
  );
}
