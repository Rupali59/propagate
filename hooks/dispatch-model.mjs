#!/usr/bin/env node
/**
 * PreToolUse (Agent|Task) — check a subagent dispatch against its issue's Model field, and move the item to
 * In progress (propagate#265 part 3, #214 part 2).
 *
 * WHY. `rule:model-routing` is a rule sessions follow, and 50 of 110 measured dispatches inherited the parent's
 * model. The board's Model field says what the item needs; this hook refuses a dispatch that disagrees, unless the
 * prompt states a reason. DECISIONS 2026-11-13 "an item's Model is decided by 'is it decided?'".
 *
 * NO GRAPHQL READ. `day open` writes `<stateDir>/day/items.json` (lib/report/day.mjs buildDaySnapshot), so a
 * dispatch costs no read. A missing, unreadable or not-from-today snapshot, an unnamed issue, or an item not on a
 * board is ALLOWED and SAID so ("not checked"), never passed silently (rule:discernment-checks §2).
 *
 * AN OMITTED `model` IS A MISMATCH: the subagent would inherit the parent's model. It is an absent key in
 * tool_input (verified live 2026-08-28, see hooks/hooks.json rule-guard).
 *
 * THE ONE WRITE. On an allow, an item in Backlog or Ready is set to In progress (one updateProjectV2ItemFieldValue
 * through `gh api graphql`, 5 s timeout; PROPAGATE_GH_BIN overrides the binary for tests). A deny writes nothing; In
 * progress, In review and Done are never written. A failed write is reported and the dispatch is still allowed.
 * After a successful write the snapshot's status for that item is updated so a second dispatch does not write again.
 *
 * FAILS OPEN ON ITS OWN BUGS, LOUDLY: any exception allows the dispatch and says so in additionalContext.
 * Exit code is always 0.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MOVE_FROM = Object.freeze(["Backlog", "Ready"]);
const REPO = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Issue refs named by a prompt, as `owner/repo#n`, in first-seen order and de-duplicated.
 * `owner/repo#n` and github.com/owner/repo/issues/n always count. A bare `#n` counts only when the prompt names
 * exactly one repository (an explicit ref or a github.com/owner/repo URL), because with two it is ambiguous.
 */
