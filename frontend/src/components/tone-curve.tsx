import * as React from "react";
import { Undo2, Wand2 } from "lucide-react";
import { ProButton } from "@/components/ui/pro-button";
import { Tip } from "@/components/tip";
import { histogramUrl, type Group } from "@/lib/api";
import {
  CHANNELS,
  MIN_GAP,
  curveOf,
  isStraight,
  spline,
  withChannel,
  type CurveChannel,
  type Curves,
  type Point,
} from "@/lib/curves";
import { cn } from "@/lib/utils";

type Histogram = Record<"r" | "g" | "b" | "lum", number[]>;

const SIZE = 256; // viewBox units; the SVG scales to the inspector's width
const HIT = 9; // px: how close a click must be to grab a point
const REMOVE_BEYOND = 0.12; // drag an inner point this far out of the box to remove it

const INK: Record<CurveChannel, string> = {
  rgb: "var(--ss-text)",
  r: "#e5655b",
  g: "#5fc27a",
  b: "#5b8fe8",
};
const LABEL: Record<CurveChannel, string> = { rgb: "RGB", r: "Red", g: "Green", b: "Blue" };

function storedChannel(): CurveChannel {
  try {
    const c = localStorage.getItem("curve-channel") as CurveChannel | null;
    return c && CHANNELS.includes(c) ? c : "rgb";
  } catch {
    return "rgb";
  }
}

/** Keeps the last histogram on screen while the next one loads, so dragging sliders doesn't flicker. */
function useHistogram(url: string) {
  const [hist, setHist] = React.useState<Histogram | null>(null);
  React.useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => live && h && setHist(h))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url]);
  return hist;
}

function histPath(bins: number[]) {
  // sqrt so faint tails (exactly what fitting looks at) stay visible; the end bins are ignored for
  // the scale because clipped pixels pile up there
  const inner = bins.slice(1, -1);
  const peak = Math.sqrt(Math.max(1, ...inner));
  const w = SIZE / bins.length;
  let d = `M0 ${SIZE}`;
  bins.forEach((v, i) => {
    const y = SIZE - Math.min(1, Math.sqrt(v) / peak) * SIZE * 0.92;
    d += ` L${i * w} ${y} L${(i + 1) * w} ${y}`;
  });
  return `${d} L${SIZE} ${SIZE} Z`;
}

function curvePath(pts: Point[]) {
  const f = spline(pts);
  let d = "";
  for (let i = 0; i <= 128; i++) {
    const x = i / 128;
    d += `${i ? "L" : "M"}${x * SIZE} ${(1 - f(x)) * SIZE}`;
  }
  return d;
}

const to255 = (v: number) => Math.round(v * 255);

/**
 * Point curve editor like Lightroom's: RGB plus one curve per colour channel, drawn over the
 * histogram of what it works on. Click to add a point, drag to move, double-click or drag an inner
 * point out of the box to remove it. "Fit to data" pulls each channel's ends in to where the
 * scan's data sits — the classic fix for faded slides.
 */
