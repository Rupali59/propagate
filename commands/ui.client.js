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
 * -- THE DESIGN ------------------------------------------------------------
 *
 * Five divisions, split by the item's relationship to a HUMAN rather than by
 * which file the data came from. The eight tabs this replaces were a taxonomy
 * of sources: nobody opens this thinking "I will do some handovers", they think
 * "what is blocked on me", and no tab answered that.
 *
 * READY is the only division with a write form, because cli.mjs refuses an
 * out-of-order edge with exit 3 -- offering every actionable edge the same form
 * walks a person into a refusal the page could have predicted.
 *
 * 47% of every judgement ever recorded was "nothing needed doing", and that was
 * the one step with no keyboard shortcut. It is now `n`.
 */

const { h, render } = preact;
const { useState, useEffect, useRef, useCallback, useMemo } = preactHooks;
const html = htm.bind(h);

const TOKEN = document.body.dataset.token;
const api = (p, o) =>
  fetch(p + (p.indexOf("?") >= 0 ? "&" : "?") + "token=" + TOKEN, o).then((r) => r.json());

/* -- divisions ------------------------------------------------------------ */

const DIVISIONS = [
  { key: "ready", label: "READY", act: true },
  { key: "blocked", label: "BLOCKED", act: true },
  { key: "parked", label: "PARKED", act: true },
  { key: "gap", label: "BASELINE GAP", act: true },
  { key: "analytics", label: "ANALYTICS" },
  { key: "stream", label: "CHANGED" },
  { key: "reference", label: "REFERENCE" },
  // Framed rather than dropped: lib/graph/graph-html.mjs renders a whole
  // interactive page at /graph, and open-ui.sh turns a widget route into a
  // hash — so a link to it only resolves if the client routes it. It used to
  // be written to disk and opened standalone, which made it a second place
  // with no way back.
  { key: "graph", label: "GRAPH" },
];
const VALID = new Set(DIVISIONS.map((d) => d.key));

/* Keys are offered from item.allowed so the UI can never propose a disposition
 * the write path will refuse. A control that always errors is worse than none. */
const KEYS = { n: "no-change-needed", p: "propagated", d: "deferred", r: "both-reconciled" };
const keyFor = (disp) => Object.keys(KEYS).find((k) => KEYS[k] === disp) || null;

const UNDO_MS = 5000;
const short = (p) => String(p || "").split("/Documents/GitHub/")[1] || p || "";
const pct = (x) => (x == null ? "unknown" : Math.round(x * 100) + "%");

/* -- shaping: pure, reachable from the headless tests --------------------- */

/**
 * READY collapses runs sharing a node_id AND a state into one expandable row.
 * Measured live: 57 edges produce 38 groups but only 6 hold more than one
 * member, so this puts SIX controls on screen rather than 38.
 *
 * Both keys matter. `verify --node --state` is the unit the write path accepts;
 * a node with mixed states cannot take one disposition, and offering it as a
 * batch would make a partial application expressible.
 */
function batched(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = r.node_id + " " + r.state;
    if (!groups.has(k)) groups.set(k, { key: k, node_id: r.node_id, state: r.state, members: [] });
    groups.get(k).members.push(r);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.members.length > 1) out.push({ kind: "batch", ...g, sort: g.members[0].orderIndex });
    else out.push({ kind: "edge", key: g.members[0].edge_id, row: g.members[0], sort: g.members[0].orderIndex });
  }
  // fixOrder's sequence, preserved. That ordering is the whole promise of
  // "start at the top"; re-sorting here would quietly break it.
  out.sort((a, b) => (a.sort == null ? Infinity : a.sort) - (b.sort == null ? Infinity : b.sort));
  return out;
}

