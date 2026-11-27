#!/usr/bin/env node
/**
 * PreToolUse (Bash) — refuses to close a board item that lacks Size, Finished, Minutes or Tokens (propagate#280).
 *
 * WHY A HOOK. rule:record-completion-cost says what to record on a finished item; nothing enforced it. Measured in Sprint
 * 2 (propagate#280 body): 13 of 46 done items had no Minutes, 14 no Tokens, 22 more were Done with no Finished date in the
 * window, so `sprint review` called every Size uncalibrated. Same gap rule:background-long-runs had until #224.
 *
 * WHAT IT CATCHES (a Bash call, any session)
 *   1. `gh issue close <n|url> [-R o/r]`
 *   2. `gh project item-edit --id <item> --single-select-option-id <opt>` where <opt> is the Done option of the item's board
 *   3. `gh api graphql` carrying `updateProjectV2ItemFieldValue` whose option id is that Done option
 * Heredoc bodies are dropped first, and (for 1 and 2) quoted text is ignored, so a commit message that mentions
 * `gh issue close` triggers nothing. NOT COVERED, by design: a `Closes #n` keyword closing on push, and a close by hand on
 * github.com. `day close` lists those as "cost gaps".
 *
 * THE BOARD READ. One GraphQL read through `${PROPAGATE_GH_BIN:-gh}` (tests stub it) of the item's Size, Finished,
 * Minutes, Tokens and its board's Status options (`fields(first:50)`, never `field(name:)`, which errors on a missing
 * field). An issue on several boards is judged on each: any incomplete board item denies.
 *
 * FAILS OPEN, OUT LOUD. A failed read (offline, not logged in, issue on no board, unparseable answer) allows the command
 * and writes an additionalContext WARNING naming the failure; it never allows silently. A bug in this hook exits 0 with no
 * output, as every guard here does, because a safety hook must not wedge closing.
 *
 * ESCAPE: a `# close-ok: <why>` comment in the command, reason non-empty. The bypass is deliberate and visible in the log.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dropHeredocs } from "./background-guard.mjs";

export const REQUIRED = Object.freeze(["Size", "Finished", "Minutes", "Tokens"]);

const FILL = {
  Size: "set the Size field on the board (`gh project item-edit`, or the board UI)",
  Finished: "set the Finished date on the board (`gh project item-edit --date YYYY-MM-DD`)",
  Minutes: "`propagate costs window` for a main-session item, `propagate costs lanes` for a lane; then set Minutes",
  Tokens: "`propagate costs window` for a main-session item, `propagate costs lanes` for a lane; then set Tokens",
};

const stripQuotes = (s) => s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, " ");
const escaped = (command) => /#\s*close-ok:\s*\S/.test(command);

const ITEM_BODY =
  "id project{number title fields(first:50){nodes{... on ProjectV2SingleSelectField{name options{id name}}}}} " +
  "fieldValues(first:30){nodes{" +
  "... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}" +
  "... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}}" +
  "... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}}}";
const ISSUE_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){projectItems(first:20){nodes{${ITEM_BODY}}}}}}`;
const NODE_QUERY = `query($id:ID!){node(id:$id){... on ProjectV2Item{${ITEM_BODY}}}}`;

/** Normalise one ProjectV2Item node into {board, values, doneOptionIds}. Throws on a shape it does not understand. */
export function normalizeItem(node) {
  if (!node || typeof node !== "object" || !node.project || !Array.isArray(node.fieldValues?.nodes)) throw new Error("board answer has no item with fields");
  const values = { Size: null, Finished: null, Minutes: null, Tokens: null };
  for (const v of node.fieldValues.nodes) {
    const name = String(v?.field?.name ?? "").toLowerCase();
    if (name === "size" && typeof v.name === "string") values.Size = v.name;
    else if (name === "finished" && typeof v.date === "string") values.Finished = v.date;
    else if (name === "minutes" && typeof v.number === "number") values.Minutes = v.number;
    else if (name === "tokens" && typeof v.number === "number") values.Tokens = v.number;
  }
  const status = (node.project.fields?.nodes ?? []).find((f) => String(f?.name ?? "").toLowerCase() === "status");
  const doneOptionIds = (status?.options ?? []).filter((o) => String(o?.name).toLowerCase() === "done").map((o) => o.id);
  return { board: `board ${node.project.number ?? "?"}`, values, doneOptionIds };
}

/** The default reader: `gh api graphql` through PROPAGATE_GH_BIN. Returns parsed JSON or throws with the failure. */
export function ghRead(args, env = process.env) {
  const bin = env.PROPAGATE_GH_BIN || "gh";
  try {
    return JSON.parse(String(execFileSync(bin, ["api", "graphql", ...args], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] })));
  } catch (e) {
    if (e?.code === "ENOENT") throw new Error(`\`${bin}\` is not installed`);
    const err = String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0];
    throw new Error(err || "gh api graphql failed");
  }
}

