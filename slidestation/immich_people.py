"""Slide Station's people as Immich people, and Immich's names back into Slide Station.

Immich finds faces on the uploaded slides itself and groups them into its own people; we don't
replace that, we line the two up. Our faces are found on the turned scan, the upload is the
developed slide (trimmed, straightened, cropped), so each face box is taken through the same steps
(imaging.developed_boxes) and paired with the Immich face it overlaps most. Then, safe to repeat:

- names come back: an unnamed person of ours whose faces Immich mostly has on one named person
  takes that name (which joins them to our person of that name, if there is one); a name changed in
  Immich since the last sync is taken over too
- each named person of ours is linked to an Immich person (people.json keeps its id): the linked
  one, else the one with the same name, else an unnamed one that holds only their faces, else a new
  one; a name changed here since the last sync goes to Immich
- unnamed Immich people holding only their faces (two or more) are merged in, so their faces on
  other photos come along; faces on mixed or no people are moved one by one
- faces Immich didn't find are added by hand ("manual" faces, which its re-detection leaves alone);
  a manual face Immich's detection found after all is deleted again
- birthdays fill whichever side has none
- a face or person the two sides name differently is left alone and listed, never overwritten
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import people
from .immich import Immich

MATCH = 0.3  # overlap (IoU) from which two boxes are the same face; real pairs sit around 0.85
LONE = 0.1  # below this with every Immich face, Immich didn't find the face
FRESH = 3600  # seconds: a slide without Immich faces this new may still wait for Immich's face detection
PULL = 2 / 3  # share of an unnamed person's named Immich faces one name needs to be taken over


@dataclass
class Slide:
    sid: str
    gid: str
    asset: str
    faces: list[tuple[str, list[float]]]  # (our face id, [x1, y1, x2, y2] in 0..1 of the uploaded slide)


@dataclass
class Report:
    named_here: list[str] = field(default_factory=list)  # names taken over from Immich
    created: int = 0  # people created in Immich
    renamed: int = 0  # Immich people named or renamed
    merged: int = 0  # unnamed Immich people merged into a named one
    assigned: int = 0  # faces put on their person
    added: int = 0  # faces added by hand
    removed: int = 0  # manual faces that doubled one Immich found
    birthdays: int = 0
    waiting: int = 0  # slides whose faces Immich hasn't looked for yet
    tags: int = 0  # People/ tags taken off
    conflicts: list[str] = field(default_factory=list)

    def message(self) -> str:
        parts = []
        if self.named_here:
            parts.append(f"named {len(self.named_here)} here from Immich ({', '.join(sorted(set(self.named_here)))})")
        if self.created or self.renamed:
            parts.append(f"{self.created + self.renamed} people named in Immich")
        if self.merged:
            parts.append(f"{self.merged} unnamed Immich people merged in")
        if self.assigned or self.added:
            parts.append(f"{self.assigned + self.added} faces given their names" +
                         (f" ({self.added} Immich hadn't found)" if self.added else ""))
        if self.removed:
            parts.append(f"{self.removed} doubled faces removed")
        if self.birthdays:
            parts.append(f"{self.birthdays} birthdays shared")
        if self.tags:
            parts.append("the People tags taken off")
        if self.waiting:
            parts.append(f"{self.waiting} slides still waiting for Immich's face detection: sync again later")
        out = "People in Immich are up to date" + (": " + "; ".join(parts) if parts else "")
        if self.conflicts:
            out += f". Named differently in Immich, left alone: {'; '.join(self.conflicts[:8])}" + (
                f" and {len(self.conflicts) - 8} more" if len(self.conflicts) > 8 else "")
        return out


def iou(a: list[float], b: list[float]) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def immich_box(f: dict) -> list[float]:
    w, h = f["imageWidth"] or 1, f["imageHeight"] or 1
    return [f["boundingBoxX1"] / w, f["boundingBoxY1"] / h, f["boundingBoxX2"] / w, f["boundingBoxY2"] / h]


def match(ours: list[tuple[str, list[float]]], theirs: list[dict]) -> tuple[dict[str, dict], list[str], list[dict]]:
    """Pair our faces with Immich's on one slide, best overlap first; faces Immich detected go before
    manual ones. Returns ({our face id: Immich face}, [our faces Immich has nothing near],
    [manual Immich faces lying on a detected face that was paired: doubles])."""
    found: dict[str, dict] = {}
    taken: set[str] = set()
    for manual in (False, True):
        pairs = sorted(((iou(b, immich_box(f)), fid, f) for fid, b in ours for f in theirs
                        if (f.get("sourceType") == "manual") == manual), key=lambda x: -x[0])
        for v, fid, f in pairs:
            if v < MATCH:
                break
            if fid not in found and f["id"] not in taken:
                found[fid] = f
                taken.add(f["id"])
    lone = [fid for fid, b in ours if fid not in found and all(iou(b, immich_box(f)) < LONE for f in theirs)]
    detected = [f for f in theirs if f["id"] in taken and f.get("sourceType") != "manual"]
    doubles = [f for f in theirs if f.get("sourceType") == "manual" and f["id"] not in taken
               and any(iou(immich_box(f), immich_box(g)) >= MATCH for g in detected)]
    return found, lone, doubles


def _same(a: str | None, b: str | None) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def _owners(d: dict) -> dict[str, str]:
    return {f: pid for pid, p in d["people"].items() for f in p["faces"]}


def sync(client: Immich, slides: list[Slide], progress=None) -> Report:
    """Line our people up with Immich's on these uploaded slides (see the module docstring)."""
    rep = Report()
    say = progress or (lambda msg, done=None, total=None: None)

    # --- what Immich has on each slide, paired with ours
    found: dict[str, dict] = {}  # our face id -> its Immich face
    lone: list[tuple[Slide, str]] = []  # our faces Immich didn't find
    doubles: dict[str, list[dict]] = {}  # our face id -> manual Immich faces doubling its detected one
    faceless: set[str] = set()  # assets Immich has no faces on at all
    for n, s in enumerate(slides):
        say(f"Comparing faces with Immich: slide {n + 1} of {len(slides)}", n, len(slides))
        if not s.faces:
            continue
        theirs = client.faces(s.asset)
        if not theirs:
            faceless.add(s.asset)
        pairs, alone, extra = match(s.faces, theirs)
        found.update(pairs)
        lone += [(s, fid) for fid in alone]
        for f in extra:  # hang each double on the paired face it lies on
            fid = max(pairs, key=lambda k: iou(immich_box(pairs[k]), immich_box(f)))
            doubles.setdefault(fid, []).append(f)
    say("Lining people up with Immich's")
    theirs_by_id = {p["id"]: p for p in client.people()}

    def immich_name(f: dict) -> str:
        return (theirs_by_id.get((f.get("person") or {}).get("id"), {}).get("name") or "").strip()

    # --- names from Immich: a rename there since the last sync, and unnamed people of ours
    d = people.load_people()
    for pid, p in list(d["people"].items()):
        link, name = p.get("immich") or {}, p.get("name", "")
        them = theirs_by_id.get(link.get("id"))
        if name and them and them.get("name") and not _same(them["name"], link.get("name")) and _same(name, link.get("name")):
            _rename(pid, them["name"], rep)
    d = people.load_people()
    owner = _owners(d)
    for pid, p in list(d["people"].items()):
        if p.get("name"):
            continue
        votes = Counter(immich_name(f) for fid, f in found.items() if owner.get(fid) == pid and immich_name(f))
        if votes:
            name, n = votes.most_common(1)[0]
            if n >= 2 and n >= PULL * sum(votes.values()):
                _rename(pid, name, rep)
    d = people.load_people()
    owner = _owners(d)

    # --- who is who: for each Immich person on the slides, whose faces of ours it holds
    holds: dict[str, Counter] = defaultdict(Counter)  # Immich person id -> Counter(our pid)
    on: dict[str, Counter] = defaultdict(Counter)  # our pid -> Counter(Immich person id)
    for fid, f in found.items():
        if (f.get("person") or {}).get("id") and fid in owner:
            holds[f["person"]["id"]][owner[fid]] += 1
            on[owner[fid]][f["person"]["id"]] += 1

    def pure(pid: str) -> list[str]:
        """Unnamed Immich people whose faces on the slides are all this person's (two or more), biggest first."""
        out = [i for i, c in holds.items() if set(c) == {pid} and c[pid] >= 2 and not theirs_by_id.get(i, {}).get("name")]
        return sorted(out, key=lambda i: -holds[i][pid])

    target: dict[str, str] = {}  # our pid -> its Immich person id
    links: dict[str, dict] = {}
    for pid, p in d["people"].items():
        name = p.get("name")
        if not name:
            continue
        link = p.get("immich") or {}
        them = theirs_by_id.get(link.get("id"))
        if them and not _same(them.get("name"), name):
            if them.get("name") and not _same(them.get("name"), link.get("name")):
                rep.conflicts.append(f"{name} is {them['name']} there")  # renamed on both sides
                continue
            client.update_person(them["id"], name=name)  # renamed here since the last sync (or unnamed there)
            them["name"] = name
            rep.renamed += 1
        if not them:
            same = [x for x in theirs_by_id.values() if _same(x.get("name"), name)]
            other = Counter({i: n for i, n in on[pid].items() if theirs_by_id.get(i, {}).get("name") and i not in {x["id"] for x in same}})
            if not same and other and other.most_common(1)[0][1] * 2 >= sum(on[pid].values()) and other.most_common(1)[0][1] >= 2:
                rep.conflicts.append(f"{name} is {theirs_by_id[other.most_common(1)[0][0]]['name']} there")
                continue
            if same:
                them = max(same, key=lambda x: on[pid].get(x["id"], 0))
            elif pure(pid):
                them = theirs_by_id[pure(pid)[0]]
                client.update_person(them["id"], name=name)
                them["name"] = name
                rep.renamed += 1
            else:
                them = client.create_person(name)
                theirs_by_id[them["id"]] = them
                rep.created += 1
        target[pid] = them["id"]
        links[pid] = {"id": them["id"], "name": name}
        # birthdays: fill the side without one; a year or year-month here agrees with a date there in it
        ours, theirs = p.get("birthday") or "", them.get("birthDate") or ""
        if ours and not theirs and len(ours) == 10:
            client.update_person(them["id"], birthDate=ours)
            rep.birthdays += 1
        elif theirs and (not ours or (len(ours) < 10 and theirs.startswith(ours))):
            people.set_birthday(pid, theirs)
            rep.birthdays += 1
        elif ours and theirs and not theirs.startswith(ours):
            rep.conflicts.append(f"{name}'s birthday is {theirs} there")

    # --- unnamed Immich people that are only one named person of ours: merged in whole
    merged: dict[str, str] = {}  # Immich person id -> the one it went into
    for pid, into in target.items():
        others = [i for i in pure(pid) if i != into]
        if others:
            client.merge_people(into, others)
            merged.update({i: into for i in others})
            rep.merged += len(others)

    # --- the faces themselves
    for n, (fid, f) in enumerate(found.items()):
        pid = owner.get(fid)
        if pid not in target:
            continue
        into = target[pid]
        now = merged.get((f.get("person") or {}).get("id"), (f.get("person") or {}).get("id"))
        if now != into:
            there = immich_name(f)
            if there and not _same(there, d["people"][pid]["name"]):
                rep.conflicts.append(f"a face of {d['people'][pid]['name']} is {there} there")
                continue
            client.assign_face(f["id"], into)
            rep.assigned += 1
        for x in doubles.get(fid, []):
            if (x.get("person") or {}).get("id") in (into, None):
                client.delete_face(x["id"])
                rep.removed += 1
    assets: dict[str, dict | None] = {}
    waiting: set[str] = set()
    for s, fid in lone:
        pid = owner.get(fid)
        if pid not in target:
            continue
        if s.asset not in assets:
            assets[s.asset] = client.asset(s.asset)
        a = assets[s.asset]
        if not a:
            continue
        if s.asset in faceless and _age(a) < FRESH:
            waiting.add(s.asset)  # Immich may not have looked yet: adding now would double its faces
            continue
        w = a.get("width") or (a.get("exifInfo") or {}).get("exifImageWidth")
        h = a.get("height") or (a.get("exifInfo") or {}).get("exifImageHeight")
        if w and h:
            box = next(b for x, b in s.faces if x == fid)
            client.create_face(s.asset, target[pid], box, int(w), int(h))
            rep.added += 1
    rep.waiting = len(waiting)
    people.set_links(links)

    # --- names used to go as People/<name> tags: Immich's People page has them now
    rep.tags = client.remove_tag_everywhere("People/", sorted({s.asset for s in slides}))
    rep.conflicts = list(dict.fromkeys(rep.conflicts))
    return rep


def _rename(pid: str, name: str, rep: Report) -> None:
    try:
        people.rename(pid, name)  # joins our person of that name, if there is one
    except KeyError:  # joined someone already
        return
    rep.named_here.append(name)


def _age(asset: dict) -> float:
    """Seconds since the asset was uploaded to Immich (createdAt); unknown counts as old."""
    try:
        t = datetime.fromisoformat(asset["createdAt"].replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        return float("inf")
    return (datetime.now(timezone.utc) - t).total_seconds()
