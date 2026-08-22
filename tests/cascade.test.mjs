/**
 * F1 — the load-bearing regression.
 *
 * Proven broken before this phase: hub -> A, A -> {B,C}. Archiving A alone produced two new
 * orphans and one dangling citation, none of them attributed to the action, and the next
 * round would archive B and C in turn. The cause was that archiving removed A's OUTBOUND
 * edges from the graph.
 *
 * The fix is not a graph fix. State moves INTO the file (lib/state.mjs), and an archived doc
 * stays discovered and parsed — exempt from grading, never from contributing edges.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLinkGraph } from "../lib/link-graph.mjs";
import { setStatus } from "../lib/state.mjs";
import { loadConfig } from "../lib/config.mjs";
import { discover } from "../lib/discovery.mjs";

const HOME = mkdtempSync(path.join(tmpdir(), "cd-h-"));

/** hub -> A ; A -> {B, C} */
function tree() {
  const d = mkdtempSync(path.join(tmpdir(), "cd-casc-"));
  mkdirSync(path.join(d, "docs/archive"), { recursive: true });
  writeFileSync(path.join(d, "STATE.md"), "# hub\n- [plan A](./docs/a.md)\n");
  writeFileSync(path.join(d, "docs/a.md"), "# A\nDepends on [B](./b.md) and [C](./c.md).\n");
  writeFileSync(path.join(d, "docs/b.md"), "# B\n");
  writeFileSync(path.join(d, "docs/c.md"), "# C\n");
  return d;
}

const analyse = (d) => {
  const cfg = loadConfig(d, { home: HOME });
  return buildLinkGraph(d, { docs: discover(d, cfg).docs, cfg });
};
const rel = (d, ps) => ps.map((p) => path.relative(d, p).split(path.sep).join("/")).sort();

test("baseline: nothing is orphaned before any action", () => {
  const d = tree();
  const g = analyse(d);
  assert.deepEqual(rel(d, g.orphans), []);
  assert.deepEqual(rel(d, g.detached), []);
});

test("declaring A archived does NOT orphan B and C — the cascade is closed", () => {
  const d = tree();
  setStatus(path.join(d, "docs/a.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  const g = analyse(d);
  assert.deepEqual(rel(d, g.orphans), [], "B and C must keep their inbound edge from the archived A");
  assert.deepEqual(rel(d, g.detached), []);
  assert.deepEqual(rel(d, g.archived), ["docs/a.md"], "A is graded-exempt and reported in its own bucket");
  assert.ok(!rel(d, g.orphans).includes("docs/a.md"), "an archived doc is not an orphan");
});

test("MOVING an archived doc breaks its relative links — and that breakage is ATTRIBUTED", () => {
  // This is why the archival act is `status:`, not `git mv`. Declaring costs nothing;
  // moving rewrites every relative path the doc owns. The tool must not hide either fact.
  const d = tree();
  setStatus(path.join(d, "docs/a.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  renameSync(path.join(d, "docs/a.md"), path.join(d, "docs/archive/a.md"));
  const g = analyse(d);

  assert.deepEqual(rel(d, g.archived), ["docs/archive/a.md"], "still discovered and parsed, not skipped");
  // B and C ARE orphaned now — truthfully, because nothing reaches them any more.
  assert.deepEqual(rel(d, g.orphans), ["docs/b.md", "docs/c.md"]);
  // The point: every one of those is explained by a citation the move broke.
  assert.deepEqual(
    g.ambiguous.map((a) => `${path.relative(d, a.from)} -> ${a.cites}`).sort(),
    ["STATE.md -> ./docs/a.md", "docs/archive/a.md -> ./b.md", "docs/archive/a.md -> ./c.md"],
    "three rows, one cause — the move. Nothing is silently orphaned.",
  );
  // And each one carries the repair.
  assert.deepEqual(
    g.relinkable.map((r) => `${r.cites} => ${path.relative(d, r.suggest)}`).sort(),
    ["./b.md => docs/b.md", "./c.md => docs/c.md", "./docs/a.md => docs/archive/a.md"],
  );
});

test("declaring WITHOUT moving is the archival act, and costs nothing", () => {
  const d = tree();
  setStatus(path.join(d, "docs/a.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  const g = analyse(d);
  assert.deepEqual(rel(d, g.orphans), []);
  assert.deepEqual(g.ambiguous, []);
  assert.deepEqual(g.relinkable, []);
});

test("state survives the move: the archived doc is still archived by its own declaration", () => {
  const d = tree();
  setStatus(path.join(d, "docs/a.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  renameSync(path.join(d, "docs/a.md"), path.join(d, "docs/moved-elsewhere.md"));
  const g = analyse(d);
  assert.deepEqual(rel(d, g.archived), ["docs/moved-elsewhere.md"],
    "state travels with content — this is why it lives in frontmatter and not a directory");
});

test("an archived doc's dangling citation is still reported — exempt from grading, not from checks", () => {
  const d = tree();
  writeFileSync(path.join(d, "docs/a.md"), "# A\n[B](./b.md) [gone](./nope.md)\n");
  setStatus(path.join(d, "docs/a.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  const g = analyse(d);
  assert.equal(g.dangling.filter((x) => x.cites === "./nope.md").length, 1);
});

test("only the ACTUAL sole-caller relationship counts: a second caller protects B", () => {
  const d = tree();
  writeFileSync(path.join(d, "STATE.md"), "# hub\n- [A](./docs/a.md)\n- [B](./docs/b.md)\n");
  setStatus(path.join(d, "docs/a.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  const g = analyse(d);
  assert.equal(g.nodes.get(path.join(d, "docs/b.md")).inDegree, 2);
});
