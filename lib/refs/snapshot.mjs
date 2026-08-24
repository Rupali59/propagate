/**
 * lib/refs/snapshot.mjs — the branch registry: `refs/snapshot.json` and
 * `refs/lifecycle.jsonl`, two of the five items v3 conformance requires.
 *
 * WHAT THIS IS NOT. It is not a port of `branch-registry.sh`. propagate already
 * enumerates refs and worktrees in JS (`lib/edges/refs.mjs`, which reuses
 * `lib/core/worktrees.mjs`'s porcelain parser), so porting shell would put a
 * second implementation of working code in a second language.
 *
 * THE COST, MEASURED RATHER THAN ASSUMED. The v3 plan doc said all four missing
 * registry fields arrive by "widening one format string at zero extra spawns".
 * Checked against git:
 *
 *     %(upstream:track)            ok        <- free, now on the existing spawn
 *     %(committerdate:iso-strict)  ok        <- free, now on the existing spawn
 *     %(merged)                    fatal: unknown field name
 *     %(merge_state)               fatal: unknown field name
 *
 * So `merge_state` costs ONE extra spawn (`git branch --merged <base>`, a
 * filter rather than an atom) and `is_active_line` is not a git fact at all —
 * it comes from config. Two of four were free; the plan's claim was not.
 *
 * SNAPSHOT vs LIFECYCLE — derived vs append-only:
 *
 *     snapshot.json    the CURRENT shape. Rewritten wholesale each run, safe to
 *                      delete and regenerate, carries schema_version.
 *     lifecycle.jsonl  what CHANGED. Append-only, never rewritten. A branch
 *                      that was created and later pruned leaves two records,
 *                      because "it is gone now" and "it never existed" are
 *                      different facts and only the log can tell them apart.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { enumerateRefs, runGit } from "../edges/refs.mjs";

/** Bumped when a field is added or its meaning changes. Readers check it. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Which local branches are merged into `baseRef`.
 *
 * THE ONE EXTRA SPAWN, and it is deliberate rather than accidental: there is no
 * `for-each-ref` atom for merge state, so this cannot ride the enumeration.
 * Charged here, to the caller that wants a registry, and not to
 * `enumerateRefs`, whose other consumer (`lib/edges/bootstrap.mjs`) has no use
 * for it.
 *
 * Returns a Set, plus an `error` the caller must surface — an empty Set from a
 * failed spawn and an empty Set from a repo with nothing merged are different
 * facts (rule:discernment-checks §2), so this never conflates them.
 */
export async function mergedInto(repoRoot, baseRef) {
  try {
    const { stdout } = await runGit(repoRoot, [
      "branch",
      "--merged",
      baseRef,
      "--format=%(refname:short)",
    ]);
    const names = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { merged: new Set(names), error: null };
  } catch (err) {
    return { merged: new Set(), error: String((err && err.message) || err) };
  }
}

/**
 * Build the current registry for one repo.
 *
 * `now` and `activeLine` are injected rather than read here, so a test can pin
 * both and compare snapshots byte-for-byte. A builder that stamps
 * `new Date()` internally cannot be diffed against a fixture.
 *
 * @param {string} repoRoot
 * @param {{project?: string, baseRef?: string, activeLine?: string|null, now?: string}} opts
 */
