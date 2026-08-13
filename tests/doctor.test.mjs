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

import { decisionsAttributionReport } from "../cli.mjs";

const CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url));

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

/** Run `node cli.mjs doctor` as a subprocess scoped to `root` (or with no roots at all). */
function runDoctor(root) {
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root },
  });
}

test("doctor fails when a ledger contains an unknown row type, and names the type (N1)", async () => {
  const { root, jsonlPath } = await makeWorkspace([
    driftLine("001"),
    JSON.stringify({ type: "manual", id: "002", timestamp: new Date().toISOString(), status: "open" }),
  ]);
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, "doctor must exit non-zero when an unknown row type is present");
    assert.match(out, /no row types unknown to the reader/);
    assert.match(out, /"manual"/, "output names the offending type string");
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
    assert.match(out, /zero workspaces found/);
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
    assert.match(out, /✓.*no row types unknown to the reader/);
    assert.match(out, /✓.*no malformed ledger lines/);
    assert.match(out, /✓.*at least one workspace discovered/);
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
