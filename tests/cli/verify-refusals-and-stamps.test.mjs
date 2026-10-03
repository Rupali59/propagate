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
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeChain, runCli, storeSnapshot, cleanup, git } from "../helpers/verify-fixture.mjs";
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

// ── N118: `decoupled` on a glob match ─────────────────────────────────────────
//
// `decoupled` splices the WHOLE `propagates_to` entry. On a glob declaration that
// unwatches every sibling the glob matches while the event names one edge. The guard
// refuses; the test measures the SIDE EFFECTS (sidecar bytes, event store), never the
// refusal text alone (rule:safety-flag-needs-a-test). Run across every flag shape that
// reaches the unsafe path: dry run, --apply, --json, and a mixed --node batch.

async function makeGlobFixture(entries) {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const searchRoot = await mkdtemp(path.join(tmpdir(), "n118-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "n118-state-"));
  const ws = path.join(searchRoot, "ws");
  await mkdir(path.join(ws, "stubs"), { recursive: true });
  git(["init", "-q", "-b", "main"], ws);
  git(["config", "user.email", "t@example.com"], ws);
  git(["config", "user.name", "T"], ws);
  await writeFile(path.join(ws, "src.md"), "src v1\n");
  await writeFile(path.join(ws, "lit.md"), "lit v1\n");
  for (const n of ["a", "b", "c"]) await writeFile(path.join(ws, "stubs", `${n}.md`), `${n} v1\n`);
  const sidecar = path.join(ws, ".propagates.yml");
  await writeFile(sidecar, `workspace: true\nsources:\n  src.md:\n    propagates_to:\n${entries}`);
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "init"], ws);
  const env = { searchRoot, stateDir };
  return { searchRoot, stateDir, ws, sidecar, env };
}

test("N118: decoupled on a glob-matched edge is refused and neither the sidecar nor the event store changes", async () => {
  const f = await makeGlobFixture(
    `      - path: "stubs/*.md"\n        why: "stub glob"\n      - path: lit.md\n        why: "literal pairing"\n`,
  );
  try {
    const rows = JSON.parse(runCli(["reconcile", "--all", "--json"], f.env).stdout).rows;
    const globRows = rows.filter((r) => r.glob === "stubs/*.md");
    assert.equal(globRows.length, 3, "control: the glob matched three files");
    const target = globRows.find((r) => r.downstream.path.endsWith("a.md"));
    const litRow = rows.find((r) => r.downstream.path.endsWith("lit.md"));

    // Put a real event in the store so "unchanged" is not comparing empty to empty.
    const base = runCli(["verify", "--edge", globRows.find((r) => r.downstream.path.endsWith("c.md")).edge_id,
      "--disposition", "baselined", "--reason", "seed", "--apply", "--json"], f.env);
    assert.equal(base.status, 0, base.stderr);

    const sidecarBefore = readFileSync(f.sidecar, "utf8");
    const storeBefore = storeSnapshot(f.stateDir);
    assert.notEqual(storeBefore, "", "control: the store holds a seeded event");

    const shapes = [
      { name: "dry run", argv: ["--edge", target.edge_id] },
      { name: "--apply", argv: ["--edge", target.edge_id, "--apply", "--reason", "x"] },
      { name: "--apply --json", argv: ["--edge", target.edge_id, "--apply", "--reason", "x", "--json"] },
      { name: "--json dry run", argv: ["--edge", target.edge_id, "--json"] },
      // Mixed batch: the literal edge shares the node with the glob rows. The literal one
      // must NOT be decoupled either — a half-applied batch is the narrow-ledger,
      // wide-sidecar disagreement this guard exists to prevent.
      { name: "mixed --node batch --apply", argv: ["--node", target.node_id, "--apply", "--reason", "x", "--json"] },
    ];
    for (const sh of shapes) {
      const r = runCli(["verify", "--disposition", "decoupled", ...sh.argv], f.env);
      assert.equal(r.status, 3, `${sh.name}: must exit 3\n${r.stdout}\n${r.stderr}`);
      assert.equal(readFileSync(f.sidecar, "utf8"), sidecarBefore, `${sh.name}: sidecar must be byte-identical`);
      assert.equal(storeSnapshot(f.stateDir), storeBefore, `${sh.name}: event store must be unchanged`);
      const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(out, /2 sibling edge\(s\)/, `${sh.name}: the refusal must name the sibling count\n${out}`);
      assert.match(out, /exclude:/, `${sh.name}: and point at exclude:\n${out}`);
      if (sh.argv.includes("--json")) {
        const j = JSON.parse(r.stdout.trim());
        assert.equal(j.exitCode, 3);
        assert.ok(j.results.some((x) => x.refused && x.edge_id === target.edge_id));
        assert.ok(!j.results.some((x) => x.ok), `${sh.name}: nothing in the batch may succeed`);
      }
    }
    // The literal edge really is decouple-able on its own (so the batch refusal above
    // was the glob's doing, not a blanket refusal).
    const lit = runCli(["verify", "--edge", litRow.edge_id, "--disposition", "decoupled"], f.env);
    assert.equal(lit.status, 0, `a literal edge's dry-run decouple still succeeds:\n${lit.stdout}${lit.stderr}`);
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});

test("N118: decoupling an UNMATCHED glob (one that watches nothing) is still allowed", async () => {
  const f = await makeGlobFixture(
    `      - path: "nowhere/*.md"\n        why: "dead glob"\n      - path: lit.md\n        why: "literal pairing"\n`,
  );
  try {
    const rows = JSON.parse(runCli(["reconcile", "--all", "--json"], f.env).stdout).rows;
    const dead = rows.find((r) => r.glob === "nowhere/*.md");
    assert.equal(dead.state, "UNMATCHED");
    const dry = runCli(["verify", "--edge", dead.edge_id, "--disposition", "decoupled", "--json"], f.env);
    assert.equal(dry.status, 0, `dry run must not be refused:\n${dry.stdout}\n${dry.stderr}`);
    const r = runCli(["verify", "--edge", dead.edge_id, "--disposition", "decoupled", "--apply", "--reason", "dead glob", "--json"], f.env);
    // NOT asserting exit 0: today the sidecar edit lands and then the event write fails
    // (an UNMATCHED row has no source_content to pin) -> exit 1. That is a pre-existing
    // defect filed as N119, and pinning its exit code here would cement it. What THIS
    // test owns is that the N118 guard does not refuse it (exit 3) and the edit lands.
    assert.notEqual(r.status, 3, `the N118 guard must not refuse an UNMATCHED glob:\n${r.stdout}\n${r.stderr}`);
    const raw = readFileSync(f.sidecar, "utf8");
    assert.ok(!raw.includes("nowhere/*.md"), "the dead glob declaration is gone");
    assert.ok(raw.includes("lit.md"), "the sibling declaration survives");
  } finally {
    await cleanup(f.searchRoot, f.stateDir);
  }
});
