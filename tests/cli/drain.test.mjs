/**
 * `cli drain` — the supported close path (docs/SPEC.md §6: "new, and required").
 *
 * `drain` is non-interactive by design (mechanism, not interaction — the human
 * walkthrough lives in SKILL.md prose and calls this command to execute
 * decisions). These tests exercise the real CLI as a subprocess, following
 * `tests/check-injection.test.mjs`'s pattern: WORKSPACES is computed at
 * `cli.mjs`'s module-load time from `lib/config.mjs`'s `SEARCH_ROOTS`, which
 * reads `PROPAGATE_SEARCH_ROOTS` — so scoping to a temp workspace requires a
 * subprocess with that env var set, not an in-process import.
 *
 * Temp-workspace shape follows `tests/discovery.test.mjs`: a `.propagates.yml`
 * with `workspace: true` directly at the root, `PROPAGATE_SEARCH_ROOTS` set to
 * that same root (so `walk(root, 0)` finds the marker at depth 0), and cwd set
 * to the root so `currentWorkspace()` matches it without needing --all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readLedger } from "../../lib/edges/ledger.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

/** Build a throwaway workspace: `.propagates.yml` (workspace: true) + seeded docs/PROPAGATION_LEDGER.jsonl. */
async function makeWorkspace(rows) {
  const root = await mkdtemp(path.join(tmpdir(), "drain-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  const jsonlPath = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  await writeFile(jsonlPath, body, "utf8");
  return { root, jsonlPath };
}

function driftRow(id, overrides = {}) {
  return {
    type: "drift",
    id,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    source: `${id}.md`,
    change: `drift on ${id}`,
    downstream: [{ path: `${id}-downstream.md`, why: "test fixture", kind: "prose" }],
    status: "open",
    ...overrides,
  };
}

/** Run `node cli.mjs drain ...args` as a subprocess scoped to `root`. */
function runDrain(args, root) {
  return spawnSync(process.execPath, [CLI_PATH, "drain", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root },
  });
}

test("list mode: groups rows by correlation_id, lists ungrouped rows individually", async () => {
  const { root } = await makeWorkspace([
    driftRow("001", { correlation_id: "repo:a.md" }),
    driftRow("002", { correlation_id: "repo:a.md" }),
    driftRow("003"), // no correlation_id
  ]);
  try {
    const result = runDrain(["--json"], root);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.workspaces.length, 1);
    const ws = parsed.workspaces[0];
    assert.equal(ws.groups.length, 1, "one correlation group");
    assert.equal(ws.groups[0].correlation_id, "repo:a.md");
    assert.equal(ws.groups[0].count, 2);
    assert.deepEqual(ws.groups[0].rows.map((r) => r.id).sort(), ["001", "002"]);
    assert.equal(ws.ungrouped.length, 1, "ungrouped row listed individually");
    assert.equal(ws.ungrouped[0].id, "003");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("list mode (non-json) renders without crashing and mentions open row ids", async () => {
  const { root } = await makeWorkspace([driftRow("001")]);
  try {
    const result = runDrain([], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /#001/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("--close with a single id closes it; re-reading shows not-open, closed_by drain", async () => {
  const { root, jsonlPath } = await makeWorkspace([driftRow("010")]);
  try {
    const result = runDrain(["--close", "010", "--status", "done", "--json"], root);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.closed.length, 1);
    assert.equal(parsed.closed[0].id, "010");
    assert.equal(parsed.closed[0].status, "done");
    assert.equal(parsed.failed.length, 0);

    const rows = await readLedger(jsonlPath);
    const row = rows.find((r) => r.id === "010");
    assert.equal(row.status, "done");
    assert.equal(row.closed_by, "drain");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("batch --close a,b,c closes all three with a shared reason", async () => {
  const { root, jsonlPath } = await makeWorkspace([
    driftRow("020"),
    driftRow("021"),
    driftRow("022"),
  ]);
  try {
    const result = runDrain(
      ["--close", "020,021,022", "--status", "wontfix", "--reason", "bulk-close-test", "--json"],
      root,
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.closed.length, 3);
    assert.equal(parsed.failed.length, 0);

    const rows = await readLedger(jsonlPath);
    for (const id of ["020", "021", "022"]) {
      const row = rows.find((r) => r.id === id);
      assert.equal(row.status, "wontfix");
      assert.equal(row.wontfix_reason, "bulk-close-test");
      assert.equal(row.closed_by, "drain");
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("--group closes every row sharing a correlation_id, leaves other groups open", async () => {
  const { root, jsonlPath } = await makeWorkspace([
    driftRow("030", { correlation_id: "repo:x.md" }),
    driftRow("031", { correlation_id: "repo:x.md" }),
    driftRow("032", { correlation_id: "repo:y.md" }),
  ]);
  try {
    const result = runDrain(["--group", "repo:x.md", "--status", "done", "--json"], root);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.closed.length, 2);
    assert.deepEqual(parsed.closed.map((c) => c.id).sort(), ["030", "031"]);

    const rows = await readLedger(jsonlPath);
    assert.equal(rows.find((r) => r.id === "030").status, "done");
    assert.equal(rows.find((r) => r.id === "031").status, "done");
    assert.equal(rows.find((r) => r.id === "032").status, "open", "other group untouched");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("--status wontfix without --reason exits non-zero with a clear message, not a stack trace", async () => {
  const { root, jsonlPath } = await makeWorkspace([driftRow("040")]);
  try {
    const result = runDrain(["--close", "040", "--status", "wontfix"], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /wontfix_reason/i);
    assert.doesNotMatch(result.stdout + result.stderr, /at markStatus \(/, "no raw stack trace leaked to output");

    const rows = await readLedger(jsonlPath);
    assert.equal(rows.find((r) => r.id === "040").status, "open", "row stays open — no partial close");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("--close <nonexistent-id> exits non-zero and says so, not a silent no-op", async () => {
  const { root } = await makeWorkspace([driftRow("050")]);
  try {
    const result = runDrain(["--close", "999", "--status", "done"], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /999/);
    assert.match(result.stdout + result.stderr, /not found/i);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("--json on close mode parses and reports what was closed", async () => {
  const { root } = await makeWorkspace([driftRow("060")]);
  try {
    const result = runDrain(
      ["--close", "060", "--status", "partial", "--notes", "checked, not fully applied", "--json"],
      root,
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "partial");
    assert.equal(parsed.closed_by, "drain");
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.closed.length, 1);
    assert.equal(parsed.closed[0].id, "060");
    assert.equal(parsed.closed[0].status, "partial");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("--closed-by override is accepted when valid, rejected when not", async () => {
  const { root: root1, jsonlPath: jsonl1 } = await makeWorkspace([driftRow("070")]);
  const { root: root2 } = await makeWorkspace([driftRow("080")]);
  try {
    const ok = runDrain(["--close", "070", "--status", "done", "--closed-by", "commit-evidence", "--json"], root1);
    assert.equal(ok.status, 0, ok.stderr);
    const rows = await readLedger(jsonl1);
    assert.equal(rows.find((r) => r.id === "070").closed_by, "commit-evidence");

    const bad = runDrain(["--close", "080", "--status", "done", "--closed-by", "bogus"], root2);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout + bad.stderr, /closed_by/i);
  } finally {
    await rm(root1, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(root2, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
