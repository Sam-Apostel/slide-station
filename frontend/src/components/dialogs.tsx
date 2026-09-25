import * as React from "react";
import { toast } from "sonner";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { isMac } from "@/lib/desktop";
import {
  api,
  BOX_SIZES,
  plural,
  sourceLabel,
  standalone,
  trayLabel,
  type AppState,
  type Box,
  type Group,
  type NewTrayBody,
  type Side,
  type Source,
} from "@/lib/api";
import type { Stats } from "@/lib/stats";
import { FolderInput } from "@/components/settings";

const primary = "bg-primary text-primary-foreground";

// ------------------------------------------------------------------ new tray

const FOLDER = "__folder";
const NOTHING = "__none";

/** Where the next tray probably goes: the other tray of the last box you started, else a new box. */
export function nextPlace(boxes: Box[]): { box: number; side: Side } {
  const used = boxes.filter((b) => b.trays.left || b.trays.right);
  const last = used.at(-1);
  if (!last) return { box: (boxes.at(-1)?.number ?? 0) + 1, side: "left" };
  if (!last.trays.left) return { box: last.number, side: "left" };
  if (!last.trays.right) return { box: last.number, side: "right" };
  return { box: last.number + 1, side: "left" };
}

export function NewTrayDialog({
  open,
  onOpenChange,
  state,
  preferSource,
  preferFolder,
  onCreate,
  onChooseFolder,
  onFromImmich,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: AppState | null;
  preferSource?: Source;
  /** Opened from a dropped or picked folder: import that. */
  preferFolder?: string;
  onCreate: (body: NewTrayBody, source: string) => void;
  /** Browser version: pick a folder of scans to import (resolves to the new source). */
  onChooseFolder?: () => Promise<Source | null>;
  /** Start a tray from photos already in Immich instead. */
  onFromImmich?: () => void;
}) {
  const sources = (state?.sources ?? []).filter((x) => x.count > 0);
  const boxes = state?.boxes ?? [];
  const [boxText, setBoxText] = React.useState("");
  const [side, setSide] = React.useState<Side>("left");
  const [size, setSize] = React.useState<number>(BOX_SIZES[0]);
  const [writing, setWriting] = React.useState("");
  const [name, setName] = React.useState("");
  const [album, setAlbum] = React.useState("");
  const [date, setDate] = React.useState("");
  const [source, setSource] = React.useState(NOTHING);
  const [folder, setFolder] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    const next = nextPlace(boxes);
    setBoxText(String(next.box));
    setSide(next.side);
    setName("");
    setAlbum("");
    setDate("");
    setFolder(preferFolder ?? "");
    setSource(preferFolder !== undefined ? FOLDER : (preferSource?.path ?? sources[0]?.path ?? NOTHING));
    // only when the dialog opens; the source list refreshes every poll
  }, [open]);

  // empty: not in a box (a tray from somewhere else)
  const boxNumber = /^\s*\d+\s*$/.test(boxText) && Number(boxText) > 0 ? Number(boxText) : null;
  const badBox = boxText.trim() !== "" && boxNumber === null;
  const known = boxes.find((b) => b.number === boxNumber);
  const taken = (s: Side) => !!known?.trays[s];
  const sideTaken = boxNumber !== null && taken(side);
  // a box you're starting now: say how big it is and what's on it; a known one is as it was
  const newBox = boxNumber !== null && !known;
  React.useEffect(() => {
    if (!newBox) return;
    setSize(BOX_SIZES[0]);
    setWriting("");
  }, [boxNumber, newBox]);
  React.useEffect(() => {
    // the side that's free, when the box you typed has one tray already
    if (known && taken(side) && !taken(side === "left" ? "right" : "left")) setSide(side === "left" ? "right" : "left");
  }, [boxNumber]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (badBox || sideTaken) return;
    const src = source === FOLDER ? folder.trim() : source === NOTHING ? "" : source;
    onOpenChange(false);
    onCreate(
      {
        // in a box the server names it after where it lives
        name: name.trim() || (boxNumber === null ? `Tray ${new Date().toLocaleDateString()}` : ""),
        album: album.trim(),
        date: date.trim(),
        box: boxNumber,
        side: boxNumber === null ? null : side,
        ...(newBox && { box_size: size, box_writing: writing.trim() }),
      },
      src,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <form onSubmit={submit} className="grid gap-[18px]">
          <DialogHeader>
            <DialogTitle>New tray</DialogTitle>
            <DialogDescription>One tray of slides becomes one Immich album.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <div className="flex gap-3">
              <Field className="w-[110px] shrink-0" data-invalid={badBox || undefined}>
                <FieldLabel htmlFor="n-box">Box</FieldLabel>
                <Input
                  id="n-box"
                  autoFocus
                  inputMode="numeric"
                  value={boxText}
                  aria-invalid={badBox || undefined}
                  onChange={(e) => setBoxText(e.target.value)}
                  placeholder="none"
                />
              </Field>
              <Field className="min-w-0 flex-1" data-invalid={sideTaken || undefined}>
                <FieldLabel htmlFor="n-side">Tray</FieldLabel>
                <NativeSelect
                  id="n-side"
                  className="w-full"
                  value={side}
                  disabled={boxNumber === null}
                  aria-invalid={sideTaken || undefined}
                  onChange={(e) => setSide(e.target.value as Side)}
                >
                  {(["left", "right"] as const).map((s) => (
                    <NativeSelectOption key={s} value={s} disabled={taken(s)}>
                      {s === "left" ? "Left" : "Right"}
                      {taken(s) ? " (already scanned)" : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            {badBox ? (
              <FieldDescription className="-mt-2 text-destructive">
                The box number is a whole number; leave it empty for a tray that isn't in a box.
              </FieldDescription>
            ) : known ? (
              <FieldDescription className="-mt-2">
                Trays of {known.size}
                {known.writing ? ` · “${known.writing}”` : ""}
              </FieldDescription>
            ) : null}
            {newBox && (
              <div className="flex gap-3">
                <Field className="w-[110px] shrink-0">
                  <FieldLabel htmlFor="n-size">Trays of</FieldLabel>
                  <NativeSelect
                    id="n-size"
                    className="w-full"
                    value={size}
                    onChange={(e) => setSize(Number(e.target.value))}
                  >
                    {BOX_SIZES.map((n) => (
                      <NativeSelectOption key={n} value={n}>
                        {n} slides
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field className="min-w-0 flex-1">
                  <FieldLabel htmlFor="n-writing">Written on the box</FieldLabel>
                  <Input
                    id="n-writing"
                    value={writing}
                    onChange={(e) => setWriting(e.target.value)}
                    placeholder="optional, as it says"
                  />
                </Field>
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="n-name">Name</FieldLabel>
              <Input
                id="n-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={trayLabel(boxNumber, side) || "e.g. Italy 1978"}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="n-album">Immich album</FieldLabel>
              <Input id="n-album" value={album} onChange={(e) => setAlbum(e.target.value)} placeholder="same as name" />
            </Field>
            <Field>
              <FieldLabel htmlFor="n-date">Photo date</FieldLabel>
              <Input
                id="n-date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                placeholder="optional, e.g. 1985-07"
              />
              <FieldDescription>
                The date is written into every photo so Immich files them in the right year. Leave it empty to keep the
                scanner's own date.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="n-source">Import from</FieldLabel>
              <div className="flex gap-1.5">
                <NativeSelect
                  id="n-source"
                  className="w-full min-w-0 flex-1"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  {sources.map((x) => (
                    <NativeSelectOption key={x.path} value={x.path}>
                      {sourceLabel(x)} ({x.new} new of {x.count})
                    </NativeSelectOption>
                  ))}
                  {!standalone && !state?.server?.accounts && (
                    <NativeSelectOption value={FOLDER}>A folder on this Mac…</NativeSelectOption>
                  )}
                  <NativeSelectOption value={NOTHING}>Nothing yet</NativeSelectOption>
                </NativeSelect>
                {onChooseFolder && (
                  <Button
                    type="button"
                    onClick={async () => {
                      const src = await onChooseFolder();
                      if (src) setSource(src.path);
                    }}
                  >
                    Choose folder…
                  </Button>
                )}
              </div>
            </Field>
            {source === FOLDER && (
              <Field>
                <FieldLabel htmlFor="n-path">Folder path</FieldLabel>
                <FolderInput
                  id="n-path"
                  value={folder}
                  onChange={setFolder}
                  placeholder="/Users/you/Pictures/slides/box 4"
                  pickerTitle="Import scans from a folder"
                />
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            {onFromImmich && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto"
                onClick={() => {
                  onOpenChange(false);
                  onFromImmich();
                }}
              >
                From Immich…
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" className={primary} disabled={badBox || sideTaken}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ date a range

/** Where a run of slides dated from `sel` naturally ends: before the next slide with its own date. */
export function rangeEnd(groups: Group[], sel: number) {
  const next = groups.findIndex((g, i) => i > sel && g.date);
  return next >= 0 ? next - 1 : groups.length - 1;
}

/**
 * Date a run of slides at once ("12–31: Aug 1978"). Slide numbers are 1-based as in the filmstrip;
 * it opens on this slide through the one before the next dated slide (or the end of the tray).
 */
export function DateRangeDialog({
  open,
  onOpenChange,
  groups,
  sel,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: Group[];
  sel: number;
  onApply: (fromIndex: number, toIndex: number, date: string) => Promise<boolean>;
}) {
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [date, setDate] = React.useState("");
  const n = groups.length;

  React.useEffect(() => {
    if (!open) return;
    setFrom(String(sel + 1));
    setTo(String(rangeEnd(groups, sel) + 1));
    setDate(groups[sel]?.date ?? "");
    // only when the dialog opens; the groups refresh on every edit
  }, [open]);

  const a = Number(from);
  const b = Number(to);
  const valid = Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= 1 && a <= n && b <= n;
  const count = valid ? Math.abs(b - a) + 1 : 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (valid && (await onApply(a - 1, b - 1, date.trim()))) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={submit} className="grid gap-[18px]">
          <DialogHeader>
            <DialogTitle>Date a range of slides</DialogTitle>
            <DialogDescription>
              Every slide in the range gets this date as its own. Leave the date empty to clear theirs.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="dr-from">From slide</FieldLabel>
                <Input
                  id="dr-from"
                  inputMode="numeric"
                  value={from}
                  onChange={(e) => setFrom(e.target.value.replace(/\D/g, ""))}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="dr-to">To slide</FieldLabel>
                <Input
                  id="dr-to"
                  inputMode="numeric"
                  value={to}
                  onChange={(e) => setTo(e.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="dr-date">Date</FieldLabel>
              <Input
                id="dr-date"
                autoFocus
                value={date}
                onChange={(e) => setDate(e.target.value)}
                placeholder="1978, 1978-08 or 1978-08-14"
              />
              <FieldDescription>
                {valid
                  ? `${count === 1 ? "1 slide" : `${count} slides`} of ${n}. Locked slides keep their date.`
                  : `Slide numbers go from 1 to ${n}.`}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" className={primary} disabled={!valid}>
              {date.trim() ? "Date slides" : "Clear dates"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ keyboard help

export const SHORTCUTS: [React.ReactNode, string][] = [
  [
    <>
      <Kbd>←</Kbd> <Kbd>→</Kbd>
    </>,
    "Previous / next slide",
  ],
  [<Kbd>Space</Kbd>, "Develop (mark ready for Immich), go to next"],
  [
    <>
      <Kbd>R</Kbd> / <Kbd>⇧ R</Kbd>
    </>,
    "Rotate right / left",
  ],
  [<Kbd>H</Kbd>, "Mirror (scanned the wrong way round)"],
  [
    <>
      <Kbd>B</Kbd> (hold)
    </>,
    "Show before",
  ],
  [<Kbd>Y</Kbd>, "Split view: before | after (drag the divider)"],
  [
    <>
      <Kbd>Z</Kbd> / double-click
    </>,
    "1:1 zoom on the full-resolution render (drag to move, Z or Esc to leave)",
  ],
  [<Kbd>L</Kbd>, "Loupe: 100 % under the pointer"],
  [<Kbd>G</Kbd>, "Review grid: every slide at once (G or Esc back)"],
  [<Kbd>P</Kbd>, "Capture: the tethered camera takes a picture into this tray (camera rig)"],
  [
    <>
      <Kbd>←</Kbd> <Kbd>→</Kbd> <Kbd>↑</Kbd> <Kbd>↓</Kbd>
    </>,
    "In the grid: move the cursor (Space develops and steps on, X skips, R turns, Enter opens)",
  ],
  [<Kbd>C</Kbd>, "Copy colour from previous slide"],
  [<Kbd>0</Kbd>, "Reset all adjustments"],
  [<Kbd>W</Kbd>, "White balance: click a neutral spot on the photo"],
  [<Kbd>K</Kbd>, "Crop & straighten (Enter applies, Esc cancels)"],
  [
    <>
      <Kbd>←</Kbd> <Kbd>→</Kbd> <Kbd>↑</Kbd> <Kbd>↓</Kbd>
    </>,
    `While cropping: move the frame (${isMac ? "⌥" : "Alt"}: resize from the bottom-right, ⇧: bigger steps)`,
  ],
  [<Kbd>A</Kbd>, "Local adjustments on the photo: graduated, radial, brush (Esc closes)"],
  [
    <>
      <Kbd>O</Kbd> <Kbd>⌫</Kbd>
    </>,
    "In the Local tool: show the mask, delete the selected adjustment",
  ],
  [
    <>
      <Kbd>⌘ Z</Kbd> / <Kbd>⇧ ⌘ Z</Kbd>
    </>,
    "Undo / redo this slide's edits",
  ],
  [<Kbd>F</Kbd>, "Fit the tone curves to the scan's data"],
  [<Kbd>⇧ F</Kbd>, "Fit the curves of every slide still to develop"],
  [<Kbd>X</Kbd>, "Skip slide (not uploaded)"],
  [<Kbd>M</Kbd>, "Merge with next slide"],
  [
    <>
      <Kbd>1</Kbd>–<Kbd>9</Kbd>
    </>,
    "Toggle scan in the stack",
  ],
  [<Kbd>{isMac ? "⌘ K" : "Ctrl K"}</Kbd>, "Every action, searchable"],
  ["Right-click", "Actions for a slide"],
  [<Kbd>?</Kbd>, "This list"],
];

// ------------------------------------------------------------------ stats

/** Progress across every tray: slides per hour, trays left, when the target is reached. */
export function StatsDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The target was changed (it lives in the config). */
  onSaved: () => void;
}) {
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [target, setTarget] = React.useState("");
  const load = React.useCallback(async () => {
    try {
      const s = await api<Stats>("GET", "/api/stats");
      setStats(s);
      setTarget(String(s.target));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);
  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  const saveTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(target);
    if (!Number.isInteger(n) || n < 1 || n === stats?.target) return;
    try {
      await api("POST", "/api/config", { stats_target: n });
      onSaved();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const s = stats;
  const n = (x: number) => x.toLocaleString();
  const finish = s?.finish
    ? new Date(`${s.finish}T12:00:00`).toLocaleDateString(undefined, { dateStyle: "long" })
    : null;
  const tiles: [string, string, string?][] = s
    ? [
        [
          "Slides per hour",
          s.per_hour ? String(s.per_hour) : "–",
          s.per_hour ? `over ${s.hours_worked} h of work` : "develop a few more",
        ],
        [
          "Done",
          `${n(s.slides.done)} of ${n(s.target)}`,
          `${Math.min(100, Math.round((s.slides.done / s.target) * 100))} %`,
        ],
        [
          "Projected finish",
          s.remaining === 0 ? "Done!" : (finish ?? "–"),
          s.remaining === 0
            ? ""
            : s.per_day
              ? `at ${s.per_day} slides a day (last 2 weeks)`
              : "no slides in the last 2 weeks",
        ],
        ["Work left", s.hours_left !== null ? `${s.hours_left} h` : "–", `${n(s.remaining)} slides`],
        ["Trays", `${s.trays.open} open`, `${s.trays.finished} of ${s.trays.total} in Immich`],
        [
          "Still to scan",
          s.trays_to_scan !== null ? plural(s.trays_to_scan, "tray") : "–",
          `${n(Math.max(0, s.target - s.slides.total))} slides not imported yet`,
        ],
        ["Today", String(s.today), `${s.last_7_days} in the last 7 days`],
        ["In the library", n(s.slides.total), `${n(s.slides.to_develop)} to develop · ${n(s.slides.skipped)} skipped`],
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Stats</DialogTitle>
          <DialogDescription>
            Across every tray in the library. Time between slides counts up to 10 minutes; longer is a break.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-2" aria-busy={!s}>
          {tiles.map(([label, value, note]) => (
            <div key={label} className="rounded-md border border-(--ss-line-soft) bg-(--ss-panel) px-3 py-2">
              <dt className="text-[11px] text-muted-foreground">{label}</dt>
              <dd className="text-[18px] leading-6 font-semibold tabular-nums">{value}</dd>
              {note && <dd className="text-[11px] text-(--ss-dim)">{note}</dd>}
            </div>
          ))}
        </dl>
        <form onSubmit={saveTarget} className="flex items-end gap-1.5">
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="stats-target">Target: slides to digitise in all</FieldLabel>
            <Input
              id="stats-target"
              inputMode="numeric"
              value={target}
              onChange={(e) => setTarget(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Button type="submit" disabled={!s || !Number(target) || Number(target) === s.target}>
            Set
          </Button>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button className={primary}>Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Keyboard</DialogTitle>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto scrollbar-thin">
          <table className="w-full text-[12px]">
            <tbody>
              {SHORTCUTS.map(([keys, what], i) => (
                <tr key={i} className="border-b border-(--ss-line-soft) last:border-0">
                  <td className="py-1.5 pr-4 whitespace-nowrap">{keys}</td>
                  <td className="py-1.5 text-foreground/75">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button className={primary}>Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
