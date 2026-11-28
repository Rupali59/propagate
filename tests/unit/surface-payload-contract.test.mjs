/**
 * The payload's contract with its consumers, now that the Ubersicht widget is gone (#415).
 *
 * WHY THIS FILE EXISTS. It began as the Ubersicht widget's contract test, which read the widget's JSX and
 * asserted every `d.<field>` it used existed on `surface --json`. The widget was retired when the
 * SwiftUI panel took over (claude-usage-widget PR #183), so the JSX-reading half went with it and
 * what is left guards the PAYLOAD and its real consumer:
 *
 *   - the nested fields the surface promises (asserted against the real builder, not a fixture of itself);
 *   - a row is clickable only when its view is served, and SERVED_VIEWS matches what the UI routes;
 *   - every health status the builder can emit is one the native panel's roll-up knows;
 *   - every field the native panel DECODES exists on the payload (derived from QueueContract.swift).
 *
 * The consumer lives in another repo, so the last two read it from the workspace and SKIP with a
 * stated reason when no workspace surrounds this clone, never passing silently
 * (rule:workspace-docs-layout, rule:discernment-checks section 2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { buildSurface, SERVED_VIEWS } from "../../lib/report/surface.mjs";

/** Skip with a STATED reason. "not run" and "passed" must never look alike. */
const t_skip = (t, why) => { t.skip(why); console.log("  SKIPPED: " + why); };

