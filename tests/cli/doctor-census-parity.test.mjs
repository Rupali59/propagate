/**
 * doctor-census-parity.test.mjs — N87 slice 1.
 *
 * WHY THIS TEST EXISTS. `doctor` and `rollup` answer the same question — which
 * workspaces conform to the v3 layout — and did it from two different
 * populations, with nothing comparing them. Measured 2026-09-23: `WORKSPACES`
 * (`lib/core/config.mjs`, marker-based) contained neither `propagate` nor
 * `Motion-Graphics`, which are exactly the two directories `rollup` reports
 * NON-CONFORMANT in `ECOSYSTEM.md`.
 *
 * The mechanism is circular, which is why it survived: a marker is something a
 * workspace only carries once it has ADOPTED the layout, so the check for "did
 * you adopt the layout" was gated on having adopted it.
 *
 * WHY THESE TESTS USE FIXTURES AND NOT THE LIVE TREE. The first draft guarded
 * every case with `if (!isThisMachine()) return`, reading SEARCH_ROOTS to
 * decide. Under `npm test` the state dir is scoped to a tmpdir, `SEARCH_ROOTS`
 * is `[]`, and all five tests early-returned — passing in 0.05ms while
 * asserting nothing. A skip that renders as a pass is the precise failure this
 * repo keeps paying for (`rule:discernment-checks` §1 and §2), so the semantics
 * are pinned with fixtures that run everywhere, and the one live-tree case
 * skips LOUDLY via `t.skip`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ownerCandidates } from "../../lib/core/discovery.mjs";

/** A root holding: two git repos, one plain dir, one dotted git dir, one file. */
async function fixtureRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "census-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  for (const name of ["alpha", "beta"]) {
    await mkdir(path.join(root, name, ".git"), { recursive: true });
  }
  await mkdir(path.join(root, "plain-dir"), { recursive: true });
  await mkdir(path.join(root, ".hidden", ".git"), { recursive: true });
  await writeFile(path.join(root, "loose-file.md"), "not a directory\n");
  return root;
}

const names = (owners) => owners.map((o) => path.basename(String(o.root))).sort();

test("a directory is an owner when it is version-controlled, not when it carries a marker", async (t) => {
  const root = await fixtureRoot(t);
  const got = names(ownerCandidates([root], []));
  assert.ok(got.includes("alpha") && got.includes("beta"), `git dirs must be owners; got ${got.join(",")}`);
  assert.ok(!got.includes("plain-dir"), "a directory with no .git is not an attributable thing");
  assert.ok(!got.includes("loose-file.md"), "a file is never an owner");
});

test("dotted directories are skipped even when version-controlled", async (t) => {
  const root = await fixtureRoot(t);
  const got = names(ownerCandidates([root], []));
  assert.ok(!got.includes(".hidden"), "dot-directories are infrastructure, not workspaces");
});

test("the census is a SUPERSET of the marker-based set — widening never drops a workspace", async (t) => {
  const root = await fixtureRoot(t);
  const marker = { root: path.join(root, "plain-dir"), name: "plain-dir" };
  const got = names(ownerCandidates([root], [marker]));
  assert.ok(
    got.includes("plain-dir"),
    "a marker-declared workspace survives even though it would not qualify on the git predicate alone",
  );
});

test("propagate includes ITSELF when the search root contains it", async (t) => {
  // rule:enforcement-watches-itself, in mechanical form: scanning the tree
  // propagate lives in must never omit propagate.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, "../..");
  const hub = path.dirname(repoRoot);
  const got = names(ownerCandidates([hub], []));
  assert.ok(got.includes("propagate"), `scanning the hub must include propagate; got ${got.length} owners`);
});

test("propagate does NOT inject itself into a population that is looking elsewhere", async (t) => {
  // The other half, and the reason self-inclusion is containment-based rather
  // than unconditional. Measured 2026-09-23: unconditional inclusion turned 5
  // hermetic doctor tests red, because a fixture workspace built in a tmpdir
  // suddenly had this repo — non-conformant — inside its population.
  const root = await fixtureRoot(t);
  const got = names(ownerCandidates([root], []));
  assert.ok(
    !got.includes("propagate"),
    `a fixture root must stay hermetic; got ${got.join(",")}`,
  );
});

test("an unreadable root is skipped without throwing — one bad root never kills the census", async (t) => {
  const root = await fixtureRoot(t);
  const got = names(ownerCandidates([root, path.join(root, "does-not-exist")], []));
  assert.ok(got.includes("alpha"), "the readable root still contributes");
});

