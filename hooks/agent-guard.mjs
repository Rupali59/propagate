#!/usr/bin/env node
/**
 * PreToolUse — the read-only guard for propagate's own subagents (propagate#251).
 *
 * WHY A HOOK. An agent file's `tools` line allows or denies Bash wholesale; it cannot allow only the read commands.
 * And a PLUGIN agent cannot carry its own hooks or permissionMode: "For security reasons, plugin subagents don't
 * support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields" (code.claude.com sub-agents docs,
 * verified 2026-11-12). So the guard lives here and keys on `agent_type`, a common input field that "identif[ies]
 * the subagent" on every tool event.
 *
 * AN ALLOWLIST, FAILING CLOSED. For an agent in READ_ONLY, a Bash command is allowed only if every segment
 * (split on && || ; |) starts with a known read command, and no segment redirects into a file. Anything not
 * recognised is denied with its reason. A denylist would let the first unanticipated writer through; this lets
 * the first unanticipated reader be denied, which costs one report line.
 *
 * SCOPE. Only propagate's read-only agents. The main session (no agent_type) and every other subagent are never
 * touched: the hook exits 0 with no output for them. tests/hooks/agent-guard.test.mjs asserts both halves.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const READ_ONLY = Object.freeze(["edge-settler", "doc-curator", "adversarial-reviewer"]);

const isReadOnlyAgent = (t) => typeof t === "string" && READ_ONLY.includes(t.replace(/^propagate:/, ""));

const READ_CMDS = new Set([
  "cat", "head", "tail", "wc", "ls", "grep", "rg", "jq", "sort", "uniq", "cut", "tr", "awk", "diff", "file",
  "stat", "basename", "dirname", "realpath", "pwd", "echo", "printf", "date", "true", "test", "[",
]);
const GIT_READ = new Set([
  "log", "show", "diff", "status", "cat-file", "rev-parse", "blame", "ls-files", "ls-tree", "merge-base",
  "cherry", "grep", "describe", "rev-list", "shortlog", "name-rev", "for-each-ref", "remote", "branch",
]);
const PROPAGATE_READ = new Set(["status", "settle", "graph", "why", "check", "reconcile", "doctor", "verify", "costs", "help", "list", "inventory"]);
const GH_READ = { issue: ["view", "list"], pr: ["view", "list", "diff", "checks"], project: ["view", "list", "item-list", "field-list"], repo: ["view"] };

/** @returns {string|null} why the segment is not a read, or null when it is */
function segmentProblem(seg) {
  const words = seg.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  while (/^[A-Z_][A-Z0-9_]*=/.test(words[0] ?? "")) words.shift(); // VAR=x cmd
  const [cmd, ...rest] = words;
  if (!cmd) return null;
  if (rest.includes("--apply")) return "`--apply` writes";

  if (READ_CMDS.has(cmd)) return null;
  if (cmd === "sed") return rest.some((a) => /^-[a-zA-Z]*i/.test(a)) ? "`sed -i` edits a file" : null;
  if (cmd === "find") return rest.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-fprint"].includes(a)) ? "`find` with an action" : null;

  if (cmd === "git") {
    const args = [...rest];
    while (args[0] === "-C" || args[0] === "-c") args.splice(0, 2);
    const sub = args[0];
    if (!GIT_READ.has(sub)) return `\`git ${sub ?? ""}\` is not a read`;
    if (sub === "branch" && args.slice(1).some((a) => !a.startsWith("-") || /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force)/.test(a))) return "`git branch` with a write argument";
    if (sub === "remote" && args.slice(1).some((a) => ["add", "remove", "rm", "rename", "set-url", "prune"].includes(a))) return "`git remote` write";
    return null;
  }

  if (cmd === "propagate" || (cmd === "node" && /(^|\/)cli\.mjs$/.test(rest[0] ?? ""))) {
    const sub = cmd === "propagate" ? rest[0] : rest[1];
    return PROPAGATE_READ.has(sub) ? null : `\`propagate ${sub ?? ""}\` is not on the read list`;
  }

  if (cmd === "gh") {
    const [g, s] = rest;
    if (g === "api") {
      const method = rest.findIndex((a) => a === "-X" || a === "--method");
      if (method !== -1 && String(rest[method + 1]).toUpperCase() !== "GET") return "`gh api` with a write method";
      if (rest[1] === "graphql") return /\bmutation\b/.test(seg) ? "a GraphQL mutation" : null;
      if (rest.some((a) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(a))) return "`gh api` with fields defaults to POST";
      return null;
    }
    return GH_READ[g]?.includes(s) ? null : `\`gh ${g ?? ""} ${s ?? ""}\` is not a read`;
  }

  return `\`${cmd}\` is not on the read list`;
}

/** @returns {{deny: boolean, reason?: string}} */
export function decide(input) {
  if (!isReadOnlyAgent(input?.agent_type)) return { deny: false };
  const tool = input.tool_name;
  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") return { deny: true, reason: `${tool} is a write` };
  if (tool !== "Bash") return { deny: false };
  const command = String(input.tool_input?.command ?? "");
  // A redirection into a file writes it. 2>&1, >&2 and /dev/null are not files.
  const redirect = command.replace(/\d?>&\d/g, "").replace(/\d?>>?\s*\/dev\/null/g, "");
  if (/>/.test(redirect.replace(/'[^']*'|"[^"]*"/g, ""))) return { deny: true, reason: "a `>` redirection writes a file" };
  if (/\btee\b/.test(command)) return { deny: true, reason: "`tee` writes a file" };
  if (/\$\(|`/.test(command.replace(/'[^']*'/g, ""))) return { deny: true, reason: "command substitution cannot be checked" };
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const p = segmentProblem(seg);
    if (p) return { deny: true, reason: p };
  }
  return { deny: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0); // unreadable payload: not ours to judge, and a guard must not wedge the session
  }
  const d = decide(input);
  if (d.deny) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `propagate read-only agent ${input.agent_type}: ${d.reason}. Report what you would run; the parent decides.`,
      },
    }));
  }
  process.exit(0);
}
