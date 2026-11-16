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
 * THE SURFACE GATE (#297, glance design §6). The plan also carries `Surface: none` or
 * `Surface: ui|widget|command|job|skill|notification|hook` (bold or plain, any case; "surface" = anything a person reads
 * or clicks). When it is not `none`, it needs a `## Need` section with non-empty `Question:`, `Decision:`, `Today:` and
 * `Retire when:` labels (counted only inside that section, which ends at the next heading of its level or higher) and
 * a `## References checked` section with at least one entry. Fenced code blocks are ignored. `surface_reason: <why>`
 * is the sanctioned escape, logged with the approval like `goal_reason`.
 *   - Goal and Surface are decided together and refused in ONE denial that lists everything missing and carries the
 *     template to paste.
 *   - The Surface check runs on EVERY path that has plan text, including "no active goal was read" (goal not checked,
 *     Surface still checked). With no plan text it says `Surface not checked`.
 *   - Grace: before SURFACE_ENFORCE_FROM a plan with NO `Surface:` line is allowed with a warning naming the date.
 *     A Surface plan missing its sections is denied from day one.
 *   - #301: a `Surface: none` plan whose text names a surface marker (SURFACE_MARKERS: notify(, hooks/, widget,
 *     COMMANDS / lib/core/commands.mjs, launchd / .plist / LaunchAgents; any case) is WARNED, never denied, with the
 *     marker and the Surface kind it suggests, and logged with verdict `warn-surface-mismatch`, missing = the markers.
 *   - Every deny and every warn appends `{ts, session, verdict, missing[]}` (no plan text) to
 *     `<stateDir>/plan-gate/YYYY-MM.jsonl`. A failed log write never turns a deny into an allow.
 *
 * NEVER BLOCKS ON ITS OWN BUGS. An exception inside the hook allows. A missing section is not a bug: it blocks.
 *
 * OFF SWITCH. `hooks.planSurfaceGate` in config.yml, or PROPAGATE_PLAN_SURFACE_GATE (lib/core/config.mjs
 * planSurfaceGate). Unset, it is ON only in the owner's tree (a declared hub, or an approvals log already written) and
 * OFF elsewhere, so a public install is never denied for a convention it did not adopt. Off skips Surface entirely;
 * the Goal check is unaffected. Placeholder values (`<...>`, TODO, TBD, `?`, `-`) do not count as filled.
 *
 * TEST SEAM (clock). PROPAGATE_PLAN_GATE_NOW (an ISO date) replaces Date.now() for the grace decision and the log.
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

/** Day 0 of the Surface grace period (the day the gate shipped) and its length. Fixed in code, never configured. */
export const SURFACE_GRACE_START = "2026-11-16";
export const SURFACE_GRACE_DAYS = 14;
/** From this UTC day a plan with no `Surface:` line is denied instead of warned. */
export const SURFACE_ENFORCE_FROM = new Date(Date.parse(`${SURFACE_GRACE_START}T00:00:00Z`) + SURFACE_GRACE_DAYS * 86400000)
  .toISOString()
  .slice(0, 10);
export const SURFACES = ["none", "ui", "widget", "command", "job", "skill", "notification", "hook"];
const SURFACE_LINE = /^[ \t]*(?:[-*+][ \t]+)?\**[ \t]*surface[ \t]*\**[ \t]*:[ \t]*\**[ \t]*([A-Za-z]+)/im;
const SURFACE_REASON_LINE = /^\s*surface_reason:[ \t]*(\S.*)$/im;
/**
 * #301: words in a `Surface: none` plan that say it touches a surface anyway, each with the kind it suggests.
 * Matched case-insensitively (except the COMMANDS identifier) on the whole plan text (fences included: a code sketch calling notify( counts). Warn only.
 */
