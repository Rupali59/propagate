/**
 * `propagate rekey` — carry an edge's history across a re-identification.
 *
 * Every test that touches a store runs the CLI as a subprocess against a TEMP
 * search root and a TEMP state dir (verify-fixture's runCli sets both), so none
 * of this can reach the production ledger (GOTCHAS G54/G56). Fixtures are
 * literal: the hostile cases (a still-declared --from, a store with a cycle) are
 * written out by hand and must not be refactored onto a shared builder
 * (rule:mutate-behind-the-fixture-builder).
 */
// @size medium — starts processes (CLI); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { git, runCli, storeSnapshot, cleanup } from "../helpers/verify-fixture.mjs";
import { allowedDispositions } from "../../lib/edges/disposition.mjs";
import { DISPOSITIONS, VERIFY_DISPOSITIONS, dryValidateEvent } from "../../lib/edges/events.mjs";
import { historyFromEvents } from "../../lib/report/queue.mjs";

const sidecar = (...whys) =>
  [
    "workspace: true",
    "sources:",
    "  X.md:",
    "    propagates_to:",
    ...whys.flatMap(([file, why]) => [`      - path: ${file}`, `        why: ${why}`, "        kind: prose"]),
    "",
  ].join("\n");

/** A repo with X.md -> Y.md (and Z.md available), one commit. */
async function makeRepo(whys = [["Y.md", "why one"]]) {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "rekey-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "rekey-state-"));
  const ws = path.join(searchRoot, "ws");
  await mkdir(ws, { recursive: true });
  git(["init", "-q", "-b", "main"], ws);
  git(["config", "user.email", "t@example.com"], ws);
  git(["config", "user.name", "T"], ws);
  for (const f of ["X.md", "Y.md", "Z.md"]) await writeFile(path.join(ws, f), `${f} v1\n`);
  await writeFile(path.join(ws, ".propagates.yml"), sidecar(...whys));
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "init"], ws);
  return { searchRoot, stateDir, ws, env: { searchRoot, stateDir } };
}

const rows = (f) => JSON.parse(runCli(["reconcile", "--all", "--json"], f.env).stdout).rows;
const rowFor = (f, file) => rows(f).find((r) => r.downstream.path.endsWith(file));
const verify = (f, id, disposition, reason = "test verdict") =>
  runCli(["verify", "--edge", id, "--disposition", disposition, "--reason", reason, "--apply", "--json"], f.env);
const reword = (f, ...whys) => writeFile(path.join(f.ws, ".propagates.yml"), sidecar(...whys));
const commit = (f, msg) => { git(["add", "."], f.ws); git(["commit", "-q", "-m", msg], f.ws); };
const events = async (f) =>
  (await readFile(path.join(f.stateDir, "events", (await import("node:fs")).readdirSync(path.join(f.stateDir, "events"))[0]), "utf8"))
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Verify the edge, reword its why, return both ids. The old id is now orphaned. */
async function orphan(f, { disposition = "propagated", beforeReword } = {}) {
  const oldId = rowFor(f, "Y.md").edge_id;
  assert.equal(verify(f, oldId, disposition).status, 0, "fixture: the old edge's verdict must land");
  if (beforeReword) await beforeReword();
  await reword(f, ["Y.md", "why two"]);
  commit(f, "reword");
  const nu = rowFor(f, "Y.md");
  assert.notEqual(nu.edge_id, oldId, "fixture: rewording the why must mint a new id");
  assert.equal(nu.state, "NEVER_VERIFIED");
  return { oldId, newId: nu.edge_id };
}

// ── the five refusals, each its own reason and exit code ────────────────────

