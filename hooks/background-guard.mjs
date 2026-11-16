#!/usr/bin/env node
/**
 * PreToolUse (Bash) — enforces rule:background-long-runs and rule:delegation-criteria §3 (propagate#224).
 *
 * WHY A HOOK. The rule was flouted "nearly every session" (Rupali, 2026-11-15) on commands that looked short: a
 * foreground `timeout: 500000` journey, a slow `doctor`, and `npm test > log &`, whose shell `&` hides the job from the
 * harness so no completion notice ever arrives. Prose failed four times; this is the mechanical check.
 *
 * MAIN SESSION VS SUBAGENT. The discriminator is `agent_id`, NOT `agent_type`. Hooks docs, "Common input fields"
 * (https://code.claude.com/docs/en/hooks, fetched 2026-11-15):
 *   agent_id:   "Unique identifier for the subagent or in-process teammate the hook fires in."
 *   agent_type: "Present when the session uses `--agent` or the hook fires inside a subagent."
 * `agent_type` also appears in a main session started with `--agent`, so keying on it would exempt that session.
 * VERIFIED: the two doc lines above. INFERRED, not captured: that `agent_id` is absent in a main session. propagate
 * logs no PreToolUse payload, so no real one was read; the docs imply the absence and do not state it.
 *
 * THE FOUR RULES (a Bash call is judged in this order)
 *   2. Any session: a shell `&` that backgrounds a command, or `nohup`. Deny: use run_in_background.
 *   3. Subagent with run_in_background true. Deny: a backgrounded subagent has ended, not paused.
 *   1. Main session, not run_in_background, and timeout >= 120000 or the command matches HEAVY. Deny: re-run in the
 *      background.
 *   4. Subagents are exempt from rule 1 (they must stay foreground, with a timeout).
 * Not a background `&`: `&&`, `2>&1`, `>&2`, `&>`, and anything inside quotes.
 *
 * FAILS OPEN. An unreadable payload, or any bug here, exits 0 silently: a guard must not wedge the session.
 *
 * THE GUARD LOG (propagate#294). One row per `deny` and per `allow-bg` (a backgrounded main-session call that rule 1
 * would have denied in the foreground), appended to `$PROPAGATE_STATE_DIR/guard/YYYY-MM.jsonl` (UTC month of `ts`):
 *   {ts, session, event, rule, label, program, command_hash, timeout_ms}
 * NEVER COMMAND TEXT. `label` comes from the fixed HEAVY or network table (or `&`/`nohup`), `program` is the bare first
 * word after every NAME=value prefix, and `command_hash` is 16 hex of the sha256 of the whitespace-normalised command. A
 * `SECRET=x npm test` or a `Bearer` header therefore never reaches disk.
 * ORDER: the decision goes to stdout FIRST, then the append runs in its own try. A failed append never changes the
 * decision. `mkdirSync` runs only on that logging path, so an install without `guard/` gets it on its first logged event.
 * The hook never prunes: `lib/guard/log.mjs` does, from the CLI (`day open`).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stateDir as defaultStateDir } from "../lib/core/paths.mjs";

export const TIMEOUT_MS = 120000;

const START = String.raw`^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`; // optional VAR=x prefixes
const PROPAGATE = String.raw`(?:propagate|node\s+\S*cli\.mjs)\s+`;
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * DERIVED: every COMMANDS entry marked `network: true` (it reaches GitHub, so it takes minutes). A new network command
 * is covered by marking it in lib/core/commands.mjs; nothing here is edited (propagate#224, rule:derive-dont-curate).
 * `offline` flags (backlog --offline) exempt a call. The test asserts a floor and that every module calling gh is marked.
 */
export const networkFrom = (commands) => Object.freeze(
  Object.entries(commands)
    .filter(([, c]) => c.network === true)
    .map(([name, c]) => {
      const off = (c.offline ?? []).map(escapeRe);
      const guard = off.length ? String.raw`(?!.*(?:${off.join("|")})(?:\s|$))` : "";
      const words = name.split(" ").map(escapeRe).join(String.raw`\s+`);
      return {
        label: `${name} (reaches GitHub)`,
        re: new RegExp(START + PROPAGATE + words + String.raw`(?=\s|$)` + guard),
        example: `propagate ${name}`,
      };
    }),
);

