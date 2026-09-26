/**
 * verify-flags.test.mjs — ISSUES N69 and N70, both S1, both about a
 * verification row that looks complete and is not.
 *
 * EVERY ASSERTION HERE IS AGAINST THE EVENT ROW, NEVER STDOUT. That is not
 * stylistic. N69 is explicit that during the incident stdout "was correct and
 * reassuring throughout": the command printed `✓ <edge> no-change-needed →
 * CLEAN` with a real event id while the justification it was given went
 * nowhere. A test reading stdout would have passed on all twenty of them.
 *
 * N69 — `--note` was accepted and silently discarded, because nothing rejected
 * unknown flags. Twenty events landed with no record of why, closing a 15-edge
 * cascade. The store is append-only and those edges have since resolved, so
 * the reasons can never be attached by any supported path: the loss is
 * permanent the moment the command returns. That is why it is S1 rather than a
 * cosmetic gap awaiting a backfill.
 *
 * N70 — `--out-of-order` overrides the refusal that exists because pinning a
 * downstream against an unconfirmed source records a verification nobody
 * performed, and the override was recorded nowhere. `0 of 2771` events carried
 * it, so a forced CLEAN and an ordinary CLEAN read identically forever after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { makeChain, runCli, storeSnapshot, cleanup } from "../helpers/verify-fixture.mjs";

/** Every event in the scoped store, parsed. The artifact, not a report on it. */
function events(stateDir) {
  const dir = path.join(stateDir, "events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .flatMap((f) => readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l));
}

const forEdge = (stateDir, id) => events(stateDir).filter((e) => e.edge_id === id);

/* ── N69: the justification reaches the row ──────────────────────────────── */

test("N69: --note lands in the event's `reason` — the flag that was silently eaten", async (t) => {
  const { env, searchRoot, stateDir, edgeAB } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  const text = "0 matches for the changed claim in this downstream";
  const r = runCli(
    ["verify", "--edge", edgeAB.edge_id, "--disposition", "no-change-needed", "--note", text, "--apply", "--json"],
    env,
  );
  assert.equal(r.status, 0, r.stderr);

  const written = forEdge(stateDir, edgeAB.edge_id).filter((e) => e.disposition === "no-change-needed");
  assert.equal(written.length, 1, `expected one event, got ${written.length}`);
  assert.equal(written[0].reason, text,
    "the note did not reach the event — this is exactly N69, and stdout would have said it worked");
});

test("N69: --reason and --note are the SAME field, not two", async (t) => {
  const { env, searchRoot, stateDir, edgeAB } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  const r = runCli(
    ["verify", "--edge", edgeAB.edge_id, "--disposition", "no-change-needed", "--reason", "same", "--note", "same", "--apply", "--json"],
    env,
  );
  assert.equal(r.status, 0, r.stderr);
  const w = forEdge(stateDir, edgeAB.edge_id).filter((e) => e.disposition === "no-change-needed");
  assert.equal(w[0].reason, "same", "identical text in both flags is not a conflict");
});

test("N69: --reason and --note with DIFFERENT text is refused, and writes nothing", async (t) => {
  // Silently preferring one is the same class of defect as silently dropping
  // it: the user's other sentence goes nowhere and nothing says so.
  const { env, searchRoot, stateDir, edgeAB } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  const before = storeSnapshot(stateDir);
  const r = runCli(
    ["verify", "--edge", edgeAB.edge_id, "--disposition", "no-change-needed", "--reason", "A", "--note", "B", "--apply"],
    env,
  );
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--reason and --note were both given/);
  assert.equal(storeSnapshot(stateDir), before, "a refused verify must write nothing");
});

/* ── N69: an unknown flag stops the command ─────────────────────────────── */

test("N69: an unknown flag exits non-zero and writes NOTHING", async (t) => {
  const { env, searchRoot, stateDir, edgeAB } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  const before = storeSnapshot(stateDir);
  const r = runCli(
    ["verify", "--edge", edgeAB.edge_id, "--disposition", "no-change-needed", "--resaon", "typo", "--apply"],
    env,
  );
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.match(r.stderr, /unknown flag --resaon/);
  assert.match(r.stderr, /did you mean --reason\?/, "a refusal without a suggestion is a worse refusal");
  assert.equal(storeSnapshot(stateDir), before,
    "a command refused for a bad flag must not have written an event first");
});

