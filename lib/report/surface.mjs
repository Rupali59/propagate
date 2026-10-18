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
 * House rule: `lib/` derives, `cli/` renders. Nothing here prints, writes,
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
 *
 * **4. "What changed" is a different question from "what state is X in", and
 * gets a different shape.** See `buildChangedSummary` — it does not become a
 * fourth group of rows next to EDGES/REGISTERS/HEALTH. It rides beside
 * `headline`, because the widget's one number for this question is closer in
 * kind to "here is THE number" than to "here is a bar for one of several
 * backlogs". Sourced from lib/report/stream.mjs's `streamPayload()`, whose
 * own fold this module does not repeat (G20).
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
/**
 * What the widget may link to, as hash routes.
 *
 * open-ui.sh turns a route into a fragment (`URL#${VIEW}`), so every entry
 * here has to be something cli/ui.client.js actually routes. A view listed
 * here and not routed there puts a DEAD LINK on the desktop — which is the
 * exact failure this list exists to prevent, arriving through the list itself.
 *
 * ROUTE RENAME 2026-10-15 (plan F11). Nine data-source views became the views
 * built for what a human does. Old -> new: /ready /parked /gap -> /judge;
 * /blocked -> /unblock; /reference -> /health; /analytics /stream -> /activity;
 * /conflicts -> /reminders; /graph unchanged; /registers is new. An OLDER
 * installed widget still sends the old hashes, so ui.client.js's readHash maps
 * every one of them -- this list is only what a CURRENT widget may link to.
 *
 * REPLACED THE EIGHT TABS on 2026-09-21. Those were a taxonomy of data sources
 * — queue, issues, todos, handovers, gotchas, health, rules, graph — and the
 * divisions below are a taxonomy of what needs a human. A widget-contract test
 * asserts this list against the client's own DIVISIONS.
 */
export const SERVED_VIEWS = Object.freeze([
  "/overview", "/judge", "/unblock", "/health", "/claims", "/rules", "/caps", "/skills", "/backlog", "/goals", "/registers", "/reminders", "/activity", "/history", "/graph",
]);

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

import { shortPath } from "./queue.mjs";
import { usageReport, DEFAULT_ORIGIN } from "./usage.mjs";

const DAY = 86_400_000;

/**
 * `YYYY-MM-DD` of an instant in the PROCESS'S LOCAL time zone, or null when the
 * input is not a date. Never `ts.slice(0, 10)`: that is the UTC day, and a
 * judgement at 2026-10-12T20:00Z is 10-13 in IST (UTC+5:30). Every day bucket on
 * the surface goes through here so the calendar, velocity and usage cannot
 * disagree about what "today" is.
 */
