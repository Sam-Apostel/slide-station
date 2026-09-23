import * as React from "react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { api, needsReview, plural, type AppState, type Group, type Params, type SessionPayload } from "@/lib/api";

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
      if (j.session === sid) await loadSession(sid, true);
    }
    lastJobKey.current = jobKey;
    if (s.sessions.length && !s.sessions.some((x) => x.id === sid)) {
      loadSession(s.sessions[0].id);
    } else if (j && !j.finished && j.kind === "import" && j.session === sid) {
      // pull in slides as the import makes them ready
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
    async (body: Record<string, unknown>) => {
      const url = groupUrl();
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
    // colour only: crop and straighten belong to each slide
    const { crop: _c, angle: _a, ...colour } = s.groups[i - 1].params;
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

  const STEP_LABEL: Record<string, string> = {
    rotation: "rotation",
    fit: "curve fit",
    neutral: "white balance pick",
    learned: "learned settings",
    apply: "applied settings",
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
    patchGroup,
    undo,
    redo,
    patchSession,
    startImport,
    createSession,
    startUpload,
    startCleanup,
    eject,
    reveal,
  };
}

export type SlideStation = ReturnType<typeof useSlideStation>;
