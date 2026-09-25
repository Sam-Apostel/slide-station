// People & Places: the faces found on the slides of every tray, grouped by likeness (people.py), and
// the places the slides were taken on a map (dating.atlas). Name someone once (named people go to
// Immich as tags, People/<name>) and give their birthday: with the age model (desktop app) the ages
// their faces look then date the slides they're on (dating.py). In both versions (the browser
// version runs the face model in the page; ages are the desktop app's).
import * as React from "react";
import { toast } from "sonner";
import { MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tip } from "@/components/tip";
import { PreviewImg } from "@/components/filmstrip";
import { AtlasMap } from "@/components/atlas-map";
import {
  api,
  placeLabel,
  plural,
  type AtlasPayload,
  type Job,
  type PeoplePayload,
  type Person,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const primary = "bg-primary text-primary-foreground";
const SHOWN = 14; // faces per person before "show all"
type Tab = "people" | "places";

export function PeopleDialog({
  open,
  onOpenChange,
  job,
  onSettings,
  onOpenSlide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The running job: the list reloads when a face search finishes. */
  job: Job | null;
  onSettings: () => void;
  /** Go to a slide (closes the dialog). */
  onOpenSlide: (sid: string, gid: string) => void;
}) {
  const [data, setData] = React.useState<PeoplePayload | null>(null);
  const [atlas, setAtlas] = React.useState<AtlasPayload | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [showOnce, setShowOnce] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>("people");
  const [who, setWho] = React.useState(""); // the map shows this person's places ("" = everyone's)

  const run = React.useCallback(async (p: Promise<PeoplePayload>) => {
    try {
      setData(await p);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const load = React.useCallback(() => run(api<PeoplePayload>("GET", "/api/people")), [run]);

  const searching = !!job && !job.finished && job.kind === "faces";
  React.useEffect(() => {
    if (open) {
      load();
      api<AtlasPayload>("GET", "/api/atlas").then(setAtlas, () => setAtlas(null));
    } else setSelected([]);
  }, [open, searching, load]);

  const start = async (path: string, what: string) => {
    try {
      await api("POST", path);
      toast(what);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const rename = (p: Person, name: string) =>
    name.trim() !== p.name && run(api("PATCH", `/api/people/${p.id}`, { name }));
  const setBirthday = (p: Person, birthday: string) =>
    birthday.trim() !== (p.birthday ?? "") && run(api("PATCH", `/api/people/${p.id}`, { birthday }));
  const remove = (p: Person, face: string) => run(api("POST", `/api/people/${p.id}/remove`, { faces: [face] }));
  const merge = async () => {
    const [into, ...rest] = [...selected].sort((a, b) => {
      // into the named one if there is one, else the biggest
      const pa = data!.people.find((p) => p.id === a)!;
      const pb = data!.people.find((p) => p.id === b)!;
      return +!pa.name - +!pb.name || pb.faces.length - pa.faces.length;
    });
    await run(api("POST", `/api/people/${into}/merge`, { people: rest }));
    setSelected([]);
  };
  const go = (sid: string, gid: string) => {
    onOpenChange(false);
    onOpenSlide(sid, gid);
  };

  const all = data?.people ?? [];
  const once = all.filter((p) => !p.name && p.faces.length === 1);
  const shown = showOnce ? all : all.filter((p) => !once.includes(p));
  // how many places each person is seen at, for the rows' map button
  const placesOf = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const pl of atlas?.places ?? [])
      for (const pid of new Set(pl.slides.flatMap((s) => s.people))) m.set(pid, (m.get(pid) ?? 0) + 1);
    return m;
  }, [atlas]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] flex-col sm:max-w-[900px]">
        <DialogHeader>
          <DialogTitle>People &amp; Places</DialogTitle>
          <DialogDescription>
            {tab === "people"
              ? "Faces on your slides, grouped by likeness across every tray. Name someone once — Immich gets the names as tags (People/<name>). A birthday lets the ages on their faces date the slides they're on."
              : "Where your slides were taken. Pick someone to see where they've been; click a place for its slides."}
          </DialogDescription>
        </DialogHeader>

        <div role="tablist" aria-label="View" className="flex gap-1 self-start rounded-md bg-(--ss-panel-2) p-0.5">
          {(["people", "places"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-[5px] px-3 py-1 text-[12px] text-muted-foreground",
                tab === t && "bg-(--ss-panel) text-foreground shadow-sm",
              )}
            >
              {t === "people" ? `People${all.length ? ` · ${all.length - once.length}` : ""}` : `Places${atlas?.places.length ? ` · ${atlas.places.length}` : ""}`}
            </button>
          ))}
        </div>

        {tab === "places" ? (
          <PlacesView atlas={atlas} people={all} who={who} onWho={setWho} onOpenSlide={go} />
        ) : data && !data.enabled ? (
          <p className="text-[12px] text-foreground/75">
            Recognising people is off.{" "}
            <Button variant="link" className="h-auto p-0 text-[12px]" onClick={onSettings}>
              Turn it on in Settings
            </Button>{" "}
            (it downloads a {data.model_mb} MB face model once).
          </p>
        ) : (
          data && (
            <>
              {(data.pending > 0 || searching) && (
                <div className="flex items-center gap-3 text-[12px]">
                  <span className="flex-1 text-foreground/75">
                    {searching
                      ? job!.message || "Looking for faces…"
                      : `${plural(data.pending, "slide")} not looked at yet${data.model ? "" : " (the face model is downloaded first)"}.`}
                  </span>
                  {!searching && (
                    <Button size="sm" onClick={() => start("/api/people/scan", "Looking for faces on every slide")}>
                      Find faces
                    </Button>
                  )}
                </div>
              )}
              <AgesNote data={data} onSettings={onSettings} />
              <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                {!all.length && (
                  <p className="py-6 text-center text-[12px] text-muted-foreground">No faces found yet.</p>
                )}
                <ul className="grid gap-2">
                  {shown.map((p) => (
                    <PersonRow
                      key={p.id}
                      person={p}
                      places={placesOf.get(p.id) ?? 0}
                      selected={selected.includes(p.id)}
                      onSelect={(on) => setSelected((s) => (on ? [...s, p.id] : s.filter((x) => x !== p.id)))}
                      onRename={(name) => rename(p, name)}
                      onBirthday={(b) => setBirthday(p, b)}
                      onRemove={(face) => remove(p, face)}
                      onOpenSlide={go}
                      onMap={() => (setWho(p.id), setTab("places"))}
                    />
                  ))}
                </ul>
                {once.length > 0 && (
                  <Button variant="link" className="mt-2 h-auto p-0 text-[12px]" onClick={() => setShowOnce((v) => !v)}>
                    {showOnce ? "Hide" : "Show"} {plural(once.length, "face")} seen only once
                  </Button>
                )}
              </div>
            </>
          )
        )}

        <DialogFooter className="items-center">
          {tab === "people" && selected.length >= 2 && (
            <Button onClick={merge} className="mr-auto">
              These {selected.length} are the same person
            </Button>
          )}
          {tab === "people" && data?.enabled && all.some((p) => p.name) && (
            <Tip label="Tags the slides already in Immich with the names on them">
              <Button variant="outline" onClick={() => start("/api/people/tag", "Sending the names to Immich")}>
                Send names to Immich
              </Button>
            </Tip>
          )}
          <DialogClose asChild>
            <Button className={primary}>Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the ages do for dating, and how well they're checked (desktop app: `data.ages`). */
function AgesNote({ data, onSettings }: { data: PeoplePayload; onSettings: () => void }) {
  const a = data.ages;
  if (!a) return null;
  const birthdays = data.people.filter((p) => p.birthday).length;
  let text: React.ReactNode;
  if (!a.enabled)
    text = (
      <>
        Birthdays can date your slides by how old people look on them.{" "}
        <Button variant="link" className="h-auto p-0 text-[12px]" onClick={onSettings}>
          Turn on ages in Settings
        </Button>{" "}
        (a {a.model_mb} MB model, once).
      </>
    );
  else if (!a.model) text = "The age model is downloaded with the next face search.";
  else if (!birthdays) text = "Give someone a birthday and their slides get a suggested year (Details → Date).";
  else if (!a.calibrated)
    text = `${plural(birthdays, "birthday")}. Date a few slides with them on it yourself and the ages get checked against those.`;
  else
    text = `${plural(birthdays, "birthday")}. Ages checked against ${plural(a.calibrated, "face")} on slides you dated: within about ±${Math.round(a.sigma * 100)} %${
      Math.abs(a.bias) >= 0.02 ? `, the model guessing ${a.bias < 0 ? "older" : "younger"} than people are by ~${Math.round(Math.abs(Math.expm1(a.bias)) * 100)} %` : ""
    }.`;
  return <p className="text-[12px] text-foreground/75">{text}</p>;
}

function PersonRow({
  person: p,
  places,
  selected,
  onSelect,
  onRename,
  onBirthday,
  onRemove,
  onOpenSlide,
  onMap,
}: {
  person: Person;
  places: number;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onRename: (name: string) => void;
  onBirthday: (birthday: string) => void;
  onRemove: (face: string) => void;
  onOpenSlide: (sid: string, gid: string) => void;
  onMap: () => void;
}) {
  const [name, setName] = React.useState(p.name);
  const [born, setBorn] = React.useState(p.birthday ?? "");
  const [all, setAll] = React.useState(false);
  React.useEffect(() => setName(p.name), [p.name]);
  React.useEffect(() => setBorn(p.birthday ?? ""), [p.birthday]);
  const faces = all ? p.faces : p.faces.slice(0, SHOWN);
  const commit = (e: React.KeyboardEvent) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur();
  return (
    <li
      className={cn(
        "grid gap-2 rounded-md border border-(--ss-line-soft) p-2",
        selected && "border-primary/60 bg-primary/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => onSelect(v === true)}
          aria-label={`Select ${p.name || "this person"} to merge`}
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => onRename(name)}
          onKeyDown={commit}
          placeholder="Who is this?"
          aria-label="Name"
          className="h-[25px] max-w-[220px] text-[12px]"
        />
        <Tip label="A year, year-month or full date — dates the slides they're on by the age they look">
          <Input
            value={born}
            onChange={(e) => setBorn(e.target.value)}
            onBlur={() => onBirthday(born)}
            onKeyDown={commit}
            placeholder="Born, e.g. 1952-03-14"
            aria-label="Birthday"
            className="h-[25px] w-[150px] text-[12px]"
          />
        </Tip>
        <span className="text-[11px] text-muted-foreground">
          {plural(p.slides, "slide")}
          {p.faces.length > p.slides && ` · ${p.faces.length} faces`}
          {p.ages && ` · looks ${p.ages[0] === p.ages[1] ? `≈ ${p.ages[0]}` : `${p.ages[0]}–${p.ages[1]}`}`}
        </span>
        {places > 0 && (
          <Tip label="Where they've been">
            <Button variant="ghost" size="sm" className="ml-auto h-[25px] gap-1 text-[11px]" onClick={onMap}>
              <MapPin className="size-3.5" /> {plural(places, "place")}
            </Button>
          </Tip>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {faces.map((f) => (
          <div key={f.id} className="group relative">
            <button
              type="button"
              className="block rounded-sm focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Open this slide"
              onClick={() => f.sid && f.gid && onOpenSlide(f.sid, f.gid)}
            >
              <PreviewImg url={f.url} alt="" className="size-[52px] rounded-sm object-cover" />
            </button>
            {f.age != null && (
              <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded-sm bg-black/70 px-1 text-[10px] leading-[14px] text-white tabular-nums">
                {f.age}
              </span>
            )}
            {p.faces.length > 1 && (
              <Tip label="Not this person">
                <button
                  type="button"
                  aria-label="Not this person"
                  onClick={() => onRemove(f.id)}
                  className="absolute top-0.5 right-0.5 hidden rounded-full bg-black/70 p-0.5 text-white group-hover:block focus-visible:block"
                >
                  <X className="size-3" />
                </button>
              </Tip>
            )}
          </div>
        ))}
        {p.faces.length > SHOWN && (
          <Button variant="ghost" size="sm" className="self-center" onClick={() => setAll((v) => !v)}>
            {all ? "Fewer" : `+${p.faces.length - SHOWN} more`}
          </Button>
        )}
      </div>
    </li>
  );
}

function PlacesView({
  atlas,
  people,
  who,
  onWho,
  onOpenSlide,
}: {
  atlas: AtlasPayload | null;
  people: Person[];
  who: string;
  onWho: (pid: string) => void;
  onOpenSlide: (sid: string, gid: string) => void;
}) {
  const [place, setPlace] = React.useState<string | null>(null);
  const places = React.useMemo(
    () =>
      (atlas?.places ?? [])
        .map((p) => {
          const slides = who ? p.slides.filter((s) => s.people.includes(who)) : p.slides;
          return { ...p, slides, count: slides.length };
        })
        .filter((p) => p.count > 0),
    [atlas, who],
  );
  React.useEffect(() => setPlace(null), [who]);
  const named = people.filter((p) => p.name);
  const open = places.find((p) => p.id === place) ?? null;
  const person = people.find((p) => p.id === who);

  if (!atlas) return <p className="py-6 text-center text-[12px] text-muted-foreground">Loading places…</p>;
  if (!atlas.places.length)
    return (
      <p className="py-6 text-center text-[12px] text-muted-foreground">
        No places yet. Give a slide a place under Details → Place (or accept a suggested one) and it shows up here.
      </p>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px]">
        <NativeSelect
          value={who}
          onChange={(e) => onWho(e.target.value)}
          aria-label="Whose places"
          className="h-[25px] w-[220px] text-[12px]"
        >
          <NativeSelectOption value="">Everyone</NativeSelectOption>
          {(person && !person.name ? [person, ...named] : named).map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.name || "This person (unnamed)"}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="text-muted-foreground">
          {plural(places.length, "place")} · {plural(places.reduce((n, p) => n + p.count, 0), "slide")}
          {who && !places.length && " — nobody's given a place on their slides yet"}
        </span>
      </div>
      <AtlasMap
        places={places}
        selected={place}
        onSelect={setPlace}
        className="min-h-[240px] flex-1 overflow-hidden rounded-md border border-(--ss-line-soft) bg-[#0e0e11]"
      />
      <div className="h-[132px] shrink-0 overflow-hidden">
        {open ? (
          <div className="flex h-full flex-col gap-1.5">
            <p className="text-[12px]">
              <span className="text-foreground">{placeLabel({ ...open, id: undefined }, true)}</span>
              <span className="text-muted-foreground"> · {plural(open.count, "slide")}</span>
            </p>
            <ul className="flex min-h-0 flex-1 gap-1.5 overflow-x-auto pb-1">
              {open.slides.map((s) => (
                <li key={`${s.sid}/${s.gid}`} className="shrink-0">
                  <Tip label={`${s.tray} · slide ${s.index + 1}${s.date ? ` · ${s.date}` : ""}`}>
                    <button
                      type="button"
                      onClick={() => onOpenSlide(s.sid, s.gid)}
                      className="block rounded-sm focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label={`Open slide ${s.index + 1} of ${s.tray}`}
                    >
                      <PreviewImg
                        url={`/api/sessions/${s.sid}/groups/${s.gid}/preview.jpg?size=320&v=${s.key}`}
                        alt=""
                        className="h-[96px] w-auto max-w-[150px] rounded-sm object-cover"
                      />
                    </button>
                  </Tip>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            {places.slice(0, 24).map((p) => (
              <li key={p.id}>
                <button type="button" className="hover:text-foreground" onClick={() => setPlace(p.id)}>
                  {p.name} <span className="tabular-nums">({p.count})</span>
                </button>
              </li>
            ))}
            {places.length > 24 && <li>+{places.length - 24} more on the map</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
