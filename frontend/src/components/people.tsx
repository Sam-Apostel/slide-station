// The People dialog: faces found on the slides of every tray, grouped by likeness (people.py). Name
// someone once; named people go to Immich as tags (People/<name>). Desktop / server app only: the
// browser version has no face embeddings yet, so App never opens this there.
import * as React from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
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
import { Tip } from "@/components/tip";
import { PreviewImg } from "@/components/filmstrip";
import { api, plural, type Job, type PeoplePayload, type Person } from "@/lib/api";
import { cn } from "@/lib/utils";

const primary = "bg-primary text-primary-foreground";
const SHOWN = 14; // faces per person before "show all"

export function PeopleDialog({
  open,
  onOpenChange,
  job,
  onSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The running job: the list reloads when a face search finishes. */
  job: Job | null;
  onSettings: () => void;
}) {
  const [data, setData] = React.useState<PeoplePayload | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [showOnce, setShowOnce] = React.useState(false);

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
    if (open) load();
    else setSelected([]);
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

  const all = data?.people ?? [];
  const once = all.filter((p) => !p.name && p.faces.length === 1);
  const shown = showOnce ? all : all.filter((p) => !once.includes(p));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>People</DialogTitle>
          <DialogDescription>
            Faces on your slides, grouped by likeness across every tray. Name someone once; Immich gets the names as
            tags (People/&lt;name&gt;) when the slides are uploaded.
          </DialogDescription>
        </DialogHeader>

        {data && !data.enabled ? (
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
              <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                {!all.length && (
                  <p className="py-6 text-center text-[12px] text-muted-foreground">No faces found yet.</p>
                )}
                <ul className="grid gap-2">
                  {shown.map((p) => (
                    <PersonRow
                      key={p.id}
                      person={p}
                      selected={selected.includes(p.id)}
                      onSelect={(on) => setSelected((s) => (on ? [...s, p.id] : s.filter((x) => x !== p.id)))}
                      onRename={(name) => rename(p, name)}
                      onRemove={(face) => remove(p, face)}
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
          {selected.length >= 2 && (
            <Button onClick={merge} className="mr-auto">
              These {selected.length} are the same person
            </Button>
          )}
          {data?.enabled && all.some((p) => p.name) && (
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

function PersonRow({
  person: p,
  selected,
  onSelect,
  onRename,
  onRemove,
}: {
  person: Person;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onRename: (name: string) => void;
  onRemove: (face: string) => void;
}) {
  const [name, setName] = React.useState(p.name);
  const [all, setAll] = React.useState(false);
  React.useEffect(() => setName(p.name), [p.name]);
  const faces = all ? p.faces : p.faces.slice(0, SHOWN);
  return (
    <li
      className={cn(
        "grid gap-2 rounded-md border border-(--ss-line-soft) p-2",
        selected && "border-primary/60 bg-primary/5",
      )}
    >
      <div className="flex items-center gap-2">
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => onSelect(v === true)}
          aria-label={`Select ${p.name || "this person"} to merge`}
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => onRename(name)}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          placeholder="Who is this?"
          aria-label="Name"
          className="h-[25px] max-w-[240px] text-[12px]"
        />
        <span className="text-[11px] text-muted-foreground">
          {plural(p.slides, "slide")}
          {p.faces.length > p.slides && ` · ${p.faces.length} faces`}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {faces.map((f) => (
          <div key={f.id} className="group relative">
            <PreviewImg url={f.url} alt="" className="size-[52px] rounded-sm object-cover" />
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
