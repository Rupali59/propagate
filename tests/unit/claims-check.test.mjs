/**
 * `lib/claims/check.mjs` — the five deterministic checks, plus
 * `buildClaimsCorpus`/`claimsCheck`'s three-outcome discipline.
 *
 * Two kinds of coverage, per Phase 2 lane 1's brief:
 *
 * 1. HERMETIC unit tests against small synthetic strings — one PASS
 *    (finding fires) and one FIX (the same fixture, mutated toward the
 *    correct state, and the finding disappears) per check. This is the
 *    read-only-derivation analogue of `rule:safety-flag-needs-a-test`'s
 *    "mutate the guard and confirm red for the stated reason" — these
 *    functions have no boolean flag to invert (they are not writers), so
 *    the mutation is applied to the FIXTURE CONTENT instead, and what must
 *    flip is the presence/absence of the specific finding, proven by name
 *    — never by a bare `findings.length` count, which a check that always
 *    fires would also satisfy.
 * 2. The LIVE-CORPUS acceptance tests for the five known positives live in
 *    `tests/cli/claims-check-known-positives.test.mjs` (a separate file —
 *    those run the real CLI as a subprocess against the real
 *    `Vipin Kaushik` tree, which is slow and machine-specific; keeping
 *    them apart means this file stays fast and hermetic).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findExpiredDates,
  findDeadConceptTokens,
  extractPriceTableLabels,
  extractCodeTierKinds,
  checkPriceLiteralsVsCode,
  checkFooterVsInline,
  findSelfLineCitations,
  findDeadBranchCitations,
  findDeadPathCitations,
  buildClaimsCorpus,
  claimsCheck,
} from "../../lib/claims/check.mjs";

const NOW = new Date("2026-08-31T00:00:00Z");

// ─────────────────────────────────────────────────────────────────────────
// Check 1 — expired dates
// ─────────────────────────────────────────────────────────────────────────

test("findExpiredDates: an arrow range whose end date has passed fires (VIPIN.md known positive, shape)", () => {
  const text = "### Online-only window (2026-05-04 → ~2026-08-04)\n";
  const findings = findExpiredDates(text, { now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].marker, "→");
  assert.equal(findings[0].approx, true);
  assert.equal(findings[0].expiredISO, "2026-08-04");
  assert.equal(findings[0].daysExpired, 27);
});

test("findExpiredDates: FIX — pushing the end date into the future clears the finding", () => {
  const stillOpen = "### Online-only window (2026-05-04 → ~2027-08-04)\n";
  assert.deepEqual(findExpiredDates(stillOpen, { now: NOW }), []);
});

test("findExpiredDates: a bare Month+Year after a marker expires at the end of that month (pricing.ts known positive, shape)", () => {
  const text = 'availabilityNote: "Resumes August 2026",\n';
  const findings = findExpiredDates(text, { now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].marker, "Resumes");
  assert.equal(findings[0].dateText, "August 2026");
  assert.equal(findings[0].expiredISO, "2026-08-31");
});

test("findExpiredDates: FIX — a future Month+Year does not fire", () => {
  const text = 'availabilityNote: "Resumes September 2026",\n';
  assert.deepEqual(findExpiredDates(text, { now: NOW }), []);
});

test("findExpiredDates: a through/until ISO date behaves the same as an arrow range (CLAUDE.md known positive, shape)", () => {
  const text = "Online-only booking window through ~2026-08-04.\n";
  const findings = findExpiredDates(text, { now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].marker, "through");
  assert.equal(findings[0].daysExpired, 27);
});

test("findExpiredDates: a line already marked expired/superseded is suppressed, not flagged", () => {
  const text = "Vastu superseded 2026-07-15 — the window through 2026-07-01 lapsed on schedule.\n";
  assert.deepEqual(findExpiredDates(text, { now: NOW }), []);
});

test("findExpiredDates: a marker word far from any date does not fire (arrow-adjacency regression)", () => {
  // The exact false positive this check used to produce: an arrow used as
  // UI copy ("Book a consultation →"), with an UNRELATED past date many
  // characters later in the same sentence.
  const text =
    "hero `Book a consultation →` button shipped 2026-05-31, commit 45c5bc0.\n";
  assert.deepEqual(findExpiredDates(text, { now: NOW }), []);
});

// ─────────────────────────────────────────────────────────────────────────
// Check 5 — dead concept tokens
// ─────────────────────────────────────────────────────────────────────────

test("findDeadConceptTokens: a token absent from its own source's text is dead (₹5,100 vs \"5100\", known positive shape)", () => {
  const sourceText = "## Pricing\n\n| 15 min consultation | ₹5,100 | Online active. |\n";
  const concepts = { "§Pricing": ["pricing", "5100", "consultation"] };
  const findings = findDeadConceptTokens(sourceText, concepts);
  assert.deepEqual(findings, [{ section: "§Pricing", token: "5100" }]);
});

test("findDeadConceptTokens: FIX — writing the token literally (comma removed) clears the finding", () => {
  const sourceText = "## Pricing\n\n| 15 min consultation | Rs 5100 | Online active. |\n";
  const concepts = { "§Pricing": ["pricing", "5100", "consultation"] };
  assert.deepEqual(findDeadConceptTokens(sourceText, concepts), []);
});

test("findDeadConceptTokens: matching is case-insensitive (Title-Case label vs. lowercase declared token)", () => {
  const sourceText = "**Email:** contact@example.com\n";
  assert.deepEqual(findDeadConceptTokens(sourceText, { "§Identity": ["email"] }), []);
});

test("findDeadConceptTokens: no concepts block returns no findings, not a throw", () => {
  assert.deepEqual(findDeadConceptTokens("anything", null), []);
});

// ─────────────────────────────────────────────────────────────────────────
// Check 2 — literal claims vs. declared downstream (price table vs. code)
// ─────────────────────────────────────────────────────────────────────────

test("extractPriceTableLabels: reads the first column of a Service|Price table", () => {
  const doc = [
    "| Service | Price (INR) | Notes |",
    "|---------|-------------|-------|",
    "| 15 min consultation | ₹5,100 | Online active. |",
    "| Complex Muhurta | Variable, depth-dependent | — |",
    "",
    "Some prose after the table.",
  ].join("\n");
  assert.deepEqual(extractPriceTableLabels(doc), ["15 min consultation", "Complex Muhurta"]);
});

test("extractCodeTierKinds: reads every kind: \"...\" string literal", () => {
  const code = 'consultation_15: { kind: "consultation_15" },\ndouble_kundli: { kind: "double_kundli" },\n';
  assert.deepEqual(extractCodeTierKinds(code), ["consultation_15", "double_kundli"]);
});

test("checkPriceLiteralsVsCode: a doc row with no match in code is flagged doc-not-in-code (Complex Muhurta known positive, shape)", () => {
  const doc = [
    "| Service | Price (INR) | Notes |",
    "|---------|-------------|-------|",
    "| 15 min consultation · online or in-person · Gurgaon | ₹5,100 | — |",
    "| Complex Muhurta | Variable, depth-dependent | — |",
  ].join("\n");
  const code = 'export const PRICING = {\n  consultation_15: { kind: "consultation_15", label: "Consultation" },\n};\n';
  const findings = checkPriceLiteralsVsCode(doc, code);
  assert.ok(
    findings.some((f) => f.direction === "doc-not-in-code" && f.label === "Complex Muhurta"),
    "expected Complex Muhurta to be flagged doc-not-in-code",
  );
  assert.ok(
    !findings.some((f) => f.direction === "doc-not-in-code" && /consultation/i.test(f.label)),
    "the 15-min consultation row shares the word 'consultation' with the code and must NOT be flagged",
  );
});

test("checkPriceLiteralsVsCode: FIX — adding the tier to code clears the doc-not-in-code finding", () => {
  const doc = ["| Service | Price (INR) |", "|---|---|", "| Complex Muhurta | Variable |"].join("\n");
  const codeWithout = 'kind: "consultation",\n';
  const codeWith = 'kind: "consultation",\nkind: "complex_muhurta", // "complex muhurta" now literally present\n';
  assert.ok(checkPriceLiteralsVsCode(doc, codeWithout).some((f) => f.label === "Complex Muhurta"));
  assert.deepEqual(
    checkPriceLiteralsVsCode(doc, codeWith).filter((f) => f.label === "Complex Muhurta"),
    [],
  );
});

test("checkPriceLiteralsVsCode: a code identifier with no match in the doc is flagged code-not-in-doc (double_kundli known positive, shape)", () => {
  const doc = "Consultation pricing is covered above. No other tiers are mentioned in this prose.\n";
  const code = 'kind: "double_kundli",\n';
  const findings = checkPriceLiteralsVsCode(doc, code);
  assert.deepEqual(findings, [{ direction: "code-not-in-doc", label: "double_kundli" }]);
});

test("checkPriceLiteralsVsCode: FIX — mentioning the deslugged phrase in the doc clears the code-not-in-doc finding", () => {
  const code = 'kind: "double_kundli",\n';
  const docWithout = "No mention of that tier here.\n";
  const docWith = "A Double Kundli reading covers both charts.\n";
  assert.ok(checkPriceLiteralsVsCode(docWithout, code).some((f) => f.label === "double_kundli"));
  assert.deepEqual(checkPriceLiteralsVsCode(docWith, code), []);
});

test("checkPriceLiteralsVsCode: hyphen/underscore normalization avoids a false positive (in_person vs. \"in-person\")", () => {
  const doc = "In-person consultations resume later.\n";
  const code = 'kind: "in_person",\n';
  assert.deepEqual(checkPriceLiteralsVsCode(doc, code), []);
});

// ─────────────────────────────────────────────────────────────────────────
// Check 3 — footer date vs. newest inline date
// ─────────────────────────────────────────────────────────────────────────

test("checkFooterVsInline: a footer older than an inline amendment marker is stale (NORTH_STAR.md known positive, shape)", () => {
  const text = [
    "Some section.",
    "(Narrowed 2026-07-13 — corrected the earlier claim.)",
    "",
    "*Last amended: 2026-03-19*",
  ].join("\n");
  const result = checkFooterVsInline(text);
  assert.deepEqual(result, { footer: "2026-03-19", newestInline: "2026-07-13", stale: true });
});

test("checkFooterVsInline: FIX — bumping the footer to the newest inline date clears staleness", () => {
  const text = [
    "(Narrowed 2026-07-13 — corrected the earlier claim.)",
    "*Last amended: 2026-07-13*",
  ].join("\n");
  const result = checkFooterVsInline(text);
  assert.equal(result.stale, false);
});

test("checkFooterVsInline: no footer at all returns null, not a false 'not stale'", () => {
  const result = checkFooterVsInline("No footer marker anywhere in this file.\n");
  assert.deepEqual(result, { footer: null, newestInline: null, stale: false });
});

// ─────────────────────────────────────────────────────────────────────────
// Check 4a — self-line citations
// ─────────────────────────────────────────────────────────────────────────

test("findSelfLineCitations: citing a line that is a markdown table separator is rotted (VIPIN.md known positive, shape)", () => {
  const lines = [];
  lines[116] = "| Service | Price (INR) | Notes |"; // line 117
  lines[117] = "|---------|-------------|-------|"; // line 118 — the separator
  lines[118] = "| 15 min consultation | ₹5,100 | — |"; // line 119
  const filler = Array.from({ length: 116 }, (_, i) => `filler line ${i + 1}`);
  const text = filler.concat([lines[116], lines[117], lines[118]]).join("\n") +
    '\n(per Jiraiya voice example at line 118) — this implies remedies are given.\n';
  const findings = findSelfLineCitations(text);
  assert.deepEqual(findings, [
    {
      citedLine: 118,
      reason: "cited line is a markdown table separator",
      targetLine: "|---------|-------------|-------|",
      context: findings[0].context,
    },
  ]);
});

test("findSelfLineCitations: FIX — citing a line that holds real prose is not flagged", () => {
  const text = "real prose here\n".repeat(5) + "(see line 3) refers to real content.\n";
  assert.deepEqual(findSelfLineCitations(text), []);
});

test("findSelfLineCitations: a heading label like \"anchor line 2\" is not a citation (false-positive regression)", () => {
  const text = [
    "### What astrology is — anchor line 1 (page-epigraph candidate)",
    "",
    "### Voice register — anchor line 2 (register, not slogan)",
    "> some quote",
  ].join("\n");
  assert.deepEqual(findSelfLineCitations(text), []);
});

test("findSelfLineCitations: a citation of another file's line ('pricing.ts:118') is out of scope, not flagged", () => {
  const text = "\n".repeat(120) + "see pricing.ts:118 for the canonical values.\n";
  assert.deepEqual(findSelfLineCitations(text), []);
});

test("findSelfLineCitations: an out-of-range self-citation is flagged with its own reason", () => {
  const text = "one line only\n(see line 999) does not exist in this short file.\n";
  const findings = findSelfLineCitations(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, "out-of-range");
});

// ─────────────────────────────────────────────────────────────────────────
// Check 4b — dead branch citations (real temp git repo — no network)
// ─────────────────────────────────────────────────────────────────────────

function makeTempGitRepo() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "claims-check-git-")));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "README.md"), "seed\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  return dir;
}

test("findDeadBranchCitations: a cited branch absent from the repo is rotted (chore/correct-remedies-doctrine known positive, shape)", () => {
  const repo = makeTempGitRepo();
  try {
    const text = "queued for correction on branch `chore/correct-remedies-doctrine`.\n";
    const findings = findDeadBranchCitations(text, repo);
    assert.deepEqual(findings, [{ branch: "chore/correct-remedies-doctrine", context: findings[0].context }]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("findDeadBranchCitations: FIX — creating the branch clears the finding", () => {
  const repo = makeTempGitRepo();
  try {
    const text = "queued for correction on branch `chore/correct-remedies-doctrine`.\n";
    assert.equal(findDeadBranchCitations(text, repo).length, 1);
    execFileSync("git", ["-C", repo, "branch", "chore/correct-remedies-doctrine"]);
    assert.deepEqual(findDeadBranchCitations(text, repo), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("findDeadBranchCitations: a null repoRoot (no repo found) returns no findings, never throws", () => {
  assert.deepEqual(findDeadBranchCitations("branch `whatever`", null), []);
});

test("findDeadBranchCitations: the git runner is injectable for hermetic tests without spawning a real process", () => {
  const calls = [];
  const refExists = (repoRoot, ref) => {
    calls.push(ref);
    return ref.endsWith("real-branch");
  };
  const findings = findDeadBranchCitations("branch `real-branch` and branch `fake-branch`", "/fake/repo", { refExists });
  assert.deepEqual(findings.map((f) => f.branch), ["fake-branch"]);
  assert.ok(calls.some((r) => r.includes("refs/heads/")) && calls.some((r) => r.includes("refs/remotes/origin/")));
});

// ─────────────────────────────────────────────────────────────────────────
// Check 4c — dead path citations (implemented, unit-tested, NOT wired into
// claimsCheck — see the module's own doc comment for why)
// ─────────────────────────────────────────────────────────────────────────

test("findDeadPathCitations: a backtick path that does not exist relative to baseDir is flagged", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "claims-check-paths-")));
  try {
    writeFileSync(path.join(dir, "real.md"), "exists\n");
    const text = "See `real.md` and also `missing/nested.md` for details.\n";
    const findings = findDeadPathCitations(text, { baseDir: dir });
    assert.deepEqual(findings, [{ citedPath: "missing/nested.md", context: findings[0].context }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findDeadPathCitations: FIX — creating the file clears the finding", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "claims-check-paths-fix-")));
  try {
    const text = "See `nested/file.md` for details.\n";
    assert.equal(findDeadPathCitations(text, { baseDir: dir }).length, 1);
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    writeFileSync(path.join(dir, "nested", "file.md"), "now exists\n");
    assert.deepEqual(findDeadPathCitations(text, { baseDir: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// buildClaimsCorpus / claimsCheck — three-outcome discipline over a
// synthetic fixture tree (same style as tests/unit/rollup-render.test.mjs).
// ─────────────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "claims-check-corpus-")));

function writeFixture(rel, body) {
  const full = path.join(FIXTURE_ROOT, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
  return full;
}

writeFixture(
  "docs/.propagates.yml",
  [
    "sources:",
    "  VIPIN.md:",
    "    propagates_to:",
    '      - path: pricing.ts',
    '        why: "price literals"',
    "        kind: code",
    '      - path: "glob/**/*.md"',
    '        why: "deliberately unresolved glob"',
    "        kind: prose",
    "    concepts:",
    '      "§Pricing":',
    "        - pricing",
    '        - "9999"',
    "",
  ].join("\n"),
);
writeFixture(
  "docs/VIPIN.md",
  [
    "# Fixture doc",
    "",
    "## Pricing",
    "",
    "| Service | Price (INR) | Notes |",
    "|---------|-------------|-------|",
    "| Consultation | Rs 100 | — |",
    "",
    // Deliberately NOT "expired" (the word itself is an already-acknowledged
    // marker per ALREADY_ACKNOWLEDGED_RE) — this line must still be an open
    // finding, not a self-suppressed one.
    "This early-bird window runs through 2020-01-01, well before any test clock.",
    "",
  ].join("\n"),
);
writeFixture(
  "docs/pricing.ts",
  [
    "export const PRICING = {",
    '  consultation: { kind: "consultation", label: "Consultation" },',
    '  double_kundli: { kind: "double_kundli", label: "Double Kundli reading" },',
    "};",
    "",
  ].join("\n"),
);
mkdirSync(path.join(FIXTURE_ROOT, "docs", "unreadable-target.md"), { recursive: true }); // a DIRECTORY named like a file

