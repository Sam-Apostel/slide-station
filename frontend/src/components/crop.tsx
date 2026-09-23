import * as React from "react";
import { Check, FlipHorizontal2, RotateCcw, X } from "lucide-react";
import { ProButton } from "@/components/ui/pro-button";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/tip";
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
    let [nl, nt, nr, nb] = d.start;
    if (d.h === "move") {
      const w = nr - nl;
      const h = nb - nt;
      nl = clamp(nl + dx, 0, 1 - w);
      nt = clamp(nt + dy, 0, 1 - h);
      return onChange([nl, nt, nl + w, nt + h]);
    }
    if (d.h.includes("w")) nl = clamp(nl + dx, 0, nr - MIN);
    if (d.h.includes("e")) nr = clamp(nr + dx, nl + MIN, 1);
    if (d.h.includes("n")) nt = clamp(nt + dy, 0, nb - MIN);
    if (d.h.includes("s")) nb = clamp(nb + dy, nt + MIN, 1);
    if (ratio) {
      // width leads on corners and side handles, height on top / bottom handles
      if (d.h === "n" || d.h === "s") {
        const w = ((nb - nt) * ratio) / frame;
        const cx = (d.start[0] + d.start[2]) / 2;
        nl = cx - w / 2;
        nr = cx + w / 2;
      } else {
        const h = ((nr - nl) * frame) / ratio;
        if (d.h.includes("n")) nt = nb - h;
        else if (d.h.includes("s") || d.h === "e" || d.h === "w") {
          if (d.h === "e" || d.h === "w") {
            const cy = (d.start[1] + d.start[3]) / 2;
            nt = cy - h / 2;
            nb = cy + h / 2;
          } else nb = nt + h;
        }
      }
      if (nl < 0 || nt < 0 || nr > 1 || nb > 1) return; // would leave the photo: hold still
    }
    onChange([nl, nt, nr, nb]);
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
