/* ui.client.js — the input surface's browser half.
 *
 * WHY THIS IS A FILE. It used to live inside page()'s template literal, where
 * every escape is consumed twice and one backtick kills the entire script. Four
 * dead-page bugs in a single session came from that (G65), and each was
 * invisible: HTTP 200 on every request, nothing in any log, the only evidence in
 * a console nothing reads.
 *
 * As a plain file there is nothing to escape, `node --check` can parse it
 * directly, and the page still inlines it at serve time — self-contained, no
 * build step, no second request.
 *
 * THE TOKEN IS NOT INTERPOLATED. It arrives on `<body data-token>`, so this file
 * contains no substitution point at all. A file with nothing interpolated into
 * it cannot be broken by interpolation.
 *
 * ── THE DESIGN ─────────────────────────────────────────────────────────────
 *
 * Two panes. The admin reads many and acts on few — 248 judgements are waiting —
 * so the list optimises for SCANNING and the detail carries the evidence and the
 * one form. The previous version rendered 200 rows each with its own
 * select+input+button, which optimises for acting on all of them.
 *
 * Evidence before judgement is the whole point: the review's #1 finding was that
 * the system demands a justification and offers nothing to justify from.
 */

const TOKEN = document.body.dataset.token;
const api = (p, o) => fetch(p + (p.indexOf("?") >= 0 ? "&" : "?") + "token=" + TOKEN, o).then((r) => r.json());
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const el = (id) => document.getElementById(id);

const VIEWS = ["queue", "issues", "todos"];
let VIEW = (location.hash || "#queue").slice(1).replace(/^[/]+/, "");
if (VIEWS.indexOf(VIEW) < 0) VIEW = "queue";

let DATA = { queue: null, issues: null, todos: null };
let ROWS = [];        // the filtered, flattened rows currently listed
let SEL = 0;          // index into ROWS
let FILTER = null;    // active chip
let Q = "";           // search text
let PLAN = null;      // the previewed edit awaiting confirmation

/* ── shaping ─────────────────────────────────────────────────────────────── */

/* Severity is a first-class fact, so it comes OUT of the text and becomes a
 * badge. Left inline it renders as literal asterisks -- `N10 ... - **S1**` --
 * which is how it has been shipping. */
function severityOf(raw) {
  const m = String(raw || "").match(/\*\*(S[0-4])\*\*/);
  return m ? m[1] : "none";
}
function cleanTitle(text) {
  return String(text || "")
    .replace(/\*\*(S[0-4])\*\*/g, "")
    .replace(/\*\*(OPEN|RESOLVED[^*]*|WITHDRAWN[^*]*|MOOT[^*]*)\*\*/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+[-—·]\s*$/, "")
    .trim();
}
function workspaceOf(file) {
  const m = String(file || "").split("/Documents/GitHub/")[1];
  return m ? m.split("/")[0] : "elsewhere";
}
function ageDays(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - Date.parse(ts)) / 86400000);
}

/* Each view groups on the axis its DATA actually varies along, which is not the
 * same axis for each. Measured: all 55 issues are propagate's, so grouping them
 * by workspace yields one group; 127 of 145 todos carry no priority, so grouping
 * those by priority yields one group plus noise. A symmetric design gets both
 * wrong. */
function shape(view) {
  if (view === "queue") {
    const items = (DATA.queue && DATA.queue.items) || [];
    return items.map((i) => ({
      kind: "edge",
      key: i.edge_id,
      group: i.state,
      badge: i.state,
      badgeClass: i.state,
      title: i.sourceShort + "  →  " + i.downstreamShort,
      meta: i.edge_id + (i.judgedCount ? "  ·  judged " + i.judgedCount + "×" : "  ·  never judged"),
      noisy: i.judgedCount > 0 && i.noiseRatio >= 0.5,
      raw: i,
    }));
  }
  const src = view === "issues" ? (DATA.issues && DATA.issues.issues) : (DATA.todos && DATA.todos.todos);
  return (src || []).map((i) => {
    const sev = severityOf(i.raw);
    return {
      kind: view === "issues" ? "issue" : "todo",
      key: i.file + ":" + i.line,
      group: view === "issues" ? sev : workspaceOf(i.file),
      badge: view === "issues" ? sev : (i.priority != null ? "P" + i.priority : "–"),
      badgeClass: view === "issues" ? sev : "none",
      title: cleanTitle(i.text),
      meta: i.short + ":" + i.line,
      raw: i,
    };
  });
}

