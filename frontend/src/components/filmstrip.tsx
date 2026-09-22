import * as React from "react";
import { RotateCw } from "lucide-react";
import { ProScope, ProScopebar } from "@/components/ui/pro-toolbar";
import { needsReview, plural, previewUrl, type Group, type GroupStatus, type SessionPayload } from "@/lib/api";
import { cn } from "@/lib/utils";

export type Filter = "all" | "todo" | "multi";

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["todo", "To review"],
  ["multi", "HDR"],
];

export const STATUS_LABEL: Record<GroupStatus, string> = {
  new: "to review",
  reviewed: "reviewed",
  uploaded: "in Immich",
  changed: "edited since upload",
  skipped: "skipped",
};

export const STATUS_DOT: Record<GroupStatus, string> = {
  new: "bg-[#55555f]",
  reviewed: "bg-primary",
  uploaded: "bg-[var(--pro-green)]",
  changed: "bg-(--ss-warn)",
  skipped: "bg-transparent border-[#666]",
};

/** Status pill tone, as in the original UI. */
export const STATUS_TEXT: Record<GroupStatus, string> = {
  new: "text-muted-foreground",
  reviewed: "text-primary border-primary/40",
  uploaded: "text-(--ss-ok) border-(--ss-ok)/40",
  changed: "text-(--ss-warn) border-(--ss-warn)/40",
  skipped: "text-(--ss-dim)",
};

const matches = (g: Group, f: Filter) => (f === "todo" ? needsReview(g) : f === "multi" ? g.scans.length > 1 : true);

export function Filmstrip({
  session,
  sessionId,
  sel,
  filter,
  onFilter,
  onSelect,
}: {
  session: SessionPayload;
  sessionId: string;
  sel: number;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onSelect: (i: number) => void;
}) {
  const sm = session.summary;
  const groups = session.groups.filter((g) => matches(g, filter));
  const selRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel, filter]);

  return (
    <aside className="flex min-h-0 w-[250px] shrink-0 flex-col border-r border-border bg-[var(--pro-canvas)]">
      <div className="border-b border-border bg-(--ss-panel) px-3 pt-2.5 pb-2">
        <div className="truncate text-[13px] font-semibold text-foreground/90">{sm.name}</div>
        <div className="text-[11px] text-muted-foreground">
          {plural(sm.slides, "slide")} · {plural(sm.scans, "scan")}
        </div>
      </div>
      <ProScopebar role="toolbar" aria-label="Filter slides">
        {FILTERS.map(([f, label]) => (
          <ProScope key={f} active={filter === f} onClick={() => onFilter(f)}>
            {label}
          </ProScope>
        ))}
      </ProScopebar>
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto p-2 scrollbar-thin">
        {groups.map((g) => {
          const isSel = g.index === sel;
          const autoRot = g.rot_reason && g.rot_reason !== "manual" && g.rotation;
          return (
            <button
              key={g.id}
              ref={isSel ? selRef : undefined}
              type="button"
              onClick={() => onSelect(g.index)}
              aria-label={`Slide ${g.index + 1}, ${STATUS_LABEL[g.status]}`}
              aria-current={isSel || undefined}
              className={cn(
                "relative aspect-square cursor-default overflow-hidden rounded-[5px] bg-black outline-none",
                "shadow-[inset_0_0_0_0.5px_#0008]",
                isSel ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-white/20",
              )}
            >
              <img
                loading="lazy"
                src={previewUrl(sessionId, g, 320)}
                alt=""
                draggable={false}
                className={cn("absolute inset-0 size-full object-contain", g.skip && "opacity-25 grayscale")}
              />
              <span className="absolute top-[3px] left-1 text-[11px] text-white [text-shadow:0_1px_2px_#000]">
                {g.index + 1}
              </span>
              <span className="absolute top-[3px] right-[3px] flex gap-[3px]">
                {g.active.length > 1 && <TileBadge>HDR ×{g.active.length}</TileBadge>}
                {autoRot ? (
                  <TileBadge title={`Auto-rotated (${g.rot_reason})`} className="text-primary">
                    <RotateCw className="size-2.5" aria-label="Auto-rotated" />
                  </TileBadge>
                ) : null}
              </span>
              <span
                title={STATUS_LABEL[g.status]}
                className={cn(
                  "absolute bottom-1 left-1 size-[9px] rounded-full border-[1.5px] border-black/60",
                  STATUS_DOT[g.status],
                )}
              />
            </button>
          );
        })}
        {!groups.length && (
          <p className="col-span-2 py-6 text-center text-[11px] text-(--ss-dim)">
            {session.groups.length ? "No slides match this filter" : "No slides yet"}
          </p>
        )}
      </div>
    </aside>
  );
}

function TileBadge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("flex h-4 items-center rounded-[3px] bg-black/65 px-1 text-[10px] leading-4 text-white", className)}
      {...props}
    />
  );
}