// Found by walking UP from this file, never from the runner's HOME (N46): a clone inside the workspace
// reaches its sibling workspace dir, a lone clone elsewhere finds nothing and the tests skip.
const SWIFT_DIR = (() => {
  let dir = import.meta.dirname;
  for (let i = 0; i < 12; i += 1) {
    const cand = path.join(dir, "Rupali/claude-usage-widget/widgets/Sources/PropagateQueue");
    if (existsSync(path.join(cand, "QueueContract.swift"))) return cand;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
})();

/** A payload with every branch populated, so no field is absent by accident. */
function fullPayload() {
  return buildSurface({
    queue: {
      items: [
        { edge_id: "e1", state: "DRIFTED", sourceShort: "a/b.md", downstreamShort: "c/d.md", noiseRatio: 0.5, last: { ts: "2026-09-01T00:00:00.000Z" }, blocked: false, blockedBy: [] },
        { edge_id: "e2", state: "REVERSED", sourceShort: "e/f.md", downstreamShort: "g/h.md", noiseRatio: null, last: null, blocked: true, blockedBy: [{ edge_id: "e1", from: "/r/a/b.md", to: "/r/c/d.md", state: "DRIFTED" }] },
      ],
      summary: { total: 2, byState: { DRIFTED: 1, REVERSED: 1 }, neverJudged: 1, judged: 1, highNoise: 1 },
      declared: 493,
      expanded: 1003,
    },
    snapshot: {
      ok: true,
      ageMs: 600_000,
      payload: {
        problems: 1,
        generatedAt: "2026-09-17T06:00:00.000Z",
        sections: [
          { name: "Delivery", pass: 0, warn: 3, fail: 0, info: 0, note: 0, entries: [] },
          { name: "Workspace: A", pass: 5, warn: 1, fail: 0, info: 0, note: 0, accepted: 1, entries: [] },
          {
            name: "Instruction budget", pass: 1, warn: 0, fail: 0, info: 1, note: 0, accepted: 0,
            entries: [{ kind: "info", label: "instruction budget", detail: "worst unexcepted: A/B 144,765 / 145,000 (235 headroom)" }],
          },
        ],
      },
    },
    registers: { totals: { hot: { issues: 86, handovers: 38, todos: 205 }, rotatable: { issues: 30, handovers: 31, todos: 89 } } },
    gotchas: { files: 11, entries: 158, triggered: 79, scope: "workspace roots + cwd" },
    changed: { summary: { total: 5, open: 2, closed: 3 } },
    analytics: {
      charts: {
        dispositionsByDay: {
          error: null, windowDays: 14, events: 4, noChangeEvents: 3, noChangeShareOfEvents: 0.75,
          days: [{ day: "2026-09-17", total: 4, noChange: 3, changed: 1 }],
        },
      },
    },
    runs: [{ ts: "2026-09-17T08:00:00.000Z", command: "verify", outcome: "ok", origin: "interactive" }],
    now: Date.parse("2026-09-17T12:00:00.000Z"),
  });
}

// ── the contract ───────────────────────────────────────────────────────────

// ── the payload ────────────────────────────────────────────────────────────

test("the nested fields the surface promises are present", () => {
  const d = fullPayload();
  // Hand-listed because they are reached through a map callback, where a regex
  // cannot tell `r.tone` on a row from `r.tone` on anything else. Each is
  // asserted against the real payload rather than a fixture of itself.
  const row = d.groups.flatMap((g) => g.rows)[0];
  for (const k of ["key", "label", "value", "unit", "ratio", "tone", "extra", "cta", "source"]) {
    assert.ok(k in row, `rows must carry ${k}`);
  }
  assert.ok("route" in row.cta && "available" in row.cta, "a row's cta needs a route and its reachability");

  for (const k of ["key", "label", "rows"]) assert.ok(k in d.groups[0], `groups must carry ${k}`);
  for (const k of ["state", "count", "cells"]) assert.ok(k in d.grid[0], `grid runs must carry ${k}`);
  for (const k of ["edge_id", "state", "age"]) assert.ok(k in d.grid[0].cells[0], `cells must carry ${k}`);
  for (const k of ["ok", "reason", "ageMs", "problems"]) assert.ok(k in d.snapshot, `snapshot must carry ${k}`);
  for (const k of ["declared", "expanded"]) assert.ok(k in d.edges, `edges must carry ${k}`);
  for (const k of ["value", "label", "tone"]) assert.ok(k in d.headline, `headline must carry ${k}`);
  for (const k of ["value", "label", "tone"]) assert.ok(k in d.changed, `changed must carry ${k}, same shape as headline`);

  // The locked widget's pure-data sections (W4). Geometry is the widget's own (D4).
  assert.equal(d.health.ok, true);
  for (const k of ["key", "label", "status", "fail", "accepted", "pass"]) assert.ok(k in d.health.sections[0], `health sections must carry ${k}`);
  for (const k of ["toJudge", "decide", "blocked", "ages", "byState", "total", "calendar", "never"]) assert.ok(k in d.worklist, `worklist must carry ${k}`);
  for (const k of ["never", "today", "week", "fortnight", "stale"]) assert.ok(k in d.worklist.ages, `worklist.ages must carry ${k}`);
  for (const k of ["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"]) assert.ok(k in d.worklist.byState, `worklist.byState must carry ${k}`);
  for (const k of ["day", "count"]) assert.ok(k in d.worklist.calendar[0], `calendar days must carry ${k}`);
  for (const k of ["blocked", "needAllRoots", "roots", "bottleneck"]) assert.ok(k in d.leverage, `leverage must carry ${k}`);
  for (const k of ["edge_id", "source", "downstream", "freesNow", "upstreamOf"]) assert.ok(k in d.leverage.roots[0], `leverage roots must carry ${k}`);
  assert.equal(d.velocity.status, "ok");
  for (const k of ["day", "total", "noChange", "changed"]) assert.ok(k in d.velocity.days[0], `velocity days must carry ${k}`);
  assert.ok("noChangeShareOfEvents" in d.velocity);
  assert.ok("idleDays" in d.velocity, "velocity must carry idleDays: the widget draws it and does not derive it (N86)");
  assert.ok("since" in d.changed, "changed must carry the stream window's start, or null, so the pill never invents a time");
  assert.equal(d.usage.status, "ok");
  for (const k of ["days", "top", "total", "failures", "refusals", "origins"]) assert.ok(k in d.usage, `usage must carry ${k}`);
  for (const k of ["directory", "headroom", "thin"]) assert.ok(k in d.headroom, `headroom must carry ${k}`);
});

test("a row is only clickable when its view is actually served", () => {
  // The plan is explicit: a row must never link to a control that does not
  // exist yet — that is worse than linking to the file, because a dead CTA
  // teaches the reader that the whole surface lies.
  const d = fullPayload();
  for (const r of d.groups.flatMap((g) => g.rows)) {
    assert.equal(r.cta.available, SERVED_VIEWS.includes(r.cta.route), `${r.key} claims the wrong reachability`);
  }
  assert.equal(d.groups[0].rows[0].cta.available, true, "drift routes to /queue, which IS served");

  // EVERY ROW NOW LANDS SOMEWHERE. This assertion used to require that SOME row
  // was unbuilt, which was true of a partial surface and is a strange thing to
  // demand once the page holds everything. What matters is the invariant above:
  // availability tracks SERVED_VIEWS exactly, in both directions.
  const dead = d.groups.flatMap((g) => g.rows).filter((r) => !r.cta.available).map((r) => r.key);
  assert.deepEqual(dead, [], `these rows route nowhere: ${dead.join(", ")}`);
});

// ── the CHANGED badge — one number, not a table ─────────────────────────────

test("SERVED_VIEWS matches what the ui page can ACTUALLY render", () => {
  // THE COUPLING THIS WORK CREATED, made mechanical rather than remembered.
  // `SERVED_VIEWS` is a promise in lib/report/surface.mjs that cli/ui.mjs
  // has to keep: every row's CTA availability is stamped from it, so a view
  // listed here but not routed there puts a DEAD BUTTON on the desktop — the
  // exact failure the list exists to prevent, arriving through the list itself.
  //
  // The test in this file above only checks internal consistency (rows agree
  // with SERVED_VIEWS). That passes happily while both are wrong together.
  // rule:adversarial-review-reads-the-ledger: a promise in one file that another
  // file cannot keep is invisible to any review scoped to one file.
  // THE VIEW LIST MOVED, AND THIS CHECK SAID SO. It used to read ui.mjs; the
  // page's client was extracted to ui.client.js and the check failed with "gone
  // blind" rather than silently matching nothing and passing. That is the
  // behaviour it was written for, observed working.
  // THE VIEW LIST CHANGED SHAPE on 2026-09-21: a flat array of tab names
  // became an array of division objects. This check read the old literal and
  // would have matched nothing — so it asserts it FOUND something first, which
  // is the behaviour that caught the last move too.
  // AND IT WENT BLIND THE OTHER WAY on 2026-09-25, which the note above did not
  // anticipate. The extraction was `{ key: "...", label: ... }` matched anywhere
  // in the file, on the assumption that shape was unique to DIVISIONS. T4 added
  // CONFLICT_GROUPS with the identical shape, so the regex found 12 keys for 9
  // divisions and the failure read as "SERVED_VIEWS is missing four views".
  // Three of those four were group headers that no route will ever serve.
  //
  // A guard can be blind by matching NOTHING or by matching MORE, and only the
  // first was defended against. So the literal is located first and the keys are
  // read from inside it — the same extraction ui-rail-separator.test.mjs uses.
  const ui = readFileSync(path.join(import.meta.dirname, "../../cli/ui.client.js"), "utf8");
  const lit = /const DIVISIONS\s*=\s*\[([\s\S]*?)\];/.exec(ui);
  assert.ok(lit, "could not find the DIVISIONS literal in ui.client.js — this check has gone blind, which is worse than failing");
  const keys = [...lit[1].matchAll(/key:\s*"([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5,
    "could not find the division list in ui.client.js — this check has gone blind, which is worse than failing");
  // The negative control for the widening above: a key declared OUTSIDE the
  // literal must not be collected. CONFLICT_GROUPS is that population today.
  for (const outside of ["config", "content", "quiet"]) {
    assert.ok(!keys.includes(outside),
      `"${outside}" is not a division — the extraction is reading beyond the DIVISIONS literal again`);
  }
  const routed = new Set(keys);
  for (const v of SERVED_VIEWS) {
    assert.ok(routed.has(v.replace(/^\//, "")), `SERVED_VIEWS promises ${v}, which ui.mjs does not route`);
  }
  assert.equal(routed.size, SERVED_VIEWS.length, "ui.mjs routes a view SERVED_VIEWS does not list — the widget will never offer it");
});

// ── the native panel's decoder ─────────────────────────────────────────────

/**
 * Struct -> payload path, for the structs in QueueContract.swift. Hand-listed because the Swift side
 * names its types, not their place in the payload; each struct's FIELDS are derived from the Swift
 * file, and a struct this table does not know fails below rather than going unchecked.
 */
const SWIFT_PATHS = {
  QueueSurface: [],
  QueueChanged: ["changed"],
  QueueAges: ["worklist", "ages"],
  QueueWorklist: ["worklist"],
  QueueRoot: ["leverage", "roots", 0],
  QueueLeverage: ["leverage"],
  QueueDay: ["velocity", "days", 0],
  QueueVelocity: ["velocity"],
  QueueHeadroom: ["headroom"],
  QueueSection: ["health", "sections", 0],
  QueueHealth: ["health"],
  QueueSnapshot: ["snapshot"],
};
/** Not a payload object: nested helper structs whose shape is checked through their parent. */
const SWIFT_SKIP = new Set(["QueueParts", "QueueCascade"]);

function swiftFields(src) {
  const out = {};
  for (const m of src.matchAll(/struct (Queue\w+): Decodable[^{]*\{([\s\S]*?)\n\}/g)) {
    const fields = [...m[2].matchAll(/^\s*var (\w+):/gm)].map((f) => f[1]);
    // `case edgeId = "edge_id"` renames a key: the payload's name is the string.
    const renamed = Object.fromEntries([...m[2].matchAll(/case (\w+) = "(\w+)"/g)].map((r) => [r[1], r[2]]));
    out[m[1]] = fields.map((f) => renamed[f] ?? f);
  }
  return out;
}

/** The payload's own field names, for fields that are conditional (reason on a failure, never on a success). */
const surfaceSrc = readFileSync(path.join(import.meta.dirname, "../../lib/report/surface.mjs"), "utf8");

test("every field the native panel decodes exists on the surface payload", (t) => {
  if (!SWIFT_DIR) return t_skip(t, "no claude-usage-widget workspace around this clone, so QueueContract.swift cannot be read");
  const structs = swiftFields(readFileSync(path.join(SWIFT_DIR, "QueueContract.swift"), "utf8"));
  assert.ok(Object.keys(structs).length >= 10, `only ${Object.keys(structs).length} structs found in QueueContract.swift - the scan has gone blind, it has not found nothing`);
  const d = fullPayload();
  let checked = 0;
  for (const [name, fields] of Object.entries(structs)) {
    if (SWIFT_SKIP.has(name)) continue;
    assert.ok(name in SWIFT_PATHS, `QueueContract.swift has a struct ${name} this test has no payload path for - add it to SWIFT_PATHS`);
    let node = d;
    for (const k of SWIFT_PATHS[name]) node = node?.[k];
    assert.ok(node && typeof node === "object", `payload has nothing at ${SWIFT_PATHS[name].join(".") || "(root)"} for ${name}`);
    for (const f of fields) {
      checked += 1;
      // The root also carries `error`, which only the failed shape has; conditional fields (`reason`) are
      // set on the not-ok branch. Either way the builder's source must name the field.
      assert.ok(f in node || new RegExp(`\\b${f}\\b`).test(surfaceSrc),
        `the native panel decodes ${name}.${f}, which the payload does not carry (${Object.keys(node).join(", ")})`);
    }
  }
  assert.ok(checked >= 40, `only ${checked} decoded fields checked - expected the contract's full width`);
});

test("every health status the builder can emit is one the native panel rolls up", (t) => {
  if (!SWIFT_DIR) return t_skip(t, "no claude-usage-widget workspace around this clone, so QueueHealthModel.swift cannot be read");
  const fn = surfaceSrc.slice(surfaceSrc.indexOf("export function buildHealthSections"));
  const line = /const status = [^;]+;/.exec(fn.slice(0, fn.indexOf("\n}")));
  assert.ok(line, "could not find the status expression in buildHealthSections - this check has gone blind");
  const statuses = new Set([...line[0].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(statuses.size >= 4, `buildHealthSections emits four statuses; found ${statuses.size} (${[...statuses].join(", ")}) - gone blind`);
  const model = readFileSync(path.join(SWIFT_DIR, "QueueHealthModel.swift"), "utf8");
  const rank = /static let rank = \[([^\]]+)\]/.exec(model);
  assert.ok(rank, "could not find the status rank table in QueueHealthModel.swift - this check has gone blind");
  const known = new Set([...rank[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));
  const unsaid = [...statuses].filter((s) => !known.has(s));
  assert.deepEqual(unsaid, [], `the payload can emit these and the native panel cannot rank them: ${unsaid.join(", ")}`);
});
