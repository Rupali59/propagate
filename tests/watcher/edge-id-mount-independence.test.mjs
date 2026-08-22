/**
 * N40 — the same coupling must keep ONE identity across checkout locations.
 *
 * WHY THIS EXISTS. `tests/watcher/edge-id-stability.test.mjs` freezes the
 * `edgeId` HASH. It does not, and cannot, see a change to what the hash is
 * FED — yet feeding it a different value has exactly the same consequence:
 * every persisted event orphans from its edge and the store reads as
 * unverified. That gap is how N40 lived at S1 while a test named
 * "edge-id-stability" stayed green. This file closes it by asserting the
 * property rather than the derivation.
 *
 * WHAT IS FIXED, AND WHAT IS NOT. The downstream half is now a repo-relative
 * node id, so the same repo cloned to a different parent directory yields the
 * same edge ids. The node id still embeds `basename(repoRoot)`, so a checkout
 * RENAMED on disk (`propagate-skill` -> `propagate`) still mints new ids.
 * That residual is deliberate and recorded in docs/ISSUES.md N40 — a stable
 * repo identifier needs a decision about repos with no remote, which is a
 * larger change than this one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { edgeId } from "../../lib/edges/events.mjs";
import { toNodeId, edgeIdFor } from "../../lib/edges/reconcile.mjs";

/** A repo named `myrepo` under a fresh parent, with a source and a downstream. */
function makeCheckout() {
  const parent = mkdtempSync(path.join(tmpdir(), "propagate-mount-"));
  const repo = path.join(parent, "myrepo");
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "SOURCE.md"), "source\n");
  writeFileSync(path.join(repo, "docs", "DOWN.md"), "downstream\n");
  return {
    sourceAbs: path.join(repo, "docs", "SOURCE.md"),
    downstreamAbs: path.join(repo, "docs", "DOWN.md"),
  };
}

const WHY = "the summary must not diverge from the full list";

test("N40: identical repos at different mounts mint the SAME edge id", () => {
  const a = makeCheckout();
  const b = makeCheckout();
  assert.notEqual(a.downstreamAbs, b.downstreamAbs, "test setup: mounts must differ");

  // edgeIdFor is what reconcile.mjs and cli.mjs actually call. Composing the
  // derivation by hand here would let this guard agree with itself while
  // disagreeing with production — the exact failure it exists to catch.
  const idA = edgeIdFor(toNodeId(a.sourceAbs), a.downstreamAbs, WHY);
  const idB = edgeIdFor(toNodeId(b.sourceAbs), b.downstreamAbs, WHY);

  assert.equal(
    idA,
    idB,
    "the same coupling minted two identities. Every event keyed by the other " +
      "one orphans and reads as 'never verified'. This is N40.",
  );
});

test("N40: the pre-fix form (absolute downstream) DID differ — the defect was real", () => {
  // Demonstrates this test can fail, and documents what it is protecting
  // against. If this assertion ever goes green, absolute paths have stopped
  // varying and the guard above is no longer load-bearing.
  const a = makeCheckout();
  const b = makeCheckout();
  const nodeId = toNodeId(a.sourceAbs); // same on both by construction

  assert.notEqual(
    edgeId(nodeId, a.downstreamAbs, WHY),
    edgeId(nodeId, b.downstreamAbs, WHY),
    "absolute downstream paths no longer vary across mounts",
  );
});

test("N40: distinct downstreams still get distinct ids — the fix did not collapse edges", () => {
  const a = makeCheckout();
  const nodeId = toNodeId(a.sourceAbs);
  const other = path.join(path.dirname(a.downstreamAbs), "OTHER.md");

  assert.notEqual(
    edgeIdFor(nodeId, a.downstreamAbs, WHY),
    edgeIdFor(nodeId, other, WHY),
    "two different downstreams collapsed to one id",
  );
});
