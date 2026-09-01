/**
 * `node cli.mjs claims check --json` against a REAL tree — the acceptance test
 * the Phase 2 lane 1 brief asked for. A run that reports none of a corpus's
 * hand-found positives is broken, not clean (`rule:discernment-checks` §1).
 *
 * THE CORPUS IS NOT IN THIS REPO, AND NEITHER ARE THE EXPECTATIONS. Both come
 * from `PROPAGATE_ACCEPTANCE_EXPECT`, a JSON file outside the tree. That split
 * is the point: the value of this test is "the five checks fire on a real
 * document tree", which is mechanism and belongs here; *which* positives a
 * given tree holds is a fact about that tree — often someone's private working
 * notes — and belongs with it. Hardcoding both put a person's pricing table,
 * branch names and vocabulary inside a public repo to assert a property that
 * has nothing to do with any of them.
 *
 * Unset env => every test SKIPS WITH A REASON, never silently passes
 * (`rule:discernment-checks` §2 — "looked at nothing" and "found nothing" are
 * different facts). Malformed env => the suite FAILS rather than skipping: a
 * typo'd path that reads as "no corpus configured" is a check that cannot fail.
 *
 * Expectations file shape:
 *
 *   {
 *     "corpusRoot": "/abs/path/to/tree",     // becomes PROPAGATE_SEARCH_ROOTS
 *     "expect": [
 *       { "name": "human label for the failure message",
 *         "count": 1,                         // optional, default 1 (a floor)
 *         "match": { "check": "expired-date", // plain key  => strict equal
 *                    "file~": "NOTES.md",     // `~` suffix => substring
 *                    "reason/": "table sep" } // `/` suffix => regex
 *       }
 *     ]
 *   }
 *
 * DELIBERATELY reads the live tree, not a fixture. That makes the suite fragile
 * to future edits of the corpus BY DESIGN: if a flagged gap is fixed, or an
 * expired window resolves, this SHOULD start failing — that failure is the
 * propagation ledger doing its job. Update the expectations file, never the
 * corpus, when a known positive legitimately goes away.
 *
 * `claims check` has no writer, so pointing it at a real tree is read-only.
 * `PROPAGATE_STATE_DIR` is still redirected to a temp dir — G56: a test run
 * must never be able to touch the production store, whatever the command claims
 * about itself.
 *
 * Slow relative to the rest of the suite (a real tree walk plus several `git
 * rev-parse` subprocesses) — one `before()` hook runs the CLI exactly once and
 * every test asserts against that single captured result.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const EXPECT_PATH = process.env.PROPAGATE_ACCEPTANCE_EXPECT || "";

let result = null;
let spec = null;
let skipReason = null;

/**
 * One field predicate. The suffix carries the operator so the expectations file
 * stays plain JSON — no code, nothing to eval, and a malformed entry is a data
 * error rather than an injection point.
 */
function fieldMatches(finding, key, want) {
  if (key.endsWith("~")) return String(finding[key.slice(0, -1)] ?? "").includes(String(want));
  if (key.endsWith("/")) return new RegExp(want).test(String(finding[key.slice(0, -1)] ?? ""));
  return finding[key] === want;
}

const matches = (f, m) => Object.entries(m).every(([k, v]) => fieldMatches(f, k, v));