writeFixture(
  "docs/second/.propagates.yml",
  [
    "sources:",
    "  UNREADABLE.md:",
    "    propagates_to:",
    '      - path: "../unreadable-target.md"',
    '        why: "this downstream is actually a directory"',
    "        kind: prose",
    "",
  ].join("\n"),
);
writeFixture("docs/second/UNREADABLE.md", "placeholder — the interesting file is the downstream\n");

const FIXTURE_WORKSPACES = [{ root: FIXTURE_ROOT, name: "fixture" }];

test("buildClaimsCorpus: resolves sources + non-glob downstreams, and records glob downstreams as skipped", async () => {
  const corpus = await buildClaimsCorpus({ workspaces: FIXTURE_WORKSPACES });
  assert.equal(corpus.sidecarsChecked.length, 2);
  assert.equal(corpus.globsSkipped.length, 1);
  assert.equal(corpus.globsSkipped[0].path, "glob/**/*.md");

  const vipinEdge = corpus.sourceEdges.find((e) => e.sourceKey === "VIPIN.md");
  assert.ok(vipinEdge, "expected a source edge for VIPIN.md");
  assert.deepEqual(vipinEdge.concepts, { "§Pricing": ["pricing", "9999"] });
  assert.equal(vipinEdge.downstreams.length, 1); // the glob one is excluded from this list
  assert.equal(vipinEdge.downstreams[0].kind, "code");
});

