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

/**
 * failurePath(command) -> {ok, reason?}: a STATIC lint for a `Derived by:` command that can never exit non-zero
 * (propagate#383). check-done reads exit 0 as "met", so a command with no failure path closes its goal on a report.
 * Measured 2026-11-26: two goals' commands printed "38 undeclared of 46" and "1 with neither" and exited 0.
 *
 * CONSERVATIVE BY DESIGN. It finds the DEFINITE no-failure shapes below and nothing else; `ok: true` means "no
 * definite defect found", never "this command is honest". It cannot prove a command can fail, and plain `grep` is
 * left alone because whether its pattern matches a line the command always prints is not decidable statically.
 *
 * Flagged shapes (the pure shell is split at top-level `;`, `&&`, `||`, newline, then `|`):
 *   1. a later statement after `;` or `&&` that is `echo`, `printf` or `true`; or the last statement after `||`
 *      that is `echo`, `printf`, `true` or `:` (swallows the failure);
 *   2. the last stage of a pipeline (two or more stages) is tail, head, cat, sort, wc or tee, or `grep -c`;
 *   3. the last stage is an inline `node -e` program with no exit path producing 1 (a `process.exit(` argument
 *      other than a literal 0 or 2, an `exitCode`, or a `throw`), or an `awk` program with no `exit` other
 *      than a bare one, `exit 0` or `exit 2`.
 */
function splitTop(cmd) {
  const src = String(cmd).replace(/\\\n/g, " ");
  const out = []; // {sep, text}
  let cur = "";
  let sep = "";
  let q = null;
  let depth = 0;
  const flush = (next) => {
    out.push({ sep, text: cur.trim() });
    cur = "";
    sep = next;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') cur += src[++i] ?? "";
      else if (c === q) q = null;
      continue;
    }
    if (c === "\\") {
      cur += c + (src[++i] ?? "");
    } else if (c === "'" || c === '"' || c === "`") {
      q = c;
      cur += c;
    } else if (c === "(") {
      depth++;
      cur += c;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (depth === 0 && c === "#" && /\s|^$/.test(src[i - 1] ?? "")) {
      while (i < src.length && src[i] !== "\n") i++;
      i--;
    } else if (depth === 0 && c === ";") flush(";");
    else if (depth === 0 && c === "\n") flush(";");
    else if (depth === 0 && c === "&" && src[i + 1] === "&") {
      flush("&&");
      i++;
    } else if (depth === 0 && c === "|" && src[i + 1] === "|") {
      flush("||");
      i++;
    } else cur += c;
  }
  flush("");
  return out.filter((x) => x.text !== "");
}

/** Pipeline stages of one statement: split at a single top-level `|` (not `||`, not inside quotes or parens). */
function stagesOf(stmt) {
  const out = [];
  let cur = "";
  let q = null;
  let depth = 0;
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') cur += stmt[++i] ?? "";
      else if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === "`") {
      q = c;
      cur += c;
    } else if (c === "(") {
      depth++;
      cur += c;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (depth === 0 && c === "|") out.push((cur = cur.trim())), (cur = "");
    else cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

const word0 = (s) => (s.match(/^(?:\w+=\S*\s+)*(\S+)/)?.[1] ?? "").replace(/^.*\//, "");

export function failurePath(command) {
  const stmts = splitTop(command);
  if (!stmts.length) return { ok: true };
  const last = stmts[stmts.length - 1];
  const w = word0(last.text);
  if (stmts.length > 1) {
    if ((last.sep === ";" || last.sep === "&&") && ["echo", "printf", "true"].includes(w)) {
      return { ok: false, reason: `ends in \`${w}\`, which always exits 0, so the command's own status is lost` };
    }
    if (last.sep === "||" && ["echo", "printf", "true", ":"].includes(w)) {
      return { ok: false, reason: `ends in \`|| ${w}\`, which turns every failure into exit 0` };
    }
  }
  const stages = stagesOf(last.text);
  const tail = stages[stages.length - 1];
  const tw = word0(tail);
  if (stages.length > 1) {
    if (["tail", "head", "cat", "sort", "wc", "tee"].includes(tw)) {
      return { ok: false, reason: `the last pipeline stage is \`${tw}\`, which exits 0 whatever the earlier stages found` };
    }
    if (tw === "grep" && /\s-[a-zA-Z]*c[a-zA-Z]*(\s|$)/.test(tail)) {
      return { ok: false, reason: "`grep -c` prints a count and exits 0 when the count is 0 or large; it does not compare it" };
    }
  }
  if (tw === "node" && /\s(-e|--eval|-p|--print)\s/.test(` ${tail} `)) {
    const exits = /process\.exit\(\s*(?![02]\s*\))/.test(tail) || /exitCode/.test(tail) || /\bthrow\b/.test(tail);
    if (!exits) return { ok: false, reason: "the inline `node -e` program has no exit path producing 1 (no process.exit with a computed code, exitCode or throw)" };
  }
  if (tw === "awk" || tw === "gawk") {
    const codes = [...tail.matchAll(/\bexit\b[ \t]*([^\s;}]*)/g)].map((m) => m[1]);
    if (!codes.some((c) => c !== "" && c !== "0" && c !== "2")) {
      return { ok: false, reason: "the `awk` program has no exit path producing 1 (its only exit is bare, 0 or 2, and 2 means could not run)" };
    }
  }
  return { ok: true };
}

/** Record approval of one command's exact text. Idempotent. */
export function allow({ file, goal, cmd, now = new Date(), store = trustPath(), override = null }) {
  const t = readTrust(store);
  const h = commandHash(cmd);
  if (!t.entries.some((e) => e.sha256 === h)) {
    t.entries.push({ sha256: h, file, goal: String(goal), approved: now.toISOString().slice(0, 10), command: cmd, ...(override ? { override } : {}) });
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
  // The last 3 lines of what the command printed, kept with the verdict so a person can see what was read as a pass.
  const lines = (s) => String(s ?? "").trim().split("\n").filter((l) => l !== "").slice(-3).map((l) => l.slice(0, 200));
  const output_tail = lines(r.stdout).length ? lines(r.stdout) : lines(r.stderr);
  if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM") return { met: false, reason: `timed out after ${timeout / 1000}s`, output_tail: [] };
  if (r.error) return { met: false, reason: `could not run: ${r.error.code || r.error.message}`, output_tail: [] };
  return r.status === 0
    ? { met: true, reason: `exited 0${tail(r.stdout) ? `: ${tail(r.stdout)}` : ""}`, output_tail }
    : { met: false, reason: `exited ${r.status}: ${tail(r.stderr) || tail(r.stdout) || "(no output)"}`, output_tail };
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