/**
 * LAZY: the hook runs on every Bash call and importing COMMANDS cost ~57 ms, so it is imported only when the command text
 * could name a propagate command. `load` is injectable so a test can prove a plain command never triggers it.
 */
const NAMES_PROPAGATE = /\b(?:propagate|cli\.mjs)\b/;
let cached;
const defaultLoad = async () => (await import("../lib/core/commands.mjs")).COMMANDS;
export async function networkPatterns(load = defaultLoad) {
  if (load === defaultLoad) return (cached ??= networkFrom(await load()));
  return networkFrom(await load());
}

/**
 * The EXPLICIT EXCEPTIONS: heavy commands that are not a network `propagate` subcommand, so COMMANDS cannot express
 * them. `example` is a command that must match, so a test can iterate the list and assert the floor.
 */
const EXCEPTIONS = [
  { label: "npm test", re: new RegExp(START + String.raw`npm\s+(?:run\s+)?test(?:\s|$)`), example: "npm test" },
  { label: "npm run test:record", re: new RegExp(START + String.raw`npm\s+run\s+test:record\b`), example: "npm run test:record" },
  { label: "release --check", re: new RegExp(START + PROPAGATE + String.raw`release\b.*--check\b`), example: "node cli.mjs release --check" },
  { label: "doctor (without --quick)", re: new RegExp(START + PROPAGATE + String.raw`doctor\b(?!.*--quick)`), example: "propagate doctor" },
  { label: "make-public --check", re: new RegExp(START + String.raw`.*\bmake-public\b.*--check\b`), example: "node cli.mjs make-public repo --check" },
];

/** The literal exceptions only; the derived network patterns come from `networkPatterns()`. */
export const HEAVY = Object.freeze(EXCEPTIONS);

const stripQuotes = (s) => s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, " ");

