/**
 * Build tests/impact-map.json: for each test file, the repo files it depends on.
 *
 * deps = static import closure (static.mjs) UNION what the recorder (record.mjs) saw
 * the test, and every process it spawned, load or read. The union is the standard
 * practice: static misses couplings made at run time (a test that starts cli.mjs and
 * so reaches every module cli.mjs lazy-loads); recording misses branches no run
 * exercised. Each covers the other's blind spot, neither covers both.
 *
 * Runs the same globs as `npm run test:propagate`, with PROPAGATE_STATE_DIR scoped the
 * same way (G56): a bare `node --test` would write to the production ledger.
 *
 * Usage: node scripts/test-impact/map.mjs [--dir <record dir>] [--reuse] [--timeout <ms>]
 *                                          [--allow-red] [--no-write]
 *   --reuse  build the map from an existing --dir instead of running the suite
 */
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, createWriteStream, openSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, MAP_PATH, listTestFiles, readSize } from "./lib.mjs";
import { closure } from "./static.mjs";

const RECORDER = path.join(REPO, "scripts", "test-impact", "record.mjs");

export const TEST_GLOBS = ["tests/**/*.test.mjs", "hooks/**/*.test.mjs"];

/**
 * Parse every <id>.jsonl (+ <id>.hooks.txt) in a record dir into per-owner facts.
 *
 * A file normally holds one process: a header line ({o, pid, test}) then rows ({k, p}). It is split at
 * EVERY header line anyway, because a pid is not unique across a run (a process that execs into node keeps
 * its pid) and recordings named by pid alone once put two processes in one file; the second header was
 * then read as a row with no path and the whole map build crashed (2026-10-17). A row without a string
 * path is counted as malformed and skipped, never fatal: a recorder fault may lose data, it must not
 * lose the map. The hooks file belongs to the file's FIRST process (it is written by that process).
 */
export function readRecordings(dir) {
  const owners = new Map(); // owner -> {deps:Set, spawned, lost, tree, ms}
  let unattributed = 0;
  let processes = 0;
  let malformed = 0;
  const names = readdirSync(dir);
  const isHead = (o) => o && typeof o === "object" && "pid" in o && !("k" in o);
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const parsed = [];
    for (const l of readFileSync(path.join(dir, n), "utf8").split("\n").filter(Boolean)) {
      try { parsed.push(JSON.parse(l)); } catch { malformed++; }
    }
    const hooksName = n.replace(/\.jsonl$/, ".hooks.txt");
    const hooks = names.includes(hooksName)
      ? readFileSync(path.join(dir, hooksName), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [k, p] = l.split("\t");
            return { k, p };
          })
      : [];
    let seg = null;
    const segments = [];
    for (const o of parsed) {
      if (isHead(o)) segments.push((seg = { head: o, rows: [] }));
      else if (seg) seg.rows.push(o);
      else malformed++;
    }
    segments.forEach((s, i) => {
      processes++;
      const { head } = s;
      if (!head.o) {
        unattributed++;
        return;
      }
      let e = owners.get(head.o);
      if (!e) owners.set(head.o, (e = { deps: new Set(), spawned: 0, lost: false, tree: false, ms: 0 }));
      if (head.test) e.ms = head.ms ?? 0;
      else e.spawned++;
      for (const { k, p: raw } of i === 0 ? [...s.rows, ...hooks] : s.rows) {
        if (typeof raw !== "string") {
          malformed++;
          continue;
        }
        const p = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
        if (k === "m" || k === "r") e.deps.add(p);
        else if (k === "d") e.deps.add(p === "." ? "./" : `${p}/`);
        else if (k === "R") {
          e.deps.add(p === "." ? "**" : `${p}/**`);
          e.tree = true;
        } else if (k === "c") e.lost = true;
        else if (k === "g") e.tree = true;
      }
    });
  }
  return { owners, unattributed, processes, malformed };
}

