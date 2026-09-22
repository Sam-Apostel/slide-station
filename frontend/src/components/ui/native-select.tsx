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
import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";

function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <div
      className="group/native-select relative w-fit has-[select:disabled]:opacity-50"
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          "relative h-[25px] w-full min-w-0 appearance-none overflow-hidden rounded-[5px] border-0 bg-[#505050] px-3 pr-8 py-0 font-[inherit] text-[12px] leading-[25px] font-normal text-foreground shadow-[inset_0_0.5px_#ffffff15,inset_0_0_0_0.5px_#0005] outline-none transition-none selection:bg-[var(--pro-text-selection)] selection:text-white placeholder:text-muted-foreground hover:brightness-[1.025] active:shadow-[inset_0_0_0_100px_#ffffff15,inset_0_0.5px_#ffffff15,inset_0_0_0_0.5px_#0005] disabled:cursor-not-allowed aria-invalid:shadow-[inset_0_0_0_1px_#a96560] data-[size=sm]:h-[22px] data-[size=sm]:py-0 data-[size=sm]:leading-[22px] data-[size=sm]:pr-7",
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2.5 size-[11px] -translate-y-1/2 stroke-[2.5] text-muted-foreground opacity-50 group-has-[[data-size=sm]]/native-select:right-2 group-has-[[data-size=sm]]/native-select:size-[10px] select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
