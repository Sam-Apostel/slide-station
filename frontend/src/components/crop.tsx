import * as React from "react";
import { Check, FlipHorizontal2, RotateCcw, X } from "lucide-react";
import { ProButton } from "@/components/ui/pro-button";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/tip";
import { isMac } from "@/lib/desktop";
import { cn } from "@/lib/utils";

export type Rect = [number, number, number, number]; // l, t, r, b in 0..1
const FULL: Rect = [0, 0, 1, 1];
const MIN = 0.05;

const ASPECTS: [string, number | "original" | null][] = [
  ["Free", null],
  ["Original", "original"],
  ["3:2", 3 / 2],
  ["4:3", 4 / 3],
  ["5:4", 5 / 4],
  ["1:1", 1],
  ["16:9", 16 / 9],
];

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The picture's rectangle inside an object-fit: contain <img>, relative to its offset parent. */
function contentBox(img: HTMLImageElement) {
  const w = img.clientWidth;
  const h = img.clientHeight;
  if (!img.naturalWidth || !w) return null;
  const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const cw = img.naturalWidth * s;
  const ch = img.naturalHeight * s;
  return { left: img.offsetLeft + (w - cw) / 2, top: img.offsetTop + (h - ch) / 2, width: cw, height: ch };
}

/**
 * Apply an aspect ratio (width / height in pixels) to a rect, keeping it centred where it was and
 * inside the frame. `frame` is the picture's pixel aspect.
 */
function fitAspect([l, t, r, b]: Rect, ratio: number, frame: number): Rect {
  const cx = (l + r) / 2;
  const cy = (t + b) / 2;
  let w = r - l;
  let h = (w * frame) / ratio; // in 0..1 units of height
  if (h > b - t) {
    h = b - t;
    w = (h * ratio) / frame;
  }
  if (w > 1) [w, h] = [1, frame / ratio];
  if (h > 1) [w, h] = [ratio / frame, 1];
  const nl = clamp(cx - w / 2, 0, 1 - w);
  const nt = clamp(cy - h / 2, 0, 1 - h);
  return [nl, nt, nl + w, nt + h];
}

/** Largest rect of that aspect, centred. */
function maxAspect(ratio: number, frame: number): Rect {
  return fitAspect(FULL, ratio, frame);
}

/** Shift a rect by dx, dy (0..1 units), stopping at the photo's edges. */
export function moveRect([l, t, r, b]: Rect, dx: number, dy: number): Rect {
  const nl = clamp(l + dx, 0, 1 - (r - l));
  const nt = clamp(t + dy, 0, 1 - (b - t));
  return [nl, nt, nl + (r - l), nt + (b - t)];
}

/**
 * Drag a handle of `start` by dx, dy (0..1 units of the photo). Free: each dragged edge follows
 * the pointer. With an aspect ratio (width / height in pixels; `frame` is the photo's) the size
 * follows whichever axis the pointer moved further along, the opposite corner or edge stays put,
 * and at the photo's border the size stops growing while the rect keeps sliding along it: a side
 * handle's centred axis shifts to stay inside instead of the whole drag freezing.
 */
export function resizeRect(
  start: Rect,
  h: Exclude<Handle, "move">,
  dx: number,
  dy: number,
  ratio: number | null,
  frame: number,
): Rect {
  const [l, t, r, b] = start;
  if (!ratio) {
    let [nl, nt, nr, nb] = start;
    if (h.includes("w")) nl = clamp(l + dx, 0, r - MIN);
    if (h.includes("e")) nr = clamp(r + dx, l + MIN, 1);
    if (h.includes("n")) nt = clamp(t + dy, 0, b - MIN);
    if (h.includes("s")) nb = clamp(b + dy, t + MIN, 1);
    return [nl, nt, nr, nb];
  }
  const k = ratio / frame; // width per height, in 0..1 units
  const sx = h.includes("e") ? 1 : h.includes("w") ? -1 : 0;
  const sy = h.includes("s") ? 1 : h.includes("n") ? -1 : 0;
  // how much wider the pointer asks for: from its x, or from its y turned into width
  const byX = sx * dx;
  const byY = sy * dy * k;
  const grow = !sy ? byX : !sx ? byY : Math.abs(byX) >= Math.abs(byY) ? byX : byY;
  // room for the width: to the border on the dragged side(s); a centred axis may use it all
  const roomX = sx > 0 ? 1 - l : sx < 0 ? r : 1;
  const roomY = sy > 0 ? 1 - t : sy < 0 ? b : 1;
  const w = clamp(r - l + grow, Math.max(MIN, MIN * k), Math.min(roomX, roomY * k));
  const hh = w / k;
  // the anchored side stays; an undragged axis stays centred where it was, slid inside the photo
  const nl = sx > 0 ? l : sx < 0 ? r - w : clamp((l + r) / 2 - w / 2, 0, 1 - w);
  const nt = sy > 0 ? t : sy < 0 ? b - hh : clamp((t + b) / 2 - hh / 2, 0, 1 - hh);
  return [nl, nt, nl + w, nt + hh];
}

