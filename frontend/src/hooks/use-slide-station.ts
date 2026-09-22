import * as React from "react";
import { toast } from "sonner";
import { api, needsReview, type AppState, type Group, type Params, type SessionPayload } from "@/lib/api";

const NEUTRAL = { brightness: 0, contrast: 0, warmth: 0, tint: 0, saturation: 0 };
const POLL_MS = 2000;
const PARAM_DEBOUNCE_MS = 140;

function storedSession() {
  try {
    return localStorage.getItem("session") || "";
  } catch {
    return "";
  }
}

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
  // Unsaved slider moves, tied to the slide they were made on.
  const pendingParams = React.useRef<{ gid: string; url: string; params: Partial<Params> } | null>(null);
  const paramTimer = React.useRef<number | undefined>(undefined);

  const current: Group | null = session?.groups[sel] ?? null;

  /** Swap in a new payload, keeping the same slide selected if it still exists. */
  const applyPayload = React.useCallback((p: SessionPayload, keepId?: string) => {
    const { session: prev, sel: prevSel } = ref.current;
    const id = keepId ?? prev?.groups[prevSel]?.id;
    // Slider moves made while this request was in flight must survive the response.
    const pending = pendingParams.current;
    if (pending) {
      const g = p.groups.find((x) => x.id === pending.gid);
      if (g) g.params = { ...g.params, ...pending.params };
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

  const flushParams = React.useCallback(async () => {
    window.clearTimeout(paramTimer.current);
    const pending = pendingParams.current;
    pendingParams.current = null;
    if (!pending) return;
    try {
      applyPayload(await api<SessionPayload>("PATCH", pending.url, { params: pending.params }));
    } catch (e) {
      fail(e);
    }
  }, [applyPayload]);

  /** Optimistic: the slider moves now, the server hears about it shortly after. */
  const setParam = React.useCallback(
    <K extends keyof Params>(k: K, v: Params[K], immediate = false) => {
      const { session: s, sel: i } = ref.current;
      const g = s?.groups[i];
      const url = groupUrl();
      if (!s || !g || !url) return;
      if (pendingParams.current && pendingParams.current.gid !== g.id) flushParams();
      const groups = s.groups.slice();
      groups[i] = { ...g, params: { ...g.params, [k]: v } };
      const next = { ...s, groups };
      ref.current.session = next;
      setSession(next);
      pendingParams.current = { gid: g.id, url, params: { ...pendingParams.current?.params, [k]: v } };
      window.clearTimeout(paramTimer.current);
      paramTimer.current = window.setTimeout(flushParams, immediate ? 0 : PARAM_DEBOUNCE_MS);
    },
    [flushParams],
  );

  const rotate = (d: number) => {
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
  const splitAt = (scan: string) => groupAction("split", { scan });
  const mergeNext = () => {
    const { session: s, sel: i } = ref.current;
    if (s && i < s.groups.length - 1) groupAction("merge_next");
  };

  const copyPrev = () => {
    const { session: s, sel: i } = ref.current;
    if (!s || i === 0) return;
    patchGroup({ params: { ...s.groups[i - 1].params } });
    toast(`Copied colour from slide ${i}`);
  };

  const resetColour = () => {
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

  const resuggest = async () => {
    const url = groupUrl();
    if (!url) return;
    try {
      const p = await api<SessionPayload & { applied: number }>("POST", `${url}/resuggest`, {});
      applyPayload(p);
      toast(p.applied ? "Applied the learned colour settings" : "Not enough similar approved slides to learn from yet");
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

  const startUpload = async () => {
    try {
      await api("POST", `/api/sessions/${ref.current.sessionId}/finish`);
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
      toast((await api<{ path: string }>("POST", "/api/reveal", { session: ref.current.sessionId })).path);
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
