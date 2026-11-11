/**
 * Cross-repo propagation: the client-isolation guard over ordinary edges
 * (`crossClientViolations`), the partner allowlist/alias helpers, and the loader
 * for the RETIRED `<repo>/.propagates-cross.yml` format.
 *
 * `.propagates-cross.yml` is retired (propagate#117): its entries never fired
 * (`reconcile` and `check --changed` do not read it). The loader remains only so
 * `doctor` can report leftovers. A cross-repo coupling is declared in an ordinary
 * `.propagates.yml`, which already fires across repo boundaries.
 */
import { readFileSync, existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "yaml";
import Ajv from "ajv";
import { CROSS_SCHEMA_PATH, CROSS_ALLOW_PATH } from "../core/config.mjs";

const FILE_NAME = ".propagates-cross.yml";

let _validate = null;
function validator() {
  if (_validate) return _validate;
  const schema = JSON.parse(readFileSync(CROSS_SCHEMA_PATH, "utf8"));
  _validate = new Ajv({ allErrors: true }).compile(schema);
  return _validate;
}

/**
 * @param {string} repoRoot absolute repo root
 * @returns {{pushEdges: Array, pullEdges: Array}}
 */
export function loadCrossRepoSync(repoRoot) {
  const filePath = path.join(repoRoot, FILE_NAME);
  if (!existsSync(filePath)) return { pushEdges: [], pullEdges: [] };

  const parsed = yaml.parse(readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object") return { pushEdges: [], pullEdges: [] };

  const validate = validator();
  if (!validate(parsed)) {
    const errs = validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw new Error(`${FILE_NAME} schema violation in ${repoRoot}: ${errs}`);
  }

  const pushEdges = [];
  const pullEdges = [];
  for (const entry of parsed.platform_contracts ?? []) {
    if (entry.source && Array.isArray(entry.affects)) {
      pushEdges.push({ source: String(entry.source), affects: entry.affects, why: String(entry.why ?? ""), kind: entry.kind ?? "contract" });
    } else if (entry.watch) {
      pullEdges.push({ watch: String(entry.watch), for: String(entry.for ?? ""), why: String(entry.why ?? ""), flow: "platform_contract" });
    }
  }
  for (const entry of parsed.shared_conventions ?? []) {
    pullEdges.push({ watch: String(entry.watch), for: String(entry.for ?? ""), why: String(entry.why ?? ""), flow: "shared_convention" });
  }
  return { pushEdges, pullEdges };
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-allowlist resolution (realpath client-isolation guard) + partner aliases
// ─────────────────────────────────────────────────────────────────────────────

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

let _partnerRootsReal = null;
let _contractGlobs = null;
let _partnerAliases = null;
function loadAllow() {
  // Fill each singleton independently so a test hook that overrides one field
  // (e.g. __setPartnerRootsForTest sets roots but not aliases) doesn't leave the
  // others null — resolvePartner must still get real aliases.
  if (_partnerRootsReal !== null && _contractGlobs !== null && _partnerAliases !== null) return;
  const allow = yaml.parse(readFileSync(CROSS_ALLOW_PATH, "utf8"));
  if (_partnerRootsReal === null) {
    _partnerRootsReal = (allow.partner_roots ?? [])
      .map(expandHome)
      .filter((r) => existsSync(r))
      .map((r) => realpathSync(r));
  }
  if (_contractGlobs === null) _contractGlobs = allow.contract_files ?? [];
  if (_partnerAliases === null) _partnerAliases = allow.partner_aliases ?? {};
}

/** Test hook — override resolved partner roots. */
export function __setPartnerRootsForTest(roots) {
  _partnerRootsReal = roots;
  _contractGlobs = _contractGlobs ?? ["**"];
}

function underPartner(realAbs) {
  return _partnerRootsReal.some((root) => realAbs === root || realAbs.startsWith(root + path.sep));
}

function matchesContract(absPath) {
  if (!_contractGlobs || _contractGlobs.includes("**")) return true;
  return _contractGlobs.some((g) => {
    const suffix = g.replace(/\*\*/g, "").replace(/\*/g, "");
    return absPath.includes(suffix.replace(/\/+/g, "/"));
  });
}

/**
 * Resolve a declared cross path relative to the sidecar dir, then realpath-check
 * it against the partner allowlist (client-isolation guard) and contract-file allowlist.
 * @returns {{abs: string, ok: boolean, reason: string}}
 */
export function resolveTarget(sidecarDir, declaredPath) {
  loadAllow();
  // `abs` is the LEXICAL absolute path — a STABLE identity that survives file
  // deletion (needed so rename detection + state-keying match whether or not the
  // file currently exists). The realpath is computed ONLY for the isolation check
  // (a symlink must not escape a partner tree), never used as the identity key.
  const lexicalAbs = path.resolve(sidecarDir, declaredPath);
  if (!existsSync(lexicalAbs)) {
    return { abs: lexicalAbs, ok: false, reason: "missing" };
  }
  const realAbs = realpathSync(lexicalAbs);
  if (!underPartner(realAbs)) return { abs: lexicalAbs, ok: false, reason: "outside-partner" };
  if (!matchesContract(realAbs)) return { abs: lexicalAbs, ok: false, reason: "not-contract" };
  return { abs: lexicalAbs, ok: true, reason: "ok" };
}

/**
 * Normalize a path or an Affects: token to a canonical partner name, or null.
 * Used to tag every cross row with `partner` so drain groups file + (future) decision rows.
 */
export function resolvePartner(pathOrToken) {
  loadAllow();
  const hay = String(pathOrToken).toLowerCase();
  for (const [partner, aliases] of Object.entries(_partnerAliases)) {
    if (aliases.some((a) => hay.includes(String(a).toLowerCase()))) return partner;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-repo discovery (independent of .propagates.yml) + logical-edge id
// ─────────────────────────────────────────────────────────────────────────────

/** Scan searchRoots (to maxDepth) for dirs containing .propagates-cross.yml. */
export function discoverCrossReposSync(searchRoots, maxDepth = 2) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // A cross sidecar marks a PARTICIPATING DIRECTORY, not a subtree boundary,
    // so keep walking past it — N68. This used to `return` here, which made a
    // nested sidecar unreachable at any maxDepth: `Vipin Kaushik` carries one,
    // so the walk stopped there and `Vipin Kaushik/astro-studio`'s 7 edges were
    // never enumerated. Every one of them resolved {ok:false,reason:"missing"}
    // while doctor printed `✓ cross-repo edges resolve  4 edges, 0 missing` —
    // a check reporting clean over a corpus it had silently truncated.
    if (existsSync(path.join(dir, FILE_NAME))) {
      out.push({ name: path.basename(dir), root: dir });
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  for (const root of searchRoots) {
    try { if (statSync(root).isDirectory()) walk(root, 0); } catch { /* skip */ }
  }
  return out;
}

/** Order-independent logical-edge id from a pair of realpath endpoints. */
export function crossCorrelationId(absA, absB) {
  const ra = existsSync(absA) ? realpathSync(absA) : absA;
  const rb = existsSync(absB) ? realpathSync(absB) : absB;
  return [ra, rb].sort().join("|");
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-isolation guard over ordinary edges (propagate#117)
// ─────────────────────────────────────────────────────────────────────────────

function tryReal(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

function isUnder(abs, root) {
  return abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * The shared platform roots: `partner_roots` of the cross-allow file that exist
 * on this machine (realpath'd), minus any root that contains the hub root (a
 * root above the hub would exempt every edge, so it binds nothing).
 * Reading the file is the impure half; `crossClientViolations` stays pure.
 * @returns {string[]}
 */
export function loadPlatformRoots(hubRoot, allowPath = CROSS_ALLOW_PATH) {
  let allow;
  try { allow = yaml.parse(readFileSync(allowPath, "utf8")); } catch { return []; }
  const hubReal = hubRoot ? tryReal(hubRoot) : null;
  return (allow?.partner_roots ?? [])
    .map(expandHome)
    .filter((r) => existsSync(r))
    .map((r) => realpathSync(r))
    .filter((r) => !(hubReal && isUnder(hubReal, r)));
}

/**
 * Which edges join two different client workspaces without a shared platform
 * root at either end. Pure: rows and roots in, verdict out.
 *
 * Owner of a path = the discovered workspace that is a DIRECT child of `hubRoot`
 * and contains the path; anything else (the hub itself, tooling) has no owner.
 * Violation = `sameRepo` false, both ends owned, owners differ, and neither end
 * under a platform root. Paths are compared by realpath (symlinks exist).
 *
 * @param {Array<{sameRepo:boolean, source:{path:string}, downstream:{path:string}, edge_id?:string}>} rows
 * @param {{hubRoot:string, workspaces:Array<{root:string}>, platformRoots?:string[], minWorkspaces?:number}} ctx
 * @returns {{examined:number, violations:Array, blind:string|null}}
 */
export function crossClientViolations(rows, { hubRoot, workspaces, platformRoots = [], minWorkspaces = 10 }) {
  const hubReal = tryReal(hubRoot);
  const children = workspaces
    .map((w) => tryReal(w.root))
    .filter((r) => path.dirname(r) === hubReal);
  const platform = platformRoots.map(tryReal).filter((r) => !isUnder(hubReal, r));
  const owner = (abs) => children.find((c) => isUnder(abs, c)) ?? null;

  const cross = rows.filter((r) => r.sameRepo === false);
  let blind = null;
  if (workspaces.length < minWorkspaces) {
    blind = `only ${workspaces.length} workspace(s) discovered (need ${minWorkspaces}) — the scan has gone blind, it has not found nothing`;
  } else if (cross.length === 0) {
    blind = rows.length === 0
      ? "0 reconcile rows — the scan has gone blind, it has not found nothing"
      : `0 cross-repo rows among ${rows.length} reconcile rows — the scan has gone blind, it has not found nothing`;
  }

  const violations = [];
  for (const r of cross) {
    const a = tryReal(r.source.path);
    const b = tryReal(r.downstream.path);
    const ownerA = owner(a);
    const ownerB = owner(b);
    if (!ownerA || !ownerB || ownerA === ownerB) continue;
    if (platform.some((p) => isUnder(a, p) || isUnder(b, p))) continue;
    violations.push({ edge_id: r.edge_id, source: r.source.path, downstream: r.downstream.path, ownerA, ownerB });
  }
  return { examined: cross.length, violations, blind, clientWorkspaces: children.length };
}

/**
 * Every entry left in any `.propagates-cross.yml` under searchRoots. Entries are
 * retired and never fire, so any entry is a finding. Unparseable files are
 * reported, never skipped in silence (N68).
 * @returns {{files:number, entries:Array<{file:string, kind:string, target:string, why:string}>, unreadable:Array<{file:string, error:string}>}}
 */
export function legacyCrossEntries(searchRoots) {
  const repos = discoverCrossReposSync(searchRoots);
  const entries = [];
  const unreadable = [];
  let files = 0;
  for (const repo of repos) {
    const file = path.join(repo.root, FILE_NAME);
    let e;
    try { e = loadCrossRepoSync(repo.root); files++; } catch (err) { unreadable.push({ file, error: err.message }); continue; }
    for (const p of e.pushEdges) entries.push({ file, kind: "push", target: p.source, why: p.why });
    for (const p of e.pullEdges) entries.push({ file, kind: "pull", target: p.watch, why: p.why });
  }
  return { files, entries, unreadable };
}