const GROUP_ORDER = { S1: 0, S2: 1, S3: 2, S4: 3, none: 9, DRIFTED: 0, DIVERGED: 1, REVERSED: 2 };
function grouped(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.group)) by.set(r.group, []);
    by.get(r.group).push(r);
  }
  return [...by.entries()].sort((a, b) => {
    const ao = GROUP_ORDER[a[0]], bo = GROUP_ORDER[b[0]];
    if (ao != null || bo != null) return (ao == null ? 8 : ao) - (bo == null ? 8 : bo);
    return b[1].length - a[1].length;   // biggest group first when unranked
  });
}

function filtered(all) {
  let rows = all;
  if (FILTER) rows = rows.filter((r) => r.group === FILTER);
  if (Q) {
    const q = Q.toLowerCase();
    rows = rows.filter((r) => (r.title + " " + r.meta).toLowerCase().indexOf(q) >= 0);
  }
  return rows;
}

/* ── rendering ───────────────────────────────────────────────────────────── */

function renderChips(all) {
  const counts = new Map();
  for (const r of all) counts.set(r.group, (counts.get(r.group) || 0) + 1);
  const chips = grouped(all).map(([g]) =>
    '<button class="chip' + (FILTER === g ? " on" : "") + '" data-g="' + esc(g) + '">' +
    esc(g === "none" ? "unrated" : g) + '<span class="n">' + counts.get(g) + "</span></button>");
  el("chips").innerHTML = chips.join("");
}

function renderList() {
  const all = shape(VIEW);
  renderChips(all);
  ROWS = filtered(all);
  if (SEL >= ROWS.length) SEL = Math.max(0, ROWS.length - 1);

  const src = VIEW === "queue" ? DATA.queue : (VIEW === "issues" ? DATA.issues : DATA.todos);
  if (src && src.error) {
    el("list").innerHTML = '<div class="empty err">' + esc(src.error) + "</div>";
    el("detail").innerHTML = "";
    return;
  }
  if (!ROWS.length) {
    /* Say which question was asked. "Nothing here" and "nothing matched your
     * filter" are different facts and only one means there is no work. */
    el("list").innerHTML = '<div class="empty">' +
      (FILTER || Q ? "Nothing matches this filter." : "Nothing in this view.") + "</div>";
    el("detail").innerHTML = "";
    return;
  }

  /* ROWS IS REBUILT IN DISPLAY ORDER FIRST, then rendered from. Grouping
   * reorders rows relative to the filtered array, so an index into one is not an
   * index into the other -- and j/k, the click handler and SEL all index the
   * same list. The first version rendered first and then re-queried the DOM to
   * recover the order, which made the display the source of truth for its own
   * contents and could not be tested without a browser. */
  const groups = grouped(ROWS);
  ROWS = [];
  for (const [, rows] of groups) for (const r of rows) ROWS.push(r);
  if (SEL >= ROWS.length) SEL = Math.max(0, ROWS.length - 1);

  let html = "";
  let i = 0;
  for (const [g, rows] of groups) {
    html += '<div class="grp">' + esc(g === "none" ? "unrated" : g) + '<span class="n">' + rows.length + "</span></div>";
    for (const r of rows) {
      html += '<div class="item' + (i === SEL ? " sel" : "") + '" data-i="' + i + '">' +
        '<span class="badge ' + esc(r.badgeClass) + '">' + esc(r.badge) + "</span>" +
        '<span class="itxt"><span class="ttl">' + esc(r.title) + "</span>" +
        '<span class="meta">' + esc(r.meta) + (r.noisy ? ' <span class="warn">mostly no-op</span>' : "") + "</span></span></div>";
      i += 1;
    }
  }
  el("list").innerHTML = html;
  renderDetail();
}

