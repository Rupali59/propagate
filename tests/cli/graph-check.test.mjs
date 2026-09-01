/**
 * `doctor`'s "Graph integration" section shelled out to `claude mcp list`
 * synchronously, with no timeout, purely to report a WARNING that is known
 * and already deferred (TM-064). Measured 2026-08-13: 17.8s of a ~19s doctor
 * run — 94% of the total — spent reconfirming a fact already written down
 * (docs/ISSUES.md N16).
 *
 * `checkGraphMcpStatus()` (cli.mjs) bounds that shell-out to a 2s timeout and
 * caches the outcome (including timeout/error outcomes) for an hour, in
 * PROPAGATE_STATE_DIR when set. The one thing that must never happen: a
 * timeout collapsing into the same report as "checked, and it's fine" — "I
 * could not look" must read differently from "I looked and it is fine".
 *
 * Two layers: fast unit tests against `checkGraphMcpStatus` with an injected
 * `runMcpList` (no real subprocess, deterministic), then one real end-to-end
 * `doctor` subprocess run against a stubbed `claude` binary on PATH, proving
 * the actual `execSync` + `timeout` wiring works and that PROPAGATE_STATE_DIR
 * is honoured for the cache file's location.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkGraphMcpStatus } from "../../cli.mjs";

const SKILL_DIR = fileURLToPath(new URL("../../", import.meta.url));
const CLI_PATH = path.join(SKILL_DIR, "cli.mjs");

/** A `killed`/`signal` error shaped like what Node's execSync throws on `timeout`. */
function timeoutError() {
  const err = new Error("Command timed out");
  err.killed = true;
  err.signal = "SIGTERM";
  return err;
}

// ---------------------------------------------------------------------------
// Unit layer: checkGraphMcpStatus with an injected runMcpList (no subprocess)
// ---------------------------------------------------------------------------