export async function buildSnapshot(repoRoot, opts = {}) {
  const { project = path.basename(repoRoot), baseRef = null, activeLine = null, now = null } = opts;

  const { refs, error } = await enumerateRefs(repoRoot);
  if (error) {
    // Attributable failure, not an empty registry. A snapshot that renders
    // "0 refs" for a repo git could not be read is the silent-zero this whole
    // codebase keeps paying for.
    return { schema_version: SNAPSHOT_SCHEMA_VERSION, project, repo_root: repoRoot, error, refs: [] };
  }

  // `merge_state` needs a base to be merged INTO. With no base declared there is
  // no answer, and "unknown" is the honest one — never `false`, which would
  // read as "checked, not merged".
  let merged = new Set();
  let mergeError = null;
  if (baseRef) {
    const r = await mergedInto(repoRoot, baseRef);
    merged = r.merged;
    mergeError = r.error;
  }

  const out = refs.map((r) => ({
    ref: r.ref,
    kind: r.kind,
    path: r.path,
    head: r.head,
    is_canonical: r.isCanonical,
    detached: r.detached,
    // `null`, NOT `""`. lib/edges/refs.mjs defines the distinction and it is
    // load-bearing: `""` means ASKED-AND-NONE (a branch with no upstream),
    // absent means NEVER-ASKED. These two fields are branch-only atoms, so a
    // worktree row coerced to `""` asserted that a question was asked which
    // never was — defeating the exact distinction the fields were added for
    // (review 2026-08-23, F8; rule:discernment-checks §2).
    //
    // No schema_version bump, and the reason is NOT the one first written here.
    // That comment claimed the only shipped snapshot "carries refs: 0" — false.
    // It carries 36 refs; the probe that said 0 read a top-level `refs` key that
    // file does not have. The real reason is that the shipped file is a
    // DIFFERENT FORMAT entirely (see assertKnownShape below), so no row of the
    // shape this writer produces exists anywhere yet, and there are zero readers
    // of either field outside this module.
    upstream_track: r.upstreamTrack ?? null,
    last_commit_iso: r.lastCommitIso ?? null,
    // Tri-state on purpose: true / false / null-for-unknown.
    merge_state: !baseRef || mergeError ? null : merged.has(r.ref) ? "merged" : "unmerged",
    // Config-derived, never guessed from git. null means nobody declared one.
    is_active_line: activeLine == null ? null : r.ref === activeLine,
  }));

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    project,
    repo_root: repoRoot,
    base_ref: baseRef,
    active_line: activeLine,
    generated_at: now,
    merge_state_error: mergeError,
    error: null,
    refs: out,
  };
}

/**
 * What changed between two snapshots.
 *
 * `detected_by` and `evidence` are required on every record: a lifecycle entry
 * that says a branch was pruned, without saying how that was concluded, is an
 * assertion nobody can re-check later.
 */
/**
 * Was work lost when this ref went away?
 *
 * PORTED from `Vipin Kaushik/scripts/hygiene/lib/branch-registry.sh:207-225`,
 * which is the only place this logic existed. It is the reason that script was
 * worth keeping, and retiring the script without this would have deleted the
 * one capability that catches real data loss.
 *
 * Read entirely from the PREVIOUS row — the ref is gone, so nothing can be
 * asked of git now. That is also the limit: reflog retains only branches
 * checked out IN THAT WORKTREE, expiring at 90 days, so "pruned between two
 * snapshots" is knowable and "pruned before the first snapshot" is not.
 *
 *   merged / same  -> commits are in the base ref. Safe, whatever upstream says.
 *   otherwise      -> commits are unique to this ref, so they survive only if it
 *                     was pushed AND had nothing unpushed ("ahead").
 *   unmeasured     -> we could not establish either. Absence must be
 *                     attributable (rule:discernment-checks §2), so it is
 *                     UNSAFE, not silently fine.
 *
 * That last line is the one worth not paraphrasing. An unmeasured merge state
 * with no upstream classifies as `lost`, not as `unknown` — the shell chose
 * that deliberately and this port keeps the choice.
 *
 * @returns {{work: string|null, why: string}} `work` is null for worktree rows:
 *   removing a checkout is not a work-loss question, and null is the answer
 *   rather than a gap.
 */
