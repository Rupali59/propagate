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
  { key: "overview", label: "OVERVIEW", group: "today" },
  { key: "judge", label: "JUDGE", act: true, group: "settle" },
  { key: "unblock", label: "UNBLOCK", act: true, group: "settle" },
  { key: "health", label: "HEALTH", group: "machinery" },
  { key: "claims", label: "CLAIMS", group: "machinery" },
  { key: "rules", label: "RULES", group: "machinery" },
  { key: "caps", label: "CAPS", group: "machinery" },
  { key: "skills", label: "SKILLS", group: "machinery" },
  { key: "backlog", label: "BACKLOG", group: "work" },
  { key: "goals", label: "GOALS", group: "work" },
  { key: "registers", label: "REGISTERS", group: "work" },
  { key: "reminders", label: "REMINDERS", group: "work" },
  { key: "activity", label: "ACTIVITY", group: "history" },
  { key: "history", label: "HISTORY", group: "history" },
  // Framed rather than dropped: lib/graph/graph-html.mjs renders a whole
  // interactive page at /graph, and open-ui.sh turns a widget route into a
  // hash -- so a link to it only resolves if the client routes it. It used to
  // be written to disk and opened standalone, which made it a second place
  // with no way back.
  { key: "graph", label: "GRAPH", group: "history" },
];

/* Every hash an older widget or bookmark can still send, and where it lands.
   The new keys map to themselves so readHash has ONE lookup. */
const HASH_TO_VIEW = { ready: "judge", parked: "judge", gap: "judge", blocked: "unblock",
  reference: "health", analytics: "activity", stream: "activity", conflicts: "reminders",
  overview: "overview", judge: "judge", unblock: "unblock", health: "health", activity: "activity",
  registers: "registers", reminders: "reminders", graph: "graph",
  claims: "claims", rules: "rules", caps: "caps", skills: "skills", backlog: "backlog", goals: "goals", history: "history" };

/* PR-025, re-derived twice. The rail's group separator used to be `i === 4`, a position one insertion away from
   silently labelling the wrong group. It was then derived from an `explore` flag; Phase 4a (2026-10-17) replaced the
   two-way split with five named groups, TODAY / SETTLE / MACHINERY / WORK / HISTORY. A division says which group it is
   in (`group`), and the rail starts a new group wherever that value changes -- so inserting a view moves nothing by
   position. `railGroups` is that rule as a pure function, for the renderer and the test to share. */
const RAIL_GROUPS = [
  { key: "today", label: "TODAY" }, { key: "settle", label: "SETTLE" }, { key: "machinery", label: "MACHINERY" },
  { key: "work", label: "WORK" }, { key: "history", label: "HISTORY" },
];
function railGroups(divs) {
  const out = [];
  for (const d of divs) {
    const last = out[out.length - 1];
    if (last && last.key === d.group) last.items.push(d);
    else out.push({ key: d.group, label: ((RAIL_GROUPS.find((g) => g.key === d.group) || {}).label) || String(d.group).toUpperCase(), items: [d] });
  }
  return out;
}

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

/**
 * How one resource read looks to a FIGURE (Phase 0, 2026-10-16). Three states, three sentences.
 *
 * WHY. `/api/surface` is gated behind `/api/inbox` (`firstLanded` in App), so for about four
 * seconds on a cold start "Judged today" read "unknown" -- the very word a FAILED read used. A
 * reader could not tell "the page has not asked yet" from "it asked and the server could not
 * answer", and only one of those needs them to do anything. So a pending read says "loading…",
 * a failed one says "could not read — <reason>", and "unknown" is not used for either
 * (rule:discernment-checks 2: absence must be attributable, and a wait is not an absence).
 * `idle` counts as pending: it is a lazy resource whose gate has not opened yet.
 */
const LOADING = "loading…";
function readState(st) {
  if (!st || st.status === "idle" || st.status === "loading") return { kind: "loading", reason: null, text: LOADING };
  if (st.status === "error") {
    const reason = st.kind === "token" ? TOKEN_EXPIRED : (st.error || "the server gave no reason");
    return { kind: "error", reason: reason, text: "could not read — " + reason };
  }
  return { kind: "ok", reason: null, text: null };
}

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
  return "Reminders did not answer" + (secs ? " in " + secs + "s" : "") + ". Open Reminders once and allow access, then retry.";
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
  if (kind === "runs") {
    return { title: dayLabel(v.day), lines: [num(v.count) > 0 ? plural(num(v.count), "command") + " run" : "no commands run", "hover only — no list behind a day's count"] };
  }
  if (kind === "command") {
    const p = share(v.count, v.total);
    return { title: v.command || "command", lines: [plural(num(v.count), "run"), p ? p + " of " + num(v.total) + " interactive runs" : null,
      "click to copy: propagate " + v.command].filter(Boolean) };
  }
  if (kind === "bucket") {
    const p = share(v.value, v.total);
    return { title: v.label, lines: [plural(num(v.value), "edge"), p ? p + " of " + num(v.total) + " never verified" : null, v.hint || null].filter(Boolean) };
  }
  if (kind === "root") {
    if (v.unknown) return { title: v.edge_id, lines: ["not in the queue any more"] };
    return { title: v.source + " → " + v.downstream, lines: ["frees " + num(v.freesNow) + " now",
      v.upstreamOf != null ? "upstream of " + num(v.upstreamOf) : null,
      v.inQueue ? "click to judge this root" : "never verified: click to copy the command to baseline it"].filter(Boolean) };
  }
  if (kind === "edge") {
    return { title: v.sourceShort + " → " + v.downstreamShort,
      lines: [dot(v.state, boundaryLabel(v.boundary)), v.parked ? "parked" : (v.judgedCount ? "judged " + plural(v.judgedCount, "time") : "never judged"), "click to open the evidence"].filter(Boolean) };
  }
  if (kind === "health") {
    return { title: v.label, lines: [v.section, v.tag === "fail" ? "failing check" : v.tag === "warn" ? "warning, not failing" : "accepted, not fixed",
      v.action ? "next step: " + v.action.target : (v.tag === "warn" ? "doctor maps no next step for a warning" : "no action mapped"),
      v.action ? "click to copy the next step" : null].filter(Boolean) };
  }
  if (kind === "register") {
    const loc = registerLocator(v);
    return { title: v.id || v.short || "item", lines: [dot(v.priority != null ? "priority " + priorityLabel(v) : "no priority", v.short, v.line ? "line " + v.line : null, v.date),
      loc ? "click to copy " + loc : "no file recorded for this item"] };
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
      lines: [num(v.n) > 0 ? plural(num(v.n), "verdict") : "none recorded", num(v.total) > 0 ? "of " + plural(num(v.total), "verdict") + " that day" : null,
      // `go` is where wireChart says this bar leads: Judge on the Activity page, Activity from the Overview.
      "click to open " + (v.go === "judge" ? "Judge" : "Activity")].filter(Boolean) };
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
 * `?tick=<id>,<id>` (Unblock "settle together", Phase 3, 2026-10-17): the edge ids to pre-tick in Judge.
 * An id is the characters edge ids are made of (8 hex today, letters digits _ - allowed) and at most 64
 * long. ONE bad piece rejects the WHOLE value, not just that piece: a link that was mangled in transit
 * is not partly trusted. The result never reaches a selector or the server -- it is only compared with
 * ids already in the queue (preTick).
 */
const TICK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TICK_MAX = 200;
function parseTick(value) {
  if (value == null || value === "") return { ids: [], rejected: false };
  const parts = String(value).split(",");
  if (parts.length > TICK_MAX) return { ids: [], rejected: true };
  const ids = [];
  for (const p of parts) {
    if (!TICK_ID.test(p)) return { ids: [], rejected: true };
    if (ids.indexOf(p) < 0) ids.push(p);
  }
  return { ids: ids, rejected: false };
}

/** Split requested ids into those Judge lists (toJudge, diverged, parked) and those it does not. Pure. */
function preTick(ids, model) {
  const listed = new Map();
  if (model) for (const k of ["toJudge", "diverged", "parked"]) for (const r of model[k] || []) if (!listed.has(r.edge_id)) listed.set(r.edge_id, k);
  const ticked = [];
  const missing = [];
  for (const id of ids || []) { if (listed.has(id)) ticked.push(id); else missing.push(id); }
  return { ticked: ticked, missing: missing, where: ticked.map((id) => listed.get(id)) };
}

