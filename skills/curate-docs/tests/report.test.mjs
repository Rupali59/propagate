import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { declaredIn } from "../lib/evidence.mjs";
import { verdict } from "../lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "fixtures", "sample-repo");
const CLI = path.join(HERE, "..", "cli.mjs");
const run = (...a) => execFileSync("node", [CLI, ...a], { encoding: "utf8" });

test("the hub is never flagged as its own orphan", () => {
  assert.equal(verdict({ isHub: true, inDegree: 0, hubDistance: 0, kind: "state" }, 30).flag, "ok");
});

test("the header count and the flagged rows agree — one fact, one number", () => {
  const md = run("report", REPO);
  const declared = Number(/\*\*(\d+) orphan\*\*/.exec(md)[1]);
  const flagged = (md.match(/\*\*ORPHAN\*\*/g) ?? []).length;
  assert.equal(declared, flagged);
  assert.equal(declared, 1);
});

test("a path mention must match on a boundary, not as the suffix of a longer path", () => {
  // STATE.md cites `docs/README.md`. The ROOT README.md must not read as declared there.
  const d = declaredIn(REPO, path.join(REPO, "README.md"));
  assert.deepEqual(d.hits, [], "root README.md was falsely reported as named by path");
  assert.deepEqual(d.weak, [], "and not as a weak basename hit either");
  // The doc that IS cited by path is found.
  const r = declaredIn(REPO, path.join(REPO, "docs/README.md"));
  assert.deepEqual(r.hits.map((h) => h.where), ["STATE.md"]);
});

test("a plan linked from the hub declares a state; an unlinked one does not", () => {
  const rows = JSON.parse(run("graph", REPO, "--json"));
  const active = rows.find((r) => r.path === "docs/plans/2026-01-01-active.md");
  const orphan = rows.find((r) => r.path === "docs/plans/2026-01-02-orphan.md");
  assert.equal(active.declaredState.state, "active");
  assert.equal(orphan.declaredState.state, "undeclared");
});

test("without propagate the tool still runs, and NAMES the taxonomy provider in force", () => {
  // Superseded 2026-08-19: the hard exit-3 blocked the skill on any machine without
  // propagate. What was rejected was a SILENT local taxonomy; a declared fallback that
  // announces itself is a different thing (docs/DECISIONS.md).
  //
  // Updated 2026-08-22 (subtree merge, docs/DECISIONS.md): PROPAGATE_SKILL_DIR and HOME
  // alone no longer produce an absent propagate — the CO-LOCATED candidate resolves inside
  // this checkout regardless of either, so this state became genuinely unreachable through
  // env alone (rule:discernment-checks §1, a guard that cannot fire is worse than no guard).
  // cli.mjs's analyse() calls loadTaxonomy() with no arguments, and loadTaxonomy's selfDir
  // default reads CURATE_DOCS_SELF_DIR from env — the same env-only lever a spawned
  // subprocess can pull, since it cannot pass a call-time argument. Setting it here forces
  // the co-located candidate absent too, so all three roots miss and this test still
  // exercises the real "taxonomy: none" rendering path end-to-end through the CLI.
  const out = execFileSync("node", [CLI, "report", REPO], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROPAGATE_SKILL_DIR: "/nonexistent/xyz",
      HOME: "/nonexistent",
      CURATE_DOCS_SELF_DIR: "/nonexistent/self/anchor/dir",
    },
  });
  assert.match(out, /taxonomy: none — every kind undeclared/,
    "absence must be attributable, never a silence (rule:discernment-checks §2)");
  assert.match(out, /markdown files/, "and the graph still works — kinds are not the graph");
});

test("with propagate present the report says so, so the two runs are distinguishable", () => {
  const out = execFileSync("node", [CLI, "report", REPO], { encoding: "utf8" });
  assert.match(out, /taxonomy: propagate/);
});

test("report writes nothing into the repo it measures", () => {
  const before = execFileSync("find", [REPO, "-type", "f"], { encoding: "utf8" });
  run("report", REPO);
  run("orphans", REPO);
  assert.equal(execFileSync("find", [REPO, "-type", "f"], { encoding: "utf8" }), before);
});
