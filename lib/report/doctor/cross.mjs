/**
 * Doctor's two cross-repo checks (propagate#117). Collects into a Reporter and
 * prints nothing, like its siblings.
 *
 *  (a) cross-client edges: reads the reconcile rows doctor already computed
 *      (environment.mjs owns the one reconcile() of a run, D8) and fails on any
 *      edge joining two different client workspaces with no shared platform root
 *      at either end. A blind scan is `inconclusive`, never a pass.
 *  (b) legacy .propagates-cross.yml: the format is retired and never fired, so
 *      every entry still in one fails with the move instruction.
 */
import { crossClientViolations, legacyCrossEntries } from "../../edges/cross-repo.mjs";

/**
 * Severity of what this section reports. S2: a wrong answer is misleading rather than silent.
 * A client-to-client edge or a retired-format entry is visible to anyone who reads the sidecar,
 * and a blind scan says so as `inconclusive` instead of passing, so doctor is never quietly
 * wrong about the tree. Not S1 for that reason; not S3 because the old line it replaced
 * ("cross-repo edges resolve") printed a green tick over entries nothing fired.
 */
export const SEVERITY = "S2";

export function checkCrossRepoEdges({ reporter, rows, hubRoot, workspaces, platformRoots, searchRoots }) {
  // (a)
  if (!hubRoot) {
    reporter.info("cross-client edges", "no hubRoot configured, so there is no client boundary to guard (set hubRoot in config.yml)");
  } else if (!Array.isArray(rows)) {
    reporter.inconclusive("cross-client edges", "reconcile rows were not computed, so no edge was examined");
  } else {
    const g = crossClientViolations(rows, { hubRoot, workspaces, platformRoots });
    if (g.clientWorkspaces < 2) {
      // An edge can join two clients only if two exist. This is "nothing to guard", not a blind
      // scan: a fresh install with one workspace must not exit non-zero for having a small tree.
      // (A tree that really has many clients but discovered under two is caught elsewhere:
      // doctor's discovery checks.)
      reporter.info("cross-client edges", `${g.clientWorkspaces} client workspace(s) under the hub, so no edge can join two`);
    } else if (g.blind) {
      reporter.inconclusive("cross-client edges", g.blind);
    } else if (g.violations.length === 0) {
      reporter.check("cross-client edges", true, `${g.examined} cross-repo edges examined, 0 join two client workspaces`);
    } else {
      for (const v of g.violations) {
        reporter.check(
          "cross-client edge",
          false,
          `${v.source} (${v.ownerA}) -> ${v.downstream} (${v.ownerB}): two client workspaces with no shared platform root at either end`,
        );
      }
    }
  }
  // (b)
  const legacy = legacyCrossEntries(searchRoots);
  for (const u of legacy.unreadable) {
    reporter.check("legacy .propagates-cross.yml", false, `${u.file} could not be read (${u.error}); a file that cannot be read is not a clean one`);
  }
  for (const e of legacy.entries) {
    reporter.check(
      "legacy .propagates-cross.yml entry",
      false,
      `${e.file} (${e.kind} ${e.target}): declared in a format nothing fires; move it to .propagates.yml (propagate#117)`,
    );
  }
  if (legacy.entries.length === 0 && legacy.unreadable.length === 0) {
    reporter.check("legacy .propagates-cross.yml", true, `${legacy.files} file(s) scanned, 0 entries`);
  }
}
