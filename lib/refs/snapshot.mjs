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

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

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
  if (snap == null) return; // a genuinely absent previous snapshot is fine — everything is `created`
  if (Array.isArray(snap.refs)) return;
  const hint = snap.projects
    ? `looks like a hygiene/branch-registry snapshot (nested projects.<name>.refs); this module writes a flat refs[] array`
    : `has no refs array`;
  throw new Error(
    `snapshot: refusing to diff ${label} — ${hint}. ` +
      `Both formats declare schema_version ${snap.schema_version}; treating the missing array as empty would ` +
      `emit spurious lifecycle events into an append-only log.`,
  );
}

export function diffSnapshots(prev, next) {
  assertKnownShape(prev, "the previous snapshot");
  assertKnownShape(next, "the next snapshot");
  const events = [];
  // A ROW'S IDENTITY IS (kind, ref), NEVER ref ALONE. enumerateRefs yields BOTH
  // a `worktree` row and a `branch` row for any checked-out branch, so keying on
  // `ref` made `new Map` silently keep whichever came last. Measured on a fixture
  // repo checked out at `main`: refs was [worktree main, branch feature-x,
  // branch main] — two rows keyed `main`, one of them discarded.
  //
  // The cost was not cosmetic. Adding or removing a WORKTREE for a branch that
  // already existed produced NO lifecycle event, because the surviving branch
  // row made both snapshots look identical. A registry built to record exactly
  // that transition reported "nothing changed" (review 2026-08-23, F7).
  const key = (r) => `${r.kind ?? "branch"}\u0000${r.ref}`;
  const prevRefs = new Map((prev?.refs ?? []).filter((r) => r.ref).map((r) => [key(r), r]));
  const nextRefs = new Map((next?.refs ?? []).filter((r) => r.ref).map((r) => [key(r), r]));

  for (const [k, r] of nextRefs) {
    if (!prevRefs.has(k)) {
      events.push({
        type: "created",
        ref: r.ref,
        // `kind` is on every event because "main appeared" is unactionable when
        // a branch and a worktree can both be called main.
        kind: r.kind ?? "branch",
        project: next.project,
        head: r.head,
        detected_by: "snapshot-diff",
        evidence: `${r.kind ?? "branch"} absent in previous snapshot, present at ${r.head}`,
        at: next.generated_at,
      });
    }
  }
  for (const [k, r] of prevRefs) {
    const now = nextRefs.get(k);
    if (!now) {
      events.push({
        type: "pruned",
        ref: r.ref,
        kind: r.kind ?? "branch",
        project: prev.project,
        head: r.head,
        detected_by: "snapshot-diff",
        evidence: `${r.kind ?? "branch"} present at ${r.head} in previous snapshot, absent now`,
        at: next.generated_at,
      });
      continue;
    }
    // Merge is a TRANSITION, so it is only reportable when both sides are known.
    // unknown -> merged is not a merge event; it is the first time anyone asked.
    if (r.merge_state === "unmerged" && now.merge_state === "merged") {
      events.push({
        type: "merged",
        ref: r.ref,
        kind: r.kind ?? "branch",
        project: next.project,
        head: now.head,
        detected_by: "snapshot-diff",
        evidence: `merge_state unmerged -> merged against base ${next.base_ref}`,
        at: next.generated_at,
      });
    }
  }
  return events;
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
    appendFileSync(lifePath, lifecycleEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } else if (!existsSync(lifePath)) {
    // Conformance requires the file to EXIST. An empty append-only log is a
    // real state ("nothing has changed yet"), distinct from a missing one
    // ("this workspace was never registered").
    writeFileSync(lifePath, "");
  }
  plan.applied = true;
  return plan;
}
