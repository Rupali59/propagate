/**
 * Tests for lib/reconcile.mjs — the v2 derivation (plan §3/§9's verification list).
 *
 * Strategy: real temp git repos (execFileSync, never mocked — same discipline
 * as tests/content-id.test.mjs / tests/refs.test.mjs). The event store is
 * scoped per test via PROPAGATE_STATE_DIR through a subprocess, same pattern
 * as tests/events.test.mjs and tests/init-reload.test.mjs — EVENTS_DIR /
 * STATE_DIR are module-level consts resolved at import time, so exercising a
 * fresh store per test requires a fresh process, not an in-process re-import.
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RECONCILE_LIB = fileURLToPath(new URL("../../lib/edges/reconcile.mjs", import.meta.url));
const EVENTS_LIB = fileURLToPath(new URL("../../lib/edges/events.mjs", import.meta.url));
const CONTENT_ID_LIB = fileURLToPath(new URL("../../lib/edges/content-id.mjs", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeRepo(prefix = "reconcile-test-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

async function commitAll(dir, msg = "snapshot") {
  git(["add", "."], dir);
  git(["commit", "-q", "-m", msg], dir);
}

async function scopedStateDir() {
  return mkdtemp(path.join(tmpdir(), "reconcile-store-"));
}

function runScript(script, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, `subprocess failed: ${result.stderr}\n${result.stdout}`);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

/** Append a pinning event for (sourceAbs, downstreamAbs, why), pinned to CURRENT content. */
function pin({ stateDir, sourceAbs, downstreamAbs, why, disposition = "propagated", reason = "test pin" }) {
  const script = `
import { contentId } from ${JSON.stringify(CONTENT_ID_LIB)};
import { edgeId, appendEvent } from ${JSON.stringify(EVENTS_LIB)};
import { toNodeId } from ${JSON.stringify(RECONCILE_LIB)};

const sourceAbs = ${JSON.stringify(sourceAbs)};
const downstreamAbs = ${JSON.stringify(downstreamAbs)};
const nodeId = toNodeId(sourceAbs);
const eId = edgeId(nodeId, downstreamAbs, ${JSON.stringify(why)});
const s = contentId(sourceAbs);
const d = contentId(downstreamAbs);
if (s.unresolvable || d.unresolvable) {
  throw new Error("pin: side unresolvable — " + JSON.stringify({ s, d }));
}
const event = await appendEvent({
  edge_id: eId,
  node_id: nodeId,
  source_content: s.id,
  downstream_content: d.id,
  source_git_blob: s.gitBlob,
  disposition: ${JSON.stringify(disposition)},
  reason: ${JSON.stringify(reason)},
  by: "test",
  observed_on_ref: "main",
});
console.log(JSON.stringify({ edge_id: eId, ts: event.ts, node_id: nodeId }));
`;
  return runScript(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
}

/** Append a "deferred" event — never pins, per lib/events.mjs's validateEvent. */
function defer({ stateDir, sourceAbs, downstreamAbs, why, reason = "postponed" }) {
  const script = `
import { edgeId, appendEvent } from ${JSON.stringify(EVENTS_LIB)};
import { toNodeId } from ${JSON.stringify(RECONCILE_LIB)};
const nodeId = toNodeId(${JSON.stringify(sourceAbs)});
const eId = edgeId(nodeId, ${JSON.stringify(downstreamAbs)}, ${JSON.stringify(why)});
const event = await appendEvent({
  edge_id: eId,
  node_id: nodeId,
  disposition: "deferred",
  reason: ${JSON.stringify(reason)},
  by: "test",
});
console.log(JSON.stringify({ edge_id: eId, ts: event.ts }));
`;
  return runScript(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
}

function runReconcile({ stateDir, workspaceRoots, refs }) {
  const script = `
import { reconcile } from ${JSON.stringify(RECONCILE_LIB)};
const workspaces = ${JSON.stringify(workspaceRoots)}.map((root) => ({ root }));
const result = await reconcile(workspaces, { refs: ${JSON.stringify(refs || {})} });
console.log(JSON.stringify(result));
`;
  return runScript(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
}

function rowFor(result, sourceAbs) {
  return result.rows.find((r) => r.source.path === sourceAbs);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Each of the six table states, on one controlled fixture.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile — each of the six derived states on a controlled fixture", async () => {
  const repo = await makeRepo();
  const stateDir = await scopedStateDir();
  try {
    const files = {
      a: "a.txt", b: "b.txt", // never verified
      c: "c.txt", // d.txt deliberately never created — not present on ref
      e: "e.txt", f: "f.txt", // clean
      g: "g.txt", h: "h.txt", // drifted (source moves)
      i: "i.txt", j: "j.txt", // reversed (downstream moves)
      k: "k.txt", l: "l.txt", // diverged (both move)
    };
    for (const [key, name] of Object.entries(files)) {
      await writeFile(path.join(repo, name), `${key} v1\n`);
    }
    await writeFile(
      path.join(repo, ".propagates.yml"),
      `sources:
  a.txt:
    propagates_to:
      - path: b.txt
        why: "never verified pairing"
  c.txt:
    propagates_to:
      - path: d.txt
        why: "downstream absent pairing"
  e.txt:
    propagates_to:
      - path: f.txt
        why: "clean pairing"
  g.txt:
    propagates_to:
      - path: h.txt
        why: "drifted pairing"
  i.txt:
    propagates_to:
      - path: j.txt
        why: "reversed pairing"
  k.txt:
    propagates_to:
      - path: l.txt
        why: "diverged pairing"
`,
    );
    await commitAll(repo, "initial fixture");

    const abs = (name) => path.join(repo, name);
    for (const [srcName, dstName, why] of [
      ["e.txt", "f.txt", "clean pairing"],
      ["g.txt", "h.txt", "drifted pairing"],
      ["i.txt", "j.txt", "reversed pairing"],
      ["k.txt", "l.txt", "diverged pairing"],
    ]) {
      pin({ stateDir, sourceAbs: abs(srcName), downstreamAbs: abs(dstName), why });
    }

    // Move source only -> DRIFTED
    await writeFile(abs("g.txt"), "g v2\n");
    // Move downstream only -> REVERSED
    await writeFile(abs("j.txt"), "j v2\n");
    // Move both -> DIVERGED
    await writeFile(abs("k.txt"), "k v2\n");
    await writeFile(abs("l.txt"), "l v2\n");

    const result = runReconcile({ stateDir, workspaceRoots: [repo] });

    assert.equal(rowFor(result, abs("a.txt")).state, "NEVER_VERIFIED");
    assert.equal(rowFor(result, abs("c.txt")).state, "NOT_PRESENT_ON_REF");
    assert.equal(rowFor(result, abs("e.txt")).state, "CLEAN");
    assert.equal(rowFor(result, abs("g.txt")).state, "DRIFTED");
    assert.equal(rowFor(result, abs("i.txt")).state, "REVERSED");
    assert.equal(rowFor(result, abs("k.txt")).state, "DIVERGED");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 2. wontfix re-arms — deliberate behaviour change from v1.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile — wontfix pins the pair, then a later source change re-drifts it", async () => {
  const repo = await makeRepo();
  const stateDir = await scopedStateDir();
  try {
    await writeFile(path.join(repo, "m.txt"), "m v1\n");
    await writeFile(path.join(repo, "n.txt"), "n v1\n");
    await writeFile(
      path.join(repo, ".propagates.yml"),
      `sources:
  m.txt:
    propagates_to:
      - path: n.txt
        why: "wontfix pairing"
`,
    );
    await commitAll(repo, "initial");

    const abs = (n) => path.join(repo, n);
    pin({
      stateDir,
      sourceAbs: abs("m.txt"),
      downstreamAbs: abs("n.txt"),
      why: "wontfix pairing",
      disposition: "wontfix",
      reason: "deliberately not propagating this version",
    });

    let result = runReconcile({ stateDir, workspaceRoots: [repo] });
    assert.equal(rowFor(result, abs("m.txt")).state, "CLEAN", "wontfix pins the pair — reads CLEAN immediately after");

    await writeFile(abs("m.txt"), "m v2\n");
    result = runReconcile({ stateDir, workspaceRoots: [repo] });
    assert.equal(
      rowFor(result, abs("m.txt")).state,
      "DRIFTED",
      "a wontfix'd edge re-arms once the source changes again — v1 closed this forever, v2 must not",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3. A later `deferred` surfaces without changing the derived state.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile — a deferred event after the last pin is surfaced but does not change state", async () => {
  const repo = await makeRepo();
  const stateDir = await scopedStateDir();
  try {
    await writeFile(path.join(repo, "o.txt"), "o v1\n");
    await writeFile(path.join(repo, "p.txt"), "p v1\n");
    await writeFile(
      path.join(repo, ".propagates.yml"),
      `sources:
  o.txt:
    propagates_to:
      - path: p.txt
        why: "deferred-surfacing pairing"
`,
    );
    await commitAll(repo, "initial");

    const abs = (n) => path.join(repo, n);
    const pinResult = pin({
      stateDir,
      sourceAbs: abs("o.txt"),
      downstreamAbs: abs("p.txt"),
      why: "deferred-surfacing pairing",
    });
    await new Promise((r) => setTimeout(r, 5));
    const deferResult = defer({
      stateDir,
      sourceAbs: abs("o.txt"),
      downstreamAbs: abs("p.txt"),
      why: "deferred-surfacing pairing",
      reason: "will handle after the launch",
    });
    assert.ok(deferResult.ts > pinResult.ts, "test needs the deferred event to postdate the pin");

    const result = runReconcile({ stateDir, workspaceRoots: [repo] });
    const row = rowFor(result, abs("o.txt"));
    assert.equal(row.state, "CLEAN", "state is still derived from the pin, unaffected by a later deferred");
    assert.ok(row.deferred, "the later deferred must be surfaced on the row");
    assert.equal(row.deferred.reason, "will handle after the launch");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Cross-repo edge — resolves per-side, real state not an error.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile — a cross-repo edge resolves per-side and reports a real state", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "reconcile-cross-"));
  const stateDir = await scopedStateDir();
  try {
    const repoA = path.join(parent, "repo-a");
    const repoB = path.join(parent, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    for (const dir of [repoA, repoB]) {
      git(["init", "-q", "-b", "main"], dir);
      git(["config", "user.email", "test@example.com"], dir);
      git(["config", "user.name", "Test"], dir);
    }

    await writeFile(path.join(repoA, "src.txt"), "src v1\n");
    await writeFile(path.join(repoB, "dst.txt"), "dst v1\n");
    await writeFile(
      path.join(repoA, ".propagates.yml"),
      `sources:
  src.txt:
    propagates_to:
      - path: ../repo-b/dst.txt
        why: "cross-repo pairing"
`,
    );
    await commitAll(repoA, "initial a");
    await commitAll(repoB, "initial b");

    const sourceAbs = path.join(repoA, "src.txt");
    const downstreamAbs = path.join(repoB, "dst.txt");
    pin({ stateDir, sourceAbs, downstreamAbs, why: "cross-repo pairing" });

    let result = runReconcile({ stateDir, workspaceRoots: [repoA] });
    let row = rowFor(result, sourceAbs);
    assert.equal(row.sameRepo, false, "the two sides live in different repos");
    assert.equal(row.state, "CLEAN");
    assert.equal(row.source.unresolvable, null);
    assert.equal(row.downstream.unresolvable, null);

    await writeFile(sourceAbs, "src v2\n");
    result = runReconcile({ stateDir, workspaceRoots: [repoA] });
    row = rowFor(result, sourceAbs);
    assert.equal(row.state, "DRIFTED", "cross-repo edge must derive a real state, not error out");
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Glob expansion — one edge per match; zero matches -> UNMATCHED.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile — a glob downstream expands to one edge per match, and a zero-match glob reports UNMATCHED", async () => {
  const repo = await makeRepo();
  const stateDir = await scopedStateDir();
  try {
    await mkdir(path.join(repo, "sub"), { recursive: true });
    await writeFile(path.join(repo, "src.txt"), "src v1\n");
    await writeFile(path.join(repo, "sub", "one.md"), "one v1\n");
    await writeFile(path.join(repo, "sub", "two.md"), "two v1\n");
    await writeFile(
      path.join(repo, ".propagates.yml"),
      `sources:
  src.txt:
    propagates_to:
      - path: "sub/*.md"
        why: "glob pairing"
      - path: "nowhere/*.md"
        why: "zero-match glob pairing"
`,
    );
    await commitAll(repo, "initial");

    const result = runReconcile({ stateDir, workspaceRoots: [repo] });
    assert.equal(result.stats.edges, 2, "two declared generators");
    assert.equal(result.stats.expanded, 3, "sub/*.md expands to 2, nowhere/*.md expands to 1 UNMATCHED row");

    const matchedRows = result.rows.filter((r) => r.glob === "sub/*.md");
    assert.equal(matchedRows.length, 2);
    assert.ok(matchedRows.every((r) => r.state === "NEVER_VERIFIED"));
    const matchedNames = matchedRows.map((r) => path.basename(r.downstream.path)).sort();
    assert.deepEqual(matchedNames, ["one.md", "two.md"]);

    const unmatchedRow = result.rows.find((r) => r.glob === "nowhere/*.md");
    assert.ok(unmatchedRow, "the zero-match glob must still produce a visible row");
    assert.equal(unmatchedRow.state, "UNMATCHED");
    assert.equal(unmatchedRow.unresolvable, "unmatched-glob");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Adding a matching file creates one new NEVER_VERIFIED edge and does
//    not re-drift verified siblings.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile — a newly matching glob file creates one NEVER_VERIFIED edge without disturbing verified siblings", async () => {
  const repo = await makeRepo();
  const stateDir = await scopedStateDir();
  try {
    await mkdir(path.join(repo, "sub"), { recursive: true });
    await writeFile(path.join(repo, "src.txt"), "src v1\n");
    await writeFile(path.join(repo, "sub", "one.md"), "one v1\n");
    await writeFile(path.join(repo, "sub", "two.md"), "two v1\n");
    await writeFile(
      path.join(repo, ".propagates.yml"),
      `sources:
  src.txt:
    propagates_to:
      - path: "sub/*.md"
        why: "glob pairing"
`,
    );
    await commitAll(repo, "initial");

    const sourceAbs = path.join(repo, "src.txt");
    pin({ stateDir, sourceAbs, downstreamAbs: path.join(repo, "sub", "one.md"), why: "glob pairing" });
    pin({ stateDir, sourceAbs, downstreamAbs: path.join(repo, "sub", "two.md"), why: "glob pairing" });

    let result = runReconcile({ stateDir, workspaceRoots: [repo] });
    assert.equal(result.rows.length, 2);
    assert.ok(result.rows.every((r) => r.state === "CLEAN"));

    await writeFile(path.join(repo, "sub", "three.md"), "three v1\n");
    result = runReconcile({ stateDir, workspaceRoots: [repo] });

    assert.equal(result.rows.length, 3, "the new file must appear as its own edge");
    const byName = new Map(result.rows.map((r) => [path.basename(r.downstream.path), r.state]));
    assert.equal(byName.get("one.md"), "CLEAN", "verified sibling must stay CLEAN");
    assert.equal(byName.get("two.md"), "CLEAN", "verified sibling must stay CLEAN");
    assert.equal(byName.get("three.md"), "NEVER_VERIFIED");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 7. An unresolvable side carries its reason.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile — a downstream that is a directory reports UNRESOLVABLE with reason is-directory", async () => {
  const repo = await makeRepo();
  const stateDir = await scopedStateDir();
  try {
    await writeFile(path.join(repo, "q.txt"), "q v1\n");
    await mkdir(path.join(repo, "q_dir"));
    await writeFile(path.join(repo, "q_dir", "keep.txt"), "keep\n");
    await writeFile(
      path.join(repo, ".propagates.yml"),
      `sources:
  q.txt:
    propagates_to:
      - path: q_dir
        why: "directory downstream (sidecar bug)"
`,
    );
    await commitAll(repo, "initial");

    const result = runReconcile({ stateDir, workspaceRoots: [repo] });
    const row = rowFor(result, path.join(repo, "q.txt"));
    assert.equal(row.state, "UNRESOLVABLE");
    assert.equal(row.unresolvable, "is-directory");
    assert.equal(row.downstream.unresolvable, "is-directory");
    assert.equal(result.stats.unresolvable, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 8. `--json` parses and matches the envelope convention.
// ─────────────────────────────────────────────────────────────────────────

test("cli reconcile --json — parses and matches the generatedAt-first envelope", async () => {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "reconcile-cli-search-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "reconcile-cli-state-"));
  try {
    const wsRoot = path.join(searchRoot, "cli-fixture-ws");
    await mkdir(wsRoot, { recursive: true });
    git(["init", "-q", "-b", "main"], wsRoot);
    git(["config", "user.email", "test@example.com"], wsRoot);
    git(["config", "user.name", "Test"], wsRoot);
    await writeFile(path.join(wsRoot, "a.txt"), "a v1\n");
    await writeFile(path.join(wsRoot, "b.txt"), "b v1\n");
    await writeFile(
      path.join(wsRoot, ".propagates.yml"),
      `workspace: true
sources:
  a.txt:
    propagates_to:
      - path: b.txt
        why: "cli envelope test"
`,
    );
    await commitAll(wsRoot, "initial");

    const result = spawnSync(process.execPath, [CLI_PATH, "reconcile", "--all", "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PROPAGATE_SEARCH_ROOTS: searchRoot,
        PROPAGATE_STATE_DIR: stateDir,
      },
    });
    assert.equal(result.status, 0, `cli reconcile --all --json failed: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(typeof parsed.generatedAt === "string" && !Number.isNaN(Date.parse(parsed.generatedAt)));
    assert.ok(parsed.stats && typeof parsed.stats.edges === "number");
    assert.ok(Array.isArray(parsed.rows));
    const row = parsed.rows.find((r) => r.source.path === path.join(wsRoot, "a.txt"));
    assert.ok(row, "the declared edge must appear in the reconciled rows");
    assert.equal(row.state, "NEVER_VERIFIED", "an empty store reconciles to NEVER_VERIFIED — the honest starting position");
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
