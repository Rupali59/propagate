// @size small — temp-dir rule fixtures, no network, no git
/**
 * #218: rule load tiers. Each case below is a literal rule file written to a temp rules dir. They are not built
 * through a helper that knows the valid shape (rule:mutate-behind-the-fixture-builder): the hostile cases are the point.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkLoadTiers, actualTier } from "../../lib/rules/load-tier.mjs";

const RULE_ALWAYS = "---\nid: a\nscope: global\nstatus: active\nload: always\nfingerprint: \"aaa\"\n---\nBody of a, which cites rule:b.\n";
const RULE_SCOPED = "---\nid: b\nscope: global\nstatus: active\nload: scoped\nfingerprint: \"bbb\"\npaths:\n  - \"**/*.test.*\"\n---\nBody of b, which cites rule:a.\n";

function dir(files) {
  const d = mkdtempSync(path.join(tmpdir(), "load-tier-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    writeFileSync(path.join(d, rel), body);
  }
  return d;
}
const run = (files, opts = {}) => {
  const d = dir(files);
  try { return checkLoadTiers({ rulesDir: d, ...opts(d) }); } finally { rmSync(d, { recursive: true, force: true }); }
};
const opts0 = () => ({});

test("a correctly declared always rule and scoped rule pass, and are counted by tier", () => {
  const r = run({ "a.md": RULE_ALWAYS, "b.md": RULE_SCOPED }, opts0);
  assert.deepEqual(r.failures, []);
  assert.equal(r.counts.always, 1);
  assert.equal(r.counts.scoped, 1);
});

test("declaring scoped with no paths: fails: Claude Code loads it at every session start", () => {
  const r = run({ "a.md": RULE_ALWAYS.replace("load: always", "load: scoped") }, opts0);
  assert.match(r.failures.join("\n"), /declares `load: scoped` but it has no paths:/);
});

test("broken YAML fails: Claude Code then loads the rule as if it had no paths", () => {
  const broken = "---\nid: c\nload: scoped\npaths: [unclosed\n---\nBody.\n";
  assert.equal(actualTier(broken).tier, "always");
  const r = run({ "c.md": broken }, opts0);
  assert.match(r.failures.join("\n"), /frontmatter does not parse/);
});

test("a missing load: fails and names the expected tier", () => {
  const r = run({ "a.md": RULE_ALWAYS.replace("load: always\n", "") }, opts0);
  assert.match(r.failures.join("\n"), /no `load:` declared; expected `load: always`/);
});

test("a user-level glob without a leading **/ fails: it would match from one working directory only", () => {
  const r = run({ "b.md": RULE_SCOPED.replace('"**/*.test.*"', '"tests/*.test.*"') }, opts0);
  assert.match(r.failures.join("\n"), /does not start with \*\*\//);
});

test("a companion with no parent rule fails; one declared scoped instead of companion fails", () => {
  const ev = "---\nload: companion\npaths:\n  - \"**/*.test.*\"\n---\nEvidence.\n";
  const orphan = run({ "x.evidence.md": ev }, opts0);
  assert.match(orphan.failures.join("\n"), /companion without a parent rule/);
  const mislabelled = run({ "b.md": RULE_SCOPED, "b.evidence.md": ev.replace("load: companion", "load: scoped") }, opts0);
  assert.match(mislabelled.failures.join("\n"), /an \*\.evidence\.md file is a companion/);
});

test("an excluded file needs no load:, and is counted as excluded", () => {
  const r = run({ "a.md": RULE_ALWAYS, "conventions/HISTORY.md": "no frontmatter at all\n" }, (d) => ({ excludes: [path.join(d, "conventions/**")] }));
  assert.deepEqual(r.failures, []);
  assert.equal(r.counts.excluded, 1);
});

test("an empty rules dir is a blind scan, not a pass", () => {
  const r = run({}, opts0);
  assert.match(r.failures.join("\n"), /0 rule files .* the scan is blind/);
});

test("precedence: a pair stated in both bodies passes; a one-sided pair fails on the side that does not cite", () => {
  const reg = "pairs:\n  - winner: a\n    loser: b\n    when: test\n";
  const both = run({ "a.md": RULE_ALWAYS, "b.md": RULE_SCOPED, "conventions/PRECEDENCE.yml": reg }, opts0);
  assert.deepEqual(both.failures, []);
  const oneSided = run({ "a.md": RULE_ALWAYS, "b.md": RULE_SCOPED.replace("rule:a", "nothing"), "conventions/PRECEDENCE.yml": reg }, opts0);
  assert.match(oneSided.failures.join("\n"), /b\.md does not cite rule:a/);
});

test("a promotion to always is reported against HEAD, and an unchanged tier is not", () => {
  const headScoped = (rel) => (rel === "a.md" ? RULE_SCOPED.replace("id: b", "id: a") : null);
  const r = run({ "a.md": RULE_ALWAYS }, () => ({ headReader: headScoped }));
  assert.match(r.promotions.join("\n"), /a\.md: promoted scoped -> always/);
  const same = run({ "a.md": RULE_ALWAYS }, () => ({ headReader: () => RULE_ALWAYS }));
  assert.deepEqual(same.promotions, []);
});