export const SURFACE_MARKERS = [
  { marker: "notify(", re: /notify\(/i, kind: "notification" },
  { marker: "hooks/", re: /hooks\//i, kind: "hook" },
  { marker: "widget", re: /\bwidgets?\b/i, kind: "widget" },
  // Case-SENSITIVE on purpose: the identifier COMMANDS, never the prose word "commands", which nearly every plan has.
  { marker: "COMMANDS", re: /\bCOMMANDS\b|lib\/core\/commands\.mjs/, kind: "command" },
  { marker: "launchd", re: /launchd|\.plist\b|LaunchAgents/i, kind: "job" },
];

/** The markers a plan names. @returns {{marker: string, kind: string}[]} */
export function surfaceMarkers(planText) {
  return SURFACE_MARKERS.filter((m) => m.re.test(planText)).map(({ marker, kind }) => ({ marker, kind }));
}
const NEED_LABELS = ["Question", "Decision", "Today", "Retire when"];
const NEED_MISSING = "## Need (Question:, Decision:, Today:, Retire when:)";

const TEMPLATE = [
  "Surface: ui            (or none | widget | command | job | skill | notification | hook)",
  "",
  "## Need",
  "",
  "- Question: <what the person asks that this answers>",
  "- Decision: <what they decide from it>",
  "- Today: <what they do now, without it>",
  "- Retire when: <the signal that it is no longer needed>",
  "",
  "## References checked",
  "",
  "- <library, standard or reference>: <why it did or did not fit>",
].join("\n");

/** Plan text with fenced code blocks blanked, so a quoted template never counts. */
function stripFences(text) {
  const out = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      out.push("");
    } else if (m) {
      fence = m[1];
      out.push("");
    } else out.push(line);
  }
  return out;
}

/** The body lines of the first `##`/`###` heading whose title starts with `title`, or null when there is none. */
function section(lines, title) {
  const head = new RegExp(`^(#{2,3})[ \\t]+${title}\\b`, "i");
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const level = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const h = /^(#{1,6})[ \t]/.exec(lines[j]);
      if (h && h[1].length <= level) break;
      body.push(lines[j]);
    }
    return body;
  }
  return null;
}

/**
 * True when a value is not real text: empty, only `<...>` placeholders, punctuation, or a stock filler word. A gate
 * its own template satisfies cannot fail (rule:discernment-checks §1), so the template's `<...>` values count as
 * unfilled. Angle brackets inside real text (`Goal: G<n>`) are fine: something besides placeholders must remain.
 */
const FILLER = /^(?:todo|tbd|tbc|fixme|xxx|n\/?a|none yet|\.\.\.|…)$/i;
export function isPlaceholder(value) {
  const v = String(value ?? "").trim();
  if (!v) return true;
  if (FILLER.test(v.replace(/[.:!]+$/, "").trim())) return true;
  const rest = v.replace(/<[^<>]*>/g, "");
  return !/[\p{L}\p{N}]/u.test(rest);
}

/** A body line with its bullet and bold markers removed. */
const bare = (line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__/g, "").trim();

/**
 * The Surface half of the decision. @returns {{surface: string|null, reason: string|null, missing: string[],
 * invalid?: string, warnOnly: boolean}}. `missing` empty means it passes; `warnOnly` means the only gap is the absent
 * Surface line inside the grace window.
 */
