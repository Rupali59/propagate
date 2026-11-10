/**
 * fingerprint.mjs — "did the tree change since doctor last answered?" (#239)
 *
 * WHY. The monitor ran the full doctor every 1800 s (48x a day, ~67 s each) over a tree whose
 * inputs change only when someone commits or edits a tracked file. That is the background-watcher
 * shape `rule:delegation-criteria` §2 warns about. The monitor now asks this module first and runs
 * doctor only when the answer is "changed", "too old", or "cannot tell".
 *
 * THE FINGERPRINT is DERIVED (`rule:derive-dont-curate`): for each repo the caller passes (the
 * monitor passes the repos behind every workspace discovery finds), the HEAD sha plus a digest of
 * `git status --porcelain`; plus the mtimes of the hub config and the health-exceptions file.
 * Every repo read goes through `readOnlyGitEnv()` (#102) so fingerprinting never takes index.lock.
 *
 * THE FLOOR. 0 repos fingerprinted is "cannot fingerprint", never an empty digest that matches the
 * last empty digest. A repo that IS a repo but whose git call fails also makes the whole thing
 * "cannot fingerprint": a fingerprint that silently omits a repo would skip doctor on a change in it.
 * Both mean doctor RUNS (`rule:discernment-checks` §2).
 *
 * STORAGE. A sibling file beside the snapshot (`<snapshot>.fingerprint.json`), never a field in the
 * snapshot: `writeSnapshot` replaces the snapshot wholesale on every run, and old readers (banner,
 * UI, digest) keep reading it unchanged. An old install with no sibling file reads as
 * "no fingerprint" -> run once, which writes the sibling.
 *
 * Pure of module-level I/O.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

import { readOnlyGitEnv } from "../../core/git-env.mjs";

export const DEFAULT_CEILING_MS = 24 * 60 * 60 * 1000;

/** @param {string} snapshotFile */
export function fingerprintPath(snapshotFile) {
  return `${snapshotFile}.fingerprint.json`;
}

function git(repo, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile("git", ["-C", repo, ...args], { env: readOnlyGitEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) err.stderr = stderr;
      // Say WHY: "Command failed" alone hid the 2026-11-10 08:18 cause (46 repos at once under load, most likely the
      // timeout). killed+signal means the timeout fired; otherwise the exit code and git's own first stderr line.
      const why = !err ? null : err.killed ? `timed out after ${timeoutMs} ms (${err.signal ?? "killed"})` : `exit ${err.code ?? "?"}: ${String(err.stderr ?? err.message ?? err).split("\n").find(Boolean) ?? ""}`;
      resolve(err ? { ok: false, error: why } : { ok: true, out: stdout });
    });
  });
}

function mtimeOf(file) {
  if (!file) return "unset";
  try { return String(statSync(file).mtimeMs); } catch { return "absent"; }
}

/**
 * @param {{repos: string[], extraFiles?: string[], gitTimeoutMs?: number, concurrency?: number}} opts
 * @returns {Promise<{ok: true, fingerprint: string, repos: number} | {ok: false, reason: string}>}
 */
export async function computeFingerprint({ repos, extraFiles = [], gitTimeoutMs = 30_000, concurrency = 8 }) {
  const real = [...new Set(repos)].filter((r) => existsSync(path.join(r, ".git")));
  if (real.length === 0) {
    return { ok: false, reason: `cannot fingerprint: 0 repos fingerprinted (${repos.length} candidate(s), none with a .git)` };
  }
  const parts = new Array(real.length);
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < real.length) {
      const i = next++;
      const repo = real[i];
      const head = await git(repo, ["rev-parse", "HEAD"], gitTimeoutMs);
      const st = await git(repo, ["status", "--porcelain"], gitTimeoutMs);
      if (!head.ok || !st.ok) {
        failures.push(`${repo}: ${(!head.ok ? head : st).error}`);
        continue;
      }
      parts[i] = `${repo}\0${head.out.trim()}\0${createHash("sha256").update(st.out).digest("hex")}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, real.length) }, worker));
  if (failures.length) {
    return { ok: false, reason: `cannot fingerprint: git failed in ${failures.length} repo(s), first: ${failures[0]}` };
  }
  const h = createHash("sha256");
  for (const p of parts.slice().sort()) h.update(p + "\n");
  for (const f of extraFiles) h.update(`${f}\0${mtimeOf(f)}\n`);
  return { ok: true, fingerprint: h.digest("hex"), repos: real.length };
}

/** @returns {Promise<{fingerprint?: string, snapshotGeneratedAt?: string|null, confirmedAt?: string}|null>} */
export async function readFingerprint(snapshotFile) {
  try {
    const j = JSON.parse(await readFile(fingerprintPath(snapshotFile), "utf8"));
    return j && typeof j.fingerprint === "string" ? j : null;
  } catch {
    return null;
  }
}

export async function writeFingerprint(snapshotFile, { fingerprint, snapshotGeneratedAt, now = new Date() }) {
  const file = fingerprintPath(snapshotFile);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ fingerprint, snapshotGeneratedAt: snapshotGeneratedAt ?? null, confirmedAt: now.toISOString() }));
  await rename(tmp, file);
}

/**
 * Pure decision. Skip only when EVERY condition for skipping holds; anything else runs.
 *
 * @param {{snapshot: {ok: boolean, payload?: object, ageMs?: number|null, reason?: string}, stored: object|null,
 *          current: {ok: boolean, fingerprint?: string, reason?: string}, ceilingMs?: number}} a
 * @returns {{run: boolean, reason: string, since?: string}}
 */
export function decideDoctorRun({ snapshot, stored, current, ceilingMs = DEFAULT_CEILING_MS }) {
  if (!current.ok) return { run: true, reason: current.reason };
  if (!snapshot?.ok) return { run: true, reason: `no good snapshot (${snapshot?.reason ?? "unknown"})` };
  if (snapshot.payload?.error) return { run: true, reason: "previous snapshot was an error" };
  if (snapshot.ageMs == null || !Number.isFinite(snapshot.ageMs)) return { run: true, reason: "snapshot has no readable timestamp" };
  if (snapshot.ageMs > ceilingMs) return { run: true, reason: `snapshot older than the ${Math.round(ceilingMs / 3_600_000)} h ceiling` };
  if (!stored) return { run: true, reason: "no stored fingerprint (first run after upgrade, or an old snapshot)" };
  if (stored.snapshotGeneratedAt !== (snapshot.payload?.generatedAt ?? null)) {
    return { run: true, reason: "stored fingerprint belongs to a different snapshot" };
  }
  if (stored.fingerprint !== current.fingerprint) return { run: true, reason: "fingerprint changed" };
  return { run: false, reason: "fingerprint unchanged", since: snapshot.payload.generatedAt };
}
