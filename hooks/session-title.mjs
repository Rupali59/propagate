#!/usr/bin/env node
/**
 * UserPromptSubmit — show the board item a session works on in the session title (propagate#442).
 *
 * Claude Code shows the session title in agent view, /resume, Remote Control, the statusline `session_name` and
 * `claude agents --json` `name`, and a UserPromptSubmit hook may set it with `hookSpecificOutput.sessionTitle`
 * (https://code.claude.com/docs/en/hooks). So the display is the built-in one; this hook only prefixes it.
 *
 * It reads the session's current association from `$STATE/sessions/assoc.jsonl` by `session_id` (the same log
 * `propagate sessions` reads; agent-nudge.mjs and dispatch-model.mjs write it) and returns
 * `{hookSpecificOutput: {hookEventName: "UserPromptSubmit", sessionTitle: "<owner>/<repo>#<n> · <rest>"}}`, where <rest> is
 * the payload's `session_title` with any earlier `<owner>/<repo>#<n> · ` prefix stripped, so a name given with /rename is kept
 * and only the prefix changes.
 *
 * SILENT when there is no association, when the title already starts with the item, inside a subagent (agent_type
 * set), and on any error. Never blocks; exit 0. DEPENDENCY-FREE (node builtins only): it runs on every prompt.
 * Needs /reload-plugins after hooks.json changes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { existingAssociation } from "../lib/sessions/assoc-write.mjs";
import { stateDir } from "../lib/core/paths.mjs";

const PREFIX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+ · /;

/** @returns {string|null} the new title, or null when there is nothing to change. */
export function titleFor(input, logText) {
  if (input?.agent_type) return null;
  const sid = input?.session_id;
  if (typeof sid !== "string" || !sid) return null;
  const a = existingAssociation(logText, sid);
  if (!a || typeof a.item !== "string" || !a.item) return null;
  const short = a.item;
  const current = typeof input.session_title === "string" ? input.session_title : "";
  if (current.startsWith(`${short} · `) || current === short) return null;
  const rest = current.replace(PREFIX, "").trim();
  return rest ? `${short} · ${rest}` : short;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    let text = "";
    try {
      text = readFileSync(path.join(stateDir(), "sessions", "assoc.jsonl"), "utf8");
    } catch {
      /* no log: no association: silent */
    }
    const title = titleFor(input, text);
    if (title) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title } }));
  } catch {
    /* a title must never wedge a prompt */
  }
  process.exit(0);
}
