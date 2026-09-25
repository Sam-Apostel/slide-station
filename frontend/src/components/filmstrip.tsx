import * as React from "react";
import { Lock } from "lucide-react";
import { ProScope, ProScopebar } from "@/components/ui/pro-toolbar";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  needsReview,
  plural,
  previewUrl,
  standalone,
  trayLabel,
  useImageSrc,
  type Group,
  type GroupStatus,
  type Scene,
  type SessionPayload,
} from "@/lib/api";
import { Tip } from "@/components/tip";
import { cn } from "@/lib/utils";

export type Filter = "all" | "todo" | "multi";

/** A slide thumbnail (filmstrip, review grid). The browser version renders only the ones scrolled into view. */
export function PreviewImg({ url, ...props }: { url: string } & Omit<React.ComponentProps<"img">, "src">) {
  const [el, setEl] = React.useState<HTMLElement | null>(null);
  const [seen, setSeen] = React.useState(!standalone);
  React.useEffect(() => {
    if (seen || !el) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setSeen(true), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);
  const src = useImageSrc(seen ? url : null, 0);
  return src ? <img loading="lazy" src={src} {...props} /> : <span ref={setEl} className={props.className} />;
}

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
  changed: "bg-primary", // developed again, waiting to go up
  skipped: "bg-transparent border-[#666]",
};

/** Status pill tone, as in the original UI. */
export const STATUS_TEXT: Record<GroupStatus, string> = {
  new: "text-muted-foreground",
  reviewed: "text-primary border-primary/40",
  uploaded: "text-(--ss-ok) border-(--ss-ok)/40",
  changed: "text-primary border-primary/40",
  skipped: "text-(--ss-dim)",
};

/** The mount's finish: developed slides are gilded, and stay gold when edited after upload until
 *  that version goes up; slides Immich has as they are turn green. */
const FINISH: Partial<Record<GroupStatus, "gold" | "green">> = { reviewed: "gold", changed: "gold", uploaded: "green" };

const matches = (g: Group, f: Filter) => (f === "todo" ? needsReview(g) : f === "multi" ? g.scans.length > 1 : true);

/** A slide's tags plus the ones suggested for it and not dismissed: what the tag filter looks at. */
const tagsOf = (g: Group) => {
  const t = new Set(g.tags ?? []);
  for (const e of g.insights?.tags ?? []) if (e.state === "suggested") t.add(e.value);
  return t;
};

