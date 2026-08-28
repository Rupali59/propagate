#!/usr/bin/env node
/**
 * rule-guard — deliver the relevant RULE at the moment of risk.
 *
 * WHY THIS EXISTS, and why it is not load-rules.mjs. `load-rules.mjs` injects all
 * 16 applicable rules at SessionStart. That is necessary and demonstrably not
 * sufficient: the rules arrive once, at the top of a session, and are then buried
 * under everything that follows. `gotcha-guard.mjs:10-15` already names the failure
 * for hazards — "knowing about it does not stop you reaching for grep" — and the
 * same holds for rules.
 *
 * MEASURED, 2026-08-28, across the 60 most recent transcripts:
 *
 *     Agent dispatches            110
 *       model: sonnet              59   compliant
 *       model: opus                 1   violation
 *       no model -> inherits Opus   50   violation   (29 of them `Explore`)
 *
 * `rule:model-routing` was in context for every one of those 110 calls. The
 * session that took this measurement then dispatched two more `Explore` agents
 * with no model *while researching why the rule is not followed*. Recognition,
 * not knowledge, is the failure.
 *
 * WHAT THIS ADDS OVER gotcha-guard. That guard is the proven mechanism and this
 * one is modelled on it deliberately rather than invented. But its `subjectOf`
 * returns "" for every tool except Bash/Edit/Write/NotebookEdit, so it is blind to
 * subagent dispatch — and no hook anywhere in this install observes `Agent`. That
 * hole is exactly where `model-routing` is violated. Verified live 2026-08-28:
 * PreToolUse DOES fire on `Agent`, and an omitted `model` is visible as an absent
 * key in `tool_input`. (Verified with a `Bash` control in the same config, so
 * "does not fire" was distinguishable from "config never reloaded".)
 *
 * HOW A RULE OPTS IN. Three frontmatter fields, all optional together. A rule
 * without `trigger:` is inert by construction, which is the correct default: 9 of
 * 17 rules govern judgment, and inventing triggers for those produces the noise
 * that hides the four that matter (propagate GOTCHAS G23).
 *
 *     ---
 *     id: model-routing
 *     trigger: 'Agent model=\(absent\)|Agent model=opus'
 *     fires_on: 'Agent model=(absent) subagent_type=Explore :: find the callers'
 *     alert: 'Dispatching without a model inherits Opus. rule:model-routing ...'
 *     ---
 *
 * `fires_on:` is a literal the trigger MUST match, asserted per rule by
 * --selftest. That is deliberate and copied from the gotchas contract: a regex you
 * cannot prove fires is a rule you have documented and not delivered.
 *
 * NEVER BLOCKS. Informs only — no `permissionDecision`, always exit 0. The reason
 * is in gotcha-guard's header and it applies with more force here: "a guard that
 * blocks on a regex would be trained around within a week." A dispatch on Opus is
 * sometimes correct (scope, design, review), so a gate here would be wrong on the
 * merits as well as counterproductive.
 *
 * FAILS OPEN, LOUDLY. Any internal error exits 0 so the tool call proceeds, and is
 * recorded in the log. Every invocation appends one line, so "never fired" is
 * distinguishable from "never ran" (rule:discernment-checks §2).
 */

import { readFileSync, existsSync, readdirSync, appendFileSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const RULES_DIR = path.join(HOME, ".claude", "rules");
const LOG = path.join(HOME, ".claude", "rule-guard.log");

/** Cap on rules shown at once. Noise is a hiding place (propagate GOTCHAS G23). */
const MAX_SHOWN = 2;

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/**
 * Frontmatter reader. Deliberately the SAME permissive shape as
 * `load-rules.mjs:28-39` — any `\w+:` key, surrounding quotes stripped — so a rule
 * file stays readable by both and neither rejects the other's fields.
 */
function parseRule(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null; // no frontmatter => not a rule (e.g. gotchas-global.md, _TODO.md)
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  if (!meta.id) return null;
  return { ...meta, file };
}

/**
 * Every rule that declares a trigger, with the regex compiled.
 * Returns { entries, bad } — a malformed regex is reported, never thrown, so one
 * bad rule cannot take the guard down for every other rule.
 */
export function loadTriggeredRules(dir = RULES_DIR) {
  const entries = [];
  const bad = [];
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch (e) {
    return { entries, bad, unreadable: `${dir}: ${e.message}` };
  }
  for (const f of files.sort()) {
    const r = parseRule(path.join(dir, f));
    if (!r) continue;
    if ((r.status || "active") === "obsolete") continue;
    if (!r.trigger) continue; // inert by construction — the correct default
    let re;
    try {
      re = new RegExp(r.trigger, "i");
    } catch (e) {
      bad.push(`${r.id}: bad trigger regex — ${e.message}`);
      continue;
    }
    entries.push({ id: r.id, re, alert: r.alert || "", firesOn: r.fires_on || "", file: r.file });
  }
  return { entries, bad, unreadable: null };
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

/**
 * The string a tool call is "about" — what a trigger regex is matched against.
 *
 * The `Agent` shape is NORMALISED rather than passed through raw, because the
 * violation is an ABSENT key and a regex cannot match something that is not
 * there. Rendering it as the literal `model=(absent)` turns a missing field into
 * matchable text. Verified against a live payload 2026-08-28: `tool_input` for a
 * dispatch carries [description, prompt, subagent_type, run_in_background] and no
 * `model` key at all when it is omitted.
 */
export function subjectOf(payload) {
  const tool = payload?.tool_name;
  const input = payload?.tool_input || {};
  if (tool === "Bash") return input.command || "";
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") return input.file_path || "";
  if (tool === "Agent" || tool === "Task") {
    const model = typeof input.model === "string" && input.model ? input.model : "(absent)";
    const type = input.subagent_type || "(default)";
    return `Agent model=${model} subagent_type=${type} :: ${input.prompt || ""}`;
  }
  // The one observable proxy for "a plan was approved". The violation this rule
  // cares about most — hand-applying the plan on Opus instead of dispatching — is
  // a NON-EVENT, and a hook cannot fire on a non-event. It can fire on the
  // transition into one.
  if (tool === "ExitPlanMode") return "ExitPlanMode plan-approved";
  return "";
}

function render(hits) {
  const lines = [];
  for (const h of hits.slice(0, MAX_SHOWN)) {
    lines.push(`rule · ${h.id}`);
    for (const l of (h.alert || "(no alert text declared)").split("\\n")) {
      lines.push(`  ${l.trim()}`);
    }
    lines.push(`  — ${h.file.replace(HOME, "~")}`);
  }
  if (hits.length > MAX_SHOWN) lines.push(`  (+${hits.length - MAX_SHOWN} more rule(s) matched)`);
  return lines.join("\n");
}

function logLine(msg) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging must never break a tool call */
  }
}

