/**
 * `/api/dispose`'s BATCH path — {node_id, state, disposition, reason}.
 *
 * WHY A SEPARATE FILE FROM tests/cli/ui-queue.test.mjs. That file tests the
 * single-edge write gate (`validateWrite`) as a pure function. The batch gate
 * has one property the single-edge path does not: a group that fails its
 * uniformity check must be refused WHOLESALE, never narrowed to the members
 * that happen to match — narrowing would make a partial application
 * expressible through the very check meant to forbid it. That is the risk
 * worth its own file and, per rule:safety-flag-needs-a-test, its own
 * real-store assertions rather than a mocked writer nobody can be sure
 * matches production.
 *
 * `validateBatchWrite` is pure (no I/O) and tested directly. `applyBatchDispose`
 * writes real events, so its tests run through a Node subprocess scoped to a
 * fresh PROPAGATE_STATE_DIR — the same reason tests/cli/verify.test.mjs's
 * header gives: lib/edges/events.mjs resolves EVENTS_DIR from
 * PROPAGATE_STATE_DIR at import time (a module-level const), so setting
 * process.env in this process after events.mjs is already loaded would not
 * move it, and G56 records what running the write path against the wrong
 * (production) store costs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateBatchWrite } from "../../commands/ui.mjs";

const UI_URL = pathToFileURL(fileURLToPath(new URL("../../commands/ui.mjs", import.meta.url))).href;
const EVENTS_URL = pathToFileURL(fileURLToPath(new URL("../../lib/edges/events.mjs", import.meta.url))).href;
const DISPOSITION_URL = pathToFileURL(fileURLToPath(new URL("../../lib/edges/disposition.mjs", import.meta.url))).href;

/** Concatenate every byte of the event store — the artifact, not a report
 * about it. Same shape as tests/unit/claims-verdict.test.mjs's storeSnapshot. */
async function storeSnapshot(stateDir) {
  const dir = path.join(stateDir, "events");
  if (!existsSync(dir)) return "";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  let out = "";
  for (const f of files) out += await readFile(path.join(dir, f), "utf8");
  return out;
}

/**
 * Run the REAL two-step sequence commands/ui.mjs's /api/dispose route runs
 * for a batch body — `validateBatchWrite` gates, and only a null result
 * reaches `applyBatchDispose` (the real write) — against an isolated store.
 */
