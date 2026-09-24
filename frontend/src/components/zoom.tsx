import * as React from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { api, tileUrl, useImageSrc, type FullInfo, type Group } from "@/lib/api";

// 1:1 zoom and the loupe show the slide's full-resolution render (not the 1600 px preview), which
// the server renders once per slide and hands out in fixed tiles (GET …/full, …/tile.jpg). One
// image pixel is one screen pixel, so on a Retina screen that is half a CSS pixel.

const infos = new Map<string, FullInfo>();

/** The full-resolution render's size, once it exists (rendering it takes a few seconds). */
export function useFullInfo(sid: string, g: Group | undefined, enabled: boolean, onFail: () => void) {
  const key = g ? `${sid}/${g.id}/${g.key}` : "";
  const [info, setInfo] = React.useState<FullInfo | null>(infos.get(key) ?? null);
  const fail = React.useRef(onFail);
  fail.current = onFail;
  React.useEffect(() => {
    if (!enabled || !g) return;
    const hit = infos.get(key);
    setInfo(hit ?? null);
    if (hit) return;
    let live = true;
    api<FullInfo>("GET", `/api/sessions/${sid}/groups/${g.id}/full`).then(
      (i) => {
        infos.set(key, i);
        if (live) setInfo(i);
      },
      (e) => {
        if (!live) return;
        toast.error(e instanceof Error ? e.message : String(e), { id: "zoom" });
        fail.current();
      },
    );
    return () => {
      live = false;
    };
    // the key covers the slide and its render
  }, [key, enabled]);
  return info;
}

function Tile({ url, style }: { url: string; style: React.CSSProperties }) {
  const src = useImageSrc(url, 8);
  return src ? (
    <img src={src} alt="" draggable={false} className="absolute max-w-none select-none" style={style} />
  ) : null;
}

/** The tiles covering a w × h (CSS px) window centred on image pixel (cx, cy). */
function Tiles({
  sid,
  g,
  info,
  cx,
  cy,
  w,
  h,
}: {
  sid: string;
  g: Group;
  info: FullInfo;
  cx: number;
  cy: number;
  w: number;
  h: number;
}) {
  const dpr = window.devicePixelRatio || 1;
  const T = info.tile;
  const [hw, hh] = [(w * dpr) / 2, (h * dpr) / 2];
  const c0 = Math.max(0, Math.floor((cx - hw) / T));
  const c1 = Math.min(Math.ceil(info.width / T) - 1, Math.floor((cx + hw) / T));
  const r0 = Math.max(0, Math.floor((cy - hh) / T));
  const r1 = Math.min(Math.ceil(info.height / T) - 1, Math.floor((cy + hh) / T));
  const tiles = [];
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++)
      tiles.push(
        <Tile
          key={`${c},${r}`}
          url={tileUrl(sid, g, c, r)}
          style={{
            left: (c * T - cx) / dpr + w / 2,
            top: (r * T - cy) / dpr + h / 2,
            width: Math.min(T, info.width - c * T) / dpr,
            height: Math.min(T, info.height - r * T) / dpr,
          }}
        />,
      );
  return <>{tiles}</>;
}

/**
 * 1:1 zoom over the stage (Z, or double-click the photo at the spot to look at): drag to pan,
 * Z / Esc / double-click to go back.
 */
export function ZoomView({
  sid,
  g,
  start,
  onClose,
}: {
  sid: string;
  g: Group;
  /** Where to look first, 0..1 of the photo. */
  start: [number, number];
  onClose: () => void;
}) {
  const info = useFullInfo(sid, g, true, onClose);
  const [el, setEl] = React.useState<HTMLDivElement | null>(null);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  React.useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  const [centre, setCentre] = React.useState<[number, number] | null>(null);
  React.useEffect(() => {
    if (info) setCentre((c) => c ?? [start[0] * info.width, start[1] * info.height]);
  }, [info]);

  const dpr = window.devicePixelRatio || 1;
  /** Keep the window on the photo (centred on an axis where the photo is smaller than it). */
  const clamp = (x: number, full: number, view: number) =>
    full <= view * dpr ? full / 2 : Math.min(full - (view * dpr) / 2, Math.max((view * dpr) / 2, x));
  const cx = info && centre ? clamp(centre[0], info.width, size.w) : 0;
  const cy = info && centre ? clamp(centre[1], info.height, size.h) : 0;
  const drag = React.useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  return (
    <div
      ref={setEl}
      className="ss-zoom absolute inset-0 z-10 cursor-grab overflow-hidden bg-[var(--pro-well)] active:cursor-grabbing"
      role="img"
      aria-label={`Slide ${g.index + 1} at 100 %`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, cx, cy };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d && e.buttons === 1) setCentre([d.cx - (e.clientX - d.x) * dpr, d.cy - (e.clientY - d.y) * dpr]);
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={onClose}
    >
      {info && centre && size.w > 0 && <Tiles sid={sid} g={g} info={info} cx={cx} cy={cy} w={size.w} h={size.h} />}
      <span className="ss-zoom-tag" role="status">
        {info ? (
          <>
            100 % · {info.width} × {info.height} · drag to move · <kbd>Z</kbd> <kbd>Esc</kbd>
          </>
        ) : (
          <>
            <Spinner className="size-3" /> Rendering at full resolution…
          </>
        )}
      </span>
    </div>
  );
}

/** Loupe (L): a circle following the pointer over the photo, showing that spot at 100 %. */
export function Loupe({
  sid,
  g,
  at,
  onFail,
}: {
  sid: string;
  g: Group;
  at: { x: number; y: number; fx: number; fy: number } | null;
  onFail: () => void;
}) {
  const info = useFullInfo(sid, g, true, onFail);
  const R = 240; // CSS px across
  if (!at) return null;
  return (
    <div
      className="ss-loupe pointer-events-none absolute z-10"
      style={{ left: at.x - R / 2, top: at.y - R / 2, width: R, height: R }}
    >
      {info ? (
        <Tiles sid={sid} g={g} info={info} cx={at.fx * info.width} cy={at.fy * info.height} w={R} h={R} />
      ) : (
        <Spinner className="absolute top-1/2 left-1/2 -translate-1/2 text-primary" />
      )}
    </div>
  );
}
