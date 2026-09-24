// Insights (desktop app only): what the models suggest about a slide — scene tags today — shown as
// suggestions to accept or dismiss, never applied silently. The browser version hides all of it
// (its models would need onnxruntime-web).
import * as React from "react";
import { Check, Download, ListChecks, Plus, RefreshCw, Settings, X } from "lucide-react";
import { ProButton } from "@/components/ui/pro-button";
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
import { Tip } from "@/components/tip";
import { rangeEnd } from "@/components/dialogs";
import {
  plural,
  placeLabel,
  previewUrl,
  type Group,
  type InsightKind,
  type Place,
  type SessionPayload,
  type Suggestion,
} from "@/lib/api";
import type { SlideStation } from "@/hooks/use-slide-station";

const pct = (c: number) => `${Math.round(c * 100)}%`;

/** Where a suggestion comes from, in words. */
export function whySuggested(e: Suggestion) {
  const from = e.source === "tray" ? "neighbours" : e.source.startsWith("ppocr") ? "text in the photo" : e.source;
  return e.text ? `${from}: ${e.source === "tray" ? e.text : `“${e.text}”`}` : from;
}

/** A slide's open suggestions, tags first. */
export function openSuggestions(g: Group): [InsightKind, Suggestion][] {
  const ins = g.insights;
  if (!ins) return [];
  const out: [InsightKind, Suggestion][] = ins.tags.filter((e) => e.state === "suggested").map((e) => ["tags", e]);
  for (const k of ["caption", "date", "place"] as const) {
    const e = ins[k];
    if (e?.state === "suggested") out.push([k, e]);
  }
  return out;
}

/** One line for the collapsed Insights section. */
export function insightsNote(g: Group, session: SessionPayload) {
  const st = session.insights;
  if (!st?.enabled) return "off";
  if (!st.ready) return "model not downloaded";
  if (g.skip) return "skipped";
  if (!g.insights || g.insights.stale) return "analysing…";
  const open = openSuggestions(g);
  return open.length ? open.map(([, e]) => e.value).join(" · ") : "nothing new";
}

