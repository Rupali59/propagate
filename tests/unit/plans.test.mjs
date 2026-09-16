/**
 * lib/report/plans.mjs — `propagate plans --check`'s derivation.
 *
 * Covers the four measured defects the module header names (doc-kind's dated
 * corpus narrowing, declaredState's structurally-zero archive branch,
 * seeds[0]-only hub linking, and the precedence rule that decides which of
 * "cited by a hub" and "Status: says done" wins), plus the date gate, root
 * validation three-state, and the classifyPlan() in-repo/external fork.
 *
 * Run: `npm test` (G56 — never bare `node --test`, it writes the production ledger).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  TEMPLATE_LANDED,
  validateRoot,
  walkMarkdown,
  classifyPlan,
  excludedFromPlanDirs,
  extractStatusPhrase,
  classifyStatusPhrase,
  planState,
  goalStateGrade,
  authoredDate,
  checkRoot,
  checkPlans,
  planCounts,
} from "../../lib/report/plans.mjs";

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function put(root, rel, body) {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateRoot — the three-state D5 requires: missing / not-a-directory /
// unreadable must never be confusable with "exists and is empty".
// ─────────────────────────────────────────────────────────────────────────────

test("validateRoot: a nonexistent path is 'missing', naming the path", () => {
  const r = validateRoot("/definitely/does/not/exist/xyz-plans-test");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing");
  assert.match(r.detail, /does\/not\/exist/);
});

test("validateRoot: a file (not a directory) is 'not-a-directory'", () => {
  const dir = tmp("plans-notdir-");
  const file = put(dir, "not-a-dir.md", "hi");
  const r = validateRoot(file);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-a-directory");
});

test("validateRoot: an unreadable directory is 'unreadable', distinct from missing/not-a-directory", () => {
  const dir = tmp("plans-unreadable-");
  const locked = path.join(dir, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const r = validateRoot(locked);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unreadable");
  } finally {
    chmodSync(locked, 0o755); // so the tmp dir can be cleaned up
  }
});

test("validateRoot: an existing, readable, EMPTY directory is ok — a different fact from any bad-root reason", () => {
  const dir = tmp("plans-empty-");
  const r = validateRoot(dir);
  assert.equal(r.ok, true);
  assert.equal(r.reason, undefined, "an ok root carries no reason — that field is reserved for the three bad-root states");
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyPlan — the ONE fork (defect-adjacent: this is what keeps the fork
// from being scattered across callers).
// ─────────────────────────────────────────────────────────────────────────────

test("classifyPlan in-repo: a dated basename under plans/ is a plan", () => {
  const c = classifyPlan("/repo/docs/plans/2026-09-14-example.md", { external: false });
  assert.deepEqual(c, { kind: "plan", basenameDate: "2026-09-14" });
});

test("classifyPlan in-repo: undated basename under plans/ is NOT a plan (doc-kind's own rule)", () => {
  assert.equal(classifyPlan("/repo/docs/plans/README.md", { external: false }), null);
});

test("classifyPlan in-repo: a dated file NOT under plans/ is not a plan", () => {
  assert.equal(classifyPlan("/repo/docs/2026-09-14-notes.md", { external: false }), null);
});

test("classifyPlan external: an undated slug under a plans/ dir IS a plan — 0 of 54 session plans carry a date or frontmatter", () => {
  const c = classifyPlan("/Users/x/.claude/plans/okay-to-make-something-rivest.md", { external: true });
  assert.deepEqual(c, { kind: "plan", basenameDate: null });
});

test("classifyPlan external: a file with no plans/ ancestor is not a plan", () => {
  assert.equal(classifyPlan("/Users/x/.claude/notes/random.md", { external: true }), null);
});

test("excludedFromPlanDirs: reports what doc-kind excluded, and why — defect 1", () => {
  const files = [
    "/repo/docs/plans/2026-09-14-example.md", // classified
    "/repo/docs/plans/README.md",             // excluded: no date
    "/repo/docs/other/2026-09-14-notes.md",   // not under plans/ at all — not counted
  ];
  const excluded = excludedFromPlanDirs(files, false);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].file, "/repo/docs/plans/README.md");
  assert.match(excluded[0].reason, /no YYYY-MM-DD date/);
});

test("excludedFromPlanDirs: always empty for external roots — nothing there is excluded by a second condition", () => {
  const files = ["/x/.claude/plans/anything.md"];
  assert.deepEqual(excludedFromPlanDirs(files, true), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Status: prose — a REFINEMENT, never the primary live/undeclared signal.
// ─────────────────────────────────────────────────────────────────────────────

test("extractStatusPhrase reads the real phrasings this tree actually uses", () => {
  assert.equal(extractStatusPhrase("Status: ACTIVE\nmore text"), "ACTIVE");
  assert.equal(extractStatusPhrase("<!-- Written 2026-08-19. Status: ACTIVE. -->"), "ACTIVE");
  assert.equal(extractStatusPhrase("**Status: done.** Commits abc123."), "done");
  assert.equal(
    extractStatusPhrase("**Status: approved, not started.** Reviewed by /plan-eng-review"),
    "approved, not started",
  );
});

test("extractStatusPhrase returns null when the file states none", () => {
  assert.equal(extractStatusPhrase("# A plan\n\nJust prose, no status line."), null);
});

test("classifyStatusPhrase: finished vocabulary vs live vocabulary vs unrecognised", () => {
  assert.equal(classifyStatusPhrase("done"), "finished");
  assert.equal(classifyStatusPhrase("shipped"), "finished");
  assert.equal(classifyStatusPhrase("ACTIVE"), "live");
  assert.equal(classifyStatusPhrase("approved, not started"), "live", "'approved' is in the live vocabulary");
  assert.equal(classifyStatusPhrase("banana"), null);
  assert.equal(classifyStatusPhrase(null), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// planState — the PRECEDENCE RULE, defects 2 and 3, asserted directly.
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal fixture repo: an entry point (README.md) plus whatever docs are given. */
function fixtureRepo(docs) {
  const root = tmp("plans-fixture-");
  put(root, "README.md", "# hub\n\n" + Object.keys(docs).filter((d) => docs[d].linkFromHub).map((d) => `[x](./${d})`).join("\n"));
  const abs = {};
  for (const [rel, spec] of Object.entries(docs)) {
    abs[rel] = put(root, rel, spec.body);
  }
  return { root, abs };
}