function repoOf(args, env) {
  const m = /(?:^|\s)(?:-R|--repo)[=\s]+([\w.-]+\/[\w.-]+)/.exec(args);
  if (m) return m[1];
  const u = /github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d+/.exec(args);
  if (u) return u[1];
  const bin = env.PROPAGATE_GH_BIN || "gh";
  try {
    return String(execFileSync(bin, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] })).trim();
  } catch (e) {
    throw new Error(`cannot tell which repository the issue is in (${String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0]})`);
  }
}

/** The close targets in a command: [{kind:"issue", repoArgs, number} | {kind:"item", itemId, optionId}]. */
export function targets(command) {
  const text = dropHeredocs(command);
  const out = [];
  for (const seg of stripQuotes(text).split(/&&|\|\||;|\||\n/)) {
    const s = seg.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "");
    const c = /^gh\s+issue\s+close\s+(.*)$/.exec(s);
    if (c) {
      const n = /(?:^|\s)#?(\d+)(?=\s|$)/.exec(c[1]) ?? /\/issues\/(\d+)/.exec(c[1]);
      if (n) out.push({ kind: "issue", args: c[1], number: Number(n[1]) });
    }
  }
  // item-edit and the GraphQL write carry their ids in quotes, so they are read from the unstripped text
  if (/(?:^|[\s;&|(])gh\s+project\s+item-edit\b/.test(stripQuotes(text))) {
    const id = /--id[=\s]+["']?([\w-]+)/.exec(text)?.[1];
    const opt = /--single-select-option-id[=\s]+["']?([\w-]+)/.exec(text)?.[1];
    if (id && opt) out.push({ kind: "item", itemId: id, optionId: opt });
  }
  if (/(?:^|[\s;&|(])gh\s+api\s+graphql\b/.test(stripQuotes(text)) && /updateProjectV2ItemFieldValue/.test(text)) {
    const id = /itemId["']?\s*[:=]\s*\\?["']?([\w-]+)/.exec(text)?.[1];
    const opt = /(?:singleSelectOptionId|optionId)["']?\s*[:=]\s*\\?["']?([\w-]+)/.exec(text)?.[1];
    if (id && opt) out.push({ kind: "item", itemId: id, optionId: opt });
  }
  return out;
}

const missingOf = (it) => REQUIRED.filter((f) => it.values[f] === null);

/**
 * @param {object} input the PreToolUse payload
 * @param {{read?: Function, env?: object}} [o] `read(args)` returns the parsed GraphQL answer (injectable)
 * @returns {{deny: boolean, reason?: string, warn?: string}}
 */
export function decide(input, { read = ghRead, env = process.env } = {}) {
  if (input?.tool_name !== "Bash") return { deny: false };
  const command = String(input.tool_input?.command ?? "");
  if (!/\bgh\b/.test(command)) return { deny: false };
  const found = targets(command);
  if (!found.length) return { deny: false };
  if (escaped(dropHeredocs(command))) return { deny: false };

  const denials = [];
  const warns = [];
  for (const t of found) {
    try {
      let items, label, closing = true;
      if (t.kind === "issue") {
        const [o, r] = repoOf(t.args, env).split("/");
        const data = read(["-f", `query=${ISSUE_QUERY}`, "-f", `o=${o}`, "-f", `r=${r}`, "-F", `n=${t.number}`]);
        if (data?.errors?.length) throw new Error(String(data.errors[0]?.message ?? "GraphQL error"));
        const nodes = data?.data?.repository?.issue?.projectItems?.nodes;
        if (!Array.isArray(nodes)) throw new Error(`issue ${o}/${r}#${t.number} not found in the answer`);
        if (!nodes.length) throw new Error(`issue ${o}/${r}#${t.number} is on no board`);
        items = nodes.map(normalizeItem);
        label = `${o}/${r}#${t.number}`;
      } else {
        const data = read(["-f", `query=${NODE_QUERY}`, "-f", `id=${t.itemId}`]);
        if (data?.errors?.length) throw new Error(String(data.errors[0]?.message ?? "GraphQL error"));
        const it = normalizeItem(data?.data?.node);
        closing = it.doneOptionIds.includes(t.optionId);
        items = [it];
        label = `board item ${t.itemId}`;
      }
      if (!closing) continue;
      for (const it of items) {
        const miss = missingOf(it);
        if (miss.length) denials.push(`${label} (${it.board}) is missing ${miss.join(", ")}: ` + miss.map((f) => `${f}: ${FILL[f]}`).join("; "));
      }
    } catch (e) {
      warns.push(`board read failed (${e?.message ?? e}); the close was NOT checked for Size, Finished, Minutes, Tokens`);
    }
  }
  if (denials.length) return { deny: true, reason: `${denials.join(" | ")}. To close anyway add a \`# close-ok: <why>\` comment (rule:record-completion-cost)` };
  if (warns.length) return { deny: false, warn: warns.join(" | ") };
  return { deny: false };
}

export function respond(input, o = {}, write = (s) => process.stdout.write(s)) {
  const d = decide(input, o);
  if (d.deny) write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `propagate close-guard: ${d.reason}.` } }));
  else if (d.warn) write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `propagate close-guard WARNING: ${d.warn}.` } }));
  return d;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    respond(JSON.parse(readFileSync(0, "utf8") || "{}"));
  } catch {
    // unreadable payload or a bug here: not ours to judge
  }
  process.exit(0);
}
