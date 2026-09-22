"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Thin vertical hairline divider used across toolbar / scopebar. */
export function ProSeparator({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-[22px] w-px shrink-0 bg-[#242527] shadow-[1px_0_rgba(255,255,255,0.08)]",
        className,
      )}
    />
  );
}

/**
 * ProToolbar — 43px gradient action row (Catalyst Browse).
 * Compose with ProButton / ProButtonGroup / ProSeparator.
 */
export function ProToolbar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="pro-scopebar"
      className={cn(
        "pro-toolbar flex h-[43px] select-none items-center gap-1.5 border-x-0 border-t-0 border-b border-[#242424] bg-[linear-gradient(#494949,#414141)] px-2.5 shadow-[inset_0_1px_rgb(255_255_255/8%)]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * ProScopebar — 36px filter/context row under the toolbar.
 */
export function ProScopebar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="pro-scopebar"
      className={cn(
        "pro-scopebar flex h-9 select-none items-center gap-[3px] border-x-0 border-t-0 border-b border-[#202020] bg-[#383838] px-2.5",
        className,
      )}
      {...props}
    />
  );
}

export function ProScope({
  active,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      data-slot="pro-scope"
      aria-pressed={active}
      data-active={active || undefined}
      className={cn(
        "pro-scope pro-no-drag inline-flex h-[21px] shrink-0 cursor-default select-none items-center justify-center gap-[5px] whitespace-nowrap rounded-[4px] border-0 bg-transparent px-[9px] font-[inherit] text-[11px] leading-none font-medium text-white/52 outline-none transition-none focus-visible:brightness-[1.15] disabled:cursor-not-allowed disabled:opacity-40 data-active:bg-black/30 data-active:text-white/95 data-active:shadow-[inset_0_1px_2px_rgb(0_0_0/28%),inset_0_0_0_0.5px_rgb(0_0_0/24%),0_0.5px_rgb(255_255_255/8%)] [&:active:not(:disabled)]:bg-black/38 [&:hover:not(:disabled):not([data-active])]:bg-white/[0.04] [&:hover:not(:disabled):not([data-active])]:text-white/82 [&_svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}
