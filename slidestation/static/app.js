"use strict";
// Slide Station UI - plain JS, no build step.

const $ = (id) => document.getElementById(id);
const api = async (method, url, body) => {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.detail || `${r.status} ${r.statusText}`);
  return j;
};

const SLIDERS = [
  ["strength", "Auto restore", 0, 1, 0.05],
  ["brightness", "Brightness", -1, 1, 0.05],
  ["contrast", "Contrast", -1, 1, 0.05],
  ["warmth", "Warmth", -1, 1, 0.05],
  ["tint", "Tint", -1, 1, 0.05],
  ["saturation", "Saturation", -1, 1, 0.05],
];
const NEUTRAL = { brightness: 0, contrast: 0, warmth: 0, tint: 0, saturation: 0 };

let S = null; // /api/state
let cur = null; // session payload
let curId = localStorage.getItem("session") || "";
let sel = 0;
let filter = "all";
let lastJobKey = "";
let pendingPatch = null;
let patchTimer = null;

// ------------------------------------------------------------------ helpers
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const gkey = (g) => hash(JSON.stringify([g.active, g.rotation, g.params]));
const previewUrl = (g, size, before) =>
  `/api/sessions/${curId}/groups/${g.id}/preview.jpg?size=${size}&v=${gkey(g)}${before ? "&before=1" : ""}`;
function toast(msg, bad = false, ms = 3500) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}
const visible = () =>
  cur.groups.filter((g) =>
    filter === "todo" ? !g.reviewed && !g.skip && g.status !== "uploaded" : filter === "multi" ? g.scans.length > 1 : true,
  );
const current = () => cur && cur.groups[sel];

// ------------------------------------------------------------------ state polling
async function refreshState() {
  try {
    S = await api("GET", "/api/state");
  } catch {
    return;
  }
  renderTop();
  const j = S.job;
  const jobKey = j ? `${j.kind}:${j.started}:${j.finished}` : "";
  if (j && j.finished && jobKey !== lastJobKey && lastJobKey) {
    if (j.error) toast(j.error, true, 8000);
    else if (j.message) toast(j.message);
    if (j.session === curId) await loadSession(curId, true);
  }
  lastJobKey = jobKey;
  // while importing into the open tray, pull in slides as they are ready
  if (j && !j.finished && j.kind === "import" && j.session === curId) loadSession(curId, true);
}

