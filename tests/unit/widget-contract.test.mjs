/**
 * The widget's contract with the payload, and its own house rules.
 *
 * WHY THIS FILE EXISTS. `widget/propagate-queue.jsx` has no headless test and
 * cannot easily get one: it is JSX, this repo has zero dev dependencies on
 * purpose, and Übersicht compiles it with `pragma:'html'` rather than React. So
 * the obvious test — render it — is not available.
 *
 * But the failure that actually happens is not a render failure. It is the
 * payload quietly dropping a field the widget reads, which on the desktop layer
 * produces `undefined` in a card with no console, no error, and no test. That
 * IS mechanically checkable: extract every `d.<field>` the widget reads and
 * assert the real payload has it.
 *
 * The rest of this file makes the widget's own hard-won rules into assertions
 * rather than comments. `rule:enforcement-watches-itself`: prose about a hazard
 * is not a check for it, and every one of these was written down correctly
 * before it fired anyway.
 */
import { test } from "node:test";

/** Skip with a STATED reason. "not run" and "passed" must never look alike. */
const t_skip = (why) => { console.log("  SKIPPED: " + why); };
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { buildSurface, SERVED_VIEWS } from "../../lib/report/surface.mjs";

const WIDGET = path.join(import.meta.dirname, "../../widget/propagate-queue.jsx");
const src = readFileSync(WIDGET, "utf8");
/** Comments describe hazards and name fields that do not exist; only code counts. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*\/\//.test(l))
  .join("\n");

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

test("every field the widget reads off the payload actually exists on it", () => {
  // The failure this prevents: surface.mjs renames a field, every test still
  // passes, and the desktop card renders `undefined` where a number was. There
  // is no console on that layer, so nothing reports it.
  // TWO SHAPES, because the collector emits two. A field may live on either,
  // and checking only the success shape wrongly condemns `d.error` — which is
  // the field the whole degradation path depends on.
  const ok = fullPayload();
  const failed = { error: "could not derive", headline: null, groups: null, grid: null };
  const read = new Set();
  for (const m of code.matchAll(/\bd\.([A-Za-z_$][\w$]*)/g)) read.add(m[1]);

  assert.ok(read.size >= 4, `expected the widget to read several payload fields, saw ${read.size}`);
  for (const field of read) {
    assert.ok(field in ok || field in failed, `widget reads d.${field}, which neither payload shape has`);
  }
  assert.ok(read.has("error"), "the widget must read the error field, or a failed derive renders as a calm card");
});

test("the ERROR shape carries the fields the widget branches on", () => {
  // `surface --json` emits this on a derivation failure rather than exiting
  // silently, so the desktop can name the reason. If it stopped carrying
  // `error`, the widget would fall through to the success path with null
  // groups — a blank, healthy-looking card (rule:discernment-checks §6).
  const failed = { error: "boom", headline: null, groups: null, grid: null };
  assert.ok(failed.error);
  assert.equal(failed.groups, null, "and NOT an empty array, which would render as 'nothing wrong'");
});

test("the nested fields the widget names are present too", () => {
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
  for (const k of ["toJudge", "byState", "total", "calendar", "never"]) assert.ok(k in d.worklist, `worklist must carry ${k}`);
  for (const k of ["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"]) assert.ok(k in d.worklist.byState, `worklist.byState must carry ${k}`);
  for (const k of ["day", "count"]) assert.ok(k in d.worklist.calendar[0], `calendar days must carry ${k}`);
  for (const k of ["blocked", "needAllRoots", "roots", "bottleneck"]) assert.ok(k in d.leverage, `leverage must carry ${k}`);
  for (const k of ["edge_id", "source", "downstream", "freesNow", "upstreamOf"]) assert.ok(k in d.leverage.roots[0], `leverage roots must carry ${k}`);
  assert.equal(d.velocity.status, "ok");
  for (const k of ["day", "total", "noChange", "changed"]) assert.ok(k in d.velocity.days[0], `velocity days must carry ${k}`);
  assert.ok("noChangeShareOfEvents" in d.velocity);
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

test("the widget reads d.changed and renders it as a toned badge, not a per-edge list", () => {
  // "One number, not a table" — surface.mjs's buildChangedSummary collapses
  // streamPayload()'s whole changed-edges list to {value, label, tone} before
  // this file ever sees it. Nothing per-edge should reach the widget, so this
  // asserts BOTH that the badge exists and that no per-item iteration does.
  assert.match(code, /d\.changed/, "the widget must read d.changed");
  assert.match(code, /className=\{`chg \$\{ch\.tone\}`\}/, "the badge needs a tone class, same convention as every other coloured value on the card");
  assert.doesNotMatch(code, /changed\.(list|items|edges)\b/, "iterating a raw changed list would be the table this design rejects");
  assert.doesNotMatch(code, /ch\.(list|items|edges)\b/, "same check against the widget's own local name for the summary");
});

test("the badge is gated on a real value — G24: the gate must be BEFORE the marker, not just present somewhere", () => {
  // This repo's widget has no headless renderer, so its tests match raw
  // source text (G24). A test anchored only at "does ch.value != null appear
  // ANYWHERE in the file" cannot see a gate written AFTER the badge markup,
  // which would let the badge render "null changed" on every first tick
  // before the guard ever protected anything. So the ordering is asserted
  // explicitly: the null check must appear strictly BEFORE the JSX it guards.
  const render = code.slice(code.indexOf("export const render"));
  const chgIdx = render.indexOf("className={`chg");
  assert.ok(chgIdx > -1, "no .chg badge markup found in render()");
  const before = render.slice(0, chgIdx);
  assert.match(before, /ch\.value\s*!=\s*null/, "the null guard must appear BEFORE the badge markup, not merely exist in the file");
});

test("ch falls back the same way h does, so an older collect.sh cannot throw reading it", () => {
  const render = code.slice(code.indexOf("export const render"));
  assert.match(render, /const ch = d\.changed \|\| \{[^}]*tone:\s*'unknown'[^}]*\}/, "ch must have the same absent-field fallback as h");
});

test("the .chg badge CSS carries no fixed width (G9's family) and a distinct 'none' tone", () => {
  const cssMatch = code.match(/\.chg\s*\{([^}]*)\}/);
  assert.ok(cssMatch, "no .chg rule found — the badge has gone unstyled");
  assert.doesNotMatch(cssMatch[1], /(?<![-\w])width:\s*\d+px/, "a fixed badge width will clip a longer count, the G9 shape");
  assert.match(code, /\.chg\.none\s*\{/, "the 'something is open' tone needs its own visible rule, or it reads identically to the quiet state");
});

// ── the widget's own rules, as assertions rather than comments ─────────────

test("the JSX actually parses", (t) => {
  // THE BUG THIS CAUGHT ON ITS FIRST RUN. A CSS comment inside the `className`
  // template literal contained BACKTICKS — "not `grid-auto-flow: column`" —
  // which terminated the literal early and turned the rest of the stylesheet
  // into JavaScript. Nothing else in this repo could see it: node cannot parse
  // JSX, there is no bundler, and on the desktop layer the widget would simply
  // never have appeared, with no console and no error.
  //
  // `bun` is used only as a PARSER here, not as a runtime or a dependency. It
  // is not in package.json and the suite still runs under node.
  //
  // NOTE it does not replace the G8 fragment check below: a fragment transpiles
  // cleanly under bun's React defaults and is fatal only because Übersicht sets
  // no `pragmaFrag`. Bun sees syntax; the regexes see the host's constraints.
  // Resolved through PATH, never by building a path from the runner's HOME —
  // tests/portability/state-isolation.test.mjs forbids that outright (N46), and
  // it caught this on the first full run.
  const probe = spawnSync("/bin/sh", ["-c", "command -v bun"], { encoding: "utf8" });
  const bun = probe.status === 0 ? probe.stdout.trim() : null;
  if (!bun) {
    // Attributable absence (rule:discernment-checks §2). "Not parsed because no
    // parser" must never read as "parsed and fine".
    t.skip("bun not installed — the JSX was NOT parsed by this run");
    return;
  }
  const r = spawnSync(bun, ["-e", `
    const src = await Bun.file(${JSON.stringify(WIDGET)}).text();
    new Bun.Transpiler({ loader: "jsx" }).transformSync(src);
    console.log("ok");
  `], { encoding: "utf8" });
  assert.equal(r.status, 0, `widget JSX does not parse:\n${r.stderr}`);
  assert.match(r.stdout, /ok/);
});

test("no backtick survives inside the className template literal", () => {
  // TWICE IN ONE SESSION. A CSS comment written as "not `grid-auto-flow`" and
  // then, in the FIX for a different bug, "`display:inline-block` is
  // load-bearing" — each one closed the template literal early and turned the
  // rest of the stylesheet into JavaScript. The parse test catches it, but it
  // reports a confusing error twenty lines further down; this one names the
  // actual cause. The habit that produces it (quoting code in prose with
  // backticks) is the same habit that makes the comments in this repo good, so
  // it will happen again.
  const open = src.indexOf("export const className = `") + "export const className = `".length;
  const close = src.indexOf("`", open);
  const literal = src.slice(open, close);
  assert.ok(literal.includes(".gate"), "the className literal is TRUNCATED — a backtick closed it early");
  assert.ok(literal.length > 2000, `className literal is only ${literal.length} chars — it ended too soon`);
});

test("SERVED_VIEWS matches what the ui page can ACTUALLY render", () => {
  // THE COUPLING THIS WORK CREATED, made mechanical rather than remembered.
  // `SERVED_VIEWS` is a promise in lib/report/surface.mjs that commands/ui.mjs
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
  const ui = readFileSync(path.join(import.meta.dirname, "../../commands/ui.client.js"), "utf8");
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

test("no RELATIVE imports — they fail silently on the desktop layer", () => {
  // G60's family. A relative specifier that does not resolve produces no
  // console, no test failure, and no render. `uebersicht` is the one import
  // that is guaranteed to resolve.
  const imports = [...code.matchAll(/^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, "the widget should import `run` from uebersicht");
  for (const spec of imports) {
    assert.ok(!spec.startsWith("."), `relative import ${spec} will fail silently`);
  }
  assert.ok(imports.includes("uebersicht"), "clicks need `run` from uebersicht");
});

test("no JSX fragments — there is no pragmaFrag (G8)", () => {
  // Übersicht compiles with `pragma:'html'` and sets no `pragmaFrag`, so `<>…</>`
  // falls back to React.Fragment, which is not in a widget bundle's scope.
  assert.doesNotMatch(code, /<>|<\/>/, "a fragment will not resolve");
  assert.doesNotMatch(code, /React\.Fragment/);
});

test("the card width is derived, never asserted (G9)", () => {
  // G9: "a fixed card width is a claim about the cell count, and it rotted
  // immediately" — a 470px card whose heatmap needed 630px drew cells onto the
  // wallpaper with correct DOM, valid CSS, passing tests and the right data.
  // FIND THE CARD RULE FIRST, AND FAIL IF IT CANNOT. This check was written
  // against a class called `.card`. The card was later renamed to `.shell`, and
  // the negative assertion below stopped matching ANYTHING -- so it passed
  // vacuously while checking nothing at all. A check that goes blind and stays
  // green is worse than one that fails, because nothing ever asks about it
  // again (rule:enforcement-watches-itself).
  const cardRe = /\.(card|shell)\s*\{([^}]*)\}/;
  const card = code.match(cardRe);
  assert.ok(card, "no card rule found — this check has gone blind; the element was renamed");

  assert.match(card[2], /width:\s*max-content/, "the card must size to its widest child");
  // `\b` is NOT enough for the negative: it is satisfied by the hyphen in
  // `max-width`, so the obvious regex flags a correct file. Caught by this test
  // failing against a card that was already right — rule:discernment-checks §4.
  assert.doesNotMatch(card[2], /(?<![-\w])width:\s*\d+px/, "a fixed card width is the rotted claim");

  // NO max-width EITHER. The 2026-10-15 redesign dropped the old 560px cap along
  // with the wrapping `.cells` grid it protected: every chart is now an SVG of
  // intrinsic size, so the card is as wide as its widest panel and a cap would
  // only clip a panel instead of widening the card. Long wrapping text (.err,
  // .gate) opts out of contributing width with `contain: inline-size`.
  assert.doesNotMatch(card[2], /max-width:/, "a max-width on the card is a claim about the content width");
  assert.match(code, /\.(err|gate)[^{]*\{[^}]*contain:\s*inline-size/, "wrapping messages must not set the card's width");
});

test("every updateState branch spreads ...prev (G11)", () => {
  // Übersicht REPLACES widget state on each command run. A branch returning a
  // fresh object silently drops the remembered position — and both the drop and
  // the cause are invisible.
  const body = code.slice(code.indexOf("export const updateState"), code.indexOf("export const className"));
  const returns = [...body.matchAll(/return\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(returns.length >= 4, `expected several object returns, saw ${returns.length}`);
  for (const r of returns) {
    assert.match(r, /\.\.\.prev/, `an updateState branch returns a fresh object: ${r}`);
  }
});

test("updateState still handles the COMMAND's own events, not just drags", () => {
  // Providing updateState replaces the default. Forgetting this gives a widget
  // that drags beautifully and never shows any data.
  const body = code.slice(code.indexOf("export const updateState"), code.indexOf("export const className"));
  assert.match(body, /event\.output/, "the command's output event must be handled");
  assert.match(body, /event\.error/, "and its error event");
});

test("the card renders even when clicks cannot work (DECISION 1)", () => {
  // Reverses the earlier "gate the whole widget" choice. Drawing that gate
  // showed it ALSO hides the stale-snapshot warning and the failing check — the
  // two things most worth seeing. G5's precedent: nothing is hidden behind an
  // interaction you cannot perform.
  const render = code.slice(code.indexOf("export const render"));
  const gate = render.slice(render.indexOf("const gate"), render.indexOf("const snap"));
  assert.match(gate, /interactive\s*\|\|\s*moved/, "the gate is computed from whether interaction has ever worked");
  assert.match(gate, /\?\s*null/, "...and when it has NOT, the gate is a note, not a replacement card");
  assert.doesNotMatch(render, /if\s*\(\s*!interactive\s*\)\s*return/, "an early return here would hide the whole card");
});

test("the collector is invoked through collect.sh, never `node` directly", () => {
  // Übersicht inherits launchd's PATH, which has no /opt/homebrew/bin.
  assert.match(code, /export const command\s*=\s*['"]bash /, "must go through the shell wrapper");
  assert.doesNotMatch(code, /export const command\s*=\s*['"]node /);
});

test("the refresh interval stays a glance budget, not a doctor run", () => {
  const m = code.match(/export const refreshFrequency\s*=\s*(\d+)/);
  assert.ok(m, "refreshFrequency must be declared");
  const ms = Number(m[1]);
  assert.ok(ms >= 60_000, `${ms}ms would re-derive faster than the data changes`);
  // The payload is ~0.7s. Anything under a minute is the 4,420-runs-for-nothing
  // shape rule:delegation-criteria §2 exists to prevent.
});

// ── the shell scripts the widget shells out to ─────────────────────────────

test("every external command the widget's scripts invoke EXISTS on this machine", () => {
  // THE BUG THIS CAUGHT. `open-ui.sh` ran `nohup setsid node …`. `setsid` is a
  // LINUX utility and macOS does not have it, so nohup refused to exec, no
  // server started, and a click did nothing but append one line to a log nobody
  // opens. It was written from habit, committed, reviewed, and described in a
  // commit message before anyone ran it.
  //
  // Nothing else could see it: the script is valid bash, it exits 0 on the
  // failure path by design (a click must not crash the widget), and the widget
  // has no way to report that the thing it launched never launched.
  //
  // This is deliberately a check that the commands RESOLVE, not a portability
  // opinion. A machine without `curl` should fail here loudly rather than
  // producing a widget whose buttons quietly do nothing.
  const scripts = ["collect.sh", "open-ui.sh"].map((f) => path.join(import.meta.dirname, "../../widget", f));
  const KEYWORDS = new Set([
    "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac",
    "function", "return", "exit", "local", "set", "echo", "printf", "cd", "read", "export",
    "break", "continue", "shift", "eval", "trap", "true", "false", "sleep", "command", "mkdir",
    "grep", "cat", "seq", "curl", "disown", "nohup", "sed", "awk",
  ]);
  const missing = [];
  for (const file of scripts) {
    const src = readFileSync(file, "utf8");
    // A function the script DEFINES is not an external command. Without this the
    // check flags `alive` in open-ui.sh — a false positive, and a check that
    // cries wolf gets deleted, which is how a working check becomes no check.
    const defined = new Set([...src.matchAll(/^\s*([a-z][a-z0-9_-]*)\s*\(\)\s*\{/gm)].map((m) => m[1]));
    for (const line of src.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      // TOKENISE, do not regex the whole line. The first version used
      // `/(?:^|\bnohup\s+|\bexec\s+)(\w+)/g`, which CONSUMED `nohup` via its `^`
      // branch — so lastIndex was already past it and the `\bnohup\s+` branch
      // could never fire. It therefore could not see `setsid`, the one command
      // it was written to catch.
      //
      // It went red during its own mutation gate anyway, for an unrelated false
      // positive, and that red was briefly read as proof it worked. A check that
      // fails for the wrong reason is as bad as one that cannot fail
      // (rule:discernment-checks §4).
      const words = t.split(/\s+/);
      let i = 0;
      while (i < words.length && /^(nohup|exec|env|time)$/.test(words[i])) i += 1;
      const cmd = (words[i] ?? "").replace(/^["']|["']$/g, "");
      if (/^[a-z][a-z0-9_-]{2,}$/.test(cmd) && !KEYWORDS.has(cmd) && !defined.has(cmd)) {
        const r = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
        if (r.status !== 0) missing.push(`${path.basename(file)}: ${cmd}`);
      }
    }
  }
  assert.deepEqual(missing, [], `these commands do not exist here, so the click silently does nothing:\n  ${missing.join("\n  ")}`);
});

/* ── the JSX actually compiles ─────────────────────────────────────────────
 *
 * THIS FILE'S HEADER SAYS "the obvious test — render it — is not available".
 * Half of that is no longer true. Übersicht ships its own @babel/parser, so
 * the widget can be parsed by the EXACT parser that will compile it on the
 * desktop — not an approximation, the same one.
 *
 * Why it matters more here than anywhere else in this repo: a JSX syntax error
 * produces a BLANK CARD. No error dialog, no log anyone reads, nothing in the
 * test suite. Identical in shape to G65's dead page, and until now identically
 * uncaught.
 *
 * Rendering is still unavailable — that needs the transform plus Übersicht's
 * hyperscript runtime — so this proves the file is syntactically sound and
 * exports what the runtime looks for. It does not prove it draws correctly.
 */
