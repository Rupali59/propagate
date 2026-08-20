/**
 * `cli doctor` — I1 "no silent no-op" surfacing (docs/SPEC.md §2, docs/ISSUES.md
 * N1/N7/N12).
 *
 * Follows `tests/drain.test.mjs`'s subprocess pattern: WORKSPACES is computed
 * at `cli.mjs`'s module-load time from `lib/config.mjs`'s SEARCH_ROOTS, which
 * reads `PROPAGATE_SEARCH_ROOTS` — so scoping doctor to a temp workspace (or to
 * zero workspaces) requires a subprocess with that env var set, not an
 * in-process import.
 *
 * The N12 (DECISIONS.md attribution) checks are unit-tested directly against
 * `decisionsAttributionReport`, exported from cli.mjs for exactly this reason
 * — no need to shell out or touch the skill's real docs/DECISIONS.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decisionsAttributionReport } from "../../cli.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

/** Build a throwaway workspace: `.propagates.yml` (workspace: true) + a seeded ledger. */
async function makeWorkspace(lines) {
  const root = await mkdtemp(path.join(tmpdir(), "doctor-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  const jsonlPath = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
  await writeFile(jsonlPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  return { root, jsonlPath };
}

function driftLine(id, overrides = {}) {
  return JSON.stringify({
    type: "drift",
    id,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    source: `${id}.md`,
    change: `drift on ${id}`,
    status: "open",
    ...overrides,
  });
}

/**
 * Run `node cli.mjs doctor` as a subprocess scoped to `root` (or with no
 * roots at all). Sets PROPAGATE_STATE_DIR alongside PROPAGATE_SEARCH_ROOTS
 * (GOTCHAS G10: "one override moves all the paths together") — doctor now
 * writes metrics.jsonl every run, so without this every test invocation
 * would append to the real production metrics.jsonl.
 */
function runDoctor(root, stateDir = root) {
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: stateDir },
  });
}

