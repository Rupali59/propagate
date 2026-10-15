/**
 * health-exceptions.mjs (doctor glue) — applies the declared-exceptions registry to doctor's
 * Discovery-integrity findings. The pure logic is lib/report/health-exceptions.mjs; this owns
 * only the reporting, so it can be tested against a bare Reporter.
 *
 * Usage, per excepted check:  `gate.apply(checkId, findings)` returns the findings that still
 * FAIL and emits one `accepted` entry per accepted finding. `gate.finish()` runs once, after
 * every excepted check, and reports stale exceptions and registry problems.
 *
 * REGISTRY MISSING: not configured/absent. If any finding failed, that is an attributable
 * failure (the reader must learn why no exception was consulted). If nothing failed there was
 * nothing to except, so it is an info line and a fresh machine stays doctor-clean.
 * REGISTRY BROKEN (unparseable, bad key, missing reason/since): always a failure, because it
 * could hide a decision either way.
 */

/**
 * Severity of what this section reports (N87 slice 2b). S3: a stale or unreadable exceptions list
 * never loses data or hides a failure (a finding it cannot match simply stays a failure); it makes
 * the report noisier or less informative.
 */
export const SEVERITY = "S3";

import { loadHealthExceptions, adjudicate, staleExceptions, exceptionKey } from "../health-exceptions.mjs";

/**
 * @param {{reporter: import("./reporter.mjs").Reporter, registryFile: string|null|undefined}} opts
 */
export function createExceptionGate({ reporter, registryFile }) {
  const reg = loadHealthExceptions(registryFile);
  const evaluated = new Set();
  const seenFailing = new Set();
  let anyFailing = 0;
  let acceptedTotal = 0;

  return {
    /** Hub-relative form of a path, for building subjects. Falls back to the absolute path. */
    relPath(p) {
      return reg.hub && p.startsWith(reg.hub + "/") ? p.slice(reg.hub.length + 1) : p;
    },

    /** Mark a check as having run to a verdict (also done by apply()). */
    markEvaluated(checkId) {
      evaluated.add(checkId);
    },

    /**
     * @param {string} checkId
     * @param {Array<{subject: string, label?: string, action?: {kind: string, target: string}}>} findings
     * @returns {object[]} the findings that still fail
     */
    apply(checkId, findings) {
      evaluated.add(checkId);
      for (const f of findings) seenFailing.add(exceptionKey(checkId, f.subject));
      const { failing, accepted } = adjudicate(reg.entries, checkId, findings);
      anyFailing += failing.length;
      for (const a of accepted) {
        acceptedTotal++;
        reporter.accepted(
          `${a.finding.label ?? a.key}`,
          `${a.key} — ${a.reason} (since ${a.since})`,
          a.finding.action,
        );
      }
      return failing;
    },

    finish() {
      if (reg.state === "broken") {
        reporter.check("health-exceptions registry parses", false, `${reg.file}: ${reg.problems.join("; ")}`);
        return { accepted: acceptedTotal, stale: [] };
      }
      if (reg.state === "missing") {
        const why = `${reg.problems.join("; ")} — no exception was consulted, so every finding above is reported as a failure`;
        if (anyFailing > 0) reporter.check("health-exceptions registry present", false, why);
        else reporter.info("health exceptions", `registry unavailable (${reg.problems.join("; ")}); nothing failed, so nothing needed an exception`);
        return { accepted: 0, stale: [] };
      }
      const { stale, unjudged } = staleExceptions(reg.entries, evaluated, seenFailing);
      if (unjudged.length) {
        reporter.info("health exceptions not judged", `${unjudged.join(", ")} — their check did not run to a verdict this run, so staleness is unknown`);
      }
      reporter.check(
        "health exceptions are all still needed",
        stale.length === 0,
        stale.length
          ? `STALE: ${stale.join(", ")} — the finding no longer fails; remove the entr${stale.length === 1 ? "y" : "ies"} from ${reg.file} (the list may not outlive its reason)`
          : `${reg.entries.size} listed, ${acceptedTotal} accepted this run`,
      );
      return { accepted: acceptedTotal, stale };
    },
  };
}