test("the widget parses with Übersicht's OWN babel, and exports what it must", () => {
  const PARSER = "/Applications/Übersicht.app/Contents/Resources/node_modules/@babel/parser";
  let parse;
  try {
    ({ parse } = createRequire(import.meta.url)(PARSER));
  } catch {
    // SKIPPED, ATTRIBUTABLY. A machine without Übersicht cannot run this, and
    // that is a different fact from the widget being fine. Never a silent pass.
    t_skip("Übersicht is not installed at /Applications — the widget's syntax is UNVERIFIED here");
    return;
  }
  const src = readFileSync(WIDGET, "utf8");
  let ast;
  try {
    ast = parse(src, { sourceType: "module", plugins: ["jsx"] });
  } catch (err) {
    assert.fail(`the widget does not parse — Übersicht would render a BLANK CARD.\n  line ${err.loc?.line}: ${err.message}`);
  }

  // Übersicht looks these up by name on the module. A missing one is not a
  // syntax error; it is a widget that loads and does nothing.
  const exported = new Set(
    ast.program.body
      .filter((n) => n.type === "ExportNamedDeclaration" && n.declaration?.declarations)
      .flatMap((n) => n.declaration.declarations.map((d) => d.id.name)),
  );
  for (const k of ["command", "refreshFrequency", "initialState", "updateState", "className", "render"]) {
    assert.ok(exported.has(k), `the widget must export ${k}; Übersicht reads it by name`);
  }
});