export function extractRefs(prompt) {
  const text = String(prompt ?? "");
  const refs = [];
  const repos = new Set();
  const add = (r) => {
    if (!refs.includes(r)) refs.push(r);
  };
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9_./-])(${REPO})#(\\d+)\\b`, "g"))) {
    repos.add(m[1]);
    add(`${m[1]}#${m[2]}`);
  }
  for (const m of text.matchAll(new RegExp(`github\\.com/(${REPO})/issues/(\\d+)\\b`, "g"))) {
    repos.add(m[1]);
    add(`${m[1]}#${m[2]}`);
  }
  for (const m of text.matchAll(new RegExp(`github\\.com/(${REPO})(?![A-Za-z0-9_.-])`, "g"))) repos.add(m[1].replace(/\.git$/, ""));
  if (repos.size === 1) {
    const [only] = repos;
    for (const m of text.matchAll(/(?<![A-Za-z0-9_/#&])#(\d+)\b/g)) add(`${only}#${m[1]}`);
  }
  return refs;
}

const actualModel = (input) => {
  const m = input?.tool_input?.model;
  return typeof m === "string" && m.trim() ? m.trim().toLowerCase() : null;
};
const matches = (expected, actual) => actual !== null && actual.includes(expected);

/**
 * The pure decision.
 * @param {object} input the hook payload
 * @param {object|null} snapshot parsed items.json, or null when missing or unreadable
 * @param {Date} now
 * @returns {{refs: string[], deny?: string, notes: string[], overrides: object[], moves: object[]}}
 */
export function decide(input, snapshot, now = new Date()) {
  const out = { refs: [], notes: [], overrides: [], moves: [] };
  if (input?.tool_name !== "Agent" && input?.tool_name !== "Task") return out;
  const prompt = String(input?.tool_input?.prompt ?? "");
  out.refs = extractRefs(prompt);
  if (!out.refs.length) return out;

  const gen = snapshot && typeof snapshot.generatedAt === "string" ? new Date(snapshot.generatedAt) : null;
  if (!gen || Number.isNaN(gen.getTime()) || ymd(gen) !== ymd(now) || typeof snapshot.items !== "object" || !snapshot.items) {
    out.notes.push("model not checked: no day snapshot from today (run propagate day open)");
    return out;
  }

  const actual = actualModel(input);
  const reason = /^\s*model_reason:[ \t]*(\S.*)$/im.exec(prompt)?.[1].trim() ?? null;
  const denied = [];
  const checked = [];
  for (const ref of out.refs) {
    const item = snapshot.items[ref];
    if (!item) {
      out.notes.push(`not checked: ${ref} is not on a board`);
      continue;
    }
    const expected = typeof item.model === "string" && item.model.trim() ? item.model.trim().toLowerCase() : null;
    if (!expected) {
      out.notes.push(`model not checked: ${ref} has no Model field`);
    } else if (!matches(expected, actual)) {
      if (reason) out.overrides.push({ ref, expected, actual, reason, subagent_type: input.tool_input?.subagent_type ?? null });
      else {
        denied.push(
          `${ref}'s Model is ${expected}; this dispatch ${actual ? `uses ${actual}` : "names no model, so the subagent would inherit the parent's"}. ` +
            `Pass model: "${expected}", or add a line \`model_reason: <why>\` to the prompt.`,
        );
        continue;
      }
    }
    checked.push([ref, item]);
  }
  if (denied.length) {
    out.deny = denied.join(" ");
    return out; // a deny moves nothing and records nothing
  }
  for (const [ref, item] of checked) {
    if (MOVE_FROM.includes(item.status) && item.projectId && item.itemId && item.statusFieldId && item.inProgressOptionId) {
      out.moves.push({ ref, projectId: item.projectId, itemId: item.itemId, statusFieldId: item.statusFieldId, optionId: item.inProgressOptionId });
    }
  }
  return out;
}

const q = (s) => JSON.stringify(String(s));

/** One Status -> In progress write. @returns {{ok: boolean, error?: string}} */
export function moveToInProgress(m, gh = process.env.PROPAGATE_GH_BIN || "gh") {
  const mutation =
    `mutation{updateProjectV2ItemFieldValue(input:{projectId:${q(m.projectId)},itemId:${q(m.itemId)},` +
    `fieldId:${q(m.statusFieldId)},value:{singleSelectOptionId:${q(m.optionId)}}}){projectV2Item{id}}}`;
  const r = spawnSync(gh, ["api", "graphql", "-f", `query=${mutation}`], { encoding: "utf8", timeout: 5000 });
  if (r.error) return { ok: false, error: r.error.code === "ETIMEDOUT" ? "timed out after 5 s" : r.error.code || r.error.message };
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.stdout).trim().split("\n")[0] || `gh exited ${r.status}` };
  try {
    const res = JSON.parse(r.stdout);
    if (res.errors?.length) return { ok: false, error: res.errors.map((e) => e.message).join("; ") };
  } catch {
    /* gh printed no JSON: exit 0 is the signal */
  }
  return { ok: true };
}

function readSnapshot(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Atomic: temp file, then rename. */
function writeSnapshot(file, snapshot) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0); // unreadable payload: not ours to judge, and a guard must not wedge the session
  }
  if (input?.tool_name !== "Agent" && input?.tool_name !== "Task") process.exit(0);
  const emit = (hookSpecificOutput) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...hookSpecificOutput } }));
  try {
    const { stateDir } = await import("../lib/core/paths.mjs");
    const dir = path.join(stateDir(), "day");
    const file = path.join(dir, "items.json");
    const snapshot = readSnapshot(file);
    const d = decide(input, snapshot);
    if (d.deny) {
      emit({ permissionDecision: "deny", permissionDecisionReason: `propagate dispatch-model: ${d.deny}` });
      process.exit(0);
    }
    const notes = [...d.notes];
    if (d.overrides.length) {
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString();
      appendFileSync(path.join(dir, "overrides.jsonl"), d.overrides.map((o) => JSON.stringify({ ts, ...o })).join("\n") + "\n");
      notes.push(`model override recorded for ${d.overrides.map((o) => o.ref).join(", ")}`);
    }
    let changed = false;
    for (const m of d.moves) {
      const r = moveToInProgress(m);
      if (r.ok) {
        snapshot.items[m.ref].status = "In progress";
        changed = true;
        notes.push(`${m.ref} moved to In progress`);
      } else {
        notes.push(`could not move ${m.ref} to In progress (dispatch allowed): ${r.error}`);
      }
    }
    if (changed) {
      try {
        writeSnapshot(file, snapshot);
      } catch (e) {
        notes.push(`snapshot status not updated (${e.message}): a second dispatch may write again`);
      }
    }
    if (notes.length) emit({ additionalContext: `propagate dispatch-model: ${notes.join("; ")}` });
  } catch (e) {
    emit({ additionalContext: `propagate dispatch-model: hook error, dispatch allowed UNCHECKED: ${e?.message ?? e}` });
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
