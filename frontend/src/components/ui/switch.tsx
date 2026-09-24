"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full border-0 bg-[#262626] p-[2px] shadow-[inset_0_0_0_1px_#5a5a5a] outline-none transition-[background-color,box-shadow] duration-100 ease-[var(--pro-motion-ease)] focus-visible:brightness-[1.16] disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:bg-[var(--pro-accent)] data-[state=checked]:shadow-[inset_0_0.5px_#ffffff26] motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[14px] rounded-full bg-[#e6e6e6] shadow-[0_1px_2px_#0006] transition-transform duration-100 ease-[var(--pro-motion-ease)] data-[state=checked]:translate-x-[12px] data-[state=checked]:bg-white motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
