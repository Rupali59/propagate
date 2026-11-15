/**
 * `propagate standards [--json] [--std <id>] [--project <p>]` and `standards versions [--refresh] [--json]`
 * (#269). OFFLINE: neither reaches GitHub. The only spawn is the tool-version probe in `versions --refresh`
 * (lib/standards/versions.mjs), behind an injectable `run`.
 *
 * EXIT CODES. 0 report produced and no problems; 1 report produced with problems (a page or sidecar could not
 * be read); 2 could not run (not configured, registry unreadable, blind scan, usage). Every failure is
 * `<CODE>: <what>. Next: <command>` on stderr, or `{ok:false, code, what, next}` with --json.
 * Import prefix is `../lib/…` from here (G60).
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../lib/core/paths.mjs";
import { readSidecar } from "../lib/report/manifest.mjs";
import { collectUnits, loadServices, MIN_UNITS } from "../lib/report/services.mjs";
import { loadStandards } from "../lib/standards/registry.mjs";
import { buildStandardsReport } from "../lib/standards/status.mjs";
import { readVersions, refreshVersions, writeVersions } from "../lib/standards/versions.mjs";

const USAGE = "usage: propagate standards [--json] [--std <id>] [--project <p>] | standards versions [--refresh] [--json]";

const fail = (code, what, next) => ({ ok: false, code, what, next });

function emitFailure(f, asJson, io) {
  if (asJson) io.log(JSON.stringify(f, null, 2));
  else io.error(`${f.code}: ${f.what}. Next: ${f.next}`);
  return 2;
}

function parse(rest, valued, bools) {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (valued.includes(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: fail("STANDARDS_USAGE", `${a} needs a value`, USAGE) };
      flags[a] = v;
      i++;
    } else if (bools.includes(a)) flags[a] = true;
    else return { error: fail("STANDARDS_USAGE", `unknown argument ${a}`, USAGE) };
  }
  return { flags };
}

/** Each workspace's `propagation/state/<project>/.sidecar.yml` `standards:` block, read leniently. */
function readSidecars(workspaces) {
  const out = [];
  for (const ws of workspaces ?? []) {
    const dir = path.join(ws.root, "propagation", "state");
    let names = [];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name, ".sidecar.yml");
      if (!existsSync(file)) continue;
      const { sidecar, error } = readSidecar(file);
      const wsName = ws.name ?? path.basename(ws.root);
      if (error) out.push({ workspace: wsName, project: name, file, standards: "unreadable sidecar: " + error });
      else out.push({ workspace: wsName, project: sidecar?.project ?? name, file, standards: sidecar?.standards });
    }
  }
  return out;
}

async function env(inject) {
  const cfg = inject.integrations && inject.workspaces ? null : await import("../lib/core/config.mjs");
  return {
    integrations: inject.integrations ?? cfg.INTEGRATIONS,
    workspaces: inject.workspaces ?? cfg.WORKSPACES,
  };
}

function loadOrFail(integrations) {
  const l = loadStandards({ standardsFile: integrations.standardsFile, standardsDir: integrations.standardsDir });
  if (l.ok) return l;
  const code = /^standards not configured/.test(l.reason) ? "STANDARDS_NOT_CONFIGURED" : "STANDARDS_UNREADABLE";
  const next = code === "STANDARDS_NOT_CONFIGURED" ? "set PROPAGATE_STANDARDS_FILE and PROPAGATE_STANDARDS_DIR (or standardsFile and standardsDir in config.yml)" : "fix the registry file named above";
  return fail(code, l.reason, next);
}

/**
 * @param {string[]} argv everything after `standards`
 * @param {object} [inject] tests: io, integrations, workspaces, units, sidecars, stateDirPath, now, run, minUnits
 */
