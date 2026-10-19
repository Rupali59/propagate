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

/* ── N82: "present but empty" is its own fact ───────────────────────────── */

test("N82: a project directory that EXISTS and is EMPTY does not conform", async () => {
  // THE LIVE SYMPTOM. `hasProjectDir` was documented as "exists and holds at
  // least one subdirectory", and an empty subdirectory satisfied that. Measured
  // on the real tree: Khushboo and Rishabh each hold all four other required
  // items plus a 0-entry `state/workspace/`, and both reported CONFORMING — a
  // workspace whose entire state tree is hollow, graded as fully migrated.
  const root = await makeWorkspace([...V3_REQUIRED]);
  try {
    // Empty the project dir but LEAVE IT THERE. That is the difference from the
    // test above, which removes it entirely.
    await rm(path.join(root, "propagation", "state", "someproject", "STATE.md"), { force: true });

    const r = conformance(root);
    assert.equal(r.conforms, false,
      "a state/ holding only empty project directories is scaffolding, not state");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("N82: EMPTY and MISSING are different words — neither borrows the other's", async () => {
  // The root of N82 is that the census had no vocabulary for absence: three
  // silences rendered identically. Flipping a boolean would fix the symptom and
  // leave the root, so the two facts must be separately reportable.
  const hollow = await makeWorkspace([...V3_REQUIRED]);
  const absent = await makeWorkspace([...V3_REQUIRED]);
  try {
    await rm(path.join(hollow, "propagation", "state", "someproject", "STATE.md"), { force: true });
    await rm(path.join(absent, "propagation", "state"), { recursive: true, force: true });

    const h = conformance(hollow);
    const a = conformance(absent);

    assert.deepEqual(h.empty, ["state/"], "a hollow state/ belongs in `empty`");
    assert.ok(!h.missing.includes("state/"),
      "a hollow state/ must NOT be reported as missing — the directory is there, and saying " +
      "otherwise sends someone to create what already exists");

    assert.ok(a.missing.includes("state/"), "an absent state/ belongs in `missing`");
    assert.deepEqual(a.empty, [], "an absent state/ is not 'empty' — it is not there at all");
  } finally {
    for (const d of [hollow, absent]) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("N82 positive control: one file inside the project dir conforms", async () => {
  // Without this the test above passes by making everything non-conformant.
  const root = await makeWorkspace([...V3_REQUIRED]);
  try {
    const r = conformance(root);
    assert.equal(r.conforms, true, `a populated workspace must still conform: ${JSON.stringify(r)}`);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.empty, []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// A fresh clone of a repo that gitignores its refs registry (propagate #12, 2026-10-19)
// ---------------------------------------------------------------------------

const REFS = ["refs/snapshot.json", "refs/lifecycle.jsonl"];
const withoutRefs = [...V3_REQUIRED].filter((i) => !REFS.includes(i));

test("fresh clone: refs absent AND named in the workspace .gitignore read as regenerated, and the workspace conforms", async () => {
  const root = await makeWorkspace(withoutRefs);
  try {
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n/propagation/refs/snapshot.json\npropagation/refs/lifecycle.jsonl\n");
    const r = conformance(root);
    assert.equal(r.conforms, true, `a fresh clone must not read as half-migrated; missing: ${r.missing.join(", ")}`);
    assert.deepEqual(r.missing, []);
    assert.deepEqual([...r.regenerated].sort(), [...REFS].sort(), "the absence must be attributed, not silent (rule:discernment-checks §2)");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("fresh clone: a directory rule in .gitignore covers both refs files", async () => {
  const root = await makeWorkspace(withoutRefs);
  try {
    await writeFile(path.join(root, ".gitignore"), "propagation/refs/\n");
    assert.deepEqual([...conformance(root).regenerated].sort(), [...REFS].sort());
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("the carve-out cannot swallow a real gap: refs absent and NOT gitignored stay MISSING", async () => {
  // The mutation this guards: treating every absent refs file as regenerated. Built three ways —
  // no .gitignore at all, a .gitignore that names something else, and one that only names a
  // COMMENTED-OUT or NEGATED rule — because each is a different way a loose match goes wrong.
  for (const gitignore of [null, "node_modules/\n", "# propagation/refs/snapshot.json\n!propagation/refs/snapshot.json\n"]) {
    const root = await makeWorkspace(withoutRefs);
    try {
      if (gitignore !== null) await writeFile(path.join(root, ".gitignore"), gitignore);
      const r = conformance(root);
      assert.equal(r.conforms, false, `must not conform with .gitignore=${JSON.stringify(gitignore)}`);
      assert.deepEqual([...r.missing].sort(), [...REFS].sort());
      assert.deepEqual(r.regenerated, []);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

test("fresh clone: only the refs files are carved out — a gitignored README.md is still missing", async () => {
  const root = await makeWorkspace(["INDEX.md", "state/"]);
  try {
    await writeFile(path.join(root, ".gitignore"), "propagation/README.md\npropagation/refs/\n");
    const r = conformance(root);
    assert.deepEqual(r.missing, ["README.md"]);
    assert.equal(r.conforms, false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
