/**
 * standards.mjs — doctor's offline `# Standards` section (design §2.3, propagate#269).
 *
 * OFFLINE ONLY: reads the registry, the pages, the sidecars and the cached tool versions. It makes no network call,
 * runs no project check and spawns no probe. THE THREE STATES:
 *   - not configured            -> `info`, skipped (the normal state on another machine)
 *   - could not run             -> `inconclusive` (a broken registry or page, a blind scan). Votes, never a pass.
 *   - ran and found something   -> `warn` (documentation debt, never counted) or `check(false)` (a declaration
 *                                  error, like a stale `exclude`: counted).
 * So a tree with standards configured and only warnings leaves doctor's problem count unchanged.
 *
 * Detected-not-adopted and adopted-undetected are judged for `tool` standards only: a global or production
 * standard "detects" any code unit, so every project would warn and the finding would carry nothing.
 *
 * Not in this increment (design §2.3): UNAPPROVED-CHANGE and APPROVALS-NOT-CONFIGURED (S4), ADOPTED-UNSETTLED (S3),
 * POINTERS-DRIFT (S5), AUTHORITY-UNRESOLVED (online).
 */
import { INTEGRATIONS, WORKSPACES } from "../../core/config.mjs";
import { stateDir as defaultStateDir } from "../../core/paths.mjs";
import { collectUnits, MIN_UNITS } from "../services.mjs";
import { readAdoptions } from "../../standards/adopt.mjs";
import { loadStandards } from "../../standards/registry.mjs";
import { readSidecars, serviceDetectsFor } from "../../standards/sidecars.mjs";
import { buildStandardsReport, NO_VERSION_REASON } from "../../standards/status.mjs";
import { cacheAge, readVersions } from "../../standards/versions.mjs";

/** The section's severity, as `doctor/services.mjs` declares it: the worst finding that can FAIL (a declaration error, S2). */
export const SEVERITY = "S2";

/** Severity per finding (design §2.3). `tests/unit/doctor-severity.test.mjs` requires SEVERITY above to be a single S1/S2/S3. */
export const FINDING_SEVERITY = Object.freeze({
  "STANDARDS-UNREADABLE": "S2",
  "RE-VERIFY": "S3",
  "VERSION-NOT-READ": "info",
  "UNCHECKED-ROW": "info",
  "CHECK-CANNOT-FAIL": "S2",
  "DETECTED-NOT-ADOPTED": "S3",
  "ADOPTED-UNDETECTED": "S3",
  "UNIT-NOT-ON-DISK": "S3",
  "OVERRIDE-NO-REASON": "S2",
  "OVERRIDE-STALE": "S2",
  "DECLINE-NO-REASON": "S2",
});

const NUM = /\d+\.\d+(?:\.\d+)?/;
const blank = (v) => typeof v !== "string" || v.trim() === "";
const uniq = (a) => [...new Set(a)];
const ACTION = { kind: "command", target: "propagate standards" };

/**
 * @param {{reporter: import("./reporter.mjs").Reporter, integrations?: object, workspaces?: object[], stateDir?: string, now?: number, units?: object[], minUnits?: number}} o
 */
