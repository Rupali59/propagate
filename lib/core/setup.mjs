/**
 * setup.mjs — the install-time bootstrap.
 *
 * WHY THIS EXISTS. Installing the plugin and running `status` gave: zero
 * workspaces, no error, exit 0, nothing works. `lib/config.mjs` predicted exactly
 * that in prose ("discovery on another machine silently finds zero workspaces and
 * the watcher reports healthy forever, which is precisely the 'abandoned
 * automation reports itself healthy' failure this skill exists to catch") and
 * nothing detected it. This command is the detection, plus the fix it enables.
 *
 * WHY NOT `init` OR `bootstrap`. Both verbs are taken by unrelated commands —
 * `init <dir>` scaffolds a `.propagates.yml`, `bootstrap` baselines edges. Piling
 * "configure the whole install" onto either would make the dangerous reading the
 * plausible one, in a CLI whose own GOTCHAS record a flag that meant different
 * things in adjacent subcommands (G44) costing 11 spurious events.
 *
 * THE CONTRACT, and the only part that really matters:
 *
 *   setup NEVER reports success on an install where discovery finds nothing.
 *
 * A bootstrap that says "ready" over a silent-zero-discovery is that same failure
 * wearing the uniform of the fix. rule:safety-flag-needs-a-test: a command that
 * promises a working install is making a claim about another subsystem, and an
 * unverified claim is worse than no claim, because people act on it.
 *
 * HOW IT VERIFIES — and why it re-reads its own output. The check runs discovery
 * over the roots parsed back OUT of the config file just written, not over the
 * roots held in memory. Those differ exactly when the write is the thing that is
 * broken, which is the case worth catching: verifying the in-memory value would
 * confirm the intent and miss the artifact. `lib/config.mjs` evaluates at module
 * load, so the freshly-written file is NOT in force in this process — reading it
 * back is also the only way to see what the next invocation will see.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { discoverWorkspacesSync, DEFAULT_MAX_DEPTH } from "./discovery.mjs";

const HOME = os.homedir();

/**
 * Layouts probed when `--roots` is absent, in order.
 *
 * `~/Documents/GitHub` is this author's layout and is listed FIRST for continuity
 * on the machine that already runs this, not because it is more canonical than the
 * rest. A probe is a convenience; it never overrides an explicit `--roots`, and a
 * probe that finds nothing must ask rather than guess.
 */
export const PROBE_LAYOUTS = Object.freeze([
  path.join(HOME, "Documents", "GitHub"),
  path.join(HOME, "code"),
  path.join(HOME, "src"),
  path.join(HOME, "dev"),
  path.join(HOME, "projects"),
  path.join(HOME, "repos"),
  path.join(HOME, "git"),
  path.join(HOME, "workspace"),
]);

/** Directories that exist among the probe list. Separate from "has markers". */
export function probeRoots(layouts = PROBE_LAYOUTS) {
  return layouts.filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Split a PATH-style `--roots` value. Absent/blank yields []. */
export function parseRootsArg(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith("~/") ? path.join(HOME, p.slice(2)) : path.resolve(p)));
}

/**
 * Render config.yml.
 *
 * Hand-written by design — a generated file people are expected to edit needs to
 * explain itself, and the comments are the only documentation an operator gets at
 * the moment they open it. `scheduler` is emitted with the resolved platform
 * default rather than omitted, so a Linux install can SEE that nothing is
 * scheduled instead of inferring it from silence.
 */