export function ToneCurve({
  sessionId,
  group,
  onChange,
  onFit,
  onFitAll,
}: {
  sessionId: string;
  group: Group;
  onChange: (curves: Curves) => void;
  onFit: () => void;
  onFitAll: () => void;
}) {
  const [channel, setChannelState] = React.useState(storedChannel);
  const setChannel = (c: CurveChannel) => {
    setChannelState(c);
    try {
      localStorage.setItem("curve-channel", c);
    } catch {
      /* private mode */
    }
  };
  const curves = group.params.curves;
  const pts = curveOf(curves, channel);
  const hist = useHistogram(histogramUrl(sessionId, group));

  const svg = React.useRef<SVGSVGElement>(null);
  const drag = React.useRef<{ index: number; pointerId: number; removing: boolean } | null>(null);
  const [active, setActive] = React.useState<number | null>(null);
  const [hover, setHover] = React.useState<number | null>(null);
  const [removing, setRemoving] = React.useState(false);

  // Latest values for the pointer handlers, which outlive a render mid-drag.
  const latest = React.useRef({ curves, channel, onChange });
  latest.current = { curves, channel, onChange };

  const toUnit = (e: { clientX: number; clientY: number }): Point => {
    const r = svg.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  };
  const pxPerUnit = () => svg.current!.getBoundingClientRect().width;

  const nearest = (p: Point, list: Point[]) => {
    const px = pxPerUnit();
    let best = -1;
    let dist = HIT;
    list.forEach(([x, y], i) => {
      const d = Math.hypot((x - p[0]) * px, (y - p[1]) * px);
      if (d <= dist) {
        best = i;
        dist = d;
      }
    });
    return best;
  };

  const commit = (list: Point[] | null) => {
    const { curves: c, channel: ch, onChange: change } = latest.current;
    change(withChannel(c, ch, list));
  };

  /** Where point i may go: between its neighbours, inside the box. */
  const place = (list: Point[], i: number, [x, y]: Point): Point => {
    const lo = i === 0 ? 0 : list[i - 1][0] + MIN_GAP;
    const hi = i === list.length - 1 ? 1 : list[i + 1][0] - MIN_GAP;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return [r(Math.min(hi, Math.max(lo, x))), r(Math.min(1, Math.max(0, y)))];
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = toUnit(e);
    let list = pts.slice();
    let i = nearest(p, list);
    if (i < 0) {
      // new point on the click's input value, at the click's height
      if (list.length >= 16) return;
      const at = list.findIndex(([x]) => x > p[0]);
      if (at <= 0) return; // outside the end points: nothing to add to
      if (p[0] - list[at - 1][0] < MIN_GAP || list[at][0] - p[0] < MIN_GAP) return;
      list.splice(at, 0, place(list, at, p));
      list = list.slice();
      i = at;
      commit(list);
    }
    drag.current = { index: i, pointerId: e.pointerId, removing: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    setActive(i);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toUnit(e);
    const dr = drag.current;
    const { curves: c, channel: ch } = latest.current;
    const list = curveOf(c, ch).slice();
    if (!dr || dr.pointerId !== e.pointerId) {
      const i = nearest(p, list);
      setHover(i >= 0 ? i : null);
      return;
    }
    const inner = dr.index > 0 && dr.index < list.length - 1;
    const out = Math.max(-p[0], p[0] - 1, -p[1], p[1] - 1);
    dr.removing = inner && out > REMOVE_BEYOND;
    setRemoving(dr.removing);
    if (dr.removing) return;
    list[dr.index] = place(list, dr.index, p);
    commit(list);
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const dr = drag.current;
    if (!dr || dr.pointerId !== e.pointerId) return;
    if (dr.removing) {
      const { curves: c, channel: ch } = latest.current;
      commit(curveOf(c, ch).filter((_, k) => k !== dr.index));
    }
    drag.current = null;
    setActive(null);
    setRemoving(false);
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const i = nearest(toUnit(e), pts);
    if (i < 0) return;
    if (i === 0) commit([[0, 0], ...pts.slice(1)]);
    else if (i === pts.length - 1) commit([...pts.slice(0, -1), [1, 1]]);
    else commit(pts.filter((_, k) => k !== i));
  };

  const shown = active ?? hover;
  const readout = shown !== null && pts[shown] ? pts[shown] : null;
  const others = CHANNELS.filter((c) => c !== channel && !isStraight(curves?.[c]));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Curve channel">
        {CHANNELS.map((c) => (
          <Tip key={c} label={`${LABEL[c]} curve`}>
            <button
              type="button"
              role="radio"
              aria-checked={channel === c}
              aria-label={`${LABEL[c]} curve`}
              onClick={() => setChannel(c)}
              className={cn(
                "ss-curve-tab relative flex h-[22px] items-center gap-1.5 rounded-[5px] px-2 text-[11px] font-medium text-muted-foreground",
                channel === c && "bg-(--ss-panel-2) text-foreground shadow-[inset_0_0_0_1px_#45454f]",
              )}
            >
              <span
                aria-hidden
                className="size-[9px] rounded-full"
                style={{
                  background: c === "rgb" ? "conic-gradient(#e5655b, #5fc27a, #5b8fe8, #e5655b)" : INK[c],
                }}
              />
              {c === "rgb" ? "RGB" : c.toUpperCase()}
              {!isStraight(curves?.[c]) && (
                <span aria-hidden className="absolute top-[3px] right-[3px] size-[4px] rounded-full bg-primary" />
              )}
            </button>
          </Tip>
        ))}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground tabular-nums">
          {readout ? `${to255(readout[0])} → ${to255(readout[1])}` : ""}
        </span>
      </div>

      <svg
        ref={svg}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`${LABEL[channel]} tone curve`}
        className={cn(
          "ss-curve aspect-square w-full touch-none rounded-[6px] select-none",
          removing ? "cursor-no-drop" : hover !== null || active !== null ? "cursor-grab" : "cursor-crosshair",
          active !== null && !removing && "cursor-grabbing",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
      >
        {/* histogram of the curve's input */}
        {hist &&
          (channel === "rgb" ? (
            <g style={{ mixBlendMode: "screen" }}>
              {(["r", "g", "b"] as const).map((c) => (
                <path key={c} d={histPath(hist[c])} fill={INK[c]} opacity={0.3} />
              ))}
            </g>
          ) : (
            <path d={histPath(hist[channel])} fill={INK[channel]} opacity={0.32} />
          ))}
        {/* quarter grid + the straight line */}
        {[0.25, 0.5, 0.75].map((t) => (
          <g key={t} stroke="var(--ss-line)" strokeWidth={1} vectorEffect="non-scaling-stroke">
            <line x1={t * SIZE} y1={0} x2={t * SIZE} y2={SIZE} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={t * SIZE} x2={SIZE} y2={t * SIZE} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        <line
          x1={0}
          y1={SIZE}
          x2={SIZE}
          y2={0}
          stroke="var(--ss-dim)"
          strokeDasharray="3 4"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {/* the other edited channels, faintly */}
        {others.map((c) => (
          <path
            key={c}
            d={curvePath(curveOf(curves, c))}
            fill="none"
            stroke={INK[c]}
            strokeOpacity={0.35}
            strokeWidth={1.25}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* clipped ranges outside the end points */}
        <rect x={0} y={0} width={pts[0][0] * SIZE} height={SIZE} fill="#000" opacity={0.35} />
        <rect
          x={pts[pts.length - 1][0] * SIZE}
          y={0}
          width={(1 - pts[pts.length - 1][0]) * SIZE}
          height={SIZE}
          fill="#000"
          opacity={0.35}
        />
        <path
          d={curvePath(pts)}
          fill="none"
          stroke={INK[channel]}
          strokeWidth={1.75}
          vectorEffect="non-scaling-stroke"
        />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x * SIZE}
            cy={(1 - y) * SIZE}
            r={i === shown ? 5 : 4}
            fill={i === active ? INK[channel] : "var(--ss-sunken)"}
            stroke={INK[channel]}
            strokeWidth={1.5}
            opacity={i === active && removing ? 0.3 : 1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <div className="flex flex-wrap items-center gap-1.5">
        <Tip label="Pull each colour's black and white point in to where the scan's data sits" keys="F">
          <ProButton onClick={onFit}>
            <Wand2 /> Fit to data
          </ProButton>
        </Tip>
        <Tip label="Fit every slide still to develop, each to its own data" keys="⇧F">
          <ProButton onClick={onFitAll}>Fit all</ProButton>
        </Tip>
        <Tip label={`Straighten the ${LABEL[channel]} curve`}>
          <ProButton
            plain
            className="ml-auto"
            aria-label={`Reset ${LABEL[channel]} curve`}
            disabled={isStraight(curves?.[channel])}
            onClick={() => commit(null)}
          >
            <Undo2 />
          </ProButton>
        </Tip>
      </div>
    </div>
  );
}