export function classifyPruned(prevRow) {
  if (!prevRow) {
    return { work: "unknown", why: "no previous row for this ref; nothing can be established about its commits" };
  }
  if ((prevRow.kind ?? "branch") === "worktree") {
    return { work: null, why: "worktree removed — a checkout went away, not commits" };
  }

  const merge = prevRow.merge_state ?? null;
  if (merge === "merged" || merge === "same") {
    return { work: "safe", why: `merge_state=${merge} — the commits are in the base ref` };
  }

  const upstream = prevRow.upstream ?? null;
  const track = prevRow.upstream_track ?? "";
  const ahead = /ahead/.test(track);
  const mergeLabel = merge ?? "unmeasured";

  if (upstream === null || ahead) {
    return {
      work: "lost",
      why:
        `pruned while carrying work that exists nowhere else: merge_state=${mergeLabel}` +
        `, upstream=${upstream ?? "NONE"}, track=${track || "(none)"}`,
    };
  }
  return {
    work: "recoverable",
    why: `pruned with ${mergeLabel} commits, but they are pushed to ${upstream} — recoverable`,
  };
}

/**
 * Refuse a snapshot whose shape this module did not write.
 *
 * TWO INCOMPATIBLE FORMATS BOTH CLAIM `schema_version: 1`. This module writes
 * `{ schema_version, project, repo_root, refs: [...] }`. The pre-existing
 * `hygiene/branch-registry` writes `{ captured_at, captured_by, projects: {
 * <name>: { refs: { <branch>: {...} } } }, schema_version: 1 }` — and one is
 * live at `Vipin Kaushik/propagation/refs/snapshot.json` with 36 refs.
 *
 * Measured 2026-08-24: `diffSnapshots(shipped, mine)` returned 4 `created` and
 * ZERO `pruned`, because `prev?.refs ?? []` turned 36 existing refs into "there
 * was nothing here". Those events go to an APPEND-ONLY log, which is precisely
 * the class of damage N27/N44 cost this project twice.
 *
 * So `refs` missing must mean UNREADABLE, never EMPTY (rule:discernment-checks
 * §2). A silent `?? []` is the bug.
 */
function assertKnownShape(snap, label) {
  if (snap == null) return; // a genuinely absent previous snapshot: everything is a baseline
  if (snap.schema_version === WORKSPACE_SNAPSHOT_SCHEMA && snap.projects) return;
  const hint =
    snap.projects && snap.schema_version === 1
      ? `is a v1 snapshot, written by the retired hygiene/branch-registry. Convert it with \`migrate-refs\` before diffing`
      : Array.isArray(snap.refs)
        ? `is a flat single-repo snapshot; this module now writes the per-project shape docs/REFERENCE.md specifies`
        : `declares schema_version ${snap.schema_version} and has no projects map`;
  throw new Error(
    `snapshot: refusing to diff ${label} — it ${hint}. Treating an unrecognised shape as empty ` +
      `would emit spurious lifecycle events into an append-only log.`,
  );
}

