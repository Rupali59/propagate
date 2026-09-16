/**
 * doctor's `# Delivery` section — is the plugin anyone RUNS the same code as this repo?
 *
 * WHAT THIS PINS, AND WHY IT IS NOT A VERSION COMPARISON. On 2026-09-16 the served
 * plugin was 0.5.0 while source was 0.6.1 — four merged PRs authored and not
 * delivered, with `commands/goals.mjs` and `lib/claims/restate.mjs` absent from the
 * served tree. Every check in the repo stayed green because every check reads SOURCE.
 *
 * The subtler half: in that incident every manifest read the same number and agreed
 * with every other manifest while the served tree was still missing modules. So the
 * load-bearing assertion here is that a MATCHING VERSION WITH DIFFERENT CONTENT is
 * its own outcome, never folded into "current". A test that only compared version
 * strings would pass on the exact defect this section exists to catch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyServed, servedTrees, checkDelivery } from "../../lib/report/doctor/delivery.mjs";

/** Minimal stand-in for lib/report/doctor/reporter.mjs — collects, never prints. */
function fakeReporter() {
  const entries = [];
  return {
    entries,
    problems: 0,
    header(label) { entries.push({ kind: "header", label }); },
    check(label, ok, detail = "") { entries.push({ kind: "check", label, ok, detail }); if (!ok) this.problems += 1; },
    warn(label, detail = "") { entries.push({ kind: "warn", label, detail }); },
    info(label, detail = "") { entries.push({ kind: "info", label, detail }); },
    note(label) { entries.push({ kind: "note", label }); },
  };
}

function cacheFixture(trees) {
  const root = mkdtempSync(path.join(tmpdir(), "delivery-cache-"));
  for (const { marketplace, version, cli } of trees) {
    const dir = path.join(root, marketplace, "propagate", version);
    mkdirSync(dir, { recursive: true });
    if (cli !== null) writeFileSync(path.join(dir, "cli.mjs"), cli);
  }
  return root;
}

function repoFixture({ version, cli }) {
  const root = mkdtempSync(path.join(tmpdir(), "delivery-repo-"));
  if (version !== null) writeFileSync(path.join(root, "VERSION"), `${version}\n`);
  if (cli !== null) writeFileSync(path.join(root, "cli.mjs"), cli);
  return root;
}

// ── the classifier: three states, and the middle one is the point ──────────

test("same version AND same content is `current`", () => {
  assert.equal(
    classifyServed({ servedVersion: "1.0.0", sourceVersion: "1.0.0", servedHash: "aa", sourceHash: "aa" }).state,
    "current",
  );
});

test("a different version is `stale` — the shape that cost four PRs", () => {
  const v = classifyServed({ servedVersion: "0.5.0", sourceVersion: "0.6.1", servedHash: "aa", sourceHash: "bb" });
  assert.equal(v.state, "stale");
  assert.match(v.why, /0\.5\.0/);
  assert.match(v.why, /0\.6\.1/, "both versions must be named — a reader should not have to go look one up");
});

test("MATCHING version with DIFFERENT content is `incoherent`, never `current`", () => {
  // The load-bearing case. A version-only comparison returns "current" here, which
  // is exactly how the real incident stayed invisible.
  const v = classifyServed({ servedVersion: "0.6.1", sourceVersion: "0.6.1", servedHash: "aaaa", sourceHash: "bbbb" });
  assert.equal(v.state, "incoherent");
  assert.notEqual(v.state, "current");
});

test("an unhashable side is `incoherent`, not silently `current`", () => {
  // A reader that cannot compare must not report agreement
  // (`rule:discernment-checks` §6 — a reader that cannot report failure invents an answer).
  assert.equal(
    classifyServed({ servedVersion: "1.0.0", sourceVersion: "1.0.0", servedHash: null, sourceHash: "aa" }).state,
    "incoherent",
  );
});

// ── discovery ──────────────────────────────────────────────────────────────

