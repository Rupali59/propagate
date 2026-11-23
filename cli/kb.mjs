/**
 * `propagate kb standards [--json] [--std <id>] [--project <p>]`, `kb standards versions|adopt|decline|remove` and
 * `kb references [--json]` and `kb migrate [--apply] [--json]` (#269, #322). `propagate standards …` is a deprecated alias that says so on stderr and
 * calls the same code. OFFLINE: none reaches GitHub. The only spawn is the tool-version probe in `versions --refresh`
 * (lib/kb/standards/versions.mjs), behind an injectable `run`.
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
import { APPROVAL_UNAVAILABLE, applyPlan, planAdopt, readAdoptions } from "../lib/kb/standards/adopt.mjs";
import { applyMigrate, planMigrate } from "../lib/kb/migrate.mjs";
import { loadReferences } from "../lib/kb/references.mjs";
import { reviewCmd } from "../lib/kb/review/cmd.mjs";
import { discoverCmd } from "../lib/research/discover.mjs";
import { FetchFatal, fetchAll } from "../lib/research/fetch.mjs";
import { collectEntries, rankEntries } from "../lib/kb/search.mjs";
import { loadStandards } from "../lib/kb/standards/registry.mjs";
import { readSidecars, serviceDetectsFor } from "../lib/kb/standards/sidecars.mjs";
import { buildStandardsReport } from "../lib/kb/standards/status.mjs";
import { cacheAge, readVersions, refreshVersions, writeVersions } from "../lib/kb/standards/versions.mjs";

const USAGE = "usage: propagate kb standards [--json] [--std <id>] [--project <p>] | kb standards versions [--refresh] [--json] | kb standards adopt <std> <project|workspace/project> [--units a,b] [--evidence <text>] [--apply] | kb standards decline|remove <std> <project|workspace/project> --reason <r> [--apply] | kb references [--json] | kb search <terms> [--kind standard|reference] [--json] | kb migrate [--apply] [--json] | kb discover <dir> \"<query>\" [--engine openalex|s2|arxiv|crossref] [--limit n] [--lane <name>] [--json] | kb fetch <dir> <url...> [--json] | kb review new <slug> --decision <text> --decider <name> | kb review assemble <dir> [--json] | kb review check <dir> [--refetch] [--json] | kb review agree <dir> [--record <file>] [--apply] [--json] | kb review apply <dir> [--json]";

/** The exact line `propagate standards …` writes to stderr, once per run. */
export const STANDARDS_DEPRECATION = "propagate standards is now propagate kb standards; the old name is removed in the release after 0.21.0";

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
  const l = loadStandards({ standardsFile: integrations.kbStandardsFile, standardsDir: integrations.kbStandardsDir });
  if (l.ok) return l;
  const code = /^standards not configured/.test(l.reason) ? "STANDARDS_NOT_CONFIGURED" : "STANDARDS_UNREADABLE";
  const next = code === "STANDARDS_NOT_CONFIGURED" ? "set PROPAGATE_KB_STANDARDS_FILE and PROPAGATE_KB_STANDARDS_DIR (or kbStandardsFile and kbStandardsDir under integrations: in config.yml)" : "fix the registry file named above";
  return fail(code, l.reason, next);
}

/** The polite-pool contact: `kbContact` under integrations (env PROPAGATE_KB_CONTACT wins inside discoverCmd). */
async function kbContact(inject) {
  const { integrations } = await env(inject);
  return integrations.kbContact ?? null;
}

/**
 * @param {string[]} argv everything after `kb`: `standards …` or `references …`
 * @param {object} [inject] tests: io, integrations, workspaces, units, sidecars, stateDirPath, now, run, minUnits
 */
