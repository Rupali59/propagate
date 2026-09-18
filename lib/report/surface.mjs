/**
 * surface.mjs — the one payload behind the one surface.
 *
 * Merges the cached doctor snapshot with a live queue, the register census and
 * a gotcha census into a single object of rows. The widget and the web UI both
 * render THIS; neither derives anything of its own. That is the N86 shape being
 * avoided on purpose — when two renderers each compute "actionable", they
 * eventually disagree, and the disagreement is invisible because each is
 * internally consistent.
 *
 * House rule: `lib/` derives, `commands/` renders. Nothing here prints, writes,
 * or opens a socket.
 *
 * ── THE THREE RULES THIS MODULE ENFORCES ───────────────────────────────────
 *
 * **1. A zero whose denominator is zero is NOT green.** N87 filed exactly this
 * against doctor: `0 actionable of 0 declared` rendered as a pass, so a tree
 * that had not been scanned was indistinguishable from a tree that was clean.
 * Every row therefore carries a `tone`, and the tone for "nothing, over
 * nothing" is `unknown` — never `ok`. `rule:discernment-checks` §2.
 *
 * **2. Declared and expanded are different numbers.** `reconcile` reports
 * `stats.edges: 493` (sidecar declarations) and `stats.expanded: 1003` (after
 * globs). The queue payload has been reporting the expanded count under the
 * name `declared` since it was written, so three renderers say "of 1003
 * declared" and all three are wrong in the way `rule:discernment-checks` §5
 * names. Both are carried here, each under its own name.
 *
 * **3. A census states its own scope.** See `gotchaCensus` — the count depends
 * entirely on which question was asked, and the version that does not say which
 * one is the defect N80 filed.
 */

/**
 * The views `propagate ui` can actually serve today.
 *
 * WHY THIS LIST EXISTS RATHER THAN EVERY ROW JUST CLAIMING A ROUTE. The plan is
 * explicit: *a row must never link to a control that does not exist yet — that
 * is worse than linking to the file.* A dead CTA teaches a reader that the
 * surface lies, and they stop clicking the live ones too.
 *
 * So every row still declares where it BELONGS, and this list decides whether
 * that destination is reachable yet. A row whose route is not served renders
 * with its numbers intact and its action marked as not-yet-built — which is a
 * roadmap the reader can see, not a broken button.
 *
 * Add a view here in the SAME commit that makes `ui` serve it, never before.
 */
export const SERVED_VIEWS = Object.freeze(["/queue", "/issues", "/todos", "/handovers", "/gotchas", "/health", "/rules", "/graph"]);

/** The bar never exceeds 1, and a zero/absent denominator yields null rather
 *  than 0 — "no bar" and "an empty bar" must not render identically. */
export function ratio(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(1, value / total));
}

/**
 * Tone for a count.
 *
 * `denominator` is REQUIRED to earn a green. Passing 0 or null means the
 * population is unknown, and an unknown population with nothing in it is not a
 * clean result — it is a check that did not run. See rule 1 above.
 *
 * ── WHY `warnAt` DEFAULTS TO INFINITY ──────────────────────────────────────
 *
 * It used to default to **1**, so any non-zero count went amber. Measured on the
 * live tree: **6 of 9 rows amber**, which means the colour was answering "is this
 * number greater than zero" — a question the number printed beside it already
 * answers. Six ambers is not a signal, it is a texture.
 *
 * The design's own stated read order was *"the ONE coloured value ... everything
 * else is one weight, one colour, deliberately quiet"* — and the card had eight.
 *
 * So colour now costs something: a caller must NAME a threshold to get amber,
 * and the default for "has items, none of them urgent" is `none` — a neutral
 * fill. `ok` is reserved for a genuine zero, which on this card is rare and
 * therefore worth seeing.
 */
export function toneFor(value, { denominator = null, warnAt = Infinity, failAt = Infinity } = {}) {
  if (!Number.isFinite(value)) return "unknown";
  if (!Number.isFinite(denominator) || denominator <= 0) return "unknown";
  if (value >= failAt) return "fail";
  if (value >= warnAt) return "warn";
  return value === 0 ? "ok" : "none";
}