test("LIVE TREE: doctor's conformance accounts for propagate itself", async (t) => {
  const { SEARCH_ROOTS, WORKSPACES } = await import("../../lib/core/config.mjs");
  if (SEARCH_ROOTS.length === 0) {
    // LOUD, not a silent return: under `npm test` the state dir is scoped and
    // SEARCH_ROOTS is empty, which is a legitimate "cannot look" — but it must
    // never read as "looked and it was fine".
    t.skip("no SEARCH_ROOTS configured in this environment — the live tree was not examined");
    return;
  }
  const { conformanceReport } = await import("../../lib/core/v3-layout.mjs");
  const rep = conformanceReport(ownerCandidates(SEARCH_ROOTS, WORKSPACES));
  const offenders = rep.offenders.map((o) => String(o.name));
  assert.ok(
    offenders.includes("propagate"),
    `propagate holds state/ and lacks the other four, so it must be a half-migrated offender; offenders=${offenders.join(",")} notStarted=${rep.notStarted.map((o) => o.name).join(",")}`,
  );
});

test("an EMPTY census is inconclusive, never a pass — the N82/G68 case", async (t) => {
  // This runs in the ordinary scoped test environment, where SEARCH_ROOTS is []
  // and the census is therefore empty. That is not a contrived fixture: it is
  // the exact condition under which doctor printed `✓ 0/0 conform`, because
  // `offenders.length === 0` is vacuously true over an empty set.
  const { SEARCH_ROOTS } = await import("../../lib/core/config.mjs");
  if (SEARCH_ROOTS.length > 0) {
    t.skip("this environment has search roots, so the empty-census path is not exercised here");
    return;
  }
  const { Reporter } = await import("../../lib/report/doctor/reporter.mjs");
  const { checkDiscovery } = await import("../../lib/report/doctor/discovery.mjs");
  const r = new Reporter();
  await checkDiscovery({ reporter: r });

  const e = r.entries.find((x) => x.label === "workspaces conform to the v3 propagation layout");
  assert.ok(e, "the conformance check must emit an entry");
  assert.notEqual(e.kind, "pass", `an empty census must not pass; detail was ${JSON.stringify(e.detail)}`);
  assert.equal(e.kind, "inconclusive", `expected inconclusive, got ${e.kind}`);
  assert.match(e.detail, /\b0\b|empt|no workspace/i, "the reason must say WHY it could not look");
});

test("LIVE TREE: never-begun workspaces FAIL the gate when others have adopted (PR-001)", async (t) => {
  // Rupali's decision, 2026-09-24: a workspace that never began the migration
  // should fail the gate, not sit in an `info` line.
  //
  // THE CARVE-OUT, and why it is not a hedge. `tests/cli/doctor.test.mjs`'s
  // negative control records that requiring the full v3 tree UNCONDITIONALLY
  // "makes every fresh install fail by definition until the migration
  // completes", and `tests/cli/stranger-install.test.mjs` asserts a stranger
  // reaches doctor-clean. So the distinction is adoption ASYMMETRY: if some
  // workspaces conform and others never began, that is a gap someone chose not
  // to close and it fails. If NOTHING has begun anywhere, nothing was promised.
  const { SEARCH_ROOTS, WORKSPACES } = await import("../../lib/core/config.mjs");
  if (SEARCH_ROOTS.length === 0) {
    t.skip("no SEARCH_ROOTS in this environment — the live tree was not examined");
    return;
  }
  const { conformanceReport } = await import("../../lib/core/v3-layout.mjs");
  const rep = conformanceReport(ownerCandidates(SEARCH_ROOTS, WORKSPACES));
  if (rep.notStarted.length === 0 || rep.notStarted.length === rep.total) {
    t.skip(`this tree is not asymmetric (notStarted=${rep.notStarted.length} total=${rep.total})`);
    return;
  }

  const { Reporter } = await import("../../lib/report/doctor/reporter.mjs");
  const { checkDiscovery } = await import("../../lib/report/doctor/discovery.mjs");
  const r = new Reporter();
  await checkDiscovery({ reporter: r });

  const e = r.entries.find((x) => /migration begun/i.test(x.label));
  assert.ok(e, `a never-begun verdict must be emitted; labels seen: ${r.entries.map((x) => x.label).join(" | ").slice(0, 300)}`);
  assert.equal(e.kind, "fail", `never-begun must fail when adoption is asymmetric; got ${e.kind}`);
  assert.match(e.detail, /not begun/i, "the detail must name the condition");
});
