/**
 * The record `release --check` leaves of its own run: one JSON line per run in
 * `<stateDir>/release-checks.jsonl`, with the per-gate result. Before this the only trace was the generic command
 * ledger (exit status and duration), which cannot tell BLOCKED from INCOMPLETE from a usage error, and cannot say which
 * gate failed.
 *
 * WHO WRITES: `releaseCmd` in cli.mjs, after `runReleaseCheck` returns -- never `runReleaseCheck` itself. The release
 * tests call `runReleaseCheck` with fixture repos and must never write state (GOTCHAS G56: a state write that follows the
 * environment is the production-ledger hazard). This module takes `stateDir` as an argument and never resolves it, so
 * no caller can write to the real store by importing it.
 *
 * FORMAT (append-only, one line per run, detail strings stored whole -- they are local state):
 *   {"ts","version","overall","exitCode","gates":[{"name","status","detail"|"reason"}]}
 * `ts` is the result's own `generatedAt`. `raw` (the child process output of a gate) is NOT stored: it can be large and is
 * not part of the verdict.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const RELEASE_CHECKS_FILE = "release-checks.jsonl";

export function releaseChecksPath(stateDir) {
  if (typeof stateDir !== "string" || !stateDir) throw new Error("releaseChecksPath: stateDir is required");
  return path.join(stateDir, RELEASE_CHECKS_FILE);
}

/** The line that gets stored for a result. Pure; exported so a test can state the format. */
export function buildReleaseRecord(result, { version = null } = {}) {
  return {
    ts: result.generatedAt,
    version,
    overall: result.overall,
    exitCode: result.exitCode,
    gates: result.gates.map((g) => {
      const out = { name: g.name, status: g.status };
      if (g.detail != null) out.detail = g.detail;
      if (g.reason != null) out.reason = g.reason;
      return out;
    }),
  };
}

/** Append one run. THROWS on failure -- use `persistReleaseCheck` from a command, which must not fail on it. */
export function recordReleaseCheck(result, { stateDir, version = null } = {}) {
  const file = releaseChecksPath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(file, JSON.stringify(buildReleaseRecord(result, { version })) + "\n");
  return file;
}

/**
 * The command-side wrapper: a failed write is a warning line and nothing else. It cannot change the verdict or the exit
 * code, because the gate result is already settled when this runs. Returns { ok, file?, error? }.
 */
export function persistReleaseCheck(result, { stateDir, version = null, warn = (m) => console.error(m) } = {}) {
  try {
    return { ok: true, file: recordReleaseCheck(result, { stateDir, version }) };
  } catch (err) {
    const error = String(err?.message ?? err);
    try { warn(`warning: could not record this release check in ${stateDir ? releaseChecksPath(stateDir) : RELEASE_CHECKS_FILE}: ${error}`); } catch { /* a warning must not throw */ }
    return { ok: false, error };
  }
}

/**
 * Read every recorded run, oldest first. A line that is not JSON, or not shaped like a record, goes to `bad` with its
 * 1-based line number and the reason -- never skipped silently. A missing file is `{checks: [], bad: [], exists: false}`.
 * Any other read failure THROWS (the caller shows it as an error, not as "nothing recorded").
 */
export function readReleaseChecks({ stateDir } = {}) {
  const file = releaseChecksPath(stateDir);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { checks: [], bad: [], exists: false };
    throw err;
  }
  const checks = [];
  const bad = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let rec;
    try { rec = JSON.parse(line); } catch (err) { bad.push({ line: i + 1, reason: "not JSON: " + String(err?.message ?? err) }); return; }
    if (!rec || typeof rec !== "object" || typeof rec.ts !== "string" || !Number.isFinite(Date.parse(rec.ts)) || !Array.isArray(rec.gates) || typeof rec.overall !== "string") {
      bad.push({ line: i + 1, reason: "not a release record (needs ts, overall and gates)" });
      return;
    }
    checks.push(rec);
  });
  checks.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { checks, bad, exists: true };
}
