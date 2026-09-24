import * as React from "react";
import { toast } from "sonner";
import {
  Aperture,
  ArrowRight,
  Bookmark,
  CalendarRange,
  Images,
  CheckCheck,
  CloudDownload,
  Copy,
  Crop,
  Eraser,
  Frame,
  Layers,
  Sparkles,
  FolderOpen,
  HardDriveDownload,
  Lock,
  Merge,
  RotateCcw,
  RotateCw,
  Ruler,
  SkipForward,
  Undo2,
  Upload,
  Download,
} from "lucide-react";
import { ProInspector } from "@/components/ui/pro-inspector";
import { ProDisclosureGroup } from "@/components/ui/pro-disclosure";
import { ProButton, ProButtonGroup } from "@/components/ui/pro-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/tip";
import { ToneCurve } from "@/components/tone-curve";
import { AdjustPanel, adjustSummary } from "@/components/adjust";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { InsightsPanel, StockField, SuggestionRow, TagsField, insightsNote } from "@/components/insights";
import {
  MOUNT_SUGGEST,
  needsReview,
  plural,
  standalone,
  STOCK_NAMES,
  STOCKS,
  type EraHint,
  type Group,
  type InsightKind,
  type SessionPayload,
} from "@/lib/api";
import { CHANNELS, isStraight } from "@/lib/curves";
import type { SlideStation } from "@/hooks/use-slide-station";

function rotationNote(rotation: number, reason: string) {
  if (!rotation) return "";
  if (reason === "faces") return "auto · faces";
  if (reason === "sky") return "auto · sky";
  return `${rotation}°`;
}

type SectionId = "rotation" | "curve" | "colour" | "details" | "insights" | "tray";

function storedSections(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem("inspector-sections") || "{}");
  } catch {
    return {};
  }
}

/** Which inspector sections are open, remembered like the panel layout. */
function useSections() {
  const [open, setOpen] = React.useState(storedSections);
  const props = (id: SectionId) => ({
    expanded: open[id] ?? true,
    onExpandedChange: (v: boolean) =>
      setOpen((o) => {
        const next = { ...o, [id]: v };
        try {
          localStorage.setItem("inspector-sections", JSON.stringify(next));
        } catch {
          /* private mode */
        }
        return next;
      }),
  });
  return props;
}

