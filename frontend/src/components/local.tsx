import * as React from "react";
import { Brush, Circle, Eraser, Eye, EyeOff, SunDim, Trash2, X } from "lucide-react";
import { ProButton } from "@/components/ui/pro-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/tip";
import { AdjustSlider, COOL, GREEN, MAGENTA, SPECS, WARM, type Spec } from "@/components/adjust";
import { LOCAL_MAX, LOCAL_NAMES, PictureView, localMask, localSummary, newLocal } from "@/lib/local";
import type { BrushStroke, Group, Local, LocalSlider, Pt } from "@/lib/api";
import type { SlideStation } from "@/hooks/use-slide-station";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ tool state

export type BrushSettings = { radius: number; hardness: number; flow: number; erase: boolean };

/** The Local tool: open or not, which adjustment is being edited, the mask overlay, the brush. */
export type LocalTool = {
  open: boolean;
  sel: number;
  showMask: boolean;
  brush: BrushSettings;
};

export const LOCAL_CLOSED: LocalTool = {
  open: false,
  sel: 0,
  showMask: false,
  brush: { radius: 0.04, hardness: 0.5, flow: 0.8, erase: false },
};

/** Edits to a slide's local adjustments, through the same optimistic, debounced, undoable path as
 *  every other setting (PATCH params, so the server's undo step covers them). */
export function useLocalEdits(app: SlideStation) {
  const g = app.current;
  const list: Local[] = g?.params.local ?? [];
  const set = (next: Local[], immediate = false) => app.setParam("local", next, immediate);
  const update = (i: number, fn: (a: Local) => Local, immediate = false) =>
    set(
      list.map((a, k) => (k === i ? fn(a) : a)),
      immediate,
    );
  return { list, set, update };
}

// ------------------------------------------------------------------ inspector section

const SLIDER_SPECS: Record<LocalSlider, Spec> = {
  exposure: {
    ...SPECS.brightness,
    key: "exposure",
    label: "Exposure",
    hint: ["burn", "dodge"],
  },
  contrast: SPECS.contrast,
  warmth: {
    key: "warmth",
    label: "Warmth",
    min: -1,
    max: 1,
    track: `linear-gradient(90deg, ${COOL}, #8a8a8a 50%, ${WARM})`,
    hint: ["cooler", "warmer"],
  },
  tint: {
    key: "tint",
    label: "Tint",
    min: -1,
    max: 1,
    track: `linear-gradient(90deg, ${GREEN}, #8a8a8a 50%, ${MAGENTA})`,
    hint: ["greener", "more magenta"],
  },
  saturation: SPECS.saturation,
};
// named "Local …" for screen readers (and tests): the Adjust panel has a Contrast and a Saturation too
const SLIDERS = Object.fromEntries(
  Object.entries(SLIDER_SPECS).map(([k, s]) => [k, { ...s, aria: `Local ${s.label.toLowerCase()}` }]),
) as Record<LocalSlider, Spec>;

const FEATHER: Spec = {
  key: "feather",
  aria: "Local feather",
  label: "Feather",
  min: 0,
  max: 1,
  track: "linear-gradient(90deg, #d8d8d8, #d8d8d8 30%, #3a3a3a)",
  hint: ["hard edge", "soft"],
};

const BRUSH_SPECS: Record<"radius" | "hardness" | "flow", Spec> = {
  radius: {
    key: "radius",
    label: "Size",
    aria: "Brush size",
    min: 0.005,
    max: 0.25,
    track: "linear-gradient(90deg, #555, #aaa)",
    hint: ["small", "large"],
  },
  hardness: {
    key: "hardness",
    label: "Hardness",
    aria: "Brush hardness",
    min: 0,
    max: 1,
    track: FEATHER.track.replace("90deg", "270deg"),
    hint: ["soft", "hard"],
  },
  flow: {
    key: "flow",
    label: "Flow",
    aria: "Brush flow",
    min: 0.05,
    max: 1,
    track: "linear-gradient(90deg, #3a3a3a, #e8e8e8)",
    hint: ["light", "full"],
  },
};

