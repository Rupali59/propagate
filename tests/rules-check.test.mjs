/**
 * Phase 5 — the rules lifecycle, absorbed and made honest.
 *
 * WHY PROPAGATE OWNS THIS. docs/LIFECYCLE.md already defines PROMOTE, and its
 * destination *is* a rule file with id/scope/status/fingerprint and a green selftest.
 * The concept was already here; only the code lived somewhere else, in a standalone
 * `_check.mjs` that nothing invoked automatically (docs/SYSTEMS.md classes it
 * active-unadopted).
 *
 * MEASURED BASELINE, 2026-08-19 — four defects in the original, in order of cost:
 *
 *   1. IT EXITS 0 ON AN EMPTY TREE. `find $TREE -name CLAUDE.md` returning nothing
 *      gives 0 findings gives exit 0 gives "no drift" — when it means "nothing was
 *      scanned". That is GOTCHAS G1 exactly: a check that cannot fail reports
 *      success. On any machine that is not this one, the tree does not exist and the
 *      detector has been reporting clean since the day it was written.
 *   2. `TREE` is `~/Documents/GitHub`, hardcoded.
 *   3. `RULES_DIR` is `~/.claude/rules`, hardcoded.
 *   4. It shells out to `find` to enumerate, so a missing root throws out of
 *      execFileSync rather than being reported.
 *
 * Parity is asserted separately (see "produces the same findings as the original"):
 * a rewrite that changes the ANSWER while fixing the plumbing is not a fix, and the
 * original's output on the real tree is the only available oracle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const RULE = (id, fingerprint, extra = "") =>
  `---\nid: ${id}\nscope: global\nstatus: active\nfingerprint: "${fingerprint}"\n---\n\n${extra || fingerprint} in the body.\n`;

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-rules-"));
  const rulesDir = path.join(dir, "rules");
  const tree = path.join(dir, "tree");
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(tree, { recursive: true });
  return {
    dir,
    rulesDir,
    tree,
    rule: (id, fp, extra) => writeFileSync(path.join(rulesDir, `${id}.md`), RULE(id, fp, extra)),
    claudeMd: (rel, body) => {
      const p = path.join(tree, rel, "CLAUDE.md");
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
      return p;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("an empty tree is reported as not-scanned, never as clean", async () => {
  // THE load-bearing case. rule:discernment-checks §2 — "no result" and "no result
  // BECAUSE" are different facts, and a detector that conflates them has been
  // silently reporting success on every machine but one.
  const { checkRules } = await import("../lib/rules-check.mjs");
  const f = fixture();
  try {
    f.rule("some-rule", "distinctive phrase");
    const r = checkRules({ rulesDir: f.rulesDir, roots: [f.tree] });
    assert.equal(r.filesScanned, 0, "nothing to scan in this fixture");
    assert.equal(r.diagnostic, "no-files-scanned", `must name why, got ${r.diagnostic}`);
    assert.notEqual(r.exitCode, 0, "must not exit 0 having scanned nothing");
  } finally {
    f.cleanup();
  }
});

test("a root that does not exist is distinguished from a root with no CLAUDE.md", async () => {
  const { checkRules } = await import("../lib/rules-check.mjs");
  const f = fixture();
  try {
    f.rule("some-rule", "distinctive phrase");
    const r = checkRules({ rulesDir: f.rulesDir, roots: [path.join(f.dir, "nope")] });
    assert.equal(r.diagnostic, "roots-missing", `got ${r.diagnostic}`);
    assert.notEqual(r.exitCode, 0);
  } finally {
    f.cleanup();
  }
});

test("a restatement is found; a reference is not", async () => {
  const { checkRules } = await import("../lib/rules-check.mjs");
  const f = fixture();
  try {
    f.rule("tool-priority", "purpose-built tool");
    f.claudeMd("restater", "# X\nAlways prefer a purpose-built tool before Grep.\n");
    f.claudeMd("referencer", "# Y\nTool priority: rule:tool-priority\n");
    f.claudeMd("silent", "# Z\nNothing relevant here.\n");
    const r = checkRules({ rulesDir: f.rulesDir, roots: [f.tree] });
    assert.equal(r.filesScanned, 3);
    assert.equal(r.findings.length, 1, "exactly the restater");
    assert.ok(r.findings[0].file.includes("restater"), `got ${r.findings[0].file}`);
    assert.notEqual(r.exitCode, 0, "a restatement is a failure");
  } finally {
    f.cleanup();
  }
});

test("a declared override is reported but does not fail the run", async () => {
  const { checkRules } = await import("../lib/rules-check.mjs");
  const f = fixture();
  try {
    f.rule("secrets-source-of-truth", "Doppler is the source of truth");
    f.claudeMd("deviant", "# D\nDoppler is the source of truth elsewhere.\n**`overrides: secrets-source-of-truth`** — we use Vault.\n");
    const r = checkRules({ rulesDir: f.rulesDir, roots: [f.tree] });
    assert.equal(r.findings.length, 0, "a declared deviation is not a restatement");
    assert.equal(r.overrides.length, 1, "but it must still be printed");
    assert.equal(r.exitCode, 0, "declared deviations do not fail the run");
  } finally {
    f.cleanup();
  }
});

test("selftest proves every fingerprint can fire, and fails when one cannot", async () => {
  const { selftest } = await import("../lib/rules-check.mjs");
  const f = fixture();
  try {
    f.rule("good-rule", "a phrase that is present");
    const ok = selftest({ rulesDir: f.rulesDir });
    assert.equal(ok.pass, true, `expected pass, got ${JSON.stringify(ok.failures)}`);

    // A fingerprint that does not match its own rule body can never fire. This is
    // the case that caught a real bug: plan-mode-3-files declared `3\+ *files` while
    // its body said "3 or more files".
    writeFileSync(
      path.join(f.rulesDir, "broken.md"),
      `---\nid: broken\nscope: global\nstatus: active\nfingerprint: "never appears anywhere"\n---\n\nThe body says something else.\n`,
    );
    const bad = selftest({ rulesDir: f.rulesDir });
    assert.equal(bad.pass, false, "must fail when a fingerprint cannot fire");
    assert.ok(bad.failures.some((x) => String(x).includes("broken")), "must name the rule");
  } finally {
    f.cleanup();
  }
});

test("override detection fires on real declarations and refuses near-misses", async () => {
  const { overrideRe } = await import("../lib/rules-check.mjs");
  const id = "secrets-source-of-truth";
  const cases = [
    ["overrides: secrets-source-of-truth", true, "bare"],
    ["**`overrides: secrets-source-of-truth`** — reason", true, "bold + backticks, as written in prose"],
    ["see rule:secrets-source-of-truth", false, "a reference is not an override"],
    ["overrides: secrets-source-of-truth-extended", false, "must not match a longer id"],
    ["this overrides the secrets-source-of-truth rule", false, "prose mentioning both words"],
  ];
  for (const [sample, want, why] of cases) {
    assert.equal(overrideRe(id).test(sample), want, why);
  }
});

test("enumeration does not shell out, so a missing root is reported not thrown", async () => {
  const { findCandidateFiles } = await import("../lib/rules-check.mjs");
  const r = findCandidateFiles(["/definitely/not/here"]);
  assert.deepEqual(r.files, [], "no files");
  assert.deepEqual(r.missing, ["/definitely/not/here"], "and it says which root was missing");
});

test("frontmatter is parsed as YAML, so escaped fingerprints survive", async () => {
  // THE most expensive defect found in this absorb. The original parsed frontmatter
  // with `/^(\w+):\s*(.*)$/` and stripped surrounding quotes — it did not UNESCAPE.
  // So the valid YAML `fingerprint: "STATE\\.md"` (which means STATE\.md) reached the
  // regex engine as `STATE\\.md`, matching a literal backslash. Three of the sixteen
  // live rules are written that way, and all three detectors were dead: they could
  // not fire for any input, ever.
  //
  // The old selftest passed all three, because it tested the fingerprint against the
  // WHOLE FILE — and the frontmatter contains the fingerprint text verbatim. A check
  // whose subject includes its own expectation cannot fail.
  const { loadRules } = await import("../lib/rules-check.mjs");
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.rulesDir, "escaped.md"),
      `---\nid: escaped\nscope: global\nstatus: active\nfingerprint: "STATE\\\\.md.{0,20}daily-open"\n---\n\nSTATE.md is the daily-open file.\n`,
    );
    const [r] = loadRules(f.rulesDir);
    assert.equal(r.fingerprint, "STATE\\.md.{0,20}daily-open", "YAML escape must be resolved once");
    assert.ok(
      new RegExp(r.fingerprint, "i").test("STATE.md is the daily-open file."),
      `the parsed fingerprint must actually match its subject; got ${JSON.stringify(r.fingerprint)}`,
    );
  } finally {
    f.cleanup();
  }
});

test("worktree checkouts are excluded from the scan, and the exclusion is reported", async () => {
  // A worktree's CLAUDE.md is the SAME FILE seen twice — its canonical path is already
  // scanned — so counting it inflates the finding count with work that duplicates
  // other work. Worse for a DETACHED-HEAD worktree, which is what
  // Motherboard/.claude/worktrees/hardcore-villani-778ff0 is: it sits on no branch, so
  // an edit there can never merge anywhere. The finding is real and the work it implies
  // cannot land.
  //
  // It only surfaced when Phase 5 revived the plan-mode-3-files detector, which had
  // been dead since it was written.
  //
  // Reported, not silently dropped: a scan that quietly narrows its own scope reads as
  // "covered everything" when it did not.
  const { findCandidateFiles } = await import("../lib/rules-check.mjs");
  const f = fixture();
  try {
    f.claudeMd("real", "# canonical\n");
    f.claudeMd(path.join(".worktrees", "some-branch"), "# a checkout\n");
    f.claudeMd(path.join(".claude", "worktrees", "detached-abc123"), "# another checkout\n");
    const r = findCandidateFiles([f.tree]);
    assert.equal(r.files.length, 1, `only the canonical file, got:\n  ${r.files.join("\n  ")}`);
    assert.ok(r.files[0].includes("real"), "and it is the canonical one");
    assert.equal(r.excludedWorktrees, 2, "both checkouts counted and reported, not silently dropped");
  } finally {
    f.cleanup();
  }
});

