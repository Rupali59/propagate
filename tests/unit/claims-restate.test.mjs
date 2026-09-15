/**
 * lib/claims/restate.mjs — Phase 2a: hold a rule's own text against the copy of
 * it a `CLAUDE.md` restates. Same mould as `claims-contradict.test.mjs`, one
 * substitution: the derived fact is a rule's canonical body, not a rollup
 * count, and the corpus is HANDED TO US by `checkRules`'s
 * `referencedRestatements` rather than searched for.
 *
 * WHY NO HARDCODED "15" HERE. The live tree really does enumerate to exactly
 * 15 pairs today (verified manually against `~/Documents/GitHub` while
 * building this) — 5 pair cleanly, 10 land inside headings/tables/comments
 * that merely CONTAIN a fingerprint substring (e.g. a path literally named
 * `.code-review-graph`, or a heading "## MCP: code-review-graph") and are
 * correctly reported UNPAIRED rather than judged as if they were prose. But
 * that count is a fact about OTHER PEOPLE'S files, changing on every edit to
 * any of 15 CLAUDE.md files this repo does not own — baking it into a
 * permanent assertion is the exact "a count rots faster than anything else"
 * hazard `rule:state-and-decisions` names. So the live count is verified by
 * running the CLI (`claims restate --json`) and reported once, in the session
 * that built this; the tests below assert the INVARIANT the plan actually
 * needs — every corpus entry lands in judged, unjudged or unpaired, exhaustively
 * and without overlap — against small, controlled fixtures that will not rot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { deriveRuleFact, restatementPairs, restateStatus, asQuestions } from "../../lib/claims/restate.mjs";
import { checkRules } from "../../lib/rules/rules-check.mjs";

const RULE_MD = (id, fingerprint, body) =>
  `---\nid: ${id}\nscope: global\nstatus: active\nfingerprint: "${fingerprint}"\n---\n\n${body}\n`;

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-restate-"));
  const rulesDir = path.join(dir, "rules");
  const tree = path.join(dir, "tree");
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(tree, { recursive: true });
  return {
    dir,
    rulesDir,
    tree,
    rule: (id, fp, body) => {
      writeFileSync(path.join(rulesDir, `${id}.md`), RULE_MD(id, fp, body));
      return path.join(rulesDir, `${id}.md`);
    },
    claudeMd: (rel, body) => {
      const p = path.join(tree, rel, "CLAUDE.md");
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
      return p;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

// Empty readClaims stub — every fixture test below cares about pairing, not
// the verdict store, so this keeps `restateStatus` from touching real disk.
const NO_CLAIMS = async () => ({ claims: [], storeExists: false });

// ── failing input 1 (required): a drifted copy still gets paired ───────────

test("a restatement whose copy has DRIFTED from the rule still pairs, so the caller can judge it", async () => {
  const f = fixture();
  try {
    f.rule(
      "tool-priority",
      "purpose-built tool",
      "Always reach for a purpose-built tool before Grep, and check freshness first.",
    );
    // Cites AND restates -- but the restated copy dropped the freshness clause
    // entirely, which is exactly the "half-finished conversion" shape N35
    // describes: the copy and the canon have silently diverged.
    const file = f.claudeMd(
      "drifted",
      "# X\n\nTool priority: `rule:tool-priority`.\n\n" +
        "Always reach for a purpose-built tool before Grep. No need to check freshness.\n",
    );
    const rc = checkRules({ rulesDir: f.rulesDir, roots: [f.tree] });
    assert.equal(rc.referencedRestatements.length, 1, "the corpus must hand us this pair");

    const { pairs, unpaired } = restatementPairs(rc.referencedRestatements, rc.rules);
    assert.equal(unpaired.length, 0, "a real restatement, however drifted, must not be UNPAIRED");
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].file, file);
    assert.equal(pairs[0].rule, "tool-priority");
    assert.match(pairs[0].claim.text, /No need to check freshness/, "the ACTUAL drifted copy, not the canon");
    assert.match(pairs[0].fact.text, /check freshness first/, "the fact is the rule's OWN text, unmodified");
    assert.notEqual(
      pairs[0].claim.text.replace(/\s+/g, " ").trim(),
      pairs[0].fact.text.replace(/\s+/g, " ").trim(),
      "claim and fact must actually differ — that is the whole reason this is worth judging",
    );

    const status = await restateStatus(rc.referencedRestatements, rc.rules, { readClaims: NO_CLAIMS });
    assert.equal(status.judged.length, 0);
    assert.equal(status.unjudged.length, 1, "nobody has judged it yet, so it must be a live question");
    const questions = asQuestions(status);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].rule, "tool-priority");
    assert.match(questions[0].claim, /No need to check freshness/);
    assert.match(questions[0].fact, /check freshness first/);
  } finally {
    f.cleanup();
  }
});

// ── failing input 2 (required): citation exists, no restatement nearby ─────

test("a corpus entry pointing at a citation with no restatement is UNPAIRED, never silently dropped", async () => {
  const f = fixture();
  try {
    const ruleFile = f.rule("tool-priority", "purpose-built tool", "Always use a purpose-built tool before Grep.");
    const file = f.claudeMd("clean", "# X\n\nTool priority: `rule:tool-priority`. Nothing else here.\n");

    // Hand-construct the corpus entry rather than getting it from `checkRules`,
    // because `checkRules` would (correctly) never emit this pair — a file that
    // only cites the rule produces no `referencedRestatements` entry at all
    // (see rules-check.test.mjs: "a file that only references a rule is NOT
    // counted"). This simulates the real hazard the plan calls out: a corpus
    // entry that is STALE by the time the lane reads it (the restatement was
    // deleted after the corpus was computed, leaving only the citation), or an
    // upstream bug that hands us a line that never restated anything.
    const staleCorpus = [{ rule: "tool-priority", file, line: 3 }];
    const rules = [{ id: "tool-priority", fingerprint: "purpose-built tool", __file: ruleFile }];

    const { pairs, unpaired } = restatementPairs(staleCorpus, rules);
    assert.equal(pairs.length, 0, "must not fabricate a pair against text that isn't a restatement");
    assert.equal(unpaired.length, 1, "must be reported, not dropped");
    assert.equal(unpaired[0].rule, "tool-priority");
    assert.equal(unpaired[0].file, file);
    assert.match(unpaired[0].reason, /fingerprint no longer matches/i);

    const status = await restateStatus(staleCorpus, rules, { readClaims: NO_CLAIMS });
    assert.equal(status.corpusCount, 1);
    assert.equal(status.judged.length + status.unjudged.length, 0);
    assert.equal(status.unpaired.length, 1, "the caller-visible status must carry it too");
  } finally {
    f.cleanup();
  }
});

// ── other ways a pair cannot be formed — each must be reported, not dropped ─

test("a fingerprint hit inside a heading is structure, not a claim — UNPAIRED", async () => {
  // The exact shape found live against the real tree: `## MCP: code-review-graph`
  // matches `tool-priority`'s fingerprint by bare substring, but a section title
  // naming a tool is not a restatement of the rule about using it.
  const f = fixture();
  try {
    const ruleFile = f.rule("tool-priority", "code-review-graph", "Run code-review-graph status first.");
    const file = f.claudeMd("headed", "# X\n\n## MCP: code-review-graph\n\nSee `rule:tool-priority`.\n");
    const rc = checkRules({ rulesDir: f.rulesDir, roots: [f.tree] });
    assert.equal(rc.referencedRestatements.length, 1, "the parent detector does find this — that is the point");
    const { pairs, unpaired } = restatementPairs(rc.referencedRestatements, rc.rules);
    assert.equal(pairs.length, 0);
    assert.equal(unpaired.length, 1);
    assert.match(unpaired[0].reason, /heading/);
  } finally {
    f.cleanup();
  }
});

test("a corpus entry naming an unknown rule is UNPAIRED with a reason, not a throw", () => {
  const f = fixture();
  try {
    const file = f.claudeMd("orphan", "# X\nsomething\n");
    const corpus = [{ rule: "does-not-exist", file, line: 1 }];
    const { pairs, unpaired } = restatementPairs(corpus, []);
    assert.equal(pairs.length, 0);
    assert.equal(unpaired.length, 1);
    assert.match(unpaired[0].reason, /not among the loaded rules/);
  } finally {
    f.cleanup();
  }
});

test("an unreadable restating file is UNPAIRED with a reason, not a throw", () => {
  const f = fixture();
  try {
    const ruleFile = f.rule("tool-priority", "purpose-built tool", "Use a purpose-built tool.");
    const rules = [{ id: "tool-priority", fingerprint: "purpose-built tool", __file: ruleFile }];
    const corpus = [{ rule: "tool-priority", file: path.join(f.tree, "nope", "CLAUDE.md"), line: 1 }];
    const { pairs, unpaired } = restatementPairs(corpus, rules);
    assert.equal(pairs.length, 0);
    assert.equal(unpaired.length, 1);
    assert.match(unpaired[0].reason, /unreadable/);
  } finally {
    f.cleanup();
  }
});

test("an unreadable rule file is UNPAIRED with a reason, not a throw", () => {
  const f = fixture();
  try {
    const file = f.claudeMd("x", "# X\nsomething\n");
    const rules = [{ id: "ghost", fingerprint: "anything", __file: path.join(f.rulesDir, "ghost.md") }];
    const corpus = [{ rule: "ghost", file, line: 1 }];
    const { pairs, unpaired } = restatementPairs(corpus, rules);
    assert.equal(pairs.length, 0);
    assert.equal(unpaired.length, 1);
    assert.match(unpaired[0].reason, /rule file unreadable/);
  } finally {
    f.cleanup();
  }
});

// ── the exhaustive-partition invariant the plan's verification asks for ────

test("every corpus entry lands in exactly one of pairs/unpaired — the partition is exhaustive", async () => {
  const f = fixture();
  try {
    const ruleFile = f.rule("tool-priority", "purpose-built tool", "Use a purpose-built tool before Grep.");
    const good = f.claudeMd("good", "# X\n\nTool priority: `rule:tool-priority`.\n\nUse a purpose-built tool before Grep.\n");
    const headed = f.claudeMd("headed", "# X\n\n## purpose-built tool\n\nSee `rule:tool-priority`.\n");
    const rc = checkRules({ rulesDir: f.rulesDir, roots: [f.tree] });
    assert.equal(rc.referencedRestatements.length, 2, "both files hand us a corpus entry");

    const status = await restateStatus(rc.referencedRestatements, rc.rules, { readClaims: NO_CLAIMS });
    assert.equal(status.corpusCount, 2);
    assert.equal(
      status.judged.length + status.unjudged.length + status.unpaired.length,
      status.corpusCount,
      "every entry classified exactly once — none dropped, none double-counted",
    );
  } finally {
    f.cleanup();
  }
});

// ── verdict lookup, keyed by (file, block_sha, against) ─────────────────────

test("an existing verdict for the exact (file, claim, fact) triple reads as judged", async () => {
  const f = fixture();
  try {
    const ruleFile = f.rule("tool-priority", "purpose-built tool", "Use a purpose-built tool before Grep.");
    const file = f.claudeMd("good", "# X\n\nTool priority: `rule:tool-priority`.\n\nUse a purpose-built tool before Grep.\n");
    const rc = checkRules({ rulesDir: f.rulesDir, roots: [f.tree] });
    const { pairs } = restatementPairs(rc.referencedRestatements, rc.rules);
    assert.equal(pairs.length, 1);
    const p = pairs[0];

    const readClaims = async () => ({
      claims: [{ file, block_sha: p.claim.sha, against: p.fact.sha, finding: "consistent", ts: "2026-01-01T00:00:00.000Z", claim_id: "01A" }],
      storeExists: true,
    });
    const status = await restateStatus(rc.referencedRestatements, rc.rules, { readClaims });
    assert.equal(status.judged.length, 1, "must match by file + block_sha + against");
    assert.equal(status.unjudged.length, 0);
    assert.equal(status.judged[0].verdict.finding, "consistent");
  } finally {
    f.cleanup();
  }
});

test("a verdict recorded for a DIFFERENT file with the same block/fact hashes does not count", async () => {
  // Guards the reason `file` is part of the key: two files could carry
  // byte-identical restated text (same block_sha) against the same rule (same
  // fact sha), and a verdict about one must not silently cover the other.
  const f = fixture();
  try {
    const ruleFile = f.rule("tool-priority", "purpose-built tool", "Use a purpose-built tool before Grep.");
    const body = "# X\n\nTool priority: `rule:tool-priority`.\n\nUse a purpose-built tool before Grep.\n";
    const fileA = f.claudeMd("a", body);
    const fileB = f.claudeMd("b", body); // byte-identical restated block
    const rc = checkRules({ rulesDir: f.rulesDir, roots: [f.tree] });
    assert.equal(rc.referencedRestatements.length, 2);
    const { pairs } = restatementPairs(rc.referencedRestatements, rc.rules);
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].claim.sha, pairs[1].claim.sha, "identical prose hashes identically");

    const readClaims = async () => ({
      claims: [{ file: fileA, block_sha: pairs[0].claim.sha, against: pairs[0].fact.sha, finding: "consistent", ts: "t", claim_id: "01A" }],
      storeExists: true,
    });
    const status = await restateStatus(rc.referencedRestatements, rc.rules, { readClaims });
    assert.equal(status.judged.length, 1, "only fileA's pair is judged");
    assert.equal(status.unjudged.length, 1, "fileB's identical text is a SEPARATE unanswered question");
  } finally {
    f.cleanup();
  }
});

// ── identity ─────────────────────────────────────────────────────────────

test("pairSha changes when either the claim or the fact changes", () => {
  const f = fixture();
  try {
    const ruleFile = f.rule("tool-priority", "purpose-built tool", "Use a purpose-built tool.");
    const rules = [{ id: "tool-priority", fingerprint: "purpose-built tool", __file: ruleFile }];
    const fileA = f.claudeMd("a", "# X\n\n`rule:tool-priority`\n\nUse a purpose-built tool for X.\n");
    const fileB = f.claudeMd("b", "# X\n\n`rule:tool-priority`\n\nUse a purpose-built tool for Y.\n");
    // Line 5 is where the restatement itself (the fingerprint match) actually
    // sits — line 3 is only the citation and would (correctly) come back
    // UNPAIRED, per the "citation exists, no restatement" test above.
    const corpusA = [{ rule: "tool-priority", file: fileA, line: 5 }];
    const corpusB = [{ rule: "tool-priority", file: fileB, line: 5 }];
    const a = restatementPairs(corpusA, rules).pairs[0];
    const b = restatementPairs(corpusB, rules).pairs[0];
    assert.notEqual(a.pairSha, b.pairSha, "a changed claim must re-open its pair");
  } finally {
    f.cleanup();
  }
});

test("deriveRuleFact returns null, not a throw, for an unreadable rule file", () => {
  const fact = deriveRuleFact({ id: "ghost", __file: "/definitely/not/here.md" });
  assert.equal(fact, null);
});

// ── the unpaired drain: identity existed, nothing consumed it ──────────────

test("an unpaired entry carrying a verdict moves OUT of awaiting — the lane converges", async () => {
  // THE DEFECT THIS PINS. `unpairedSha` was added so an unpairable entry could
  // be dispositioned, and `claims-verdict.test.mjs` asserts it yields "a valid
  // block_sha, so a verdict can key to it" — but `restateStatus` built
  // `judgedByKey` and consulted it for `pairs` only, returning `unpaired`
  // verbatim. So every verdict written for an unpairable entry was inert and
  // the same entries re-reported forever: the lane could not converge, which
  // is the one thing the hash was introduced to fix.
  const f = fixture();
  try {
    f.rule("tool-priority", "code-review-graph", "Run code-review-graph status first.");
    const file = f.claudeMd("headed", "# X\n\n## MCP: code-review-graph\n\nSee `rule:tool-priority`.\n");
    const rc = checkRules({ rulesDir: f.rulesDir, roots: [f.tree] });
    const { unpaired } = restatementPairs(rc.referencedRestatements, rc.rules);
    assert.equal(unpaired.length, 1, "fixture must produce exactly one unpairable entry");
    const u = unpaired[0];
    assert.match(u.against, /^[0-9a-f]{64}$/, "the entry must expose the fact sha a verdict keys to");

    const readClaims = async () => ({
      claims: [{ file, block_sha: u.pairSha, against: u.against, finding: "unrelated", ts: "2026-01-01T00:00:00.000Z", claim_id: "01A" }],
      storeExists: true,
    });
    const status = await restateStatus(rc.referencedRestatements, rc.rules, { readClaims });
    assert.equal(status.unpairedJudged.length, 1, "a recorded verdict must disposition the entry");
    assert.equal(status.unpairedAwaiting.length, 0, "and it must stop being reported as outstanding work");
    assert.equal(status.unpairedJudged[0].verdict.finding, "unrelated");
    assert.equal(status.unpaired.length, 1, "`unpaired` stays the FULL set — that question did not change");
  } finally {
    f.cleanup();
  }
});

test("the same entry with an EMPTY store stays awaiting — proving the test above measures something", async () => {
  // Without this, the assertion above would also pass on a build where every
  // unpaired entry was classed judged regardless of the store.
  // `rule:discernment-checks` §1.
  const f = fixture();
  try {
    f.rule("tool-priority", "code-review-graph", "Run code-review-graph status first.");
    f.claudeMd("headed", "# X\n\n## MCP: code-review-graph\n\nSee `rule:tool-priority`.\n");
    const rc = checkRules({ rulesDir: f.rulesDir, roots: [f.tree] });
    const status = await restateStatus(rc.referencedRestatements, rc.rules, { readClaims: NO_CLAIMS });
    assert.equal(status.unpairedAwaiting.length, 1, "no verdict means still awaiting one");
    assert.equal(status.unpairedJudged.length, 0);
  } finally {
    f.cleanup();
  }
});

test("an entry with no derived fact is UNDISPOSITIONABLE, not awaiting — a broken rule is not pending work", async () => {
  // `validateClaim` refuses a `finding` without an `against`, and there is no
  // fact to be against when the rule is missing. Folding these into "awaiting
  // judgment" would advertise work that cannot be done — the two-states-worn-
  // as-one failure (`rule:discernment-checks` §2) one level up.
  const status = await restateStatus(
    [{ rule: "no-such-rule", file: "/tmp/nonexistent/CLAUDE.md", line: 1 }],
    [],
    { readClaims: NO_CLAIMS },
  );
  assert.equal(status.unpairedUndispositionable.length, 1);
  assert.equal(status.unpairedAwaiting.length, 0, "must NOT be advertised as awaiting a verdict");
  assert.equal(status.unpairedUndispositionable[0].against, null, "no fact means nothing to judge against");
});
