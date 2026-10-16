/**
 * ui-rail-separator.test.mjs — PR-025.
 *
 * The rail's group separator was `i === 4`: a position standing in for a rule.
 * It rendered correctly and nothing asserted where it landed, so inserting any
 * division above index 4 would have moved the "reference" label onto the wrong
 * group silently. The CHANGED division was inserted at index 5 on 2026-09-25
 * and missed it by one.
 *
 * Deliberately its own file rather than an addition to ui-client.test.mjs,
 * which PR-008 records as intermittently failing across six test names — a new
 * assertion in there would inherit a flake it has nothing to do with.
 *
 * Source-text, because the rail has no headless renderer here. That makes the
 * blind-check below load-bearing: a regex that stops matching would otherwise
 * report a clean sweep of nothing (rule:enforcement-watches-itself §4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(path.join(REPO, "commands", "ui.client.js"), "utf8");

/** The DIVISIONS literal, as the shipped file declares it. */
function divisions() {
  const m = src.match(/const DIVISIONS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, "DIVISIONS not found in ui.client.js — this check has gone blind");
  const rows = [...m[1].matchAll(/\{[^}]*key:\s*"([^"]+)"[^}]*\}/g)]
    .map((x) => ({ key: x[1], explore: /explore:\s*true/.test(x[0]) }));
  assert.ok(rows.length >= 6, `only ${rows.length} divisions parsed — the extraction has gone blind`);
  return rows;
}

/* REWRITTEN 2026-10-15 (plan F11), deliberately. The rule the separator stands for
   changed with the redesign: it used to divide "actionable" from "reference" and
   was pinned at index 4 (`analytics`). It now divides the four task views from the
   Explore set, and is pinned at 4 again -- but on `registers`, and derived from
   `explore: true` rather than from `act`. Health and Activity are not actionable
   and sit ABOVE the line, which is exactly why reusing `act` would have been wrong. */

test("the rail separator is derived from the Explore flag, never from a position", () => {
  // The literal is what PR-025 removed. If it comes back, so does the defect.
  assert.doesNotMatch(
    src,
    /\$\{i === \d+ \?/,
    "the rail separator compares i against a number again — derive it from the data instead",
  );
  assert.match(src, /const FIRST_EXPLORE = DIVISIONS\.findIndex\(/);
  assert.match(src, /\$\{i === FIRST_EXPLORE \?/);
});

test("the derived boundary lands on the first Explore view, with every task view above it", () => {
  const d = divisions();
  const first = d.findIndex((x) => x.explore);
  // 5 since 2026-10-16: Overview joined the task views above the boundary (Overview, then Judge,
  // Unblock, Health, Activity). The separator is derived; this pin says which side each view is on.
  assert.equal(first, 5, `expected the first Explore view at 5, got ${first} (${d[first]?.key})`);
  assert.equal(d[first].key, "registers");
  assert.deepEqual(d.slice(0, first).map((x) => x.key), ["overview", "judge", "unblock", "health", "activity"]);
  assert.ok(d.slice(0, first).every((x) => !x.explore), "a task view carries the Explore flag");
  assert.ok(d.slice(first).every((x) => x.explore), "an Explore view is missing the flag, so it would render above the line");
});

test("inserting a view above the boundary MOVES it — which a literal 4 could not do", () => {
  const d = divisions();
  const before = d.findIndex((x) => x.explore);

  // The exact edit that would have broken the old code: an Explore view added above
  // the existing boundary.
  const mutated = [...d.slice(0, 2), { key: "injected", explore: true }, ...d.slice(2)];
  const after = mutated.findIndex((x) => x.explore);

  assert.equal(after, 2, "the derived boundary must follow the data");
  assert.notEqual(after, before, "if it did not move, this test proves nothing");
  assert.equal(mutated[after].key, "injected");
});

test("the rail the client actually renders puts its label before the first Explore view", async () => {
  // The three above read SOURCE TEXT. This one renders, because a regex that still
  // matches a line the template no longer executes would pass over a wrong rail.
  const { mountClient } = await import("../helpers/mount-client.mjs");
  const { byClass, byTag, textOf } = await import("../helpers/minidom.mjs");
  const { app, ui } = await mountClient({ inbox: { fatal: "x", divisions: null }, hash: "#/judge",
    routes: { "/api/surface": {}, "/api/seen-edges": { ok: true, status: "ok", triples: [] } } });
  const nav = byTag(app, "nav")[0];
  const kids = nav.childNodes.map((n) => (n.nodeType === 1 ? (n.localName === "hr" ? "|" : byClass(n, "lbl").length || /\blbl\b/.test(n.getAttribute("class") || "") ? "LBL:" + textOf(n) : "B:" + textOf(n)) : "")).filter(Boolean);
  const at = kids.indexOf("LBL:explore");
  assert.ok(at > 0, `no explore label in the rail: ${JSON.stringify(kids)}`);
  assert.equal(kids[at - 1], "|", "the rule sits directly above the label");
  assert.match(kids[at + 1], /REGISTERS/, "and the first Explore view directly below it");
  assert.equal(ui.FIRST_EXPLORE, 5); // Overview is a task view (2026-10-16)
});
