import * as React from "react";
import { Check, TriangleAlert, UserPlus, UserX } from "lucide-react";
import { PreviewImg } from "@/components/filmstrip";
import { ProButton } from "@/components/ui/pro-button";
import { Input } from "@/components/ui/input";
import { PictureView } from "@/lib/local";
import { api, type Group, type PersonName, type SlideFace } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { SlideStation } from "@/hooks/use-slide-station";

/** The People section's summary: who's on it, and how many faces to check. */
export function peopleNote(g: Group) {
  const faces = g.faces ?? [];
  const named = [...new Set(faces.filter((f) => f.named).map((f) => f.label))];
  const odd = faces.filter((f) => f.odd).length;
  return [
    named.length ? named.slice(0, 2).join(", ") + (named.length > 2 ? ` +${named.length - 2}` : "") : `${faces.length} faces`,
    odd && `${odd} to check`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "Tom would be ≈ 9 in 1977; this face looks 37." */
export const oddText = (label: string, odd: { age: number; year: number }, looks?: number | null) =>
  `${label} would be ≈ ${odd.age} in ${odd.year}` + (looks != null ? `; this face looks ${looks}` : "");

/**
 * The faces on the slide and who they are: a click picks one to say who it is (a name, someone
 * new, or "not them"). Faces whose age doesn't fit their person (dating.suspects) are marked, with
 * "not them" / "it is them". `onFocus` tells the stage which face to outline on the photo.
 */
export function SlidePeople({
  app,
  g,
  focus,
  onFocus,
}: {
  app: SlideStation;
  g: Group;
  focus: string | null;
  onFocus: (face: string | null) => void;
}) {
  const faces = g.faces ?? [];
  const [picked, setPicked] = React.useState<string | null>(null);
  const [hover, setHover] = React.useState<string | null>(null);
  const face = faces.find((f) => f.id === picked) ?? null;
  // another slide, or the face moved on: nothing picked
  React.useEffect(() => setPicked(null), [g.id]);
  const shown = hover ?? face?.id ?? null;
  React.useEffect(() => {
    if (shown !== focus) onFocus(shown);
  }, [shown, focus, onFocus]);
  React.useEffect(() => () => onFocus(null), [onFocus]);

  const assign = async (f: SlideFace, person: string | null, name = "") => {
    if (await app.assignFace(f.id, person, name)) setPicked(null);
  };

  return (
    <div className="flex flex-col gap-2 px-3 pt-2.5 pb-3">
      <ul className="flex flex-wrap gap-x-2 gap-y-2" aria-label="Faces on this slide">
        {faces.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              aria-pressed={f.id === picked}
              aria-label={`${f.person ? f.label : "Nobody yet"}${f.odd ? " (check)" : ""}: say who this is`}
              onClick={() => setPicked((p) => (p === f.id ? null : f.id))}
              onPointerEnter={() => setHover(f.id)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(f.id)}
              onBlur={() => setHover(null)}
              className="flex w-[52px] flex-col items-center gap-1 rounded-md py-1 text-center hover:bg-(--ss-panel-2) focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className="relative">
                <PreviewImg
                  url={f.url}
                  alt=""
                  className={cn(
                    "block size-10 rounded-full object-cover ring-2",
                    f.id === picked ? "ring-primary" : f.odd ? "ring-primary/70" : "ring-transparent",
                  )}
                />
                {f.odd && (
                  <TriangleAlert className="absolute -top-1 -right-1 size-3.5 rounded-full bg-(--ss-panel) p-px text-primary" />
                )}
              </span>
              <span
                className={cn(
                  "w-full truncate text-[10px] leading-3",
                  f.named ? "text-foreground/85" : "text-muted-foreground",
                )}
              >
                {f.person ? f.label : "—"}
              </span>
              {f.age != null && <span className="text-[10px] leading-3 text-muted-foreground">≈ {f.age}</span>}
            </button>
          </li>
        ))}
      </ul>
      {!face && faces.some((f) => f.odd) && (
        <p className="text-[11px] text-primary" role="status">
          A face marked <TriangleAlert className="inline size-3 align-[-2px]" /> looks far from that person's age then:
          probably someone else. Click it to check.
        </p>
      )}
      {face && <WhoIsThis key={face.id} face={face} onAssign={(p, n) => assign(face, p, n)} />}
    </div>
  );
}

