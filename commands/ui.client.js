/* ui.client.js — the browser half.
 *
 * WHY THIS IS A FILE. It lived inside page()'s template literal, where every
 * escape is consumed twice and one backtick kills the script. Four dead-page
 * bugs in a single session came from that (G65), each invisible: HTTP 200,
 * nothing in any log. A plain file has nothing to escape, `node --check` parses
 * it, and tests/unit/ui-client.test.mjs runs it in node:vm against a stub DOM.
 *
 * PREACT AND HTM ARRIVE AS GLOBALS, from commands/vendor/*.js. UMD, not ESM,
 * because `new Script()` cannot resolve `import` and the headless suite depends
 * on this staying a plain script. Verified: the three UMD builds attach
 * preact / preactHooks / htm to globalThis under node:vm.
 *
 * -- THE DESIGN (rewritten 2026-10-15, plan ticklish-gathering-brook) ----------
 *
 * Four views built for what a human DOES, plus a secondary Explore set. The
 * nine views this replaces were a taxonomy of data sources: nobody opens this
 * thinking "I will do some handovers", they think "what needs me", and no tab
 * answered that.
 *
 *   JUDGE    the edges you can write a verdict on now, with the evidence beside them.
 *   UNBLOCK  which unsettled root holds the most blocked edges back.
 *   HEALTH   doctor's fail and accepted rows, each with the one thing to do.
 *   ACTIVITY verdicts per day and the commands you ran. Trends only.
 *   Explore  registers (read-only), the graph, reminders.
 *
 * ONE COUNT DEFINITION, SHARED WITH THE WIDGET. The unit is an EDGE. The Judge
 * badge is `inbox.worklist.toJudge`, computed by the widget's own function over
 * the very items this page renders, so "51 to judge" means the same thing in
 * both places. This page prints no number of its own: every figure is read from
 * a payload or derived from rows on screen.
 *
 * EVERY FAILURE HAS A VOICE. Four states per view -- loading, empty, error, data
 * -- because an empty list and a failed one that look alike are the same defect
 * rule:discernment-checks section 2 names. A rejected fetch, a 401, a 500 and a
 * non-JSON body each end in a sentence on screen (#70.4); none leaves a skeleton.
 *
 * THE WRITE PATH IS HELD, NOT COMPENSATED. The event store is append-only and
 * DISPOSITIONS is frozen, so there is no "undone" event to write. A verdict is
 * delayed five seconds instead, which buys a real undo without either having to
 * move. At most one is outstanding; a second verdict flushes the first.
 */

const { h, render } = preact;
const { useState, useEffect, useRef, useCallback, useMemo } = preactHooks;
const html = htm.bind(h);

const TOKEN = document.body.dataset.token;
// The id of the files THIS page was read from (F5). null when the page was not
// served by a build-aware server; the staleness check then has nothing to say.
const BUILD = document.body.dataset.build || null;

/* -- one transport -------------------------------------------------------- */

const TOKEN_EXPIRED = "token expired, reopen from the widget";

/**
 * Every request in this file goes through here (#70.4, F8, F9).
 *
 * It RESOLVES, never throws, and it always says which of five things happened,
 * because the old wrapper was `fetch().then(r => r.json())` and each way it could
 * fail was a different silent defect: a 403 body was read as data, a stale tab
 * crashed on `undefined.fatal`, and a rejected fetch left a skeleton on screen
 * for ever.
 *
 *   kind "token"    401 (or the server's stable `error:"token"`)  -> reopen from the widget
 *   kind "http"     any other non-2xx; `error` is the server's own sentence when it sent one
 *   kind "network"  fetch rejected; the server is not there
 *   kind "parse"    a 2xx or an error page whose body is not JSON
 *   kind "aborted"  we cancelled it; callers drop the result and say nothing
 *
 * 207 is a 2xx on purpose: a partial dispose is a RESULT with per-edge detail,
 * and `data.ok` tells the caller it was not total.
 */
async function request(p, o, as) {
  const opts = Object.assign({}, o || {});
  let r;
  try {
    r = await fetch(p + (p.indexOf("?") >= 0 ? "&" : "?") + "token=" + TOKEN, opts);
  } catch (e) {
    if (e && e.name === "AbortError") return { ok: false, kind: "aborted", status: 0, error: "request cancelled", data: null };
    return { ok: false, kind: "network", status: 0, error: "could not reach the server — " + String((e && e.message) || e), data: null };
  }
  const status = r.status || 0;
  let text = "";
  try { text = await r.text(); } catch (e) { text = ""; }
  const good = typeof r.ok === "boolean" ? r.ok : (status >= 200 && status < 300);
  let data = null;
  let parsed = false;
  if (as !== "text") {
    try { data = JSON.parse(text); parsed = true; } catch (e) { parsed = false; }
  } else {
    data = text;
    parsed = true;
  }
  if (status === 401 || (parsed && data && data.error === "token")) {
    return { ok: false, kind: "token", status: status, error: TOKEN_EXPIRED, data: parsed ? data : null };
  }
  if (!good) {
    const said = parsed && as !== "text" && data && typeof data.error === "string" ? data.error
      : (as === "text" && text ? text : null);
    return { ok: false, kind: "http", status: status, error: said || ("the server answered " + status), data: parsed ? data : null };
  }
  if (!parsed) {
    return { ok: false, kind: "parse", status: status, error: "the server answered " + status + " with something that is not JSON", data: null };
  }
  return { ok: true, kind: "ok", status: status, error: null, data: data };
}
const api = (p, o) => request(p, o, "json");
const apiText = (p, o) => request(p, o, "text");

const JSON_HEADERS = { "content-type": "application/json" };

/* -- views ---------------------------------------------------------------- */

// ROUTE RENAME 2026-10-15 (plan F11): nine data-source views became the views
// built for what a human does -- judge, unblock, health, activity -- plus the
// secondary Explore set. Keys are exactly SERVED_VIEWS minus the slash
// (lib/report/surface.mjs), asserted by widget-contract.test.mjs.
const DIVISIONS = [
  { key: "judge", label: "JUDGE", act: true },
  { key: "unblock", label: "UNBLOCK", act: true },
  { key: "health", label: "HEALTH" },
  { key: "activity", label: "ACTIVITY" },
  { key: "registers", label: "REGISTERS", explore: true },
  { key: "reminders", label: "REMINDERS", explore: true },
  // Framed rather than dropped: lib/graph/graph-html.mjs renders a whole
  // interactive page at /graph, and open-ui.sh turns a widget route into a
  // hash -- so a link to it only resolves if the client routes it. It used to
  // be written to disk and opened standalone, which made it a second place
  // with no way back.
  { key: "graph", label: "GRAPH", explore: true },
];

/* Every hash an older widget or bookmark can still send, and where it lands.
   The new keys map to themselves so readHash has ONE lookup. */
const HASH_TO_VIEW = { ready: "judge", parked: "judge", gap: "judge", blocked: "unblock",
  reference: "health", analytics: "activity", stream: "activity", conflicts: "reminders",
  judge: "judge", unblock: "unblock", health: "health", activity: "activity",
  registers: "registers", reminders: "reminders", graph: "graph" };

/* PR-025, re-derived. The rail's group separator used to be `i === 4`, a
   position that was one insertion away from silently labelling the wrong group.
   The rule it stands for is "before the first Explore view", so it is derived
   from the data: `explore: true` on a division is what puts it under the line. */
const FIRST_EXPLORE = DIVISIONS.findIndex((d) => d.explore);

/* Keys are offered from item.allowed so the UI can never propose a disposition
 * the write path will refuse. A control that always errors is worse than none. */
const KEYS = { n: "no-change-needed", p: "propagated", d: "deferred", r: "both-reconciled" };
const keyFor = (disp) => Object.keys(KEYS).find((k) => KEYS[k] === disp) || null;

const UNDO_MS = 5000;
const EVIDENCE_DEBOUNCE_MS = 150;
const MIN_REASON = 12;
const SEEN_POST_MAX = 5000;   // seen-edges.mjs MAX_POST; a longer list is sent in slices

const short = (p) => String(p || "").split("/Documents/GitHub/")[1] || p || "";

/* -- small pure helpers --------------------------------------------------- */

/** A fraction, or null when the denominator is not a positive number (#70.6). */
function ratio(n, d) {
  return typeof n === "number" && typeof d === "number" && d > 0 && isFinite(n / d) ? n / d : null;
}
/** A percentage that cannot print NaN: anything that is not a finite fraction is "unknown". */
function pct(x) {
  return typeof x === "number" && isFinite(x) ? Math.round(x * 100) + "%" : "unknown";
}
/** Join the parts that exist with a middle dot. A missing part leaves no stray separator (#70.3). */
function dot() {
  const parts = [];
  for (let i = 0; i < arguments.length; i++) {
    const p = arguments[i];
    if (p !== null && p !== undefined && p !== "" && p !== false) parts.push(p);
  }
  return parts.join(" · ");
}
/** "14 min old", never "NaN min old". */
function ageLabel(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "age unknown";
  if (ms < 60000) return "under a minute old";
  if (ms < 3600000) return Math.round(ms / 60000) + " min old";
  if (ms < 86400000) return Math.round(ms / 3600000) + " h old";
  return Math.round(ms / 86400000) + " d old";
}
const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));

/** POSIX single-quote, for a value that goes into a command a person will paste (disposition.mjs shellQuote). */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
/**
 * The command for an edge the UI will not write a baseline for.
 *
 * A baseline pins the current bytes of BOTH files as correct without anyone
 * having read a diff, so it is a different operation from a verdict and stays on
 * the command line. `--disposition baselined` is the form `verify` accepts
 * (lib/edges/disposition.mjs; cli.mjs verify) and it requires a reason that names
 * its evidence, so the reason slot is a placeholder rather than an invented one.
 */
function baselineCommand(edgeId) {
  return "propagate verify --edge " + shellQuote(edgeId) + " --disposition baselined --reason "
    + shellQuote("<what you checked, as file:line>") + " --apply";
}
function gitDiffCommand(since, file) {
  return "git diff " + shellQuote(since) + " -- " + shellQuote(file);
}

