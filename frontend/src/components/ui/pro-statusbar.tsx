"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** 25px bottom status line */
export function ProStatusbar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="pro-statusbar"
      className={cn(
        "pro-statusbar flex h-[25px] select-none items-center gap-3.5 border-x-0 border-t border-b-0 border-[#454545] bg-[#303030] px-2.5 text-[11px] font-medium text-[#8c8e90]",
        className,
      )}
      {...props}
    />
  );
}
