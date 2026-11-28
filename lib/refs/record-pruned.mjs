/**
 * record-pruned.mjs — a validated record of a branch an OUTSIDE tool prunes (propagate#448).
 *
 * WHY THIS EXISTS. `lifecycle.jsonl` had one writer, the snapshot diff, which stamps
 * `detected_by: "snapshot-diff"`. A tool that deletes branches (the cleaner) could either leave the
 * deletion unrecorded or append to propagate's file by hand, bypassing the shape this module
 * enforces (`detected_by` and `evidence` on every record, snapshot.mjs diffSnapshots header). It
 * has recorded that it will never write the file itself, so this is the one door.
 *
 * THE ORDER IS THE CONTRACT (cleaner plan C2): snapshot -> record -> delete, and a non-zero exit
 * from record means NO delete. So the record is written while the branch is still there, and the
 * acceptance test is that `--head` equals the snapshot's head for that branch (or, for a branch newer
 * than the snapshot, its LIVE head, `head_source: "live-ref"`, propagate#455): it proves the ref
 * about to go is the ref that was recorded.
 *
 * IF THE DELETE THEN FAILS the branch is still present at the recorded head on the next snapshot.
 * `reconcileOutsidePrunes` turns that into ONE `prune-incomplete` event carrying the record's
 * evidence, and never silently clears the record. If the delete went through, the diff's own
 * `pruned` event for the same branch and head is dropped: the branch is recorded once.
 *
 * DRY RUN BY DEFAULT. Without `apply` nothing is written and no lock directory is created; the
 * tests assert that on the directory's bytes (rule:safety-flag-needs-a-test).
 *
 * EXIT CODES (the CLI maps them): 0 recorded or dry run ok; 1 refused with a REFS_PRUNE_* code;
 * 2 could not run (no/unreadable snapshot or lifecycle, or a snapshot shape we do not know). A
 * missing snapshot is never read as an empty one, because that would turn every branch into
 * UNKNOWN_BRANCH or, worse, accept one.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { acquireLock } from "../core/lock.mjs";
import { LIFECYCLE_SCHEMA, WORKSPACE_SNAPSHOT_SCHEMA, readLifecycle, readSnapshot, refsDir } from "./snapshot.mjs";

/**
 * Who may record a prune from outside. `snapshot-diff` stays internal: it is what the diff writes
 * for itself. To admit another tool, add its name here and to docs/REFERENCE.md in the same commit.
 */
export const ALLOWED_DETECTORS = Object.freeze(["cleaner"]);

export const PRUNE_CODES = Object.freeze({
  HEAD_MISMATCH: "REFS_PRUNE_HEAD_MISMATCH",
  DUPLICATE: "REFS_PRUNE_DUPLICATE",
  DETECTED_BY: "REFS_PRUNE_DETECTED_BY",
  EVIDENCE: "REFS_PRUNE_EVIDENCE",
  AMBIGUOUS: "REFS_PRUNE_AMBIGUOUS",
  LIVE_MISMATCH: "REFS_PRUNE_LIVE_MISMATCH",
  NO_SUCH_BRANCH: "REFS_PRUNE_NO_SUCH_BRANCH",
});

const refuse = (code, reason) => ({ ok: false, exit: 1, code, reason });
const couldNotRun = (reason) => ({ ok: false, exit: 2, code: "REFS_PRUNE_UNREADABLE", reason });

/**
 * Read a branch's live head from a repo (propagate#455). Returns `{head}` (the full sha), `{head:null}`
 * when the branch does not exist (`rev-parse --verify --quiet` exits 1 and prints nothing), or
 * `{error}` for anything else (no repo, git missing): absence and "could not read" stay different.
 */
export function readLiveHead(repoRoot, branch) {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { head: out || null };
  } catch (err) {
    if (err?.status === 1 && !String(err.stderr ?? "").trim()) return { head: null };
    return { error: String(err?.stderr || err?.message || err).trim() };
  }
}

/** Evidence is JSON, and "nothing" is not evidence. Returns `{ok, value}` or `{ok:false, reason}`. */
function parseEvidence(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "--evidence is empty" };
  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `--evidence is not valid JSON (${err?.message ?? err})` };
  }
  const empty =
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
  return empty ? { ok: false, reason: "--evidence parses to an empty value" } : { ok: true, value };
}

const sameKey = (e, project, ref, head) =>
  e?.type === "pruned" && e.ref === ref && e.head === head && (project == null || e.project === project);

/**
 * Pure: decide whether a prune may be recorded. No I/O.
 *
 * @param {object} o
 * @param {object} o.snapshot   a workspace snapshot (schema 2)
 * @param {object} o.lifecycle  the result of `readLifecycle`
 * @param {string} o.branch
 * @param {string} o.head       the sha the caller is about to delete
 * @param {string} o.evidence   JSON text
 * @param {string} o.detectedBy
 * @param {string} [o.project]  only needed when one branch name exists in several projects
 * @param {string} [o.now]
 * @param {(repoRoot:string, branch:string)=>({head:string|null}|{error:string})} [o.readLive]
 *   reads a live ref when the snapshot has never seen the branch; injected so the planner stays pure
 * @returns {{ok:true,event:object}|{ok:false,exit:number,code:string,reason:string}}
 */
