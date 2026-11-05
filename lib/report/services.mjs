/**
 * services.mjs — which external service each unit uses, derived, plus what is wrong with how the
 * hub describes those services. OFFLINE: no network call, no write, no secret file opened.
 *
 * DATA lives on the hub (`scripts/execution/services.yml` and the pages beside it); the LOGIC is
 * here, so manifest, doctor and `propagate services` read one source and one JSON shape.
 *
 * "Which units use Vercel" is never a hand list (rule:derive-dont-curate). A unit uses a service
 * when one of four kinds of evidence says so, each kept separate in the output:
 *   dep        a dependency name in package.json / go.mod / pubspec.yaml / pyproject.toml
 *   file       a config file in the unit (vercel.json, wrangler.*, ...)
 *   env-name   a variable NAME in a `.env*.example` file. Names only; `.env` and `.env.local` are
 *              never opened, because their contents are credentials.
 *   registry   a row in deploy.yml / mongo.yml / access.yml / ports.yml keyed `<Workspace>/<unit>`
 *
 * UNITS come from manifest's walk (`workspaceManifest`), not a second walker.
 *
 * A READER THAT CANNOT REPORT FAILURE INVENTS AN ANSWER (rule:discernment-checks §6): a missing,
 * unparseable or wrong-schema services.yml is `could-not-run` with the reason, never zero services.
 * A scan of fewer than FLOOR units is "the scan has gone blind", not a clean result.
 *
 * FINDINGS, each its own state, never collapsed:
 *   UNPAGED, STUB-IN-USE, STALE-LIMIT (cause: over-90-days | unverified), HAZARD-UNTRIGGERED,
 *   NO-CREDENTIAL-LOCATION, ENV-UNKNOWN, could-not-run.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { INTEGRATIONS, HUB_ROOT } from "../core/config.mjs";
import { workspaceManifest, readYamlSafe } from "./manifest.mjs";
import { parseEntries, GLOBAL_INDEX } from "../gotchas/parse.mjs";

export const SCHEMA_VERSION = 1;
export const SHAPE = "propagate-services/1";
/** rule:environment-vocabulary: local is a laptop, the other three are deployed. */
export const ENV_NAMES = Object.freeze(["local", "development", "preview", "production"]);
/** Fewer units than this across the whole tree means the scan looked at nothing. */
export const MIN_UNITS = 10;
export const STALE_DAYS = 90;
export const FINDING_STATES = Object.freeze([
  "UNPAGED",
  "STUB-IN-USE",
  "STALE-LIMIT",
  "HAZARD-UNTRIGGERED",
  "NO-CREDENTIAL-LOCATION",
  "ENV-UNKNOWN",
  "SCAN-SKIPPED",
  "UNIT-NOT-ON-DISK",
  "could-not-run",
]);

const ID_RE = /^[a-z][a-z0-9-]*$/;
const REGISTRY_KEYS = { deploy: "deployments", mongo: "databases", access: "properties", ports: "services" };

// ── loading ──────────────────────────────────────────────────────────────────

const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** `verified:` may parse as a Date, an ISO string, or the word `unverified`. */
function verifiedOf(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v.trim();
  return null;
}

/**
 * @returns {{ok:true, services:object[], file:string} | {ok:false, state:"could-not-run", reason:string, problems:string[]}}
 */
