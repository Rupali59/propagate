/**
 * The CLI leg of the allowedDispositions parity table.
 *
 * tests/unit/allowed-dispositions.test.mjs proves the pure function, the queue
 * and the UI agree. This proves `verify` ITSELF agrees with the pure function,
 * by running it: for a real edge in each (state, blocked) cell and every
 * disposition, a disposition `allowedDispositions` calls allowed must not be
 * refused, one it calls an --out-of-order route must exit 3, and anything else
 * must be refused somehow. Dry-run only, and the event store is snapshotted to
 * prove it -- this file must never be the thing that writes
 * (`rule:safety-flag-needs-a-test`).
 *
 * Two fixtures cover four cells (makeChain A->B->C):
 *   A edited:       A->B DRIFTED (unblocked)   B->C CLEAN   (blocked by A->B)
 *   A and B edited: A->B DIVERGED (unblocked)  B->C DRIFTED (blocked by A->B)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { makeChain, runCli, storeSnapshot, cleanup } from "../helpers/verify-fixture.mjs";
import { allowedDispositions } from "../../lib/edges/disposition.mjs";
import { DISPOSITIONS } from "../../lib/edges/events.mjs";

function probe(env, row, disposition) {
  const r = runCli(
    ["verify", "--edge", row.edge_id, "--disposition", disposition, "--reason", "parity probe", "--json"],
    env,
  );
  let refusal = null;
  if (r.status === 0) {
    const out = JSON.parse(r.stdout);
    // `decoupled` takes its own path and reports `results`, not `wouldWrite`.
    refusal = out.wouldWrite ? out.wouldWrite[0].refusal : (out.results[0].ok ? null : out.results[0].error);
  } else if (r.status === 1 && disposition === "decoupled") {
    refusal = JSON.parse(r.stdout).results[0].error; // runDecoupled exits 1 on a refused row
  }
  return { status: r.status, refusal };
}

function assertParity(env, row, blocked, label) {
  const expected = allowedDispositions({ state: row.state }, blocked ? [{ edge_id: "x" }] : []);
  let probed = 0;
  for (const d of DISPOSITIONS) {
    const got = probe(env, row, d);
    probed += 1;
    if (expected.allowed.includes(d)) {
      assert.equal(got.status, 0, `${label}: ${d} is allowed but verify exited ${got.status}`);
      assert.equal(got.refusal, null, `${label}: ${d} is allowed but verify refused it: ${got.refusal}`);
    } else if (expected.viaOutOfOrder.includes(d)) {
      assert.equal(got.status, 3, `${label}: ${d} is an --out-of-order route; verify exited ${got.status}`);
    } else {
      assert.ok(got.status === 3 || got.refusal, `${label}: ${d} is not allowed but verify let it through`);
    }
  }
  assert.equal(probed, DISPOSITIONS.length);
}

test("verify agrees with allowedDispositions: DRIFTED unblocked and CLEAN blocked", async () => {
  const f = await makeChain();
  try {
    assert.equal(f.edgeAB.state, "DRIFTED");
    assert.equal(f.edgeBC.state, "CLEAN");
    const before = storeSnapshot(f.stateDir);
    assertParity(f.env, f.edgeAB, false, "DRIFTED unblocked");
    assertParity(f.env, f.edgeBC, true, "CLEAN blocked");
    assert.equal(storeSnapshot(f.stateDir), before, "dry-run probes must not touch the store");
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("verify agrees with allowedDispositions: DIVERGED unblocked and DRIFTED blocked", async () => {
  const f = await makeChain();
  try {
    await writeFile(path.join(f.ws, "B.md"), "B v2\n"); // now A->B DIVERGED, B->C DRIFTED
    const rows = JSON.parse(runCli(["reconcile", "--all", "--json"], f.env).stdout).rows;
    const ab = rows.find((r) => r.source.path.endsWith("A.md"));
    const bc = rows.find((r) => r.source.path.endsWith("B.md"));
    assert.equal(ab.state, "DIVERGED");
    assert.equal(bc.state, "DRIFTED");
    const before = storeSnapshot(f.stateDir);
    assertParity(f.env, ab, false, "DIVERGED unblocked");
    assertParity(f.env, bc, true, "DRIFTED blocked");
    assert.equal(storeSnapshot(f.stateDir), before);
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});
