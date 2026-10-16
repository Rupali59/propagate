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
// "overview" joined at the FRONT on 2026-10-16: the dashboard is what an empty hash opens.
// An unknown hash still lands on Judge, because Judge is where the work is.
const DIVISIONS = [
  { key: "overview", label: "OVERVIEW" },
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
  overview: "overview", judge: "judge", unblock: "unblock", health: "health", activity: "activity",
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

/* -- plain-language copy and the tooltip formatter (plain-user pass 2026-10-16) -- */

/**
 * What each verdict MEANS, in one line, shown under its button.
 *
 * WHY. The buttons were named for the ledger (`propagated`, `wontfix`, `baselined`) and a
 * person reading them cold had to know the vocabulary to know what they were committing.
 * The sentences are the owner's approved copy (2026-10-16, neutral voice) and are copied
 * word for word: "reason needed" is the one fact a verdict carries that its name hides.
 * A disposition with no entry here renders with no line rather than an invented one.
 */
const VERDICT_MEANING = {
  "propagated": "Downstream updated to match",
  "no-change-needed": "Checked: the downstream is still right",
  "source-corrected": "Source was wrong and is now fixed",
  "both-reconciled": "Both changed and now agree",
  "decoupled": "Not related: remove the link",
  "deferred": "Later: park it with a reason",
  "wontfix": "Accepted: it stays different (reason needed)",
  "baselined": "First check: accept today as the start (reason needed)",
};

/**
 * The server stamps `crosses the line` on an edge between the hub and a workspace
 * (inbox.mjs boundaryOf, shared with the widget). "The line" means nothing to a reader who
 * has not read that function, so the page says what it is; the payload is not changed.
 */
const boundaryLabel = (b) => (b === "crosses the line" ? "crosses workspaces" : b);

/** "Tue 13 Oct" from "2026-10-13"; the raw text when it is not a date, never "NaN". */
function dayLabel(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ""));
  if (!m) return day ? String(day) : "unknown day";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(t.getTime())) return String(day);
  return names[t.getUTCDay()] + " " + (+m[3]) + " " + months[+m[2] - 1];
}

/** "13 Oct": the short form an axis can afford. */
function dayShort(day) {
  const l = dayLabel(day);
  const parts = l.split(" ");
  return parts.length === 3 ? parts[1] + " " + parts[2] : l;
}

/**
 * Which columns of a day axis carry a label. Every column of a 30-day chart cannot: 30
 * labels would overlap into one smear. The first and last always do (they bound the window),
 * the middle ones every `step`, and one that would crowd the last is dropped.
 */
function axisTicks(n, maxLabels) {
  if (!(n > 0)) return [];
  const cap = maxLabels || 6;
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / cap);
  const out = [];
  for (let i = 0; i < n - 1; i += step) if (n - 1 - i >= step * 0.6 || i === 0) out.push(i);
  out.push(n - 1);
  return out;
}

/**
 * One piece of inline markdown at a time, as DATA. Register lines carry `**bold**` and
 * `code` spans straight from the markdown source, and the page printed the asterisks. This
 * returns segments the view renders as elements, so no string is ever injected as HTML:
 * a stray `<img onerror=...>` in a register line arrives as text, because it is one.
 * Any marker left unpaired is stripped rather than shown.
 */
function inlineMd(text) {
  const src = String(text == null ? "" : text);
  const out = [];
  const re = /\*\*([^*]+?)\*\*|`([^`]+?)`/g;
  let last = 0;
  let m;
  const plainOf = (t) => t.replace(/\*\*/g, "").replace(/`/g, "");
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ k: "text", s: plainOf(src.slice(last, m.index)) });
    out.push(m[1] !== undefined ? { k: "bold", s: m[1] } : { k: "code", s: m[2] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ k: "text", s: plainOf(src.slice(last)) });
  return out.filter((x) => x.s !== "");
}

/** The badge text for a register priority: P0/P1/P2, or the item id, or a dash. 0 is a priority. */
const priorityLabel = (r) => (typeof r.priority === "number" && isFinite(r.priority) ? "P" + r.priority
  : r.priority ? String(r.priority) : (r.id || "–"));

/**
 * The Reminders bridge reports a hung AppleScript call as `osascript timed out after
 * 3000ms...`. That is the tool talking about itself; what the reader can DO is allow access
 * and try again. Returns the plain sentence for a timeout and null for anything else, so a
 * different failure keeps the server's own words.
 */
function remindersTimeoutText(why) {
  const s = String(why || "");
  if (!/timed out/i.test(s)) return null;
  const m = /after (\d+)\s*ms/i.exec(s);
  const secs = m ? Math.round(+m[1] / 1000) : null;
  return "Reminders did not answer" + (secs ? " in " + secs + "s" : "") + ". Open Reminders once and allow access, then Retry.";
}

/**
 * Tooltip content, ONE pure formatter for every chart shape and row on this page; the web
 * counterpart of the widget's tipLines (widget/propagate-queue.jsx). Returns
 * {title, lines} or null.
 *
 * TWO RULES, both from the owner's standard for the widget. (1) Every figure comes from a
 * value the page already holds: a tooltip that computed a new fact would be a second
 * source of truth beside the chart it sits on. (2) Never a native `title=` attribute: it
 * is unstyled, unthemed, has a delay nobody controls and does not show on touch.
 *
 * Zero and empty are answered in words ("no verdicts recorded"), never "0 verdicts" or NaN.
 */
function tipText(kind, v) {
  if (!v) return null;
  const num = (x) => (typeof x === "number" && isFinite(x) ? x : 0);
  const share = (n, d) => { const r = ratio(n, d); return r === null ? null : pct(r); };
  if (kind === "verdicts") {
    if (!(num(v.total) > 0)) return { title: dayLabel(v.day), lines: ["no verdicts recorded", "click to open Judge"] };
    return { title: dayLabel(v.day), lines: [plural(num(v.total), "verdict"),
      num(v.changed) + " changed something · " + num(v.noChange) + " no change needed", "click to open Judge"] };
  }
  if (kind === "runs") {
    return { title: dayLabel(v.day), lines: [num(v.count) > 0 ? plural(num(v.count), "command") + " run" : "no commands run"] };
  }
  if (kind === "command") {
    const p = share(v.count, v.total);
    return { title: v.command || "command", lines: [plural(num(v.count), "run"), p ? p + " of " + num(v.total) + " interactive runs" : null,
      "click to copy: propagate " + v.command].filter(Boolean) };
  }
  if (kind === "bucket") {
    const p = share(v.value, v.total);
    return { title: v.label, lines: [plural(num(v.value), "edge"), p ? p + " of " + num(v.total) + " never verified" : null].filter(Boolean) };
  }
  if (kind === "root") {
    if (v.unknown) return { title: v.edge_id, lines: ["not in the queue any more"] };
    return { title: v.source + " → " + v.downstream, lines: ["frees " + num(v.freesNow) + " now",
      v.upstreamOf != null ? "upstream of " + num(v.upstreamOf) : null,
      v.inQueue ? "click to judge this root" : "never verified: copy the command to baseline it"].filter(Boolean) };
  }
  if (kind === "edge") {
    return { title: v.sourceShort + " → " + v.downstreamShort,
      lines: [dot(v.state, boundaryLabel(v.boundary)), v.parked ? "parked" : (v.judgedCount ? "judged " + plural(v.judgedCount, "time") : "never judged"), "click to open the evidence"].filter(Boolean) };
  }
  if (kind === "health") {
    return { title: v.label, lines: [v.section, v.tag === "fail" ? "failing check" : "accepted, not fixed",
      v.action ? "next step: " + v.action.target : "no action mapped"].filter(Boolean) };
  }
  if (kind === "register") {
    return { title: v.id || v.short || "item", lines: [dot(v.priority != null ? "priority " + priorityLabel(v) : "no priority", v.short, v.line ? "line " + v.line : null, v.date)] };
  }
  if (kind === "qbar") {
    const p = share(v.n, v.wsTotal);
    return { title: (v.ws || "workspace") + " · " + (STATE_WORDS[v.state] || v.state || "state unknown"), lines: [plural(num(v.n), "edge"),
      p ? p + " of the " + num(v.wsTotal) + " in " + v.ws : null, "click to judge these"].filter(Boolean) };
  }
  if (kind === "wbar") {
    return { title: ageWords(v.bucket) + " · " + (STATE_WORDS[v.state] || v.state || "state unknown"), lines: [plural(num(v.n), "edge"), "click to open this age band in Judge"] };
  }
  if (kind === "vbar") {
    return { title: dayLabel(v.day) + " · " + (v.kind || "verdicts"),
      lines: [num(v.n) > 0 ? plural(num(v.n), "verdict") : "none recorded", num(v.total) > 0 ? "of " + plural(num(v.total), "verdict") + " that day" : null, "click to open Activity"].filter(Boolean) };
  }
  if (kind === "source") {
    return { title: baseName(v.short) || "source", lines: [plural(num(v.edges), "edge") + (num(v.blocked) > 0 ? ", " + num(v.blocked) + " blocked" : ""),
      STATE_ORDER.filter((s) => v.states && v.states[s]).map((s) => v.states[s] + " " + STATE_WORDS[s]).join(" · ") || null,
      v.oldest >= 0 ? "oldest waited " + v.oldest + " d" : "never judged", "click to judge only this source"].filter(Boolean) };
  }
  if (kind === "note") return { title: v.title, lines: [v.text] };
  return null;
}

