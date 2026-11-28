/**
 * `.lane-checks` (propagate#453): the checks a lane must run before it reports, declared per repo at its git root,
 * the way `.test-queue` opts a repo into the queue. Format, settled with the first two adopting repos:
 *   <test path>      one per line, run with the repo's own test runner
 *   run: <command>   a shell command run from the repo root; exit 0 passes
 *   # comment        and blank lines are ignored
 * A listed path that does not exist, a `run:` command that cannot start, and a file with no entries all give exit 2:
 * a blind list is not a pass (rule:discernment-checks §2). GATES NEVER READ THIS FILE. It is the lane's own
 * pre-report check; a gate keeps its own selection.
 *
 * EXIT. 0 every entry passed; 1 an entry ran and failed; 2 could not run (a missing path, a command that cannot
 * start, an empty list). 2 outranks 1: a list that could not be run in full is never reported as merely failing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const LANE_CHECKS_FILE = ".lane-checks";

/**
 * @param {string} text file contents
 * @returns {Array<{kind: "test", path: string, line: number}|{kind: "run", cmd: string, line: number}|{kind: "bad", raw: string, line: number}>}
 */
export function parseLaneChecks(text) {
  const entries = [];
  String(text ?? "").split(/\r?\n/).forEach((raw, i) => {
    const s = raw.trim();
    if (!s || s.startsWith("#")) return;
    const m = /^run:[ \t]*(.*)$/.exec(s);
    if (m) entries.push(m[1].trim() ? { kind: "run", cmd: m[1].trim(), line: i + 1 } : { kind: "bad", raw: s, line: i + 1 });
    else entries.push({ kind: "test", path: s, line: i + 1 });
  });
  return entries;
}

/** The repo's `.lane-checks` text, or null when there is none (the hook then enforces nothing). */
export function readLaneChecks(root) {
  try {
    return readFileSync(path.join(root, LANE_CHECKS_FILE), "utf8");
  } catch {
    return null;
  }
}

/**
 * The test command for this repo: `npm test --` only when package.json's test script IS a path-taking runner
 * (vitest, jest or mocha), else `node --test`. A composite script (propagate's runs two whole suites) would turn a
 * one-path entry into the full suite, which the first live run of this very file did; anything else uses `run:`.
 */
function testRunner(root) {
  try {
    const t = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))?.scripts?.test;
    if (typeof t === "string" && t.trim() && /^(vitest|jest|mocha)\b/.test(t.trim())) return { cmd: "npm", args: ["test", "--"] };
  } catch {
    /* no package.json: node's runner */
  }
  return { cmd: process.execPath, args: ["--test"] };
}

/**
 * Run every entry of `root`'s `.lane-checks`.
 * @param {string} root the repo root
 * @param {{env?: object}} [opts]
 * @returns {{exit: 0|1|2, entries: Array<{entry: string, status: "pass"|"fail"|"error", detail?: string}>, reason?: string}}
 */
export function runLaneChecks(root, opts = {}) {
  const text = readLaneChecks(root);
  if (text === null) return { exit: 2, entries: [], reason: `no ${LANE_CHECKS_FILE} at ${root}` };
  const parsed = parseLaneChecks(text);
  if (parsed.length === 0) return { exit: 2, entries: [], reason: `${LANE_CHECKS_FILE} lists nothing: a blind list is not a pass` };
  // G56: a test run must not write the real state dir.
  const env = { ...process.env, ...(opts.env ?? {}) };
  delete env.NODE_TEST_CONTEXT; // inside a `node --test` run a nested one reports to its parent and exits 0 whatever it finds
  if (!env.PROPAGATE_STATE_DIR) env.PROPAGATE_STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "lane-checks-"));
  const runner = testRunner(root);

  const entries = [];
  for (const e of parsed) {
    if (e.kind === "bad") {
      entries.push({ entry: e.raw, status: "error", detail: `line ${e.line}: \`run:\` with no command` });
    } else if (e.kind === "test") {
      if (!existsSync(path.resolve(root, e.path))) {
        entries.push({ entry: e.path, status: "error", detail: `line ${e.line}: path does not exist` });
        continue;
      }
      const r = spawnSync(runner.cmd, [...runner.args, e.path], { cwd: root, env, encoding: "utf8", timeout: 590000 });
      entries.push(settle(e.path, r));
    } else {
      const r = spawnSync(e.cmd, { cwd: root, env, shell: true, encoding: "utf8", timeout: 590000 });
      // The shell reports a command it cannot start as 127 (not found) or 126 (not executable).
      entries.push(settle(`run: ${e.cmd}`, r, true));
    }
  }
  const exit = entries.some((x) => x.status === "error") ? 2 : entries.some((x) => x.status === "fail") ? 1 : 0;
  return { exit, entries };
}

function settle(entry, r, viaShell = false) {
  if (r.error) return { entry, status: "error", detail: `could not start: ${r.error.code ?? r.error.message}` };
  if (viaShell && (r.status === 126 || r.status === 127)) return { entry, status: "error", detail: `could not start (shell exit ${r.status})` };
  if (r.status === 0) return { entry, status: "pass" };
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
  return { entry, status: "fail", detail: `exit ${r.status ?? r.signal}${tail ? `\n${tail}` : ""}` };
}

/** The repo root containing `dir` (nearest ancestor with a `.git` entry), or null. */
export function gitRootOf(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}