export function decideSurface(planText, { now = Date.now() } = {}) {
  const lines = stripFences(planText);
  const text = lines.join("\n");
  const out = { surface: null, reason: null, missing: [], warnOnly: false };
  const reason = SURFACE_REASON_LINE.exec(text)?.[1].trim() ?? null;
  const raw = SURFACE_LINE.exec(text)?.[1] ?? null;
  const surface = raw ? raw.toLowerCase() : null;
  if (surface && SURFACES.includes(surface)) out.surface = surface;
  if (reason) {
    out.reason = reason;
    return out;
  }
  if (surface === null) {
    out.missing.push("Surface");
    out.warnOnly = now < Date.parse(`${SURFACE_ENFORCE_FROM}T00:00:00Z`);
    return out;
  }
  if (!SURFACES.includes(surface)) {
    out.missing.push("Surface");
    out.invalid = raw;
    return out;
  }
  if (surface === "none") {
    const found = surfaceMarkers(planText);
    if (found.length) out.markers = found;
    return out;
  }
  const need = section(lines, "Need");
  if (!need) out.missing.push(NEED_MISSING);
  else {
    const absent = [];
    const unfilled = [];
    for (const label of NEED_LABELS) {
      const re = new RegExp(`^${label.replace(" ", "\\s+")}\\s*:\\s*(\\S.*)$`, "i");
      const values = need.map((l) => re.exec(bare(l))?.[1]).filter((v) => v !== undefined);
      if (!values.length) absent.push(label);
      else if (values.every(isPlaceholder)) unfilled.push(label);
    }
    if (absent.length) out.missing.push(`## Need (${absent.map((l) => `${l}:`).join(", ")})`);
    if (unfilled.length) out.missing.push(`## Need unfilled (${unfilled.map((l) => `${l}:`).join(", ")})`);
  }
  const refs = section(lines, "References checked");
  const entries = (refs ?? []).map(bare).filter((l) => l.length > 0);
  if (!entries.length) out.missing.push("## References checked");
  else if (entries.every(isPlaceholder)) out.missing.push("## References checked unfilled");
  return out;
}

/**
 * Goal and Surface together. `surfaceGate: false` (the install's off switch) skips Surface. `activeIds` null means the goals could not be read (goal not checked, Surface still is).
 * @returns {{deny?: string, warn?: string, surfaceMismatch?: string, markers?: object[], missing: string[], goal, reason, surface, surfaceReason, goalChecked, log}}
 */
export function decidePlan(planText, activeIds, { now = Date.now(), surfaceGate = true } = {}) {
  const goalChecked = Array.isArray(activeIds) && activeIds.length > 0;
  const g = goalChecked ? decide(planText, activeIds) : { goal: null, reason: null, log: false };
  // The off switch (hooks.planSurfaceGate) skips the Surface half entirely: no warn, no deny, no log row.
  const s = surfaceGate ? decideSurface(planText, { now }) : { surface: null, reason: null, missing: [], warnOnly: false };
  const out = { missing: [], goal: g.goal, reason: g.reason, surface: s.surface, surfaceReason: s.reason, goalChecked, log: g.log };
  if (g.deny) out.missing.push("Goal");
  const surfaceBlocks = s.missing.length > 0 && !s.warnOnly;
  if (surfaceBlocks) out.missing.push(...s.missing);
  if (out.missing.length) {
    const parts = [`this plan is missing: ${out.missing.join(", ")}.`];
    if (g.deny) parts.push(`Goal: ${g.deny}`);
    if (surfaceBlocks) {
      if (s.invalid) parts.push(`"Surface: ${s.invalid}" is not a surface; use one of ${SURFACES.join("|")}.`);
      parts.push(
        'Surface: add "Surface: none" if it adds nothing a person reads. Otherwise add "Surface: ' +
          SURFACES.filter((x) => x !== "none").join("|") +
          '", a "## Need" section with the four labels, and a "## References checked" section with one line: the library, ' +
          'standard or reference, and why it did or did not fit. Or a line "surface_reason: <why>" to override. Paste and fill in:\n\n' +
          TEMPLATE,
      );
    }
    out.deny = parts.join("\n");
    return out;
  }
  if (s.warnOnly) {
    out.missing = ["Surface"];
    out.warn = `Surface not declared: allowed until ${SURFACE_ENFORCE_FROM}, denied from then. Add "Surface: none" or a Surface with its "## Need" and "## References checked" sections.`;
  }
  // #301: Surface: none, but the text names a surface. Warn, never deny.
  if (s.markers?.length) {
    out.markers = s.markers;
    out.surfaceMismatch =
      "plan says Surface: none but names " +
      s.markers.map((m) => `${m.marker} (suggests Surface: ${m.kind})`).join(", ") +
      "; if it adds something a person reads, declare that Surface with its sections";
  }
  return out;
}

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

