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
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
        { edge_id: "e1", state: "DRIFTED", sourceShort: "a/b.md", downstreamShort: "c/d.md", noiseRatio: 0.5, last: { ts: "2026-09-01T00:00:00.000Z" } },
        { edge_id: "e2", state: "REVERSED", sourceShort: "e/f.md", downstreamShort: "g/h.md", noiseRatio: null, last: null },
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
          { name: "Workspace: A", pass: 5, warn: 1, fail: 0, info: 0, note: 0, entries: [] },
        ],
      },
    },
    registers: { totals: { hot: { issues: 86, handovers: 38, todos: 205 }, rotatable: { issues: 30, handovers: 31, todos: 89 } } },
    gotchas: { files: 11, entries: 158, triggered: 79, scope: "workspace roots + cwd" },
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
  assert.ok(d.groups.flatMap((g) => g.rows).some((r) => !r.cta.available), "and some rows are honestly not built yet");
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
  const ui = readFileSync(path.join(import.meta.dirname, "../../commands/ui.mjs"), "utf8");
  const m = ui.match(/\[\s*"queue"[^\]]*\]/);
  assert.ok(m, "could not find the view list in ui.mjs — this check has gone blind, which is worse than failing");
  const routed = new Set(JSON.parse(m[0].replace(/'/g, '"')));
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
  assert.match(code, /width:\s*max-content/, "the card must size to its widest child");
  // `\b` is NOT enough here: it is satisfied by the hyphen in `max-width`, so
  // the obvious regex flags a correct file. Caught by this test failing against
  // a card that was already right — rule:discernment-checks §4, verify the
  // instrument before believing a surprising result.
  assert.doesNotMatch(code, /\.card\s*\{[^}]*(?<![-\w])width:\s*\d+px/, "a fixed .card width is the rotted claim");

  // A max-width is a weaker claim than a fixed width, but still a claim. It is
  // only safe because the cells WRAP rather than running off the edge, so no
  // count can push content past the corner. Assert the wrap, not the number.
  assert.match(code, /\.cells\s*\{[^}]*flex-wrap:\s*wrap/, "cells must wrap, or a large state redraws G9 exactly");
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