test("checkGraphMcpStatus: a timeout is reported as status 'timeout', never as a pass", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "graph-cache-"));
  try {
    const cachePath = path.join(dir, "graph-mcp-cache.json");
    let calls = 0;
    const result = await checkGraphMcpStatus({
      cachePath,
      runMcpList: () => {
        calls++;
        throw timeoutError();
      },
    });
    assert.equal(result.status, "timeout");
    assert.notEqual(result.status, "registered", "a timeout must never read as a pass");
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("checkGraphMcpStatus: a non-timeout error is distinguished from a timeout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "graph-cache-"));
  try {
    const cachePath = path.join(dir, "graph-mcp-cache.json");
    const result = await checkGraphMcpStatus({
      cachePath,
      runMcpList: () => {
        throw new Error("claude: command not found");
      },
    });
    assert.equal(result.status, "error");
    assert.notEqual(result.status, "timeout", "a plain failure must not be reported as a timeout");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("checkGraphMcpStatus: registered / not-registered still distinguished by output content", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "graph-cache-"));
  try {
    const registered = await checkGraphMcpStatus({
      cachePath: path.join(dir, "a.json"),
      runMcpList: () => "code-review-graph  ✓ Connected\nother-mcp  ✓ Connected\n",
    });
    assert.equal(registered.status, "registered");

    const notRegistered = await checkGraphMcpStatus({
      cachePath: path.join(dir, "b.json"),
      runMcpList: () => "other-mcp  ✓ Connected\n",
    });
    assert.equal(notRegistered.status, "not-registered");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("checkGraphMcpStatus: a second call within TTL uses the cache — the expensive call happens once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "graph-cache-"));
  try {
    const cachePath = path.join(dir, "graph-mcp-cache.json");
    let calls = 0;
    const runMcpList = () => {
      calls++;
      return "code-review-graph  ✓ Connected\n";
    };

    const first = await checkGraphMcpStatus({ cachePath, ttlMs: 60_000, runMcpList });
    assert.equal(first.fromCache, false);
    assert.equal(calls, 1);

    const second = await checkGraphMcpStatus({ cachePath, ttlMs: 60_000, runMcpList });
    assert.equal(second.fromCache, true);
    assert.equal(calls, 1, "runMcpList must not be invoked again while the cache is warm");
    assert.equal(second.status, "registered", "the cached status must be returned, unchanged");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("checkGraphMcpStatus: cache expires after the TTL and recomputes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "graph-cache-"));
  try {
    const cachePath = path.join(dir, "graph-mcp-cache.json");
    let calls = 0;
    const runMcpList = () => {
      calls++;
      return "code-review-graph  ✓ Connected\n";
    };
    let clock = 1_000_000;
    const now = () => clock;

    await checkGraphMcpStatus({ cachePath, ttlMs: 1000, runMcpList, now });
    assert.equal(calls, 1);

    clock += 500; // still within TTL
    await checkGraphMcpStatus({ cachePath, ttlMs: 1000, runMcpList, now });
    assert.equal(calls, 1, "still warm — must not recompute");

    clock += 2000; // now past TTL
    await checkGraphMcpStatus({ cachePath, ttlMs: 1000, runMcpList, now });
    assert.equal(calls, 2, "TTL expired — must recompute");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("checkGraphMcpStatus: a corrupt cache file is ignored, not thrown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "graph-cache-"));
  try {
    const cachePath = path.join(dir, "graph-mcp-cache.json");
    await writeFile(cachePath, "{ not valid json", "utf8");
    const result = await checkGraphMcpStatus({
      cachePath,
      runMcpList: () => "code-review-graph  ✓ Connected\n",
    });
    assert.equal(result.status, "registered");
    assert.equal(result.fromCache, false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// End-to-end layer: real `doctor` subprocess, real execSync + timeout wiring,
// against a stubbed `claude` binary on PATH that sleeps past the 2s bound.
// ---------------------------------------------------------------------------

/** Build a throwaway workspace doctor can run against without touching the real tree. */
async function makeWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "graph-e2e-ws-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.jsonl"), "", "utf8");
  return root;
}

/** A fake `claude` binary on PATH that sleeps well past doctor's 2s timeout bound. */
async function makeSlowClaudeStub() {
  const binDir = await mkdtemp(path.join(tmpdir(), "graph-e2e-bin-"));
  const stubPath = path.join(binDir, "claude");
  await writeFile(
    stubPath,
    "#!/bin/sh\necho x >> \"$(dirname \"$0\")/calls\"\nsleep 60\necho 'code-review-graph  ✓ Connected'\n",
    "utf8",
  );
  await chmod(stubPath, 0o755);
  return binDir;
}

function runDoctor(root, { binDir, stateDir } = {}) {
  const env = { ...process.env, PROPAGATE_SEARCH_ROOTS: root };
  if (binDir) env.PATH = `${binDir}:${process.env.PATH}`;
  if (stateDir) env.PROPAGATE_STATE_DIR = stateDir;
  // 90s, deliberately far above the 60s stub sleep. This cap is NOT the assertion —
  // it is only a runaway guard. When it was 20s it became the confound: under load,
  // a doctor with an INTACT bound was killed at 22s and the test reported a broken
  // bound. A harness timeout that can fire during normal operation is indistinguishable
  // from the failure it is meant to surface.
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], { cwd: root, encoding: "utf8", env, timeout: 90_000 });
}

test("doctor: never invokes `claude` at all — the subprocess is gone, not merely bounded", async () => {
  const root = await makeWorkspace();
  const binDir = await makeSlowClaudeStub();
  const stateDir = await mkdtemp(path.join(tmpdir(), "graph-e2e-state-"));
  try {
    // REPLACES "a hung `claude mcp list` is bounded to ~2s" (N16, closed
    // 2026-09-01). That test was correct for its time and its comment records four
    // attempts to make the bound assertion non-flaky. Its PREMISE is now gone:
    // doctor reads .mcp.json and ~/.claude.json instead of shelling out, because
    // rule:tool-priority forbids `claude mcp list` in a health-check path
    // ("~30 remote servers ... tens of seconds. Never put it in a health-check
    // path") and the 2s bound added afterwards only guaranteed the check could
    // never SUCCEED — doctor reported `status unknown` on every run.
    //
    // This assertion is STRICTLY STRONGER than the one it replaces. "Bounded to 2s"
    // permits a subprocess; "called zero times" does not. And it inherits the old
    // test's hard-won discipline: assert the CLAIM (the stub's own call log), never
    // a duration proxy. Every timing assertion this file ever carried became a
    // flake — see G53 and the comment below.
    const result = runDoctor(root, { binDir, stateDir });
    const out = result.stdout + result.stderr;

    assert.doesNotMatch(out, /^$/, "doctor produced no output at all");

    const calls = (await readFile(path.join(binDir, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    assert.equal(calls, 0, `doctor invoked the \`claude\` stub ${calls}x — it must never shell out for this`);

    // And it must produce a real ANSWER, not the unknown it used to.
    assert.doesNotMatch(
      out,
      /graph integration check timed out/,
      "the timeout path should be unreachable now that nothing is spawned",
    );
    assert.match(
      out,
      /code-review-graph MCP (registered|not registered)/,
      "the check must answer, not report unknown",
    );

    const cachePath = path.join(stateDir, "graph-mcp-cache.json");
    assert.ok(existsSync(cachePath), "cache file must be written inside PROPAGATE_STATE_DIR");
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    assert.ok(
      cached.status === "registered" || cached.status === "not-registered",
      `cached status must be a real answer, got ${cached.status}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(binDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("doctor: the cache is keyed by cwd — a project answer is never served to another directory", async () => {
  const rootA = await makeWorkspace();
  const rootB = await makeWorkspace();
  const stateDir = await mkdtemp(path.join(tmpdir(), "graph-e2e-state-"));
  try {
    // REPLACES "a warm cache skips the subprocess entirely". There is no subprocess
    // to skip, so that claim is vacuous; this asserts the property that actually
    // matters now and that DID break when the subprocess was removed.
    //
    // The answer became cwd-DEPENDENT the moment this started reading .mcp.json:
    // measured 2026-09-01, 24 of the 26 .mcp.json files in this tree declare
    // code-review-graph at PROJECT scope and NONE declares it at user scope. With a
    // cwd-independent cache, running doctor at the hub and then inside
    // Motherboard/motherboard-infra reported "not registered (cached 2m ago)" for a
    // directory whose own .mcp.json declares it. Clearing the cache made the same
    // command report registered — which is how the bug was found.
    //
    // rootA declares the server; rootB does not. Same state dir, so the same cache
    // file. If cwd is not part of the key, the second run inherits the first answer.
    await writeFile(
      path.join(rootA, ".mcp.json"),
      JSON.stringify({ mcpServers: { "code-review-graph": { command: "x" } } }),
    );

    const outA = (() => { const r = runDoctor(rootA, { stateDir }); return r.stdout + r.stderr; })();
    const outB = (() => { const r = runDoctor(rootB, { stateDir }); return r.stdout + r.stderr; })();

    assert.match(outA, /✓.*code-review-graph MCP registered/, "rootA declares it and must report registered");
    assert.match(
      outB,
      /code-review-graph MCP not registered/,
      "rootB declares nothing — a cached rootA answer must not be served here",
    );
  } finally {
    await rm(rootA, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(rootB, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