/**
 * Crop frame over the photo. Drag inside to move, the handles to resize (locked to the chosen
 * aspect), with a rule-of-thirds grid while you work. The frame is 0..1 of the straightened photo,
 * as the server crops it.
 */
export function CropOverlay({
  img,
  rect,
  ratio,
  onChange,
}: {
  img: HTMLImageElement | null;
  rect: Rect;
  ratio: number | null;
  onChange: (r: Rect) => void;
}) {
  const [box, setBox] = React.useState<ReturnType<typeof contentBox>>(null);
  const drag = React.useRef<{ h: Handle; x: number; y: number; start: Rect; id: number } | null>(null);
  const [active, setActive] = React.useState(false);

  React.useLayoutEffect(() => {
    if (!img) return;
    const update = () => setBox(contentBox(img));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(img);
    img.addEventListener("load", update);
    return () => {
      ro.disconnect();
      img.removeEventListener("load", update);
    };
  }, [img]);

  if (!box) return null;
  const frame = box.width / box.height;
  const [l, t, r, b] = rect;

  const down = (h: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { h, x: e.clientX, y: e.clientY, start: rect, id: e.pointerId };
    setActive(true);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = (e.clientX - d.x) / box.width;
    const dy = (e.clientY - d.y) / box.height;
    if (d.h === "move") return onChange(moveRect(d.start, dx, dy));
    onChange(resizeRect(d.start, d.h, dx, dy, ratio, frame));
  };
  const up = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
    setActive(false);
  };

  const px = (v: number, of: number) => `${v * of}px`;
  return (
    <div
      className="ss-crop"
      data-active={active || undefined}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div
        className="ss-crop-box"
        style={{
          left: px(l, box.width),
          top: px(t, box.height),
          width: px(r - l, box.width),
          height: px(b - t, box.height),
        }}
        onPointerDown={down("move")}
      >
        <span className="ss-crop-third" style={{ left: "33.333%" }} />
        <span className="ss-crop-third" style={{ left: "66.666%" }} />
        <span className="ss-crop-third ss-crop-third-h" style={{ top: "33.333%" }} />
        <span className="ss-crop-third ss-crop-third-h" style={{ top: "66.666%" }} />
        {HANDLES.map((h) => (
          <span key={h} className="ss-crop-handle" data-h={h} onPointerDown={down(h)} />
        ))}
        <span className="ss-crop-size">
          {Math.round((r - l) * 100)} × {Math.round((b - t) * 100)} %
        </span>
      </div>
    </div>
  );
}

/** The crop tool's controls, in place of the scan strip while cropping. */
export function CropBar({
  rect,
  aspect,
  portrait,
  angle,
  frame,
  onAspect,
  onFlip,
  onAngle,
  onRect,
  onCancel,
  onDone,
}: {
  rect: Rect;
  aspect: string;
  portrait: boolean;
  angle: number;
  frame: number;
  onAspect: (name: string, ratio: number | null) => void;
  onFlip: () => void;
  onAngle: (a: number) => void;
  onRect: (r: Rect) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  return (
    <div className="ss-cropbar" role="toolbar" aria-label="Crop and straighten">
      <div className="ss-seg" role="radiogroup" aria-label="Aspect ratio">
        {ASPECTS.map(([name, v]) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={aspect === name}
            onClick={() => {
              let ratio = v === "original" ? frame : v;
              if (ratio && portrait && v !== "original") ratio = 1 / ratio;
              onAspect(name, ratio);
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <Tip label="Swap portrait / landscape">
        <ProButton plain aria-label="Swap orientation" disabled={aspect === "Free" || aspect === "1:1"} onClick={onFlip}>
          <FlipHorizontal2 className="rotate-90" />
        </ProButton>
      </Tip>

      <label className="ss-straighten">
        <span className="text-muted-foreground">Straighten</span>
        <input
          type="range"
          min={-15}
          max={15}
          step={0.1}
          value={angle}
          onChange={(e) => onAngle(Number(e.target.value))}
          onDoubleClick={() => onAngle(0)}
          aria-label="Straighten angle"
        />
        <span className="w-[42px] text-right font-mono text-[11px] tabular-nums">
          {angle > 0 ? "+" : ""}
          {angle.toFixed(1)}°
        </span>
      </label>

      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Kbd>←</Kbd>
        <Kbd>→</Kbd>
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> move · <Kbd>{isMac ? "⌥" : "Alt"}</Kbd> resize · <Kbd>⇧</Kbd> bigger steps
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <Tip label="Whole photo, no straighten">
          <ProButton
            plain
            aria-label="Reset crop"
            onClick={() => {
              onRect(FULL);
              onAngle(0);
            }}
          >
            <RotateCcw /> Reset
          </ProButton>
        </Tip>
        <ProButton onClick={onCancel}>
          <X /> Cancel <Kbd>Esc</Kbd>
        </ProButton>
        <ProButton active onClick={onDone} className={cn(rect === FULL && "opacity-90")}>
          <Check /> Done <Kbd>↵</Kbd>
        </ProButton>
      </div>
    </div>
  );
}

export { FULL, maxAspect, fitAspect };
export type { Handle };
