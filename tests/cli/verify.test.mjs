/**
 * Tests for `verify` (cli.mjs) — the v2 write side (plan §4).
 *
 * Strategy: real temp git repos + a real CLI subprocess, same discipline as
 * tests/reconcile.test.mjs — PROPAGATE_SEARCH_ROOTS/PROPAGATE_STATE_DIR are
 * module-level consts resolved at import time, so exercising a fresh
 * workspace + store per test requires a subprocess, not an in-process
 * re-import. Pure selection/guard/verify-after-write logic is unit-tested
 * directly against the exported functions (no subprocess needed there).
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { selectVerifyRows, divergedGuard, expectedStateAfter, computeVerifyAfterWrite } from "../../cli.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeWorkspace(searchRoot, name) {
  const wsRoot = path.join(searchRoot, name);
  await mkdir(wsRoot, { recursive: true });
  git(["init", "-q", "-b", "main"], wsRoot);
  git(["config", "user.email", "test@example.com"], wsRoot);
  git(["config", "user.name", "Test"], wsRoot);
  return wsRoot;
}

async function commitAll(dir, msg = "snapshot") {
  git(["add", "."], dir);
  git(["commit", "-q", "-m", msg], dir);
}

/** Run `node cli.mjs <argv...>` scoped to a fresh search root + store. */
function runCli(argv, { searchRoot, stateDir }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
}