export function planRecord({ snapshot, lifecycle, branch, head, evidence, detectedBy, project = null, now = null, readLive = readLiveHead }) {
  if (!ALLOWED_DETECTORS.includes(detectedBy)) {
    return refuse(
      PRUNE_CODES.DETECTED_BY,
      `--detected-by ${JSON.stringify(detectedBy ?? null)} is not allowed; allowed: ${ALLOWED_DETECTORS.join(", ")}`,
    );
  }
  const ev = parseEvidence(evidence);
  if (!ev.ok) return refuse(PRUNE_CODES.EVIDENCE, ev.reason);

  // A duplicate is refused before the snapshot is consulted: after the next snapshot the branch is
  // gone from it, and "already recorded" must not turn into "unknown branch".
  const rows = lifecycle?.current ?? [];
  const dup = rows.find((e) => sameKey(e, project, branch, head));
  if (dup) {
    return refuse(
      PRUNE_CODES.DUPLICATE,
      `${branch} at ${head} is already recorded as pruned (detected_by ${dup.detected_by ?? "unknown"}, at ${dup.at ?? "unknown"})`,
    );
  }

  const projects = snapshot?.projects ?? {};
  const named = Object.entries(projects).filter(([name]) => project == null || name === project);
  const holding = named.filter(([, p]) => p?.refs && Object.hasOwn(p.refs, branch));
  if (holding.length === 0) return planFromLiveRef({ named, project, branch, head, detectedBy, ev, now, readLive });
  const matching = holding.filter(([, p]) => p.refs[branch]?.head === head);
  if (matching.length === 0) {
    const seen = holding.map(([name, p]) => `${name}: ${p.refs[branch]?.head ?? "no head"}`).join("; ");
    return refuse(PRUNE_CODES.HEAD_MISMATCH, `--head ${head} is not the snapshot's head for ${branch} (${seen})`);
  }
  if (matching.length > 1) {
    return refuse(
      PRUNE_CODES.AMBIGUOUS,
      `${branch} at ${head} is in ${matching.length} projects (${matching.map(([n]) => n).join(", ")}); pass --project`,
    );
  }

  const [projectName] = matching[0];
  return {
    ok: true,
    event: {
      type: "pruned",
      project: projectName,
      ref: branch,
      path: null,
      head,
      detected_by: detectedBy,
      evidence: ev.value,
      recorded_before_delete: true,
      head_source: "snapshot",
      at: now ?? new Date().toISOString(),
    },
  };
}

/**
 * The snapshot has never seen the branch (a lane branch made after the last snapshot, propagate#455).
 * Prove the ref about to be deleted by reading it live from the project's repo: accept only when it
 * exists AND its head equals `--head`. The snapshot is not refreshed (that would rewrite
 * snapshot.json, trip migrate-refs' mtime guard and give the file a second writer).
 */
function planFromLiveRef({ named, project, branch, head, detectedBy, ev, now, readLive }) {
  const repos = named.filter(([, p]) => typeof p?.repo_root === "string" && p.repo_root !== "" && !p.error);
  if (repos.length === 0) {
    return couldNotRun(`no project${project ? ` named ${JSON.stringify(project)}` : ""} in the snapshot has a readable repo_root to check ${JSON.stringify(branch)} against`);
  }
  const live = [];
  for (const [name, p] of repos) {
    const r = readLive(p.repo_root, branch);
    if (r.error) return couldNotRun(`could not read ${JSON.stringify(branch)} in ${name}: ${r.error}`);
    if (r.head) live.push([name, r.head]);
  }
  if (live.length === 0) {
    return refuse(
      PRUNE_CODES.NO_SUCH_BRANCH,
      `${JSON.stringify(branch)} is neither in the snapshot nor a live branch${project ? ` of ${project}` : ""}`,
    );
  }
  const matching = live.filter(([, h]) => h === head);
  if (matching.length === 0) {
    const seen = live.map(([name, h]) => `${name}: ${h}`).join("; ");
    return refuse(PRUNE_CODES.LIVE_MISMATCH, `--head ${head} is not the live head for ${branch} (${seen})`);
  }
  if (matching.length > 1) {
    return refuse(
      PRUNE_CODES.AMBIGUOUS,
      `${branch} at ${head} is live in ${matching.length} projects (${matching.map(([n]) => n).join(", ")}); pass --project`,
    );
  }
  return {
    ok: true,
    event: {
      type: "pruned",
      project: matching[0][0],
      ref: branch,
      path: null,
      head,
      detected_by: detectedBy,
      evidence: ev.value,
      recorded_before_delete: true,
      head_source: "live-ref",
      at: now ?? new Date().toISOString(),
    },
  };
}

/**
 * Load what planRecord needs, or say why it cannot. Exit 2 for every unreadable input: absence and
 * "could not read" are named, never treated as empty.
 */
