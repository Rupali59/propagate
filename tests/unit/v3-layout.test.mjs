/**
 * The v3 layout conformance predicate — docs/REFERENCE.md §"Propagation layout",
 * and the ratchet for docs/plans/2026-08-22-v3-one-propagation-standard.md.
 *
 * WHY THIS IS A SEPARATE PURE FUNCTION rather than logic inside doctor: the
 * plan's single critical gap is that the conformance check must be PROVEN to
 * fail on today's tree before any workspace is migrated. A predicate that can
 * only be exercised by running the whole doctor is a predicate whose failure
 * case is expensive to construct, and expensive-to-construct failure cases are
 * the ones that never get written (tests/cli/doctor-check-coverage.test.mjs
 * records 14 doctor checks with no failing-case test at all).
 *
 * The interesting assertions here are the NEGATIVE ones: a fully-conforming
 * fixture must report zero missing, and a bare directory must report every
 * required item by name. A predicate that says "not conforming" without saying
 * what is absent is the unattributable-absence failure (rule:discernment-checks
 * §2) in a new place.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { V3_REQUIRED, conformance } from "../../lib/core/v3-layout.mjs";

/** Build a workspace holding exactly the named subset of the v3 tree. */
async function makeWorkspace(present = []) {
  const root = await mkdtemp(path.join(tmpdir(), "v3-layout-"));
  const prop = path.join(root, "propagation");
  await mkdir(prop, { recursive: true });
  if (present.includes("README.md")) await writeFile(path.join(prop, "README.md"), "# propagation\n");
  if (present.includes("INDEX.md")) await writeFile(path.join(prop, "INDEX.md"), "# index\n");
  if (present.includes("refs/snapshot.json")) {
    await mkdir(path.join(prop, "refs"), { recursive: true });
    await writeFile(path.join(prop, "refs", "snapshot.json"), "{}\n");
  }
  if (present.includes("refs/lifecycle.jsonl")) {
    await mkdir(path.join(prop, "refs"), { recursive: true });
    await writeFile(path.join(prop, "refs", "lifecycle.jsonl"), "");
  }
  if (present.includes("state/")) {
    await mkdir(path.join(prop, "state", "someproject"), { recursive: true });
    await writeFile(path.join(prop, "state", "someproject", "STATE.md"), "# state\n");
  }
  return root;
}

test("V3_REQUIRED names every item the layout section specifies, and nothing else", () => {
  // Guards against the list quietly growing a requirement that no workspace can
  // satisfy, which would make the check unpassable rather than useful.
  assert.deepEqual(
    [...V3_REQUIRED].sort(),
    ["INDEX.md", "README.md", "refs/lifecycle.jsonl", "refs/snapshot.json", "state/"].sort(),
  );
});

test("a bare propagation/ reports EVERY missing item by name, never a bare false", async () => {
  const root = await makeWorkspace([]);
  try {
    const r = conformance(root);
    assert.equal(r.conforms, false);
    assert.deepEqual([...r.missing].sort(), [...V3_REQUIRED].sort());
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a fully-populated propagation/ conforms and reports nothing missing", async () => {
  const root = await makeWorkspace([...V3_REQUIRED]);
  try {
    const r = conformance(root);
    assert.equal(r.conforms, true, `should conform, missing: ${r.missing.join(", ")}`);
    assert.deepEqual(r.missing, []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a PARTIAL workspace names only what it lacks — the common case during migration", async () => {
  // This is the shape every workspace passes through in Phase E, so the
  // predicate has to be useful mid-migration, not only at the endpoints.
  const root = await makeWorkspace(["state/", "README.md"]);
  try {
    const r = conformance(root);
    assert.equal(r.conforms, false);
    assert.deepEqual([...r.missing].sort(), ["INDEX.md", "refs/lifecycle.jsonl", "refs/snapshot.json"]);
    assert.ok(!r.missing.includes("state/"), "must not report what is present");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("state/ requires an actual project directory, not just the folder", async () => {
  const root = await makeWorkspace([...V3_REQUIRED]);
  try {
    await rm(path.join(root, "propagation", "state", "someproject"), { recursive: true, force: true });
    const r = conformance(root);
    assert.equal(r.conforms, false, "an EMPTY state/ is scaffolding, not state");
    assert.ok(r.missing.includes("state/"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a workspace with no propagation/ at all is attributable, not a crash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "v3-layout-none-"));
  try {
    assert.doesNotThrow(() => conformance(root));
    const r = conformance(root);
    assert.equal(r.conforms, false);
    assert.deepEqual([...r.missing].sort(), [...V3_REQUIRED].sort());
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