/* -- shaping: pure, reachable from the headless tests --------------------- */

/** The workspace a queue item belongs to. An item with no fix-order position is its own group, never dropped. */
function workspaceOf(item) {
  if (item.orderMissing) return "unplaced";
  return String(item.sourceShort || "").split("/")[0] || "other";
}

/**
 * Rows grouped by workspace, then by source node, in the order the server sent
 * them. The server's order is fixOrder's (roots before leaves) and that sequence
 * is the whole promise of "start at the top", so grouping keeps first-seen order
 * at both levels instead of re-sorting.
 */
function groupRows(rows) {
  const ws = new Map();
  const flat = [];
  for (const r of rows || []) {
    const w = workspaceOf(r);
    if (!ws.has(w)) ws.set(w, { ws: w, nodes: new Map(), count: 0 });
    const g = ws.get(w);
    const nk = r.node_id || r.edge_id;
    if (!g.nodes.has(nk)) g.nodes.set(nk, { node_id: nk, rows: [] });
    g.nodes.get(nk).rows.push(r);
    g.count += 1;
  }
  const groups = [];
  for (const g of ws.values()) {
    const nodes = [...g.nodes.values()];
    for (const n of nodes) for (const r of n.rows) flat.push(r);
    groups.push({ ws: g.ws, count: g.count, nodes: nodes });
  }
  return { groups: groups, flat: flat };
}

/**
 * The dispositions a parked row may take. The inbox's parked items carry no
 * `allowed` (parkedFrom), so it is DERIVED from the queue: a parked edge is
 * NEVER_VERIFIED and never DIVERGED, which allowedDispositions() answers the same
 * way for every non-DIVERGED row. The longest such list is taken. If the queue
 * holds no such row there is nothing to derive from and the answer is "none" --
 * which renders as read-only, not as a guess. The server re-checks ordering.
 */
function parkedAllowed(inbox) {
  const w = (inbox && inbox.divisions && inbox.divisions.worklist) || {};
  let best = [];
  for (const r of (w.ready || []).concat(w.blocked || [])) {
    if (r.state !== "DIVERGED" && Array.isArray(r.allowed) && r.allowed.length > best.length) best = r.allowed;
  }
  return best;
}

/**
 * The Judge populations, from ONE payload. `held` hides edges whose verdict is
 * pending or in flight (F8): a row you just judged must not be judgeable again
 * while its write is five seconds from landing.
 *
 * `badge` is `inbox.worklist.toJudge` -- the widget's count over these same
 * items -- and is NOT recomputed from the rows below, because the point is that
 * two independent derivations agree (tests assert it). null means the payload
 * did not carry it, which renders blank rather than 0.
 */
function judgeModel(inbox, held) {
  const hide = held || new Set();
  const d = inbox && inbox.divisions;
  if (!d) return null;
  const w = d.worklist || {};
  const ready = (w.ready || []).filter((r) => !hide.has(r.edge_id));
  const toJudge = ready.filter((r) => r.state !== "DIVERGED");
  const diverged = ready.filter((r) => r.state === "DIVERGED");
  const allowed = parkedAllowed(inbox);
  const parked = ((d.parked && d.parked.items) || [])
    .filter((r) => !hide.has(r.edge_id))
    .map((r) => Object.assign({}, r, { parked: true, allowed: Array.isArray(r.allowed) ? r.allowed : allowed, allowedDerived: !Array.isArray(r.allowed) }));
  const wl = inbox.worklist || null;
  return {
    toJudge: toJudge,
    diverged: diverged,
    parked: parked,
    badge: wl && typeof wl.toJudge === "number" ? wl.toJudge : null,
    includesUnplaced: wl && wl.toJudgeIncludesUnplaced ? wl.toJudgeIncludesUnplaced : 0,
    // A division that failed arrives with `ready: null` and an `error`. Reading null
    // as an empty list would say "nothing to judge" about a queue that could not be
    // computed -- the one confusion every empty state here exists to prevent.
    errors: { worklist: w.error || null, parked: (d.parked && d.parked.error) || null },
    blockedN: (w.blocked || []).length,
    gapTotal: d.gap && typeof d.gap.total === "number" ? d.gap.total : null,
    checked: wl && typeof wl.total === "number" ? wl.total : null,
    rootsTotal: inbox.leverage && typeof inbox.leverage.rootsTotal === "number" ? inbox.leverage.rootsTotal : null,
    // Every edge id anywhere in the payload, held or not: selection pruning asks
    // "is this still in the payload", and a held row still is.
    allIds: new Set((w.ready || []).concat(w.blocked || [], (d.parked && d.parked.items) || []).map((r) => r.edge_id)),
  };
}

/** Rail counts. Null means not loaded, which is not the same as zero. */
function counts(inbox) {
  if (!inbox || !inbox.divisions) return {};
  return {
    judge: inbox.worklist && typeof inbox.worklist.toJudge === "number" ? inbox.worklist.toJudge : null,
    unblock: inbox.leverage && typeof inbox.leverage.blocked === "number" ? inbox.leverage.blocked : null,
  };
}

/** The dispositions allowed for EVERY row: offering one that any member would refuse makes a batch that cannot land whole. */
function intersectAllowed(rows) {
  if (!rows || !rows.length) return [];
  let out = (rows[0].allowed || []).slice();
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i].allowed || [];
    out = out.filter((x) => a.indexOf(x) >= 0);
  }
  return out;
}

/** Drop selected ids that are no longer anywhere in the payload (F8): a stale tick must not write. */
function pruneTicked(ticked, allIds) {
  const out = new Set();
  for (const id of ticked) if (allIds.has(id)) out.add(id);
  return out.size === ticked.size ? ticked : out;
}

/**
 * A path that BREAKS on null.
 *
 * A gap in the timeline is a day nobody measured. Drawing a line across it
 * asserts a reading that was never taken -- the same defect as an empty result
 * rendering identically to a failed one, one plane over.
 */
function linePath(points, x, y) {
  let d = "";
  let pen = false;
  (points || []).forEach((p, i) => {
    if (p.value == null) { pen = false; return; }
    d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(p.value).toFixed(1) + " ";
    pen = true;
  });
  return d.trim();
}

/** The Unblock model: roots that free something now first, then joint blockers grouped by file. */
function unblockModel(inbox) {
  const lv = inbox && inbox.leverage;
  if (!lv) return null;
  const all = lv.allRoots || [];
  const byId = new Map(all.map((r) => [r.edge_id, r]));
  return {
    blocked: lv.blocked,
    rootsTotal: lv.rootsTotal,
    needAllRoots: lv.needAllRoots,
    // allRoots arrives in the widget's own order (freesNow, then reach); the
    // filter keeps that order, it only separates the roots that help ALONE.
    ranked: all.filter((r) => r.freesNow > 0),
    // MERGED BY ROOT SET. buildLeverage keys a group by the file the blocked edges flow
    // into, so the same two roots repeated once per file: the live pass on 2026-10-15
    // showed the ports.yml pair three times over, under three different files. What the
    // reader has to DO is "settle this set of roots", so the set is the group and the
    // files are its description.
    byFile: [...(lv.byFile || []).reduce((acc, g) => {
      const ids = [...(g.roots || [])].sort();
      const key = ids.join(" ");
      const cur = acc.get(key) || { files: [], blockedEdges: 0, ids };
      cur.files.push(g.file);
      cur.blockedEdges += g.blockedEdges || 0;
      acc.set(key, cur);
      return acc;
    }, new Map()).values()].map((g) => ({
      file: g.files.join(" · "),
      files: g.files,
      blockedEdges: g.blockedEdges,
      roots: g.ids.map((id) => byId.get(id) || { edge_id: id, inQueue: false, source: null, downstream: null, freesNow: 0, upstreamOf: 0, unknown: true }),
    })),
    checked: inbox.worklist && typeof inbox.worklist.total === "number" ? inbox.worklist.total : null,
  };
}

/** Health: one summary and one fail-then-accepted list; warn stays per section. */
function healthModel(h) {
  if (!h || h.ok === false) return null;
  const sections = h.sections || [];
  const rows = { fail: [], accepted: [] };
  const warn = [];
  for (const s of sections) {
    for (const e of s.entries || []) {
      if (e.kind === "fail" || e.kind === "inconclusive") rows.fail.push(Object.assign({ section: s.name }, e));
      else if (e.kind === "accepted") rows.accepted.push(Object.assign({ section: s.name }, e));
    }
    const w = (s.entries || []).filter((e) => e.kind === "warn");
    if (w.length) warn.push({ name: s.name, entries: w });
  }
  const t = h.totals || {};
  return {
    fail: typeof t.fail === "number" ? t.fail : rows.fail.length,
    accepted: typeof t.accepted === "number" ? t.accepted : rows.accepted.length,
    warn: typeof t.warn === "number" ? t.warn : warn.reduce((n, s) => n + s.entries.length, 0),
    warnSections: warn.length,
    rows: rows,
    warnBySection: warn,
    ageMs: h.ageMs,
  };
}

/**
 * The body for a held verdict. A single edge keeps the shape every older caller
 * and the CLI-shaped tests know; a selection of any size sends {edges}, because
 * a selection crosses nodes and the node_id batch cannot express that (D9).
 * `observed` is the content pair the reviewer was shown (F1): sent only when the
 * evidence loaded, since claiming to have seen bytes that never arrived would
 * defeat the check it feeds.
 */
function disposeBody(p) {
  if (p.kind === "bulk") {
    return {
      edges: p.entries.map((e) => {
        const o = { edge_id: e.edge_id, state: e.state };
        if (e.observed) o.observed = e.observed;
        return o;
      }),
      disposition: p.disposition,
      reason: p.reason,
    };
  }
  const e = p.entries[0];
  const body = { edge_id: e.edge_id, disposition: p.disposition, reason: p.reason };
  if (e.observed) body.observed = e.observed;
  return body;
}

/* -- charts: inline SVG, no library --------------------------------------- */

