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

/** Strip ANSI so assertions match the check line, not its colour codes. */
const strip = (t) => t.replace(/\x1B\[[0-9;]*m/g, "");

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
    // PLATFORM-CONDITIONAL, because the line itself is. Phase 3 made the launchd probe
    // fire only when `LAUNCHD_ACTIVE` (scheduler === launchd AND platform === darwin), so
    // on Linux there is no plist line to assert — correctly, since there is no launchd.
    // The test was left asserting a macOS-only string against code that had been made
    // portable, and it failed on CI's ubuntu runner while passing 741/741 locally.
    //
    // The invariant that holds EVERYWHERE is the one worth pinning: whatever the retired
    // section says, it never says it with a ✗ (asserted above). The plist line is checked
    // only where a plist can exist.
    if (process.platform === "darwin") {
      assert.match(retiredSection, /·.*plist loaded/, "on macOS the plist state must still be reported, as info");
    } else {
      assert.doesNotMatch(retiredSection, /plist loaded/, "off darwin there is no launchd, so no plist claim may be made");
    }
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

// ─────────────────────────────────────────────────────────────────────────
// The monitor liveness probe must be able to FAIL.
//
// Until 2026-08-22 it was `info(...)`, never `check(...)`, and it printed
// the last run's timestamp WITHOUT comparing it to now — so a monitor three
// hours dead on a 30-minute interval rendered identically to one that ran
// two minutes ago. Both `cli.mjs` and `docs/SYSTEMS.md` described this
// failure in prose; neither detected it. Measured 2026-08-22: the agent had
// been failing every 1800s for hours while `doctor` printed "all green".
//
// The three-state discipline is preserved and is why the plist gates this:
// the monitor is GENERATED but not ARMED by default, so "no log" and "no
// plist" must stay informational or every fresh install fails forever. Only
// an ARMED monitor (plist on disk) that has run and then gone quiet is a
// failure.
// ─────────────────────────────────────────────────────────────────────────

const MONITOR_LABEL_FOR_TEST = "com.tathya.propagate.monitor";

/** Seed a monitor.log whose last line is `ageMs` old, in the scoped state dir. */
async function seedMonitorLog(stateDir, ageMs) {
  const ts = new Date(Date.now() - ageMs).toISOString();
  await writeFile(
    path.join(stateDir, "monitor.log"),
    `${ts} ran=1 rows=12 actionable=0 notified=0 suppressed=0 ms=800\n`,
    "utf8",
  );
}

/** Put a monitor plist in the scoped dir — PLIST_DIR follows STATE_DIR when scoped. */
async function armMonitor(stateDir) {
  await writeFile(path.join(stateDir, `${MONITOR_LABEL_FOR_TEST}.plist`), "<plist/>\n", "utf8");
}

test("doctor FAILS when an ARMED monitor has gone quiet, and names how long", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    await armMonitor(root);
    await seedMonitorLog(root, 6 * 60 * 60 * 1000); // 6h, against a 30m interval
    const result = runDoctor(root);
    const out = strip(result.stdout + result.stderr);
    // Assert the CHECK LINE, never the process exit code: this fixture fails
    // doctor for unrelated reasons (makeWorkspace writes no ledger .md), so
    // a status assertion here would pass whether or not the probe fired.
    assert.match(out, /✗ monitor is running on schedule/, `probe must fail:\n${out}`);
    assert.match(
      out,
      /✗ monitor is running on schedule[^\n]*\d/,
      "the failure must quantify the staleness on its own line, not just assert it",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor PASSES the monitor check when an armed monitor ran recently", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    await armMonitor(root);
    await seedMonitorLog(root, 60 * 1000); // one minute ago
    const result = runDoctor(root);
    const out = strip(result.stdout + result.stderr);
    assert.doesNotMatch(
      out,
      /✗ monitor is running on schedule/,
      `a fresh monitor must not be reported stale:\n${out}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor names a CRASHING monitor — stderr newer than the log is the only tell", async () => {
  // monitor.log records only SUCCESSFUL runs; a crash goes to
  // monitor.stderr.log, which nothing read. That one mtime comparison is
  // what would have surfaced N43 in seconds instead of hours.
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    await armMonitor(root);
    await seedMonitorLog(root, 6 * 60 * 60 * 1000);
    await writeFile(path.join(root, "monitor.stderr.log"), "Error: Cannot find module\n", "utf8");
    const result = runDoctor(root);
    const out = strip(result.stdout + result.stderr);
    assert.match(out, /✗ monitor is running on schedule/);
    assert.match(
      out,
      /✗ monitor is running on schedule[^\n]*stderr/i,
      "a crashing monitor must be distinguishable from a merely quiet one, on the check line",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor does NOT fail a stale log when the monitor is not armed — disarmed is not broken", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    await seedMonitorLog(root, 6 * 60 * 60 * 1000); // stale, but no plist
    const result = runDoctor(root);
    const out = strip(result.stdout + result.stderr);
    assert.doesNotMatch(
      out,
      /✗ monitor is running on schedule/,
      `an unarmed monitor must never be reported as a failure:\n${out}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor treats a never-run monitor as informational, so a fresh install stays green", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    const result = runDoctor(root); // no log, no plist
    const out = strip(result.stdout + result.stderr);
    assert.doesNotMatch(out, /✗ monitor is running on schedule/, `a fresh install must not fail here:\n${out}`);
    assert.match(out, /never run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// v3 layout conformance — the ratchet for the migration plan.
//
// The predicate itself is unit-tested in tests/unit/v3-layout.test.mjs. What
// THESE cover is the thing a unit test cannot: that doctor actually fails on
// a non-conforming workspace, and that the failure NAMES what is absent.
//
// Measured against the live tree on the day it was written: 1 of 7 workspaces
// conforming. A conformance check that is green before the conforming work has
// happened is not checking anything, so the negative case is the one that
// matters and it is asserted first.
// ─────────────────────────────────────────────────────────────────────────

test("doctor FAILS on a HALF-migrated workspace, and names what is missing", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    // Half-migrated: state/ present, everything else absent. This is the state
    // the check exists for — a workspace someone began moving and stopped.
    await mkdir(path.join(root, "propagation", "state", "someproject"), { recursive: true });
    await writeFile(path.join(root, "propagation", "state", "someproject", "STATE.md"), "# state\n");

    const out = strip(runDoctor(root).stdout + runDoctor(root).stderr);
    assert.match(out, /✗ workspaces conform to the v3 propagation layout/);
    // Attribution, not a bare verdict: the operator has to know WHICH items to
    // create, or the check tells them they are wrong without telling them how.
    assert.match(out, /lacks[^\n]*refs\/snapshot\.json/);
    assert.match(out, /half-migrated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor does NOT fail a workspace nobody has begun migrating — it reports it as not begun", async () => {
  // The negative control, and the one that matters most: requiring the full v3
  // tree unconditionally makes every fresh install fail by definition until the
  // migration completes. tests/cli/stranger-install.test.mjs caught exactly that
  // within one run of the first version of this check.
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    const out = strip(runDoctor(root).stdout + runDoctor(root).stderr);
    assert.doesNotMatch(
      out,
      /✗ workspaces conform to the v3 propagation layout/,
      `an unmigrated workspace must not be a doctor failure:\n${out}`,
    );
    assert.match(out, /v3 migration[^\n]*not begun/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor PASSES the v3 check on a fully conforming workspace", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  try {
    const prop = path.join(root, "propagation");
    await mkdir(path.join(prop, "refs"), { recursive: true });
    await mkdir(path.join(prop, "state", "someproject"), { recursive: true });
    await writeFile(path.join(prop, "README.md"), "# propagation\n");
    await writeFile(path.join(prop, "INDEX.md"), "# index\n");
    await writeFile(path.join(prop, "refs", "snapshot.json"), "{}\n");
    await writeFile(path.join(prop, "refs", "lifecycle.jsonl"), "");
    await writeFile(path.join(prop, "state", "someproject", "STATE.md"), "# state\n");

    const out = strip(runDoctor(root).stdout + runDoctor(root).stderr);
    assert.doesNotMatch(
      out,
      /✗ workspaces conform to the v3 propagation layout/,
      `a conforming workspace must not be reported:\n${out}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Canonical rules — the second caller of the same detector.
//
// The SessionStart hook detects restatements silently and automatically
// (tests/hooks/load-rules-drift.test.mjs); this is the on-demand report.
// Because ONE detector now has TWO callers, the failing case must be
// exercised through BOTH or one path rots unnoticed — which is the whole
// reason `rules check` sat in no gate for weeks and nobody noticed.
// ─────────────────────────────────────────────────────────────────────────

const FIXTURE_RULE = `---
id: fixture-doctor-rule
scope: global
status: active
fingerprint: "the sky is plaid on tuesdays"
supersedes: []
---

**the sky is plaid on tuesdays.** A fixture rule whose fingerprint is a phrase
no real file contains by accident.
`;

/** runDoctor with HOME scoped too, so ~/.claude/rules resolves into the fixture. */
function runDoctorWithHome(root, home) {
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: root, HOME: home },
  });
}

test("doctor FAILS when a CLAUDE.md restates a canonical rule, and names the file", async () => {
  const { root } = await makeWorkspace([driftLine("001")]);
  const home = await mkdtemp(path.join(tmpdir(), "doctor-rules-home-"));
  try {
    await mkdir(path.join(home, ".claude", "rules"), { recursive: true });
    await writeFile(path.join(home, ".claude", "rules", "fixture-doctor-rule.md"), FIXTURE_RULE);
    await writeFile(path.join(root, "CLAUDE.md"), "# p\n\nRemember: the sky is plaid on tuesdays.\n");

    const out = strip(runDoctorWithHome(root, home).stdout + runDoctorWithHome(root, home).stderr);
    assert.match(out, /✗ canonical rules are not restated/);
    assert.match(out, /fixture-doctor-rule/, "must name WHICH rule");
    assert.match(out, /file\(s\)/, "must say how many files were scanned, not just how many findings");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor does NOT fail the rules check on a machine with no rules layer", async () => {
  // The stranger-install property again: a machine that never installed the
  // rules layer must reach doctor-clean, not fail for the absence of an
  // optional component.
  const { root } = await makeWorkspace([driftLine("001")]);
  const home = await mkdtemp(path.join(tmpdir(), "doctor-norules-home-"));
  try {
    const out = strip(runDoctorWithHome(root, home).stdout + runDoctorWithHome(root, home).stderr);
    assert.doesNotMatch(out, /✗ canonical rules are not restated/, `no rules layer must not fail:\n${out}`);
    assert.match(out, /canonical rules[^\n]*not installed/, "absence must be named, not silent");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
