/**
 * Tests for `propagate why <edge_id>` — §4 of
 * ~/.claude/plans/status-temporal-plum.md (lane W3), lib/edges/why.mjs +
 * cli.mjs's thin `why` dispatch arm.
 *
 * Same fixture discipline as tests/cli/reconcile.test.mjs: a real temp git
 * repo with a `.propagates.yml` sidecar, PROPAGATE_SEARCH_ROOTS pointed at
 * it and PROPAGATE_STATE_DIR scoped to a fresh tmpdir, driven entirely
 * through the real CLI binary via spawnSync — never the real store
 * (docs/GOTCHAS.md G54).
 *
 * Run: `npm test` (node --test tests/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const EVENTS_LIB = fileURLToPath(new URL("../../lib/edges/events.mjs", import.meta.url));
const RECONCILE_LIB = fileURLToPath(new URL("../../lib/edges/reconcile.mjs", import.meta.url));
const CONTENT_ID_LIB = fileURLToPath(new URL("../../lib/edges/content-id.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function commitAll(dir, msg = "snapshot") {
  git(["add", "."], dir);
  git(["commit", "-q", "-m", msg], dir);
}

/** One workspace: a git repo with a.txt -> b.txt declared, under a search root. */
async function makeFixtureWorkspace() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "why-cli-search-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "why-cli-state-"));
  const wsRoot = path.join(searchRoot, "why-fixture-ws");
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
        why: "why-cli fixture edge"
`,
  );
  await commitAll(wsRoot, "initial");
  return { searchRoot, stateDir, wsRoot };
}

function env(searchRoot, stateDir) {
  return { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir };
}

function runCli(args, envVars) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8", env: envVars });
}

/** Compute the real edge_id for a.txt -> b.txt in a given workspace, via toNodeId/edgeId
 *  (same primitives reconcile()/appendEvent use), and pin an event for it. */
function pinEvent({ stateDir, wsRoot, disposition = "propagated", reason = "test pin", byKind }) {
  const sourceAbs = path.join(wsRoot, "a.txt");
  const downstreamAbs = path.join(wsRoot, "b.txt");
  const realScript = `
import { contentId } from ${JSON.stringify(CONTENT_ID_LIB)};
import { edgeId, appendEvent } from ${JSON.stringify(EVENTS_LIB)};
import { toNodeId, edgeIdFor } from ${JSON.stringify(RECONCILE_LIB)};

