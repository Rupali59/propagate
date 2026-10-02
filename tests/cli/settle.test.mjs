/**
 * `propagate settle <file>` — a READ-ONLY worklist.
 *
 * The property that matters most is the one the module's header claims and no
 * comment can prove: settle never writes. Every test here that runs it
 * snapshots every byte of the event store first (`storeSnapshot`), because a
 * command that "would" write and one that does are indistinguishable from its
 * output (`rule:safety-flag-needs-a-test`, the corollary: never trust the tool's
 * own description of itself).
 *
 * Fixture: A -> B -> C (makeChain). makeChain edits A, so A->B is DRIFTED and
 * B->C is CLEAN -- and a CLEAN edge is not work, so it is not listed. Where a
 * test needs an edge both INTO and OUT of one file, `bothEdited` also edits B:
 * A->B becomes DIVERGED and B->C DRIFTED, blocked by A->B.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeChain, runCli, storeSnapshot, cleanup, git } from "../helpers/verify-fixture.mjs";
import { settleWorklist } from "../../commands/settle.mjs";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

/** Edit B too: A->B DIVERGED (into B.md), B->C DRIFTED and blocked by it (out of B.md). */
async function bothEdited(f) {
  await writeFile(path.join(f.ws, "B.md"), "B v2\n");
  const rows = JSON.parse(runCli(["reconcile", "--all", "--json"], f.env).stdout).rows;
  return {
    ab: rows.find((r) => r.source.path.endsWith("A.md")),
    bc: rows.find((r) => r.source.path.endsWith("B.md")),
  };
}

function settleJson(env, file) {
  const r = runCli(["settle", file, "--json"], env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout);
}

