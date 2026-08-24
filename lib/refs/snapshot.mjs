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
    upstream_track: r.upstreamTrack ?? "",
    last_commit_iso: r.lastCommitIso ?? "",
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
export function diffSnapshots(prev, next) {
  const events = [];
  const prevRefs = new Map((prev?.refs ?? []).filter((r) => r.ref).map((r) => [r.ref, r]));
  const nextRefs = new Map((next?.refs ?? []).filter((r) => r.ref).map((r) => [r.ref, r]));

  for (const [ref, r] of nextRefs) {
    if (!prevRefs.has(ref)) {
      events.push({
        type: "created",
        ref,
        project: next.project,
        head: r.head,
        detected_by: "snapshot-diff",
        evidence: `absent in previous snapshot, present at ${r.head}`,
        at: next.generated_at,
      });
    }
  }
  for (const [ref, r] of prevRefs) {
    const now = nextRefs.get(ref);
    if (!now) {
      events.push({
        type: "pruned",
        ref,
        project: prev.project,
        head: r.head,
        detected_by: "snapshot-diff",
        evidence: `present at ${r.head} in previous snapshot, absent now`,
        at: next.generated_at,
      });
      continue;
    }
    // Merge is a TRANSITION, so it is only reportable when both sides are known.
    // unknown -> merged is not a merge event; it is the first time anyone asked.
    if (r.merge_state === "unmerged" && now.merge_state === "merged") {
      events.push({
        type: "merged",
        ref,
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
