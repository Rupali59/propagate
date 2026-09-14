/**
 * lib/claims/runs.mjs — the answering-run log, and the boundary it must keep.
 *
 * Same posture as `claims-judge.test.mjs`: propagate never calls a model and
 * never makes a network call, and that is asserted by reading this module's
 * own source text rather than trusting a comment. This module additionally
 * must not shell out at all (unlike `check.mjs`, which is allowed exactly one
 * local `git rev-parse --verify`) — a run record is pure bookkeeping over the
 * filesystem the claims store already owns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  RUN_OUTCOMES,
  validateRunRecord,
  dryValidateRunRecord,
  summarizeRunsForFile,
} from "../../lib/claims/runs.mjs";

const SRC = readFileSync(fileURLToPath(new URL("../../lib/claims/runs.mjs", import.meta.url)), "utf8");
const CODE_ONLY = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── boundary ─────────────────────────────────────────────────────────────

test("lib/claims/runs.mjs imports no model/SDK client", () => {
  for (const forbidden of ["@anthropic-ai", "openai", "anthropic", "langchain"]) {
    assert.equal(CODE_ONLY.includes(forbidden), false, `runs.mjs must not import ${forbidden}`);
  }
});

test("lib/claims/runs.mjs makes no network call and spawns no subprocess", () => {
  for (const forbidden of ["fetch(", "node:http", "node:https", "undici", "execFileSync", "spawnSync", "execSync"]) {
    assert.equal(CODE_ONLY.includes(forbidden), false, `runs.mjs must not use ${forbidden}`);
  }
});

test("lib/claims/runs.mjs does not print — rendering stays in commands/claims.mjs", () => {
  assert.doesNotMatch(CODE_ONLY, /console\.(log|error|warn|info)\s*\(/, "lib/claims/runs.mjs must not print");
});

// ── validation ───────────────────────────────────────────────────────────

test("validateRunRecord rejects a non-object record", () => {
  for (const bad of [null, undefined, "a string", 42]) {
    assert.throws(() => validateRunRecord(bad), /not an object/, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("validateRunRecord rejects a record with no file", () => {
  assert.throws(() => validateRunRecord({ run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", phase: "start" }), /missing "file"/);
});

test("validateRunRecord rejects a non-ULID run_id", () => {
  assert.throws(() => validateRunRecord({ file: "/x.md", run_id: "not-a-ulid", phase: "start" }), /"run_id"/);
});

test("validateRunRecord rejects an unknown phase", () => {
  assert.throws(
    () => validateRunRecord({ file: "/x.md", run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", phase: "middle" }),
    /"phase" must be "start" or "end"/,
  );
});

test("a start record must not carry an outcome", () => {
  assert.throws(
    () => validateRunRecord({ file: "/x.md", run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", phase: "start", outcome: "ok" }),
    /must not carry an "outcome"/,
  );
});

test("an end record requires a valid outcome", () => {
  assert.throws(
    () => validateRunRecord({ file: "/x.md", run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", phase: "end" }),
    /needs "outcome"/,
  );
  assert.throws(
    () => validateRunRecord({ file: "/x.md", run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", phase: "end", outcome: "maybe" }),
    /needs "outcome"/,
  );
});

test("outcomes no-brain and error require a reason; ok does not", () => {
  for (const outcome of ["no-brain", "error"]) {
    assert.throws(
      () => validateRunRecord({ file: "/x.md", run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", phase: "end", outcome }),
      /requires a "reason"/,
      `outcome "${outcome}" without a reason must be rejected`,
    );
  }
  assert.equal(
    dryValidateRunRecord({ file: "/x.md", run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", phase: "end", outcome: "ok" }),
    null,
    "ok needs no reason",
  );
});

test("RUN_OUTCOMES is closed to exactly ok / no-brain / error", () => {
  assert.deepEqual([...RUN_OUTCOMES], ["ok", "no-brain", "error"]);
});

// ── summarizeRunsForFile: pure fold, no disk ────────────────────────────
//
// The actual append/read round trip (`appendRunStart`/`appendRunEnd`/
// `readRuns` writing real bytes) is tested at the CLI boundary in
// `tests/cli/claims-judge-runs.test.mjs`, which gives each test its own
// `mkdtemp`'d `PROPAGATE_STATE_DIR`. Deliberately NOT tested here: `RUNS_DIR`
// is a module-level const resolved from `STATE_DIR` at import time, fixed for
// the whole `npm test` process by the `test:propagate` script's ONE shared
// stable path — so unit tests in this file must never call the real
// `appendRunStart`/`appendRunEnd`/`readRuns` against it. That path is
// intentionally not a fresh `mktemp` (G56 — a fresh dir has no `config.yml`
// and breaks discovery for tests that need it), which means it is NOT wiped
// between separate `npm test` invocations either. A test asserting an exact
// count against real disk here would be counting every previous run of this
// suite, not just its own writes — exactly the pollution this split avoids.

test("summarizeRunsForFile: no records at all is 'never', 0 runs", () => {
  const s = summarizeRunsForFile([]);
  assert.deepEqual(s, { count: 0, status: "never", outcome: null, runId: null });
});

test("summarizeRunsForFile: a start with no matching end is 'crashed'", () => {
  const s = summarizeRunsForFile([
    { run_id: "R1", phase: "start", ts: "2026-09-14T00:00:00.000Z", file: "/x.md" },
  ]);
  assert.equal(s.status, "crashed");
  assert.equal(s.count, 1);
  assert.equal(s.runId, "R1");
});

test("summarizeRunsForFile: a start with a matching end is 'completed', carrying the outcome", () => {
  const s = summarizeRunsForFile([
    { run_id: "R1", phase: "start", ts: "2026-09-14T00:00:00.000Z", file: "/x.md" },
    { run_id: "R1", phase: "end", outcome: "no-brain", ts: "2026-09-14T00:00:01.000Z", file: "/x.md" },
  ]);
  assert.equal(s.status, "completed");
  assert.equal(s.outcome, "no-brain");
  assert.equal(s.count, 1);
});

test("summarizeRunsForFile: the run with the LATEST start wins, even if it is the one that crashed", () => {
  const s = summarizeRunsForFile([
    { run_id: "R1", phase: "start", ts: "2026-09-14T00:00:00.000Z", file: "/x.md" },
    { run_id: "R1", phase: "end", outcome: "ok", ts: "2026-09-14T00:00:01.000Z", file: "/x.md" },
    { run_id: "R2", phase: "start", ts: "2026-09-14T00:05:00.000Z", file: "/x.md" }, // no end
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.status, "crashed");
  assert.equal(s.runId, "R2", "a newer crash must not be masked by an older completed run");
});

test("summarizeRunsForFile: an end record with no matching start is ordered last, never masquerading as latest", () => {
  // Per the doc comment: "possible only if a shard was pruned or hand-edited".
  // Its start-ts key is `entry.start?.ts ?? ""`, the empty string sorting
  // before every real ISO timestamp — so a genuinely-started, genuinely-newer
  // run must still win over a startless end record, however late that end's
  // OWN timestamp is.
  const s = summarizeRunsForFile([
    { run_id: "R1", phase: "start", ts: "2026-09-14T00:00:00.000Z", file: "/x.md" },
    { run_id: "R1", phase: "end", outcome: "ok", ts: "2026-09-14T00:00:01.000Z", file: "/x.md" },
    // R2 has only an end, stamped LATER than everything above — and must not win.
    { run_id: "R2", phase: "end", outcome: "error", reason: "orphaned end", ts: "2026-09-20T00:00:00.000Z", file: "/x.md" },
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.runId, "R1", "the startless end record must not outrank the run that actually started");
  assert.equal(s.status, "completed");
  assert.equal(s.outcome, "ok");
});

test("summarizeRunsForFile: ranks by START ts, not by whichever record has the latest ts", () => {
  // R1 started first and is still open (no end at all); R2 started second and
  // already finished. Ranking by "any record's ts" would let R2's END ts (the
  // largest timestamp in the set) outrank R1's start — the doc comment's
  // warning about a "still-open run masking a newer crash" cuts both ways.
  const s = summarizeRunsForFile([
    { run_id: "R1", phase: "start", ts: "2026-09-14T00:00:00.000Z", file: "/x.md" },
    { run_id: "R2", phase: "start", ts: "2026-09-14T00:01:00.000Z", file: "/x.md" },
    { run_id: "R2", phase: "end", outcome: "ok", ts: "2026-09-14T00:02:00.000Z", file: "/x.md" },
  ]);
  assert.equal(s.runId, "R2", "R2 started later, so it is the latest ATTEMPT regardless of R1 still being open");
  assert.equal(s.status, "completed");
});
