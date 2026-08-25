/**
 * Workspace discovery — finds dirs containing `.propagates.yml` markers
 * under configured search roots. Synchronous (called at module-load time
 * from config.mjs to keep the public WORKSPACES export shape).
 *
 * A `.propagates.yml` marker means "edge declarations live here" by default.
 * It is ALSO a ledger-owning workspace root only when it opts in with
 * `workspace: true` (see propagates.schema.json). The walk always descends
 * past a marker regardless of that flag — nested workspaces are real (e.g.
 * PanditPawanKaushik/SSJK-mb nested under PanditPawanKaushik) and a
 * non-workspace marker (e.g. a `docs/` sidecar) must not swallow anything
 * beneath it.
 *
 * Searched at depth ≤ DEFAULT_MAX_DEPTH below each search root, so both:
 *   - ~/Documents/GitHub/Vipin Kaushik/          (depth 1)
 *   - ~/Documents/GitHub/PanditPawanKaushik/SSJK-mb/  (depth 2)
 * are reachable.
 *
 * Ledger path resolution per workspace (see makeWorkspaceRecord):
 *   - `<root>/propagation/ledger.jsonl` is checked FIRST, but only a FILE
 *     there wins — an empty `propagation/` directory alone is not enough.
 *     This is the third, current layout (docs/DECISIONS.md, "a propagation/
 *     folder in every workspace"): the legacy basenames, un-hidden, chosen
 *     deliberately rather than accidentally.
 *   - Otherwise, if a ledger file ALREADY EXISTS at either of the two older
 *     candidate paths, pin to that one — never relocate a live ledger
 *     because a `docs/` dir later appears.
 *   - Otherwise, `<root>/docs/` existing selects the legacy
 *     `docs/PROPAGATION_LEDGER.{jsonl,md}` convention; its absence selects
 *     `.propagation/ledger.{jsonl,md}`.
 *
 * scanDirs (relative to workspace root) — directories the watcher walks:
 *   - Always includes "." (root itself)
 *   - Includes "docs" when docs/ exists
 *
 * `discoverWorkspacesSync` never throws — a malformed marker, an unreadable
 * dir, or an empty result all resolve gracefully. It returns
 * `{ workspaces, markersSeen, degraded, suspiciousMarkers }`; `degraded` is
 * true when markers were found on disk but none opted into `workspace: true`
 * (a signal that something upstream — like the schema not yet declaring the
 * field — is silently swallowing every workspace, i.e. TOTAL collapse).
 *
 * `degraded` only catches n=0-workspaces collapse. If a single workspace
 * silently drops out (corrupted marker, typo'd `workspace: "true"`, an
 * exception while building its record) while the rest stay valid,
 * `degraded` stays false. `suspiciousMarkers` is the partial-loss signal:
 * an array of `{path, reason}` for every marker that is (a) unparseable
 * YAML, (b) has a `workspace` key present but not a strict boolean, or (c)
 * parsed fine but threw while building its workspace record. Callers
 * (doctor, status --json) must surface this list as a real problem, not a
 * log line — that's the whole point of Part A.
 */

import {
  readdirSync,
  existsSync,
  statSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

/**
 * Exported so callers can REPORT the depth actually used. config.mjs MAX_DEPTH is
 * `undefined` when unconfigured — the right sentinel for 'let the callee decide',
 * and the wrong thing to print at a human, who then learns nothing about how deep
 * the walk went. One default, named once, readable by whoever has to explain it.
 */
export const DEFAULT_MAX_DEPTH = 2;

/** The sidecar filename. One spelling, used by both the walk and listDirs. */
const MARKER = ".propagates.yml";

// NOTE (2026-08-19): the walker's guard is
//   `if (e.name.startsWith(".") || SKIP_DIR_NAMES.has(e.name)) continue;`
// so every DOTTED entry below is dead code — already skipped by the first clause.
// Only node_modules, dist, build, Library and Trash are load-bearing. They are
// kept because the guard could change, but do not add dotted names here expecting
// them to do anything. Two timestamped `.gstack-backup-<epoch>` literals from this
// author's machine were removed the same day: machine-specific AND unreachable.
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".vercel",
  "Library",
  "Trash",
]);

