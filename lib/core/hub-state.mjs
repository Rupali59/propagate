/**
 * hub-state.mjs — where propagate's own working state lives now that the repo is public.
 *
 * Since 2026-10-19 (propagate #12, "the public repo carries only the tool") STATE, DECISIONS,
 * GOTCHAS, ISSUES, TODOS and the archive are not in this repo: they are in the PRIVATE hub that
 * surrounds the checkout, at `<hub>/propagation/state/<repo basename>/`, and what remains here
 * is a pointer stub at each old path (`propagation/state/workspace/<FILE>`). The same is true
 * of the working docs (`docs/plans`, `docs/archive`, `docs/deferred`, `docs/AUDIT-*.md`), which
 * moved to `<hub>/propagation/docs/<repo basename>/`. The layout rule is `rule:workspace-docs-layout`;
 * the canonical statement of both paths is `docs/REFERENCE.md` §"Propagation layout".
 *
 * DERIVED FROM THE REPO'S PARENT, never configured. A clone anywhere else (a stranger's machine,
 * CI, a tmp dir) has no such parent, and every reader of these files must then say "not
 * present, skipped" with a reason rather than pass silently (rule:discernment-checks §2). That
 * is why these functions return `null` and never throw: "the hub is absent" and "the file is
 * empty" are different facts and only the caller can word the difference.
 *
 * A directory only counts when its `.sidecar.yml` names this repo (`repo_root: <basename>`),
 * so an unrelated sibling directory that happens to share the name is not mistaken for the
 * project's state.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT_RE = /^repo_root:[ \t]*["']?([^"'#\r\n]*?)["']?[ \t]*(?:#.*)?$/m;

/**
 * `<hub>/propagation/state/<basename(repoRoot)>`, or null when no hub surrounds the repo.
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function hubStateDir(repoRoot) {
  const root = path.resolve(repoRoot);
  const name = path.basename(root);
  const dir = path.join(path.dirname(root), "propagation", "state", name);
  const sidecar = path.join(dir, ".sidecar.yml");
  if (!existsSync(sidecar)) return null;
  try {
    const declared = (REPO_ROOT_RE.exec(readFileSync(sidecar, "utf8")) || [])[1]?.trim();
    return declared === name ? dir : null;
  } catch {
    return null;
  }
}

/**
 * The hub copy of one moved state file (`STATE.md`, `DECISIONS.md`, `GOTCHAS.md`, …), or null
 * when the hub is absent or does not hold that file.
 * @param {string} repoRoot
 * @param {string} file  a path relative to the state directory, e.g. "DECISIONS.md" or "archive/STATE-2026-09.md"
 * @returns {string|null}
 */
export function hubStateFile(repoRoot, file) {
  const dir = hubStateDir(repoRoot);
  if (!dir) return null;
  const p = path.join(dir, file);
  return existsSync(p) ? p : null;
}

/**
 * `<hub>/propagation/docs/<basename(repoRoot)>` (moved plans, archive, deferred, audits), or null.
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function hubDocsDir(repoRoot) {
  if (!hubStateDir(repoRoot)) return null;
  const root = path.resolve(repoRoot);
  const dir = path.join(path.dirname(root), "propagation", "docs", path.basename(root));
  return existsSync(dir) ? dir : null;
}

/**
 * The reason string every reader gives when it skips because the hub copy is not here. One
 * wording, so a skip is recognisable in test output and cannot be mistaken for a pass.
 * @param {string} what  e.g. "propagation/state/propagate/DECISIONS.md"
 */
export function hubAbsentReason(what) {
  return `the private hub copy (${what}) is not present beside this checkout — propagate's working state and docs live in the private hub since 2026-10-19 (propagate #12); a standalone clone gets pointer stubs, so this check is skipped here, not passed`;
}
