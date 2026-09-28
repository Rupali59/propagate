/**
 * lib/migrate/workspace.mjs — move a workspace to the v3 propagation layout.
 *
 * WHY THIS EXISTS. `lib/core/v3-layout.mjs` states what a conforming
 * `propagation/` folder contains and has exactly one caller (`doctor`) that only
 * REPORTS. Nothing produced those files, so the conformance ratchet failed on 6
 * of 7 workspaces with no way to satisfy it. This is the producer.
 *
 * IT MIRRORS `relocateLedger`, DELIBERATELY. Same signature shape
 * (`{workspace, apply = false}`), same dry-run-by-default posture, same
 * fingerprint-before-and-after. A second dry-run mechanism with its own
 * conventions is how two things that must agree start disagreeing.
 *
 * ONE ASSERTION IS INVERTED, AND IT MATTERS. `relocateLedger` THROWS if edge
 * identity changes across the move — "a relocation must never do this". This
 * command is the opposite case: moving a file to a new path DOES change its
 * identity, because `toNodeId` is `basename(repoRoot):relpath`
 * (`lib/edges/reconcile.mjs:99`). N40 made that independent of where the repo is
 * MOUNTED, not of the file's path within it.
 *
 * So the fingerprint delta here is expected, and the job is to NAME it rather
 * than assert it away. Measured before building this: 22 edges point at files a
 * migration moves, 8 of them CLEAN. Those 8 verifications become unreachable —
 * their events stay in the append-only store, but nothing resolves them again.
 *
 * The decision was to accept that loss and re-baseline afterwards. The guardrail
 * is that the loss is ENUMERATED first: a migration that silently drops human
 * verifications and reports success is the laundering that cost this tree 11
 * spurious events on two separate occasions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { V3_REQUIRED, conformance } from "../core/v3-layout.mjs";
import { buildWorkspaceSnapshot, writeRegistry, diffSnapshots } from "../refs/snapshot.mjs";
import { classifyMarker } from "../core/discovery.mjs";

/**
 * The artifacts that belong to a project's propagation state.
 *
 * `TODOS.md` and `TODO.md` are both here because the tree uses both spellings —
 * 13 files use the plural. Migrating one and not the other would leave the
 * other stranded at project level, which is the state this whole change removes.
 */
export const PROJECT_ARTIFACTS = Object.freeze([
  "STATE.md",
  "DECISIONS.md",
  "GOTCHAS.md",
  "ISSUES.md",
  "TODO.md",
  "TODOS.md",
]);

/** Where a project artifact may sit today, relative to the project root. */
const ARTIFACT_LOCATIONS = Object.freeze(["", "docs"]);

/**
 * Paths already dirty in a repo BEFORE this command touches it.
 *
 * WRITTEN 2026-09-28 against an instance that had just happened, and the
 * instance is the argument. `migrate --apply` ran against
 * `obsidian-vk-publish` while a live session in that repo had four uncommitted
 * files. `git mv` plus `git add` staged two of ours into its index; it committed
 * forty seconds later, and `aeee151 feat(review): the JSON payload a review pass
 * writes` carries 189 lines of propagation-layout move it has nothing to do with.
 *
 * THIS IS WORSE THAN THE HAZARD IT RHYMES WITH. The refs refresh only WRITES:
 * an unstaged file needs `git add -A` to be swept. A staged one needs only
 * `git commit`. And `git mv` cannot decline to stage, so no amount of care at
 * the write site helps — the check has to be at the front, before anything moves.
 *
 * Reported by the session it happened to, about the mirror-image incident, hours
 * earlier: "one `-A` away from being authored by whoever commits next." It was
 * right about the refresh and more right about this.
 */
function dirtyPaths(repo) {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null; // unreadable — reported as its own outcome, never as "clean"
  }
}