/** The Judge destination for one "settle together" group: every root id, in the group's order. */
function settleTogetherRoute(g) {
  return "judge?tick=" + g.roots.map((r) => encodeURIComponent(r.edge_id)).join(",");
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

/** Table order for the sources: the generic sortRows over a source's own fields, ties to the source path. */
function sortSources(list, key, dir) {
  const val = (g) => (key === "source" ? baseName(g.short).toLowerCase() : key === "ws" ? String(g.ws).toLowerCase() : g[key]);
  return sortRows(list, val, dir, (g) => g.source);
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
function routeForBar(chart, d, from) {
  if (!d) return null;
  const enc = encodeURIComponent;
  if (chart === "queue") {
    if (!d.ws) return null;
    const q = "judge?ws=" + enc(d.ws);
    if (d.state === "DIVERGED") return q + "&chip=both";
    return JUDGE_STATES.indexOf(d.state) >= 0 ? q + "&state=" + enc(d.state) : q;
  }
  if (chart === "wait") return AGE_KEYS.indexOf(d.bucket) >= 0 ? "judge?age=" + enc(d.bucket) : null;
  // ONE chart, two homes. On the Overview a verdict bar opens Activity (the place to read verdicts
  // over time); on Activity itself that would be a no-op, so the same bar opens Judge, where
  // verdicts are made. The tooltip names whichever it is (tipText "vbar"), so the click is never a surprise.
  if (chart === "verdicts") return from === "activity" ? "judge" : "activity";
  // The buckets carry their own destination (or none: the inbox has no row per edge to open).
  if (chart === "buckets") return d.route || null;
  return null;
}

/**
 * What a click on a chart shape DOES: {route} to navigate, {copy} to put a command on the
 * clipboard, or null when nothing is behind it (a per-day command count, a bucket with no list).
 * One place, so the pointer cursor, the tooltip and the click cannot disagree about it.
 */
function barTarget(chart, d, from) {
  const route = routeForBar(chart, d, from);
  if (route) return { route: route };
  if (chart === "usage" && d && d.command) return { copy: "propagate " + d.command };
  if (chart === "buckets" && d && d.copy) return { copy: d.copy };
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

/**
 * The velocity the Overview and Activity read, whatever state the surface is in. A loaded
 * surface hands back its own `velocity` (which may itself say it could not be read); a pending
 * or failed `/api/surface` read becomes the same shape, so every consumer branches on ONE field
 * and the two cases cannot be given the same word (Phase 0).
 */
function surfaceVelocity(surfaceSt) {
  const rs = readState(surfaceSt);
  if (rs.kind === "loading") return { status: "loading", reason: null };
  if (rs.kind === "error") return { status: "error", reason: rs.reason };
  const v = surfaceSt.data && surfaceSt.data.velocity;
  return v && typeof v === "object" ? v : { status: "error", reason: "the surface sent no velocity" };
}

/** What a figure or a chart says in place of a number that is not (yet) there. Null when the velocity is readable. */
function velocityNote(v) {
  if (v && v.status === "ok") return null;
  if (v && v.status === "loading") return LOADING;
  return "could not read — " + ((v && v.reason) || "the surface sent no velocity");
}

/**
 * The five cards. A figure that is not known says so; it is never a zero. And "not known" has
 * two causes that must not share a word: still being read ("loading…") and failed to read
 * ("could not read", with the reason beneath it). Phase 0, 2026-10-16.
 */
function overviewKpis(model, velocity, health, now, inbox) {
  const num = (v) => (typeof v === "number" ? v : null);
  // "To judge" and "Blocked" come out of /api/inbox. A number already held wins (a refresh keeps the old
  // figure on screen); only a MISSING one is told apart: still reading, failed, or read fine but not sent.
  const is = readState(inbox);
  const inboxNote = (what) => is.kind === "loading" ? { text: LOADING, sub: "reading the queue" }
    : is.kind === "error" ? { text: "could not read", sub: is.reason }
    : { text: "could not read", sub: "the queue sent no " + what };
  let today = null, todayText, todaySub;
  if (velocity && velocity.status === "ok" && Array.isArray(velocity.days)) {
    const hit = velocity.days.find((d) => d.day === localDay(now));
    today = hit ? (hit.total || 0) : 0;
    todayText = String(today);
    todaySub = "verdicts recorded today";
  } else if (velocity && velocity.status === "loading") {
    todayText = LOADING;
    todaySub = "reading today's verdicts";
  } else {
    todayText = "could not read";
    todaySub = (velocity && velocity.reason) || "the surface sent no velocity";
  }
  let fails = null, healthText, healthSub;
  const hs = readState(health);
  if (hs.kind === "ok" && health.data && health.data.ok !== false) {
    fails = healthModel(health.data).fail;
    healthText = fails + " fail";
    healthSub = fails ? "open Health for the next step" : "nothing failing";
  } else if (hs.kind === "loading") {
    healthText = LOADING;
    healthSub = "reading doctor's snapshot";
  } else {
    healthText = "could not read";
    healthSub = hs.kind === "error" ? hs.reason : (health.data.reason || health.data.error || "doctor's snapshot could not be read");
  }
  const oldest = model.oldest;
  return [
    { key: "judge", label: "To judge", value: num(model.toJudge), text: model.toJudge == null ? inboxNote("worklist count").text : String(model.toJudge),
      sub: model.toJudge == null ? inboxNote("worklist count").sub : "of " + plural(model.edges, "edge") + " in the queue, from " + plural(model.nSources, "source file"), warn: false,
      tip: "edges you can write a verdict on now. Click to open Judge" },
    { key: "blocked", label: "Blocked", value: num(model.blocked), text: model.blocked == null ? inboxNote("blocked count").text : String(model.blocked),
      sub: model.blocked == null ? inboxNote("blocked count").sub : "waiting on an upstream edge", warn: false, tip: "edges held back until an upstream edge is settled. Click to open Unblock" },
    { key: "oldest", label: "Oldest wait", value: oldest, text: oldest == null ? "none" : oldest + " d",
      sub: oldest == null ? "no queued edge has been judged yet" : "since that edge was last judged", warn: oldest != null && oldest > 28,
      tip: "the longest any queued edge has gone without a verdict. Click to open the edges in that age band" },
    { key: "today", label: "Judged today", value: today, text: todayText,
      sub: todaySub, warn: false, tip: "verdicts written since midnight, local time. Click to open Activity" },
    { key: "health", label: "Health", value: fails, text: healthText,
      sub: healthSub, warn: fails != null && fails > 0,
      tip: "doctor's failing checks. Click to open Health" },
  ].map((k) => Object.assign(k, { route: routeForKpi(k.key, model) }));
}

/* -- charts: ONE implementation (Observable Plot, below) --------------------------
 * Four chart implementations used to live here (Plot on the Overview, flex columns for
 * Velocity, an SVG Spark, div Bars) and "verdicts per day" was drawn twice by two of them with
 * two different click targets. Phase 1 (2026-10-16) moved every chart to PlotChart; this card is
 * only the frame around one. */

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
 *
 * THE ONE ERROR BANNER (Phase 1, 2026-10-16). About ten hand-written `div.banner` blocks used
 * to say a read failed with no way to try again, beside the few that used this; each is now this
 * component so the wording, the role and the retry are the same everywhere. `note` is a
 * follow-on sentence (what the reader can still do); `extra` is a control that belongs beside
 * the message (a copyable command). A banner with no `retry` is one where trying again would
 * change nothing -- the data was read and is itself the problem.
 */
function ErrorBanner({ what, st, retry, note, extra }) {
  const token = st && st.kind === "token";
  return html`<div class="banner" role="alert">
    ${what ? html`<b>${what}</b>` : null}${what ? " " : null}${token ? TOKEN_EXPIRED : (st && st.error) || "failed for a reason the server did not give"}${note ? " " + note : null}
    ${token || !retry ? null : html` <button class="ghost" onClick=${retry}>retry</button>`}
    ${extra || null}
  </div>`;
}

/** Stop a click or key inside a control from also activating the row or card around it. */
const stop = (e) => { if (e && typeof e.stopPropagation === "function") e.stopPropagation(); };

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
  // stop(): a Copy button inside a DataTable row must not ALSO fire the row's own action.
  const copy = (e) => { stop(e); copyText(text, () => { setDone(true); setTimeout(() => setDone(false), 1500); }); };
  return html`<button class="ghost" onClick=${copy}>${done ? "copied" : (label || "copy")}</button>`;
}

/**
 * Which key was copied a moment ago, so its row or bar can say "copied". `copy(key, text)` writes
 * the clipboard and flags the key for 1.5 s; a blocked clipboard flags nothing, which is
 * honest: the text is still visible to select (copyText).
 */
function useCopyFlash() {
  const [done, setDone] = useState(null);
  const copy = useCallback((key, text) => copyText(text, () => { setDone(key); setTimeout(() => setDone(null), 1500); }), []);
  return [done, copy];
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
const Cmd = ({ text, label }) => html`<div class="cmdrow" onClick=${stop} onKeyDown=${stop}><code class="cmd">${text}</code><${Copy} text=${text} label=${label} /></div>`;

/* -- the two shared pieces every view is built from (Phase 1, 2026-10-16) ------- */

/**
 * One KPI card. {label, value, sub, route, tip} -- and `route` is REQUIRED: a figure a person
 * can see and cannot click is a dead end the page never explained. When a figure genuinely
 * leads nowhere (nothing is blocked, so there is no list to open), `route` is null and `tip`
 * is the REASON, shown by the same tooltip a live card uses. A null route with no reason
 * renders KPI_NO_REASON, a sentence that reads as a defect on purpose and that a test asserts
 * never appears.
 *
 * Label on top, value, then the sub-line -- the Overview's markup. The Unblock stat row used a
 * different one (value on top, inert), which is the inconsistency this replaces.
 */
const KPI_NO_REASON = "this figure goes nowhere, and nothing says why";
function Kpi({ label, value, sub, route, act, tip, warn, cls, nav }) {
  // `act` is the second kind of destination: a function (a copy, today) for a figure whose page does not exist
  // yet. A route wins when both are given. Either way the card is live and `tip` says which it is.
  const go = route && nav ? () => nav(route) : (typeof act === "function" ? act : null);
  const live = !!go;
  const text = live ? tip : (tip || KPI_NO_REASON);
  const props = live
    ? { role: "button", onClick: go, onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } } }
    : { role: "group" };
  // Both kinds take focus: an inert card's reason is a tooltip, and focus is how a keyboard user gets one.
  return html`<div class=${"kpi " + (live ? "pick" : "inert") + (warn ? " warn" : "") + (cls ? " " + cls : "")} tabIndex="0" ...${props}
      ...${tipProps(tipText("note", { title: label, text: text }))}>
    <span>${label}</span><b>${value}</b><div class="ksub">${sub}</div>
  </div>`;
}

/**
 * Rows ordered by one column's value. Null and undefined sort LAST in both directions (a figure
 * that is not there is not the smallest figure), ties fall to `tie(row)` so a re-sort never
 * shuffles equals between renders. Pure, so the order is testable without a table.
 */
function sortRows(rows, value, dir, tie) {
  const sign = dir === "asc" ? 1 : -1;
  const byTie = (a, b) => {
    if (!tie) return 0;
    const x = tie(a), y = tie(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  return (rows || []).slice().sort((a, b) => {
    const x = value(a), y = value(b);
    if (x == null || y == null) return x == null && y == null ? byTie(a, b) : (x == null ? 1 : -1);
    const c = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : (x - y);
    return c !== 0 ? sign * c : byTie(a, b);
  });
}

/**
 * Rows a DataTable shows at once. 50, for two measured reasons. Every row is focusable and carries tooltip handlers, so
 * the DOM cost is per row: Claims alone is 194 rows, Backlog about 800. And 50 is the cap Registers already used, so a
 * page that gained paging did not also change how much a person sees at once. The paging is in the table, not the
 * pages: sort and filter act on EVERY row first and the window is cut from the result.
 */
const TABLE_PAGE_SIZE = 50;

/**
 * The window onto `total` rows for page `page` (0-based, clamped), as 1-based `from`/`to` for "showing 51-100 of 194"
 * and 0-based `start`/`end` for slice. Pure, so the arithmetic is tested without a table. A page past the end (rows
 * shrank under a filter) reads as the last page, never an empty one.
 */
function pageWindow(total, page, size) {
  const n = Math.max(0, total | 0);
  const sz = size > 0 ? size : TABLE_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(n / sz));
  const p = Math.min(Math.max(0, page | 0), pages - 1);
  const start = p * sz;
  const end = Math.min(n, start + sz);
  return { pages: pages, page: p, start: start, end: end, from: n === 0 ? 0 : start + 1, to: end };
}
/**
 * The ONE table. Generalised from the Overview's sources table; Unblock's roots, Health,
 * Registers and Reminders all render through it, so a row looks, sorts, focuses and explains
 * itself the same way everywhere.
 *
 *   columns   [{key, label, num?, value?(row), cell(row)}] -- `value` makes the header sortable
 *             (aria-sort, Enter or Space on the header); a number column sorts largest-first
 *             on the first click, text A to Z.
 *   rowKey    row -> stable key
 *   route     row -> "view?query" | null: Enter or a click navigates (needs `nav`)
 *   act       row -> function | null: Enter or a click runs it (a copy, in Registers and Reminders)
 *   tip       row -> {title, lines} | null: the page's one tooltip, on hover AND on focus
 *   rowClass  row -> extra class names; flashKey names the row that was just acted on ("copied")
 *   pageSize  rows per page (default TABLE_PAGE_SIZE); a table of more rows shows "showing 1-50 of N" with prev and next
 *
 * EVERY row is keyboard-focusable, even an inert one, because focus is how a keyboard user gets
 * the tooltip. A row with neither `route` nor `act` is `inert`, and then `tip` is its reason; with
 * no tip at all it says ROW_NO_REASON, which a test asserts never appears. A control INSIDE a cell
 * (Copy, Cmd, a button) stops its own click, and a key press only acts when the row itself has
 * focus, so Enter on a button never also fires the row.
 */
const ROW_NO_REASON = "this row goes nowhere, and nothing says why";
function DataTable({ columns, rows, rowKey, initialSort, tie, route, act, tip, rowClass, flashKey, label, nav, pageSize }) {
  const [sort, setSort] = useState(initialSort || null);
  const col = sort ? columns.find((c) => c.key === sort.key && c.value) : null;
  // SORT FIRST, THEN PAGE: the order is over every row, and a page is a window onto it. Paging the rows and sorting
  // the page would put the largest figure on page 1 only if it happened to be there. `rows` is whatever the caller
  // already filtered, so a filter also applies before paging.
  const list = col ? sortRows(rows, col.value, sort.dir, tie) : rows;
  const size = pageSize || TABLE_PAGE_SIZE;
  // A page number is only meaningful for the rows and order it was chosen under. The signature (order + row count +
  // first and last key) changes when a filter, a sort or a refresh changes them, and a changed signature reads as page 1.
  // A filter that leaves the same first row, last row and count cannot be told apart, and cannot have moved the window.
  const sig = (col ? col.key + sort.dir : "") + "|" + rows.length + "|" + (rows.length ? rowKey(rows[0]) + "|" + rowKey(rows[rows.length - 1]) : "");
  const [pg, setPg] = useState({ n: 0, sig: sig });
  // The stored page is dropped when the signature moves on. Without this, going back to an EARLIER signature (sorting a
  // column twice returns to the first order) would find the old page number still stored under it and revive it.
  useEffect(() => { setPg((p) => (p.sig === sig ? p : { n: 0, sig: sig })); }, [sig]);
  const w = pageWindow(list.length, pg.sig === sig ? pg.n : 0, size);
  const goPage = (n) => setPg({ n: n, sig: sig });
  const shown = list.slice(w.start, w.end);
  const pickSort = (c) => setSort((s) => (s && s.key === c.key ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: c.num ? "desc" : "asc" }));
  // "]" and "[" page while focus is in the table. PageUp and PageDown are NOT taken: they scroll, and a table that
  // swallowed them would break the way a long page is read.
  const pageKey = w.pages > 1 ? (e) => {
    if (e.key === "]" && w.page < w.pages - 1) { e.preventDefault(); goPage(w.page + 1); }
    else if (e.key === "[" && w.page > 0) { e.preventDefault(); goPage(w.page - 1); }
  } : null;
  const table = html`<table class="t dt" aria-label=${label || null} onKeyDown=${pageKey}>
    <thead><tr>${columns.map((c) => c.value
      ? html`<th key=${c.key} class=${(c.num ? "num " : "") + "sortable"} tabIndex="0" role="columnheader" scope="col"
          aria-sort=${sort && sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
          onClick=${() => pickSort(c)} onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickSort(c); } }}>${c.label}${sort && sort.key === c.key ? (sort.dir === "asc" ? " ▴" : " ▾") : ""}</th>`
      : html`<th key=${c.key} class=${c.num ? "num" : ""} scope="col">${c.label}</th>`)}</tr></thead>
    <tbody>${shown.map((r) => {
      const to = route ? route(r) : null;
      const run = !to && act ? act(r) : null;
      const live = !!((to && nav) || run);
      const go = () => { if (to && nav) nav(to); else if (run) run(); };
      const k = rowKey(r);
      const t = tip ? tip(r) : null;
      return html`<tr key=${k} class=${"dt-row " + (live ? "pick" : "inert") + (flashKey != null && flashKey === k ? " flash" : "") + (rowClass ? " " + (rowClass(r) || "") : "")}
          tabIndex="0" onClick=${live ? go : null}
          onKeyDown=${live ? (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(); } } : null}
          ...${tipProps(t || (live ? null : { title: "No action", lines: [ROW_NO_REASON] }))}>
        ${columns.map((c, i) => html`<td key=${c.key} class=${c.num ? "num" : ""}>${c.cell(r)}${i === 0 && flashKey != null && flashKey === k ? html` <span class="dt-flash" role="status">copied</span>` : null}</td>`)}
      </tr>`;
    })}</tbody>
  </table>`;
  if (w.pages <= 1) return table;
  return html`<div class="dtpaged">${table}
    <div class="pager" role="navigation" aria-label=${"pages of " + (label || "the table")} onKeyDown=${pageKey}>
      <button class="ghost" disabled=${w.page === 0} aria-label="previous page" onClick=${() => w.page > 0 && goPage(w.page - 1)}>← prev</button>
      <span role="status">showing ${w.from}–${w.to} of ${list.length}</span>
      <button class="ghost" disabled=${w.page >= w.pages - 1} aria-label="next page" onClick=${() => w.page < w.pages - 1 && goPage(w.page + 1)}>next →</button>
      <span class="dmeta">page ${w.page + 1} of ${w.pages} · "[" and "]" page while a row has focus</span>
    </div>
  </div>`;
}

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
    return html`<${ErrorBanner} what="evidence" st=${entry} note="— you can still give a verdict, but you will be judging without the diff." />`;
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
      ${/* Enter/Space select it like a click, but only when the ROW has focus: the checkbox inside keeps its own Space (DataTable uses the same target guard). */ ""}
      onKeyDown=${(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(e); } }}
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
    msg, reduced, markSeen, rendered, nav } = app;
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
  // Header refresh (App's refreshTick): re-read the split only while the chip that shows it is open;
  // a closed chip has not asked for it and reads fresh data the next time it is opened first.
  const refreshTick = app.refreshTick;
  useEffect(() => { if (refreshTick && chip === "never") baseline[1](); }, [refreshTick]);

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
  // A node header ticks every edge of its node and opens the bulk panel, and does nothing else. The verdict then
  // goes through judgeBulk like any selection: reason of 12+ characters, the intersection of allowed dispositions,
  // the 5 s hold, undo. There is deliberately no second write path (no node_id body from the UI).
  const tickNode = (n) => {
    setTicked((t) => { const nx = new Set(t); for (const r of n.rows) nx.add(r.edge_id); return nx; });
    setBulkOpen(true);
    setTimeout(() => { if (bulkRef.current && bulkRef.current.focus) bulkRef.current.focus(); }, 0);
  };
  // ?tick= (Unblock "settle together"): read once per distinct value, when the queue is there to compare with.
  // Ids not in the queue are listed, never dropped silently; a rejected value ticks nothing and says so.
  const [tickNote, setTickNote] = useState(null);
  const tickKey = route.tick ? (route.tick.rejected ? "!" : route.tick.ids.join(",")) : "";
  const tickDone = useRef("");
  useEffect(() => {
    if (!tickKey || !model || tickDone.current === tickKey) return;
    tickDone.current = tickKey;
    if (route.tick.rejected) { setTickNote({ rejected: true, missing: [], count: 0 }); return; }
    const p = preTick(route.tick.ids, model);
    setTickNote({ rejected: false, missing: p.missing, count: p.ticked.length });
    if (!p.ticked.length) return;
    setTicked((t) => { const nx = new Set(t); for (const id of p.ticked) nx.add(id); return nx; });
    const at = ["toJudge", "diverged", "parked"].find((k) => p.where.indexOf(k) >= 0);
    setChip(at === "toJudge" ? "judge" : at);
    setIdx(0);
  }, [tickKey, model]);
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
      return html`<div class="list"><${ErrorBanner} what="the queue could not be reconciled —" st=${{ error: inboxSt.data.fatal }} retry=${retryInbox} /></div><div class="detail"><div class="empty">Nothing is shown until the queue loads.</div></div>`;
    }
    return html`<div class="list"><${Skeleton} rows=${5} /></div><div class="detail"><${Skeleton} rows=${2} /></div>`;
  }

  const seenOk = seen.status === "ok";
  const isNew = (r) => seenOk && r.contentKey && !seen.set.has(r.contentKey);
  const unseenCount = flat.filter((r) => r.contentKey && !(seen.set && seen.set.has(r.contentKey))).length;
  const counts4 = { judge: scoped(model.toJudge).length, diverged: scoped(model.diverged).length, parked: scoped(model.parked).length, never: model.gapTotal };
  // One clearable control per active filter, like the state one beside it. The source's tooltip
  // carries the full path: the chip shows the file name only.
  // The filters ride in the hash (a reload restores them), so a clear that only touched local state
  // came back on reload. Clearing rewrites the hash without that one parameter and goes through nav, so
  // `route` (which the effect above re-reads) agrees with the address bar. The open chip is written into
  // the hash when it is not the default, or the effect would reset it to "To judge" when a filter remains.
  const dropFromHash = (k) => {
    const keep = chip === "judge" ? null : (chip === "diverged" ? "both" : chip);
    nav(hashWithout(location.hash, k, keep));
    setIdx(0);
  };
  const clearF = (k) => dropFromHash(k);
  const filterChips = [
    filters.ws ? { k: "ws", text: "only " + filters.ws, name: "workspace" } : null,
    filters.age ? { k: "age", text: "only waited " + ageWords(filters.age), name: "waiting time" } : null,
    filters.source ? { k: "source", text: "only " + baseName(filters.source), name: "source", full: filters.source } : null,
  ].filter(Boolean);

  const chipsBar = html`<div class="chips" role="group" aria-label="queue filter">
    ${CHIPS.map((c) => html`<button key=${c.key} class=${"chip" + (chip === c.key ? " on" : "")} aria-pressed=${chip === c.key ? "true" : "false"}
        onClick=${() => { setChip(c.key); setIdx(0); }}>${c.label} <b>${counts4[c.key] == null ? "" : counts4[c.key]}</b></button>`)}
    ${stateFilter && chip === "judge" ? html`<button class="chip on filt" aria-label=${"clear the " + stateFilter.toLowerCase() + " filter"}
        onClick=${() => dropFromHash("state")}>only ${stateFilter.toLowerCase()} <b>${rows.length}</b> ✕</button>` : null}
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
  const tickNoteEl = !tickNote ? null : tickNote.rejected
    ? html`<div class="note">The tick= link was not understood, so nothing was ticked. Tick rows with x, or open Judge from Unblock again.</div>`
    : tickNote.missing.length ? html`<div class="note">${plural(tickNote.count, "root")} ticked. ${plural(tickNote.missing.length, "root")} not in the queue (never verified, or already settled), so not ticked: ${tickNote.missing.join(", ")}.</div>` : null;
  const unplacedNote = model.includesUnplaced > 0 ? html`<div class="note">${plural(model.includesUnplaced, "edge")} in the count ${model.includesUnplaced === 1 ? "has" : "have"} no place in the fix order and cannot be listed here.</div>` : null;

  const divErr = chip === "parked" ? model.errors.parked : chip === "never" ? null : model.errors.worklist;
  let listBody;
  if (divErr) {
    listBody = html`<${ErrorBanner} what=${(chip === "parked" ? "parked" : "the worklist") + " could not be computed —"} st=${{ error: divErr }} retry=${retryInbox} />`;
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
        <div class="nhead act" role="button" tabIndex="0" aria-label=${"tick all " + plural(n.rows.length, "edge") + " of " + n.node_id + " for one verdict"}
          onClick=${() => tickNode(n)}
          onKeyDown=${(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); tickNode(n); } }}
          ...${tipProps(tipText("note", { title: "Decide this node together", text: "tick all " + plural(n.rows.length, "edge") + " of " + n.node_id + " for one verdict. Nothing is written until you pick a verdict and the 5 s hold ends" }))}>${n.node_id}${n.rows.length > 1 ? html` <span class="gn">${n.rows.length}</span>` : null}</div>
        ${n.rows.map((r) => {
          const i = flat.indexOf(r);
          return html`<${Row} key=${r.edge_id} r=${r} sel=${cur && cur.edge_id === r.edge_id} ticked=${ticked.has(r.edge_id)} isNew=${isNew(r)}
            onSelect=${() => setIdx(i)} onTick=${() => toggle(r.edge_id)} />`;
        })}
      </div>`)}
    </div>`)}</div>`;
  }

  return html`
    <div class="list">${chipsBar}${selectAllBar}${tickNoteEl}${seenNote}${unplacedNote}${listBody}</div>
    <div class="detail" key=${chip + ":" + (bulkOpen ? "bulk" : curId || "none")}>
      ${ticked.size && !bulkOpen ? html`<div class="bulkstrip"><b>${plural(ticked.size, "edge")} ticked.</b> <kbd>⇧J</kbd> gives them one verdict · <kbd>Esc</kbd> clears
        <button class="ghost" onClick=${() => setBulkOpen(true)}>give them one verdict</button></div>` : null}
      ${bulkOpen && ticked.size
        ? html`<${BulkPanel} rows=${tickedRows} allowed=${bulkAllowed} bulkReason=${bulkReason} onVerdict=${judgeBulk} onClear=${clear} inputRef=${bulkRef}
            pending=${pending} undo=${undo} reduced=${reduced} msg=${msg} />`
        : html`<${JudgeDetail} chip=${chip} cur=${cur} model=${model} entry=${evEntry} evSettled=${evSettled} reasons=${reasons} judgeOne=${judgeOne}
            baseline=${baseline[0]} pending=${pending} undo=${undo} reduced=${reduced} msg=${msg} evTick=${evTick} nav=${nav} />`}
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

function JudgeDetail({ chip, cur, model, entry, evSettled, reasons, judgeOne, baseline, pending, undo, reduced, msg, nav }) {
  if (chip === "never") return html`<${NeverVerified} model=${model} st=${baseline} nav=${nav} />`;
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

/**
 * The five never-verified buckets as bars, each one as clickable as the data allows. The inbox
 * carries a COUNT per bucket and not a row per edge (see the detail text), so only two buckets
 * lead anywhere: "examined and parked" are the Parked chip, and "baselineable now" is the one
 * with a command. The other three have no list behind them, and each says that in its tooltip
 * rather than being a bar that looks clickable and is not (Phase 1, 2026-10-16).
 */
const BASELINE_CMD = "propagate bootstrap --baseline-from-git";
function bucketBars(k, total) {
  const NO_LIST = "no list to open: the inbox carries a count for this bucket, not one row per edge";
  const rows = [
    { id: "baselineable", label: "baselineable now", value: k.baselineable, tone: "open", copy: BASELINE_CMD,
      hint: "click to copy: " + BASELINE_CMD + " (a dry run)" },
    { id: "noCoCommit", label: "no co-commit found", value: k.noCoCommit, tone: "open", hint: NO_LIST },
    { id: "boundReached", label: "walk bound reached", value: k.boundReached, tone: "open", hint: NO_LIST },
    { id: "ineligibleCrossRepo", label: "cross-repo, PERMANENT", value: k.ineligibleCrossRepo, tone: "permanent",
      hint: "structural: two independent histories cannot share a commit, so this never clears. " + NO_LIST },
    { id: "examinedAndDeferred", label: "examined and parked", value: k.examinedAndDeferred, tone: "open", route: "judge?chip=parked",
      hint: "click to open the Parked chip in Judge" },
  ];
  return rows.map((r) => Object.assign(r, { key: "b:" + r.id, total: total }));
}

function NeverVerified({ model, st, nav }) {
  const k = st && st.status === "ok" && st.data && st.data.buckets;
  const [copied, copy] = useCopyFlash();
  const bars = useMemo(() => (k ? bucketBars(k, model.gapTotal) : []), [k, model.gapTotal]);
  return html`<div>
    <h2 class="dtitle">${model.gapTotal == null ? "unknown" : model.gapTotal} never verified</h2>
    <div class="dmeta">Read-only here. The inbox carries the count and the baseline buckets, not one row per edge.</div>
    <div class="sec">Why the UI writes no baseline</div>
    <div class="reason">A baseline pins the current bytes of BOTH files as correct without anyone having read a diff. It is not a verdict, and a button that wrote one would be the cheapest way to close a backlog without judging it. Roots that block other work are listed in Unblock, each with its command.</div>
    <div class="sec">Where they stand</div>
    ${!st || st.status === "idle" || st.status === "loading" ? html`<${Skeleton} rows=${2} />`
      : st.status === "error" ? html`<${ErrorBanner} what="the baseline split could not be read —" st=${st} />`
      : st.data && st.data.error ? html`<${ErrorBanner} what="the baseline split could not be computed —" st=${{ error: st.data.error }} />`
      : html`<div>
          <${PlotChart} chart="buckets" data=${{ bars: bars }} bars=${bars} nav=${nav} copy=${(text, d) => copy(d.key, text)} />
          ${copied ? html`<div class="cov" role="status">copied: ${bars.find((b) => b.key === copied) ? bars.find((b) => b.key === copied).copy : ""}</div>` : null}
          <div class="caveat">${k.ineligibleCrossRepo} are cross-repo. Two independent histories cannot share a commit, so that slice is structural and will never clear. It is not a backlog.</div>
          ${st.data.accountedFor ? null : html`<${ErrorBanner} what="the buckets do not sum to the total —" st=${{ error: st.data.unaccounted + " unaccounted" }} />`}
        </div>`}
    <div class="sec">The bulk command</div>
    <${Cmd} text=${BASELINE_CMD} label="copy" />
    <div class="hint">A dry run. Add <b>--apply</b> to write; every applied write is a <b>baselined</b> event with its evidence.</div>
  </div>`;
}

/* -- Unblock -------------------------------------------------------------- */

/**
 * The three figures over the Unblock list, each with a destination or a stated reason it has
 * none (Phase 1, 2026-10-16). Unblock IS the page they describe, so "go to the Unblock page"
 * would be a no-op; each goes to the PART of it that answers the figure instead:
 *   blocked      -> the roots that free those edges (`focus=roots`), or the joint groups when no
 *                   single root frees anything alone. Why: a blocked edge cannot be judged, the
 *                   only thing a person can DO about one is settle what holds it back.
 *   roots        -> Judge, on the top root that is in the queue: the first root to settle. The
 *                   count of roots is only useful as "start here", and Judge is where it is settled.
 *                   Falls back to the root list when the top root was never verified (not judgeable).
 *   need several -> the "settle together" groups (`focus=together`): those edges are not freed by
 *                   one root, so that is the section that lists the sets to settle.
 * Judge has no "blocked" chip (it lists only edges that can be settled now), which is why blocked
 * does not go there. A figure of 0 has no list to open, so it is inert and says so.
 */
function unblockKpis(m) {
  const enc = encodeURIComponent;
  const top = m.ranked.find((r) => r.inQueue);
  const rootsRoute = m.ranked.length ? "unblock?focus=roots" : (m.byFile.length ? "unblock?focus=together" : null);
  const none = (what) => "no " + what + ", so there is nothing to open";
  return [
    { key: "blocked", label: "Blocked", value: m.blocked, sub: "edges waiting on an upstream edge",
      route: m.blocked > 0 ? rootsRoute : null,
      tip: m.blocked > 0 ? "edges held back until what they depend on is settled. Click to jump to the roots that free them" : none("blocked edge") },
    { key: "roots", label: "Roots", value: m.rootsTotal, sub: "unsettled edges that hold others back",
      route: m.rootsTotal > 0 ? (top ? "judge?edge=" + enc(top.edge_id) : rootsRoute) : null,
      tip: m.rootsTotal > 0 ? (top ? "edges that must be settled first. Click to judge the one that frees the most" : "edges that must be settled first. Click to jump to the list")
        : none("root") },
    { key: "several", label: "Need several", value: m.needAllRoots, sub: "blocked edges that need more than one root settled",
      route: m.needAllRoots > 0 && m.byFile.length ? "unblock?focus=together" : null,
      tip: m.needAllRoots > 0 ? "edges that no single root frees. Click to jump to the sets of roots to settle together" : none("edge that needs several roots") },
  ];
}

/** Columns for a list of roots. Two numbers, sortable, beside the edge and the one thing to do. */
function rootColumns(nav) {
  return [
    { key: "kind", label: "kind", cell: (r) => html`<span class=${"badge " + (r.inQueue ? "DRIFTED" : "NEVER_VERIFIED")}>${r.inQueue ? "root" : "NEVER VERIFIED"}</span>` },
    { key: "edge", label: "edge", value: (r) => (r.unknown ? r.edge_id : r.source + " → " + r.downstream),
      cell: (r) => html`<div class="itxt">
        <span class="ttl">${r.unknown ? r.edge_id : (r.source + " → " + r.downstream)}</span>
        <span class="meta">${r.edge_id}</span>
        ${r.inQueue || r.unknown ? null : html`<div class="note">Not in the queue: it has never been verified, and the UI does not write a baseline. Run it where you can read it first.</div>
          <${Cmd} text=${baselineCommand(r.edge_id)} label="copy command" />`}
      </div>` },
    { key: "frees", label: "frees now", num: true, value: (r) => (r.unknown ? null : r.freesNow), cell: (r) => (r.unknown ? "–" : r.freesNow) },
    { key: "up", label: "upstream of", num: true, value: (r) => (r.unknown ? null : r.upstreamOf), cell: (r) => (r.unknown || r.upstreamOf == null ? "–" : r.upstreamOf) },
    { key: "do", label: "", cell: (r) => (r.inQueue ? html`<button onClick=${(e) => { stop(e); nav("judge?edge=" + encodeURIComponent(r.edge_id)); }}>Judge root</button>` : null) },
  ];
}

/**
 * One list of roots. A root in the queue opens Judge on its edge; one that was never verified is
 * not judgeable here, so its row copies the baseline command instead; one the payload no longer
 * knows is inert, and its tooltip says so.
 */
function RootsTable({ roots, nav, label }) {
  const [copied, copy] = useCopyFlash();
  const columns = useMemo(() => rootColumns(nav), [nav]);
  return html`<${DataTable} columns=${columns} rows=${roots} rowKey=${(r) => r.edge_id} nav=${nav} label=${label} flashKey=${copied}
    route=${(r) => (r.inQueue ? "judge?edge=" + encodeURIComponent(r.edge_id) : null)}
    act=${(r) => (!r.inQueue && !r.unknown ? () => copy(r.edge_id, baselineCommand(r.edge_id)) : null)}
    tip=${(r) => tipText("root", r)} />`;
}

function UnblockView({ app, route }) {
  const { inboxSt, retryInbox, nav } = app;
  const top = useRef(null);
  // ?focus=roots|together: a KPI above the lists lands on the list that answers it. After render,
  // because the target exists only once the model has loaded; keyed on the route OBJECT, so a
  // second click on the same card scrolls again.
  useEffect(() => {
    if (!route || (route.focus !== "roots" && route.focus !== "together") || !top.current || typeof top.current.querySelector !== "function") return;
    const el = top.current.querySelector('[data-focus="' + route.focus + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "start" });
  }, [route, inboxSt.status]);
  if (inboxSt.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="the queue could not be read —" st=${inboxSt} retry=${retryInbox} /></div>`;
  const m = unblockModel(inboxSt.data);
  if (!m) {
    return html`<div class="detail wide">${inboxSt.data && inboxSt.data.fatal ? html`<${ErrorBanner} what="the queue could not be reconciled —" st=${{ error: inboxSt.data.fatal }} retry=${retryInbox} />` : html`<${Skeleton} rows=${4} />`}</div>`;
  }
  const wlErr = inboxSt.data && inboxSt.data.divisions && inboxSt.data.divisions.worklist && inboxSt.data.divisions.worklist.error;
  return html`<div class="detail wide" ref=${top}>
    <h2 class="dtitle">Unblock</h2>
    ${wlErr ? html`<${ErrorBanner} what="the worklist could not be computed —" st=${{ error: wlErr }} retry=${retryInbox} note="The figures below may be incomplete." />` : null}
    <div class="kpis">
      ${unblockKpis(m).map((k) => html`<${Kpi} key=${k.key} label=${k.label} value=${k.value} sub=${k.sub} route=${k.route} tip=${k.tip} nav=${nav} />`)}
    </div>
    ${m.blocked === 0 ? html`<div class="empty"><b>Nothing is blocked${m.checked == null ? "" : " (" + plural(m.checked, "edge") + " checked)"}.</b></div>` : html`<div>
      <div class="sec" data-focus="roots">Settle these first</div>
      ${m.ranked.length ? html`<${RootsTable} roots=${m.ranked} nav=${nav} label="roots that free blocked edges" />`
        : html`<div class="reason">No single root frees an edge on its own. Every blocked edge needs several roots settled together, below.</div>`}
      ${m.byFile.length ? html`<div class="sec" data-focus="together">Settle together</div>${m.byFile.map((g) => html`<div class="fgroup" key=${g.file}>
        <div class="fhead act" role="button" tabIndex="0" aria-label=${"open Judge with the " + plural(g.roots.length, "root") + " for " + g.file + " ticked"}
          onClick=${() => nav(settleTogetherRoute(g))}
          onKeyDown=${(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); nav(settleTogetherRoute(g)); } }}
          ...${tipProps(tipText("note", { title: "Settle these together", text: "opens Judge with the " + plural(g.roots.length, "root") + " ticked, ready for one verdict" + (g.roots.some((r) => !r.inQueue) ? ". Roots never verified are not in the queue: Judge lists them and ticks the rest" : "") + ". Nothing is written by opening it" }))}>${plural(g.blockedEdges, "blocked edge")} ${g.blockedEdges === 1 ? "flows" : "flow"} into ${g.files.map((f, i) => html`${i ? (i === g.files.length - 1 ? " and " : ", ") : ""}<b key=${f}>${f}</b>`)}; settle these roots together</div>
        <${RootsTable} roots=${g.roots} nav=${nav} label=${"roots to settle together for " + g.file} />
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
  if (action.kind === "link") return html`<div class="cmdrow" onClick=${stop} onKeyDown=${stop}><span class="meta">see ${action.target}</span><${Copy} text=${action.target} label="copy path" /></div>`;
  return html`<${Cmd} text=${action.target} label="copy path" />`;
}

