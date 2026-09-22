import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-[4px] border-[0.5px] border-[#353535] bg-[linear-gradient(#535353,#4d4d4d)] px-[5px] font-sans text-[11px] leading-none font-normal text-[#d0d0d0] shadow-[inset_0_0.5px_#ffffff18,inset_0_-0.5px_#0001,0_0.5px_0_#303030,0_1px_1px_#0002] select-none",
        "[[data-slot=button]_&]:h-auto [[data-slot=button]_&]:min-w-0 [[data-slot=button]_&]:rounded-none [[data-slot=button]_&]:border-0 [[data-slot=button]_&]:bg-transparent [[data-slot=button]_&]:bg-none [[data-slot=button]_&]:p-0 [[data-slot=button]_&]:text-inherit [[data-slot=button]_&]:shadow-none",
        "[&_svg:not([class*='size-'])]:size-3",
        "[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-foreground dark:[[data-slot=tooltip-content]_&]:bg-background/10",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