/**
 * Backup directories, matched by PREFIX rather than by exact name.
 *
 * Exported because lib/refs.mjs kept its own copy of this list and the two had
 * already diverged: refs carried `.gstack-backup-1779072805` and
 * `.gstack-backup-20260515135620` — two timestamped directories from one machine,
 * pinned as exact names — while discovery had dropped them. Two copies of one list,
 * silently disagreeing, inside the tool whose entire purpose is detecting exactly
 * that. Declared once here; refs re-exports this binding.
 *
 * Prefix rather than exact also fixes the reason those literals existed at all: a
 * timestamped backup dir has a different name on every machine and on every run, so
 * no list of exact names can ever be complete. `.gstack-backup-<anything>` is skipped
 * everywhere now, which is what the three literals were reaching for.
 */
export const BACKUP_DIR_PREFIXES = Object.freeze([".gstack-backup", ".gstack.bak"]);

/** True when a directory name should never be descended into. */
export function isSkippedDir(name) {
  return SKIP_DIR_NAMES.has(name) || BACKUP_DIR_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Directories to descend into from `parent`.
 *
 * SYMLINKS ARE FOLLOWED ONLY WHEN THEY CARRY A MARKER (N29, 2026-08-17).
 *
 * `dirent.isDirectory()` is **false** for a symlink, so before this the walk
 * silently skipped every linked directory. That is correct for the general case
 * — following links by default invites cycles and duplicate workspaces — but it
 * meant an out-of-tree artifact could never be reached at all. propagate's own
 * skill directory is the worked example: it lives at `~/.claude/skills/propagate`,
 * outside SEARCH_ROOTS, and the only path to it is the `propagate-skill` symlink
 * in the hub. Five edges declared there moved the expanded edge count 711 -> 711.
 * The skill that exists to catch undeclared couplings could not declare its own.
 *
 * The marker is the opt-in. A link without a `.propagates.yml` is skipped exactly
 * as before, so this changes nothing for the ~dozen incidental symlinks in the
 * tree; a link that declares one is asking to be walked.
 *
 * Cycle safety is the CALLER's, not this function's — `walk()` holds the
 * realpath-keyed `seen` set, because a cycle is a property of the traversal and
 * not of any single directory listing. Same split `lib/journal.mjs` uses.
 */
function listDirs(parent) {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || isSkippedDir(e.name)) continue;
    const p = path.join(parent, e.name);

    if (e.isDirectory()) {
      out.push(p);
      continue;
    }
    if (!e.isSymbolicLink()) continue;

    // Resolve, confirm it is a directory, and require the marker. Any failure
    // (dangling link, permission, not a directory) means "not walkable" — never
    // a throw, since discovery must degrade rather than die.
    try {
      if (!statSync(p).isDirectory()) continue;
      if (!existsSync(path.join(p, MARKER))) continue;
      out.push(p);
    } catch {
      /* dangling or unreadable link — skip, same as before */
    }
  }
  return out;
}

/**
 * Classify a `.propagates.yml` marker's `workspace` field into one of three
 * outcomes, never throwing:
 *   - flagged true            -> { isWorkspace: true,  suspicious: null }
 *   - absent or explicit false -> { isWorkspace: false, suspicious: null }
 *   - PRESENT BUT MALFORMED   -> { isWorkspace: false, suspicious: {path, reason} }
 *     (unparseable YAML, or `workspace` present with a non-boolean value,
 *     e.g. a typo'd `workspace: "true"` string or `workspace: yes` parsed
 *     as a plain scalar rather than a boolean)
 *
 * Deliberately does NOT coerce a truthy-looking non-boolean to `true` —
 * that would silently promote a typo'd marker instead of surfacing it.
 * Strict boolean semantics are kept for promotion; the malformed case is
 * routed into `suspicious` so `discoverWorkspacesSync` can report it instead
 * of dropping it on the floor.
 *
 * Sync + dependency-light on purpose: it CANNOT import lib/frontmatter.mjs,
 * which has a top-level await on the ajv schema compile — importing it here
 * would deadlock module load (config.mjs calls discoverWorkspacesSync at
 * module-load time, synchronously).
 */