/** Rail counts. Null means not loaded, which is not the same as zero. */
function counts(inbox) {
  if (!inbox || !inbox.divisions) return {};
  const d = inbox.divisions;
  return {
    ready: d.worklist.ready ? d.worklist.ready.length : null,
    blocked: d.worklist.blocked ? d.worklist.blocked.length : null,
    parked: d.parked.items ? d.parked.items.length : null,
    gap: d.gap.total,
  };
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
  const total = rows.reduce((n, r) => n + r.value, 0) || 1;
  return html`<div>
    ${rows.map((r) => html`
      <div key=${r.label} class="bar">
        <span class="bar-l">${r.label}</span>
        <span class="bar-t"><span class="bar-f" style=${{ width: (100 * r.value / total).toFixed(1) + "%", background: colorOf(r) }} /></span>
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

function Analytics({ data }) {
  if (!data) {
    return html`<div class="charts">${[0, 1, 2, 3].map((i) => html`
      <div class="chart" key=${i}><div class="skel"><i /><i /></div></div>`)}</div>`;
  }
  if (data.error) return html`<div class="banner">analytics failed to load — ${data.error}</div>`;
  const c = data.charts || {};
  const cov = data.coverage || {};
  const noop = c.dispositions && !c.dispositions.error
    ? c.dispositions.weeks.reduce((n, w) => n + (w.counts["no-change-needed"] || 0), 0)
    : 0;
  const ws = Object.entries((c.boundary && c.boundary.byWorkspace) || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map((e) => ({ label: e[0], value: e[1] }));

  return html`<div class="charts">
    ${c.backlog && !c.backlog.error ? html`
      <${Chart} title="Open rows over time"
        coverage=${c.backlog.coverage ? c.backlog.coverage.days + " days measured across a " + c.backlog.coverage.span + "-day span" : null}>
        <${Spark} points=${c.backlog.points} stroke="var(--st-accent)" label="open rows" />
      <//>` : null}

    ${c.scale && !c.scale.error && c.scale.series ? html`
      <${Chart} title="One hub, many projects" coverage="workspaces discovered against sidecars declared">
        ${c.scale.series.map((s, i) => html`
          <div key=${s.name}>
            <div class="cov">${s.name}</div>
            <${Spark} points=${s.points} stroke=${i ? "var(--edge-drift)" : "var(--st-ok)"} label=${s.name} />
          </div>`)}
      <//>` : null}

    ${c.boundary && !c.boundary.error ? html`
      <${Chart} title="Hub or workspace"
        coverage="a crossing edge is a contract that has not reached its instances">
        <${Bars} rows=${[
          { label: "touched the hub", value: c.boundary.hub },
          { label: "workspace-local", value: c.boundary.workspace },
        ]} colorOf=${(r) => (r.label === "touched the hub" ? "var(--st-accent)" : "var(--edge-drift)")} />
        ${c.boundary.note ? html`<div class="caveat">${c.boundary.note}</div>` : null}
      <//>` : null}

    ${ws.length ? html`
      <${Chart} title="Where the work is" coverage="judgements per workspace, top 8">
        <${Bars} rows=${ws} colorOf=${() => "var(--edge-reverse)"} />
      <//>` : null}

    ${c.dispositions && !c.dispositions.error ? html`
      <${Chart} title="What the answer was"
        coverage=${c.dispositions.total + " judgements across " + c.dispositions.weeks.length + " weeks"}>
        <${Bars} rows=${c.dispositions.kinds
          .map((k) => ({ label: k, value: c.dispositions.weeks.reduce((n, w) => n + w.counts[k], 0) }))
          .sort((a, b) => b.value - a.value)}
          colorOf=${(r) => (r.label === "no-change-needed" ? "var(--dim)" : "var(--st-ok)")} />
        <div class="caveat">${pct(noop / c.dispositions.total)} of every judgement recorded that nothing needed doing</div>
      <//>` : null}

    ${c.problems && !c.problems.error ? html`
      <${Chart} title="Doctor problems" coverage="lower is better">
        <${Spark} points=${c.problems.points} stroke="var(--st-warn)" label="doctor problems" />
      <//>` : null}

    <${Chart} title="What these events can support"
      coverage="stated, because a chart that hides its coverage claims a completeness it does not have">
      <${Bars} rows=${[
        { label: "carry a reason", value: cov.reason ? cov.reason.have : 0 },
        { label: "carry a commit", value: cov.observedAtCommit ? cov.observedAtCommit.have : 0 },
        { label: "events in total", value: cov.events || 0 },
      ]} colorOf=${() => "var(--st-accent)"} />
      <div class="caveat">
        observed_at_commit is present on ${pct(cov.observedAtCommit && cov.observedAtCommit.pct)} of events,
        so anything commit-derived is that far from complete.
      </div>
    <//>
  </div>`;
}

/* -- stream: "what changed since I last looked" --------------------------- */

/**
 * `sinceSource` -> a label a reader can trust. A 7-day default must never
 * read as "this is everything since you last looked"
 * (rule:discernment-checks §2, and lib/report/stream.mjs's own header).
 */
function sinceLabel(s) {
  if (s === "given") return "since the date you gave";
  if (s === "invalid-given-defaulted") return "the date you gave was invalid — showing the last 7 days instead";
  return "the last 7 days (no since given)";
}

/**
 * `downstream_on_ref`'s three-way vintage, kept distinguishable rather than
 * collapsed into one branch -- "absent" means the event predates
 * 2026-08-22, about two thirds of the store's history, and is a DIFFERENT
 * fact from "resolution ran and failed" (unresolved). See stream.mjs's
 * refVintage() and STATE.md's schema-vintage note.
 */
function vintageLabel(v) {
  if (!v || !v.status) return "unknown";
  if (v.status === "absent") return "pre-2026-08-22, no ref recorded";
  if (v.status === "unresolved") return "resolution failed";
  return "resolved";
}

function Stream({ data }) {
  if (!data) return html`<div class="reason">folding the event store for this window…</div>`;
  if (data.error) return html`<div class="banner">stream failed to load — ${data.error}</div>`;
  const s = data.summary || { total: 0, open: 0, closed: 0 };
  const changed = data.changed || [];
  return html`<div>
    <h2 class="dtitle">What changed</h2>
    <div class="dmeta">${sinceLabel(data.sinceSource)} · ${data.since} → ${data.generatedAt}</div>
    <div class="sec">${s.total} edge(s) changed — ${s.open} open, ${s.closed} closed</div>
    ${data.malformed ? html`<div class="caveat">${data.malformed} malformed line(s) in the store could not be read</div>` : null}
    ${!changed.length ? html`<div class="reason">nothing changed in this window</div>` : html`
      <div class="streamlist">
        ${changed.map((c) => html`
          <div key=${c.edge_id} class="sitem">
            <span class=${"badge " + (c.open ? "open" : "closed")}>${c.open ? "open" : "closed"}</span>
            <span class="itxt">
              <span class="ttl">${c.node_id || c.edge_id}</span>
              <span class="meta">${c.disposition || "unknown disposition"} · ${c.at || "no timestamp"}${c.by ? " · " + c.by : ""}</span>
              <span class=${"vin vin-" + ((c.downstreamOnRef && c.downstreamOnRef.status) || "unknown")}>${vintageLabel(c.downstreamOnRef)}</span>
              <span class="meta">${c.judgedCount == null ? "no prior history" : "judged " + c.judgedCount + "x"}${
                c.noiseRatio != null ? " · " + pct(c.noiseRatio) + " no-op" : ""}</span>
              ${c.reason ? html`<span class="meta">${c.reason}</span>` : null}
            </span>
          </div>`)}
      </div>`}
  </div>`;
}

/* -- the undo window ------------------------------------------------------ */

/**
 * The write is DELAYED, not compensated.
 *
 * The event store is append-only and DISPOSITIONS is frozen at eight, so there
 * is no "undone" event to write. Holding the write for five seconds buys a real
 * undo without either having to move. At most one is outstanding: a second
 * judgement flushes the first.
 */
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
    <span>${pending.disposition} — <b>${short(pending.label)}</b></span>
    ${/* The ring IS the clock, so when motion is off the number has to carry it. */ ""}
    <span class="secs">${reduced ? left + "s" : ""}</span>
    <button class="ghost" onClick=${onUndo}>undo <kbd>u</kbd></button>
  </div>`;
}

/**
 * The POST body for a pending judgement -- pulled out as its own pure
 * function so the two shapes /api/dispose accepts (batch vs single edge) are
 * directly testable without simulating a real click through the mini DOM.
 */
function disposeBody(p) {
  return p.kind === "batch"
    ? { node_id: p.node_id, state: p.state, disposition: p.disposition, reason: p.reason }
    : { edge_id: p.edge_id, disposition: p.disposition, reason: p.reason };
}

/* -- rows ----------------------------------------------------------------- */

const EdgeRow = ({ r, sel, onClick }) => html`
  <div class=${"item" + (sel ? " sel" : "")} onClick=${onClick} tabIndex="0">
    <span class=${"badge " + r.state}>${r.state.slice(0, 3)}</span>
    <span class="itxt">
      <span class="ttl">${r.sourceShort} → ${r.downstreamShort}</span>
      <span class="meta">${r.boundary} · ${r.judgedCount ? "judged " + r.judgedCount + "x" : "never judged"}${
        r.noiseRatio != null && r.noiseRatio >= 0.5 ? html` <span class="warn">mostly no-op</span>` : null}</span>
      ${r.blocked && r.blockedBy && r.blockedBy.length ? html`
        <span class="blockers">waiting on ${r.blockedBy.length}</span>` : null}
    </span>
  </div>`;

/* -- the app -------------------------------------------------------------- */

function readHash() {
  const v = (location.hash || "#ready").slice(1).replace(/^[/]+/, "");
  return VALID.has(v) ? v : "ready";
}

function App() {
  const [div, setDiv] = useState(readHash());
  const [inbox, setInbox] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [lazy, setLazy] = useState({});
  const [sel, setSel] = useState(0);
  const [pending, setPending] = useState(null);
  const [judged, setJudged] = useState(0);
  const [msg, setMsg] = useState(null);
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState({});
  const [bumped, setBumped] = useState(null);
  const flushRef = useRef(null);

  const reduced = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const load = useCallback(async () => {
    const j = await api("/api/inbox");
    if (j.fatal) { setFatal(j.fatal); return; }
    setFatal(null);
    setInbox((prev) => {
      const before = counts(prev);
      const after = counts(j);
      const changed = Object.keys(after).find((k) => before[k] != null && before[k] !== after[k]);
      if (changed) { setBumped(changed); setTimeout(() => setBumped(null), 400); }
      return j;
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onHash = () => { setDiv(readHash()); setSel(0); };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // Lazy divisions: measured 300 ms, 1704 ms and 28 ms (stream unmeasured on
  // this machine, but it is a single in-process fold, same shape as
  // analytics). Fetched when opened, never on first paint -- that is what
  // keeps the page near 340 ms.
  useEffect(() => {
    const ep = { reference: "/api/reference", gap: "/api/baseline", analytics: "/api/analytics", stream: "/api/stream" }[div];
    if (!ep || lazy[div]) return;
    api(ep).then((j) => setLazy((L) => Object.assign({}, L, { [div]: j })));
  }, [div, lazy]);

  const flush = useCallback(async (p) => {
    if (!p) return;
    clearTimeout(p.timer);
    flushRef.current = null;
    setPending(null);
    const res = await api("/api/dispose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(disposeBody(p)),
    }).catch((e) => ({ ok: false, error: String(e) }));
    if (res.ok) {
      setJudged((n) => n + (res.results ? res.results.length : 1));
      setMsg({ ok: true, text: res.results
        ? "recorded — " + res.results.length + " event(s)"
        : "recorded — event " + res.event_id });
      load();
    } else if (res.results) {
      // A batch can fail PARTIALLY even after the group passed the uniform-
      // state gate (the two reconciles are seconds apart) -- name which
      // members failed rather than one opaque error, so the failure is
      // legible by edge_id the same way the server's response already is.
      const failed = res.results.filter((r) => !r.ok);
      setMsg({ ok: false, text: failed.length + " of " + res.results.length + " refused — " +
        failed.map((r) => r.edge_id + ": " + r.error).join("; ") });
      load();
    } else {
      setMsg({ ok: false, text: res.error });
    }
  }, [load]);

  const judge = useCallback((row, disposition) => {
    if (String(reason).trim().length < 12) {
      setMsg({ ok: false, text: "a reason of 12 or more characters is required — it lands in the ledger" });
      return;
    }
    if (flushRef.current) flush(flushRef.current);   // at most one outstanding
    const p = {
      id: String(Date.now()) + row.edge_id,
      kind: "edge",
      edge_id: row.edge_id,
      disposition: disposition,
      reason: String(reason).trim(),
      label: row.source,
    };
    p.timer = setTimeout(() => flush(p), UNDO_MS);
    flushRef.current = p;
    setPending(p);
    setReason("");
    setMsg(null);
  }, [reason, flush]);

  /** Same shape as `judge`, for a batch row: one disposition applied to
   * every member sharing (node_id, state) -- see the DIVISIONS/batched()
   * header comment for why that pair, not just node_id, is the unit. */
  const judgeBatch = useCallback((group, disposition) => {
    if (String(reason).trim().length < 12) {
      setMsg({ ok: false, text: "a reason of 12 or more characters is required — it lands in the ledger" });
      return;
    }
    if (flushRef.current) flush(flushRef.current);
    const p = {
      id: String(Date.now()) + group.key,
      kind: "batch",
      node_id: group.node_id,
      state: group.state,
      disposition: disposition,
      reason: String(reason).trim(),
      label: group.node_id,
    };
    p.timer = setTimeout(() => flush(p), UNDO_MS);
    flushRef.current = p;
    setPending(p);
    setReason("");
    setMsg(null);
  }, [reason, flush]);

  const undo = useCallback(() => {
    const p = flushRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    flushRef.current = null;
    setPending(null);
    setMsg({ ok: true, text: "undone — nothing was written" });
  }, []);

  // Leaving with a write pending must not lose it. A lost write and a silent
  // write are both worse than an early one.
  useEffect(() => {
    const go = () => { if (flushRef.current) flush(flushRef.current); };
    addEventListener("beforeunload", go);
    return () => removeEventListener("beforeunload", go);
  }, [flush]);

  const d = inbox && inbox.divisions;
  const rows = useMemo(() => {
    if (!d) return [];
    if (div === "ready") return batched(d.worklist.ready || []);
    if (div === "blocked") return (d.worklist.blocked || []).map((r) => ({ kind: "edge", key: r.edge_id, row: r }));
    if (div === "parked") return (d.parked.items || []).map((r) => ({ kind: "parked", key: r.edge_id, row: r }));
    return [];
  }, [d, div]);

  const flat = useMemo(
    () => rows.flatMap((g) => (g.kind === "batch" && open[g.key]
      ? [g].concat(g.members.map((m) => ({ kind: "edge", key: m.edge_id, row: m })))
      : [g])),
    [rows, open],
  );
  const current = flat[sel];

  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (typing) { if (e.key === "Escape") document.activeElement.blur(); return; }
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(flat.length - 1, s + 1)); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
      else if (e.key === "u") { e.preventDefault(); undo(); }
      else if (KEYS[e.key] && div === "ready" && current && current.kind === "edge") {
        const allowed = current.row.allowed || [];
        if (allowed.indexOf(KEYS[e.key]) < 0) {
          setMsg({ ok: false, text: KEYS[e.key] + " is not allowed for a " + current.row.state + " edge" });
          return;
        }
        e.preventDefault();
        judge(current.row, KEYS[e.key]);
      }
      // Same control, for the collapsed batch row -- members share `allowed`
      // because they share a state, so member[0]'s is representative of all.
      else if (KEYS[e.key] && div === "ready" && current && current.kind === "batch") {
        const allowed = (current.members[0] && current.members[0].allowed) || [];
        if (allowed.indexOf(KEYS[e.key]) < 0) {
          setMsg({ ok: false, text: KEYS[e.key] + " is not allowed for a " + current.state + " batch" });
          return;
        }
        e.preventDefault();
        judgeBatch(current, KEYS[e.key]);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [flat, div, current, judge, judgeBatch, undo]);

  const go = (k) => { location.hash = k; setDiv(k); setSel(0); };
  const n = counts(inbox);

  return html`
    <header>
      <h1>propagate</h1>
      <div class="sum">${inbox
        ? html`<b>${inbox.declared}</b> declared · <b>${inbox.expanded}</b> expanded`
        : "loading…"}</div>
      <div class="session">${judged ? html`<b>${judged}</b> judged this session` : ""}</div>
    </header>

    <div class="shell">
      <nav class="rail" aria-label="divisions">
        ${DIVISIONS.map((x, i) => html`
          ${i === 4 ? html`<hr /><div class="lbl">reference</div>` : null}
          <button key=${x.key} class=${"div" + (div === x.key ? " on" : "") + (x.act ? " act" : "")}
                  onClick=${() => go(x.key)}>
            ${x.label}
            <span class=${"n" + (bumped === x.key ? " bump" : "")}>${n[x.key] == null ? "" : n[x.key]}</span>
          </button>`)}
      </nav>

      <div class="list">
        ${fatal ? html`<div class="banner">${fatal}</div>`
          : !inbox ? [0, 1, 2].map((i) => html`<div class="skel" key=${i}><i /><i /></div>`)
          : html`<${ListPane} div=${div} flat=${flat} sel=${sel} setSel=${setSel} d=${d}
                    open=${open} setOpen=${setOpen} />`}
      </div>

      <div class="detail" key=${div}>
        <${DetailPane} div=${div} current=${current} d=${d} lazy=${lazy}
          reason=${reason} setReason=${setReason} judge=${judge} judgeBatch=${judgeBatch} msg=${msg}
          pending=${pending} reduced=${reduced} onUndo=${undo} />
      </div>
    </div>`;
}

function ListPane({ div, flat, sel, setSel, d, open, setOpen }) {
  if (div === "analytics" || div === "reference" || div === "gap" || div === "graph" || div === "stream") {
    const label = DIVISIONS.find((x) => x.key === div).label;
    return html`<div class="empty">${label} is read-only.<br />Its content is on the right.</div>`;
  }
  const err = div === "parked" ? d.parked.error : d.worklist.error;
  if (err) return html`<div class="banner">${div} could not be computed — ${err}</div>`;

  if (!flat.length) {
    // An empty division is not an empty system, so each names what remains.
    const blockedN = (d.worklist.blocked || []).length;
    const parkedN = (d.parked.items || []).length;
    const gone = {
      ready: html`<b>READY — nothing to judge.</b><br />
        ${blockedN} in BLOCKED are waiting on edges you just settled; re-check them.<br />
        ${parkedN} parked, ${d.gap.total} never verified.
        <br /><button onClick=${() => { location.hash = "blocked"; }}>re-check BLOCKED</button>`,
      blocked: html`<b>Nothing blocked.</b><br />Every actionable edge is in READY.`,
      parked: html`<b>Nothing parked.</b><br />A deferred edge lands here with its reason.`,
    }[div];
    return html`<div class="empty">${gone}</div>`;
  }

  return html`${flat.map((g, i) => {
    if (g.kind === "batch") {
      return html`<div key=${g.key}
              class=${"item grp" + (open[g.key] ? " open" : "") + (i === sel ? " sel" : "")}
              onClick=${() => { setSel(i); setOpen((o) => Object.assign({}, o, { [g.key]: !o[g.key] })); }}>
        <span class=${"badge " + g.state}>${g.state.slice(0, 3)}</span>
        <span class="itxt">
          <span class="ttl"><span class="caret">&#9656;</span> ${g.node_id} → ${g.members.length} files</span>
          <span class="meta">one node, one state — writable as a single batch</span>
        </span>
      </div>`;
    }
    if (g.kind === "parked") {
      const r = g.row;
      return html`<div key=${g.key} class=${"item" + (i === sel ? " sel" : "")} onClick=${() => setSel(i)}>
        <span class="badge none">park</span>
        <span class="itxt">
          <span class="ttl">${r.sourceShort} → ${r.downstreamShort}</span>
          <span class="meta">${r.ageDays == null ? "age unknown" : r.ageDays + "d ago"} · ${r.boundary}</span>
        </span>
      </div>`;
    }
    return html`<${EdgeRow} key=${g.key} r=${g.row} sel=${i === sel} onClick=${() => setSel(i)} />`;
  })}`;
}

function DetailPane({ div, current, d, lazy, reason, setReason, judge, judgeBatch, msg, pending, onUndo, reduced }) {
  if (div === "analytics") return html`<${Analytics} data=${lazy.analytics} />`;
  if (div === "stream") return html`<${Stream} data=${lazy.stream} />`;

  if (div === "graph") {
    return html`<iframe class="frame" src=${"/graph?token=" + encodeURIComponent(TOKEN)}
      title="dependency graph" />`;
  }

  if (div === "gap") {
    const b = lazy.gap;
    if (!b) return html`<div class="reason">measuring — a git walk per repo, about a second…</div>`;
    if (b.error) return html`<div class="banner">${b.error}</div>`;
    const k = b.buckets;
    return html`<div>
      <h2 class="dtitle">${b.total} never verified</h2>
      <div class="sec">Four outcomes, and one can never clear</div>
      <${Bars} rows=${[
        { label: "baselineable now", value: k.baselineable },
        { label: "no co-commit found", value: k.noCoCommit },
        { label: "walk bound reached", value: k.boundReached },
        { label: "cross-repo, PERMANENT", value: k.ineligibleCrossRepo },
        { label: "examined and parked", value: k.examinedAndDeferred },
      ]} colorOf=${(r) => (/PERMANENT/.test(r.label) ? "var(--dim)" : "var(--st-accent)")} />
      <div class="caveat">
        ${k.ineligibleCrossRepo} are cross-repo. Two independent histories cannot share a commit,
        so that slice is structural and will never clear. It is not a backlog.
      </div>
      ${b.accountedFor ? null
        : html`<div class="banner">the buckets do not sum to the total — ${b.unaccounted} unaccounted</div>`}
    </div>`;
  }

  if (div === "reference") {
    const r = lazy.reference;
    if (!r) return html`<div class="reason">walking the registers…</div>`;
    if (r.error) return html`<div class="banner">${r.error}</div>`;
    const reg = r.registers || {};
    return html`<div>
      <h2 class="dtitle">Registers</h2>
      <div class="sec">Read-only here</div>
      <${Bars} rows=${[
        { label: "open issues", value: (reg.issues || []).length },
        { label: "open todos", value: (reg.todos || []).length },
        { label: "handovers", value: (reg.handovers || []).length },
      ]} colorOf=${() => "var(--edge-reverse)"} />
      ${reg.counts ? html`<div class="caveat">${reg.counts.noAction} items had no action available on their line</div>` : null}
    </div>`;
  }

  if (!current) return html`<div class="empty">Nothing selected.</div>`;
  const r = current.row;

  if (current.kind === "batch") {
    // Members share a state, so member[0]'s `allowed` is representative of
    // every member -- the writer refuses the whole group otherwise (the
    // server-side validateBatchWrite gate), so offering more here would be a
    // control that always errors.
    const allowed = (current.members[0] && current.members[0].allowed) || [];
    return html`<div>
      <h2 class="dtitle">${current.node_id}</h2>
      <div class="dmeta">${current.members.length} edges, all ${current.state}</div>
      <div class="sec">Batch — one disposition, all ${current.members.length} members</div>
      <div class="reason">
        Every member shares a node and a state, so one disposition applies to all of them —
        which is exactly what <b>verify --node --state</b> accepts. Click the row to expand and
        judge them individually instead.
      </div>
      <div class="act disp">
        ${allowed.map((a) => html`
          <button key=${a} onClick=${() => judgeBatch(current, a)}>
            ${a}${keyFor(a) ? html` <kbd>${keyFor(a)}</kbd>` : null}
          </button>`)}
      </div>
      <textarea value=${reason} onInput=${(e) => setReason(e.target.value)}
        placeholder=${"why this disposition is correct for all " + current.members.length + " members (required, 12+ characters) — this text lands in the ledger"}></textarea>
      ${pending ? html`<${Undo} pending=${pending} onUndo=${onUndo} reduced=${reduced} />` : null}
      ${msg ? html`<div class=${"msg " + (msg.ok ? "ok" : "err")}>${msg.text}</div>` : null}
      <div class="hint">
        <kbd>j</kbd><kbd>k</kbd> move · <kbd>n</kbd><kbd>p</kbd><kbd>d</kbd><kbd>r</kbd> judge all · <kbd>u</kbd> undo
      </div>
    </div>`;
  }

  if (current.kind === "parked") {
    return html`<div>
      <h2 class="dtitle">${r.sourceShort} → ${r.downstreamShort}</h2>
      <div class="dmeta">${r.edge_id} · parked ${r.ageDays == null ? "at an unknown time" : r.ageDays + " days ago"}${r.by ? " by " + r.by : ""}</div>
      <div class="sec">Why it was parked</div>
      ${r.reason
        ? html`<div class="ev">${r.reason}</div>`
        : html`<div class="reason">deferred with no reason recorded — that is a finding, not an absence</div>`}
    </div>`;
  }

  if (div === "blocked") {
    return html`<div>
      <h2 class="dtitle">${r.sourceShort} → ${r.downstreamShort}</h2>
      <div class="dmeta">${r.edge_id} · ${r.state} · layer ${r.layer} · ${r.boundary}</div>
      <div class="sec">Why you cannot judge this yet</div>
      <div class="reason">
        ${r.blockedBy.length} unsettled edge(s) upstream. Settling a downstream first pins it
        against a source that is still moving, and the write path refuses that with exit 3.
        <ul>${r.blockedBy.slice(0, 8).map((b) => html`
          <li key=${b.edge_id}>${b.edge_id} — ${short(b.from)} → ${short(b.to)} [${b.state}]</li>`)}</ul>
      </div>
      <div class="caveat">
        This list is not final. Never-verified edges also block but are excluded from the printed
        worklist, so a further blocker can surface once these clear. Re-check after each settlement.
      </div>
    </div>`;
  }

  return html`<div>
    <h2 class="dtitle">${r.sourceShort} → ${r.downstreamShort}</h2>
    <div class="dmeta">${r.edge_id} · ${r.state} · layer ${r.layer} · ${r.boundary}</div>
    ${r.why ? html`<div class="dmeta" style=${{ marginTop: "6px" }}>${r.why}</div>` : null}
    <div class="sec">Action</div>
    <div class="act disp">
      ${(r.allowed || []).map((a) => html`
        <button key=${a} onClick=${() => judge(r, a)}>
          ${a}${keyFor(a) ? html` <kbd>${keyFor(a)}</kbd>` : null}
        </button>`)}
    </div>
    <textarea value=${reason} onInput=${(e) => setReason(e.target.value)}
      placeholder="why this disposition is correct (required, 12+ characters) — this text lands in the ledger"></textarea>
    ${pending ? html`<${Undo} pending=${pending} onUndo=${onUndo} reduced=${reduced} />` : null}
    ${msg ? html`<div class=${"msg " + (msg.ok ? "ok" : "err")}>${msg.text}</div>` : null}
    <div class="hint">
      <kbd>j</kbd><kbd>k</kbd> move · <kbd>n</kbd><kbd>p</kbd><kbd>d</kbd><kbd>r</kbd> judge · <kbd>u</kbd> undo
    </div>
  </div>`;
}

/* A headless test can reach the pure helpers. There is no browser and no
 * bundler in this repo's suite, so without this the shaping logic -- batching,
 * the gap-breaking path builder, the rail counts -- has no check at all. */
if (typeof globalThis !== "undefined") {
  globalThis.__ui = { batched, counts, linePath, KEYS, keyFor, DIVISIONS, UNDO_MS, readHash, disposeBody, sinceLabel, vintageLabel };
}

if (typeof document !== "undefined" && document.getElementById("app")) {
  render(html`<${App} />`, document.getElementById("app"));
}