export function loadServices(file) {
  const fail = (reason, problems = []) => ({ ok: false, state: "could-not-run", reason, problems });
  if (!file) return fail("services.yml is not configured (set PROPAGATE_SERVICES_FILE or integrations.servicesFile)");
  const r = readYamlSafe(file);
  if (r.error) return fail(`services.yml ${r.error}: ${file}`);
  const doc = r.data;
  if (!isObj(doc)) return fail(`services.yml is not a mapping: ${file}`);
  if (doc.schema_version !== SCHEMA_VERSION) {
    return fail(`services.yml schema_version is ${JSON.stringify(doc.schema_version)}, this reader understands ${SCHEMA_VERSION}`);
  }
  if (!isObj(doc.services) || Object.keys(doc.services).length === 0) {
    return fail("services.yml has no `services:` mapping — a registry with nothing in it is a shape this reader does not recognise, not zero services");
  }
  const problems = [];
  if (r.duplicateKeys) problems.push("duplicate keys in services.yml (last wins would hide one)");
  const services = [];
  for (const [id, s] of Object.entries(doc.services)) {
    const at = `services.${id}`;
    if (!ID_RE.test(id)) problems.push(`${at}: id must be lowercase (a-z, 0-9, -)`);
    if (!isObj(s)) {
      problems.push(`${at}: not a mapping`);
      continue;
    }
    if (s.status !== "deep" && s.status !== "stub") problems.push(`${at}: status must be deep or stub, got ${JSON.stringify(s.status)}`);
    if (typeof s.page !== "string" || !s.page) problems.push(`${at}: page is required`);
    if (!isObj(s.detect)) problems.push(`${at}: detect is required`);
    const limits = [];
    for (const [i, l] of (Array.isArray(s.limits) ? s.limits : []).entries()) {
      const v = isObj(l) ? verifiedOf(l.verified) : null;
      if (!isObj(l) || typeof l.name !== "string") {
        problems.push(`${at}.limits[${i}]: needs a name`);
        continue;
      }
      if (!v) problems.push(`${at}.limits[${i}] (${l.name}): verified is required (a date, or "unverified")`);
      else if (v !== "unverified" && Number.isNaN(Date.parse(v))) problems.push(`${at}.limits[${i}] (${l.name}): verified is neither a date nor "unverified": ${JSON.stringify(v)}`);
      limits.push({ name: l.name, value: l.value ?? null, unit: l.unit ?? null, source_url: l.source_url ?? null, verified: v });
    }
    let environments = null;
    if (s.environments !== undefined && s.environments !== null) {
      if (!isObj(s.environments)) problems.push(`${at}.environments: not a mapping`);
      else {
        environments = {};
        for (const [k, v] of Object.entries(s.environments)) {
          if (!ENV_NAMES.includes(k)) {
            problems.push(`${at}.environments.${k}: unknown environment (the four are ${ENV_NAMES.join(", ")}; rule:environment-vocabulary)`);
            continue;
          }
          environments[k] = v ?? {};
        }
      }
    }
    const d = isObj(s.detect) ? s.detect : {};
    const registries = (Array.isArray(d.registries) ? d.registries : []).filter(isObj).map((x) => ({ file: String(x.file ?? ""), field: x.field == null ? null : String(x.field) }));
    for (const reg of registries) {
      if (!REGISTRY_KEYS[reg.file]) problems.push(`${at}.detect.registries: unknown registry file ${JSON.stringify(reg.file)} (one of ${Object.keys(REGISTRY_KEYS).join(", ")})`);
    }
    services.push({
      id,
      title: typeof s.title === "string" ? s.title : id,
      status: s.status,
      page: typeof s.page === "string" ? s.page : null,
      accounts: Array.isArray(s.accounts) ? s.accounts : [],
      plan: s.plan ?? null,
      limits,
      bill_source: s.bill_source ?? null,
      needs_credentials: typeof s.needs_credentials === "boolean" ? s.needs_credentials : Array.isArray(s.accounts) && s.accounts.length > 0,
      detect: { deps: strList(d.deps), files: strList(d.files), env: strList(d.env), registries },
      edge_files: strList(s.edge_files),
      hazards: (Array.isArray(s.hazards) ? s.hazards : []).map(String),
      environments,
    });
  }
  if (problems.length) return fail(`services.yml has ${problems.length} schema problem(s): ${problems.join("; ")}`, problems);
  return { ok: true, services, file };
}

// ── units (from manifest's walk) ─────────────────────────────────────────────