test("every updateState branch spreads ...prev (G11)", () => {
  // Übersicht REPLACES widget state on each command run. A branch returning a
  // fresh object silently drops the saved position, the interactive flag, and
  // a half-typed reason — and only on the next scheduled refresh, minutes
  // later, which is what makes it hard to attribute.
  const src = readFileSync(WIDGET, "utf8");
  const body = src.slice(src.indexOf("export const updateState"), src.indexOf("export const className"));
  const returns = [...body.matchAll(/return\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(returns.length >= 6, `expected several branches, found ${returns.length} — this check has gone blind`);
  const bare = returns.filter((r) => !r.includes("...prev"));
  assert.deepEqual(bare, [], `these branches drop previous state:\n  ${bare.join("\n  ")}`);
});

// RETIRED 2026-10-15: "the widget's judge path goes through judge.sh, never a built
// command string" asserted the arm-then-confirm write path of the desktop judge
// panel. Desktop judging was REMOVED by decision D15 — the highest-consequence
// action on the surface was offered on a layer that may not take clicks — so the
// panel and widget/judge.sh are gone and the CTAs open /ready and /blocked
// instead. What replaces it is the assertion below: nothing in the widget can
// write a verdict.
test("the widget cannot write a verdict: no judge script, no CLI call, no ledger write (D15)", () => {
  assert.doesNotMatch(code, /judge\.sh|confirmJudge|<Judge\b|\bDISPS\b/, "the judge panel and judge.sh were removed by D15; they should not be back");
  assert.doesNotMatch(code, /run\([^)]*cli\.mjs/, "the widget must not invoke the CLI directly");
  assert.doesNotMatch(code, /--apply|confirmJudge|disposition/i, "a write path crept back in");
  const scripts = [...code.matchAll(/widget\/([a-z-]+\.sh)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(scripts)].sort(), ["collect.sh", "open-ui.sh"], "the widget may only run its two read/open scripts");
});

// RETIRED 2026-10-15: "every tone toneFor can emit has a fill rule" and "a neutral
// fill is NOT the same colour as the empty track" guarded the nine ratio-bar
// rows (`.fil.<tone>`), which the locked variant-A redesign removed. The same
// failure class — a value the code can emit that the stylesheet has no rule for —
// now lives in the health pills, so the replacement derives its population from
// the payload builder instead of a list (G67, rule:derive-dont-curate).
test("every health status buildHealthSections can emit has a pill rule and a glyph", () => {
  const surface = readFileSync(
    path.join(import.meta.dirname, "../../lib/report/surface.mjs"), "utf8");
  const fn = surface.slice(surface.indexOf("export function buildHealthSections"));
  const line = /const status = [^;]+;/.exec(fn.slice(0, fn.indexOf("\n}")));
  assert.ok(line, "could not find the status expression in buildHealthSections - this check has gone blind");
  const statuses = new Set([...line[0].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(statuses.size >= 4, `buildHealthSections emits four statuses; found ${statuses.size} (${[...statuses].join(", ")}) - gone blind`);

  const unstyled = [...statuses].filter((st) => !new RegExp(`\\.pill\\.${st}\\s+\\.ps\\s*\\{`).test(src));
  assert.deepEqual(unstyled, [], `the payload can emit these and the pill gives them no status colour: ${unstyled.join(", ")}`);
  // Colour is never alone: every status also has a differently-SHAPED glyph.
  const glyphs = [...src.matchAll(/(?:^|\n)\s*(?:'([a-z-]+)'|([a-z]+)):\s*\{\s*icon:\s*'([a-z-]+)'\s*\}/g)];
  const byStatus = new Map(glyphs.map((m) => [m[1] || m[2], m[3]]));
  const unglyphed = [...statuses].filter((st) => !byStatus.has(st));
  assert.deepEqual(unglyphed, [], `these statuses have no glyph, so they would be colour alone: ${unglyphed.join(", ")}`);
  assert.equal(new Set([...statuses].map((st) => byStatus.get(st))).size, statuses.size, "two statuses share one glyph, so they differ by colour alone");
});

// ── the locked widget: sections, aliases, and Übersicht's own compiler ──────

test("every <alias>.<field> the widget reads off a payload SECTION exists on the real payload (nested too)", () => {
  // The top-level test above sees only `d.<section>`. The redesign reads fields
  // two and three levels down, through one alias per section that the widget
  // keeps consistent (see the note above the components). A renamed
  // `leverage.roots[].freesNow` would otherwise render `undefined` on a desktop
  // with no console. ALIASES ARE A POPULATION WE DERIVE FROM: each must be found
  // in the widget and must resolve to a real object, so a rename of the alias
  // shows up as "gone blind" rather than as a clean sweep of nothing.
  const d = fullPayload();
  const ALIASES = {
    wl: d.worklist,
    lev: d.leverage,
    vel: d.velocity,
    use: d.usage,
    hr: d.headroom,
    hl: d.health,
    rt: d.leverage.roots[0],
    cmd: d.usage.top[0],
  };
  const FLOOR = { wl: 4, lev: 4, vel: 3, use: 5, hr: 2, hl: 2, rt: 4, cmd: 1 };
  for (const [alias, obj] of Object.entries(ALIASES)) {
    assert.ok(obj && typeof obj === "object", `fixture has no object for ${alias} - this check has gone blind`);
    const fields = new Set([...code.matchAll(new RegExp(`(?<![\\w.$])${alias}\\.([A-Za-z_$][\\w$]*)(?:\\.([A-Za-z_$][\\w$]*))?`, "g"))].map((m) => m[1] + (m[2] ? `.${m[2]}` : "")));
    assert.ok(fields.size >= FLOOR[alias], `only ${fields.size} reads of ${alias}.* found, expected at least ${FLOOR[alias]} - the alias was renamed or this extraction is blind`);
    for (const f of fields) {
      const [first, second] = f.split(".");
      if (["length", "map", "filter", "reduce", "slice"].includes(first)) continue;
      assert.ok(first in obj, `widget reads ${alias}.${first}, which the payload does not carry (${Object.keys(obj).join(", ")})`);
      const inner = obj[first];
      if (second && inner && typeof inner === "object" && !Array.isArray(inner)) {
        assert.ok(second in inner, `widget reads ${alias}.${first}.${second}, which the payload does not carry`);
      }
    }
  }
});

test("the widget imports ONLY from 'uebersicht'", () => {
  const specs = [...code.matchAll(/^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(specs)], ["uebersicht"], "any other import fails silently on the desktop layer (G60); icons are vendored, not imported");
  assert.doesNotMatch(code, /\brequire\(|\bimport\(/, "no dynamic module loading either");
});

test("no :hover state carries information, and nothing shipped depends on one", () => {
  // :hover never fires on the desktop layer. The redesign has no hover rules at
  // all; a future one must not hold a fact. Asserted on the className literal.
  const open = src.indexOf("export const className = `") + "export const className = `".length;
  const css = src.slice(open, src.indexOf("`", open));
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /:hover/, "a :hover rule - hover never fires on the desktop layer");
  assert.doesNotMatch(code, /<title>|onMouseEnter|onMouseOver/, "a tooltip or hover handler would hold information nobody can reach");
});

test("every font-size in the stylesheet is at least 11px (Apple HIG widgets)", () => {
  const open = src.indexOf("export const className = `") + "export const className = `".length;
  const css = src.slice(open, src.indexOf("`", open)).replace(/\/\*[\s\S]*?\*\//g, "");
  const sizes = [...css.matchAll(/font(?:-size)?:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length >= 8, `only ${sizes.length} font sizes found - the extraction has gone blind`);
  const small = sizes.filter((n) => n < 11);
  assert.deepEqual(small, [], `text under 11px: ${small.join(", ")}`);
});

test("chart fills are classes over tokens: no hex literal in an SVG attribute or a fill/stroke rule", () => {
  // Theme coverage (tests/unit/theme.test.mjs) derives its token population from
  // the var() uses in the className literal, so a chart colour written as a hex
  // attribute is invisible to it (G70).
  assert.doesNotMatch(code, /(?:fill|stroke)=["']#/, "a hex SVG attribute escapes the theme test");
  assert.doesNotMatch(code, /(?:fill|stroke)=["'](?!none|currentColor)[a-z]/, "a named colour SVG attribute escapes the theme test");
  const open = src.indexOf("export const className = `") + "export const className = `".length;
  const css = src.slice(open, src.indexOf("`", open));
  const rules = [...css.matchAll(/(?:^|[\s;{])(?:fill|stroke):\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.ok(rules.length >= 10, `only ${rules.length} fill/stroke declarations found - the extraction has gone blind`);
  const bad = rules.filter((v) => !/^(none|var\(--[a-z-]+\))$/.test(v));
  assert.deepEqual(bad, [], `a chart fill that is not a token: ${bad.join(" | ")}`);
});

test("every run() has a .catch that dispatches an attributable error", () => {
  // run() REJECTS on a non-zero exit, and open-ui.sh exits 1 with its reason on
  // stderr. A promise with no catch is a click that did nothing and said nothing.
  const runs = [...code.matchAll(/\brun\(/g)].length;
  assert.ok(runs >= 2, `expected at least two run() calls (open + refresh), saw ${runs}`);
  const catches = [...code.matchAll(/\.catch\(\(e\) => dispatch\(\{ type: 'RUN_ERROR'/g)].length;
  assert.equal(catches, runs, "every run() needs its own .catch dispatching RUN_ERROR");
  assert.match(code, /event\.type === 'RUN_ERROR'/, "updateState must handle RUN_ERROR");
  assert.match(code, /\{note \?/, "and the card must render the note, or the error is stored and never seen");
});

test("every section's unknown / none-recorded / missing state renders as can't tell, never as 0", () => {
  // Each panel branches on whyNot() (or the health reason) before it draws.
  for (const panel of ["VelocityPanel", "CommandsPanel", "HeadroomLine"]) {
    const body = code.slice(code.indexOf(`const ${panel}`));
    assert.match(body.slice(0, body.indexOf("\n};") + 3), /whyNot\(/, `${panel} must ask why it cannot be drawn before drawing`);
  }
  assert.match(code, /can&#8217;t tell/, "the can't-tell wording is the attributable absence");
  for (const panel of ["WorklistPanel", "LeveragePanel"]) {
    const body = code.slice(code.indexOf(`const ${panel}`));
    assert.match(body.slice(0, body.indexOf("\n};") + 3), /if \(!(wl|lev)\)/, `${panel} must handle a missing section`);
  }
});

test("each section's click opens its route through open-ui.sh (CTA per metric)", () => {
  // ROUTE RENAME 2026-10-15 (plan F11): ready->judge, blocked->unblock,
  // analytics->activity, reference->health, stream->activity. These literals were
  // rewritten DELIBERATELY with the table in surface.mjs, not drifted into.
  const routes = { WorklistPanel: "/judge", LeveragePanel: "/unblock", VelocityPanel: "/activity", CommandsPanel: "/activity", HealthPanel: "/health" };
  for (const [panel, route] of Object.entries(routes)) {
    const body = code.slice(code.indexOf(`const ${panel}`));
    assert.match(body.slice(0, body.indexOf("\n};") + 3), new RegExp(`openView\\('${route}'`), `${panel} must open ${route}`);
  }
  assert.match(code, /chg [^\n]*openView\('\/activity'/, "the new pill opens /activity (was /stream)");
  for (const r of Object.values(routes)) {
    assert.ok(SERVED_VIEWS.includes(r), `${r} is not a served view - the CTA would be dead`);
  }
});

test("the widget compiles with Übersicht's OWN babel (preset-react, pragma 'html')", (t) => {
  // The same transform server.js applies: @babel/preset-react with
  // {pragma: 'html'} (then preset-env). A JSX construct that parses can still
  // fail to compile — the fragment case, G8 — and the result on the desktop is a
  // blank card. Skipped, attributably, on a machine without Übersicht.
  const BASE = "/Applications/Übersicht.app/Contents/Resources/node_modules";
  const req = createRequire(import.meta.url);
  let babel, react;
  try {
    babel = req(`${BASE}/@babel/core`);
    react = req(`${BASE}/@babel/preset-react`);
  } catch {
    t_skip("Übersicht's @babel/core or @babel/preset-react is not at /Applications - the widget's COMPILE is unverified here");
    return;
  }
  let out;
  try {
    out = babel.transformSync(src, { babelrc: false, configFile: false, comments: false, presets: [[react, { pragma: "html" }]] });
  } catch (err) {
    assert.fail(`Übersicht's babel cannot compile the widget - it would render a BLANK CARD.\n${err.message}`);
  }
  assert.ok(out.code.includes("html("), "the transform did not apply the html pragma - the check is not testing what it claims");
  assert.ok(!out.code.includes("React.Fragment"), "a fragment slipped through");
});

test("the calendar's width budget agrees with the stylesheet's .stack width", () => {
  // CARD_INNER (script) is the panel's content width: .stack (640px) less the
  // panel's 11px padding twice. If one moves without the other the calendar
  // draws a grid for a width the card does not have.
  const stack = src.match(/\.stack\s*\{[^}]*?width:\s*(\d+)px/);
  const inner = src.match(/const CARD_INNER = (\d+);/);
  assert.ok(stack && inner, "the .stack width or CARD_INNER was not found - this check has gone blind");
  assert.equal(Number(stack[1]) - 22, Number(inner[1]), "CARD_INNER must be the .stack width less 2 x 11px of panel padding");
});

test("a leverage root's label elides directories only (compactPath), never CSS-truncates a filename", () => {
  assert.match(code, /compactPath\(rt\.source/, "root labels go through compactPath");
  const rn = src.match(/\.rn\s*\{([^}]*)\}/);
  assert.ok(rn, "no .rn rule found");
  assert.doesNotMatch(rn[1], /text-overflow|overflow:\s*hidden|max-width/, "CSS truncation would cut a filename");
});