export async function kbCmd(argv = [], inject = {}) {
  const io = inject.io ?? console;
  const asJson = argv.includes("--json");
  if (argv[0] === "standards") return standardsBody(argv.slice(1), inject);
  if (argv[0] === "references") return referencesCmd(argv.slice(1), inject, io, asJson);
  if (argv[0] === "search") return searchCmd(argv.slice(1), inject, io, asJson);
  if (argv[0] === "discover") return discoverCmd(argv.slice(1), { ...inject, io, contact: inject.contact ?? (await kbContact(inject)) });
  if (argv[0] === "fetch") return fetchCmd(argv.slice(1), inject, io, asJson);
  if (argv[0] === "review") return reviewCmd(argv.slice(1), { io, integrations: (await env(inject)).integrations, inject });
  if (argv[0] === "migrate") return migrateCmd(argv.slice(1), inject, io, asJson);
  return emitFailure(fail("KB_USAGE", argv[0] === undefined ? "kb needs a subcommand" : `unknown kb subcommand ${JSON.stringify(argv[0])}`, USAGE), asJson, io);
}

/** `propagate standards …`: the deprecated name. One stderr line, then exactly what `kb standards …` does. */
export async function standardsCmd(argv = [], inject = {}) {
  (inject.io ?? console).error(STANDARDS_DEPRECATION);
  return kbCmd(["standards", ...argv], inject);
}

/**
 * `kb fetch <dir> <url...> [--json]` (#324): read each URL's raw source into `<dir>/fetched.json`, bodies under
 * `$STATE/kb/fetched/<sha256>`. EXIT CODES. 0 every URL ok; 1 at least one was not_retrieved, stale or hallucinated
 * (the records say which); 2 could not run: usage, pdftotext missing when a PDF turned up, gh missing or logged out
 * when a GitHub URL turned up, a body store that would land inside the repo or `<dir>`. Nothing is written on a 2.
 * The contact address Unpaywall asks for is PROPAGATE_KB_CONTACT, or `kbContact` under `integrations:`; never guessed.
 */
