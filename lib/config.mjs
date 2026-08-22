/**
 * Configuration, so this skill stops being fitted to one person's repo.
 *
 * Four layers, most specific wins:
 *   shipped defaults  <  ~/.curate-docs.yml  <  <repo>/.curate-docs.yml  <  CLI flags
 *
 * The contract is copied in spirit from propagate/lib/config.mjs:29-64, which earned it:
 *
 *   MUST NOT THROW. A config file is hand-written, so a malformed one is a typo. It
 *   degrades to defaults and SAYS SO. Degrading silently would be the other half of the
 *   bug — the tool runs on defaults while the operator believes their file is in force.
 *
 * `degraded` is therefore a reported VALUE, never a silence (rule:discernment-checks §2).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";

/**
 * Directory names that are never repo documentation.
 *
 * Every entry past the obvious build output was measured across ~/Documents/GitHub:
 *   .worktrees   duplicate WHOLE doc trees — Motherboard's docs/unreviewed was counted twice
 *   .claude 183 · .gemini 140 · .github 160 · .disabled 169 · .cursor 9 — agent/CI config
 *   .obsidian    a vault is a [[wikilink]] corpus this extractor cannot read (refused, not guessed)
 *   fixtures     found by running this tool on ITSELF: 11 of 16 "docs" were its own fixtures
 *   .gstack      session scratch, "never authoritative" per rule:state-and-decisions
 *
 * NOT here, deliberately:
 *   references/     360 files of real skill documentation
 *   docs/unreviewed 384 files — they are exactly the un-triaged docs, which is the point
 *   archive/        graded-exempt, NOT skipped. Skipping it drops the archived doc's
 *                   OUTBOUND edges and orphans everything it uniquely cited — proven to
 *                   turn one archive action into 3 unattributed findings. See archiveDirs.
 */
const SKIP_DIRS = [
  "node_modules", ".git", ".next", "dist", "build", "coverage", "vendor",
  ".agents", "_archive", "fixtures", "__fixtures__", "testdata", "__snapshots__",
  ".gstack", ".worktrees", ".claude", ".gemini", ".github", ".cursor", ".disabled",
  ".obsidian", ".turbo", ".vercel", ".docusaurus", "_site",
];

/** Prefix globs — `.venv.broken-xcode-2026-08-11` escapes a literal `.venv`. */
const SKIP_GLOBS = [".venv*", ".gstack-backup-*"];

export const DEFAULTS = Object.freeze({
  entryPoints: ["STATE.md", "README.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md", "TODOS.md", "SKILL.md"],
  hubSeeds: "auto",
  docRoots: ["."],
  skipDirs: SKIP_DIRS,
  skipGlobs: SKIP_GLOBS,
  skipDirsReplace: false,
  archiveDirs: ["archive", "_archive"],
  followSymlinks: true,
  staleDays: { default: 30 },
  kinds: {},
  extraRoots: [],
});

export const CONFIG_NAME = ".curate-docs.yml";

/** `~/x` taken literally resolves to `./~/x`, which exists nowhere — and the failure would
 *  present as "path does not exist", pointing the reader at the value they got right. */
function expandHome(p, home) {
  if (typeof p !== "string") return p;
  if (p === "~") return home;
  return p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** @returns {{value: object|null, warning: string|null}} — never throws. */
function readLayer(file) {
  if (!existsSync(file)) return { value: null, warning: null };
  let parsed;
  try {
    parsed = parseYaml(readFileSync(file, "utf8"));
  } catch (err) {
    return { value: null, warning: `curate-docs: could not read ${file} (${err?.message ?? err}) — using defaults` };
  }
  if (parsed === null || parsed === undefined) return { value: null, warning: null };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: null, warning: `curate-docs: ${file} is not a mapping — ignoring it, using defaults` };
  }
  return { value: parsed, warning: null };
}

/**
 * @param {string} repoRoot
 * @param {{home?:string, flags?:object, warn?:(m:string)=>void}} [opts]
 */
export function loadConfig(repoRoot, opts = {}) {
  const home = opts.home ?? os.homedir();
  const warn = opts.warn ?? ((m) => console.error(m));
  const flags = opts.flags ?? {};

  const layers = [];
  let degraded = false;
  for (const file of [path.join(home, CONFIG_NAME), path.join(repoRoot, CONFIG_NAME)]) {
    const { value, warning } = readLayer(file);
    if (warning) { warn(warning); degraded = true; }
    if (value) layers.push({ file, value });
  }

  const merged = { ...DEFAULTS };
  for (const { value } of layers) for (const [k, v] of Object.entries(value)) merged[k] = v;
  // A CLI flag is the most specific layer there is.
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined || v === null) continue;
    merged[k] = k === "staleDays" && typeof v === "number" ? { default: v } : v;
  }

  // skipDirs MERGES unless replacement is asked for explicitly. A config that replaced by
  // default would let one added entry silently drop node_modules — 24,525 files back in scope.
  if (!merged.skipDirsReplace) {
    const extra = layers.flatMap(({ value }) => value.skipDirs ?? []).concat(flags.skipDirs ?? []);
    merged.skipDirs = [...new Set([...DEFAULTS.skipDirs, ...extra])];
  }
  merged.skipGlobs = [...new Set([...DEFAULTS.skipGlobs, ...(merged.skipGlobs ?? [])])];

  merged.extraRoots = (merged.extraRoots ?? []).map((p) => expandHome(p, home));
  merged.docRoots = (merged.docRoots ?? ["."]).map((p) => expandHome(p, home));
  if (typeof merged.staleDays === "number") merged.staleDays = { default: merged.staleDays };

  return {
    ...merged,
    degraded,
    source: layers.length ? layers.map((l) => l.file).join(" < ") : "defaults",
  };
}

/** Does this directory name get skipped? Exported so discovery and tests share ONE list —
 *  propagate duplicated its ignore list across four files and they drifted. */
export function isSkipped(name, cfg) {
  if (cfg.skipDirs.includes(name)) return true;
  return cfg.skipGlobs.some((g) =>
    g.endsWith("*") ? name.startsWith(g.slice(0, -1)) : name === g,
  );
}
