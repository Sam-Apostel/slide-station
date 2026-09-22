"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * ProButton
 *
 * The recipe: flat relative fill (white 15%, tints against any surface),
 * a single top inner light and a subtle inset hairline. Selected colors are
 * shaded so the active segment reads as pressed into the surrounding surface.
 */
const proButtonVariants = cva(
  "pro-btn pro-no-drag relative inline-flex cursor-default select-none items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[5px] border-0 bg-white/15 font-[inherit] text-[12px] font-normal text-white shadow-[inset_0_0_0_var(--pro-edge-width,0.5px)_rgb(0_0_0/20%)] outline-none focus-visible:brightness-[1.15] disabled:cursor-not-allowed disabled:opacity-55 disabled:text-white/65 [&_svg]:size-[14px] [&_svg]:shrink-0",
  {
    variants: {
      size: {
        sm: "h-[22px] px-2",
        md: "h-[25px] px-3",
        lg: "h-[32px] px-[18px] text-[13px]",
      },
      active: { true: "", false: "" },
    },
    defaultVariants: { size: "sm", active: false },
  },
);

export interface ProButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof proButtonVariants> {
  /** Solid fill used when `active` — mirrors Swift `activeTint`. */
  activeTint?: string;
  backgroundTint?: string;
  plain?: boolean;
  fullWidth?: boolean;
  /** Swift inner highlight, composited through the fill opacity. */
  topHighlightOpacity?: number;
  /** Applies a subtle brightness change on pointer hover. */
  hoverEffect?: boolean;
}

export function ProButton({
  className,
  size,
  active,
  activeTint,
  backgroundTint,
  plain,
  fullWidth,
  topHighlightOpacity = 0.35,
  hoverEffect = false,
  style,
  onClick,
  onPointerDown,
  onPointerCancel,
  onPointerLeave,
  onKeyDown,
  onKeyUp,
  onBlur,
  ...props
}: ProButtonProps) {
  // Mouse-up clears :active before click commits the controlled toggle value.
  // Keep the pressed paint through click so both changes reach the same frame.
  const [pressed, setPressed] = React.useState(false);
  return (
    <button
      type="button"
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!event.defaultPrevented && event.button === 0) setPressed(true);
      }}
      onPointerCancel={(event) => {
        setPressed(false);
        onPointerCancel?.(event);
      }}
      onPointerLeave={(event) => {
        setPressed(false);
        onPointerLeave?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          (event.key === " " || event.key === "Enter")
        )
          setPressed(true);
      }}
      onKeyUp={(event) => {
        onKeyUp?.(event);
        if (event.defaultPrevented) setPressed(false);
      }}
      onBlur={(event) => {
        setPressed(false);
        onBlur?.(event);
      }}
      onClick={(event) => {
        try {
          onClick?.(event);
        } finally {
          setPressed(false);
        }
      }}
      aria-pressed={active == null ? undefined : active}
      className={cn(
        proButtonVariants({ size, active }),
        plain && "pro-plain border-[0.6px] border-black/20",
        fullWidth && "w-full",
        hoverEffect && "enabled:hover:brightness-[1.025]",
        active &&
          "bg-[color-mix(in_srgb,var(--pro-button-active-tint,var(--pro-accent))_80%,var(--color-black))]",
        !active && backgroundTint && "bg-(--pro-button-background-tint)",
        active
          ? "shadow-[inset_0_0_0_var(--pro-edge-width,0.5px)_rgb(0_0_0/20%),inset_0_1px_rgb(255_255_255/6%)] enabled:active:shadow-[inset_0_0_0_100px_rgb(0_0_0/3%),inset_0_0_0_var(--pro-edge-width,0.5px)_rgb(0_0_0/20%),inset_0_1px_rgb(255_255_255/5%)] enabled:data-pressed:shadow-[inset_0_0_0_100px_rgb(0_0_0/3%),inset_0_0_0_var(--pro-edge-width,0.5px)_rgb(0_0_0/20%),inset_0_1px_rgb(255_255_255/5%)]"
          : "enabled:active:shadow-[inset_0_0_0_100px_rgb(255_255_255/8%),inset_0_0_0_var(--pro-edge-width,0.5px)_rgb(0_0_0/20%)] enabled:data-pressed:shadow-[inset_0_0_0_100px_rgb(255_255_255/8%),inset_0_0_0_var(--pro-edge-width,0.5px)_rgb(0_0_0/20%)]",
        className,
      )}
      style={
        {
          "--pro-fill-opacity": active || backgroundTint ? 1 : 0.15,
          "--pro-highlight-stop": active || backgroundTint ? "0.5px" : "1px",
          "--pro-highlight-end": active || backgroundTint ? "2px" : "3px",
          "--pro-top-highlight-opacity": active
            ? Math.min(topHighlightOpacity, 0.1)
            : topHighlightOpacity,
          "--pro-button-active-tint": activeTint,
          "--pro-button-background-tint": backgroundTint,
          ...style,
        } as React.CSSProperties
      }
      data-active={active || undefined}
      data-pressed={pressed || undefined}
      {...props}
    />
  );
}

/**
 * ProButtonGroup — zero-spacing plain segments with one hairline per join.
 * Children retain their individual fills and top lights; the group supplies
 * the rounded silhouette and a single inset outer stroke.
 */
export function ProButtonGroup({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="pro-button-group"
      className={cn(
        "pro-button-group pro-no-drag relative isolate inline-flex select-none items-stretch overflow-hidden rounded-[5px] border-0 shadow-[0_1px_1px_rgb(0_0_0/6%)] [&>.pro-btn]:rounded-none [&>.pro-btn]:border-0 [&>.pro-btn]:[--pro-edge-width:0px] [&>.pro-btn[data-active]]:text-white",
        className,
      )}
      {...props}
    />
  );
}

export { proButtonVariants };