function renderTop() {
  const sessions = S.sessions;
  const sEl = $("sessionSelect");
  const opts = sessions
    .map((s) => `<option value="${s.id}">${esc(s.name)} · ${s.slides} slides${s.pending_upload ? "" : s.slides ? " ✓" : ""}</option>`)
    .join("");
  if (sEl.dataset.opts !== opts) {
    sEl.innerHTML = opts || `<option value="">No trays yet</option>`;
    sEl.dataset.opts = opts;
  }
  if (curId && sessions.some((s) => s.id === curId)) sEl.value = curId;

  // detected scanner / card
  const src = S.sources.find((x) => x.new > 0) || S.sources[0];
  const chip = $("sourceChip");
  if (src) {
    const label = src.scanner ? "Slide N Scan" : src.name;
    chip.innerHTML = src.new
      ? `<span class="dot"></span>${esc(label)} · <b>${src.new}</b> new scan${src.new === 1 ? "" : "s"} <button class="primary" id="importBtn">Import</button>`
      : `<span class="dot"></span>${esc(label)} · nothing new <button id="ejectBtn">Eject</button>`;
    chip.hidden = false;
    const ib = $("importBtn");
    if (ib) ib.onclick = () => openImport(src);
    const eb = $("ejectBtn");
    if (eb) eb.onclick = async () => {
      try { toast((await api("POST", "/api/eject", { path: src.path })).message); } catch (e) { toast(e.message, true); }
    };
  } else chip.hidden = true;

  // job
  const j = S.job;
  const bar = $("jobBar");
  if (j && (!j.finished || Date.now() / 1000 - j.started < 4 || j.error)) {
    bar.hidden = false;
    bar.classList.toggle("error", !!j.error);
    $("jobText").textContent = j.error ? `Failed: ${j.error}` : j.finished ? j.message : `${j.message} (${j.done}/${j.total || "?"})`;
    $("jobFill").style.width = j.total ? `${(100 * j.done) / j.total}%` : j.finished ? "100%" : "5%";
  } else bar.hidden = true;
  const busy = j && !j.finished;
  $("uploadBtn").disabled = busy;
  $("cleanBtn").disabled = busy || (cur && cur.cleanup_blockers.length > 0);

  const none = !sessions.length;
  $("empty").hidden = !none;
  for (const id of ["filmstrip", "stage", "inspector"]) $(id).hidden = none;
  if (none)
    $("emptyHint").innerHTML = src
      ? `<button class="primary" onclick="openImport(S.sources.find(x=>x.new>0)||S.sources[0])">Import ${src.new} scans from ${esc(src.scanner ? "the Slide N Scan" : src.name)}</button>`
      : `<span class="muted">Waiting for the scanner… or </span><button onclick="openNew()">import a folder</button>`;
  else if (!curId || !sessions.some((s) => s.id === curId)) loadSession(sessions[0].id);
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ------------------------------------------------------------------ session
async function loadSession(id, keepSel = false) {
  if (!id) return;
  const prevGroup = keepSel && current() ? current().id : null;
  curId = id;
  localStorage.setItem("session", id);
  cur = await api("GET", `/api/sessions/${id}`);
  if (prevGroup) {
    const i = cur.groups.findIndex((g) => g.id === prevGroup);
    sel = i >= 0 ? i : Math.min(sel, cur.groups.length - 1);
  } else {
    const firstTodo = cur.groups.findIndex((g) => !g.reviewed && !g.skip && g.status !== "uploaded");
    sel = firstTodo >= 0 ? firstTodo : 0;
  }
  renderAll();
}

function applyPayload(p) {
  const id = current()?.id;
  cur = p;
  const i = cur.groups.findIndex((g) => g.id === id);
  if (i >= 0) sel = i;
  sel = Math.max(0, Math.min(sel, cur.groups.length - 1));
  renderAll();
}

function renderAll() {
  renderStrip();
  renderSlide();
  renderSessionPanel();
}

function renderStrip() {
  const sm = cur.summary;
  $("stripTitle").innerHTML = `<b>${esc(sm.name)}</b><div class="muted small">${sm.slides} slides · ${sm.scans} scans</div>`;
  const strip = $("strip");
  const groups = visible();
  const want = groups.map((g) => g.id + gkey(g) + g.status + g.skip).join("|");
  if (strip.dataset.want !== want) {
    strip.innerHTML = groups
      .map((g) => {
        const badges = [
          g.active.length > 1 ? `<span class="badge">HDR ×${g.active.length}</span>` : "",
          g.rot_reason && g.rot_reason !== "manual" && g.rotation ? `<span class="badge auto" title="Auto-rotated (${g.rot_reason})">↻</span>` : "",
        ].join("");
        return `<div class="tile ${g.skip ? "skipped" : ""}" data-i="${g.index}">
          <img loading="lazy" src="${previewUrl(g, 320)}" alt="">
          <span class="num">${g.index + 1}</span><span class="badges">${badges}</span>
          <span class="state ${g.status}" title="${g.status}"></span></div>`;
      })
      .join("");
    strip.dataset.want = want;
    strip.querySelectorAll(".tile").forEach((t) => (t.onclick = () => select(+t.dataset.i)));
  }
  strip.querySelectorAll(".tile").forEach((t) => t.classList.toggle("sel", +t.dataset.i === sel));
  const selTile = strip.querySelector(".tile.sel");
  if (selTile) selTile.scrollIntoView({ block: "nearest" });
}

function select(i) {
  if (!cur || !cur.groups.length) return;
  sel = Math.max(0, Math.min(i, cur.groups.length - 1));
  renderStrip();
  renderSlide();
}

let imgToken = 0;
function showImage(g, before = false) {
  const img = $("mainImg");
  const url = previewUrl(g, 1600, before);
  if (img.dataset.url === url) return;
  const token = ++imgToken;
  $("spinner").hidden = false;
  const pre = new Image();
  pre.onload = () => {
    if (token !== imgToken) return;
    img.src = url;
    img.dataset.url = url;
    $("spinner").hidden = true;
  };
  pre.onerror = () => token === imgToken && ($("spinner").hidden = true);
  pre.src = url;
  // warm the next slide so arrow-key browsing feels instant
  const nxt = cur.groups[sel + 1];
  if (nxt) new Image().src = previewUrl(nxt, 1600);
}

function renderSlide() {
  const g = current();
  if (!g) {
    $("slideLabel").textContent = "No slides yet - import some scans";
    $("mainImg").removeAttribute("src");
    $("mainImg").dataset.url = "";
    $("stack").innerHTML = "";
    return;
  }
  $("slideLabel").textContent = `Slide ${sel + 1} of ${cur.groups.length}`;
  const pill = $("statusPill");
  pill.className = `pill ${g.status}`;
  pill.textContent = { new: "to review", reviewed: "reviewed", uploaded: "in Immich", changed: "edited since upload", skipped: "skipped" }[g.status];
  showImage(g);

  // stack of scans (brackets)
  const st = $("stack");
  const parts = [`<span class="label">${g.scans.length > 1 ? `Stack of ${g.scans.length} scans · click to leave one out` : "Single scan"}</span>`];
  g.scans.forEach((sc, k) => {
    if (k > 0) parts.push(`<button class="split" data-scan="${sc}" title="Split: this scan and the ones after it are a different slide">✂</button>`);
    const off = g.excluded.includes(sc);
    parts.push(`<div class="scan ${off ? "off" : ""}" data-scan="${sc}" title="${sc}"><img src="/api/sessions/${curId}/scans/${sc}/thumb.jpg" alt=""><span class="k">${k + 1}</span></div>`);
  });
  st.innerHTML = parts.join("");
  st.querySelectorAll(".scan").forEach((el) => (el.onclick = () => toggleScan(el.dataset.scan)));
  st.querySelectorAll(".split").forEach((el) => (el.onclick = () => splitAt(el.dataset.scan)));

  // inspector
  $("rotReason").textContent = g.rotation ? (g.rot_reason === "faces" ? "auto · faces" : g.rot_reason === "sky" ? "auto · sky" : `${g.rotation}°`) : "";
  const sl = $("sliders");
  if (!sl.children.length) {
    sl.innerHTML = SLIDERS.map(
      ([k, label, min, max, step]) =>
        `<div class="slider"><span>${label}</span><input type="range" id="p_${k}" min="${min}" max="${max}" step="${step}"><output id="o_${k}"></output></div>`,
    ).join("");
    for (const [k] of SLIDERS) {
      $(`p_${k}`).oninput = (e) => setParam(k, +e.target.value);
      $(`p_${k}`).ondblclick = () => setParam(k, k === "strength" ? cur.defaults.strength : 0, true);
    }
  }
  for (const [k] of SLIDERS) {
    $(`p_${k}`).value = g.params[k];
    $(`o_${k}`).textContent = (+g.params[k]).toFixed(2);
  }
  $("trim").checked = g.params.trim;
  $("skipBtn").textContent = g.skip ? "Unskip slide" : "Skip slide";
  $("mergeBtn").disabled = sel >= cur.groups.length - 1;
  $("copyPrev").disabled = sel === 0;
}

function renderSessionPanel() {
  const sm = cur.summary;
  for (const [id, k] of [["sName", "name"], ["sAlbum", "album"], ["sDate", "date"]])
    if (document.activeElement !== $(id)) $(id).value = sm[k] || "";
  $("counts").innerHTML = `
    <span>Reviewed</span><b>${sm.reviewed} / ${sm.slides}</b>
    <span>In Immich</span><b>${sm.uploaded}</b>
    <span>Skipped</span><b>${sm.skipped}</b>
    <span>To upload</span><b>${sm.pending_upload}</b>`;
  $("uploadBtn").textContent = !sm.slides
    ? "Nothing to upload yet"
    : sm.pending_upload ? `Upload ${sm.pending_upload} slide${sm.pending_upload === 1 ? "" : "s"} to Immich` : "Everything is in Immich";
  const busy = S?.job && !S.job.finished;
  $("uploadBtn").disabled = !sm.pending_upload || busy;
  $("cleanBtn").disabled = cur.cleanup_blockers.length > 0 || busy || sm.card_cleaned;
  $("cleanNote").textContent = sm.card_cleaned
    ? "Card cleaned - you can eject the scanner."
    : cur.cleanup_blockers.length
      ? `Card cleanup unlocks when: ${cur.cleanup_blockers.join("; ")}.`
      : "Deletes this tray's scans from the scanner's card (only files that match the verified copies).";
}

// ------------------------------------------------------------------ edits
async function patchGroup(body, quiet = false) {
  const g = current();
  if (!g) return;
  try {
    const p = await api("PATCH", `/api/sessions/${curId}/groups/${g.id}`, body);
    if (!quiet) applyPayload(p);
    return p;
  } catch (e) {
    toast(e.message, true);
  }
}

function setParam(k, v, immediate = false) {
  const g = current();
  g.params[k] = v;
  $(`o_${k}`) && ($(`o_${k}`).textContent = (+v).toFixed(2));
  if ($(`p_${k}`) && +$(`p_${k}`).value !== v) $(`p_${k}`).value = v;
  pendingPatch = { ...(pendingPatch || {}), [k]: v };
  clearTimeout(patchTimer);
  patchTimer = setTimeout(flushParams, immediate ? 0 : 140);
}
async function flushParams() {
  if (!pendingPatch) return;
  const body = { params: pendingPatch };
  pendingPatch = null;
  const p = await patchGroup(body, true);
  if (p) {
    cur = p;
    showImage(current());
    renderStrip();
    renderSessionPanel();
  }
}

const rotate = (d) => patchGroup({ rotation: (current().rotation + d + 360) % 360 });
async function review() {
  const g = current();
  if (!g) return;
  if (!g.reviewed) await patchGroup({ reviewed: true }, true).then((p) => p && (cur = p));
  const nxt = cur.groups.findIndex((x, i) => i > sel && !x.reviewed && !x.skip && x.status !== "uploaded");
  select(nxt >= 0 ? nxt : Math.min(sel + 1, cur.groups.length - 1));
  renderSessionPanel();
}
const toggleSkip = () => patchGroup({ skip: !current().skip });
function toggleScan(scan) {
  const g = current();
  const ex = g.excluded.includes(scan) ? g.excluded.filter((x) => x !== scan) : [...g.excluded, scan];
  if (ex.length >= g.scans.length) return toast("A slide needs at least one scan.");
  patchGroup({ excluded: ex });
}
async function splitAt(scan) {
  try { applyPayload(await api("POST", `/api/sessions/${curId}/groups/${current().id}/split`, { scan })); } catch (e) { toast(e.message, true); }
}
async function mergeNext() {
  try { applyPayload(await api("POST", `/api/sessions/${curId}/groups/${current().id}/merge_next`)); } catch (e) { toast(e.message, true); }
}
function copyPrev() {
  if (sel === 0) return;
  const p = cur.groups[sel - 1].params;
  patchGroup({ params: { ...p } });
  toast(`Copied colour from slide ${sel}`);
}
function resetColour() {
  patchGroup({ params: { ...NEUTRAL, strength: cur.defaults.strength, trim: cur.defaults.trim } });
}
async function applyRest() {
  const g = current();
  try {
    applyPayload(await api("POST", `/api/sessions/${curId}/apply`, { params: g.params, scope: "rest", from: g.id, as_default: true }));
    toast("Applied to the following unreviewed slides (and future imports in this tray)");
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ dialogs
function fillSources(selectEl, preferPath) {
  const srcs = S.sources.filter((x) => x.count > 0);
  selectEl.innerHTML =
    srcs.map((x) => `<option value="${esc(x.path)}">${esc(x.scanner ? "Slide N Scan" : x.name)} (${x.new} new of ${x.count})</option>`).join("") +
    `<option value="__folder">A folder on this Mac…</option><option value="">Nothing yet</option>`;
  if (preferPath) selectEl.value = preferPath;
  else if (!srcs.length) selectEl.value = "";
  const sync = () => ($("nPathRow").hidden = selectEl.value !== "__folder");
  selectEl.onchange = sync;
  sync();
}

function openNew(prefSource) {
  $("newTitle").textContent = "New tray";
  $("nName").value = "";
  $("nAlbum").value = "";
  $("nDate").value = "";
  fillSources($("nSource"), prefSource?.path);
  $("newDlg").returnValue = "";
  $("newDlg").showModal();
  $("nName").focus();
}
window.openNew = openNew;

function openImport(src) {
  // import into the open tray if it hasn't been finished yet, otherwise start a new one
  if (cur && cur.summary.pending_upload + cur.summary.uploaded === 0) return startImport(curId, src.path);
  if (cur && !cur.summary.card_cleaned && cur.summary.uploaded < cur.summary.slides) {
    if (confirm(`Import ${src.new} scans into "${cur.summary.name}"?\n\nCancel to start a new tray instead.`))
      return startImport(curId, src.path);
  }
  openNew(src);
}
window.openImport = openImport;

async function startImport(sid, path) {
  try {
    await api("POST", `/api/sessions/${sid}/import`, { source: path });
    toast("Importing…");
    refreshState();
  } catch (e) { toast(e.message, true); }
}

$("newDlg").addEventListener("close", async () => {
  if ($("newDlg").returnValue !== "ok") return;
  const name = $("nName").value.trim() || `Tray ${new Date().toLocaleDateString()}`;
  try {
    const { id } = await api("POST", "/api/sessions", { name, album: $("nAlbum").value.trim(), date: $("nDate").value.trim() });
    await refreshState();
    await loadSession(id);
    let src = $("nSource").value;
    if (src === "__folder") src = $("nPath").value.trim();
    if (src) await startImport(id, src);
  } catch (e) { toast(e.message, true); }
});

$("settingsBtn").onclick = () => {
  const c = S.config;
  $("cfgUrl").value = c.immich_url || "";
  $("cfgKey").value = "";
  $("cfgKey").placeholder = c.has_key ? "saved - leave empty to keep it" : "paste your API key";
  $("cfgLib").value = c.library;
  $("cfgKeep").checked = c.keep_originals;
  $("cfgKeepExp").checked = c.keep_exports;
  $("testResult").textContent = "";
  $("settingsDlg").showModal();
};
$("testImmich").onclick = async () => {
  $("testResult").textContent = "Testing…";
  const r = await api("POST", "/api/immich/test", { immich_url: $("cfgUrl").value, immich_key: $("cfgKey").value });
  $("testResult").textContent = r.message;
  $("testResult").style.color = r.ok ? "var(--ok)" : "var(--bad)";
};
$("settingsDlg").addEventListener("close", async () => {
  if ($("settingsDlg").returnValue !== "save") return;
  await api("POST", "/api/config", {
    immich_url: $("cfgUrl").value.trim(), immich_key: $("cfgKey").value.trim(),
    library: $("cfgLib").value.trim(), keep_originals: $("cfgKeep").checked, keep_exports: $("cfgKeepExp").checked,
  });
  toast("Settings saved");
  refreshState();
});
$("helpBtn").onclick = () => $("helpDlg").showModal();
$("newSessionBtn").onclick = () => openNew();
$("sessionSelect").onchange = (e) => loadSession(e.target.value);

// ------------------------------------------------------------------ buttons
$("rotL").onclick = () => rotate(-90);
$("rotR").onclick = () => rotate(90);
$("rot180").onclick = () => rotate(180);
$("resetColour").onclick = resetColour;
$("trim").onchange = (e) => setParam("trim", e.target.checked, true);
$("copyPrev").onclick = copyPrev;
$("applyRest").onclick = applyRest;
$("reviewBtn").onclick = review;
$("skipBtn").onclick = toggleSkip;
$("mergeBtn").onclick = mergeNext;
$("beforeBtn").onmousedown = () => showBefore(true);
$("beforeBtn").onmouseup = $("beforeBtn").onmouseleave = () => showBefore(false);
document.querySelectorAll(".filters button").forEach(
  (b) => (b.onclick = () => {
    filter = b.dataset.filter;
    document.querySelectorAll(".filters button").forEach((x) => x.classList.toggle("on", x === b));
    renderStrip();
  }),
);
for (const [id, k] of [["sName", "name"], ["sAlbum", "album"], ["sDate", "date"]])
  $(id).onchange = async (e) => {
    try {
      cur = await api("PATCH", `/api/sessions/${curId}`, { [k]: e.target.value });
      renderAll();
      refreshState();
      if (k === "date") toast("Date saved - slides already in Immich get the new date on the next upload");
    } catch (err) { toast(err.message, true); }
  };
$("uploadBtn").onclick = async () => {
  if (!S.config.has_key || !S.config.immich_url) return $("settingsBtn").click();
  const unrev = cur.groups.filter((g) => !g.reviewed && !g.skip && g.status !== "uploaded").length;
  if (unrev && !confirm(`${unrev} slide(s) haven't been reviewed yet. Upload them with the automatic settings anyway?`)) return;
  try {
    await api("POST", `/api/sessions/${curId}/finish`);
    refreshState();
  } catch (e) { toast(e.message, true); }
};
$("cleanBtn").onclick = async () => {
  if (!confirm(`Delete this tray's ${cur.summary.scans} scans from the scanner's card?\n\nThey are safely copied and uploaded. This cannot be undone on the card.`)) return;
  try { await api("POST", `/api/sessions/${curId}/cleanup`); refreshState(); } catch (e) { toast(e.message, true); }
};
$("revealBtn").onclick = () => api("POST", "/api/reveal", { session: curId }).then((r) => toast(r.path));

function showBefore(on) {
  const g = current();
  if (!g) return;
  $("viewer").classList.toggle("before", on);
  const img = $("mainImg");
  const url = previewUrl(g, 1600, on);
  if (on) {
    const pre = new Image();
    pre.onload = () => $("viewer").classList.contains("before") && (img.src = url);
    pre.src = url;
  } else img.src = previewUrl(g, 1600, false);
}

// ------------------------------------------------------------------ keyboard
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input:not([type=range]), select, textarea") || document.querySelector("dialog[open]")) return;
  if (!cur || !cur.groups.length) return;
  const k = e.key;
  if (k === "ArrowRight" || k === "ArrowDown") select(sel + 1);
  else if (k === "ArrowLeft" || k === "ArrowUp") select(sel - 1);
  else if (k === " " || k === "Enter") review();
  else if (k === "r") rotate(90);
  else if (k === "R") rotate(-90);
  else if (k === "x" || k === "X") toggleSkip();
  else if (k === "m" || k === "M") mergeNext();
  else if (k === "c" || k === "C") copyPrev();
  else if (k === "0") resetColour();
  else if (k === "b" || k === "B") { if (!e.repeat) showBefore(true); }
  else if (k === "?") $("helpDlg").showModal();
  else if (/^[1-9]$/.test(k)) { const sc = current().scans[+k - 1]; if (sc) toggleScan(sc); }
  else return;
  e.preventDefault();
});
document.addEventListener("keyup", (e) => {
  if (e.key === "b" || e.key === "B") showBefore(false);
});

refreshState().then(() => curId && S.sessions.some((s) => s.id === curId) && loadSession(curId));
setInterval(refreshState, 2000);
