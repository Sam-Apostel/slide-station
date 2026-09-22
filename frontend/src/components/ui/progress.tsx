"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Progress as ProgressPrimitive } from "radix-ui";

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-1 w-full overflow-visible rounded-[4px] bg-[#252525] shadow-[inset_0_1px_1px_#0004]",
        className,
      )}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-(--pro-progress-width) flex-1 rounded-[inherit] bg-primary shadow-[0_1px_3px_#0003,inset_0_0.5px_#ffffff30] transition-[width] duration-100 ease-[cubic-bezier(.16,1,.3,1)]"
        style={
          {
            "--pro-progress-width": `${Math.min(100, Math.max(0, ((value ?? 0) / (props.max ?? 100)) * 100))}%`,
          } as React.CSSProperties
        }
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