function runBatchDispose(stateDir, scenario) {
  const code = `
    import { validateBatchWrite, applyBatchDispose } from ${JSON.stringify(UI_URL)};
    import { appendEvent } from ${JSON.stringify(EVENTS_URL)};
    import { buildEventPayload, divergedGuard } from ${JSON.stringify(DISPOSITION_URL)};
    const { body, members, rows } = ${JSON.stringify(scenario)};
    const invalid = validateBatchWrite(body, members);
    if (invalid) {
      process.stdout.write(JSON.stringify({ invalid }));
    } else {
      const result = await applyBatchDispose({ body, members, rows, appendEvent, buildEventPayload, divergedGuard, by: "test (ui)" });
      process.stdout.write(JSON.stringify({ invalid: null, result }));
    }
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
  if (r.status !== 0) throw new Error(`batch-dispose runner failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

// A path that is genuinely outside any git repo, so resolveProvenance's
// git-context lookup returns the honest "outside any repo" non-error case
// (lib/core/git-context.mjs) rather than picking up whatever repo happens to
// contain the OS tmp dir.
const FIXTURE_BASE = path.join(tmpdir(), "ui-batch-fixture-no-such-repo");

function member(edgeId, state, allowed) {
  return { edge_id: edgeId, node_id: "/n/src.md", state, allowed };
}

function row(edgeId, state, dstName) {
  return {
    edge_id: edgeId,
    node_id: "/n/src.md",
    state,
    source: { path: path.join(FIXTURE_BASE, "src.md"), contentId: "src-" + edgeId },
    downstream: { path: path.join(FIXTURE_BASE, dstName), contentId: "dst-" + edgeId },
  };
}

const ALLOWED = ["propagated", "no-change-needed", "source-corrected", "decoupled", "deferred", "wontfix"];
const REASON = "reviewed all members, none need a change here";

async function withStateDir(prefix, fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await fn(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// ── validateBatchWrite: pure, no I/O ────────────────────────────────────────

test("validateBatchWrite refuses a missing field with 400", () => {
  const members = [member("e1", "DRIFTED", ALLOWED)];
  assert.equal(validateBatchWrite({ state: "DRIFTED", disposition: "no-change-needed", reason: REASON }, members).code, 400);
  assert.equal(validateBatchWrite({ node_id: "/n/src.md", disposition: "no-change-needed", reason: REASON }, members).code, 400);
  assert.equal(validateBatchWrite({ node_id: "/n/src.md", state: "DRIFTED", reason: REASON }, members).code, 400);
});

test("validateBatchWrite refuses zero members with 409, not a vacuous success", () => {
  const r = validateBatchWrite({ node_id: "/n/gone.md", state: "DRIFTED", disposition: "no-change-needed", reason: REASON }, []);
  assert.equal(r.code, 409);
  assert.match(r.error, /no actionable edges/);
});

test("validateBatchWrite refuses a MIXED-state group wholesale, and names the split", () => {
  const members = [member("e1", "DRIFTED", ALLOWED), member("e2", "REVERSED", ALLOWED)];
  const r = validateBatchWrite({ node_id: "/n/src.md", state: "DRIFTED", disposition: "no-change-needed", reason: REASON }, members);
  assert.equal(r.code, 409);
  assert.match(r.error, /not uniformly DRIFTED/);
  assert.match(r.error, /REVERSED/, "the refusal must name the state that disagrees");
});

test("validateBatchWrite refuses a disposition the (uniform) state does not accept", () => {
  const members = [member("e1", "DIVERGED", ["both-reconciled"]), member("e2", "DIVERGED", ["both-reconciled"])];
  const r = validateBatchWrite({ node_id: "/n/src.md", state: "DIVERGED", disposition: "no-change-needed", reason: REASON }, members);
  assert.equal(r.code, 400);
  assert.match(r.error, /both-reconciled/, "the refusal must name what IS allowed");
});

test("validateBatchWrite refuses a short reason — the UI is stricter than the CLI on purpose", () => {
  const members = [member("e1", "DRIFTED", ALLOWED)];
  const r = validateBatchWrite({ node_id: "/n/src.md", state: "DRIFTED", disposition: "no-change-needed", reason: "ok" }, members);
  assert.equal(r.code, 400);
  assert.match(r.error, /12 characters/);
});

test("validateBatchWrite accepts a genuinely uniform group", () => {
  const members = [member("e1", "DRIFTED", ALLOWED), member("e2", "DRIFTED", ALLOWED)];
  assert.equal(validateBatchWrite({ node_id: "/n/src.md", state: "DRIFTED", disposition: "no-change-needed", reason: REASON }, members), null);
});

// ── applyBatchDispose: real writes, isolated store ──────────────────────────

test("a mixed-state node is refused before any write is attempted, and the store is byte-identical", async () => {
  await withStateDir("ui-batch-mixed-", async (stateDir) => {
    const members = [member("e1", "DRIFTED", ALLOWED), member("e2", "REVERSED", ALLOWED)];
    const rows = [row("e1", "DRIFTED", "d1.md"), row("e2", "REVERSED", "d2.md")];
    const before = await storeSnapshot(stateDir);
    const out = runBatchDispose(stateDir, {
      body: { node_id: "/n/src.md", state: "DRIFTED", disposition: "no-change-needed", reason: REASON },
      members, rows,
    });
    assert.ok(out.invalid, "a mixed-state group must be refused, not partially applied");
    assert.equal(out.invalid.code, 409);
    assert.equal(await storeSnapshot(stateDir), before, "a refused batch must not touch the store");
  });
});

test("a uniform batch writes one event per member, ALL carrying the same reason", async () => {
  await withStateDir("ui-batch-uniform-", async (stateDir) => {
    const members = [member("e1", "DRIFTED", ALLOWED), member("e2", "DRIFTED", ALLOWED), member("e3", "DRIFTED", ALLOWED)];
    const rows = [row("e1", "DRIFTED", "d1.md"), row("e2", "DRIFTED", "d2.md"), row("e3", "DRIFTED", "d3.md")];
    const out = runBatchDispose(stateDir, {
      body: { node_id: "/n/src.md", state: "DRIFTED", disposition: "no-change-needed", reason: REASON },
      members, rows,
    });
    assert.equal(out.invalid, null);
    assert.equal(out.result.ok, true);
    assert.equal(out.result.results.length, 3);
    assert.ok(out.result.results.every((r) => r.ok), JSON.stringify(out.result.results));

    // The store itself, not just the function's return value.
    const raw = await storeSnapshot(stateDir);
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 3, "one event per member, no more, no fewer");
    assert.deepEqual(new Set(lines.map((l) => l.edge_id)), new Set(["e1", "e2", "e3"]));
    for (const l of lines) assert.equal(l.reason, REASON, "every member's event must carry the SAME reason");
  });
});

test("a partial failure is reported per edge_id, and ok is never true when one member failed", async () => {
  await withStateDir("ui-batch-partial-", async (stateDir) => {
    const members = [member("e1", "DRIFTED", ALLOWED), member("e2", "DRIFTED", ALLOWED)];
    // e2 is ABSENT from the freshly reconciled rows -- simulating "vanished
    // between the two reads," the race applyBatchDispose exists to catch even
    // after the group passed the uniform-state gate.
    const rows = [row("e1", "DRIFTED", "d1.md")];
    const out = runBatchDispose(stateDir, {
      body: { node_id: "/n/src.md", state: "DRIFTED", disposition: "no-change-needed", reason: REASON },
      members, rows,
    });
    assert.equal(out.invalid, null, "the group passed the uniform-state gate; only the fresh re-check catches e2");
    assert.equal(out.result.ok, false, "ok must be false when ANY member failed — never a bare success");
    const byId = Object.fromEntries(out.result.results.map((r) => [r.edge_id, r]));
    assert.equal(byId.e1.ok, true);
    assert.equal(byId.e2.ok, false);
    assert.match(byId.e2.error, /vanished/);

    // e1's event still landed — one member's failure must not roll back
    // another member's write; only the group-level gate is all-or-nothing.
    const raw = await storeSnapshot(stateDir);
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.edge_id), ["e1"]);
  });
});

test("a member that moved state between the two reconciles is refused individually, not the whole batch", async () => {
  await withStateDir("ui-batch-moved-", async (stateDir) => {
    const members = [member("e1", "DRIFTED", ALLOWED), member("e2", "DRIFTED", ALLOWED)];
    // e2's FRESH row reads REVERSED — it moved after validateBatchWrite's
    // snapshot was taken but before the write.
    const rows = [row("e1", "DRIFTED", "d1.md"), row("e2", "REVERSED", "d2.md")];
    const out = runBatchDispose(stateDir, {
      body: { node_id: "/n/src.md", state: "DRIFTED", disposition: "no-change-needed", reason: REASON },
      members, rows,
    });
    assert.equal(out.invalid, null);
    assert.equal(out.result.ok, false);
    const byId = Object.fromEntries(out.result.results.map((r) => [r.edge_id, r]));
    assert.equal(byId.e1.ok, true);
    assert.equal(byId.e2.ok, false);
    assert.match(byId.e2.error, /moved to REVERSED/);
  });
});