/**
 * Where the tooltip box goes. Below and right of the pointer, flipped to the other side
 * when it would leave the viewport, clamped so it never starts off-screen. Pure so the
 * flip is testable without a browser; sizes are the CSS max-width and a generous height.
 */
const TIP_W = 264;
const TIP_H = 112;
const TIP_GAP = 14;
function tipPlace(x, y, vw, vh) {
  const px = typeof x === "number" && isFinite(x) ? x : 0;
  const py = typeof y === "number" && isFinite(y) ? y : 0;
  const W = typeof vw === "number" && vw > 0 ? vw : 1200;
  const H = typeof vh === "number" && vh > 0 ? vh : 800;
  let left = px + TIP_GAP;
  let top = py + TIP_GAP;
  if (left + TIP_W > W - 8) left = Math.max(8, px - TIP_GAP - TIP_W);
  if (top + TIP_H > H - 8) top = Math.max(8, py - TIP_GAP - TIP_H);
  return { left: left, top: top };
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

/* -- Overview and the Judge filters: pure, reachable from the headless tests ---- */

// The waiting-time buckets. The KEY is what rides in the hash (url-safe: "<" and the en dash
// are not), the LABEL is what a person reads. Order is the order the histogram draws.
const AGE_BUCKETS = [
  { key: "lt1d", label: "< 1 day" },
  { key: "1to7d", label: "1–7 days" },
  { key: "1to4w", label: "1–4 weeks" },
  { key: "gt4w", label: "> 4 weeks" },
  { key: "never", label: "never judged" },
];
const AGE_KEYS = AGE_BUCKETS.map((b) => b.key);
// The histogram's axis labels, shortened: five full labels do not fit under a card this wide
// ("> 4 weeks" and "never judged" printed on top of each other in the first render, 2026-10-16).
// Everywhere a person reads a sentence (tooltip, filter control) the full label is used.
const AGE_TICK = { lt1d: "< 1 day", "1to7d": "1–7 days", "1to4w": "1–4 wks", gt4w: "> 4 wks", never: "never" };
const ageWords = (key) => { const b = AGE_BUCKETS.find((x) => x.key === key); return b ? b.label : String(key); };

/** The four states the queue can hold, in the order every chart stacks them. */
const STATE_ORDER = ["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"];
const STATE_WORDS = { DRIFTED: "drifted", REVERSED: "reversed", DIVERGED: "both sides moved", UNMATCHED: "unmatched" };
const baseName = (p) => String(p || "").split("/").pop() || String(p || "");

/**
 * Whole days since an edge was last judged, or null when it never was. A parked row has no
 * `last` but carries `ageDays` (since it was parked); that is the only age it has, and it is
 * used rather than calling a parked edge "never judged" when the payload says otherwise.
 */
function ageDaysOf(item, now) {
  const ts = item && item.last && item.last.ts ? Date.parse(item.last.ts) : NaN;
  if (isFinite(ts)) return Math.max(0, Math.floor((now - ts) / 864e5));
  if (item && typeof item.ageDays === "number" && isFinite(item.ageDays)) return item.ageDays;
  return null;
}

/** Which bucket an age falls in. null is its own bucket, never folded into "< 1 day". */
function ageKey(days) {
  if (typeof days !== "number" || !isFinite(days)) return "never";
  return days < 1 ? "lt1d" : days < 7 ? "1to7d" : days < 28 ? "1to4w" : "gt4w";
}

/**
 * The Judge filters from the Overview (ws=, age=, source=), combinable with state= and chip=.
 * `ws` is the label the chart printed (boundaryLabel), `age` a bucket key, `source` the EXACT
 * source path: a basename would merge two files of the same name in different repos, and the
 * count on the Overview row would then disagree with the list it opens.
 */
function judgeFilterRows(rows, f, now) {
  const ws = f && f.ws, age = f && f.age, source = f && f.source;
  if (!ws && !age && !source) return rows;
  return (rows || []).filter((r) => (!ws || boundaryLabel(r.boundary) === ws)
    && (!age || ageKey(ageDaysOf(r, now)) === age)
    && (!source || r.source === source));
}

/** The local calendar day of a timestamp, "YYYY-MM-DD" -- the unit velocity.days is cut in. */
function localDay(now) {
  const d = new Date(now);
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/**
 * Everything the Overview draws, from the inbox payload alone. `rows` is ready PLUS blocked:
 * the dashboard answers "what is in the queue", and a blocked edge is in it. (Judge lists only
 * the ready, non-diverged ones, so a bar that includes blocked edges can open a shorter list --
 * the subtitles say "in the queue" rather than "to judge" for that reason.)
 *
 * A division that failed arrives with `ready: null` and an `error`; that comes back as
 * `{ error }`, never as an empty model that would read as "nothing waiting".
 */
function overviewModel(inbox, now) {
  const d = inbox && inbox.divisions;
  if (!d || !d.worklist) return null;
  const w = d.worklist;
  if (w.error || !Array.isArray(w.ready)) return { error: w.error || "the worklist could not be computed" };
  const rows = w.ready.concat(w.blocked || []).map((i) => {
    const age = ageDaysOf(i, now);
    return { edge_id: i.edge_id, ws: boundaryLabel(i.boundary) || "other", state: i.state, blocked: !!i.blocked, age: age,
      bucket: ageKey(age), source: i.source, sourceShort: i.sourceShort || i.source };
  });
  const byFile = new Map();
  for (const r of rows) {
    if (!byFile.has(r.source)) byFile.set(r.source, { source: r.source, short: r.sourceShort, ws: r.ws, edges: 0, states: {}, oldest: -1, blocked: 0 });
    const g = byFile.get(r.source);
    g.edges += 1;
    g.states[r.state] = (g.states[r.state] || 0) + 1;
    if (r.age != null && r.age > g.oldest) g.oldest = r.age;
    if (r.blocked) g.blocked += 1;
  }
  // The top ten are chosen by edge count, THEN the table may be re-sorted: sorting by "oldest"
  // reorders those ten, it does not swap in a different ten.
  const sources = sortSources([...byFile.values()], "edges", "desc");
  const ages = rows.map((r) => r.age).filter((a) => a != null);
  const wl = inbox.worklist || null;
  return {
    error: null, rows: rows, sources: sources, top: sources.slice(0, 10), nSources: sources.length, edges: rows.length,
    toJudge: wl && typeof wl.toJudge === "number" ? wl.toJudge : null,
    blocked: inbox.leverage && typeof inbox.leverage.blocked === "number" ? inbox.leverage.blocked : null,
    oldest: ages.length ? Math.max.apply(null, ages) : null,
  };
}

/** Table order. Ties fall to the source path so a re-sort never shuffles equals between renders. */
const SORT_DEFAULT_DIR = { source: "asc", ws: "asc", edges: "desc", blocked: "desc", oldest: "desc" };
function sortSources(list, key, dir) {
  const sign = dir === "asc" ? 1 : -1;
  const val = (g) => (key === "source" ? baseName(g.short).toLowerCase() : key === "ws" ? String(g.ws).toLowerCase() : g[key]);
  return list.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === "string" ? x.localeCompare(y) : (x - y);
    return c !== 0 ? sign * c : (a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
  });
}

/**
 * Where a KPI card goes. "Oldest wait" opens the age band the oldest edge is IN, which is
 * "> 4 weeks" whenever the card is flagged and never an empty list when it is not.
 */
function routeForKpi(key, model) {
  if (key === "judge") return "judge";
  if (key === "blocked") return "unblock";
  if (key === "oldest") return model && model.oldest != null ? "judge?age=" + ageKey(model.oldest) : "judge";
  if (key === "today") return "activity";
  if (key === "health") return "health";
  return null;
}

/**
 * Where a click on a chart shape goes -- the one place a datum becomes a destination, so it is
 * testable without a chart. A DIVERGED bar opens the Both-sides-moved chip (state= only filters
 * To judge, where a diverged edge is never listed). Null for a datum it cannot route.
 */
function routeForBar(chart, d) {
  if (!d) return null;
  const enc = encodeURIComponent;
  if (chart === "queue") {
    if (!d.ws) return null;
    const q = "judge?ws=" + enc(d.ws);
    if (d.state === "DIVERGED") return q + "&chip=both";
    return JUDGE_STATES.indexOf(d.state) >= 0 ? q + "&state=" + enc(d.state) : q;
  }
  if (chart === "wait") return AGE_KEYS.indexOf(d.bucket) >= 0 ? "judge?age=" + enc(d.bucket) : null;
  if (chart === "verdicts") return "activity";
  return null;
}

/** The datum behind every stacked bar, aggregated HERE so a click maps by key and not by DOM order. */
function queueBars(rows) {
  const n = new Map(), tot = new Map();
  for (const r of rows || []) {
    const k = r.ws + "|" + r.state;
    n.set(k, (n.get(k) || 0) + 1);
    tot.set(r.ws, (tot.get(r.ws) || 0) + 1);
  }
  const order = [...tot.keys()].sort((a, b) => tot.get(b) - tot.get(a) || (a < b ? -1 : 1));
  const bars = [];
  for (const ws of order) for (const state of STATE_ORDER) {
    const c = n.get(ws + "|" + state);
    if (c) bars.push({ key: "q:" + ws + "|" + state, ws: ws, state: state, n: c, wsTotal: tot.get(ws) });
  }
  return { bars: bars, order: order };
}
function waitBars(rows) {
  const n = new Map();
  for (const r of rows || []) n.set(r.bucket + "|" + r.state, (n.get(r.bucket + "|" + r.state) || 0) + 1);
  const bars = [];
  for (const b of AGE_BUCKETS) for (const state of STATE_ORDER) {
    const c = n.get(b.key + "|" + state);
    if (c) bars.push({ key: "w:" + b.key + "|" + state, bucket: b.key, label: AGE_TICK[b.key], state: state, n: c });
  }
  return bars;
}
const VERDICT_KINDS = ["changed something", "no change needed"];
function verdictBars(velocity) {
  const bars = [];
  for (const d of (velocity && velocity.status === "ok" && velocity.days) || []) {
    bars.push({ key: "v:" + d.day + "|0", day: d.day, kind: VERDICT_KINDS[0], n: d.changed || 0, total: d.total || 0 });
    bars.push({ key: "v:" + d.day + "|1", day: d.day, kind: VERDICT_KINDS[1], n: d.noChange || 0, total: d.total || 0 });
  }
  return bars;
}

/** The five cards. A figure that is not known says so; it is never a zero. */
function overviewKpis(model, velocity, health, now) {
  const num = (v) => (typeof v === "number" ? v : null);
  let today = null, todayWhy = null;
  if (velocity && velocity.status === "ok" && Array.isArray(velocity.days)) {
    const hit = velocity.days.find((d) => d.day === localDay(now));
    today = hit ? (hit.total || 0) : 0;
  } else todayWhy = (velocity && velocity.reason) || "the surface sent no velocity";
  let fails = null, healthWhy = null;
  if (health && health.status === "ok" && health.data && health.data.ok !== false) fails = healthModel(health.data).fail;
  else if (health && (health.status === "error" || (health.data && health.data.ok === false))) healthWhy = "doctor's snapshot could not be read";
  else healthWhy = "reading doctor's snapshot…";
  const oldest = model.oldest;
  return [
    { key: "judge", label: "To judge", value: num(model.toJudge), text: model.toJudge == null ? "unknown" : String(model.toJudge),
      sub: "of " + plural(model.edges, "edge") + " in the queue, from " + plural(model.nSources, "source file"), warn: false,
      tip: "edges you can write a verdict on now. Click to open Judge" },
    { key: "blocked", label: "Blocked", value: num(model.blocked), text: model.blocked == null ? "unknown" : String(model.blocked),
      sub: "waiting on an upstream edge", warn: false, tip: "edges held back until an upstream edge is settled. Click to open Unblock" },
    { key: "oldest", label: "Oldest wait", value: oldest, text: oldest == null ? "none" : oldest + " d",
      sub: oldest == null ? "no queued edge has been judged yet" : "since that edge was last judged", warn: oldest != null && oldest > 28,
      tip: "the longest any queued edge has gone without a verdict. Click to open the edges in that age band" },
    { key: "today", label: "Judged today", value: today, text: today == null ? "unknown" : String(today),
      sub: today == null ? todayWhy : "verdicts recorded today", warn: false, tip: "verdicts written since midnight, local time. Click to open Activity" },
    { key: "health", label: "Health", value: fails, text: fails == null ? "…" : fails + " fail",
      sub: fails == null ? healthWhy : (fails ? "open Health for the next step" : "nothing failing"), warn: fails != null && fails > 0,
      tip: "doctor's failing checks. Click to open Health" },
  ].map((k) => Object.assign(k, { route: routeForKpi(k.key, model) }));
}

/* -- charts: inline SVG, no library --------------------------------------- */

function Spark({ points, stroke, label, unit, tipKind }) {
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
      ${/* One hit circle per reading, so every day answers a hover: a 2px line is not a target. A gap has no reading and so no circle. */ ""}
      ${pts.map((p, i) => p.value == null ? null : html`<circle key=${i} class="hit" cx=${x(i).toFixed(1)} cy=${y(p.value).toFixed(1)} r="7"
          ...${tipProps(tipText(tipKind || "runs", { day: p.day, count: p.value }))} />`)}
    </svg>
    ${/* The scale and the window sit OUTSIDE the svg. The max used to be an svg <text> at y=2, which floated above the plot as a bare "621" with no unit. */ ""}
    <div class="axnote"><span>${"dashed line: max " + max + (unit || "")}</span>${gaps ? html`<span>${gaps} day(s) with no run</span>` : null}</div>
    ${pts.length > 1 && pts[0].day && pts[pts.length - 1].day ? html`<div class="axnote"><span>${dayShort(pts[0].day)}</span><span>${dayShort(pts[pts.length - 1].day)}</span></div>` : null}`;
}

/**
 * Horizontal bars. `tipOf(row)` gives each row its tooltip; `onPick(row)` makes the row a
 * click target (and a keyboard one), with `doneLabel` naming the row that just acted so its
 * figure can say "copied". A row with neither is a plain, non-interactive bar.
 */
function Bars({ rows, colorOf, tipOf, onPick, doneLabel }) {
  const total = rows.reduce((n, r) => n + r.value, 0);
  return html`<div>
    ${rows.map((r) => html`
      <div key=${r.label} class=${"bar" + (onPick ? " pick" : "")} ...${tipOf ? tipProps(tipOf(r, total)) : {}}
        ...${onPick ? { onClick: () => onPick(r), tabIndex: 0, role: "button", onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(r); } } } : {}}>
        <span class="bar-l">${r.label}</span>
        <span class="bar-t"><span class="bar-f" style=${{ width: (total > 0 ? 100 * r.value / total : 0).toFixed(1) + "%", background: colorOf(r) }} /></span>
        <span class="bar-v">${doneLabel === r.label ? "copied" : r.value}</span>
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

/** Put text on the clipboard; `ok` runs once it landed. A blocked clipboard leaves the text visible to select. */
function copyText(text, ok) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, () => {});
      return true;
    }
  } catch (e) { /* the text is visible beside the button; selecting it is the fallback */ }
  return false;
}

function Copy({ text, label }) {
  const [done, setDone] = useState(false);
  const copy = () => copyText(text, () => { setDone(true); setTimeout(() => setDone(false), 1500); });
  return html`<button class="ghost" onClick=${copy}>${done ? "copied" : (label || "copy")}</button>`;
}

/* -- the one tooltip ------------------------------------------------------ */

// The setter of the mounted <TipLayer>. A module-level hook-up rather than context: every
// shape on the page would otherwise need the provider threaded through it, and there is
// exactly one tooltip on a page by construction.
let tipSet = null;
const tipShow = (tip, x, y) => { if (tipSet && tip) tipSet({ title: tip.title, lines: tip.lines, x: x, y: y }); };
const tipHide = () => { if (tipSet) tipSet(null); };

/**
 * The handlers that make an element show a tooltip. Spread onto the element:
 * `<div ...${tipProps(tipText("runs", d))}>`. Focus shows it too, anchored to the element,
 * so a keyboard user is not left with a hover-only fact. A null tip yields no handlers.
 */
function tipProps(tip) {
  if (!tip) return {};
  return {
    onMouseEnter: (e) => tipShow(tip, e.clientX, e.clientY),
    onMouseMove: (e) => tipShow(tip, e.clientX, e.clientY),
    onMouseLeave: tipHide,
    onFocus: (e) => {
      const el = e.currentTarget;
      const r = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      tipShow(tip, r ? r.left : 0, r ? r.bottom : 0);
    },
    onBlur: tipHide,
  };
}

function TipLayer() {
  const [tip, setTip] = useState(null);
  useEffect(() => { tipSet = setTip; return () => { tipSet = null; }; }, []);
  if (!tip) return null;
  const at = tipPlace(tip.x, tip.y, typeof innerWidth === "number" ? innerWidth : 0, typeof innerHeight === "number" ? innerHeight : 0);
  return html`<div class="tip" role="tooltip" style=${{ left: at.left + "px", top: at.top + "px" }}>
    <b>${tip.title}</b>${tip.lines.map((l, i) => html`<div key=${i}>${l}</div>`)}
  </div>`;
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

const JUDGE_STATES = ["DRIFTED", "REVERSED", "UNMATCHED"];
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
      role="option" aria-selected=${sel ? "true" : "false"} ...${tipProps(tipText("edge", r))}>
    <input type="checkbox" class="tick" checked=${ticked} aria-label=${"select " + label}
      onClick=${(e) => e.stopPropagation()} onChange=${onTick} />
    <span class=${"badge " + r.state}>${String(r.state).slice(0, 3)}</span>
    <span class="itxt">
      <span class="ttl">${label}${isNew ? html` <span class="newdot" ...${tipProps(tipText("note", { title: "New", text: "new since you last marked the queue seen" }))}>new</span>` : null}</span>
      ${/* Copy pass 2026-10-16 (plain-user pass): "crosses the line", "judged 5x" and "mostly no-op" were the code talking. */ ""}
      <span class="meta">${dot(boundaryLabel(r.boundary), r.parked ? (r.ageDays == null ? "parked, age unknown" : "parked " + r.ageDays + "d ago") : (r.judgedCount ? "judged " + plural(r.judgedCount, "time") : "never judged"),
        r.noiseRatio != null && r.noiseRatio >= 0.5 ? "usually nothing to change" : null)}</span>
    </span>
  </div>`;
}

function JudgeView({ app, route }) {
  const { inboxSt, retryInbox, model, seen, ev, loadEvidence, evTick, reasons, bulkReason, hold, pending, undo, say,
    msg, reduced, markSeen, rendered } = app;
  const [chip, setChip] = useState("judge");
  // ?state= narrows To judge to one edge state; ?chip= opens a chip ("both" is the widget's word
  // for the Both sides moved chip). Both are re-applied when the hash changes.
  const [stateFilter, setStateFilter] = useState(null);
  // ?ws= ?age= ?source= (from the Overview) narrow EVERY chip, beside state= and chip=. They are
  // state, not a re-read of the route, so clearing one does not wait on a hash change.
  const [filters, setFilters] = useState({ ws: null, age: null, source: null });
  useEffect(() => {
    const st = JUDGE_STATES.indexOf(route.state) >= 0 ? route.state : null;
    setStateFilter(st);
    const f = { ws: route.ws || null, age: AGE_KEYS.indexOf(route.age) >= 0 ? route.age : null, source: route.source || null };
    setFilters(f);
    const ck = route.chip === "both" ? "diverged" : route.chip;
    if (ck && CHIPS.some((c) => c.key === ck)) { setChip(ck); setIdx(0); }
    else if (st || f.ws || f.age || f.source) { setChip("judge"); setIdx(0); }
  }, [route.state, route.chip, route.ws, route.age, route.source]);
  const now = Date.now();
  const scoped = (list) => judgeFilterRows(list, filters, now);
  const anyFilter = !!(filters.ws || filters.age || filters.source);
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

  const rowsFor = (k) => (!model ? [] : k === "judge" ? scoped(stateFilter ? model.toJudge.filter((r) => r.state === stateFilter) : model.toJudge)
    : k === "diverged" ? scoped(model.diverged) : k === "parked" ? scoped(model.parked) : []);
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
  const counts4 = { judge: scoped(model.toJudge).length, diverged: scoped(model.diverged).length, parked: scoped(model.parked).length, never: model.gapTotal };
  // One clearable control per active filter, like the state one beside it. The source's tooltip
  // carries the full path: the chip shows the file name only.
  const clearF = (k) => { setFilters((f) => Object.assign({}, f, { [k]: null })); setIdx(0); };
  const filterChips = [
    filters.ws ? { k: "ws", text: "only " + filters.ws, name: "workspace" } : null,
    filters.age ? { k: "age", text: "only waited " + ageWords(filters.age), name: "waiting time" } : null,
    filters.source ? { k: "source", text: "only " + baseName(filters.source), name: "source", full: filters.source } : null,
  ].filter(Boolean);

  const chipsBar = html`<div class="chips" role="group" aria-label="queue filter">
    ${CHIPS.map((c) => html`<button key=${c.key} class=${"chip" + (chip === c.key ? " on" : "")} aria-pressed=${chip === c.key ? "true" : "false"}
        onClick=${() => { setChip(c.key); setIdx(0); }}>${c.label} <b>${counts4[c.key] == null ? "" : counts4[c.key]}</b></button>`)}
    ${stateFilter && chip === "judge" ? html`<button class="chip on filt" aria-label=${"clear the " + stateFilter.toLowerCase() + " filter"}
        onClick=${() => { setStateFilter(null); setIdx(0); }}>only ${stateFilter.toLowerCase()} <b>${rows.length}</b> ✕</button>` : null}
    ${filterChips.map((c) => html`<button key=${c.k} class="chip on filt" aria-label=${"clear the " + c.name + " filter"}
        onClick=${() => clearF(c.k)} ...${c.full ? tipProps(tipText("note", { title: "Source", text: c.full })) : {}}>${c.text} <b>${rows.length}</b> ✕</button>`)}
    <button class="ghost chip-seen" disabled=${!rendered.current || !flat.length || unseenCount === 0} onClick=${() => markSeen(renderedKeys.current)}
      ...${tipProps(tipText("note", { title: "Mark seen", text: "records the edges on screen as seen, so only later arrivals carry a new dot" }))}>Mark seen</button>
  </div>`;

  // With a source chosen, "judge everything this file changed" is the point: offer to tick the lot.
  const allTicked = flat.length > 0 && flat.every((r) => ticked.has(r.edge_id));
  const selectAllBar = filters.source && flat.length > 0 && !allTicked
    ? html`<div class="bulkstrip"><b>${plural(flat.length, "edge")}</b> from ${baseName(filters.source)}.
        <button class="ghost" onClick=${() => setTicked(new Set(flat.map((r) => r.edge_id)))}>select all ${flat.length}</button></div>` : null;

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
  } else if (!flat.length && anyFilter) {
    // A filtered list that is empty is not an empty queue: say which, and how to widen it.
    listBody = html`<div class="empty"><b>Nothing matches this filter.</b><br />The edge may already be judged, or the filter may be out of date. Clear it with the ✕ above.</div>`;
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
    <div class="list">${chipsBar}${selectAllBar}${seenNote}${unplacedNote}${listBody}</div>
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
    ${allowed.map((a) => html`<div class="vopt" key=${a}>
      <button disabled=${disabled} onClick=${() => onPick(a)}>${a}${keyFor(a) ? html` <kbd>${keyFor(a)}</kbd>` : null}</button>
      ${VERDICT_MEANING[a] ? html`<span class="vmean">${VERDICT_MEANING[a]}</span>` : null}
    </div>`)}
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
    <div class="dmeta">${dot(r.edge_id, r.state, r.layer != null ? "layer " + r.layer : null, boundaryLabel(r.boundary))}</div>
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
          ]} colorOf=${(r) => (/PERMANENT/.test(r.label) ? "var(--dim)" : "var(--st-accent)")}
            tipOf=${(r) => tipText("bucket", { label: r.label, value: r.value, total: model.gapTotal })} />
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
  return html`<div class="root" ...${tipProps(tipText("root", r))}>
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
  // A block, not a span: as an inline span it ran straight on from the detail text above
  // ("...path(s))no action mapped"), because both were inline children of one column.
  if (!action) return html`<div class="meta none-mapped">no action mapped</div>`;
  if (action.kind === "command") return html`<${Cmd} text=${action.target} label="copy command" />`;
  if (action.kind === "link") return html`<div class="cmdrow"><span class="meta">see ${action.target}</span><${Copy} text=${action.target} label="copy path" /></div>`;
  return html`<${Cmd} text=${action.target} label="copy path" />`;
}

function HealthRow({ e, tag, hl }) {
  return html`<div class=${"hrow" + (hl ? " focus" : "")} ...${tipProps(tipText("health", { label: e.label, section: e.section, tag: tag, action: e.action }))}>
    <span class=${"badge " + tag}>${tag === "fail" ? "FAIL" : "ACCEPTED"}</span>
    <div class="itxt">
      <span class="ttl">${e.label}</span>
      <span class="meta">${dot(e.section, e.detail)}</span>
      <${ActionCell} action=${e.action} />
    </div>
  </div>`;
}

// ?section=<doctor section name, or a prefix such as "Workspace:">: the widget's health chip
// lands HERE, on the section clicked, not on a page that also holds every other warning.
const inFocus = (focus, name) => !!focus && (name === focus || String(name).startsWith(focus));

function HealthView({ st, retry, focus }) {
  const top = useRef(null);
  useEffect(() => {
    if (!focus || st.status !== "ok" || !top.current || typeof top.current.querySelector !== "function") return;
    const el = top.current.querySelector(".focus");
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "start" });
  }, [focus, st.status]);
  if (st.status === "idle" || st.status === "loading") return html`<div class="detail wide"><${Skeleton} rows=${3} /></div>`;
  if (st.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="health could not be read —" st=${st} retry=${retry} /></div>`;
  const data = st.data || {};
  if (data.ok === false) {
    return html`<div class="detail wide"><div class="banner" role="alert"><b>doctor snapshot unreadable:</b> ${data.reason || data.error || "no reason given"}.
      Re-run doctor: <${Cmd} text="propagate doctor" label="copy" /></div></div>`;
  }
  const m = healthModel(data);
  const focused = focus ? (data.sections || []).filter((s) => inFocus(focus, s.name)) : [];
  const sum = (k) => focused.reduce((n, s) => n + (s[k] || 0), 0);
  return html`<div class="detail wide" ref=${top}>
    <h2 class="dtitle">Health</h2>
    ${focus ? html`<div class="banner focus" role="status"><b>${focus.replace(/:$/, "")}</b> · ${focused.length
      ? dot(sum("fail") + " fail", sum("accepted") + " accepted", sum("warn") + " warn", sum("pass") + " pass") + (focused.length > 1 ? " across " + plural(focused.length, "section") : "")
      : "no doctor section by that name in this snapshot"}</div>` : null}
    <div class=${"hline" + (m.fail === 0 ? " okline" : "")}>${dot(
      m.fail + " fail", m.accepted + " accepted", m.warn + " warn in " + plural(m.warnSections, "section"), "snapshot " + ageLabel(m.ageMs))} ·
      <${Copy} text="propagate doctor" label="re-run doctor" /></div>
    ${m.rows.fail.length + m.rows.accepted.length === 0
      ? html`<div class="empty"><b>0 fail</b> · snapshot ${ageLabel(m.ageMs)}. Nothing failing and nothing accepted.</div>`
      : html`<div>
          ${m.rows.fail.map((e, i) => html`<${HealthRow} key=${"f" + i} e=${e} tag="fail" hl=${inFocus(focus, e.section)} />`)}
          ${m.rows.accepted.map((e, i) => html`<${HealthRow} key=${"a" + i} e=${e} tag="accepted" hl=${inFocus(focus, e.section)} />`)}
        </div>`}
    ${m.warnBySection.length ? html`<div class="sec">Warnings, by section</div>${m.warnBySection.map((s) => html`<details key=${s.name} class=${"wsec" + (inFocus(focus, s.name) ? " focus" : "")} open=${inFocus(focus, s.name)}>
      <summary>${s.name} <span class="gn">${s.entries.length}</span></summary>
      ${s.entries.map((e, i) => html`<div class="hrow" key=${i}><span class="badge none">WARN</span><div class="itxt"><span class="ttl">${e.label}</span><span class="meta">${e.detail || ""}</span></div></div>`)}
    </details>`)}` : null}
  </div>`;
}

/* -- Activity ------------------------------------------------------------- */

function Velocity({ v, go }) {
  if (!v || v.status !== "ok") {
    return html`<div class="reason">unknown: ${(v && v.reason) || "the surface sent no velocity"}</div>`;
  }
  const days = v.days || [];
  const peak = days.reduce((n, d) => Math.max(n, d.total || 0), 0);
  if (!v.events) return html`<div class="reason">No verdicts in ${v.windowDays} days (event store read).</div>`;
  const share = ratio(v.noChangeEvents, v.events);
  return html`<div>
    <div class="vel" role="group" aria-label=${v.events + " verdicts in " + v.windowDays + " days"}>
      ${days.map((d) => {
        const h2 = peak > 0 ? 100 * (d.total || 0) / peak : 0;
        // The column is the hit area, and it is full chart height, so an EMPTY day (a 2px
        // stub) still answers a hover and a click. Mouse-only on purpose: thirty tab stops
        // would bury the keyboard path, and Judge is one rail key away.
        return html`<div class=${"vcol pick" + (d.total ? "" : " vgap")} key=${d.day} onClick=${go} ...${tipProps(tipText("verdicts", d))}>
          <div class="vstack" style=${{ height: h2.toFixed(1) + "%" }}>
            <span class="vseg-changed" style=${{ flexGrow: String(d.changed || 0) }} />
            <span class="vseg-quiet" style=${{ flexGrow: String(d.noChange || 0) }} />
          </div>
        </div>`;
      })}
    </div>
    ${/* The day axis. The bars had none, so the only way to learn which day a bar was was to guess from the window length. */ ""}
    <div class="vaxis" aria-hidden="true">${days.map((d, i) => html`<span class="vtick" key=${d.day}>${axisTicks(days.length).indexOf(i) >= 0 ? dayShort(d.day) : ""}</span>`)}</div>
    <div class="vleg"><span class="key key-changed" /> changed something <span class="key key-quiet" /> no change needed</div>
    <div class="caveat">${pct(share)} of ${v.events} verdicts in ${v.windowDays} days recorded that nothing needed doing</div>
  </div>`;
}

function Usage({ u }) {
  // Which command row was just copied, so its figure can say so for a moment.
  const [copied, setCopied] = useState(null);
  if (!u || (u.status !== "ok")) {
    return html`<div class="reason">${u && u.status === "none-recorded" ? "None recorded: " : "unknown: "}${(u && u.reason) || "the surface sent no usage"}</div>`;
  }
  const pts = (u.days || []).map((d) => ({ day: d.day, value: d.count }));
  return html`<div>
    <${Bars} rows=${(u.top || []).map((t) => ({ label: t.command, value: t.count }))} colorOf=${() => "var(--st-accent)"}
      tipOf=${(r, total) => tipText("command", { command: r.label, count: r.value, total: u.total })}
      doneLabel=${copied}
      onPick=${(r) => copyText("propagate " + r.label, () => { setCopied(r.label); setTimeout(() => setCopied(null), 1500); })} />
    <${Spark} points=${pts} stroke="var(--st-accent)" label="commands per day" unit="/day" />
    <div class="cov">${dot(plural(u.total, "run") + " in " + u.windowDays + " days", u.failures ? plural(u.failures, "failure") : null, u.refusals ? plural(u.refusals, "refusal") : null, "origin " + u.origin)}</div>
  </div>`;
}

function ActivityView({ st, retry, go }) {
  if (st.status === "idle" || st.status === "loading") {
    return html`<div class="detail wide"><div class="charts">${[0, 1].map((i) => html`<div class="chart" key=${i}><div class="skel"><i /><i /></div></div>`)}</div></div>`;
  }
  if (st.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="activity could not be read —" st=${st} retry=${retry} /></div>`;
  const s = st.data || {};
  return html`<div class="detail wide">
    <h2 class="dtitle">Activity</h2>
    <div class="charts">
      <${Chart} title="Verdicts per day" coverage="judgements recorded in the event store, per local day"><${Velocity} v=${s.velocity} go=${() => go("judge")} /><//>
      <${Chart} title="Commands you ran" coverage="interactive runs only, from the runs store"><${Usage} u=${s.usage} /><//>
    </div>
  </div>`;
}

/* -- Overview: Observable Plot (vendored d3 + Plot), tokens for every colour ---- */

/**
 * Why the charts cannot draw, or null when they can. It NAMES the cause: a blank card tells
 * nobody whether to reload, restart the server or file a bug. `Plot` is a global from
 * commands/vendor/plot.umd.min.js; under the headless suite it is simply absent, which is the
 * path the KPIs and the table must survive.
 */
function plotUnavailable() {
  if (typeof Plot === "undefined" || !Plot) return "the chart library did not load";
  if (typeof Plot.plot !== "function" || typeof Plot.barX !== "function" || typeof Plot.barY !== "function") return "the chart library loaded without its bar marks";
  return null;
}

/**
 * A design token as a colour the chart library can hand to an SVG attribute. `--seg-quiet` and
 * friends are RELATIVE colours (oklch(from ...)), and reading the custom property back returns
 * that source text, not a colour. A probe element asked for its computed colour returns the
 * resolved value, which is what an attribute needs. The var() text is the last resort, not a
 * hex: nothing here may carry a literal colour of its own (DESIGN.md).
 */
function resolveToken(name) {
  try {
    if (typeof document !== "undefined" && typeof getComputedStyle === "function" && document.body && document.createElement) {
      const probe = document.createElement("span");
      probe.style.color = "var(" + name + ")";
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      document.body.removeChild(probe);
      if (c) return c;
    }
  } catch (e) { /* fall through to the var() text */ }
  return "var(" + name + ")";
}

const STATE_TOKEN = { DRIFTED: "--edge-drift", REVERSED: "--edge-reverse", DIVERGED: "--edge-diverge", UNMATCHED: "--dim" };

/**
 * The Plot options for one chart. `P` and `tok` are passed in so a test can hand it a recording
 * stand-in: the contract is which marks, which fields and which colours, and none of that needs
 * a browser. Every shape gets an `ariaLabel` channel carrying its datum's key -- that is how a
 * rendered shape is matched back to its datum (wireChart), because the order of the shapes in
 * the DOM is Plot's business and not something to index into.
 */
function buildPlot(P, chart, data, tok, width) {
  const style = { background: "transparent", color: tok("--fg"), fontSize: "11px" };
  const keyOf = (d) => d.key;
  const states = { domain: STATE_ORDER, range: STATE_ORDER.map((s) => tok(STATE_TOKEN[s])), tickFormat: (s) => STATE_WORDS[s] || s };
  if (chart === "queue") {
    return P.plot({ style: style, width: width, height: 190, marginLeft: 120, color: Object.assign({ legend: true }, states),
      y: { domain: data.order, label: null }, x: { label: "edges", grid: true },
      marks: [P.barX(data.bars, { x: "n", y: "ws", fill: "state", ariaLabel: keyOf }), P.ruleX([0])] });
  }
  if (chart === "wait") {
    return P.plot({ style: style, width: width, height: 190, color: states,
      x: { domain: AGE_BUCKETS.map((b) => AGE_TICK[b.key]), label: null }, y: { label: "edges", grid: true },
      marks: [P.barY(data.bars, { x: "label", y: "n", fill: "state", ariaLabel: keyOf }), P.ruleY([0])] });
  }
  return P.plot({ style: style, width: width, height: 190,
    color: { domain: VERDICT_KINDS, range: [tok("--st-accent"), tok("--seg-quiet")], legend: true },
    x: { type: "band", label: null, tickFormat: (d) => String(d).slice(8) }, y: { label: "verdicts", grid: true },
    marks: [P.barY(data.bars, { x: "day", y: "n", fill: "kind", ariaLabel: keyOf }), P.ruleY([0])] });
}

/**
 * Make every drawn shape a click target with the page's own tooltip. Returns how many shapes it
 * matched, so the caller can say so when the answer is none (a chart that draws and answers
 * nothing is worse than one that says it cannot).
 */
function wireChart(node, chart, bars, nav) {
  if (!node || typeof node.querySelectorAll !== "function") return 0;
  const byKey = new Map(bars.map((b) => [b.key, b]));
  const kind = chart === "queue" ? "qbar" : chart === "wait" ? "wbar" : "vbar";
  let wired = 0;
  node.querySelectorAll("[aria-label]").forEach((el) => {
    const d = byKey.get(el.getAttribute("aria-label"));
    if (!d) return;
    wired += 1;
    const tip = tipText(kind, d);
    if (el.style) el.style.cursor = "pointer";
    const at = (e) => tipShow(tip, e.clientX, e.clientY);
    el.addEventListener("mouseenter", at);
    el.addEventListener("mousemove", at);
    el.addEventListener("mouseleave", tipHide);
    el.addEventListener("click", () => { const to = routeForBar(chart, d); if (to) nav(to); });
  });
  return wired;
}

function PlotChart({ chart, data, bars, nav }) {
  const host = useRef(null);
  const [res, setRes] = useState({ fail: null, note: null });
  const [tick, setTick] = useState(0);
  const why = plotUnavailable();
  // Redraw when the window is resized or the colour scheme flips: the colours were resolved
  // at draw time, so a theme change would otherwise leave the old theme's ink on the new ground.
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    let mq = null;
    try { mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null; } catch (e) { mq = null; }
    if (mq && typeof mq.addEventListener === "function") mq.addEventListener("change", again);
    if (typeof addEventListener === "function") addEventListener("resize", again);
    return () => {
      if (mq && typeof mq.removeEventListener === "function") mq.removeEventListener("change", again);
      if (typeof removeEventListener === "function") removeEventListener("resize", again);
    };
  }, []);
  useEffect(() => {
    const el = host.current;
    if (why || !el || !bars.length) return;
    try {
      const node = buildPlot(Plot, chart, data, resolveToken, el.clientWidth || (chart === "queue" ? 470 : 360));
      el.textContent = "";
      el.appendChild(node);
      const wired = wireChart(node, chart, bars, nav);
      setRes({ fail: null, note: wired ? null : "hover and click are unavailable on this chart" });
    } catch (e) {
      setRes({ fail: String((e && e.message) || e), note: null });
    }
  }, [bars, why, tick]);
  const problem = why || res.fail;
  if (problem) return html`<div class="reason">chart unavailable — ${problem}</div>`;
  if (!bars.length) return html`<div class="reason">nothing to chart yet</div>`;
  return html`<div><div class="plot" ref=${host}></div>${res.note ? html`<div class="cov">${res.note}</div>` : null}</div>`;
}

const SRC_COLS = [
  { key: "source", label: "source" },
  { key: "edges", label: "edges", num: true },
  { key: null, label: "what moved" },
  { key: "blocked", label: "blocked", num: true },
  { key: "oldest", label: "oldest", num: true },
  { key: "ws", label: "workspace" },
];

function MixBar({ g }) {
  return html`<div class="mix" role="img" aria-label=${STATE_ORDER.filter((s) => g.states[s]).map((s) => g.states[s] + " " + STATE_WORDS[s]).join(", ")}>
    ${STATE_ORDER.filter((s) => g.states[s]).map((s) => html`<i key=${s} class=${s} style=${{ width: (100 * g.states[s] / g.edges).toFixed(1) + "%" }} />`)}
  </div>`;
}

function sourceRoute(g) {
  return g.edges > 0 && g.blocked >= g.edges ? "unblock" : "judge?source=" + encodeURIComponent(g.source);
}

function SourcesTable({ model, nav }) {
  const [sort, setSort] = useState({ key: "edges", dir: "desc" });
  const list = sortSources(model.top, sort.key, sort.dir);
  const pickSort = (key) => setSort((s) => (s.key === key ? { key: key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: key, dir: SORT_DEFAULT_DIR[key] || "desc" }));
  // A source whose edges are ALL blocked has nothing Judge can list (Judge shows only edges that
  // can be settled now), so its row opens Unblock, where its blockers are. Found on the live
  // render 2026-10-16: MEASUREMENT.md, 14 edges, all 14 blocked, opened an empty Judge.
  const open = (g) => nav(sourceRoute(g));
  return html`<div>
    <div class="h2"><b>Sources with the most waiting edges</b><span>one source change can settle all its edges at once</span>
      <button class="ghost go" onClick=${() => nav("judge")}>all ${model.nSources} sources →</button></div>
    <table class="t">
      <thead><tr>${SRC_COLS.map((c) => c.key
        ? html`<th key=${c.key} class=${(c.num ? "num " : "") + "sortable"} tabIndex="0" role="columnheader" scope="col"
            aria-sort=${sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
            onClick=${() => pickSort(c.key)} onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickSort(c.key); } }}>${c.label}${sort.key === c.key ? (sort.dir === "asc" ? " ▴" : " ▾") : ""}</th>`
        : html`<th key=${c.label} scope="col">${c.label}</th>`)}</tr></thead>
      <tbody>${list.map((g) => html`<tr key=${g.source} class="pick" tabIndex="0" onClick=${() => open(g)}
          onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); open(g); } }} ...${tipProps(tipText("source", g))}>
        <td><div class="nm">${baseName(g.short)}</div><div class="dr">${String(g.short).split("/").slice(0, -1).slice(-2).join("/")}</div></td>
        <td class="num"><b>${g.edges}</b></td>
        <td><${MixBar} g=${g} /></td>
        <td class="num">${g.blocked}</td>
        <td class="num">${g.oldest < 0 ? "never" : g.oldest + " d"}</td>
        <td>${g.ws}</td>
      </tr>`)}</tbody>
    </table>
  </div>`;
}

function OverviewView({ app, surfaceSt, healthSt, nav }) {
  const { inboxSt, retryInbox } = app;
  const now = Date.now();
  const model = useMemo(() => overviewModel(inboxSt.data, now), [inboxSt.data]);
  const charts = useMemo(() => (model && !model.error ? {
    queue: queueBars(model.rows), wait: waitBars(model.rows),
    verdicts: verdictBars(surfaceSt.status === "ok" && surfaceSt.data ? surfaceSt.data.velocity : null),
  } : null), [model, surfaceSt.data]);
  if (inboxSt.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="the queue could not be read —" st=${inboxSt} retry=${retryInbox} /></div>`;
  if (!model) {
    if (inboxSt.data && inboxSt.data.fatal) return html`<div class="detail wide"><div class="banner" role="alert">${inboxSt.data.fatal}</div></div>`;
    return html`<div class="detail wide"><${Skeleton} rows=${4} /></div>`;
  }
  if (model.error) return html`<div class="detail wide"><div class="banner" role="alert"><b>the worklist</b> could not be computed — ${model.error}</div></div>`;
  const velocity = surfaceSt.status === "ok" && surfaceSt.data ? surfaceSt.data.velocity : { status: "unknown", reason: surfaceSt.status === "error" ? "the surface could not be read" : "reading the surface…" };
  const kpis = overviewKpis(model, velocity, healthSt, now);
  const vSub = velocity && velocity.status === "ok" ? "last " + velocity.windowDays + " days · changed vs no change needed · click a bar for Activity" : "unknown: " + ((velocity && velocity.reason) || "no velocity");
  return html`<div class="detail wide">
    <h2 class="dtitle">Overview</h2>
    <div class="kpis ov">
      ${kpis.map((k) => html`<div key=${k.key} class=${"kpi pick" + (k.warn ? " warn" : "")} role="button" tabIndex="0"
          onClick=${() => nav(k.route)} onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nav(k.route); } }}
          ...${tipProps(tipText("note", { title: k.label, text: k.tip }))}>
        <span>${k.label}</span><b>${k.text}</b><div class="ksub">${k.sub}</div>
      </div>`)}
    </div>
    <div class="charts charts3">
      <${Chart} title="Queue by workspace" coverage="edges in the queue, by what moved · click a bar to judge it">
        <${PlotChart} chart="queue" data=${charts.queue} bars=${charts.queue.bars} nav=${nav} /><//>
      <${Chart} title="How long edges have waited" coverage="since each was last judged · click a bar for that age band">
        <${PlotChart} chart="wait" data=${{ bars: charts.wait }} bars=${charts.wait} nav=${nav} /><//>
      <${Chart} title="Verdicts per day" coverage=${vSub}>
        <${PlotChart} chart="verdicts" data=${{ bars: charts.verdicts }} bars=${charts.verdicts} nav=${nav} /><//>
    </div>
    ${model.nSources ? html`<${SourcesTable} model=${model} nav=${nav} />` : html`<div class="empty"><b>Nothing waiting.</b> No source file has an edge in the queue.</div>`}
  </div>`;
}