async function fetchCmd(rest, inject, io, asJson) {
  const pos = rest.filter((a) => a !== "--json");
  const bad = pos.find((a) => a.startsWith("--"));
  if (bad) return emitFailure(fail("KB_USAGE", `unknown argument ${bad}`, USAGE), asJson, io);
  if (pos.length < 2) return emitFailure(fail("KB_USAGE", "kb fetch needs <dir> and at least one <url>", USAGE), asJson, io);
  const [dir, ...urls] = pos;
  const bareHost = urls.find((u) => !/^https?:\/\//i.test(u) && !/^10\.\d{4,9}\//.test(u));
  if (bareHost) return emitFailure(fail("KB_USAGE", `${JSON.stringify(bareHost)} is not an http(s) URL or a DOI`, USAGE), asJson, io);
  const norm = urls.map((u) => (/^10\./.test(u) ? `https://doi.org/${u}` : u));
  let email = inject.contact;
  if (email === undefined) {
    email = process.env.PROPAGATE_KB_CONTACT;
    if (!email) email = (await env(inject)).integrations?.kbContact;
  }
  let out;
  try {
    out = await fetchAll({
      dir, urls: norm, stateDirPath: inject.stateDirPath ?? stateDir(), now: inject.now, fetchImpl: inject.fetchImpl, run: inject.run,
      pdftotextBin: inject.pdftotextBin, ghBin: inject.ghBin, contact: typeof email === "string" && email.trim() ? email.trim() : null,
      endpoints: inject.endpoints, timeoutMs: inject.timeoutMs,
    });
  } catch (e) {
    if (e instanceof FetchFatal) return emitFailure(fail(e.code, e.what, e.next), asJson, io);
    throw e;
  }
  const bad1 = out.records.filter((r) => r.classification !== "ok");
  if (asJson) {
    io.log(JSON.stringify({ ok: bad1.length === 0, file: out.file, records: out.records, duplicates: out.duplicates }, null, 2));
    return bad1.length ? 1 : 0;
  }
  io.log(`# kb fetch  (${out.records.length} fetched, ${out.records.length - bad1.length} ok; records in ${out.file})`);
  for (const r of out.records) io.log(`  ${r.classification.padEnd(13)} ${r.status ?? "-"}  ${r.url}${r.final_url && r.final_url !== r.url ? `  -> ${r.final_url}` : ""}${r.note ? `\n    ${r.note}` : ""}`);
  for (const d of out.duplicates) io.log(`  duplicate (same source as an earlier URL, fetched once): ${d}`);
  return bad1.length ? 1 : 0;
}

/**
 * `kb migrate [--apply] [--json]`: rename each sidecar's `standards:` key to `kb:`. Dry run unless --apply, and a dry
 * run writes nothing. EXIT CODES. 0 nothing to migrate, or the migration was applied; 1 a conflict (a sidecar with both
 * keys, or one that cannot be read), or a refused write; 2 the workspaces could not be read. A dry run with changes
 * pending is 0, as `kb standards adopt` is: nothing is wrong, the next step is printed.
 */
async function migrateCmd(rest, inject, io, asJson) {
  const p = parse(rest, [], ["--json", "--apply"]);
  if (p.error) return emitFailure({ ...p.error, code: "KB_USAGE" }, asJson, io);
  const { workspaces } = await env(inject);
  if (!workspaces || workspaces.length === 0) return emitFailure(fail("KB_BLIND", "no workspaces were found, so no sidecar could be read", "check PROPAGATE_WORKSPACES and the workspace roots, then re-run"), asJson, io);
  const files = readSidecars(workspaces).map((s) => s.file);
  const plan = planMigrate(files);
  const apply = Boolean(p.flags["--apply"]);
  const { written, skipped } = apply ? applyMigrate(plan) : { written: [], skipped: [] };
  const conflicts = [...plan.conflicts, ...skipped];
  const code = conflicts.length ? 1 : 0;
  if (asJson) {
    io.log(JSON.stringify({ ok: code === 0, dry_run: !apply, scanned: files.length, changes: plan.changes, written, conflicts }, null, 2));
    return code;
  }
  io.log(`${apply ? "applied" : "dry run (nothing written; add --apply)"}: ${files.length} sidecar(s) scanned, ${plan.changes.length} carry \`standards:\``);
  for (const c of plan.changes) io.log(`  ${apply && written.includes(c.file) ? "renamed" : "would rename"} ${c.from}: -> ${c.to}:  ${c.file}`);
  if (conflicts.length) {
    io.log("\n# conflicts (not rewritten)");
    for (const x of conflicts) io.log(`  ${x}`);
  }
  return code;
}

/**
 * `kb search <terms> [--kind standard|reference] [--json]`: one derived search over standards rows, references and
 * evaluator's registers (registersDir). EXIT CODES. 0 searched (no hits is 0); 2 usage, or KB_BLIND when no entry
 * at all parsed ("the scan has gone blind"), which is never reported as an empty result.
 */
async function searchCmd(rest, inject, io, asJson) {
  const terms = [];
  let kind = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") continue;
    if (a === "--kind") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return emitFailure(fail("KB_USAGE", "--kind needs a value", USAGE), asJson, io);
      if (v !== "standard" && v !== "reference") return emitFailure(fail("KB_USAGE", `--kind must be standard or reference, got ${JSON.stringify(v)}`, USAGE), asJson, io);
      kind = v;
      i++;
    } else if (a.startsWith("--")) return emitFailure(fail("KB_USAGE", `unknown argument ${a}`, USAGE), asJson, io);
    else terms.push(a);
  }
  if (terms.length === 0) return emitFailure(fail("KB_USAGE", "kb search needs at least one term", USAGE), asJson, io);
  const { integrations } = await env(inject);
  const found = collectEntries({
    standardsFile: integrations.kbStandardsFile,
    standardsDir: integrations.kbStandardsDir,
    referencesFile: integrations.kbReferencesFile,
    registersDir: integrations.registersDir,
  });
  if (found.blind) {
    return emitFailure(fail("KB_BLIND", `0 entries parsed from the standards, references and registers, so the scan has gone blind, it has not found nothing${found.problems.length ? ` (${found.problems.join("; ")})` : ""}`, "check kbStandardsFile, kbStandardsDir, kbReferencesFile and registersDir (PROPAGATE_KB_*, PROPAGATE_REGISTERS_DIR)"), asJson, io);
  }
  const hits = rankEntries(found.entries, terms, { kind });
  if (asJson) {
    io.log(JSON.stringify({ ok: true, terms, kind, scanned: found.entries.length, hits, problems: found.problems }, null, 2));
    return 0;
  }
  io.log(`# kb search ${terms.join(" ")}  (${hits.length} hit(s) of ${found.entries.length} entries; derived, no index)`);
  for (const h of hits) io.log(`  ${h.id}  ${h.title}\n    ${h.path}${h.line ? `:${h.line}` : ""}  ${h.checked ? `checked ${h.checked}` : "checked: never"}`);
  for (const x of found.problems) io.log(`  problem: ${x}`);
  return 0;
}