test("planState precedence: hub-linked AND Status says done -> FINISHED, not live", async () => {
  const { buildLinkGraph } = await import("../../skills/curate-docs/lib/link-graph.mjs");
  const cfg = { entryPoints: ["README.md"], hubSeeds: "auto", extraRoots: [], archiveDirs: ["archive", "_archive"] };
  const { root, abs } = fixtureRepo({
    "docs/plans/2026-09-14-a.md": { body: "**Status: done.** Shipped.", linkFromHub: true },
  });
  const file = abs["docs/plans/2026-09-14-a.md"];
  const docs = [root + "/README.md", file];
  const graph = buildLinkGraph(root, { docs, cfg });
  const r = planState(root, file, graph, classifyStatusPhrase(extractStatusPhrase("**Status: done.** Shipped.")));
  assert.equal(r.state, "finished", "Status: overrides an otherwise-live graph read — this is the precedence rule, in the surprising direction");
  assert.equal(r.finishedBy, "status");
});

test("planState precedence: hub-linked, no Status override -> live", async () => {
  const { buildLinkGraph } = await import("../../skills/curate-docs/lib/link-graph.mjs");
  const cfg = { entryPoints: ["README.md"], hubSeeds: "auto", extraRoots: [], archiveDirs: ["archive", "_archive"] };
  const { root, abs } = fixtureRepo({
    "docs/plans/2026-09-14-a.md": { body: "# A\nno status line here.", linkFromHub: true },
  });
  const file = abs["docs/plans/2026-09-14-a.md"];
  const docs = [root + "/README.md", file];
  const graph = buildLinkGraph(root, { docs, cfg });
  const r = planState(root, file, graph, null);
  assert.equal(r.state, "live");
});

test("planState precedence: NOT hub-linked, no Status -> undeclared (never promoted to live by Status alone)", async () => {
  const { buildLinkGraph } = await import("../../skills/curate-docs/lib/link-graph.mjs");
  const cfg = { entryPoints: ["README.md"], hubSeeds: "auto", extraRoots: [], archiveDirs: ["archive", "_archive"] };
  const { root, abs } = fixtureRepo({
    "docs/plans/2026-09-14-a.md": { body: "**Status: ACTIVE**\nnothing links this.", linkFromHub: false },
  });
  const file = abs["docs/plans/2026-09-14-a.md"];
  const docs = [root + "/README.md", file];
  const graph = buildLinkGraph(root, { docs, cfg });
  const r = planState(root, file, graph, classifyStatusPhrase("ACTIVE"));
  assert.equal(r.state, "undeclared", "a live-sounding Status: does not by itself promote an unlinked doc to live — the graph is primary");
});