const sourceAbs = ${JSON.stringify(sourceAbs)};
const downstreamAbs = ${JSON.stringify(downstreamAbs)};
const nodeId = toNodeId(sourceAbs);
const eId = edgeIdFor(nodeId, downstreamAbs, ${JSON.stringify("why-cli fixture edge")});
const s = contentId(sourceAbs);
const d = contentId(downstreamAbs);
const payload = {
  edge_id: eId,
  node_id: nodeId,
  source_content: s.id,
  downstream_content: d.id,
  disposition: ${JSON.stringify(disposition)},
  reason: ${JSON.stringify(reason)},
  by: "test",
  observed_on_ref: "main",
  downstream_on_ref: "main",
  ${byKind ? `by_kind: ${JSON.stringify(byKind)},` : ""}
};
const event = await appendEvent(payload);
console.log(JSON.stringify({ edge_id: eId, event }));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", realScript], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
  assert.equal(result.status, 0, `pin failed: ${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

/** Write a raw pre-provenance event directly (no observed_at_commit/observed_on_branch),
 *  simulating one of the 1347 events written before lane W1. Bypasses appendEvent's
 *  provenance fields entirely by constructing the event object by hand. */
function pinPreProvenanceEvent({ stateDir, wsRoot }) {
  const sourceAbs = path.join(wsRoot, "a.txt");
  const downstreamAbs = path.join(wsRoot, "b.txt");
  const realScript = `
import { contentId } from ${JSON.stringify(CONTENT_ID_LIB)};
import { edgeId, appendEvent } from ${JSON.stringify(EVENTS_LIB)};
import { toNodeId, edgeIdFor } from ${JSON.stringify(RECONCILE_LIB)};

const sourceAbs = ${JSON.stringify(sourceAbs)};
const downstreamAbs = ${JSON.stringify(downstreamAbs)};
const nodeId = toNodeId(sourceAbs);
const eId = edgeIdFor(nodeId, downstreamAbs, ${JSON.stringify("why-cli fixture edge")});
const s = contentId(sourceAbs);
const d = contentId(downstreamAbs);
// Deliberately NO observed_at_commit / observed_on_branch / by_kind — the
// exact shape of every one of the 1347 pre-wedge events.
const event = await appendEvent({
  edge_id: eId,
  node_id: nodeId,
  source_content: s.id,
  downstream_content: d.id,
  disposition: "no-change-needed",
  by: "legacy",
  observed_on_ref: "working-tree",
  downstream_on_ref: "working-tree",
});
console.log(JSON.stringify({ edge_id: eId, event }));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", realScript], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
  assert.equal(result.status, 0, `pin (pre-provenance) failed: ${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

async function cleanup({ searchRoot, stateDir }) {
  await rm(searchRoot, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────
// RED #2 — disposition changes only, --all shows everything.
// ─────────────────────────────────────────────────────────────────────────

test("why: five identical dispositions render as one entry; --all renders five", async () => {
  const fx = await makeFixtureWorkspace();
  try {
    let edgeId;
    for (let i = 0; i < 5; i++) {
      const { edge_id } = pinEvent({ ...fx, disposition: "no-change-needed", reason: `pass ${i}` });
      edgeId = edge_id;
    }

    const defaultRun = runCli(["why", edgeId, "--json"], env(fx.searchRoot, fx.stateDir));
    assert.equal(defaultRun.status, 0, defaultRun.stderr);
    const defaultResult = JSON.parse(defaultRun.stdout.trim());
    assert.equal(defaultResult.status, "found");
    assert.equal(defaultResult.totalEvents, 5);
    assert.equal(defaultResult.shown.length, 1, "five identical dispositions must collapse to one entry");

    const allRun = runCli(["why", edgeId, "--all", "--json"], env(fx.searchRoot, fx.stateDir));
    assert.equal(allRun.status, 0, allRun.stderr);
    const allResult = JSON.parse(allRun.stdout.trim());
    assert.equal(allResult.shown.length, 5, "--all must render every event");
  } finally {
    await cleanup(fx);
  }
});

test("why: a disposition change is a new entry, not collapsed", async () => {
  const fx = await makeFixtureWorkspace();
  try {
    pinEvent({ ...fx, disposition: "no-change-needed" });
    pinEvent({ ...fx, disposition: "no-change-needed" });
    const { edge_id } = pinEvent({ ...fx, disposition: "baselined", reason: "actually changed" });

    const run = runCli(["why", edge_id, "--json"], env(fx.searchRoot, fx.stateDir));
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.shown.length, 2, "no-change-needed x2 then baselined = 2 kept entries");
    assert.equal(result.shown[0].disposition, "no-change-needed");
    assert.equal(result.shown[1].disposition, "baselined");
  } finally {
    await cleanup(fx);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// RED #3 — three distinguishable absence messages.
// ─────────────────────────────────────────────────────────────────────────

test("why: an edge with no events (but currently declared) reports 'no-events', not blank", async () => {
  const fx = await makeFixtureWorkspace();
  try {
    // Compute the real edge_id without writing any event for it.
    const script = `
import { toNodeId, edgeIdFor } from ${JSON.stringify(RECONCILE_LIB)};
// Use production's OWN derivation (edgeIdFor). Rebuilding it by hand here is
// how these two tests silently disagreed with the CLI through the N40 fix:
// they kept minting the old absolute-path id and the CLI reported unknown-edge.
const nodeId = toNodeId(${JSON.stringify(path.join(fx.wsRoot, "a.txt"))});
console.log(edgeIdFor(nodeId, ${JSON.stringify(path.join(fx.wsRoot, "b.txt"))}, ${JSON.stringify("why-cli fixture edge")}));
`;
    const idResult = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(idResult.status, 0, idResult.stderr);
    const edgeIdValue = idResult.stdout.trim();

    const run = runCli(["why", edgeIdValue, "--json"], env(fx.searchRoot, fx.stateDir));
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.status, "no-events");
    assert.match(result.message, /no verification events/);
  } finally {
    await cleanup(fx);
  }
});

test("why: an edge id that is neither declared nor has events reports 'unknown-edge'", async () => {
  const fx = await makeFixtureWorkspace();
  try {
    const run = runCli(["why", "deadbeef", "--json"], env(fx.searchRoot, fx.stateDir));
    // unknown-edge is a distinguishable non-success, not a crash.
    assert.equal(run.status, 1, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.status, "unknown-edge");
    assert.match(result.message, /unknown edge id/);
  } finally {
    await cleanup(fx);
  }
});

test("why: 'no-events' and 'unknown-edge' render genuinely different messages", async () => {
  const fx = await makeFixtureWorkspace();
  try {
    const script = `
import { toNodeId, edgeIdFor } from ${JSON.stringify(RECONCILE_LIB)};
// Use production's OWN derivation (edgeIdFor). Rebuilding it by hand here is
// how these two tests silently disagreed with the CLI through the N40 fix:
// they kept minting the old absolute-path id and the CLI reported unknown-edge.
const nodeId = toNodeId(${JSON.stringify(path.join(fx.wsRoot, "a.txt"))});
console.log(edgeIdFor(nodeId, ${JSON.stringify(path.join(fx.wsRoot, "b.txt"))}, ${JSON.stringify("why-cli fixture edge")}));
`;
    const idResult = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    const declaredEdgeId = idResult.stdout.trim();

    const noEventsRun = runCli(["why", declaredEdgeId, "--json"], env(fx.searchRoot, fx.stateDir));
    const unknownRun = runCli(["why", "0000dead", "--json"], env(fx.searchRoot, fx.stateDir));

    const noEvents = JSON.parse(noEventsRun.stdout.trim());
    const unknown = JSON.parse(unknownRun.stdout.trim());

    assert.notEqual(noEvents.status, unknown.status);
    assert.notEqual(noEvents.message, unknown.message);
  } finally {
    await cleanup(fx);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// pre-provenance events — "position not recorded", never blank or invented.
// ─────────────────────────────────────────────────────────────────────────

test("why: an event with no observed_at_commit/observed_on_branch renders 'position not recorded', never a guess", async () => {
  const fx = await makeFixtureWorkspace();
  try {
    const { edge_id } = pinPreProvenanceEvent(fx);

    const run = runCli(["why", edge_id, "--json"], env(fx.searchRoot, fx.stateDir));
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.status, "found");
    assert.equal(result.shown.length, 1);
    assert.equal(result.shown[0].position.recorded, false);
    assert.match(result.shown[0].position.note, /position not recorded/);
    assert.equal(result.shown[0].position.commit, undefined);
    assert.equal(result.shown[0].position.branch, undefined);
    // The downstream end is the same story one lane later: an event minted
    // before the ref pair genuinely does not know where its downstream was
    // read, and must SAY so rather than render blank or borrow the source's.
    assert.equal(result.shown[0].downstreamPosition.recorded, false);
    assert.match(result.shown[0].downstreamPosition.note, /downstream position not recorded/);
  } finally {
    await cleanup(fx);
  }
});

test("why: a post-wedge event with a recorded position never renders 'position not recorded'", async () => {
  const fx = await makeFixtureWorkspace();
  try {
    // appendEvent itself does not stamp observed_at_commit (that's the
    // caller's job per lane W1's design — cli.mjs's verify path does it via
    // resolveProvenance). Simulate a caller that DID stamp it.
    const sourceAbs = path.join(fx.wsRoot, "a.txt");
    const downstreamAbs = path.join(fx.wsRoot, "b.txt");
    const script = `
import { contentId } from ${JSON.stringify(CONTENT_ID_LIB)};
import { edgeId, appendEvent } from ${JSON.stringify(EVENTS_LIB)};
import { toNodeId, edgeIdFor } from ${JSON.stringify(RECONCILE_LIB)};
const nodeId = toNodeId(${JSON.stringify(sourceAbs)});
const eId = edgeIdFor(nodeId, ${JSON.stringify(downstreamAbs)}, ${JSON.stringify("why-cli fixture edge")});
const s = contentId(${JSON.stringify(sourceAbs)});
const d = contentId(${JSON.stringify(downstreamAbs)});
const event = await appendEvent({
  edge_id: eId,
  node_id: nodeId,
  source_content: s.id,
  downstream_content: d.id,
  disposition: "propagated",
  reason: "post-wedge, position known",
  by: "test",
  observed_on_ref: "working-tree",
  downstream_on_ref: "working-tree",
  observed_at_commit: "abc123def456",
  observed_on_branch: "main",
  observed_dirty: false,
  downstream_at_commit: "999fff888eee",
  downstream_on_branch: "production",
  downstream_dirty: true,
  by_kind: "human",
});
console.log(JSON.stringify({ edge_id: eId }));
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_STATE_DIR: fx.stateDir },
    });
    assert.equal(result.status, 0, result.stderr);
    const { edge_id } = JSON.parse(result.stdout.trim());

    const run = runCli(["why", edge_id, "--json"], env(fx.searchRoot, fx.stateDir));
    const out = JSON.parse(run.stdout.trim());
    assert.equal(out.shown[0].position.recorded, true);
    assert.equal(out.shown[0].position.branch, "main");
    assert.equal(out.shown[0].position.commit, "abc123def456");
    // Both ends, and they must NOT be the same values — the design's stated
    // success criterion is that `why` names the branch each decision was
    // made on, and a decision about a cross-repo edge was made on two.
    assert.equal(out.shown[0].downstreamPosition.recorded, true);
    assert.equal(out.shown[0].downstreamPosition.branch, "production");
    assert.equal(out.shown[0].downstreamPosition.commit, "999fff888eee");
    assert.equal(out.shown[0].downstreamPosition.dirty, true);
    assert.notEqual(
      out.shown[0].downstreamPosition.branch,
      out.shown[0].position.branch,
      "the two ends must be rendered independently, not one value shown twice",
    );
  } finally {
    await cleanup(fx);
  }
});