/**
 * Flatten a `workspaceManifest` result into the unit rows `derive` takes. Units not on disk are
 * skipped (a fresh machine is entirely not-cloned-here), as is a workspace repo's own
 * toolchain-less root, which is not a runnable unit.
 */
export function unitsFromManifest(m, { notOnDisk = null } = {}) {
  const out = [];
  for (const p of m.projects) {
    if (!p.onDisk) {
      // A declared project the walk cannot find is NOT "uses no services". Say so (rule:discernment-checks §2).
      // Measured 2026-11-05: Sindhu's sipl-tms sidecar carried a hub-relative repo_root, so the project vanished
      // from every service count with no line anywhere saying why.
      if (notOnDisk && !p.isWorkspaceItself) notOnDisk.push({ workspace: m.workspace, project: p.project, repo_root: p.repo_root });
      continue;
    }
    for (const u of p.units) {
      if (p.isWorkspaceItself && u.toolchain === "none") continue;
      out.push({
        workspace: m.workspace,
        project: p.project,
        rel: u.rel,
        abs: path.join(m.workspaceRoot, u.rel),
        credentialsDeclared: Boolean(p.credentials?.declared),
      });
    }
  }
  return out;
}

/** Units across workspaces, deduplicated by absolute path (nested workspace roots, G4). */
export function collectUnits(workspaces, { integrations = INTEGRATIONS, skipped = null, notOnDisk = null, manifest = workspaceManifest } = {}) {
  const seen = new Map();
  for (const ws of workspaces) {
    let m;
    try {
      m = manifest(ws.root, { integrations });
    } catch (e) {
      // Never a silent skip: a workspace that cannot be read is reported, or its absence reads as "no services".
      if (skipped) skipped.push({ workspace: ws.name ?? ws.root, reason: String(e?.message ?? e).split("\n")[0] });
      continue;
    }
    for (const u of unitsFromManifest(m, { notOnDisk })) if (!seen.has(u.abs)) seen.set(u.abs, u);
  }
  return [...seen.values()];
}

// ── evidence ─────────────────────────────────────────────────────────────────

const globRe = (g) => new RegExp("^" + g.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\/@-]/g, "\\$&")).join(".*") + "$");

function depNames(abs) {
  const names = new Set();
  try {
    const pkg = JSON.parse(readFileSync(path.join(abs, "package.json"), "utf8"));
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const n of Object.keys(pkg[k] ?? {})) names.add(n);
    }
  } catch {
    // no package.json or unparseable: nothing derivable from it
  }
  for (const f of ["go.mod", "pubspec.yaml", "pyproject.toml", "requirements.txt"]) {
    let text;
    try {
      text = readFileSync(path.join(abs, f), "utf8");
    } catch {
      continue;
    }
    for (const t of text.match(/[A-Za-z0-9@_.\/-]+/g) ?? []) names.add(t);
  }
  return names;
}

/** Variable NAMES from `.env*.example` only. Nothing else named `.env*` is opened. */
export function exampleEnvNames(abs) {
  const names = new Set();
  let entries = [];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const e of entries) {
    if (e.isDirectory() || !/^\.env(\..+)?\.example$/.test(e.name)) continue;
    let text = "";
    try {
      text = readFileSync(path.join(abs, e.name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) names.add(m[1]);
    }
  }
  return names;
}

function fileExists(abs, pattern) {
  if (!pattern.includes("*")) return existsSync(path.join(abs, pattern));
  const dir = path.join(abs, path.dirname(pattern));
  const re = globRe(path.basename(pattern));
  try {
    return readdirSync(dir).some((n) => re.test(n));
  } catch {
    return false;
  }
}

/** Read the four registries once, by name -> the rows map `<Workspace>/<unit>` keys. */
export function readRegistryRows(integrations = INTEGRATIONS) {
  const rows = {};
  const sources = {};
  for (const [name, top] of Object.entries(REGISTRY_KEYS)) {
    const r = readYamlSafe(integrations[`${name}File`]);
    sources[name] = r.error ?? "ok";
    rows[name] = r.data?.[top] ?? {};
  }
  return { rows, sources };
}

