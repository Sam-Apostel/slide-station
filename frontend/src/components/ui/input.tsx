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

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "pro-ui-input h-[25px] min-h-[25px] w-full min-w-0 cursor-text rounded-[4px] border-0 bg-[#2a2a2a] px-2 py-[3px] text-[13px] text-foreground shadow-[inset_0_1px_2px_#0003,inset_0_0_0_0.5px_#181818,0_0.5px_#ffffff12] outline-none transition-none [appearance:textfield] selection:bg-[var(--pro-text-selection)] selection:text-white focus:bg-[#2f2f2f] file:mr-2 file:box-border file:inline-block file:h-[22px] file:cursor-default file:rounded-[3px] file:border-[0.5px] file:border-[#343434] file:bg-[linear-gradient(#626262,#525252)] file:px-2 file:py-0 file:align-top file:text-[12px] file:leading-[21px] file:font-medium file:text-[#eee] file:shadow-[inset_0_0.5px_#ffffff26,inset_0_-0.5px_#00000028,0_0.5px_0_#00000030] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:text-destructive aria-invalid:shadow-[inset_0_0_0_1px_#a96560] md:text-[12px] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none",
        type === "file" && "h-7 min-h-7 p-[3px] leading-[22px]",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
