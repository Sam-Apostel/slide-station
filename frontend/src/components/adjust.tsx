import * as React from "react";
import { Pipette, RotateCcw } from "lucide-react";
import { ProButton } from "@/components/ui/pro-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tip } from "@/components/tip";
import { isStraight, CHANNELS } from "@/lib/curves";
import type { Group, Params, ParamKey, SessionPayload } from "@/lib/api";
import type { SlideStation } from "@/hooks/use-slide-station";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ what each control looks like

type Spec = {
  key: ParamKey;
  label: string;
  min: number;
  max: number;
  /** Painted rail: what moving that way does to the photo. */
  track: string;
  hint: [string, string];
};

const WARM = "#f0a53a";
const COOL = "#4d8fe6";
const GREEN = "#4dbb72";
const MAGENTA = "#d25ad2";

const SPECS: Record<"strength" | "dust" | "brightness" | "contrast" | "saturation", Spec> = {
  strength: {
    key: "strength",
    label: "Auto restore",
    min: 0,
    max: 1,
    track: "linear-gradient(90deg, #6d7876, #8c8a78 45%, #d49a48)",
    hint: ["off", "full"],
  },
  dust: {
    key: "dust",
    label: "Dust",
    min: 0,
    max: 1,
    // specks on the left, gone to the right
    track:
      "radial-gradient(circle at 7% 40%, #101012 0 1.5px, transparent 2px), radial-gradient(circle at 16% 68%, #ecebe6 0 1px, transparent 1.5px), radial-gradient(circle at 27% 34%, #101012 0 1px, transparent 1.5px), linear-gradient(90deg, #5f6361, #8a8d8b)",
    hint: ["off", "strong"],
  },
  brightness: {
    key: "brightness",
    label: "Brightness",
    min: -1,
    max: 1,
    track: "linear-gradient(90deg, #0d0d0f, #6a6a6a 50%, #f1efe9)",
    hint: ["darker", "brighter"],
  },
  contrast: {
    key: "contrast",
    label: "Contrast",
    min: -1,
    max: 1,
    // top half light, bottom half dark: they drift apart to the right
    track:
      "linear-gradient(90deg, #707070, #e8e8e8) top / 100% 50% no-repeat, linear-gradient(90deg, #5c5c5c, #0b0b0b) bottom / 100% 50% no-repeat",
    hint: ["flatter", "punchier"],
  },
  saturation: {
    key: "saturation",
    label: "Saturation",
    min: -1,
    max: 1,
    track: "linear-gradient(90deg, #7c7c7c, #9d8a78 50%, #e8663f 78%, #d9458f)",
    hint: ["muted", "vivid"],
  },
};

const LIGHT_KEYS = ["brightness", "contrast"] as const;

