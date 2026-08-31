/**
 * The digest's ECOSYSTEM section (Phase 1 Task E) — the change notice for
 * `ECOSYSTEM.md` (`lib/report/rollup.mjs` / `commands/rollup.mjs`).
 *
 * Two INDEPENDENT facts are covered here, on purpose, because the task
 * brief and `rollupSnapshot()`'s own doc comment both insist they never be
 * collapsed into one:
 *
 *   (a) STATE-based — is `ECOSYSTEM.md`, as it sits on disk right now,
 *       trustworthy (exists, not hand-edited, not stale against a fresh
 *       derivation)? `fileStale` / `handEdited` / `artifactExists`.
 *   (b) DIFF-based — has anything changed in the tree's inputs since the
 *       LAST DIGEST RUN, via `lib/report/rollup.mjs`'s `compareInputs()`
 *       over this file's own lean prior (`toStateRollup`)? `inputsChanged`
 *       / `inputsAppeared` / `inputsVanished` / `becameUnreadable`.
 *
 * Most of this file uses synthetic snapshot/prior fixtures and drives
 * `computeDiff()`/`formatDigest()` directly — `computeDiff` is a pure
 * function of (snapshot, prior), so every transition is unit-testable
 * without touching a ledger or the real tree, exactly the same idiom as
 * `tests/digest/digest-inventory.test.mjs`.
 *
 * The one section that is NOT synthetic (the "never writes ECOSYSTEM.md"
 * block near the bottom) deliberately calls the REAL `rollupSnapshot()`
 * (exported as `rollupSnapshotForTest`) against an isolated, empty fixture
 * directory via `PROPAGATE_SEARCH_ROOTS` — never the real hub. This is safe
 * to execute for real, unlike `tests/digest/digest-dryrun.test.mjs`'s
 * source-level-only choice for the lifecycle/reap guard: that guard's
 * unsafe path is a real skill deletion under `~/.claude/skills`, and "a
 * test whose failure mode is 'deleted one of Rupali's skills' is not a test
 * worth having" (that file's own words). `rollupSnapshot()`'s unsafe path is
 * writing a markdown file inside an isolated `mkdtemp()` directory that is
 * deleted at the end of the test — there is no live artifact at risk, so
 * measuring the actual side effect (not just grepping for the shape of a
 * write call) is both safe and strictly stronger.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { computeDiff, formatDigest } from "../../digest.mjs";

const DIGEST_PATH = fileURLToPath(new URL("../../digest.mjs", import.meta.url));
const DIGEST_SRC = readFileSync(DIGEST_PATH, "utf8");

// ─────────────────────────────────────────────────────────────────────────
// Synthetic fixture builders — mirror tests/digest/digest-inventory.test.mjs
// exactly (same ws()/baseSnapshot() shape) so the two files stay easy to
// read side by side.
// ─────────────────────────────────────────────────────────────────────────

function ws(name, { openRows = [], total, malformed = 0 } = {}) {
  const open = openRows.length;
  return {
    name,
    root: `/fake/${name}`,
    ledgerJsonl: `/fake/${name}/ledger.jsonl`,
    counts: { total: total ?? open, open, done: 0, wontfix: 0 },
    malformed,
    quietDays: 0,
    openRows,
  };
}

function baseSnapshot(overrides = {}) {
  return {
    generatedAt: "2026-08-31T09:00:00.000Z",
    degraded: false,
    suspiciousMarkers: [],
    watcher: { heartbeatMs: Date.now(), ageSeconds: 10, state: "alive" },
    workspaces: [ws("Alpha", { openRows: [] })],
    cross: ws("cross", { openRows: [] }),
    duplicateOpenAcrossLedgers: { count: 0, examples: [] },
    plist: { checked: true, mismatched: false },
    ...overrides,
  };
}

const emptyPriorLedgers = {
  workspaces: {},
  cross: { total: 0, open: 0, done: 0, wontfix: 0, openRows: [] },
};

function rollupSnap({ inputs = {}, artifactExists = true, handEdited = false, fileStale = false } = {}) {
  return { available: true, bodyHash: "abc123def456", inputs, artifactExists, handEdited, fileStale };
}

function priorRollupState(inputs = {}) {
  return { bodyHash: "abc123def456", inputs };
}

// ─────────────────────────────────────────────────────────────────────────
// computeDiff — (a) the STATE-based facts (fileStale/handEdited/artifactExists)
// ─────────────────────────────────────────────────────────────────────────

test("first run, but the on-disk file is fully current: zero ecosystem lines", () => {
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs: { a: "hash1" }, artifactExists: true }) });
  const diff = computeDiff(snapshot, null);
  assert.equal(diff.firstRun, true);
  assert.equal(diff.fileStale, false);
  assert.equal(diff.handEdited, false);
  assert.deepEqual(diff.ecosystemLines, []);
});

test("artifact does not exist yet: reported regardless of firstRun (state-based, not diff-based)", () => {
  const snapshot = baseSnapshot({ rollup: rollupSnap({ artifactExists: false, fileStale: true }) });
  const diff = computeDiff(snapshot, null);
  assert.equal(diff.fileStale, true);
  assert.ok(diff.ecosystemLines.some((l) => l.includes("does not exist yet")));
});

test("hand-edited file is reported distinctly from a plain-stale one", () => {
  const snapshot = baseSnapshot({ rollup: rollupSnap({ artifactExists: true, handEdited: true, fileStale: true }) });
  const diff = computeDiff(snapshot, priorRollupState({}));
  assert.equal(diff.handEdited, true);
  assert.ok(diff.ecosystemLines.some((l) => l.includes("hand-edited")));
  assert.ok(!diff.ecosystemLines.some((l) => l.includes("is stale —")), "hand-edited message must win over the generic stale message");
});

test("stale-but-not-hand-edited file gets the plain stale message", () => {
  const snapshot = baseSnapshot({ rollup: rollupSnap({ artifactExists: true, handEdited: false, fileStale: true }) });
  const diff = computeDiff(snapshot, priorRollupState({}));
  assert.equal(diff.fileStale, true);
  assert.equal(diff.handEdited, false);
  assert.ok(diff.ecosystemLines.some((l) => l.includes("is stale —")));
});

test("vanished-signal: rollup was available last run and is not now -> explicit failure line, fileStale/handEdited stay null (unknown, never false)", () => {
  const snapshot = baseSnapshot({ rollup: { available: false, error: "derivation boom" } });
  const prior = { ...emptyPriorLedgers, rollup: priorRollupState({ a: "hash1" }) };
  const diff = computeDiff(snapshot, prior);
  assert.equal(diff.fileStale, null, "unavailable must read as unknown, not as a clean 'false'");
  assert.equal(diff.handEdited, null);
  assert.ok(diff.ecosystemLines.some((l) => l.includes("!! ecosystem rollup unavailable: derivation boom")));
});

test("missing snapshot.rollup entirely does not crash computeDiff (older/synthetic snapshots)", () => {
  const snapshot = baseSnapshot();
  const diff = computeDiff(snapshot, emptyPriorLedgers);
  assert.deepEqual(diff.ecosystemLines, []);
  assert.equal(diff.fileStale, null);
  assert.equal(diff.handEdited, null);
  assert.deepEqual(diff.inputsChanged, []);
  assert.deepEqual(diff.inputsAppeared, []);
  assert.deepEqual(diff.inputsVanished, []);
  assert.deepEqual(diff.becameUnreadable, []);
});

// ─────────────────────────────────────────────────────────────────────────
// computeDiff — (b) the DIFF-based input transitions, all four buckets plus
// the two named edge cases from the brief: ABSENT -> hash (a workspace
// gaining state) and hash -> UNREADABLE.
// ─────────────────────────────────────────────────────────────────────────

test("probe comes online with no prior rollup baseline: states it once, no full diff", () => {
  const snapshot = baseSnapshot({
    rollup: rollupSnap({ inputs: { "A/STATE.md": "hash1", "B/STATE.md": "hash2" } }),
  });
  const diff = computeDiff(snapshot, emptyPriorLedgers); // prior exists but predates the `rollup` key
  assert.deepEqual(diff.inputsAppeared, []);
  assert.ok(diff.ecosystemLines.some((l) => /ecosystem rollup online: 2 tracked input/.test(l)));
});

test("no change: identical input maps produce zero transitions", () => {
  const inputs = { "A/STATE.md": "hash1" };
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs }) });
  const diff = computeDiff(snapshot, { ...emptyPriorLedgers, rollup: priorRollupState(inputs) });
  assert.deepEqual(diff.inputsChanged, []);
  assert.deepEqual(diff.inputsAppeared, []);
  assert.deepEqual(diff.inputsVanished, []);
  assert.deepEqual(diff.becameUnreadable, []);
  assert.deepEqual(diff.ecosystemLines, []);
});

test("ABSENT -> hash: a workspace gaining state is reported as appeared", () => {
  const before = { "A/STATE.md": "ABSENT" };
  const after = { "A/STATE.md": "newhash1" };
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs: after }) });
  const diff = computeDiff(snapshot, { ...emptyPriorLedgers, rollup: priorRollupState(before) });
  assert.equal(diff.inputsAppeared.length, 1);
  assert.deepEqual(diff.inputsAppeared[0], { key: "A/STATE.md", before: "ABSENT", after: "newhash1" });
  assert.ok(diff.ecosystemLines.some((l) => l === "+ A/STATE.md (newhash1)"));
});

test("hash -> ABSENT: a workspace's state file disappearing is reported as vanished", () => {
  const before = { "A/STATE.md": "hash1" };
  const after = { "A/STATE.md": "ABSENT" };
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs: after }) });
  const diff = computeDiff(snapshot, { ...emptyPriorLedgers, rollup: priorRollupState(before) });
  assert.equal(diff.inputsVanished.length, 1);
  assert.deepEqual(diff.inputsVanished[0], { key: "A/STATE.md", before: "hash1", after: "ABSENT" });
  assert.ok(diff.ecosystemLines.some((l) => l === "- A/STATE.md (was hash1)"));
});

test("hash -> different hash: a plain content edit is reported as changed", () => {
  const before = { "A/STATE.md": "hash1" };
  const after = { "A/STATE.md": "hash2" };
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs: after }) });
  const diff = computeDiff(snapshot, { ...emptyPriorLedgers, rollup: priorRollupState(before) });
  assert.equal(diff.inputsChanged.length, 1);
  assert.deepEqual(diff.inputsChanged[0], { key: "A/STATE.md", before: "hash1", after: "hash2" });
  assert.ok(diff.ecosystemLines.some((l) => l === "~ A/STATE.md (hash1 -> hash2)"));
});

test("hash -> UNREADABLE: a file that stops being readable is becameUnreadable, not changed", () => {
  const before = { "A/STATE.md": "hash1" };
  const after = { "A/STATE.md": "UNREADABLE:EACCES" };
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs: after }) });
  const diff = computeDiff(snapshot, { ...emptyPriorLedgers, rollup: priorRollupState(before) });
  assert.equal(diff.becameUnreadable.length, 1);
  assert.deepEqual(diff.becameUnreadable[0], { key: "A/STATE.md", before: "hash1", after: "UNREADABLE:EACCES" });
  assert.deepEqual(diff.inputsChanged, [], "a became-unreadable transition must not ALSO be double-counted as changed");
  assert.ok(diff.ecosystemLines.some((l) => l === "! A/STATE.md became unreadable (hash1 -> UNREADABLE:EACCES)"));
});

test("UNREADABLE -> hash: recovering from unreadable is reported as changed, per compareInputs' own contract", () => {
  const before = { "A/STATE.md": "UNREADABLE:EACCES" };
  const after = { "A/STATE.md": "hash1" };
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs: after }) });
  const diff = computeDiff(snapshot, { ...emptyPriorLedgers, rollup: priorRollupState(before) });
  assert.equal(diff.inputsChanged.length, 1);
  assert.deepEqual(diff.inputsChanged[0], { key: "A/STATE.md", before: "UNREADABLE:EACCES", after: "hash1" });
  assert.deepEqual(diff.becameUnreadable, []);
});

test("multiple simultaneous transitions across different keys are all reported, not just the first", () => {
  const before = { a: "h1", b: "h2", c: "h3", d: "ABSENT" };
  const after = { a: "h1", b: "h2x", c: "ABSENT", d: "h4" };
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs: after }) });
  const diff = computeDiff(snapshot, { ...emptyPriorLedgers, rollup: priorRollupState(before) });
  assert.equal(diff.inputsChanged.length, 1); // b
  assert.equal(diff.inputsVanished.length, 1); // c
  assert.equal(diff.inputsAppeared.length, 1); // d
  assert.deepEqual(diff.becameUnreadable, []);
});

// ─────────────────────────────────────────────────────────────────────────
// formatDigest — rendering + quiet-day participation
// ─────────────────────────────────────────────────────────────────────────

test("formatDigest renders an ECOSYSTEM section with one changed and one appeared input", () => {
  const before = { "A/STATE.md": "hash1", "B/STATE.md": "hash2" };
  const after = { "A/STATE.md": "hash1x", "B/STATE.md": "hash2", "C/STATE.md": "hash3" };
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs: after }) });
  const diff = computeDiff(snapshot, { ...emptyPriorLedgers, rollup: priorRollupState(before) });
  const text = formatDigest(diff);
  assert.match(text, /ECOSYSTEM — ECOSYSTEM\.md rollup:/);
  assert.match(text, /~ A\/STATE\.md \(hash1 -> hash1x\)/);
  assert.match(text, /\+ C\/STATE\.md \(hash3\)/);
});

test("formatDigest stays quiet (no ECOSYSTEM section, quiet-day line) when the file is current and nothing changed", () => {
  const inputs = { "A/STATE.md": "hash1" };
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs, artifactExists: true, fileStale: false, handEdited: false }) });
  const diff = computeDiff(snapshot, { ...emptyPriorLedgers, rollup: priorRollupState(inputs) });
  const text = formatDigest(diff);
  assert.doesNotMatch(text, /ECOSYSTEM/);
  assert.match(text, /no change/);
});

test("formatDigest renders the hand-edited line when the artifact was edited by hand", () => {
  const inputs = { "A/STATE.md": "hash1" };
  const snapshot = baseSnapshot({ rollup: rollupSnap({ inputs, artifactExists: true, handEdited: true, fileStale: true }) });
  const diff = computeDiff(snapshot, { ...emptyPriorLedgers, rollup: priorRollupState(inputs) });
  const text = formatDigest(diff);
  assert.match(text, /ECOSYSTEM — ECOSYSTEM\.md rollup:/);
  assert.match(text, /hand-edited since it was last generated/);
});

// ─────────────────────────────────────────────────────────────────────────
// THE LOAD-BEARING TEST — the digest never writes ECOSYSTEM.md.
// Two layers: a source-level assertion (fast, catches the shape of the
// 2026-08-14 digest.mjs defect directly — a write call reachable from a
// path that reads as read-only) and a REAL execution against an isolated
// fixture directory (measures the actual side effect, never stdout text —
// rule:safety-flag-needs-a-test's own words: "a guard that trusts the
// tool's own description of itself is the failure the rule exists to
// catch").
// ─────────────────────────────────────────────────────────────────────────

test("source: digest.mjs contains no writeFileSync call anywhere", () => {
  // digest.mjs uses ONLY the async fs/promises `writeFile` (for its own
  // digest-state file and DAILY.md, both via atomic temp+rename) — never the
  // synchronous `writeFileSync` commands/rollup.mjs uses for ECOSYSTEM.md.
  // If this ever matches, something started writing synchronously, which is
  // not a pattern used anywhere else in this file and is worth a second
  // look regardless of what it targets.
  assert.equal(DIGEST_SRC.match(/writeFileSync\(/g), null, "digest.mjs must never call writeFileSync");
});

test("source: digest.mjs has exactly its two known writeFile() call sites, and neither targets an artifact/ECOSYSTEM path", () => {
  const matches = DIGEST_SRC.match(/writeFile\([^)]*\)/g) || [];
  assert.equal(matches.length, 2, `expected exactly 2 writeFile() call sites (digest-state + DAILY.md), found ${matches.length}: ${JSON.stringify(matches)}`);
  for (const m of matches) {
    assert.doesNotMatch(m, /artifact/i, `a writeFile() call site mentions "artifact": ${m}`);
    assert.doesNotMatch(m, /ecosystem/i, `a writeFile() call site mentions "ECOSYSTEM": ${m}`);
  }
});

test("source: rollupSnapshot() never calls renderRollup and then writes — it only calls it to hash", () => {
  // Extract rollupSnapshot()'s own body textually (from its declaration to
  // the next top-level `function` declaration) and assert no write-shaped
  // call appears inside it at all.
  const start = DIGEST_SRC.indexOf("function rollupSnapshot(");
  assert.ok(start !== -1, "rollupSnapshot() not found in digest.mjs — has it been renamed?");
  const next = DIGEST_SRC.indexOf("\nfunction ", start + 1);
  const body = next === -1 ? DIGEST_SRC.slice(start) : DIGEST_SRC.slice(start, next);
  assert.doesNotMatch(body, /writeFile/i, "rollupSnapshot()'s body must contain no write call of any kind");
});

const ABSENT = Symbol.for("propagate:digest-rollup-test:absent");
function snap(p) {
  return existsSync(p) ? readFileSync(p) : ABSENT;
}

async function scopedRoot() {
  return mkdtemp(path.join(tmpdir(), "digest-rollup-root-"));
}

/**
 * Runs `rollupSnapshotForTest()` for real, in a SEPARATE process with
 * `PROPAGATE_SEARCH_ROOTS` pinned to `searchRoot` — `SEARCH_ROOTS` (and
 * therefore `rollupArtifactPath()`) is resolved once at module-evaluation
 * time in `lib/core/config.mjs`, so setting `process.env` after this test
 * file has already imported `digest.mjs` would be too late to matter. This
 * mirrors `tests/cli/rollup-dryrun.test.mjs`'s own `runCli()` helper
 * exactly, one layer down (the exported function instead of the CLI verb).
 */