/** Everyone a face can be; fetched each time the picker opens (names change in People & Places). */
function usePeopleNames() {
  const [names, setNames] = React.useState<PersonName[]>([]);
  React.useEffect(() => {
    let live = true;
    api<{ people: PersonName[] }>("GET", "/api/people/names").then(
      (r) => live && setNames(r.people),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return names;
}

function WhoIsThis({ face, onAssign }: { face: SlideFace; onAssign: (person: string | null, name?: string) => void }) {
  const names = usePeopleNames();
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const needle = q.trim().toLowerCase();
  const hits = names
    .filter((p) => p.id !== face.person && (!needle || p.label.toLowerCase().includes(needle)))
    .slice(0, needle ? 8 : 6);
  const exact = names.some((p) => p.label.toLowerCase() === needle);
  // the options under the input: people, then "someone new" when the name is nobody's yet
  const options: { key: string; run: () => void; node: React.ReactNode }[] = [
    ...hits.map((p) => ({
      key: p.id,
      run: () => onAssign(p.id),
      node: (
        <>
          {p.cover ? (
            <PreviewImg url={p.cover} alt="" className="size-5 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="size-5 shrink-0 rounded-full bg-(--ss-panel-2)" />
          )}
          <span className="flex-1 truncate">{p.label}</span>
          <span className="text-[10px] text-muted-foreground tabular-nums">{p.faces}</span>
        </>
      ),
    })),
    ...(needle && !exact
      ? [
          {
            key: "new",
            run: () => onAssign("new", q.trim()),
            node: (
              <>
                <UserPlus className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">Someone new: “{q.trim()}”</span>
              </>
            ),
          },
        ]
      : []),
  ];
  const at = Math.min(active, options.length - 1);

  return (
    <div className="flex flex-col gap-2 rounded-md bg-(--ss-panel-2) p-2 shadow-[inset_0_0_0_1px_var(--ss-line-soft)]">
      <div className="flex items-center gap-2">
        <PreviewImg url={face.url} alt="" className="size-12 shrink-0 rounded-full object-cover" />
        <div className="min-w-0 text-[11px] leading-4">
          <div className="truncate text-foreground">{face.person ? face.label : "Nobody yet"}</div>
          {face.age != null && <div className="text-muted-foreground">looks {face.age}</div>}
        </div>
      </div>
      {face.odd && (
        <p className="text-[11px] text-primary" role="status">
          {oddText(face.label, face.odd, face.age)}. Probably someone else — or the slide's date is off.
        </p>
      )}
      {face.person && (
        <div className="flex flex-wrap gap-1.5">
          <ProButton onClick={() => onAssign(null)}>
            <UserX /> Not {face.label}
          </ProButton>
          {face.odd && (
            <ProButton onClick={() => onAssign(face.person)}>
              <Check /> It is {face.label}
            </ProButton>
          )}
        </div>
      )}
      <div className="relative">
        <Input
          autoFocus={!face.odd}
          className="h-7"
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label="Who is this?"
          autoComplete="off"
          placeholder={face.person ? "Someone else…" : "Who is this?"}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const d = e.key === "ArrowDown" ? 1 : -1;
              setActive(options.length ? (at + d + options.length) % options.length : 0);
            } else if (e.key === "Enter") {
              e.preventDefault();
              options[at]?.run();
            } else if (e.key === "Escape") {
              e.currentTarget.blur();
            }
          }}
        />
        {options.length > 0 && (
          <ul id={listId} role="listbox" aria-label="People" className="mt-1 flex flex-col">
            {options.map((o, i) => (
              <li
                key={o.key}
                role="option"
                aria-selected={i === at}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={o.run}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded px-1.5 py-1 text-[12px]",
                  i === at && "bg-(--ss-panel) shadow-[inset_0_0_0_1px_var(--ss-line-soft)]",
                )}
              >
                {o.node}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The face picked or hovered in the People section, outlined on the photo (with its name). */
export function FaceOnPhoto({ img, g, face }: { img: HTMLImageElement | null; g: Group; face: SlideFace }) {
  const [box, setBox] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null);
  React.useLayoutEffect(() => {
    if (!img) return;
    const refresh = () => {
      const w = img.clientWidth;
      const h = img.clientHeight;
      if (!img.naturalWidth || !w) return setBox(null);
      const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      const cw = img.naturalWidth * s;
      const ch = img.naturalHeight * s;
      setBox({ left: img.offsetLeft + (w - cw) / 2, top: img.offsetTop + (h - ch) / 2, width: cw, height: ch });
    };
    refresh();
    const ro = new ResizeObserver(refresh);
    ro.observe(img);
    img.addEventListener("load", refresh);
    return () => {
      ro.disconnect();
      img.removeEventListener("load", refresh);
    };
  }, [img]);
  if (!box || !face.box) return null;
  // the box is on the slide before trim, straighten and crop: near enough to point at a face
  const view = new PictureView(box.width / box.height, g.params);
  const [x, y, w, h] = face.box;
  const [cx, cy] = view.toShown([x + w / 2, y + h / 2]);
  const [l, t, r, b] = g.params.crop ?? [0, 0, 1, 1];
  const bw = ((w * view.scale) / (r - l)) * box.width;
  const bh = ((h * view.scale) / (b - t)) * box.height;
  const pad = 1.25; // around the whole head, not just the features
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute rounded-md border-2 border-primary shadow-[0_0_0_1px_rgb(0_0_0/60%)]"
      style={{
        left: box.left + cx * box.width - (bw * pad) / 2,
        top: box.top + cy * box.height - (bh * pad) / 2,
        width: bw * pad,
        height: bh * pad,
      }}
    >
      {face.person && (
        <span className="absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded bg-black/75 px-1.5 py-px text-[11px] whitespace-nowrap text-white">
          {face.label}
        </span>
      )}
    </div>
  );
}
