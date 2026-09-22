"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface ProSliderProps {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  resetValue?: number;
  disabled?: boolean;
  label?: string;
  className?: string;
  precision?: number;
  valueWidth?: React.CSSProperties["width"];
  /** Optional color for the numeric scrub chevrons. */
  accentColor?: string;
  thumb?: "pointer" | "round";
  track?: "default" | "hue" | "saturation" | "luminance" | string;
  showValue?: boolean;
  showTrack?: boolean;
  /** Normalized post-fader audio levels, painted beneath round thumbs. */
  levels?: { left: number; right: number };
  onValueCommit?: (value: number) => void;
}

export interface ProRoundSliderProps {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  resetValue?: number;
  disabled?: boolean;
  label?: string;
  className?: string;
  levels?: { left: number; right: number };
  valueText?: string;
  trackBackground?: string;
  onValueCommit?: (value: number) => void;
}

/** Full-size native fader used by action bars and round inspector sliders. */
export function ProRoundSlider({
  value,
  onValueChange,
  min = 0,
  max = 1,
  step = (max - min) / 100 || 0.01,
  resetValue,
  disabled,
  label = "Value",
  className,
  levels,
  valueText,
  trackBackground,
  onValueCommit,
}: ProRoundSliderProps) {
  const safeMax = Math.max(min, max);
  const current = Math.min(safeMax, Math.max(min, value));
  const normalized = (current - min) / (safeMax - min || 1);
  const latest = React.useRef(current);
  latest.current = current;
  const [dragging, setDragging] = React.useState(false);
  const update = React.useCallback(
    (next: number) => {
      latest.current = Math.min(safeMax, Math.max(min, next));
      onValueChange(latest.current);
    },
    [min, onValueChange, safeMax],
  );
  const gestures = useProRange({
    value: current,
    onValueChange: update,
    disabled,
    min,
    max: safeMax,
    step,
  });

  return (
    <span
      className={cn(
        "pro-pill-slider-shell relative inline-flex h-[22px] w-[120px] min-w-[60px] select-none rounded-[11px] bg-[#242424] shadow-[inset_0_1px_2px_#0007,0_0.5px_#ffffff18] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
        trackBackground && "[background:var(--pro-pill-track-background)]",
        className,
      )}
      data-disabled={disabled || undefined}
      style={
        trackBackground
          ? ({
              "--pro-pill-track-background": trackBackground,
            } as React.CSSProperties)
          : undefined
      }
    >
      {dragging && !disabled && valueText && (
        <span
          className="pro-pill-slider-value pointer-events-none absolute bottom-[calc(100%+6px)] left-(--pro-pill-value-left) z-[5] -translate-x-1/2 whitespace-nowrap rounded-sm bg-[#242424] px-1.5 py-[3px] text-[10px] leading-[14px] font-medium text-[#ddd] tabular-nums shadow-[inset_0_0.5px_#ffffff20,0_2px_5px_#0006]"
          aria-hidden="true"
          style={
            {
              "--pro-pill-value-left": `calc(10px + (100% - 20px) * ${normalized})`,
            } as React.CSSProperties
          }
        >
          {valueText}
        </span>
      )}
      {levels && (
        <span
          className="pro-pill-slider-meter pointer-events-none absolute inset-[5px_10px] flex flex-col gap-0.5"
          aria-hidden="true"
        >
          {[levels.left, levels.right].map((level, channel) => (
            <span
              className="pro-pill-slider-channel flex-1 overflow-hidden rounded-xs bg-white/[0.047]"
              key={channel}
            >
              <span
                className="block h-full bg-[linear-gradient(to_right,#74af89_0%,#74af89_78%,#e1be61_78%,#e1be61_96%,#d56b63_96%)] [clip-path:var(--pro-level-clip)]"
                style={
                  {
                    "--pro-level-clip": `inset(0 ${(1 - Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0))) * 100}% 0 0)`,
                  } as React.CSSProperties
                }
              />
            </span>
          ))}
        </span>
      )}
      <input
        {...gestures}
        onPointerDown={(event) => {
          gestures.onPointerDown(event);
          if (!disabled && event.button === 0) setDragging(true);
        }}
        onPointerUp={(event) => {
          gestures.onPointerUp(event);
          setDragging(false);
          onValueCommit?.(latest.current);
        }}
        onPointerCancel={() => {
          gestures.onPointerCancel();
          setDragging(false);
        }}
        onLostPointerCapture={() => {
          gestures.onLostPointerCapture();
          setDragging(false);
        }}
        onBlur={() => {
          gestures.onPointerCancel();
          setDragging(false);
        }}
        type="range"
        min={min}
        max={safeMax}
        step={step}
        value={current}
        aria-label={label}
        aria-valuetext={valueText}
        disabled={disabled}
        onChange={(event) => update(Number(event.target.value))}
        onDoubleClick={() => {
          if (disabled || resetValue === undefined) return;
          update(resetValue);
          onValueCommit?.(latest.current);
        }}
        className="pro-pill-slider pro-no-drag relative z-[1] m-0 h-[22px] w-full min-w-[60px] cursor-ew-resize touch-none appearance-none rounded-[11px] bg-transparent outline-none disabled:cursor-not-allowed disabled:opacity-100"
      />
    </span>
  );
}

