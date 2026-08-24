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

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { V3_REQUIRED, conformance } from "../core/v3-layout.mjs";
import { buildSnapshot, writeRegistry } from "../refs/snapshot.mjs";

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
  if (text.split("\n").length > 40) return false;
  return /now lives at|—\s*moved|^#.*\bmoved\b/im.test(text);
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
    for (const loc of ARTIFACT_LOCATIONS) {
      for (const name of PROJECT_ARTIFACTS) {
        const abs = path.join(projectRoot, loc, name);
        if (existsSync(abs)) found.push({ project: e.name, projectRoot, from: abs, artifact: name });
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
export function planMigration(workspaceRoot) {
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
  const conflicts = [];

  for (const a of findProjectArtifacts(wsRoot)) {
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
      // A stub pointing at a destination that does not exist is a broken
      // signpost, not something to relocate. Report it; do not move it.
      conflicts.push({ ...entry, reason: "source is a pointer stub but its destination is missing — dangling stub" });
      continue;
    }
    moves.push(entry);
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
    conflicts,
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
export async function migrateWorkspace({ workspace, apply = false, now = null }) {
  // Resolve ONCE, here, so every downstream renderer gets a real stamp. `now`
  // defaults to null for injectability in tests, and the README/INDEX renderers
  // call .slice(0,10) on it — a null reached them and threw
  // "Cannot read properties of null" from inside --apply, after moves had
  // already run. The CLI passed `now` on one path and not the other, which is
  // exactly the kind of caller-dependent nullness that should be normalised at
  // the boundary rather than defended against at each use.
  now = now ?? new Date().toISOString();
  const plan = planMigration(workspace);

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
  if (plan.conflicts.length > 0) {
    // A conflict is a decision for a person. Proceeding past one means guessing
    // which of two real files wins, and the guess is invisible afterwards.
    throw new Error(
      `migrate: ${plan.workspace} has ${plan.conflicts.length} unresolved conflict(s) — ` +
        plan.conflicts.map((c) => `${c.from}: ${c.reason}`).join("; ") +
        `. Resolve by hand, then re-run. Nothing was written.`,
    );
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
      // AWAIT. buildSnapshot is async; calling it bare made `snapshot` a Promise,
      // and JSON.stringify(Promise) is `{}` — so the file was created, existed,
      // and conformance went GREEN on a snapshot containing nothing. Nothing
      // threw, so the catch below could not see it either.
      const snapshot = await buildSnapshot(plan.workspaceRepo ?? plan.workspace, { now });
      // Presence is easy; content is the thing conformance cannot check. A
      // required file that exists and is empty satisfies V3_REQUIRED while
      // delivering nothing — the exact shape rule:every-project-carries-gotchas
      // names when it says a file can be present, current, and still inert.
      if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.refs)) {
        throw new Error(
          `buildSnapshot returned no refs array (got ${Object.prototype.toString.call(snapshot)}) — ` +
            `refusing to write a snapshot that would satisfy conformance while holding nothing`,
        );
      }
      // WORKSPACE ROOT, not propagationDir: refsDir() appends `propagation/refs`
      // itself. Passing the already-joined path produced
      // `propagation/propagation/refs/` — caught because conformance kept
      // reporting the pair missing rather than greening on the wrong location.
      registry = writeRegistry(plan.workspace, snapshot, [], { apply: true });
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
        for (const m of plan.moves) {
          const rel = path.relative(path.dirname(abs), m.from);
          if (text.includes(rel) || text.includes(path.basename(m.from))) {
            hits.push({ sidecar: abs, names: m.from, suggested: path.relative(path.dirname(abs), m.to) });
          }
        }
      }
    }
  };
  for (const r of searchRoots ?? [plan.workspace]) walk(r, 0);
  return hits;
}
