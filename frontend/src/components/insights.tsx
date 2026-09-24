// Insights: what the models suggest about a slide — scene tags and a caption — shown as suggestions
// to accept (a caption after editing it) or dismiss, never applied silently. The browser version
// hides the model parts (they would need onnxruntime-web); the film stock and date guesses need no
// model and work in both.
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tip } from "@/components/tip";
import { rangeEnd } from "@/components/dialogs";
import {
  plural,
  placeLabel,
  previewUrl,
  standalone,
  STOCK_NAMES,
  STOCKS,
  type Group,
  type InsightKind,
  type Place,
  type SessionPayload,
  type Suggestion,
  type SuggestionModel,
} from "@/lib/api";
import type { SlideStation } from "@/hooks/use-slide-station";
import { SimilarPanel, SimilarReview, openLookalikes, similarNote, similarSuggestions } from "@/components/similar";

const pct = (c: number) => `${Math.round(c * 100)}%`;

/** Film stock and date guesses need no model: the Details section shows them, in both versions. */
const MODEL_FREE = (kind: InsightKind, e: Suggestion) =>
  kind === "stock" || (kind === "date" && e.source === "neighbours+stock");

/** Where a suggestion comes from, in words. */
export function whySuggested(e: Suggestion) {
  const from = e.source === "tray" ? "neighbours" : e.source.startsWith("ppocr") ? "text in the photo" : e.source;
  return e.text ? `${from}: ${e.source === "tray" ? e.text : `“${e.text}”`}` : from;
}

/** A slide's open suggestions, tags first; `models`: only what the models suggested. A caption is
 *  never offered over the slide's own. */
export function openSuggestions(g: Group, models = false): [InsightKind, Suggestion][] {
  const ins = g.insights;
  if (!ins) return [];
  const out: [InsightKind, Suggestion][] = ins.tags.filter((e) => e.state === "suggested").map((e) => ["tags", e]);
  for (const k of ["caption", "date", "place", "stock"] as const) {
    const e = ins[k];
    if (e?.state === "suggested" && !(models && MODEL_FREE(k, e)) && !(k === "caption" && g.caption)) out.push([k, e]);
  }
  return out;
}

/** How a suggested value reads: film stocks by name. */
export const shown = (kind: InsightKind, value: string) => (kind === "stock" ? (STOCK_NAMES[value] ?? value) : value);

const MODEL_NAMES: Record<SuggestionModel, string> = { tags: "tag model", captions: "caption model" };
const modelNames = (m: SuggestionModel[] | undefined) => (m ?? []).map((k) => MODEL_NAMES[k]).join(" and ");

/** One line for the collapsed Insights section. */
export function insightsNote(g: Group, session: SessionPayload) {
  const st = session.insights;
  if (!st?.enabled) return "off";
  if (!st.ready) return "model not downloaded";
  if (g.skip) return "skipped";
  if (!g.insights || g.insights.stale) return "analysing…";
  const open = openSuggestions(g, true).map(([, e]) => e.value);
  const alike = similarNote(g, session);
  return [...open, ...(alike ? [alike] : [])].join(" · ") || "nothing new";
}