test("doctor fails when a ledger contains an unknown row type, and names the type (N1)", async () => {
  const { root, jsonlPath } = await makeWorkspace([
    driftLine("001"),
    JSON.stringify({ type: "not-a-real-type", id: "002", timestamp: new Date().toISOString(), status: "open" }),
  ]);
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, "doctor must exit non-zero when an unknown row type is present");
    assert.match(out, /no row types unknown to the reader/);
    assert.match(out, /"not-a-real-type"/, "output names the offending type string");
    assert.match(out, new RegExp(jsonlPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "output names the ledger");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor fails on malformed JSONL lines and names the ledger's workspace", async () => {
  const { root } = await makeWorkspace([driftLine("001"), '{"type":"drift","id":"002",']);
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, "doctor must exit non-zero on a malformed line");
    assert.match(out, /no malformed ledger lines/);
    // The existing malformed-line check (cli.mjs) names the ledger by
    // workspace name (ws.name), derived from the temp dir's basename.
    assert.match(out, new RegExp(path.basename(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor fails when zero workspaces are discovered, not silently pass (N7)", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "doctor-empty-"));
  try {
    const result = runDoctor(empty);
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, "zero discovered workspaces must fail doctor, not report healthy");
    assert.match(out, /at least one workspace discovered/);
    // Contract, not phrasing: name the condition AND the action. This asserted the
    // literal "zero workspaces found" until 2026-08-19, which made it go red when the
    // message was improved to distinguish a missing root from an unmarked one — a test
    // that forbids its subject from getting better.
    assert.match(out, /contains no workspace|search root/i, "must name the condition");
    assert.match(out, /\.propagates\.yml|run `init`/, "must name the action");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("doctor's new checks pass cleanly on a healthy ledger (no spurious failure)", async () => {
  const { root } = await makeWorkspace([driftLine("001"), driftLine("002")]);
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    // These are the checks this round of work added/touched; assert each is
    // green regardless of what unrelated machine-specific checks (launchd,
    // heartbeat, real plist) do on the box running the test.
    //
    // "no row types unknown to the reader" and "at least one workspace
    // discovered" are now informational restatements (GOTCHAS G20) — the
    // sole assertion for both moved to EXPECTATIONS, surfaced here as the
    // "all calibrated expectations hold" green line instead of a per-line ✓.
    assert.match(out, /·.*no row types unknown to the reader/);
    assert.match(out, /·.*at least one workspace discovered/);
    assert.match(out, /✓.*no malformed ledger lines/);
    assert.match(out, /✓.*all calibrated expectations hold/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor reports the retired watcher as informational only, never a failure, and asserts the v2 replacement's health instead", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;

    // The retirement section exists and is clearly labeled...
    assert.match(out, /launchd watcher — RETIRED/);
    // ...and neither of its two facts (plist loaded, heartbeat age) is ever
    // printed with a ✗ — a retired component going stale must not read as
    // broken (task brief; docs/GOTCHAS.md G2 "absence must be attributable").
    const retiredSectionStart = out.indexOf("launchd watcher — RETIRED");
    const replacementSectionStart = out.indexOf("v2 replacement");
    assert.notEqual(replacementSectionStart, -1, "replacement health section must exist");
    const retiredSection = out.slice(retiredSectionStart, replacementSectionStart);
    assert.doesNotMatch(retiredSection, /✗/, "no ✗ inside the retired watcher section");
    assert.match(retiredSection, /·.*plist loaded/);
    // Scoped test env: PROPAGATE_STATE_DIR is a fresh temp dir, so there is
    // no heartbeat file yet — that's the "heartbeat file" branch, not
    // "heartbeat age" (which only prints once one exists). Either way it
    // must stay informational (`·`), asserted above via retiredSection.
    assert.match(retiredSection, /·.*heartbeat (file|age)/);

    // The replacement's health is what CAN fail now: event store readable,
    // and reconcile completes. Both checks must be present and run (not
    // skipped) — a scoped temp workspace legitimately has zero events, so
    // "non-empty" failing here is the check correctly doing its job, not a
    // spurious failure like the ones this checks against.
    assert.match(out, /event store readable/);
    assert.match(out, /event store non-empty/);
    assert.match(out, /reconcile completes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GOTCHAS G20: doctor used to carry TWO mechanisms asserting the same fact for
// workspaces.discovered / decisions.with_tokens / ledger.unknown_types /
// sidecars.rejected — an inline check() AND an EXPECTATIONS entry — so one
// real defect printed two ✗ lines (observed live: a single hand-authored
// An unknown-typed ledger row produced both "✗ no row types unknown to the reader"
// and "✗ ledger.unknown_types == 0"). These tests pin the fixed shape: the
// EXPECTATIONS entry is now the SOLE assertion for those four subjects, and
// the previously-duplicate inline check is downgraded to an informational
// `·` line that never turns red.
// ─────────────────────────────────────────────────────────────────────────────

/** Count non-overlapping matches of `re` (with the `g` flag) in `text`. */
function countMatches(text, re) {
  return (text.match(re) || []).length;
}

test("G20: an unknown ledger row type produces exactly ONE ✗ line, not two", async () => {
  const { root, jsonlPath } = await makeWorkspace([
    driftLine("001"),
    JSON.stringify({ type: "not-a-real-type", id: "002", timestamp: new Date().toISOString(), status: "open" }),
  ]);
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0);
    // The old inline check's label must never appear as a ✗ — only as the
    // informational `·` restatement.
    assert.equal(
      countMatches(out, /✗[^\n]*no row types unknown to the reader/g),
      0,
      "the old per-workspace inline check must no longer fail on its own",
    );
    assert.match(
      out,
      /·[^\n]*no row types unknown to the reader/,
      "the inline check still prints, just informationally",
    );
    // The sole assertion is the EXPECTATIONS entry, and it fires exactly once
    // for this run (one workspace, one offending row) even though the
    // per-workspace loop that gathers the count could in principle run
    // several times.
    assert.equal(
      countMatches(out, /✗[^\n]*ledger\.unknown_types == 0/g),
      1,
      "ledger.unknown_types is asserted exactly once",
    );
    // Every ✗ line anywhere in the run naming "unknown" must be this single
    // EXPECTATIONS line — i.e. 4 defects worth of checks did not become 5
    // printed problems the way they did before G20's fix.
    assert.equal(
      countMatches(out, /✗[^\n]*unknown[^\n]*/gi),
      1,
      "exactly one ✗ line total references the unknown-row-type defect",
    );
    // Non-negotiable: the surviving message is at least as informative as the
    // inline check it replaced — same ledger path, same offending type, same
    // count.
    assert.match(out, new RegExp(jsonlPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "names the ledger path");
    assert.match(out, /"not-a-real-type"×1/, "names the offending type and its count");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("G20: zero discovered workspaces produces exactly ONE ✗ line, not two", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "doctor-empty-"));
  try {
    const result = runDoctor(empty);
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0);
    assert.equal(
      countMatches(out, /✗[^\n]*at least one workspace discovered/g),
      0,
      "the old inline check must no longer fail on its own",
    );
    assert.equal(
      countMatches(out, /✗[^\n]*workspaces\.discovered >= 1/g),
      1,
      "workspaces.discovered is asserted exactly once, by EXPECTATIONS",
    );
    // The point of this assertion is that EXPECTATIONS' detail and the inline check
    // describe the same state in the same words (G20), not that any particular
    // sentence survives. Both now render config.searchRootsExplain().
    assert.match(
      out,
      /contains no workspace|search root/i,
      "detail from the old inline check is preserved (same wording, both sites)",
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("G20: a healthy fixture produces zero ✗ lines for any of the four sole-source subjects", async () => {
  const { root } = await makeWorkspace([driftLine("001"), driftLine("002")]);
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    for (const re of [
      /✗[^\n]*workspaces\.discovered/g,
      /✗[^\n]*decisions\.with_tokens/g,
      /✗[^\n]*ledger\.unknown_types/g,
      /✗[^\n]*sidecars\.rejected/g,
    ]) {
      assert.equal(countMatches(out, re), 0, `${re} must not fire on a clean fixture`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing plist is informational, not a failure (the watcher was retired on purpose)", async () => {
  // Changed 2026-08-14. This used to assert a ✗ here, because "no plist" was a
  // fault. The watcher was retired and its plist deleted deliberately, so absence
  // is now the expected state and a ✗ would be a permanent red check for a
  // component that no longer exists (G20). Per G2 the line must still say WHY it
  // is absent rather than vanishing.
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    const out = runDoctor(root).stdout + runDoctor(root).stderr;
    assert.equal(
      countMatches(out, /✗[^\n]*plist/gi),
      0,
      "a missing plist must not produce a ✗ — the watcher is retired",
    );
    assert.match(out, /plist WatchPaths — n\/a/, "absence must still be reported, with a reason");
    assert.match(out, /retired 2026-08-14/, "the reason must name the retirement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("G20: plist.watchpaths stays a single inline assertion — not duplicated into EXPECTATIONS", async () => {
  // Trigger the failure the way it can still legitimately happen: a plist that
  // EXISTS but whose WatchPaths disagree with discovery. Using a *missing* plist
  // (the old trigger) no longer fires, and a check that cannot be made to fail is
  // worthless as a guard (G1) — so this plants a bad one instead of deleting the test.
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    const label = process.env.PROPAGATE_LABEL || "com.tathya.propagate.watcher";
    await writeFile(
      path.join(root, `${label}.plist`),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>WatchPaths</key><array><string>/nonexistent/stale/path</string></array>
</dict></plist>`,
      "utf8",
    );
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    assert.match(out, /✗[^\n]*plist WatchPaths matches discovered workspaces/);
    // No second, EXPECTATIONS-driven ✗ mentioning plist.watchpaths anywhere
    // in the Metrics section — it was deliberately removed from EXPECTATIONS
    // because the inline check is strictly richer (GOTCHAS G20).
    assert.equal(
      countMatches(out, /✗[^\n]*plist\.watchpaths/g),
      0,
      "plist.watchpaths must not also be asserted by EXPECTATIONS",
    );
    assert.equal(countMatches(out, /✗[^\n]*plist/gi), 1, "exactly one ✗ line total references plist");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decisionsAttributionReport: every entry zero tokens on a non-empty file is allZero (N12)", () => {
  const text = [
    "## 2026-08-01: first decision",
    "",
    "Some body text with no Affects line at all.",
    "",
    "## 2026-08-02: second decision",
    "",
    "Affects:",
    "",
  ].join("\n");
  const { entries, zero, allZero } = decisionsAttributionReport(text);
  assert.equal(entries.length, 2);
  assert.equal(zero.length, 2);
  assert.equal(allZero, true);
});

test("decisionsAttributionReport: some zero, some not — reports the zero subset by date/title, not allZero", () => {
  const text = [
    "## 2026-08-01: has tokens",
    "",
    "**Affects:** propagate, cli.mjs",
    "",
    "## 2026-08-02: missing tokens",
    "",
    "Some body text with no Affects line at all.",
    "",
  ].join("\n");
  const { entries, zero, allZero } = decisionsAttributionReport(text);
  assert.equal(entries.length, 2);
  assert.equal(zero.length, 1);
  assert.equal(zero[0].date, "2026-08-02");
  assert.equal(zero[0].title, "missing tokens");
  assert.equal(allZero, false);
});

test("decisionsAttributionReport: healthy file (all entries have tokens) reports zero-length zero[], allZero false", () => {
  const text = [
    "## 2026-08-01: first",
    "",
    "**Affects:** propagate",
    "",
    "## 2026-08-02: second",
    "",
    "**Affects:** cli.mjs, lib/ledger.mjs",
    "",
  ].join("\n");
  const { entries, zero, allZero } = decisionsAttributionReport(text);
  assert.equal(entries.length, 2);
  assert.equal(zero.length, 0);
  assert.equal(allZero, false);
});

test("decisionsAttributionReport: empty file is not allZero (no entries, not a bug state)", () => {
  const { entries, zero, allZero } = decisionsAttributionReport("");
  assert.equal(entries.length, 0);
  assert.equal(zero.length, 0);
  assert.equal(allZero, false);
});
