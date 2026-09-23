import * as React from "react";
import { toast } from "sonner";
import {
  Aperture,
  ArrowRight,
  CheckCheck,
  FolderOpen,
  Merge,
  RotateCcw,
  RotateCw,
  SkipForward,
  Sparkles,
  Undo2,
  Upload,
} from "lucide-react";
import { ProInspector, ProInspectorRow } from "@/components/ui/pro-inspector";
import { ProDisclosureGroup } from "@/components/ui/pro-disclosure";
import { ProSlider } from "@/components/ui/pro-slider";
import { ProButton, ProButtonGroup } from "@/components/ui/pro-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/tip";
import { STATUS_LABEL } from "@/components/filmstrip";
import { ToneCurve } from "@/components/tone-curve";
import { needsReview, plural, type ParamKey, type SessionPayload } from "@/lib/api";
import { CHANNELS, isStraight } from "@/lib/curves";
import type { SlideStation } from "@/hooks/use-slide-station";

const SLIDERS: [ParamKey, string, number, number][] = [
  ["strength", "Auto restore", 0, 1],
  ["brightness", "Brightness", -1, 1],
  ["contrast", "Contrast", -1, 1],
  ["warmth", "Warmth", -1, 1],
  ["tint", "Tint", -1, 1],
  ["saturation", "Saturation", -1, 1],
];

function rotationNote(rotation: number, reason: string) {
  if (!rotation) return "";
  if (reason === "faces") return "auto · faces";
  if (reason === "sky") return "auto · sky";
  return `${rotation}°`;
}

type SectionId = "rotation" | "curve" | "colour" | "slide" | "tray";

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