test("claimsCheck: three-outcome discipline — checked files are counted, unreadable files are named with a reason, never silently dropped", async () => {
  const result = await claimsCheck({ workspaces: FIXTURE_WORKSPACES, now: new Date("2026-08-31T00:00:00Z") });

  // 4 unique corpus files total (VIPIN.md, pricing.ts, second/UNREADABLE.md,
  // the directory-masquerading-as-a-file downstream) — 3 checked, 1 not.
  assert.equal(result.coverage.filesChecked, 3, "expected exactly the 3 readable fixture files to be checked");
  assert.equal(result.coverage.filesUnreadable, 1, "the directory-named-as-a-file downstream must be reported unreadable, not silently skipped");
  assert.ok(result.files.unreadable.some((f) => f.file.includes("unreadable-target.md")));

  // A run with findings is not a run with ZERO findings pretending to be
  // clean — assert the specific ones the fixture was built to produce.
  assert.ok(result.findings.some((f) => f.check === "expired-date"));
  assert.ok(result.findings.some((f) => f.check === "dead-concept-token" && f.token === "9999"));
  assert.ok(result.findings.some((f) => f.check === "price-literal-drift" && f.label === "double_kundli" && f.direction === "code-not-in-doc"));
});

test("claimsCheck: a workspace with no declared sidecars at all reports zero sidecars, not an error", async () => {
  const emptyRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "claims-check-empty-")));
  try {
    const result = await claimsCheck({ workspaces: [{ root: emptyRoot, name: "empty" }] });
    assert.deepEqual(result.coverage, {
      filesChecked: 0,
      filesUnreadable: 0,
      sidecarsChecked: 0,
      sidecarsUnreadable: 0,
      globsSkipped: 0,
      sourceEdges: 0,
    });
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});
