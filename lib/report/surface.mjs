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
 */
export function toneFor(value, { denominator = null, warnAt = 1, failAt = Infinity } = {}) {
  if (!Number.isFinite(value)) return "unknown";
  if (!Number.isFinite(denominator) || denominator <= 0) return "unknown";
  if (value >= failAt) return "fail";
  if (value >= warnAt) return "warn";
  return "ok";
}

const DAY = 86_400_000;

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
export function buildEdgeRows(queue, { now = Date.now() } = {}) {
  const items = queue?.items ?? [];
  const s = queue?.summary ?? { total: items.length, byState: {} };
  const expanded = queue?.expanded ?? null;
  const declared = queue?.declared ?? null;

  const buckets = { never: 0, today: 0, week: 0, fortnight: 0, stale: 0 };
  for (const i of items) {
    const ts = i?.last?.ts ? Date.parse(i.last.ts) : NaN;
    buckets[ageBucket(Number.isFinite(ts) ? now - ts : null)] += 1;
  }

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
      // failAt is deliberately absent: a large backlog is not a FAILURE, it is
      // work. Only a check that could not run fails.
      tone: toneFor(s.total ?? 0, { denominator: expanded, warnAt: 1 }),
      detail: parts.join(" · ") || null,
      extra: [
        buckets.stale ? `${buckets.stale} over 15 days` : null,
        s.highNoise ? `${s.highNoise} mostly no-op` : null,
        s.neverJudged ? `${s.neverJudged} never judged` : null,
      ].filter(Boolean),
      cta: { route: "/queue", label: "judge" },
      source: "live",
      denominator: { declared, expanded },
      buckets,
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
      tone: toneFor(open, { denominator: total, warnAt: 1 }),
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
      ratio: ratio(gotchas.triggered, gotchas.entries),
      // A gotcha backlog is not work to clear — it is knowledge. The tone is
      // driven by DELIVERY: an entry with no trigger never fires, which is the
      // hazard documented and not delivered.
      tone: gotchas.entries > 0 ? (gotchas.triggered > 0 ? "ok" : "warn") : "unknown",
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
    tone: toneFor(bad, { denominator: checks, warnAt: 1, failAt: fail > 0 ? fail : Infinity }),
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
export function buildSurface({ queue, snapshot, registers, gotchas, now = Date.now(), generatedAt } = {}) {
  const edges = buildEdgeRows(queue, { now });
  const health = buildHealthRows(snapshot);
  const groups = [
    { key: "edges", label: "EDGES", rows: edges },
    { key: "registers", label: "REGISTERS", rows: buildRegisterRows(registers, gotchas) },
    { key: "health", label: "HEALTH", rows: health },
  ];

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
 * new tree walk — so it is stable regardless of the cwd a launchd-started
 * widget happens to inherit. It does NOT claim to be tree-wide; it names its
 * scope, and `files` lets a reader see how much it looked at.
 *
 * `entries` counts `### ` headings (every entry). `triggered` counts the subset
 * `parseEntries` returns, which SKIPS any entry without a `**Trigger:**` line.
 * They are not the same population and must not be compared as if they were.
 */
export async function gotchaCensus({ roots, cwd = process.cwd(), deps } = {}) {
  const d = deps ?? {
    ...(await import("../gotchas/parse.mjs")),
    readFileSync: (await import("node:fs")).readFileSync,
  };
  let list = roots;
  if (!list) {
    const { WORKSPACES } = await import("../core/config.mjs");
    list = WORKSPACES.map((w) => w.root ?? w.path ?? w);
  }

  const files = new Set();
  for (const r of [...list, cwd]) {
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
    scope: "workspace roots + cwd",
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

  return buildSurface({ queue, snapshot, registers: reg, gotchas, now: opts.now });
}
