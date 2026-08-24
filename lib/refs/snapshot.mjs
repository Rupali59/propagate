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

  // A FIRST RUN IS A BASELINE, NOT A MASS CREATION.
  //
  // `created` asserts a ref came into existence between two observations. With
  // no previous snapshot there IS no earlier observation, so labelling every
  // ref `created` states something untrue: those refs predated us, we merely
  // started looking. Committed on 2026-08-24 and corrected the same day.
  //
  // The shell registry this module replaces got this right, and its wording is
  // adopted rather than reinvented — 7 such events sit in Vipin Kaushik's
  // lifecycle log. rule:discernment-checks §2: "I have no prior data" and
  // "these are new" are different facts.
  //
  // `prev === null` (never looked) is deliberately NOT the same as
  // `prev.refs === []` (looked, saw nothing). A ref appearing after a genuinely
  // empty snapshot IS created, and still reports as such.
  if (prev == null) {
    const refs = (next?.refs ?? []).filter((r) => r.ref);
    return [
      {
        type: "baseline",
        ref: null,
        kind: null,
        ref_count: refs.length,
        project: next?.project ?? null,
        detected_by: "snapshot-diff",
        evidence: "no prior snapshot; ref existence before this moment is unknown",
        at: next?.generated_at ?? null,
      },
    ];
  }
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
      const verdict = classifyPruned(r);
      events.push({
        type: "pruned",
        ref: r.ref,
        kind: r.kind ?? "branch",
        // The work-loss verdict rides on the event, not a separate report: a
        // pruned ref whose consequence lives elsewhere is a fact nobody joins.
        work: verdict.work,
        project: prev.project,
        head: r.head,
        detected_by: "snapshot-diff",
        evidence: `${r.kind ?? "branch"} present at ${r.head} in previous snapshot, absent now — ${verdict.why}`,
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
