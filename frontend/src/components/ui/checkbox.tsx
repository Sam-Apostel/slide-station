/**
 * Adapted from shadcn/ui (https://github.com/shadcn-ui/ui).
 * MIT License
 * 
 * Copyright (c) 2023 shadcn
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { CheckIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer inline-grid size-4 shrink-0 place-items-center rounded-[4px] border-0 bg-[#292929] align-middle text-white shadow-[inset_0_0_0_1.4px_#646464] outline-none transition-none *:animate-none *:transition-none focus-visible:brightness-[1.16] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:shadow-[inset_0_0_0_1px_#a96560] data-[state=checked]:bg-[var(--pro-accent)] data-[state=checked]:shadow-[inset_0_0.5px_#ffffff26,0_4px_9px_#00000024] data-[state=indeterminate]:bg-[var(--pro-accent)] data-[state=indeterminate]:shadow-[inset_0_0.5px_#ffffff26,0_4px_9px_#00000024]",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid size-4 place-content-center text-current transition-none after:data-[state=indeterminate]:h-[1.5px] after:data-[state=indeterminate]:w-[7px] after:data-[state=indeterminate]:rounded-full after:data-[state=indeterminate]:bg-current after:data-[state=indeterminate]:content-[''] data-[state=indeterminate]:[&_svg]:hidden [&_svg]:size-3 [&_svg]:translate-[0.5px_0.5px] [&_svg]:stroke-[1.8] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
