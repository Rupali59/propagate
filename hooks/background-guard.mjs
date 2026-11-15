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
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

/** @returns {{deny: boolean, reason?: string}} */
export async function decide(input, load = defaultLoad) {
  if (input?.tool_name !== "Bash") return { deny: false };
  const ti = input.tool_input ?? {};
  const command = String(ti.command ?? "");
  const bg = ti.run_in_background === true;
  const isSub = typeof input.agent_id === "string" && input.agent_id.length > 0;

  const sh = shellBackground(command);
  if (sh) return { deny: true, reason: `a shell \`${sh}\` backgrounds the command out of the harness's sight: use run_in_background, not \`${sh}\`; a shell \`&\` gets no completion notice` };

  if (isSub && bg) return { deny: true, reason: "a subagent runs long commands in the FOREGROUND with an explicit timeout; a backgrounded subagent command has ended, not paused, because its completion notice routes to the parent (rule:delegation-criteria §3)" };

  if (!isSub && !bg) {
    const timeout = Number(ti.timeout);
    if (timeout >= TIMEOUT_MS) return { deny: true, reason: `a foreground timeout of ${timeout} ms (>= ${TIMEOUT_MS}) holds the turn: re-run with run_in_background: true (rule:background-long-runs)` };
    const h = await heavyMatch(command, load);
    if (h) return { deny: true, reason: `\`${h.label}\` takes minutes: re-run with run_in_background: true and keep working; the harness re-invokes you on exit (rule:background-long-runs)` };
  }
  return { deny: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    const d = await decide(input);
    if (d.deny) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `propagate background-guard: ${d.reason}.`,
        },
      }));
    }
  } catch {
    // unreadable payload or a bug here: not ours to judge
  }
  process.exit(0);
}
