/**
 * goals-run.mjs: run a goal's `Derived by:` command ONLY when its owner has approved that exact text, and write the
 * `**Resolved:**` line when it passes (propagate#55).
 *
 * WHY A TRUST STORE. `cli/goals.mjs` refused to run these commands at all, for a real reason: a GOALS.md edited by
 * anyone (an agent included) would otherwise become code that runs on this machine. 83 goals were written and none
 * ever closed, because nothing evaluated a condition. The middle path is the `direnv allow` pattern: a command runs
 * only if the SHA-256 of its exact text was approved with `propagate goals allow`. Change one character and it is
 * untrusted again, so an edit cannot smuggle in a different command under an approved goal.
 *
 * Nothing here runs at import time. `parseGoalsFile` (goals.mjs) still never executes anything, and its canary
 * test still holds.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { stateDir } from "../core/paths.mjs";
import { SECTION_RE } from "./handovers.mjs";

export const RUN_TIMEOUT_MS = 120_000;

export const commandHash = (cmd) => createHash("sha256").update(String(cmd)).digest("hex");

export function trustPath(dir = stateDir()) {
  return path.join(dir, "goals", "trusted.json");
}

/** @returns {{entries: object[]}} The store. A missing store is empty, not an error. */
export function readTrust(file = trustPath()) {
  if (!existsSync(file)) return { entries: [] };
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(j.entries)) throw new Error(`${file}: no entries array`);
  return j;
}

export function isTrusted(store, cmd) {
  const h = commandHash(cmd);
  return store.entries.some((e) => e.sha256 === h);
}

/** Record approval of one command's exact text. Idempotent. */
export function allow({ file, goal, cmd, now = new Date(), store = trustPath() }) {
  const t = readTrust(store);
  const h = commandHash(cmd);
  if (!t.entries.some((e) => e.sha256 === h)) {
    t.entries.push({ sha256: h, file, goal: String(goal), approved: now.toISOString().slice(0, 10), command: cmd });
    mkdirSync(path.dirname(store), { recursive: true });
    writeFileSync(store, JSON.stringify(t, null, 2) + "\n");
  }
  return h;
}

/** The repo root a GOALS.md belongs to: commands are written relative to it. Falls back to the file's directory. */
export function repoRoot(file) {
  const r = spawnSync("git", ["-C", path.dirname(file), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : path.dirname(file);
}

/**
 * Run one approved command. Pure of trust: the CALLER must have checked isTrusted.
 *
 * On a timeout the command's WHOLE process group dies, not only bash. spawnSync's timeout signals bash alone, so a
 * suite's children (flutter_tester, dart, a native build) would outlive it unseen; and spawnSync does not support
 * `detached`, so node cannot make the group itself (tried first: kill(-pid) found no group, and the test stayed
 * red). So bash does it: `set -m` gives the command its own process group, and a TERM trap kills that group.
 * Measured 2026-11-13: a Flutter oracle suite overran 120 s on a loaded machine.
 */
export const groupWrapped = (cmd) =>
  `set -m\n( ${cmd}\n) &\np=$!\ntrap 'kill -KILL -- -$p 2>/dev/null; exit 143' TERM\nwait $p`;

export function runDerived(cmd, cwd, { timeout = RUN_TIMEOUT_MS, spawn = spawnSync } = {}) {
  const r = spawn("bash", ["-c", groupWrapped(cmd)], { cwd, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  const tail = (s) => String(s ?? "").trim().split("\n").slice(-3).join(" | ").slice(0, 300);
  if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM") return { met: false, reason: `timed out after ${timeout / 1000}s` };
  if (r.error) return { met: false, reason: `could not run: ${r.error.code || r.error.message}` };
  return r.status === 0
    ? { met: true, reason: `exited 0${tail(r.stdout) ? `: ${tail(r.stdout)}` : ""}` }
    : { met: false, reason: `exited ${r.status}: ${tail(r.stderr) || tail(r.stdout) || "(no output)"}` };
}

/**
 * Decide, per entry, what check-done does. Pure: (parsed file, trust store) -> plan.
 * outcome: "run" (trusted command) | "untrusted" | "judgement" | "no-command" | "closed" | "parked"
 */
export function planChecks(parsed, store) {
  return parsed.entries.map((e) => {
    if (e.status === "closed") return { ...e, outcome: "closed" };
    if (e.status === "parked") return { ...e, outcome: "parked" };
    if (e.derivation === "waived") return { ...e, outcome: "judgement" };
    if (e.derivation !== "claimed" || !e.command) return { ...e, outcome: "no-command" };
    return { ...e, outcome: isTrusted(store, e.command) ? "run" : "untrusted" };
  });
}

/**
 * Insert one `**Resolved:**` line DIRECTLY under the goal's heading. Not at the section's end: the reader only sees a
 * marker in the first MARKER_WINDOW (3) non-empty lines under a heading (handovers.mjs, added after the window-less
 * parser reported 2 false closes on the live HANDOVERS.md), so a line appended at the end is written and never read.
 * Fence-aware: a heading inside a fenced block is not a section (the N51 lesson recorded in goals.mjs). Returns the
 * new text, or null when the section was not found (never a guess).
 */
export function writeResolved(text, sectionIndex, line) {
  const lines = text.split("\n");
  let fenced = false;
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && SECTION_RE.test(lines[i]) && ++seen === sectionIndex) {
      lines.splice(i + 1, 0, line);
      return lines.join("\n");
    }
  }
  return null;
}
