// People & Places: a full-window view (in place of filmstrip, stage and inspector) of everyone on
// the slides of every tray (people.py) and every place they were taken (dating.atlas). A sidebar
// lists people or places with search and sort; the main pane is an overview (people's faces, or
// the map), a person's page (their slides by year with the age they were and look, their places,
// who they're with) or a place's page. Slides picked on a page can be placed by clicking the map.
// Birthdays date the slides people are on (dating.py; ages are the desktop app's). In both versions.
import * as React from "react";
import { toast } from "sonner";
import { ArrowLeft, MapPin, MapPinOff, Search, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tip } from "@/components/tip";
import { PreviewImg } from "@/components/filmstrip";
import { AtlasMap, placeAt, type MapPlace } from "@/components/atlas-map";
import {
  api,
  personLabel,
  placeLabel,
  plural,
  slidePreview,
  type AtlasPayload,
  type AtlasSlide,
  type Job,
  type PeoplePayload,
  type Person,
  type PersonPage,
  type Place,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type Tab = "people" | "places";
type Nav = { tab: Tab; person?: string; place?: string };
/** Where a slide was opened from: the tray view offers the way back to it (App.tsx). */
export type PeopleSpot = { nav: Nav; label: string; scroll: number };
type Sort = "name" | "slides" | "birthday";
const LIST = 200; // sidebar rows before "show more"
const slideId = (s: { sid: string; gid: string }) => `${s.sid}/${s.gid}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const placeKey = (p: Place) => `${p.name ?? ""}@${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;

export function PeoplePlaces({
  job,
  initialTab = "people",
  from,
  onClose,
  onSettings,
  onOpenSlide,
  onPlaced,
}: {
  /** The running job: people reload when a face search finishes. */
  job: Job | null;
  initialTab?: Tab;
  /** Open on this page again, scrolled as it was left. */
  from?: PeopleSpot;
  onClose: () => void;
  onSettings: () => void;
  /** Go to a slide (closes the view), remembering the page it was opened from. */
  onOpenSlide: (sid: string, gid: string, from: PeopleSpot) => void;
  /** Slides of these trays got a place here: the open tray reloads. */
  onPlaced: (sids: string[]) => void;
}) {
  const [data, setData] = React.useState<PeoplePayload | null>(null);
  const [atlas, setAtlas] = React.useState<AtlasPayload | null>(null);
  const [nav, setNav] = React.useState<Nav>(from?.nav ?? { tab: initialTab });
  const [page, setPage] = React.useState<PersonPage | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set()); // slides, "sid/gid"
  const [placing, setPlacing] = React.useState(false);

  const run = React.useCallback(async (p: Promise<PeoplePayload>) => {
    try {
      setData(await p);
    } catch (e) {
      toast.error(message(e));
    }
  }, []);
  const loadAtlas = React.useCallback(
    () => api<AtlasPayload>("GET", "/api/atlas").then(setAtlas, () => setAtlas({ places: [], slides: 0 })),
    [],
  );
  const loadPage = React.useCallback(async (pid: string) => {
    try {
      setPage(await api<PersonPage>("GET", `/api/people/${pid}`));
    } catch {
      setPage(null);
      setNav((n) => ({ tab: n.tab }));
    }
  }, []);

  const searching = !!job && !job.finished && job.kind === "faces";
  React.useEffect(() => {
    run(api<PeoplePayload>("GET", "/api/people"));
    loadAtlas();
  }, [searching, run, loadAtlas]);
  React.useEffect(() => {
    setPicked(new Set());
    setPlacing(false);
    if (nav.person) loadPage(nav.person);
    else setPage(null);
  }, [nav.person, nav.place, loadPage]);

  // Esc steps back: out of placing, then the selection, then the page, then the view
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]")) return;
      const t = e.target as HTMLElement;
      if (t?.matches?.("input, textarea, select")) return t.blur();
      if (placing) setPlacing(false);
      else if (picked.size) setPicked(new Set());
      else if (nav.person || nav.place) setNav({ tab: nav.tab });
      else onClose();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [placing, picked, nav, onClose]);

  const editPerson = async (pid: string, body: Record<string, string>) => {
    await run(api("PATCH", `/api/people/${pid}`, body));
    if (nav.person === pid) loadPage(pid);
  };
  const removeFace = async (pid: string, face: string) => {
    await run(api("POST", `/api/people/${pid}/remove`, { faces: [face] }));
    loadPage(pid);
    loadAtlas();
  };
  const merge = async (ids: string[]) => {
    const [into, ...rest] = [...ids].sort((a, b) => {
      // into the named one if there is one, else the biggest
      const pa = data!.people.find((p) => p.id === a)!;
      const pb = data!.people.find((p) => p.id === b)!;
      return +!pa.name - +!pb.name || pb.faces.length - pa.faces.length;
    });
    await run(api("POST", `/api/people/${into}/merge`, { people: rest }));
    loadAtlas();
    setNav({ tab: "people", person: into });
  };
  const start = async (path: string, what: string) => {
    try {
      await api("POST", path);
      toast(what);
    } catch (e) {
      toast.error(message(e));
    }
  };

  /** Give the picked slides a place (null: take theirs away). Locked slides are left as they are. */
  const place = async (p: Place | null) => {
    const ids = [...picked];
    setPlacing(false);
    let done = 0;
    let locked = 0;
    for (const id of ids) {
      const [sid, gid] = id.split("/");
      try {
        await api("PATCH", `/api/sessions/${sid}/groups/${gid}`, { place: p });
        done++;
      } catch {
        locked++;
      }
    }
    toast(
      (p ? `Placed ${plural(done, "slide")} in ${p.name}` : `Took the place off ${plural(done, "slide")}`) +
        (locked ? ` (${locked} locked or gone, left as they were)` : ""),
    );
    setPicked(new Set());
    onPlaced([...new Set(ids.map((i) => i.split("/")[0]))]);
    await loadAtlas();
    if (nav.person) loadPage(nav.person);
    if (nav.place && p && ids.length) setNav({ tab: nav.tab, place: placeKey(p) });
  };
  const pick = async (lat: number, lon: number, at?: MapPlace) =>
    place(at ? { name: at.name, lat: at.lat, lon: at.lon, country: at.country, admin: at.admin } : await placeAt(lat, lon));

  const people = data?.people ?? [];
  const byId = React.useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const allPlaces = React.useMemo<MapPlace[]>(
    () => (atlas?.places ?? []).map((p) => ({ ...p, count: p.slides.length })),
    [atlas],
  );
  const open = (sid: string, gid: string) => {
    const label = nav.person
      ? personLabel(page ?? { id: nav.person })
      : (allPlaces.find((p) => p.id === nav.place)?.name ?? "People & Places");
    const scroll = document.querySelector("[data-ss-atlas] [data-ss-scroll]")?.scrollTop ?? 0;
    onClose();
    onOpenSlide(sid, gid, { nav, label, scroll });
  };
  // back from a slide: scrolled to where it was opened, once the page is there to scroll
  const restore = React.useRef(from?.scroll ?? 0);
  React.useLayoutEffect(() => {
    const el = restore.current && document.querySelector("[data-ss-atlas] [data-ss-scroll]");
    if (!el || el.scrollHeight <= el.clientHeight) return;
    el.scrollTop = restore.current;
    restore.current = 0;
  });
  const selection = {
    picked,
    toggle: (id: string) =>
      setPicked((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    set: setPicked,
  };

  let main: React.ReactNode;
  if (nav.person) {
    main = page ? (
      <PersonView
        page={page}
        person={byId.get(page.id)}
        ages={!!data?.ages?.enabled}
        places={allPlaces}
        selection={selection}
        placing={placing}
        onPlacing={setPlacing}
        onPick={pick}
        onUnplace={() => place(null)}
        onEdit={(body) => editPerson(page.id, body)}
        onRemoveFace={(face) => removeFace(page.id, face)}
        onPerson={(pid) => setNav({ tab: "people", person: pid })}
        onPlace={(id) => setNav({ tab: "places", place: id })}
        onOpen={open}
      />
    ) : (
      <Loading />
    );
  } else if (nav.place) {
    const pl = allPlaces.find((p) => p.id === nav.place);
    main = pl ? (
      <PlaceView
        place={pl}
        places={allPlaces}
        byId={byId}
        selection={selection}
        placing={placing}
        onPlacing={setPlacing}
        onPick={pick}
        onUnplace={() => place(null)}
        onPerson={(pid) => setNav({ tab: "people", person: pid })}
        onPlace={(id) => setNav({ tab: "places", place: id ?? undefined })}
        onOpen={open}
      />
    ) : (
      <Loading />
    );
  } else if (nav.tab === "places") {
    main = (
      <PlacesOverview atlas={atlas} places={allPlaces} onPlace={(id) => setNav({ tab: "places", place: id })} />
    );
  } else {
    main = (
      <PeopleOverview
        data={data}
        searching={searching}
        job={job}
        onPerson={(pid) => setNav({ tab: "people", person: pid })}
        onSettings={onSettings}
        onFind={() => start("/api/people/scan", "Looking for faces on every slide")}
        onSync={() => start("/api/people/sync", "Syncing people with Immich")}
      />
    );
  }

  return (
    <div data-ss-atlas className="flex min-h-0 flex-1 bg-background">
      <Sidebar
        nav={nav}
        onNav={setNav}
        people={people}
        places={allPlaces}
        onClose={onClose}
        onMerge={merge}
      />
      <section className="flex min-w-0 flex-1 flex-col">{main}</section>
    </div>
  );
}

function Loading() {
  return <p className="p-6 text-[12px] text-muted-foreground">Loading…</p>;
}

// ---------------------------------------------------------------------------------- sidebar

function Sidebar({
  nav,
  onNav,
  people,
  places,
  onClose,
  onMerge,
}: {
  nav: Nav;
  onNav: (n: Nav) => void;
  people: Person[];
  places: MapPlace[];
  onClose: () => void;
  onMerge: (ids: string[]) => void;
}) {
  const [q, setQ] = React.useState("");
  const [sort, setSort] = React.useState<Sort>("name");
  const [more, setMore] = React.useState(false);
  const [once, setOnce] = React.useState(false);
  const [merging, setMerging] = React.useState<string[]>([]);
  React.useEffect(() => (setQ(""), setMore(false)), [nav.tab]);

  const needle = q.trim().toLowerCase();
  const seenOnce = people.filter((p) => !p.name && p.faces.length === 1).length;
  const shownPeople = React.useMemo(() => {
    let list = people.filter((p) => once || p.name || p.faces.length > 1);
    if (needle) list = list.filter((p) => personLabel(p).toLowerCase().includes(needle));
    if (sort === "birthday") list = list.filter((p) => !p.birthday);
    const byName = (a: Person, b: Person) =>
      +!a.name - +!b.name || a.name.localeCompare(b.name) || b.slides - a.slides;
    return [...list].sort(sort === "slides" ? (a, b) => b.slides - a.slides || byName(a, b) : byName);
  }, [people, needle, sort, once]);
  const shownPlaces = React.useMemo(() => {
    const list = needle
      ? places.filter((p) => placeLabel({ ...p, id: undefined }, true).toLowerCase().includes(needle))
      : places;
    return sort === "name" ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : list;
  }, [places, needle, sort]);
  const rows = nav.tab === "people" ? shownPeople.length : shownPlaces.length;

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-(--ss-line-soft) bg-(--ss-panel)">
      <div className="flex items-center gap-2 px-3 pt-3">
        <Tip label="Back to the tray" keys="Esc">
          <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={onClose} aria-label="Back to the tray">
            <ArrowLeft className="size-4" />
          </Button>
        </Tip>
        <div role="tablist" aria-label="View" className="flex flex-1 gap-1 rounded-md bg-(--ss-panel-2) p-0.5">
          {(["people", "places"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={nav.tab === t && !nav.person && !nav.place}
              onClick={() => onNav({ tab: t })}
              className={cn(
                "flex-1 rounded-[5px] px-2 py-1 text-[12px] text-muted-foreground",
                nav.tab === t && "bg-(--ss-panel) text-foreground shadow-sm",
              )}
            >
              {t === "people" ? "People" : "Places"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-1.5 px-3 pt-2 pb-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={nav.tab === "people" ? "Find someone" : "Find a place"}
            aria-label="Search"
            className="h-7 pl-7 text-[12px]"
          />
        </div>
        <NativeSelect
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Sort"
          className="h-7 w-[92px] text-[12px]"
        >
          <NativeSelectOption value="name">A–Z</NativeSelectOption>
          <NativeSelectOption value="slides">Most</NativeSelectOption>
          {nav.tab === "people" && <NativeSelectOption value="birthday">No birthday</NativeSelectOption>}
        </NativeSelect>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" aria-label={nav.tab === "people" ? "People" : "Places"}>
        {nav.tab === "people"
          ? shownPeople.slice(0, more ? undefined : LIST).map((p) => (
              <li key={p.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onNav({ tab: "people", person: p.id })}
                  aria-current={nav.person === p.id || undefined}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md py-1 pr-8 pl-1.5 text-left hover:bg-(--ss-panel-2)",
                    nav.person === p.id && "bg-(--ss-panel-2)",
                  )}
                >
                  <Avatar url={p.cover ?? p.faces[0]?.url} className="size-8" />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-[12px]", !p.name && "text-muted-foreground italic")}>
                      {personLabel(p)}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {plural(p.slides, "slide")}
                      {p.birthday && ` · b. ${p.birthday.slice(0, 4)}`}
                    </span>
                  </span>
                </button>
                <Checkbox
                  checked={merging.includes(p.id)}
                  onCheckedChange={(v) => setMerging((m) => (v === true ? [...m, p.id] : m.filter((x) => x !== p.id)))}
                  aria-label={`Select ${personLabel(p)} to merge`}
                  className={cn(
                    "absolute top-1/2 right-2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                    merging.includes(p.id) && "opacity-100",
                  )}
                />
              </li>
            ))
          : shownPlaces.slice(0, more ? undefined : LIST).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onNav({ tab: "places", place: p.id })}
                  aria-current={nav.place === p.id || undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--ss-panel-2)",
                    nav.place === p.id && "bg-(--ss-panel-2)",
                  )}
                >
                  <MapPin className="size-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px]">{p.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {[p.admin, p.country].filter((x) => x && x !== p.name).join(", ") || " "}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{p.count}</span>
                </button>
              </li>
            ))}
        {!rows && (
          <li className="px-2 py-4 text-center text-[12px] text-muted-foreground">
            {needle ? "Nothing matches." : nav.tab === "people" ? "No people yet." : "No places yet."}
          </li>
        )}
        {rows > LIST && !more && (
          <li>
            <Button variant="link" className="h-auto p-2 text-[12px]" onClick={() => setMore(true)}>
              Show all {rows}
            </Button>
          </li>
        )}
        {nav.tab === "people" && seenOnce > 0 && (
          <li>
            <Button variant="link" className="h-auto p-2 text-[12px]" onClick={() => setOnce((v) => !v)}>
              {once ? "Hide" : "Show"} {plural(seenOnce, "face")} seen only once
            </Button>
          </li>
        )}
      </ul>
      {nav.tab === "people" && merging.length >= 2 && (
        <div className="flex items-center gap-2 border-t border-(--ss-line-soft) p-2">
          <Button
            size="sm"
            className="flex-1 bg-primary text-primary-foreground"
            onClick={() => {
              onMerge(merging);
              setMerging([]);
            }}
          >
            <Users className="size-3.5" /> These {merging.length} are one person
          </Button>
          <Tip label="Clear">
            <Button size="sm" variant="ghost" onClick={() => setMerging([])} aria-label="Clear the selection">
              <X className="size-3.5" />
            </Button>
          </Tip>
        </div>
      )}
    </aside>
  );
}

