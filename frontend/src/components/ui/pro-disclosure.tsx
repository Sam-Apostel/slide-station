"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function ProDisclosureGroup({
  title,
  right,
  summary,
  defaultExpanded = true,
  expanded: controlled,
  onExpandedChange,
  showsBottomSeparator = true,
  children,
  className,
}: {
  title: React.ReactNode;
  right?: React.ReactNode;
  summary?: React.ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  showsBottomSeparator?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [internal, setInternal] = React.useState(defaultExpanded);
  const expanded = controlled ?? internal;
  const id = React.useId();
  return (
    <section
      data-slot="pro-disclosure"
      className={cn(
        "pro-disclosure select-none border-0 bg-[var(--pro-disclosure-surface)] [--pro-disclosure-header-surface:#474747] [--pro-disclosure-separator:#242424] [--pro-disclosure-surface:#4f4f4f]",
        className,
      )}
      data-expanded={expanded}
      data-shows-bottom-separator={showsBottomSeparator ? undefined : "false"}
    >
      <div
        className={cn(
          "pro-disclosure-header relative z-[1] flex min-h-[34px] items-center border-x-0 border-t border-[var(--pro-disclosure-separator)] bg-[var(--pro-disclosure-header-surface)] shadow-none",
          expanded ? "border-b" : "border-b-0",
        )}
      >
        <button
          type="button"
          data-slot="pro-disclosure-trigger"
          className="flex h-[34px] min-w-0 flex-1 cursor-default items-center gap-[7px] border-0 bg-transparent px-[10px] py-0 text-left text-[11px] font-medium text-white/85 outline-none [&>span:first-of-type]:overflow-hidden [&>span:first-of-type]:text-ellipsis [&>span:first-of-type]:whitespace-nowrap"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            setInternal(!expanded);
            onExpandedChange?.(!expanded);
          }}
        >
          <ChevronDown
            size={10}
            strokeWidth={1.5}
            className={cn(
              "shrink-0 transition-transform duration-[75ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
              !expanded && "-rotate-90",
            )}
          />
          <span>{title}</span>
          {!expanded && summary && (
            <span
              className="pro-disclosure-summary ml-auto text-[10px] font-medium text-white/40"
              aria-hidden="true"
            >
              {summary}
            </span>
          )}
        </button>
        {right && (
          <div className="pro-disclosure-actions flex h-[34px] shrink-0 items-center gap-1 pr-[10px] [&_button]:inline-flex [&_button]:size-[22px] [&_button]:cursor-default [&_button]:items-center [&_button]:justify-center [&_button]:rounded-[3px] [&_button]:border-0 [&_button]:bg-transparent [&_button]:p-0 [&_button]:text-white/50 [&_button]:shadow-none [&_button]:transition-none [&_button]:before:hidden [&_button]:hover:bg-white/[0.06] [&_button]:hover:text-white/85 [&_svg]:size-3">
            {right}
          </div>
        )}
      </div>
      <div
        id={id}
        hidden={!expanded}
        className="pro-disclosure-body p-0 [&>.pro-inspector-list-item]:min-h-[29px]"
      >
        {children}
      </div>
    </section>
  );
}