/** The gate clock: PROPAGATE_PLAN_GATE_NOW when it parses, else the real time. */
function gateNow() {
  const raw = process.env.PROPAGATE_PLAN_GATE_NOW;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? Date.now() : t;
}

/** One `{ts, session, verdict, missing}` row in `<stateDir>/plan-gate/YYYY-MM.jsonl`. Never throws. @returns {string|null} error */
async function logGate(now, session, verdict, missing) {
  try {
    const { stateDir } = await import("../lib/core/paths.mjs");
    const ts = new Date(now).toISOString();
    const dir = path.join(stateDir(), "plan-gate");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, `${ts.slice(0, 7)}.jsonl`), JSON.stringify({ ts, session, verdict, missing }) + "\n");
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
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
    const now = gateNow();
    const session = typeof input?.session_id === "string" ? input.session_id : null;
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
      emit({ additionalContext: "propagate plan-goal: plan goal not checked: no plan text found; Surface not checked: no plan text found" });
      process.exit(0);
    }
    // A failure READING goals is blindness about the goal only: the Surface check still runs on the text.
    let ids = null;
    let goalBlind = null;
    try {
      ids = await activeGoalIds();
      if (!ids.length) goalBlind = "no active goal was read";
    } catch (e) {
      goalBlind = `goals unreadable (${e?.message ?? e})`;
    }
    // The off switch. Reading it is the hook's own I/O: if that fails, the Surface gate fails open and says so.
    let surfaceGate = false;
    let gateNote = null;
    try {
      surfaceGate = (await import("../lib/core/config.mjs")).planSurfaceGate().on;
    } catch (e) {
      gateNote = `Surface not checked: gate setting unreadable (${e?.message ?? e})`;
    }
    const d = decidePlan(text, goalBlind ? null : ids, { now, surfaceGate });
    const notes = [];
    if (goalBlind) notes.push(`plan goal not checked: ${goalBlind}`);
    if (gateNote) notes.push(gateNote);
    if (d.deny) {
      const err = await logGate(now, session, "deny", d.missing);
      const tail = [...notes, ...(err ? [`plan-gate log not written: ${err}`] : [])];
      emit({ permissionDecision: "deny", permissionDecisionReason: `propagate plan-goal: ${d.deny}${tail.length ? `\n(${tail.join("; ")})` : ""}` });
      process.exit(0);
    }
    if (d.warn) {
      const err = await logGate(now, session, "warn", d.missing);
      notes.push(d.warn + (err ? ` (plan-gate log not written: ${err})` : ""));
    }
    if (d.surfaceMismatch) {
      const err = await logGate(now, session, "warn-surface-mismatch", d.markers.map((m) => m.marker));
      notes.push(d.surfaceMismatch + (err ? ` (plan-gate log not written: ${err})` : ""));
    }
    if (d.surfaceReason) notes.push(`surface_reason override recorded (${d.surfaceReason})`);
    else if (d.surface) notes.push(`Surface: ${d.surface}`);
    if (!goalBlind) {
      const { stateDir } = await import("../lib/core/paths.mjs");
      const dir = path.join(stateDir(), "plans");
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString();
      const row = d.goal ? { ts, plan: source, goal: d.goal } : { ts, plan: source, goal: null, reason: d.reason };
      if (surfaceGate) row.surface = d.surface;
      if (d.surfaceReason) row.surface_reason = d.surfaceReason;
      appendFileSync(path.join(dir, "approvals.jsonl"), JSON.stringify(row) + "\n");
      notes.unshift(d.goal ? `plan names active goal ${d.goal}` : `goal_reason override recorded (${d.reason})`);
    }
    emit({ additionalContext: `propagate plan-goal: ${notes.join("; ")}` });
  } catch (e) {
    emit({ additionalContext: `propagate plan-goal: hook error, plan approval allowed UNCHECKED: ${e?.message ?? e}` });
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
