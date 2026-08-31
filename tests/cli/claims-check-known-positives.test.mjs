/**
 * `node cli.mjs claims check --json` against the REAL `Vipin Kaushik`
 * corpus — the acceptance test the Phase 2 lane 1 brief asked for: five
 * known positives, each found by hand this session, each reproduced here
 * by name. A run reporting none of them is broken, not clean
 * (`rule:discernment-checks` §1).
 *
 * DELIBERATELY reads the live tree, not a fixture — `PROPAGATE_SEARCH_ROOTS`
 * is scoped to `~/Documents/GitHub/Vipin Kaushik` (read-only; `claims check`
 * has no writer, so there is nothing to guard against). This makes the
 * suite fragile to Rupali's own future edits of that corpus by design: if
 * she fixes the "Complex Muhurta" pricing gap, or the "line 118" citation,
 * or lets the online-only window resolve, this test SHOULD start failing —
 * that failure is the propagation ledger doing its job, not a broken test.
 * If a known positive ever needs updating because the underlying fact
 * changed, update the assertion, not the corpus this session is reading.
 *
 * Slow relative to the rest of the suite (a real tree walk + several `git
 * rev-parse` subprocess calls) — one `before()` hook runs the CLI exactly
 * once; every `test()` below asserts against that single captured result,
 * so the cost is paid once, not five times.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const VIPIN_KAUSHIK_ROOT = fileURLToPath(new URL("../../../Vipin Kaushik", import.meta.url));

let result = null;
let skipReason = null;

before(async () => {
  if (!existsSync(VIPIN_KAUSHIK_ROOT)) {
    skipReason = `Vipin Kaushik/ not present at ${VIPIN_KAUSHIK_ROOT} — acceptance corpus unavailable on this machine`;
    return;
  }
  const stateDir = await mkdtemp(path.join(tmpdir(), "claims-check-known-positives-state-"));
  const proc = spawnSync(process.execPath, [CLI_PATH, "claims", "check", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PROPAGATE_SEARCH_ROOTS: VIPIN_KAUSHIK_ROOT,
      PROPAGATE_STATE_DIR: stateDir,
    },
  });
  await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

  assert.ok(
    proc.status === 0 || proc.status === 1,
    `claims check --json should exit 0 (clean) or 1 (findings), got ${proc.status}. stderr: ${proc.stderr}`,
  );
  // --json discipline (N65's lesson, restated for this command): nothing
  // but the JSON blob may be on stdout.
  try {
    result = JSON.parse(proc.stdout);
  } catch (err) {
    assert.fail(`--json stdout was not valid JSON (${err.message}) — stdout began: ${proc.stdout.slice(0, 200)}`);
  }
});

function requireResult() {
  if (skipReason) return null;
  assert.ok(result, "expected a parsed claims check result — did the before() hook run?");
  return result;
}

test("known positive 1 — expired dates: VIPIN.md's online-only window (2026-05-04 → ~2026-08-04) has lapsed and nothing marks it", (t) => {
  const r = requireResult();
  if (!r) return t.skip(skipReason);
  const hit = r.findings.find(
    (f) => f.check === "expired-date" && f.file.includes("VIPIN.md") && f.dateText.includes("2026-08-04"),
  );
  assert.ok(hit, `expected an expired-date finding on VIPIN.md's ~2026-08-04 window. All expired-date findings: ${JSON.stringify(r.findings.filter((f) => f.check === "expired-date"), null, 2)}`);
});

test("known positive 1b — expired dates: VipinKaushik/lib/pricing.ts's \"Resumes August 2026\" is also unmarked", (t) => {
  const r = requireResult();
  if (!r) return t.skip(skipReason);
  const hit = r.findings.find((f) => f.check === "expired-date" && f.file.includes("pricing.ts"));
  assert.ok(hit, "expected an expired-date finding on pricing.ts's availabilityNote");
});

test("known positive 1c — expired dates: the workspace CLAUDE.md's \"through ~2026-08-04\" is also unmarked (three files, not one)", (t) => {
  const r = requireResult();
  if (!r) return t.skip(skipReason);
  const hit = r.findings.find(
    (f) => f.check === "expired-date" && /(^|\/)CLAUDE\.md$/.test(f.file) && f.dateText.includes("2026-08-04"),
  );
  assert.ok(hit, "expected an expired-date finding on the workspace CLAUDE.md's online-only-window line");
});

test("known positive 2 — price literal drift: \"Complex Muhurta\" has no match in lib/pricing.ts", (t) => {
  const r = requireResult();
  if (!r) return t.skip(skipReason);
  const hit = r.findings.find(
    (f) => f.check === "price-literal-drift" && f.direction === "doc-not-in-code" && f.label === "Complex Muhurta",
  );
  assert.ok(hit, "expected 'Complex Muhurta' flagged doc-not-in-code");
});

test("known positive 2b — price literal drift: \"double_kundli\" exists in code and not in VIPIN.md", (t) => {
  const r = requireResult();
  if (!r) return t.skip(skipReason);
  const hit = r.findings.find(
    (f) => f.check === "price-literal-drift" && f.direction === "code-not-in-doc" && f.label === "double_kundli",
  );
  assert.ok(hit, "expected 'double_kundli' flagged code-not-in-doc");
});

test("known positive 3 — footer staleness: NORTH_STAR.md's \"Last amended: 2026-03-19\" footer is behind its own newest inline date", (t) => {
  const r = requireResult();
  if (!r) return t.skip(skipReason);
  const hit = r.findings.find((f) => f.check === "footer-stale" && f.file.includes("NORTH_STAR.md"));
  assert.ok(hit, "expected a footer-stale finding on NORTH_STAR.md");
  assert.equal(hit.footer, "2026-03-19");
  assert.ok(hit.newestInline > hit.footer, `newest inline date ${hit.newestInline} should postdate the footer ${hit.footer}`);
});

test("known positive 4 — rotted citation: VIPIN.md cites its own \"line 118\", which is a table separator", (t) => {
  const r = requireResult();
  if (!r) return t.skip(skipReason);
  const hit = r.findings.find(
    (f) => f.check === "rotted-citation" && f.subtype === "self-line" && f.file.includes("VIPIN.md") && f.citedLine === 118,
  );
  assert.ok(hit, "expected a self-line rotted-citation finding at VIPIN.md line 118");
  assert.match(hit.reason, /table separator/);
});

test("known positive 4b — rotted citation: VIPIN.md cites branch `chore/correct-remedies-doctrine`, which does not exist", (t) => {
  const r = requireResult();
  if (!r) return t.skip(skipReason);
  const hit = r.findings.find(
    (f) => f.check === "rotted-citation" && f.subtype === "dead-branch" && f.branch === "chore/correct-remedies-doctrine",
  );
  assert.ok(hit, "expected a dead-branch rotted-citation finding for chore/correct-remedies-doctrine");
});

test("known positive 5 — dead concepts: at least 5 of VIPIN.md's 19 declared §Pricing/§Philosophy/§Wordmark tokens never match its own text", (t) => {
  const r = requireResult();
  if (!r) return t.skip(skipReason);
  const dead = r.findings.filter((f) => f.check === "dead-concept-token" && f.file.includes("VIPIN.md"));
  const tokens = dead.map((f) => f.token);
  // Named individually, not just counted: these are the exact tokens the
  // brief called out by hand. "5100"/"8100"/"21000" are dead because the
  // doc writes "₹5,100" (comma-formatted) — a different substring. "jadui"/
  // "haathi"/"wordmark" are dead because the doc uses diacritic forms
  // ("jādūī", "haathī") or never uses the plain word at all.
  for (const expectedDead of ["5100", "21000", "jadui", "haathi", "wordmark"]) {
    assert.ok(tokens.includes(expectedDead), `expected "${expectedDead}" among VIPIN.md's dead concept tokens; got ${JSON.stringify(tokens)}`);
  }
  assert.ok(dead.length >= 5, `expected at least 5 dead tokens (brief's own floor), found ${dead.length}: ${JSON.stringify(tokens)}`);
});