/** This slide's suggestions, with accept / dismiss, and the way to the tray's review. */
export function InsightsPanel({
  app,
  session,
  sessionId,
  downloading,
  ocrDownloading,
  onAccepted,
  onReview,
  onSettings,
}: {
  app: SlideStation;
  session: SessionPayload;
  sessionId: string;
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
          Suggest tags (beach, snow, wedding…) and a one-line caption for each slide from what's in the photo. Runs on
          this computer.
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
          {downloading
            ? "Downloading — progress is at the top."
            : `The ${modelNames(st.missing) || "model"} isn't downloaded yet.`}
        </p>
        {!downloading && (
          <ProButton onClick={app.downloadModel}>
            <Download /> Download model
          </ProButton>
        )}
      </div>
    );
  }
  const open = openSuggestions(g, true);
  const decided = (g.insights?.tags ?? []).filter((e) => e.state !== "suggested").length;
  const accept = async (kind: InsightKind, value: string, text?: string) => {
    const p = await app.decide(kind, "accept", value, [g.id], text);
    if (p?.decided) onAccepted(kind, text ?? value, p.groups, g.index);
  };
  const dismiss = (kind: InsightKind, value: string) => app.decide(kind, "dismiss", value, [g.id]);
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
          {open.map(([kind, e]) =>
            kind === "caption" ? (
              <CaptionSuggestion
                key={`${g.id}:caption:${e.value}`}
                e={e}
                onAccept={(text) => accept("caption", e.value, text)}
                onDismiss={() => dismiss("caption", e.value)}
              />
            ) : (
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
                  <button type="button" aria-label={`Dismiss ${e.value}`} onClick={() => dismiss(kind, e.value)}>
                    <X />
                  </button>
                </Tip>
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className={note}>No open suggestions for this slide{decided ? ` (${decided} decided)` : ""}.</p>
      )}
      <SimilarPanel app={app} session={session} sessionId={sessionId} />
      {!!st.missing?.length && (
        <p className={note}>
          The {modelNames(st.missing)} isn't downloaded yet
          {downloading ? " (downloading)." : "."}{" "}
          {!downloading && (
            <button type="button" className="underline underline-offset-2" onClick={app.downloadModel}>
              Download
            </button>
          )}
        </p>
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

/**
 * A suggested caption, editable in place: Enter (or ✓) makes the text as it stands the slide's caption,
 * Escape puts the model's words back, × dismisses it for this slide.
 */
function CaptionSuggestion({
  e,
  onAccept,
  onDismiss,
}: {
  e: Suggestion;
  onAccept: (text: string) => void;
  onDismiss: () => void;
}) {
  const [draft, setDraft] = React.useState(e.value);
  const text = draft.trim().replace(/\s+/g, " ");
  return (
    <li className="ss-suggestion ss-caption-suggestion">
      <textarea
        aria-label="Suggested caption"
        value={draft}
        rows={2}
        maxLength={2000}
        spellCheck
        onChange={(ev) => setDraft(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            if (text) onAccept(text);
          }
          if (ev.key === "Escape") setDraft(e.value);
        }}
      />
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          caption{text !== e.value ? " · edited" : ""}
        </span>
        <Tip label={`${pct(e.confidence)} sure (${e.source})`}>
          <span className="ss-confidence" style={{ "--c": e.confidence } as React.CSSProperties}>
            {pct(e.confidence)}
          </span>
        </Tip>
        <Tip label="Use as the slide's caption (goes to Immich as the description)">
          <button type="button" aria-label="Accept caption" disabled={!text} onClick={() => onAccept(text)}>
            <Check />
          </button>
        </Tip>
        <Tip label="Dismiss: it won't be suggested for this slide again">
          <button type="button" aria-label="Dismiss caption" onClick={onDismiss}>
            <X />
          </button>
        </Tip>
      </div>
    </li>
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

// ------------------------------------------------------------------ film stock (no model: both versions)

const whyStock = (source: string) =>
  source.startsWith("knn:")
    ? `like the ${source.slice(4)} closest slides you set a film stock for`
    : "a guess from how the colours faded (red / magenta: Ektachrome, cyan: Agfachrome, unfaded: Kodachrome)";

/** One open suggestion with its confidence, ✓ and ×, for the Details section. */
export function SuggestionRow({
  label,
  e,
  why,
  onAccept,
  onDismiss,
}: {
  label: React.ReactNode;
  e: Suggestion;
  why: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="ss-suggestion" role="group" aria-label="Suggestion">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Tip label={`${pct(e.confidence)} sure: ${why}`}>
        <span className="ss-confidence" style={{ "--c": e.confidence } as React.CSSProperties}>
          {pct(e.confidence)}
        </span>
      </Tip>
      <Tip label="Accept">
        <button type="button" aria-label={`Accept ${e.value}`} onClick={onAccept}>
          <Check />
        </button>
      </Tip>
      <Tip label="Dismiss: it won't be suggested for this slide again">
        <button type="button" aria-label={`Dismiss ${e.value}`} onClick={onDismiss}>
          <X />
        </button>
      </Tip>
    </div>
  );
}

/**
 * The slide's film stock: its own, or the tray's (the first option), plus the guess when it has
 * none. Accepting offers it to the neighbours; a set stock can be given to a range of slides.
 */
export function StockField({
  g,
  trayStock,
  onChange,
  onDecide,
  onRange,
}: {
  g: Group;
  trayStock: string;
  onChange: (stock: string) => void;
  onDecide: (action: "accept" | "dismiss", value: string) => void;
  /** Give this stock to a run of slides (the propagate dialog). */
  onRange: (stock: string) => void;
}) {
  const id = React.useId();
  const e = g.insights?.stock;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-muted-foreground">
        Film stock
      </label>
      <div className="flex items-center gap-1.5">
        <NativeSelect id={id} value={g.stock} onChange={(ev) => onChange(ev.target.value)} className="min-w-[150px]">
          <NativeSelectOption value="">
            {trayStock ? `Tray's: ${STOCK_NAMES[trayStock]}` : "Not set"}
          </NativeSelectOption>
          {STOCKS.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {STOCK_NAMES[s]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {!!g.stock && g.stock !== "unknown" && (
          <Tip label="Give this film stock to a run of slides">
            <ProButton plain aria-label="Film stock for a range" onClick={() => onRange(g.stock)}>
              <ListChecks />
            </ProButton>
          </Tip>
        )}
      </div>
      {e?.state === "suggested" && (
        <SuggestionRow
          label={
            <>
              <span className="text-muted-foreground">Looks like </span>
              {shown("stock", e.value)}
            </>
          }
          e={e}
          why={whyStock(e.source)}
          onAccept={() => onDecide("accept", e.value)}
          onDismiss={() => onDecide("dismiss", e.value)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ tray review

type Pile = { kind: InsightKind; value: string; items: { g: Group; e: Suggestion }[] };

/** Open suggestions of the tray, one pile per kind + value, biggest first. Captions are all different:
 *  they make one pile (value ""), each slide with its own words. */
export function suggestionPiles(groups: Group[]): Pile[] {
  const piles = new Map<string, Pile>();
  for (const g of groups) {
    if (g.skip) continue;
    for (const [kind, e] of openSuggestions(g)) {
      const value = kind === "caption" ? "" : e.value;
      const k = `${kind}:${value}`;
      const p = piles.get(k) ?? { kind, value, items: [] };
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
  const alike = similarSuggestions(session).length + session.groups.filter((g) => openLookalikes(g).length).length;
  const pending = session.insights?.pending ?? 0;
  const go = (index: number) => {
    app.select(index);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Review suggestions</DialogTitle>
          <DialogDescription>
            {piles.length || alike
              ? "Accept a suggestion for every slide it was made for, or dismiss slides that don't fit first (×)."
              : "Nothing left to review in this tray."}
            {pending ? ` Still analysing (${pending} to go).` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-1 scrollbar-thin">
          <SimilarReview app={app} session={session} sessionId={sessionId} onGo={go} />
          {piles.map((p) => (
            <section
              key={`${p.kind}:${p.value}`}
              aria-label={`${p.kind === "caption" ? "Captions" : shown(p.kind, p.value)}, ${plural(p.items.length, "slide")}`}
              className="ss-pile"
            >
              <header className="flex items-center gap-2">
                <b className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                  {p.kind === "caption" ? (
                    "Captions"
                  ) : (
                    <>
                      {p.kind !== "tags" && (
                        <span className="font-normal text-muted-foreground">
                          {p.kind === "stock" ? "film" : p.kind}:{" "}
                        </span>
                      )}
                      {shown(p.kind, p.value)}
                    </>
                  )}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {plural(p.items.length, "slide")} · ≈
                    {pct(p.items.reduce((s, x) => s + x.e.confidence, 0) / p.items.length)}
                  </span>
                </b>
                <Button size="sm" variant="outline" onClick={() => app.decide(p.kind, "dismiss", p.value || undefined)}>
                  Dismiss all
                </Button>
                <Button
                  size="sm"
                  className="bg-primary text-primary-foreground"
                  onClick={() => app.decide(p.kind, "accept", p.value || undefined)}
                >
                  Accept all
                </Button>
              </header>
              <div className={p.kind === "caption" ? "flex flex-col gap-1.5" : "flex flex-wrap gap-1.5"}>
                {p.items.map(({ g, e }) => (
                  <span key={g.id} className={p.kind === "caption" ? "ss-pile-slide ss-pile-caption" : "ss-pile-slide"}>
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
                    {p.kind === "caption" && <span>{e.value}</span>}
                    <button
                      type="button"
                      className="ss-pile-dismiss"
                      aria-label={`Dismiss ${p.value || "the caption"} for slide ${g.index + 1}`}
                      onClick={() => app.decide(p.kind, "dismiss", e.value, [g.id])}
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
          {standalone ? (
            <span /> // the browser version has no models to run again: film stock and dates only
          ) : (
            <Tip label="Analyse every slide again (what you accepted or dismissed stays)">
              <Button variant="outline" onClick={() => app.analyseTray(true)}>
                <RefreshCw /> Analyse again
              </Button>
            </Tip>
          )}
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

/** A value confirmed on one slide, offered to slides from..to (0-based). A place's `value` is how it
 *  reads, `place` the place itself. `pick`: the user chooses what to apply (a scene of the tray: "give
 *  slides 12–31 …"), `label` names the run. */
export type Offer = {
  kind: "tags" | "caption" | "date" | "stock" | "place";
  value: string;
  place?: Place;
  from: number;
  to: number;
  pick?: boolean;
  label?: string;
};

const holds = (g: Group, kind: Offer["kind"], value: string) =>
  kind === "tags"
    ? g.tags.includes(value)
    : kind === "date"
      ? g.date === value
      : kind === "stock"
        ? g.stock === value
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
 * The run of slides around `i` to offer a confirmed tag / caption / date / film stock to:
 * neighbours that have it or were suggested it (a date: up to the next slide with its own date,
 * like "Date a range"). With nothing around saying so, just the next slide. Null when every slide
 * in the run has it.
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
  const [kind, setKind] = React.useState<Offer["kind"]>("tags");
  const [value, setValue] = React.useState("");
  React.useEffect(() => {
    if (!offer) return;
    setFrom(String(offer.from + 1));
    setTo(String(offer.to + 1));
    setKind(offer.kind);
    setValue(offer.value);
  }, [offer]);
  const a = Number(from);
  const b = Number(to);
  const valid = Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= 1 && a <= n && b <= n && !!value.trim();
  const count = valid ? Math.abs(b - a) + 1 : 0;
  const what =
    kind === "tags"
      ? `the tag “${value}”`
      : kind === "date" || kind === "place"
        ? value
        : kind === "stock"
          ? shown("stock", value)
          : "this caption";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // a place goes as the place itself (its value is only how it reads)
    const v = kind === "place" ? (offer?.place ?? value) : value.trim();
    if (offer && valid && (await onApply(kind, v, a - 1, b - 1))) onOpenChange(false);
  };
  return (
    <Dialog open={!!offer} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={submit} className="grid gap-[18px]">
          <DialogHeader>
            <DialogTitle>
              {offer?.pick
                ? `Give ${offer.label || "these slides"} a tag, date or caption`
                : `Apply ${what} to more slides`}
            </DialogTitle>
            <DialogDescription>
              {offer?.pick
                ? "A tag is added to every slide in the range; a date or caption replaces theirs."
                : kind === "tags"
                  ? "Every slide in the range gets the tag."
                  : kind === "date"
                    ? "Every slide in the range gets this date as its own."
                    : kind === "stock"
                      ? "Every slide in the range gets this film stock as its own."
                      : kind === "place"
                        ? "Every slide in the range gets this place (their map position in Immich)."
                        : `“${value}” replaces the captions of the slides in the range.`}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            {offer?.pick && (
              <div className="grid grid-cols-[110px_1fr] gap-3">
                <Field>
                  <FieldLabel htmlFor="pr-kind">What</FieldLabel>
                  <NativeSelect id="pr-kind" value={kind} onChange={(e) => setKind(e.target.value as Offer["kind"])}>
                    <NativeSelectOption value="tags">Tag</NativeSelectOption>
                    <NativeSelectOption value="date">Date</NativeSelectOption>
                    <NativeSelectOption value="caption">Caption</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="pr-value">
                    {kind === "tags" ? "Tag" : kind === "date" ? "Date" : "Caption"}
                  </FieldLabel>
                  <Input
                    id="pr-value"
                    autoFocus
                    value={value}
                    placeholder={
                      kind === "tags" ? "e.g. lake garda" : kind === "date" ? "e.g. 1978-08" : "e.g. Summer in Italy"
                    }
                    onChange={(e) => setValue(e.target.value)}
                  />
                </Field>
              </div>
            )}
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
                  autoFocus={!offer?.pick}
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