test("settle is READ-ONLY: the event store is byte-identical after the text form and after --json", async () => {
  const f = await makeChain();
  try {
    const before = storeSnapshot(f.stateDir);
    assert.ok(before.length > 0, "the fixture baselined two edges, so there IS a store to compare");
    const text = runCli(["settle", "B.md"], f.env);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(storeSnapshot(f.stateDir), before, "text settle changed the store");
    const json = runCli(["settle", "B.md", "--json"], f.env);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(storeSnapshot(f.stateDir), before, "settle --json changed the store");
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("settle B.md lists the edge INTO the file and the edge OUT of it, in fix order, blocked one with a route", async () => {
  const f = await makeChain();
  try {
    const { ab, bc } = await bothEdited(f);
    assert.equal(ab.state, "DIVERGED");
    assert.equal(bc.state, "DRIFTED");
    const w = settleJson(f.env, "B.md");
    assert.equal(w.read_only, true);
    assert.ok(w.walk_started, "--json prints walk_started");

    const into = w.items.find((i) => i.edge_id === ab.edge_id);
    const out = w.items.find((i) => i.edge_id === bc.edge_id);
    assert.ok(into && out, "both directions are listed");
    assert.equal(into.direction, "into");
    assert.equal(out.direction, "out of");
    // Roots first: A->B is upstream of B->C.
    assert.ok(w.items.indexOf(into) < w.items.indexOf(out), "fix order is root to leaf");

    assert.equal(into.blocked, false);
    assert.deepEqual(into.allowed, ["both-reconciled"], "DIVERGED accepts only both-reconciled");
    assert.equal(out.blocked, true);
    assert.equal(out.blockedBy[0].edge_id, ab.edge_id);
    assert.match(out.blockedBy[0].route, /^propagate settle '/, "a route to the upstream, never a dead 'walk upstream'");
    // Blocked: only the exempt set is runnable as-is; the rest are the --out-of-order route.
    assert.deepEqual([...out.allowed].sort(), ["decoupled", "deferred"]);
    assert.ok(out.viaOutOfOrder.includes("propagated"));
    for (const cmd of Object.values(out.outOfOrderCommands)) assert.match(cmd, / --out-of-order/);
    for (const cmd of Object.values(out.commands)) assert.doesNotMatch(cmd, /--out-of-order/);
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("every printed command selects with --edge (never --glob), and parses when run through a shell with a hostile reason", async () => {
  const f = await makeChain();
  try {
    await bothEdited(f);
    const w = settleJson(f.env, "B.md");
    const all = w.items.flatMap((i) => [...Object.values(i.commands), ...Object.values(i.outOfOrderCommands)]);
    assert.ok(all.length >= 6, `only ${all.length} commands emitted — the loop below has gone blind`);
    const reason = `it's a "quoted" reason with $HOME and \`backticks\``;
    for (const cmd of all) {
      assert.match(cmd, /--edge [0-9a-f]{8}/);
      assert.doesNotMatch(cmd, /--glob/);
      const line = cmd
        .replace(`'${w.reason_placeholder}'`, `'${reason.replace(/'/g, `'\\''`)}'`)
        .replace(/^propagate /, `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} `)
        .replace(/ --apply$/, ""); // dry-run: this test must not write
      const r = spawnSync("sh", ["-c", line], {
        encoding: "utf8",
        env: { ...process.env, PROPAGATE_SEARCH_ROOTS: f.env.searchRoot, PROPAGATE_STATE_DIR: f.env.stateDir },
      });
      assert.equal(r.status, 0, `did not parse/run: ${cmd}\n${r.stderr}${r.stdout}`);
      // `decoupled` previews a sidecar edit rather than an event.
      assert.match(r.stdout, /would write 1 event|would decouple/);
    }
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("an UNCOMMITTED source edit shows in the diff, and the downstream is diffed too", async () => {
  const f = await makeChain();
  try {
    // makeChain edited A.md and did not commit it; B.md is untouched.
    const w = settleJson(f.env, "A.md");
    const ab = w.items.find((i) => i.edge_id === f.edgeAB.edge_id);
    assert.ok(ab, "A->B is out of A.md");
    assert.deepEqual(Object.keys(ab.diff).sort(), ["downstream", "source"], "two parallel sides, never one nested in the other");
    assert.equal(ab.diff.source.ok, true, JSON.stringify(ab.diff));
    assert.notEqual(ab.diff.source.empty, true, "the old ..HEAD diff reported empty for exactly this case");
    assert.match(ab.diff.source.text, /\+A v2/);
    assert.ok(ab.diff.downstream, "the downstream side is present");
    assert.equal(ab.diff.downstream.empty, true, "B is unchanged, and that is a real result, not a missing one");
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("a file whose edges are all settled says there is nothing to settle (not an empty screen)", async () => {
  const f = await makeChain();
  try {
    const text = runCli(["settle", "C.md"], f.env);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /nothing to settle/);
    assert.match(text.stdout, /1 edge\(s\) touch this file: 1 CLEAN/);
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("a file with no match, and a call with no file, are named refusals", async () => {
  const f = await makeChain();
  try {
    const none = runCli(["settle", "nope-not-here.md"], f.env);
    assert.equal(none.status, 1);
    assert.match(none.stdout, /no file matched/);
    const bare = runCli(["settle"], f.env);
    assert.equal(bare.status, 2);
    assert.match(bare.stdout, /usage: propagate settle <file>/);
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("a file whose edges are ALL NEVER_VERIFIED says so, rather than printing nothing", async () => {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "settle-nv-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "settle-nv-state-"));
  try {
    const ws = path.join(searchRoot, "ws");
    await mkdir(ws, { recursive: true });
    git(["init", "-q", "-b", "main"], ws);
    git(["config", "user.email", "t@example.com"], ws);
    git(["config", "user.name", "T"], ws);
    await writeFile(path.join(ws, "X.md"), "x\n");
    await writeFile(path.join(ws, "Y.md"), "y\n");
    await writeFile(
      path.join(ws, ".propagates.yml"),
      ["workspace: true", "sources:", "  X.md:", "    propagates_to:", "      - path: Y.md", "        why: X feeds Y", "        kind: prose", ""].join("\n"),
    );
    git(["add", "."], ws);
    git(["commit", "-q", "-m", "init"], ws);
    const env = { searchRoot, stateDir };
    const text = runCli(["settle", "Y.md"], env);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /every edge on this file is NEVER_VERIFIED/);
    assert.match(text.stdout, /\[1\/1\] NEVER_VERIFIED/);
    const w = settleJson(env, "Y.md");
    assert.equal(w.allNeverVerified, true);
    assert.equal(w.items[0].diff.source.ok, false, "no history means no diff, and it says why");
    assert.match(w.items[0].diff.source.reason, /never judged/);
    // The downstream says the same, not "events before 2026-08-22 did not record one" --
    // which asserts an old event exists for an edge that has none.
    assert.match(w.items[0].diff.downstream.reason, /never judged/);
  } finally {
    await cleanup(searchRoot, stateDir);
  }
});

// ── the worklist, over synthetic rows: cross-repo edges, NEVER_VERIFIED blockers ──

function synthRow(id, state, from, to) {
  return {
    edge_id: id, node_id: `n:${id}`, state, why: "w", kind: "prose", glob: null, sameRepo: false,
    source: { path: from }, downstream: { path: to },
  };
}

test("settleWorklist: a cross-repo edge is included, and a NEVER_VERIFIED blocker is shown with a route", async () => {
  // repoA/up.md -> repoA/mid.md (NEVER_VERIFIED), repoA/mid.md -> repoB/leaf.md (DRIFTED, cross-repo)
  const rows = [
    synthRow("aaaa0001", "NEVER_VERIFIED", "/w/repoA/up.md", "/w/repoA/mid.md"),
    synthRow("bbbb0002", "DRIFTED", "/w/repoA/mid.md", "/w/repoB/leaf.md"),
  ];
  const deps = {
    loadWorkspaces: async () => [{ root: "/w/repoA" }, { root: "/w/repoB" }],
    reconcile: async () => ({ rows }),
    history: async () => Object.assign(new Map(), { malformed: 0 }),
    diff: async () => ({ ok: false, kind: "diff", reason: "stub" }),
  };
  const w = await settleWorklist("/w/repoB/leaf.md", deps);
  assert.equal(w.ok, true);
  const item = w.items.find((i) => i.edge_id === "bbbb0002");
  assert.ok(item, "the cross-repo edge INTO leaf.md is listed");
  assert.equal(item.blocked, true);
  assert.equal(item.blockedBy[0].edge_id, "aaaa0001");
  assert.equal(item.blockedBy[0].state, "NEVER_VERIFIED", "a never-verified blocker is shown, not skipped");
  assert.equal(item.blockedBy[0].otherWorkspace, false, "up.md and mid.md share repoA");
  assert.equal(item.blockedBy[0].route, "propagate settle '/w/repoA/mid.md'");
  assert.deepEqual([...item.allowed].sort(), ["decoupled", "deferred"]);
});

test("settleWorklist: an ambiguous selector lists the candidates instead of picking one", async () => {
  const rows = [
    synthRow("cccc0001", "DRIFTED", "/w/a/CLAUDE.md", "/w/a/x.md"),
    synthRow("cccc0002", "DRIFTED", "/w/b/CLAUDE.md", "/w/b/y.md"),
  ];
  const deps = {
    loadWorkspaces: async () => [{ root: "/w/a" }, { root: "/w/b" }],
    reconcile: async () => ({ rows }),
    history: async () => Object.assign(new Map(), { malformed: 0 }),
    diff: async () => ({ ok: false, kind: "diff", reason: "stub" }),
  };
  // cwd pinned to a directory owning neither, so the cwd-first rule cannot pick one.
  const w = await settleWorklist("CLAUDE.md", { ...deps, cwd: "/elsewhere" });
  assert.equal(w.ok, false);
  assert.equal(w.code, 2);
  assert.equal(w.candidates.length, 2);
});

// The cwd-first rule. Built from literal rows, not makeChain: the defect only shows
// when a SAME-NAMED declared file exists elsewhere in the tree, which the chain
// fixture cannot express (rule:mutate-behind-the-fixture-builder). Both cases are
// the real ones measured 2026-10-02 on the v0.15.16 release.
function cwdDeps(rows, roots) {
  return {
    loadWorkspaces: async () => roots.map((root) => ({ root })),
    reconcile: async () => ({ rows }),
    history: async () => Object.assign(new Map(), { malformed: 0 }),
    diff: async () => ({ ok: false, kind: "diff", reason: "stub" }),
  };
}

test("settleWorklist: a relative path resolving under the cwd wins over a same-named file elsewhere (the STATE.md case)", async () => {
  // Hub /w/hub owns propagation/state/workspace/STATE.md; the nested repo /w/hub/propagate
  // owns its own copy at the same relative path. From inside propagate, the path means
  // propagate's file -- the first version listed the hub's.
  const rows = [
    synthRow("dddd0001", "DRIFTED", "/w/hub/propagation/state/workspace/TODOS.md", "/w/hub/propagation/state/workspace/STATE.md"),
    synthRow("dddd0002", "DIVERGED", "/w/hub/propagate/propagation/state/workspace/TODOS.md", "/w/hub/propagate/propagation/state/workspace/STATE.md"),
  ];
  const w = await settleWorklist("propagation/state/workspace/STATE.md",
    { ...cwdDeps(rows, ["/w/hub", "/w/hub/propagate"]), cwd: "/w/hub/propagate" });
  assert.equal(w.ok, true, w.error);
  assert.equal(w.file, "/w/hub/propagate/propagation/state/workspace/STATE.md");
  assert.deepEqual(w.items.map((i) => i.edge_id), ["dddd0002"], "only the cwd file's edge is listed");
});

test("settleWorklist: a relative path matching two files by suffix is resolved by the cwd, not refused (the DATA_MODEL.md case)", async () => {
  const rows = [
    synthRow("eeee0001", "DRIFTED", "/w/form-collector/src/a.mjs", "/w/form-collector/docs/DATA_MODEL.md"),
    synthRow("eeee0002", "DRIFTED", "/w/propagate/lib/b.mjs", "/w/propagate/docs/DATA_MODEL.md"),
  ];
  const deps = cwdDeps(rows, ["/w/form-collector", "/w/propagate"]);
  const w = await settleWorklist("docs/DATA_MODEL.md", { ...deps, cwd: "/w/propagate" });
  assert.equal(w.ok, true, w.error);
  assert.equal(w.file, "/w/propagate/docs/DATA_MODEL.md");
  // ...and from a cwd owning neither, the same selector is still an ambiguity, never a guess.
  const elsewhere = await settleWorklist("docs/DATA_MODEL.md", { ...deps, cwd: "/w/other" });
  assert.equal(elsewhere.ok, false);
  assert.equal(elsewhere.code, 2);
});