test("planState precedence: living under archive/ wins over everything else, including a live Status", async () => {
  const { buildLinkGraph } = await import("../../skills/curate-docs/lib/link-graph.mjs");
  const cfg = { entryPoints: ["README.md"], hubSeeds: "auto", extraRoots: [], archiveDirs: ["archive", "_archive"] };
  const { root, abs } = fixtureRepo({
    "docs/plans/archive/2026-09-14-a.md": { body: "**Status: ACTIVE**", linkFromHub: true },
  });
  const file = abs["docs/plans/archive/2026-09-14-a.md"];
  const docs = [root + "/README.md", file];
  const graph = buildLinkGraph(root, { docs, cfg });
  const r = planState(root, file, graph, classifyStatusPhrase("ACTIVE"));
  assert.equal(r.state, "finished");
  assert.equal(r.finishedBy, "archive-dir");
});

test("planState: hub linking is checked against EVERY seed, not just seeds[0] — defect 3", async () => {
  const { buildLinkGraph } = await import("../../skills/curate-docs/lib/link-graph.mjs");
  // Two entry points. The plan is linked from the SECOND one only. A
  // seeds[0]-only check (curate-docs cli.mjs's own bug) would report undeclared;
  // trying every seed must report live.
  const root = tmp("plans-multiseed-");
  put(root, "README.md", "# hub one\nno links here.");
  put(root, "AGENTS.md", "# hub two\n[plan](./docs/plans/2026-09-14-a.md)");
  const file = put(root, "docs/plans/2026-09-14-a.md", "# A");
  const cfg = { entryPoints: ["README.md", "AGENTS.md"], hubSeeds: "auto", extraRoots: [], archiveDirs: ["archive", "_archive"] };
  const docs = [root + "/README.md", root + "/AGENTS.md", file];
  const graph = buildLinkGraph(root, { docs, cfg });
  assert.ok(graph.seeds.length >= 2, "fixture must actually produce more than one seed, or this test proves nothing");
  const r = planState(root, file, graph, null);
  assert.equal(r.state, "live", "the plan is linked from the SECOND seed only — a seeds[0]-only check would miss it");
});

// ─────────────────────────────────────────────────────────────────────────────
// goalStateGrade — conforms / partial / flagged.
// ─────────────────────────────────────────────────────────────────────────────

test("goalStateGrade: Done when + Derived by -> conforms", () => {
  const text = "## Goal state\n**Done when:** x.\n**Derived by:** `node cli.mjs plans --check`\n";
  assert.equal(goalStateGrade(text), "conforms");
});

test("goalStateGrade: Done when + Judgement, not derivable -> conforms (a declared waiver is not a defect)", () => {
  const text = "## Goal state\n**Done when:** x.\n**Judgement, not derivable:** it's a judgement call.\n";
  assert.equal(goalStateGrade(text), "conforms");
});

test("goalStateGrade: Done when, no derivation at all -> partial", () => {
  const text = "## Goal state\n**Done when:** x.\n";
  assert.equal(goalStateGrade(text), "partial");
});

test("goalStateGrade: neither -> flagged", () => {
  assert.equal(goalStateGrade("# A plan\n\nSome prose."), "flagged");
});

// ─────────────────────────────────────────────────────────────────────────────
// authoredDate — basename first (free), evidence.mjs second (degrades, never throws).
// ─────────────────────────────────────────────────────────────────────────────

test("authoredDate: a dated basename is used directly, no git spawn needed", () => {
  const root = tmp("plans-date-basename-");
  const file = put(root, "docs/plans/2026-01-01-x.md", "# x");
  const d = authoredDate(root, file, "2026-01-01");
  assert.deepEqual(d, { date: "2026-01-01", source: "basename" });
});

test("authoredDate: no basename date, no git repo -> falls back to mtime, never throws", () => {
  const root = tmp("plans-date-mtime-");
  const file = put(root, "plans/no-date-slug.md", "# x");
  const when = new Date("2026-02-02T00:00:00Z");
  utimesSync(file, when, when);
  const d = authoredDate(root, file, null);
  assert.equal(d.source, "mtime");
  assert.equal(d.date, "2026-02-02");
});

