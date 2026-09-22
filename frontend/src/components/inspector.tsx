import * as React from "react";
import { toast } from "sonner";
import { ArrowRight, FolderOpen, Merge, RotateCcw, RotateCw, SkipForward, Sparkles, Upload } from "lucide-react";
import { ProInspector, ProInspectorRow, ProInspectorSection } from "@/components/ui/pro-inspector";
import { ProSlider } from "@/components/ui/pro-slider";
import { ProButton, ProButtonGroup } from "@/components/ui/pro-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import type { ParamKey, SessionPayload } from "@/lib/api";
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

function paramsNote(source: string) {
  if (source.startsWith("learned:")) return `Learned from ${source.split(":")[1]} similar slides`;
  if (source === "manual") return "Adjusted by hand";
  return "Tray defaults";
}

export function Inspector({
  app,
  session,
  busy,
  onUpload,
  onClean,
}: {
  app: SlideStation;
  session: SessionPayload;
  busy: boolean;
  onUpload: () => void;
  onClean: () => void;
}) {
  const { current: g, sel } = app;
  const sm = session.summary;
  const blockers = session.cleanup_blockers;

  return (
    <ProInspector className="min-h-0 w-[300px] border-l border-[#202020]">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {g && (
          <>
            <ProInspectorSection title="Rotation">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <ProButtonGroup>
                  <ProButton plain onClick={() => app.rotate(-90)} title="Rotate left (Shift+R)">
                    <RotateCcw /> Left
                  </ProButton>
                  <ProButton plain onClick={() => app.rotate(90)} title="Rotate right (R)">
                    <RotateCw /> Right
                  </ProButton>
                  <ProButton plain onClick={() => app.rotate(180)} title="Upside down">
                    180°
                  </ProButton>
                </ProButtonGroup>
                <span className="ml-auto text-[11px] text-white/45">{rotationNote(g.rotation, g.rot_reason)}</span>
              </div>
            </ProInspectorSection>

            <ProInspectorSection title="Colour">
              <div className="flex flex-col gap-1 px-3 py-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] text-white/45">
                  {g.params_source.startsWith("learned:") && <Sparkles className="size-3 text-primary" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{paramsNote(g.params_source)}</span>
                  <ProButton onClick={app.resetColour} title="Reset (0)">
                    Reset
                  </ProButton>
                </div>
                {SLIDERS.map(([k, label, min, max]) => (
                  <div key={k} className="grid grid-cols-[76px_1fr] items-center gap-2">
                    <span className="text-right text-[12px] text-white/50">{label}</span>
                    <ProSlider
                      label={label}
                      min={min}
                      max={max}
                      step={0.05}
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
                  <ProButton onClick={app.copyPrev} disabled={sel === 0} title="Copy from previous slide (C)">
                    Copy previous
                  </ProButton>
                  <ProButton onClick={app.applyRest} title="Apply to all following unreviewed slides">
                    Apply to rest
                  </ProButton>
                  {!g.reviewed && (
                    <ProButton onClick={app.resuggest} title="Use what your approved slides suggest for this one">
                      <Sparkles /> Use learned
                    </ProButton>
                  )}
                </div>
              </div>
            </ProInspectorSection>

            <ProInspectorSection title="Slide">
              <div className="flex flex-col gap-1.5 px-3 py-2.5">
                <ProButton active size="md" fullWidth onClick={app.review} title="Space">
                  Looks good <ArrowRight /> next
                  <Kbd className="ml-1 opacity-70">Space</Kbd>
                </ProButton>
                <div className="flex gap-1.5">
                  <ProButton className="flex-1" onClick={app.toggleSkip} title="X">
                    <SkipForward /> {g.skip ? "Unskip slide" : "Skip slide"}
                  </ProButton>
                  <ProButton
                    className="flex-1"
                    onClick={app.mergeNext}
                    disabled={sel >= session.groups.length - 1}
                    title="Merge with next slide (M)"
                  >
                    <Merge /> Merge with next
                  </ProButton>
                </div>
              </div>
            </ProInspectorSection>
          </>
        )}

        <ProInspectorSection title="Tray">
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
            <ProInspectorRow label="Reviewed" value={`${sm.reviewed} / ${sm.slides}`} />
            <ProInspectorRow label="In Immich" value={sm.uploaded} />
            <ProInspectorRow label="Skipped" value={sm.skipped} />
            <ProInspectorRow label="To upload" value={sm.pending_upload} />
          </div>
        </ProInspectorSection>
      </div>

      {/* Pinned so the way out of a tray is always one click away. */}
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-black/30 bg-[#333] px-3 pt-2.5 pb-3">
        <ProButton active size="lg" fullWidth onClick={onUpload} disabled={!sm.pending_upload || busy}>
          <Upload />
          {!sm.slides
            ? "Nothing to upload yet"
            : sm.pending_upload
              ? `Upload ${sm.pending_upload} slide${sm.pending_upload === 1 ? "" : "s"} to Immich`
              : "Everything is in Immich"}
        </ProButton>
        <div className="flex gap-1.5">
          <ProButton className="flex-1" onClick={onClean} disabled={blockers.length > 0 || busy || sm.card_cleaned}>
            Clean scanner card
          </ProButton>
          <ProButton onClick={app.reveal}>
            <FolderOpen /> Show files
          </ProButton>
        </div>
        <p className="text-[11px] leading-snug text-white/45">
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
      <Label htmlFor={id} className="text-[11px] font-normal text-white/50">
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
