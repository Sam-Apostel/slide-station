import type * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";

/** ProUI tooltip for a control, with its keyboard shortcut if it has one. Replaces `title=`. */
export function Tip({
  label,
  keys,
  side = "bottom",
  children,
}: {
  label: React.ReactNode;
  keys?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="flex items-center gap-1.5">
        {label}
        {keys && <Kbd className="h-4 min-w-4 text-[10px]">{keys}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