/** `kb references [--json]`: the registry's entries, ids shown as `ref:<key>` (the file keeps the bare key). */
async function referencesCmd(rest, inject, io, asJson) {
  const p = parse(rest, [], ["--json"]);
  if (p.error) return emitFailure({ ...p.error, code: "KB_USAGE" }, asJson, io);
  const { integrations } = await env(inject);
  const file = integrations.kbReferencesFile ?? null;
  const { references, problems } = loadReferences(file);
  if (references.length === 0) {
    const code = file ? "KB_REFERENCES_UNREADABLE" : "KB_REFERENCES_NOT_CONFIGURED";
    const next = file ? "fix the registry file named above" : "set PROPAGATE_KB_REFERENCES_FILE (or kbReferencesFile under integrations: in config.yml)";
    return emitFailure(fail(code, problems.join("; "), next), asJson, io);
  }
  const shown = references.map((r) => ({ ...r, id: `ref:${r.id}` }));
  if (asJson) {
    io.log(JSON.stringify({ ok: true, references: shown, problems }, null, 2));
    return problems.length ? 1 : 0;
  }
  io.log(`# references  (${shown.length} entr${shown.length === 1 ? "y" : "ies"})`);
  for (const r of shown) io.log(`  ${r.id}  ${r.kind ?? "?"}  ${r.url ?? r.repo ?? ""}${r.verdict ? `  (${r.verdict})` : ""}`);
  if (problems.length) {
    io.log("\n# problems");
    for (const x of problems) io.log(`  ${x}`);
  }
  return problems.length ? 1 : 0;
}