function frameNote(g: { rotation: number; rot_reason: string; params: { crop: unknown; angle: number } }) {
  return [
    rotationNote(g.rotation, g.rot_reason) || "upright",
    g.params.crop && "cropped",
    g.params.angle && "straightened",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The slide sits turned in its mount (or the mount in the scanner): offer to straighten to the
 * mount's edge, and to crop to its window. Shown only when the mount was found with confidence;
 * an import straightens by itself only when it is very sure (imaging.MOUNT_AUTO).
 */
function MountSuggestion({ app, g }: { app: SlideStation; g: Group }) {
  const m = g.mount;
  if (!m || m.confidence < MOUNT_SUGGEST || Math.abs(m.angle) < 0.1) return null;
  const done = Math.abs(g.params.angle + m.angle) < 0.05;
  const turn = `${Math.abs(m.angle).toFixed(1)}° ${m.angle > 0 ? "clockwise" : "anticlockwise"}`;
  return (
    <div className="flex items-center gap-1.5 px-3 pb-2.5" role="status">
      <Ruler className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
        {done ? "Level with the mount" : `Mount turned ${turn}`}
        <span className="opacity-70"> · {Math.round(m.confidence * 100)}% sure</span>
      </span>
      {!done && (
        <Tip label={`Turn the photo ${m.angle > 0 ? "anticlockwise" : "clockwise"} so the mount's edges are level`}>
          <ProButton onClick={() => app.straightenToMount()}>Straighten to mount</ProButton>
        </Tip>
      )}
      <Tip label="Straighten and crop to the inside of the mount: a tighter trim">
        <ProButton plain aria-label="Straighten and trim to the mount" onClick={() => app.straightenToMount(true)}>
          <Frame />
        </ProButton>
      </Tip>
    </div>
  );
}

function curveNote(curves: Record<string, unknown> | undefined) {
  const edited = CHANNELS.filter((c) => !isStraight(curves?.[c] as never));
  if (!edited.length) return "straight";
  return edited.map((c) => (c === "rgb" ? "RGB" : c.toUpperCase())).join(" · ");
}

export function Inspector({
  app,
  session,
  sessionId,
  busy,
  onUpload,
  onClean,
  picking,
  onPick,
  cropping,
  onCrop,
  onReimport,
  onSave,
  onDateRange,
  onPresets,
  onDevelopLike,
  onAccepted,
  onStockRange,
  insights,
}: {
  app: SlideStation;
  session: SessionPayload;
  sessionId: string;
  busy: boolean;
  onUpload: (scope?: "ready" | "all") => void;
  onClean: () => void;
  /** The neutral-point eyedropper is waiting for a click on the photo. */
  picking: boolean;
  onPick: () => void;
  cropping: boolean;
  onCrop: () => void;
  /** Import the tray's scans again (brings deleted originals back and unlocks their slides). */
  onReimport?: () => void;
  /** Browser version: save the finished JPEGs to disk (replaces "show the finished files"). */
  onSave?: () => void;
  /** Opens the "date a range of slides" dialog. */
  onDateRange: () => void;
  /** Opens the presets dialog, and the "develop like another slide" picker. */
  onPresets: () => void;
  onDevelopLike: () => void;
  /** A suggestion (film stock, date) was accepted on slide `index`: offer it to the neighbours. */
  onAccepted: (kind: InsightKind, value: string, groups: Group[], index: number) => void;
  /** Give a film stock to a run of slides (the propagate dialog, from this slide). */
  onStockRange: (stock: string) => void;
  /** The Insights section (desktop app only; the browser version has no models yet). */
  insights?: {
    downloading: boolean;
    onAccepted: (kind: InsightKind, value: string, groups: Group[], index: number) => void;
    onReview: () => void;
    onSettings: () => void;
  };
}) {
  const { current: g, sel } = app;
  const sm = session.summary;
  const blockers = session.cleanup_blockers;
  const section = useSections();
  const undeveloped = session.groups.filter(needsReview).length;

  return (
    <ProInspector className="size-full min-h-0 border-l border-border">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {g?.locked && (
          <div className="ss-locked" role="status">
            <Lock className="size-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <b>Locked — Immich has the final version</b>
              <span>The original scans were deleted after upload, so this slide can't be edited.</span>
            </div>
            {onReimport && (
              <Tip label="Import the scans again into this tray (the card or a folder) to edit it">
                <ProButton onClick={onReimport}>
                  <HardDriveDownload /> Re-import
                </ProButton>
              </Tip>
            )}
          </div>
        )}
        {g && (
          // a locked slide shows its settings but can't change them (the server refuses too)
          <div aria-disabled={g.locked || undefined} className={g.locked ? "ss-readonly" : undefined}>
            <ProDisclosureGroup title="Frame" summary={frameNote(g)} {...section("rotation")}>
              <div className="flex items-center gap-1.5 px-3 py-2.5">
                <ProButtonGroup>
                  <Tip label="Rotate left" keys="⇧R">
                    <ProButton plain onClick={() => app.rotate(-90)} aria-label="Rotate left">
                      <RotateCcw />
                    </ProButton>
                  </Tip>
                  <Tip label="Rotate right" keys="R">
                    <ProButton plain onClick={() => app.rotate(90)} aria-label="Rotate right">
                      <RotateCw />
                    </ProButton>
                  </Tip>
                  <Tip label="Upside down">
                    <ProButton plain onClick={() => app.rotate(180)}>
                      180°
                    </ProButton>
                  </Tip>
                </ProButtonGroup>
                <Tip label="Crop and straighten" keys="K">
                  <ProButton aria-pressed={cropping || undefined} data-on={cropping || undefined} onClick={onCrop}>
                    <Crop /> Crop
                  </ProButton>
                </Tip>
                {!!(g.params.crop || g.params.angle) && (
                  <Tip label="Remove crop and straighten">
                    <ProButton
                      plain
                      className="ml-auto"
                      aria-label="Uncrop"
                      onClick={() => {
                        app.setParam("crop", null, true);
                        app.setParam("angle", 0, true);
                      }}
                    >
                      <Undo2 />
                    </ProButton>
                  </Tip>
                )}
              </div>
              <MountSuggestion app={app} g={g} />
            </ProDisclosureGroup>

            <ProDisclosureGroup title="Tone curve" summary={curveNote(g.params.curves)} {...section("curve")}>
              <div className="px-3 py-2.5">
                <ToneCurve
                  sessionId={sessionId}
                  group={g}
                  onChange={(c) => app.setParam("curves", c)}
                  onFit={() => app.fitCurves()}
                  onFitAll={() => app.fitCurves(true)}
                />
              </div>
            </ProDisclosureGroup>

            <ProDisclosureGroup
              title="Adjust"
              summary={adjustSummary(g, session.defaults)}
              right={<AdjustActions app={app} onPresets={onPresets} onDevelopLike={onDevelopLike} />}
              {...section("colour")}
            >
              <AdjustPanel app={app} session={session} picking={picking} onPick={onPick} />
            </ProDisclosureGroup>

            <ProDisclosureGroup title="Details" summary={detailsNote(g, session.stock ?? "")} {...section("details")}>
              <SlideDetails
                app={app}
                session={session}
                onDateRange={onDateRange}
                onAccepted={onAccepted}
                onStockRange={onStockRange}
              />
            </ProDisclosureGroup>

            {insights && (
              <ProDisclosureGroup title="Insights" summary={insightsNote(g, session)} {...section("insights")}>
                <InsightsPanel app={app} session={session} {...insights} />
              </ProDisclosureGroup>
            )}
          </div>
        )}

        <ProDisclosureGroup title="Tray" summary={sm.name} showsBottomSeparator={false} {...section("tray")}>
          <div className="flex flex-col gap-2 px-3 pt-2.5 pb-3">
            <TrayField label="Name" value={sm.name} onCommit={(v) => app.patchSession({ name: v })} />
            <TrayField label="Immich album" value={sm.album} onCommit={(v) => app.patchSession({ album: v })} />
            <TrayField
              label="Date"
              placeholder="e.g. 1985-07 — for slides without their own"
              value={sm.date}
              onCommit={async (v) => {
                if (await app.patchSession({ date: v }))
                  toast("Date saved — slides already in Immich get the new date on the next upload");
              }}
            />
            <TrayStock value={session.stock ?? ""} onChange={(stock) => app.patchSession({ stock })} />
            {session.groups.some((x) => x.status === "uploaded" || x.status === "changed") && (
              <Tip label="Bring captions and dates edited in Immich back into this tray">
                <ProButton className="self-start" onClick={app.pullFromImmich}>
                  <CloudDownload /> Pull from Immich
                </ProButton>
              </Tip>
            )}
          </div>
        </ProDisclosureGroup>
      </div>

      {/* Pinned: the two things you do on every slide and every tray are always one click away. */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-(--ss-panel) px-3 pt-3 pb-3">
        {g && (
          <div className="flex gap-1.5">
            <button
              type="button"
              className="ss-develop flex-1"
              data-done={g.reviewed || undefined}
              onClick={app.review}
              aria-label={g.reviewed ? "Developed, go to the next slide to develop" : "Develop and go to next"}
            >
              {g.reviewed ? <CheckCheck aria-hidden /> : <Aperture aria-hidden />}
              <span>{g.reviewed ? "Developed" : "Develop"}</span>
              <ArrowRight aria-hidden className="ss-develop-arrow" />
              <Kbd>Space</Kbd>
            </button>
            <Tip label={g.skip ? "Unskip slide" : "Skip: leave this slide out of the upload"} keys="X">
              <ProButton
                size="lg"
                className="ss-square"
                aria-label={g.skip ? "Unskip slide" : "Skip slide"}
                aria-pressed={g.skip || undefined}
                data-on={g.skip || undefined}
                onClick={app.toggleSkip}
              >
                <SkipForward />
              </ProButton>
            </Tip>
            <Tip label="Merge with the next slide" keys="M">
              <ProButton
                size="lg"
                className="ss-square"
                aria-label="Merge with next"
                onClick={app.mergeNext}
                disabled={sel >= session.groups.length - 1 || g.locked}
              >
                <Merge />
              </ProButton>
            </Tip>
          </div>
        )}
        <UploadArea sm={sm} undeveloped={undeveloped} busy={busy} onUpload={onUpload} />
        <div className="flex gap-1.5">
          <Tip
            label={
              sm.card_cleaned
                ? "Card cleaned — you can eject the scanner"
                : blockers.length
                  ? `Unlocks when: ${blockers.join("; ")}`
                  : "Delete this tray's scans from the card (only files matching the verified copies)"
            }
            side="top"
          >
            {/* span: a disabled button shows no tooltip */}
            <span className="flex-1">
              <ProButton fullWidth onClick={onClean} disabled={blockers.length > 0 || busy || sm.card_cleaned}>
                <Eraser /> {sm.card_cleaned ? "Card cleaned" : "Clean card"}
              </ProButton>
            </span>
          </Tip>
          {onSave ? (
            <Tip label="Save the finished slides to disk: a folder you pick, or a zip" side="top">
              <ProButton onClick={onSave} disabled={busy || !sm.slides} aria-label="Save to disk">
                <Download />
              </ProButton>
            </Tip>
          ) : (
            <Tip label="Show the finished files" side="top">
              <ProButton onClick={app.reveal} aria-label="Show files">
                <FolderOpen />
              </ProButton>
            </Tip>
          )}
        </div>
      </div>
    </ProInspector>
  );
}

/** Use learned / presets / develop like / copy previous / apply to rest, as icons in the Adjust header. */
function AdjustActions({
  app,
  onPresets,
  onDevelopLike,
}: {
  app: SlideStation;
  onPresets: () => void;
  onDevelopLike: () => void;
}) {
  return (
    <span className="flex items-center gap-0.5">
      <Tip label="Presets: save this colour, or apply a saved one">
        <button type="button" aria-label="Presets" onClick={onPresets}>
          <Bookmark />
        </button>
      </Tip>
      <Tip label="Develop like another slide, from any tray">
        <button type="button" aria-label="Develop like" onClick={onDevelopLike}>
          <Images />
        </button>
      </Tip>
      <Tip label="Use what your developed slides suggest (⇧-click: every slide to develop)">
        <button type="button" aria-label="Use learned settings" onClick={(e) => app.resuggest(e.shiftKey)}>
          <Sparkles />
        </button>
      </Tip>
      <Tip label="Copy adjustments from the previous slide" keys="C">
        <button type="button" aria-label="Copy previous" onClick={app.copyPrev} disabled={app.sel === 0}>
          <Copy />
        </button>
      </Tip>
      <Tip label="Apply to every following slide still to develop">
        <button type="button" aria-label="Apply to rest" onClick={app.applyRest}>
          <Layers />
        </button>
      </Tip>
      <Tip label="Reset all adjustments" keys="0">
        <button type="button" aria-label="Reset all adjustments" onClick={app.resetColour}>
          <Undo2 />
        </button>
      </Tip>
    </span>
  );
}

const DATE_FROM: Record<string, string> = {
  between: "between",
  near: "like",
  tray: "tray date",
  scan: "scanner clock",
};

function detailsNote(g: Group, trayStock: string) {
  const d = g.date_est;
  const date = d.value ? (d.source === "own" ? d.value : `≈ ${d.value}`) : "no date";
  const stock = g.stock || trayStock;
  return [
    date,
    stock && stock !== "unknown" ? STOCK_NAMES[stock] : "",
    g.caption,
    g.tags.length ? g.tags.join(", ") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "Kodachrome 1936–2010": the years the slide's film was sold. */
function eraText(era: EraHint) {
  return `${STOCK_NAMES[era.stock]} ${era.from}–${era.to ?? "today"}`;
}

/** The slide's own date (or where its estimate comes from), film stock, caption and tags. */
function SlideDetails({
  app,
  session,
  onDateRange,
  onAccepted,
  onStockRange,
}: {
  app: SlideStation;
  session: SessionPayload;
  onDateRange: () => void;
  onAccepted: (kind: InsightKind, value: string, groups: Group[], index: number) => void;
  onStockRange: (stock: string) => void;
}) {
  const g = app.current!;
  const est = g.date_est;
  const from = est.from?.map((i) => `#${i + 1}`).join(" & ");
  const era = est.era;
  const dateSug =
    g.insights?.date?.state === "suggested" && g.insights.date.source === "neighbours+stock" ? g.insights.date : null;
  const decide = async (kind: InsightKind, action: "accept" | "dismiss", value: string) => {
    const p = await app.decide(kind, action, value, [g.id]);
    if (p?.decided && action === "accept") onAccepted(kind, value, p.groups, g.index);
  };
  return (
    <div className="flex flex-col gap-2 px-3 pt-2.5 pb-3">
      <TrayField
        key={`${g.id}-date`}
        label="Date"
        value={g.date}
        placeholder={
          (est.source === "own" || !est.value
            ? "e.g. 1978-06"
            : `≈ ${est.value} (${DATE_FROM[est.source]} ${from ?? ""})`.replace(" )", ")")) +
          (era && est.source !== "own" ? ` · ${eraText(era)}` : "")
        }
        onCommit={(v) => app.patchGroup({ date: v })}
      />
      {era?.fits === false && (
        // a hint, never a correction: the date or the film stock is off
        <p className="text-[11px] text-primary" role="status">
          {est.source === "own" ? "This date" : "The estimate"} is outside {eraText(era)}: check the date or the film
          stock.
        </p>
      )}
      {dateSug && (
        <SuggestionRow
          label={
            <>
              <span className="text-muted-foreground">Date </span>
              {dateSug.value}
            </>
          }
          e={dateSug}
          why={`from the dated slides around it${era ? `, within ${eraText(era)}` : ""}`}
          onAccept={() => decide("date", "accept", dateSug.value)}
          onDismiss={() => decide("date", "dismiss", dateSug.value)}
        />
      )}
      <Tip label="Give a run of slides one date, e.g. 12–31: 1978-08">
        <ProButton className="self-start" onClick={onDateRange}>
          <CalendarRange /> Date a range…
        </ProButton>
      </Tip>
      <StockField
        key={`${g.id}-stock`}
        g={g}
        trayStock={session.stock ?? ""}
        onChange={(stock) => app.patchGroup({ stock })}
        onDecide={(action, value) => decide("stock", action, value)}
        onRange={onStockRange}
      />
      <TrayField
        key={`${g.id}-caption`}
        label="Caption"
        value={g.caption}
        placeholder="Who, where, what — goes to Immich as the description"
        onCommit={(v) => app.patchGroup({ caption: v })}
      />
      {g.from_immich && (
        <p className="text-[11px] text-muted-foreground">
          Pulled in from Immich: uploading it replaces that photo there (same albums, favourite kept).
        </p>
      )}
      {/* the browser version keeps a library's tags but can't send them yet: shown, not edited */}
      <TagsField key={`${g.id}-tags`} tags={g.tags ?? []} onChange={app.setTags} readOnly={standalone} />
    </div>
  );
}

/**
 * The way into Immich. Quiet while there's developing left to do; once every slide is developed it
 * turns into the tray's finish line. Developed slides can go up early while the rest stay here.
 */
function UploadArea({
  sm,
  undeveloped,
  busy,
  onUpload,
}: {
  sm: SessionPayload["summary"];
  undeveloped: number;
  busy: boolean;
  onUpload: (scope?: "ready" | "all") => void;
}) {
  if (!sm.slides || !sm.pending_upload) {
    return (
      <ProButton size="lg" fullWidth disabled>
        <Upload />
        {!sm.slides ? "Nothing to upload yet" : "Everything is in Immich"}
      </ProButton>
    );
  }
  if (!undeveloped) {
    return (
      <div className="ss-ready" role="status">
        <div className="flex items-center gap-2 text-[12px]">
          <CheckCheck className="size-4 shrink-0 text-primary" aria-hidden />
          <b className="font-semibold text-foreground">All {plural(sm.slides - sm.skipped, "slide")} developed</b>
        </div>
        <ProButton active size="lg" fullWidth className="ss-upload-ready" onClick={() => onUpload()} disabled={busy}>
          <Upload />
          Upload {plural(sm.pending_upload, "slide")} to Immich
        </ProButton>
      </div>
    );
  }
  return (
    <div className="flex gap-1.5">
      {sm.ready_upload > 0 && (
        <Tip label={`${plural(undeveloped, "slide")} still to develop stay here to keep working on`} side="top">
          <ProButton active size="lg" className="flex-1" onClick={() => onUpload("ready")} disabled={busy}>
            <Upload />
            Upload {sm.ready_upload} developed
          </ProButton>
        </Tip>
      )}
      <Tip
        label={`Upload all ${sm.pending_upload}, the ${undeveloped} undeveloped ones with automatic settings`}
        side="top"
      >
        <ProButton
          size="lg"
          className={sm.ready_upload ? undefined : "flex-1"}
          onClick={() => onUpload("all")}
          disabled={busy}
          aria-label={`Upload all ${sm.pending_upload}`}
        >
          {sm.ready_upload ? `All ${sm.pending_upload}` : `Upload all ${sm.pending_upload}`}
        </ProButton>
      </Tip>
    </div>
  );
}

/** The tray's film stock: every slide without its own is taken to be on it (learning, dates). */
function TrayStock({ value, onChange }: { value: string; onChange: (stock: string) => void }) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-[11px] font-normal text-muted-foreground">
        Film stock
      </Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} className="min-w-[150px]">
        <NativeSelectOption value="">Not set — each slide its own</NativeSelectOption>
        {STOCKS.filter((s) => s !== "unknown").map((s) => (
          <NativeSelectOption key={s} value={s}>
            {STOCK_NAMES[s]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

/** Text field that saves on blur or Enter, and follows the server value while not being edited. */
function TrayField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const id = React.useId();
  const [draft, setDraft] = React.useState(value);
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-[11px] font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          }
        }}
      />
    </div>
  );
}