/** Inspector slider */
export function ProSlider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = (max - min) / 100 || 1,
  resetValue = min + (max - min) / 2,
  disabled,
  label = "Value",
  className,
  precision = 2,
  valueWidth,
  accentColor,
  thumb = "pointer",
  track = "default",
  showValue = true,
  showTrack = true,
  levels,
  onValueCommit,
}: ProSliderProps) {
  const safeMax = Math.max(min, max);
  const increment = Number.isFinite(step) && step > 0 ? step : 1;
  const decimals = Math.min(20, Math.max(0, Math.floor(precision)));
  const cancelEdit = React.useRef(false);
  const normalize = (n: number) =>
    Math.min(
      safeMax,
      Math.max(
        min,
        Number.isFinite(n)
          ? Number(
              (min + Math.round((n - min) / increment) * increment).toFixed(8),
            )
          : min,
      ),
    );
  const current = normalize(value);
  const latest = React.useRef(current);
  latest.current = current;
  const railDrag = React.useRef<{ x: number; value: number } | null>(null);
  const trackPaint =
    track === "hue"
      ? "var(--pro-slider-hue-track)"
      : track === "saturation"
        ? "var(--pro-slider-saturation-track)"
        : track === "luminance"
          ? "var(--pro-slider-luminance-track)"
          : track === "default"
            ? undefined
            : track;
  const pct = (current - min) / (safeMax - min || 1);
  const [draft, setDraft] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [scrubbing, setScrubbing] = React.useState(false);
  const readout = React.useRef<HTMLSpanElement>(null);
  const drag = React.useRef<{
    y: number;
    value: number;
    moved: boolean;
  } | null>(null);
  const startEditing = () => {
    if (disabled) return;
    cancelEdit.current = false;
    setDraft(current.toFixed(decimals));
    setEditing(true);
  };
  const finishDrag = () => {
    drag.current = null;
    setScrubbing(false);
  };
  const update = (n: number) => {
    if (!disabled) {
      latest.current = normalize(n);
      onValueChange(latest.current);
    }
  };
  return (
    <div
      data-slot="pro-slider"
      className={cn(
        "pro-inspector-slider group/pro-slider flex w-full min-w-0 select-none items-center gap-0.5 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
        className,
      )}
      data-disabled={disabled || undefined}
      data-scrubbing={scrubbing || undefined}
      data-editing={editing || undefined}
    >
      {showTrack && thumb === "round" && (
        <ProRoundSlider
          className="pro-inspector-round-slider w-auto flex-auto"
          value={current}
          onValueChange={update}
          onValueCommit={onValueCommit}
          min={min}
          max={safeMax}
          step={increment}
          resetValue={resetValue}
          disabled={disabled}
          label={label}
          levels={levels}
          valueText={current.toFixed(decimals)}
          trackBackground={trackPaint}
        />
      )}
      {showTrack && thumb !== "round" && (
        <div
          className="pro-pointer-track relative h-[22px] min-w-6 flex-1 rounded-[3px] outline-none"
          data-thumb={thumb}
          data-colored={track !== "default"}
          onPointerDown={(e) => {
            if (disabled || e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.querySelector("input")?.focus();
            const box = e.currentTarget.getBoundingClientRect();
            if (!e.altKey && !e.shiftKey)
              update(
                min +
                  ((e.clientX - box.left - 4.6) / (box.width - 9.2)) *
                    (safeMax - min),
              );
            railDrag.current = { x: e.clientX, value: latest.current };
          }}
          onPointerMove={(e) => {
            if (!railDrag.current) return;
            const scale = e.altKey ? 0.2 : e.shiftKey ? 5 : 1;
            const delta =
              ((e.clientX - railDrag.current.x) /
                (e.currentTarget.clientWidth - 9.2)) *
              (safeMax - min) *
              scale;
            const next = Math.max(
              min,
              Math.min(safeMax, railDrag.current.value + delta),
            );
            railDrag.current = { x: e.clientX, value: next };
            update(next);
          }}
          onPointerUp={(e) => {
            if (!railDrag.current) return;
            railDrag.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            onValueCommit?.(latest.current);
          }}
          onPointerCancel={() => {
            railDrag.current = null;
          }}
          onLostPointerCapture={() => {
            railDrag.current = null;
          }}
          onDoubleClick={() => {
            update(resetValue);
            onValueCommit?.(latest.current);
          }}
        >
          <div
            className={cn(
              "pro-pointer-rail absolute top-[10px] right-0 left-1 h-0.5 rounded-xs bg-black/50 shadow-[0_1px_rgb(255_255_255/5%)]",
              trackPaint && "[background:var(--pro-pointer-track)]",
            )}
            style={
              trackPaint
                ? ({
                    "--pro-pointer-track": trackPaint,
                  } as React.CSSProperties)
                : undefined
            }
          />
          <svg
            className="pro-pointer pointer-events-none absolute top-[5px] left-(--pro-pointer-left) -translate-x-1/2 fill-[#808080] stroke-[#181818] stroke-[0.2px] drop-shadow-[0_1px_2px_rgb(0_0_0/30%)] group-hover/pro-slider:fill-[#b3b3b3] group-focus-within/pro-slider:fill-[#b3b3b3] group-data-[scrubbing]/pro-slider:fill-[#b3b3b3]"
            width="9.2"
            height="11"
            viewBox="0 0 9.2 11"
            aria-hidden="true"
            style={
              {
                "--pro-pointer-left": `calc(4.6px + (100% - 9.2px) * ${pct})`,
              } as React.CSSProperties
            }
          >
            <path d="M0 1 L0 7 C0 6.45 .1 6.7 .3 7 L4 10.5 C4.3 11 5 11 5.3 10.5 L9 7 C9.1 6.7 9.2 6.5 9.2 6.2 L9.2 1 C9.2 .45 8.75 0 8.2 0 L1 0 C.45 0 0 .45 0 1 Z" />
          </svg>
          <input
            className="absolute inset-0 m-0 size-full cursor-ew-resize opacity-0 outline-none disabled:cursor-not-allowed"
            type="range"
            aria-label={label}
            aria-valuenow={current}
            min={min}
            max={safeMax}
            step={increment}
            value={current}
            disabled={disabled}
            onChange={(e) => update(Number(e.target.value))}
            onKeyDown={(e) => {
              if (
                ![
                  "ArrowUp",
                  "ArrowRight",
                  "ArrowDown",
                  "ArrowLeft",
                  "Home",
                  "End",
                ].includes(e.key)
              )
                return;
              e.preventDefault();
              const scale = e.altKey ? 0.2 : e.shiftKey ? 5 : 1;
              update(
                e.key === "Home"
                  ? min
                  : e.key === "End"
                    ? safeMax
                    : current +
                      (["ArrowUp", "ArrowRight"].includes(e.key) ? 1 : -1) *
                        increment *
                        scale,
              );
              onValueCommit?.(latest.current);
            }}
          />
        </div>
      )}
      {showValue && (
        <div
          className="pro-value relative w-(--pro-value-width) shrink-0 text-[11px] font-medium tabular-nums"
          style={
            {
              "--pro-value-width":
                typeof valueWidth === "number"
                  ? `${valueWidth}px`
                  : (valueWidth ??
                    `calc(${Math.max(3, min.toFixed(decimals).length, safeMax.toFixed(decimals).length)}ch + 4px)`),
            } as React.CSSProperties
          }
        >
          <span
            className={cn(
              "pro-value-chevrons pointer-events-none absolute inset-0 text-[#bcbcbc] opacity-0 transition-opacity duration-100 ease-out group-hover/pro-slider:opacity-100 group-focus-within/pro-slider:opacity-100 group-data-[scrubbing]/pro-slider:opacity-100 group-data-[disabled]/pro-slider:!opacity-0 group-data-[editing]/pro-slider:!opacity-0 motion-reduce:transition-none [&_svg]:absolute [&_svg]:left-1/2 [&_svg]:-translate-x-1/2 [&_svg]:[fill:none] [&_svg]:stroke-current [&_svg]:stroke-[1.25] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]",
              accentColor && "text-(--pro-value-accent)",
            )}
            aria-hidden="true"
            style={
              accentColor
                ? ({
                    "--pro-value-accent": accentColor,
                  } as React.CSSProperties)
                : undefined
            }
          >
            <svg
              className="pro-value-up -top-px"
              width="11"
              height="3.6"
              viewBox="0 0 11 3.6"
            >
              <path d="M1 2.7 L5.5 1.1 L10 2.7" />
            </svg>
            <svg
              className="pro-value-down -bottom-px"
              width="11"
              height="3.6"
              viewBox="0 0 11 3.6"
            >
              <path d="M1 0.9 L5.5 2.5 L10 0.9" />
            </svg>
          </span>
          {editing ? (
            <input
              className="pro-number block w-full min-w-0 cursor-text touch-none appearance-none rounded-[3px] border-[0.5px] border-[#181818] bg-[#252525] px-px py-0.5 text-center text-[11px] font-medium text-white/85 tabular-nums outline-none"
              type="number"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              aria-label={`${label} value`}
              min={min}
              max={safeMax}
              step={increment}
              disabled={disabled}
              value={draft ?? current.toFixed(decimals)}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (
                  !cancelEdit.current &&
                  draft !== null &&
                  draft.trim() !== "" &&
                  Number.isFinite(Number(draft))
                ) {
                  update(Number(draft));
                  onValueCommit?.(latest.current);
                }
                cancelEdit.current = false;
                setDraft(null);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit.current = e.key === "Escape";
                  e.currentTarget.blur();
                  requestAnimationFrame(() => readout.current?.focus());
                }
              }}
            />
          ) : (
            <span
              ref={readout}
              className="pro-number pro-value-readout block box-border w-full min-w-0 cursor-ns-resize touch-none select-none appearance-none rounded-[3px] border border-transparent group-data-[disabled]/pro-slider:cursor-not-allowed bg-transparent px-px py-0.5 text-center text-[11px] leading-4 font-medium text-white/85 tabular-nums outline-none"
              role="spinbutton"
              tabIndex={disabled ? -1 : 0}
              aria-label={`${label} value`}
              aria-valuemin={min}
              aria-valuemax={safeMax}
              aria-valuenow={current}
              aria-disabled={disabled || undefined}
              title="Drag to adjust. Shift: 5× speed. Option: 0.2× speed. Click to type."
              onPointerDown={(e) => {
                if (disabled || e.button !== 0) return;
                e.preventDefault();
                drag.current = { y: e.clientY, value: current, moved: false };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                const distance = drag.current.y - e.clientY;
                if (!drag.current.moved && Math.abs(distance) <= 3) return;
                drag.current.moved = true;
                setScrubbing(true);
                const next =
                  drag.current.value +
                  ((distance * (safeMax - min)) / 200) *
                    (e.altKey ? 0.2 : e.shiftKey ? 5 : 1);
                drag.current.y = e.clientY;
                drag.current.value = Math.max(min, Math.min(safeMax, next));
                update(next);
              }}
              onPointerUp={(e) => {
                if (!drag.current) return;
                const clicked = !drag.current.moved;
                finishDrag();
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
                if (clicked) startEditing();
                else onValueCommit?.(latest.current);
              }}
              onPointerCancel={finishDrag}
              onLostPointerCapture={finishDrag}
              onClick={(e) => {
                if (e.detail === 0) startEditing();
              }}
              onKeyDown={(e) => {
                if (disabled) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  startEditing();
                } else if (
                  [
                    "ArrowUp",
                    "ArrowDown",
                    "ArrowLeft",
                    "ArrowRight",
                    "Home",
                    "End",
                  ].includes(e.key)
                ) {
                  e.preventDefault();
                  update(
                    e.key === "Home"
                      ? min
                      : e.key === "End"
                        ? safeMax
                        : current +
                          (["ArrowUp", "ArrowRight"].includes(e.key)
                            ? increment
                            : -increment) *
                            (e.altKey ? 0.2 : e.shiftKey ? 5 : 1),
                  );
                }
              }}
            >
              {current.toFixed(decimals)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export { ProSlider as ProInspectorSlider };

/** Shared modifier gestures for the compact native range controls. */
export function useProRange({
  value,
  onValueChange,
  disabled,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  value: number;
  onValueChange: (value: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  const drag = React.useRef<{ x: number; value: number } | null>(null);
  const change = (v: number) => {
    if (!disabled)
      onValueChange(Math.max(min, Math.min(max, Number(v.toFixed(6)))));
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLInputElement>) => {
      if (disabled || e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
      const r = e.currentTarget.getBoundingClientRect();
      const v =
        e.altKey || e.shiftKey
          ? value
          : min +
            Math.max(
              0,
              Math.min(1, (e.clientX - r.left - 8) / (r.width - 16)),
            ) *
              (max - min);
      change(v);
      drag.current = { x: e.clientX, value: v };
    },
    onPointerMove: (e: React.PointerEvent<HTMLInputElement>) => {
      if (!drag.current) return;
      const next =
        drag.current.value +
        ((e.clientX - drag.current.x) / (e.currentTarget.clientWidth - 16)) *
          (max - min) *
          (e.altKey ? 0.2 : e.shiftKey ? 5 : 1);
      drag.current = {
        x: e.clientX,
        value: Math.max(min, Math.min(max, next)),
      };
      change(next);
    },
    onPointerUp: (e: React.PointerEvent<HTMLInputElement>) => {
      if (!drag.current) return;
      drag.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    onPointerCancel: () => {
      drag.current = null;
    },
    onLostPointerCapture: () => {
      drag.current = null;
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (
        ![
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
        ].includes(e.key)
      )
        return;
      e.preventDefault();
      change(
        e.key === "Home"
          ? min
          : e.key === "End"
            ? max
            : value +
              (["ArrowUp", "ArrowRight"].includes(e.key) ? 1 : -1) *
                step *
                (e.altKey ? 0.2 : e.shiftKey ? 5 : 1),
      );
    },
  };
}