const HEALTH_TAG = { fail: "FAIL", accepted: "ACCEPTED", warn: "WARN" };
/**
 * Health's two lists share these columns. A warn row has no "no action mapped" line: doctor maps a
 * next step for failures and accepted findings, and a warning that carries none is the normal
 * case, not a gap to flag on every row. (Its TOOLTIP still says so, so the row is never silent.)
 */
const HEALTH_COLUMNS = [
  { key: "tag", label: "status", cell: (e) => html`<span class=${"badge " + (e.tag === "warn" ? "none" : e.tag)}>${HEALTH_TAG[e.tag]}</span>` },
  { key: "check", label: "check", value: (e) => e.label, cell: (e) => html`<div class="itxt">
      <span class="ttl">${e.label}</span>
      <span class="meta">${dot(e.section, e.detail)}</span>
      ${e.tag === "warn" && !e.action ? null : html`<${ActionCell} action=${e.action} />`}
    </div>` },
];

/** One Health list. A row with a mapped next step copies it; a row without one is inert and its tooltip says so. */
function HealthTable({ rows, focus, label }) {
  const [copied, copy] = useCopyFlash();
  return html`<${DataTable} columns=${HEALTH_COLUMNS} rows=${rows} rowKey=${(e) => e._k} label=${label} flashKey=${copied}
    rowClass=${(e) => (inFocus(focus, e.section) && e.tag !== "warn" ? "focus" : "")}
    act=${(e) => (e.action ? () => copy(e._k, e.action.target) : null)}
    tip=${(e) => tipText("health", { label: e.label, section: e.section, tag: e.tag, action: e.action })} />`;
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
    return html`<div class="detail wide"><${ErrorBanner} what="doctor snapshot unreadable:" st=${{ error: data.reason || data.error || "no reason given" }} retry=${retry}
      note="— re-run doctor:" extra=${html`<${Cmd} text="propagate doctor" label="copy" />`} /></div>`;
  }
  const m = healthModel(data);
  const focused = focus ? (data.sections || []).filter((s) => inFocus(focus, s.name)) : [];
  const sum = (k) => focused.reduce((n, s) => n + (s[k] || 0), 0);
  const listed = m.rows.fail.map((e, i) => Object.assign({ tag: "fail", _k: "f" + i }, e))
    .concat(m.rows.accepted.map((e, i) => Object.assign({ tag: "accepted", _k: "a" + i }, e)));
  return html`<div class="detail wide" ref=${top}>
    <h2 class="dtitle">Health</h2>
    ${focus ? html`<div class="banner focus" role="status"><b>${focus.replace(/:$/, "")}</b> · ${focused.length
      ? dot(sum("fail") + " fail", sum("accepted") + " accepted", sum("warn") + " warn", sum("pass") + " pass") + (focused.length > 1 ? " across " + plural(focused.length, "section") : "")
      : "no doctor section by that name in this snapshot"}</div>` : null}
    <div class=${"hline" + (m.fail === 0 ? " okline" : "")}>${dot(
      m.fail + " fail", m.accepted + " accepted", m.warn + " warn in " + plural(m.warnSections, "section"), "snapshot " + ageLabel(m.ageMs))} ·
      <${Copy} text="propagate doctor" label="re-run doctor" /></div>
    ${listed.length === 0
      ? html`<div class="empty"><b>0 fail</b> · snapshot ${ageLabel(m.ageMs)}. Nothing failing and nothing accepted.</div>`
      : html`<${HealthTable} rows=${listed} focus=${focus} label="failing and accepted checks" />`}
    ${m.warnBySection.length ? html`<div class="sec">Warnings, by section</div>${m.warnBySection.map((s) => html`<details key=${s.name} class=${"wsec" + (inFocus(focus, s.name) ? " focus" : "")} open=${inFocus(focus, s.name)}>
      <summary>${s.name} <span class="gn">${s.entries.length}</span></summary>
      <${HealthTable} rows=${s.entries.map((e, i) => Object.assign({ tag: "warn", section: s.name, _k: "w:" + s.name + ":" + i }, e))} focus=${focus} label=${"warnings in " + s.name} />
    </details>`)}` : null}
  </div>`;
}