function paramsNote(source: string) {
  if (source.startsWith("learned:")) return `Learned from ${source.split(":")[1]} similar slides`;
  if (source === "manual") return "Adjusted by hand";
  return "Tray defaults";
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
}: {
  app: SlideStation;
  session: SessionPayload;
  sessionId: string;
  busy: boolean;
  onUpload: (scope?: "ready" | "all") => void;
  onClean: () => void;
}) {
  const { current: g, sel } = app;
  const sm = session.summary;
  const blockers = session.cleanup_blockers;
  const section = useSections();
  const undeveloped = session.groups.filter(needsReview).length;

  return (
    <ProInspector className="size-full min-h-0 border-l border-border">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {g && (
          <>
            <ProDisclosureGroup
              title="Rotation"
              summary={rotationNote(g.rotation, g.rot_reason) || "upright"}
              {...section("rotation")}
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <ProButtonGroup>
                  <Tip label="Rotate left" keys="⇧R">
                    <ProButton plain onClick={() => app.rotate(-90)}>
                      <RotateCcw /> Left
                    </ProButton>
                  </Tip>
                  <Tip label="Rotate right" keys="R">
                    <ProButton plain onClick={() => app.rotate(90)}>
                      <RotateCw /> Right
                    </ProButton>
                  </Tip>
                  <Tip label="Upside down">
                    <ProButton plain onClick={() => app.rotate(180)}>
                      180°
                    </ProButton>
                  </Tip>
                </ProButtonGroup>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {rotationNote(g.rotation, g.rot_reason)}
                </span>
              </div>
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
              title="Colour"
              summary={paramsNote(g.params_source)}
              right={
                <Tip label="Reset colour" keys="0">
                  <button type="button" aria-label="Reset colour" onClick={app.resetColour}>
                    <Undo2 />
                  </button>
                </Tip>
              }
              {...section("colour")}
            >
              <div className="flex flex-col gap-1 px-3 py-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {g.params_source.startsWith("learned:") && <Sparkles className="size-3 text-primary" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{paramsNote(g.params_source)}</span>
                </div>
                {SLIDERS.map(([k, label, min, max]) => (
                  <div key={k} className="grid grid-cols-[76px_1fr] items-center gap-2">
                    <span className="text-right text-[12px] text-muted-foreground">{label}</span>
                    <ProSlider
                      label={label}
                      min={min}
                      max={max}
                      step={0.01}
                      precision={2}
                      value={g.params[k]}
                      resetValue={k === "strength" ? session.defaults.strength : 0}
                      onValueChange={(v) => app.setParam(k, v)}
                    />
                  </div>
                ))}
                <div className="mt-1.5 flex items-center gap-2 pl-[84px]">
                  <Checkbox
                    id="trim"
                    checked={g.params.trim}
                    onCheckedChange={(v) => app.setParam("trim", v === true, true)}
                  />
                  <Label htmlFor="trim" className="text-[12px] font-normal">
                    Trim dark mount edges
                  </Label>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Tip label="Copy colour from the previous slide" keys="C">
                    <ProButton onClick={app.copyPrev} disabled={sel === 0}>
                      Copy previous
                    </ProButton>
                  </Tip>
                  <Tip label="Apply to all following unreviewed slides">
                    <ProButton onClick={app.applyRest}>Apply to rest</ProButton>
                  </Tip>
                  {!g.reviewed && (
                    <Tip label="Use what your approved slides suggest for this one">
                      <ProButton onClick={app.resuggest}>
                        <Sparkles /> Use learned
                      </ProButton>
                    </Tip>
                  )}
                </div>
              </div>
            </ProDisclosureGroup>

            <ProDisclosureGroup title="Slide" summary={STATUS_LABEL[g.status]} {...section("slide")}>
              <div className="flex flex-col gap-1.5 px-3 py-2.5">
                <button
                  type="button"
                  className="ss-develop"
                  data-done={g.reviewed || undefined}
                  onClick={app.review}
                  aria-label={g.reviewed ? "Developed, go to the next slide to develop" : "Develop and go to next"}
                >
                  {g.reviewed ? <CheckCheck aria-hidden /> : <Aperture aria-hidden />}
                  <span>{g.reviewed ? "Developed" : "Develop"}</span>
                  <ArrowRight aria-hidden className="ss-develop-arrow" />
                  <Kbd>Space</Kbd>
                </button>
                <div className="flex gap-1.5">
                  <Tip label={g.skip ? "Unskip slide" : "Leave this slide out of the upload"} keys="X">
                    <ProButton className="flex-1" onClick={app.toggleSkip}>
                      <SkipForward /> {g.skip ? "Unskip slide" : "Skip slide"}
                    </ProButton>
                  </Tip>
                  <Tip label="Merge with the next slide" keys="M">
                    <ProButton className="flex-1" onClick={app.mergeNext} disabled={sel >= session.groups.length - 1}>
                      <Merge /> Merge with next
                    </ProButton>
                  </Tip>
                </div>
              </div>
            </ProDisclosureGroup>
          </>
        )}

        <ProDisclosureGroup
          title="Tray"
          summary={`${sm.reviewed} / ${sm.slides} developed`}
          showsBottomSeparator={false}
          {...section("tray")}
        >
          <div className="flex flex-col gap-2 px-3 pt-2.5 pb-1">
            <TrayField label="Name" value={sm.name} onCommit={(v) => app.patchSession({ name: v })} />
            <TrayField label="Immich album" value={sm.album} onCommit={(v) => app.patchSession({ album: v })} />
            <TrayField
              label="Photo date"
              placeholder="e.g. 1985-07 (optional)"
              value={sm.date}
              onCommit={async (v) => {
                if (await app.patchSession({ date: v }))
                  toast("Date saved — slides already in Immich get the new date on the next upload");
              }}
            />
          </div>
          <div className="py-1">
            <ProInspectorRow label="Developed" value={`${sm.reviewed} / ${sm.slides}`} />
            <ProInspectorRow label="In Immich" value={sm.uploaded} />
            <ProInspectorRow label="Skipped" value={sm.skipped} />
            <ProInspectorRow label="To upload" value={sm.pending_upload} />
          </div>
        </ProDisclosureGroup>
      </div>

      {/* Pinned so the way out of a tray is always one click away. */}
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-(--ss-panel) px-3 pt-2.5 pb-3">
        <UploadArea sm={sm} undeveloped={undeveloped} busy={busy} onUpload={onUpload} />
        <div className="flex gap-1.5">
          <ProButton className="flex-1" onClick={onClean} disabled={blockers.length > 0 || busy || sm.card_cleaned}>
            Clean scanner card
          </ProButton>
          <ProButton onClick={app.reveal}>
            <FolderOpen /> Show files
          </ProButton>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {sm.card_cleaned
            ? "Card cleaned — you can eject the scanner."
            : blockers.length
              ? `Card cleanup unlocks when: ${blockers.join("; ")}.`
              : "Deletes this tray's scans from the scanner's card (only files that match the verified copies)."}
        </p>
      </div>
    </ProInspector>
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
          <span>
            <b className="font-semibold text-foreground">All {plural(sm.slides - sm.skipped, "slide")} developed</b>
            <span className="block text-[11px] text-muted-foreground">Ready for Immich</span>
          </span>
        </div>
        <ProButton active size="lg" fullWidth className="ss-upload-ready" onClick={() => onUpload()} disabled={busy}>
          <Upload />
          Upload {plural(sm.pending_upload, "slide")} to Immich
        </ProButton>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {sm.ready_upload > 0 && (
        <ProButton active size="lg" fullWidth onClick={() => onUpload("ready")} disabled={busy}>
          <Upload />
          Upload {plural(sm.ready_upload, "developed slide")}
        </ProButton>
      )}
      <ProButton size={sm.ready_upload ? "md" : "lg"} fullWidth onClick={() => onUpload("all")} disabled={busy}>
        {sm.ready_upload ? (
          `Upload all ${sm.pending_upload}, undeveloped too`
        ) : (
          <>
            <Upload /> Upload {plural(sm.pending_upload, "slide")} to Immich
          </>
        )}
      </ProButton>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {plural(undeveloped, "slide")} still to develop
        {sm.ready_upload
          ? " — uploading the developed ones leaves them here to keep working on."
          : " — press Space on each one you're happy with."}
      </p>
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