function renderDetail() {
  const r = ROWS[SEL];
  if (!r) { el("detail").innerHTML = ""; return; }
  const i = r.raw;

  let head = '<h2 class="dtitle">' + esc(r.title) + "</h2>";
  if (r.kind === "edge") {
    const lv = i.lastVerified;
    const d = lv ? ageDays(lv.ts) : null;
    head += '<div class="dmeta">' + esc(i.edge_id) + "  ·  " + esc(i.state) +
      (lv ? "  ·  last judged " + esc(lv.commit.slice(0, 8)) + (d != null ? " (" + d + "d ago)" : "") : "  ·  never judged") +
      "</div>";
    if (i.why) head += '<div class="dmeta" style="margin-top:6px;color:var(--dim)">' + esc(i.why) + "</div>";
  } else {
    head += '<div class="dmeta">' + esc(i.file) + ":" + i.line + "</div>";
    if (i.noClose) head += '<div class="note">close not offered — ' + esc(i.noClose) + "</div>";
  }

  el("detail").innerHTML = head +
    '<div class="sec">Evidence</div><div id="ev"><div class="reason">loading…</div></div>' +
    '<div class="sec">Action</div><div id="action"></div>';

  loadEvidence(r);
  renderAction(r);
}

function diffHtml(text) {
  return '<div class="diff">' + text.split("\n").map((l) => {
    const c = l.charAt(0) === "+" ? "add" : l.charAt(0) === "-" ? "del" : l.slice(0, 2) === "@@" ? "at" : "hdr";
    return '<span class="' + c + '">' + esc(l) + "</span>";
  }).join("\n") + "</div>";
}

