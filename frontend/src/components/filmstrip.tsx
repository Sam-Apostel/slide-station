import * as React from "react";
import { Lock, RotateCw } from "lucide-react";
import { ProScope, ProScopebar } from "@/components/ui/pro-toolbar";
import { needsReview, plural, previewUrl, type Group, type GroupStatus, type SessionPayload } from "@/lib/api";
import { cn } from "@/lib/utils";

export type Filter = "all" | "todo" | "multi";

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["todo", "To develop"],
  ["multi", "HDR"],
];

export const STATUS_LABEL: Record<GroupStatus, string> = {
  new: "to develop",
  reviewed: "developed",
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
  slideMenu,
}: {
  session: SessionPayload;
  sessionId: string;
  sel: number;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onSelect: (i: number) => void;
  /** Wraps a tile in the slide's right-click menu. */
  slideMenu: (index: number, el: React.ReactElement) => React.ReactElement;
}) {
  const sm = session.summary;
  const groups = session.groups.filter((g) => matches(g, filter));
  const selRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel, filter]);

  return (
    <aside className="flex size-full min-h-0 flex-col border-r border-border bg-[var(--pro-canvas)]">
      <div className="border-b border-border bg-(--ss-panel) px-3 pt-2.5 pb-2">
        <div className="truncate text-[13px] font-semibold text-foreground/90">{sm.name}</div>
        <div className="text-[11px] text-muted-foreground">
          {plural(sm.slides, "slide")} · {plural(sm.scans, "scan")}
        </div>
        <TrayGauge session={session} sel={sel} onSelect={onSelect} />
      </div>
      <ProScopebar role="toolbar" aria-label="Filter slides">
        {FILTERS.map(([f, label]) => (
          <ProScope key={f} active={filter === f} onClick={() => onFilter(f)}>
            {label}
          </ProScope>
        ))}
      </ProScopebar>
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3 overflow-y-auto p-3 scrollbar-thin">
        {groups.map((g) => {
          const isSel = g.index === sel;
          const autoRot = g.rot_reason && g.rot_reason !== "manual" && g.rotation;
          return slideMenu(
            g.index,
            <button
              key={g.id}
              ref={isSel ? selRef : undefined}
              type="button"
              onClick={() => onSelect(g.index)}
              aria-label={`Slide ${g.index + 1}, ${STATUS_LABEL[g.status]}`}
              aria-current={isSel || undefined}
              data-status={g.status}
              className="ss-mount"
            >
              {/* the mount's window, with the photo sunk into it */}
              <span className="ss-mount-window">
                <img
                  loading="lazy"
                  src={previewUrl(sessionId, g, 320)}
                  alt=""
                  draggable={false}
                  onLoad={(e) => {
                    const i = e.currentTarget;
                    i.parentElement!.dataset.portrait = String(i.naturalHeight > i.naturalWidth);
                  }}
                  className={cn("size-full object-cover", g.skip && "opacity-25 grayscale")}
                />
              </span>
              <span className="ss-mount-number">{String(g.index + 1).padStart(2, "0")}</span>
              {g.date_est?.value && (
                // stamped on the mount like the lab did, dimmer when it's an estimate
                <span className="ss-mount-year" data-estimated={g.date_est.source !== "own" || undefined}>
                  ’{g.date_est.value.slice(2, 4)}
                </span>
              )}
              <span className="absolute top-[5px] right-[5px] flex gap-[3px]">
                {g.locked && (
                  <TileBadge title="Locked: original scans deleted after upload">
                    <Lock className="size-2.5" aria-label="Locked" />
                  </TileBadge>
                )}
                {g.active.length > 1 && <TileBadge>HDR ×{g.active.length}</TileBadge>}
                {autoRot ? (
                  <TileBadge title={`Auto-rotated (${g.rot_reason})`} className="text-primary">
                    <RotateCw className="size-2.5" aria-label="Auto-rotated" />
                  </TileBadge>
                ) : null}
              </span>
              <span
                title={STATUS_LABEL[g.status]}
                className={cn("ss-mount-dot border-[1.5px] border-black/50", STATUS_DOT[g.status])}
              />
            </button>,
          );
        })}
        {!groups.length && (
          <p className="col-span-full py-6 text-center text-[11px] text-(--ss-dim)">
            {session.groups.length ? "No slides match this filter" : "No slides yet"}
          </p>
        )}
      </div>
    </aside>
  );
}

/**
 * The tray seen from above: every slide stands on edge in its slot, coloured by where it is in the
 * workflow. The current one is pulled up out of the tray. Click a slot to go to that slide.
 */
function TrayGauge({ session, sel, onSelect }: { session: SessionPayload; sel: number; onSelect: (i: number) => void }) {
  const n = session.groups.length;
  if (!n) return null;
  return (
    <div className="ss-tray" role="group" aria-label="Tray overview">
      {session.groups.map((g) => (
        <button
          key={g.id}
          type="button"
          tabIndex={-1}
          aria-label={`Slide ${g.index + 1}, ${STATUS_LABEL[g.status]}`}
          data-status={g.status}
          data-current={g.index === sel || undefined}
          className="ss-tray-slide"
          onClick={() => onSelect(g.index)}
        />
      ))}
    </div>
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