function Spark({ points, stroke, label }) {
  const ref = useRef(null);
  const pts = points || [];
  const vals = pts.filter((p) => p.value != null).map((p) => p.value);
  const max = vals.length ? Math.max(...vals) : 1;
  const W = 300;
  const H = 110;
  const PAD = 6;
  const x = (i) => PAD + (i / Math.max(1, pts.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - (v / (max || 1)) * (H - PAD * 2);
  const d = linePath(pts, x, y);

  // --len is each path's measured length; only the browser knows it. The CSS
  // draw-in reads it as a dash offset, and falls back to 0 without it.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.getTotalLength !== "function") return;
    const len = el.getTotalLength();
    el.style.setProperty("--len", String(len));
    el.style.strokeDasharray = String(len);
  }, [d]);

  if (!vals.length) return html`<div class="reason">no readings in this series</div>`;
  const gaps = pts.filter((p) => p.value == null).length;
  return html`
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label=${label || "series"}>
      <line class="axis" x1=${PAD} y1=${H - PAD} x2=${W - PAD} y2=${H - PAD} />
      <line class="gridline" x1=${PAD} y1=${y(max)} x2=${W - PAD} y2=${y(max)} />
      <path ref=${ref} class="series" d=${d} style=${{ stroke: stroke }} />
      <text class="lbl" x=${PAD} y=${y(max) - 4}>${max}</text>
      ${gaps ? html`<text class="lbl" x=${W - PAD} y=${12} text-anchor="end">${gaps} day(s) with no run</text>` : null}
    </svg>`;
}

function Bars({ rows, colorOf }) {
  const total = rows.reduce((n, r) => n + r.value, 0);
  return html`<div>
    ${rows.map((r) => html`
      <div key=${r.label} class="bar">
        <span class="bar-l">${r.label}</span>
        <span class="bar-t"><span class="bar-f" style=${{ width: (total > 0 ? 100 * r.value / total : 0).toFixed(1) + "%", background: colorOf(r) }} /></span>
        <span class="bar-v">${r.value}</span>
      </div>`)}
  </div>`;
}

function Chart({ title, coverage, children }) {
  return html`<div class="chart">
    <h3>${title}</h3>
    ${coverage ? html`<div class="cov">${coverage}</div>` : null}
    ${children}
  </div>`;
}

/* -- shared pieces -------------------------------------------------------- */

const Skeleton = ({ rows }) => html`<div>${Array.from({ length: rows || 3 }, (_, i) => html`<div class="skel" key=${i}><i /><i /></div>`)}</div>`;

/**
 * An error with a way out. A 401 has nothing to retry -- the token in this tab is
 * dead -- so it offers the instruction instead of a button that cannot work.
 */
function ErrorBanner({ what, st, retry }) {
  const token = st && st.kind === "token";
  return html`<div class="banner" role="alert">
    <b>${what}</b> ${token ? TOKEN_EXPIRED : (st && st.error) || "failed for a reason the server did not give"}
    ${token || !retry ? null : html` <button class="ghost" onClick=${retry}>retry</button>`}
  </div>`;
}

function Copy({ text, label }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    const ok = () => { setDone(true); setTimeout(() => setDone(false), 1500); };
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, () => {});
        return;
      }
    } catch (e) { /* the text is visible beside the button; selecting it is the fallback */ }
  };
  return html`<button class="ghost" onClick=${copy}>${done ? "copied" : (label || "copy")}</button>`;
}

/** A command a person pastes: the text is always visible, so a blocked clipboard still leaves something to select. */
const Cmd = ({ text, label }) => html`<div class="cmdrow"><code class="cmd">${text}</code><${Copy} text=${text} label=${label} /></div>`;

/**
 * A request-backed value with the staleness rule built in (F8). Every call to
 * `run` takes a number; only the latest number may write state, so a slow
 * response that was overtaken by a refresh cannot paint over the newer one.
 * `enabled` gates the first fetch (lazy views); `run` is the retry and refresh.
 */
function useResource(path, enabled) {
  const [st, setSt] = useState({ status: "idle" });
  const seq = useRef(0);
  const started = useRef(false);
  const run = useCallback(async () => {
    started.current = true;
    const n = ++seq.current;
    setSt((s) => (s.status === "ok" ? Object.assign({}, s, { refreshing: true }) : { status: "loading" }));
    const r = await api(path);
    if (n !== seq.current || r.kind === "aborted") return;
    setSt(r.ok ? { status: "ok", data: r.data } : { status: "error", kind: r.kind, error: r.error });
  }, [path]);
  useEffect(() => {
    if (enabled && !started.current) run();
  }, [enabled, run]);
  return [st, run];
}

/* -- the undo window ------------------------------------------------------ */

function Undo({ pending, onUndo, reduced }) {
  const [left, setLeft] = useState(Math.ceil(UNDO_MS / 1000));
  useEffect(() => {
    setLeft(Math.ceil(UNDO_MS / 1000));
    const iv = setInterval(() => setLeft((n) => (n > 1 ? n - 1 : 1)), 1000);
    return () => clearInterval(iv);
  }, [pending.id]);
  return html`<div class="undo">
    <svg class="ring" viewBox="0 0 22 22" aria-hidden="true">
      <circle class="bed" cx="11" cy="11" r="9" /><circle class="arc" cx="11" cy="11" r="9" />
    </svg>
    <span>${pending.disposition} — <b>${pending.label}</b></span>
    ${/* The ring IS the clock, so when motion is off the number has to carry it. */ ""}
    <span class="secs">${reduced ? left + "s" : ""}</span>
    <button class="ghost" onClick=${onUndo}>undo <kbd>u</kbd></button>
  </div>`;
}

/* -- evidence ------------------------------------------------------------- */

/**
 * One side of the evidence. Every state has its own sentence: an unreadable
 * diff must never look like an unchanged one (rule:discernment-checks 2), and
 * the downstream's emptiness means something the source's does not -- the
 * source moved and this did not.
 */
function EvidenceBox({ side, ev, file }) {
  const title = side === "source" ? "Source" : "Downstream";
  const head = html`<div class="sec">${title}${file ? html` <span class="mono">${short(file)}</span>` : null}</div>`;
  if (!ev) return html`<div class="evbox">${head}<div class="ev skeleton"><div class="skel"><i /><i /></div></div></div>`;
  if (ev.ok === false) {
    return html`<div class="evbox">${head}<div class="reason">${ev.reason || "this side could not be read, and the server gave no reason"}</div></div>`;
  }
  if (ev.empty) {
    const t = side === "downstream"
      ? "Unchanged since last judged. The source moved and this did not: that is drift."
      : (ev.reason || "Unchanged since last judged.");
    return html`<div class="evbox">${head}<div class="reason">${t}</div></div>`;
  }
  return html`<div class="evbox">
    ${head}
    ${ev.noPriorVerdict ? html`<div class="caveat">${ev.reason || "no earlier verdict to diff against — showing the current content"}</div>` : null}
    ${ev.caveat ? html`<div class="caveat">${ev.caveat}</div>` : null}
    <div class="ev" tabIndex="0" role="region" aria-label=${title + " diff"}>${ev.text}</div>
    ${ev.truncated ? html`<div class="trunc">${ev.truncated}</div>` : null}
    ${ev.truncated && ev.since && file ? html`<${Cmd} text=${gitDiffCommand(ev.since, file)} label="copy git diff" />` : null}
  </div>`;
}

function EvidencePane({ entry, row }) {
  if (!entry) {
    return html`<div class="evgrid" aria-busy="true"><${EvidenceBox} side="source" ev=${null} file=${row.source} /><${EvidenceBox} side="downstream" ev=${null} file=${row.downstream} /></div>`;
  }
  if (entry.status === "error") {
    return html`<div class="banner" role="alert"><b>evidence</b> ${entry.error} — you can still give a verdict, but you will be judging without the diff.</div>`;
  }
  const d = entry.data || {};
  return html`<div class="evgrid">
    <${EvidenceBox} side="source" ev=${d} file=${row.source} />
    <${EvidenceBox} side="downstream" ev=${d.downstream} file=${row.downstream} />
  </div>`;
}

/* -- the Judge view ------------------------------------------------------- */

const CHIPS = [
  { key: "judge", label: "To judge" },
  { key: "diverged", label: "Both sides moved" },
  { key: "parked", label: "Parked" },
  { key: "never", label: "Never verified" },
];

function ReasonBox({ id, label, value, onInput, placeholder }) {
  return html`<div class="reasonbox">
    <label for=${id} class="rlabel">${label}</label>
    <textarea id=${id} value=${value} onInput=${(e) => onInput(e.target.value)} placeholder=${placeholder}></textarea>
  </div>`;
}

function Row({ r, sel, ticked, isNew, onSelect, onTick }) {
  const label = r.sourceShort + " → " + r.downstreamShort;
  return html`<div class=${"item" + (sel ? " sel" : "") + (ticked ? " ticked" : "")} onClick=${onSelect} tabIndex="0"
      role="option" aria-selected=${sel ? "true" : "false"}>
    <input type="checkbox" class="tick" checked=${ticked} aria-label=${"select " + label}
      onClick=${(e) => e.stopPropagation()} onChange=${onTick} />
    <span class=${"badge " + r.state}>${String(r.state).slice(0, 3)}</span>
    <span class="itxt">
      <span class="ttl">${label}${isNew ? html` <span class="newdot" title="new since you last marked the queue seen">new</span>` : null}</span>
      <span class="meta">${dot(r.boundary, r.parked ? (r.ageDays == null ? "parked, age unknown" : "parked " + r.ageDays + "d ago") : (r.judgedCount ? "judged " + r.judgedCount + "x" : "never judged"),
        r.noiseRatio != null && r.noiseRatio >= 0.5 ? "mostly no-op" : null)}</span>
    </span>
  </div>`;
}

