/**
 * Cross-repo propagation loader + validator + realpath allowlist.
 * Mirrors lib/code-canonical.mjs shape; parses <repo>/.propagates-cross.yml.
 */
import { readFileSync, existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "yaml";
import Ajv from "ajv";
import { CROSS_SCHEMA_PATH, CROSS_ALLOW_PATH } from "./config.mjs";

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
  const lexicalAbs = path.resolve(sidecarDir, declaredPath);
  if (!existsSync(lexicalAbs)) {
    return { abs: lexicalAbs, ok: false, reason: "missing" };
  }
  const realAbs = realpathSync(lexicalAbs);
  if (!underPartner(realAbs)) return { abs: realAbs, ok: false, reason: "outside-partner" };
  if (!matchesContract(realAbs)) return { abs: realAbs, ok: false, reason: "not-contract" };
  return { abs: realAbs, ok: true, reason: "ok" };
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
    if (existsSync(path.join(dir, FILE_NAME))) {
      out.push({ name: path.basename(dir), root: dir });
      return; // don't recurse below a found cross repo
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
