/**
 * v3-layout.mjs — what a conforming `propagation/` folder contains, and which
 * parts of it a given workspace is missing.
 *
 * The canonical statement of the layout is `docs/REFERENCE.md` §"Propagation
 * layout". This module is that section made executable; it must not restate a
 * path anywhere else, and the section must not describe a tree this file does
 * not check. They are declared as a coupling in `.propagates.yml`.
 *
 * WHY THIS EXISTS AT ALL. Measured 2026-08-22 across seven workspaces: two
 * carried `propagation/state/`, one carried a branch registry, two carried a
 * forked `scripts/hygiene/` stack (5 of 8 shared libs diverged), and four
 * carried nothing but a ledger. Every divergence was individually reasonable.
 * Together they meant no check could be written once — which is the whole
 * argument for a standard, and the reason this predicate is the ratchet for
 * every later phase of docs/plans/2026-08-22-v3-one-propagation-standard.md.
 *
 * THE PREDICATE MUST BE ABLE TO FAIL, AND MUST BE SEEN TO. On the day it was
 * written it was expected to fail on six of seven workspaces. A conformance
 * check that is green before the conforming work has happened is not checking
 * anything (rule:discernment-checks §1), so `tests/unit/v3-layout.test.mjs`
 * asserts the negative cases first and `doctor` prints WHICH items are absent
 * rather than a bare verdict (§2 — absence must be attributable).
 *
 *     <workspace>/propagation/
 *       README.md              generated
 *       INDEX.md               derived
 *       refs/snapshot.json     derived, schema_version'd
 *       refs/lifecycle.jsonl   append-only
 *       state/<project>/       STATE.md  DECISIONS.md  .sidecar.yml
 *       archive/               frozen v1 rows        <- NOT required; see below
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The items a conforming workspace must have.
 *
 * `archive/` is deliberately NOT here. It only exists once a workspace HAD a v1
 * ledger to freeze (Phase D), and two workspaces — Motherboard and Obsidian —
 * have zero v1 rows and will never grow one. Requiring it would make those two
 * permanently non-conforming for the absence of an artifact they should not
 * have, which is the "check that fails every fresh install forever" shape
 * doctor's own retired-watcher probe was rewritten to avoid.
 *
 * The ledger itself is likewise absent: `doctor` already has dedicated checks
 * for ledger existence and for more-than-one-live-ledger, and duplicating them
 * here would report one fact as two failures (GOTCHAS G20).
 */
export const V3_REQUIRED = Object.freeze([
  "README.md",
  "INDEX.md",
  "refs/snapshot.json",
  "refs/lifecycle.jsonl",
  "state/",
]);

/** True when `dir` exists and holds at least one subdirectory. */
function hasProjectDir(dir) {
  try {
    return readdirSync(dir).some((e) => {
      try {
        return statSync(path.join(dir, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Which v3 items `workspaceRoot` is missing.
 *
 * `state/` is satisfied only by a real project directory inside it, never by
 * the bare folder: an empty `state/` is scaffolding that ran, not state that
 * exists, and treating the two as the same is how a migration reports itself
 * complete halfway through.
 *
 * Never throws — a workspace with no `propagation/` at all reports every item
 * missing, which is the correct and attributable answer rather than an error
 * that stops `doctor` from reporting on the other six workspaces.
 *
 * @param {string} workspaceRoot
 * @returns {{conforms: boolean, missing: string[], root: string}}
 */
export function conformance(workspaceRoot) {
  const prop = path.join(workspaceRoot, "propagation");
  const missing = [];
  for (const item of V3_REQUIRED) {
    const target = path.join(prop, item);
    const ok = item === "state/" ? hasProjectDir(target) : existsSync(target);
    if (!ok) missing.push(item);
  }
  return { conforms: missing.length === 0, missing, root: workspaceRoot };
}

/**
 * True when a workspace holds at least one v3-only item — i.e. someone has
 * begun migrating it.
 *
 * THIS GATE IS WHY THE CHECK CAN BE A `check()` AT ALL. Requiring the full tree
 * of every workspace unconditionally makes `doctor` fail for every workspace
 * and every fresh install until the migration finishes, which is the shape
 * doctor's retired-watcher probe was rewritten to avoid: "a check() here fails
 * every fresh install forever for the absence of a dead component's artifact."
 * `tests/cli/stranger-install.test.mjs` asserts a fresh machine reaches
 * doctor-clean, and it caught this within one run.
 *
 * Same structure as the monitor liveness probe (cli.mjs): gate on evidence that
 * the thing was turned ON, then hold it to the standard. Not started is
 * informational; STARTED AND INCOMPLETE is a failure, because a half-migrated
 * workspace is the state that silently loses data.
 *
 * @param {string} workspaceRoot
 * @returns {boolean}
 */
export function hasStartedV3(workspaceRoot) {
  return conformance(workspaceRoot).missing.length < V3_REQUIRED.length;
}

/**
 * Conformance across many workspaces, for `doctor`'s single check line.
 *
 * One check label, not one per workspace: `tests/cli/doctor-check-coverage.test.mjs`
 * parses literal `check("...")` strings out of cli.mjs, so a label templated
 * with a workspace name would be invisible to the coverage ratchet on every
 * machine — the check would exist and nothing would enforce that it can fail.
 *
 * @param {Array<{root: string, name: string}>} workspaces
 * @returns {{conforming: number, total: number, offenders: Array<{name: string, missing: string[]}>}}
 */
export function conformanceReport(workspaces) {
  const offenders = [];
  const notStarted = [];
  for (const ws of workspaces) {
    const r = conformance(ws.root);
    if (r.conforms) continue;
    // STARTED = holds at least one v3-only item. See `hasStartedV3`.
    (r.missing.length === V3_REQUIRED.length ? notStarted : offenders).push({
      name: ws.name,
      missing: r.missing,
    });
  }
  return {
    conforming: workspaces.length - offenders.length - notStarted.length,
    total: workspaces.length,
    offenders,
    notStarted,
  };
}
