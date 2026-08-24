/**
 * migrate-refs.mjs — adopt a v1 branch registry without an inconsistent window.
 *
 * THE ORDER IS THE DESIGN:
 *
 *     read v1 -> convert IN MEMORY -> diff vs fresh -> append events -> THEN write
 *
 * Never build -> write -> diff. The previous snapshot is the ONLY record of the
 * prior state; overwriting it before diffing loses every change since the last
 * capture. Measured on Vipin Kaushik 2026-08-24: 12 branches were pruned in the
 * seven hours after the last shell capture, and a build-then-write would have
 * discarded all twelve unclassified. Reconstructible or not, a gap nobody can
 * explain later is not an acceptable outcome of a setup step.
 *
 * DRY-RUN BY DEFAULT, mirroring `relocateLedger` and `migrate` rather than
 * inventing a third preview mechanism. Without `apply`, nothing is written and
 * the tree is byte-identical afterwards — asserted on the tree, not on this
 * function's return value.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildWorkspaceSnapshot, diffSnapshots, refsDir, WORKSPACE_SNAPSHOT_SCHEMA, LIFECYCLE_SCHEMA } from "./snapshot.mjs";

/**
 * A v1 snapshot in the v2 shape, WITHOUT inventing anything.
 *
 * v1 carries only `base_ref` and `refs` per project. The additions are the keys
 * v2 requires, each set to the honest value:
 *
 *   repo_root           null — v1 never recorded it
 *   error               null — v1 only ever wrote projects it could read
 *   detached_worktrees  NULL, NOT []. v1 has no such key, so it recorded
 *                       NOTHING about them, which is a different fact from
 *                       recording that there were none. `diffSnapshots` treats
 *                       null as "no transition knowable" — without this, the
 *                       first run would report every pre-existing detached
 *                       worktree as newly ADDED. Vipin Kaushik has none and
 *                       would not have exposed it; Motherboard has one.
 */
export function convertV1(v1) {
  const projects = {};
  for (const [name, p] of Object.entries(v1?.projects ?? {})) {
    projects[name] = {
      repo_root: p.repo_root ?? null,
      base_ref: p.base_ref ?? null,
      error: null,
      refs: p.refs ?? {},
      detached_worktrees: null,
    };
  }
  return {
    schema_version: WORKSPACE_SNAPSHOT_SCHEMA,
    captured_at: v1?.captured_at ?? null,
    captured_by: v1?.captured_by ?? "unknown",
    converted_from_schema: v1?.schema_version ?? null,
    projects,
    skipped: [],
  };
}

/**
 * @param {object} o
 * @param {string} o.workspace
 * @param {boolean} [o.apply]  false (default) previews; true writes.
 * @param {string}  [o.now]    capture timestamp for the fresh snapshot.
 * @param {Function} [o._afterRead] test seam: runs between read and write, so
 *   the concurrent-writer guard below can be exercised. Never used in prod.
 */
export async function migrateRefs({ workspace, apply = false, now = null, _afterRead = null }) {
  const dir = refsDir(workspace);
  const snapPath = path.join(dir, "snapshot.json");
  const logPath = path.join(dir, "lifecycle.jsonl");
  const stamp = now ?? new Date().toISOString();

  // 1. READ. Absence is a named state — six of the seven workspaces have no
  //    snapshot at all, and that is a first run, not a failure.
  let previous = "absent";
  let raw = null;
  let mtimeAtRead = null;
  if (existsSync(snapPath)) {
    try {
      raw = JSON.parse(readFileSync(snapPath, "utf8"));
      mtimeAtRead = statSync(snapPath).mtimeMs;
      previous = raw?.schema_version === WORKSPACE_SNAPSHOT_SCHEMA ? "v2" : `v${raw?.schema_version ?? "?"}`;
    } catch (err) {
      // Refuse rather than treat an unreadable file as absent: "there was
      // nothing here" and "I could not read what was here" are different facts,
      // and only one of them makes a baseline correct.
      throw new Error(
        `migrate-refs: ${snapPath} exists but does not parse (${err?.message ?? err}) — ` +
          `refusing to diff against it or overwrite it.`,
      );
    }
  }

  // 2. CONVERT IN MEMORY. Nothing is written yet.
  const prev = raw == null ? null : raw.schema_version === WORKSPACE_SNAPSHOT_SCHEMA ? raw : convertV1(raw);

  // 3. BUILD FRESH from live git plus the declared active lines.
  const next = await buildWorkspaceSnapshot(workspace, { now: stamp });

  // 4. DIFF. This is what turns the gap since the last capture into events.
  const events = diffSnapshots(prev, next);

  const plan = {
    workspace,
    snapshot: snapPath,
    lifecycle: logPath,
    previous,
    projects: Object.keys(next.projects).length,
    refs: Object.values(next.projects).reduce((n, p) => n + Object.keys(p.refs ?? {}).length, 0),
    events,
    applied: false,
  };
  if (!apply) return plan;

  if (_afterRead) await _afterRead();

  // 5. ABORT IF ANOTHER WRITER MOVED IT. Unregistering `branch-registry` from
  //    collect.sh stops FUTURE runs; one already in flight still writes. Same
  //    before/after discipline relocateLedger uses for its own dry run, pointed
  //    at a concurrent writer instead.
  if (mtimeAtRead != null && existsSync(snapPath)) {
    const nowMtime = statSync(snapPath).mtimeMs;
    if (nowMtime !== mtimeAtRead) {
      throw new Error(
        `migrate-refs: ${snapPath} changed while this run was preparing ` +
          `(mtime ${mtimeAtRead} -> ${nowMtime}) — another writer is active. ` +
          `Nothing was written. Quiesce it, then re-run.`,
      );
    }
  }

  // 5b. REWRITTEN ONLY ON CHANGE. branch-registry.sh's own header describes the
  //     snapshot as "the one remembered file; rewritten only on change", and it
  //     is right: this file is git-tracked, so rewriting it to bump `captured_at`
  //     alone produces a diff on every run — noise that trains people to ignore
  //     the file's history. Compare the SUBSTANCE (projects), not the timestamp.
  const sameContent =
    prev != null &&
    events.length === 0 &&
    JSON.stringify(prev.projects) === JSON.stringify(next.projects);
  if (sameContent) {
    plan.applied = true;
    plan.unchanged = true;
    return plan;
  }

  // 6. APPEND FIRST, then write. If the write fails, the events still describe
  //    a transition that genuinely happened; if the order were reversed and the
  //    append failed, the new snapshot would erase the evidence for events that
  //    were never recorded.
  mkdirSync(dir, { recursive: true });
  if (events.length) {
    const stamped = events.map((e) => ({ schema: LIFECYCLE_SCHEMA, ...e }));
    appendFileSync(logPath, stamped.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } else if (!existsSync(logPath)) {
    writeFileSync(logPath, "");
  }
  writeFileSync(snapPath, `${JSON.stringify(next, null, 2)}\n`);

  plan.applied = true;
  return plan;
}