export function classifyMarker(markerPath) {
  let parsed;
  try {
    parsed = parseYaml(readFileSync(markerPath, "utf8"));
  } catch (err) {
    return {
      isWorkspace: false,
      suspicious: { path: markerPath, reason: `unparseable YAML: ${err.message}` },
    };
  }
  const value = parsed?.workspace;
  if (value === true) return { isWorkspace: true, suspicious: null };
  if (value === undefined || value === false) return { isWorkspace: false, suspicious: null };
  return {
    isWorkspace: false,
    suspicious: {
      path: markerPath,
      reason: `workspace key present but not a strict boolean (got ${JSON.stringify(value)})`,
    },
  };
}

/**
 * Returns true iff the given `.propagates.yml` parses and has `workspace: true`
 * at its top level. Must never throw — a bad marker (malformed YAML, unreadable
 * file, non-object body) is treated as "not a workspace", never bubbled up.
 * Thin wrapper over `classifyMarker` kept for callers that only care about
 * the boolean (e.g. cli.mjs's unreachable-marker sweep).
 */
export function isWorkspaceMarker(markerPath) {
  return classifyMarker(markerPath).isWorkspace;
}

/**
 * The scaffolded `ledger.md` body.
 *
 * REWRITTEN 2026-08-25 (v3 Phase D, N42). This used to be "byte-for-byte what
 * `renderMarkdown` produces for a JSONL with zero rows", so that the first real
 * render would be a no-op overwrite. `renderMarkdown` was removed in Phase D —
 * the v1 `.md` files are frozen into `propagation/archive/` and nothing renders
 * a live one any more — so that justification is void, and the old body's claim
 * "This file is rendered" became false the moment the renderer left.
 *
 * The file itself STAYS: `init` asserts the ledger pair (N24), and a workspace
 * with a `.jsonl` and no `.md` reads as a half-finished install. It now says
 * what it is — a placeholder nobody regenerates — and points at the readers
 * that actually derive the view.
 */
export const EMPTY_LEDGER_MD = [
  "# Propagation Ledger",
  "",
  "**Last entry: never** — nothing has been recorded yet. Run `/propagate status`.",
  "",
  "Append-only. `/propagate reconcile` derives drift; `/propagate drain` marks rows done.",
  "The JSONL beside this file is authoritative. **This file is NOT regenerated** —",
  "nothing renders it (v3 Phase D removed the renderer). For the live view run",
  "`/propagate status` or `/propagate graph`; frozen v1 history is in `archive/`.",
  "",
  "| ID | Date | Source | Change | Downstream | Status |",
  "|----|------|--------|--------|------------|--------|",
  "| — | — | — | _no drift events yet_ | — | — |",
  "",
  "---",
  "",
].join("\n");

