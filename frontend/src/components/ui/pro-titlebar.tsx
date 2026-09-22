"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export function ProTitlebarWell({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="pro-titlebar-well"
      className={cn(
        "pro-titlebar-well flex h-10 min-w-0 select-none flex-col items-center justify-center overflow-hidden rounded-[7px] bg-[linear-gradient(#252525,#2b2b2b)] px-[18px] py-1 shadow-[inset_0_1px_2px_#0004,inset_0_0_0_0.5px_#0006,0_0.5px_#ffffff18]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * ProTitlebar — native macOS-style titlebar for Electron.
 * Compact 34px or large 68px bar with a centered content slot.
 * The container is draggable in Electron; controls get `pro-no-drag`.
 */
export function ProTitlebar({
  title,
  trafficLights = true,
  left,
  right,
  className,
  size = "compact",
  center,
  centerMaxWidth = 260,
}: {
  title: React.ReactNode;
  trafficLights?: boolean;
  left?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
  size?: "compact" | "large";
  centerMaxWidth?: number;
  /** Replaces the centered title with an interactive well or custom content. */
  center?: React.ReactNode;
}) {
  return (
    <div
      data-size={size}
      style={
        size === "large"
          ? ({
              "--pro-titlebar-center-width": `${centerMaxWidth}px`,
            } as React.CSSProperties)
          : undefined
      }
      data-slot="pro-titlebar"
      className={cn(
        "pro-titlebar pro-drag relative select-none border-x-0 border-t-0 border-b border-[#222] bg-[linear-gradient(#4a4a4a,#3e3e3e)]",
        size === "large"
          ? "grid h-[68px] min-h-[68px] grid-cols-[minmax(72px,1fr)_minmax(140px,var(--pro-titlebar-center-width))_minmax(72px,1fr)] items-center gap-3 overflow-hidden px-[14px] py-2 shadow-[inset_0_0.5px_#ffffff18] [&_.pro-abar-btn]:size-7 [&_.pro-abar-btn]:rounded-md [&_.pro-abar-btn_svg]:size-[15px] [&_.pro-action-button-group>.pro-abar-btn]:rounded-none [&_.pro-well]:w-full"
          : "flex h-[34px] items-center px-3",
        className,
      )}
    >
      <div className="pro-titlebar-left pro-no-drag flex items-center gap-2">
        {/* Render real traffic lights in Electron via CSS or leave slot for custom controls */}
        {left ??
          (trafficLights && (
            <span
              className="pro-titlebar-traffic-lights flex gap-[7px]"
              aria-hidden
            >
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="size-[11px] rounded-full bg-[#696a6c] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25)]"
                />
              ))}
            </span>
          ))}
      </div>
      <div
        className={cn(
          "pro-titlebar-center min-w-0 text-center text-[11px] font-medium text-[#e2e2e1] [text-shadow:0_1px_#0004]",
          size === "large"
            ? "static translate-x-0"
            : "absolute left-1/2 -translate-x-1/2",
          center != null ? "pro-no-drag" : "pointer-events-none",
        )}
        aria-label={
          center != null && typeof title === "string" ? title : undefined
        }
      >
        {center ?? title}
      </div>
      <div
        className={cn(
          "pro-titlebar-right pro-no-drag flex items-center gap-2",
          size === "large" ? "justify-self-end" : "ml-auto",
        )}
      >
        {right}
      </div>
    </div>
  );
}
