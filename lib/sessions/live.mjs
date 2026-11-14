/**
 * The ONLY code in propagate that runs the `claude` binary (propagate#272, Eng finding "the original arrangement spreads
 * CLI knowledge"). create and delete import `runClaude` from here; a test greps lib/ cli/ hooks/ and fails on any other
 * spawn of `claude`.
 *
 * HAZARD: `claude --bg --help` does not print help, it STARTS a session (measured 2026-11-14). Nothing here may pass
 * flags it has not been told to. This lane's only call is `agents --json`.
 *
 * Live state is DERIVED on every read and never cached ("the queue is a view, not a store"). An unknown shape, a
 * non-zero exit, a timeout or a parse failure is a typed failure, NEVER an empty list: an empty list reads as "no
 * sessions" and gets acted on (rule:discernment-checks §6).
 */
import { spawnSync } from "node:child_process";

import { fail } from "./errors.mjs";

export const READ_TIMEOUT_MS = 15000;

/**
 * Run the claude binary. argv array, never a shell string. Honours PROPAGATE_CLAUDE_BIN (the test stub).
 * @param {string[]} args
 * @param {{timeout?: number}} [opts]
 * @returns {{ok: boolean, status: number|null, stdout: string, stderr: string, timedOut: boolean, error: string|null}}
 */
export function runClaude(args, { timeout = READ_TIMEOUT_MS } = {}) {
  const bin = process.env.PROPAGATE_CLAUDE_BIN || "claude";
  const r = spawnSync(bin, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  const timedOut = r.error?.code === "ETIMEDOUT";
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut,
    error: r.error ? (timedOut ? `timed out after ${timeout} ms` : r.error.message) : null,
  };
}

/**
 * The one shape check. Rows must be an array of objects carrying string `cwd`, `kind` and `sessionId` (keys measured
 * 2026-11-14, claude 2.1.311: id, cwd, kind, startedAt, sessionId, name, state, pid, status). doctor reuses this.
 * @returns {{ok: true} | {ok: false, why: string}}
 */
export function checkShape(rows) {
  if (!Array.isArray(rows)) return { ok: false, why: `expected an array, got ${rows === null ? "null" : typeof rows}` };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, why: `row ${i} is not an object` };
    for (const k of ["cwd", "kind", "sessionId"]) {
      if (typeof r[k] !== "string") return { ok: false, why: `row ${i} has no string \`${k}\` (keys: ${Object.keys(r).sort().join(",") || "none"})` };
    }
  }
  return { ok: true };
}

/**
 * The row key: `(kind, id || sessionId, pid)`. `sessionId` is NOT unique: one id appears as both a background and an
 * interactive row, so it is never a key on its own and rows are never deduped on it.
 */
export function rowKeyOf(row) {
  return `${row.kind}:${row.id || row.sessionId}:${row.pid ?? ""}`;
}

/** One normalised row. Interactive rows have no `id` and use `status`; background rows have an `id` and use `state`. */
export function normalizeRow(r) {
  const row = {
    kind: r.kind,
    id: r.id ? String(r.id) : "",
    sessionId: r.sessionId,
    pid: typeof r.pid === "number" ? r.pid : null,
    name: typeof r.name === "string" ? r.name : "",
    cwd: r.cwd,
    startedAt: typeof r.startedAt === "number" ? r.startedAt : null,
    state: String(r.state ?? r.status ?? "unknown"),
    waitingFor: typeof r.waitingFor === "string" ? r.waitingFor : null,
  };
  row.key = rowKeyOf(row);
  return row;
}

/**
 * `claude agents --json`, validated.
 * @param {{timeout?: number, now?: () => number}} [opts]
 * @returns {{ok: true, rows: object[], readAt: string} | {ok: false, code: string, what: string, next: string, side_effects: string[]}}
 */
export function readLive(opts = {}) {
  const envMs = Number(process.env.PROPAGATE_CLAUDE_TIMEOUT_MS);
  const timeout = opts.timeout ?? (envMs > 0 ? envMs : READ_TIMEOUT_MS);
  const r = runClaude(["agents", "--json"], { timeout });
  const cause = r.error ?? (r.status !== 0 ? `exit ${r.status}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]}` : ""}` : null);
  if (cause) {
    return fail("SESSION_READER_FAILED", `could not read claude agents (${cause})`, "run `claude agents --json` yourself; set PROPAGATE_CLAUDE_BIN if claude is not on PATH");
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return fail("SESSION_READER_FAILED", `could not read claude agents (output was not JSON: ${e.message})`, "run `claude agents --json` yourself and check its output");
  }
  const shape = checkShape(parsed);
  if (!shape.ok) {
    return fail("SESSION_SHAPE_UNKNOWN", `claude agents --json shape not understood: ${shape.why}`, "update lib/sessions/live.mjs checkShape for this Claude Code version, then run `propagate doctor`");
  }
  const at = opts.now ? opts.now() : Date.now();
  return { ok: true, rows: parsed.map(normalizeRow), readAt: new Date(at).toISOString() };
}