/* -- Explore: registers, reminders, graph --------------------------------- */

function RegisterList({ title, rows }) {
  const shown = (rows || []).slice(0, 50);
  return html`<div class="rgroup">
    <div class="sec">${title} <span class="gn">${(rows || []).length}</span></div>
    ${!(rows || []).length ? html`<div class="reason">None open.</div>` : html`<div class="shead"><span class="sh-p">priority</span><span>item</span></div>`}
    ${shown.map((r, i) => html`<div class="sitem" key=${i} ...${tipProps(tipText("register", r))}>
      ${/* P0 is a priority, and it is the most urgent one: the old test was truthiness, so 0 fell through to the id and rendered as a dot. */ ""}
      <span class=${"badge " + (r.priority !== null && r.priority !== undefined && r.priority !== "" ? "open" : "none")}>${priorityLabel(r)}</span>
      <div><div>${inlineMd(r.text).map((seg, j) => seg.k === "bold" ? html`<b key=${j}>${seg.s}</b>` : seg.k === "code" ? html`<code class="mono" key=${j}>${seg.s}</code>` : seg.s)}</div><div class="dmeta">${dot(r.short, r.line ? "line " + r.line : null, r.date)}</div></div>
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
    const friendly = remindersTimeoutText(why);
    return html`<div class="detail wide">
      <h2 class="dtitle">Reminders</h2>
      ${friendly
        ? html`<div class="banner" role="alert">${friendly} <button class="ghost" onClick=${retry}>Retry</button></div><div class="dmeta">${why}</div>`
        : html`<div class="banner" role="alert">could not read the reminders list — ${why}</div>`}
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
  return html`<div class="detail wide"><iframe class="frame" srcdoc=${st.page} aria-label="dependency graph" /></div>`;
}

/* -- the app -------------------------------------------------------------- */

function parseHash(hash) {
  // `#/unblock?edge=<id>`: the query rides in the hash because the server never
  // sees a fragment. An EMPTY hash opens the Overview; an unknown name lands on
  // /judge, never a blank page.
  const raw = (hash || "").slice(1).replace(/^[/]+/, "");
  const q = raw.indexOf("?");
  const name = q >= 0 ? raw.slice(0, q) : raw;
  // Deep links from the widget (2026-10-15, "give me cta for everything"): `section=` opens
  // Health at a doctor section, `state=` filters Judge to one edge state, `chip=` opens a Judge
  // chip. A value the view does not know is ignored and the view opens normally.
  // `ws=`, `age=` and `source=` (Overview, 2026-10-16) narrow Judge further; `age` must be one of
  // the bucket keys, the rest are taken as written and simply match nothing if they are stale.
  const params = q >= 0 ? raw.slice(q + 1) : "";
  const get = (k) => { const m = new RegExp("(?:^|&)" + k + "=([^&]*)").exec(params); if (!m) return null; try { return decodeURIComponent(m[1]); } catch { return null; } };
  const age = get("age");
  return { view: name === "" ? "overview" : (HASH_TO_VIEW[name] || "judge"), edge: get("edge"), section: get("section"), state: get("state"), chip: get("chip"),
    ws: get("ws") || null, age: AGE_KEYS.indexOf(age) >= 0 ? age : null, source: get("source") || null };
}
function readHash() { return parseHash(location.hash); }