async function loadEvidence(r) {
  const body = r.kind === "edge"
    ? { kind: "edge", edge_id: r.raw.edge_id }
    : { kind: r.kind, file: r.raw.file, line: r.raw.line };
  let ev;
  try { ev = await api("/api/evidence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch (e) { ev = { ok: false, reason: String(e) }; }
  if (ROWS[SEL] !== r) return;   // the selection moved while this was in flight

  const box = el("ev");
  if (!box) return;
  /* A named reason and an empty panel must never look the same. An empty panel
   * asserts "nothing changed", which is exactly one of the five outcomes. */
  if (!ev.ok) { box.innerHTML = '<div class="reason">' + esc(ev.reason || "no evidence available") + "</div>"; return; }
  if (ev.empty) { box.innerHTML = '<div class="reason">' + esc(ev.reason) + "</div>"; return; }

  box.innerHTML = (ev.kind === "diff" ? diffHtml(ev.text) : '<div class="ev">' + esc(ev.text) + "</div>") +
    (ev.caveat ? '<div class="caveat">' + esc(ev.caveat) + "</div>" : "") +
    (ev.truncated ? '<div class="trunc">' + esc(ev.truncated) + "</div>" : "");
}

function renderAction(r) {
  const box = el("action");
  if (r.kind === "edge") {
    box.innerHTML = '<div class="act"><select id="disp">' +
      r.raw.allowed.map((a) => "<option>" + esc(a) + "</option>").join("") + "</select></div>" +
      '<textarea id="reason" placeholder="why this disposition is correct (required, 12+ characters)"></textarea>' +
      '<div class="act" style="margin-top:9px"><button id="go">record</button>' +
      '<span class="hint"><kbd>⌘</kbd><kbd>↵</kbd> record</span></div><div class="msg" id="msg"></div>';
    return;
  }
  const a = r.raw.actions || [];
  const opts = [];
  if (a.indexOf("issue-close") >= 0) opts.push('<option value="issue-close">close</option>');
  if (a.indexOf("issue-severity") >= 0) opts.push('<option value="issue-severity">change severity</option>');
  if (a.indexOf("todo-tick") >= 0) opts.push('<option value="todo-tick">tick done</option>');
  box.innerHTML = '<div class="act"><select id="disp">' + opts.join("") + "</select>" +
    '<select id="sev" style="display:none">' + ["S0", "S1", "S2", "S3", "S4"].map((s) => "<option>" + s + "</option>").join("") + "</select></div>" +
    '<textarea id="reason" placeholder="why (required, 12+ characters) — this text goes into the file"></textarea>' +
    '<div class="act" style="margin-top:9px"><button id="go">preview</button>' +
    '<span class="hint"><kbd>⌘</kbd><kbd>↵</kbd> preview</span></div><div class="msg" id="msg"></div>';
  syncSev();
}
function syncSev() {
  const d = el("disp"), s = el("sev");
  if (d && s) s.style.display = d.value === "issue-severity" ? "" : "none";
}

/* ── acting ──────────────────────────────────────────────────────────────── */

function planFor(r) {
  return {
    action: el("disp").value,
    file: r.raw.file,
    line: r.raw.line,
    current: r.raw.raw,
    reason: el("reason").value,
    severity: el("sev") ? el("sev").value : undefined,
  };
}

async function act() {
  const r = ROWS[SEL];
  if (!r) return;
  const msg = el("msg");
  const btn = el("go");

  if (r.kind === "edge") {
    btn.disabled = true; msg.className = "msg"; msg.textContent = "writing…";
    try {
      const res = await api("/api/dispose", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ edge_id: r.raw.edge_id, disposition: el("disp").value, reason: el("reason").value }) });
      if (res.ok) { msg.className = "msg ok"; msg.textContent = "recorded — event " + res.event_id; setTimeout(load, 650); }
      else { msg.className = "msg err"; msg.textContent = res.error; btn.disabled = false; }
    } catch (e) { msg.className = "msg err"; msg.textContent = String(e); btn.disabled = false; }
    return;
  }

  /* PREVIEW FIRST, ALWAYS. A one-click write into hand-written prose is exactly
   * the friction that should not be removed; you approve a hunk, not a promise. */
  if (!PLAN) {
    msg.className = "msg"; msg.textContent = "planning…";
    try {
      const body = planFor(r);
      const res = await api("/api/register-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { msg.className = "msg err"; msg.textContent = res.error; return; }
      PLAN = Object.assign({}, body, { next: res.next });
      msg.className = "msg";
      msg.innerHTML = diffHtml(res.diff) +
        '<div class="act" style="margin-top:9px"><button id="confirm">write this</button>' +
        '<button class="ghost" id="cancel">cancel</button>' +
        '<span class="hint"><kbd>⌘</kbd><kbd>⇧</kbd><kbd>↵</kbd> write</span></div>';
    } catch (e) { msg.className = "msg err"; msg.textContent = String(e); }
    return;
  }
  confirmWrite();
}

async function confirmWrite() {
  if (!PLAN) return;
  const msg = el("msg");
  try {
    const res = await api("/api/register-write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(PLAN) });
    if (res.ok) { msg.className = "msg ok"; msg.textContent = "written — " + res.file + ":" + res.line; PLAN = null; setTimeout(load, 650); }
    else { msg.className = "msg err"; msg.textContent = res.error; }
  } catch (e) { msg.className = "msg err"; msg.textContent = String(e); }
}

/* ── events ──────────────────────────────────────────────────────────────── */

document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.classList.contains("tab")) { setView(t.dataset.v); return; }
  if (t.classList.contains("chip")) { FILTER = FILTER === t.dataset.g ? null : t.dataset.g; SEL = 0; PLAN = null; renderList(); return; }
  if (t.id === "go") { act(); return; }
  if (t.id === "confirm") { confirmWrite(); return; }
  if (t.id === "cancel") { PLAN = null; el("msg").innerHTML = ""; return; }
  const item = t.closest && t.closest(".item");
  if (item) { SEL = Number(item.dataset.i); PLAN = null; renderList(); }
});
document.addEventListener("change", (e) => { if (e.target.id === "disp") { PLAN = null; syncSev(); } });
el("q").addEventListener("input", (e) => { Q = e.target.value; SEL = 0; PLAN = null; renderList(); });

