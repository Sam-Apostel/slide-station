// Slide Station's people as Immich people, and Immich's names back (slidestation/immich_people.py,
// function by function; its docstring has the whole story). Immich finds faces on the uploaded
// slides itself and groups them into its own people; we line the two up: our face boxes are taken
// through the develop (imaging.developedBoxes) and paired with the Immich face they overlap most,
// then names, links, merges, faces and birthdays go whichever way they're missing. Safe to repeat.
import type { Immich, ImmichFace, ImmichPerson } from "./immich";
import { cleanBirthday, rename, setBirthday, setLinks, type ImmichLink, type PeopleFile } from "./people";

export const MATCH = 0.3; // overlap (IoU) from which two boxes are the same face; real pairs sit around 0.85
export const LONE = 0.1; // below this with every Immich face, Immich didn't find the face
export const FRESH = 3600; // seconds: a slide without Immich faces this new may still wait for Immich's face detection
export const PULL = 2 / 3; // share of an unnamed person's named Immich faces one name needs to be taken over

/** An uploaded slide: its Immich asset and our faces as [x1, y1, x2, y2] in 0..1 of the uploaded slide. */
export type Slide = { sid: string; gid: string; asset: string; faces: [string, number[]][] };

/** people.json as the sync reads and edits it: `load` is people.load_people, `edit` people._edit
 *  (load, change, save, refresh), answering null when the change finds no such person. */
export type PeopleStore = {
  load(): Promise<PeopleFile>;
  edit(fn: (d: PeopleFile) => PeopleFile | null): Promise<PeopleFile | null>;
};

export type Progress = (msg: string, done?: number, total?: number) => void;

export class Report {
  namedHere: string[] = []; // names taken over from Immich
  created = 0; // people created in Immich
  renamed = 0; // Immich people named or renamed
  merged = 0; // unnamed Immich people merged into a named one
  assigned = 0; // faces put on their person
  added = 0; // faces added by hand
  removed = 0; // manual faces that doubled one Immich found
  birthdays = 0;
  waiting = 0; // slides whose faces Immich hasn't looked for yet
  tags = 0; // People/ tags taken off
  conflicts: string[] = [];

  message(): string {
    const parts: string[] = [];
    if (this.namedHere.length)
      parts.push(`named ${this.namedHere.length} here from Immich (${[...new Set(this.namedHere)].sort().join(", ")})`);
    if (this.created || this.renamed) parts.push(`${this.created + this.renamed} people named in Immich`);
    if (this.merged) parts.push(`${this.merged} unnamed Immich people merged in`);
    if (this.assigned || this.added)
      parts.push(
        `${this.assigned + this.added} faces given their names` +
          (this.added ? ` (${this.added} Immich hadn't found)` : ""),
      );
    if (this.removed) parts.push(`${this.removed} doubled faces removed`);
    if (this.birthdays) parts.push(`${this.birthdays} birthdays shared`);
    if (this.tags) parts.push("the People tags taken off");
    if (this.waiting) parts.push(`${this.waiting} slides still waiting for Immich's face detection: sync again later`);
    let out = "People in Immich are up to date" + (parts.length ? ": " + parts.join("; ") : "");
    if (this.conflicts.length)
      out +=
        `. Named differently in Immich, left alone: ${this.conflicts.slice(0, 8).join("; ")}` +
        (this.conflicts.length > 8 ? ` and ${this.conflicts.length - 8} more` : "");
    return out;
  }
}