/* -- Charts: Observable Plot (vendored d3 + Plot), tokens for every colour. EVERY chart in the UI is one of these. ---- */

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
  // The single-series charts colour by a one-value categorical field rather than a literal fill:
  // Plot reads a string `fill` as a colour only when it parses as one, and a token that could not
  // be resolved is the text "var(--x)", which does not -- it would be taken for a FIELD NAME and
  // draw nothing. A scale with one entry has no such ambiguity.
  if (chart === "usage") {
    return P.plot({ style: style, width: width, height: Math.max(90, 28 * data.bars.length + 40), marginLeft: 90,
      color: { domain: ["runs"], range: [tok("--st-accent")] },
      y: { domain: data.bars.map((b) => b.command), label: null }, x: { label: "runs", grid: true },
      marks: [P.barX(data.bars, { x: "count", y: "command", fill: "tone", ariaLabel: keyOf }), P.ruleX([0])] });
  }
  if (chart === "runs") {
    const keep = axisLabels(data.days);
    return P.plot({ style: style, width: width, height: 150, color: { domain: ["runs"], range: [tok("--st-accent")] },
      x: { type: "band", domain: data.days, label: null, tickFormat: (d) => (keep.has(d) ? dayShort(d) : "") }, y: { label: "commands", grid: true },
      marks: [P.barY(data.bars, { x: "day", y: "count", fill: "tone", ariaLabel: keyOf }), P.ruleY([0])] });
  }
  if (chart === "buckets") {
    return P.plot({ style: style, width: width, height: 190, marginLeft: 150,
      color: { domain: ["open", "permanent"], range: [tok("--st-accent"), tok("--dim")] },
      y: { domain: data.bars.map((b) => b.label), label: null }, x: { label: "edges", grid: true },
      marks: [P.barX(data.bars, { x: "value", y: "label", fill: "tone", ariaLabel: keyOf }), P.ruleX([0])] });
  }
  const keep = axisLabels((data.days) || data.bars.map((d) => d.day).filter((d, i, a) => a.indexOf(d) === i));
  return P.plot({ style: style, width: width, height: 190,
    color: { domain: VERDICT_KINDS, range: [tok("--st-accent"), tok("--seg-quiet")], legend: true },
    x: { type: "band", label: null, tickFormat: (d) => (keep.has(d) ? String(d).slice(8) : "") }, y: { label: "verdicts", grid: true },
    marks: [P.barY(data.bars, { x: "day", y: "n", fill: "kind", ariaLabel: keyOf }), P.ruleY([0])] });
}

/** The days of an axis that carry a label: 30 labels would overlap into one smear (axisTicks picks which). */
function axisLabels(days) {
  const list = days || [];
  const keep = new Set();
  for (const i of axisTicks(list.length)) keep.add(list[i]);
  return keep;
}

/**
 * Make every drawn shape a click target with the page's own tooltip. Returns how many shapes it
 * matched, so the caller can say so when the answer is none (a chart that draws and answers
 * nothing is worse than one that says it cannot).
 */
const CHART_TIP = { queue: "qbar", wait: "wbar", verdicts: "vbar", usage: "command", runs: "runs", buckets: "bucket" };
function wireChart(node, chart, bars, nav, extra) {
  if (!node || typeof node.querySelectorAll !== "function") return 0;
  const byKey = new Map(bars.map((b) => [b.key, b]));
  const kind = CHART_TIP[chart] || "vbar";
  const from = extra && extra.from;
  let wired = 0;
  node.querySelectorAll("[aria-label]").forEach((el) => {
    const d = byKey.get(el.getAttribute("aria-label"));
    if (!d) return;
    wired += 1;
    const target = barTarget(chart, d, from);
    // `go` lets a tooltip name where a verdict bar leads (Judge on Activity, Activity elsewhere).
    const tip = tipText(kind, Object.assign({}, d, { go: target && target.route ? target.route : null }));
    if (el.style && target) el.style.cursor = "pointer";
    const at = (e) => tipShow(tip, e.clientX, e.clientY);
    el.addEventListener("mouseenter", at);
    el.addEventListener("mousemove", at);
    el.addEventListener("mouseleave", tipHide);
    el.addEventListener("click", () => {
      if (!target) return;
      if (target.route) nav(target.route);
      else if (extra && extra.copy) extra.copy(target.copy, d);
    });
  });
  return wired;
}