/** This slide's suggestions, with accept / dismiss, and the way to the tray's review. */
export function InsightsPanel({
  app,
  session,
  downloading,
  ocrDownloading,
  onAccepted,
  onReview,
  onSettings,
}: {
  app: SlideStation;
  session: SessionPayload;
  /** The model download job is running. */
  downloading: boolean;
  /** The text reader download (place suggestions from signs) is running. */
  ocrDownloading?: boolean;
  /** A suggestion was accepted on slide `index`: offer it to the neighbours (`groups`: the tray after). */
  onAccepted: (kind: InsightKind, value: string, groups: Group[], index: number) => void;
  onReview: () => void;
  onSettings: () => void;
}) {
  const g = app.current!;
  const st = session.insights;
  const note = "text-[12px] text-muted-foreground";
  if (!st?.enabled) {
    return (
      <div className="flex flex-col items-start gap-2 px-3 pt-2.5 pb-3">
        <p className={note}>
          Suggest tags for each slide from what's in the photo (beach, snow, wedding…). Runs on this computer.
        </p>
        <ProButton onClick={onSettings}>
          <Settings /> Turn on in Settings
        </ProButton>
      </div>
    );
  }
  if (!st.ready) {
    return (
      <div className="flex flex-col items-start gap-2 px-3 pt-2.5 pb-3">
        <p className={note}>
          {downloading ? "Downloading the tag model — progress is at the top." : "The tag model isn't downloaded yet."}
        </p>
        {!downloading && (
          <ProButton onClick={app.downloadModel}>
            <Download /> Download model
          </ProButton>
        )}
      </div>
    );
  }
  const open = openSuggestions(g);
  const decided = (g.insights?.tags ?? []).filter((e) => e.state !== "suggested").length;
  const accept = async (kind: InsightKind, value: string) => {
    const p = await app.decide(kind, "accept", value, [g.id]);
    if (p?.decided) onAccepted(kind, value, p.groups, g.index);
  };
  return (
    <div className="flex flex-col gap-2 px-3 pt-2.5 pb-3">
      {g.skip ? (
        <p className={note}>Skipped slides aren't analysed.</p>
      ) : !g.insights || g.insights.stale ? (
        <p className={note}>Analysing… {st.pending > 1 ? `${plural(st.pending, "slide")} to go in this tray` : ""}</p>
      ) : g.insights.error ? (
        <p className={note}>Couldn't analyse this slide: {g.insights.error}</p>
      ) : open.length ? (
        <ul className="flex flex-col gap-1" aria-label="Suggestions">
          {open.map(([kind, e]) => (
            <li key={`${kind}:${e.value}`} className="ss-suggestion">
              <span className="min-w-0 flex-1 truncate">
                {kind !== "tags" && <span className="text-muted-foreground">{kind}: </span>}
                {e.value}
              </span>
              <Tip label={`${pct(e.confidence)} sure (${whySuggested(e)})`}>
                <span className="ss-confidence" style={{ "--c": e.confidence } as React.CSSProperties}>
                  {pct(e.confidence)}
                </span>
              </Tip>
              <Tip label={kind === "tags" ? "Add this tag to the slide" : `Use as the slide's ${kind}`}>
                <button type="button" aria-label={`Accept ${e.value}`} onClick={() => accept(kind, e.value)}>
                  <Check />
                </button>
              </Tip>
              <Tip label="Dismiss: it won't be suggested for this slide again">
                <button
                  type="button"
                  aria-label={`Dismiss ${e.value}`}
                  onClick={() => app.decide(kind, "dismiss", e.value, [g.id])}
                >
                  <X />
                </button>
              </Tip>
            </li>
          ))}
        </ul>
      ) : (
        <p className={note}>No open suggestions for this slide{decided ? ` (${decided} decided)` : ""}.</p>
      )}
      {session.places && !session.places.ocr && !g.skip && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {ocrDownloading ? (
            "Downloading the text reader — progress is at the top."
          ) : (
            <>
              <span>Suggest places from signs in the photo (~{session.places.ocr_mb} MB).</span>
              <ProButton plain onClick={() => app.downloadPlaces(true)}>
                <Download /> Download
              </ProButton>
            </>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <ProButton onClick={onReview}>
          <ListChecks /> Review tray…
        </ProButton>
        {!!open.length && open.every(([k]) => k === "tags") && (
          <Tip label="Add every suggested tag to this slide">
            <ProButton plain onClick={() => app.decide("tags", "accept", undefined, [g.id])}>
              Accept all
            </ProButton>
          </Tip>
        )}
      </div>
    </div>
  );
}

/** The slide's own tags: chips to remove, a field to add. Read-only in the browser version. */
export function TagsField({
  tags,
  onChange,
  readOnly,
}: {
  tags: string[];
  onChange: (t: string[]) => void;
  readOnly?: boolean;
}) {
  const [draft, setDraft] = React.useState("");
  const id = React.useId();
  if (readOnly && !tags.length) return null;
  const add = () => {
    const t = draft.trim().toLowerCase().replace(/\s+/g, " ");
    setDraft("");
    if (t && !tags.includes(t)) onChange([...tags, t]);
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-muted-foreground">
        Tags
      </label>
      <div className="flex flex-wrap items-center gap-1">
        {tags.map((t) => (
          <span key={t} className="ss-tag">
            {t}
            {!readOnly && (
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => onChange(tags.filter((x) => x !== t))}
              >
                <X />
              </button>
            )}
          </span>
        ))}
        {!readOnly && (
          <span className="flex min-w-[120px] flex-1 items-center gap-1">
            <Input
              id={id}
              className="h-7"
              value={draft}
              placeholder={tags.length ? "Add a tag" : "e.g. beach — goes to Immich as a tag"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  add();
                }
                if (e.key === "Escape") {
                  setDraft("");
                  e.currentTarget.blur();
                }
              }}
              onBlur={add}
            />
            {draft.trim() && (
              <button
                type="button"
                aria-label="Add tag"
                className="ss-tag-add"
                onMouseDown={(e) => e.preventDefault()}
                onClick={add}
              >
                <Plus />
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tray review

type Pile = { kind: InsightKind; value: string; items: { g: Group; e: Suggestion }[] };

/** Open suggestions of the tray, one pile per kind + value, biggest first. */
export function suggestionPiles(groups: Group[]): Pile[] {
  const piles = new Map<string, Pile>();
  for (const g of groups) {
    if (g.skip) continue;
    for (const [kind, e] of openSuggestions(g)) {
      const k = `${kind}:${e.value}`;
      const p = piles.get(k) ?? { kind, value: e.value, items: [] };
      p.items.push({ g, e });
      piles.set(k, p);
    }
  }
  return [...piles.values()].sort((a, b) => b.items.length - a.items.length || a.value.localeCompare(b.value));
}

/**
 * Every open suggestion in the tray, grouped by what it suggests: accept or dismiss a whole pile
 * ("beach · 14 slides"), or dismiss single slides out of it first. Clicking a slide goes to it.
 */
export function ReviewDialog({
  open,
  onOpenChange,
  app,
  session,
  sessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: SlideStation;
  session: SessionPayload;
  sessionId: string;
}) {
  const piles = suggestionPiles(session.groups);
  const pending = session.insights?.pending ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Review suggestions</DialogTitle>
          <DialogDescription>
            {piles.length
              ? "Accept a suggestion for every slide it was made for, or dismiss slides that don't fit first (×)."
              : "Nothing left to review in this tray."}
            {pending ? ` ${plural(pending, "slide")} still being analysed.` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-1 scrollbar-thin">
          {piles.map((p) => (
            <section
              key={`${p.kind}:${p.value}`}
              aria-label={`${p.value}, ${plural(p.items.length, "slide")}`}
              className="ss-pile"
            >
              <header className="flex items-center gap-2">
                <b className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                  {p.kind !== "tags" && <span className="font-normal text-muted-foreground">{p.kind}: </span>}
                  {p.value}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {plural(p.items.length, "slide")} · ≈
                    {pct(p.items.reduce((s, x) => s + x.e.confidence, 0) / p.items.length)}
                  </span>
                </b>
                <Button size="sm" variant="outline" onClick={() => app.decide(p.kind, "dismiss", p.value)}>
                  Dismiss all
                </Button>
                <Button
                  size="sm"
                  className="bg-primary text-primary-foreground"
                  onClick={() => app.decide(p.kind, "accept", p.value)}
                >
                  Accept all
                </Button>
              </header>
              <div className="flex flex-wrap gap-1.5">
                {p.items.map(({ g, e }) => (
                  <span key={g.id} className="ss-pile-slide">
                    <button
                      type="button"
                      aria-label={`Go to slide ${g.index + 1}`}
                      onClick={() => {
                        app.select(g.index);
                        onOpenChange(false);
                      }}
                    >
                      <img src={previewUrl(sessionId, g, 320)} alt="" loading="lazy" draggable={false} />
                      <span>
                        {g.index + 1} · {pct(e.confidence)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ss-pile-dismiss"
                      aria-label={`Dismiss ${p.value} for slide ${g.index + 1}`}
                      onClick={() => app.decide(p.kind, "dismiss", p.value, [g.id])}
                    >
                      <X />
                    </button>
                  </span>
                ))}
              </div>
            </section>
          ))}
        </div>
        <DialogFooter className="sm:justify-between">
          <Tip label="Analyse every slide again (what you accepted or dismissed stays)">
            <Button variant="outline" onClick={() => app.analyseTray(true)}>
              <RefreshCw /> Analyse again
            </Button>
          </Tip>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Done
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ tray-level propagation

/** A value confirmed on one slide, offered to slides from..to (0-based). A place's `value` is how it reads. */
export type Offer = {
  kind: "tags" | "caption" | "date" | "place";
  value: string;
  place?: Place;
  from: number;
  to: number;
};

const holds = (g: Group, kind: Offer["kind"], value: string) =>
  kind === "tags"
    ? g.tags.includes(value)
    : kind === "date"
      ? g.date === value
      : kind === "place"
        ? !!g.place && placeLabel(g.place) === value
        : g.caption === value;

const suggests = (g: Group, kind: Offer["kind"], value: string) => {
  const ins = g.insights;
  if (!ins) return false;
  const es = kind === "tags" ? ins.tags : [ins[kind]];
  return es.some((e) => e && e.value === value && e.state !== "dismissed");
};

/**
 * The run of slides around `i` to offer a confirmed tag / caption / date to: neighbours that have
 * it or were suggested it (a date: up to the next slide with its own date, like "Date a range").
 * With nothing around saying so, just the next slide. Null when every slide in the run has it.
 */
export function propagationOffer(
  groups: Group[],
  i: number,
  kind: Offer["kind"],
  value: string,
  place?: Place,
): Offer | null {
  let a = i;
  let b = i;
  if (kind === "date") {
    b = rangeEnd(groups, i);
  } else {
    const near = (g: Group) => holds(g, kind, value) || suggests(g, kind, value);
    while (a > 0 && near(groups[a - 1])) a--;
    while (b < groups.length - 1 && near(groups[b + 1])) b++;
  }
  if (a === b) b = Math.min(i + 1, groups.length - 1);
  if (a === b) a = Math.max(0, i - 1);
  const missing = groups.slice(a, b + 1).filter((g) => !g.locked && !holds(g, kind, value)).length;
  return missing ? { kind, value, place, from: a, to: b } : null;
}

/** "Apply 'beach' to slides 12–31?" — the date-range dialog's pattern, for a tag, caption or date. */
export function PropagateDialog({
  offer,
  onOpenChange,
  count: n,
  onApply,
}: {
  offer: Offer | null;
  onOpenChange: (open: boolean) => void;
  count: number;
  onApply: (kind: Offer["kind"], value: string | Place, fromIndex: number, toIndex: number) => Promise<boolean>;
}) {
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  React.useEffect(() => {
    if (!offer) return;
    setFrom(String(offer.from + 1));
    setTo(String(offer.to + 1));
  }, [offer]);
  const a = Number(from);
  const b = Number(to);
  const valid = Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= 1 && a <= n && b <= n;
  const count = valid ? Math.abs(b - a) + 1 : 0;
  const what =
    offer?.kind === "tags"
      ? `the tag “${offer.value}”`
      : offer?.kind === "date" || offer?.kind === "place"
        ? offer.value
        : "this caption";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (offer && valid && (await onApply(offer.kind, offer.place ?? offer.value, a - 1, b - 1))) onOpenChange(false);
  };
  return (
    <Dialog open={!!offer} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={submit} className="grid gap-[18px]">
          <DialogHeader>
            <DialogTitle>Apply {what} to more slides</DialogTitle>
            <DialogDescription>
              {offer?.kind === "tags"
                ? "Every slide in the range gets the tag."
                : offer?.kind === "date"
                  ? "Every slide in the range gets this date as its own."
                  : offer?.kind === "place"
                    ? "Every slide in the range gets this place (their map position in Immich)."
                    : `“${offer?.value}” replaces the captions of the slides in the range.`}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="pr-from">From slide</FieldLabel>
                <Input
                  id="pr-from"
                  inputMode="numeric"
                  value={from}
                  onChange={(e) => setFrom(e.target.value.replace(/\D/g, ""))}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="pr-to">To slide</FieldLabel>
                <Input
                  id="pr-to"
                  inputMode="numeric"
                  autoFocus
                  value={to}
                  onChange={(e) => setTo(e.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>
            <FieldDescription>
              {valid
                ? `${plural(count, "slide")} of ${n}. Locked slides stay as they are.`
                : `Slide numbers go from 1 to ${n}.`}
            </FieldDescription>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" className="bg-primary text-primary-foreground" disabled={!valid}>
              Apply to {plural(count, "slide")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