async function standardsBody(argv, inject) {
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
    return emitFailure(fail("STANDARDS_UNKNOWN", `no standard named ${JSON.stringify(p.flags["--std"])} (known: ${loaded.standards.map((s) => s.id).join(", ")})`, "propagate kb standards"), asJson, io);
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
  if (report.unknownProject) return emitFailure(fail("STANDARDS_UNKNOWN_PROJECT", `no project named ${JSON.stringify(report.unknownProject)} among the scanned units or sidecars (known: ${report.known.join(", ")})`, "propagate kb standards"), asJson, io);
  if (!report.ok) return emitFailure(fail("STANDARDS_BLIND", report.blind, "check PROPAGATE_WORKSPACES and the workspace roots, then re-run"), asJson, io);
  const code = report.problems.length ? 1 : 0;
  if (asJson) {
    io.log(JSON.stringify(report, null, 2));
    return code;
  }
  io.log(`# standards  (offline; ${report.units_scanned} unit(s) scanned, floor ${report.floor}; ${report.sidecars_scanned} sidecar(s) read, ${report.sidecars_unreadable.length} unreadable)`);
  io.log(cachedVersions ? `  tool versions read ${cacheAge(cachedVersions, (inject.now ?? Date.now)()) ?? "at an unreadable time"} (kb standards versions --refresh)` : "  tool versions: never read (kb standards versions --refresh)");
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
    if (Object.keys(probes).length === 0) return emitFailure(fail("STANDARDS_NO_PROBES", "no registry entry declares a probe, so there is nothing to refresh and the cache is left as it was", "add `probe: {cmd, args, parse}` to a standard in kb-standards.yml"), asJson, io);
    versions = refreshVersions({ probes, run: inject.run });
    writeVersions(dir, versions);
  }
  if (asJson) {
    io.log(JSON.stringify({ ok: true, versions }, null, 2));
    return 0;
  }
  if (!versions) {
    io.log("no tool versions cached. Run: propagate kb standards versions --refresh");
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

/** `kb standards adopt|decline|remove <std> <project>`. Dry run unless --apply. */
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
  if (verb !== "adopt" && !(f["--reason"] ?? "").trim()) return emitFailure(fail("STANDARDS_USAGE", `${verb} needs --reason`, `propagate kb standards ${verb} ${stdId} ${projectArg} --reason "<why>"`), asJson, io);
  const { integrations, workspaces } = await env(inject);
  const loaded = loadOrFail(integrations);
  if (!loaded.ok) return emitFailure(loaded, asJson, io);
  const std = loaded.standards.find((s) => s.id === stdId);
  if (!std) return emitFailure(fail("STANDARDS_UNKNOWN", `no standard named ${JSON.stringify(stdId)} (known: ${loaded.standards.map((s) => s.id).join(", ")})`, "propagate kb standards"), asJson, io);
  const allSidecars = readSidecars(workspaces);
  const sc = findSidecar(workspaces, projectArg, allSidecars);
  if (sc.ambiguous) return emitFailure(fail("STANDARDS_PROJECT_AMBIGUOUS", `${JSON.stringify(projectArg)} names a project in ${sc.ambiguous.length} workspaces: ${sc.ambiguous.join(", ")}`, `propagate kb standards ${verb} ${stdId} <workspace>/<project>  (one of the above)`), asJson, io);
  const project = sc.project ?? projectArg;
  if (!sc.file) return emitFailure(fail("STANDARDS_PROJECT_UNKNOWN", `no sidecar for project ${JSON.stringify(projectArg)}; looked for ${sc.expected.slice(0, 3).join(" or ")}${sc.expected.length > 3 ? ` (and ${sc.expected.length - 3} more workspace roots)` : ""}`, "create the project's state folder (see rule:state-and-decisions) or check the project name"), asJson, io);
  const cur = readAdoptions(sc.file);
  if (cur.error) return emitFailure(fail("STANDARDS_UNREADABLE", cur.error, "fix the sidecar block named above, or run propagate kb migrate if it has both kb: and standards:"), asJson, io);
  const isAdopted = cur.adopted.some((a) => a?.standard === stdId);
  if (verb === "remove" && !isAdopted) return emitFailure(fail("STANDARDS_NOT_ADOPTED", `${project} has not adopted ${stdId}, so there is nothing to remove`, `propagate kb standards decline ${stdId} ${project} --reason "<why>"`), asJson, io);
  if (verb === "decline" && isAdopted) return emitFailure(fail("STANDARDS_ALREADY_ADOPTED", `${project} has adopted ${stdId}; declining it would contradict the adoption`, `propagate kb standards remove ${stdId} ${project} --reason "<why>"`), asJson, io);

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
    return emitFailure(fail("STANDARDS_USAGE", `${stdId} is detected on no unit of ${project}`, `propagate kb standards adopt ${stdId} ${project} --units <unit,unit>`), asJson, io);
  }
  const live = (std.page?.rows ?? []).filter((r) => r.state !== "retired");
  const rows = rep.rows.map((r) => ({ id: r.id, status: mine?.rows.find((x) => x.id === r.id)?.status ?? r.status }));
  const checksToRun = live.filter((r) => r.check.kind === "command" || r.check.kind === "test").map((r) => ({ row: r.id, kind: r.check.kind, target: r.check.target }));

  const apply = Boolean(f["--apply"]);
  if (apply && verb !== "adopt") return emitFailure(fail("STANDARDS_APPROVAL_UNAVAILABLE", APPROVAL_UNAVAILABLE, `propagate kb standards ${verb} ${stdId} ${project} --reason "<why>"  (a dry run)`), asJson, io);
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