const KIND_ICON: Record<Local["kind"], React.ReactNode> = {
  graduated: <SunDim />,
  radial: <Circle />,
  brush: <Brush />,
};

/** The collapsed Local section's summary. */
export function localNote(g: Group) {
  const list = g.params.local ?? [];
  if (!list.length) return "none";
  return list.length === 1 ? LOCAL_NAMES[list[0].kind].toLowerCase() : `${list.length} adjustments`;
}

/**
 * Local adjustments: add a graduated filter, a radial or a brush, pick one to shape it on the
 * photo (the Local tool, A) and set what it does with the Adjust panel's controls.
 */
export function LocalPanel({
  app,
  tool,
  setTool,
}: {
  app: SlideStation;
  tool: LocalTool;
  setTool: React.Dispatch<React.SetStateAction<LocalTool>>;
}) {
  const { list, set, update } = useLocalEdits(app);
  const sel = Math.min(tool.sel, list.length - 1);
  const adj = sel >= 0 ? list[sel] : undefined;
  const add = (kind: Local["kind"]) => {
    if (list.length >= LOCAL_MAX) return;
    set([...list, newLocal(kind)], true);
    setTool((t) => ({ ...t, open: true, sel: list.length }));
  };
  const remove = (i: number) => {
    set(
      list.filter((_, k) => k !== i),
      true,
    );
    setTool((t) => ({ ...t, sel: Math.max(0, Math.min(t.sel, list.length - 2)) }));
  };

  return (
    <div className="flex flex-col gap-2.5 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        {(["graduated", "radial", "brush"] as const).map((kind) => (
          <Tip
            key={kind}
            label={
              kind === "graduated"
                ? "Graduated filter: burn a pale sky in, from the edge you drag from"
                : kind === "radial"
                  ? "Radial: dodge or burn inside (or outside) an ellipse"
                  : "Brush: paint where it applies"
            }
          >
            <ProButton aria-label={`Add ${kind}`} disabled={list.length >= LOCAL_MAX} onClick={() => add(kind)}>
              {KIND_ICON[kind]} {LOCAL_NAMES[kind]}
            </ProButton>
          </Tip>
        ))}
        <span className="flex-1" />
        <Tip label={tool.showMask ? "Hide the mask" : "Show the mask over the photo"} keys="O">
          <ProButton
            plain
            aria-label="Show mask"
            aria-pressed={tool.showMask || undefined}
            data-on={tool.showMask || undefined}
            onClick={() => setTool((t) => ({ ...t, showMask: !t.showMask, open: true }))}
          >
            {tool.showMask ? <Eye /> : <EyeOff />}
          </ProButton>
        </Tip>
      </div>

      {!list.length && (
        <p className="text-[12px] text-muted-foreground">
          Dodge a dark foreground or burn a blown sky back in. Each slide keeps its own: Copy previous and Apply to rest
          leave them out. <Kbd>A</Kbd> shows them on the photo.
        </p>
      )}

      {!!list.length && (
        <ul className="flex flex-col gap-1" aria-label="Local adjustments">
          {list.map((a, i) => (
            <li key={i}>
              <div
                role="button"
                tabIndex={0}
                aria-pressed={i === sel}
                aria-label={`${LOCAL_NAMES[a.kind]} ${i + 1}`}
                className={cn("ss-local-item", i === sel && tool.open && "ss-local-item-on")}
                onClick={() => setTool((t) => ({ ...t, sel: i, open: true }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setTool((t) => ({ ...t, sel: i, open: true }));
                }}
              >
                {KIND_ICON[a.kind]}
                <span className="min-w-0 flex-1 truncate">
                  {LOCAL_NAMES[a.kind]}
                  <span className="text-muted-foreground"> · {localSummary(a)}</span>
                </span>
                <Tip label="Delete" keys="⌫">
                  <button
                    type="button"
                    aria-label={`Delete ${LOCAL_NAMES[a.kind].toLowerCase()} ${i + 1}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(i);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </Tip>
              </div>
            </li>
          ))}
        </ul>
      )}

      {adj && (
        <div className="flex flex-col gap-2.5" aria-label={`${LOCAL_NAMES[adj.kind]} settings`}>
          {(Object.keys(SLIDERS) as LocalSlider[]).map((k) => (
            <AdjustSlider
              key={k}
              spec={SLIDERS[k]}
              value={adj[k]}
              resetValue={0}
              onChange={(v, immediate) => update(sel, (a) => ({ ...a, [k]: v }), immediate)}
            />
          ))}
          {adj.kind === "radial" && (
            <>
              <AdjustSlider
                spec={FEATHER}
                value={adj.feather}
                resetValue={0.6}
                onChange={(v, immediate) => update(sel, (a) => ({ ...a, feather: v }), immediate)}
              />
              <div className="flex items-center gap-2">
                <Checkbox
                  id="local-invert"
                  checked={adj.invert}
                  onCheckedChange={(v) => update(sel, (a) => ({ ...a, invert: v === true }), true)}
                />
                <Label htmlFor="local-invert" className="text-[12px] font-normal text-muted-foreground">
                  Outside the ellipse (a vignette)
                </Label>
              </div>
            </>
          )}
          {adj.kind === "brush" && (
            <BrushControls
              brush={tool.brush}
              strokes={adj.strokes.length}
              onBrush={(b) => setTool((t) => ({ ...t, brush: { ...t.brush, ...b }, open: true }))}
              onClear={() => update(sel, (a) => ({ ...a, strokes: [] }), true)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function BrushControls({
  brush,
  strokes,
  onBrush,
  onClear,
}: {
  brush: BrushSettings;
  strokes: number;
  onBrush: (b: Partial<BrushSettings>) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5 border-t border-border pt-2.5">
      <div className="flex items-center gap-1.5">
        <span className="ss-adj-label">Brush</span>
        <div className="ss-seg" role="radiogroup" aria-label="Brush mode">
          <button type="button" role="radio" aria-checked={!brush.erase} onClick={() => onBrush({ erase: false })}>
            <Brush className="inline size-3" /> Paint
          </button>
          <button type="button" role="radio" aria-checked={brush.erase} onClick={() => onBrush({ erase: true })}>
            <Eraser className="inline size-3" /> Erase
          </button>
        </div>
        <span className="flex-1" />
        {strokes > 0 && (
          <Tip label="Remove every stroke">
            <ProButton plain aria-label="Clear strokes" onClick={onClear}>
              <X /> Clear
            </ProButton>
          </Tip>
        )}
      </div>
      {(["radius", "hardness", "flow"] as const).map((k) => (
        <AdjustSlider
          key={k}
          spec={BRUSH_SPECS[k]}
          value={brush[k]}
          resetValue={LOCAL_CLOSED.brush[k]}
          onChange={(v) => onBrush({ [k]: v })}
        />
      ))}
      <p className="text-[11px] text-muted-foreground">
        Paint on the photo; {strokes ? `${strokes} stroke${strokes > 1 ? "s" : ""} so far` : "nothing painted yet"}.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ on the photo

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

type Drag =
  | { what: "start" | "end" | "line" | "center" | "rx" | "ry"; id: number; from: Pt; start: Local }
  | { what: "paint"; id: number; points: Pt[] };

/** The mask, drawn once per change on a small grid, as a red wash over the picture. */
function MaskCanvas({ adj, aspect }: { adj: Local; aspect: number }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const m = localMask(adj, aspect * 1000, 1000, 256);
    c.width = m.width;
    c.height = m.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(m.width, m.height);
    for (let i = 0; i < m.data.length; i++) {
      img.data[i * 4] = 240;
      img.data[i * 4 + 1] = 70;
      img.data[i * 4 + 2] = 60;
      img.data[i * 4 + 3] = Math.round(m.data[i] * 150);
    }
    ctx.putImageData(img, 0, 0);
  }, [adj, aspect]);
  // the grid is a little wider than the picture when its edge isn't a whole number of cells
  const m = { w: Math.ceil((256 * aspect) / Math.max(aspect, 1)), h: Math.ceil(256 / Math.max(aspect, 1)) };
  const kx = (256 * aspect) / Math.max(aspect, 1);
  const ky = 256 / Math.max(aspect, 1);
  return (
    <canvas
      ref={ref}
      data-testid="local-mask"
      className="ss-local-mask"
      style={{ width: `${(m.w / kx) * 100}%`, height: `${(m.h / ky) * 100}%` }}
    />
  );
}

/**
 * The Local tool over the photo: the selected adjustment's handles (a graduated filter's start,
 * middle and end lines; a radial's centre and two radii, which also turn it), painting for a
 * brush, and the mask as a red wash. Everything is drawn in the picture's own frame — the layer is
 * turned and zoomed like straighten() and shifted by the crop — so masks sit where the renderer
 * puts them.
 */
export function LocalOverlay({ img, app, tool }: { img: HTMLImageElement | null; app: SlideStation; tool: LocalTool }) {
  const [box, setBox] = React.useState<ReturnType<typeof contentBox>>(null);
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const [hover, setHover] = React.useState<Pt | null>(null);
  const { list, update } = useLocalEdits(app);
  const g = app.current;

  React.useLayoutEffect(() => {
    if (!img) return;
    const refresh = () => setBox(contentBox(img));
    refresh();
    const ro = new ResizeObserver(refresh);
    ro.observe(img);
    img.addEventListener("load", refresh);
    return () => {
      ro.disconnect();
      img.removeEventListener("load", refresh);
    };
  }, [img]);

  if (!box || !g) return null;
  const sel = Math.min(tool.sel, list.length - 1);
  const adj = sel >= 0 ? list[sel] : undefined;
  const view = new PictureView(box.width / box.height, g.params);
  const [l, t, r, b] = g.params.crop ?? [0, 0, 1, 1];
  const fw = box.width / (r - l); // the straightened frame, on screen
  const fh = box.height / (b - t);
  const long = Math.max(fw, fh); // picture lengths are fractions of its longer edge
  const px = (p: Pt): Pt => [p[0] * fw, p[1] * fh];
  const handle = 7 / view.scale; // screen-sized handles inside the zoomed layer

  const pointAt = (e: React.PointerEvent): Pt => {
    const root = (e.currentTarget as HTMLElement).closest(".ss-local")!.getBoundingClientRect();
    return view.fromShown([(e.clientX - root.left) / box.width, (e.clientY - root.top) / box.height]);
  };

  const begin = (what: Exclude<Drag["what"], "paint">) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !adj) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ what, id: e.pointerId, from: pointAt(e), start: adj });
  };

  const paintDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || adj?.kind !== "brush") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ what: "paint", id: e.pointerId, points: [pointAt(e)] });
  };

  const move = (e: React.PointerEvent) => {
    const at = pointAt(e);
    if (adj?.kind === "brush") setHover(at);
    if (!drag || drag.id !== e.pointerId || !adj) return;
    if (drag.what === "paint") {
      // a point every quarter of the brush's radius: smooth, and well under the server's 400 a stroke
      const last = drag.points[drag.points.length - 1];
      const d = Math.hypot((at[0] - last[0]) * fw, (at[1] - last[1]) * fh) / long;
      if (d >= tool.brush.radius / 4 && drag.points.length < 400) setDrag({ ...drag, points: [...drag.points, at] });
      return;
    }
    const s = drag.start;
    const dx = at[0] - drag.from[0];
    const dy = at[1] - drag.from[1];
    const shift = (p: Pt): Pt => [p[0] + dx, p[1] + dy];
    const round = (v: number) => Math.round(v * 10000) / 10000;
    const pt = (p: Pt): Pt => [round(Math.min(2, Math.max(-1, p[0]))), round(Math.min(2, Math.max(-1, p[1])))];
    if (s.kind === "graduated") {
      const next =
        drag.what === "start"
          ? { start: pt(at) }
          : drag.what === "end"
            ? { end: pt(at) }
            : { start: pt(shift(s.start)), end: pt(shift(s.end)) };
      update(sel, (a) => ({ ...a, ...next }) as Local);
    } else if (s.kind === "radial") {
      if (drag.what === "center") update(sel, (a) => ({ ...a, center: pt(shift(s.center)) }) as Local);
      else {
        // the handle's direction turns the ellipse, its distance sizes that radius
        const vx = (at[0] - s.center[0]) * fw;
        const vy = (at[1] - s.center[1]) * fh;
        const len = Math.min(2, Math.max(0.005, Math.hypot(vx, vy) / long));
        let ang = (Math.atan2(vy, vx) * 180) / Math.PI - (drag.what === "ry" ? 90 : 0);
        ang = ((((ang + 180) % 360) + 360) % 360) - 180;
        update(sel, (a) => ({ ...a, [drag.what]: round(len), angle: round(ang) }) as Local);
      }
    }
  };

  const up = (e: React.PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.what === "paint" && adj?.kind === "brush") {
      const b = tool.brush;
      const stroke: BrushStroke = {
        points: drag.points.map((p) => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]),
        radius: b.radius,
        hardness: b.hardness,
        flow: b.flow,
        erase: b.erase,
      };
      update(sel, (a) => (a.kind === "brush" ? { ...a, strokes: [...a.strokes, stroke].slice(-64) } : a), true);
    }
    setDrag(null);
  };

  // what the mask overlay shows: the adjustment with the stroke being painted
  const shown =
    adj && drag?.what === "paint" && adj.kind === "brush"
      ? {
          ...adj,
          strokes: [...adj.strokes, { points: drag.points, ...tool.brush }],
        }
      : adj;
  const masking = !!shown && (tool.showMask || shown.kind === "brush");

  const lineAcross = (p: Pt, n: Pt, dashed = false, key?: string) => {
    const [x, y] = px(p);
    return (
      <line
        key={key}
        x1={x - n[0] * 3 * long}
        y1={y - n[1] * 3 * long}
        x2={x + n[0] * 3 * long}
        y2={y + n[1] * 3 * long}
        className="ss-local-line"
        strokeDasharray={dashed ? "5 4" : undefined}
      />
    );
  };
  const dot = (p: Pt, what: Exclude<Drag["what"], "paint">, label: string, big = false) => {
    const [x, y] = px(p);
    return (
      <circle
        cx={x}
        cy={y}
        r={big ? handle * 1.25 : handle}
        className="ss-local-handle"
        data-h={what}
        aria-label={label}
        onPointerDown={begin(what)}
      />
    );
  };

  let shapes: React.ReactNode = null;
  if (adj?.kind === "graduated") {
    const [sx, sy] = px(adj.start);
    const [ex, ey] = px(adj.end);
    const len = Math.hypot(ex - sx, ey - sy) || 1;
    const n: Pt = [-(ey - sy) / len, (ex - sx) / len];
    const mid: Pt = [(adj.start[0] + adj.end[0]) / 2, (adj.start[1] + adj.end[1]) / 2];
    shapes = (
      <>
        {lineAcross(adj.start, n, false, "s")}
        {lineAcross(mid, n, true, "m")}
        {lineAcross(adj.end, n, false, "e")}
        <line x1={sx} y1={sy} x2={ex} y2={ey} className="ss-local-line ss-local-axis" />
        {dot(adj.start, "start", "Graduated start (full effect)")}
        {dot(mid, "line", "Move the graduated filter", true)}
        {dot(adj.end, "end", "Graduated end (no effect)")}
      </>
    );
  } else if (adj?.kind === "radial") {
    const [cx, cy] = px(adj.center);
    const rx = adj.rx * long;
    const ry = adj.ry * long;
    const th = (adj.angle * Math.PI) / 180;
    const inner = 1 - adj.feather;
    const onAxis = (d: number, alongY: boolean): Pt => {
      const [ux, uy] = alongY ? [-Math.sin(th), Math.cos(th)] : [Math.cos(th), Math.sin(th)];
      return [(cx + ux * d) / fw, (cy + uy * d) / fh];
    };
    shapes = (
      <>
        <ellipse
          cx={cx}
          cy={cy}
          rx={rx}
          ry={ry}
          transform={`rotate(${adj.angle} ${cx} ${cy})`}
          className="ss-local-line"
        />
        {inner > 0.02 && (
          <ellipse
            cx={cx}
            cy={cy}
            rx={rx * inner}
            ry={ry * inner}
            transform={`rotate(${adj.angle} ${cx} ${cy})`}
            className="ss-local-line"
            strokeDasharray="4 4"
          />
        )}
        {dot(adj.center, "center", "Move the radial", true)}
        {dot(onAxis(rx, false), "rx", "Radial width and turn")}
        {dot(onAxis(ry, true), "ry", "Radial height and turn")}
      </>
    );
  }

  const cursor =
    adj?.kind === "brush" && hover ? (
      <circle
        cx={px(hover)[0]}
        cy={px(hover)[1]}
        r={tool.brush.radius * long}
        className={cn("ss-local-line", tool.brush.erase && "ss-local-erase")}
        pointerEvents="none"
      />
    ) : null;

  return (
    <div
      className="ss-local"
      data-kind={adj?.kind}
      data-active={drag ? true : undefined}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={paintDown}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => setHover(null)}
    >
      <div
        className="ss-local-frame"
        style={{
          left: -l * fw,
          top: -t * fh,
          width: fw,
          height: fh,
          transform: `rotate(${view.angle}deg) scale(${view.scale})`,
        }}
      >
        {masking && <MaskCanvas adj={shown!} aspect={view.aspect} />}
        <svg width={fw} height={fh} viewBox={`0 0 ${fw} ${fh}`} className="ss-local-svg">
          {shapes}
          {cursor}
        </svg>
      </div>
      {!list.length && (
        <div className="ss-pick-hint" role="status">
          Add a graduated filter, a radial or a brush in the Local section · <kbd>Esc</kbd>
        </div>
      )}
    </div>
  );
}

/** Keys while the Local tool is open (the app's keyboard map stands aside while `.ss-local` exists). */
export function useLocalKeys(
  open: boolean,
  app: SlideStation,
  setTool: React.Dispatch<React.SetStateAction<LocalTool>>,
  sel: number,
) {
  const latest = React.useRef({ app, sel });
  latest.current = { app, sel };
  React.useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !document.querySelector(".ss-local")) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t.matches("textarea, input:not([type=range]):not([type=checkbox])"))
      )
        return;
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu]")) return;
      const { app: a, sel: i } = latest.current;
      const list = a.current?.params.local ?? [];
      // Enter on a focused button presses it; anywhere else it closes the tool, like Esc
      const onButton = t instanceof HTMLElement && !!t.closest("button, [role=button], [role=radio]");
      if (e.key === "Escape" || (e.key === "Enter" && !onButton) || e.key === "a" || e.key === "A")
        setTool((s) => ({ ...s, open: false }));
      else if (e.key === "o" || e.key === "O") setTool((s) => ({ ...s, showMask: !s.showMask }));
      else if ((e.key === "Delete" || e.key === "Backspace") && list[i]) {
        a.setParam(
          "local",
          list.filter((_, k) => k !== i),
          true,
        );
        setTool((s) => ({ ...s, sel: Math.max(0, i - 1) }));
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [open, setTool]);
}