export async function standardsCmd(argv = [], inject = {}) {
  const io = inject.io ?? console;
  const asJson = argv.includes("--json");
  if (argv[0] === "versions") return versionsCmd(argv.slice(1), inject, io, asJson);
  const p = parse(argv, ["--std", "--project"], ["--json"]);
  if (p.error) return emitFailure(p.error, asJson, io);
  const { integrations, workspaces } = await env(inject);
  const loaded = loadOrFail(integrations);
  if (!loaded.ok) return emitFailure(loaded, asJson, io);
  if (p.flags["--std"] && !loaded.standards.some((s) => s.id === p.flags["--std"])) {
    return emitFailure(fail("STANDARDS_UNKNOWN", `no standard named ${JSON.stringify(p.flags["--std"])} (known: ${loaded.standards.map((s) => s.id).join(", ")})`, "propagate standards"), asJson, io);
  }
  const units = inject.units ?? collectUnits(workspaces, { integrations });
  const sidecars = inject.sidecars ?? readSidecars(workspaces);
  let serviceDetects = null;
  if (loaded.standards.some((s) => s.service && !s.detect) && integrations.servicesFile) {
    const sv = loadServices(integrations.servicesFile);
    if (sv.ok) serviceDetects = Object.fromEntries(sv.services.map((s) => [s.id, s.detect]));
  }
  const report = buildStandardsReport({
    standards: loaded.standards,
    units,
    sidecars,
    versions: readVersions(inject.stateDirPath ?? stateDir()),
    now: (inject.now ?? Date.now)(),
    minUnits: inject.minUnits ?? MIN_UNITS,
    std: p.flags["--std"] ?? null,
    project: p.flags["--project"] ?? null,
    serviceDetects,
    problems: loaded.problems,
  });
  if (!report.ok) return emitFailure(fail("STANDARDS_BLIND", report.blind, "check PROPAGATE_WORKSPACES and the workspace roots, then re-run"), asJson, io);
  const code = report.problems.length ? 1 : 0;
  if (asJson) {
    io.log(JSON.stringify(report, null, 2));
    return code;
  }
  io.log(`# standards  (offline; ${report.units_scanned} unit(s) scanned, floor ${report.floor})`);
  for (const s of report.standards) {
    const c = s.counts;
    io.log(`\n${s.id}  ${s.kind}  ${s.detected.length} detected, ${s.adopted.length} adopted  version in use: ${s.versionInUse ?? "unknown"}${s.versionSource ? ` (${s.versionSource})` : ""}`);
    io.log(`  rows: ${c.verified} verified, ${c["re-verify"]} re-verify, ${c.unverifiable} unverifiable, ${c.unchecked} unchecked`);
    for (const r of s.rows) io.log(`  ${r.id}  ${r.status}${r.reason ? `  (${r.reason})` : ""}`);
  }
  if (report.problems.length) {
    io.log("\n# problems");
    for (const x of report.problems) io.log(`  ${x}`);
  }
  return code;
}

async function versionsCmd(rest, inject, io, asJson) {
  const p = parse(rest, [], ["--json", "--refresh"]);
  if (p.error) return emitFailure(p.error, asJson, io);
  const dir = inject.stateDirPath ?? stateDir();
  let versions = readVersions(dir);
  if (p.flags["--refresh"]) {
    const { integrations } = await env(inject);
    const loaded = loadOrFail(integrations);
    if (!loaded.ok) return emitFailure(loaded, asJson, io);
    const probes = {};
    for (const s of loaded.standards) if (s.probe && typeof s.probe === "object") probes[s.page?.versionProbe ?? s.id] = s.probe;
    versions = refreshVersions({ probes, run: inject.run });
    writeVersions(dir, versions);
  }
  if (asJson) {
    io.log(JSON.stringify({ ok: true, versions }, null, 2));
    return 0;
  }
  if (!versions) {
    io.log("no tool versions cached. Run: propagate standards versions --refresh");
    return 0;
  }
  io.log(`tool versions (read ${versions.at}):`);
  for (const [k, v] of Object.entries(versions.tools)) io.log(`  ${k}  ${v.version ?? `unknown (${v.error})`}`);
  return 0;
}