function gitHead() {
  try {
    return execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function runSuite(dir, timeoutMs) {
  const log = path.join(dir, "suite.log");
  const fd = openSync(log, "w");
  const stateDir = path.join(process.env.TMPDIR || "/tmp", "propagate-test-state");
  const nodeOpts = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--import ${RECORDER}`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--test", ...TEST_GLOBS], {
    cwd: REPO,
    stdio: ["ignore", fd, fd],
    timeout: timeoutMs,
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir, TESTIMPACT_DIR: dir, NODE_OPTIONS: nodeOpts },
  });
  closeSync(fd);
  const out = readFileSync(log, "utf8");
  const num = (k) => Number((out.match(new RegExp(`(?:#|ℹ)\\s*${k}\\s+(\\d+)`)) || [])[1]);
  return { status: r.status, signal: r.signal, wallMs: Date.now() - t0, pass: num("pass"), fail: num("fail"), tests: num("tests"), log };
}

export function buildMap({ dir, suite }) {
  const tests = listTestFiles();
  const { owners, unattributed, processes, malformed } = readRecordings(dir);
  const out = {};
  let staticCount = 0;
  let recordedCount = 0;
  let partial = 0;
  let unresolved = 0;
  for (const t of tests) {
    const c = closure(t);
    unresolved += c.unresolved.length;
    if (c.deps.length > 1) staticCount++;
    const rec = owners.get(t);
    const deps = new Set(c.deps);
    deps.add(t);
    if (rec) {
      for (const d of rec.deps) if (d !== "impact-map.json" && d !== "tests/impact-map.json") deps.add(d);
      if (rec.spawned > 0) recordedCount++;
    }
    const entry = { deps: [...deps].sort(), size: readSize(t) };
    if (rec?.lost || !rec) {
      entry.partial = true;
      partial++;
    }
    if (rec?.tree) entry.tree = true;
    out[t] = entry;
  }
  const header = {
    recordedAt: new Date().toISOString(),
    commit: gitHead(),
    node: process.version,
    tests: tests.length,
    withStaticDeps: staticCount,
    withRecordedSpawnDeps: recordedCount,
    partial,
    unattributedProcesses: unattributed,
    malformedRecords: malformed,
    recordedProcesses: processes,
    unresolvedStaticSpecifiers: unresolved,
    suite: suite ? { pass: suite.pass, fail: suite.fail } : undefined,
  };
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  return { header, tests: sorted, owners };
}

function main() {
  const a = process.argv.slice(2);
  const flag = (n) => a.includes(n);
  const val = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const dir = val("--dir") ? path.resolve(val("--dir")) : mkdtempSync(path.join(os.tmpdir(), "testimpact-"));
  mkdirSync(dir, { recursive: true });
  let suite;
  if (!flag("--reuse")) {
    suite = runSuite(dir, Number(val("--timeout") || 600000));
    console.log(`suite: exit=${suite.status} signal=${suite.signal} wall=${(suite.wallMs / 1000).toFixed(1)}s pass=${suite.pass} fail=${suite.fail} log=${suite.log}`);
    if ((suite.status !== 0 || suite.fail > 0) && !flag("--allow-red")) {
      console.error("suite is not green — a red run lacks the deps of whatever aborted, so the map is NOT written (--allow-red to override)");
      process.exit(1);
    }
  }
  const { header, tests, owners } = buildMap({ dir, suite });
  const durations = Object.fromEntries([...owners].map(([k, v]) => [k, v.ms]));
  writeFileSync(path.join(dir, "durations.json"), JSON.stringify(durations, null, 1));
  if (header.recordedProcesses < 50) {
    console.error(`only ${header.recordedProcesses} recorded processes — the recorder has gone blind, it has not found a small suite`);
    process.exit(2);
  }
  console.log(JSON.stringify(header, null, 1));
  if (!flag("--no-write")) {
    writeFileSync(MAP_PATH, JSON.stringify({ header, tests }, null, 1) + "\n");
    console.log(`wrote ${path.relative(REPO, MAP_PATH)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