export function diffSnapshots(prev, next) {
  assertKnownShape(prev, "the previous snapshot");
  assertKnownShape(next, "the next snapshot");
  const events = [];
  const at = next?.captured_at ?? null;

  const prevProjects = prev?.projects ?? null;
  const nextProjects = next?.projects ?? {};

  // A FIRST RUN IS A BASELINE, NOT A MASS CREATION — per project.
  //
  // `created` asserts a ref came into existence between two observations. With no
  // previous observation of a project there is none, so labelling its refs
  // `created` states something untrue: they predated us, we started looking.
  // The retired shell registry got this right and its wording is adopted rather
  // than reinvented. rule:discernment-checks §2.
  const baselineFor = (name, project) => ({
    type: "baseline",
    project: name,
    ref: null,
    path: null,
    ref_count: Object.keys(project.refs ?? {}).length + (project.detached_worktrees?.length ?? 0),
    detected_by: "snapshot-diff",
    evidence: "no prior snapshot for this project; ref existence before this moment is unknown",
    at,
  });

  for (const [name, project] of Object.entries(nextProjects)) {
    const before = prevProjects?.[name];
    if (!before) {
      events.push(baselineFor(name, project));
      continue;
    }

    const prevRefs = before.refs ?? {};
    const nextRefs = project.refs ?? {};

    for (const [ref, row] of Object.entries(nextRefs)) {
      if (!(ref in prevRefs)) {
        events.push({
          type: "created",
          project: name,
          ref,
          path: null,
          head: row.head,
          detected_by: "snapshot-diff",
          evidence: `absent in previous snapshot, present at ${row.head}`,
          at,
        });
        continue;
      }
      const was = prevRefs[ref];

      // Worktrees are an ATTRIBUTE of a ref, so their add/remove is a diff of that
      // array — which is how the shell detected them, and why the attribute model
      // is the right one. A branch that gains a checkout was not created.
      const before_ = new Set(was.worktrees ?? []);
      const after_ = new Set(row.worktrees ?? []);
      for (const wt of after_) {
        if (!before_.has(wt)) {
          events.push({
            type: "worktree-added",
            project: name, ref, path: wt, head: row.head,
            detected_by: "snapshot-diff",
            evidence: `${ref} gained a checkout at ${wt}`,
            at,
          });
        }
      }
      for (const wt of before_) {
        if (!after_.has(wt)) {
          events.push({
            type: "worktree-removed",
            project: name, ref, path: wt, head: was.head,
            detected_by: "snapshot-diff",
            evidence: `${ref} lost its checkout at ${wt}; the branch remains`,
            at,
          });
        }
      }

      // Merge is a TRANSITION, reportable only when both sides are known.
      // unknown -> merged is not a merge; it is the first time anyone asked.
      const wasMerged = was.merge_state === "merged" || was.merge_state === "same";
      const nowMerged = row.merge_state === "merged" || row.merge_state === "same";
      if (was.merge_state && !wasMerged && nowMerged) {
        events.push({
          type: "merged",
          project: name, ref, path: null, head: row.head,
          detected_by: "snapshot-diff",
          evidence: `merge_state ${was.merge_state} -> ${row.merge_state} against base ${project.base_ref}`,
          at,
        });
      }
    }

    for (const [ref, was] of Object.entries(prevRefs)) {
      if (ref in nextRefs) continue;
      const verdict = classifyPruned({ kind: "branch", ref, ...was });
      events.push({
        type: "pruned",
        project: name, ref, path: null,
        head: was.head,
        // The verdict rides on the event: a pruned ref whose consequence lives in
        // a separate report is a fact nobody joins up.
        work: verdict.work,
        detected_by: "snapshot-diff",
        evidence: `present at ${was.head} in previous snapshot, absent now — ${verdict.why}`,
        at,
      });
    }

    // DETACHED WORKTREES ARE KEYED BY PATH. They have no ref, and the previous
    // implementation filtered rows on `r.ref` being truthy, which made every one
    // of them invisible — including the live one in Motherboard.
    //
    // `null` IS NOT `[]`. A v1 snapshot has no `detached_worktrees` key at all,
    // so it records nothing about them — which is not the same as recording that
    // there were none. Treating a converted v1's absent key as an empty list
    // would report every existing detached worktree as newly ADDED the first
    // time propagate ran. Vipin Kaushik happens to have none, so nothing would
    // have fired there; Motherboard has one, and it would have.
    if (before.detached_worktrees == null) {
      // Not recorded previously: no transition is knowable, so none is claimed.
      continue;
    }
    const prevDet = new Set((before.detached_worktrees ?? []).map((d) => d.path));
    const nextDet = new Map((project.detached_worktrees ?? []).map((d) => [d.path, d]));
    for (const [wtPath, d] of nextDet) {
      if (prevDet.has(wtPath)) continue;
      events.push({
        type: "worktree-added",
        project: name, ref: null, path: wtPath, head: d.head,
        detected_by: "snapshot-diff",
        evidence: `detached worktree appeared at ${wtPath}`,
        at,
      });
    }
    for (const d of before.detached_worktrees ?? []) {
      if (nextDet.has(d.path)) continue;
      events.push({
        type: "worktree-removed",
        project: name, ref: null, path: d.path, head: d.head,
        detected_by: "snapshot-diff",
        evidence: `detached worktree at ${d.path} is gone`,
        at,
      });
    }
  }

  // A project that disappears entirely. Its refs are not individually pruned —
  // we stopped observing the repo, which is a different fact from the branches
  // going away, and conflating them would invent N prunes from one removal.
  for (const name of Object.keys(prevProjects ?? {})) {
    if (name in nextProjects) continue;
    events.push({
      type: "project-gone",
      project: name,
      ref: null,
      path: null,
      ref_count: Object.keys(prevProjects[name].refs ?? {}).length,
      detected_by: "snapshot-diff",
      evidence: "project present in previous snapshot, absent now — its refs were NOT individually checked",
      at,
    });
  }

  return events;
}