function App() {
  const [route, setRoute] = useState(readHash());
  const view = route.view;
  const [inboxSt, retryInbox] = useResource("/api/inbox", true);
  const firstLanded = inboxSt.status === "ok" || inboxSt.status === "error";
  const [surfaceSt, retrySurface] = useResource("/api/surface", firstLanded);
  // The Overview reads health only for its fail count, but it is the same resource: one fetch, shared.
  const [healthSt, retryHealth] = useResource("/api/health", view === "health" || view === "overview");
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

  // An element that unmounts under the pointer never fires mouseleave, so a tooltip would
  // outlive the view it described.
  useEffect(() => { tipHide(); }, [route.view]);

  const go = useCallback((v, edge) => { setRoute({ view: v, edge: edge || null }); if (!edge) location.hash = "#/" + v; }, []);
  // A destination WITH a query ("judge?ws=...&state=..."): the route is parsed from the same text
  // the hash will carry, so the filters cannot differ between a click and a reload.
  const nav = useCallback((to) => { if (!to) return; setRoute(parseHash("#/" + to)); location.hash = "#/" + to; }, []);

  // Refresh re-fetches what the CURRENT view reads, and the badges with it, so a
  // number in the rail cannot disagree with the list beside it (#70.7).
  const refresh = () => {
    retryInbox(); retrySurface();
    if (view === "health" || view === "overview") retryHealth();
    if (view === "registers") retryReg();
    if (view === "reminders") retryRem();
  };

  const model = useMemo(() => judgeModel(inboxSt.data, heldIds), [inboxSt.data, heldIds]);
  const app = { inboxSt, retryInbox, model, seen, ev, loadEvidence, evTick, reasons, bulkReason, hold, pending, undo, say, msg, reduced, markSeen, rendered, go };

  const surfaceHealth = surfaceSt.status === "ok" && surfaceSt.data && surfaceSt.data.health && surfaceSt.data.health.ok
    ? surfaceSt.data.health.sections.reduce((a, s) => a + (s.fail || 0), 0) : null;
  const badge = (k) => (k === "judge" ? n.judge : k === "unblock" ? n.unblock : k === "health" ? surfaceHealth : null);

  let body;
  if (view === "overview") body = html`<${OverviewView} app=${app} surfaceSt=${surfaceSt} healthSt=${healthSt} nav=${nav} />`;
  else if (view === "judge") body = html`<${JudgeView} app=${app} route=${route} />`;
  else if (view === "unblock") body = html`<${UnblockView} app=${app} />`;
  else if (view === "health") body = html`<${HealthView} st=${healthSt} retry=${retryHealth} focus=${route.section} />`;
  else if (view === "activity") body = html`<${ActivityView} st=${surfaceSt} retry=${retrySurface} go=${go} />`;
  else if (view === "registers") body = html`<${RegistersView} st=${regSt} retry=${retryReg} />`;
  else if (view === "reminders") body = html`<${RemindersView} st=${remSt} retry=${retryRem} />`;
  else body = html`<${GraphView} />`;

  const inbox = inboxSt.data;
  return html`
    <header>
      <h1>propagate</h1>
      <div class="sum">${inbox && inbox.declared != null
        ? html`<b>${inbox.declared}</b> links between files · <b>${inbox.expanded}</b> file pairs checked`
        : (inboxSt.status === "error" ? "queue unavailable" : "loading…")}</div>
      <div class="session">${judged ? html`<b>${judged}</b> judged this session` : ""}</div>
      <button class="ghost" onClick=${refresh} ...${tipProps(tipText("note", { title: "Refresh", text: "re-read this view and the counts" }))}>refresh</button>
    </header>
    <${TipLayer} />
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
  globalThis.__ui = { sourceRoute, counts, linePath, KEYS, keyFor, DIVISIONS, UNDO_MS, readHash, disposeBody, judgeModel, groupRows, workspaceOf,
    intersectAllowed, pruneTicked, unblockModel, healthModel, parkedAllowed, baselineCommand, gitDiffCommand, shellQuote, pct, ratio, dot, ageLabel,
    conflictGroup, groupConflicts, conflictsEmptyLine, CONFLICT_GROUPS, TOKEN_EXPIRED, HASH_TO_VIEW, FIRST_EXPLORE, request,
    parseHash, AGE_BUCKETS, AGE_KEYS, ageKey, ageDaysOf, judgeFilterRows, overviewModel, overviewKpis, sortSources, routeForKpi, routeForBar,
    queueBars, waitBars, verdictBars, buildPlot, wireChart, plotUnavailable, resolveToken, localDay,
    tipText, tipPlace, inlineMd, dayLabel, dayShort, axisTicks, priorityLabel, remindersTimeoutText, boundaryLabel, VERDICT_MEANING };
}

if (typeof document !== "undefined" && document.getElementById("app")) {
  render(html`<${App} />`, document.getElementById("app"));
}