function PlotChart({ chart, data, bars, nav, from, copy }) {
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
      const wired = wireChart(node, chart, bars, nav, { from: from, copy: copy });
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

/** The top commands as bars: a click copies `propagate <command>`. */
function usageBars(u) {
  return ((u && u.top) || []).map((t) => ({ key: "u:" + t.command, command: t.command, count: t.count, total: u.total, tone: "runs" }));
}

/**
 * Commands per day. A day the store has NO reading for (count null) is a gap, not a zero: it is
 * left out of the bars and counted, so the chart never asserts a run count nobody measured -- the
 * property the old sparkline's broken path guarded, kept now that the line is bars.
 */
function runBars(u) {
  const days = ((u && u.days) || []).map((d) => d.day);
  const bars = [];
  let gaps = 0, max = 0;
  for (const d of (u && u.days) || []) {
    if (d.count == null) { gaps += 1; continue; }
    bars.push({ key: "r:" + d.day, day: d.day, count: d.count, tone: "runs" });
    if (d.count > max) max = d.count;
  }
  return { days: days, bars: bars, gaps: gaps, max: max };
}

/**
 * Verdicts per day -- the ONE verdict chart, used by the Overview and by Activity (it was drawn
 * twice by two implementations with two click targets). `from` says which page it sits on, and
 * with it where a bar leads (routeForBar). A velocity that is not readable says why instead of
 * drawing an empty axis: pending reads "loading…", failed reads "could not read — <reason>".
 */
function VerdictsChart({ velocity, nav, from, share }) {
  const bars = useMemo(() => verdictBars(velocity), [velocity]);
  const note = velocityNote(velocity);
  if (note) return html`<div class="reason">${note}</div>`;
  if (!velocity.events) return html`<div class="reason">No verdicts in ${velocity.windowDays} days (event store read).</div>`;
  return html`<div>
    <${PlotChart} chart="verdicts" data=${{ bars: bars }} bars=${bars} nav=${nav} from=${from} />
    ${share ? html`<div class="caveat">${pct(ratio(velocity.noChangeEvents, velocity.events))} of ${velocity.events} verdicts in ${velocity.windowDays} days recorded that nothing needed doing</div>` : null}
  </div>`;
}

function UsageBody({ u, nav }) {
  const [copied, copy] = useCopyFlash();
  const ok = !!(u && u.status === "ok");
  const ub = useMemo(() => (ok ? usageBars(u) : []), [u]);
  const rb = useMemo(() => (ok ? runBars(u) : { days: [], bars: [], gaps: 0, max: 0 }), [u]);
  if (!ok) {
    const why = (u && u.reason) || "the surface sent no usage";
    return html`<div class="reason">${u && u.status === "none-recorded" ? "None recorded: " + why : "could not read — " + why}</div>`;
  }
  return html`<div>
    <${PlotChart} chart="usage" data=${{ bars: ub }} bars=${ub} nav=${nav} copy=${(text, d) => copy(d.command, text)} />
    ${copied ? html`<div class="cov" role="status">copied: propagate ${copied}</div>` : null}
    <${PlotChart} chart="runs" data=${{ days: rb.days, bars: rb.bars }} bars=${rb.bars} nav=${nav} />
    <div class="cov">${dot("most in a day: " + rb.max, rb.gaps ? plural(rb.gaps, "day") + " with no run recorded" : null)}</div>
    <div class="cov">${dot(plural(u.total, "run") + " in " + u.windowDays + " days", u.failures ? plural(u.failures, "failure") : null, u.refusals ? plural(u.refusals, "refusal") : null, "origin " + u.origin)}</div>
  </div>`;
}

function ActivityView({ st, retry, nav }) {
  if (st.status === "idle" || st.status === "loading") {
    return html`<div class="detail wide"><div class="charts">${[0, 1].map((i) => html`<div class="chart" key=${i}><div class="skel"><i /><i /></div></div>`)}</div></div>`;
  }
  if (st.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="activity could not be read —" st=${st} retry=${retry} /></div>`;
  const s = st.data || {};
  return html`<div class="detail wide">
    <h2 class="dtitle">Activity</h2>
    <div class="charts">
      <${Chart} title="Verdicts per day" coverage="judgements recorded in the event store, per local day · click a bar to open Judge"><${VerdictsChart} velocity=${surfaceVelocity(st)} nav=${nav} from="activity" share=${true} /><//>
      <${Chart} title="Commands you ran" coverage="interactive runs only, from the runs store · click a command to copy it"><${UsageBody} u=${s.usage} nav=${nav} /><//>
    </div>
  </div>`;
}

/**
 * The Overview's next step (Phase 2). Built from the inbox's own leverage block, never recomputed:
 * `allRoots` arrives ordered by what a root frees alone (surface.mjs buildLeverage), so the first
 * one is the root that frees the most. Four outcomes, each with a sentence:
 *   judge     the top root is in the queue            -> Judge it
 *   baseline  the top root was never verified         -> the UI writes no baseline; copy the command
 *   together  blocked edges exist, no root frees any alone -> the settle-together groups
 *   clear     nothing blocked                         -> `bottleneckReason`, so the strip is never empty
 * Age is the root's own "last judged", read from the worklist row when the root is in the queue.
 */
function nextAction(inbox, now) {
  const lv = inbox && inbox.leverage;
  if (!lv) return { kind: "clear", title: "No next step to show", detail: "the queue sent no leverage data, so what is blocking what is not known", route: null };
  const roots = lv.allRoots || [];
  const top = roots[0];
  if (top && top.freesNow > 0) {
    const name = top.source + " → " + top.downstream;
    const frees = "frees " + plural(top.freesNow, "blocked edge") + " now";
    const w = inbox.divisions && inbox.divisions.worklist;
    const row = w ? (w.ready || []).concat(w.blocked || []).find((i) => i.edge_id === top.edge_id) : null;
    const days = row ? ageDaysOf(row, now) : null;
    const age = !top.inQueue ? null : (days == null ? "never judged" : "last judged " + days + " d ago");
    if (top.inQueue) return { kind: "judge", title: "Judge " + name, detail: [frees, age].filter(Boolean).join(" · "), edgeId: top.edge_id, route: "judge?edge=" + encodeURIComponent(top.edge_id), freesNow: top.freesNow };
    return { kind: "baseline", title: "Baseline " + name + " first", detail: frees + " · never verified, and the UI does not write a baseline", edgeId: top.edge_id, command: baselineCommand(top.edge_id), route: null, freesNow: top.freesNow };
  }
  if (lv.blocked > 0) {
    return { kind: "together", title: "Settle blocked edges together", detail: plural(lv.blocked, "blocked edge") + ", and no single root frees any of them alone" + (lv.bottleneckReason ? " (" + lv.bottleneckReason + ")" : ""), route: "unblock?focus=together" };
  }
  return { kind: "clear", title: "Nothing is blocked", detail: lv.bottleneckReason || "no edge is waiting on another, and the queue gave no reason", route: null };
}

function NextStrip({ action, nav }) {
  const [copied, copy] = useCopyFlash();
  const a = action;
  return html`<div class=${"nextstrip " + a.kind} ...${tipProps(tipText("note", { title: "Next step", text: a.kind === "clear" ? "Shown even when there is nothing to do, so an empty strip never reads as a failure to load" : "The root that frees the most blocked edges right now, from the queue's own leverage figures" }))}>
    <div class="ns-t"><span class="eyebrow">Next step</span><b>${a.title}</b><span class="ns-s">${a.detail}</span></div>
    <div class="ns-a">
      ${a.kind === "judge" ? html`<button onClick=${() => nav(a.route)}>Judge root</button>` : null}
      ${a.kind === "baseline" ? html`<button onClick=${() => copy("cmd", a.command)}>${copied === "cmd" ? "copied" : "Copy baseline command"}</button>` : null}
      ${a.kind === "together" ? html`<button onClick=${() => nav(a.route)}>See the groups</button>` : null}
      ${a.kind !== "clear" ? html`<button class="ghost" onClick=${() => nav("unblock")}>All roots</button>` : null}
    </div>
    ${a.kind === "baseline" ? html`<${Cmd} text=${a.command} label="copy command" />` : null}
  </div>`;
}

/**
 * The six machinery tiles. Every one opens its own page (Phase 4a: Claims, Rules, Caps, Skills; Phase 4b: Backlog and
 * Goals), and the tooltip says which. No tile is a dead end, and none copies a command any more.
 */
const MACH_TILES = [
  { key: "claims", title: "Claims", route: "claims", why: "Opens the Claims page, which lists every finding with its file and line" },
  { key: "rules", title: "Rules", route: "rules", why: "Opens the Rules page, which lists each rule with its status and where it is restated" },
  { key: "caps", title: "Caps", route: "caps", why: "Opens the Caps page, which lists the files over their size cap, worst first" },
  { key: "skills", title: "Skills", route: "skills", why: "Opens the Skills page, which lists every installed skill with its uses, never-invoked first" },
  { key: "backlog", title: "Backlog", route: "backlog", why: "Opens the Backlog page, which lists every open item, filterable by priority and kind" },
  { key: "goals", title: "Goals", route: "goals", why: "Opens the Goals and Plans page, which lists each goal with its status and how it is checked, and the plans beside them" },
];

function machineryTiles(st) {
  const rs = readState(st);
  const data = st && st.status === "ok" ? (st.data || {}) : null;
  return MACH_TILES.map((t) => {
    const goes = t.why + ".";
    const base = { key: t.key, label: t.title, route: t.route, warn: false };
    if (rs.kind === "loading") return { ...base, value: LOADING, sub: "reading " + t.key, route: null, tip: "Still reading this source; it opens once the figure lands. " + goes };
    if (rs.kind === "error") return { ...base, value: "could not read", sub: "could not read — " + rs.reason, warn: true, tip: "The machinery request failed: " + rs.reason + ". " + goes };
    const b = data && data[t.key];
    if (!b) return { ...base, value: "could not read", sub: "could not read — the server sent no " + t.key + " block", warn: true, tip: goes };
    if (b.status !== "ok") return { ...base, value: "could not read", sub: "could not read — " + (b.reason || "the source gave no reason"), warn: true, tip: "This source failed on its own; the others are fine. " + goes };
    const value = b.of != null ? b.count + " of " + b.of : String(b.count);
    return { ...base, value: value, sub: b.label + (b.top ? " · " + b.top : ""), tip: goes };
  });
}

function MachineryTiles({ st, nav }) {
  const tiles = machineryTiles(st);
  return html`<div>
    <div class="h2"><b>Machinery and work</b><span>what the tool checks about itself and the tree · each tile says where it goes</span></div>
    <div class="kpis mach">
      ${tiles.map((k) => html`<${Kpi} key=${k.key} cls="mt" label=${k.label} value=${k.value} sub=${k.sub} route=${k.route} warn=${k.warn} tip=${k.tip} nav=${nav} />`)}
    </div>
  </div>`;
}

const SRC_COLS = [
  { key: "source", label: "source", value: (g) => baseName(g.short).toLowerCase(),
    cell: (g) => html`<div><div class="nm">${baseName(g.short)}</div><div class="dr">${String(g.short).split("/").slice(0, -1).slice(-2).join("/")}</div></div>` },
  { key: "edges", label: "edges", num: true, value: (g) => g.edges, cell: (g) => html`<b>${g.edges}</b>` },
  { key: "mix", label: "what moved", cell: (g) => html`<${MixBar} g=${g} />` },
  { key: "blocked", label: "blocked", num: true, value: (g) => g.blocked, cell: (g) => g.blocked },
  { key: "oldest", label: "oldest", num: true, value: (g) => g.oldest, cell: (g) => (g.oldest < 0 ? "never" : g.oldest + " d") },
  { key: "ws", label: "workspace", value: (g) => String(g.ws).toLowerCase(), cell: (g) => g.ws },
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
  // A source whose edges are ALL blocked has nothing Judge can list (Judge shows only edges that
  // can be settled now), so its row opens Unblock, where its blockers are. Found on the live
  // render 2026-10-16: MEASUREMENT.md, 14 edges, all 14 blocked, opened an empty Judge.
  return html`<div>
    <div class="h2"><b>Sources with the most waiting edges</b><span>one source change can settle all its edges at once</span>
      <button class="ghost go" onClick=${() => nav("judge")}>all ${model.nSources} sources →</button></div>
    <${DataTable} columns=${SRC_COLS} rows=${model.top} rowKey=${(g) => g.source} initialSort=${{ key: "edges", dir: "desc" }} tie=${(g) => g.source}
      route=${sourceRoute} tip=${(g) => tipText("source", g)} nav=${nav} label="sources with the most waiting edges" />
  </div>`;
}

function OverviewView({ app, surfaceSt, healthSt, machSt, nav }) {
  const { inboxSt, retryInbox } = app;
  const now = Date.now();
  const model = useMemo(() => overviewModel(inboxSt.data, now), [inboxSt.data]);
  const charts = useMemo(() => (model && !model.error ? { queue: queueBars(model.rows), wait: waitBars(model.rows) } : null), [model]);
  if (inboxSt.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="the queue could not be read —" st=${inboxSt} retry=${retryInbox} /></div>`;
  if (!model) {
    if (inboxSt.data && inboxSt.data.fatal) return html`<div class="detail wide"><${ErrorBanner} what="the queue could not be reconciled —" st=${{ error: inboxSt.data.fatal }} retry=${retryInbox} /></div>`;
    return html`<div class="detail wide"><${Skeleton} rows=${4} /></div>`;
  }
  if (model.error) return html`<div class="detail wide"><${ErrorBanner} what="the worklist could not be computed —" st=${{ error: model.error }} retry=${retryInbox} /></div>`;
  // Pending and failed are different sentences (Phase 0): surfaceVelocity gives each its own status.
  const velocity = surfaceVelocity(surfaceSt);
  const kpis = overviewKpis(model, velocity, healthSt, now, inboxSt);
  const vSub = velocity.status === "ok" ? "last " + velocity.windowDays + " days · changed vs no change needed · click a bar for Activity" : velocityNote(velocity);
  return html`<div class="detail wide">
    <h2 class="dtitle">Overview</h2>
    <${NextStrip} action=${nextAction(inboxSt.data, now)} nav=${nav} />
    <div class="kpis ov">
      ${kpis.map((k) => html`<${Kpi} key=${k.key} label=${k.label} value=${k.text} sub=${k.sub} route=${k.route} tip=${k.tip} warn=${k.warn} nav=${nav} />`)}
    </div>
    ${/* Right under the KPIs, as in the approved mock (review artifact §4): the tree-wide figures are part of "where do I stand", not a footnote under the sources table. */""}
    <${MachineryTiles} st=${machSt} nav=${nav} />
    <div class="charts charts3">
      <${Chart} title="Queue by workspace" coverage="edges in the queue, by what moved · click a bar to judge it">
        <${PlotChart} chart="queue" data=${charts.queue} bars=${charts.queue.bars} nav=${nav} /><//>
      <${Chart} title="How long edges have waited" coverage="since each was last judged · click a bar for that age band">
        <${PlotChart} chart="wait" data=${{ bars: charts.wait }} bars=${charts.wait} nav=${nav} /><//>
      <${Chart} title="Verdicts per day" coverage=${vSub}>
        <${VerdictsChart} velocity=${velocity} nav=${nav} from="overview" /><//>
    </div>
    ${model.nSources ? html`<${SourcesTable} model=${model} nav=${nav} />` : html`<div class="empty"><b>Nothing waiting.</b> No source file has an edge in the queue.</div>`}
  </div>`;
}

/* -- Explore: registers, reminders, graph --------------------------------- */

/**
 * Where a register item lives, as a path a terminal or editor can open: `file:line`. /api/registers
 * sends the absolute `file` and the `line`; the shortened `short` is the fallback when a row has
 * no `file`. Null when there is nothing to locate, which makes the row inert.
 */
function registerLocator(r) {
  const where = r.file || r.short;
  if (!where) return null;
  return r.line ? where + ":" + r.line : where;
}

const REGISTER_COLUMNS = [
  { key: "priority", label: "priority",
    // 0 is a priority and the most urgent one; null/"" are no priority and sort last (sortRows).
    value: (r) => (typeof r.priority === "number" ? r.priority : (r.priority ? String(r.priority) : null)),
    // P0 is a priority, and it is the most urgent one: the old test was truthiness, so 0 fell through to the id and rendered as a dot.
    cell: (r) => html`<span class=${"badge " + (r.priority !== null && r.priority !== undefined && r.priority !== "" ? "open" : "none")}>${priorityLabel(r)}</span>` },
  { key: "item", label: "item", value: (r) => String(r.text || ""),
    cell: (r) => html`<div><div>${inlineMd(r.text).map((seg, j) => seg.k === "bold" ? html`<b key=${j}>${seg.s}</b>` : seg.k === "code" ? html`<code class="mono" key=${j}>${seg.s}</code>` : seg.s)}</div>${r.date ? html`<div class="dmeta">${r.date}</div>` : null}</div>` },
  { key: "where", label: "where", value: (r) => registerLocator(r), cell: (r) => html`<span class="mono">${dot(r.short, r.line ? "line " + r.line : null)}</span>` },
];

function RegisterList({ title, rows }) {
  const shown = (rows || []).slice(0, 50);
  const [copied, copy] = useCopyFlash();
  return html`<div class="rgroup">
    <div class="sec">${title} <span class="gn">${(rows || []).length}</span></div>
    ${!(rows || []).length ? html`<div class="reason">None open.</div>`
      : html`<${DataTable} columns=${REGISTER_COLUMNS} rows=${shown} rowKey=${(r) => r.kind + ":" + registerLocator(r) + ":" + r.text} label=${title} flashKey=${copied}
          act=${(r) => { const loc = registerLocator(r); return loc ? () => copy(r.kind + ":" + loc + ":" + r.text, loc) : null; }}
          tip=${(r) => tipText("register", r)} />`}
    ${(rows || []).length > shown.length ? html`<div class="trunc">showing the first ${shown.length} of ${rows.length}</div>` : null}
  </div>`;
}

/* REGISTERS IS SUPERSEDED BY BACKLOG, AND KEPT FOR NOW (Phase 4b, 2026-10-17). Backlog lists the same open items
   with a priority filter, a kind filter and paging, where this view shows the first 50 of each register. Registers
   keeps its rail entry and its rows (it also lists Handovers, which Backlog does not rank); its header sends the reader
   to Backlog with a plain link (an anchor, not a button: a test pins that this view has no button, so no write control can
   arrive unnoticed). Deleting it is a later, deliberate pass, not part of this one. */
function RegistersView({ st, retry }) {
  if (st.status === "idle" || st.status === "loading") return html`<div class="detail wide"><${Skeleton} rows=${4} /></div>`;
  if (st.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="registers could not be read —" st=${st} retry=${retry} /></div>`;
  const r = st.data || {};
  if (r.error) return html`<div class="detail wide"><${ErrorBanner} what="registers could not be computed —" st=${{ error: r.error }} retry=${retry} /></div>`;
  return html`<div class="detail wide">
    <h2 class="dtitle">Registers</h2>
    <div class="dmeta">Read-only. Opening or closing an item stays on the command line until the register write flow has its own design pass. Click a row to copy its file and line.</div>
    <div class="dmeta">Backlog lists every open item, not the first 50 of each register, and filters by priority and kind. <a class="go" href="#/backlog">open Backlog →</a></div>
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

/**
 * The best locator a held reminder has. /api/conflicts rows (lib/reminders/sync.mjs) carry NO
 * file:line: `registerPath` is set only when a register was found for the reminder's tag, and
 * even then it is a path, not a line (checked 2026-10-16 against every `rows.push` in
 * sync.mjs). So the row copies the register path when there is one, and the reminder's id
 * otherwise -- the one thing that names the reminder in the Reminders app. `kind` says which.
 */
function reminderLocator(r) {
  if (r.registerPath) return { kind: "register", text: r.registerPath };
  if (r.reminderId) return { kind: "reminder id", text: String(r.reminderId) };
  return null;
}

const REMINDER_COLUMNS = [
  { key: "disposition", label: "held because", value: (r) => r.disposition, cell: (r) => html`<span class=${"badge " + r.disposition}>${String(r.disposition).replace("held-", "")}</span>` },
  { key: "reminder", label: "reminder", value: (r) => (r.prId ? r.prId + " · " : "") + (r.project || r.tag || "untagged"),
    cell: (r) => html`<div>
      <div>${(r.prId ? r.prId + " · " : "") + (r.project || r.tag || "untagged")}</div>
      ${r.reason ? html`<div class="dmeta">${r.reason}</div>` : null}
    </div>` },
  { key: "where", label: "where", value: (r) => { const l = reminderLocator(r); return l ? l.text : null; },
    cell: (r) => { const l = reminderLocator(r); return html`<span class="mono">${l ? dot(l.kind, l.kind === "register" ? short(l.text) : l.text) : "no locator"}</span>`; } },
];

function ReminderGroup({ grp, rows }) {
  const [copied, copy] = useCopyFlash();
  return html`<div>
    <div class="sec">${grp.label} — ${grp.hint} · ${rows.length}</div>
    <${DataTable} columns=${REMINDER_COLUMNS} rows=${rows} rowKey=${(r) => r.reminderId} label=${grp.label} flashKey=${copied}
      rowClass=${() => (grp.key === "quiet" ? "quiet" : "")}
      act=${(r) => { const l = reminderLocator(r); return l ? () => copy(r.reminderId, l.text) : null; }}
      tip=${(r) => { const l = reminderLocator(r); return { title: (r.prId ? r.prId + " · " : "") + (r.project || r.tag || "untagged"),
        lines: [r.reason || r.disposition, l ? "click to copy the " + l.kind : "no register or id to copy"] }; }} />
  </div>`;
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
        ? html`<${ErrorBanner} st=${{ error: friendly }} retry=${retry} /><div class="dmeta">${why}</div>`
        : html`<${ErrorBanner} what="could not read the reminders list —" st=${{ error: why }} retry=${retry} />`}
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
      return html`<${ReminderGroup} key=${grp.key} grp=${grp} rows=${rows} />`;
    })}
  </div>`;
}

/**
 * The graph, fetched here rather than framed by URL. An iframe cannot report a
 * 500: the error page loads as a document and the pane looks "loaded". Fetching
 * first gives the failure a sentence and a retry, then srcdoc hands the page over.
 */
function GraphView({ tick }) {
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
  // The header's refresh bumps `tick`; 0 is the initial mount, which the effect above already ran for.
  useEffect(() => { if (tick) run(); }, [tick]);
  if (st.status === "loading") return html`<div class="detail wide"><div class="reason" aria-busy="true">rendering the graph — this runs <b>graph --html</b>, a few seconds…</div></div>`;
  if (st.status === "error") return html`<div class="detail wide"><${ErrorBanner} what="the graph could not be rendered —" st=${st} retry=${run} /></div>`;
  return html`<div class="detail wide"><iframe class="frame" srcdoc=${st.page} aria-label="dependency graph" /></div>`;
}

/* -- the four machinery pages (Phase 4a, 2026-10-17) --------------------------------------------------------------
   Each answers ONE question, is read-only, and is a DataTable over the rows /api/<name> sends. The rows come from the
   same computation as the Overview tile (lib/report/machinery.mjs), so the tile's figure is derived from these rows
   and the two cannot disagree. A source that failed is its reason in a banner, never an empty table; an empty table
   names what was examined. `*Rows` are the pure row models (no markup), so a test can feed them any payload. */

const NO_ROWS = [];
const arr = (x) => (Array.isArray(x) ? x : NO_ROWS);
const fmtDate = (ms) => (typeof ms === "number" && isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);

/** The shared frame: title, the question, loading, and a banner that carries the server's reason. */
function MachineryPage({ title, question, what, st, retry, children }) {
  const rs = readState(st);
  if (rs.kind === "loading") return html`<div class="detail wide"><h2 class="dtitle">${title}</h2><${Skeleton} rows=${4} /></div>`;
  if (rs.kind === "error") return html`<div class="detail wide"><h2 class="dtitle">${title}</h2>
    <${ErrorBanner} what=${what + " could not be read —"} st=${st} retry=${retry} />
    <div class="reason">This is not "nothing found". The source could not run, so nothing was examined and nothing can be reported.</div></div>`;
  const d = st.data || {};
  if (d.ok === false) return html`<div class="detail wide"><h2 class="dtitle">${title}</h2><${ErrorBanner} what=${what + " could not be read —"} st=${{ error: d.error }} retry=${retry} /></div>`;
  return html`<div class="detail wide"><h2 class="dtitle">${title}</h2>
    <div class="dmeta">${question} · read-only</div>
    ${children(d)}
  </div>`;
}

/* ---- Claims ---- */

/** `file:line` when the finding has a line, else the file alone (rotted citations and footers carry none). */
function claimLocator(r) {
  if (!r || !r.file) return null;
  return typeof r.line === "number" ? r.file + ":" + r.line : r.file;
}
function claimRows(d, kind) {
  const rows = arr(d && d.rows);
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}
/** The empty state names the population it examined (a bare "none found" is a panel that failed to load). */
function claimsEmpty(summary) {
  const s = summary || {};
  return "0 findings in " + (s.filesChecked || 0) + " files checked" + (s.sidecarsChecked ? " and " + s.sidecarsChecked + " sidecars" : "");
}
const CLAIM_COLUMNS = [
  { key: "kind", label: "kind", value: (r) => r.kindLabel || r.kind, cell: (r) => html`<span class=${"badge k-" + r.kind}>${r.kindLabel || r.kind}</span>` },
  { key: "file", label: "file", value: (r) => r.file, cell: (r) => html`<span class="mono">${short(r.file)}${typeof r.line === "number" ? ":" + r.line : ""}</span>` },
  { key: "message", label: "what it claims", value: (r) => r.message, cell: (r) => html`<div>${r.message}${r.historical ? html` <span class="dmeta">(reads as history)</span>` : null}</div>` },
];

function ClaimsView({ st, retry }) {
  const [kind, setKind] = useState(null);
  const [copied, copy] = useCopyFlash();
  return html`<${MachineryPage} title="Claims" question="Which claims in docs no longer match the code?" what="claims" st=${st} retry=${retry}>${(d) => {
    const s = d.summary || {};
    const all = claimRows(d);
    const shown = claimRows(d, kind);
    return html`<div>
      <div class="sec">${s.findings != null ? s.findings : all.length} findings · ${s.filesChecked || 0} files and ${s.sidecarsChecked || 0} sidecars checked${s.unreadable ? " · " + s.unreadable + " unreadable" : ""}${s.globsSkipped ? " · " + s.globsSkipped + " globs skipped" : ""}</div>
      ${all.length === 0 ? html`<div class="reason">${claimsEmpty(s)}</div>` : html`<div>
        <div class="chips" role="group" aria-label="filter by kind">
          <button class=${"chip" + (kind === null ? " on" : "")} onClick=${() => setKind(null)}>all<b>${all.length}</b></button>
          ${arr(d.kinds).map((k) => html`<button key=${k.kind} class=${"chip" + (kind === k.kind ? " on" : "")} onClick=${() => setKind(kind === k.kind ? null : k.kind)}>${k.label}<b>${k.count}</b></button>`)}
        </div>
        <${DataTable} columns=${CLAIM_COLUMNS} rows=${shown} rowKey=${(r) => r.id} initialSort=${{ key: "kind", dir: "asc" }} tie=${(r) => r.file + ":" + (r.line || 0)} label="claims that no longer match"
          flashKey=${copied}
          act=${(r) => { const l = claimLocator(r); return l ? () => copy(r.id, l) : null; }}
          tip=${(r) => { const l = claimLocator(r); return { title: r.kindLabel || r.kind, lines: [r.claim ? "claim: " + r.claim : null, r.message, l ? "click to copy " + l : "no file recorded for this finding"].filter(Boolean) }; }} />
      </div>`}
    </div>`;
  }}<//>`;
}