/**
 * Which CLI verbs are allowed to scaffold a missing ledger pair as a side
 * effect of discovery. Deliberately NARROW — "setup", "init" and "bootstrap"
 * are the commands that scaffold a workspace at all; every read-only verb
 * (`check`, `status`, `doctor`, `reconcile`, `drain`, `verify`, ...) must
 * stay pure, because `WORKSPACES` is computed once at config.mjs's
 * MODULE-LOAD time regardless of which command is running — an unscoped
 * side effect there fires on every single invocation, not just the ones
 * that mean to scaffold something.
 *
 * FOUND VIA A REAL TEST FAILURE, not reasoned in advance: an earlier version
 * of this fix created the pair unconditionally, and
 * tests/docs/audit-conversions.test.mjs's G43 case ("a clean tree says
 * nothing about untracked files") started failing — running plain
 * `check --changed` against a freshly-committed fixture silently wrote two
 * untracked ledger files into it, which the G43 detector then (correctly)
 * reported, breaking the test's premise. That is real behavior a stranger
 * would also hit: `propagate check` in an ordinary repo must never write to
 * it. `doctor` is excluded on the same reasoning — the CI/`release --check`
 * gate 4 sequence is `setup -> bootstrap --apply -> doctor`, and "doctor is
 * red before bootstrap has run" is documented as CORRECT (see the CI step's
 * prior comment, SKILL.md step 3); scaffolding from `doctor` itself would
 * quietly launder that signal.
 *
 * Each CLI verb is a separate `node cli.mjs <verb>` process (see
 * lib/core/release.mjs's gate 4 and .github/workflows/test.yml), so
 * `process.argv[2]` reliably names the verb for THIS process — it is not a
 * guess, it is the same value cli.mjs's own dispatch switches on.
 */
const LEDGER_SCAFFOLDING_VERBS = new Set(["setup", "init", "bootstrap"]);

/** Exported for direct testing without spawning a subprocess. */
export function ledgerScaffoldingAllowed(argv = process.argv) {
  return LEDGER_SCAFFOLDING_VERBS.has(argv[2]);
}

/**
 * Create an empty ledger JSONL + MD pair at the given paths, iff NEITHER
 * already exists AND the current process is running one of
 * `LEDGER_SCAFFOLDING_VERBS`. Best-effort and silent otherwise: a permission
 * error or read-only filesystem must not make discovery throw (same
 * contract as the rest of this module — "discovery must never throw"), and
 * doctor's existing `ledger JSONL/MD exists` checks already report the gap
 * to a human if creation didn't happen (either because no scaffolding verb
 * ever ran, or because it ran and failed).
 *
 * Exported for direct testing (N38/G1 — a check that cannot fail is worse
 * than no check; this is the side effect a test must be able to assert on
 * its own, independent of the full discovery walk).
 */
export function ensureLedgerPair(ledgerDir, ledgerJsonl, ledgerMd) {
  if (!ledgerScaffoldingAllowed()) return;
  try {
    mkdirSync(ledgerDir, { recursive: true });
    if (!existsSync(ledgerJsonl)) writeFileSync(ledgerJsonl, "");
    if (!existsSync(ledgerMd)) writeFileSync(ledgerMd, EMPTY_LEDGER_MD);
  } catch {
    /* best-effort; doctor's existence checks surface the gap instead */
  }
}

/**
 * Resolve the ledger location for a workspace root.
 *
 * Pinning rule: if a ledger file ALREADY EXISTS at either candidate path, use
 * that one — never relocate a live ledger just because a `docs/` dir showed up
 * later. Only fall back to the `docs/`-exists heuristic when NEITHER ledger
 * file exists yet (i.e. this is a brand-new workspace).
 *
 * GATE-4 FIX (2026-08-20, docs/ISSUES.md N38-adjacent stranger-install gap):
 * a workspace whose marker just gained `workspace: true` has neither
 * candidate ledger file yet. Nothing else in the install path (`init`
 * scaffolds the sidecar; `bootstrap --apply` writes only the v2 event
 * store) ever created the v1 ledger pair a fresh workspace needs, so
 * `doctor`'s `ledger JSONL/MD exists` checks failed forever on a stranger
 * machine. Creating the pair here, exactly once ("on first use" — the
 * first time this workspace is discovered with no ledger at either
 * candidate path), closes that gap without touching the pinning rule
 * above: the existence checks that decide `docsExistsForLedger` run BEFORE
 * this creation, so a real pre-existing ledger is always pinned first and
 * this is a pure no-op for every already-ledgered workspace.
 *
 * PROPAGATION-FOLDER LAYOUT (docs/DECISIONS.md, "a propagation/ folder in
 * every workspace"): `<root>/propagation/ledger.jsonl` is checked before
 * either older candidate, but ONLY when a ledger FILE already exists there
 * — never on the directory alone existing. Checking on the directory would
 * relocate every docs-pinned workspace the instant an empty `propagation/`
 * folder showed up (e.g. someone starts a `git mv` and hasn't finished),
 * which is exactly what the older pinning rule already forbids for `docs/`.
 * A file at that path is a deliberate, completed move; a bare directory is
 * not. With no `propagation/ledger.jsonl` anywhere, this branch never
 * matches and every workspace resolves exactly as it did before this layout
 * existed — the whole point being that landing this code is inert until
 * something is actually relocated there (see `relocate-ledger`).
 */
