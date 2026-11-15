/**
 * lib/standards/status.mjs — derived row status and the standards report.
 *
 * Status is always derived, never written onto a row (design §2.1):
 *   verified      the version in use is the same or an older major.minor than the row's Version
 *   re-verify     the version in use is newer
 *   unverifiable  no version in use, or either side has no comparable number (`GA4`, `2026-11`)
 *   unchecked     the row's check kind is review or none
 *
 * Detection reuses services.mjs `derive`, so the evidence kinds and the floor are the services ones. An empty scan
 * is `blind`, never "0 detected" (rule:discernment-checks §6).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { derive, MIN_UNITS } from "../report/services.mjs";

export const NO_VERSION_REASON = "version not read (standards versions --refresh)";
const NUM = /(\d+)\.(\d+)(?:\.(\d+))?/;
const STATUSES = ["verified", "re-verify", "unverifiable", "unchecked"];
const strList = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

/** Raw version text vs the version in use: compares major.minor of the FIRST number found in each (ruling P4). */
export function compareVersions(rowVersion, inUse) {
  const a = NUM.exec(String(rowVersion ?? ""));
  const b = NUM.exec(String(inUse ?? ""));
  if (!a || !b) return "unverifiable";
  const [am, an, bm, bn] = [Number(a[1]), Number(a[2]), Number(b[1]), Number(b[2])];
  return bm > am || (bm === am && bn > an) ? "re-verify" : "verified";
}

export function rowStatus(row, versionInUse) {
  const kind = row.check?.kind ?? "none";
  if (kind === "review" || kind === "none") return "unchecked";
  if (versionInUse === null || versionInUse === undefined || versionInUse === "") return "unverifiable";
  return compareVersions(row.version, versionInUse);
}

/** `sdks.<key>` of a unit's pubspec.lock, or null. The lock holds a constraint (">=3.38.4"); the first number is what compares. */
function lockfileVersion(unitAbs, key) {
  try {
    const doc = yaml.parse(readFileSync(path.join(unitAbs, "pubspec.lock"), "utf8"));
    const v = doc?.sdks?.[key];
    return v && NUM.test(String(v)) ? String(v) : null;
  } catch {
    return null;
  }
}

const probeKey = (std) => std.page?.versionProbe ?? std.id;

function detectOf(std, serviceDetects) {
  const d = std.detect ?? serviceDetects?.[std.service] ?? null;
  if (d) return { deps: strList(d.deps), files: strList(d.files), env: strList(d.env), registries: [] };
  return null;
}

/**
 * Adopted (project, standard) pairs from sidecar `standards:` blocks. A malformed block is a problem naming the
 * file, and the other projects still report (Review Focus 3).
 * @param {{workspace:string, project:string, file:string, standards?:any}[]} sidecars
 */
function adoptedFrom(sidecars, problems) {
  const out = [];
  for (const sc of sidecars ?? []) {
    if (sc.error) {
      problems.push(`STANDARDS-UNREADABLE: ${sc.file}: ${sc.error}`);
      continue;
    }
    if (sc.standards === undefined || sc.standards === null) continue;
    const block = sc.standards;
    if (typeof block !== "object" || Array.isArray(block) || (block.adopted !== undefined && !Array.isArray(block.adopted))) {
      problems.push(`STANDARDS-UNREADABLE: ${sc.file}: \`standards:\` must be a mapping whose \`adopted:\` is a list`);
      continue;
    }
    for (const a of block.adopted ?? []) {
      if (!a || typeof a !== "object" || typeof a.standard !== "string") {
        problems.push(`STANDARDS-UNREADABLE: ${sc.file}: an adopted entry has no \`standard:\``);
        continue;
      }
      out.push({ workspace: sc.workspace, project: sc.project, standard: a.standard, units: strList(a.units), verified_on: a.verified_on ?? null, since: a.since ?? null });
    }
  }
  return out;
}

const RANK = { verified: 1, unverifiable: 2, "re-verify": 3 };
const worst = (a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);
const hasCode = (u) => Boolean(u.toolchain) && u.toolchain !== "none" && u.toolchain !== "unknown";

/** One unit's version in use: its own pubspec.lock, else the machine probe, else none. Each names its source. */
function versionFor(u, key, versions) {
  const lock = lockfileVersion(u.abs, key);
  if (lock) return { version: lock, source: `lockfile: ${path.join(u.abs, "pubspec.lock")}` };
  const v = versions?.tools?.[key]?.version;
  if (v) return { version: v, source: `probe: ${key}` };
  return { version: null, source: null };
}

/**
 * @returns {{ok:true, standards:object[], problems:string[], units_scanned:number, floor:number}|{ok:false, blind:string, units_scanned:number, floor:number}|{ok:false, unknownProject:string, known:string[]}}
 */
