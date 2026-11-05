/**
 * services.mjs — doctor's offline services section.
 *
 * OFFLINE ONLY: it calls `buildServicesReport`, which makes no network call, writes nothing and
 * opens no secret file. Quiet when clean (one line). Findings are warnings, never failures: a
 * missing page or a stale limit is documentation debt, not a broken install. A could-not-run is
 * `inconclusive` (the third state), never a pass and never zero services.
 */

import { INTEGRATIONS, WORKSPACES } from "../../core/config.mjs";
import { buildServicesReport } from "../services.mjs";

export const SEVERITY = "S3";

/**
 * @param {{reporter: import("./reporter.mjs").Reporter, workspaces?: object[], integrations?: object, minUnits?: number}} o
 * @returns {Promise<{report: object|null}>}
 */
export async function checkServices({ reporter, workspaces = WORKSPACES, integrations = INTEGRATIONS, minUnits, hubRoot, gotchasFile, now } = {}) {
  // Not configured is the normal state on any other machine: say so in one line, not as a problem.
  if (!integrations.servicesFile) {
    reporter.info("services", "services.yml is not configured on this machine — skipped (PROPAGATE_SERVICES_FILE or integrations.servicesFile)");
    return { report: null };
  }
  const report = buildServicesReport({
    workspaces,
    integrations,
    ...(minUnits !== undefined ? { minUnits } : {}),
    ...(hubRoot !== undefined ? { hubRoot } : {}),
    ...(gotchasFile !== undefined ? { gotchasFile } : {}),
    ...(now !== undefined ? { now } : {}),
  });
  if (report.state === "could-not-run") {
    reporter.inconclusive("services", report.reason, { kind: "command", target: "propagate services" });
    return { report };
  }
  if (report.findings.length === 0) {
    reporter.check("services", true, `${report.services.length} service(s), ${report.units_scanned} unit(s), no findings`);
    return { report };
  }
  const parts = Object.entries(report.counts.byState).map(([k, n]) => `${n} ${k}`);
  reporter.warn("services", `${report.findings.length} finding(s): ${parts.join(" · ")} — run \`propagate services\``);
  return { report };
}