export async function checkStandards({ reporter, integrations = INTEGRATIONS, workspaces = WORKSPACES, stateDir = defaultStateDir(), now = Date.now(), units, minUnits = MIN_UNITS } = {}) {
  reporter.header("# Standards");
  const loaded = loadStandards({ standardsFile: integrations.standardsFile, standardsDir: integrations.standardsDir });
  if (!loaded.ok) {
    if (/^standards not configured/.test(loaded.reason)) {
      reporter.info("standards", "standards are not configured on this machine — skipped (PROPAGATE_STANDARDS_FILE and PROPAGATE_STANDARDS_DIR, or standardsFile and standardsDir in config.yml)");
    } else reporter.inconclusive("standards", `STANDARDS-UNREADABLE: ${loaded.reason}`, ACTION);
    return { report: null };
  }
  const serviceDetects = serviceDetectsFor(loaded, integrations);
  const allUnits = units ?? collectUnits(workspaces, { integrations });
  const sidecars = readSidecars(workspaces);
  const report = buildStandardsReport({ standards: loaded.standards, units: allUnits, sidecars, versions: readVersions(stateDir), now, minUnits, serviceDetects, problems: [] });
  const pageOf = (id) => loaded.standards.find((s) => s.id === id)?.page ?? null;
  const strip = (m) => String(m).replace(/^STANDARDS-UNREADABLE: /, "");
  const unreadable = [...loaded.problems];
  if (report.ok) unreadable.push(...report.problems);
  if (!report.ok) unreadable.push(report.blind ?? `unknown project ${report.unknownProject}`);
  // One defect, one entry: a file the report already named is not named again by the declarations pass.
  const declarations = report.ok ? declarationsOf(sidecars, pageOf, unreadable) : null;
  if (unreadable.length) {
    const shown = unreadable.slice(0, 3).map(strip).join("; ");
    reporter.inconclusive("standards", `STANDARDS-UNREADABLE: ${unreadable.length} problem(s): ${shown}${unreadable.length > 3 ? "; ..." : ""}`, ACTION);
  }
  if (!report.ok) return { report: null };

  const declinedBy = (std) => new Set(declarations.declined.filter((d) => d.standard === std).map((d) => `${d.workspace}/${d.project}`));
  let notRead = 0;

  for (const s of report.standards) {
    const page = pageOf(s.id);
    const live = (page?.rows ?? []).filter((r) => r.state !== "retired");

    const reverify = s.rows.filter((r) => r.status === "re-verify");
    if (reverify.length) {
      const inUse = uniq(s.projects.flatMap((p) => p.units.map((u) => u.version)).filter(Boolean).map((v) => NUM.exec(v)?.[0] ?? v));
      const rowVers = uniq(live.filter((r) => reverify.some((x) => x.id === r.id)).map((r) => NUM.exec(r.version ?? "")?.[0]).filter(Boolean));
      reporter.warn("standards", `RE-VERIFY ${s.id}: ${reverify.length} row(s) re-verify (${rowVers.join(", ") || "?"} → ${inUse.join(", ") || "?"}) — propagate standards --std ${s.id}`);
    }
    notRead += s.rows.filter((r) => r.reason === NO_VERSION_REASON).length;
    if (s.counts.unchecked > 0) reporter.info("standards", `UNCHECKED-ROW ${s.id}: ${s.counts.unchecked} row(s) unchecked; review rows are recorded with \`standards review\` (#290)`);

    const cannotFail = live.filter((r) => (r.check.kind === "command" || r.check.kind === "test") && !r.failsWhen).map((r) => r.id);
    if (cannotFail.length) reporter.warn("standards", `CHECK-CANNOT-FAIL ${s.id}: ${cannotFail.length} row(s) have a ${"command/test"} check but no \`Fails when:\` — ${cannotFail.join(", ")}`);

    if (s.kind !== "tool") continue;
    const adoptedKeys = new Set(s.adopted.map((a) => `${a.workspace}/${a.project}`));
    const declined = declinedBy(s.id);
    const wsOf = new Map();
    for (const u of allUnits) wsOf.set(u.project, (wsOf.get(u.project) ?? new Set()).add(u.workspace));
    const label = (p) => ((wsOf.get(p.project)?.size ?? 0) > 1 ? `${p.workspace}/${p.project}` : p.project);
    const loose = uniq(s.projects.filter((p) => !adoptedKeys.has(`${p.workspace}/${p.project}`) && !declined.has(`${p.workspace}/${p.project}`)).map(label));
    if (loose.length) reporter.warn("standards", `DETECTED-NOT-ADOPTED ${s.id}: detected but neither adopted nor declined: ${loose.join(", ")} — propagate standards adopt ${s.id} ${loose.some((l) => l.includes("/")) ? "<workspace>/<project>" : "<project>"}`);

    const detected = new Set(s.detected);
    const onDisk = new Set(allUnits.map((u) => `${u.workspace}/${u.project}/${u.rel}`));
    const missing = [];
    const undetected = [];
    for (const a of s.adopted) {
      const listed = a.units.length ? a.units : null;
      if (listed) {
        for (const u of listed) {
          if (!onDisk.has(`${a.workspace}/${a.project}/${u}`)) missing.push(`${a.project}:${u}`);
          else if (!detected.has(`${a.workspace}/${u}`)) undetected.push(`${a.project}:${u}`);
        }
      } else if (![...detected].some((d) => s.projects.some((p) => p.project === a.project && d.startsWith(`${p.workspace}/`)))) undetected.push(a.project);
    }
    if (missing.length) reporter.warn("standards", `UNIT-NOT-ON-DISK ${s.id}: adopted unit(s) not on disk: ${missing.join(", ")}`);
    if (undetected.length) reporter.warn("standards", `ADOPTED-UNDETECTED ${s.id}: adopted but the detector finds nothing: ${undetected.join(", ")}`);
  }
  const cached = readVersions(stateDir);
  if (cached) reporter.info("standards", `versions read ${cacheAge(cached, now) ?? "at an unreadable time"}`);
  if (notRead > 0) reporter.info("standards", `VERSION-NOT-READ ${notRead} row(s) version not read: standards versions --refresh`);

  if (declarations.findings.length === 0) {
    reporter.check("standards declarations", true, `${declarations.overrides} override(s), ${declarations.declined.length} decline(s), each with a reason`);
  } else for (const f of declarations.findings) reporter.check("standards declarations", false, f);
  return { report };
}

