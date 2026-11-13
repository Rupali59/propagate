#!/usr/bin/env node
/**
 * PreToolUse (ExitPlanMode) — a plan must name an active goal (propagate#244 goal clause, G3 Done-when 2).
 *
 * THE RULE. The plan carries a line `Goal: G<n>` (bold or plain, any case) and G<n> is ACTIVE in the discovered
 * GOALS.md files (lib/report/goals.mjs `active`, the same definition `goals check` uses). Otherwise a line
 * `goal_reason: <why>` is the sanctioned escape. Neither: DENY, naming the active ids and both fixes.
 * Each allowed approval appends one row to `<stateDir>/plans/approvals.jsonl`; `goals check` reads the last 7 days.
 *
 * PLAN TEXT. `tool_input.plan` when it is a non-empty string; otherwise the newest `*.md` modified in the last
 * 15 minutes in the plans directory (`plansDirectory` in $HOME/.claude/settings.json, else $HOME/.claude/plans).
 * HOME comes from the environment so tests can point it at a temp dir.
 *
 * NEVER BLOCKS ON ITS OWN BLINDNESS (matches `day close`): no plan text, no readable active goal, or any exception
 * ALLOWS the approval and says so in additionalContext (rule:discernment-checks §2).
 *
 * TEST SEAM. PROPAGATE_GOALS_FILES is a path-delimited (`:` on POSIX) list of GOALS.md files that replaces
 * discoverBacklogFiles().goalsMd, so a test never walks the real tree.
 *
 * Acts only on ExitPlanMode; every other tool exits 0 with no output. Exit code is always 0.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PLAN_WINDOW_MS = 15 * 60 * 1000;
const GOAL_LINE = /^\s*\**\s*goal\s*:?\s*\**\s*:?\s*(G\d+)\b/im;
const REASON_LINE = /^\s*goal_reason:[ \t]*(\S.*)$/im;

/** The pure decision. @returns {{deny?: string, goal: string|null, reason: string|null, log: boolean}} */
export function decide(planText, activeIds) {
  const out = { goal: null, reason: null, log: false };
  const named = GOAL_LINE.exec(planText)?.[1]?.toUpperCase() ?? null;
  if (named && activeIds.includes(named)) {
    out.goal = named;
    out.log = true;
    return out;
  }
  const reason = REASON_LINE.exec(planText)?.[1].trim() ?? null;
  if (reason) {
    out.reason = reason;
    out.log = true;
    return out;
  }
  const why = named ? `names ${named}, which is not active` : "names no goal";
  out.deny =
    `this plan ${why} (active: ${activeIds.join(", ")}). ` +
    "Add a line `Goal: G<n>` naming an active goal, or a line `goal_reason: <why>` for work outside the cycle.";
  return out;
}

/** The newest *.md modified within PLAN_WINDOW_MS of `now`, or null. */
export function newestPlan(dir, now = Date.now()) {
  let best = null;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (!n.endsWith(".md")) continue;
    const f = path.join(dir, n);
    try {
      const st = statSync(f);
      if (st.isFile() && now - st.mtimeMs <= PLAN_WINDOW_MS && (!best || st.mtimeMs > best.mtimeMs)) best = { file: f, mtimeMs: st.mtimeMs };
    } catch {
      /* raced away */
    }
  }
  return best?.file ?? null;
}

function plansDir(home) {
  try {
    const s = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    if (typeof s.plansDirectory === "string" && s.plansDirectory.trim()) {
      const d = s.plansDirectory.trim();
      if (d === "~") return home;
      if (d.startsWith("~/")) return path.join(home, d.slice(2));
      return path.isAbsolute(d) ? d : path.join(home, d);
    }
  } catch {
    /* no settings: the default */
  }
  return path.join(home, ".claude", "plans");
}

async function activeGoalIds() {
  const { parseGoalsFile, goalId } = await import("../lib/report/goals.mjs");
  let files;
  if (process.env.PROPAGATE_GOALS_FILES !== undefined) files = process.env.PROPAGATE_GOALS_FILES.split(path.delimiter).filter(Boolean);
  else files = (await import("../lib/report/backlog.mjs")).discoverBacklogFiles().goalsMd ?? [];
  const ids = [];
  for (const f of files) {
    const p = parseGoalsFile(f);
    if (p.unread) continue;
    for (const e of p.entries) if (e.active && !ids.includes(goalId(e))) ids.push(goalId(e));
  }
  return ids;
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0);
  }
  if (input?.tool_name !== "ExitPlanMode") process.exit(0);
  const emit = (hookSpecificOutput) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...hookSpecificOutput } }));
  try {
    const home = process.env.HOME || homedir();
    let text = null;
    let source = "tool_input";
    const inline = input?.tool_input?.plan;
    if (typeof inline === "string" && inline.trim()) text = inline;
    else {
      const f = newestPlan(plansDir(home));
      if (f) {
        text = readFileSync(f, "utf8");
        source = f;
      }
    }
    if (text === null) {
      emit({ additionalContext: "propagate plan-goal: plan goal not checked: no plan text found" });
      process.exit(0);
    }
    const ids = await activeGoalIds();
    if (!ids.length) {
      emit({ additionalContext: "propagate plan-goal: plan goal not checked: no active goal was read" });
      process.exit(0);
    }
    const d = decide(text, ids);
    if (d.deny) {
      emit({ permissionDecision: "deny", permissionDecisionReason: `propagate plan-goal: ${d.deny}` });
      process.exit(0);
    }
    const { stateDir } = await import("../lib/core/paths.mjs");
    const dir = path.join(stateDir(), "plans");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const row = d.goal ? { ts, plan: source, goal: d.goal } : { ts, plan: source, goal: null, reason: d.reason };
    appendFileSync(path.join(dir, "approvals.jsonl"), JSON.stringify(row) + "\n");
    emit({ additionalContext: `propagate plan-goal: ${d.goal ? `plan names active goal ${d.goal}` : `goal_reason override recorded (${d.reason})`}` });
  } catch (e) {
    emit({ additionalContext: `propagate plan-goal: hook error, plan approval allowed UNCHECKED: ${e?.message ?? e}` });
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
