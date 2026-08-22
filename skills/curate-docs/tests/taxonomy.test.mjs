import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTaxonomy, TaxonomyUnavailable, propagateCandidates, stalenessRule } from "../lib/taxonomy.mjs";

test("loads propagate's taxonomy and re-exports the surface we depend on", async () => {
  const t = await loadTaxonomy();
  // Assert it came from PROPAGATE, not which subdirectory propagate keeps it in. Pinning
  // the full path is what made this test encode `lib/doc-kind.mjs`, so propagate moving the
  // file to `lib/report/` read as this skill being broken rather than as a relocation.
  assert.match(t.source, /propagate\/lib\/(report\/)?doc-kind\.mjs$/, t.source);
  assert.equal(typeof t.kindOf, "function");
  assert.ok(Object.keys(t.KINDS).includes("plan"));
});

test("kinds are propagate's, not restated here", async () => {
  const t = await loadTaxonomy();
  assert.deepEqual(
    Object.keys(t.KINDS).sort(),
    ["decision-log", "design", "functionality-spec", "ops", "page-spec", "plan", "router", "state"],
  );
});

test("an absent propagate throws with the paths it tried — never a silent local fallback", async () => {
  await assert.rejects(
    () => loadTaxonomy({ PROPAGATE_SKILL_DIR: "/nonexistent/xyz" }, "/nonexistent/home"),
    (e) => {
      assert.ok(e instanceof TaxonomyUnavailable);
      assert.match(e.message, /taxonomy: unavailable/);
      assert.equal(e.tried.length, 4);
      assert.match(e.tried[0], /^\/nonexistent\/xyz\/lib\/report\/doc-kind\.mjs$/);
      return true;
    },
  );
});

test("candidate order puts the env override first, and lib/report before lib", () => {
  // Two roots x two relative paths. `lib/report/` first at each root because that is
  // where propagate actually keeps doc-kind.mjs since its lib/ reorganisation; bare
  // `lib/` retained so an older propagate install still resolves.
  const c = propagateCandidates({ PROPAGATE_SKILL_DIR: "/a" }, "/h");
  assert.deepEqual(c, [
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