/**
 * The workspace snapshot schema. `docs/REFERENCE.md:106-110` specifies the shape —
 * per project a `base_ref`, and per ref its head/merge_state/upstream/
 * upstream_track/last_commit_iso/worktrees/is_active_line — and the retired
 * `hygiene/branch-registry.sh` matched it field for field at version 1.
 *
 * Version 2 is that shape plus `detached_worktrees`, which the spec has no slot
 * for: a detached worktree has no branch, so it cannot be a key in a ref map,
 * and one is live in Motherboard. Declaring the version is also how a reader
 * tells a shell-written v1 file from a propagate-written v2 one, which is what
 * G26 was actually missing.
 */
export const WORKSPACE_SNAPSHOT_SCHEMA = 2;

/** Error text that never renders as "[object Object]". */
function errText(err) {
  return err?.message ?? String(err);
}

/**
 * Every git repo a workspace owns: the workspace repo itself under the key
 * `workspace`, plus each IMMEDIATE child directory whose git toplevel differs.
 *
 * IMMEDIATE CHILDREN ONLY, and symlinks are skipped with a reason. The hub holds
 * `skills-marketplace/propagate -> ../propagate`; following it would register the
 * plugin as a hub project and duplicate its own workspace. Nested scopes multiply
 * every finding (G4), a `.git` inside a `.git` is invisible anyway (G58), and a
 * symlinked child is the one case that looks like a project and is not (G31).
 *
 * `skipped` is returned, never swallowed: a child that is not a repo is a fact
 * about the tree, and absence must be attributable.
 */
function discoverProjectRepos(workspaceRoot) {
  const projects = [];
  const skipped = [];
  let wsRepo = null;
  try {
    wsRepo = execFileSync("git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    wsRepo = null;
  }
  if (wsRepo) projects.push({ name: "workspace", repoRoot: wsRepo });

  let entries = [];
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true });
  } catch (err) {
    return { projects, skipped: [{ name: ".", reason: `cannot read workspace root: ${errText(err)}` }] };
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isSymbolicLink()) {
      skipped.push({ name: e.name, reason: "symlink — not followed; it would duplicate the target's own workspace" });
      continue;
    }
    if (!e.isDirectory()) continue;
    const abs = path.join(workspaceRoot, e.name);
    let top = null;
    try {
      top = execFileSync("git", ["-C", abs, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      skipped.push({ name: e.name, reason: "not a git repository" });
      continue;
    }
    if (!top || (wsRepo && path.resolve(top) === path.resolve(wsRepo))) {
      // A directory INSIDE the workspace repo is not a project with its own refs;
      // it shares the workspace repo's. Reported so "why is X missing" has an answer.
      skipped.push({ name: e.name, reason: "inside the workspace repo — shares its refs" });
      continue;
    }
    projects.push({ name: e.name, repoRoot: top });
  }
  return { projects, skipped };
}

