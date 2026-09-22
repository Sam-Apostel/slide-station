"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const inspectorHeadingStyles =
  "pro-inspector-section-heading flex w-full items-center gap-[5px] disabled:cursor-not-allowed border-x-0 border-t-[0.5px] border-b-[0.5px] border-black/30 bg-white/[0.015] py-[5px] text-[10px] font-medium tracking-[0.08em] text-[#aaa] uppercase";

/**
 * ProInspector — right-rail metadata panel (Catalyst Browse).
 * Flat regions + hairline dividers; sections carry centered uppercase
 * headers; rows are tabular-nums.
 */
export function ProInspector({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <aside
      data-slot="pro-inspector"
      className={cn(
        "pro-inspector flex w-[280px] shrink-0 select-none flex-col bg-[#383838] text-[12px]",
        className,
      )}
      {...props}
    />
  );
}

export function ProInspectorTabs({
  tabs,
  value,
  onValueChange,
}: {
  tabs: string[];
  value: string;
  onValueChange: (t: string) => void;
}) {
  return (
    <div
      data-slot="pro-inspector-tabs"
      className="pro-inspector-tabs flex select-none gap-1 border-b-0 bg-[#282828] p-1.5"
    >
      {tabs.map((t) => (
        <button
          type="button"
          aria-pressed={value === t}
          key={t}
          onClick={() => onValueChange(t)}
          className={cn(
            "flex-1 cursor-default rounded-full px-2 py-1 text-[11px] font-medium outline-none",
            value === t
              ? "bg-black/40 text-white shadow-[inset_0_1px_2px_rgb(0_0_0/28%),inset_0_0_0_0.5px_rgb(0_0_0/25%),0_0.5px_rgb(255_255_255/8%)]"
              : "text-[#a6a6a6] hover:bg-white/[0.05] hover:text-white/92",
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

export function ProInspectorSection({
  title,
  children,
  collapsible = false,
  headerAlign = "center",
  defaultExpanded = true,
  expanded: controlled,
  onExpandedChange,
}: {
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  headerAlign?: "left" | "center";
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [internal, setInternal] = React.useState(defaultExpanded);
  const expanded = controlled ?? internal;
  const id = React.useId();
  return (
    <section
      data-slot="pro-inspector-section"
      className="pro-inspector-section select-none [&:first-of-type_.pro-inspector-section-heading]:border-t-0"
      data-header-align={headerAlign}
    >
      {collapsible ? (
        <h4>
          <button
            type="button"
            className={cn(
              inspectorHeadingStyles,
              "cursor-default transition-colors duration-[75ms] ease-[cubic-bezier(.2,.8,.2,1)] hover:bg-white/[0.03] active:bg-black/[0.08] motion-reduce:transition-none",
              headerAlign === "left"
                ? "justify-between px-3 text-left"
                : "justify-center px-[10px]",
            )}
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => {
              setInternal(!expanded);
              onExpandedChange?.(!expanded);
            }}
          >
            {title}
            <ChevronRight
              aria-hidden
              size={10}
              strokeWidth={1.5}
              className={cn(
                "shrink-0 transition-transform duration-[75ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </button>
        </h4>
      ) : (
        <h4
          className={cn(
            inspectorHeadingStyles,
            headerAlign === "left"
              ? "justify-between px-3 text-left"
              : "justify-center px-[10px]",
          )}
        >
          {title}
        </h4>
      )}
      <dl id={id} hidden={collapsible && !expanded}>
        {children}
      </dl>
    </section>
  );
}

export function ProInspectorRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div
      data-slot="pro-inspector-row"
      className="flex select-none items-baseline justify-between gap-3 border-b border-white/[0.05] px-3 py-[6px]"
    >
      <dt className="shrink-0 text-[#747679]">{label}</dt>
      <dd className="pro-tabular text-right text-[#e2e2e1] tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/**
 * ProInspectorListItem
 * Right-aligned label at 50% opacity, control on the right; 12px both.
 * `alignTop` mirrors the alignment init; `striped` reproduces the
 * ExampleApp zebra (alternate rows black 10%).
 */
export function ProInspectorListItem({
  label,
  children,
  alignTop,
  striped,
  className,
}: {
  label: string;
  children: React.ReactNode;
  alignTop?: boolean;
  striped?: boolean;
  className?: string;
}) {
  return (
    <div
      data-slot="pro-inspector-list-item"
      className={cn(
        "pro-inspector-list-item flex w-full select-none px-3 py-[4px]",
        alignTop ? "items-start" : "items-center",
        striped && "bg-black/10",
        className,
      )}
    >
      <div className="flex w-1/2 justify-end pr-2">
        <span className="text-[12px] text-white/50">{label}</span>
      </div>
      <div className="flex min-w-0 w-1/2 items-center text-[12px] text-white">
        {children}
      </div>
    </div>
  );
}
