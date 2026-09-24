import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { PreviewImg, STATUS_DOT, STATUS_LABEL } from "@/components/filmstrip";
import type { SlideStation } from "@/hooks/use-slide-station";
import { api, plural, previewUrl, type Preset, type SessionPayload } from "@/lib/api";
import { isStraight } from "@/lib/curves";
import { cn } from "@/lib/utils";

const primary = "bg-primary text-primary-foreground";

const SLIDERS = ["brightness", "contrast", "warmth", "tint", "saturation"] as const;

/** One line on what a preset does: "restore 40 · warmth +0.25 · curves". */
function presetNote(p: Preset["params"]) {
  const parts = [`restore ${Math.round(p.strength * 100)}`];
  for (const k of SLIDERS) if (Math.abs(p[k]) > 0.004) parts.push(`${k} ${p[k] > 0 ? "+" : ""}${p[k].toFixed(2)}`);
  if (Object.values(p.curves ?? {}).some((c) => !isStraight(c))) parts.push("curves");
  return parts.join(" · ");
}

/**
 * Presets: this slide's colour settings (never its crop or straighten) saved under a name for the
 * whole library, and applied to this slide or to it and every following slide still to develop.
 */
export function PresetsDialog({
  open,
  onOpenChange,
  app,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: SlideStation;
}) {
  const [name, setName] = React.useState("");
  React.useEffect(() => {
    if (!open) return;
    setName("");
    app.loadPresets();
    // only when the dialog opens
  }, [open]);
  const g = app.current;
  const run = async (fn: () => Promise<boolean>) => {
    if (await fn()) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Presets</DialogTitle>
          <DialogDescription>
            A preset is a slide's colour — restore, curves, light and colour — without its crop or straighten. Every
            slide it changes can be undone.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex items-end gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await app.savePreset(name)) setName("");
          }}
        >
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="preset-name">Save slide {app.sel + 1}'s colour as</FieldLabel>
            <Input
              id="preset-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Faded Ektachrome"
            />
          </Field>
          <Button type="submit" className={primary} disabled={!g || !name.trim()}>
            Save
          </Button>
        </form>
        <div className="max-h-[300px] overflow-y-auto scrollbar-thin" role="list" aria-label="Presets">
          {!app.presets.length && (
            <p className="py-4 text-center text-[12px] text-(--ss-dim)">No presets yet — save one above.</p>
          )}
          {app.presets.map((p) => (
            <div
              key={p.name}
              role="listitem"
              aria-label={p.name}
              className="flex items-center gap-2 border-b border-(--ss-line-soft) py-2 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium">{p.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{presetNote(p.params)}</div>
              </div>
              <Button size="sm" disabled={!g || g.locked} onClick={() => run(() => app.applyLook({ preset: p.name }))}>
                This slide
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!g}
                onClick={() => run(() => app.applyLook({ preset: p.name }, "rest"))}
                title="This slide and every following one still to develop"
              >
                + rest
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete ${p.name}`}
                onClick={() => app.deletePreset(p.name)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Develop like…": pick any slide of any tray and copy its colour settings (never framing) to this
 * slide, or to it and every following slide still to develop.
 */
export function DevelopLikeDialog({
  open,
  onOpenChange,
  app,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: SlideStation;
}) {
  const [tray, setTray] = React.useState(app.sessionId);
  const [other, setOther] = React.useState<SessionPayload | null>(null);
  const [pick, setPick] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setTray(app.sessionId);
    setPick(null);
    // only when the dialog opens
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    setOther(null);
    setPick(null);
    if (tray === app.sessionId) return;
    let live = true;
    // peek: looking into another tray doesn't make it the one the background renderer works on
    api<SessionPayload>("GET", `/api/sessions/${tray}?peek=1`).then(
      (p) => live && setOther(p),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, tray]);
  const shown = tray === app.sessionId ? app.session : other;
  const src = shown?.groups.find((x) => x.id === pick);
  const g = app.current;
  const apply = async (scope: "this" | "rest") => {
    if (src && (await app.applyLook({ like: { session: tray, group: src.id } }, scope))) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Develop like another slide</DialogTitle>
          <DialogDescription>
            Slide {app.sel + 1} gets the colour of the slide you pick, from this tray or any other. Its own crop and
            straighten stay.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="like-tray">Tray</FieldLabel>
          <NativeSelect id="like-tray" className="w-full" value={tray} onChange={(e) => setTray(e.target.value)}>
            {(app.state?.sessions ?? []).map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {s.name} · {plural(s.slides, "slide")}
                {s.id === app.sessionId ? " (this tray)" : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <div
          className="grid max-h-[340px] grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2 overflow-y-auto p-0.5 scrollbar-thin"
          role="listbox"
          aria-label="Slides to develop like"
        >
          {!shown && <p className="col-span-full py-6 text-center text-[12px] text-(--ss-dim)">Loading…</p>}
          {shown?.groups.map((x) => (
            <button
              key={x.id}
              type="button"
              role="option"
              aria-selected={pick === x.id}
              aria-label={`Slide ${x.index + 1}, ${STATUS_LABEL[x.status]}`}
              onClick={() => setPick(x.id)}
              onDoubleClick={() => {
                setPick(x.id);
                if (g && !g.locked)
                  void app.applyLook({ like: { session: tray, group: x.id } }).then((ok) => ok && onOpenChange(false));
              }}
              className={cn(
                "relative aspect-[3/2] cursor-default overflow-hidden rounded border-2 border-transparent bg-black/40",
                pick === x.id && "border-primary",
              )}
            >
              <PreviewImg
                url={previewUrl(tray, x, 320)}
                alt=""
                draggable={false}
                className="size-full object-contain"
              />
              <span className="absolute bottom-0.5 left-1 flex items-center gap-1 rounded bg-black/65 px-1 text-[10px] text-white">
                <span className={cn("size-[6px] rounded-full", STATUS_DOT[x.status])} />
                {x.index + 1}
              </span>
            </button>
          ))}
        </div>
        <FieldDescription>
          {src
            ? `Slide ${src.index + 1} of ${shown?.summary.name}: ${presetNote(src.params)}`
            : "Pick a slide (double-click applies it)."}
        </FieldDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="outline" disabled={!src || !g} onClick={() => apply("rest")}>
            This and the rest to develop
          </Button>
          <Button className={primary} disabled={!src || !g || g.locked} onClick={() => apply("this")}>
            Develop like it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