test("N69: the refusal happens BEFORE the work, not after it", async (t) => {
  // The ordering matters: rejecting after the write would leave the very row
  // this issue is about, plus an error message.
  const { env, searchRoot, stateDir, edgeAB } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  const r = runCli(
    ["verify", "--edge", edgeAB.edge_id, "--disposition", "no-change-needed", "--bogus", "--apply"],
    env,
  );
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout, /✓/, "no tick may be printed for a command that was refused");
  assert.equal(forEdge(stateDir, edgeAB.edge_id).filter((e) => e.disposition === "no-change-needed").length, 0);
});

/* ── N70: the override leaves a trace ───────────────────────────────────── */

test("N70: --out-of-order is recorded on the event, with the upstreams it bypassed", async (t) => {
  const { env, searchRoot, stateDir, edgeAB, edgeBC } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  // B->C is CLEAN but its SOURCE is the downstream of a DRIFTED edge, so the
  // guard fires on it. That is the fixture's sharp case.
  const refused = runCli(["verify", "--edge", edgeBC.edge_id, "--disposition", "propagated", "--apply"], env);
  assert.equal(refused.status, 3, "fixture: B->C must be blocked, or this test proves nothing");

  const r = runCli(
    ["verify", "--edge", edgeBC.edge_id, "--disposition", "propagated", "--out-of-order",
     "--reason", "measured the downstream directly", "--apply", "--json"],
    env,
  );
  assert.equal(r.status, 0, r.stderr);

  const w = forEdge(stateDir, edgeBC.edge_id).filter((e) => e.disposition === "propagated");
  assert.equal(w.length, 1);
  assert.equal(w[0].out_of_order, true, "the override left no trace — this is N70");
  assert.deepEqual(w[0].bypassed_upstreams, [edgeAB.edge_id],
    "the event must name WHICH upstream was bypassed; 'it was forced' is weaker than " +
    "'it was forced past this', and only the second survives once that upstream resolves");
});

test("N70: an ORDINARY verification carries no override field — the negative control", async (t) => {
  // Without this, `out_of_order: true` on every row would pass the test above
  // while destroying the distinction it exists to make.
  const { env, searchRoot, stateDir, edgeAB } = await makeChain();
  t.after(() => cleanup(searchRoot, stateDir));

  const r = runCli(
    ["verify", "--edge", edgeAB.edge_id, "--disposition", "no-change-needed", "--reason", "ordinary", "--apply", "--json"],
    env,
  );
  assert.equal(r.status, 0, r.stderr);

  const w = forEdge(stateDir, edgeAB.edge_id).filter((e) => e.disposition === "no-change-needed");
  assert.equal(w.length, 1);
  assert.equal(Object.hasOwn(w[0], "out_of_order"), false,
    "an unforced verification must not carry the field at all — absence is the signal");
  assert.equal(Object.hasOwn(w[0], "bypassed_upstreams"), false);
});

/* ── N70: and it reaches the surface ────────────────────────────────────── */

test("N70: the forced count distinguishes a forced CLEAN from an ordinary one", async () => {
  // Asserted against `coverageFrom` rather than `status` stdout, and the reason
  // is a check that passed for the wrong reason first: the CLI fixture has no
  // ledger file, so `status` prints "(no ledger file yet)" and never reaches
  // the summary line. A `doesNotMatch(/forced/)` there was satisfied by output
  // that contained no counts at all.
  const { coverageFrom } = await import("../../commands/status.mjs");

  const clean = (over = {}) => ({ state: "CLEAN", ...over });
  const cov = coverageFrom([
    clean({ last: { disposition: "propagated" } }),
    clean({ last: { disposition: "propagated", out_of_order: true } }),
    clean({ last: null }),
  ]);

  assert.equal(cov.verified, 3, "a forced verification is still VERIFIED — it is a weaker claim, not a failure");
  assert.equal(cov.forced, 1, "exactly the forced one is counted");

  // The negative control. Without it, `forced = verified` would pass above.
  const none = coverageFrom([clean({ last: { disposition: "propagated" } }), clean({ last: null })]);
  assert.equal(none.forced, 0, "nothing forced must count zero, or the marker fires on every tree");
  assert.equal(none.verified, 2);
});
