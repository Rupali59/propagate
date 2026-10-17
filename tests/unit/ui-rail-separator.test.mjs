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
 * Source-text for the first two, and a real render for the last two. The blind-check below is load-bearing: a regex that stops matching would otherwise
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
    .map((x) => ({ key: x[1], group: (x[0].match(/group:\s*"([^"]+)"/) || [])[1] }));
  assert.ok(rows.length >= 6, `only ${rows.length} divisions parsed — the extraction has gone blind`);
  return rows;
}

/* REWRITTEN 2026-10-17 (Phase 4a, plan "Phase 4"), deliberately and not patched. The rule the separator stands for
   changed a second time. PR-025 pinned a position (`i === 4`); the 2026-10-15 redesign derived the line from an
   `explore: true` flag and pinned the first Explore view at index 5. Phase 4a replaces the two-way split with FIVE
   named groups -- TODAY / SETTLE / MACHINERY / WORK / HISTORY -- so the pins below are no longer "the first Explore
   view is at 5" but "each division belongs to this group, in this order, and a new group starts wherever the group
   value changes". What this file now pins on purpose: the group order, the membership of each group, and that
   FIRST_EXPLORE and the `explore` flag are gone (a second source of truth for the boundary would let them disagree). */

const GROUPS = {
  today: ["overview"],
  settle: ["judge", "unblock"],
  machinery: ["health", "claims", "rules", "caps", "skills"],
  work: ["registers", "reminders"],
  history: ["activity", "graph"],
};

test("the rail separator is derived from each division's group, never from a position or an Explore flag", () => {
  // The literal is what PR-025 removed. If it comes back, so does the defect.
  assert.doesNotMatch(src, /\$\{i === \d+ \?/, "the rail separator compares i against a number again — derive it from the data instead");
  assert.doesNotMatch(src, /FIRST_EXPLORE/, "the two-way boundary is gone; a second source of truth for it would let the two disagree");
  assert.doesNotMatch(src, /explore:\s*true/, "a division still carries the Explore flag the groups replaced");
  assert.match(src, /railGroups\(DIVISIONS\)\.map\(/);
});

test("the divisions fall into TODAY / SETTLE / MACHINERY / WORK / HISTORY, in that order, with the stated members", () => {
  const d = divisions();
  assert.ok(d.every((x) => x.group), "a division has no group: " + JSON.stringify(d.filter((x) => !x.group)));
  const order = [];
  for (const x of d) if (order[order.length - 1] !== x.group) order.push(x.group);
  assert.deepEqual(order, Object.keys(GROUPS), "the groups are contiguous and in rail order (a group appearing twice would repeat its label)");
  for (const [g, keys] of Object.entries(GROUPS)) {
    assert.deepEqual(d.filter((x) => x.group === g).map((x) => x.key), keys, `group ${g}`);
  }
});

test("inserting a view into the middle MOVES the boundary instead of leaving it behind -- which a literal index could not do", async () => {
  const { mountClient } = await import("../helpers/mount-client.mjs");
  const { ui } = await mountClient({ inbox: { fatal: "x", divisions: null }, hash: "#/judge",
    routes: { "/api/surface": {}, "/api/seen-edges": { ok: true, status: "ok", triples: [] } } });
  const keysOf = (gs) => Array.from(gs, (g) => g.key + ":" + Array.from(g.items, (i) => i.key).join(","));
  const real = keysOf(ui.railGroups(ui.DIVISIONS));
  assert.equal(real.length, 5);
  // The exact edit that would have broken the old code: a view added in the middle of an existing group.
  const mutated = [ui.DIVISIONS[0], { key: "injected", label: "X", group: "today" }, ...ui.DIVISIONS.slice(1)];
  const after = keysOf(ui.railGroups(mutated));
  assert.equal(after[0], "today:overview,injected", "the new view joined its own group; no other label moved");
  assert.deepEqual(after.slice(1), real.slice(1));
  // And a group that appears twice is NOT merged: it repeats its label, which the order test above forbids.
  const split = keysOf(ui.railGroups([ui.DIVISIONS[0], ui.DIVISIONS[1], { key: "z", label: "Z", group: "today" }]));
  assert.equal(split.length, 3, "non-contiguous members start a new group");
});

test("the rail the client actually renders: five labels in order, a rule above every label but the first, each view under its own label", async () => {
  // The tests above read SOURCE TEXT. This one renders, because a regex that still matches a line the template no
  // longer executes would pass over a wrong rail.
  const { mountClient } = await import("../helpers/mount-client.mjs");
  const { byClass, byTag, textOf } = await import("../helpers/minidom.mjs");
  const { app } = await mountClient({ inbox: { fatal: "x", divisions: null }, hash: "#/judge",
    routes: { "/api/surface": {}, "/api/seen-edges": { ok: true, status: "ok", triples: [] } } });
  const nav = byTag(app, "nav")[0];
  const kids = nav.childNodes.filter((n) => n.nodeType === 1).map((n) => (n.localName === "hr" ? "|" : /\blbl\b/.test(n.getAttribute("class") || "") ? "LBL:" + textOf(n) : "B:" + textOf(n).replace(/\d+$/, "")));
  assert.equal(byClass(nav, "lbl").length, 5, JSON.stringify(kids));
  const flat = kids.join(" ");
  assert.equal(flat, [
    "LBL:today B:OVERVIEW", "| LBL:settle B:JUDGE B:UNBLOCK", "| LBL:machinery B:HEALTH B:CLAIMS B:RULES B:CAPS B:SKILLS",
    "| LBL:work B:REGISTERS B:REMINDERS", "| LBL:history B:ACTIVITY B:GRAPH",
  ].join(" "));
});