export function renderConfig({ roots, scheduler, hub = null }) {
  const lines = [
    "# propagate — install configuration.",
    "# Written by `propagate setup`. Safe to edit by hand; re-run setup --force to regenerate.",
    "#",
    "# Precedence is env > this file > built-in default, in that order and no other.",
    "# So PROPAGATE_SEARCH_ROOTS in your shell still wins over what is written here.",
    "",
    "# THE HUB — one declared fact. searchRoots, marketplaceDir and portsFile all",
    "# derive from it, so moving your code is a one-line edit here rather than a",
    "# hunt for four separate restatements of the same path.",
    "#",
    "# Unset means UNSET: hub-derived paths resolve to null and the commands that",
    "# need them refuse and say so. They are never guessed, because a guessed hub",
    "# finds zero workspaces and then reports healthy.",
    ...(hub ? [`hubRoot: ${hub}`] : ["# hubRoot: /path/to/your/code-root"]),
    "",
    "# Roots discovery walks looking for `.propagates.yml` markers.",
    "# Omit this and it defaults to [hubRoot]. Set it only for a split layout.",
    "searchRoots:",
    ...roots.map((r) => `  - ${r}`),
    "",
    "# launchd | systemd | none. `none` is fully supported, not degraded: the v1",
    "# watcher is retired and drift is derived from content on demand in ~1.2s.",
    "# Without a scheduler you lose proactive notification and nothing else.",
    `scheduler: ${scheduler}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Classify what discovery found. Kept separate from printing so the reason is a
 * value the caller can assert on — "absence must be attributable"
 * (rule:discernment-checks §2) is unenforceable when the reason exists only as an
 * English sentence inside a console.log.
 *
 * Three reasons, not two. `markers-rejected` is the case where discovery SAW
 * `.propagates.yml` files and produced no workspace from any of them — a schema or
 * `workspace: true` problem, fixed by editing a sidecar, whereas `no-markers` is
 * fixed by running `init <dir>`. Discovery already computes this as `degraded`;
 * collapsing it into "found nothing" would send the reader to the wrong fix.
 *
 * @returns {{ok: boolean, reason: "ok"|"roots-missing"|"no-markers"|"markers-rejected", missing: string[], present: string[], workspaces: object[], markersSeen: number, depth: number}}
 */
export function verifyDiscovery(roots, maxDepth) {
  // Resolve the sentinel HERE, once, so every consumer reports the same number as
  // the walk actually used. Passing `undefined` through to discovery and printing
  // `undefined` at the operator is two bugs sharing one variable.
  const depth = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : DEFAULT_MAX_DEPTH;
  const present = [];
  const missing = [];
  for (const r of roots) {
    try {
      if (statSync(r).isDirectory()) present.push(r);
      else missing.push(r);
    } catch {
      missing.push(r);
    }
  }
  const base = { missing, present, workspaces: [], markersSeen: 0, depth };
  if (present.length === 0) return { ...base, ok: false, reason: "roots-missing" };

  const found = discoverWorkspacesSync(present, depth);
  const workspaces = found?.workspaces ?? [];
  const markersSeen = found?.markersSeen ?? 0;
  if (workspaces.length === 0) {
    return { ...base, ok: false, reason: markersSeen > 0 ? "markers-rejected" : "no-markers", markersSeen };
  }
  return { ...base, ok: true, reason: "ok", workspaces, markersSeen };
}

/**
 * Artifacts the skill used to write beside its own code, back when STATE_DIR
 * defaulted to `null` and every path fell back to SKILL_DIR.
 *
 * Split by whether anything still reads them. `live` must be MOVED — losing
 * `metrics.jsonl` loses doctor's history and losing `index.db` loses the skills
 * index. `retired` belong to the v1 watcher (retired 2026-08-14, watcher.mjs refuses
 * to run) and are left where they are for a human to archive or delete: this function
 * relocates state, it does not decide what to throw away.
 *
 * Extended 2026-08-20 (plan `status-temporal-plum.md` §"Phase 1 -> 1b", GOTCHAS G12):
 * the original list covered 4 of ~14 real artifacts and, critically, omitted the ONE
 * whose loss is unrecoverable — `events/`, the v2 event store (1347 events at time of
 * writing). Also added: `graph-index.db`, `graph-index.cypher`, `notified.jsonl`.
 * `events` is a DIRECTORY; `migrateLegacyState` below merges it file-by-file rather
 * than renaming the directory wholesale, because the real-world destination
 * (`~/.propagate/events/`) already holds live data the source must never clobber.
 *
 * `cross-allow.yml` is deliberately NOT in `live`. `SKILL_DIR/cross-allow.yml` is not
 * a stray legacy artifact — it is `CROSS_ALLOW_SHIPPED` (lib/core/config.mjs:444), the
 * PERMANENT, version-controlled fallback that `CROSS_ALLOW_PATH` resolves to for every
 * install with no user copy in the state dir. A first pass at this migration put it in
 * `live` and, when run for real, MOVED (deleted) the shipped file out of the repo —
 * every fresh/stranger install with no user copy would then ENOENT on every cross-repo
 * code path (`lib/edges/cross-repo.mjs:70`, `cli.mjs:1315` both read it with no
 * existence guard), invisibly on any machine that already has a user copy shadowing
 * it. See `seedOnly` below for the correct, non-destructive treatment.
 */
export const LEGACY_STATE = Object.freeze({
  live: [
    "metrics.jsonl",
    "index.db",
    "graph-mcp-cache.json",
    "SKILLS_LIFECYCLE.jsonl",
    "events",
    "graph-index.db",
    "graph-index.cypher",
    "notified.jsonl",
  ],
  retired: ["state.json", "state.json.bak", "heartbeat", "watcher.log", "watcher.stderr.log", "watcher.stdout.log"],
  /**
   * Files that must NEVER be removed from `fromDir` (they are permanent shipped
   * defaults a constant elsewhere depends on), but are worth SEEDING into `toDir` —
   * copied, never moved — so a fresh state dir starts with an editable copy instead of
   * silently relying on the shipped one forever. Copy-only, and only when `toDir` has
   * no copy of its own yet: an existing user copy (the common case on this machine,
   * `~/.propagate/cross-allow.yml` since before this migration existed) is never
   * touched, so a real customization can never be clobbered by a reseed.
   */
  seedOnly: ["cross-allow.yml"],
});

/** A backup of the event store taken before a truncation -- see `archiveEventBackups`. */
const PRE_TRUNCATE_RE = /\.jsonl\.pre-truncate-\d{4}-\d{2}-\d{2}$/;

/**
 * Move one file from `src` to `dst`, recording the outcome under `label`.
 *
 * NEVER CLOBBERS. If `dst` already exists, `src` is left in place and `label` is
 * reported as a conflict — two files with one name is a decision a human makes, and
 * silently picking one is how the incident GOTCHAS G12 describes happens.
 *
 * Shared by the per-name loop below (files and directory contents alike) and by
 * `archiveEventBackups`, so the never-clobber / EXDEV-fallback behaviour is defined
 * exactly once.
 *
 * `renameImpl` defaults to the real `renameSync` and exists ONLY so tests can force
 * the EXDEV (cross-device rename) branch deterministically. Node's test-runner mock
 * cannot reliably intercept a builtin `node:fs` named export from here (verified: a
 * mocked `require("node:fs").renameSync` does not intercept this module's imported
 * binding on this Node version) — dependency injection is the alternative that
 * actually exercises the fallback rather than the happy path in disguise.
 */
function relocateFile(src, dst, label, moved, conflicts, renameImpl = renameSync) {
  if (existsSync(dst)) {
    conflicts.push(label);
    return;
  }
  try {
    mkdirSync(path.dirname(dst), { recursive: true });
    renameImpl(src, dst);
    moved.push(label);
  } catch {
    // A cross-device rename fails; copy-then-unlink rather than lose the file.
    try {
      copyFileSync(src, dst);
      unlinkSync(src);
      moved.push(label);
    } catch {
      conflicts.push(label);
    }
  }
}

/** Every regular file under `dir`, recursively, as absolute paths. */
function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) out.push(p);
    }
  }
  return out;
}

/**
 * Relocate stray `*.jsonl.pre-truncate-*` backups sitting loose at `rootDir`'s top
 * level into `rootDir/events/archive/`, where a glob over the root can no longer
 * mistake one for a live event shard.
 *
 * These backups are the ONLY surviving copy of rows whose originals were later
 * truncated away (see `~/.propagate/2026-08.jsonl.pre-truncate-2026-08-17`, 574 KB /
 * 869 lines, ~150 of which have no other copy anywhere). This function only ever
 * RELOCATES — never deletes, never truncates, never overwrites an existing archive
 * entry of the same name.
 *
 * @returns {{moved: string[], conflicts: string[]}}
 */
function archiveEventBackups(rootDir, renameImpl = renameSync) {
  const moved = [];
  const conflicts = [];
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return { moved, conflicts };
  }
  for (const ent of entries) {
    if (!ent.isFile() || !PRE_TRUNCATE_RE.test(ent.name)) continue;
    const src = path.join(rootDir, ent.name);
    const dst = path.join(rootDir, "events", "archive", ent.name);
    const label = path.join("events", "archive", ent.name);
    relocateFile(src, dst, label, moved, conflicts, renameImpl);
  }
  return { moved, conflicts };
}

/**
 * Copy (never move) `LEGACY_STATE.seedOnly` names from `fromDir` into `toDir`, only
 * when `toDir` has no file of that name yet. `fromDir` is left untouched in every
 * case — success, conflict, or copy failure — because these are permanent shipped
 * defaults (`cross-allow.yml` / `CROSS_ALLOW_SHIPPED`), not artifacts that used to
 * live beside the code by accident. See the `seedOnly` doc comment on `LEGACY_STATE`
 * for the incident this exists to not repeat.
 *
 * @returns {{seeded: string[], conflicts: string[]}}
 */
function seedShippedCopies(fromDir, toDir, names = LEGACY_STATE.seedOnly) {
  const seeded = [];
  const conflicts = [];
  for (const name of names) {
    const src = path.join(fromDir, name);
    const dst = path.join(toDir, name);
    if (!existsSync(src)) continue; // nothing to seed from; not this function's problem to report
    if (existsSync(dst)) {
      conflicts.push(name); // an existing user copy — correctly untouched, not an error
      continue;
    }
    try {
      mkdirSync(toDir, { recursive: true });
      copyFileSync(src, dst); // COPY, never rename/unlink -- fromDir must keep its copy
      seeded.push(name);
    } catch {
      conflicts.push(name);
    }
  }
  return { seeded, conflicts };
}

/**
 * Move legacy artifacts from `fromDir` into `toDir`.
 *
 * WHY THIS MUST EXIST BEFORE THE DEFAULT MOVES. GOTCHAS G12 — "a default that moves
 * loses state silently" — was written after `PROPAGATE_STATE_DIR` was added, precisely
 * to stop someone relocating a default and orphaning what was already written. That
 * entry does not forbid the move; it demands the move not lose anything. This is how
 * that is discharged.
 *
 * NEVER CLOBBERS. If the destination already holds a file of that name, the source is
 * left in place and reported as a conflict — two files with one name is a decision a
 * human makes, and silently picking one is how the incident G12 describes happens.
 *
 * DIRECTORY-AWARE. When a named entry (e.g. `events`) is a directory at `src`, its
 * contents are walked recursively and merged into `toDir/<name>/...` file by file,
 * rather than renaming the directory as one unit — the real destination often already
 * exists with live data (`~/.propagate/events/`), and a single directory-level rename
 * would either fail outright or silently shadow what was already there. Each file gets
 * its own never-clobber check, so a colliding shard is a per-file conflict, not a lost
 * directory.
 *
 * Also relocates any `*.jsonl.pre-truncate-*` backup sitting loose at `toDir`'s root
 * into `toDir/events/archive/` (see `archiveEventBackups`) — this runs regardless of
 * whether `events` itself needed migrating, since the backup in the wild today already
 * sits at the destination, not the source.
 *
 * `_renameImpl` (test-only, hence the leading underscore — no production caller
 * should ever pass it) overrides the primitive `relocateFile` calls to attempt the
 * rename with, so tests can force the EXDEV / copy+unlink fallback deterministically.
 * See the comment on `relocateFile` for why mocking the `node:fs` builtin directly
 * does not reliably work here.
 *
 * Also SEEDS (copies, never moves) `LEGACY_STATE.seedOnly` names — see
 * `seedShippedCopies` — into the returned `seeded` array; `fromDir`'s copy of those is
 * never touched.
 *
 * @returns {{moved: string[], conflicts: string[], skipped: string[], seeded: string[]}}
 */
export function migrateLegacyState(fromDir, toDir, { names = LEGACY_STATE.live, _renameImpl = renameSync } = {}) {
  const moved = [];
  const conflicts = [];
  const skipped = [];
  if (path.resolve(fromDir) === path.resolve(toDir)) return { moved, conflicts, skipped, seeded: [] };

  for (const name of names) {
    const src = path.join(fromDir, name);
    const dst = path.join(toDir, name);
    if (!existsSync(src)) {
      skipped.push(name);
      continue;
    }

    let srcIsDir = false;
    try {
      srcIsDir = statSync(src).isDirectory();
    } catch {
      skipped.push(name);
      continue;
    }

    if (srcIsDir) {
      const files = walkFiles(src);
      if (files.length === 0) {
        skipped.push(name);
        continue;
      }
      for (const f of files) {
        const rel = path.relative(src, f);
        relocateFile(f, path.join(dst, rel), path.join(name, rel), moved, conflicts, _renameImpl);
      }
      continue;
    }

    relocateFile(src, dst, name, moved, conflicts, _renameImpl);
  }

  const archived = archiveEventBackups(toDir, _renameImpl);
  moved.push(...archived.moved);
  conflicts.push(...archived.conflicts);

  // Seeding's own "conflicts" (an existing user copy) are the steady state, not an
  // actionable collision — deliberately NOT merged into the top-level `conflicts`
  // array, which callers treat as "needs a human". Only `seeded` is reported.
  const seed = seedShippedCopies(fromDir, toDir);

  return { moved, conflicts, skipped, seeded: seed.seeded };
}