function JudgeView({ app, route }) {
  const { inboxSt, retryInbox, model, seen, ev, loadEvidence, evTick, reasons, bulkReason, hold, pending, undo, say,
    msg, reduced, markSeen, rendered } = app;
  const [chip, setChip] = useState("judge");
  const [idx, setIdxState] = useState(0);
  // The cursor is mirrored in a ref because the key handler is registered once and
  // two keys can arrive before a render: "j" then "x" must tick the row j moved to,
  // not the one the last render still shows.
  const idxRef = useRef(0);
  const setIdx = (v) => {
    const next = typeof v === "function" ? v(idxRef.current) : v;
    idxRef.current = next;
    setIdxState(next);
  };
  const [ticked, setTicked] = useState(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkRef = useRef(null);

  const rowsFor = (k) => (!model ? [] : k === "judge" ? model.toJudge : k === "diverged" ? model.diverged : k === "parked" ? model.parked : []);
  const rows = rowsFor(chip);
  const shaped = useMemo(() => groupRows(rows), [rows]);
  const flat = shaped.flat;
  const curAt = (list, i) => list[Math.min(i, Math.max(0, list.length - 1))] || null;
  const cur = curAt(flat, idx);
  const baseline = useResource("/api/baseline", chip === "never");

  // ?edge=<id>: Unblock's "Judge root" lands here. The edge may be in any
  // population (a DIVERGED root sits under its own chip), so find it rather than assume.
  const landed = useRef(null);
  useEffect(() => {
    if (!route.edge || !model || landed.current === route.edge) return;
    landed.current = route.edge;
    for (const k of ["judge", "diverged", "parked"]) {
      const list = groupRows(rowsFor(k)).flat;
      const at = list.findIndex((r) => r.edge_id === route.edge);
      if (at >= 0) { setChip(k); setIdx(at); return; }
    }
    say({ ok: false, text: "edge " + route.edge + " is not in the queue any more — it may already be settled; refresh to check" });
  }, [route.edge, model]);

  // F8: the selection is pruned against every payload, so a tick on an edge that
  // another window judged cannot be written.
  useEffect(() => {
    if (model) setTicked((t) => pruneTicked(t, model.allIds));
  }, [model]);

  const curId = cur ? cur.edge_id : null;
  const nextRow = flat[Math.min(idx, flat.length - 1) + 1];
  const nextId = nextRow ? nextRow.edge_id : null;

  // Evidence is fetched on SELECT, not on render: measured 0.43s per edge, so
  // prefetching the queue would be ~24s of serial work against one server (E3).
  // The 150ms debounce lets j-j-j skim past rows without a request each; the
  // controller cancels the one a newer selection overtook. The next row is
  // prefetched once the current one has landed -- one row, never the queue.
  useEffect(() => {
    if (!curId || chip === "never") return;
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    let alive = true;
    const t = setTimeout(async () => {
      await loadEvidence(curId, ctl ? ctl.signal : undefined);
      if (alive && nextId) loadEvidence(nextId);
    }, EVIDENCE_DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(t); if (ctl) ctl.abort(); };
  }, [curId, chip]);

  // "leaving Judge": the triples this view rendered become seen. Never on
  // opening -- advance-on-view marks things seen that nobody looked at (PR-023).
  const renderedKeys = useRef([]);
  renderedKeys.current = flat.map((r) => r.contentKey).filter(Boolean);
  rendered.current = renderedKeys;
  useEffect(() => () => { markSeen(renderedKeys.current); }, []);

  // ---- selection ----
  const toggle = (id) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clear = () => { setTicked(new Set()); setBulkOpen(false); };
  const tickedRows = useMemo(() => {
    const all = rowsFor("judge").concat(rowsFor("diverged"), rowsFor("parked"));
    return all.filter((r) => ticked.has(r.edge_id));
  }, [ticked, model]);
  const bulkAllowed = intersectAllowed(tickedRows);

  // ---- verdicts ----
  const evEntry = curId ? ev.current.get(curId) : null;
  const evSettled = !!evEntry;   // loaded OR errored: an unreadable diff must not block judging
  const observedOf = (id) => {
    const e = ev.current.get(id);
    return e && e.status === "ok" && e.data && e.data.contentIds ? e.data.contentIds : undefined;
  };
  const judgeOne = (r, disposition) => {
    if (!evSettled) { say({ ok: false, text: "the evidence is still loading — a verdict is offered once it has arrived or failed" }); return; }
    const reason = String(reasons.get(r.edge_id) || "").trim();
    if (reason.length < MIN_REASON) { say({ ok: false, text: "a reason of " + MIN_REASON + " or more characters is required — it lands in the ledger" }); return; }
    hold({ kind: "edge", entries: [{ edge_id: r.edge_id, state: r.state, observed: observedOf(r.edge_id) }], disposition: disposition, reason: reason,
      label: short(r.source) || r.edge_id });
  };
  const judgeBulk = (disposition) => {
    const reason = String(bulkReason.text || "").trim();
    if (reason.length < MIN_REASON) { say({ ok: false, text: "a reason of " + MIN_REASON + " or more characters is required — it lands in the ledger" }); return; }
    if (!tickedRows.length) return;
    hold({ kind: "bulk", entries: tickedRows.map((r) => ({ edge_id: r.edge_id, state: r.state, observed: observedOf(r.edge_id) })), disposition: disposition, reason: reason,
      label: plural(tickedRows.length, "edge") }, { onResult: (res) => setTicked((t) => {
        // refused rows stay ticked; written ones are done
        const keep = new Set();
        for (const x of res) if (!x.ok && t.has(x.edge_id)) keep.add(x.edge_id);
        return keep;
      }) });
  };

  // ---- keyboard ----
  const latest = useRef({});
  // The handler below is registered ONCE, so everything it reads that changes per
  // render goes through this ref. `judgeOne` closes over `evSettled`; calling the
  // first render's copy would keep the verdict keys refusing "evidence still
  // loading" for the life of the page.
  latest.current = { flat, chip, ticked, bulkAllowed, bulkOpen, evSettled, judgeOne };
  useEffect(() => {
    const onKey = (e) => {
      const L = latest.current;
      const cur = curAt(L.flat, idxRef.current);
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (typing) { if (e.key === "Escape") document.activeElement.blur(); return; }
      const k = e.key;
      if (k === "j" || k === "ArrowDown") { e.preventDefault(); setIdx((s) => Math.min(L.flat.length - 1, s + 1)); }
      else if (k === "k" || k === "ArrowUp") { e.preventDefault(); setIdx((s) => Math.max(0, s - 1)); }
      else if (k === "x" && cur) { e.preventDefault(); toggle(cur.edge_id); }
      else if (k === "J") {
        e.preventDefault();
        if (L.ticked.size) { setBulkOpen(true); setTimeout(() => { if (bulkRef.current && bulkRef.current.focus) bulkRef.current.focus(); }, 0); }
        else say({ ok: false, text: "tick rows with x first, then ⇧J gives them one verdict" });
      }
      else if (k === "Escape") { if (L.ticked.size || L.bulkOpen) { e.preventDefault(); clear(); } }
      else if (KEYS[k] && cur) {
        const row = cur;
        if ((row.allowed || []).indexOf(KEYS[k]) < 0) { say({ ok: false, text: KEYS[k] + " is not allowed for a " + row.state + " edge" }); return; }
        e.preventDefault();
        L.judgeOne(row, KEYS[k]);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // ---- render ----
  if (inboxSt.status !== "ok" && inboxSt.status !== "idle" && inboxSt.status !== "loading") {
    return html`<div class="list"><${ErrorBanner} what="the queue could not be read —" st=${inboxSt} retry=${retryInbox} /></div>
      <div class="detail"><div class="empty">Nothing is shown until the queue loads.</div></div>`;
  }
  if (!model) {
    if (inboxSt.data && inboxSt.data.fatal) {
      return html`<div class="list"><div class="banner" role="alert">${inboxSt.data.fatal}</div></div><div class="detail"><div class="empty">Nothing is shown until the queue loads.</div></div>`;
    }
    return html`<div class="list"><${Skeleton} rows=${5} /></div><div class="detail"><${Skeleton} rows=${2} /></div>`;
  }

  const seenOk = seen.status === "ok";
  const isNew = (r) => seenOk && r.contentKey && !seen.set.has(r.contentKey);
  const unseenCount = flat.filter((r) => r.contentKey && !(seen.set && seen.set.has(r.contentKey))).length;
  const counts4 = { judge: model.toJudge.length, diverged: model.diverged.length, parked: model.parked.length, never: model.gapTotal };

  const chipsBar = html`<div class="chips" role="group" aria-label="queue filter">
    ${CHIPS.map((c) => html`<button key=${c.key} class=${"chip" + (chip === c.key ? " on" : "")} aria-pressed=${chip === c.key ? "true" : "false"}
        onClick=${() => { setChip(c.key); setIdx(0); }}>${c.label} <b>${counts4[c.key] == null ? "" : counts4[c.key]}</b></button>`)}
    <button class="ghost chip-seen" disabled=${!rendered.current || !flat.length || unseenCount === 0} onClick=${() => markSeen(renderedKeys.current)}
      title="records the edges on screen as seen, so only later arrivals carry a new dot">Mark seen</button>
  </div>`;

  const seenNote = seen.status === "missing" ? html`<div class="note">No seen-set yet, so nothing is marked new. Mark seen to start tracking arrivals.</div>`
    : seen.status === "corrupt" || seen.status === "error" ? html`<div class="note">The seen-set could not be read (${seen.error}); new marks are off.</div>` : null;
  const unplacedNote = model.includesUnplaced > 0 ? html`<div class="note">${plural(model.includesUnplaced, "edge")} in the count ${model.includesUnplaced === 1 ? "has" : "have"} no place in the fix order and cannot be listed here.</div>` : null;

  const divErr = chip === "parked" ? model.errors.parked : chip === "never" ? null : model.errors.worklist;
  let listBody;
  if (divErr) {
    listBody = html`<div class="banner" role="alert"><b>${chip === "parked" ? "parked" : "the worklist"}</b> could not be computed — ${divErr}</div>`;
  } else if (chip === "never") {
    listBody = html`<div class="empty"><b>${model.gapTotal == null ? "unknown" : model.gapTotal} never verified.</b><br />
      They are read-only here: a baseline pins the current bytes of both files as correct without a verdict, which is a different operation from judging. The detail pane has the command.</div>`;
  } else if (!flat.length) {
    listBody = html`<div class="empty">${emptyJudge(chip, model, () => app.go("unblock"), (k) => { setChip(k); setIdx(0); })}</div>`;
  } else {
    listBody = html`<div role="listbox" aria-label="edges">${shaped.groups.map((g) => html`<div key=${g.ws}>
      <div class="ghead">${g.ws} <span class="gn">${g.count}</span></div>
      ${g.nodes.map((n) => html`<div key=${n.node_id}>
        <div class="nhead">${n.node_id}${n.rows.length > 1 ? html` <span class="gn">${n.rows.length}</span>` : null}</div>
        ${n.rows.map((r) => {
          const i = flat.indexOf(r);
          return html`<${Row} key=${r.edge_id} r=${r} sel=${cur && cur.edge_id === r.edge_id} ticked=${ticked.has(r.edge_id)} isNew=${isNew(r)}
            onSelect=${() => setIdx(i)} onTick=${() => toggle(r.edge_id)} />`;
        })}
      </div>`)}
    </div>`)}</div>`;
  }

  return html`
    <div class="list">${chipsBar}${seenNote}${unplacedNote}${listBody}</div>
    <div class="detail" key=${chip + ":" + (bulkOpen ? "bulk" : curId || "none")}>
      ${ticked.size && !bulkOpen ? html`<div class="bulkstrip"><b>${plural(ticked.size, "edge")} ticked.</b> <kbd>⇧J</kbd> gives them one verdict · <kbd>Esc</kbd> clears
        <button class="ghost" onClick=${() => setBulkOpen(true)}>give them one verdict</button></div>` : null}
      ${bulkOpen && ticked.size
        ? html`<${BulkPanel} rows=${tickedRows} allowed=${bulkAllowed} bulkReason=${bulkReason} onVerdict=${judgeBulk} onClear=${clear} inputRef=${bulkRef}
            pending=${pending} undo=${undo} reduced=${reduced} msg=${msg} />`
        : html`<${JudgeDetail} chip=${chip} cur=${cur} model=${model} entry=${evEntry} evSettled=${evSettled} reasons=${reasons} judgeOne=${judgeOne}
            baseline=${baseline[0]} pending=${pending} undo=${undo} reduced=${reduced} msg=${msg} evTick=${evTick} />`}
    </div>`;
}

/** F7: an empty queue names where the work went. */
function emptyJudge(chip, model, toUnblock, toChip) {
  if (chip === "parked") return html`<b>Nothing parked.</b><br />A deferred edge lands here with its reason.`;
  if (chip === "diverged") return html`<b>No edge has both sides moved.</b>`;
  const lines = [];
  if (model.blockedN > 0) lines.push(html`<div key="b">${plural(model.blockedN, "edge")} ${model.blockedN === 1 ? "is" : "are"} blocked${model.rootsTotal ? " on " + plural(model.rootsTotal, "root") : ""} <button class="ghost" onClick=${toUnblock}>Unblock</button></div>`);
  if (model.diverged.length > 0) lines.push(html`<div key="d">${plural(model.diverged.length, "edge")} need both sides edited <button class="ghost" onClick=${() => toChip("diverged")}>Both sides moved</button></div>`);
  if (model.parked.length > 0) lines.push(html`<div key="p">${model.parked.length} parked <button class="ghost" onClick=${() => toChip("parked")}>Parked</button></div>`);
  if (model.gapTotal) lines.push(html`<div key="n">${model.gapTotal} never verified <button class="ghost" onClick=${() => toChip("never")}>Never verified</button></div>`);
  return html`<b>Nothing to judge (${model.checked == null ? "sources checked" : plural(model.checked, "edge") + " checked"}).</b>${lines}`;
}

function VerdictBar({ allowed, disabled, onPick, note }) {
  return html`<div class="act disp" role="group" aria-label="verdict">
    ${allowed.map((a) => html`<button key=${a} disabled=${disabled} onClick=${() => onPick(a)}>
      ${a}${keyFor(a) ? html` <kbd>${keyFor(a)}</kbd>` : null}</button>`)}
    ${note}
  </div>`;
}

function JudgeDetail({ chip, cur, model, entry, evSettled, reasons, judgeOne, baseline, pending, undo, reduced, msg }) {
  if (chip === "never") return html`<${NeverVerified} model=${model} st=${baseline} />`;
  if (!cur) return html`<div class="empty">Nothing selected.</div>`;
  const r = cur;
  const allowed = r.allowed || [];
  const id = "reason-" + r.edge_id;
  return html`<div>
    <h2 class="dtitle">${r.sourceShort} → ${r.downstreamShort}</h2>
    <div class="dmeta">${dot(r.edge_id, r.state, r.layer != null ? "layer " + r.layer : null, r.boundary)}</div>
    ${r.why ? html`<div class="dmeta why">${r.why}</div>` : null}
    ${r.state === "DIVERGED" ? html`<div class="note">Both sides moved. Edit both files first, then give your verdict: only <b>both-reconciled</b> is offered.</div>` : null}
    ${r.parked ? html`<div class="note">Parked ${r.ageDays == null ? "at an unknown time" : r.ageDays + " days ago"}${r.by ? " by " + r.by : ""}${r.reason ? ": " + r.reason : " with no reason recorded — that is a finding, not an absence"}.${r.allowedDerived && !allowed.length ? " No dispositions could be derived for parked edges, so this one is read-only." : ""}</div>` : null}
    <${EvidencePane} entry=${entry} row=${r} />
    <div class="sec">Verdict</div>
    <${VerdictBar} allowed=${allowed} disabled=${!evSettled} onPick=${(a) => judgeOne(r, a)}
      note=${!evSettled ? html`<span class="meta">waiting for the evidence…</span>` : null} />
    <${ReasonBox} id=${id} key=${id} label=${"Reason for " + r.edge_id} value=${reasons.get(r.edge_id) || ""} onInput=${(v) => reasons.set(r.edge_id, v)}
      placeholder="why this disposition is correct (required, 12+ characters) — this text lands in the ledger" />
    ${pending ? html`<${Undo} pending=${pending} onUndo=${undo} reduced=${reduced} />` : null}
    ${msg ? html`<div class=${"msg " + (msg.ok ? "ok" : "err")}>${msg.text}</div>` : null}
    <div class="hint">
      <kbd>j</kbd><kbd>k</kbd> move · <kbd>x</kbd> tick · <kbd>⇧J</kbd> verdict for ticked · <kbd>n</kbd><kbd>p</kbd><kbd>d</kbd><kbd>r</kbd> judge · <kbd>u</kbd> undo · <kbd>Esc</kbd> clear
    </div>
  </div>`;
}

function BulkPanel({ rows, allowed, bulkReason, onVerdict, onClear, inputRef, pending, undo, reduced, msg }) {
  return html`<div>
    <h2 class="dtitle">${plural(rows.length, "edge")}, one verdict</h2>
    <div class="dmeta">Nothing is preselected. One disposition and one reason apply to every ticked edge.</div>
    <ul class="bulklist">${rows.slice(0, 12).map((r) => html`<li key=${r.edge_id}>${r.sourceShort} → ${r.downstreamShort} <span class=${"badge " + r.state}>${String(r.state).slice(0, 3)}</span></li>`)}
      ${rows.length > 12 ? html`<li>… and ${rows.length - 12} more</li>` : null}</ul>
    <div class="sec">Verdict</div>
    ${allowed.length
      ? html`<${VerdictBar} allowed=${allowed} disabled=${false} onPick=${onVerdict} />`
      : html`<div class="reason">These edges share no disposition. A both-sides-moved edge takes only both-reconciled, so it cannot be mixed with the others — untick one group.</div>`}
    <div class="reasonbox">
      <label for="reason-bulk" class="rlabel">One reason for all ${rows.length}</label>
      <textarea id="reason-bulk" ref=${inputRef} value=${bulkReason.text} onInput=${(e) => bulkReason.set(e.target.value)}
        placeholder=${"why this disposition is correct for all " + rows.length + " edges (required, 12+ characters) — this text lands in the ledger"}></textarea>
    </div>
    <div class="act"><button class="ghost" onClick=${onClear}>clear selection <kbd>Esc</kbd></button></div>
    ${pending ? html`<${Undo} pending=${pending} onUndo=${undo} reduced=${reduced} />` : null}
    ${msg ? html`<div class=${"msg " + (msg.ok ? "ok" : "err")}>${msg.text}</div>` : null}
  </div>`;
}

function NeverVerified({ model, st }) {
  const k = st && st.status === "ok" && st.data && st.data.buckets;
  return html`<div>
    <h2 class="dtitle">${model.gapTotal == null ? "unknown" : model.gapTotal} never verified</h2>
    <div class="dmeta">Read-only here. The inbox carries the count and the baseline buckets, not one row per edge.</div>
    <div class="sec">Why the UI writes no baseline</div>
    <div class="reason">A baseline pins the current bytes of BOTH files as correct without anyone having read a diff. It is not a verdict, and a button that wrote one would be the cheapest way to close a backlog without judging it. Roots that block other work are listed in Unblock, each with its command.</div>
    <div class="sec">Where they stand</div>
    ${!st || st.status === "idle" || st.status === "loading" ? html`<${Skeleton} rows=${2} />`
      : st.status === "error" ? html`<${ErrorBanner} what="the baseline split could not be read —" st=${st} />`
      : st.data && st.data.error ? html`<div class="banner" role="alert">${st.data.error}</div>`
      : html`<div>
          <${Bars} rows=${[
            { label: "baselineable now", value: k.baselineable },
            { label: "no co-commit found", value: k.noCoCommit },
            { label: "walk bound reached", value: k.boundReached },
            { label: "cross-repo, PERMANENT", value: k.ineligibleCrossRepo },
            { label: "examined and parked", value: k.examinedAndDeferred },
          ]} colorOf=${(r) => (/PERMANENT/.test(r.label) ? "var(--dim)" : "var(--st-accent)")} />
          <div class="caveat">${k.ineligibleCrossRepo} are cross-repo. Two independent histories cannot share a commit, so that slice is structural and will never clear. It is not a backlog.</div>
          ${st.data.accountedFor ? null : html`<div class="banner" role="alert">the buckets do not sum to the total — ${st.data.unaccounted} unaccounted</div>`}
        </div>`}
    <div class="sec">The bulk command</div>
    <${Cmd} text="propagate bootstrap --baseline-from-git" label="copy" />
    <div class="hint">A dry run. Add <b>--apply</b> to write; every applied write is a <b>baselined</b> event with its evidence.</div>
  </div>`;
}

/* -- Unblock -------------------------------------------------------------- */

function RootRow({ r, go }) {
  const label = r.unknown ? r.edge_id : (r.source + " → " + r.downstream);
  return html`<div class="root">
    <span class=${"badge " + (r.inQueue ? "DRIFTED" : "NEVER_VERIFIED")}>${r.inQueue ? "root" : "NEVER VERIFIED"}</span>
    <div class="itxt">
      <span class="ttl">${label}</span>
      <span class="meta">${dot(r.unknown ? null : "frees " + r.freesNow + " now", r.upstreamOf != null && !r.unknown ? "upstream of " + r.upstreamOf : null, r.edge_id)}</span>
      ${r.inQueue || r.unknown ? null : html`<div class="note">Not in the queue: it has never been verified, and the UI does not write a baseline. Run it where you can read it first.</div>
        <${Cmd} text=${baselineCommand(r.edge_id)} label="copy command" />`}
    </div>
    ${r.inQueue ? html`<button onClick=${() => go(r.edge_id)}>Judge root</button>` : null}
  </div>`;
}

function UnblockView({ app }) {
  const { inboxSt, retryInbox } = app;
  if (inboxSt.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="the queue could not be read —" st=${inboxSt} retry=${retryInbox} /></div>`;
  const m = unblockModel(inboxSt.data);
  if (!m) {
    return html`<div class="detail wide">${inboxSt.data && inboxSt.data.fatal ? html`<div class="banner" role="alert">${inboxSt.data.fatal}</div>` : html`<${Skeleton} rows=${4} />`}</div>`;
  }
  const wlErr = inboxSt.data && inboxSt.data.divisions && inboxSt.data.divisions.worklist && inboxSt.data.divisions.worklist.error;
  const goJudge = (id) => { location.hash = "#/judge?edge=" + encodeURIComponent(id); app.go("judge", id); };
  return html`<div class="detail wide">
    <h2 class="dtitle">Unblock</h2>
    ${wlErr ? html`<div class="banner" role="alert">the worklist could not be computed — ${wlErr}; the figures below may be incomplete</div>` : null}
    <div class="kpis">
      <div class="kpi"><b>${m.blocked}</b><span>blocked</span></div>
      <div class="kpi"><b>${m.rootsTotal}</b><span>roots</span></div>
      <div class="kpi"><b>${m.needAllRoots}</b><span>need several</span></div>
    </div>
    ${m.blocked === 0 ? html`<div class="empty"><b>Nothing is blocked${m.checked == null ? "" : " (" + plural(m.checked, "edge") + " checked)"}.</b></div>` : html`<div>
      <div class="sec">Settle these first</div>
      ${m.ranked.length ? m.ranked.map((r) => html`<${RootRow} key=${r.edge_id} r=${r} go=${goJudge} />`)
        : html`<div class="reason">No single root frees an edge on its own. Every blocked edge needs several roots settled together, below.</div>`}
      ${m.byFile.length ? html`<div class="sec">Settle together</div>${m.byFile.map((g) => html`<div class="fgroup" key=${g.file}>
        <div class="fhead">${plural(g.blockedEdges, "blocked edge")} ${g.blockedEdges === 1 ? "flows" : "flow"} into ${g.files.map((f, i) => html`${i ? (i === g.files.length - 1 ? " and " : ", ") : ""}<b key=${f}>${f}</b>`)}; settle these roots together</div>
        ${g.roots.map((r) => html`<${RootRow} key=${r.edge_id} r=${r} go=${goJudge} />`)}
      </div>`)}` : null}
    </div>`}
  </div>`;
}

/* -- Health --------------------------------------------------------------- */

function ActionCell({ action }) {
  if (!action) return html`<span class="meta">no action mapped</span>`;
  if (action.kind === "command") return html`<${Cmd} text=${action.target} label="copy command" />`;
  if (action.kind === "link") return html`<div class="cmdrow"><span class="meta">see ${action.target}</span><${Copy} text=${action.target} label="copy path" /></div>`;
  return html`<${Cmd} text=${action.target} label="copy path" />`;
}

function HealthRow({ e, tag }) {
  return html`<div class="hrow">
    <span class=${"badge " + tag}>${tag === "fail" ? "FAIL" : "ACCEPTED"}</span>
    <div class="itxt">
      <span class="ttl">${e.label}</span>
      <span class="meta">${dot(e.section, e.detail)}</span>
      <${ActionCell} action=${e.action} />
    </div>
  </div>`;
}

function HealthView({ st, retry }) {
  if (st.status === "idle" || st.status === "loading") return html`<div class="detail wide"><${Skeleton} rows=${3} /></div>`;
  if (st.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="health could not be read —" st=${st} retry=${retry} /></div>`;
  const data = st.data || {};
  if (data.ok === false) {
    return html`<div class="detail wide"><div class="banner" role="alert"><b>doctor snapshot unreadable:</b> ${data.reason || data.error || "no reason given"}.
      Re-run doctor: <${Cmd} text="propagate doctor" label="copy" /></div></div>`;
  }
  const m = healthModel(data);
  return html`<div class="detail wide">
    <h2 class="dtitle">Health</h2>
    <div class=${"hline" + (m.fail === 0 ? " okline" : "")}>${dot(
      m.fail + " fail", m.accepted + " accepted", m.warn + " warn in " + plural(m.warnSections, "section"), "snapshot " + ageLabel(m.ageMs))} ·
      <${Copy} text="propagate doctor" label="re-run doctor" /></div>
    ${m.rows.fail.length + m.rows.accepted.length === 0
      ? html`<div class="empty"><b>0 fail</b> · snapshot ${ageLabel(m.ageMs)}. Nothing failing and nothing accepted.</div>`
      : html`<div>
          ${m.rows.fail.map((e, i) => html`<${HealthRow} key=${"f" + i} e=${e} tag="fail" />`)}
          ${m.rows.accepted.map((e, i) => html`<${HealthRow} key=${"a" + i} e=${e} tag="accepted" />`)}
        </div>`}
    ${m.warnBySection.length ? html`<div class="sec">Warnings, by section</div>${m.warnBySection.map((s) => html`<details key=${s.name} class="wsec">
      <summary>${s.name} <span class="gn">${s.entries.length}</span></summary>
      ${s.entries.map((e, i) => html`<div class="hrow" key=${i}><span class="badge none">WARN</span><div class="itxt"><span class="ttl">${e.label}</span><span class="meta">${e.detail || ""}</span></div></div>`)}
    </details>`)}` : null}
  </div>`;
}

/* -- Activity ------------------------------------------------------------- */

function Velocity({ v }) {
  if (!v || v.status !== "ok") {
    return html`<div class="reason">unknown: ${(v && v.reason) || "the surface sent no velocity"}</div>`;
  }
  const days = v.days || [];
  const peak = days.reduce((n, d) => Math.max(n, d.total || 0), 0);
  if (!v.events) return html`<div class="reason">No verdicts in ${v.windowDays} days (event store read).</div>`;
  const share = ratio(v.noChangeEvents, v.events);
  return html`<div>
    <div class="vel" role="img" aria-label=${v.events + " verdicts in " + v.windowDays + " days"}>
      ${days.map((d) => {
        const h2 = peak > 0 ? 100 * (d.total || 0) / peak : 0;
        return html`<div class=${"vcol" + (d.total ? "" : " vgap")} key=${d.day} title=${d.day + ": " + (d.total ? d.total + " verdicts" : "no verdicts")}>
          <div class="vstack" style=${{ height: h2.toFixed(1) + "%" }}>
            <span class="vseg-changed" style=${{ flexGrow: String(d.changed || 0) }} />
            <span class="vseg-quiet" style=${{ flexGrow: String(d.noChange || 0) }} />
          </div>
        </div>`;
      })}
    </div>
    <div class="vleg"><span class="key key-changed" /> changed something <span class="key key-quiet" /> no change needed</div>
    <div class="caveat">${pct(share)} of ${v.events} verdicts in ${v.windowDays} days recorded that nothing needed doing</div>
  </div>`;
}

function Usage({ u }) {
  if (!u || (u.status !== "ok")) {
    return html`<div class="reason">${u && u.status === "none-recorded" ? "None recorded: " : "unknown: "}${(u && u.reason) || "the surface sent no usage"}</div>`;
  }
  const pts = (u.days || []).map((d) => ({ day: d.day, value: d.count }));
  return html`<div>
    <${Bars} rows=${(u.top || []).map((t) => ({ label: t.command, value: t.count }))} colorOf=${() => "var(--st-accent)"} />
    <${Spark} points=${pts} stroke="var(--st-accent)" label="commands per day" />
    <div class="cov">${dot(plural(u.total, "run") + " in " + u.windowDays + " days", u.failures ? plural(u.failures, "failure") : null, u.refusals ? plural(u.refusals, "refusal") : null, "origin " + u.origin)}</div>
  </div>`;
}

function ActivityView({ st, retry }) {
  if (st.status === "idle" || st.status === "loading") {
    return html`<div class="detail wide"><div class="charts">${[0, 1].map((i) => html`<div class="chart" key=${i}><div class="skel"><i /><i /></div></div>`)}</div></div>`;
  }
  if (st.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="activity could not be read —" st=${st} retry=${retry} /></div>`;
  const s = st.data || {};
  return html`<div class="detail wide">
    <h2 class="dtitle">Activity</h2>
    <div class="charts">
      <${Chart} title="Verdicts per day" coverage="judgements recorded in the event store, per local day"><${Velocity} v=${s.velocity} /><//>
      <${Chart} title="Commands you ran" coverage="interactive runs only, from the runs store"><${Usage} u=${s.usage} /><//>
    </div>
  </div>`;
}

/* -- Explore: registers, reminders, graph --------------------------------- */

function RegisterList({ title, rows }) {
  const shown = (rows || []).slice(0, 50);
  return html`<div class="rgroup">
    <div class="sec">${title} <span class="gn">${(rows || []).length}</span></div>
    ${!(rows || []).length ? html`<div class="reason">None open.</div>` : shown.map((r, i) => html`<div class="sitem" key=${i}>
      <span class=${"badge " + (r.priority ? "open" : "none")}>${r.priority || r.id || "·"}</span>
      <div><div>${r.text}</div><div class="dmeta">${dot(r.short, r.line ? "line " + r.line : null, r.date)}</div></div>
    </div>`)}
    ${(rows || []).length > shown.length ? html`<div class="trunc">showing the first ${shown.length} of ${rows.length}</div>` : null}
  </div>`;
}

function RegistersView({ st, retry }) {
  if (st.status === "idle" || st.status === "loading") return html`<div class="detail wide"><${Skeleton} rows=${4} /></div>`;
  if (st.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="registers could not be read —" st=${st} retry=${retry} /></div>`;
  const r = st.data || {};
  if (r.error) return html`<div class="detail wide"><div class="banner" role="alert">registers could not be computed — ${r.error}</div></div>`;
  return html`<div class="detail wide">
    <h2 class="dtitle">Registers</h2>
    <div class="dmeta">Read-only. Opening or closing an item stays on the command line until the register write flow has its own design pass.</div>
    <${RegisterList} title="Issues" rows=${r.issues} />
    <${RegisterList} title="Todos" rows=${r.todos} />
    <${RegisterList} title="Handovers" rows=${r.handovers} />
  </div>`;
}

/**
 * T4. The refusals the Reminders bridge produces, which until now existed and
 * appeared nowhere.
 *
 * The six refusals are not six peers. They fall into three groups by what the
 * reader can DO, and a flat list makes you read all of them to find the two you
 * can act on. `held-untagged` and `held-unknown-tag` come from the ROUTING layer
 * and sit in CONFIGURATION because they are fixable the same way the other two
 * are: add a tag, or add the tag to the table.
 */
const CONFLICT_GROUPS = [
  { key: "config", label: "CONFIGURATION", hint: "you can fix these",
    of: ["held-no-register", "held-ambiguous-register", "held-untagged", "held-unknown-tag"] },
  { key: "content", label: "CONTENT", hint: "the tool refused to touch a file",
    of: ["held-unrecognized-shape", "held-would-change-classification", "held-illegal-boundary"] },
  { key: "quiet", label: "NOT A FAILURE", hint: "the duplicate guard working", of: ["already-inserted"] },
];

/** Which group a disposition belongs to, or null when it is not a conflict. */
function conflictGroup(disposition) {
  const g = CONFLICT_GROUPS.find((x) => x.of.indexOf(disposition) >= 0);
  return g ? g.key : null;
}

/**
 * Split rows into the three groups, keeping the ones that are NOT conflicts
 * separately. A reminder that routed and inserted cleanly is not a conflict and
 * does not belong in this panel -- but its count is what makes the empty state a
 * result rather than an absence.
 */
function groupConflicts(rows) {
  const out = { config: [], content: [], quiet: [], routed: 0 };
  for (const r of rows || []) {
    const g = conflictGroup(r && r.disposition);
    if (g) out[g].push(r); else out.routed += 1;
  }
  return out;
}

/**
 * Empty is the state you see most, and "No conflicts found." is the default an
 * engineer reaches for. It is indistinguishable from a panel that failed to load.
 * So empty REPORTS THE POPULATION it examined. No counts means it did not run.
 */
function conflictsEmptyLine(data) {
  const total = (data && data.summary && data.summary.total) || 0;
  if (!total) return "no reminders were read — nothing to route, and nothing held";
  return "all " + total + " reminder(s) routed. Nothing held.";
}

function RemindersView({ st, retry }) {
  if (st.status === "idle" || st.status === "loading") return html`<div class="detail wide"><div class="reason">reading the reminders list…</div></div>`;
  if (st.status === "error") return html`<div class="detail wide"><h2 class="dtitle">Reminders</h2><${ErrorBanner} what="the reminders list could not be read —" st=${st} retry=${retry} />
    <div class="reason">This is not "nothing held". Nothing was examined, so nothing can be reported.</div></div>`;
  const data = st.data || {};

  // "could not look" is not "nothing to show". F1 draws this line in the read
  // path and it would be lost here if a failed read rendered as an empty list.
  // The reason is `reason` from the bridge and `error` from the server's own
  // catch; reading only the first printed "undefined" for the second (#70.5).
  if (data.ok === false) {
    const why = data.reason || data.error || "no reason was given";
    return html`<div class="detail wide">
      <h2 class="dtitle">Reminders</h2>
      <div class="banner" role="alert">could not read the reminders list — ${why}</div>
      ${data.reasonDetail ? html`<div class="dmeta">${data.reasonDetail}</div>` : null}
      <div class="reason">This is not "nothing held". Nothing was examined, so nothing can be reported.</div>
    </div>`;
  }

  const g = groupConflicts(data.rows);
  const held = g.config.length + g.content.length + g.quiet.length;
  return html`<div class="detail wide">
    <h2 class="dtitle">Reminders</h2>
    <div class="dmeta">${dot(data.list, held + " held of " + ((data.summary && data.summary.total) || 0) + " read", "dry run, nothing written")}</div>
    ${!held ? html`<div class="sec">${conflictsEmptyLine(data)}</div>` : CONFLICT_GROUPS.map((grp) => {
      const rows = g[grp.key];
      if (!rows.length) return null;
      return html`<div key=${grp.key}>
        <div class="sec">${grp.label} — ${grp.hint} · ${rows.length}</div>
        <div class="streamlist">
          ${rows.map((r) => html`
            <div class=${"sitem" + (grp.key === "quiet" ? " quiet" : "")} key=${r.reminderId}>
              <span class=${"badge " + r.disposition}>${r.disposition.replace("held-", "")}</span>
              <div>
                <div>${(r.prId ? r.prId + " · " : "") + (r.project || r.tag || "untagged")}</div>
                ${r.reason ? html`<div class="dmeta">${r.reason}</div>` : null}
              </div>
            </div>`)}
        </div>
      </div>`;
    })}
  </div>`;
}

/**
 * The graph, fetched here rather than framed by URL. An iframe cannot report a
 * 500: the error page loads as a document and the pane looks "loaded". Fetching
 * first gives the failure a sentence and a retry, then srcdoc hands the page over.
 */
function GraphView() {
  const [st, setSt] = useState({ status: "loading" });
  const seq = useRef(0);
  const run = useCallback(async () => {
    const n = ++seq.current;
    setSt({ status: "loading" });
    const r = await apiText("/graph");
    if (n !== seq.current || r.kind === "aborted") return;
    setSt(r.ok ? { status: "ok", page: r.data } : { status: "error", kind: r.kind, error: r.error });
  }, []);
  useEffect(() => { run(); }, [run]);
  if (st.status === "loading") return html`<div class="detail wide"><div class="reason" aria-busy="true">rendering the graph — this runs <b>graph --html</b>, a few seconds…</div></div>`;
  if (st.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="the graph could not be rendered —" st=${st} retry=${run} /></div>`;
  return html`<div class="detail wide"><iframe class="frame" srcdoc=${st.page} title="dependency graph" /></div>`;
}

/* -- the app -------------------------------------------------------------- */

function readHash() {
  // `#/unblock?edge=<id>`: the query rides in the hash because the server never
  // sees a fragment. Unknown hashes land on /judge, never a blank page.
  const raw = (location.hash || "#/judge").slice(1).replace(/^[/]+/, "");
  const q = raw.indexOf("?");
  const name = q >= 0 ? raw.slice(0, q) : raw;
  const m = q >= 0 ? /(?:^|&)edge=([^&]*)/.exec(raw.slice(q + 1)) : null;
  return { view: HASH_TO_VIEW[name] || "judge", edge: m ? decodeURIComponent(m[1]) : null };
}

function App() {
  const [route, setRoute] = useState(readHash());
  const view = route.view;
  const [inboxSt, retryInbox] = useResource("/api/inbox", true);
  const firstLanded = inboxSt.status === "ok" || inboxSt.status === "error";
  const [surfaceSt, retrySurface] = useResource("/api/surface", firstLanded);
  const [healthSt, retryHealth] = useResource("/api/health", view === "health");
  const [regSt, retryReg] = useResource("/api/registers", view === "registers");
  const [remSt, retryRem] = useResource("/api/conflicts", view === "reminders");
  const [buildNote, setBuildNote] = useState(null);
  const [judged, setJudged] = useState(0);
  const [msg, setMsgState] = useState(null);
  const [announce, setAnnounce] = useState("");
  const [pending, setPending] = useState(null);
  const [sending, setSending] = useState(() => new Set());
  const [bumped, setBumped] = useState(null);
  const [, bump] = useState(0);
  const flushRef = useRef(null);
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const say = useCallback((m) => { setMsgState(m); setAnnounce(m ? m.text : ""); }, []);

  // Reason text lives in a Map keyed by EDGE ID (#70.1). It used to be one shared
  // string, so a reason typed for one edge was submitted for whichever edge was
  // selected when the key was pressed. A Map entry is only ever read by the edge
  // it was typed for; `set` re-renders because the textarea is controlled.
  const reasonsRef = useRef(null);
  if (!reasonsRef.current) {
    const m = new Map();
    const set = m.set.bind(m);
    m.set = (k, v) => { set(k, v); bump((n) => n + 1); return m; };
    reasonsRef.current = m;
  }
  const reasons = reasonsRef.current;
  const [bulkText, setBulkText] = useState("");
  const bulkReason = { text: bulkText, set: setBulkText };

  // ---- evidence cache: edge_id -> {status, data|error} ----
  const ev = useRef(new Map());
  const evInflight = useRef(new Map());
  const [evTick, setEvTick] = useState(0);
  const loadEvidence = useCallback((id, signal) => {
    if (ev.current.has(id)) return Promise.resolve(ev.current.get(id));
    if (evInflight.current.has(id)) return evInflight.current.get(id);
    const p = api("/api/evidence", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ kind: "edge", edge_id: id }), signal: signal })
      .then((r) => {
        evInflight.current.delete(id);
        if (r.kind === "aborted") return null;
        const entry = r.ok ? { status: "ok", data: r.data } : { status: "error", kind: r.kind, error: r.error };
        ev.current.set(id, entry);
        setEvTick((n) => n + 1);
        return entry;
      });
    evInflight.current.set(id, p);
    return p;
  }, []);

  // ---- the seen-set (D12) ----
  const [seen, setSeen] = useState({ status: "idle", set: new Set(), error: null });
  const inJudge = view === "judge";
  useEffect(() => {
    if (!inJudge || !firstLanded || seen.status !== "idle") return;
    setSeen((s) => Object.assign({}, s, { status: "loading" }));
    api("/api/seen-edges").then((r) => {
      if (!r.ok) { setSeen({ status: "error", set: new Set(), error: r.error }); return; }
      const d = r.data || {};
      setSeen({ status: d.status === "ok" ? "ok" : d.status || "error", set: new Set(d.triples || []), error: d.error || null });
    });
  }, [inJudge, firstLanded]);
  const rendered = useRef(null);
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const markSeen = useCallback(async (keys) => {
    const fresh = (keys || []).filter((k) => !seenRef.current.set.has(k));
    if (!fresh.length) return;
    for (let i = 0; i < fresh.length; i += SEEN_POST_MAX) {
      const slice = fresh.slice(i, i + SEEN_POST_MAX);
      const r = await api("/api/seen-edges", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ triples: slice }), keepalive: true });
      if (!r.ok) { say({ ok: false, text: "could not record what you have seen — " + r.error }); return; }
    }
    setSeen((s) => ({ status: "ok", set: new Set([...s.set, ...fresh]), error: null }));
  }, [say]);

  // ---- the stale-server check (F5), after first paint ----
  useEffect(() => {
    if (!firstLanded || !BUILD) return;
    api("/api/version").then((r) => {
      // Anything but a clear answer is "cannot tell", which is not "stale".
      if (r.ok && r.data && typeof r.data.build === "string" && r.data.build !== BUILD) {
        setBuildNote("server older than page — restart propagate ui (page " + BUILD + ", server " + r.data.build + ")");
      }
    });
  }, [firstLanded]);

  // ---- counts that changed pulse once ----
  const n = counts(inboxSt.data);
  const lastCounts = useRef({});
  useEffect(() => {
    const before = lastCounts.current;
    const changed = Object.keys(n).find((k) => before[k] != null && before[k] !== n[k]);
    if (changed) { setBumped(changed); setTimeout(() => setBumped(null), 400); }
    lastCounts.current = n;
  }, [n.judge, n.unblock]);

  // ---- the write path: hold five seconds, then POST ----
  const heldIds = useMemo(() => {
    const s = new Set(sending);
    if (pending) for (const e of pending.entries) s.add(e.edge_id);
    return s;
  }, [pending, sending]);

  const flush = useCallback(async (p) => {
    if (!p) return;
    clearTimeout(p.timer);
    if (flushRef.current === p) flushRef.current = null;
    setPending((cur) => (cur === p ? null : cur));
    const ids = p.entries.map((e) => e.edge_id);
    setSending((s) => new Set([...s, ...ids]));
    // keepalive: the page may be unloading (F8), and a fetch that outlives its
    // document is the only way a held write still lands.
    const r = await api("/api/dispose", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(disposeBody(p)), keepalive: true });
    setSending((s) => { const x = new Set(s); for (const i of ids) x.delete(i); return x; });
    const done = (written) => {
      for (const i of written) { ev.current.delete(i); reasons.delete(i); }
      bump((k) => k + 1);
    };
    const results = r.data && Array.isArray(r.data.results) ? r.data.results : null;
    if (r.ok && r.data && r.data.ok && !results) {
      done(ids);
      setJudged((k) => k + 1);
      say({ ok: true, text: "recorded — event " + r.data.event_id });
      if (p.onResult) p.onResult([]);
      retryInbox();
    } else if (results) {
      const failed = results.filter((x) => !x.ok);
      const written = results.filter((x) => x.ok).map((x) => x.edge_id);
      done(written);
      setJudged((k) => k + written.length);
      if (p.kind === "bulk" && !failed.length) setBulkText("");
      if (p.onResult) p.onResult(results);
      say(failed.length
        ? { ok: false, text: written.length + " written · " + failed.length + " refused — " + failed.map((x) => x.edge_id + ": " + x.error).join("; ") }
        : { ok: true, text: "recorded — " + plural(written.length, "event") });
      retryInbox();
    } else {
      // Not written. The row comes back (it is no longer held) and its reason is
      // still in the Map, so the person re-presses a key instead of retyping.
      say({ ok: false, text: r.kind === "token" ? TOKEN_EXPIRED
        : r.kind === "network" ? r.error + " — the verdict was NOT recorded"
        : (r.error || (r.data && r.data.error) || "the verdict was refused for a reason the server did not give") });
    }
  }, [retryInbox, say]);

  const hold = useCallback((p, extra) => {
    if (flushRef.current) flush(flushRef.current);   // at most one outstanding
    const held = Object.assign({}, p, extra || {}, { id: String(Date.now()) + p.entries[0].edge_id });
    held.timer = setTimeout(() => flush(held), UNDO_MS);
    flushRef.current = held;
    setPending(held);
    say({ ok: true, text: held.disposition + " held for " + (UNDO_MS / 1000) + " seconds — press u to undo" });
  }, [flush, say]);

  const undo = useCallback(() => {
    const p = flushRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    flushRef.current = null;
    setPending(null);
    say({ ok: true, text: "undone — nothing was written" });
  }, [say]);

  // Leaving with a write pending must not lose it. A lost write and a silent
  // write are both worse than an early one.
  useEffect(() => {
    const go = () => { if (flushRef.current) flush(flushRef.current); if (rendered.current) markSeen(rendered.current.current); };
    addEventListener("beforeunload", go);
    return () => removeEventListener("beforeunload", go);
  }, [flush, markSeen]);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
      if (e.key === "u") { e.preventDefault(); undo(); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [undo]);

  const go = useCallback((v, edge) => { setRoute({ view: v, edge: edge || null }); if (!edge) location.hash = "#/" + v; }, []);

  // Refresh re-fetches what the CURRENT view reads, and the badges with it, so a
  // number in the rail cannot disagree with the list beside it (#70.7).
  const refresh = () => {
    retryInbox(); retrySurface();
    if (view === "health") retryHealth();
    if (view === "registers") retryReg();
    if (view === "reminders") retryRem();
  };

  const model = useMemo(() => judgeModel(inboxSt.data, heldIds), [inboxSt.data, heldIds]);
  const app = { inboxSt, retryInbox, model, seen, ev, loadEvidence, evTick, reasons, bulkReason, hold, pending, undo, say, msg, reduced, markSeen, rendered, go };

  const surfaceHealth = surfaceSt.status === "ok" && surfaceSt.data && surfaceSt.data.health && surfaceSt.data.health.ok
    ? surfaceSt.data.health.sections.reduce((a, s) => a + (s.fail || 0), 0) : null;
  const badge = (k) => (k === "judge" ? n.judge : k === "unblock" ? n.unblock : k === "health" ? surfaceHealth : null);

  let body;
  if (view === "judge") body = html`<${JudgeView} app=${app} route=${route} />`;
  else if (view === "unblock") body = html`<${UnblockView} app=${app} />`;
  else if (view === "health") body = html`<${HealthView} st=${healthSt} retry=${retryHealth} />`;
  else if (view === "activity") body = html`<${ActivityView} st=${surfaceSt} retry=${retrySurface} />`;
  else if (view === "registers") body = html`<${RegistersView} st=${regSt} retry=${retryReg} />`;
  else if (view === "reminders") body = html`<${RemindersView} st=${remSt} retry=${retryRem} />`;
  else body = html`<${GraphView} />`;

  const inbox = inboxSt.data;
  return html`
    <header>
      <h1>propagate</h1>
      <div class="sum">${inbox && inbox.declared != null
        ? html`<b>${inbox.declared}</b> declared · <b>${inbox.expanded}</b> expanded`
        : (inboxSt.status === "error" ? "queue unavailable" : "loading…")}</div>
      <div class="session">${judged ? html`<b>${judged}</b> judged this session` : ""}</div>
      <button class="ghost" onClick=${refresh} title="re-read this view and the counts">refresh</button>
    </header>
    <div class="sr" role="status" aria-live="polite">${announce}</div>
    ${buildNote ? html`<div class="banner" role="alert">${buildNote}</div>` : null}

    <div class="shell">
      <nav class="rail" aria-label="views">
        ${DIVISIONS.map((x, i) => html`
          ${i === FIRST_EXPLORE ? html`<hr /><div class="lbl">explore</div>` : null}
          <button key=${x.key} class=${"div" + (view === x.key ? " on" : "") + (x.act ? " act" : "")}
                  aria-current=${view === x.key ? "page" : null} onClick=${() => go(x.key)}>
            ${x.label}
            <span class=${"n" + (bumped === x.key ? " bump" : "")}>${badge(x.key) == null ? "" : badge(x.key)}</span>
          </button>`)}
      </nav>
      ${body}
    </div>`;
}

/* A headless test can reach the pure helpers. There is no browser and no
 * bundler in this repo's suite, so without this the shaping logic -- grouping,
 * the gap-breaking path builder, the rail counts -- has no check at all. */
if (typeof globalThis !== "undefined") {
  globalThis.__ui = { counts, linePath, KEYS, keyFor, DIVISIONS, UNDO_MS, readHash, disposeBody, judgeModel, groupRows, workspaceOf,
    intersectAllowed, pruneTicked, unblockModel, healthModel, parkedAllowed, baselineCommand, gitDiffCommand, shellQuote, pct, ratio, dot, ageLabel,
    conflictGroup, groupConflicts, conflictsEmptyLine, CONFLICT_GROUPS, TOKEN_EXPIRED, HASH_TO_VIEW, FIRST_EXPLORE, request };
}

if (typeof document !== "undefined" && document.getElementById("app")) {
  render(html`<${App} />`, document.getElementById("app"));
}
