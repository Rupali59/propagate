/**
 * update-notice.mjs — surface `bin/propagate-update-check`'s answer to a human.
 *
 * WHY THIS FILE EXISTS AT ALL. The check was written and then invoked by nothing: the only
 * file mentioning `propagate-update-check` was the script itself. That is GOTCHAS G48 —
 * an enforcement point that does not watch anything — and it is the third time this repo
 * has recorded that shape (a drift gate rolled out to seven repos but not this one; N6's
 * edge that could not fire; now an update check nobody calls). A capability nobody invokes
 * is indistinguishable from one that was never built.
 *
 * DESIGN CONSTRAINTS, all of them about not being annoying enough to get disabled:
 *
 *  - ONE line, or nothing. Never a paragraph, never a box.
 *  - NEVER throws, never rejects, never blocks. The check is best-effort by construction;
 *    a tool that fails because a version lookup failed is worse than one that misses a
 *    notice.
 *  - Bounded wall time. The script self-limits (curl --max-time 3, 24h cache), and this
 *    adds a hard spawn timeout so a wedged child cannot hold the CLI open.
 *  - Silence means "nothing to report", and only that. Every other state the script can be
 *    in — disabled, snoozed, offline, cached — is silent by ITS design, and each is
 *    recoverable by the user without reading code.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { SKILL_DIR } from "./config.mjs";

/**
 * Run the check and return the single line it produced, or null.
 *
 * Exported separately from the printing so a test can assert the LINE without capturing
 * stdout — a check whose only observable is console output is a check that is awkward to
 * prove fires.
 *
 * @returns {string|null}
 */
export function updateNotice({ skillDir = SKILL_DIR, env = process.env } = {}) {
  try {
    const script = path.join(skillDir, "bin", "propagate-update-check");
    if (!existsSync(script)) return null; // absent in a partial install: not an error

    const r = spawnSync(script, [], {
      encoding: "utf8",
      timeout: 5000,
      env,
      stdio: ["ignore", "pipe", "ignore"], // stderr discarded: this must never add noise
    });
    const line = String(r.stdout ?? "").trim();
    return line.length ? line.split("\n")[0] : null;
  } catch {
    return null; // best-effort, always
  }
}

/**
 * Render the notice for a human, or return null when there is nothing to say.
 *
 * The wording carries the action. "UPGRADE_AVAILABLE 0.1.0 0.2.0" is a machine line; a
 * person needs to know what to type and how to stop being told.
 */
export function formatUpdateNotice(line, { dim = "", reset = "" } = {}) {
  if (!line) return null;
  const [kind, a, b] = line.split(/\s+/);
  if (kind === "UPGRADE_AVAILABLE") {
    return `${dim}propagate ${a} → ${b} available: git -C ${SKILL_DIR} pull` +
      ` · silence it with \`updateCheck: off\` in config.yml${reset}`;
  }
  if (kind === "JUST_UPGRADED") {
    return `${dim}propagate upgraded ${a} → ${b}${reset}`;
  }
  return null;
}