function runRollupSnapshotInSubprocess(searchRoot) {
  const script = `
    import { rollupSnapshotForTest } from ${JSON.stringify(DIGEST_PATH)};
    const r = rollupSnapshotForTest();
    process.stdout.write(JSON.stringify(r));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot },
    timeout: 30_000,
  });
}

test("real execution: rollupSnapshot() against an artifact-absent fixture leaves ECOSYSTEM.md absent", async () => {
  const searchRoot = await scopedRoot();
  try {
    const artifact = path.join(searchRoot, "ECOSYSTEM.md");
    const before = snap(artifact);
    assert.equal(before, ABSENT, "fixture setup: artifact must start absent");

    const r = runRollupSnapshotInSubprocess(searchRoot);
    assert.equal(r.status, 0, `subprocess failed: ${r.stdout}${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.available, true);
    assert.equal(parsed.artifactExists, false);
    assert.equal(parsed.fileStale, true, "an absent artifact must read as stale, per rollup --check's own reading");

    const after = snap(artifact);
    assert.equal(after, ABSENT, "rollupSnapshot() must NEVER create ECOSYSTEM.md, even to report it as stale");
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
  }
});

test("real execution: rollupSnapshot() against a pre-existing hand-edited ECOSYSTEM.md leaves it byte-identical", async () => {
  const searchRoot = await scopedRoot();
  try {
    const artifact = path.join(searchRoot, "ECOSYSTEM.md");
    await writeFile(artifact, "# not generated by propagate\n\nhand-written content.\n", "utf8");
    const before = snap(artifact);
    assert.notEqual(before, ABSENT);

    const r = runRollupSnapshotInSubprocess(searchRoot);
    assert.equal(r.status, 0, `subprocess failed: ${r.stdout}${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.handEdited, true, "a foreign file with no propagate footer must read as hand-edited");
    assert.equal(parsed.fileStale, true);

    const after = snap(artifact);
    assert.deepEqual(after, before, "rollupSnapshot() must NEVER touch an existing ECOSYSTEM.md, hand-edited or not");
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
  }
});