/* KEYBOARD, because the task is repetitive -- 248 judgements are waiting. Every
 * shortcut also has a visible control; nothing is reachable ONLY by keyboard. */
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); e.shiftKey ? confirmWrite() : act(); return; }
  if (typing) {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
  else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (e.key === "Enter") { e.preventDefault(); const t = el("reason"); if (t) t.focus(); }
  else if (e.key === "/") { e.preventDefault(); el("q").focus(); }
  else if (e.key === "Escape") { if (FILTER || Q) { FILTER = null; Q = ""; el("q").value = ""; SEL = 0; renderList(); } }
});
function move(d) {
  if (!ROWS.length) return;
  SEL = Math.max(0, Math.min(ROWS.length - 1, SEL + d));
  PLAN = null;
  renderList();
  const n = el("list").querySelector(".item.sel");
  if (n) n.scrollIntoView({ block: "nearest" });
}

function setView(v) {
  VIEW = v; FILTER = null; Q = ""; SEL = 0; PLAN = null;
  el("q").value = "";
  location.hash = v;
  load();
}

/* ── loading ─────────────────────────────────────────────────────────────── */

function counts() {
  const q = DATA.queue && DATA.queue.items ? DATA.queue.items.length : null;
  const i = DATA.issues && DATA.issues.issues ? DATA.issues.issues.length : null;
  const t = DATA.todos && DATA.todos.todos ? DATA.todos.todos.length : null;
  const n = (x) => (x == null ? "" : '<span class="n">' + x + "</span>");
  el("nav").innerHTML = VIEWS.map((v) =>
    '<button class="tab' + (v === VIEW ? " on" : "") + '" data-v="' + v + '">' + v +
    n(v === "queue" ? q : v === "issues" ? i : t) + "</button>").join("");
}

async function load() {
  counts();
  try {
    if (VIEW === "queue") DATA.queue = await api("/api/queue");
    else if (!DATA.issues || VIEW === "todos") {
      const r = await api("/api/registers");
      DATA.issues = r; DATA.todos = r;
    }
    counts();
    const s = VIEW === "queue" ? DATA.queue : DATA.issues;
    el("sum").innerHTML = VIEW === "queue"
      ? "<b>" + DATA.queue.items.length + "</b> actionable of " + DATA.queue.expanded + " edges · <b>" + DATA.queue.declared + "</b> declared"
      : "<b>" + (s.counts ? s.counts.noAction : 0) + "</b> items had no action on their line";
    renderList();
  } catch (e) {
    el("sum").textContent = "failed to load: " + e;
    el("list").innerHTML = '<div class="empty err">' + esc(String(e)) + "</div>";
  }
}

/* A HEADLESS TEST CAN REACH THE PURE HELPERS. There is no browser in this
 * repo's test suite and no bundler, so without this the shaping logic --
 * severity extraction, grouping, filtering, title cleaning -- has no check at
 * all. It is a plain assignment on a global that a browser simply ignores. */
if (typeof globalThis !== "undefined") {
  globalThis.__ui = { shape, grouped, filtered, cleanTitle, severityOf, workspaceOf,
    setData: (d) => { DATA = d; }, setView: (v) => { VIEW = v; },
    setFilter: (f) => { FILTER = f; }, setQ: (q) => { Q = q; },
    rows: () => ROWS, sel: () => SEL };
}

load();