function makeWorkspaceRecord(wsRoot) {
  const name = path.basename(wsRoot);
  const docsDir = path.join(wsRoot, "docs");
  const docsExists = existsSync(docsDir);

  const propagationDir = path.join(wsRoot, "propagation");
  const propagationJsonl = path.join(propagationDir, "ledger.jsonl");
  const propagationMd = path.join(propagationDir, "ledger.md");

  const docsJsonl = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
  const legacyJsonl = path.join(wsRoot, ".propagation", "ledger.jsonl");

  let ledgerDir, ledgerJsonl, ledgerMd, ledgerHadNoPriorFile;

  if (existsSync(propagationJsonl)) {
    // Deliberate move already completed — pin here, file existence only.
    ledgerDir = propagationDir;
    ledgerJsonl = propagationJsonl;
    ledgerMd = propagationMd;
    ledgerHadNoPriorFile = false;
  } else if (!existsSync(docsJsonl) && !existsSync(legacyJsonl)) {
    // BRAND-NEW workspace: no ledger at ANY candidate. Pin the CANONICAL
    // layout (docs/REFERENCE.md §"Ledger layout" -- every workspace keeps
    // its propagation items in `<workspace>/propagation/`).
    //
    // Until 2026-08-22 this case fell through to the `docs/`-exists
    // heuristic below and produced a SUPERSEDED layout every time:
    // `docs/PROPAGATION_LEDGER.*` when that directory happened to exist,
    // `.propagation/ledger.*` otherwise. So `init` could not create the
    // canonical layout at all, and a new workspace's home was decided by
    // whether someone had run `mkdir docs` first.
    //
    // That is the cause docs/DECISIONS.md recorded as contained but not
    // removed -- "the location remains an accident of directory layout at
    // first-write time; the guard contains the damage but does not remove
    // the cause" -- and it is where three simultaneous layouts across eight
    // ledgers came from.
    //
    // Safe precisely because it is the no-ledger-anywhere branch: the
    // pinning rule above still wins for `propagation/`, and the heuristic
    // below still wins whenever a live ledger exists at either superseded
    // path. Nothing that has data moves.
    ledgerDir = propagationDir;
    ledgerJsonl = propagationJsonl;
    ledgerMd = propagationMd;
    ledgerHadNoPriorFile = true;
  } else {
    // A live ledger exists at one of the SUPERSEDED paths. Pin it there and
    // never relocate it implicitly -- moving a live ledger is
    // `relocate-ledger`'s job, and a `git mv` alone makes discovery fall
    // through and mint a fresh empty ledger while the real one goes unowned.
    const docsExistsForLedger = existsSync(docsJsonl);

    ledgerHadNoPriorFile = false;

    ledgerDir = docsExistsForLedger ? docsDir : path.join(wsRoot, ".propagation");
    ledgerJsonl = docsExistsForLedger ? docsJsonl : legacyJsonl;
    ledgerMd = docsExistsForLedger
      ? path.join(ledgerDir, "PROPAGATION_LEDGER.md")
      : path.join(ledgerDir, "ledger.md");
  }

  if (ledgerHadNoPriorFile) {
    ensureLedgerPair(ledgerDir, ledgerJsonl, ledgerMd);
  }

  const scanDirs = docsExists ? ["docs", "."] : ["."];

  return {
    name,
    root: wsRoot,
    ledgerJsonl,
    ledgerMd,
    scanDirs,
  };
}