/**
 * `checkStandards`, with a throw turned into an `inconclusive` entry (counted as a problem). Doctor calls this, not
 * `checkStandards`: a section that can go inconclusive must not let "could not run" read as "no problem".
 */
export async function runStandardsSection(opts) {
  try {
    return await checkStandards(opts);
  } catch (err) {
    opts.reporter.inconclusive("standards", `standards could not run: ${err?.message ?? err}`, ACTION);
    return { report: null };
  }
}

/** Overrides and declines from every readable sidecar, with the declaration errors found in them. */
function declarationsOf(sidecars, pageOf, unreadable) {
  const out = { findings: [], overrides: 0, declined: [] };
  for (const sc of sidecars) {
    if (sc.error || sc.standards === undefined || sc.standards === null) continue;
    const ad = readAdoptions(sc.file);
    if (ad.error) {
      if (!unreadable.some((m) => String(m).includes(sc.file))) unreadable.push(ad.error);
      continue;
    }
    const adopted = new Set(ad.adopted.map((a) => a?.standard));
    for (const o of ad.overrides) {
      out.overrides++;
      const id = `${o?.standard ?? "?"} ${o?.row ?? "?"}`;
      if (blank(o?.reason)) out.findings.push(`OVERRIDE-NO-REASON ${sc.project}: override of ${id} has no reason (${sc.file})`);
      const rows = pageOf(o?.standard)?.rows ?? [];
      const live = rows.some((r) => r.id === o?.row && r.state !== "retired");
      if (!adopted.has(o?.standard)) out.findings.push(`OVERRIDE-STALE ${sc.project}: override of ${id}, but ${o?.standard ?? "?"} is not adopted (${sc.file})`);
      else if (!live) out.findings.push(`OVERRIDE-STALE ${sc.project}: override of ${id}, but the row is retired or missing (${sc.file})`);
    }
    for (const d of ad.declined) {
      out.declined.push({ workspace: sc.workspace, project: sc.project, standard: d?.standard });
      if (blank(d?.reason)) out.findings.push(`DECLINE-NO-REASON ${sc.project}: decline of ${d?.standard ?? "?"} has no reason (${sc.file})`);
    }
  }
  return out;
}
