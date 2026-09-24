// Look-alikes (desktop app only): what the CLIP embeddings say about slides that belong together —
// the same shot taken twice, a bracket that may be two slides, two slides that may be one — and
// photos already in Immich that look like an uploaded slide. Suggestions only, like the tags.
import * as React from "react";
import { Check, Combine, RefreshCw, Scissors, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/tip";
import { immichThumbUrl, plural, previewUrl, type Group, type SessionPayload, type SimilarSuggestion } from "@/lib/api";
import type { SlideStation } from "@/hooks/use-slide-station";
import { cn } from "@/lib/utils";

const pct = (c: number) => `${Math.round(c * 100)}%`;
const numbers = (ns: number[]) =>
  ns.length > 1 ? `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}` : String(ns[0] ?? "");

/** Every open look-alike suggestion of the tray, or only those about slide `gid`. */
export function similarSuggestions(session: SessionPayload, gid?: string): SimilarSuggestion[] {
  const s = session.similar;
  if (!s) return [];
  const all = [...s.duplicates, ...s.split, ...s.merge];
  return gid ? all.filter((x) => x.groups.includes(gid)) : all;
}

/** A slide's open look-alikes in Immich. */
export const openLookalikes = (g: Group) => (g.lookalike?.matches ?? []).filter((m) => m.state === "suggested");

/** One line for the collapsed Insights section, or "" when there's nothing like that. */
export function similarNote(g: Group, session: SessionPayload) {
  const bits: string[] = similarSuggestions(session, g.id).map((x) =>
    x.kind === "duplicates" ? "same shot as others" : x.kind === "split" ? "two slides?" : "merge?",
  );
  if (openLookalikes(g).length) bits.push("already in Immich?");
  return bits.join(" · ");
}

/** The suggestion as a card: what it says, the slides it is about, and its one-click action. */
function SimilarCard({
  sug,
  app,
  session,
  sessionId,
  onGo,
}: {
  sug: SimilarSuggestion;
  app: SlideStation;
  session: SessionPayload;
  sessionId: string;
  /** Go to a slide (the review dialog closes itself too). */
  onGo?: (index: number) => void;
}) {
  const byId = new Map(session.groups.map((g) => [g.id, g]));
  const groups = sug.groups.map((id) => byId.get(id)).filter((g): g is Group => !!g);
  const [keep, setKeep] = React.useState(sug.best ?? "");
  React.useEffect(() => setKeep(sug.best ?? ""), [sug.id, sug.best]);
  const n = (id: string) => (byId.get(id)?.index ?? 0) + 1;
  const nums = groups.map((g) => g.index + 1);
  const title =
    sug.kind === "duplicates"
      ? `Slides ${numbers(nums)} look like the same shot`
      : sug.kind === "split"
        ? `Slide ${nums[0]}: from scan ${(groups[0]?.scans.indexOf(sug.scan ?? "") ?? 0) + 1} on it may be another slide`
        : `Slides ${numbers(nums)} look like one slide at two exposures`;
  const others = sug.groups.filter((id) => id !== keep).map(n);
  return (
    <section className="ss-pile" aria-label={title}>
      <header className="flex items-start gap-2">
        <b className="min-w-0 flex-1 text-[12px] font-semibold">
          {title}
          <Tip label={`${pct(sug.confidence)} sure (${sug.source})`}>
            <span
              className="ss-confidence ml-2 inline-block align-middle"
              style={{ "--c": sug.confidence } as React.CSSProperties}
            >
              {pct(sug.confidence)}
            </span>
          </Tip>
        </b>
      </header>
      <div className="flex flex-wrap gap-1.5">
        {groups.map((g) => (
          <span key={g.id} className="ss-pile-slide">
            <button
              type="button"
              aria-label={sug.kind === "duplicates" ? `Keep slide ${g.index + 1}` : `Go to slide ${g.index + 1}`}
              aria-pressed={sug.kind === "duplicates" ? keep === g.id : undefined}
              className={cn(sug.kind === "duplicates" && keep === g.id && "ss-keep")}
              onClick={() => (sug.kind === "duplicates" ? setKeep(g.id) : onGo?.(g.index))}
              onDoubleClick={() => onGo?.(g.index)}
            >
              <img src={previewUrl(sessionId, g, 320)} alt="" loading="lazy" draggable={false} />
              <span>
                {g.index + 1}
                {sug.kind === "duplicates" && (keep === g.id ? " · keep" : " · skip")}
              </span>
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {sug.kind === "duplicates" ? (
          <Tip label="Skipped slides aren't uploaded; X on one brings it back. Click a photo to keep that one instead.">
            <Button
              size="sm"
              className="bg-primary text-primary-foreground"
              onClick={() => app.decideSimilar("duplicates", "accept", sug.id, keep)}
            >
              <Check /> Keep {n(keep)}
              {keep === sug.best && groups.length > 1 ? " (sharpest)" : ""}, skip {numbers(others)}
            </Button>
          </Tip>
        ) : sug.kind === "split" ? (
          <Button
            size="sm"
            className="bg-primary text-primary-foreground"
            onClick={() => app.decideSimilar("split", "accept", sug.id)}
          >
            <Scissors /> Split into two slides
          </Button>
        ) : (
          <Button
            size="sm"
            className="bg-primary text-primary-foreground"
            onClick={() => app.decideSimilar("merge", "accept", sug.id)}
          >
            <Combine /> Merge into one slide
          </Button>
        )}
        <Tip label="It won't be suggested again">
          <Button size="sm" variant="outline" onClick={() => app.decideSimilar(sug.kind, "dismiss", sug.id)}>
            <X /> {sug.kind === "duplicates" ? "Not the same" : "Leave as is"}
          </Button>
        </Tip>
      </div>
    </section>
  );
}

/** The look-alike part of the Insights section: this slide's tray-level suggestions and Immich look-alikes. */
export function SimilarPanel({
  app,
  session,
  sessionId,
}: {
  app: SlideStation;
  session: SessionPayload;
  sessionId: string;
}) {
  const g = app.current!;
  const sugs = similarSuggestions(session, g.id);
  const look = g.lookalike;
  const matches = openLookalikes(g);
  if (!sugs.length && !matches.length && look?.state !== "pending") return null;
  return (
    <div className="flex flex-col gap-2">
      {sugs.map((s) => (
        <SimilarCard key={s.id} sug={s} app={app} session={session} sessionId={sessionId} onGo={app.select} />
      ))}
      {matches.map((m) => (
        <section key={m.id} className="ss-pile" aria-label="Already in Immich?">
          <header className="flex items-start gap-2">
            <b className="min-w-0 flex-1 text-[12px] font-semibold">
              Looks like a photo already in Immich
              <Tip label={`${pct(m.similarity)} alike (CLIP, compared on this computer)`}>
                <span
                  className="ss-confidence ml-2 inline-block align-middle"
                  style={{ "--c": m.similarity } as React.CSSProperties}
                >
                  {pct(m.similarity)}
                </span>
              </Tip>
            </b>
          </header>
          <div className="flex items-center gap-2">
            <img src={immichThumbUrl(m.id)} alt="" className="h-14 w-[76px] rounded object-cover" draggable={false} />
            <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
              <span className="block truncate text-foreground/90">{m.name || "A photo"}</span>
              {m.date}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Tip label="The old photo goes to Immich's trash; this slide joins its albums (and is a favourite if it was)">
              <Button
                size="sm"
                className="bg-primary text-primary-foreground"
                onClick={() => app.decideLookalike("accept", m.id)}
              >
                <Check /> Replace it
              </Button>
            </Tip>
            <Button size="sm" variant="outline" onClick={() => app.decideLookalike("dismiss", m.id)}>
              <X /> Keep both
            </Button>
          </div>
        </section>
      ))}
      {look?.state === "pending" && (
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="flex-1">Immich hasn't indexed this upload yet, so look-alikes weren't checked.</span>
          <Tip label="Check this tray's uploads against Immich again">
            <Button size="sm" variant="outline" onClick={() => app.checkLookalikes()}>
              <RefreshCw /> Check
            </Button>
          </Tip>
        </p>
      )}
    </div>
  );
}

/** The tray's look-alike suggestions for the review dialog. */
export function SimilarReview({
  app,
  session,
  sessionId,
  onGo,
}: {
  app: SlideStation;
  session: SessionPayload;
  sessionId: string;
  onGo: (index: number) => void;
}) {
  const sugs = similarSuggestions(session);
  const looks = session.groups.filter((g) => openLookalikes(g).length);
  if (!sugs.length && !looks.length) return null;
  return (
    <>
      {sugs.map((s) => (
        <SimilarCard key={s.id} sug={s} app={app} session={session} sessionId={sessionId} onGo={onGo} />
      ))}
      {!!looks.length && (
        <section className="ss-pile" aria-label="Already in Immich?">
          <header className="text-[12px] font-semibold">
            {plural(looks.length, "slide")} may already be in Immich
            <span className="ml-2 font-normal text-muted-foreground">
              open one to replace the old photo or keep both
            </span>
          </header>
          <div className="flex flex-wrap gap-1.5">
            {looks.map((g) => (
              <span key={g.id} className="ss-pile-slide">
                <button type="button" aria-label={`Go to slide ${g.index + 1}`} onClick={() => onGo(g.index)}>
                  <img src={previewUrl(sessionId, g, 320)} alt="" loading="lazy" draggable={false} />
                  <span>
                    {g.index + 1} · {pct(openLookalikes(g)[0].similarity)}
                  </span>
                </button>
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
