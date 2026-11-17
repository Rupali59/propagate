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
import { execFileSync } from "node:child_process";
import path from "node:path";
import { stateDir } from "../lib/core/paths.mjs";
import { collectUnits, MIN_UNITS } from "../lib/report/services.mjs";
import { APPROVAL_UNAVAILABLE, applyPlan, planAdopt, readAdoptions } from "../lib/standards/adopt.mjs";
import { loadStandards } from "../lib/standards/registry.mjs";
import { readSidecars, serviceDetectsFor } from "../lib/standards/sidecars.mjs";
import { buildStandardsReport } from "../lib/standards/status.mjs";
import { cacheAge, readVersions, refreshVersions, writeVersions } from "../lib/standards/versions.mjs";

const USAGE = "usage: propagate standards [--json] [--std <id>] [--project <p>] | standards versions [--refresh] [--json] | standards adopt <std> <project|workspace/project> [--units a,b] [--evidence <text>] [--apply] | standards decline|remove <std> <project|workspace/project> --reason <r> [--apply]";

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
  if (["adopt", "decline", "remove"].includes(argv[0])) return adoptionCmd(argv, inject, io, asJson);
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
  const cachedVersions = readVersions(inject.stateDirPath ?? stateDir());
  const serviceDetects = serviceDetectsFor(loaded, integrations);
  const report = buildStandardsReport({
    standards: loaded.standards,
    units,
    sidecars,
    versions: cachedVersions,
    now: (inject.now ?? Date.now)(),
    minUnits: inject.minUnits ?? MIN_UNITS,
    std: p.flags["--std"] ?? null,
    project: p.flags["--project"] ?? null,
    serviceDetects,
    problems: loaded.problems,
  });
  if (report.unknownProject) return emitFailure(fail("STANDARDS_UNKNOWN_PROJECT", `no project named ${JSON.stringify(report.unknownProject)} among the scanned units or sidecars (known: ${report.known.join(", ")})`, "propagate standards"), asJson, io);
  if (!report.ok) return emitFailure(fail("STANDARDS_BLIND", report.blind, "check PROPAGATE_WORKSPACES and the workspace roots, then re-run"), asJson, io);
  const code = report.problems.length ? 1 : 0;
  if (asJson) {
    io.log(JSON.stringify(report, null, 2));
    return code;
  }
  io.log(`# standards  (offline; ${report.units_scanned} unit(s) scanned, floor ${report.floor}; ${report.sidecars_scanned} sidecar(s) read, ${report.sidecars_unreadable.length} unreadable)`);
  io.log(cachedVersions ? `  tool versions read ${cacheAge(cachedVersions, (inject.now ?? Date.now)()) ?? "at an unreadable time"} (standards versions --refresh)` : "  tool versions: never read (standards versions --refresh)");
  for (const u of report.sidecars_unreadable) io.log(`  unreadable sidecar ${u.file}: ${u.reason}`);
  for (const s of report.standards) {
    const c = s.counts;
    io.log(`\n${s.id}  ${s.kind}  ${s.detected.length} detected, ${s.adopted.length} adopted  version source: ${s.versionSource ?? "none"}`);
    const pc = s.projectCounts;
    io.log(`  projects: ${pc.verified} verified, ${pc["re-verify"]} re-verify, ${pc.unverifiable} unverifiable, ${pc.unchecked} unchecked`);
    for (const pr of s.projects) for (const x of pr.units) io.log(`    ${pr.workspace}/${x.unit}  ${x.version ?? "unknown"}  (${x.source ?? "no version source"})`);
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
    if (Object.keys(probes).length === 0) return emitFailure(fail("STANDARDS_NO_PROBES", "no registry entry declares a probe, so there is nothing to refresh and the cache is left as it was", "add `probe: {cmd, args, parse}` to a standard in standards.yml"), asJson, io);
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

/** The GitHub login that did it, from `gh api user`. null when it cannot be read: never a blank `by`. */
function ghLogin() {
  try {
    return execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The sidecar of `<project>` or `<workspace>/<project>`, resolved the way `readSidecars` keys a project: by the
 * sidecar's `project:` field, inside one workspace. A bare name several workspaces share is ambiguous, never
 * first-match-wins (a write to the wrong repo).
 * @returns {{file:string, workspace:string, project:string}|{ambiguous:string[]}|{expected:string[]}}
 */
function findSidecar(workspaces, arg, sidecars) {
  const cut = arg.lastIndexOf("/");
  const wsName = cut > 0 ? arg.slice(0, cut) : null;
  const project = cut > 0 ? arg.slice(cut + 1) : arg;
  const hits = sidecars.filter((s) => s.project === project && (wsName === null || s.workspace === wsName));
  if (hits.length === 1) return { file: hits[0].file, workspace: hits[0].workspace, project };
  if (hits.length > 1) return { ambiguous: hits.map((h) => `${h.workspace}/${h.project}`).sort() };
  const expected = (workspaces ?? []).map((w) => path.join(w.root, "propagation", "state", project, ".sidecar.yml"));
  return { expected: expected.length ? expected : [`<workspace root>/propagation/state/<dir>/.sidecar.yml naming project: ${project}`] };
}

/** `standards adopt|decline|remove <std> <project>`. Dry run unless --apply. */
async function adoptionCmd(argv, inject, io, asJson) {
  const verb = argv[0];
  const rest = argv.slice(1);
  const pos = [];
  const flagArgs = [];
  const valued = ["--units", "--evidence", "--reason"];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      flagArgs.push(rest[i]);
      if (valued.includes(rest[i]) && rest[i + 1] !== undefined) flagArgs.push(rest[++i]);
    } else pos.push(rest[i]);
  }
  const p = parse(flagArgs, valued, ["--json", "--apply"]);
  if (p.error) return emitFailure(p.error, asJson, io);
  const f = p.flags;
  if (pos.length !== 2) return emitFailure(fail("STANDARDS_USAGE", `${verb} needs <std> <project>`, USAGE), asJson, io);
  const [stdId, projectArg] = pos;
  if (verb !== "adopt" && !(f["--reason"] ?? "").trim()) return emitFailure(fail("STANDARDS_USAGE", `${verb} needs --reason`, `propagate standards ${verb} ${stdId} ${projectArg} --reason "<why>"`), asJson, io);
  const { integrations, workspaces } = await env(inject);
  const loaded = loadOrFail(integrations);
  if (!loaded.ok) return emitFailure(loaded, asJson, io);
  const std = loaded.standards.find((s) => s.id === stdId);
  if (!std) return emitFailure(fail("STANDARDS_UNKNOWN", `no standard named ${JSON.stringify(stdId)} (known: ${loaded.standards.map((s) => s.id).join(", ")})`, "propagate standards"), asJson, io);
  const allSidecars = readSidecars(workspaces);
  const sc = findSidecar(workspaces, projectArg, allSidecars);
  if (sc.ambiguous) return emitFailure(fail("STANDARDS_PROJECT_AMBIGUOUS", `${JSON.stringify(projectArg)} names a project in ${sc.ambiguous.length} workspaces: ${sc.ambiguous.join(", ")}`, `propagate standards ${verb} ${stdId} <workspace>/<project>  (one of the above)`), asJson, io);
  const project = sc.project ?? projectArg;
  if (!sc.file) return emitFailure(fail("STANDARDS_PROJECT_UNKNOWN", `no sidecar for project ${JSON.stringify(projectArg)}; looked for ${sc.expected.join(" or ")}`, "create the project's state folder (see rule:state-and-decisions) or check the project name"), asJson, io);
  const cur = readAdoptions(sc.file);
  if (cur.error) return emitFailure(fail("STANDARDS_UNREADABLE", cur.error, "fix the `standards:` block named above"), asJson, io);
  const isAdopted = cur.adopted.some((a) => a?.standard === stdId);
  if (verb === "remove" && !isAdopted) return emitFailure(fail("STANDARDS_NOT_ADOPTED", `${project} has not adopted ${stdId}, so there is nothing to remove`, `propagate standards decline ${stdId} ${project} --reason "<why>"`), asJson, io);
  if (verb === "decline" && isAdopted) return emitFailure(fail("STANDARDS_ALREADY_ADOPTED", `${project} has adopted ${stdId}; declining it would contradict the adoption`, `propagate standards remove ${stdId} ${project} --reason "<why>"`), asJson, io);

  // Rows, the version in use and the detected units, from the same report `standards` prints.
  const units = inject.units ?? collectUnits(workspaces, { integrations });
  const report = buildStandardsReport({
    standards: loaded.standards, units, sidecars: inject.sidecars ?? readSidecars(workspaces),
    versions: readVersions(inject.stateDirPath ?? stateDir()), minUnits: inject.minUnits ?? MIN_UNITS, std: stdId, problems: [],
  });
  if (!report.ok) return emitFailure(fail("STANDARDS_BLIND", report.blind ?? "scan failed", "check PROPAGATE_WORKSPACES and the workspace roots, then re-run"), asJson, io);
  const rep = report.standards[0];
  const mine = rep.projects.find((pr) => pr.project === project && pr.workspace === sc.workspace);
  const detectedUnits = (mine?.units ?? []).map((u) => u.unit);
  const vers = [...new Set((mine?.units ?? []).map((u) => u.version).filter(Boolean))];
  const key = std.page?.versionProbe ?? std.id;
  const verifiedOn = vers.length ? `${key} ${vers.join(", ")}` : `${key}: version not read`;
  const chosenUnits = f["--units"] ? f["--units"].split(",").map((x) => x.trim()).filter(Boolean) : detectedUnits;
  if (verb === "adopt" && chosenUnits.length === 0 && !cur.adopted.some((a) => a?.standard === stdId)) {
    return emitFailure(fail("STANDARDS_USAGE", `${stdId} is detected on no unit of ${project}`, `propagate standards adopt ${stdId} ${project} --units <unit,unit>`), asJson, io);
  }
  const live = (std.page?.rows ?? []).filter((r) => r.state !== "retired");
  const rows = rep.rows.map((r) => ({ id: r.id, status: mine?.rows.find((x) => x.id === r.id)?.status ?? r.status }));
  const checksToRun = live.filter((r) => r.check.kind === "command" || r.check.kind === "test").map((r) => ({ row: r.id, kind: r.check.kind, target: r.check.target }));

  const apply = Boolean(f["--apply"]);
  if (apply && verb !== "adopt") return emitFailure(fail("STANDARDS_APPROVAL_UNAVAILABLE", APPROVAL_UNAVAILABLE, `propagate standards ${verb} ${stdId} ${project} --reason "<why>"  (a dry run)`), asJson, io);
  let by = null;
  if (apply) {
    by = typeof inject.by === "function" ? inject.by() : inject.by !== undefined ? inject.by : ghLogin();
    if (!by) return emitFailure(fail("STANDARDS_IDENTITY_UNKNOWN", "could not read the GitHub login (gh api user --jq .login), so `by` would be blank", "run `gh auth status`, then retry"), asJson, io);
  }
  const plan = planAdopt({ kind: verb, std: stdId, project, sidecarFile: sc.file, units: chosenUnits, evidence: f["--evidence"] ?? null, by, now: (inject.now ?? Date.now)(), verifiedOn, reason: f["--reason"] ?? null, rows, checksToRun });
  if (plan.error) return emitFailure(fail("STANDARDS_UNREADABLE", plan.error, "fix the sidecar named above"), asJson, io);
  let written = false;
  if (apply) {
    const r = applyPlan(plan);
    if (!r.written) return emitFailure(fail("STANDARDS_WRITE_REFUSED", r.error, "re-run"), asJson, io);
    written = true;
  }
  const shown = { ...plan.entry, ...(by === null && "by" in plan.entry ? { by: "(the gh login, read at --apply)" } : {}) };
  if (asJson) {
    io.log(JSON.stringify({ ok: true, verb, dry_run: !apply, written, sidecar: plan.sidecarFile, entry: shown, refresh: plan.refresh, rows: plan.rows, checks_to_run: plan.checksToRun }, null, 2));
    return 0;
  }
  const past = { adopt: "adopted", decline: "declined", remove: "removed" }[verb];
  io.log(`${apply ? "applied" : "dry run (nothing written; add --apply)"}: ${verb} ${stdId} for ${project}${plan.refresh ? " (already adopted: refreshing verified_on)" : ""}`);
  io.log(`  sidecar: ${plan.sidecarFile}`);
  io.log(`  would be recorded as ${past}: ${JSON.stringify(shown)}`);
  if (verb === "adopt") {
    io.log(`  version in use: ${verifiedOn}`);
    io.log(`  rows (${plan.rows.length}):`);
    for (const r of plan.rows) io.log(`    ${r.id}  ${r.status}`);
    io.log(`  checks it would run (${plan.checksToRun.length}; adopt does not run them, record their output with --evidence):`);
    for (const c of plan.checksToRun) io.log(`    ${c.row}  ${c.kind}: ${c.target}`);
  } else io.log(`  approval: ${APPROVAL_UNAVAILABLE}`);
  return 0;
}