function runReconcileJson(env) {
  const r = runCli(["reconcile", "--all", "--json"], env);
  assert.equal(r.status, 0, `reconcile --json failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

function rowFor(parsed, sourceAbs) {
  return parsed.rows.find((row) => row.source.path === sourceAbs);
}

/** Read one event straight off disk by event_id — the real store shape,
 * scoped to this test's own PROPAGATE_STATE_DIR (never the real ~/.propagate,
 * per docs/GOTCHAS.md G52). Used to assert on provenance fields the CLI's
 * own JSON output does not echo back (event_id is the only linking field). */
async function readEventById(stateDir, eventId) {
  const eventsDir = path.join(stateDir, "events");
  const files = (await readdir(eventsDir)).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    const raw = await readFile(path.join(eventsDir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.event_id === eventId) return row;
    }
  }
  throw new Error(`event ${eventId} not found under ${eventsDir}`);
}

async function withFixture(fn) {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "verify-search-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "verify-state-"));
  try {
    await fn({ searchRoot, stateDir });
  } finally {
    await rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. --edge with each (non-DIVERGED-only) disposition writes one
//    correctly-shaped event.
// ─────────────────────────────────────────────────────────────────────────

test("verify --edge — each disposition writes one correctly-shaped event", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws1");
    const dispositions = ["propagated", "no-change-needed", "source-corrected", "deferred", "wontfix", "baselined"];
    let sidecar = "workspace: true\nsources:\n";
    for (const d of dispositions) {
      await writeFile(path.join(ws, `${d}-src.txt`), `${d} src v1\n`);
      await writeFile(path.join(ws, `${d}-dst.txt`), `${d} dst v1\n`);
      sidecar += `  ${d}-src.txt:\n    propagates_to:\n      - path: ${d}-dst.txt\n        why: "${d} pairing"\n`;
    }
    await writeFile(path.join(ws, ".propagates.yml"), sidecar);
    await commitAll(ws, "initial");

    const before = runReconcileJson(env);

    for (const d of dispositions) {
      const srcAbs = path.join(ws, `${d}-src.txt`);
      const row = rowFor(before, srcAbs);
      assert.ok(row, `row for ${d} must exist`);
      assert.equal(row.state, "NEVER_VERIFIED");

      const argv = ["verify", "--edge", row.edge_id, "--disposition", d, "--apply", "--json"];
      if (d === "wontfix" || d === "baselined") argv.push("--reason", `${d} reason`);
      const r = runCli(argv, env);
      assert.equal(r.status, 0, `verify --disposition ${d} failed: ${r.stderr}\n${r.stdout}`);
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.disposition, d);
      assert.equal(parsed.confirmed.length, 1, `one edge confirmed for ${d}`);
      assert.equal(parsed.confirmed[0].edge_id, row.edge_id);
      assert.equal(parsed.refused.length, 0);
      assert.equal(parsed.failed.length, 0);

      const expected = d === "deferred" ? "NEVER_VERIFIED" : "CLEAN";
      assert.equal(parsed.confirmed[0].state, expected, `${d} must land on ${expected}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. --node selects every context for that node and writes one event per
//    edge.
// ─────────────────────────────────────────────────────────────────────────

test("verify --node — selects every edge sharing that node_id, one event each", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws2");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst-a.txt"), "a v1\n");
    await writeFile(path.join(ws, "dst-b.txt"), "b v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst-a.txt
        why: "pairing a"
      - path: dst-b.txt
        why: "pairing b"
`,
    );
    await commitAll(ws, "initial");

    const before = runReconcileJson(env);
    const rows = before.rows.filter((r) => r.source.path === path.join(ws, "src.txt"));
    assert.equal(rows.length, 2, "two declared downstreams share one node_id");
    const nodeId = rows[0].node_id;
    assert.ok(rows.every((r) => r.node_id === nodeId));

    const r = runCli(
      ["verify", "--node", nodeId, "--disposition", "no-change-needed", "--reason", "reviewed both", "--apply", "--json"],
      env,
    );
    assert.equal(r.status, 0, `verify --node failed: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.confirmed.length, 2, "one event per edge sharing the node");
    const confirmedIds = new Set(parsed.confirmed.map((c) => c.edge_id));
    assert.deepEqual(confirmedIds, new Set(rows.map((row) => row.edge_id)));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. --glob selects every expansion; one reason applies to all.
// ─────────────────────────────────────────────────────────────────────────

test("verify --glob — selects every expanded match; one reason applies to all", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws3");
    await mkdir(path.join(ws, "sub"), { recursive: true });
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "sub", "one.md"), "one v1\n");
    await writeFile(path.join(ws, "sub", "two.md"), "two v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: "sub/*.md"
        why: "glob pairing"
`,
    );
    await commitAll(ws, "initial");

    const before = runReconcileJson(env);
    const matchedRows = before.rows.filter((r) => r.glob === "sub/*.md");
    assert.equal(matchedRows.length, 2);

    const r = runCli(
      ["verify", "--glob", "sub/*.md", "--disposition", "no-change-needed", "--reason", "reviewed all matches", "--apply", "--json"],
      env,
    );
    assert.equal(r.status, 0, `verify --glob failed: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.confirmed.length, 2);
    assert.ok(parsed.confirmed.every((c) => c.state === "CLEAN"));

    // Confirm the reason actually reached both events (round-trip via the store).
    const after = runReconcileJson(env);
    for (const row of matchedRows) {
      const afterRow = after.rows.find((r) => r.edge_id === row.edge_id);
      assert.equal(afterRow.last.reason, "reviewed all matches");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. --state narrows the selection.
// ─────────────────────────────────────────────────────────────────────────

test("verify --node --state — narrows to only the matching state within the node", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws4");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst-clean.txt"), "clean v1\n");
    await writeFile(path.join(ws, "dst-drifted.txt"), "drifted v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst-clean.txt
        why: "clean pairing"
      - path: dst-drifted.txt
        why: "drifted pairing"
`,
    );
    await commitAll(ws, "initial");

    let before = runReconcileJson(env);
    const cleanRow = before.rows.find((r) => r.downstream.path === path.join(ws, "dst-clean.txt"));
    const drift1Row = before.rows.find((r) => r.downstream.path === path.join(ws, "dst-drifted.txt"));

    // Pin dst-clean.txt's pairing so it starts CLEAN; leave the other NEVER_VERIFIED,
    // then move the source so the un-pinned one can't confuse the picture, and pin+drift
    // the "drifted" one so it reads DRIFTED distinctly from NEVER_VERIFIED.
    runCli(["verify", "--edge", cleanRow.edge_id, "--disposition", "propagated", "--apply", "--json"], env);
    runCli(["verify", "--edge", drift1Row.edge_id, "--disposition", "propagated", "--apply", "--json"], env);
    await writeFile(path.join(ws, "src.txt"), "src v2\n");

    before = runReconcileJson(env);
    const nodeId = before.rows.find((r) => r.downstream.path === path.join(ws, "dst-clean.txt")).node_id;
    const cleanState = before.rows.find((r) => r.downstream.path === path.join(ws, "dst-clean.txt")).state;
    const driftState = before.rows.find((r) => r.downstream.path === path.join(ws, "dst-drifted.txt")).state;
    assert.equal(cleanState, "DRIFTED");
    assert.equal(driftState, "DRIFTED");

    // Now diverge them: touch only dst-drifted.txt's downstream too, so it becomes DIVERGED
    // while dst-clean.txt's pairing stays plain DRIFTED — a real distinguishing --state value.
    await writeFile(path.join(ws, "dst-drifted.txt"), "drifted v2\n");
    before = runReconcileJson(env);
    const cleanRow2 = before.rows.find((r) => r.downstream.path === path.join(ws, "dst-clean.txt"));
    const driftRow2 = before.rows.find((r) => r.downstream.path === path.join(ws, "dst-drifted.txt"));
    assert.equal(cleanRow2.state, "DRIFTED");
    assert.equal(driftRow2.state, "DIVERGED");

    const r = runCli(
      ["verify", "--node", nodeId, "--state", "DRIFTED", "--disposition", "propagated", "--apply", "--json"],
      env,
    );
    assert.equal(r.status, 0, `verify --node --state failed: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.confirmed.length, 1, "only the DRIFTED member is selected, not the DIVERGED one");
    assert.equal(parsed.confirmed[0].edge_id, cleanRow2.edge_id);

    const after = runReconcileJson(env);
    const afterDrift = after.rows.find((r) => r.edge_id === driftRow2.edge_id);
    assert.equal(afterDrift.state, "DIVERGED", "the un-selected DIVERGED member must be untouched");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. A DIVERGED edge refuses everything except both-reconciled.
// ─────────────────────────────────────────────────────────────────────────

test("verify — a DIVERGED edge refuses everything except both-reconciled, with a clear message", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws5");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "diverged pairing"
`,
    );
    await commitAll(ws, "initial");

    let rows = runReconcileJson(env);
    let row = rowFor(rows, path.join(ws, "src.txt"));
    runCli(["verify", "--edge", row.edge_id, "--disposition", "propagated", "--apply", "--json"], env);

    await writeFile(path.join(ws, "src.txt"), "src v2\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v2\n");
    rows = runReconcileJson(env);
    row = rowFor(rows, path.join(ws, "src.txt"));
    assert.equal(row.state, "DIVERGED");

    const refused = runCli(["verify", "--edge", row.edge_id, "--disposition", "propagated", "--reason", "x", "--apply", "--json"], env);
    assert.equal(refused.status, 1, "refusing a DIVERGED edge must exit non-zero");
    const parsedRefused = JSON.parse(refused.stdout.trim());
    assert.equal(parsedRefused.confirmed.length, 0);
    assert.equal(parsedRefused.refused.length, 1);
    assert.match(parsedRefused.refused[0].error, /DIVERGED/);
    assert.match(parsedRefused.refused[0].error, /both-reconciled/);

    const rowsAfterRefusal = runReconcileJson(env);
    assert.equal(rowFor(rowsAfterRefusal, path.join(ws, "src.txt")).state, "DIVERGED", "a refused write must not change state");

    const allowed = runCli(
      ["verify", "--edge", row.edge_id, "--disposition", "both-reconciled", "--reason", "reviewed both sides", "--apply", "--json"],
      env,
    );
    assert.equal(allowed.status, 0, `both-reconciled on a DIVERGED edge must succeed: ${allowed.stderr}\n${allowed.stdout}`);
    const parsedAllowed = JSON.parse(allowed.stdout.trim());
    assert.equal(parsedAllowed.confirmed.length, 1);
    assert.equal(parsedAllowed.confirmed[0].state, "CLEAN");

    // both-reconciled must ALSO be refused on a non-DIVERGED edge.
    const rowsAfter = runReconcileJson(env);
    const cleanRow = rowFor(rowsAfter, path.join(ws, "src.txt"));
    assert.equal(cleanRow.state, "CLEAN");
    const misapplied = runCli(
      ["verify", "--edge", cleanRow.edge_id, "--disposition", "both-reconciled", "--reason", "x", "--apply", "--json"],
      env,
    );
    assert.equal(misapplied.status, 1);
    const parsedMisapplied = JSON.parse(misapplied.stdout.trim());
    assert.equal(parsedMisapplied.refused.length, 1);
    assert.match(parsedMisapplied.refused[0].error, /only applies to a DIVERGED edge/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. wontfix without --reason exits non-zero with events.mjs's message.
// ─────────────────────────────────────────────────────────────────────────

test("verify — wontfix without --reason exits non-zero with events.mjs's message, not a stack trace", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws6");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "wontfix pairing"
`,
    );
    await commitAll(ws, "initial");

    const rows = runReconcileJson(env);
    const row = rowFor(rows, path.join(ws, "src.txt"));

    const r = runCli(["verify", "--edge", row.edge_id, "--disposition", "wontfix", "--apply", "--json"], env);
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.confirmed.length, 0);
    assert.equal(parsed.refused.length, 1);
    assert.match(parsed.refused[0].error, /appendEvent: event [0-9A-Z]{26} —/, "the exact events.mjs message, not a re-implementation");
    assert.match(parsed.refused[0].error, /wontfix/);
    assert.match(parsed.refused[0].error, /reason/);
    assert.doesNotMatch(r.stderr, /at Object\.|at Module\.|node:internal/, "must never surface a raw stack trace");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. verify-after-write catches a state that did not change and exits
//    non-zero — unit-tested on the pure comparison function (no I/O race
//    needed to synthesize the "didn't land" case deterministically).
// ─────────────────────────────────────────────────────────────────────────

test("computeVerifyAfterWrite — flags an edge whose state did not reach the expected value", () => {
  const applied = [
    { edge_id: "e1", node_id: "n1", disposition: "propagated", priorState: "DRIFTED", event_id: "ev1" },
    { edge_id: "e2", node_id: "n2", disposition: "deferred", priorState: "DRIFTED", event_id: "ev2" },
  ];
  const afterRows = [
    { edge_id: "e1", state: "DRIFTED" }, // did NOT land on CLEAN — the write "returned" but didn't take
    { edge_id: "e2", state: "DRIFTED" }, // deferred correctly stayed put
  ];
  const { confirmed, failed } = computeVerifyAfterWrite(applied, afterRows);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].edge_id, "e2");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].edge_id, "e1");
  assert.match(failed[0].error, /expected state CLEAN.*got DRIFTED/);
});

test("computeVerifyAfterWrite — an edge missing from the re-reconcile is a failure, not a silent pass", () => {
  const applied = [{ edge_id: "e1", node_id: "n1", disposition: "propagated", priorState: "DRIFTED", event_id: "ev1" }];
  const { confirmed, failed } = computeVerifyAfterWrite(applied, []);
  assert.equal(confirmed.length, 0);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /vanished/);
});

test("expectedStateAfter — every disposition re-pins to CLEAN except deferred, which keeps the prior state", () => {
  assert.equal(expectedStateAfter("propagated", "DRIFTED"), "CLEAN");
  assert.equal(expectedStateAfter("no-change-needed", "REVERSED"), "CLEAN");
  assert.equal(expectedStateAfter("both-reconciled", "DIVERGED"), "CLEAN");
  assert.equal(expectedStateAfter("deferred", "DRIFTED"), "DRIFTED");
  assert.equal(expectedStateAfter("deferred", "NEVER_VERIFIED"), "NEVER_VERIFIED");
});

test("selectVerifyRows / divergedGuard — pure selection and guard logic", () => {
  const rows = [
    { edge_id: "e1", node_id: "n1", glob: null, state: "DRIFTED" },
    { edge_id: "e2", node_id: "n1", glob: "sub/*.md", state: "CLEAN" },
    { edge_id: "e3", node_id: "n2", glob: "sub/*.md", state: "DIVERGED" },
  ];
  assert.deepEqual(selectVerifyRows(rows, { edge: "e1" }).map((r) => r.edge_id), ["e1"]);
  assert.deepEqual(selectVerifyRows(rows, { node: "n1" }).map((r) => r.edge_id), ["e1", "e2"]);
  assert.deepEqual(selectVerifyRows(rows, { glob: "sub/*.md" }).map((r) => r.edge_id), ["e2", "e3"]);
  assert.deepEqual(
    selectVerifyRows(rows, { glob: "sub/*.md", state: "DIVERGED" }).map((r) => r.edge_id),
    ["e3"],
  );
  assert.equal(divergedGuard("DIVERGED", "propagated"), divergedGuard("DIVERGED", "propagated")); // stable
  assert.ok(divergedGuard("DIVERGED", "propagated"));
  assert.equal(divergedGuard("DIVERGED", "both-reconciled"), null);
  assert.ok(divergedGuard("CLEAN", "both-reconciled"));
  assert.equal(divergedGuard("CLEAN", "propagated"), null);
});

// ─────────────────────────────────────────────────────────────────────────
// 8/9. decoupled — print-by-default, --apply writes and names the change.
// ─────────────────────────────────────────────────────────────────────────

test("verify --disposition decoupled — without --apply prints the edit and does NOT modify the sidecar", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws8");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    const sidecarPath = path.join(ws, ".propagates.yml");
    await writeFile(
      sidecarPath,
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "mistaken pairing"
`,
    );
    await commitAll(ws, "initial");

    const before = runReconcileJson(env);
    const row = rowFor(before, path.join(ws, "src.txt"));
    const rawBefore = await readFile(sidecarPath, "utf8");

    const r = runCli(["verify", "--edge", row.edge_id, "--disposition", "decoupled", "--json"], env);
    assert.equal(r.status, 0, `dry-run decoupled must succeed: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.apply, false);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].ok, true);
    assert.equal(parsed.results[0].applied, false);
    assert.match(parsed.results[0].edit, /propagates_to\[0\]/);
    assert.match(parsed.results[0].edit, /dst\.txt/);
    assert.match(parsed.results[0].edit, /\.propagates\.yml/);

    const rawAfter = await readFile(sidecarPath, "utf8");
    assert.equal(rawAfter, rawBefore, "the sidecar must be byte-identical after a dry-run decoupled");

    const after = runReconcileJson(env);
    assert.ok(rowFor(after, path.join(ws, "src.txt")), "the edge must still be declared (nothing was applied)");
  });
});

test("verify --disposition decoupled --apply — performs the edit and names what changed", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws9");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst-keep.txt"), "keep v1\n");
    await writeFile(path.join(ws, "dst-bad.txt"), "bad v1\n");
    const sidecarPath = path.join(ws, ".propagates.yml");
    await writeFile(
      sidecarPath,
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst-keep.txt
        why: "legit pairing"
      - path: dst-bad.txt
        why: "mistaken pairing"
`,
    );
    await commitAll(ws, "initial");

    const before = runReconcileJson(env);
    const badRow = before.rows.find((r) => r.downstream.path === path.join(ws, "dst-bad.txt"));
    const keepRow = before.rows.find((r) => r.downstream.path === path.join(ws, "dst-keep.txt"));

    const r = runCli(["verify", "--edge", badRow.edge_id, "--disposition", "decoupled", "--apply", "--reason", "never should have coupled these", "--json"], env);
    assert.equal(r.status, 0, `decoupled --apply must succeed: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.apply, true);
    assert.equal(parsed.results[0].ok, true);
    assert.equal(parsed.results[0].applied, true);
    assert.ok(parsed.results[0].event_id);
    assert.match(parsed.results[0].edit, /dst-bad\.txt/);
    assert.match(parsed.results[0].edit, /\.propagates\.yml/);

    // The sidecar no longer declares the bad pairing...
    const rawAfter = await readFile(sidecarPath, "utf8");
    const doc = YAML.parse(rawAfter);
    const remaining = doc.sources["src.txt"].propagates_to;
    assert.equal(remaining.length, 1, "only the decoupled entry is removed");
    assert.equal(remaining[0].path, "dst-keep.txt", "the legitimate pairing survives");

    // ...and reconcile no longer enumerates it, while the sibling edge is untouched.
    const after = runReconcileJson(env);
    assert.equal(after.rows.find((row) => row.edge_id === badRow.edge_id), undefined, "the decoupled edge must vanish");
    const keepAfter = after.rows.find((row) => row.edge_id === keepRow.edge_id);
    assert.ok(keepAfter, "the sibling edge must still be declared");
    assert.equal(keepAfter.state, "NEVER_VERIFIED", "the sibling edge's own state is untouched by the decouple");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. --json parses on verify; reconcile --group-by renders groups with
//     counts, and the default output is unchanged.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile --group-by glob|node — groups render with member counts and states; default is unchanged", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws10");
    await mkdir(path.join(ws, "sub"), { recursive: true });
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "sub", "one.md"), "one v1\n");
    await writeFile(path.join(ws, "sub", "two.md"), "two v1\n");
    await writeFile(path.join(ws, "lone.txt"), "lone dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: "sub/*.md"
        why: "glob pairing"
      - path: lone.txt
        why: "literal pairing"
`,
    );
    await commitAll(ws, "initial");

    const plain = runCli(["reconcile", "--all", "--json"], env);
    assert.equal(plain.status, 0);
    const plainParsed = JSON.parse(plain.stdout.trim());
    assert.equal(plainParsed.groupBy, "none");
    assert.equal(plainParsed.groups.length, 0, "default --group-by is a pass-through");
    assert.equal(plainParsed.ungrouped.length, plainParsed.rows.length, "every row comes back ungrouped by default");

    const byGlob = runCli(["reconcile", "--all", "--group-by", "glob", "--json"], env);
    assert.equal(byGlob.status, 0, `reconcile --group-by glob failed: ${byGlob.stderr}`);
    const glob = JSON.parse(byGlob.stdout.trim());
    assert.equal(glob.groupBy, "glob");
    const globGroup = glob.groups.find((g) => g.key === "sub/*.md");
    assert.ok(globGroup, "the glob generator must appear as one group");
    assert.equal(globGroup.count, 2, "two expanded matches");
    assert.deepEqual(globGroup.states, { NEVER_VERIFIED: 2 });
    assert.equal(glob.ungrouped.length, 1, "the literal (non-glob) edge has nothing to group by");

    const byNode = runCli(["reconcile", "--all", "--group-by", "node", "--json"], env);
    assert.equal(byNode.status, 0);
    const node = JSON.parse(byNode.stdout.trim());
    assert.equal(node.groupBy, "node");
    assert.equal(node.groups.length, 1, "all three declared edges share one node_id (same source file)");
    assert.equal(node.groups[0].count, 3);
  });
});

test("verify --json — parses and matches the disposition-batch envelope", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws11");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "json envelope test"
`,
    );
    await commitAll(ws, "initial");

    const rows = runReconcileJson(env);
    const row = rowFor(rows, path.join(ws, "src.txt"));

    const r = runCli(["verify", "--edge", row.edge_id, "--disposition", "no-change-needed", "--apply", "--json"], env);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.ok(typeof parsed.generatedAt === "string" && !Number.isNaN(Date.parse(parsed.generatedAt)));
    assert.equal(parsed.disposition, "no-change-needed");
    assert.equal(parsed.selectedCount, 1);
    assert.ok(Array.isArray(parsed.confirmed));
    assert.ok(Array.isArray(parsed.refused));
    assert.ok(Array.isArray(parsed.failed));
    assert.equal(parsed.exitCode, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Basic argument validation.
// ─────────────────────────────────────────────────────────────────────────

test("verify — requires at least one selector", async () => {
  await withFixture(async (env) => {
    await makeWorkspace(env.searchRoot, "ws-empty");
    const r = runCli(["verify", "--disposition", "propagated"], env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /at least one selector/);
  });
});

test("verify — requires --disposition", async () => {
  await withFixture(async (env) => {
    await makeWorkspace(env.searchRoot, "ws-empty2");
    const r = runCli(["verify", "--edge", "deadbeef"], env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--disposition/);
  });
});

test("verify — no edges matched exits non-zero", async () => {
  await withFixture(async (env) => {
    await makeWorkspace(env.searchRoot, "ws-empty3");
    const r = runCli(["verify", "--edge", "doesnotexist", "--disposition", "propagated"], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no edges matched/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Provenance (lane W1, ~/.claude/plans/status-temporal-plum.md §1+§2):
// every event `verify` writes — both the disposition-batch path
// (buildEventPayload) and the decoupled path — must carry a real
// observed_on_ref plus the new position/actor fields, routed through
// lib/edges/provenance.mjs rather than the old `row.source.ref ||
// "working-tree"` inline expression.
// ─────────────────────────────────────────────────────────────────────────

test("verify --disposition propagated — the written event carries provenance: working-tree ref, real commit position, clean tree, by_kind human", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws-prov1");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "provenance pairing"
`,
    );
    await commitAll(ws, "initial");
    const realSha = git(["rev-parse", "HEAD"], ws);

    const before = runReconcileJson(env);
    const row = rowFor(before, path.join(ws, "src.txt"));

    const r = runCli(["verify", "--edge", row.edge_id, "--disposition", "propagated", "--apply", "--json"], env);
    assert.equal(r.status, 0, `verify failed: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout.trim());
    const eventId = parsed.confirmed[0].event_id;
    assert.ok(eventId, "confirmed entry must carry event_id to look the event up");

    const event = await readEventById(env.stateDir, eventId);
    assert.equal(event.observed_on_ref, "working-tree", "no --ref was given; the repo is a genuine working-tree read");
    assert.equal(event.observed_at_commit, realSha);
    assert.equal(event.observed_on_branch, "main");
    assert.equal(event.observed_dirty, false, "nothing was left uncommitted at the moment of the write");
    assert.equal(event.by_kind, "human");
    assert.ok(!("observed_on_ref_error" in event), "no error key on a clean resolution");
  });
});

// RED test #3 applied end-to-end through the real CLI: verifying while the
// workspace has an uncommitted change must set observed_dirty: true on the
// written event — a dirty tree means the commit recorded does NOT attribute
// the content that was actually hashed and pinned.
test("verify --disposition no-change-needed — a dirty working tree at write time sets observed_dirty: true", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws-prov2");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "dirty-tree pairing"
`,
    );
    await commitAll(ws, "initial");

    const before = runReconcileJson(env);
    const row = rowFor(before, path.join(ws, "src.txt"));

    // Leave an unrelated uncommitted change in the same repo before verifying.
    await writeFile(path.join(ws, "unrelated.txt"), "uncommitted\n");

    const r = runCli(["verify", "--edge", row.edge_id, "--disposition", "no-change-needed", "--apply", "--json"], env);
    assert.equal(r.status, 0, `verify failed: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout.trim());
    const eventId = parsed.confirmed[0].event_id;

    const event = await readEventById(env.stateDir, eventId);
    assert.equal(event.observed_dirty, true, "an uncommitted change elsewhere in the repo must still be reported as dirty");
    assert.ok(event.observed_at_commit, "the commit is still recorded, alongside the dirty flag that qualifies it");
  });
});

test("verify --disposition decoupled --apply — the event also carries provenance, routed through the same helper", async () => {
  await withFixture(async (env) => {
    const ws = await makeWorkspace(env.searchRoot, "ws-prov3");
    await writeFile(path.join(ws, "src.txt"), "src v1\n");
    await writeFile(path.join(ws, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      `workspace: true
sources:
  src.txt:
    propagates_to:
      - path: dst.txt
        why: "mistaken pairing"
`,
    );
    await commitAll(ws, "initial");
    const realSha = git(["rev-parse", "HEAD"], ws);

    const before = runReconcileJson(env);
    const row = rowFor(before, path.join(ws, "src.txt"));

    const r = runCli(
      ["verify", "--edge", row.edge_id, "--disposition", "decoupled", "--apply", "--reason", "never should have coupled these", "--json"],
      env,
    );
    assert.equal(r.status, 0, `decoupled --apply failed: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout.trim());
    const eventId = parsed.results[0].event_id;
    assert.ok(eventId);

    const event = await readEventById(env.stateDir, eventId);
    assert.equal(event.observed_on_ref, "working-tree");
    assert.equal(event.observed_at_commit, realSha);
    assert.equal(event.observed_on_branch, "main");
    // decoupled edits the sidecar BEFORE writing the event (cli.mjs's own
    // comment: "Sidecar edit first: it is the concrete, visible fact"), so
    // the tree is genuinely dirty (.propagates.yml uncommitted) at the
    // moment of the write — observed_dirty:true here is the honest answer,
    // not a bug. A hardcoded `false` would be the same "assume clean"
    // mistake this wedge exists to remove, just on the other value.
    assert.equal(event.observed_dirty, true);
    assert.equal(event.by_kind, "human");
  });
});

// An old-shape event (the exact 11-key shape all 1347 live events carry —
// see docs/deferred/2026-08-20-two-tier-ref-aware-ledger.md, "Premises")
// must still validate and still fold once W1's new optional fields exist in
// the schema. This is a literal line copied from the live store
// (~/.propagate/events/2026-08.jsonl, read-only — never written to by any
// test), not a hand-invented fixture, so the field SET and every content
// hash can't drift from what's actually on disk — except `by`, which was
// this machine's real username in the source line and is replaced with a
// neutral placeholder here so this fixture doesn't fail the make-public
// privacy check (tests/portability/make-public-watchlist.test.mjs) for
// every future public build. Nothing about the "still validates and still
// folds" claim depends on WHOSE name is in that field.
test("readEvents: an old 11-key event (verbatim from the live store, less the real username) still parses cleanly with the new fields simply absent", async () => {
  await withFixture(async (env) => {
    const eventsDir = path.join(env.stateDir, "events");
    await mkdir(eventsDir, { recursive: true });
    const legacyLine =
      '{"edge_id":"d3f4ce26","node_id":"GitHub:scripts/claude-next.sh","disposition":"baselined","reason":"baseline-from-git: co-committed at e489b3737649676581c402f410a1bc56538499be","by":"propagate-test-user","observed_on_ref":"working-tree","source_content":"d39f2b5d9f16a61a55621fc46a19831e1b496f7e4501f752cc27c528e4344418","downstream_content":"bce18f16d6b9ff3e40758f1d2098006575d1ff68d6ab679cb5d7402b8a55a792","event_id":"01KZYCX8T35V14NC3PZN7HMJXG","ts":"2026-08-13T20:27:08.482Z","hash_alg":"sha256"}';
    await writeFile(path.join(eventsDir, "2026-08.jsonl"), legacyLine + "\n");

    const script = `
      import { readEvents, knownGoodPairs } from ${JSON.stringify(fileURLToPath(new URL("../../lib/edges/events.mjs", import.meta.url)))};
      const { events, malformed } = await readEvents({ edgeId: "d3f4ce26" });
      const pairs = await knownGoodPairs();
      console.log(JSON.stringify({ events, malformed, hasPair: pairs.has("d3f4ce26|d39f2b5d9f16a61a55621fc46a19831e1b496f7e4501f752cc27c528e4344418|bce18f16d6b9ff3e40758f1d2098006575d1ff68d6ab679cb5d7402b8a55a792") }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_STATE_DIR: env.stateDir },
    });
    assert.equal(result.status, 0, `subprocess failed: ${result.stderr}`);
    const out = JSON.parse(result.stdout.trim());

    assert.equal(out.malformed, 0, "a real legacy line must never be counted malformed");
    assert.equal(out.events.length, 1);
    const event = out.events[0];
    assert.equal(event.edge_id, "d3f4ce26");
    assert.equal(event.observed_on_ref, "working-tree");
    assert.equal(event.disposition, "baselined");
    // W1's new fields are simply absent — never fabricated as "" or false.
    assert.equal("observed_at_commit" in event, false);
    assert.equal("observed_on_branch" in event, false);
    assert.equal("observed_dirty" in event, false);
    assert.equal("by_kind" in event, false);
    // The ref pair (2026-08-22) is the same story: ABSENT on every one of
    // the 1,912 events minted before it, and absent must stay absent.
    // validateEvent requires it on APPEND; readEvents must never fabricate
    // it on read, because "not recorded" and "read at the working tree" are
    // different facts about where this content came from.
    assert.equal("downstream_on_ref" in event, false);
    assert.equal("downstream_at_commit" in event, false);
    assert.equal("downstream_on_branch" in event, false);
    assert.equal("downstream_dirty" in event, false);
    // Still folds: the pinning lookup reconcile() relies on (edge_id +
    // both content ids) still resolves correctly off this event.
    assert.equal(out.hasPair, true, "the legacy event must still participate in knownGoodPairs' fold");
  });
});