/**
 * All ledger CANDIDATE file paths that currently exist under a workspace
 * root, regardless of which one `makeWorkspaceRecord` pins to. Used by
 * `doctor` to catch a half-finished `propagation/` migration — more than one
 * live candidate means one location is stale and undiscoverable by anything
 * that reads `ws.ledgerJsonl` alone.
 * @param {string} wsRoot
 * @returns {string[]} absolute paths of existing candidate .jsonl files
 */
export function liveLedgerCandidates(wsRoot) {
  const candidates = [
    path.join(wsRoot, "propagation", "ledger.jsonl"),
    path.join(wsRoot, "docs", "PROPAGATION_LEDGER.jsonl"),
    path.join(wsRoot, ".propagation", "ledger.jsonl"),
  ];
  return candidates.filter((p) => existsSync(p));
}

/**
 * Walk searchRoots looking for dirs with `.propagates.yml`.
 * @param {string[]} searchRoots
 * @param {number} maxDepth - depth below each root to search
 * @returns {Array<{name,root,ledgerJsonl,ledgerMd,scanDirs}>}
 */
export function discoverWorkspacesSync(searchRoots, maxDepth = DEFAULT_MAX_DEPTH) {
  const found = [];
  const seen = new Set();
  const suspiciousMarkers = [];
  let markersSeen = 0;

  const walked = new Set();

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    // Cycle guard, keyed on the RESOLVED path: a -> b -> a via symlinks would
    // otherwise be walked twice (and unboundedly, if maxDepth were ever raised).
    // Only the traversal can know this; listDirs sees one directory at a time.
    let real;
    try { real = realpathSync(dir); } catch { real = dir; }
    if (walked.has(real)) return;
    walked.add(real);
    // If this dir has a marker, count it. It's only a workspace when the
    // marker explicitly opts in with `workspace: true`. Either way, we
    // ALWAYS keep descending — a marker is an edge declaration by default,
    // not a ledger boundary, and nested workspaces are real (e.g.
    // PanditPawanKaushik/SSJK-mb under PanditPawanKaushik).
    const markerPath = path.join(dir, MARKER);
    if (existsSync(markerPath)) {
      try {
        const stat = statSync(markerPath);
        if (stat.isFile()) {
          markersSeen += 1;
          const { isWorkspace, suspicious } = classifyMarker(markerPath);
          if (suspicious) suspiciousMarkers.push(suspicious);
          if (isWorkspace && !seen.has(dir)) {
            seen.add(dir);
            try {
              found.push(makeWorkspaceRecord(dir));
            } catch (err) {
              suspiciousMarkers.push({
                path: markerPath,
                reason: `workspace record construction threw: ${err.message}`,
              });
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    // Descend regardless of marker status.
    if (depth === maxDepth) return;
    for (const sub of listDirs(dir)) {
      walk(sub, depth + 1);
    }
  }

  try {
    for (const root of searchRoots) {
      if (existsSync(root)) walk(root, 0);
    }
  } catch {
    /* discovery must never throw */
  }

  const degraded = markersSeen > 0 && found.length === 0;
  return { workspaces: found, markersSeen, degraded, suspiciousMarkers };
}

// ─── moved from cli.mjs 2026-08-25 (#31 T2) — see the git log for why ───

/**
 * Sweep for `.propagates.yml` markers to `maxDepth`, deeper than discovery's
 * default (2), so a workspace marker discovery silently dropped is caught.
 * Skips dot-directories (e.g. `.claude/worktrees/`) at every level.
 */
export async function sweepMarkers(roots, maxDepth) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === ".propagates.yml")) {
      found.push(path.join(dir, ".propagates.yml"));
    }
    if (depth === maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue; // skip dot-directories (worktree copies etc.)
      if (e.name === "node_modules") continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }
  for (const root of roots) {
    if (existsSync(root)) await walk(root, 0);
  }
  return found;
}
