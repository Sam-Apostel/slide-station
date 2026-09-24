import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";

function NativeSelect({
  className,
  wrapperClassName,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default"; wrapperClassName?: string }) {
  return (
    <div
      className={cn("group/native-select relative w-fit has-[select:disabled]:opacity-50", wrapperClassName)}
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
