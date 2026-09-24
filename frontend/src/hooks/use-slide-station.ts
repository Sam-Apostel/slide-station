import * as React from "react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import {
  api,
  needsReview,
  plural,
  standalone,
  STOCK_NAMES,
  type AppState,
  type Group,
  type InsightKind,
  type Params,
  type Place,
  type Preset,
  type Pulled,
  type SessionPayload,
  type SimilarKind,
  type Source,
} from "@/lib/api";

const NEUTRAL = { brightness: 0, contrast: 0, warmth: 0, tint: 0, saturation: 0, curves: {} };
const POLL_MS = 2000;
const PARAM_DEBOUNCE_MS = 140;

function storedSession() {
  try {
    return localStorage.getItem("session") || "";
  } catch {
    return "";
  }
}

type UnsavedParams = {
  url: string;
  params: Partial<Params>;
  version: number; // bumped on every edit; a save is current if nothing changed while it ran
  inFlight: boolean;
  timer?: number;
};

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

/**
 * All app state and every action the UI can take. Mirrors the old plain-JS app:
 * /api/state is polled, the open tray is held as a full session payload, and the
 * selection is an index into its groups (kept on the same group across reloads).
 */
export function useSlideStation() {
  const [state, setState] = React.useState<AppState | null>(null);
  const [session, setSession] = React.useState<SessionPayload | null>(null);
  const [sessionId, setSessionId] = React.useState(storedSession);
  const [sel, setSel] = React.useState(0);

  // Refs so polling, debounced saves and key handlers always see the latest values.
  const ref = React.useRef({ state, session, sessionId, sel });
  ref.current = { state, session, sessionId, sel };
  const lastJobKey = React.useRef("");
  // Slider moves the server hasn't confirmed yet, per slide. Kept on screen over any payload
  // until the save carrying them returns, and saved one request at a time so responses can't
  // arrive out of order and snap a slider back.
  const unsaved = React.useRef(new Map<string, UnsavedParams>());

  const current: Group | null = session?.groups[sel] ?? null;

  /** Swap in a new payload, keeping the same slide selected if it still exists. */
  const applyPayload = React.useCallback((p: SessionPayload, keepId?: string) => {
    const { session: prev, sel: prevSel } = ref.current;
    const id = keepId ?? prev?.groups[prevSel]?.id;
    // Slider moves not yet saved must survive the response. The preview keeps the server's
    // render key, so the image follows what is actually saved.
    for (const [gid, u] of unsaved.current) {
      const g = p.groups.find((x) => x.id === gid);
      if (g) g.params = { ...g.params, ...u.params };
    }
    const i = id ? p.groups.findIndex((g) => g.id === id) : -1;
    const next = Math.max(0, Math.min(i >= 0 ? i : prevSel, p.groups.length - 1));
    ref.current.session = p;
    ref.current.sel = next;
    setSession(p);
    setSel(next);
  }, []);

  const loadSession = React.useCallback(
    async (id: string, keepSel = false) => {
      if (!id) return;
      const { sessionId: prevId, session: prev, sel: prevSel } = ref.current;
      const keepId = keepSel && prevId === id ? prev?.groups[prevSel]?.id : undefined;
      ref.current.sessionId = id;
      setSessionId(id);
      try {
        localStorage.setItem("session", id);
      } catch {
        /* private mode */
      }
      let p: SessionPayload;
      try {
        p = await api<SessionPayload>("GET", `/api/sessions/${id}`);
      } catch (e) {
        return fail(e);
      }
      if (ref.current.sessionId !== id) return; // user switched trays meanwhile
      if (keepId) return applyPayload(p, keepId);
      const firstTodo = p.groups.findIndex(needsReview);
      ref.current.session = p;
      ref.current.sel = firstTodo >= 0 ? firstTodo : 0;
      setSession(p);
      setSel(ref.current.sel);
    },
    [applyPayload],
  );

  const refreshState = React.useCallback(async () => {
    let s: AppState;
    try {
      s = await api<AppState>("GET", "/api/state");
    } catch {
      return;
    }
    ref.current.state = s;
    setState(s);
    const { sessionId: sid } = ref.current;
    const j = s.job;
    const jobKey = j ? `${j.kind}:${j.started}:${j.finished}` : "";
    if (j?.finished && jobKey !== lastJobKey.current && lastJobKey.current) {
      if (j.error) toast.error(j.error, { duration: 8000 });
      else if (j.message) toast.success(j.message);
      if (j.session === sid || j.kind === "model" || j.kind === "ocr") await loadSession(sid, true);
    }
    lastJobKey.current = jobKey;
    const ins = ref.current.session?.insights;
    if (s.sessions.length && !s.sessions.some((x) => x.id === sid)) {
      loadSession(s.sessions[0].id);
    } else if (j && !j.finished && j.kind === "import" && j.session === sid) {
      // pull in slides as the import makes them ready
      loadSession(sid, true);
    } else if (ins?.enabled && ins.ready && ins.pending && (!j || j.finished)) {
      // suggestions arrive as the background analysis gets through the tray
      loadSession(sid, true);
    }
  }, [loadSession]);

  React.useEffect(() => {
    const { sessionId: sid } = ref.current;
    refreshState().then(() => {
      if (sid && ref.current.state?.sessions.some((x) => x.id === sid)) loadSession(sid);
    });
    const t = window.setInterval(refreshState, POLL_MS);
    return () => window.clearInterval(t);
  }, [refreshState, loadSession]);

  // ---------------------------------------------------------------- selection

  const select = React.useCallback((i: number) => {
    const { session: s } = ref.current;
    if (!s?.groups.length) return;
    const next = Math.max(0, Math.min(i, s.groups.length - 1));
    ref.current.sel = next;
    setSel(next);
  }, []);

  // ---------------------------------------------------------------- edits

  const groupUrl = () => {
    const { sessionId: sid, session: s, sel: i } = ref.current;
    const g = s?.groups[i];
    return g ? `/api/sessions/${sid}/groups/${g.id}` : null;
  };

  /** Locked slides (originals deleted after upload) can't change: say so instead of failing. */
  const editable = () => {
    const g = ref.current.session?.groups[ref.current.sel];
    if (!g?.locked) return true;
    toast("This slide is locked: its original scans were deleted after upload.", {
      id: "locked",
      description: "Re-import its scans into this tray to edit it again.",
    });
    return false;
  };

  const patchGroup = React.useCallback(
    /** The selected slide, or the one with id `gid`. */
    async (body: Record<string, unknown>, gid?: string) => {
      const url = gid ? `/api/sessions/${ref.current.sessionId}/groups/${gid}` : groupUrl();
      if (!url) return;
      try {
        const p = await api<SessionPayload>("PATCH", url, body);
        applyPayload(p);
        return p;
      } catch (e) {
        fail(e);
      }
    },
    [applyPayload],
  );

  // Stable across renders (applyPayload is), and calls itself when edits arrived mid-request.
  const flushParams = React.useRef(async (gid: string): Promise<void> => {
    const u = unsaved.current.get(gid);
    if (!u || u.inFlight) return;
    window.clearTimeout(u.timer);
    u.inFlight = true;
    const version = u.version;
    try {
      const p = await api<SessionPayload>("PATCH", u.url, { params: { ...u.params } });
      u.inFlight = false;
      const caughtUp = u.version === version;
      if (caughtUp) unsaved.current.delete(gid);
      applyPayload(p);
      if (!caughtUp) flushParams(gid);
    } catch (e) {
      unsaved.current.delete(gid);
      fail(e);
    }
  }).current;

  /** Optimistic: the slider moves now, the server hears about it shortly after. */
  const setParam = React.useCallback(
    <K extends keyof Params>(k: K, v: Params[K], immediate = false) => {
      if (!editable()) return;
      const { session: s, sel: i } = ref.current;
      const g = s?.groups[i];
      const url = groupUrl();
      if (!s || !g || !url) return;
      const u = unsaved.current.get(g.id) ?? { url, params: {}, version: 0, inFlight: false };
      u.params = { ...u.params, [k]: v };
      u.version++;
      unsaved.current.set(g.id, u);
      const groups = s.groups.slice();
      groups[i] = { ...g, params: { ...g.params, [k]: v } };
      const next = { ...s, groups };
      ref.current.session = next;
      setSession(next);
      window.clearTimeout(u.timer);
      u.timer = window.setTimeout(() => flushParams(g.id), immediate ? 0 : PARAM_DEBOUNCE_MS);
    },
    [flushParams],
  );

  const rotate = (d: number) => {
    if (!editable()) return;
    const g = ref.current.session?.groups[ref.current.sel];
    if (g) patchGroup({ rotation: (g.rotation + d + 360) % 360 });
  };

  const review = async () => {
    const g = ref.current.session?.groups[ref.current.sel];
    if (!g) return;
    if (!g.reviewed) await patchGroup({ reviewed: true });
    const { session: s, sel: i } = ref.current;
    if (!s) return;
    const nxt = s.groups.findIndex((x, k) => k > i && needsReview(x));
    select(nxt >= 0 ? nxt : i + 1);
  };

  /** The review grid's Space: develop the slide under the cursor and step to the next tile. */
  const developStep = () => {
    const { session: s, sel: i } = ref.current;
    const g = s?.groups[i];
    if (!g) return;
    select(i + 1); // first, so quick presses each move on
    if (!g.reviewed) patchGroup({ reviewed: true }, g.id);
  };

  const toggleSkip = () => {
    const g = ref.current.session?.groups[ref.current.sel];
    if (g) patchGroup({ skip: !g.skip });
  };

  const toggleScan = (scan: string) => {
    if (!editable()) return;
    const g = ref.current.session?.groups[ref.current.sel];
    if (!g) return;
    const ex = g.excluded.includes(scan) ? g.excluded.filter((x) => x !== scan) : [...g.excluded, scan];
    if (ex.length >= g.scans.length) return void toast("A slide needs at least one scan.");
    patchGroup({ excluded: ex });
  };

  const groupAction = async (path: string, body?: unknown) => {
    const url = groupUrl();
    if (!url) return;
    try {
      applyPayload(await api<SessionPayload>("POST", `${url}/${path}`, body));
    } catch (e) {
      fail(e);
    }
  };
  const splitAt = (scan: string) => editable() && groupAction("split", { scan });
  const mergeNext = () => {
    if (!editable()) return;
    const { session: s, sel: i } = ref.current;
    if (s && i < s.groups.length - 1) groupAction("merge_next");
  };

  const copyPrev = () => {
    if (!editable()) return;
    const { session: s, sel: i } = ref.current;
    if (!s || i === 0) return;
    // colour only: crop, straighten and local adjustments belong to each slide
    const { crop: _c, angle: _a, local: _l, ...colour } = s.groups[i - 1].params;
    patchGroup({ params: colour });
    toast(`Copied colour from slide ${i}`);
  };

  const resetColour = () => {
    if (!editable()) return;
    const d = ref.current.session?.defaults;
    if (d) patchGroup({ params: { ...NEUTRAL, strength: d.strength, trim: d.trim } });
  };

  const applyRest = async () => {
    const { sessionId: sid, session: s, sel: i } = ref.current;
    const g = s?.groups[i];
    if (!g) return;
    try {
      applyPayload(
        await api<SessionPayload>("POST", `/api/sessions/${sid}/apply`, {
          params: g.params,
          scope: "rest",
          from: g.id,
          as_default: true,
        }),
      );
      toast("Applied to the following unreviewed slides (and future imports in this tray)");
    } catch (e) {
      fail(e);
    }
  };

  /** What past edits suggest, for this slide or every slide still to develop in the tray. */
  const resuggest = async (all = false) => {
    const url = groupUrl();
    if (!url) return;
    try {
      const p = await api<SessionPayload & { applied: number }>("POST", `${url}/resuggest`, { all });
      applyPayload(p);
      toast(
        p.applied
          ? all
            ? `Applied learned settings to ${plural(p.applied, "slide")}`
            : "Applied the learned colour settings"
          : "Not enough similar developed slides to learn from yet",
      );
    } catch (e) {
      fail(e);
    }
  };

  /** Pull the curves' channel ends in to the scan's data: this slide, or every one still to develop. */
  const fitCurves = async (all = false) => {
    if (!all && !editable()) return;
    const url = groupUrl();
    const g = ref.current.session?.groups[ref.current.sel];
    if (!url || !g) return;
    // a pending slider save would land after the fit and undo it
    if (unsaved.current.has(g.id)) await flushParams(g.id);
    try {
      const p = await api<SessionPayload & { fitted: number }>("POST", `${url}/fit_curves`, { all });
      applyPayload(p);
      if (all) toast(`Fitted the curves of ${plural(p.fitted, "slide")}`);
    } catch (e) {
      fail(e);
    }
  };

  /** White balance from a spot on the photo that should be neutral (x, y: 0..1 of the preview). */
  const pickNeutral = async (x: number, y: number) => {
    if (!editable()) return;
    const url = groupUrl();
    const g = ref.current.session?.groups[ref.current.sel];
    if (!url || !g) return;
    if (unsaved.current.has(g.id)) await flushParams(g.id);
    try {
      applyPayload(await api<SessionPayload>("POST", `${url}/neutral`, { x, y }));
    } catch (e) {
      fail(e);
    }
  };

  // ---------------------------------------------------------------- looks: presets, develop like

  const [presets, setPresets] = React.useState<Preset[]>([]);
  const loadPresets = React.useCallback(async () => {
    try {
      setPresets((await api<{ presets: Preset[] }>("GET", "/api/presets")).presets);
    } catch {
      /* shown as an empty list */
    }
  }, []);
  React.useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  /** This slide's colour settings (never its crop or straighten) as a named preset. */
  const savePreset = async (name: string) => {
    const { sessionId: sid, session: s, sel: i } = ref.current;
    const g = s?.groups[i];
    if (!g || !name.trim()) return false;
    if (unsaved.current.has(g.id)) await flushParams(g.id); // save what the sliders show
    try {
      setPresets(
        (await api<{ presets: Preset[] }>("POST", "/api/presets", { name, session: sid, group: g.id })).presets,
      );
      toast(`Saved the look as “${name.trim()}”`);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const deletePreset = async (name: string) => {
    try {
      setPresets((await api<{ presets: Preset[] }>("DELETE", `/api/presets/${encodeURIComponent(name)}`)).presets);
    } catch (e) {
      fail(e);
    }
  };

  /**
   * A preset's colour, or that of any slide in any tray, on this slide ("this") or on it and every
   * following slide still to develop ("rest"). Framing stays; each slide can undo it.
   */
  const applyLook = async (
    look: { preset: string } | { like: { session: string; group: string } },
    scope: "this" | "rest" = "this",
  ) => {
    if (scope === "this" && !editable()) return false;
    const url = groupUrl();
    const g = ref.current.session?.groups[ref.current.sel];
    if (!url || !g) return false;
    if (unsaved.current.has(g.id)) await flushParams(g.id); // it would land after the look and undo it
    try {
      const p = await api<SessionPayload & { applied: number }>("POST", `${url}/look`, { ...look, scope });
      applyPayload(p);
      const what = "preset" in look ? `“${look.preset}”` : "the look";
      toast(scope === "rest" ? `Applied ${what} to ${plural(p.applied, "slide")}` : `Applied ${what}`);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  /** Straighten to the slide mount's edge; with trim, also crop to the mount's window. */
  const straightenToMount = async (trim = false) => {
    if (!editable()) return;
    const url = groupUrl();
    const g = ref.current.session?.groups[ref.current.sel];
    if (!url || !g) return;
    if (unsaved.current.has(g.id)) await flushParams(g.id);
    try {
      applyPayload(await api<SessionPayload>("POST", `${url}/mount`, { apply: true, trim }));
    } catch (e) {
      fail(e);
    }
  };

  // Slides imported before mount detection existed (or whose scans changed since) have no mount
  // yet: look for it once when the slide is shown.
  const lookedForMount = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!current || current.mount !== null || current.locked) return;
    const key = `${sessionId}:${current.id}:${current.active.join()}`;
    if (lookedForMount.current.has(key)) return;
    lookedForMount.current.add(key);
    api<SessionPayload>("POST", `/api/sessions/${sessionId}/groups/${current.id}/mount`, {}).then(
      (p) => ref.current.sessionId === sessionId && applyPayload(p),
      () => undefined, // a suggestion: nothing to tell if it fails
    );
  }, [current, sessionId, applyPayload]);

  const STEP_LABEL: Record<string, string> = {
    mount: "straighten to mount",
    rotation: "rotation",
    fit: "curve fit",
    neutral: "white balance pick",
    learned: "learned settings",
    apply: "applied settings",
    preset: "preset",
    like: "develop like",
  };
  /** Step this slide's look back / forward (settings + rotation, drags count as one step). */
  const step = async (direction: "undo" | "redo") => {
    if (!editable()) return;
    const url = groupUrl();
    const g = ref.current.session?.groups[ref.current.sel];
    if (!url || !g) return;
    if (unsaved.current.has(g.id)) await flushParams(g.id); // a pending drag is the step to undo
    try {
      const p = await api<SessionPayload & { stepped: string | null }>("POST", `${url}/${direction}`);
      applyPayload(p);
      if (!p.stepped) return void toast(direction === "undo" ? "Nothing to undo on this slide" : "Nothing to redo");
      const what = p.stepped.startsWith("params:")
        ? p.stepped.slice(7).split(",").join(", ")
        : (STEP_LABEL[p.stepped] ?? p.stepped);
      toast(`${direction === "undo" ? "Undid" : "Redid"} ${what}`, { duration: 1500 });
    } catch (e) {
      fail(e);
    }
  };
  const undo = () => step("undo");
  const redo = () => step("redo");

  /** Date slides fromIndex..toIndex (0-based, either order, both included) at once; "" clears. */
  const dateRange = async (fromIndex: number, toIndex: number, date: string) => {
    const { sessionId: sid, session: s } = ref.current;
    const a = s?.groups[fromIndex];
    const b = s?.groups[toIndex];
    if (!a || !b) return false;
    try {
      const p = await api<SessionPayload & { dated: number }>("POST", `/api/sessions/${sid}/dates`, {
        from: a.id,
        to: b.id,
        date,
      });
      applyPayload(p);
      const lo = Math.min(fromIndex, toIndex) + 1;
      const hi = Math.max(fromIndex, toIndex) + 1;
      const skipped = hi - lo + 1 - p.dated;
      toast(
        `${date ? `Dated ${plural(p.dated, "slide")} ${date}` : `Cleared the date of ${plural(p.dated, "slide")}`} (${lo}–${hi})` +
          (skipped ? `, ${skipped} locked left as they were` : ""),
      );
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  // ---------------------------------------------------------------- insights (desktop app)

  /** Accept or dismiss open suggestions of a kind (one value, or all): on the given slides, or the whole tray.
   *  `text`: a caption as the user edited it before accepting (one slide). */
  const decide = async (
    kind: InsightKind,
    action: "accept" | "dismiss",
    value?: string,
    groupIds?: string[],
    text?: string,
  ) => {
    const { sessionId: sid } = ref.current;
    try {
      const p = await api<SessionPayload & { decided: number }>("POST", `/api/sessions/${sid}/insights/decide`, {
        kind,
        action,
        value,
        groups: groupIds,
        text,
      });
      applyPayload(p);
      return p;
    } catch (e) {
      fail(e);
      return null;
    }
  };

  /**
   * A look-alike suggestion of the tray (by id). Accepting: duplicates keep `keep` (default the best)
   * and skip the rest, split cuts the stack, merge joins the two slides.
   */
  const decideSimilar = async (kind: SimilarKind, action: "accept" | "dismiss", id: string, keep?: string) => {
    const { sessionId: sid } = ref.current;
    try {
      const p = await api<SessionPayload>("POST", `/api/sessions/${sid}/insights/decide`, {
        kind,
        action,
        value: id,
        keep,
      });
      applyPayload(p);
      if (action === "accept")
        toast(
          kind === "duplicates"
            ? "Kept the best, skipped the rest (X brings one back)"
            : kind === "split"
              ? "Split"
              : "Merged",
        );
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  /** A photo in Immich that looks like this slide's upload: replace it (accept) or keep both (dismiss). */
  const decideLookalike = async (action: "accept" | "dismiss", assetId: string) => {
    const { sessionId: sid } = ref.current;
    const g = ref.current.session?.groups[ref.current.sel];
    if (!g) return;
    try {
      applyPayload(
        await api<SessionPayload>("POST", `/api/sessions/${sid}/insights/decide`, {
          kind: "lookalike",
          action,
          value: assetId,
          groups: [g.id],
        }),
      );
      if (action === "accept") toast("Replaced in Immich: the old photo is in Immich's trash, its albums carried over");
    } catch (e) {
      fail(e);
    }
  };

  /** Look for photos in Immich like this tray's uploaded slides (a job); `all`: check every one again. */
  const checkLookalikes = async (all = false) => {
    try {
      await api("POST", `/api/sessions/${ref.current.sessionId}/lookalikes`, { all });
      refreshState();
    } catch (e) {
      fail(e);
    }
  };

  /** Give slides fromIndex..toIndex (0-based, either order) a tag, caption, date, film stock or place confirmed on one of them. */
  const propagate = async (
    kind: "tags" | "caption" | "date" | "stock" | "place",
    value: string | Place,
    fromIndex: number,
    toIndex: number,
  ) => {
    const { sessionId: sid, session: s } = ref.current;
    const a = s?.groups[fromIndex];
    const b = s?.groups[toIndex];
    if (!a || !b) return false;
    try {
      const p = await api<SessionPayload & { applied: number }>("POST", `/api/sessions/${sid}/insights/propagate`, {
        kind,
        value,
        from: a.id,
        to: b.id,
      });
      applyPayload(p);
      const lo = Math.min(fromIndex, toIndex) + 1;
      const hi = Math.max(fromIndex, toIndex) + 1;
      const what =
        typeof value !== "string"
          ? `Placed in ${value.name}`
          : kind === "tags"
            ? `Tagged “${value}”`
            : kind === "date"
              ? `Dated ${value}`
              : kind === "stock"
                ? `Film stock ${STOCK_NAMES[value] ?? "cleared"}`
                : "Captioned";
      toast(`${what}: ${plural(p.applied, "slide")} (${lo}–${hi})`);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  /** The slide's own tags; removing a suggested tag counts as dismissing it. */
  const setTags = (tags: string[]) => {
    if (editable()) patchGroup({ tags });
  };

  /** Where the slide was taken (null clears it); settles an open place suggestion. */
  const setPlace = (place: Place | null) => (editable() ? patchGroup({ place }) : Promise.resolve(undefined));

  /** Fetch the place names (GeoNames) or, with `ocr`, the text reader for place suggestions too (a job). */
  const downloadPlaces = async (ocr = false) => {
    try {
      await api("POST", "/api/places/download", { ocr });
      refreshState();
    } catch (e) {
      fail(e);
    }
  };

  /** Analyse the tray in the background (again, with `force`: keeps what was accepted or dismissed). */
  const analyseTray = async (force = false) => {
    const { sessionId: sid } = ref.current;
    try {
      applyPayload(await api<SessionPayload>("POST", `/api/sessions/${sid}/insights/run`, { force }));
    } catch (e) {
      fail(e);
    }
  };

  /** Fetch the models turned on (a job in the activity pill); the open tray is analysed once they're there. */
  const downloadModel = async () => {
    try {
      await api("POST", "/api/insights/model");
      refreshState();
    } catch (e) {
      fail(e);
    }
  };

  // ---------------------------------------------------------------- tray

  const patchSession = async (body: Record<string, string>) => {
    const { sessionId: sid } = ref.current;
    try {
      applyPayload(await api<SessionPayload>("PATCH", `/api/sessions/${sid}`, body));
      refreshState();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const startImport = async (sid: string, source: string) => {
    try {
      await api("POST", `/api/sessions/${sid}/import`, { source });
      toast("Importing…");
      refreshState();
    } catch (e) {
      fail(e);
    }
  };

  const createSession = async (body: { name: string; album: string; date: string }, source: string) => {
    try {
      const { id } = await api<{ id: string }>("POST", "/api/sessions", body);
      await refreshState();
      await loadSession(id);
      if (source) await startImport(id, source);
    } catch (e) {
      fail(e);
    }
  };

  const startUpload = async (onlyReady = false) => {
    try {
      await api("POST", `/api/sessions/${ref.current.sessionId}/finish`, { only_ready: onlyReady });
      refreshState();
    } catch (e) {
      fail(e);
    }
  };

  /** Save finished JPEGs to disk instead of Immich (browser version): a folder you pick, or a zip. */
  const startSave = async (onlyReady = false) => {
    try {
      await api("POST", `/api/sessions/${ref.current.sessionId}/finish`, { only_ready: onlyReady, target: "disk" });
      refreshState();
    } catch (e) {
      fail(e);
    }
  };

  /** Browser version: a folder of scans picked, or dropped on the window, as an import source. */
  const addSource = async (how: "pick" | DataTransfer): Promise<Source | null> => {
    if (!standalone) return null;
    try {
      const pick = await import("@/standalone/pick");
      const id = await (how === "pick" ? pick.chooseFolder() : pick.fromDrop(how));
      if (!id) {
        if (how !== "pick") toast("Drop a folder of scans (JPEGs)");
        return null;
      }
      await refreshState();
      const src = ref.current.state?.sources.find((x) => x.path === id) ?? null;
      if (src && !src.count) toast(`No JPEG scans in “${src.name}”`);
      return src && src.count ? src : null;
    } catch (e) {
      fail(e);
      return null;
    }
  };

  /** Bring captions and dates edited in Immich back into this tray. */
  const pullFromImmich = async () => {
    const { sessionId: sid } = ref.current;
    try {
      const p = await api<SessionPayload & { pulled: Pulled }>("POST", `/api/sessions/${sid}/pull`);
      applyPayload(p);
      const { checked, captions, dates, places = 0, gone } = p.pulled;
      const what = [
        captions && plural(captions, "caption"),
        dates && plural(dates, "date"),
        places && plural(places, "place"),
      ].filter(Boolean);
      toast(
        !checked
          ? "Nothing in this tray is in Immich yet"
          : what.length
            ? `Pulled ${what.join(", ").replace(/, ([^,]*)$/, " and $1")} from Immich`
            : `No changes in Immich (${plural(checked, "slide")} checked)`,
        gone ? { description: `${plural(gone, "slide")} no longer in Immich (deleted or in its trash)` } : undefined,
      );
    } catch (e) {
      fail(e);
    }
  };

  /** A new tray with photos from Immich as its scans, to develop them again. */
  const importFromImmich = async (assets: string[], body: { name: string; album: string }) => {
    try {
      const { id } = await api<{ id: string }>("POST", "/api/immich/import", { assets, ...body });
      await refreshState();
      await loadSession(id);
      toast(`Pulling in ${plural(assets.length, "photo")} from Immich…`);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const startCleanup = async () => {
    try {
      await api("POST", `/api/sessions/${ref.current.sessionId}/cleanup`);
      refreshState();
    } catch (e) {
      fail(e);
    }
  };

  const eject = async (path: string) => {
    try {
      toast((await api<{ message: string }>("POST", "/api/eject", { path })).message);
    } catch (e) {
      fail(e);
    }
  };

  const reveal = async () => {
    try {
      const { path } = await api<{ path: string }>("POST", "/api/reveal", { session: ref.current.sessionId });
      if (!desktop || !(await desktop.showFolder(path))) toast(path);
    } catch (e) {
      fail(e);
    }
  };

  return {
    state,
    session,
    sessionId,
    sel,
    current,
    refreshState,
    loadSession,
    select,
    setParam,
    rotate,
    review,
    developStep,
    toggleSkip,
    toggleScan,
    splitAt,
    mergeNext,
    copyPrev,
    resetColour,
    applyRest,
    resuggest,
    fitCurves,
    pickNeutral,
    straightenToMount,
    patchGroup,
    dateRange,
    presets,
    loadPresets,
    savePreset,
    deletePreset,
    applyLook,
    decide,
    decideSimilar,
    decideLookalike,
    checkLookalikes,
    propagate,
    setTags,
    setPlace,
    downloadPlaces,
    analyseTray,
    downloadModel,
    undo,
    redo,
    patchSession,
    startImport,
    createSession,
    startUpload,
    startSave,
    addSource,
    pullFromImmich,
    importFromImmich,
    startCleanup,
    eject,
    reveal,
  };
}

export type SlideStation = ReturnType<typeof useSlideStation>;