export function localDay(input) {
  const t = input instanceof Date ? input.getTime() : typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The last `n` local days, oldest first, ending with the day containing `now`. */
export function lastLocalDays(n, now = Date.now()) {
  const base = new Date(now);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    // Calendar arithmetic on the local date, not `now - i * DAY`: a DST change
    // makes a day 23 or 25 hours long and would skip or repeat a label.
    out.push(localDay(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i, 12)));
  }
  return out;
}

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

  // READY, NOT ACTIONABLE. 18 of the 49 actionable edges have an unsettled
  // ancestor and `cli.mjs` refuses them with exit 3, so a headline of "49
  // actionable" overstates the work available by 37%. The number a person can
  // act on right now is the unblocked half.
  //
  // FALLS BACK HONESTLY. `blocked` is only present once the fix-order join has
  // run; a payload without it has `blocked === null` on every row, and there is
  // no way to tell READY from BLOCKED. In that case the row reports the
  // actionable total and SAYS SO in its unit, rather than relabelling an
  // unsplit number as "ready" — which would be the count lying about what it
  // counted (rule:discernment-checks §5).
  const joined = items.length > 0 && items.every((i) => i.blocked !== null && i.blocked !== undefined);
  const readyCount = joined ? items.filter((i) => i.blocked === false).length : null;
  const blockedCount = joined ? items.length - readyCount : null;
  const headline = joined ? readyCount : (s.total ?? 0);

  const boundary = boundarySplit(items, root);
  const byState = s.byState ?? {};
  const parts = Object.entries(byState)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`);

  return [
    {
      key: "drift",
      label: "Drift",
      value: headline,
      unit: joined ? "ready" : "actionable",
      ratio: ratio(headline, expanded),
      // AMBER ON OVERDUE, NOT ON NON-ZERO. The threshold is the stale bucket —
      // edges nobody has judged in over 15 days — because "48 is more than 0"
      // is not news and "10 have been sitting a fortnight" is. failAt is
      // deliberately absent: a backlog is work, not a failure.
      tone: buckets.stale > 0
        ? toneFor(buckets.stale, { denominator: s.total || 1, warnAt: 1 })
        : toneFor(s.total ?? 0, { denominator: expanded }),
      detail: [
        joined ? `${blockedCount} blocked` : null,
        parts.join(" · ") || null,
      ].filter(Boolean).join("  ·  ") || null,
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
      cta: { route: "/judge", label: "judge" },
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
    { key: "issues", label: "Issues", route: "/registers" },
    { key: "handovers", label: "Handovers", route: "/registers" },
    { key: "todos", label: "Todos", route: "/registers" },
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
      // "view", not "act": the registers page is READ-ONLY this release (plan D7),
      // so a label promising an action would be a button that does nothing.
      cta: { route, label: "view" },
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
      cta: { route: "/registers", label: "view" }, // read-only (plan D7)
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
  { name: "Backlog", label: "Backlog", route: "/activity" },
  // Per-session instruction load vs the harness warning; the detail is `propagate instructions`.
  { name: "Instruction budget", label: "Instruction budget", route: "/health" },
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
 * The CHANGED badge — "what changed since I last looked", reduced to the ONE
 * number a glance surface can show. See
 * ~/.claude/plans/i-saw-it-what-starry-sparkle.md, "Surface 2 — the widget":
 * *"One number, not a table."* This reshapes `streamPayload()`'s already-
 * folded `summary` into the same {value, label, tone} triple `headline`
 * already uses, so the widget needs no new reading rule to show it.
 *
 * DOES NOT RE-FOLD. `changed.summary.{total,open,closed}` is read verbatim —
 * lib/report/stream.mjs's `foldWindow()` already did the only fold this
 * number needs (G20: a second reporting mechanism duplicates the first
 * unless you delete the first, and there is nothing here to delete FROM
 * because nothing here re-derives anything).
 *
 * ZERO CHANGED IS A CLEAN RESULT, NOT AN UNKNOWN ONE — the inverse of
 * `toneFor`'s rule. `toneFor`'s zero-denominator case means "nothing was
 * scanned" (N87). Here a `total` of 0 means the fold genuinely found nothing
 * in the window, which is a real, common answer (a quiet week), so it earns
 * `ok`. `unknown` is reserved for "streamPayload could not run at all" —
 * `changed` absent or carrying its own `.error`.
 */
export function buildChangedSummary(changed) {
  if (!changed || changed.error) {
    return {
      value: null,
      label: changed?.error ? "stream error" : "no stream",
      tone: "unknown",
    };
  }
  const { total = 0, open = 0 } = changed.summary ?? {};
  return {
    value: total,
    label: "changed",
    // COLOUR MUST BE EARNED, same rule toneFor's own doc states: a non-empty
    // backlog is not an alarm by default. "Something is still open among what
    // changed" is worth a neutral flag; "nothing changed" or "everything that
    // changed is already closed" is the clean state.
    tone: open > 0 ? "none" : "ok",
  };
}


// ── pure-data sections for the desktop widget (D4: no geometry here) ───────

/**
 * Health per doctor section, with ACCEPTED findings kept apart from failures.
 *
 * `accepted` is defaulted to 0 when a snapshot predates the field -- an old
 * snapshot is "no exceptions recorded", which is also what it means. A section
 * with nothing counted (info/notes only) is `unknown`, never `ok`: zero over
 * zero is the N87 pair.
 */
export function buildHealthSections(snapshot) {
  if (!snapshot?.ok) {
    return { ok: false, reason: snapshot?.reason ?? "no snapshot", sections: [] };
  }
  const sections = (snapshot.payload?.sections ?? []).map((s) => {
    const pass = s.pass ?? 0;
    const warn = s.warn ?? 0;
    const fail = s.fail ?? 0;
    const accepted = s.accepted ?? 0;
    const status = fail > 0 ? "fail" : accepted > 0 ? "accepted-only" : pass + warn === 0 ? "unknown" : "ok";
    return { key: s.name, label: s.name, status, fail, accepted, pass };
  });
  return { ok: true, reason: null, sections };
}

const WORKLIST_STATES = Object.freeze(["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"]);

/**
 * The worklist, from ITEM FLAGS. `toJudge` is the edges a person can judge now:
 * unblocked AND not DIVERGED (a diverged edge needs a human decision about which
 * side is right, not a verdict). It is NOT `ready - blocked`: `ready` is already
 * the unblocked half, so subtracting `blocked` again double-subtracts (the
 * surface.mjs:199 hazard the plan's outside voice verified).
 *
 * `calendar` buckets ONE date field -- `last.ts`, the field the age buckets use --
 * by LOCAL day; `never` counts items with no parseable `last.ts`.
 */
export function buildWorklist(items) {
  items = items ?? [];
  const byState = Object.fromEntries(WORKLIST_STATES.map((k) => [k, 0]));
  let other = 0;
  for (const i of items) {
    if (i.state in byState) byState[i.state] += 1;
    else other += 1;
  }

  const joined = items.every((i) => i.blocked === true || i.blocked === false);
  const toJudge = joined ? items.filter((i) => i.blocked === false && i.state !== "DIVERGED").length : null;

  const days = new Map();
  let never = 0;
  for (const i of items) {
    const d = i?.last?.ts ? localDay(i.last.ts) : null;
    if (d) days.set(d, (days.get(d) ?? 0) + 1);
    else never += 1;
  }
  return {
    toJudge,
    toJudgeReason: joined ? null : "fix-order join missing on some items, so unblocked cannot be told from blocked",
    byState: { ...byState, other },
    total: items.length,
    calendar: [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, count]) => ({ day, count })),
    never,
  };
}

/**
 * Leverage (D14): which unsettled upstream edges hold the blocked edges back.
 *
 * `blockedBy` is TRANSITIVE and lists every unsettled ancestor edge, so "unblocks
 * N" overstates. Two honest numbers instead: `freesNow` -- blocked edges whose
 * ONLY distinct blocker is this edge, so settling it releases them -- and
 * `upstreamOf` -- blocked edges listing it at all. `needAllRoots` counts blocked
 * edges that have more than one distinct blocker and so need several settled.
 * A root outside the queue (e.g. NEVER_VERIFIED) is named by `edge_id` and its
 * root-relative paths, with `inQueue: false`.
 *
 * A ROOT IS A TRUE ROOT (plan E6/F10, 2026-10-15). `blockedBy` is transitive, so
 * an INTERMEDIATE edge -- one that is itself in the queue AND blocked -- appears
 * in it beside the real root above it. Settling an intermediate frees nothing
 * until its own blocker is settled, so ranking it as a lever overstated how much
 * a click could do. Only a blocker that is unblocked, or not in the queue at all
 * (e.g. NEVER_VERIFIED), is counted. This can change the widget's top 3; that is
 * the intended correction, not a regression. The counting of `freesNow` and
 * `upstreamOf` is deliberately untouched -- only WHICH edges are reported moved.
 *
 * `allRoots` is every true root in `roots`' sort order (`roots` is its first 3,
 * so the widget's contract holds). `byFile` groups the JOINT blockers -- blocked
 * edges that have two or more distinct true roots and so need several settled --
 * by the BLOCKED edge's own downstream file, which is where the work happens.
 * It is NOT `bottleneck`, which keys by the blocker's downstream and stays as is.
 */
/**
 * A path as {name, dir}: the file name, and its first and immediate parent folders relative to `root`.
 * The widget used to compact both ends of an edge to ".../CONTEXT-BUDGET.md", which made
 * rules/CONTEXT-BUDGET.md -> propagate/docs/CONTEXT-BUDGET.md read as an edge to itself;
 * the folder is what tells the two ends apart. A file at the root reads as dir "hub".
 */
export function pathParts(abs, root = "") {
  const p = String(abs ?? "");
  const rel = root && p.startsWith(root.replace(/[/]+$/, "") + "/") ? p.slice(root.replace(/[/]+$/, "").length + 1) : p;
  const segs = rel.split("/").filter(Boolean);
  const name = segs.pop() ?? "";
  // First folder (the workspace or hub area) plus the immediate parent: "Vipin Kaushik/…/measurement"
  // says which repo AND which folder, where the last two folders ("docs/measurement") lost the repo.
  const dir = segs.length <= 2 ? segs.join("/") : `${segs[0]}/…/${segs[segs.length - 1]}`;
  return { name, dir: dir || "hub" };
}

export function buildLeverage(items, { root = "" } = {}) {
  const blocked = (items ?? []).filter((i) => i.blocked === true && Array.isArray(i.blockedBy));
  const inQueue = new Map((items ?? []).map((i) => [i.edge_id, i]));
  const stats = new Map();
  let needAllRoots = 0;
  const intoFile = new Map();

  for (const e of blocked) {
    const distinct = new Map();
    for (const b of e.blockedBy) if (b?.edge_id && !distinct.has(b.edge_id)) distinct.set(b.edge_id, b);
    if (distinct.size > 1) needAllRoots += 1;
    const files = new Set();
    for (const [id, b] of distinct) {
      const st = stats.get(id) ?? { b, freesNow: 0, upstreamOf: 0 };
      st.upstreamOf += 1;
      if (distinct.size === 1) st.freesNow += 1;
      stats.set(id, st);
      if (b.to) files.add(b.to);
    }
    for (const f of files) intoFile.set(f, (intoFile.get(f) ?? 0) + 1);
  }

  // Intermediate = in the queue and itself blocked (see the header).
  const isTrueRoot = (id) => { const q = inQueue.get(id); return !q || q.blocked !== true; };

  const allRoots = [...stats.entries()]
    .filter(([edge_id]) => isTrueRoot(edge_id))
    .map(([edge_id, st]) => {
      const q = inQueue.get(edge_id);
      return {
        edge_id,
        inQueue: !!q,
        source: q ? q.sourceShort : shortPath(st.b.from, root),
        downstream: q ? q.downstreamShort : shortPath(st.b.to, root),
        sourceParts: pathParts(q ? q.source : st.b.from, root),
        downstreamParts: pathParts(q ? q.downstream : st.b.to, root),
        freesNow: st.freesNow,
        upstreamOf: st.upstreamOf,
      };
    })
    .sort((a, b) => b.freesNow - a.freesNow || b.upstreamOf - a.upstreamOf || a.edge_id.localeCompare(b.edge_id));

  const joint = new Map();
  for (const e of blocked) {
    const ids = [...new Set(e.blockedBy.map((b) => b?.edge_id).filter((id) => id && isTrueRoot(id)))];
    if (ids.length < 2) continue;
    const file = e.downstream ? shortPath(e.downstream, root) : e.downstreamShort;
    const g = joint.get(file) ?? { file, blockedEdges: 0, roots: new Set() };
    g.blockedEdges += 1;
    for (const id of ids) g.roots.add(id);
    joint.set(file, g);
  }
  const byFile = [...joint.values()]
    .map((g) => ({ file: g.file, blockedEdges: g.blockedEdges, roots: [...g.roots].sort() }))
    .sort((a, b) => b.blockedEdges - a.blockedEdges || a.file.localeCompare(b.file));

  const top = [...intoFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  // THE CASCADE (widget Leverage, direction A, 2026-10-15): how much of `blocked` settling the
  // top roots frees. freesNow counts edges whose ONLY blocker is that root, so it is disjoint
  // across roots and the segments add; needAllRoots is the multi-blocker remainder; `rest` is
  // single-blocker edges freed by roots beyond the top 3 (or by an intermediate blocker).
  // segments + several + rest === blocked, asserted in surface.test.mjs, never clamped here,
  // so a counting bug shows up as a negative rest rather than being hidden.
  const top3 = allRoots.slice(0, 3);
  const freed = top3.reduce((n, r) => n + r.freesNow, 0);
  const cascade = {
    segments: top3.filter((r) => r.freesNow > 0).map((r) => ({ edge_id: r.edge_id, n: r.freesNow })),
    freed,
    several: needAllRoots,
    rest: blocked.length - freed - needAllRoots,
    blocked: blocked.length,
  };
  return {
    cascade,
    blocked: blocked.length,
    needAllRoots,
    rootsTotal: allRoots.length,
    roots: allRoots.slice(0, 3),
    allRoots,
    byFile,
    bottleneck: top
      ? { file: shortPath(top[0], root), blockedEdges: top[1], reason: null }
      : null,
    bottleneckReason: top ? null : (blocked.length ? "blockers carry no downstream path" : "nothing is blocked"),
  };
}

/**
 * Velocity: judgements per local day, from `analyticsPayload`'s
 * `dispositionsByDay` chart (REUSED, not re-read). Absence is attributable: an
 * unreadable event store is `status: "unknown"` with the reason, not 14 zeros.
 */
export function buildVelocity(analytics) {
  const c = analytics?.charts?.dispositionsByDay;
  if (!c || c.error) {
    return { status: "unknown", reason: c?.error ?? "analytics not supplied", days: [] };
  }
  return {
    status: "ok",
    reason: null,
    windowDays: c.windowDays,
    days: c.days,
    events: c.events,
    noChangeEvents: c.noChangeEvents,
    // Over EVENTS, not edges: one edge judged nine times is nine events.
    noChangeShareOfEvents: c.noChangeShareOfEvents,
  };
}

/**
 * Command usage over the runs store, `origin` "interactive" by default.
 *
 * Only records that CARRY a `command` count: the legacy reconcile-only records
 * have none, and reading them as usage would manufacture a history. No command
 * records at all is `none-recorded`, never zeros that read as "nobody used it".
 */
export function buildUsage(runs, { now = Date.now(), origin = DEFAULT_ORIGIN, days = 14 } = {}) {
  if (!Array.isArray(runs)) return { status: "unknown", reason: "runs store not supplied or unreadable" };
  const all = runs.filter((r) => typeof r?.command === "string" && r.command !== "");
  if (all.length === 0) {
    return {
      status: "none-recorded",
      reason: `no command records in the runs store (${runs.length} legacy record(s) carry no command and are not usage)`,
    };
  }
  const window = lastLocalDays(days, now);
  const inWindow = all.filter((r) => window.includes(localDay(r.ts)));
  const originOf = (r) => (typeof r.origin === "string" && r.origin !== "" ? r.origin : DEFAULT_ORIGIN);

  const origins = {};
  for (const r of inWindow) origins[originOf(r)] = (origins[originOf(r)] ?? 0) + 1;

  const kept = inWindow.filter((r) => origin === "all" || originOf(r) === origin);
  const perDay = new Map(window.map((d) => [d, 0]));
  for (const r of kept) perDay.set(localDay(r.ts), perDay.get(localDay(r.ts)) + 1);

  const rep = usageReport(kept, [], { origin: "all" });
  const top = Object.entries(rep.byCommand)
    .map(([command, b]) => ({ command, count: b.invocations }))
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command))
    .slice(0, 5);
  const vals = Object.values(rep.byCommand);
  return {
    status: "ok",
    reason: null,
    origin,
    windowDays: days,
    days: window.map((day) => ({ day, count: perDay.get(day) })),
    top,
    total: rep.totalRuns,
    failures: vals.reduce((n, b) => n + b.errors, 0),
    refusals: vals.reduce((n, b) => n + b.refusals, 0),
    origins,
  };
}

/**
 * Instruction-budget headroom, READ FROM THE DOCTOR SNAPSHOT -- never a live scan
 * of the ~57 CLAUDE.md directories. The snapshot carries it only as a doctor line
 * (`worst unexcepted: <dir> N / LIMIT (H headroom)`), so this parses that line and
 * says `unknown` with a reason when it cannot, rather than guessing. `thin` is
 * the only flag: headroom under 1,000 chars, or already over.
 */
export function buildHeadroom(snapshot) {
  if (!snapshot?.ok) return { status: "unknown", reason: snapshot?.reason ?? "no snapshot" };
  const sec = (snapshot.payload?.sections ?? []).find((s) => s.name === "Instruction budget");
  if (!sec) return { status: "unknown", reason: "snapshot has no Instruction budget section" };
  const line = (sec.entries ?? []).find((e) => e.label === "instruction budget")?.detail ?? "";
  const m = /worst unexcepted: (.+?) ([\d,]+) \/ ([\d,]+) \((?:([\d,]+) headroom|\+([\d,]+) OVER)\)/.exec(line);
  if (!m) return { status: "unknown", reason: "could not read the worst-unexcepted line from the Instruction budget section" };
  const n = (x) => Number(x.replace(/,/g, ""));
  const headroom = m[4] != null ? n(m[4]) : -n(m[5]);
  return { status: "ok", reason: null, directory: m[1], total: n(m[2]), limit: n(m[3]), headroom, thin: headroom < 1000 };
}

/**
 * The whole surface.
 *
 * `headline` is the single value the read order lands on first. It is the
 * actionable count when there IS a population, and an explicit unknown when
 * there is not — a bare 0 cannot distinguish "clean" from "nothing scanned".
 */
export function buildSurface({ queue, snapshot, registers, gotchas, changed, analytics, runs, now = Date.now(), generatedAt, served = SERVED_VIEWS, root = "" } = {}) {
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
      // THE UNIT, NOT A LITERAL. This said "actionable" while the row it is
      // built from had already become "ready" -- the same number under two
      // names, one of them describing a population 37% larger than the other.
      ? { value: head.value, label: head.unit, tone: head.tone }
      : { value: null, label: head ? "nothing scanned" : "no queue", tone: "unknown" };

  return {
    generatedAt: generatedAt ?? new Date(now).toISOString(),
    headline,
    changed: buildChangedSummary(changed),
    groups,
    grid: buildGrid(queue?.items ?? [], { now }),
    // Pure data for the desktop widget; geometry stays in the widget (D4).
    health: buildHealthSections(snapshot),
    worklist: buildWorklist(queue?.items ?? []),
    leverage: buildLeverage(queue?.items ?? [], { root }),
    velocity: buildVelocity(analytics),
    usage: buildUsage(runs, { now }),
    headroom: buildHeadroom(snapshot),
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
      { key: "ui", label: "ui", route: "/judge" },
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

/**
 * Fetch and fold the CHANGED number, isolated in its own try/catch. L1's
 * `streamPayload()` reads the event store and can fail the way any disk read
 * can; a broken changed-badge must not take down the rest of the surface
 * (rule:discernment-checks §2 — this failure gets its OWN attributable
 * reason via `buildChangedSummary`'s `.error` branch, never a thrown surface
 * command).
 */
async function readChanged() {
  try {
    const { streamPayload } = await import("./stream.mjs");
    return await streamPayload({});
  } catch (err) {
    return { error: `could not derive changed: ${err?.message ?? err}` };
  }
}

/** Velocity's source. A failure is carried as a chart error, so the surface says
 *  "unknown" with the reason instead of throwing or drawing 14 zeros. */
async function readAnalytics(opts) {
  try {
    const { analyticsPayload } = await import("./analytics.mjs");
    return await analyticsPayload({ root: opts.root, now: opts.now });
  } catch (err) {
    return { charts: { dispositionsByDay: { error: `could not derive velocity: ${err?.message ?? err}` } } };
  }
}

/** The runs store, for usage. `null` on failure, NOT `[]`: an empty list reads as
 *  "none recorded", which is a different fact from "could not read". */
async function readRunRecords() {
  try {
    const { readRuns } = await import("../core/runs.mjs");
    return (await readRuns()).runs;
  } catch {
    return null;
  }
}

/** Compose the real thing. The only function here that touches the disk. */
export async function surfacePayload(opts = {}) {
  const { readSnapshot } = await import("./doctor/snapshot.mjs");
  const { queuePayload } = await import("./queue.mjs");
  const { registers } = await import("./registers.mjs");

  const [snapshot, queue, gotchas, changed, analytics, runs] = await Promise.all([
    readSnapshot(opts.snapshotFile),
    queuePayload({ root: opts.root }),
    gotchaCensus(opts.gotchas ?? {}),
    readChanged(),
    readAnalytics(opts),
    readRunRecords(),
  ]);

  // Register census is synchronous and ~250ms; it stays live rather than riding
  // the snapshot because it is cheap and because a stale issue count is the
  // number most likely to be acted on.
  const reg = registers({});

  return buildSurface({ queue, snapshot, registers: reg, gotchas, changed, analytics, runs, now: opts.now, root: opts.root });
}