/**
 * unit x service rows, with evidence. A row exists only when at least one detect rule matched.
 * @param {{workspace:string,project:string,rel:string,abs:string}[]} units
 * @param {object[]} services output of loadServices
 * @param {{registryRows?:object}} [opts]
 */
export function derive(units, services, { registryRows = {} } = {}) {
  const unitsPerProject = new Map();
  for (const u of units) unitsPerProject.set(`${u.workspace}\0${u.project}`, (unitsPerProject.get(`${u.workspace}\0${u.project}`) ?? 0) + 1);
  const rows = [];
  for (const u of units) {
    const deps = depNames(u.abs);
    const envs = exampleEnvNames(u.abs);
    for (const s of services) {
      const evidence = [];
      for (const d of s.detect.deps) {
        const re = globRe(d);
        const hit = [...deps].find((n) => re.test(n));
        if (hit) evidence.push({ kind: "dep", detail: hit });
      }
      for (const f of s.detect.files) if (fileExists(u.abs, f)) evidence.push({ kind: "file", detail: f });
      for (const e of s.detect.env) {
        const re = globRe(e);
        const hit = [...envs].find((n) => re.test(n));
        if (hit) evidence.push({ kind: "env-name", detail: hit });
      }
      for (const reg of s.detect.registries) {
        // Registries key a row by project root, and a unit can sit below it (SSJK-astro-darpan/tools). Use an ancestor's
        // row only when that project has a single unit: with several (SSJK-mb server/ui/admin) the row cannot say which.
        let row = registryRows[reg.file]?.[`${u.workspace}/${u.rel}`];
        if (!row && (unitsPerProject.get(`${u.workspace}\0${u.project}`) ?? 0) === 1) {
          for (let rel = path.dirname(u.rel); rel && rel !== "." && !row; rel = path.dirname(rel)) row = registryRows[reg.file]?.[`${u.workspace}/${rel}`];
        }
        const v = row && reg.field !== null ? row[reg.field] : row;
        if (row && v != null && v !== false && v !== "none") evidence.push({ kind: "registry", detail: `${reg.file}.yml${reg.field ? `:${reg.field}` : ""}` });
      }
      if (evidence.length) rows.push({ workspace: u.workspace, project: u.project, unit: u.rel, service: s.id, evidence });
    }
  }
  return rows;
}

// ── findings ─────────────────────────────────────────────────────────────────