/* ---- Rules ---- */

const RULE_STATUS_RANK = { restated: 0, unexercised: 1, adopted: 2, firing: 3 };
function ruleRows(d) { return arr(d && d.rows); }
function ruleWhere(r) { return arr(r.restatedIn).map((x) => short(x.file) + (typeof x.line === "number" ? ":" + x.line : "")); }
const RULE_COLUMNS = [
  { key: "status", label: "status", value: (r) => (RULE_STATUS_RANK[r.status] != null ? RULE_STATUS_RANK[r.status] : 9), cell: (r) => html`<span class=${"badge r-" + r.status}>${r.status}</span>` },
  { key: "id", label: "rule", value: (r) => r.id, cell: (r) => html`<span class="nm">${r.id}</span>` },
  { key: "scope", label: "scope", value: (r) => r.scope || "", cell: (r) => r.scope || "unknown" },
  { key: "restated", label: "restated in", num: true, value: (r) => arr(r.restatedIn).length, cell: (r) => arr(r.restatedIn).length },
  { key: "referenced", label: "referenced", num: true, value: (r) => r.referenced, cell: (r) => r.referenced },
];
function RulesView({ st, retry }) {
  const [copied, copy] = useCopyFlash();
  return html`<${MachineryPage} title="Rules" question="Which canonical rules need attention?" what="rules" st=${st} retry=${retry}>${(d) => {
    const s = d.summary || {};
    const rows = ruleRows(d);
    return html`<div>
      <div class="sec">${s.rules != null ? s.rules : rows.length} rules · ${s.unexercised || 0} unexercised · ${s.restated || 0} restatements in ${s.restatedRules || 0} rules · ${s.adopted || 0} adopted · ${s.firing || 0} firing · ${s.filesScanned || 0} files scanned</div>
      ${rows.length === 0 ? html`<div class="reason">0 rules found in the rules directory, so none could be checked</div>` : html`
        <${DataTable} columns=${RULE_COLUMNS} rows=${rows} rowKey=${(r) => r.id} initialSort=${{ key: "status", dir: "asc" }} tie=${(r) => r.id} label="canonical rules" flashKey=${copied}
          act=${(r) => (r.file ? () => copy(r.id, r.file) : null)}
          tip=${(r) => { const w = ruleWhere(r); return { title: r.id, lines: [
            r.status === "restated" ? "restated in " + w.join(", ") : r.status === "unexercised" ? "no file matches its fingerprint and none cites rule:" + r.id : r.status === "adopted" ? "cited by " + r.referenced + " file(s); no restatement found" : "its fingerprint matches " + r.matched + " file(s)",
            arr(r.excusedIn).length ? arr(r.excusedIn).length + " more restatement(s) in files that also cite it" : null,
            r.file ? "click to copy " + r.file : "no rule file path recorded for this rule"].filter(Boolean) }; }} />`}
    </div>`;
  }}<//>`;
}

/* ---- Caps ---- */

function capRows(d) { return arr(d && d.rows); }
const CAP_COLUMNS = [
  { key: "status", label: "status", value: (r) => (r.status === "over" ? 0 : r.status === "yellow" ? 1 : 2), cell: (r) => html`<span class=${"badge c-" + r.status}>${r.status}</span>` },
  { key: "file", label: "file", value: (r) => r.file, cell: (r) => html`<span class="mono">${short(r.file)}</span>` },
  { key: "kind", label: "kind", value: (r) => (r.kind || "") + (r.scope || ""), cell: (r) => dot(r.kind, r.scope) },
  { key: "lines", label: "lines", num: true, value: (r) => r.actual, cell: (r) => (r.actual == null ? "n/a" : r.actual) },
  { key: "cap", label: "cap", num: true, value: (r) => r.cap, cell: (r) => (r.cap == null ? "none" : r.cap) },
  { key: "ratio", label: "of cap", num: true, value: (r) => r.ratio, cell: (r) => (r.ratio == null ? "n/a" : r.ratio.toFixed(1) + "x") },
];
function CapsView({ st, retry }) {
  const [copied, copy] = useCopyFlash();
  return html`<${MachineryPage} title="Caps" question="Which files are over their size cap?" what="caps" st=${st} retry=${retry}>${(d) => {
    const s = d.summary || {};
    const rows = capRows(d);
    return html`<div>
      <div class="sec">${s.measured || 0} measured · ${s.over || 0} over · ${s.yellow || 0} yellow (within reach of the cap) · ${s.exempt || 0} exempt</div>
      ${rows.length === 0 ? html`<div class="reason">0 files over or near a cap among ${s.measured || 0} measured</div>` : html`
        <${DataTable} columns=${CAP_COLUMNS} rows=${rows} rowKey=${(r) => r.id} initialSort=${{ key: "ratio", dir: "desc" }} tie=${(r) => r.file} label="files by size against their cap" flashKey=${copied}
          act=${(r) => (r.file ? () => copy(r.id, r.file) : null)}
          tip=${(r) => ({ title: baseName(r.file), lines: [
            r.status === "over" ? (r.actual - r.cap) + " " + (r.metric || "lines") + " over a cap of " + r.cap : r.status === "yellow" ? "within reach of its cap of " + r.cap : "exempt: no cap applies",
            r.file ? "click to copy " + r.file : "no path recorded"] })} />`}
    </div>`;
  }}<//>`;
}

/* ---- Skills ---- */