function gitMv(cwd, from, to) {
  execFileSync("git", ["mv", from, to], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function gitRm(cwd, target) {
  execFileSync("git", ["rm", "-q", target], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** The repo root owning `p`, or null. Walks up looking for a `.git` marker. */
export function repoRootOf(p) {
  let dir = path.resolve(p);
  const root = path.parse(dir).root;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

/**
 * Does `dir` own a propagation registry of its own?
 *
 * Two markers, either sufficient: a `propagation/` folder on disk, or
 * `workspace: true` in its sidecar. Checked structurally rather than by name,
 * because the hub's children are workspaces and every other workspace's
 * children are projects — the same shape at two levels, distinguished only by
 * whether the directory claims its own registry.
 */
export function isWorkspaceRoot(dir) {
  if (existsSync(path.join(dir, "propagation"))) return true;
  const sidecar = path.join(dir, ".propagates.yml");
  if (!existsSync(sidecar)) return false;
  try {
    return /^\s*workspace:\s*true\s*$/m.test(readFileSync(sidecar, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Does `dir` LOOK like a workspace that has simply never been migrated?
 *
 * DECLARED vs INFERRED, and they are kept apart deliberately. `isWorkspaceRoot`
 * above is authoritative and acts silently: a directory that says what it is
 * gets believed. This one only ever produces a REFUSAL that asks a human to
 * declare. Merging them would make an inference indistinguishable from a
 * decision, which is the failure this whole guard exists to prevent, one level
 * up.
 *
 * WHY THE MARKERS ARE NOT ENOUGH. Both of `isWorkspaceRoot`'s markers are
 * things a workspace acquires WHEN IT MIGRATES. A workspace that has not begun
 * has neither, so "is a project" and "is a workspace nobody has migrated yet"
 * arrive here as the same input — and the parent then hoists it. Measured on
 * the real hub 2026-08-24: `Tushar/` (4 artifacts, 3 nested repos) and
 * `Tathya/` (1 artifact, 3 nested repos) were both planned for hoisting into
 * `GitHub/propagation/state/`, cross-repo, history left behind.
 *
 * THE SIGNAL IS CONTAINMENT: a directory that CONTAINS git repositories is a
 * workspace, not a project. Checked against all 12 unmarked hub children with
 * zero misclassifications among those carrying artifacts — `curate-docs-skill`
 * and `scripts` contain none and are correctly hub projects, while every
 * directory the hub's repo map calls a workspace contains at least one.
 *
 * NOT a substitute for declaring. `Rishabh/` and `Khushboo/` are doc-only husks
 * with no nested repos at all, so this can never see them; they carry an
 * explicit `workspace: true`. The inference exists to stop the destructive
 * DEFAULT, not to replace declaration.
 */
export function looksLikeUndeclaredWorkspace(dir) {
  if (isWorkspaceRoot(dir)) return false; // declared beats inferred, always
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable is NOT "contains nothing". Returning false here would let an
    // unreadable directory take the destructive default silently, so say no and
    // let the caller's own error handling surface it.
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    if (existsSync(path.join(dir, e.name, ".git"))) return true;
  }
  return false;
}

/**
 * Is this file a pointer stub left behind by an earlier migration?
 *
 * THIS CHECK PREVENTS DATA LOSS, and it was added because the no-op control
 * caught the bug before any write. `Vipin Kaushik` already conforms — its state
 * moved on 2026-08-21 — and it planned **15 moves** anyway, because every
 * migrated project kept a stub at the old path saying "this file now lives at
 * ...". Migrating those stubs would have copied each stub OVER the real file it
 * points at. The whole workspace's state, replaced by signposts to itself.
 *
 * Deliberately conservative: short AND self-describing as moved. A real
 * `STATE.md` that happens to contain the phrase is not short, and a short file
 * that does not say it moved is not treated as a stub.
 */
export function isPointerStub(absPath) {
  let text;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return false; // unreadable is not "stub" — leave it alone and let the move fail loudly
  }
  return isPointerStubText(text);
}

/**
 * The path-free half of `isPointerStub`, so a caller that ALREADY has the text
 * does not re-read the file and — far more important — does not restate the
 * predicate. `lib/report/backlog.mjs` classifies 14 of these stubs and a second
 * copy of this regex is one edit away from being the copy that disagrees.
 *
 * Every comment below belongs to both callers.
 */
export function isPointerStubText(text) {
  if (typeof text !== "string") return false;
  if (text.split("\n").length > 40) return false;
  // FOUR forms, because two were not enough. The first three match a HEADING or
  // a set phrase; the fourth matches a file that simply says what it is.
  //
  // `pointer stub` was added 2026-08-24 after dry-running the real Motherboard,
  // where `docs/DECISIONS.md` (`# DECISIONS — moved`) was correctly a conflict
  // while `STATE.md` (`# Motherboard — State`, body: "This is a pointer stub,
  // not the state") was classified REAL and planned as a MOVE — a 17-line
  // signpost about to be copied on top of the 143-line file it points at. Two
  // stubs, two verdicts, in one migration; the disagreement is what exposed it.
  //
  // The line-count bound above is what keeps this safe to widen: real prose
  // using the phrase in passing is longer than 40 lines, and the test asserts a
  // genuine state file is NOT swept up. A detector that calls everything a stub
  // deletes real state, which is worse than the bug it fixes.
  return /now lives at|—\s*moved|^#.*\bmoved\b|\bpointer stub\b/im.test(text);
}

/**
 * The path a pointer stub DECLARES its content moved to, or null.
 *
 * Reported 2026-09-27 by the session working in `obsidian-vk-publish`, and the
 * point is sharp: `planMigration` only ever asked "does MY computed destination
 * exist?". For a project inside a workspace that keeps state at
 * `<workspace>/propagation/state/<project>/`, the real file is one level UP and
 * outside the repo, so a correct stub was reported `dangling stub` and the
 * migration refused.
 *
 * That is backwards for the layout `rule:state-and-decisions` now makes the
 * DEFAULT — per-repo `STATE.md` is the deviation, the stub IS the intended end
 * state, and creating `propagation/state/workspace/` inside the project repo
 * would reintroduce the split the rule moved to remove.
 *
 * `null` when the stub declares nothing readable, so the caller falls back to
 * the old behaviour instead of inventing a path. "I could not tell" and "it
 * points nowhere" must not collapse into one answer.
 */
export function stubTarget(text) {
  if (typeof text !== "string" || !text) return null;
  const m = /now lives at\s+`([^`]+)`/i.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * Does the stub at `stubPath` point at something that EXISTS?
 *
 * Resolved relative to the STUB, not to the workspace root, because that is
 * what the stub's own text means: `obsidian-vk-publish/STATE.md` says
 * `../propagation/…` and `obsidian-vk-publish/docs/DECISIONS.md` says
 * `../../propagation/…` — the same destination from two different depths.
 *
 * Any failure reads as "does not resolve", never as "resolves": claiming a stub
 * is fine when its target is unreadable would silence a genuinely broken
 * signpost, which is the defect this function exists beside.
 */
export function stubTargetResolves(stubPath) {
  try {
    const rel = stubTarget(readFileSync(stubPath, "utf8"));
    if (!rel) return false;
    return existsSync(path.resolve(path.dirname(stubPath), rel));
  } catch {
    return false;
  }
}

/**
 * Does this root's OWN sidecar declare it a workspace?
 *
 * Reuses `classifyMarker`, which is the same function `discoverWorkspacesSync`
 * uses, rather than re-reading the YAML with a second set of rules. Two
 * components answering "is this a workspace" differently is how they start
 * disagreeing, and this one has to agree with discovery or `migrate` plans a
 * layout for a thing discovery classifies as something else.
 *
 * Strict-boolean semantics come along for free: a typo'd `workspace: "true"`
 * is NOT a workspace here either, for the same reason it is not there.
 */
function declaresWorkspace(root) {
  const marker = path.join(root, ".propagates.yml");
  if (!existsSync(marker)) return false;
  return classifyMarker(marker).isWorkspace;
}

/**
 * Is this outward target the PARENT WORKSPACE's slot for this very repo?
 *
 * ADDED 2026-09-27, on Rupali's decision relayed through the session working in
 * that tree: the state does NOT move, `workspace: true` stands, and the upward
 * consolidation is the intended end state rather than drift.
 *
 * Without this, `stubPlacement` was about to report a CORRECT layout as a
 * conflict forever — and `lib/report/doctor/workspaces.mjs:340-343` already
 * records why that is its own defect: a permanently-red check trains people to
 * ignore it. Naming a real shape is worth nothing if the name is wrong here.
 *
 * `Vipin Kaushik` consolidated on purpose and `rule:state-and-decisions` carries
 * the reason: seven projects, seven git repos, six branches, and every check
 * that read per-repo state needed bespoke cross-repo, cross-branch machinery.
 * Consolidating collapsed that to one repo, one branch, one read. Moving 148 KB
 * back out would undo exactly that and strand this state on a feature branch.
 *
 * DERIVED, NOT DECLARED, and that is the choice worth defending. The peer
 * offered a sidecar opt-out as the fallback; a key would have to be added to
 * every consolidating workspace, and the ones that forgot would read as faults
 * — G70, a curated inclusion list silently fails to grow. This asks the disk
 * instead: the target is the parent's slot for THIS basename, and the parent
 * itself declares `workspace: true`. Any other outward target is still a
 * misplacement, which is what keeps the check meaningful.
 */
function consolidatesUpward(wsRoot, target) {
  const parent = path.dirname(path.resolve(wsRoot));
  if (!declaresWorkspace(parent)) return false;
  const slot = path.join(parent, "propagation", "state", path.basename(path.resolve(wsRoot)));
  return path.resolve(target).startsWith(slot + path.sep) || path.resolve(target) === slot;
}

/**
 * Where a resolving stub POINTS, relative to the root being migrated.
 *
 * ADDED 2026-09-27, and it is the missing half of `stubTargetResolves`.
 *
 * That predicate asks "does the declared target exist?" and nothing else, so it
 * cannot tell these two apart:
 *
 *   a PROJECT whose stub points out to `<workspace>/propagation/state/<name>/`
 *     -> correct, and the default layout under `rule:state-and-decisions`
 *   a WORKSPACE whose stub points out to its PARENT's project slot
 *     -> misplaced: a workspace's own pair belongs at
 *        `<itself>/propagation/state/workspace/`
 *
 * Both resolve. Only one is migrated. Reporting the second as "already
 * migrated, nothing to move" is a reader that answered a narrower question than
 * the one asked and answered it reassuringly — `rule:discernment-checks` §6.
 *
 * Measured on the pair that found this: `Vipin Kaushik/obsidian-vk-publish`
 * declares `workspace: true` (its own `.propagates.yml`), is discovered as a
 * workspace, and keeps its own `propagation/refs/` — while 133 KB of STATE,
 * DECISIONS and GOTCHAS sit in `Vipin Kaushik/propagation/state/obsidian-vk-publish/`,
 * the PROJECT slot, behind stubs whose own text says "propagation/ owns state
 * and decisions for every project in this workspace". The stubs encode the
 * project reading; the marker declares the workspace one. `migrate` called it
 * done.
 *
 * Returns "inside" | "outside" | "dangling" | "not-a-stub". Four words rather
 * than a boolean, because the caller's decision differs for each and collapsing
 * any two of them is how this defect got in.
 */
export function stubPlacement(stubPath, root) {
  let rel;
  try {
    rel = stubTarget(readFileSync(stubPath, "utf8"));
  } catch {
    return "not-a-stub";
  }
  if (!rel) return "not-a-stub";
  const target = path.resolve(path.dirname(stubPath), rel);
  if (!existsSync(target)) return "dangling";
  const base = path.resolve(root) + path.sep;
  return target.startsWith(base) ? "inside" : "outside";
}

/**
 * Every propagation artifact currently sitting at project level.
 *
 * Deliberately does NOT look inside an existing `propagation/` folder: those
 * files are already home, and re-listing them would make a second run of the
 * command look like it still had work to do.
 */
export function findProjectArtifacts(workspaceRoot) {
  const found = [];

  // The WORKSPACE's own artifacts, at `<ws>/` and `<ws>/docs/`. These belong to
  // `state/workspace/`, not to a project.
  //
  // `docs/` is NOT a project, and treating it as one is a real bug this caught:
  // `Vipin Kaushik/docs/DECISIONS.md` was routed to `state/docs/DECISIONS.md`
  // and then flagged as a dangling stub, when its actual home is
  // `state/workspace/DECISIONS.md` and it is already there. A directory-shaped
  // thing is not automatically a project.
  for (const loc of ARTIFACT_LOCATIONS) {
    for (const name of PROJECT_ARTIFACTS) {
      const abs = path.join(workspaceRoot, loc, name);
      if (existsSync(abs)) {
        found.push({ project: "workspace", projectRoot: workspaceRoot, from: abs, artifact: name });
      }
    }
  }

  let entries = [];
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // `docs` excluded here because it was already swept above as workspace-level.
    if (e.name.startsWith(".") || e.name === "propagation" || e.name === "node_modules" || e.name === "docs") {
      continue;
    }
    const projectRoot = path.join(workspaceRoot, e.name);

    // A NESTED WORKSPACE IS NOT A PROJECT, and this is the most destructive
    // thing this module could get wrong. The hub's subdirectories ARE the
    // workspaces: without this guard, migrating the hub planned to move
    // `Keerti/STATE.md` into `GitHub/propagation/state/Keerti/` — hoisting six
    // workspaces' state into the hub and emptying the folders that own it.
    //
    // A workspace announces itself by owning a `propagation/` folder or by
    // declaring `workspace: true`. Either marker means its artifacts belong to
    // ITS registry, and the parent must not reach in.
    if (isWorkspaceRoot(projectRoot)) continue;
    // TAGGED, not dropped. An undeclared workspace's artifacts still have to
    // reach the plan, or the dry run cannot show the operator what is at stake
    // and "not a workspace" renders identically to "skipped as ambiguous".
    // planMigration routes them away from `moves`; it does not lose them.
    const undeclared = looksLikeUndeclaredWorkspace(projectRoot);
    for (const loc of ARTIFACT_LOCATIONS) {
      for (const name of PROJECT_ARTIFACTS) {
        const abs = path.join(projectRoot, loc, name);
        if (existsSync(abs)) found.push({ project: e.name, projectRoot, from: abs, artifact: name, undeclared });
      }
    }
  }
  return found;
}

/**
 * Plan the migration. Pure: reads the tree, writes nothing, decides nothing
 * that `apply` could later do differently.
 *
 * `state/<project>/` is created ONLY where a real artifact exists to move.
 * Scaffolding an empty STATE.md into every subdirectory would make `doctor`
 * report a conforming tree in which every new file is a lie — and one workspace
 * (`Rupali/Obsidian`) has zero artifacts, so it conforms with `state/workspace/`
 * alone. Never invent content.
 */
/**
 * @param {string} workspaceRoot
 * @param {{includeUndeclared?: boolean}} [opts] `includeUndeclared` routes
 *   undeclared-workspace artifacts back into `moves` — what `--force` means.
 *   Passed as an INPUT rather than decided here, so the function stays pure:
 *   same inputs, same plan. Without it `--force` skipped the refusal and then
 *   moved nothing, because the artifacts had already been routed out of
 *   `moves` — a flag that clears an alarm and does not do the thing.
 */
export function planMigration(workspaceRoot, { includeUndeclared = false } = {}) {
  const wsRoot = path.resolve(workspaceRoot);
  const wsRepo = repoRootOf(wsRoot);
  const propagationDir = path.join(wsRoot, "propagation");
  const stateDir = path.join(propagationDir, "state");

  // THREE outcomes per artifact, never two. Collapsing "already migrated" into
  // "move it" is what would have destroyed Vipin Kaushik's state; collapsing
  // "conflict" into either is how a real divergence gets silently resolved by
  // whichever file happened to be written last.
  const moves = [];
  const alreadyMigrated = [];
  const notes = [];
  const conflicts = [];
  // A FOURTH outcome, and it is not a conflict. A conflict is two real files
  // where one must win; this is one real file whose OWNER is in doubt. They
  // need different words because they need different fixes — a conflict is
  // resolved by hand-merging, this by declaring `workspace: true`.
  const undeclaredWorkspaces = [];

  for (const a of findProjectArtifacts(wsRoot)) {
    if (a.undeclared && !includeUndeclared) {
      undeclaredWorkspaces.push({
        ...a,
        reason:
          `${a.project}/ contains git repositories, so it is a workspace rather than a project — ` +
          `moving its ${a.artifact} into this registry would hoist a workspace's state into its parent`,
      });
      continue;
    }
    const to = path.join(stateDir, a.project, a.artifact);
    const fromRepo = repoRootOf(a.from);
    // `git mv` cannot cross a repo boundary. When the artifact lives in its own
    // project repo and the destination is the workspace repo, history does NOT
    // follow — which is why `.sidecar.yml` carries pre_move coordinates.
    const crossRepo = Boolean(fromRepo && wsRepo && path.resolve(fromRepo) !== path.resolve(wsRepo));
    const entry = { ...a, to, crossRepo, fromRepo };

    if (existsSync(to)) {
      // The destination is occupied. Whether that is fine depends entirely on
      // what the SOURCE is, so read it rather than assuming.
      if (isPointerStub(a.from)) {
        alreadyMigrated.push({ ...entry, reason: "source is a pointer stub; destination already holds the real file" });
      } else {
        conflicts.push({
          ...entry,
          reason: "destination exists and the source is NOT a stub — two real files, resolve by hand",
        });
      }
      continue;
    }
    if (isPointerStub(a.from)) {
      // ASK THE STUB WHERE IT POINTS before calling it broken. The check above
      // only knows MY destination; a stub in a project repo routinely points
      // OUT of it, to `<workspace>/propagation/state/<project>/`, which is the
      // layout `rule:state-and-decisions` now makes the default.
      const placement = stubPlacement(a.from, wsRoot);
      const declared = stubTarget(readFileSync(a.from, "utf8"));

      // A stub pointing OUT of a root that declares itself a workspace is the
      // project layout applied to a workspace. It resolves, so the old check
      // called it done; it is the one case where "it resolves" and "it is in
      // the right place" disagree.
      //
      // CONFLICT, not a move. The real file is large, live, and in a DIFFERENT
      // repo — relocating it silently would be this command deciding a question
      // about someone else's tree. Naming it is the job; moving it is a person's
      // call. `rule:discernment-checks` §2: say which fact this is.
      const outwardTarget = declared
        ? path.resolve(path.dirname(a.from), declared)
        : null;

      // The consolidating case, checked BEFORE the conflict: an outward stub
      // aimed at the parent workspace's own slot for this repo is the layout,
      // not a fault. This is the row that keeps `migrate` from being red on a
      // correct tree forever.
      if (
        placement === "outside" &&
        declaresWorkspace(wsRoot) &&
        outwardTarget &&
        consolidatesUpward(wsRoot, outwardTarget)
      ) {
        alreadyMigrated.push({
          ...entry,
          reason:
            `pointer stub -> ${declared}, which is the PARENT workspace's slot for this repo. ` +
            `Consolidated upward deliberately (rule:state-and-decisions — one repo, one branch, ` +
            `one read); nothing to move`,
        });
        continue;
      }

      if (placement === "outside" && declaresWorkspace(wsRoot)) {
        conflicts.push({
          ...entry,
          reason:
            `source is a pointer stub pointing OUT of this repo (${declared}), but ` +
            `.propagates.yml declares this a workspace — a workspace's own state belongs at ` +
            `propagation/state/workspace/, not in a parent's project slot. Resolve the ` +
            `classification before migrating: the stub says project, the marker says workspace`,
        });
        continue;
      }
      if (placement === "inside" || placement === "outside") {
        alreadyMigrated.push({
          ...entry,
          reason: `source is a pointer stub and its declared target resolves (${declared}) — already migrated, nothing to move`,
        });
        continue;
      }
      // A stub pointing at a destination that does not exist is a broken
      // signpost, not something to relocate. Report it; do not move it.
      conflicts.push({ ...entry, reason: "source is a pointer stub but its destination is missing — dangling stub" });
      continue;
    }
    moves.push(entry);
  }

  // COLLISIONS WITHIN THE PLAN ITSELF. Every check above asks
  // `existsSync(to)` against the PRE-migration tree, so two sources that
  // compute the same destination both look free and both land in `moves`.
  // ARTIFACT_LOCATIONS is ["", "docs"], so `<project>/STATE.md` and
  // `<project>/docs/STATE.md` are exactly that pair.
  //
  // Measured 2026-08-23 before this guard: --apply moved the first, `git mv`
  // refused the second with "destination exists", and the command exited 1
  // having ALREADY mutated the tree — a half-migrated workspace, which is the
  // precise state the precondition block exists to prevent. It could not
  // prevent it because the hazard is not visible in any single artifact.
  //
  // Two real files claiming one destination is a decision for a person, the
  // same as the "destination exists and the source is not a stub" case above.
  // Every stub case has already been routed away, so anything still in `moves`
  // is a real file.
  const byDestination = new Map();
  for (const m of moves) {
    if (!byDestination.has(m.to)) byDestination.set(m.to, []);
    byDestination.get(m.to).push(m);
  }
  const survivingMoves = [];
  for (const [to, group] of byDestination) {
    if (group.length === 1) {
      survivingMoves.push(group[0]);
      continue;
    }
    for (const m of group) {
      conflicts.push({
        ...m,
        reason:
          `${group.length} sources claim one destination (${path.relative(wsRoot, to)}): ` +
          group.map((g) => path.relative(wsRoot, g.from)).join(", ") +
          ` — pick which is canonical, then re-run`,
      });
    }
  }
  moves.length = 0;
  moves.push(...survivingMoves);

  // STATE PARKED IN A PARENT'S PROJECT SLOT, WITH OR WITHOUT A SIGNPOST.
  //
  // ADDED 2026-09-27, minutes after `stubPlacement`, and it is the same defect
  // one step further out. That check is STUB-DRIVEN: it can only see misplaced
  // state that left a pointer behind. Measured on the pair that found it —
  // `Vipin Kaushik/obsidian-vk-publish`, a declared workspace:
  //
  //   STATE.md          stub present -> conflict, correctly
  //   docs/DECISIONS.md stub present -> conflict, correctly
  //   GOTCHAS.md        NO STUB      -> zero rows, and 49 KB is the largest of
  //                                    the three. Acting on that plan moves two
  //                                    files and silently leaves the biggest.
  //
  // Nobody wrote a GOTCHAS.md stub, so nothing referred to the real file, so the
  // plan was SILENT about it — and silence here is indistinguishable from "no
  // such artifact exists". `rule:discernment-checks` §2: absence must be
  // attributable. It is also G70, derive rather than curate — a signpost is a
  // curated inclusion list, and this derives the population from what is on disk
  // in the slot instead.
  //
  // Only for a DECLARED workspace. For a project, state in the parent's slot is
  // exactly where it belongs and reporting it would fire on every project in the
  // tree.
  if (declaresWorkspace(wsRoot)) {
    const parentSlot = path.join(path.dirname(wsRoot), "propagation", "state", path.basename(wsRoot));
    const seenElsewhere = new Set(
      [...conflicts, ...alreadyMigrated, ...moves].map((x) => path.basename(x.from ?? "")),
    );
    for (const name of PROJECT_ARTIFACTS) {
      const parked = path.join(parentSlot, name);
      if (!existsSync(parked)) continue;
      if (seenElsewhere.has(name)) continue; // already reported via its stub
      let bytes = null;
      try { bytes = statSync(parked).size; } catch { /* report it without a size */ }
      const size = bytes === null ? "" : `, ${bytes} bytes`;

      // Under a deliberate upward consolidation the file is where it belongs, so
      // this is NOT a conflict. It is still worth a row: the two artifacts that
      // left stubs are findable from inside this repo and this one is not, so a
      // reader standing here has no way to discover it. That missing signpost is
      // the finding, and it is the reason the plan must not stay silent.
      if (consolidatesUpward(wsRoot, parked)) {
        notes.push({
          from: parked,
          reason:
            `consolidated upward into the parent workspace's slot${size} — correct, but NO stub in ` +
            `this repo points at it, while STATE/DECISIONS have one. Nobody reading this repo can ` +
            `find it. Add a pointer stub, or this artifact is discoverable only by knowing where to look`,
        });
        continue;
      }

      conflicts.push({
        from: parked,
        to: path.join(stateDir, "workspace", name),
        reason:
          `real file sits in the PARENT's project slot (${parentSlot}) with NO stub in this repo ` +
          `pointing at it${size}, and .propagates.yml declares this a ` +
          `workspace — so nothing here referred to it and the plan was silent about it. A workspace's ` +
          `own state belongs at propagation/state/workspace/. Resolve the classification, then move it ` +
          `deliberately: it is in a different repo`,
      });
    }
  }

  // Always present, so `state/` holds at least one project dir and conformance's
  // hasProjectDir() is satisfied even for a workspace with nothing to move.
  const creates = [path.join(stateDir, "workspace")];
  for (const item of V3_REQUIRED) {
    const abs = path.join(propagationDir, item);
    if (!existsSync(abs)) creates.push(abs);
  }

  return {
    workspace: wsRoot,
    workspaceRepo: wsRepo,
    propagationDir,
    creates,
    moves,
    alreadyMigrated,
    notes,
    conflicts,
    undeclaredWorkspaces,
    projects: [...new Set(moves.map((m) => m.project))].sort(),
    conformanceBefore: conformance(wsRoot),
  };
}

/**
 * Execute a plan. **Dry-run by default** — `apply: true` is the only thing that
 * writes, and the returned shape is identical either way so the preview cannot
 * drift from the write.
 *
 * @param {{workspace: string, apply?: boolean, now?: string}} opts
 */
export async function migrateWorkspace({ workspace, apply = false, force = false, allowDirty = false, now = null }) {
  // Resolve ONCE, here, so every downstream renderer gets a real stamp. `now`
  // defaults to null for injectability in tests, and the README/INDEX renderers
  // call .slice(0,10) on it — a null reached them and threw
  // "Cannot read properties of null" from inside --apply, after moves had
  // already run. The CLI passed `now` on one path and not the other, which is
  // exactly the kind of caller-dependent nullness that should be normalised at
  // the boundary rather than defended against at each use.
  now = now ?? new Date().toISOString();
  const plan = planMigration(workspace, { includeUndeclared: force });

  if (!apply) {
    return { ...plan, applied: false };
  }

  // PRECONDITIONS FIRST, before a single write. `git mv` throws on a directory
  // that is not a repo, and it would throw on move N of M — leaving some
  // artifacts relocated and the rest at project level. A half-migrated workspace
  // is precisely "the state that loses data": neither location is authoritative
  // and no reader can tell which is.
  //
  // Same discipline as relocateLedger, which validates the ledger resolves
  // before it moves anything.
  if (plan.moves.length > 0 && !plan.workspaceRepo) {
    throw new Error(
      `migrate: ${plan.workspace} is not inside a git repository, and ${plan.moves.length} artifact(s) need moving. ` +
        `git mv would fail partway and leave a half-migrated workspace. Nothing was written.`,
    );
  }
  // REFUSED ON APPLY, not in the planner. `planMigration` is pure by contract —
  // it decides nothing apply could later decide differently — and a planner that
  // threw would make the dry run unable to SHOW this, which is the opposite of
  // what it is for. Same placement as the two refusals below.
  if (!force && plan.undeclaredWorkspaces.length > 0) {
    const names = [...new Set(plan.undeclaredWorkspaces.map((u) => u.project))];
    throw new Error(
      `migrate: ${plan.workspace} contains ${names.length} undeclared workspace(s) — ` +
        names.join(", ") +
        `. Each contains git repositories, so its state belongs to ITS OWN registry, not this one. ` +
        `Migrating would hoist it cross-repo and leave its history behind. Nothing was written. ` +
        `Fix by adding \`workspace: true\` to each one's .propagates.yml, or pass --force to hoist them deliberately.`,
    );
  }

  // N49 — UNTRACKED SOURCES, refused before the first `git mv`.
  //
  // `git mv` requires a tracked file. On Tushar (2026-08-24) the run died on the
  // third artifact with two already moved and the scaffold unwritten — the
  // half-migrated state the conformance message calls "the state that loses
  // data". Nothing was lost, and the defect was the ORDER, not the failure.
  //
  // EVERY offender, not the first. Unlike the two refusals around it this is
  // per-file, so stopping early turns one re-run into N, each finding the next.
  //
  // Not a conflict, and deliberately not reported as one: a conflict is two real
  // files where one must win, this is one real file the repo has never been told
  // about, and the fix is `git add`. The message says so.
  if (plan.workspaceRepo && plan.moves.length > 0) {
    const untracked = [];
    for (const m of plan.moves) {
      const repo = m.fromRepo ?? plan.workspaceRepo;
      try {
        execFileSync("git", ["ls-files", "--error-unmatch", path.relative(repo, m.from)], {
          cwd: repo,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        untracked.push(path.relative(plan.workspace, m.from));
      }
    }
    if (untracked.length > 0) {
      throw new Error(
        `migrate: ${untracked.length} artifact(s) are UNTRACKED, and \`git mv\` cannot move them — ` +
          untracked.join(", ") +
          `. Nothing was written. This is not a conflict: the repo has simply never been told about ` +
          `these files. Run \`git add\` on each, then re-run.`,
      );
    }
  }

  if (plan.conflicts.length > 0) {
    // A conflict is a decision for a person. Proceeding past one means guessing
    // which of two real files wins, and the guess is invisible afterwards.
    throw new Error(
      `migrate: ${plan.workspace} has ${plan.conflicts.length} unresolved conflict(s) — ` +
        plan.conflicts.map((c) => `${c.from}: ${c.reason}`).join("; ") +
        `. Resolve by hand, then re-run. Nothing was written.`,
    );
  }

  // PRE-FLIGHT: REFUSE on a dirty target tree, before anything is written.
  //
  // REFUSE rather than warn, and the asymmetry with the refs refresh is
  // deliberate. That warns because it is a scheduled job whose silence recreates
  // N55 — the component that stopped running while nothing said so. This is a
  // one-shot operation a person just invoked and is watching, so stopping costs
  // them one command and cannot cost anyone their authorship.
  //
  // `--force` exists because a tree is legitimately dirty sometimes and the
  // operator may know the changes are theirs. It has to be typed.
  // `allowDirty`, NOT `force`. `--force` already means "hoist a directory that
  // looks like an undeclared workspace", and overloading it would mean an
  // operator hoisting a subdirectory silently also bypassed a guard against
  // taking someone else's authorship. That is one flag serving two situations —
  // the exact defect this file spent 2026-09-27 removing in four other places,
  // and it would be a poor day to reintroduce it here.
  if (!allowDirty) {
    const dirty = dirtyPaths(plan.workspaceRepo ?? plan.workspace);
    if (dirty === null) {
      throw new Error(
        `migrate: could not read git status in ${plan.workspaceRepo ?? plan.workspace}, so it is ` +
          `unknown whether someone else has uncommitted work there. Nothing was written. ` +
          `\`git mv\` STAGES, so a commit by anyone else would adopt this migration. Re-run with ` +
          `--force if you know the tree is yours.`,
      );
    }
    if (dirty.length > 0) {
      throw new Error(
        `migrate: ${plan.workspaceRepo ?? plan.workspace} has ${dirty.length} uncommitted change(s), ` +
          `and this command STAGES what it moves — so the next \`git commit\` by anyone working in ` +
          `that repo adopts this migration into their commit. Measured 2026-09-28: it did, and 189 ` +
          `lines of layout move landed in an unrelated feature commit forty seconds later. ` +
          `Commit or stash first, then re-run. Nothing was written.\n  ` +
          dirty.slice(0, 10).join("\n  ") +
          (dirty.length > 10 ? `\n  … and ${dirty.length - 10} more` : "") +
          `\n  Pass --allow-dirty to proceed anyway.`,
      );
    }
  }

  mkdirSync(path.join(plan.propagationDir, "state", "workspace"), { recursive: true });

  const moved = [];
  for (const m of plan.moves) {
    mkdirSync(path.dirname(m.to), { recursive: true });
    if (m.crossRepo) {
      // Copy then remove: two repos, so this is an add here and a delete there.
      // History stays behind; pre_move in .sidecar.yml is what makes it findable.
      copyFileSync(m.from, m.to);
      try {
        gitRm(m.fromRepo, path.relative(m.fromRepo, m.from));
      } catch {
        // Untracked file: copying was the whole job. Not an error, and not a
        // silent skip either — it lands in the result as `removed: false`.
        moved.push({ ...m, removed: false });
        continue;
      }
      moved.push({ ...m, removed: true });
    } else {
      gitMv(plan.workspaceRepo ?? plan.workspace, m.from, m.to);
      moved.push({ ...m, removed: true });
    }
  }

  // THE STUBS, written after every move has landed so a stub never points at a
  // file that failed to arrive. `removed: false` means the source was untracked
  // and the copy WAS the move — there is nothing left behind to stub over, and
  // writing one would overwrite the original.
  const stubFacts = plan.workspaceRepo ? gitFacts(plan.workspaceRepo) : { sha: null };
  for (const m of moved) {
    if (m.removed !== true) continue;
    const sourceRepo = m.fromRepo ?? plan.workspaceRepo ?? plan.workspace;
    const facts = m.crossRepo && m.fromRepo ? gitFacts(m.fromRepo) : stubFacts;
    writeFileSync(
      m.from,
      renderPointerStub({
        artifact: m.artifact,
        toRel: path.relative(sourceRepo, m.to),
        fromRel: path.relative(sourceRepo, m.from),
        workspaceName: path.basename(plan.workspace),
        sha: facts?.sha ?? null,
      }),
    );
    // Tracked, or the stub is invisible to a clone — which is the whole point.
    try {
      execFileSync("git", ["add", path.relative(sourceRepo, m.from)], { cwd: sourceRepo, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // An untrackable path (ignored, or not a repo) still gets the file on
      // disk. Named in the result rather than silently assumed staged.
      m.stubStaged = false;
    }
  }

  // One sidecar per project that actually received files. Written AFTER the
  // moves so `owns` describes what is there, not what was hoped for.
  const sidecars = [];
  const byProject = new Map();
  for (const m of moved) {
    if (!byProject.has(m.project)) byProject.set(m.project, []);
    byProject.get(m.project).push(m);
  }
  for (const [project, ms] of byProject) {
    const dir = path.join(plan.propagationDir, "state", project);
    const target = path.join(dir, ".sidecar.yml");
    // Never clobber a hand-written sidecar. An existing one may carry `ready`,
    // `note`, or a pre_move from an earlier migration that this run cannot
    // reconstruct.
    if (existsSync(target)) {
      sidecars.push({ path: target, written: false, reason: "already exists — left untouched" });
      continue;
    }
    writeFileSync(target, renderSidecar({ project, projectRoot: ms[0].projectRoot, moves: ms, now }));
    sidecars.push({ path: target, written: true });
  }

  // MATERIALISE plan.creates. Until 2026-08-23 this loop did not exist: the dry
  // run printed "create" for README.md, INDEX.md, refs/snapshot.json and
  // refs/lifecycle.jsonl, and --apply made none of them. So `migrate` could
  // never satisfy the conformance ratchet it was written to satisfy, and the
  // module's own stated invariant — "the preview and the write come from the
  // SAME plan object" — was false for four of the five required items.
  //
  // Root cause was one level down: writeRegistry, the ONLY code that can
  // produce the refs pair, had zero production callers. Correct, tested and
  // unreachable — rule:enforcement-watches-itself §2. This is its caller.
  const created = [];
  for (const abs of plan.creates) {
    if (existsSync(abs)) {
      created.push({ path: abs, written: false, reason: "already exists" });
      continue;
    }
    const rel = path.relative(plan.propagationDir, abs);
    if (rel === "refs/snapshot.json" || rel === "refs/lifecycle.jsonl") continue; // written as a pair below
    if (abs.endsWith(".md")) {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, renderPropagationDoc(path.basename(abs), plan, now));
      created.push({ path: abs, written: true });
    } else {
      mkdirSync(abs, { recursive: true });
      created.push({ path: abs, written: true });
    }
  }

  // The refs pair, together, because writeRegistry owns both paths and the
  // empty-lifecycle case (an empty append-only log is "nothing changed yet",
  // which is a real state and distinct from "never registered").
  let registry = null;
  const needsRefs = plan.creates.some((c) => c.endsWith("refs/snapshot.json") || c.endsWith("refs/lifecycle.jsonl"));
  if (needsRefs) {
    try {
      // buildWorkspaceSnapshot, NOT buildSnapshot. The single-repo primitive
      // describes ONE repo; a workspace is the workspace repo plus N project
      // repos, and `docs/REFERENCE.md:106-110` specifies per-project keys. Using
      // the primitive here wrote a registry covering 2 refs of 36 on Vipin
      // Kaushik — and every test passed, because the fixture had one repo.
      //
      // AWAIT: it is async, and calling it bare made `snapshot` a Promise, which
      // JSON.stringify renders as `{}` — a file that exists, satisfies
      // conformance, and holds nothing.
      const snapshot = await buildWorkspaceSnapshot(plan.workspaceRepo ?? plan.workspace, { now });
      // Presence is easy; content is what conformance cannot check for itself.
      if (!snapshot || typeof snapshot !== "object" || !snapshot.projects) {
        throw new Error(
          `buildWorkspaceSnapshot returned no projects map (got ${Object.prototype.toString.call(snapshot)}) — ` +
            `refusing to write a snapshot that would satisfy conformance while holding nothing`,
        );
      }
      // WORKSPACE ROOT, not propagationDir: refsDir() appends `propagation/refs`
      // itself. Passing the already-joined path produced
      // `propagation/propagation/refs/` — caught because conformance kept
      // reporting the pair missing rather than greening on the wrong location.
      // diffSnapshots(null, …), NOT []. An empty events array creates the
      // append-only log EMPTY, and `migrate-refs` afterwards sees a non-null
      // previous snapshot and correctly emits nothing — so the baseline never
      // lands by either route. Measured on the hub 2026-08-24: 63 refs in the
      // snapshot, 0 bytes in the log.
      //
      // `diffSnapshots` against a null previous yields `baseline` per project,
      // which is the whole point: it records that ref existence BEFORE this
      // moment is unknown, rather than asserting these refs were created now.
      const baseline = diffSnapshots(null, snapshot);
      registry = writeRegistry(plan.workspace, snapshot, baseline, { apply: true });
      created.push({ path: registry.snapshot, written: true });
      created.push({ path: registry.lifecycle, written: true });
    } catch (err) {
      // A workspace root that is not a git repo has no refs to snapshot. That
      // is a REASON, not a silent skip: conformance will still report the pair
      // missing, and this says why rather than leaving the reader to guess.
      registry = { error: err.message };
      created.push({ path: path.join(plan.propagationDir, "refs"), written: false, reason: err.message });
    }
  }

  const after = conformance(plan.workspace);
  return { ...plan, applied: true, moved, sidecars, created, registry, conformanceAfter: after, generated_at: now };
}

/**
 * The two generated markdown files. Deliberately thin: README cites
 * REFERENCE.md rather than restating the layout, because a second description
 * of the tree is one edit away from disagreeing with the canonical one, and
 * INDEX is a roll-up whose numbers are derived on read, never stored.
 */
function renderPropagationDoc(basename, plan, now) {
  const ws = path.basename(plan.workspace);
  if (basename === "README.md") {
    return [
      `# ${ws} — propagation`,
      "",
      `Generated by \`propagate migrate\` on ${now.slice(0, 10)}. Safe to edit by hand.`,
      "",
      "**The layout of this directory is canonical in propagate's",
      "`docs/REFERENCE.md` §\"Propagation layout\" — it is deliberately not restated",
      "here.** A second description of the tree is one edit away from being the copy",
      "that disagrees.",
      "",
      "| Path | Holds |",
      "|---|---|",
      "| `state/workspace/` | this workspace's STATE, DECISIONS, GOTCHAS, TODO |",
      "| `state/<project>/` | the same, per project, plus `.sidecar.yml` |",
      "| `refs/` | branch + worktree registry: `snapshot.json`, `lifecycle.jsonl` |",
      "",
      "`refs/lifecycle.jsonl` is append-only. Never edit past lines; supersede them.",
      "",
    ].join("\n");
  }
  const projects = plan.projects.length ? plan.projects : ["(none yet)"];
  return [
    `# ${ws} — propagation index`,
    "",
    `Generated ${now.slice(0, 10)}. **Counts are NOT recorded here** — a count in a`,
    "state file rots faster than anything else in it (`rule:state-and-decisions`).",
    "Derive them: `propagate status`, `propagate doctor`.",
    "",
    "## Projects with state",
    "",
    ...projects.map((p) => `- \`state/${p}/\``),
    "",
  ].join("\n");
}

/**
 * Which currently-verified edges this migration will orphan.
 *
 * Called BEFORE applying, and its output belongs in the operator's hands rather
 * than a log. `edge_id` is `sha8(node_id, downstream, why)` and `node_id`
 * embeds the path, so a moved file's edge is a different edge afterwards. The
 * old events remain in the append-only store; nothing resolves them again.
 *
 * @param {object[]} rows reconcile rows
 * @param {object} plan   from planMigration
 */
export function orphanedByMigration(rows, plan) {
  const movingFrom = new Set(plan.moves.map((m) => path.resolve(m.from)));
  const touches = (p) => p && movingFrom.has(path.resolve(String(p)));
  const out = [];
  for (const r of rows ?? []) {
    const s = r.source && typeof r.source === "object" ? r.source.path : r.source;
    const d = r.downstream && typeof r.downstream === "object" ? r.downstream.path : r.downstream;
    if (!touches(s) && !touches(d)) continue;
    out.push({
      edge_id: r.edge_id ?? null,
      state: r.state ?? null,
      source: s ?? null,
      downstream: d ?? null,
      // Only a verified edge is a LOSS. NEVER_VERIFIED had nothing to lose, and
      // conflating the two would inflate the number the operator has to weigh.
      losesVerification: r.state === "CLEAN",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// .sidecar.yml — what makes an abandoned history findable
// ---------------------------------------------------------------------------

/** Best-effort git facts about a repo. Never throws; unknowns stay null. */
function gitFacts(repoRoot) {
  const one = (args) => {
    try {
      return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim();
    } catch {
      return null;
    }
  };
  return {
    sha: one(["rev-parse", "--short", "HEAD"]),
    branch: one(["rev-parse", "--abbrev-ref", "HEAD"]),
    remote: one(["remote", "get-url", "origin"]),
  };
}

function yamlList(items) {
  return items.map((i) => `  - ${i}`).join("\n");
}

/**
 * The sidecar for one migrated project.
 *
 * `pre_move` exists for exactly one reason: **git history does not cross a repo
 * boundary.** When a project's `STATE.md` moves from its own repo into the
 * workspace repo, that is an add here and a delete there — `git log --follow`
 * on the new path reaches nothing. These coordinates are the only way back to
 * the commits that produced the file.
 *
 * Written ONLY for cross-repo moves. A same-repo `git mv` carries history
 * natively, and stamping pre_move there would imply a loss that did not happen.
 */
/**
 * The pointer stub left at a moved artifact's OLD path.
 *
 * NOT POLITENESS — the documented contract. `rule:state-and-decisions` states
 * the trade in as many words: "a fresh clone of a project repo gets a pointer
 * stub rather than its state. The stub names the workspace path and the
 * pre-move SHA." The 2026-08-21 manual migration of `Vipin Kaushik` and
 * `Motherboard` left exactly these, which is the only reason `isPointerStub`
 * has anything to recognise.
 *
 * `migrate` wrote the destination `.sidecar.yml` and nothing at the source, so
 * every link, gate and doc naming the old path broke silently. Applying it to
 * ten workspaces on 2026-08-24 surfaced that only because PanditPawanKaushik
 * runs a `check-doc-links` gate, which blocked its own commit with 17 broken
 * relative links — all at paths the migration had just emptied. The other nine
 * had the same breakage and no gate to notice.
 *
 * The wording deliberately contains "pointer stub" so `isPointerStub` matches
 * it on a later pass; a stub this tool cannot re-recognise would be migrated
 * over itself next time.
 *
 * THE "WHY" PARAGRAPH BRANCHES, as of 2026-09-28. It read "propagation/ owns
 * state and decisions for every project in this workspace" for every move, and
 * that sentence is FALSE for a workspace's own artifact going to
 * `state/workspace/` — that file is not a project's state and there is no
 * project it belongs to.
 *
 * The sentence is not a harmless imprecision. The session working in
 * `obsidian-vk-publish` identified this exact wording, in hand-written stubs of
 * the same shape, as the thing that made a deliberate layout look like the
 * PROJECT layout — to them and to me, on the same day, in opposite directions.
 * They rewrote theirs. This generator reproduces it on every future migration,
 * so fixing one repo and not the producer leaves the next reader to be misled
 * the same way. `rule:enforcement-watches-itself`: the fix belongs where the
 * text is authored.
 */
export function renderPointerStub({ artifact, toRel, fromRel, workspaceName, sha = null }) {
  // Derived from the destination rather than passed in, so a caller cannot
  // forget it and get the wrong paragraph silently.
  const ownArtifact = /(^|[/\\])state[/\\]workspace[/\\]/.test(toRel);
  return [
    `# ${artifact} — moved`,
    "",
    `This is a **pointer stub**, not the state. The file now lives at \`${toRel}\``,
    ownArtifact
      ? `in this repo, with \`.sidecar.yml\` beside it.`
      : `in the \`${workspaceName}\` workspace, with \`.sidecar.yml\` beside it.`,
    "",
    ...(ownArtifact
      ? [
          "Why: this is `" + workspaceName + "`'s OWN register, and a workspace keeps its own",
          "state under `propagation/state/workspace/` — beside, not among, the projects it",
          "holds. One location per workspace means the checks that read these files stop",
          "needing to know which repo or branch they are on. See `propagation/README.md`.",
        ]
      : [
          "Why: `propagation/` owns state and decisions for every project in this",
          "workspace, so one read gives the whole picture and the checks that read them",
          "stop needing cross-repo, cross-branch machinery. See `propagation/README.md`.",
        ]),
    "",
    "History before the move is in THIS repo, not the target:",
    "",
    `    git log --follow -- ${fromRel}${sha ? `      # pre-move HEAD: ${sha}` : ""}`,
    "",
    "Do not edit this file. Edit the target.",
    "",
  ].join("\n");
}

export function renderSidecar({ project, projectRoot, moves, now = null }) {
  const crossRepo = moves.filter((m) => m.crossRepo);
  const facts = crossRepo.length ? gitFacts(crossRepo[0].fromRepo) : { sha: null, branch: null, remote: null };
  const owns = [...new Set(moves.map((m) => m.artifact))].sort();

  const lines = [
    "# Which project the files in this directory belong to.",
    `# Written by \`propagate migrate\`${now ? ` on ${now}` : ""}. See ../../README.md.`,
    "schema_version: 1",
    `project: ${project}`,
    `repo_root: ${path.basename(projectRoot)}`,
    `remote: ${facts.remote ?? "null"}`,
    `active_line: ${facts.branch ?? "null"}`,
    "owns:",
    yamlList(owns),
  ];

  if (crossRepo.length) {
    lines.push(
      "# git mv cannot cross a repo boundary, so these files were copied into the",
      "# workspace repo and removed from the project repo. Their history stayed",
      "# behind; this is how to reach it.",
      "pre_move:",
      `  sha: ${facts.sha ?? "null"}`,
      `  branch: ${facts.branch ?? "null"}`,
      `  source: cross-repo`,
      `  history: "git -C ${path.basename(projectRoot)} log --follow -- <old-path>"`,
      "  paths:",
      ...crossRepo.map((m) => `    ${m.artifact}: ${path.relative(m.fromRepo, m.from)}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Declared edges that name a moved path
// ---------------------------------------------------------------------------

/**
 * Which `.propagates.yml` files mention a path this migration moves.
 *
 * REPORTS, does not rewrite. A sidecar key is relative to the sidecar's own
 * directory, and the same basename appears in several of them, so a blind
 * substitution across 29 files is how a working declaration becomes a wrong one
 * silently. `doctor` already names a dead source — "source X does not exist,
 * this edge can never fire" — and that is a better place to catch it than a
 * regex that thought it knew.
 */
export function sidecarsNamingMoves(plan, searchRoots) {
  const hits = [];
  const basenames = new Set(plan.moves.map((m) => path.basename(m.from)));
  if (!basenames.size) return hits;

  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(abs, depth + 1);
      } else if (e.name === ".propagates.yml") {
        let text = "";
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        // RELATIVE PATH ONLY — never the bare basename. A sidecar key is
        // relative to the sidecar's own directory, and `STATE.md` appears in
        // most of them, so the basename arm matched sidecars that had nothing
        // to do with this migration and reported one hit PER MOVE, so a single
        // file repeated (review 2026-08-23, F10).
        //
        // The relative path is the string a correct declaration actually
        // contains, which makes a hit mean something.
        for (const m of plan.moves) {
          const rel = path.relative(path.dirname(abs), m.from);
          if (!text.includes(rel)) continue;
          hits.push({ sidecar: abs, names: m.from, suggested: path.relative(path.dirname(abs), m.to) });
        }
      }
    }
  };
  for (const r of searchRoots ?? [plan.workspace]) walk(r, 0);
  return hits;
}