/** id -> {live, present}. `live` = has a `**Trigger:**` line that parses (parseEntries drops the rest). */
export function hazardIndex(file = GLOBAL_INDEX) {
  const present = new Set();
  const live = new Set();
  if (!file || !existsSync(file)) return { present, live, error: `${file ?? "gotchas-global.md"} not found` };
  for (const m of readFileSync(file, "utf8").matchAll(/^### (\S+)/gm)) present.add(m[1]);
  for (const e of parseEntries(file).entries) live.add(e.title.split(/\s/)[0]);
  return { present, live, error: null };
}

const daysSince = (iso, now) => Math.floor((now - Date.parse(iso)) / 86400000);

export function findingsFor({ services, rows, units, hubRoot = HUB_ROOT, servicesDir = INTEGRATIONS.servicesDir, gotchasFile = GLOBAL_INDEX, now = Date.now() }) {
  const out = [];
  const used = new Map();
  for (const r of rows) {
    if (!used.has(r.service)) used.set(r.service, []);
    used.get(r.service).push(r);
  }
  const unitByKey = new Map(units.map((u) => [`${u.workspace}/${u.rel}`, u]));
  const haz = hazardIndex(gotchasFile);
  for (const s of services) {
    const users = used.get(s.id) ?? [];
    const pageAbs = s.page ? (hubRoot ? path.join(hubRoot, s.page) : servicesDir ? path.join(servicesDir, path.basename(s.page)) : null) : null;
    if (users.length && !(pageAbs && existsSync(pageAbs))) {
      out.push({ state: "UNPAGED", service: s.id, detail: `${users.length} unit(s) use ${s.id} but its page ${s.page} is missing${pageAbs ? ` (${pageAbs})` : ""}` });
    }
    if (users.length && s.status === "stub") {
      out.push({ state: "STUB-IN-USE", service: s.id, detail: `${s.id} is a stub page and ${users.length} unit(s) use it` });
    }
    for (const l of s.limits) {
      if (l.verified === "unverified") {
        out.push({ state: "STALE-LIMIT", cause: "unverified", service: s.id, detail: `limit "${l.name}" is unverified` });
      } else if (daysSince(l.verified, now) > STALE_DAYS) {
        out.push({ state: "STALE-LIMIT", cause: "over-90-days", service: s.id, detail: `limit "${l.name}" was verified ${l.verified}, ${daysSince(l.verified, now)} days ago` });
      }
    }
    for (const h of s.hazards) {
      if (haz.error) {
        out.push({ state: "HAZARD-UNTRIGGERED", service: s.id, hazard: h, detail: `${h}: cannot judge, ${haz.error}` });
      } else if (!haz.present.has(h)) {
        out.push({ state: "HAZARD-UNTRIGGERED", service: s.id, hazard: h, detail: `${h} is not in the global gotchas index` });
      } else if (!haz.live.has(h)) {
        out.push({ state: "HAZARD-UNTRIGGERED", service: s.id, hazard: h, detail: `${h} is in the global gotchas index with no live **Trigger:** line` });
      }
    }
    if (users.length && s.status === "deep" && (!s.environments || Object.keys(s.environments).length === 0)) {
      out.push({ state: "ENV-UNKNOWN", service: s.id, detail: `${s.id} is deep and in use but declares no environments block` });
    }
    if (s.needs_credentials) {
      for (const r of users) {
        const u = unitByKey.get(`${r.workspace}/${r.unit}`);
        if (u && !u.credentialsDeclared) {
          out.push({ state: "NO-CREDENTIAL-LOCATION", service: s.id, workspace: r.workspace, unit: r.unit, detail: `${r.workspace}/${r.unit} uses ${s.id}, but project ${r.project}'s .sidecar.yml declares no credentials:` });
        }
      }
    }
  }
  return out;
}

// ── the report ───────────────────────────────────────────────────────────────

const couldNot = (reason, extra = {}) => ({
  shape: SHAPE,
  state: "could-not-run",
  reason,
  units_scanned: 0,
  services: [],
  matrix: [],
  findings: [{ state: "could-not-run", detail: reason }],
  counts: { findings: 1, byState: { "could-not-run": 1 } },
  exit: 2,
  ...extra,
});

/**
 * @param {object} o
 * @param {{name:string,root:string}[]} o.workspaces
 * @param {object} [o.integrations] injectable for tests
 * @param {number} [o.minUnits] the floor
 */
export function buildServicesReport({
  workspaces,
  integrations = INTEGRATIONS,
  hubRoot = HUB_ROOT,
  gotchasFile = GLOBAL_INDEX,
  minUnits = MIN_UNITS,
  now = Date.now(),
  service = null,
  workspace = null,
} = {}) {
  const loaded = loadServices(integrations.servicesFile);
  if (!loaded.ok) return couldNot(loaded.reason, { problems: loaded.problems });
  const skipped = [];
  const notOnDisk = [];
  const units = collectUnits(workspaces ?? [], { integrations, skipped, notOnDisk });
  if (units.length < minUnits) {
    return couldNot(`the scan has gone blind: only ${units.length} unit(s) found across ${(workspaces ?? []).length} workspace(s), floor is ${minUnits} — this is no result, not a clean one`, { units_scanned: units.length, floor: minUnits });
  }
  const { rows: registryRows, sources } = readRegistryRows(integrations);
  let services = loaded.services;
  if (service && !services.some((s) => s.id === service)) {
    return couldNot(`no service named ${JSON.stringify(service)} in services.yml (known: ${services.map((s) => s.id).join(", ")})`, { units_scanned: units.length, floor: minUnits });
  }
  if (workspace && !units.some((u) => u.workspace === workspace)) {
    return couldNot(`no workspace named ${JSON.stringify(workspace)} among the scanned units`, { units_scanned: units.length, floor: minUnits });
  }
  let rows = derive(units, services, { registryRows });
  let findings = findingsFor({ services, rows, units, hubRoot, servicesDir: integrations.servicesDir, gotchasFile, now });
  for (const k of skipped) findings.push({ state: "SCAN-SKIPPED", workspace: k.workspace, detail: `workspace not scanned: ${k.reason}` });
  for (const n of notOnDisk) findings.push({ state: "UNIT-NOT-ON-DISK", workspace: n.workspace, unit: n.project, detail: `declared in a sidecar with repo_root ${JSON.stringify(n.repo_root)}, not found on disk; its services are not counted` });
  if (service) {
    services = services.filter((s) => s.id === service);
    rows = rows.filter((r) => r.service === service);
    findings = findings.filter((f) => f.service === service);
  }
  if (workspace) {
    rows = rows.filter((r) => r.workspace === workspace);
    findings = findings.filter((f) => !f.workspace || f.workspace === workspace);
  }
  const byState = {};
  for (const f of findings) {
    const k = f.cause ? `${f.state}/${f.cause}` : f.state;
    byState[k] = (byState[k] ?? 0) + 1;
  }
  const out = services.map((s) => {
    const mine = rows.filter((r) => r.service === s.id);
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      page: s.page,
      environments: s.environments,
      unit_count: mine.length,
      units: mine.map((r) => ({ workspace: r.workspace, project: r.project, unit: r.unit, evidence: r.evidence })),
    };
  });
  return {
    shape: SHAPE,
    state: "ok",
    reason: null,
    units_scanned: units.length,
    floor: minUnits,
    services: out,
    matrix: rows,
    findings,
    counts: { findings: findings.length, byState },
    sources,
    exit: findings.length ? 1 : 0,
  };
}

// ── manifest integration ─────────────────────────────────────────────────────

/**
 * Annotate a `workspaceManifest` result in place: `unit.services` (ids only) and one
 * `service-no-credential-location` gap per (unit, service) that needs credentials where the
 * project's sidecar declares none. Returns `{state}`; when services.yml is not configured at all,
 * touches nothing so manifest's output is unchanged on a machine without it.
 */
export function annotateManifest(m, { integrations = INTEGRATIONS } = {}) {
  if (!integrations.servicesFile) return { state: "not-configured" };
  const loaded = loadServices(integrations.servicesFile);
  if (!loaded.ok) return { state: "could-not-run", reason: loaded.reason };
  const units = unitsFromManifest(m);
  const { rows: registryRows } = readRegistryRows(integrations);
  const rows = derive(units, loaded.services, { registryRows });
  const needs = new Map(loaded.services.map((s) => [s.id, s.needs_credentials]));
  const byUnit = new Map();
  for (const r of rows) {
    if (!byUnit.has(r.unit)) byUnit.set(r.unit, []);
    byUnit.get(r.unit).push(r);
  }
  for (const p of m.projects) {
    for (const u of p.units) {
      const mine = byUnit.get(u.rel) ?? [];
      u.services = mine.map((r) => r.service).sort();
      if (!p.credentials?.declared) {
        for (const r of mine) {
          if (!needs.get(r.service)) continue;
          m.gaps.push({
            kind: "service-no-credential-location",
            project: p.project,
            detail: `${u.rel} needs ${r.service}, and this project's .sidecar.yml declares no credentials: — a new machine cannot learn where its ${r.service} credential lives`,
          });
        }
      }
    }
  }
  return { state: "ok" };
}