function Avatar({ url, className }: { url?: string | null; className?: string }) {
  return url ? (
    <PreviewImg url={url} alt="" className={cn("shrink-0 rounded-full object-cover", className)} />
  ) : (
    <span className={cn("shrink-0 rounded-full bg-(--ss-panel-2)", className)} />
  );
}

// ---------------------------------------------------------------------------------- overviews

function PeopleOverview({
  data,
  searching,
  job,
  onPerson,
  onSettings,
  onFind,
  onSync,
}: {
  data: PeoplePayload | null;
  searching: boolean;
  job: Job | null;
  onPerson: (pid: string) => void;
  onSettings: () => void;
  onFind: () => void;
  onSync: () => void;
}) {
  if (!data) return <Loading />;
  const named = data.people.filter((p) => p.name);
  const unnamed = data.people.filter((p) => !p.name && p.faces.length > 1);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <header className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-medium">People</h1>
          <p className="mt-0.5 max-w-[640px] text-[12px] text-muted-foreground">
            Faces on your slides, grouped by likeness across every tray. Name someone once — syncing puts them on
            Immich's People page, and names you gave there come back here. A birthday lets the ages on their faces
            date the slides they're on.
          </p>
        </div>
        {data.enabled && data.people.length > 0 && (
          <Tip label="Names the faces on the slides already in Immich, and brings names given in Immich back here">
            <Button variant="outline" size="sm" onClick={onSync}>
              Sync with Immich
            </Button>
          </Tip>
        )}
      </header>
      {!data.enabled ? (
        <p className="text-[12px] text-foreground/75">
          Recognising people is off.{" "}
          <Button variant="link" className="h-auto p-0 text-[12px]" onClick={onSettings}>
            Turn it on in Settings
          </Button>{" "}
          (it downloads a {data.model_mb} MB face model once). The places work without it.
        </p>
      ) : (
        <>
          {(data.pending > 0 || searching) && (
            <div className="mb-3 flex items-center gap-3 rounded-md border border-(--ss-line-soft) px-3 py-2 text-[12px]">
              <span className="flex-1 text-foreground/75">
                {searching
                  ? job!.message || "Looking for faces…"
                  : `${plural(data.pending, "slide")} not looked at yet${data.model ? "" : " (the face model is downloaded first)"}.`}
              </span>
              {!searching && (
                <Button size="sm" onClick={onFind}>
                  Find faces
                </Button>
              )}
            </div>
          )}
          <AgesNote data={data} onSettings={onSettings} />
          {!data.people.length && <p className="py-6 text-[12px] text-muted-foreground">No faces found yet.</p>}
          <FaceGrid title="Named" people={named} onPerson={onPerson} />
          <FaceGrid title="Who are they?" people={unnamed} onPerson={onPerson} />
        </>
      )}
    </div>
  );
}