test("authoredDate: no basename date, a real git repo -> uses the introducing commit", () => {
  const root = tmp("plans-date-git-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  const file = put(root, "plans/no-date-slug.md", "# x");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "add plan"], { cwd: root });
  const d = authoredDate(root, file, null);
  assert.equal(d.source, "git-introduced");
  assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The date gate — TEMPLATE_LANDED, and "every plan in the tree predates it".
// ─────────────────────────────────────────────────────────────────────────────

test("TEMPLATE_LANDED is 2026-09-14 — the .templates/PLAN.md landing date this gate is keyed to", () => {
  assert.equal(TEMPLATE_LANDED, "2026-09-14");
});

test("checkRoot + planCounts: a plan authored BEFORE the gate is exempt, never counted as flagged debt", () => {
  const { root } = fixtureRepo({
    "docs/plans/2026-08-01-old.md": { body: "# old plan, no goal state", linkFromHub: true },
  });
  const report = checkPlans([{ path: root, external: false }]);
  const c = planCounts(report);
  assert.equal(c.exempt, 1);
  assert.equal(c.flagged, 0, "a pre-gate plan must never be graded, even though it plainly lacks a goal state");
});

test("checkRoot + planCounts: a plan authored ON the gate date, lacking a goal state, IS flagged", () => {
  const { root } = fixtureRepo({
    [`docs/plans/${TEMPLATE_LANDED}-new.md`]: { body: "# new plan, no goal state", linkFromHub: true },
  });
  const report = checkPlans([{ path: root, external: false }]);
  const c = planCounts(report);
  assert.equal(c.exempt, 0);
  assert.equal(c.flagged, 1);
});

test("checkRoot + planCounts: a gated, conforming plan is not counted as debt", () => {
  const { root } = fixtureRepo({
    [`docs/plans/${TEMPLATE_LANDED}-new.md`]: {
      body: "## Goal state\n**Done when:** x.\n**Derived by:** `echo ok`\n",
      linkFromHub: true,
    },
  });
  const c = planCounts(checkPlans([{ path: root, external: false }]));
  assert.equal(c.conforms, 1);
  assert.equal(c.flagged, 0);
  assert.equal(c.partial, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// checkRoot — unreadable file is attributable, never a silent 0; empty vs
// invalid roots are different outcomes at the top level too.
// ─────────────────────────────────────────────────────────────────────────────

test("checkRoot: an unreadable plan file is reported, not folded into any class as zero", () => {
  const { root, abs } = fixtureRepo({
    "docs/plans/2026-09-14-locked.md": { body: "# locked", linkFromHub: true },
  });
  const file = abs["docs/plans/2026-09-14-locked.md"];
  chmodSync(file, 0o000);
  try {
    const r = checkRoot({ path: root, external: false });
    const entry = r.plans.find((p) => p.file === file);
    assert.ok(entry, "the file must still appear in the report");
    assert.equal(entry.unreadable, true);
    assert.ok(entry.reason);
  } finally {
    chmodSync(file, 0o644);
  }
});

test("checkRoot: a valid, empty root is reported distinctly from an invalid one", () => {
  const root = tmp("plans-truly-empty-");
  const r = checkRoot({ path: root, external: false });
  assert.equal(r.ok, true);
  assert.equal(r.empty, true);
});

test("checkRoot: an invalid root names the reason and the path, never silently reads as empty", () => {
  const r = checkRoot({ path: "/definitely/not/here/xyz", external: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing");
  assert.equal(r.empty, undefined, "an invalid root has no 'empty' field — conflating the two is exactly what D5 forbids");
});

// ─────────────────────────────────────────────────────────────────────────────
// walkMarkdown — bounded, skip list, absence attributable.
// ─────────────────────────────────────────────────────────────────────────────

test("walkMarkdown: does not skip archive/ or _archive/ — a plan finished by directory must still be found", () => {
  const root = tmp("plans-walk-archive-");
  put(root, "docs/plans/archive/2026-01-01-old.md", "# old");
  const { files } = walkMarkdown(root);
  assert.equal(files.length, 1);
});

test("walkMarkdown: skips node_modules and fixtures directories", () => {
  const root = tmp("plans-walk-skip-");
  put(root, "node_modules/pkg/README.md", "# nope");
  put(root, "tests/fixtures/sample.md", "# nope");
  put(root, "docs/plans/2026-01-01-real.md", "# yes");
  const { files } = walkMarkdown(root);
  assert.deepEqual(files.map((f) => path.relative(root, f)), [path.join("docs", "plans", "2026-01-01-real.md")]);
});

test("walkMarkdown: a subtree past maxDepth is DROPPED, not silently omitted", () => {
  const root = tmp("plans-walk-depth-");
  put(root, "a/b/c/d/e/f/g/h/i/j/deep.md", "# deep");
  const { files, dropped } = walkMarkdown(root, { maxDepth: 2 });
  assert.equal(files.length, 0);
  assert.ok(dropped.length > 0, "a truncated walk must record what it did not reach");
});