/**
 * Fold one repo's flat rows into the spec's per-ref shape.
 *
 * A worktree is an ATTRIBUTE of a ref, not a peer row — which is the spec's model
 * and the shell's, and it is why the F7 collision cannot arise here at all.
 *
 * CONFLICTS ARE COLLECTED, NEVER OVERWRITTEN. Folding is a dedupe, and N41 is open
 * precisely because a dedupe "keeps whichever sorts first and discards the rest with
 * no report". Git forbids one branch in two worktrees, so a duplicate means the
 * input is stale or corrupt — a finding, not something to last-write-wins away.
 */
function foldRepoRefs(flat, { activeLine = null } = {}) {
  const refs = {};
  const detached = [];
  const conflicts = [];
  for (const r of flat) {
    if (r.kind === "worktree") continue; // attached below, once its branch exists
    if (refs[r.ref]) {
      conflicts.push(`duplicate branch row for ${r.ref}`);
      continue;
    }
    refs[r.ref] = {
      head: r.head,
      merge_state: r.merge_state,
      upstream: r.upstream ?? null,
      upstream_track: r.upstream_track,
      last_commit_iso: r.last_commit_iso,
      is_active_line: activeLine == null ? r.is_active_line : r.ref === activeLine,
      worktrees: [],
    };
  }
  for (const r of flat) {
    if (r.kind !== "worktree") continue;
    if (!r.ref) {
      detached.push({ path: r.path, head: r.head });
      continue;
    }
    const target = refs[r.ref];
    if (!target) {
      // A worktree on a branch the branch-walk did not report. Real (a worktree on
      // a remote-tracking checkout) or corrupt; either way it is not droppable.
      conflicts.push(`worktree ${r.path} is on ${r.ref}, which has no branch row`);
      continue;
    }
    if (target.worktrees.includes(r.path)) continue;
    target.worktrees.push(r.path);
  }
  for (const k of Object.keys(refs)) refs[k].worktrees.sort();
  return { refs, detached_worktrees: detached, conflicts };
}

/**
 * The whole workspace, in the shape `docs/REFERENCE.md` specifies.
 *
 * Reuses `buildSnapshot` per repo rather than reimplementing enumeration — that
 * function stays the single-repo primitive it always was.
 */
export async function buildWorkspaceSnapshot(workspaceRoot, opts = {}) {
  const { now = null, activeLines = {} } = opts;
  const { projects: found, skipped } = discoverProjectRepos(workspaceRoot);
  const projects = {};
  for (const { name, repoRoot } of found) {
    const one = await buildSnapshot(repoRoot, { project: name, activeLine: activeLines[name] ?? null, now });
    if (one.error) {
      // Present WITH its reason. A project that vanishes because git threw reads
      // as "this workspace has no such project", which is a different fact.
      projects[name] = { repo_root: repoRoot, base_ref: null, error: one.error, refs: {}, detached_worktrees: [] };
      continue;
    }
    const folded = foldRepoRefs(one.refs, { activeLine: activeLines[name] ?? null });
    projects[name] = {
      repo_root: repoRoot,
      base_ref: one.base_ref ?? null,
      error: null,
      merge_state_error: one.merge_state_error ?? null,
      refs: folded.refs,
      detached_worktrees: folded.detached_worktrees,
      ...(folded.conflicts.length ? { conflicts: folded.conflicts } : {}),
    };
  }
  return {
    schema_version: WORKSPACE_SNAPSHOT_SCHEMA,
    captured_at: now,
    captured_by: "propagate/refs",
    workspace_root: workspaceRoot,
    projects,
    skipped,
  };
}

/**
 * The event schema this module writes. Bumped to 2 because the log it appends
 * to already holds v1 events from `hygiene/branch-registry` — 21 of them in
 * Vipin Kaushik — and an APPEND-ONLY file cannot be rewritten. Declaring the
 * era on every new line is the only way a reader can tell them apart later.
 */