test("servedTrees finds every tree, not just the newest", () => {
  const root = cacheFixture([
    { marketplace: "tathya", version: "0.5.0", cli: "old" },
    { marketplace: "tathya", version: "0.6.1", cli: "new" },
  ]);
  try {
    const found = servedTrees(root).map((t) => t.version).sort();
    assert.deepEqual(found, ["0.5.0", "0.6.1"], "a half-finished update leaves two — picking one would hide it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("servedTrees on a missing cache root returns empty, never throws", () => {
  assert.deepEqual(servedTrees(path.join(tmpdir(), "definitely-not-here-" + Date.now())), []);
});

// ── the section: three-state reporting ─────────────────────────────────────

test("NOT INSTALLED and CURRENT do not render alike", async () => {
  // The distinction this whole section exists to preserve. "Nothing to compare"
  // and "compared and agreeing" are different facts (`rule:discernment-checks` §2),
  // and only one of them means the plugin is up to date.
  const repo = repoFixture({ version: "1.0.0", cli: "same" });
  const emptyCache = mkdtempSync(path.join(tmpdir(), "delivery-empty-"));
  const okCache = cacheFixture([{ marketplace: "m", version: "1.0.0", cli: "same" }]);
  try {
    const rNone = fakeReporter();
    await checkDelivery({ reporter: rNone, repoRoot: repo, cacheRoot: emptyCache });
    const rOk = fakeReporter();
    await checkDelivery({ reporter: rOk, repoRoot: repo, cacheRoot: okCache });

    const noneText = JSON.stringify(rNone.entries);
    const okText = JSON.stringify(rOk.entries);
    assert.match(noneText, /not installed/, "an absent plugin must say so in those words");
    assert.doesNotMatch(noneText, /identical/, "absence must never borrow the wording of agreement");
    assert.match(okText, /identical/);
    assert.notEqual(noneText, okText);
  } finally {
    for (const d of [repo, emptyCache, okCache]) rmSync(d, { recursive: true, force: true });
  }
});

test("an unreadable VERSION is attributable, never a silent pass", async () => {
  const repo = repoFixture({ version: null, cli: "x" });
  const cache = cacheFixture([{ marketplace: "m", version: "1.0.0", cli: "x" }]);
  try {
    const r = fakeReporter();
    await checkDelivery({ reporter: r, repoRoot: repo, cacheRoot: cache });
    assert.match(JSON.stringify(r.entries), /could not read|cannot be judged/);
  } finally {
    for (const d of [repo, cache]) rmSync(d, { recursive: true, force: true });
  }
});

test("NOTHING in this section touches doctor's exit code", async () => {
  // Deliberate, and a correction to this module's first version. It failed on
  // `incoherent` and then fired on its first real run — correctly — because cli.mjs
  // had been edited since the last `plugin update`, which is the normal state of a
  // repo someone is working in. A health check that goes red during ordinary
  // development trains people to ignore it. Doctor's exit code is about THIS REPO;
  // which plugin version a machine has installed is a fact about the machine.
  const repo = repoFixture({ version: "1.0.0", cli: "source-side" });
  const cache = cacheFixture([
    { marketplace: "m", version: "1.0.0", cli: "served-side-DIFFERENT" }, // incoherent
    { marketplace: "m2", version: "0.1.0", cli: "whatever" },             // stale
  ]);
  try {
    const r = fakeReporter();
    await checkDelivery({ reporter: r, repoRoot: repo, cacheRoot: cache });
    assert.equal(r.problems, 0, "no delivery outcome may fail doctor");
    // ...and it must still have SAID something about both, or "does not fail" would
    // just mean "does not look".
    const text = JSON.stringify(r.entries);
    assert.match(text, /differs|could not be hashed/);
    assert.match(text, /0\.1\.0/);
  } finally {
    for (const d of [repo, cache]) rmSync(d, { recursive: true, force: true });
  }
});
