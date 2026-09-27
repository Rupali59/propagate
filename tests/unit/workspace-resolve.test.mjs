/**
 * workspace-resolve.test.mjs — turning a workspace ARGUMENT into a root.
 *
 * ISSUES N55's blocking defect. `migrate-refs <workspace>` passed its argument
 * straight to `refsDir(workspaceRoot)`, which does
 * `path.join(workspaceRoot, "propagation", "refs")`. So a bare NAME — the form
 * its own usage string documents, and the form `doctor` tells people to type —
 * resolved relative to the working directory, found nothing, and reported
 * success:
 *
 *   migrate-refs "Vipin Kaushik"    -> previous: absent, 0 projects, 0 refs, exit 0
 *   migrate-refs "/Users/…/Vipin Kaushik" -> previous: v2, 9 projects, 38 refs
 *
 * `commands/manifest.mjs` had already solved this correctly. Rather than a
 * second copy, the resolution moved here and BOTH commands use it — the same
 * "two forks of one traversal" this repo has paid for before.
 *
 * The refusal matters as much as the match: "no workspace named X" and
 * "discovery found no workspaces at all" are different facts, and a caller
 * seeing an empty result cannot tell them apart (`rule:discernment-checks` §2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveWorkspace } from "../../lib/core/discovery.mjs";

const WS = [
  { name: "Vipin Kaushik", root: "/hub/Vipin Kaushik" },
  { name: "Tathya", root: "/hub/Tathya" },
];

test("a bare NAME resolves — the form the usage string documents", () => {
  const r = resolveWorkspace("Vipin Kaushik", WS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.workspace.root, "/hub/Vipin Kaushik");
});

test("an absolute ROOT still resolves — the form that accidentally worked", () => {
  const r = resolveWorkspace("/hub/Tathya", WS);
  assert.equal(r.ok, true);
  assert.equal(r.workspace.name, "Tathya");
});

test("an unknown name is REFUSED, and the refusal names what was found", () => {
  // The whole defect: this used to return a path and 0 projects at exit 0.
  const r = resolveWorkspace("NoSuchThing", WS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /NoSuchThing/);
  assert.match(r.reason, /Vipin Kaushik/, "the refusal must list the known workspaces");
});

test("NO workspaces at all reads differently from an unknown name", () => {
  // Two absences that must not render alike: a typo, versus discovery that
  // found nothing to look at.
  const typo = resolveWorkspace("NoSuchThing", WS);
  const empty = resolveWorkspace("NoSuchThing", []);
  assert.equal(empty.ok, false);
  assert.notEqual(empty.reason, typo.reason,
    "'no workspace named X' and 'discovery found none' must be distinguishable");
  assert.match(empty.reason, /discovery found no workspaces/i);
});

test("an empty or missing argument is refused, not defaulted", () => {
  for (const bad of ["", null, undefined, "   "]) {
    const r = resolveWorkspace(bad, WS);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} should be refused`);
  }
});

test("an explicit path that EXISTS is taken at face value, even if undiscovered", async () => {
  // Every test fixture and one-off tree is addressed this way. Caught by
  // breaking two tests in refs-migrate.test.mjs, which pass a temp root that
  // discovery has never seen — a regression my first version introduced.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;

  const dir = await mkdtemp(path.join(tmpdir(), "ws-resolve-"));
  try {
    const r = resolveWorkspace(dir, WS);   // WS does not contain it
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.workspace.root, dir);
    assert.equal(r.workspace.name, path.basename(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a path-shaped argument that does NOT exist is still refused", () => {
  // The negative control. Without it the branch above would accept anything
  // containing a slash, which is how a typo'd path becomes a stray directory.
  const r = resolveWorkspace("/definitely/not/here/xyz", WS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no workspace named/);
});

/* ── the two commands that take a <workspace> argument ──────────────────── */

test("BOTH migrate and migrate-refs resolve their argument through this function", async () => {
  // N55 fixed `migrate-refs`; `migrate` had the identical defect and was found
  // 2026-09-27 trying to finish a half-migrated workspace WITH it. A bare name
  // resolved against the CWD, so from the propagate repo it planned against
  // `propagate/<name>/propagation` and reported 0 moves — which is why that
  // workspace was still half-migrated.
  //
  // Source-level, because both resolutions live in cli.mjs's command wrappers
  // and the alternative is a subprocess per case. The BEHAVIOUR is covered by
  // tests/unit/refs-migrate.test.mjs's stray-tree case.
  const { readFileSync } = await import("node:fs");
  const path = (await import("node:path")).default;
  const cli = readFileSync(path.join(import.meta.dirname, "../../cli.mjs"), "utf8");

  for (const fn of ["migrateRefsCmd", "migrateCmd"]) {
    const i = cli.indexOf(`async function ${fn}(`);
    assert.ok(i > 0, `${fn} not found — this check has gone blind`);
    // The next function boundary, so each body is read in isolation.
    const next = cli.indexOf("\nasync function ", i + 10);
    const body = cli.slice(i, next > 0 ? next : i + 4000);
    assert.match(body, /resolveWorkspace\(/,
      `${fn} does not resolve its <workspace> argument — a bare name will hit the CWD`);
  }
});