function FaceGrid({ title, people, onPerson }: { title: string; people: Person[]; onPerson: (pid: string) => void }) {
  const [all, setAll] = React.useState(false);
  if (!people.length) return null;
  const shown = all ? people : people.slice(0, 60);
  return (
    <section className="mt-4">
      <h2 className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title} · {people.length}
      </h2>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3">
        {shown.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onPerson(p.id)}
              className="group flex w-full flex-col items-center gap-1.5 rounded-md p-1.5 text-center hover:bg-(--ss-panel)"
            >
              <Avatar url={p.cover ?? p.faces[0]?.url} className="size-[72px] ring-1 ring-(--ss-line-soft) group-hover:ring-primary/60" />
              <span className={cn("w-full truncate text-[12px]", !p.name && "text-muted-foreground italic")}>
                {personLabel(p)}
              </span>
              <span className="-mt-1 text-[11px] text-muted-foreground">
                {plural(p.slides, "slide")}
                {p.birthday ? ` · ${p.birthday.slice(0, 4)}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {people.length > shown.length && (
        <Button variant="link" className="mt-1 h-auto p-0 text-[12px]" onClick={() => setAll(true)}>
          Show all {people.length}
        </Button>
      )}
    </section>
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
      Math.abs(a.bias) >= 0.02
        ? `, the model guessing ${a.bias < 0 ? "older" : "younger"} than people are by ~${Math.round(Math.abs(Math.expm1(a.bias)) * 100)} %`
        : ""
    }.`;
  return <p className="text-[12px] text-foreground/75">{text}</p>;
}

function PlacesOverview({
  atlas,
  places,
  onPlace,
}: {
  atlas: AtlasPayload | null;
  places: MapPlace[];
  onPlace: (id: string) => void;
}) {
  if (!atlas) return <Loading />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-5">
      <header>
        <h1 className="text-[15px] font-medium">Places</h1>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {places.length
            ? `${plural(places.length, "place")} · ${plural(atlas.slides, "slide")} with a place. Click a place for its slides; pick slides on a person's or a place's page to place them on the map.`
            : "No places yet. Give a slide a place under Details → Place (type it, or click the little map there), or pick slides on someone's page and click the map."}
        </p>
      </header>
      <AtlasMap
        places={places}
        selected={null}
        onSelect={(id) => id && onPlace(id)}
        className="min-h-[300px] flex-1 overflow-hidden rounded-md border border-(--ss-line-soft)"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------- pages

type Selection = {
  picked: Set<string>;
  toggle: (id: string) => void;
  set: (s: Set<string>) => void;
};

type Placing = {
  selection: Selection;
  placing: boolean;
  onPlacing: (on: boolean) => void;
  onPick: (lat: number, lon: number, at?: MapPlace) => void;
  onUnplace: () => void;
};

/** Above a page's slides: how many are picked, and placing them on the map. */
function PlaceBar({
  selection,
  placing,
  onPlacing,
  onUnplace,
  unplaced,
}: Omit<Placing, "onPick"> & { unplaced: string[] }) {
  const n = selection.picked.size;
  if (placing)
    return (
      <div className="ss-place-bar" role="status">
        <MapPin className="size-3.5 text-primary" />
        <span className="flex-1">
          Click the map where {n === 1 ? "this slide was" : `these ${n} slides were`} taken — or an existing place.
        </span>
        <Button size="sm" variant="ghost" onClick={() => onPlacing(false)}>
          Cancel
        </Button>
      </div>
    );
  if (!n)
    return unplaced.length ? (
      <div className="ss-place-bar">
        <span className="flex-1 text-muted-foreground">{plural(unplaced.length, "slide")} without a place.</span>
        <Button size="sm" variant="ghost" onClick={() => selection.set(new Set(unplaced))}>
          Pick them
        </Button>
      </div>
    ) : null;
  return (
    <div className="ss-place-bar">
      <span className="flex-1">{plural(n, "slide")} picked</span>
      <Button size="sm" className="bg-primary text-primary-foreground" onClick={() => onPlacing(true)}>
        <MapPin className="size-3.5" /> Place on the map
      </Button>
      <Tip label="Take their place away">
        <Button size="sm" variant="ghost" onClick={onUnplace} aria-label="Remove their place">
          <MapPinOff className="size-3.5" />
        </Button>
      </Tip>
      <Tip label="Clear" keys="Esc">
        <Button size="sm" variant="ghost" onClick={() => selection.set(new Set())} aria-label="Clear the selection">
          <X className="size-3.5" />
        </Button>
      </Tip>
    </div>
  );
}

function SlideCard({
  slide,
  picked,
  onPick,
  onOpen,
  face,
  lines,
  onNotThem,
  dim,
}: {
  slide: AtlasSlide;
  picked: boolean;
  onPick: () => void;
  onOpen: () => void;
  /** Their face on it, in the corner. */
  face?: string;
  lines: React.ReactNode[];
  /** "Not this person" (a person's page). */
  onNotThem?: () => void;
  dim?: boolean;
}) {
  return (
    <li className={cn("group relative", dim && "opacity-50")}>
      <button
        type="button"
        onClick={(e) => (e.metaKey || e.ctrlKey || e.shiftKey ? onPick() : onOpen())}
        className={cn(
          "block w-full overflow-hidden rounded-md border border-(--ss-line-soft) bg-(--ss-panel) text-left",
          "hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary",
          picked && "border-primary ring-1 ring-primary",
        )}
        aria-label={`Open slide ${slide.index + 1} of ${slide.tray}`}
      >
        <span className="relative block aspect-[3/2] bg-black">
          <PreviewImg url={slidePreview(slide)} alt="" className="size-full object-cover" />
          {face && (
            <PreviewImg
              url={face}
              alt=""
              className="absolute right-1.5 bottom-1.5 size-9 rounded-full object-cover ring-2 ring-black/70"
            />
          )}
        </span>
        <span className="block px-2 py-1.5 text-[11px] leading-[15px]">
          {lines.map((l, i) => (
            <span key={i} className={cn("block truncate", i ? "text-muted-foreground" : "text-foreground")}>
              {l}
            </span>
          ))}
        </span>
      </button>
      <Checkbox
        checked={picked}
        onCheckedChange={onPick}
        aria-label="Pick this slide"
        className={cn(
          "absolute top-1.5 left-1.5 bg-black/60 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          picked && "opacity-100",
        )}
      />
      {onNotThem && (
        <Tip label="Not this person">
          <button
            type="button"
            aria-label="Not this person"
            onClick={onNotThem}
            className="absolute top-1.5 right-1.5 hidden rounded-full bg-black/70 p-0.5 text-white group-hover:block focus-visible:block"
          >
            <X className="size-3" />
          </button>
        </Tip>
      )}
    </li>
  );
}

const dateText = (date: string, source: string) =>
  !date ? "No date" : source === "own" ? date : `≈ ${date}`;

/** The ages (from the birthday) of a year's slides: "2", or "2–3" when the year spans a birthday. */
function ageRange(slides: { age: number | null }[]) {
  const a = slides.flatMap((s) => (s.age != null ? [Math.max(0, Math.floor(s.age))] : []));
  if (!a.length) return "";
  const [lo, hi] = [Math.min(...a), Math.max(...a)];
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}

function PersonView({
  page,
  person,
  ages,
  places,
  selection,
  placing,
  onPlacing,
  onPick,
  onUnplace,
  onEdit,
  onRemoveFace,
  onPerson,
  onPlace,
  onOpen,
}: Placing & {
  page: PersonPage;
  person?: Person;
  ages: boolean;
  places: MapPlace[];
  onEdit: (body: Record<string, string>) => void;
  onRemoveFace: (face: string) => void;
  onPerson: (pid: string) => void;
  onPlace: (id: string) => void;
  onOpen: (sid: string, gid: string) => void;
}) {
  const [name, setName] = React.useState(page.name);
  const [born, setBorn] = React.useState(page.birthday);
  const [at, setAt] = React.useState<string | null>(null); // only the slides at this place
  React.useEffect(() => (setName(page.name), setBorn(page.birthday), setAt(null)), [page.id, page.name, page.birthday]);
  const commit = (e: React.KeyboardEvent) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur();

  const mine = React.useMemo(() => {
    const ids = new Set(page.slides.map(slideId));
    return places
      .map((p) => {
        const slides = p.slides.filter((s) => ids.has(slideId(s)));
        return { ...p, slides, count: slides.length };
      })
      .filter((p) => p.count);
  }, [places, page.slides]);
  const slides = at ? page.slides.filter((s) => s.place && placeKey(s.place) === at) : page.slides;
  const years = React.useMemo(() => {
    const out: [string, typeof slides][] = [];
    for (const s of slides) {
      const y = s.date ? s.date.slice(0, 4) : "";
      if (out.at(-1)?.[0] !== y) out.push([y, []]);
      out.at(-1)![1].push(s);
    }
    return out;
  }, [slides]);
  const looks = person?.ages;
  const unplaced = page.slides.filter((s) => !s.place && !s.locked).map(slideId);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-start gap-4 border-b border-(--ss-line-soft) px-6 py-4">
          <Avatar url={person?.cover ?? page.slides[0]?.face.url} className="size-16 ring-1 ring-(--ss-line-soft)" />
          <div className="min-w-0 flex-1">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() !== page.name && onEdit({ name })}
              onKeyDown={commit}
              placeholder="Who is this?"
              aria-label="Name"
              className="h-8 max-w-[360px] border-transparent bg-transparent px-1 text-[16px] font-medium hover:border-(--ss-line-soft) focus-visible:border-(--ss-line)"
            />
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[12px] text-muted-foreground">
              <label className="flex items-center gap-1.5">
                Born
                <Input
                  value={born}
                  onChange={(e) => setBorn(e.target.value)}
                  onBlur={() => born.trim() !== page.birthday && onEdit({ birthday: born })}
                  onKeyDown={commit}
                  placeholder="e.g. 1952-03-14"
                  aria-label="Birthday"
                  className="h-6 w-[120px] text-[12px]"
                />
              </label>
              <span>
                {plural(page.slides.length, "slide")} · {plural(mine.length, "place")}
                {looks && ` · looks ${looks[0] === looks[1] ? `≈ ${looks[0]}` : `${looks[0]}–${looks[1]}`}`}
              </span>
              {!page.birthday && ages && <span className="text-foreground/75">A birthday dates their slides.</span>}
            </div>
            {page.with.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1 text-[11px]">
                <span className="text-muted-foreground">Often with</span>
                {page.with.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => onPerson(w.id)}
                    className="rounded-full border border-(--ss-line-soft) px-2 py-0.5 hover:border-primary/50"
                  >
                    {personLabel(w)} <span className="text-muted-foreground tabular-nums">{w.slides}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>
        <PlaceBar
          selection={selection}
          placing={placing}
          onPlacing={onPlacing}
          onUnplace={onUnplace}
          unplaced={unplaced}
        />
        <div data-ss-scroll className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {at && (
            <p className="pt-3 text-[12px] text-muted-foreground">
              At {mine.find((p) => p.id === at)?.name}{" "}
              <Button variant="link" className="h-auto p-0 text-[12px]" onClick={() => setAt(null)}>
                show everywhere
              </Button>
            </p>
          )}
          {years.map(([y, list]) => (
            <section key={y || "undated"} className="pt-4">
              <h2 className="sticky top-0 z-10 -mx-6 mb-2 bg-background/95 px-6 py-1 text-[12px] font-medium backdrop-blur">
                {y || "Undated"}
                {ageRange(list) && <span className="ml-2 font-normal text-muted-foreground">age {ageRange(list)}</span>}
                <span className="ml-2 font-normal text-muted-foreground">{plural(list.length, "slide")}</span>
              </h2>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">
                {list.map((s) => (
                  <SlideCard
                    key={slideId(s)}
                    slide={s}
                    face={s.face.url}
                    picked={selection.picked.has(slideId(s))}
                    onPick={() => selection.toggle(slideId(s))}
                    onOpen={() => (selection.picked.size ? selection.toggle(slideId(s)) : onOpen(s.sid, s.gid))}
                    onNotThem={() => onRemoveFace(s.face.id)}
                    dim={s.skip}
                    lines={[
                      <>
                        <span
                          title={
                            s.date_source === "people"
                              ? "The year the people on it and its scene say (a suggestion: accept it on the slide)"
                              : undefined
                          }
                        >
                          {dateText(s.date, s.date_source)}
                        </span>
                        {s.age != null && <span className="text-muted-foreground"> · age {Math.floor(s.age)}</span>}
                        {s.looks != null && <span className="text-muted-foreground"> · looks {s.looks}</span>}
                      </>,
                      s.place ? s.place.name : "No place",
                      `${s.tray} · ${s.index + 1}`,
                    ]}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
      <aside className="flex w-[34%] max-w-[480px] min-w-[280px] flex-col border-l border-(--ss-line-soft)">
        <AtlasMap
          places={mine.length || !placing ? mine : places}
          selected={at}
          onSelect={(id) => setAt(id)}
          picking={placing}
          onPick={onPick}
          className="min-h-0 flex-1"
        />
        {mine.length > 0 && (
          <ul className="max-h-[35%] overflow-y-auto border-t border-(--ss-line-soft) p-1.5 text-[12px]">
            {mine.map((p) => (
              <li key={p.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setAt(at === p.id ? null : p.id)}
                  className={cn(
                    "flex flex-1 items-center gap-2 rounded px-2 py-1 text-left hover:bg-(--ss-panel)",
                    at === p.id && "bg-(--ss-panel)",
                  )}
                >
                  <MapPin className="size-3.5 text-primary" />
                  <span className="flex-1 truncate">{placeLabel({ ...p, id: undefined })}</span>
                  <span className="text-muted-foreground tabular-nums">{p.count}</span>
                </button>
                <Tip label="The place's page">
                  <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => onPlace(p.id)} aria-label={`Open ${p.name}`}>
                    <ArrowLeft className="size-3 rotate-180" />
                  </Button>
                </Tip>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function PlaceView({
  place,
  places,
  byId,
  selection,
  placing,
  onPlacing,
  onPick,
  onUnplace,
  onPerson,
  onPlace,
  onOpen,
}: Placing & {
  place: MapPlace;
  places: MapPlace[];
  byId: Map<string, Person>;
  onPerson: (pid: string) => void;
  onPlace: (id: string | null) => void;
  onOpen: (sid: string, gid: string) => void;
}) {
  const who = React.useMemo(() => {
    const n = new Map<string, number>();
    for (const s of place.slides) for (const p of s.people) n.set(p, (n.get(p) ?? 0) + 1);
    return [...n].filter(([p]) => byId.has(p)).sort((a, b) => b[1] - a[1]);
  }, [place, byId]);
  const trays = new Set(place.slides.map((s) => s.tray)).size;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-(--ss-line-soft) px-6 py-4">
          <h1 className="flex items-center gap-2 text-[16px] font-medium">
            <MapPin className="size-4 text-primary" /> {place.name}
          </h1>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {[place.admin, place.country].filter((x) => x && x !== place.name).join(", ")}
            {(place.admin || place.country) && " · "}
            {place.lat.toFixed(4)}, {place.lon.toFixed(4)} · {plural(place.count, "slide")}
            {trays > 1 && ` in ${trays} trays`}
          </p>
          {who.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-muted-foreground">Here</span>
              {who.slice(0, 16).map(([pid, n]) => {
                const p = byId.get(pid)!;
                return (
                  <button
                    key={pid}
                    type="button"
                    onClick={() => onPerson(pid)}
                    className="flex items-center gap-1.5 rounded-full border border-(--ss-line-soft) py-0.5 pr-2 pl-0.5 hover:border-primary/50"
                  >
                    <Avatar url={p.cover ?? p.faces[0]?.url} className="size-5" />
                    {personLabel(p)} <span className="text-muted-foreground tabular-nums">{n}</span>
                  </button>
                );
              })}
            </div>
          )}
        </header>
        <PlaceBar selection={selection} placing={placing} onPlacing={onPlacing} onUnplace={onUnplace} unplaced={[]} />
        <ul
          data-ss-scroll
          className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3 overflow-y-auto px-6 py-4"
        >
          {place.slides.map((s) => (
            <SlideCard
              key={slideId(s)}
              slide={s}
              picked={selection.picked.has(slideId(s))}
              onPick={() => selection.toggle(slideId(s))}
              onOpen={() => (selection.picked.size ? selection.toggle(slideId(s)) : onOpen(s.sid, s.gid))}
              lines={[
                s.date || "No date",
                s.people.map((p) => byId.get(p)?.name).filter(Boolean).join(", ") || " ",
                `${s.tray} · ${s.index + 1}`,
              ]}
            />
          ))}
        </ul>
      </div>
      <aside className="flex w-[34%] max-w-[480px] min-w-[280px] flex-col border-l border-(--ss-line-soft)">
        <AtlasMap
          places={places}
          selected={place.id}
          onSelect={(id) => id && onPlace(id)}
          picking={placing}
          onPick={onPick}
          className="min-h-0 flex-1"
        />
      </aside>
    </div>
  );
}