const DAY = 86_400_000;

/**
 * Which side of the hub/workspace line a path sits on.
 *
 * THE LINE, from docs/HUB-AND-WORKSPACE.md: **the hub owns contracts, workspaces
 * own instances.** The hub is `rules/`, `scripts/execution/*.yml`, `.templates/`,
 * the schemas and propagate's own docs; a workspace is everything under its
 * directory, including `propagation/state/<project>/`.
 *
 * WHY THE SURFACE NEEDS IT. Measured 2026-09-18 over 48 actionable edges:
 * 6 hub-internal, **7 crossing the line**, 35 workspace-local. The card showed
 * "48" and none of that — and the 7 crossers are the ones that matter most,
 * because a crossing edge is a CONTRACT that has not reached its instances.
 * That is the failure the whole two-way flow exists to catch, and it was
 * indistinguishable from a typo in one workspace's README.
 */
export const HUB = "hub";
export function sideOf(abs, root = "") {
  if (!abs) return null;
  const base = root ? (root.endsWith("/") ? root : root + "/") : "";
  const rel = base && abs.startsWith(base) ? abs.slice(base.length) : abs;
  // Hub-owned trees, and the loose files an agent finds by walking up.
  if (/^(rules|scripts|\.templates|skills-marketplace|propagate\/docs)\//.test(rel)) return HUB;
  if (/^[^/]+\.(md|yml|yaml|json)$/.test(rel)) return HUB;
  const seg = rel.split("/")[0];
  return seg || null;
}

/** Split a set of edges by where each END sits. */
export function boundarySplit(items, root = "") {
  const out = { hubInternal: 0, crossing: 0, workspaceLocal: 0, byWorkspace: {} };
  for (const i of items ?? []) {
    const a = sideOf(i.source, root);
    const b = sideOf(i.downstream, root);
    if (a === HUB && b === HUB) out.hubInternal += 1;
    else if (a === HUB || b === HUB) out.crossing += 1;
    else {
      out.workspaceLocal += 1;
      const w = a ?? b;
      if (w) out.byWorkspace[w] = (out.byWorkspace[w] ?? 0) + 1;
    }
  }
  return out;
}

/** Coarse buckets, because an exact age on a glance surface is noise. `null`
 *  (never judged) is its OWN bucket rather than being folded into "old" — those
 *  are different facts and only one of them means somebody deferred. */
export function ageBucket(ms) {
  if (ms == null || !Number.isFinite(ms)) return "never";
  if (ms < DAY) return "today";
  if (ms < 7 * DAY) return "week";
  if (ms < 15 * DAY) return "fortnight";
  return "stale";
}

/**
 * The EDGES group.
 *
 * One headline row plus the state breakdown as its detail. `expanded` is the
 * denominator because the queue is drawn from expanded rows; `declared` rides
 * along so a renderer can show the honest pair instead of conflating them.
 */
export function buildEdgeRows(queue, { now = Date.now(), root = "" } = {}) {
  const items = queue?.items ?? [];
  const s = queue?.summary ?? { total: items.length, byState: {} };
  const expanded = queue?.expanded ?? null;
  const declared = queue?.declared ?? null;

  const buckets = { never: 0, today: 0, week: 0, fortnight: 0, stale: 0 };
  for (const i of items) {
    const ts = i?.last?.ts ? Date.parse(i.last.ts) : NaN;
    buckets[ageBucket(Number.isFinite(ts) ? now - ts : null)] += 1;
  }

  const boundary = boundarySplit(items, root);
  const byState = s.byState ?? {};
  const parts = Object.entries(byState)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`);

  return [
    {
      key: "drift",
      label: "Drift",
      value: s.total ?? 0,
      unit: "actionable",
      ratio: ratio(s.total ?? 0, expanded),
      // AMBER ON OVERDUE, NOT ON NON-ZERO. The threshold is the stale bucket —
      // edges nobody has judged in over 15 days — because "48 is more than 0"
      // is not news and "10 have been sitting a fortnight" is. failAt is
      // deliberately absent: a backlog is work, not a failure.
      tone: buckets.stale > 0
        ? toneFor(buckets.stale, { denominator: s.total || 1, warnAt: 1 })
        : toneFor(s.total ?? 0, { denominator: expanded }),
      detail: parts.join(" · ") || null,
      extra: [
        buckets.stale ? `${buckets.stale} over 15 days` : null,
        // THE LINE, ON THE CARD. A crossing edge is a contract that has not
        // reached its instances — the failure the two-way flow exists to catch
        // — and it was previously indistinguishable from a typo in one
        // workspace's README.
        boundary.crossing ? `${boundary.crossing} cross hub↔workspace` : null,
        boundary.hubInternal ? `${boundary.hubInternal} hub-internal` : null,
        s.highNoise ? `${s.highNoise} mostly no-op` : null,
        s.neverJudged ? `${s.neverJudged} never judged` : null,
      ].filter(Boolean),
      cta: { route: "/queue", label: "judge" },
      source: "live",
      denominator: { declared, expanded },
      buckets,
      boundary,
    },
  ];
}

/**
 * The REGISTERS group — four first-class rows.
 *
 * WHY ROWS AND NOT A SUMMARY. Today these four backlogs appear as ONE dim info
 * line inside doctor (`86 open issue(s) · 38 open handover(s) · …`). The first
 * draft of the surface compressed that further to `Registers  ok`, which is
 * worse than the line it replaced: 329 written-down items rendered as a word.
 *
 * The denominator is entries-in-file, so the bar reads "how much of this
 * register is still open" rather than an invented target.
 */
export function buildRegisterRows(reg, gotchas) {
  const hot = reg?.totals?.hot ?? {};
  const rot = reg?.totals?.rotatable ?? {};
  const rows = [];

  const spec = [
    { key: "issues", label: "Issues", route: "/issues" },
    { key: "handovers", label: "Handovers", route: "/handovers" },
    { key: "todos", label: "Todos", route: "/todos" },
  ];

  for (const { key, label, route } of spec) {
    const open = hot[key] ?? 0;
    const finished = rot[key] ?? 0;
    const total = open + finished;
    rows.push({
      key,
      label,
      value: open,
      unit: "open",
      ratio: ratio(open, total),
      // NEUTRAL BY DESIGN. 87 open issues is the normal state of a register, not
      // a condition. Colouring it amber every single day taught the eye to skip
      // the whole card. The number carries the magnitude; the bar carries the
      // proportion; neither needs a hue.
      tone: toneFor(open, { denominator: total }),
      detail: finished ? `${finished} finished, rotatable` : null,
      extra: [],
      cta: { route, label: "act" },
      source: "live",
    });
  }

  if (gotchas) {
    rows.push({
      key: "gotchas",
      label: "Gotchas",
      value: gotchas.entries,
      unit: "live",
      // THE BAR SHOWS WHAT CANNOT FIRE, not what can — so it reads in the same
      // direction as every other bar on the card ("how much is outstanding").
      // It shipped as triggered/entries, which meant a FULL bar was the GOOD
      // result here and the BAD result everywhere else. That is the identical
      // defect fixed in the workspace row hours earlier, and it survived because
      // the direction test never populated a gotcha row.
      ratio: ratio(gotchas.entries - gotchas.triggered, gotchas.entries),
      // NEUTRAL, NOT GREEN. Green asserted "this is good" on the strength of
      // at least one entry having a trigger, which is not an achievement worth
      // a colour. `rule:every-project-carries-gotchas` is explicit that most
      // gotchas have NO mechanical trigger and that inventing one makes noise,
      // so a partly-triggerless file is the designed state. Only a corpus where
      // NOTHING can fire is a hazard documented and not delivered — that is the
      // one case worth amber.
      tone: gotchas.entries > 0 ? (gotchas.triggered > 0 ? "none" : "warn") : "unknown",
      detail: `${gotchas.triggered} with a trigger · ${gotchas.files} file(s)`,
      // The scope travels WITH the number. See gotchaCensus.
      extra: [`scope: ${gotchas.scope}`],
      cta: { route: "/gotchas", label: "promote" },
      source: "live",
      scope: gotchas.scope,
    });
  }

  return rows;
}

/** Sections doctor prints that are about the machinery rather than a workspace. */
const HEALTH_SECTIONS = Object.freeze([
  { name: "Delivery", label: "Delivery", route: "/health" },
  { name: "Discovery integrity", label: "Discovery", route: "/health" },
  { name: "Backlog", label: "Backlog", route: "/health" },
]);

/**
 * One doctor section → one row, with the bar meaning what it means everywhere
 * else on the card.
 *
 * EVERY BAR ON THIS SURFACE READS "HOW MUCH IS OUTSTANDING". That sounds like a
 * detail and is not: the first version measured the workspace row as the
 * fraction CLEAN while every other row measured the fraction outstanding, so
 * one card carried two opposite meanings for the same visual. A reader has no
 * way to tell them apart, and the fuller bar was the better result in one place
 * and the worse result in the other.
 *
 * The unit follows the same discipline. A clean section reported `0 warn`,
 * which labels a healthy row with the name of a problem; it now reports what it
 * actually has, which is passes.
 */
function sectionRow({ key, label, route, pass = 0, warn = 0, fail = 0 }) {
  const checks = pass + warn + fail;
  const bad = warn + fail;
  return {
    key,
    label,
    value: bad === 0 ? pass : (fail || warn),
    unit: bad === 0 ? "pass" : (fail ? "fail" : "warn"),
    ratio: ratio(bad, checks),
    // ONLY A FAILING CHECK IS COLOURED. doctor grades 355 things `warn`
    // tree-wide, so mirroring that grading onto this card paints most of it
    // amber and says nothing. doctor's own warn COUNT is still printed — it is
    // the hue that is withheld, not the fact.
    tone: toneFor(bad, { denominator: checks, failAt: fail > 0 ? fail : Infinity }),
    detail: `${pass} pass of ${checks}`,
    extra: [],
    cta: { route, label: "review" },
    source: "snapshot",
  };
}

/**
 * The HEALTH group, from the snapshot.
 *
 * TWO THINGS IT MUST NEVER DO. It must not render a missing snapshot as a
 * healthy one — an absent snapshot yields a single `unknown` row carrying the
 * reason, because "doctor has not run" and "doctor found nothing" are the
 * N87 pair. And it must not let a failing section hide just because it is not
 * in the curated list: any section with a `fail` gets a row whether or not
 * `HEALTH_SECTIONS` names it.
 */
export function buildHealthRows(snapshot) {
  if (!snapshot?.ok) {
    return [
      {
        key: "snapshot",
        label: "Doctor",
        value: null,
        unit: "",
        ratio: null,
        tone: "unknown",
        detail: snapshot?.reason ?? "no snapshot",
        extra: [],
        cta: { route: "/health", label: "refresh" },
        source: "snapshot",
      },
    ];
  }

  const sections = snapshot.payload?.sections ?? [];
  const byName = new Map(sections.map((s) => [s.name, s]));
  const rows = [];
  const used = new Set();

  for (const { name, label, route } of HEALTH_SECTIONS) {
    const s = byName.get(name);
    if (!s) continue;
    used.add(name);
    rows.push(sectionRow({ key: name, label, route, ...s }));
  }

  // Workspace sections collapse into one row — sixteen of them would bury
  // everything else — but the scale is the point, so the OUTSTANDING count is
  // the value and the clean/total split is the detail.
  const ws = sections.filter((s) => s.name.startsWith("Workspace: "));
  if (ws.length) {
    for (const s of ws) used.add(s.name);
    const clean = ws.filter((s) => s.warn === 0 && s.fail === 0).length;
    const agg = ws.reduce(
      (a, s) => ({ pass: a.pass + s.pass, warn: a.warn + s.warn, fail: a.fail + s.fail }),
      { pass: 0, warn: 0, fail: 0 },
    );
    rows.push({
      ...sectionRow({ key: "workspaces", label: "Workspaces", route: "/health", ...agg }),
      detail: `${clean} of ${ws.length} clean · ${agg.pass + agg.warn + agg.fail} checks`,
    });
  }

  // Any OTHER failing section. A curated list that can hide a failure is the
  // same defect as a population that excludes its failures (N87).
  for (const s of sections) {
    if (used.has(s.name) || s.fail === 0) continue;
    rows.push({
      ...sectionRow({ key: s.name, label: s.name, route: "/health", ...s }),
      detail: "not in the curated list, shown because it is failing",
    });
  }

  return rows;
}

/**
 * The cell grid, grouped by state.
 *
 * DECISION 2 of the design review, and it is an accessibility fix rather than a
 * style choice. The grid encoded DRIFTED / DIVERGED / REVERSED by COLOUR ALONE,
 * in amber / red / violet — the deutan-protan confusion pair — on a 7px cell
 * with no hover available on the desktop layer. Unreadable for roughly 8% of
 * men. Grouping into labelled, counted runs puts the meaning in position, and
 * leaves colour as a redundant second channel.
 */
export function buildGrid(items, { now = Date.now() } = {}) {
  const order = ["DRIFTED", "DIVERGED", "REVERSED"];
  const groups = new Map(order.map((k) => [k, []]));
  for (const i of items ?? []) {
    if (!groups.has(i.state)) groups.set(i.state, []);
    const ts = i?.last?.ts ? Date.parse(i.last.ts) : NaN;
    groups.get(i.state).push({
      edge_id: i.edge_id,
      state: i.state,
      age: ageBucket(Number.isFinite(ts) ? now - ts : null),
      noiseRatio: i.noiseRatio ?? null,
      label: `${i.sourceShort} → ${i.downstreamShort}`,
    });
  }
  return [...groups.entries()]
    .filter(([, cells]) => cells.length > 0)
    .map(([state, cells]) => ({ state, count: cells.length, cells }));
}

/**
 * The whole surface.
 *
 * `headline` is the single value the read order lands on first. It is the
 * actionable count when there IS a population, and an explicit unknown when
 * there is not — a bare 0 cannot distinguish "clean" from "nothing scanned".
 */
export function buildSurface({ queue, snapshot, registers, gotchas, now = Date.now(), generatedAt, served = SERVED_VIEWS, root = "" } = {}) {
  const edges = buildEdgeRows(queue, { now, root });
  const health = buildHealthRows(snapshot);
  const groups = [
    { key: "edges", label: "EDGES", rows: edges },
    { key: "registers", label: "REGISTERS", rows: buildRegisterRows(registers, gotchas) },
    { key: "health", label: "HEALTH", rows: health },
  ];

  // Stamp reachability ONCE, here, rather than letting each renderer decide.
  // Two renderers each guessing which views exist is the N86 shape in miniature.
  for (const g of groups) {
    for (const r of g.rows) r.cta = { ...r.cta, available: served.includes(r.cta.route) };
  }

  const head = edges[0] ?? null;
  const headline =
    head && head.tone !== "unknown"
      ? { value: head.value, label: "actionable", tone: head.tone }
      : { value: null, label: head ? "nothing scanned" : "no queue", tone: "unknown" };

  return {
    generatedAt: generatedAt ?? new Date(now).toISOString(),
    headline,
    groups,
    grid: buildGrid(queue?.items ?? [], { now }),
    snapshot: {
      ok: !!snapshot?.ok,
      reason: snapshot?.ok ? null : (snapshot?.reason ?? "no snapshot"),
      ageMs: snapshot?.ageMs ?? null,
      generatedAt: snapshot?.payload?.generatedAt ?? null,
      problems: snapshot?.payload?.problems ?? null,
    },
    // Carried explicitly and separately. See rule 2 in the module doc.
    edges: { declared: queue?.declared ?? null, expanded: queue?.expanded ?? null },
    links: [
      { key: "graph", label: "graph", route: "graph --html" },
      { key: "ui", label: "ui", route: "/queue" },
      { key: "doctor", label: "doctor", route: "/health" },
    ],
  };
}

/**
 * A gotcha census that states which question it answered.
 *
 * THREE DIFFERENT NUMBERS EXIST and they are all correct answers to different
 * questions, measured 2026-09-17:
 *
 *   cwd-scoped (what doctor prints)   86 entries over 3 files
 *   workspace roots + cwd (this)     158 entries over 11 files, 79 triggered
 *   every GOTCHAS.md on disk         414 entries over 23 files
 *
 * Doctor's line says none of this, which is N80. This census fans the EXISTING,
 * tested `sourcesFor` over the discovered workspace roots — deliberately not a
 * new tree walk.
 *
 * IT TOOK `cwd` AS AN INPUT AND SO REPRODUCED N80 EXACTLY. Measured on the
 * desktop the day it shipped: **158 entries over 11 files when run from the
 * propagate repo, 89 over 10 from anywhere else** — because `sourcesFor` walks
 * UPWARD, so the answer depended on where the process happened to start. A
 * launchd-started widget inherits an arbitrary cwd, so the number on screen was
 * not reproducible from a terminal. That is the same defect this function's own
 * docstring was describing, one level down, which is why it is recorded here
 * rather than quietly fixed (`rule:enforcement-watches-itself`).
 *
 * The scope is now workspace roots ONLY, which is deterministic. The cost is
 * real and stated: a `GOTCHAS.md` that lives BELOW a workspace root — as
 * propagate's own does — is not counted, because reaching it needs a downward
 * walk this deliberately does not do. `files` is carried so a reader can see
 * how much was looked at rather than inferring completeness.
 *
 * `entries` counts `### ` headings (every entry). `triggered` counts the subset
 * `parseEntries` returns, which SKIPS any entry without a `**Trigger:**` line.
 * They are not the same population and must not be compared as if they were.
 */
export async function gotchaCensus({ roots, deps } = {}) {
  const d = deps ?? {
    ...(await import("../gotchas/parse.mjs")),
    readFileSync: (await import("node:fs")).readFileSync,
  };
  let list = roots;
  if (!list) {
    const { WORKSPACES } = await import("../core/config.mjs");
    list = WORKSPACES.map((w) => w.root ?? w.path ?? w);
  }

  // NO cwd. See the docstring — including it made the count depend on where the
  // process started, which is the defect, not a detail.
  const files = new Set();
  for (const r of list) {
    for (const f of d.sourcesFor(r) ?? []) files.add(f);
  }

  let entries = 0;
  let triggered = 0;
  let unreadable = 0;
  for (const f of files) {
    let txt;
    try {
      txt = d.readFileSync(f, "utf8");
    } catch {
      // Attributable, not swallowed: a file discovered and then unreadable is a
      // different fact from a file that was never there.
      unreadable += 1;
      continue;
    }
    entries += (txt.match(/^### /gm) ?? []).length;
    triggered += (d.parseEntries(f)?.entries ?? []).length;
  }

  return {
    files: files.size,
    entries,
    triggered,
    unreadable,
    scope: "workspace roots",
  };
}

/** Compose the real thing. The only function here that touches the disk. */
export async function surfacePayload(opts = {}) {
  const { readSnapshot } = await import("./doctor/snapshot.mjs");
  const { queuePayload } = await import("./queue.mjs");
  const { registers } = await import("./registers.mjs");

  const [snapshot, queue, gotchas] = await Promise.all([
    readSnapshot(opts.snapshotFile),
    queuePayload({ root: opts.root }),
    gotchaCensus(opts.gotchas ?? {}),
  ]);

  // Register census is synchronous and ~250ms; it stays live rather than riding
  // the snapshot because it is cheap and because a stale issue count is the
  // number most likely to be acted on.
  const reg = registers({});

  return buildSurface({ queue, snapshot, registers: reg, gotchas, now: opts.now, root: opts.root });
}
