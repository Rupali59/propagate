#!/usr/bin/env node
/**
 * PostToolUse (Bash) — offer the edge-settler agent at the moment it pays (propagate#251).
 *
 * Rupali, 2026-11-12: "the session takes care of itself, it asks the agent to be run on a hook". So the decision
 * to delegate is not left to the session remembering that the agent exists: when a `settle <file> --json` comes
 * back with NUDGE_AT or more edges to settle, this hook adds one line of context naming the agent and the
 * deterministic gate its output must pass (`settle <file> --check`).
 *
 * Informs only: never blocks, always exit 0, no output when it has nothing to say. Silent inside any subagent
 * (agent_type set), so edge-settler's own `settle --json` never tells it to dispatch itself.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const NUDGE_AT = 3;

/**
 * Bash's tool_response carries stdout; accept a bare string too, since the shape is the harness's, not ours.
 * A LARGE output is truncated in `stdout` and the full text is in `persistedOutputPath`. Measured on the first live
 * run (2026-11-12): a 10-edge worklist was 51.6 KB, `stdout` held 29,957 chars, the JSON did not parse and the nudge
 * stayed silent. A worklist big enough to nudge is exactly the one that gets truncated, so the file is read first.
 */
function stdoutOf(r) {
  if (typeof r === "string") return r;
  if (typeof r?.persistedOutputPath === "string") {
    try {
      return readFileSync(r.persistedOutputPath, "utf8");
    } catch {
      /* fall through to the truncated stdout; it will fail to parse and the hook stays silent */
    }
  }
  return typeof r?.stdout === "string" ? r.stdout : "";
}

/** @returns {string|null} the context line, or null */
export function nudge(input) {
  if (input?.agent_type) return null;
  if (input?.tool_name !== "Bash") return null;
  const cmd = String(input.tool_input?.command ?? "");
  if (!/\bsettle\b/.test(cmd) || !/--json\b/.test(cmd) || /--check\b/.test(cmd)) return null;
  let w;
  try {
    w = JSON.parse(stdoutOf(input.tool_response).trim().split("\n").pop());
  } catch {
    return null;
  }
  const items = Array.isArray(w?.items) ? w.items : [];
  if (items.length < NUDGE_AT || w.allNeverVerified) return null;
  const file = w.file ?? "<file>";
  return (
    `propagate: ${items.length} edges to settle on ${w.fileShort ?? file}. Dispatch the propagate:edge-settler agent on it ` +
    `instead of walking them here; save its JSON and gate it with \`propagate settle '${file}' --check <proposals.json>\`. ` +
    `Apply only what the check passes; take every refused edge back to the user as a question.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const line = nudge(JSON.parse(readFileSync(0, "utf8") || "{}"));
    if (line) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: line } }));
  } catch {
    /* an informing hook must never wedge the session */
  }
  process.exit(0);
}
