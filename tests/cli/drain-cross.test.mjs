/**
 * `drain` can reach the cross-repo ledger.
 *
 * The gap this closes was filed by hand, not by a test:
 * PanditPawanKaushik/docs/DECISIONS.md 2026-08-15 records three cross rows
 * (#006-008) whose relays were VERIFIED DONE by reading SSJK-mb directly — and
 * which could not be closed. `drain --close 006,007,008` and `drain --all
 * --close …` both failed with "row id(s) not found (or not open) in scope",
 * because `drainScope()` returns WORKSPACES and the cross ledger is not a
 * workspace. Quoting that entry: "they are not stale and not unfinished work;
 * they are unclosable with the supported tooling, and hand-editing the ledger
 * is forbidden by the skill's own rule."
 *
 * So cross rows could be OPENED but never CLOSED. A store that only grows is
 * not a worklist, and the three rows sat open for three days purely as an
 * artifact of missing scope.
 *
 * The load-bearing assertion is the round trip: a row that `--cross` lists must
 * also be closable through `--cross`, and must actually leave the open set
 * afterwards — verified by re-reading the ledger, not by trusting the command's
 * own success message.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function runCli(argv, { searchRoot, stateDir, cwd }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
}

function crossRow(id, partner) {
  return JSON.stringify({
    id,
    type: "drift",
    status: "open",
    timestamp: "2026-08-13T10:55:05.645Z",
    origin_repo: "TestWorkspace",
    partner,
    direction: "outbound",
    source: "docs/DECISIONS.md",
    downstream: [{ path: partner, why: `relay to ${partner}`, kind: "prose" }],
  });
}

/** Open rows in the cross ledger, with the append-only fold applied. */
async function openCrossIds(searchRoot) {
  const raw = await readFile(path.join(searchRoot, "PROPAGATION_CROSS_LEDGER.jsonl"), "utf8");
  const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const events = new Map();
  for (const r of rows) if (r.type !== "status_change") events.set(r.id, { ...r });
  for (const r of rows) {
    if (r.type === "status_change" && events.has(r.id)) events.get(r.id).status = r.status;
  }
  return [...events.values()].filter((r) => r.status === "open").map((r) => r.id).sort();
}

async function makeFixture() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "drain-cross-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "drain-cross-state-"));
  const ws = path.join(searchRoot, "ws");
  await mkdir(path.join(ws, "docs"), { recursive: true });
  await writeFile(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n");
  await writeFile(path.join(ws, "docs", "PROPAGATION_LEDGER.jsonl"), "");

  await writeFile(
    path.join(searchRoot, "PROPAGATION_CROSS_LEDGER.jsonl"),
    [crossRow("006", "SSJK"), crossRow("007", "SSJK"), crossRow("008", "Motherboard")].join("\n") + "\n",
  );

  return { searchRoot, stateDir, ws, env: { searchRoot, stateDir, cwd: ws } };
}

test("drain --cross lists the cross-repo rows", async (t) => {
  const { searchRoot, stateDir, env } = await makeFixture();
  t.after(() => Promise.all([rm(searchRoot, { recursive: true, force: true }),
                             rm(stateDir, { recursive: true, force: true })]));

  const r = runCli(["drain", "--cross"], env);
  assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
  for (const id of ["006", "007", "008"]) {
    assert.match(r.stdout, new RegExp(id), `row ${id} must be listed`);
  }
});

test("a cross row listed by --cross is closable through --cross", async (t) => {
  const { searchRoot, stateDir, env } = await makeFixture();
  t.after(() => Promise.all([rm(searchRoot, { recursive: true, force: true }),
                             rm(stateDir, { recursive: true, force: true })]));

  assert.deepEqual(await openCrossIds(searchRoot), ["006", "007", "008"], "precondition");

  const r = runCli(["drain", "--cross", "--close", "006", "--status", "done"], env);
  assert.equal(r.status, 0, `close exited ${r.status}: ${r.stderr}${r.stdout}`);

  // Re-read the store. The command's own success message is a claim about the
  // write, not the write.
  assert.deepEqual(
    await openCrossIds(searchRoot), ["007", "008"],
    "006 must have actually left the open set",
  );
});

test("closing several cross rows at once works, which is the real workload", async (t) => {
  const { searchRoot, stateDir, env } = await makeFixture();
  t.after(() => Promise.all([rm(searchRoot, { recursive: true, force: true }),
                             rm(stateDir, { recursive: true, force: true })]));

  const r = runCli(
    ["drain", "--cross", "--close", "006,007,008", "--status", "wontfix",
     "--reason", "relays verified done by reading the partner repo directly"],
    env,
  );
  assert.equal(r.status, 0, `close exited ${r.status}: ${r.stderr}${r.stdout}`);
  assert.deepEqual(await openCrossIds(searchRoot), [], "all three close together");
});

test("without --cross the cross ledger stays out of scope", async (t) => {
  const { searchRoot, stateDir, env } = await makeFixture();
  t.after(() => Promise.all([rm(searchRoot, { recursive: true, force: true }),
                             rm(stateDir, { recursive: true, force: true })]));

  const r = runCli(["drain"], env);
  assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(
    r.stdout, /SSJK/,
    "plain `drain` is the workspace queue; widening it silently would be its own surprise",
  );
  assert.deepEqual(await openCrossIds(searchRoot), ["006", "007", "008"], "and nothing was closed");
});