const SKILL_STATUS_RANK = { "never invoked": 0, dormant: 1, active: 2 };
function skillRows(d) { return arr(d && d.rows); }
const SKILL_COLUMNS = [
  { key: "status", label: "status", value: (r) => (SKILL_STATUS_RANK[r.status] != null ? SKILL_STATUS_RANK[r.status] : 9), cell: (r) => html`<span class=${"badge s-" + String(r.status).replace(/ /g, "-")}>${r.status}</span>` },
  { key: "id", label: "skill", value: (r) => r.id, cell: (r) => html`<span class="nm">${r.id}</span>` },
  { key: "provenance", label: "provenance", value: (r) => (r.provenance || r.installer || ""), cell: (r) => dot(r.installer, r.provenance) || "none recorded" },
  { key: "uses", label: "uses", num: true, value: (r) => r.uses, cell: (r) => r.uses },
  { key: "last", label: "last used", value: (r) => r.lastUsedAt, cell: (r) => fmtDate(r.lastUsedAt) || (r.status === "never invoked" ? "never" : "no date recorded") },
];
function SkillsView({ st, retry }) {
  const [copied, copy] = useCopyFlash();
  return html`<${MachineryPage} title="Skills" question="Which installed skills are dormant or never used?" what="skills" st=${st} retry=${retry}>${(d) => {
    const s = d.summary || {};
    const rows = skillRows(d);
    return html`<div>
      <div class="sec">${s.total != null ? s.total : rows.length} skills · ${s.neverInvoked || 0} never invoked · ${s.dormant || 0} dormant (last used over ${s.dormantDays || 0} days ago)</div>
      <div class="dmeta">"Never invoked" means ${s.neverInvokedMeans || "zero in skillUsage AND zero in transcripts"}: it is not seen in surviving transcripts, so a skill used only in a deleted session reads as never used.${s.transcriptProbe === false ? " The transcript probe was unavailable, so this rests on the usage counter alone." : ""}</div>
      ${rows.length === 0 ? html`<div class="reason">0 skills found in the skills directory</div>` : html`
        <${DataTable} columns=${SKILL_COLUMNS} rows=${rows} rowKey=${(r) => r.id} initialSort=${{ key: "status", dir: "asc" }} tie=${(r) => r.id} label="installed skills" flashKey=${copied}
          act=${(r) => (r.id ? () => copy(r.id, r.id) : null)}
          tip=${(r) => ({ title: r.id, lines: [
            r.status === "never invoked" ? "zero uses in the counter and zero in surviving transcripts" : r.status === "dormant" ? "last used " + (fmtDate(r.lastUsedAt) || "unknown") + ", over " + (s.dormantDays || 0) + " days ago" : r.uses + " use(s) in the counter, " + r.transcripts + " transcript(s)",
            "click to copy the skill name"] })} />`}
    </div>`;
  }}<//>`;
}


/* ---- Backlog (Phase 4b) ---- */

/** Characters of an item's text shown in its row; the full text is in the tooltip. A register line can run to several hundred. */
const BACKLOG_TEXT_CHARS = 110;
const BACKLOG_PRIORITIES = ["P0", "P1", "P2", "P3", "none"];
const priKey = (r) => (r.priority === null || r.priority === undefined ? "none" : "P" + r.priority);
const clipText = (t, n) => (String(t || "").length > n ? String(t).slice(0, n - 1) + "…" : String(t || ""));
function backlogLocator(r) {
  if (!r || !r.file) return null;
  return typeof r.line === "number" ? r.file + ":" + r.line : r.file;
}
/** Rows after the priority and kind chips. Both filters narrow the full population; neither pages. */
function backlogRows(d, pri, kind) {
  return arr(d && d.rows).filter((r) => (!pri || priKey(r) === pri) && (!kind || r.kind === kind));
}
function backlogEmpty(summary) {
  const s = summary || {};
  const f = s.filesRead || {};
  return "0 open items in " + ((f.state || 0) + (f.todo || 0) + (f.issue || 0)) + " register files read (" + (f.state || 0) + " STATE.md, " + (f.todo || 0) + " TODOS.md, " + (f.issue || 0) + " ISSUES.md)";
}
const BACKLOG_COLUMNS = [
  { key: "priority", label: "priority", value: (r) => r.priority, cell: (r) => html`<span class=${"badge pri-" + priKey(r)}>${r.priority === null || r.priority === undefined ? "none" : "P" + r.priority}</span>` },
  { key: "ref", label: "id", value: (r) => r.ref || "", cell: (r) => html`<span class="mono">${r.ref || ""}</span>` },
  { key: "text", label: "item", value: (r) => r.text, cell: (r) => html`<div>${clipText(r.text, BACKLOG_TEXT_CHARS)}</div>` },
  { key: "where", label: "file:line", value: (r) => r.file, cell: (r) => html`<span class="mono">${short(r.file)}${typeof r.line === "number" ? ":" + r.line : ""}</span>` },
  { key: "kind", label: "kind", value: (r) => r.kind, cell: (r) => r.kind },
];
function BacklogView({ st, retry }) {
  const [pri, setPri] = useState(null);
  const [kind, setKind] = useState(null);
  const [copied, copy] = useCopyFlash();
  return html`<${MachineryPage} title="Backlog" question="What open work is recorded, and what is unprioritised?" what="backlog" st=${st} retry=${retry}>${(d) => {
    const s = d.summary || {};
    const bp = s.byPriority || {};
    const all = arr(d.rows);
    const shown = backlogRows(d, pri, kind);
    return html`<div>
      <div class="sec">${s.items != null ? s.items : all.length} items in ${s.files || 0} files · ${BACKLOG_PRIORITIES.map((k) => k + " " + (bp[k] || 0)).join(" · ")}${s.mergedDuplicates ? " · " + s.mergedDuplicates + " duplicates merged" : ""}</div>
      ${s.caveat ? html`<div class="caveat">${s.caveat}</div>` : null}
      ${s.handovers && s.handovers.sections ? html`<div class="dmeta">${s.handovers.sections} handover sections (${s.handovers.open} open) are not ranked items and are not listed here; "propagate backlog" prints them.</div>` : null}
      ${s.delegatedRegisters ? html`<div class="dmeta">${s.delegatedRegisters} registers delegate to an external tracker; their open work is not counted here.</div>` : null}
      ${all.length === 0 ? html`<div class="reason">${backlogEmpty(s)}</div>` : html`<div>
        <div class="chips" role="group" aria-label="filter by priority">
          <button class=${"chip" + (pri === null ? " on" : "")} onClick=${() => setPri(null)}>any priority<b>${all.length}</b></button>
          ${BACKLOG_PRIORITIES.map((k) => html`<button key=${k} class=${"chip" + (pri === k ? " on" : "")} onClick=${() => setPri(pri === k ? null : k)}>${k}<b>${bp[k] || 0}</b></button>`)}
        </div>
        <div class="chips" role="group" aria-label="filter by kind">
          <button class=${"chip" + (kind === null ? " on" : "")} onClick=${() => setKind(null)}>any kind<b>${all.length}</b></button>
          ${arr(d.kinds).map((k) => html`<button key=${k.kind} class=${"chip" + (kind === k.kind ? " on" : "")} onClick=${() => setKind(kind === k.kind ? null : k.kind)}>${k.kind}<b>${k.count}</b></button>`)}
        </div>
        ${shown.length === 0 ? html`<div class="reason">No item matches ${[pri, kind].filter(Boolean).join(" + ")} among ${all.length}. <button class="ghost" onClick=${() => { setPri(null); setKind(null); }}>clear filters</button></div>` : html`
          <${DataTable} columns=${BACKLOG_COLUMNS} rows=${shown} rowKey=${(r) => r.id} initialSort=${{ key: "priority", dir: "asc" }} tie=${(r) => r.file + ":" + (r.line || 0)} label="open items" flashKey=${copied}
            act=${(r) => { const l = backlogLocator(r); return l ? () => copy(r.id, l) : null; }}
            tip=${(r) => { const l = backlogLocator(r); return { title: (r.ref ? r.ref + " · " : "") + (r.priority === null || r.priority === undefined ? "no priority" : "P" + r.priority), lines: [
              r.text, r.alsoIn ? "also recorded in " + r.alsoIn + " other register(s)" : null, l ? "click to copy " + l : "no file recorded for this item"].filter(Boolean) }; }} />`}
      </div>`}
    </div>`;
  }}<//>`;
}

/* ---- Goals and Plans (Phase 4b) ---- */

const GOAL_STATUS_RANK = { open: 0, unknown: 1, unreadable: 2, closed: 3 };
function goalRows(d) { return arr(d && d.rows); }
function planRows(d) { return arr(d && d.plans && d.plans.rows); }
/** What a goal says about how it is checked, in the CLI's own words. */
function goalDerivation(r) {
  if (r.status === "unreadable") return "not read";
  if (r.derivation === "claimed") return r.command ? String(r.command).split("\n")[0] : "a command is named";
  if (r.derivation === "waived") return "judgement";
  return "none - cannot be checked";
}
const GOAL_COLUMNS = [
  { key: "status", label: "status", value: (r) => (GOAL_STATUS_RANK[r.status] != null ? GOAL_STATUS_RANK[r.status] : 9), cell: (r) => html`<span class=${"badge g-" + r.status}>${r.status}</span>` },
  { key: "file", label: "file", value: (r) => r.file, cell: (r) => html`<span class="mono">${short(r.file)}</span>` },
  { key: "n", label: "#", num: true, value: (r) => r.n, cell: (r) => (r.n == null ? "" : r.n) },
  { key: "title", label: "goal", value: (r) => r.title || r.reason || "", cell: (r) => (r.status === "unreadable" ? html`<div class="dmeta">${r.reason}</div>` : html`<div>${r.title}</div>`) },
  { key: "how", label: "checked by", value: (r) => goalDerivation(r),
    cell: (r) => html`<div class="how">${r.command ? html`<code class="cmd">${clipText(goalDerivation(r), 70)}</code> <${Copy} text=${r.command} label="copy command" />` : goalDerivation(r)}</div>` },
];
const PLAN_STATUS_RANK = { undeclared: 0, unreadable: 1, linked: 2, finished: 3, archived: 4 };
const PLAN_COLUMNS = [
  { key: "status", label: "status", value: (r) => (PLAN_STATUS_RANK[r.status] != null ? PLAN_STATUS_RANK[r.status] : 9), cell: (r) => html`<span class=${"badge pl-" + r.status}>${r.status}</span>` },
  { key: "date", label: "date", value: (r) => r.date, cell: (r) => r.date || "date unknown" },
  { key: "file", label: "plan", value: (r) => r.file, cell: (r) => html`<span class="mono">${short(r.file)}</span>` },
  { key: "reason", label: "why", value: (r) => r.reason, cell: (r) => html`<div class="dmeta">${r.reason}</div>` },
];
function GoalsView({ st, retry }) {
  const [copied, copy] = useCopyFlash();
  const [pcopied, pcopy] = useCopyFlash();
  return html`<${MachineryPage} title="Goals & Plans" question="What are we building toward, and which plans are live?" what="goals" st=${st} retry=${retry}>${(d) => {
    const s = d.summary || {};
    const rows = goalRows(d);
    const p = d.plans || { ok: false, error: "the server sent no plans block" };
    const ps = p.summary || {};
    const prows = planRows(d);
    return html`<div>
      <div class="sec">Goals — ${s.goals != null ? s.goals : 0} in ${s.files || 0} files · ${s.open || 0} open · ${s.closed || 0} closed · ${s.unknown || 0} unknown${s.unreadable ? " · " + s.unreadable + " files unreadable" : ""}</div>
      <div class="dmeta">Checked by: ${s.claimed || 0} name a command · ${s.waived || 0} declare themselves judgement · ${s.uncheckable || 0} neither. This page never runs a command; copy one to run it yourself.</div>
      ${rows.length === 0 ? html`<div class="reason">0 goals in ${s.files || 0} GOALS.md files</div>` : html`
        <${DataTable} columns=${GOAL_COLUMNS} rows=${rows} rowKey=${(r) => r.id} initialSort=${{ key: "status", dir: "asc" }} tie=${(r) => r.file + ":" + (r.n || 0)} label="goals" flashKey=${copied}
          act=${(r) => (r.file ? () => copy(r.id, r.file) : null)}
          tip=${(r) => ({ title: r.status === "unreadable" ? "unreadable goals file" : "goal " + r.n, lines: [
            r.status === "unreadable" ? "this file was not read: " + r.reason : r.title,
            r.status === "unknown" ? "unknown = neither Done when nor Resolved is written, which is not the same as done" : null,
            r.command ? "checked by: " + r.command : null,
            r.file ? "click to copy " + r.file : "no file recorded"].filter(Boolean) })} />`}
      <div class="sec">Plans — ${p.ok ? (ps.plans || 0) + " plans under " + short(ps.root || "") + " (" + (ps.scanned || 0) + " markdown files scanned)" : "could not be read"}</div>
      ${!p.ok ? html`<${ErrorBanner} what="plans could not be read —" st=${{ error: p.error }} retry=${retry} />` : html`<div>
        <div class="dmeta">linked = cited directly by a hub seed · finished = its Status names a finished word · archived = it sits under archive/ · undeclared = none of those. Plans are read from this repo only.${ps.excluded ? " " + ps.excluded + " files under a plans/ directory were excluded by the classifier." : ""}</div>
        ${prows.length === 0 ? html`<div class="reason">0 plans among ${ps.scanned || 0} markdown files scanned under ${short(ps.root || "")}</div>` : html`
          <${DataTable} columns=${PLAN_COLUMNS} rows=${prows} rowKey=${(r) => r.id} initialSort=${{ key: "status", dir: "asc" }} tie=${(r) => r.file} label="plans" flashKey=${pcopied}
            act=${(r) => (r.file ? () => pcopy(r.id, r.file) : null)}
            tip=${(r) => ({ title: r.status, lines: [r.reason, r.statusPhrase ? "Status: " + r.statusPhrase : null, r.dateSource ? "date from " + r.dateSource : null, r.file ? "click to copy " + r.file : "no file recorded"].filter(Boolean) })} />`}
      </div>`}
    </div>`;
  }}<//>`;
}

/* ---- History (Phase 4b) ---- */

/** "2026-10-17 08:08 UTC" from an ISO stamp, or null when it is not one. */
function stamp(iso) {
  const t = Date.parse(iso);
  return typeof iso === "string" && isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null;
}
const secs = (ms) => (typeof ms === "number" && isFinite(ms) ? (ms >= 10000 ? Math.round(ms / 1000) + " s" : (ms / 1000).toFixed(1) + " s") : "n/a");
const HISTORY_ORDER = ["release", "monitor", "doctor"];
function historyParts(d) {
  const parts = arr(d && d.parts);
  return HISTORY_ORDER.map((k) => parts.find((p) => p.key === k)).filter(Boolean);
}
const DOCTOR_COLUMNS = [
  { key: "name", label: "section", value: (r) => r.name, cell: (r) => html`<span class="nm">${r.name}</span>` },
  { key: "fail", label: "fail", num: true, value: (r) => r.fail, cell: (r) => r.fail },
  { key: "warn", label: "warn", num: true, value: (r) => r.warn, cell: (r) => r.warn },
  { key: "accepted", label: "accepted", num: true, value: (r) => r.accepted, cell: (r) => r.accepted },
  { key: "pass", label: "pass", num: true, value: (r) => r.pass, cell: (r) => r.pass },
];
const MONITOR_COLUMNS = [
  { key: "at", label: "ran at", value: (r) => r.at, cell: (r) => html`<span class="mono">${stamp(r.at) || r.at}</span>` },
  { key: "result", label: "result", value: (r) => (r.error ? 0 : 1), cell: (r) => (r.error ? html`<span class="badge h-failed">could not look</span>` : "looked") },
  { key: "rows", label: "edges", num: true, value: (r) => r.rows, cell: (r) => r.rows },
  { key: "actionable", label: "actionable", num: true, value: (r) => r.actionable, cell: (r) => r.actionable },
  { key: "notified", label: "notified", num: true, value: (r) => r.notified, cell: (r) => r.notified },
  { key: "suppressed", label: "suppressed", num: true, value: (r) => r.suppressed, cell: (r) => r.suppressed },
  { key: "ms", label: "took", num: true, value: (r) => r.ms, cell: (r) => secs(r.ms) },
];
const RELEASE_COLUMNS = [
  { key: "at", label: "ran at", value: (r) => r.at, cell: (r) => html`<span class="mono">${stamp(r.at) || r.at}</span>` },
  { key: "outcome", label: "exit", value: (r) => (r.outcome === "ok" ? 1 : 0), cell: (r) => html`<span class=${"badge h-" + (r.outcome === "ok" ? "recorded" : "failed")}>${r.outcome === "ok" ? "exit 0" : "non-zero"}</span>` },
  { key: "ms", label: "took", num: true, value: (r) => r.ms, cell: (r) => secs(r.ms) },
  { key: "origin", label: "origin", value: (r) => r.origin || "", cell: (r) => r.origin || "not recorded" },
];

