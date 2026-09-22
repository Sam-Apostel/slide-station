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
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

const buttonVariants = cva(
  "pro-ui-button relative inline-flex shrink-0 cursor-default select-none items-center justify-center gap-2 overflow-hidden rounded-[5px] border-0 bg-[var(--standard-button-default-fill,#ffffff26)] font-[inherit] text-[12px] font-normal whitespace-nowrap text-foreground shadow-[inset_0_0_0_0.5px_#0003] outline-none transition-none before:pointer-events-none before:absolute before:inset-[0.5px] before:rounded-[inherit] before:bg-[linear-gradient(to_bottom,#ffffff09,#ffffff03_1px,transparent_3px)] before:content-[''] focus-visible:not-disabled:bg-[linear-gradient(#ffffff08,#ffffff08)] focus-visible:not-disabled:brightness-[1.03] active:not-disabled:shadow-[inset_0_0_0_100px_#ffffff15] aria-pressed:bg-[var(--pro-selection)] aria-pressed:text-white aria-pressed:shadow-[inset_0_0.5px_#ffffff28,inset_0_-1px_#0003] aria-invalid:shadow-[inset_0_0_0_1px_#a96560] disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--standard-button-default-fill,#ffffff26)] text-foreground ",
        destructive:
          "bg-[#a94440] text-white before:bg-[linear-gradient(#ffffff26,#ffffff10_0.5px,transparent_2px)]",
        outline:
          "bg-[var(--standard-button-outline-fill,#ffffff12)] text-foreground ",
        secondary:
          "bg-[var(--standard-button-secondary-fill,#606060)] text-white ",
        ghost:
          "bg-transparent shadow-none before:content-none",
        link: "bg-transparent text-[#69b5ff] shadow-none before:content-none underline-offset-4",
      },
      size: {
        default: "h-[25px] px-4 py-0 has-[>svg]:px-3",
        xs: "h-[20px] gap-1 rounded-md px-2 text-[11px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3 font-medium",
        sm: "h-[22px] gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-[32px] rounded-md px-6 has-[>svg]:px-4",
        icon: "size-[25px]",
        "icon-xs":
          "size-[20px] rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-[22px]",
        "icon-lg": "size-[32px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  hoverEffect = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    hoverEffect?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        buttonVariants({ variant, size }),
        hoverEffect &&
          "hover:not-disabled:bg-[linear-gradient(#ffffff08,#ffffff08)] hover:not-disabled:brightness-[1.03]",
        className,
      )}
      {...props}
    />
  );
}

export { Button, buttonVariants };