export function loadRecordInputs(workspaceRoot) {
  const dir = refsDir(workspaceRoot);
  const snapPath = path.join(dir, "snapshot.json");
  if (!existsSync(snapPath)) return couldNotRun(`no snapshot at ${snapPath}; run migrate-refs first`);
  const snapshot = readSnapshot(workspaceRoot);
  if (snapshot == null) return couldNotRun(`${snapPath} does not parse`);
  if (snapshot.schema_version !== WORKSPACE_SNAPSHOT_SCHEMA || !snapshot.projects) {
    return couldNotRun(
      `${snapPath} has an unknown shape (schema_version ${snapshot.schema_version ?? "none"}, ` +
        `${snapshot.projects ? "has" : "no"} projects map); convert it with migrate-refs`,
    );
  }
  const lifecycle = readLifecycle(workspaceRoot);
  if (lifecycle.reason === "absent") return couldNotRun(`no lifecycle at ${lifecycle.file}`);
  if (lifecycle.reason === "unreadable") return couldNotRun(`${lifecycle.file} is unreadable`);
  return { ok: true, snapshot, lifecycle };
}

/**
 * Record a prune. Dry run unless `apply`. With `apply` it takes a lock on lifecycle.jsonl, reads it
 * AGAIN under the lock (so two recorders cannot both pass the duplicate check), and appends one
 * stamped line. It appends ONLY: the snapshot is never rewritten, so the concurrent-writer guard in
 * migrate-refs (snapshot mtime) is not tripped by a record.
 */
export async function applyRecord({ workspace, branch, head, evidence, detectedBy, project = null, apply = false, now = null, readLive = readLiveHead }) {
  const inputs = loadRecordInputs(workspace);
  if (!inputs.ok) return inputs;
  const args = { branch, head, evidence, detectedBy, project, now, readLive };
  let plan = planRecord({ snapshot: inputs.snapshot, lifecycle: inputs.lifecycle, ...args });
  if (!plan.ok || !apply) return { ...plan, applied: false, lifecycle: inputs.lifecycle.file };

  const file = inputs.lifecycle.file;
  const release = await acquireLock(file);
  if (!release) return couldNotRun(`${file} is locked by another writer; nothing was written`);
  try {
    const again = loadRecordInputs(workspace);
    if (!again.ok) return again;
    plan = planRecord({ snapshot: again.snapshot, lifecycle: again.lifecycle, ...args });
    if (!plan.ok) return { ...plan, applied: false, lifecycle: file };
    const text = readFileSync(file, "utf8");
    const prefix = text === "" || text.endsWith("\n") ? "" : "\n"; // never glue onto an unterminated last line
    appendFileSync(file, `${prefix}${JSON.stringify({ schema: LIFECYCLE_SCHEMA, ...plan.event })}\n`);
    return { ...plan, applied: true, lifecycle: file };
  } finally {
    await release();
  }
}

/**
 * Pure: reconcile the diff's events against outside prune records. Called by migrate-refs after
 * `diffSnapshots`, which stays pure.
 *
 *   delete went through   a diff `pruned` for a branch+head an outside tool already recorded is
 *                         DROPPED: the branch is recorded once.
 *   delete failed         an outside record whose branch is still present at the same head gets
 *                         ONE `prune-incomplete` (deduped by project, ref and head across runs).
 *   branch re-created     present at a DIFFERENT head: nothing here; the diff's own events say so.
 */
export function reconcileOutsidePrunes(events, lifecycle, nextSnapshot) {
  const rows = lifecycle?.current ?? [];
  const outside = rows.filter((e) => e.type === "pruned" && e.detected_by !== "snapshot-diff");
  const already = new Set(rows.filter((e) => e.type === "prune-incomplete").map((e) => `${e.project}\0${e.ref}\0${e.head}`));
  const recorded = new Set(outside.map((e) => `${e.project}\0${e.ref}\0${e.head}`));

  const kept = events.filter((e) => !(e.type === "pruned" && recorded.has(`${e.project}\0${e.ref}\0${e.head}`)));
  const at = nextSnapshot?.captured_at ?? null;
  const seen = new Set();
  for (const rec of outside) {
    const key = `${rec.project}\0${rec.ref}\0${rec.head}`;
    if (already.has(key) || seen.has(key)) continue;
    if (nextSnapshot?.projects?.[rec.project]?.refs?.[rec.ref]?.head !== rec.head) continue;
    seen.add(key);
    kept.push({
      type: "prune-incomplete",
      project: rec.project,
      ref: rec.ref,
      path: null,
      head: rec.head,
      detected_by: "snapshot-diff",
      evidence: rec.evidence ?? null,
      recorded_by: rec.detected_by,
      recorded_at: rec.at ?? null,
      at,
    });
  }
  return kept;
}

/**
 * `prune-incomplete` records whose branch is STILL present at the recorded head in `snapshot`.
 * Derived, so a delete that lands later closes it without anyone clearing a record.
 */
export function openPruneIncomplete(lifecycle, snapshot) {
  return (lifecycle?.current ?? []).filter(
    (e) => e.type === "prune-incomplete" && snapshot?.projects?.[e.project]?.refs?.[e.ref]?.head === e.head,
  );
}