export function iou(a: number[], b: number[]): number {
  const [x1, y1, x2, y2] = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

export function immichBox(f: ImmichFace): number[] {
  const [w, h] = [f.imageWidth || 1, f.imageHeight || 1];
  return [f.boundingBoxX1 / w, f.boundingBoxY1 / h, f.boundingBoxX2 / w, f.boundingBoxY2 / h];
}

/**
 * Pair our faces with Immich's on one slide, best overlap first; faces Immich detected go before
 * manual ones (immich_people.match). Returns [{our face id: Immich face}, [our faces Immich has
 * nothing near], [manual Immich faces lying on a detected face that was paired: doubles]].
 */
export function match(
  ours: [string, number[]][],
  theirs: ImmichFace[],
): [Map<string, ImmichFace>, string[], ImmichFace[]] {
  const found = new Map<string, ImmichFace>();
  const taken = new Set<string>();
  for (const manual of [false, true]) {
    const pairs: [number, string, ImmichFace][] = [];
    for (const [fid, b] of ours)
      for (const f of theirs) if ((f.sourceType === "manual") === manual) pairs.push([iou(b, immichBox(f)), fid, f]);
    pairs.sort((x, y) => y[0] - x[0]);
    for (const [v, fid, f] of pairs) {
      if (v < MATCH) break;
      if (!found.has(fid) && !taken.has(f.id)) {
        found.set(fid, f);
        taken.add(f.id);
      }
    }
  }
  const lone = ours.filter(([fid, b]) => !found.has(fid) && theirs.every((f) => iou(b, immichBox(f)) < LONE)).map(([fid]) => fid);
  const detected = theirs.filter((f) => taken.has(f.id) && f.sourceType !== "manual");
  const doubles = theirs.filter(
    (f) =>
      f.sourceType === "manual" && !taken.has(f.id) && detected.some((g) => iou(immichBox(f), immichBox(g)) >= MATCH),
  );
  return [found, lone, doubles];
}

const same = (a?: string | null, b?: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

const owners = (d: PeopleFile) =>
  new Map(Object.entries(d.people).flatMap(([pid, p]) => p.faces.map((f): [string, string] => [f, pid])));

/** Counter.most_common(1): the biggest count, the first counted on a tie. */
function top<K>(c: Map<K, number>): [K, number] | null {
  let best: [K, number] | null = null;
  for (const [k, n] of c) if (!best || n > best[1]) best = [k, n];
  return best;
}

const add = <K>(c: Map<K, number>, k: K) => c.set(k, (c.get(k) ?? 0) + 1);
const total = <K>(c: Map<K, number>) => [...c.values()].reduce((a, b) => a + b, 0);

/** Line our people up with Immich's on these uploaded slides (immich_people.sync). */
export async function sync(client: Immich, slides: Slide[], people: PeopleStore, progress?: Progress): Promise<Report> {
  const rep = new Report();
  const say: Progress = progress ?? (() => undefined);

  // --- what Immich has on each slide, paired with ours
  const found = new Map<string, ImmichFace>(); // our face id -> its Immich face
  const lone: [Slide, string][] = []; // our faces Immich didn't find
  const doubles = new Map<string, ImmichFace[]>(); // our face id -> manual Immich faces doubling its detected one
  const faceless = new Set<string>(); // assets Immich has no faces on at all
  for (const [n, s] of slides.entries()) {
    say(`Comparing faces with Immich: slide ${n + 1} of ${slides.length}`, n, slides.length);
    if (!s.faces.length) continue;
    const theirs = await client.faces(s.asset);
    if (!theirs.length) faceless.add(s.asset);
    const [pairs, alone, extra] = match(s.faces, theirs);
    for (const [k, v] of pairs) found.set(k, v);
    lone.push(...alone.map((fid): [Slide, string] => [s, fid]));
    for (const f of extra) {
      // hang each double on the paired face it lies on
      let fid = "";
      let best = -Infinity;
      for (const [k, g] of pairs) {
        const v = iou(immichBox(g), immichBox(f));
        if (v > best) [fid, best] = [k, v];
      }
      doubles.set(fid, [...(doubles.get(fid) ?? []), f]);
    }
  }
  say("Lining people up with Immich's");
  const theirsById = new Map<string, ImmichPerson>((await client.people()).map((p) => [p.id, p]));
  const personOf = (f: ImmichFace) => f.person?.id || undefined;
  const immichName = (f: ImmichFace) => {
    const id = personOf(f);
    return ((id && theirsById.get(id)?.name) || "").trim();
  };
  const linked = (link?: ImmichLink) => (link?.id ? theirsById.get(link.id) : undefined);

  // --- names from Immich: a rename there since the last sync, and unnamed people of ours
  let d = await people.load();
  for (const [pid, p] of Object.entries(d.people)) {
    const [link, name] = [p.immich, p.name ?? ""];
    const them = linked(link);
    if (name && them?.name && !same(them.name, link?.name) && same(name, link?.name))
      await renameHere(people, pid, them.name, rep);
  }
  d = await people.load();
  let owner = owners(d);
  for (const [pid, p] of Object.entries(d.people)) {
    if (p.name) continue;
    const votes = new Map<string, number>();
    for (const [fid, f] of found) if (owner.get(fid) === pid && immichName(f)) add(votes, immichName(f));
    const best = top(votes);
    if (best && best[1] >= 2 && best[1] >= PULL * total(votes)) await renameHere(people, pid, best[0], rep);
  }
  d = await people.load();
  owner = owners(d);

  // --- who is who: for each Immich person on the slides, whose faces of ours it holds
  const holds = new Map<string, Map<string, number>>(); // Immich person id -> Counter(our pid)
  const on = new Map<string, Map<string, number>>(); // our pid -> Counter(Immich person id)
  for (const [fid, f] of found) {
    const id = personOf(f);
    const pid = owner.get(fid);
    if (!id || !pid) continue;
    if (!holds.has(id)) holds.set(id, new Map());
    if (!on.has(pid)) on.set(pid, new Map());
    add(holds.get(id)!, pid);
    add(on.get(pid)!, id);
  }
  const onOf = (pid: string) => on.get(pid) ?? new Map<string, number>();

  /** Unnamed Immich people whose faces on the slides are all this person's (two or more), biggest first. */
  const pure = (pid: string) =>
    [...holds]
      .filter(([i, c]) => c.size === 1 && (c.get(pid) ?? 0) >= 2 && !theirsById.get(i)?.name)
      .sort((a, b) => b[1].get(pid)! - a[1].get(pid)!)
      .map(([i]) => i);

  const target = new Map<string, string>(); // our pid -> its Immich person id
  const links: Record<string, ImmichLink> = {};
  for (const [pid, p] of Object.entries(d.people)) {
    const name = p.name;
    if (!name) continue;
    const link = p.immich;
    let them = linked(link);
    if (them && !same(them.name, name)) {
      if (them.name && !same(them.name, link?.name)) {
        rep.conflicts.push(`${name} is ${them.name} there`); // renamed on both sides
        continue;
      }
      await client.updatePerson(them.id, { name }); // renamed here since the last sync (or unnamed there)
      them.name = name;
      rep.renamed++;
    }
    if (!them) {
      const alike = [...theirsById.values()].filter((x) => same(x.name, name));
      const alikeIds = new Set(alike.map((x) => x.id));
      const other = new Map([...onOf(pid)].filter(([i]) => theirsById.get(i)?.name && !alikeIds.has(i)));
      const best = top(other);
      if (!alike.length && best && best[1] * 2 >= total(onOf(pid)) && best[1] >= 2) {
        rep.conflicts.push(`${name} is ${theirsById.get(best[0])!.name} there`);
        continue;
      }
      const lumped = pure(pid);
      if (alike.length) them = alike.reduce((b, x) => ((onOf(pid).get(x.id) ?? 0) > (onOf(pid).get(b.id) ?? 0) ? x : b));
      else if (lumped.length) {
        them = theirsById.get(lumped[0])!;
        await client.updatePerson(them.id, { name });
        them.name = name;
        rep.renamed++;
      } else {
        them = await client.createPerson(name);
        theirsById.set(them.id, them);
        rep.created++;
      }
    }
    target.set(pid, them.id);
    links[pid] = { id: them.id, name };
    // birthdays: fill the side without one; a year or year-month here agrees with a date there in it
    const [ours, theirs] = [p.birthday ?? "", them.birthDate ?? ""];
    if (ours && !theirs && ours.length === 10) {
      await client.updatePerson(them.id, { birthDate: ours });
      rep.birthdays++;
    } else if (theirs && (!ours || (ours.length < 10 && theirs.startsWith(ours)))) {
      const b = cleanBirthday(theirs);
      if (b) await people.edit((x) => setBirthday(x, pid, b));
      rep.birthdays++;
    } else if (ours && theirs && !theirs.startsWith(ours)) rep.conflicts.push(`${name}'s birthday is ${theirs} there`);
  }

  // --- unnamed Immich people that are only one named person of ours: merged in whole
  const merged = new Map<string, string>(); // Immich person id -> the one it went into
  for (const [pid, into] of target) {
    const others = pure(pid).filter((i) => i !== into);
    if (others.length) {
      await client.mergePeople(into, others);
      for (const i of others) merged.set(i, into);
      rep.merged += others.length;
    }
  }

  // --- the faces themselves
  for (const [fid, f] of found) {
    const pid = owner.get(fid);
    if (!pid || !target.has(pid)) continue;
    const into = target.get(pid)!;
    const was = personOf(f);
    const now = was !== undefined && merged.has(was) ? merged.get(was) : was;
    if (now !== into) {
      const there = immichName(f);
      if (there && !same(there, d.people[pid].name)) {
        rep.conflicts.push(`a face of ${d.people[pid].name} is ${there} there`);
        continue;
      }
      await client.assignFace(f.id, into);
      rep.assigned++;
    }
    for (const x of doubles.get(fid) ?? [])
      if (personOf(x) === into || personOf(x) === undefined) {
        await client.deleteFace(x.id);
        rep.removed++;
      }
  }
  const assets = new Map<string, Awaited<ReturnType<Immich["asset"]>>>();
  const waiting = new Set<string>();
  for (const [s, fid] of lone) {
    const pid = owner.get(fid);
    if (!pid || !target.has(pid)) continue;
    if (!assets.has(s.asset)) assets.set(s.asset, await client.asset(s.asset));
    const a = assets.get(s.asset);
    if (!a) continue;
    if (faceless.has(s.asset) && age(a.createdAt) < FRESH) {
      waiting.add(s.asset); // Immich may not have looked yet: adding now would double its faces
      continue;
    }
    const w = a.width || a.exifInfo?.exifImageWidth;
    const h = a.height || a.exifInfo?.exifImageHeight;
    if (w && h) {
      const box = s.faces.find(([x]) => x === fid)![1];
      await client.createFace(s.asset, target.get(pid)!, box, Math.trunc(w), Math.trunc(h));
      rep.added++;
    }
  }
  rep.waiting = waiting.size;
  await people.edit((x) => setLinks(x, links));

  // --- names used to go as People/<name> tags: Immich's People page has them now
  rep.tags = await client.removeTagEverywhere("People/", [...new Set(slides.map((s) => s.asset))].sort());
  rep.conflicts = [...new Set(rep.conflicts)];
  return rep;
}

async function renameHere(people: PeopleStore, pid: string, name: string, rep: Report) {
  // joins our person of that name, if there is one; null: joined someone already
  if (!(await people.edit((d) => rename(d, pid, name)))) return;
  rep.namedHere.push(name);
}

/** Seconds since the asset was uploaded to Immich (createdAt); unknown counts as old. */
function age(createdAt?: string): number {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 1000;
}
