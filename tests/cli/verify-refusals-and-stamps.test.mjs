/**
 * verify's refusals print the command that fixes them, and its events say who
 * pressed the key.
 *
 * - DIVERGED refusal: keeps "a human must look at both sides first" AND prints
 *   a `verify --edge … --disposition both-reconciled --reason …` that parses.
 * - out-of-order refusal: leads with the UPSTREAM's own verify command, then
 *   `--out-of-order`. The printed command is run, not just matched -- a refusal
 *   hint that does not parse is worse than none.
 * - `--apply` writes exactly one event, read back by id, carrying `executed_by`
 *   and `session_id`; `by_kind` keeps meaning who DECIDED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeChain, runCli, storeSnapshot, cleanup } from "../helpers/verify-fixture.mjs";
import { REASON_PLACEHOLDER, REASON_PLACEHOLDER_BOTH } from "../../lib/edges/disposition.mjs";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

/** Run a printed `propagate …` command through a real shell, minus --apply. */
function runPrinted(cmd, env, { reason = `it's a "quoted" reason $HOME` } = {}) {
  const quoted = `'${reason.replace(/'/g, `'\\''`)}'`;
  const line = cmd
    .replace(`'${REASON_PLACEHOLDER}'`, quoted)
    .replace(`'${REASON_PLACEHOLDER_BOTH}'`, quoted)
    .replace(/^propagate /, `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} `)
    .replace(/ --apply$/, "");
  return spawnSync("sh", ["-c", line], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: env.searchRoot, PROPAGATE_STATE_DIR: env.stateDir },
  });
}

test("the out-of-order refusal leads with the upstream's own command, then --out-of-order — and the command parses", async () => {
  const f = await makeChain();
  try {
    const r = runCli(["verify", "--edge", f.edgeBC.edge_id, "--disposition", "no-change-needed", "--reason", "x"], f.env);
    assert.equal(r.status, 3);
    const err = r.stderr;
    const upstream = err.indexOf(`propagate verify --edge ${f.edgeAB.edge_id}`);
    const override = err.indexOf("--out-of-order");
    assert.ok(upstream > -1, `the upstream's own verify command must appear:\n${err}`);
    assert.ok(override > upstream, "the upstream command comes BEFORE the --out-of-order escape");

    // Run the printed command for real: it must parse (exit 0 dry-run, not 2).
    const printed = err.split("\n").find((l) => l.includes(`propagate verify --edge ${f.edgeAB.edge_id}`)).trim();
    const ran = runPrinted(printed.replace("<disposition>", "no-change-needed"), f.env);
    assert.equal(ran.status, 0, `printed upstream command did not parse/run:\n${printed}\n${ran.stderr}`);
    assert.match(ran.stdout, /would write 1 event/);

    // --json carries the same commands.
    const j = JSON.parse(runCli(["verify", "--edge", f.edgeBC.edge_id, "--disposition", "no-change-needed", "--json"], f.env).stdout);
    assert.ok(j.fix_first.some((c) => c.includes(`--edge ${f.edgeAB.edge_id}`)));
    assert.ok(j.fix_first.every((c) => !c.includes("--glob")));
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("the DIVERGED refusal keeps the warning and prints a both-reconciled command that parses", async () => {
  const f = await makeChain();
  try {
    await writeFile(path.join(f.ws, "B.md"), "B v2\n");
    const rows = JSON.parse(runCli(["reconcile", "--all", "--json"], f.env).stdout).rows;
    const ab = rows.find((r) => r.source.path.endsWith("A.md"));
    assert.equal(ab.state, "DIVERGED");

    const r = runCli(["verify", "--edge", ab.edge_id, "--disposition", "propagated", "--reason", "x", "--json"], f.env);
    const refusal = JSON.parse(r.stdout).wouldWrite[0].refusal;
    assert.match(refusal, /a human must look at both sides first/);
    const printed = refusal.split("\n").find((l) => l.includes("run: ")).split("run: ")[1].trim();
    assert.match(printed, /--disposition both-reconciled/);
    assert.match(printed, new RegExp(`--edge ${ab.edge_id}`));
    const ran = runPrinted(printed, f.env);
    assert.equal(ran.status, 0, `printed DIVERGED command did not parse/run:\n${printed}\n${ran.stderr}`);
    assert.match(ran.stdout, /would write 1 event/);
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

function eventsIn(stateDir) {
  const dir = path.join(stateDir, "events");
  return readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((n) => readFileSync(path.join(dir, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

function applyWith(f, extraEnv) {
  const env = { ...process.env, PROPAGATE_SEARCH_ROOTS: f.env.searchRoot, PROPAGATE_STATE_DIR: f.env.stateDir, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, [CLI, "verify", "--edge", f.edgeAB.edge_id, "--disposition", "no-change-needed",
    "--reason", "stamp probe", "--apply", "--json"], { encoding: "utf8", env });
}

test("--apply writes exactly one event, read back by id, stamped agent + session_id under Claude Code; by_kind stays human", async () => {
  const f = await makeChain();
  try {
    const n0 = eventsIn(f.stateDir).length;
    const r = applyWith(f, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sess-test-1", PROPAGATE_BY_KIND: undefined });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.confirmed.length, 1);
    const all = eventsIn(f.stateDir);
    assert.equal(all.length, n0 + 1, "exactly one event");
    const ev = all.find((e) => e.event_id === out.confirmed[0].event_id);
    assert.ok(ev, "read back BY ID, not by line count");
    assert.equal(ev.executed_by, "agent");
    assert.equal(ev.session_id, "sess-test-1");
    assert.equal(ev.by_kind, "human", "by_kind keeps meaning who DECIDED");
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("outside Claude Code the event says executed_by human and carries no session_id", async () => {
  const f = await makeChain();
  try {
    const r = applyWith(f, { CLAUDECODE: undefined, CLAUDE_CODE_SESSION_ID: undefined, PROPAGATE_BY_KIND: undefined });
    assert.equal(r.status, 0, r.stderr);
    const id = JSON.parse(r.stdout).confirmed[0].event_id;
    const ev = eventsIn(f.stateDir).find((e) => e.event_id === id);
    assert.equal(ev.executed_by, "human");
    assert.ok(!("session_id" in ev), "an absent session is absent, not an empty string");
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("a dry run still leaves the store byte-identical", async () => {
  const f = await makeChain();
  try {
    const before = storeSnapshot(f.stateDir);
    runCli(["verify", "--edge", f.edgeAB.edge_id, "--disposition", "no-change-needed", "--reason", "x"], f.env);
    assert.equal(storeSnapshot(f.stateDir), before);
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});
