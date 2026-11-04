/**
 * #118: `status`, `graph` and the blocking walk must agree about a deferred edge.
 *
 * Before phase 1 of #127, `status` counted a deferred edge as "deferred" while `graph` listed the very
 * same edge as NEVER_VERIFIED and let it block its downstreams (measured: 10 edges; in
 * retail-restock-fiori `graph` row 7 read NEVER_VERIFIED while `status` said "1 deferred").
 *
 * Fixture: A -> B and B -> C. A -> B is deferred, then A changes. All three numbers must agree:
 * status's parked count, graph's state for A -> B, and blockedBy for the downstream B -> C (empty).
 * The control pins A -> B for real and changes A: that stays DRIFTED in status, graph and reconcile,
 * and DOES block B -> C. Everything runs in a tmpdir store (G56).
 */
// @size medium — starts processes (CLI or script); run when affected

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function runCli(argv, { searchRoot, stateDir, cwd }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8", cwd,
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
}

async function makeWorkspace() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "graph-def-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "graph-def-state-"));
  const ws = path.join(searchRoot, "ws");
  await mkdir(path.join(ws, "propagation"), { recursive: true });
  git(["init", "-q", "-b", "main"], ws);
  git(["config", "user.email", "t@example.com"], ws);
  git(["config", "user.name", "T"], ws);
  for (const f of ["A", "B", "C"]) await writeFile(path.join(ws, `${f}.md`), `${f} v1\n`);
  await writeFile(path.join(ws, ".propagates.yml"), [
    "workspace: true", "sources:",
    "  A.md:", "    propagates_to:", "      - path: B.md", "        why: A feeds B", "        kind: prose",
    "  B.md:", "    propagates_to:", "      - path: C.md", "        why: B feeds C", "        kind: prose", "",
  ].join("\n"));
  await writeFile(path.join(ws, "propagation", "ledger.jsonl"), "");
  await writeFile(path.join(ws, "propagation", "ledger.md"), "# ledger\n");
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "init"], ws);
  return { searchRoot, stateDir, ws, env: { searchRoot, stateDir, cwd: ws } };
}

const cleanup = ({ searchRoot, stateDir }) => Promise.all([
  rm(searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
]);

const json = (env, argv) => {
  const r = runCli(argv, env);
  assert.equal(r.status, 0, `${argv.join(" ")} exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
const rowFor = (env, name) =>
  json(env, ["reconcile", "--all", "--json"]).rows.find((r) => r.source.path.endsWith(`/${name}.md`));

test("a deferred edge whose source changes afterwards: status, graph and blockedBy agree (#118)", async (t) => {
  const w = await makeWorkspace();
  t.after(() => cleanup(w));
  const ab = rowFor(w.env, "A");
  assert.equal(runCli(["verify", "--edge", ab.edge_id, "--disposition", "deferred", "--reason", "examined and parked", "--apply"], w.env).status, 0);
  await writeFile(path.join(w.ws, "A.md"), "A v2\n"); // the source changes after the deferral

  const cov = json(w.env, ["status", "--json"]);
  const graph = json(w.env, ["graph", "--json", "--include-unverified"]);
  const gAB = graph.fixOrder.find((i) => i.edge_id === ab.edge_id);
  const gBC = graph.fixOrder.find((i) => i.from.endsWith("/B.md"));

  assert.equal(cov.parked, 1, "status counts the deferred edge as parked");
  assert.equal(gAB.state, "DEFERRED", "graph shows the same edge as DEFERRED, not NEVER_VERIFIED");
  assert.deepEqual(gBC.blockedBy, [], "a parked edge never blocks its downstream");
  assert.equal(cov.never_judged, 1, "only B -> C is never judged");
});

test("control: a real pin followed by a source change stays DRIFTED in status, graph and reconcile, and blocks", async (t) => {
  const w = await makeWorkspace();
  t.after(() => cleanup(w));
  const ab = rowFor(w.env, "A");
  assert.equal(runCli(["verify", "--edge", ab.edge_id, "--disposition", "no-change-needed", "--reason", "checked A against B line by line", "--apply"], w.env).status, 0);
  await writeFile(path.join(w.ws, "A.md"), "A v2\n");

  const cov = json(w.env, ["status", "--json"]);
  const graph = json(w.env, ["graph", "--json", "--include-unverified"]);
  const gAB = graph.fixOrder.find((i) => i.edge_id === ab.edge_id);
  const gBC = graph.fixOrder.find((i) => i.from.endsWith("/B.md"));

  assert.equal(rowFor(w.env, "A").state, "DRIFTED");
  assert.equal(gAB.state, "DRIFTED");
  assert.equal(cov.judge, 1, "status shows it as something to judge");
  assert.equal(cov.parked, 0);
  assert.deepEqual(gBC.blockedBy.map((b) => b.edge_id), [ab.edge_id], "an unsettled edge still blocks B -> C");
});

test("a deferral AFTER a real pin keeps the pinned state and stays visible on the row", async (t) => {
  const w = await makeWorkspace();
  t.after(() => cleanup(w));
  const ab = rowFor(w.env, "A");
  runCli(["verify", "--edge", ab.edge_id, "--disposition", "no-change-needed", "--reason", "checked A against B line by line", "--apply"], w.env);
  await writeFile(path.join(w.ws, "A.md"), "A v2\n");
  runCli(["verify", "--edge", ab.edge_id, "--disposition", "deferred", "--reason", "will look next week", "--apply"], w.env);
  const row = rowFor(w.env, "A");
  assert.equal(row.state, "DRIFTED", "a deferral does not launder a drifted edge into 'parked'");
  assert.ok(row.deferred, "the deferral is shown, not hidden");
  assert.equal(json(w.env, ["status", "--json"]).parked, 0);
});