test("refusal 1: --to is not a declared edge (exit 11)", async () => {
  const f = await makeRepo();
  try {
    const { oldId } = await orphan(f);
    const r = runCli(["rekey", "--to", "deadbeef", "--from", oldId], f.env);
    assert.equal(r.status, 11, r.stderr);
    assert.match(r.stderr, /to-not-declared/);
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

test("refusal 2: --to already has events (exit 12), and nothing is written", async () => {
  const f = await makeRepo();
  try {
    const { oldId, newId } = await orphan(f);
    assert.equal(verify(f, newId, "baselined", "fresh baseline").status, 0);
    const before = storeSnapshot(f.stateDir);
    const r = runCli(["rekey", "--to", newId, "--from", oldId, "--apply"], f.env);
    assert.equal(r.status, 12, r.stderr);
    assert.match(r.stderr, /to-has-events/);
    assert.equal(storeSnapshot(f.stateDir), before);
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

test("refusal 3: --from is still declared, so it is not a rename (exit 13)", async () => {
  // HOSTILE LITERAL: two live edges X->Y and X->Z. Y has history, Z has none.
  // Do not refactor this onto orphan(): the point is that BOTH ids are declared.
  const f = await makeRepo([["Y.md", "why for y"], ["Z.md", "why for z"]]);
  try {
    const y = rowFor(f, "Y.md").edge_id;
    const z = rowFor(f, "Z.md").edge_id;
    assert.equal(verify(f, y, "propagated").status, 0);
    const before = storeSnapshot(f.stateDir);
    const r = runCli(["rekey", "--to", z, "--from", y, "--apply"], f.env);
    assert.equal(r.status, 13, r.stderr);
    assert.match(r.stderr, /from-still-declared/);
    assert.equal(storeSnapshot(f.stateDir), before, "two live edges must not end up sharing one history");
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

test("refusal 4: --from has nothing to carry, only deferred events (exit 14)", async () => {
  const f = await makeRepo();
  try {
    const { oldId, newId } = await orphan(f, { disposition: "deferred" });
    const r = runCli(["rekey", "--to", newId, "--from", oldId, "--apply"], f.env);
    assert.equal(r.status, 14, r.stderr);
    assert.match(r.stderr, /nothing-to-carry/);
    assert.match(r.stderr, /verify --edge/, "the refusal names what to do instead");
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

test("refusal 5: --from was already rekeyed onward (exit 15)", async () => {
  const f = await makeRepo();
  try {
    const { oldId, newId } = await orphan(f);
    assert.equal(runCli(["rekey", "--to", newId, "--from", oldId, "--apply"], f.env).status, 0);
    await reword(f, ["Y.md", "why three"]);
    commit(f, "reword again");
    const third = rowFor(f, "Y.md").edge_id;
    const before = storeSnapshot(f.stateDir);
    const r = runCli(["rekey", "--to", third, "--from", oldId, "--apply"], f.env);
    assert.equal(r.status, 15, r.stderr);
    assert.match(r.stderr, /already-rekeyed/);
    assert.equal(storeSnapshot(f.stateDir), before, "a second rekey would fork the history");
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

// ── listing and the dry run ─────────────────────────────────────────────────

test("without --from it lists the orphan, newest first, and writes nothing", async () => {
  const f = await makeRepo();
  try {
    const { oldId, newId } = await orphan(f);
    const before = storeSnapshot(f.stateDir);
    const r = runCli(["rekey", "--to", newId, "--json"], f.env);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.candidates[0].edge_id, oldId);
    assert.equal(out.candidates[0].lastDisposition, "propagated");
    assert.equal(out.candidates[0].verdicts, 1);
    assert.equal(storeSnapshot(f.stateDir), before);
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

test("with no candidate it refuses with its own code (16), not an empty list", async () => {
  const f = await makeRepo();
  try {
    const nu = rowFor(f, "Y.md").edge_id;
    const r = runCli(["rekey", "--to", nu], f.env);
    assert.equal(r.status, 16, r.stderr);
    assert.match(r.stderr, /no-candidates/);
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

test("DRY RUN: every byte of the store is identical before and after, and it predicts the state", async () => {
  const f = await makeRepo();
  try {
    const { oldId, newId } = await orphan(f);
    const before = storeSnapshot(f.stateDir);
    const r = runCli(["rekey", "--to", newId, "--from", oldId, "--json"], f.env);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.apply, false);
    assert.equal(out.predictedState, "CLEAN");
    assert.equal(out.wouldWrite.disposition, "rekeyed");
    assert.equal(storeSnapshot(f.stateDir), before, "dry run must not touch the store");
    const text = runCli(["rekey", "--to", newId, "--from", oldId], f.env);
    assert.match(text.stdout, /would write 1 event/);
    assert.match(text.stdout, /predicted state of \w+ afterwards: \S*CLEAN/);
    assert.equal(storeSnapshot(f.stateDir), before);
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

// ── the state carries, with no laundering ───────────────────────────────────

for (const [label, edit, expected] of [
  ["CLEAN stays CLEAN", async () => {}, "CLEAN"],
  ["DRIFTED stays DRIFTED", (f) => writeFile(path.join(f.ws, "X.md"), "X v2\n"), "DRIFTED"],
  ["DIVERGED stays DIVERGED", async (f) => {
    await writeFile(path.join(f.ws, "X.md"), "X v2\n");
    await writeFile(path.join(f.ws, "Y.md"), "Y v2\n");
  }, "DIVERGED"],
]) {
  test(`state carries: ${label} across --apply, and the settle diff base equals the old edge's`, async () => {
    const f = await makeRepo();
    try {
      const { oldId, newId } = await orphan(f, { beforeReword: null });
      // Move HEAD after the old verdict, so a rekey that re-resolved position
      // fresh (instead of carrying it) would record a different commit.
      await edit(f);
      await writeFile(path.join(f.ws, "Z.md"), "Z v2\n");
      commit(f, "move head");
      const oldPin = (await events(f)).find((e) => e.edge_id === oldId && e.disposition === "propagated");
      assert.ok(oldPin.observed_at_commit, "fixture: the old pin records a commit");
      assert.notEqual(oldPin.observed_at_commit, git(["rev-parse", "HEAD"], f.ws), "fixture: HEAD moved");

      const r = runCli(["rekey", "--to", newId, "--from", oldId, "--apply", "--json"], f.env);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).confirmed, true);
      assert.equal(rowFor(f, "Y.md").state, expected, "no laundering: the new edge reconciles to the old edge's state");

      const evs = await events(f);
      const h = historyFromEvents(evs);
      const o = h.get(oldId).lastVerified;
      const n = h.get(newId).lastVerified;
      for (const k of ["commit", "dirty", "branch", "downstreamCommit", "downstreamDirty"]) {
        assert.deepEqual(n[k], o[k], `settle's since-last-pinning-verify base: ${k}`);
      }
      assert.equal(n.commit, oldPin.observed_at_commit);

      const sr = runCli(["settle", path.join(f.ws, "Y.md"), "--json"], f.env);
      const settle = JSON.parse(sr.stdout);
      const item = (settle.items ?? []).find((i) => i.edge_id === newId);
      if (expected === "CLEAN") {
        assert.equal(item, undefined, "a CLEAN edge has nothing to settle, so settle does not list it");
        return;
      }
      assert.ok(item, `settle must list the new edge (a skipped assertion is not a pass): ${sr.stdout.slice(0, 300)}`);
      assert.equal(item.since.commit, oldPin.observed_at_commit, "settle prints the old edge's commit as its base");
      assert.equal(item.judged, 2, "settle's judged count includes the predecessor");
    } finally { await cleanup(f.searchRoot, f.stateDir); }
  });
}

test("the carried pair is the LATEST pinning event, not the first", async () => {
  // Two verdicts with different content: the second is the pair the edge was last judged at.
  const f = await makeRepo();
  try {
    const oldId = rowFor(f, "Y.md").edge_id;
    assert.equal(verify(f, oldId, "propagated", "first judgement").status, 0);
    await writeFile(path.join(f.ws, "X.md"), "X v2\n");
    await writeFile(path.join(f.ws, "Y.md"), "Y v2\n");
    commit(f, "both move");
    assert.equal(verify(f, oldId, "both-reconciled", "second judgement").status, 0);
    await reword(f, ["Y.md", "why two"]);
    commit(f, "reword");
    const newId = rowFor(f, "Y.md").edge_id;
    const [first, second] = (await events(f)).filter((e) => e.edge_id === oldId);
    assert.notEqual(first.source_content, second.source_content, "fixture: the two pins differ");

    const r = runCli(["rekey", "--to", newId, "--from", oldId, "--apply", "--json"], f.env);
    assert.equal(r.status, 0, r.stderr);
    const written = (await events(f)).find((e) => e.edge_id === newId);
    assert.equal(written.source_content, second.source_content, "carried the latest pin's source");
    assert.equal(written.downstream_content, second.downstream_content, "carried the latest pin's downstream");
    assert.equal(written.observed_at_commit, second.observed_at_commit);
    assert.equal(rowFor(f, "Y.md").state, "CLEAN", "the first pin would have read DIVERGED");
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

// ── rekeyed is not a verdict ────────────────────────────────────────────────

test("verify --disposition rekeyed is refused, points at rekey, and writes nothing", async () => {
  const f = await makeRepo();
  try {
    const id = rowFor(f, "Y.md").edge_id;
    const before = storeSnapshot(f.stateDir);
    const r = runCli(["verify", "--edge", id, "--disposition", "rekeyed", "--reason", "x", "--apply"], f.env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /rekey/);
    assert.match(r.stderr, /not a verdict/);
    assert.equal(storeSnapshot(f.stateDir), before);
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

test("allowedDispositions never lists rekeyed, in any state, blocked or not", () => {
  assert.ok(DISPOSITIONS.includes("rekeyed"), "appendEvent must validate it");
  assert.ok(!VERIFY_DISPOSITIONS.includes("rekeyed"));
  let cells = 0;
  for (const state of ["NEVER_VERIFIED", "CLEAN", "DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"]) {
    for (const blockers of [[], [{ edge_id: "up" }]]) {
      const a = allowedDispositions({ state }, blockers);
      cells += 1;
      for (const list of [a.allowed, a.viaOutOfOrder, a.needsReason]) assert.ok(!list.includes("rekeyed"), `${state}`);
    }
  }
  assert.equal(cells, 12, "every cell visited");
});

test("appendEvent validation: rekeyed needs from_edge_id, a reason, content, and cannot continue itself", () => {
  const base = {
    edge_id: "aaaaaaaa", node_id: "r:X.md", disposition: "rekeyed", from_edge_id: "bbbbbbbb", reason: "r",
    source_content: "s", downstream_content: "d", observed_on_ref: null, downstream_on_ref: null,
  };
  assert.equal(dryValidateEvent(base), null);
  assert.match(dryValidateEvent({ ...base, from_edge_id: undefined }), /from_edge_id/);
  assert.match(dryValidateEvent({ ...base, reason: undefined }), /reason/);
  assert.match(dryValidateEvent({ ...base, from_edge_id: "aaaaaaaa" }), /itself/);
  assert.match(dryValidateEvent({ ...base, source_content: undefined }), /source_content/);
});

// ── history follows the link ────────────────────────────────────────────────

test("why <new> includes the old edge's events, labelled; judged count includes predecessors", async () => {
  const f = await makeRepo();
  try {
    const { oldId, newId } = await orphan(f);
    assert.equal(runCli(["rekey", "--to", newId, "--from", oldId, "--apply"], f.env).status, 0);
    const out = JSON.parse(runCli(["why", newId, "--all", "--json"], f.env).stdout);
    assert.equal(out.status, "found");
    assert.deepEqual(out.previous, [{ edge_id: oldId, events: 1 }]);
    const labelled = out.shown.filter((e) => e.previous_edge_id === oldId);
    assert.equal(labelled.length, 1);
    assert.equal(labelled[0].disposition, "propagated");
    assert.equal(out.shown.find((e) => e.disposition === "rekeyed").from_edge_id, oldId);
    assert.equal(out.totalEvents, 2);
    assert.equal(historyFromEvents(await events(f)).get(newId).total, 2, "judged Nx counts the predecessor");
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});

test("historyFromEvents: a two-hop chain adds each hop once, and a cycle terminates", () => {
  const ev = (edge_id, disposition, extra = {}, ts = "2026-10-01T00:00:00.000Z") => ({ edge_id, disposition, ts, ...extra });
  const hop = [
    ev("aaaaaaaa", "propagated", {}, "2026-10-01T00:00:01.000Z"),
    ev("aaaaaaaa", "no-change-needed", {}, "2026-10-01T00:00:02.000Z"),
    ev("bbbbbbbb", "rekeyed", { from_edge_id: "aaaaaaaa" }, "2026-10-02T00:00:00.000Z"),
    ev("bbbbbbbb", "no-change-needed", {}, "2026-10-02T00:00:01.000Z"),
    ev("cccccccc", "rekeyed", { from_edge_id: "bbbbbbbb" }, "2026-10-03T00:00:00.000Z"),
  ];
  const h = historyFromEvents(hop);
  assert.equal(h.get("aaaaaaaa").total, 2);
  assert.equal(h.get("bbbbbbbb").total, 4, "2 own + 2 predecessor");
  assert.equal(h.get("cccccccc").total, 5, "1 own + 2 (b own) + 2 (a), each hop once");
  assert.equal(h.get("cccccccc").noChange, 2);

  const cyc = historyFromEvents([
    ev("aaaaaaaa", "rekeyed", { from_edge_id: "bbbbbbbb" }),
    ev("bbbbbbbb", "rekeyed", { from_edge_id: "aaaaaaaa" }),
  ]);
  assert.equal(cyc.get("aaaaaaaa").total, 2);
  assert.equal(cyc.get("bbbbbbbb").total, 2);
});

test("why <new> terminates on a store with a cycle and says where it stopped", async () => {
  // HOSTILE LITERAL: a hand-written store, A rekeyed from B and B from A.
  const f = await makeRepo();
  try {
    const nu = rowFor(f, "Y.md").edge_id;
    const line = (edge_id, from) => JSON.stringify({
      edge_id, node_id: "ws:X.md", disposition: "rekeyed", from_edge_id: from, reason: "r",
      source_content: "s", downstream_content: "d", ts: "2026-10-01T00:00:00.000Z", event_id: `E${edge_id}`,
    });
    await mkdir(path.join(f.stateDir, "events"), { recursive: true });
    await writeFile(path.join(f.stateDir, "events", "2026-10.jsonl"), [line(nu, "bbbbbbbb"), line("bbbbbbbb", nu)].join("\n") + "\n");
    const r = runCli(["why", nu, "--all", "--json"], f.env);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.chainStopped, /cycle/);
  } finally { await cleanup(f.searchRoot, f.stateDir); }
});