/** A shell `&` that backgrounds, or nohup. Quotes, `&&`, `2>&1`, `>&2` and `&>` are removed first. */
function shellBackground(command) {
  const bare = stripQuotes(command)
    .replace(/&&/g, " ")
    .replace(/\d*>&\d*-?/g, " ")
    .replace(/&>>?/g, " ");
  if (/(^|[\s;|&(])nohup(\s|$)/.test(bare)) return "nohup";
  return bare.includes("&") ? "&" : null;
}

const heavyMatch = async (command, load) => {
  const segs = stripQuotes(command).split(/&&|\|\||;|\||\n/).map((s) => s.trim());
  const hit = (list) => list.find((h) => segs.some((s) => h.re.test(s)));
  return hit(HEAVY) ?? (NAMES_PROPAGATE.test(command) ? hit(await networkPatterns(load)) : undefined);
};

/**
 * The full judgement: the decision plus what the log needs. `event` is "deny", "allow-bg" or null (nothing to log);
 * `rule` is timeout | heavy | shell-bg | sub-bg; `label` is a fixed-table label or null. Never any command text.
 * @returns {Promise<{deny: boolean, reason?: string, event: string|null, rule?: string, label?: string|null}>}
 */
export async function judge(input, load = defaultLoad) {
  if (input?.tool_name !== "Bash") return { deny: false, event: null };
  const ti = input.tool_input ?? {};
  const command = String(ti.command ?? "");
  const bg = ti.run_in_background === true;
  const isSub = typeof input.agent_id === "string" && input.agent_id.length > 0;

  const sh = shellBackground(command);
  if (sh) return { deny: true, event: "deny", rule: "shell-bg", label: sh, reason: `a shell \`${sh}\` backgrounds the command out of the harness's sight: use run_in_background, not \`${sh}\`; a shell \`&\` gets no completion notice` };

  if (isSub && bg) return { deny: true, event: "deny", rule: "sub-bg", label: null, reason: "a subagent runs long commands in the FOREGROUND with an explicit timeout; a backgrounded subagent command has ended, not paused, because its completion notice routes to the parent (rule:delegation-criteria §3)" };

  if (!isSub) {
    // A backgrounded call is matched too (still lazy behind NAMES_PROPAGATE), so the log can show the rule being followed.
    const event = bg ? "allow-bg" : "deny";
    const timeout = Number(ti.timeout);
    if (timeout >= TIMEOUT_MS) {
      const r = { event, rule: "timeout", label: null };
      return bg ? { deny: false, ...r } : { deny: true, ...r, reason: `a foreground timeout of ${timeout} ms (>= ${TIMEOUT_MS}) holds the turn: re-run with run_in_background: true (rule:background-long-runs)` };
    }
    const h = await heavyMatch(command, load);
    if (h) {
      const r = { event, rule: "heavy", label: h.label };
      return bg ? { deny: false, ...r } : { deny: true, ...r, reason: `\`${h.label}\` takes minutes: re-run with run_in_background: true and keep working; the harness re-invokes you on exit (rule:background-long-runs)` };
    }
  }
  return { deny: false, event: null };
}

/** @returns {Promise<{deny: boolean, reason?: string}>} the decision only, the shape this hook has always returned. */
export async function decide(input, load = defaultLoad) {
  const j = await judge(input, load);
  return j.deny ? { deny: true, reason: j.reason } : { deny: false };
}

/**
 * The bare program: the BASENAME of the first word after every NAME=value token, kept only if it is a plain name.
 * Never a value, and never a path: `/home/<name>/bin/x` would carry a home directory and a username into the log.
 */
export function programOf(command) {
  const words = String(command ?? "").trim().split(/\s+/).filter(Boolean);
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const base = first?.slice(first.lastIndexOf("/") + 1);
  return base && /^[\w.-]{1,32}$/.test(base) ? base : null;
}

/** One log row. The only derivatives of the command text are its program name and a truncated hash. */
export function guardRow(input, j, now = new Date()) {
  const ti = input?.tool_input ?? {};
  const command = String(ti.command ?? "");
  const timeout = Number(ti.timeout);
  return {
    ts: now.toISOString(),
    session: typeof input?.session_id === "string" ? input.session_id : null,
    event: j.event,
    rule: j.rule,
    label: j.label ?? null,
    program: programOf(command),
    command_hash: createHash("sha256").update(command.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 16),
    timeout_ms: Number.isFinite(timeout) ? timeout : null,
  };
}

/** ONE write per row (O_APPEND keeps a whole write intact). The directory is created here, on the first logged event. */
export function appendGuardRow(row, dir = defaultStateDir()) {
  const d = path.join(dir, "guard");
  mkdirSync(d, { recursive: true });
  appendFileSync(path.join(d, `${row.ts.slice(0, 7)}.jsonl`), JSON.stringify(row) + "\n");
}

const denyJson = (reason) => JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `propagate background-guard: ${reason}.`,
  },
});

/**
 * Decide, write the decision, THEN log. The order is the contract: the append is attempted only after the deny is on
 * stdout, in its own try, so a full disk or an unwritable state dir can never turn a deny into an allow.
 * Every dependency is injectable for the tests; the defaults are the real stdout, the real append and the clock.
 */
export async function respond(input, { load = defaultLoad, write = (s) => process.stdout.write(s), append = appendGuardRow, stateDir, now = () => new Date() } = {}) {
  const j = await judge(input, load);
  if (j.deny) write(denyJson(j.reason));
  if (j.event) {
    try {
      append(guardRow(input, j, now()), stateDir ?? defaultStateDir());
    } catch {
      // the log is evidence, never a gate: a failed append leaves the decision as written
    }
  }
  return j;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    await respond(input);
  } catch {
    // unreadable payload or a bug here: not ours to judge
  }
  process.exit(0);
}
