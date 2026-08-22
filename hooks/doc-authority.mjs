#!/usr/bin/env node
/**
 * PreToolUse(Edit|Write) — surface the document that governs the file being edited.
 *
 * Why a hook and not a command: on 2026-08-15 `app/(site)/privacy/page.tsx` was rewritten
 * without reading `docs/content/legal/PRIVACY-CONTENT.md`, which governs it and is marked
 * counsel-owned and verbatim. The spec was reachable from three other docs. Reachability
 * did not help, because nobody was looking for it. Only an interruption at the moment of
 * the edit would have.
 *
 * Contract (matches the secret-file guard already in settings.json):
 *   stdin  — the PreToolUse payload; `.tool_input.file_path` is the target
 *   exit 0 — allow. Advisory text on stderr for `spec` / `reference`.
 *   exit 2 — block, with the reason on stderr. ONLY for `authority: counsel`.
 *
 * FAILS OPEN, deliberately. A hook that errors must not wedge every edit in the tree — a
 * broken guard that blocks everything gets disabled wholesale, and then it guards nothing.
 * The one exception is the block path itself, which is reached only after a successful
 * lookup.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SKILL is the propagate root. As a PLUGIN hook the harness sets CLAUDE_PLUGIN_ROOT;
// run directly (tests, manual invocation) it derives from this file's own location —
// hooks/doc-authority.mjs, so the root is two levels up. It previously hardcoded
// ~/.claude/skills/propagate, which the 2026-08-22 plugin cutover deleted: the hook then
// concluded "not installed" and went silent, which is right behaviour on a wrong premise.
const SKILL =
  process.env.CLAUDE_PLUGIN_ROOT ||
  path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  let filePath;
  try {
    filePath = JSON.parse(readStdin())?.tool_input?.file_path;
  } catch {
    process.exit(0); // unparseable payload is not the editor's problem
  }
  if (!filePath) process.exit(0);

  // ABSENT and BROKEN are different facts and must not render the same
  // (rule:discernment-checks §2). This hook exited 0 on every edit from
  // 2026-08-20 to 2026-08-22 because lib/ was reorganised into subdirectories
  // and the old flat paths threw — indistinguishable from "not installed", so
  // nothing reported it. Both still FAIL OPEN, per the header: a guard that
  // blocks everything gets disabled wholesale. Only the silence changes.
  let docs, config;
  try {
    docs = await import(path.join(SKILL, "lib", "report", "docs.mjs"));
    config = await import(path.join(SKILL, "lib", "core", "config.mjs"));
  } catch (err) {
    if (!existsSync(SKILL)) process.exit(0); // genuinely not installed — silence is correct
    process.stderr.write(
      `doc-authority: propagate is present at ${SKILL} but its modules did not load, ` +
        `so NOTHING was checked for this edit.\n  ${err?.message ?? err}\n`,
    );
    process.exit(0); // still fail open — but no longer silently
  }

  let index;
  try {
    const { findAllSidecarsRecursive } = await import(path.join(SKILL, "lib", "edges", "edges.mjs"));
    const sidecars = [];
    for (const ws of config.WORKSPACES) {
      // Only the workspace containing this file can govern it; scanning all nine on every
      // keystroke is waste the editor pays for.
      if (!path.resolve(filePath).startsWith(path.resolve(ws.root) + path.sep)) continue;
      sidecars.push(...(await findAllSidecarsRecursive(ws.root)));
    }
    if (sidecars.length === 0) process.exit(0);
    index = docs.buildAuthorityIndex(sidecars);
  } catch {
    process.exit(0);
  }

  const result = docs.whatGoverns(filePath, index);
  if (!result.governed) process.exit(0); // silence is correct here: most files are ungoverned

  const blocking = result.hits.filter((h) => docs.blocks(h.authority));
  const rel = (p) => path.relative(process.cwd(), p) || p;

  if (blocking.length > 0) {
    const h = blocking[0];
    process.stderr.write(
      `BLOCKED: ${path.basename(filePath)} is governed by ${rel(h.source)}\n` +
        `  ${h.why}\n` +
        `  authority: counsel — its wording is not the renderer's to change.\n` +
        `  Read that document first. If it is wrong, change it there and record why;\n` +
        `  if this edit is still right, say so and re-run.\n`,
    );
    process.exit(2);
  }

  for (const h of result.hits) {
    process.stderr.write(`note: ${path.basename(filePath)} — see ${rel(h.source)} (${h.authority})${h.why ? ` — ${h.why}` : ""}\n`);
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