function HistoryPart({ part, retry, nav }) {
  const [copied, copy] = useCopyFlash();
  const when = stamp(part.at);
  const head = part.title + (part.status === "none" ? " — nothing recorded" : part.status === "error" ? " — could not be read" : when ? " — last recorded " + when : "");
  const rerun = html`<div class="dmeta">${part.status === "none" || part.status === "partial" ? "Run it yourself (this page never does): " : "Run it again yourself (this page never does): "}</div><${Cmd} text=${part.command} />`;
  return html`<div class="hpart" data-part=${part.key}>
    <div class="sec">${head}</div>
    ${part.status === "error" ? html`<${ErrorBanner} what=${part.title.toLowerCase() + " history could not be read —"} st=${{ error: part.reason }} retry=${retry} />` : null}
    ${part.status === "none" ? html`<div class="reason">${part.reason}</div>` : null}
    ${part.status === "failed" ? html`<div class="reason">The last doctor run failed: ${part.reason}${part.summary && part.summary.lastGoodAt ? " · last good run " + (stamp(part.summary.lastGoodAt) || part.summary.lastGoodAt) : " · there is no earlier good run"}</div>` : null}
    ${part.outcome && part.status !== "none" && part.status !== "error" ? html`<div class="hout">${part.outcome}</div>` : null}
    ${part.note ? html`<div class=${part.status === "partial" ? "caveat" : "dmeta"}>${part.note}</div>` : null}
    ${arr(part.rows).length ? (part.key === "doctor"
      ? html`<${DataTable} columns=${DOCTOR_COLUMNS} rows=${part.rows} rowKey=${(r) => r.id} initialSort=${{ key: "fail", dir: "desc" }} tie=${(r) => r.name} label="doctor sections"
          route=${(r) => "health?section=" + encodeURIComponent(r.name)} nav=${nav}
          tip=${(r) => ({ title: r.name, lines: [r.fail + " fail, " + r.warn + " warn, " + r.accepted + " accepted, " + r.pass + " pass", "click to open this section in Health"] })} />`
      : part.key === "monitor"
        ? html`<${DataTable} columns=${MONITOR_COLUMNS} rows=${part.rows} rowKey=${(r) => r.id} initialSort=${{ key: "at", dir: "desc" }} tie=${(r) => r.id} label="monitor runs" flashKey=${copied}
            act=${(r) => (r.raw ? () => copy(r.id, r.raw) : null)}
            tip=${(r) => ({ title: "monitor run", lines: [r.error ? "could not look: " + r.error : r.actionable + " of " + r.rows + " edges actionable, " + r.notified + " notified, " + r.suppressed + " already told", r.runId ? "run " + r.runId : null, r.raw ? "click to copy the log line" : "no log line recorded"].filter(Boolean) })} />`
        : html`<${DataTable} columns=${RELEASE_COLUMNS} rows=${part.rows} rowKey=${(r) => r.id} initialSort=${{ key: "at", dir: "desc" }} tie=${(r) => r.id} label="release runs"
            tip=${(r) => ({ title: "release run", lines: [r.outcome === "ok" ? "exited 0, which means READY" : "exited non-zero: BLOCKED, INCOMPLETE or a usage error; the ledger cannot say which", "which gate failed was not recorded"] })} />`) : null}
    ${part.summary && part.summary.runs ? html`<div class="dmeta">${part.summary.runs} runs recorded${part.summary.notifiedRuns != null ? ", " + part.summary.notifiedRuns + " that notified, " + (part.summary.couldNotLook || 0) + " that could not look" : ""}${part.summary.nonZero != null ? ", " + part.summary.nonZero + " exited non-zero" : ""} · showing the latest ${part.summary.shown}${part.summary.unparsedLines ? " · " + part.summary.unparsedLines + " log lines did not match the format" : ""}</div>` : null}
    ${rerun}
  </div>`;
}
function HistoryView({ st, retry, nav }) {
  return html`<${MachineryPage} title="History" question="What did the last release check, monitor pass and doctor run say?" what="history" st=${st} retry=${retry}>${(d) => {
    const s = d.summary || {};
    return html`<div>
      <div class="sec">${s.withARecord != null ? s.withARecord : 0} of ${s.of != null ? s.of : 3} have a recorded result</div>
      <div class="dmeta">Only recorded results are shown. This page never runs release, monitor or doctor; each section offers the command to copy.</div>
      ${historyParts(d).map((p) => html`<${HistoryPart} key=${p.key} part=${p} retry=${retry} nav=${nav} />`)}
    </div>`;
  }}<//>`;
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
  // `focus=` (Unblock, 2026-10-16) names the part of the page to scroll to; the view ignores a value it does not know.
  return { view: name === "" ? "overview" : (HASH_TO_VIEW[name] || "judge"), edge: get("edge"), section: get("section"), state: get("state"), chip: get("chip"), focus: get("focus"),
    tick: parseTick(get("tick")),
    ws: get("ws") || null, age: AGE_KEYS.indexOf(age) >= 0 ? age : null, source: get("source") || null };
}
function readHash() { return parseHash(location.hash); }

/**
 * The destination text for `nav` ("judge?ws=a&age=b") from a hash, minus the parameter `drop`, every
 * other parameter kept in its order. `chip`, when given, replaces any chip= already there (so the
 * open chip survives the rewrite). Pure so a test can feed it any hash.
 */
function hashWithout(hash, drop, chip) {
  const raw = (hash || "").slice(1).replace(/^[/]+/, "");
  const q = raw.indexOf("?");
  const name = q >= 0 ? raw.slice(0, q) : raw;
  const parts = (q >= 0 ? raw.slice(q + 1) : "").split("&").filter((x) => x && x.split("=")[0] !== drop && !(chip && x.split("=")[0] === "chip"));
  if (chip) parts.push("chip=" + encodeURIComponent(chip));
  return name + (parts.length ? "?" + parts.join("&") : "");
}

function App() {
  const [route, setRoute] = useState(readHash());
  const view = route.view;
  const [inboxSt, retryInbox] = useResource("/api/inbox", true);
  const firstLanded = inboxSt.status === "ok" || inboxSt.status === "error";
  const [surfaceSt, retrySurface] = useResource("/api/surface", firstLanded);
  // The machinery tiles wait for /api/surface to land: the server computes claims and skills in-process (over a
  // second each on a cold cache) and one thread answers one request at a time, so asking sooner would delay the KPIs.
  const surfaceLanded = surfaceSt.status === "ok" || surfaceSt.status === "error";
  const [machSt, retryMach] = useResource("/api/machinery", view === "overview" && surfaceLanded);
  // The Overview reads health only for its fail count, but it is the same resource: one fetch, shared.
  const [healthSt, retryHealth] = useResource("/api/health", view === "health" || view === "overview");
  const [regSt, retryReg] = useResource("/api/registers", view === "registers");
  // The four machinery pages (Phase 4a): each reads its own endpoint, lazily, from the cache the Overview tile uses.
  const [claimsSt, retryClaims] = useResource("/api/claims", view === "claims");
  const [rulesSt, retryRules] = useResource("/api/rules", view === "rules");
  const [capsSt, retryCaps] = useResource("/api/caps", view === "caps");
  const [skillsSt, retrySkills] = useResource("/api/skills", view === "skills");
  const [backlogSt, retryBacklog] = useResource("/api/backlog", view === "backlog");
  const [goalsSt, retryGoals] = useResource("/api/goals", view === "goals");
  const [historySt, retryHistory] = useResource("/api/history", view === "history");
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
  //
  // Two views own a read that is not App's: Judge's Never-verified chip (/api/baseline) and the Graph
  // (/graph). Their fetches live inside the view, so App cannot call a retry it does not hold. Least
  // invasive wiring: a counter that refresh bumps and the view watches in an effect, instead of
  // lifting those resources up here (which would fetch them on every view).
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = () => {
    setRefreshTick((t) => t + 1);
    retryInbox(); retrySurface();
    if (view === "health" || view === "overview") retryHealth();
    // ?fresh=1 recomputes past the server's 60 s cache, then the resource re-reads that fresh value:
    // refresh means new numbers, while ordinary page loads keep the cache.
    if (view === "overview" && surfaceLanded) api("/api/machinery?fresh=1").then(() => retryMach());
    if (view === "registers") retryReg();
    // Same rule as the tiles: refresh means new numbers, so the page bypasses the server's 60 s cache, then re-reads.
    const retryPage = { claims: retryClaims, rules: retryRules, caps: retryCaps, skills: retrySkills, backlog: retryBacklog, goals: retryGoals, history: retryHistory }[view];
    if (retryPage) api("/api/" + view + "?fresh=1").then(() => retryPage());
    if (view === "reminders") retryRem();
  };

  const model = useMemo(() => judgeModel(inboxSt.data, heldIds), [inboxSt.data, heldIds]);
  const app = { refreshTick, inboxSt, retryInbox, model, seen, ev, loadEvidence, evTick, reasons, bulkReason, hold, pending, undo, say, msg, reduced, markSeen, rendered, go, nav };

  const surfaceHealth = surfaceSt.status === "ok" && surfaceSt.data && surfaceSt.data.health && surfaceSt.data.health.ok
    ? surfaceSt.data.health.sections.reduce((a, s) => a + (s.fail || 0), 0) : null;
  const badge = (k) => (k === "judge" ? n.judge : k === "unblock" ? n.unblock : k === "health" ? surfaceHealth : null);

  let body;
  if (view === "overview") body = html`<${OverviewView} app=${app} surfaceSt=${surfaceSt} healthSt=${healthSt} machSt=${machSt} nav=${nav} />`;
  else if (view === "judge") body = html`<${JudgeView} app=${app} route=${route} />`;
  else if (view === "unblock") body = html`<${UnblockView} app=${app} route=${route} />`;
  else if (view === "health") body = html`<${HealthView} st=${healthSt} retry=${retryHealth} focus=${route.section} />`;
  else if (view === "activity") body = html`<${ActivityView} st=${surfaceSt} retry=${retrySurface} nav=${nav} />`;
  else if (view === "claims") body = html`<${ClaimsView} st=${claimsSt} retry=${retryClaims} />`;
  else if (view === "rules") body = html`<${RulesView} st=${rulesSt} retry=${retryRules} />`;
  else if (view === "caps") body = html`<${CapsView} st=${capsSt} retry=${retryCaps} />`;
  else if (view === "skills") body = html`<${SkillsView} st=${skillsSt} retry=${retrySkills} />`;
  else if (view === "backlog") body = html`<${BacklogView} st=${backlogSt} retry=${retryBacklog} />`;
  else if (view === "goals") body = html`<${GoalsView} st=${goalsSt} retry=${retryGoals} />`;
  else if (view === "history") body = html`<${HistoryView} st=${historySt} retry=${retryHistory} nav=${nav} />`;
  else if (view === "registers") body = html`<${RegistersView} st=${regSt} retry=${retryReg} />`;
  else if (view === "reminders") body = html`<${RemindersView} st=${remSt} retry=${retryRem} />`;
  else body = html`<${GraphView} tick=${refreshTick} />`;

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
        ${railGroups(DIVISIONS).map((g, gi) => html`
          ${gi > 0 ? html`<hr key=${"hr-" + g.key} />` : null}<div key=${"lbl-" + g.key} class="lbl">${g.label.toLowerCase()}</div>
          ${g.items.map((x) => html`<button key=${x.key} class=${"div" + (view === x.key ? " on" : "") + (x.act ? " act" : "")}
                  aria-current=${view === x.key ? "page" : null} onClick=${() => go(x.key)}>
            ${x.label}
            <span class=${"n" + (bumped === x.key ? " bump" : "")}>${badge(x.key) == null ? "" : badge(x.key)}</span>
          </button>`)}`)}
      </nav>
      ${body}
    </div>`;
}

/* A headless test can reach the pure helpers. There is no browser and no
 * bundler in this repo's suite, so without this the shaping logic -- grouping,
 * the gap-breaking path builder, the rail counts -- has no check at all. */
if (typeof globalThis !== "undefined") {
  globalThis.__ui = { sourceRoute, counts, KEYS, keyFor, DIVISIONS, UNDO_MS, readHash, disposeBody, judgeModel, groupRows, workspaceOf,
    intersectAllowed, pruneTicked, parseTick, preTick, settleTogetherRoute, unblockModel, healthModel, parkedAllowed, baselineCommand, gitDiffCommand, shellQuote, pct, ratio, dot, ageLabel,
    conflictGroup, groupConflicts, conflictsEmptyLine, CONFLICT_GROUPS, TOKEN_EXPIRED, HASH_TO_VIEW, RAIL_GROUPS, railGroups, request,
    parseHash, hashWithout, AGE_BUCKETS, AGE_KEYS, ageKey, ageDaysOf, judgeFilterRows, overviewModel, overviewKpis, sortSources, routeForKpi, routeForBar,
    queueBars, waitBars, verdictBars, buildPlot, wireChart, plotUnavailable, resolveToken, localDay,
    readState, surfaceVelocity, velocityNote, sortRows, unblockKpis, barTarget, bucketBars, usageBars, runBars, axisLabels, registerLocator, reminderLocator,
    KPI_NO_REASON, ROW_NO_REASON, Kpi, DataTable, nextAction, machineryTiles, MACH_TILES,
    claimLocator, claimRows, ruleRows, capRows, skillRows, claimsEmpty, SKILL_STATUS_RANK, RULE_STATUS_RANK,
    pageWindow, TABLE_PAGE_SIZE, backlogRows, backlogLocator, backlogEmpty, BACKLOG_TEXT_CHARS, goalRows, planRows, goalDerivation, stamp, historyParts,
    tipText, tipPlace, inlineMd, dayLabel, dayShort, axisTicks, priorityLabel, remindersTimeoutText, boundaryLabel, VERDICT_MEANING };
}

if (typeof document !== "undefined" && document.getElementById("app")) {
  render(html`<${App} />`, document.getElementById("app"));
}