/** Every tag in the tray (own or suggested) with how many slides have it, most common first. */
export function trayTags(groups: Group[]): [string, number][] {
  const n = new Map<string, number>();
  for (const g of groups) for (const t of tagsOf(g)) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function Filmstrip({
  session,
  sessionId,
  sel,
  filter,
  onFilter,
  tag,
  onTag,
  onSelect,
  slideMenu,
  onScene,
}: {
  session: SessionPayload;
  sessionId: string;
  sel: number;
  filter: Filter;
  onFilter: (f: Filter) => void;
  /** Only slides with this tag (their own or suggested); "" = any. */
  tag: string;
  onTag: (t: string) => void;
  onSelect: (i: number) => void;
  /** Wraps a tile in the slide's right-click menu. */
  slideMenu: (index: number, el: React.ReactElement) => React.ReactElement;
  /** "Apply to this scene…" on a scene's separator (scene number n, 1-based). */
  onScene: (scene: Scene, n: number) => void;
}) {
  const sm = session.summary;
  // scenes of the tray (look-alikes): a separator before the first shown slide of each
  const scenes = session.similar?.scenes ?? [];
  const sceneOf = (i: number) => scenes.findIndex((sc) => sc.start <= i && i <= sc.end);
  const tags = trayTags(session.groups);
  const tagOn = tags.some(([t]) => t === tag) ? tag : "";
  const groups = session.groups.filter((g) => matches(g, filter) && (!tagOn || tagsOf(g).has(tagOn)));
  const selRef = React.useRef<HTMLButtonElement>(null);

  // a slide that takes on a new finish (developed, uploaded) gets one sweep of light across it
  const seen = React.useRef(new Map<string, GroupStatus>());
  const [gilding, setGilding] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    const fresh = session.groups.filter((g) => {
      const was = seen.current.get(g.id);
      return was !== undefined && FINISH[g.status] !== undefined && FINISH[was] !== FINISH[g.status];
    });
    for (const g of session.groups) seen.current.set(g.id, g.status);
    if (fresh.length) setGilding((s) => new Set([...s, ...fresh.map((g) => g.id)]));
  }, [session.groups]);
  const gilded = (id: string) =>
    setGilding((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });

  React.useEffect(() => {
    const tile = selRef.current;
    tile?.scrollIntoView({ block: "nearest" });
    // Keys move the selection from anywhere, so a clicked tile keeping focus would stay ringed
    // after ← → / Space moved on: focus follows the selection while it's in the strip.
    if (tile && tile !== document.activeElement && document.activeElement?.closest(".ss-mount")) {
      tile.focus({ preventScroll: true });
    }
  }, [sel, filter, tagOn]);

  return (
    <aside className="flex size-full min-h-0 flex-col border-r border-border bg-[var(--pro-canvas)]">
      <div className="border-b border-border bg-(--ss-panel) px-3 pt-2.5 pb-2">
        <div className="truncate text-[13px] font-semibold text-foreground/90">{sm.name}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {/* a tray in a box: how full it is, and where it lives when its name says something else */}
          {session.box ? `${sm.slides} of ${session.box.size} slides` : plural(sm.slides, "slide")} ·{" "}
          {plural(sm.scans, "scan")}
          {session.box && sm.name !== trayLabel(sm.box, sm.side) ? ` · ${trayLabel(sm.box, sm.side)}` : ""}
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
      {tags.length > 0 && (
        <div className="border-b border-border bg-(--ss-panel) px-2.5 py-1.5">
          <NativeSelect size="sm" aria-label="Filter by tag" value={tagOn} onChange={(e) => onTag(e.target.value)}>
            <NativeSelectOption value="">Any tag</NativeSelectOption>
            {tags.map(([t, n]) => (
              <NativeSelectOption key={t} value={t}>
                {t} · {n}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3 overflow-y-auto p-3 scrollbar-thin">
        {groups.map((g, k) => {
          const isSel = g.index === sel;
          const scene = sceneOf(g.index);
          const newScene = scene >= 0 && (k === 0 || sceneOf(groups[k - 1].index) !== scene);
          const tile = slideMenu(
            g.index,
            <button
              key={g.id}
              ref={isSel ? selRef : undefined}
              type="button"
              onClick={() => onSelect(g.index)}
              aria-label={`Slide ${g.index + 1}, ${STATUS_LABEL[g.status]}`}
              aria-current={isSel || undefined}
              data-status={g.status}
              data-finish={FINISH[g.status]}
              data-gilding={gilding.has(g.id) || undefined}
              onAnimationEnd={(e) => e.animationName === "ss-gild" && gilded(g.id)}
              className="ss-mount"
            >
              {/* the mount's window, with the photo sunk into it */}
              <span className="ss-mount-window">
                <PreviewImg
                  url={previewUrl(sessionId, g, 320)}
                  alt=""
                  draggable={false}
                  onLoad={(e) => {
                    const i = e.currentTarget;
                    i.closest<HTMLElement>(".ss-mount")!.dataset.portrait = String(i.naturalHeight > i.naturalWidth);
                  }}
                  className={cn("size-full object-cover", g.skip && "opacity-25 grayscale")}
                />
              </span>
              {g.active.length > 1 && <HdrMark n={g.active.length} />}
              {/* along the bottom edge, or down the side when the slide is turned; always upright */}
              <span className="ss-mount-foot">
                {!FINISH[g.status] && (
                  // developed and uploaded slides are gilded or green instead
                  <span
                    title={STATUS_LABEL[g.status]}
                    className={cn("ss-mount-dot border-[1.5px] border-black/50", STATUS_DOT[g.status])}
                  />
                )}
                <span className="ss-mount-number">{String(g.index + 1).padStart(2, "0")}</span>
                {g.date_est?.value && (
                  // stamped on the mount like the lab did, dimmer when it's an estimate
                  <span className="ss-mount-year" data-estimated={g.date_est.source !== "own" || undefined}>
                    ’{g.date_est.value.slice(2, 4)}
                  </span>
                )}
              </span>
              <span className="absolute top-[5px] right-[5px] flex gap-[3px]">
                {g.locked && (
                  <TileBadge title="Locked: original scans deleted after upload">
                    <Lock className="size-2.5" aria-label="Locked" />
                  </TileBadge>
                )}
              </span>
            </button>,
          );
          if (!newScene) return tile;
          const sc = scenes[scene];
          return (
            <React.Fragment key={g.id}>
              <div className="ss-scene col-span-full" role="separator" aria-label={`Scene ${scene + 1}`}>
                <span className="min-w-0 flex-1 truncate">
                  Scene {scene + 1}
                  {sc.label && <b> · {sc.label}</b>}
                  <span className="text-(--ss-dim)">
                    {" "}
                    · {sc.start + 1}–{sc.end + 1}
                  </span>
                </span>
                <Tip label="Give every slide of this scene a tag, date or caption">
                  <button type="button" onClick={() => onScene(sc, scene + 1)}>
                    Apply to scene…
                  </button>
                </Tip>
              </div>
              {tile}
            </React.Fragment>
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
 * workflow. The current one is pulled up out of the tray. Click a slot to go to that slide. A tray
 * in a box shows its empty slots too: 50, or 36 in the shorter boxes.
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
      {Array.from({ length: Math.max(0, (session.box?.size ?? 0) - n) }, (_, i) => (
        <span key={`empty-${i}`} aria-hidden className="ss-tray-empty" />
      ))}
    </div>
  );
}

/** HDR, pressed into the top margin of the mount: one frame per merged exposure, fanned out.
 *  Unlike the printing below it, it turns with the slide. */
function HdrMark({ n }: { n: number }) {
  const k = Math.min(n, 4);
  const w = 11 + (k - 1) * 2.5;
  const h = 7 + (k - 1) * 2;
  return (
    <span className="ss-mount-hdr" title={`HDR: ${n} exposures merged`}>
      <svg
        viewBox={`-1 -1 ${w + 2} ${h + 2}`}
        width={w + 2}
        height={h + 2}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
        role="img"
        aria-label={`HDR ×${n}`}
      >
        {/* the exposures behind show only the edge the front one doesn't cover */}
        {Array.from({ length: k - 1 }, (_, i) => {
          const x = i * 2.5;
          const y = (k - 1 - i) * 2;
          return <path key={i} d={`M${x + 2.5} ${y}H${x}V${y + 7}H${x + 11}V${y + 5}`} />;
        })}
        <rect x={(k - 1) * 2.5} y={0} width={11} height={7} rx={1} fill="currentColor" />
      </svg>
    </span>
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