// ---------------------------------------------------------------------------
// selftest — per rule:enforcement-watches-itself, the check watches itself
// ---------------------------------------------------------------------------

export function selftestProblems(dir = RULES_DIR) {
  const { entries, bad, unreadable } = loadTriggeredRules(dir);
  const problems = [...bad];
  if (unreadable) problems.push(`rules dir unreadable — ${unreadable}`);
  for (const e of entries) {
    if (!e.firesOn) {
      problems.push(`${e.id}: declares trigger but no fires_on — a regex you cannot prove fires is a rule documented and not delivered`);
      continue;
    }
    if (!e.re.test(e.firesOn)) {
      problems.push(`${e.id}: trigger does NOT match its own fires_on (${JSON.stringify(e.firesOn)})`);
    }
    if (!e.alert) {
      problems.push(`${e.id}: declares trigger but no alert — it would fire and say nothing`);
    }
  }
  return { problems, count: entries.length };
}

function selftest() {
  const { problems, count } = selftestProblems();
  console.log("rule-guard selftest");
  console.log(`  rules dir : ${RULES_DIR.replace(HOME, "~")}`);
  console.log(`  triggered : ${count} rule(s) declare a trigger`);
  console.log(
    `  log       : ${
      existsSync(LOG) ? `${readFileSync(LOG, "utf8").split("\n").filter(Boolean).length} invocations recorded` : "never run"
    }`,
  );
  if (count === 0) {
    // "found nothing" and "looked at nothing" must render differently.
    console.log("\n✗ no rule declares a trigger — this guard cannot fire at all");
    process.exit(1);
  }
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log("\n✓ every triggered rule matches its own fires_on — the guard can fire");
  process.exit(0);
}

// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();

  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    process.exit(0); // unparseable payload is not this guard's problem
  }

  const subject = subjectOf(payload);
  if (!subject) process.exit(0);

  const { entries, bad } = loadTriggeredRules();
  const hits = entries.filter((e) => e.re.test(subject));

  logLine(`tool=${payload?.tool_name || "?"} rules=${entries.length} bad=${bad.length} hits=${hits.length}`);

  if (hits.length === 0) process.exit(0); // silence is correct: most calls are compliant

  // DELIVERY CHANNEL — see gotcha-guard.mjs:155-179. Its v1 wrote to stderr and
  // the model saw NOTHING while the log recorded healthy hits. stdout JSON with
  // BOTH systemMessage (human) and additionalContext (model). Do not "simplify".
  const text = render(hits);
  process.stdout.write(
    JSON.stringify({
      systemMessage: text,
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text },
    }),
  );
  process.exit(0);
}

/**
 * Run ONLY when executed directly.
 *
 * realpath BOTH sides. Node realpaths `import.meta.url` but NOT `process.argv[1]`,
 * and `skills-marketplace/propagate` is a symlink — so comparing them raw left
 * gotcha-guard AND its selftest silently dead on the served path. A check that
 * cannot fire, in the check whose job is to fire (gotcha-guard.mjs:193-215).
 */
const isDirectRun = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  try {
    main();
  } catch (e) {
    logLine(`ERROR ${e && e.message}`);
    process.exit(0); // fail open — never block a tool call on this guard's bug
  }
}
