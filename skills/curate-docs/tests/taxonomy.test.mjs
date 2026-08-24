import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTaxonomy, TaxonomyUnavailable, propagateCandidates, stalenessRule } from "../lib/taxonomy.mjs";

test("loads propagate's taxonomy and re-exports the surface we depend on", async () => {
  const t = await loadTaxonomy();
  // Assert it came from PROPAGATE, not which subdirectory propagate keeps it in. Pinning
  // the full path is what made this test encode `lib/doc-kind.mjs`, so propagate moving the
  // file to `lib/report/` read as this skill being broken rather than as a relocation.
  //
  // Widened 2026-08-22 (subtree merge, docs/DECISIONS.md): the co-located candidate now
  // resolves inside THIS repo, `propagate-skill/lib/report/doc-kind.mjs` — a path ending in
  // `propagate-skill/`, not `propagate/`. The trailing `-skill` broke the anchored match. The
  // intent is unchanged: assert it came from propagate (co-located, or a standalone
  // `propagate` checkout), never which subdirectory.
  assert.match(t.source, /propagate(-skill)?\/lib\/(report\/)?doc-kind\.mjs$/, t.source);
  assert.equal(typeof t.kindOf, "function");
  assert.ok(Object.keys(t.KINDS).includes("plan"));
});

test("kinds are propagate's, not restated here", async () => {
  // Pinning the full list is the point: this skill consumes propagate's taxonomy
  // rather than keeping its own, so a kind appearing or vanishing upstream must
  // land here as a red test and not as a silent behaviour change.
  //
  // `gotchas` added 2026-08-22, upstream, when `GOTCHAS.md` was registered as the
  // third member of the STATE / DECISIONS / GOTCHAS set. Until then `kindOf()`
  // returned `{kind: null, source: "undeclared"}` for every GOTCHAS.md in the
  // tree. This test failing on that change is the coupling working.
  const t = await loadTaxonomy();
  assert.deepEqual(
    Object.keys(t.KINDS).sort(),
    ["decision-log", "design", "functionality-spec", "gotchas", "issues", "ops", "page-spec", "plan", "router", "state"],
  );
});

test("an absent propagate throws with the paths it tried — never a silent local fallback", async () => {
  // Since the subtree merge (docs/DECISIONS.md 2026-08-22), the co-located candidate
  // (SELF_DIR/../../..) always resolves on THIS checkout, so "propagate is absent" was no
  // longer constructible through env alone — a guard that cannot fire is worse than no guard
  // (rule:discernment-checks §1). loadTaxonomy's third parameter injects a nonexistent
  // co-located anchor too, so this test reaches TaxonomyUnavailable again. Three roots now
  // contribute (co-located, PROPAGATE_SKILL_DIR, home) x two relative paths each = 6.
  await assert.rejects(
    () => loadTaxonomy(
      { PROPAGATE_SKILL_DIR: "/nonexistent/xyz" },
      "/nonexistent/home",
      "/nonexistent/self/anchor/dir",
    ),
    (e) => {
      assert.ok(e instanceof TaxonomyUnavailable);
      assert.match(e.message, /taxonomy: unavailable/);
      assert.equal(e.tried.length, 6);
      assert.match(e.tried[0], /^\/nonexistent\/lib\/report\/doc-kind\.mjs$/);
      return true;
    },
  );
});

test("candidate order puts the CO-LOCATED anchor first, then the env override, then home — and lib/report before lib at each root", () => {
  // Renamed 2026-08-22 (subtree merge, docs/DECISIONS.md): this test used to assert the env
  // override came first. Since the merge, the CO-LOCATED candidate (anchored on this file's
  // own directory, three levels up to the repo root) is checked first — that is the path that
  // resolves on a consumer machine, where PROPAGATE_SKILL_DIR is unset and
  // ~/.claude/skills/propagate is a symlink only the author has (see lib/taxonomy.mjs's
  // "CO-LOCATED FIRST" comment). Three roots x two relative paths = 6. `lib/report/` first at
  // each root because that is where propagate actually keeps doc-kind.mjs since its lib/
  // reorganisation; bare `lib/` retained so an older propagate install still resolves.
  const selfDir = path.dirname(fileURLToPath(new URL("../lib/taxonomy.mjs", import.meta.url)));
  const repoRoot = path.resolve(selfDir, "../../..");
  const c = propagateCandidates({ PROPAGATE_SKILL_DIR: "/a" }, "/h");
  assert.deepEqual(c, [
    path.join(repoRoot, "lib/report/doc-kind.mjs"),
    path.join(repoRoot, "lib/doc-kind.mjs"),
    "/a/lib/report/doc-kind.mjs",
    "/a/lib/doc-kind.mjs",
    "/h/.claude/skills/propagate/lib/report/doc-kind.mjs",
    "/h/.claude/skills/propagate/lib/doc-kind.mjs",
  ]);
});

test("every candidate is reported when none resolves", () => {
  // The relocation that broke this skill was invisible because the module never loaded,
  // so the export-surface assertion could not fire. The error listing EVERY path tried is
  // what makes the next relocation diagnosable instead of a guess.
  const c = propagateCandidates({ PROPAGATE_SKILL_DIR: "/a" }, "/h");
  assert.ok(c.some((p) => p.includes("lib/report/")), "new location must be a candidate");
  assert.ok(c.some((p) => /lib\/doc-kind/.test(p)), "legacy location must remain a candidate");
});

test("plan staleness is a declared-state question, not an age question", () => {
  assert.equal(stalenessRule("plan"), "declared-state");
  assert.equal(stalenessRule("page-spec"), "age");
  assert.equal(stalenessRule("decision-log"), "append-only");
  assert.equal(stalenessRule(null), "none", "undeclared is a value, never a silence");
});
