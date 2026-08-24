/**
 * active-lines.mjs — which branch each project actually deploys from.
 *
 * WHY THIS IS NOT DERIVED FROM GIT. `is_active_line` is a required field of the
 * snapshot (`docs/REFERENCE.md:106-110`), and it records a DECISION, not a fact
 * about the repository. `VipinKaushik` deploys from `production` while `main`
 * sits archived at a tag — no probe of the repo can tell you that, and
 * `rule:conventions/WORKTREES.md` records an incident where a resolver that
 * tried (origin/production, else origin/main, take whichever exists) named a
 * stale, long-abandoned branch as the active line and reported a
 * destructive-drop risk against it.
 *
 * So it comes from `docs/conventions/CONTEXT-BUDGET.md`'s `[active_lines]`
 * block, which is the same source the retired `hygiene/lib/active-lines.sh`
 * read. This module is that lib brought forward out of C2, because the
 * per-project snapshot cannot be written correctly without it.
 *
 * THREE OUTCOMES, NEVER CONFLATED (rule:discernment-checks §2):
 *
 *   { lines: {...} }                  the section was read
 *   { lines: {}, reason: "..." }      no config file, or no section, or the
 *                                     file could not be parsed — each with its
 *                                     own wording, because they need different
 *                                     fixes
 *
 * An empty `lines` with no reason would be indistinguishable from "this
 * workspace declares nothing", which is the silent-zero this codebase keeps
 * paying for. It never throws: a throw here takes `doctor` and `migrate-refs`
 * down with it.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/** Where the convention lives, relative to a workspace root. */
export const BUDGET_REL = path.join("docs", "conventions", "CONTEXT-BUDGET.md");

/**
 * @param {string} workspaceRoot
 * @returns {{lines: Record<string,string>, source: string, reason?: string}}
 */
export function readActiveLines(workspaceRoot) {
  const source = path.join(workspaceRoot, BUDGET_REL);
  const none = (reason) => ({ lines: {}, source, reason });

  if (!existsSync(source)) {
    // The common case, and a legitimate one: most workspaces have no
    // CONTEXT-BUDGET.md. Named so a null `is_active_line` downstream is
    // attributable rather than mysterious.
    return none(`no CONTEXT-BUDGET.md at ${BUDGET_REL} — no active line is declared for this workspace`);
  }

  let text;
  try {
    text = readFileSync(source, "utf8");
  } catch (err) {
    return none(`CONTEXT-BUDGET.md could not be read: ${err?.message ?? err}`);
  }

  // The config is a fenced ```toml block inside a markdown document, which is
  // how the shell lib reads it too. Matching the fence rather than the whole
  // file keeps prose that merely mentions `[active_lines]` from being parsed.
  const fenced = text.match(/```toml\n([\s\S]*?)\n```/);
  const body = fenced ? fenced[1] : null;
  if (!body) {
    return none("CONTEXT-BUDGET.md has no ```toml block — nothing to parse");
  }

  const start = body.search(/^\[active_lines\]\s*$/m);
  if (start === -1) {
    return none("CONTEXT-BUDGET.md declares no [active_lines] section");
  }

  // Up to the NEXT section header. Without this bound the walk runs on into
  // [canonical_paths] and registers its keys as active lines — a wrong answer
  // that looks exactly like a right one.
  const rest = body.slice(start).split("\n").slice(1);
  const lines = {};
  for (const raw of rest) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\[.+\]$/.test(line)) break;
    // `key = "value"` with the key optionally quoted — both forms appear in the
    // live config (`astroacharya` bare, `"marketing-intel"` quoted because of
    // the hyphen).
    const m = line.match(/^"?([^"=\s]+)"?\s*=\s*"([^"]*)"\s*$/);
    if (!m) continue;
    lines[m[1]] = m[2];
  }

  if (Object.keys(lines).length === 0) {
    return none("[active_lines] is present but declares no projects");
  }
  return { lines, source };
}