export function buildStandardsReport({ standards, units, sidecars = [], versions = null, now = Date.now(), minUnits = MIN_UNITS, std = null, project = null, serviceDetects = null, problems: carried = [] } = {}) {
  void now;
  if (units.length < minUnits) {
    return { ok: false, blind: `only ${units.length} units scanned (floor ${minUnits}) — the scan has gone blind, this is no result, not a clean one`, units_scanned: units.length, floor: minUnits };
  }
  if (project) {
    const known = [...new Set([...units.map((u) => u.project), ...sidecars.map((x) => x.project)])].sort();
    if (!known.includes(project)) return { ok: false, unknownProject: project, known };
  }
  const problems = [...carried];
  const adopted = adoptedFrom(sidecars, problems);
  const sidecarsUnreadable = sidecars.filter((x) => x.error).map((x) => ({ file: x.file, reason: x.error }));
  const out = [];
  for (const s of standards) {
    if (std && s.id !== std) continue;
    const det = detectOf(s, serviceDetects);
    let hits = [];
    if (det) hits = derive(units, [{ id: s.id, detect: det }], {});
    else if (s.service && !serviceDetects?.[s.service]) problems.push(`standard ${s.id}: service ${JSON.stringify(s.service)} has no usable detect (services.yml unreadable or the service is not in it) — detection reads nothing for it`);
    else if (s.kind === "global" || s.kind === "production") hits = units.filter(hasCode).map((u) => ({ workspace: u.workspace, project: u.project, unit: u.rel }));
    else problems.push(`standard ${s.id}: no detect and no usable service reference — detection reads nothing for it`);
    if (project) hits = hits.filter((h) => h.project === project);
    hits = [...hits].sort((a, b) => `${a.workspace}/${a.unit}`.localeCompare(`${b.workspace}/${b.unit}`));
    const detected = hits.map((h) => `${h.workspace}/${h.unit}`);
    const mine = adopted.filter((a) => a.standard === s.id && (!project || a.project === project));

    const key = probeKey(s);
    const live = (s.page?.rows ?? []).filter((r) => r.state !== "retired");
    const rowsFor = (version) => live.map((r) => {
      const status = rowStatus(r, version);
      return { id: r.id, title: r.title, status, ...(status === "unverifiable" ? { reason: version ? "row version not comparable" : NO_VERSION_REASON } : {}) };
    });

    // Per project: each detected unit uses its OWN lockfile, falling back to the machine probe only for a unit with none.
    const byProject = new Map();
    for (const h of hits) {
      const u = units.find((x) => x.workspace === h.workspace && x.rel === h.unit);
      const k = `${h.workspace}/${h.project}`;
      if (!byProject.has(k)) byProject.set(k, { workspace: h.workspace, project: h.project, units: [] });
      byProject.get(k).units.push({ unit: h.unit, ...versionFor(u, key, versions) });
    }
    const projects = [...byProject.values()].map((pr) => {
      const perUnit = pr.units.map((x) => rowsFor(x.version));
      const rows = live.map((r, i) => {
        const cells = perUnit.map((rs) => rs[i]);
        const status = cells.reduce((acc, c) => worst(acc, c.status), cells[0].status === "unchecked" ? "unchecked" : "verified");
        const reason = cells.find((c) => c.status === status)?.reason;
        return { id: r.id, title: r.title, status, ...(reason ? { reason } : {}) };
      });
      return { ...pr, rows };
    });

    // Standard level: the worst status per row across projects (or the machine probe alone when nothing is detected).
    let rows;
    const sources = new Set(projects.flatMap((pr) => pr.units.map((x) => (x.source ? x.source.split(":")[0] : "none"))));
    if (projects.length === 0) {
      const v = versions?.tools?.[key]?.version ?? null;
      rows = rowsFor(v);
    } else {
      rows = live.map((r, i) => {
        const cells = projects.map((pr) => pr.rows[i]);
        const status = cells.reduce((acc, c) => worst(acc, c.status), cells[0].status === "unchecked" ? "unchecked" : "verified");
        const reason = cells.find((c) => c.status === status)?.reason;
        return { id: r.id, title: r.title, status, ...(reason ? { reason } : {}) };
      });
    }
    const counts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
    for (const r of rows) counts[r.status]++;
    const projectCounts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
    for (const pr of projects) {
      const w = pr.rows.reduce((acc, r) => (r.status === "unchecked" ? acc : worst(acc, r.status)), "verified");
      projectCounts[pr.rows.length && pr.rows.every((r) => r.status === "unchecked") ? "unchecked" : w]++;
    }
    const versionSource = sources.size === 0 ? (versions?.tools?.[key]?.version ? "probe" : null) : sources.size === 1 ? [...sources][0] : "mixed";
    out.push({ id: s.id, kind: s.kind, versionSource, rows, projects, projectCounts, detected, adopted: mine, counts });
  }
  return { ok: true, standards: out, problems, units_scanned: units.length, floor: minUnits, sidecars_scanned: sidecars.length, sidecars_unreadable: sidecarsUnreadable };
}