const fmt = (v: number, bipolar: boolean) => {
  const n = Math.round(v * 100);
  if (!bipolar) return String(n);
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0";
};
const parse = (s: string) => {
  const n = Number(s.replace("−", "-").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n / 100 : null;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------ value field

/**
 * The number next to a control: shows the value, and takes typing (Enter / blur commits, Esc
 * reverts, ↑ ↓ nudge by 1, with Shift by 10). Typing in it keeps the app's single-key shortcuts
 * out of the way, like any text field.
 */
function ValueField({
  label,
  value,
  min,
  max,
  bipolar,
  changed,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  bipolar: boolean;
  changed: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = (s: string) => {
    const v = parse(s);
    if (v !== null) onCommit(clamp(v, min, max));
    setDraft(null);
  };
  return (
    <input
      aria-label={`${label} value`}
      inputMode="numeric"
      className={cn("ss-adj-value", changed && "text-foreground")}
      value={draft ?? fmt(value, bipolar)}
      onFocus={(e) => {
        setDraft(fmt(value, bipolar));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => draft !== null && commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setDraft(null);
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation(); // not the next / previous slide
          const step = (e.shiftKey ? 10 : 1) / 100;
          const next = clamp(value + (e.key === "ArrowUp" ? step : -step), min, max);
          onCommit(Math.round(next * 100) / 100);
          setDraft(fmt(next, bipolar));
        }
      }}
    />
  );
}

// ------------------------------------------------------------------ slider

/**
 * One adjustment: label, value, and a rail painted with what the control does. Bipolar controls
 * show a centre notch and a bar from the centre out to the value, so what's been changed (and by
 * how much) reads at a glance. Double-click resets.
 */
function AdjustSlider({
  spec,
  value,
  resetValue,
  onChange,
}: {
  spec: Spec;
  value: number;
  resetValue: number;
  onChange: (v: number, immediate?: boolean) => void;
}) {
  const bipolar = spec.min < 0;
  const changed = Math.abs(value - resetValue) > 0.004;
  const pos = (v: number) => ((v - spec.min) / (spec.max - spec.min)) * 100;
  const from = bipolar ? 50 : pos(resetValue);
  const at = pos(value);
  return (
    <div className="ss-adj" data-changed={changed || undefined}>
      <div className="flex items-center gap-1.5">
        <span className="ss-adj-label">{spec.label}</span>
        {changed && <span aria-hidden className="size-[5px] rounded-full bg-primary" />}
        <ValueField
          label={spec.label}
          value={value}
          min={spec.min}
          max={spec.max}
          bipolar={bipolar}
          changed={changed}
          onCommit={(v) => onChange(v, true)}
        />
      </div>
      <div className="ss-adj-track" onDoubleClick={() => onChange(resetValue, true)}>
        <div className="ss-adj-rail" style={{ background: spec.track }} />
        {bipolar && <div aria-hidden className="ss-adj-notch" />}
        {changed && (
          <div
            aria-hidden
            className="ss-adj-delta"
            style={{ left: `${Math.min(from, at)}%`, width: `${Math.abs(at - from)}%` }}
          />
        )}
        <div aria-hidden className="ss-adj-thumb" style={{ left: `${at}%` }} />
        <input
          type="range"
          aria-label={spec.label}
          aria-valuetext={`${fmt(value, bipolar)} (${value < resetValue ? spec.hint[0] : spec.hint[1]})`}
          min={spec.min}
          max={spec.max}
          step={0.01}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ white balance

/**
 * Warmth × tint as one 2D pad: across is cool → warm, up is green → magenta, the puck is the
 * slide's balance. Drag it, type the numbers, double-click to centre, or pick a neutral spot on
 * the photo with the eyedropper.
 */
function BalancePad({
  warmth,
  tint,
  picking,
  onChange,
  onPick,
}: {
  warmth: number;
  tint: number;
  picking: boolean;
  onChange: (w: number, t: number, immediate?: boolean) => void;
  onPick: () => void;
}) {
  const pad = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef<number | null>(null);
  const changed = Math.abs(warmth) > 0.004 || Math.abs(tint) > 0.004;

  const fromPointer = (e: React.PointerEvent) => {
    const b = pad.current!.getBoundingClientRect();
    const r = { left: b.left + 8, top: b.top + 8, width: b.width - 16, height: b.height - 16 }; // as the puck
    const round = (v: number) => Math.round(clamp(v, -1, 1) * 100) / 100;
    return [round(((e.clientX - r.left) / r.width) * 2 - 1), round(1 - ((e.clientY - r.top) / r.height) * 2)] as const;
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="ss-adj-label">White balance</span>
        {changed && <span aria-hidden className="size-[5px] rounded-full bg-primary" />}
        <Tip label="Pick something that should be neutral grey or white" keys="W">
          <ProButton
            plain
            className="ml-auto"
            aria-label="Pick a neutral spot on the photo"
            aria-pressed={picking}
            data-on={picking || undefined}
            onClick={onPick}
          >
            <Pipette /> Neutral
          </ProButton>
        </Tip>
      </div>
      <div
        ref={pad}
        role="group"
        aria-label="White balance pad: cool to warm across, green to magenta up"
        className="ss-balance"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragging.current = e.pointerId;
          e.currentTarget.setPointerCapture(e.pointerId);
          const [w, t] = fromPointer(e);
          onChange(w, t);
        }}
        onPointerMove={(e) => {
          if (dragging.current !== e.pointerId) return;
          const [w, t] = fromPointer(e);
          onChange(w, t);
        }}
        onPointerUp={() => (dragging.current = null)}
        onPointerCancel={() => (dragging.current = null)}
        onDoubleClick={() => onChange(0, 0, true)}
      >
        <span className="ss-balance-axis ss-balance-axis-x" />
        <span className="ss-balance-axis ss-balance-axis-y" />
        <span className="ss-balance-tag left-1.5">cool</span>
        <span className="ss-balance-tag right-1.5">warm</span>
        <span
          aria-hidden
          className="ss-balance-puck"
          data-changed={changed || undefined}
          // kept inside the pad: the edges are the ±100 limits
          style={{
            left: `calc(8px + (100% - 16px) * ${(warmth + 1) / 2})`,
            top: `calc(8px + (100% - 16px) * ${(1 - tint) / 2})`,
          }}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="ss-adj-pair">
          <span
            className="size-[7px] rounded-full"
            style={{ background: `linear-gradient(90deg, ${COOL}, ${WARM})` }}
          />
          Warmth
          <ValueField
            label="Warmth"
            value={warmth}
            min={-1}
            max={1}
            bipolar
            changed={Math.abs(warmth) > 0.004}
            onCommit={(v) => onChange(v, tint, true)}
          />
        </label>
        <label className="ss-adj-pair">
          <span
            className="size-[7px] rounded-full"
            style={{ background: `linear-gradient(90deg, ${GREEN}, ${MAGENTA})` }}
          />
          Tint
          <ValueField
            label="Tint"
            value={tint}
            min={-1}
            max={1}
            bipolar
            changed={Math.abs(tint) > 0.004}
            onCommit={(v) => onChange(warmth, v, true)}
          />
        </label>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the panel

function Section({
  title,
  note,
  changed,
  onReset,
  children,
}: {
  title: string;
  /** A short state chip next to the title. */
  note?: string;
  changed: boolean;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="ss-adj-group">
      <div className="ss-adj-group-head">
        <span>{title}</span>
        {note && <span className="ss-adj-note">{note}</span>}
        <span className="flex-1" />
        {changed && (
          <Tip label={`Reset ${title.toLowerCase()}`}>
            <button type="button" aria-label={`Reset ${title.toLowerCase()}`} onClick={onReset}>
              <RotateCcw />
            </button>
          </Tip>
        )}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

const off = (v: number, d = 0) => Math.abs(v - d) > 0.004;

/** How many adjustments differ from neutral, for the collapsed section's summary. */
export function adjustSummary(g: Group, defaults: Params) {
  const p = g.params;
  const n =
    [off(p.brightness), off(p.contrast), off(p.saturation), off(p.warmth) || off(p.tint), off(p.dust ?? 0)].filter(
      Boolean,
    ).length + (off(p.strength, defaults.strength) ? 1 : 0);
  const src = g.params_source.startsWith("learned:")
    ? `learned from ${g.params_source.split(":")[1]}`
    : g.params_source === "manual"
      ? "by hand"
      : "tray defaults";
  return n ? `${src} · ${n} changed` : src;
}

/**
 * Colour adjustments, grouped the way you work through a faded slide: restore what the film lost,
 * set the light, then balance the colour. Every control shows what it does (painted rails, a
 * white-balance pad) and what has been touched (amber marks, a bar from the neutral point).
 */
export function AdjustPanel({
  app,
  session,
  picking,
  onPick,
}: {
  app: SlideStation;
  session: SessionPayload;
  picking: boolean;
  onPick: () => void;
}) {
  const g = app.current!;
  const p = g.params;
  const d = session.defaults;
  const set = (k: ParamKey) => (v: number, immediate?: boolean) => app.setParam(k, v, immediate);
  const curvesOn = CHANNELS.some((c) => !isStraight(p.curves?.[c]));

  return (
    <div className="flex flex-col pb-1">
      <Section
        title="Restore"
        note={curvesOn && p.strength === 0 ? "by the tone curve" : undefined}
        changed={off(p.strength, d.strength) || p.trim !== d.trim || off(p.dust ?? 0, d.dust ?? 0)}
        onReset={() => {
          app.setParam("strength", d.strength, true);
          app.setParam("trim", d.trim, true);
          app.setParam("dust", d.dust ?? 0, true);
        }}
      >
        <AdjustSlider spec={SPECS.strength} value={p.strength} resetValue={d.strength} onChange={set("strength")} />
        <AdjustSlider spec={SPECS.dust} value={p.dust ?? 0} resetValue={d.dust ?? 0} onChange={set("dust")} />

        <div className="flex items-center gap-2">
          <Checkbox id="trim" checked={p.trim} onCheckedChange={(v) => app.setParam("trim", v === true, true)} />
          <Label htmlFor="trim" className="text-[12px] font-normal text-muted-foreground">
            Trim dark mount edges
          </Label>
        </div>
      </Section>

      <Section
        title="Light"
        changed={LIGHT_KEYS.some((k) => off(p[k]))}
        onReset={() => LIGHT_KEYS.forEach((k) => app.setParam(k, 0, true))}
      >
        {LIGHT_KEYS.map((k) => (
          <AdjustSlider key={k} spec={SPECS[k]} value={p[k]} resetValue={0} onChange={set(k)} />
        ))}
      </Section>

      <Section
        title="Colour"
        changed={off(p.warmth) || off(p.tint) || off(p.saturation)}
        onReset={() => (["warmth", "tint", "saturation"] as const).forEach((k) => app.setParam(k, 0, true))}
      >
        <BalancePad
          warmth={p.warmth}
          tint={p.tint}
          picking={picking}
          onPick={onPick}
          onChange={(w, t, immediate) => {
            app.setParam("warmth", w, immediate);
            app.setParam("tint", t, immediate);
          }}
        />
        <AdjustSlider spec={SPECS.saturation} value={p.saturation} resetValue={0} onChange={set("saturation")} />
      </Section>
    </div>
  );
}
