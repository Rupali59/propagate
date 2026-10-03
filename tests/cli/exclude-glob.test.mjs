/**
 * `exclude:` on a glob downstream (O9), and the one expander behind it.
 *
 * The hub's `*\/docs/GOTCHAS.md` glob matches pointer stubs whose real file another
 * declaration already watches. `exclude:` drops them. The load-bearing properties:
 *
 * - an excluded file mints NO edge, and every remaining edge id is byte-identical to a
 *   run without `exclude:` (ids key on the concrete downstream path + why);
 * - all matches excluded leaves ONE UNMATCHED row, never nothing;
 * - `locateEdgeDeclaration` (verify's lookup) shares the expander, so it agrees with
 *   reconcile about what exists;
 * - doctor FAILS on an exemption that cannot fire (literal path, stale entry).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { git, runCli, cleanup } from "../helpers/verify-fixture.mjs";
import { expandDownstream, edgeIdFor } from "../../lib/edges/reconcile.mjs";
import { locateEdgeDeclaration } from "../../cli.mjs";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A repo with src.md and stubs/{a,b,c}.md, sidecar written from `entryYaml`. */
async function makeGlobRepo(entryYaml) {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "excl-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "excl-state-"));
  const ws = path.join(searchRoot, "ws");
  await mkdir(path.join(ws, "stubs"), { recursive: true });
  git(["init", "-q", "-b", "main"], ws);
  git(["config", "user.email", "t@example.com"], ws);
  git(["config", "user.name", "T"], ws);
  await writeFile(path.join(ws, "src.md"), "src v1\n");
  for (const n of ["a", "b", "c"]) await writeFile(path.join(ws, "stubs", `${n}.md`), `${n} v1\n`);
  await writeFile(
    path.join(ws, ".propagates.yml"),
    `workspace: true\nsources:\n  src.md:\n    propagates_to:\n${entryYaml}`,
  );
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "init"], ws);
  return { searchRoot, stateDir, ws, env: { searchRoot, stateDir } };
}

const GLOB = `      - path: "stubs/*.md"\n        why: "stub glob"\n`;
const rowsOf = (env) => JSON.parse(runCli(["reconcile", "--all", "--json"], env).stdout).rows;

test("expandDownstream — subtracts excluded paths and globs, reports excluded and stale entries", async () => {
  const { ws, searchRoot, stateDir } = await makeGlobRepo(GLOB);
  try {
    const r = expandDownstream("stubs/*.md", ws, ["stubs/b.md", "stubs/nope.md"]);
    assert.deepEqual(r.matches.sort(), ["stubs/a.md", "stubs/c.md"]);
    assert.deepEqual(r.excluded, ["stubs/b.md"]);
    assert.deepEqual(r.staleExcludes, ["stubs/nope.md"]);
    const g = expandDownstream("stubs/*.md", ws, ["stubs/[ab].md"]);
    assert.deepEqual(g.matches, ["stubs/c.md"], "an exclude may itself be a glob");
    assert.deepEqual(expandDownstream("stubs/*.md", ws).matches.length, 3, "no exclude = every match");
  } finally {
    await cleanup(searchRoot, stateDir);
  }
});

test("reconcile — an excluded file produces no row and every remaining edge id is unchanged", async () => {
  const plain = await makeGlobRepo(GLOB);
  const excl = await makeGlobRepo(`${GLOB}        exclude:\n          - stubs/b.md\n`);
  try {
    const before = rowsOf(plain.env).filter((r) => r.glob === "stubs/*.md");
    const after = rowsOf(excl.env).filter((r) => r.glob === "stubs/*.md");
    assert.equal(before.length, 3, "control: without exclude the glob yields three rows");
    assert.equal(after.length, 2, "exclude drops exactly one");
    assert.ok(!after.some((r) => r.downstream.path.endsWith("b.md")), "the excluded file has no row");
    // Ids key on node + concrete downstream (repo-relative) + why, so the two fixtures
    // (different tmp roots, same repo basename) must agree on the survivors.
    const idFor = (rows, n) => rows.find((r) => r.downstream.path.endsWith(`${n}.md`)).edge_id;
    assert.equal(idFor(after, "a"), idFor(before, "a"));
    assert.equal(idFor(after, "c"), idFor(before, "c"));
  } finally {
    await cleanup(plain.searchRoot, plain.stateDir, excl.searchRoot, excl.stateDir);
  }
});

test("reconcile — every match excluded leaves exactly one UNMATCHED row", async () => {
  const f = await makeGlobRepo(`${GLOB}        exclude:\n          - "stubs/*.md"\n`);
  try {
    const rows = rowsOf(f.env).filter((r) => r.glob === "stubs/*.md");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "UNMATCHED");
    assert.equal(rows[0].unresolvable, "unmatched-glob");
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("locateEdgeDeclaration shares the expander — every reconcile row is locatable, the excluded path is not", async () => {
  const f = await makeGlobRepo(`${GLOB}        exclude:\n          - stubs/b.md\n`);
  try {
    const rows = rowsOf(f.env).filter((r) => r.glob === "stubs/*.md");
    const workspaces = [{ root: f.ws }];
    for (const row of rows) {
      const loc = await locateEdgeDeclaration(workspaces, row);
      assert.ok(loc, `row ${row.downstream.path} must be locatable`);
      assert.equal(loc.declaredPath, "stubs/*.md");
    }
    // Forge the row an excluded file WOULD have had: same node, same why, b.md's path.
    const any = rows[0];
    const bAbs = path.join(f.ws, "stubs", "b.md");
    const ghost = { ...any, edge_id: edgeIdFor(any.node_id, bAbs, "stub glob") };
    assert.equal(await locateEdgeDeclaration(workspaces, ghost), null, "an excluded file must not be locatable");
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

// ── doctor ────────────────────────────────────────────────────────────────

async function doctorOut(entryYaml) {
  const root = await mkdtemp(path.join(tmpdir(), "excl-doctor-"));
  const w = path.join(root, "ws");
  await mkdir(path.join(w, "stubs"), { recursive: true });
  await writeFile(path.join(w, "src.md"), "# src\n");
  await writeFile(path.join(w, "lit.md"), "# lit\n");
  for (const n of ["a", "b"]) await writeFile(path.join(w, "stubs", `${n}.md`), `${n}\n`);
  await writeFile(path.join(w, ".propagates.yml"), `workspace: true\nsources:\n  src.md:\n    propagates_to:\n${entryYaml}`);
  const r = spawnSync(process.execPath, [CLI, "doctor"], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: path.join(root, ".state") },
  });
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return strip(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

test("doctor FAILS on `exclude:` with a literal path", async () => {
  const out = await doctorOut(`      - path: lit.md\n        why: "literal pairing"\n        exclude:\n          - stubs/a.md\n`);
  assert.match(out, /✗[^\n]*src\.md → lit\.md[^\n]*exclude:` on a literal path/, out);
});

test("doctor FAILS on a stale `exclude:` entry and names it", async () => {
  const out = await doctorOut(`      - path: "stubs/*.md"\n        why: "stub glob"\n        exclude:\n          - stubs/gone.md\n`);
  assert.match(out, /✗[^\n]*stale `exclude:` entry "stubs\/gone\.md"/, out);
});

test("doctor passes a live `exclude:` entry (negative control)", async () => {
  const out = await doctorOut(`      - path: "stubs/*.md"\n        why: "stub glob"\n        exclude:\n          - stubs/a.md\n`);
  assert.doesNotMatch(out, /stale `exclude:`|on a literal path/, out);
  assert.match(out, /\.propagates\.yml/, "control: doctor did read the sidecar");
});