export const LIFECYCLE_SCHEMA = 2;

/**
 * Read a lifecycle log, saying which era every line belongs to.
 *
 * FOUR OUTCOMES, never conflated:
 *   current  — declares `schema: 2`. Written by this module.
 *   v1       — bare `type: "branch_lifecycle"`. The shell registry's shape:
 *              readable HISTORY, never re-emitted, never counted as current.
 *   refused  — declares nothing recognisable, or does not parse. Named with a
 *              reason; never silently skipped.
 *   total    — every line, so `current + v1 + refused === total` and a dropped
 *              line is arithmetically impossible to hide.
 *
 * THIS IS NOT the "teach the reader both formats" that G26 forbids. That rule
 * is about two live PRODUCERS competing for one artifact. Here there is one
 * producer going forward and one frozen history — the same freeze-v1 pattern
 * already chosen for the ledger. If `current` and a live v1 writer ever coexist,
 * that is the failure, and this reader is what makes it visible.
 */
export function readLifecycle(workspaceRoot) {
  const file = path.join(refsDir(workspaceRoot), "lifecycle.jsonl");
  const out = { current: [], v1: [], refused: [], total: 0, file };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // Absent is a real state, distinct from empty — and distinct again from
    // unreadable. Report it rather than returning a hollow "nothing here".
    return { ...out, reason: existsSync(file) ? "unreadable" : "absent" };
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    out.total++;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      out.refused.push({ line: line.slice(0, 120), reason: "not valid JSON" });
      continue;
    }
    if (row.schema === LIFECYCLE_SCHEMA) out.current.push(row);
    else if (row.type === "branch_lifecycle") out.v1.push(row);
    else {
      out.refused.push({
        line: line.slice(0, 120),
        reason: `declares neither schema ${LIFECYCLE_SCHEMA} nor type "branch_lifecycle"`,
      });
    }
  }
  return out;
}

/** `<workspace>/propagation/refs/` — the canonical home. See REFERENCE.md. */
export function refsDir(workspaceRoot) {
  return path.join(workspaceRoot, "propagation", "refs");
}

export function readSnapshot(workspaceRoot) {
  const p = path.join(refsDir(workspaceRoot), "snapshot.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // unreadable is not "no branches" — callers treat null as unknown
  }
}

/**
 * Persist the registry. **Dry-run by default**, mirroring
 * `relocateLedger({apply=false})` rather than inventing a second posture.
 *
 * Returns what it would do either way, so the caller prints the same thing in
 * both modes and the preview cannot drift from the write.
 */
export function writeRegistry(workspaceRoot, snapshot, lifecycleEvents = [], { apply = false } = {}) {
  const dir = refsDir(workspaceRoot);
  const snapPath = path.join(dir, "snapshot.json");
  const lifePath = path.join(dir, "lifecycle.jsonl");
  const plan = {
    snapshot: snapPath,
    lifecycle: lifePath,
    refs: snapshot?.refs?.length ?? 0,
    appended: lifecycleEvents.length,
    applied: false,
  };
  if (!apply) return plan;

  mkdirSync(dir, { recursive: true });
  writeFileSync(snapPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  if (lifecycleEvents.length) {
    // Stamp at the WRITE, not at construction: this is the single choke point
    // for what reaches the log, so an event built anywhere cannot arrive
    // undeclared and read as v1 history.
    const stamped = lifecycleEvents.map((e) => ({ schema: LIFECYCLE_SCHEMA, ...e }));
    appendFileSync(lifePath, stamped.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } else if (!existsSync(lifePath)) {
    // Conformance requires the file to EXIST. An empty append-only log is a
    // real state ("nothing has changed yet"), distinct from a missing one
    // ("this workspace was never registered").
    writeFileSync(lifePath, "");
  }
  plan.applied = true;
  return plan;
}