before(async () => {
  if (!EXPECT_PATH) {
    skipReason =
      "PROPAGATE_ACCEPTANCE_EXPECT is unset — no acceptance corpus configured on this machine. " +
      "Point it at a JSON expectations file (see this file's header) to run the real-tree checks.";
    return;
  }

  // From here on every failure is a HARD failure. The env said a corpus exists;
  // if it does not, that is a broken configuration, not an absent one, and
  // reporting it as a skip is exactly the "check that cannot fail" this suite
  // is meant to be.
  assert.ok(existsSync(EXPECT_PATH), `PROPAGATE_ACCEPTANCE_EXPECT points at ${EXPECT_PATH}, which does not exist`);
  spec = JSON.parse(readFileSync(EXPECT_PATH, "utf8"));
  assert.ok(spec.corpusRoot, `${EXPECT_PATH}: missing "corpusRoot"`);
  assert.ok(Array.isArray(spec.expect) && spec.expect.length > 0, `${EXPECT_PATH}: "expect" must be a non-empty array`);
  assert.ok(existsSync(spec.corpusRoot), `${EXPECT_PATH}: corpusRoot ${spec.corpusRoot} does not exist`);

  const stateDir = await mkdtemp(path.join(tmpdir(), "claims-check-known-positives-state-"));
  const proc = spawnSync(process.execPath, [CLI_PATH, "claims", "check", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: spec.corpusRoot, PROPAGATE_STATE_DIR: stateDir },
  });
  await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

  assert.ok(
    proc.status === 0 || proc.status === 1,
    `claims check --json should exit 0 (clean) or 1 (findings), got ${proc.status}. stderr: ${proc.stderr}`,
  );
  // --json discipline (N65's lesson, restated for this command): nothing but
  // the JSON blob may be on stdout.
  try {
    result = JSON.parse(proc.stdout);
  } catch (err) {
    assert.fail(`--json stdout was not valid JSON (${err.message}) — stdout began: ${proc.stdout.slice(0, 200)}`);
  }
});

test("acceptance corpus: every declared known positive is still found", (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.ok(result, "expected a parsed claims check result — did the before() hook run?");

  const misses = [];
  for (const e of spec.expect) {
    const floor = e.count ?? 1;
    const hits = result.findings.filter((f) => matches(f, e.match));
    if (hits.length < floor) {
      // Name the near-misses: "0 of the 12 expired-date findings matched" is
      // actionable; "expected 1, got 0" sends the reader back to the corpus.
      const sameCheck = result.findings.filter((f) => f.check === e.match.check);
      misses.push(
        `  ✗ ${e.name}\n` +
          `      want ≥${floor} matching ${JSON.stringify(e.match)}, found ${hits.length}\n` +
          `      (${sameCheck.length} finding(s) of check "${e.match.check}" in this run)`,
      );
    }
  }

  assert.equal(
    misses.length,
    0,
    `${misses.length} of ${spec.expect.length} known positive(s) no longer found in ${spec.corpusRoot}:\n${misses.join("\n")}\n` +
      `If a gap was genuinely fixed, update the expectations file — never the corpus.`,
  );
});

/**
 * Corpus-independent invariants. These assert properties of the CHECKS rather
 * than of any tree, so they hold for every corpus and are the part worth having
 * even when the expectations file names positives this session never saw.
 */
test("acceptance corpus: findings are internally consistent whatever the tree", (t) => {
  if (skipReason) return t.skip(skipReason);

  for (const f of result.findings) {
    assert.ok(f.file, `every finding names a file: ${JSON.stringify(f)}`);
    assert.ok(f.check, `every finding names a check: ${JSON.stringify(f)}`);

    // A footer is only "stale" relative to something newer. If these are ever
    // equal or inverted the comparison is backwards, and no corpus is needed to
    // know that.
    if (f.check === "footer-stale") {
      assert.ok(
        f.newestInline > f.footer,
        `footer-stale on ${f.file} claims footer ${f.footer} is behind ${f.newestInline} — which is not newer`,
      );
    }
    if (f.check === "expired-date") {
      assert.ok(f.daysExpired > 0, `expired-date on ${f.file} reports ${f.daysExpired} days expired`);
    }
    if (f.check === "price-literal-drift") {
      assert.ok(
        f.direction === "doc-not-in-code" || f.direction === "code-not-in-doc",
        `price-literal-drift needs a direction, got ${JSON.stringify(f.direction)}`,
      );
    }
  }
});

test("acceptance corpus: coverage is reported, so zero findings is attributable", (t) => {
  if (skipReason) return t.skip(skipReason);
  // `rule:discernment-checks` §2 at the command level: a clean run must still
  // say what it looked at, or "no findings" is indistinguishable from "no input".
  assert.ok(result.coverage, "claims check --json must report coverage");
  assert.ok(
    result.coverage.filesChecked > 0,
    `acceptance corpus ${spec.corpusRoot} yielded 0 files checked — the corpus is misconfigured, not clean`,
  );
});
