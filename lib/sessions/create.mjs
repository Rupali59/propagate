/**
 * `propagate sessions new` (propagate#272, the act half, create). Two functions:
 *
 *   planCreate  pure. Derives folder, goal, item, name, prompt and the exact argv. Calls nothing, writes nothing: this is
 *               the whole of the dry run.
 *   applyCreate the side effect, in the order the plan fixes:
 *               lock -> read live -> refuse when a live session already serves the item -> `approved` -> spawn ->
 *               parse `backgrounded · <id>` (else join on name + cwd + startedAt) -> `created` + `associate` -> unlock.
 *
 * ONE lock is held across the whole section (assoc.append is told `locked: true`), because the check for a live session
 * on the item and the spawn must be one critical section or two creates for one item both pass the check. The lock goes
 * stale at 60 s (lib/core/lock.mjs), so the section is bounded: spawn 30 s, id join 10 s, release in `finally`.
 *
 * HAZARD: `claude --bg --help` STARTS a session. The argv here is `--bg -n <name> <prompt>` and nothing else: no
 * permission-mode flag, no bypass flag, no help flag. The prompt carries REFERENCES only (the issue URL and the guidance
 * file paths), never an issue body: a body is text someone else wrote, and it would become the session's first
 * instruction. Only `lib/sessions/live.mjs` runs `claude`; this file imports `runClaude` from there.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { acquireLock } from "../core/lock.mjs";
import { stateDir } from "../core/paths.mjs";
import { append, assocPath, fold } from "./assoc.mjs";
import { fail } from "./errors.mjs";
import { readLive as defaultReadLive, runClaude } from "./live.mjs";
import { folderOf } from "./resolve.mjs";
import { guidanceFor } from "./show.mjs";

export const ITEM_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
export const GOAL_RE = /^G\d+$/;
export const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;
/** The spawn bound. With JOIN_MS it stays well under the lock's 60 s stale limit. */
export const LAUNCH_TIMEOUT_MS = 30000;
export const JOIN_MS = 10000;
const JOIN_POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** What the two checkouts-by-repo lookups need: a case-insensitive repo match. */
const sameRepo = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Derive everything `new` will do. Pure: reads only what it is handed.
 * @param {{from?: string, folder?: string, goal?: string, item?: string, name?: string, snapshot?: object|null, ctx: object, now?: number}} a
 * @returns {{ok: true, plan: object} | {ok: false, code: string, what: string, next: string, side_effects: string[]}}
 */
export function planCreate({ from, folder, goal, item, name, snapshot = null, ctx, now = Date.now() }) {
  const warnings = [];
  const itemRef = from ?? item;
  const m = ITEM_RE.exec(itemRef ?? "");
  if (!m) return fail("SESSION_USAGE", `"${itemRef}" is not owner/repo#n`, "propagate sessions new --from owner/repo#n");
  if (goal !== undefined && !GOAL_RE.test(goal)) return fail("SESSION_USAGE", `"${goal}" is not a goal id like G3`, "propagate sessions new --from owner/repo#n --goal G3");
  if (name !== undefined && (!name.trim() || name.startsWith("-"))) return fail("SESSION_USAGE", "--name must be non-empty and must not start with `-` (it would be read as a flag)", "propagate sessions new --from owner/repo#n --name \"some name\"");
  const [, owner, repo, num] = m;
  const explicitFolder = `propagate sessions new <folder> --goal G<n> --item ${itemRef}`;

  // goal: an explicit --goal wins; otherwise the dispatch snapshot, and a null goal refuses.
  let snapshotAge = null;
  if (from) {
    snapshotAge = snapshot?.generatedAt ? now - Date.parse(snapshot.generatedAt) : null;
    if (goal === undefined) {
      const entry = snapshot?.items?.[from];
      if (!entry || typeof entry.goal !== "string" || !GOAL_RE.test(entry.goal)) {
        const why = !snapshot ? "there is no dispatch snapshot" : !entry ? `${from} is not in the dispatch snapshot` : `${from} has no Goal in the dispatch snapshot`;
        return fail("SESSION_GOAL_UNKNOWN", `${why}, so its goal cannot be derived`, `pass --goal G<n> (propagate sessions new --from ${from} --goal G<n>), or run propagate day open`);
      }
      goal = entry.goal;
      if (!(snapshotAge <= SNAPSHOT_STALE_MS)) warnings.push(`the dispatch snapshot is ${Number.isFinite(snapshotAge) ? `${Math.round(snapshotAge / 3600000)} h old` : "undated"}: run propagate day open to refresh the goal`);
    }
  }

  // folder: an explicit <folder> wins; otherwise the one checkout whose origin is the item's repo.
  let folderPath = folder ? path.resolve(folder) : null;
  if (!folderPath) {
    const hits = (ctx.checkouts ?? []).filter((c) => sameRepo(c.repo, `${owner}/${repo}`)).map((c) => c.path);
    if (hits.length === 0) return fail("SESSION_FOLDER_UNKNOWN", `no checkout on this machine has origin ${owner}/${repo}`, explicitFolder);
    if (hits.length > 1) return fail("SESSION_FOLDER_UNKNOWN", `${owner}/${repo} has ${hits.length} checkouts (${hits.join(", ")})`, `pass one: propagate sessions new <folder> --from ${itemRef}`);
    folderPath = hits[0];
  }
  if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) return fail("SESSION_FOLDER_UNKNOWN", `${folderPath} is not a directory`, explicitFolder);
  const place = folderOf(folderPath, ctx);
  if (place.unplaced) return fail("SESSION_FOLDER_UNKNOWN", `${folderPath} is outside every workspace propagate discovered`, "pass a folder inside a workspace, or run propagate setup");
  const project = place.all ? "hub" : place.project.startsWith("(") ? place.workspace : place.project;

  if (!goal) return fail("SESSION_USAGE", "name the goal: --goal G<n>", explicitFolder);

  const sessionName = name ?? `${project} · ${goal} · #${num}`;
  const guidance = guidanceFor(place, ctx);
  const files = [...guidance.claudeMd, ...guidance.state];
  const url = `https://github.com/${owner}/${repo}/issues/${num}`;
  const prompt = [
    `Work on ${url} (goal ${goal}).`,
    "Read the issue on GitHub first: this prompt carries references only.",
    ...(files.length ? ["Read these guidance files before you start:", ...files.map((f) => `- ${f}`)] : []),
  ].join("\n");
  return {
    ok: true,
    plan: {
      folder: folderPath,
      workspace: place.all ? "hub" : place.workspace,
      project,
      goal,
      item: itemRef,
      name: sessionName,
      issueUrl: url,
      guidance: files,
      prompt,
      argv: ["--bg", "-n", sessionName, prompt],
      source: from ? "from" : "explicit",
      snapshotAgeMs: snapshotAge !== null && Number.isFinite(snapshotAge) ? snapshotAge : null,
      warnings,
    },
  };
}

/** The dry-run text: what would run, and nothing about having run it. */
export function renderPlan(plan, { now = Date.now() } = {}) {
  const age = plan.source === "from" ? (plan.snapshotAgeMs === null ? "undated" : `${Math.round(plan.snapshotAgeMs / 60000)} min old`) : "not used (goal and item given)";
  return [
    "dry run: nothing was started. Re-run with --apply to start it.",
    `  folder:    ${plan.folder}  (${plan.workspace} / ${plan.project})`,
    `  goal:      ${plan.goal}`,
    `  item:      ${plan.item}`,
    `  name:      ${plan.name}`,
    `  snapshot:  ${age}`,
    `  guidance:  ${plan.guidance.length ? plan.guidance.join(", ") : "none found"}`,
    `  would run: claude ${JSON.stringify(plan.argv)}  (cwd ${plan.folder})`,
  ];
}

const UNTRUSTED_RE = /workspace not trusted/i;
const BACKGROUNDED_RE = /backgrounded\s*·\s*([A-Za-z0-9_-]+)/;

/**
 * The side effect.
 * @param {object} plan from planCreate
 * @param {{
 *   again?: boolean, stateDirPath?: string, now?: () => number, readLive?: Function,
 *   launchTimeoutMs?: number, joinMs?: number, pollMs?: number, afterApproved?: () => Promise<void>,
 *   lockOpts?: object
 * }} [o] tests inject readLive, the timings and `afterApproved` (a pause between `approved` and the spawn)
 * @returns {Promise<{ok: true, sessionId: string|null, id: string, name: string, cwd: string, state: string, rowKey: string} | {ok: false, code: string, what: string, next: string, side_effects: string[]}>}
 */
export async function applyCreate(plan, o = {}) {
  const stateDirPath = o.stateDirPath ?? stateDir();
  const now = o.now ?? Date.now;
  const readLive = o.readLive ?? defaultReadLive;
  const file = assocPath(stateDirPath);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, "", { flag: "a" });
  const put = (event) => append(event, { stateDirPath, now, locked: true });

  const release = await acquireLock(file, o.lockOpts ?? { retries: 2, minDelayMs: 100, maxDelayMs: 200 });
  if (!release) return fail("SESSION_LOCKED", "another `sessions new` holds the association lock", "wait for it to finish, then run propagate sessions: nothing was started");
  try {
    const before = readLive({ now });
    if (!before.ok) return before;
    let folded;
    try {
      folded = fold(stateDirPath);
    } catch (e) {
      return fail("SESSION_ASSOC_UNREADABLE", `could not read assoc.jsonl (${e.message})`, `check the permissions of ${path.dirname(file)}`);
    }
    if (!o.again) {
      const liveKeys = new Set(before.rows.map((r) => r.key));
      for (const [key, entry] of folded.byKey) {
        if (entry.assoc?.item === plan.item && liveKeys.has(key)) {
          const row = before.rows.find((r) => r.key === key);
          return fail("SESSION_ITEM_LIVE", `${plan.item} already has a live session (${row.name || "(unnamed)"}, ${row.id || row.sessionId.slice(0, 8)})`, `propagate sessions show ${row.id || row.sessionId.slice(0, 8)}  (or pass --again to start a second one)`);
        }
      }
    }

    const launchKey = `launch:${new Date(now()).toISOString()}:${randomBytes(3).toString("hex")}`;
    const intent = { goal: plan.goal, item: plan.item, name: plan.name, cwd: plan.folder, argv: plan.argv };
    try {
      await put({ event: "approved", rowKey: launchKey, ...intent });
    } catch (e) {
      return fail("SESSION_ASSOC_WRITE_FAILED", `the approval was not written (${e.message}), so nothing was started`, "retry propagate sessions new --apply");
    }
    if (o.afterApproved) await o.afterApproved();

    const launchAt = now();
    const r = runClaude(plan.argv, { cwd: plan.folder, timeout: o.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS });
    // Measured 2026-11-14 (DX-T8, Claude Code 2.1.311): in a folder claude has never been trusted in, `claude --bg` does
    // NOT hang on the trust prompt; it refuses in ~1.6 s with "Workspace not trusted. Run `claude` in <dir> once and
    // accept the trust prompt, then retry." and starts no session. Matched on the text, before the exit status is read,
    // so an exit 0 with that message is never mistaken for a launch whose id we failed to join.
    if (UNTRUSTED_RE.test(`${r.stderr}\n${r.stdout}`)) {
      await put({ event: "create-failed", rowKey: launchKey, ...intent, reason: "workspace not trusted" }).catch(() => {});
      return fail("SESSION_FOLDER_UNTRUSTED", `claude refused to start in ${plan.folder}: the folder is not trusted yet, so no session started`, `open claude once in ${plan.folder} and accept the trust prompt, then re-run propagate sessions new --apply`, []);
    }
    if (r.timedOut) {
      await put({ event: "unknown", rowKey: launchKey, ...intent, reason: "launch timed out" }).catch(() => {});
      return fail("SESSION_LAUNCH_TIMEOUT", `claude did not return within ${(o.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS) / 1000} s `, `claude agents --json  (a session may have started; find it, then propagate sessions assoc <id>)`, ["a session may have started"]);
    }
    if (!r.ok) {
      const why = r.error ?? `exit ${r.status}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]}` : ""}`;
      await put({ event: "create-failed", rowKey: launchKey, ...intent, reason: why }).catch(() => {});
      return fail("SESSION_LAUNCH_FAILED", `claude --bg failed (${why})`, "run propagate sessions to see whether anything started, then retry");
    }

    // Identify the new session: the id claude printed, else a join on name + cwd + startedAt >= launch.
    const printed = BACKGROUNDED_RE.exec(r.stdout)?.[1] ?? null;
    const deadline = Date.now() + (o.joinMs ?? JOIN_MS);
    const pollMs = o.pollMs ?? JOIN_POLL_MS;
    const wantCwd = real(plan.folder);
    let row = null;
    let ambiguous = 0;
    for (;;) {
      const live = readLive({ now });
      if (live.ok) {
        const hits = printed
          ? live.rows.filter((x) => x.id === printed)
          : live.rows.filter((x) => x.name === plan.name && real(x.cwd) === wantCwd && typeof x.startedAt === "number" && x.startedAt >= launchAt);
        if (hits.length === 1) {
          row = hits[0];
          break;
        }
        if (hits.length > 1) {
          ambiguous = hits.length;
          break;
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    if (!row && !printed) {
      await put({ event: "unknown", rowKey: launchKey, ...intent, reason: ambiguous ? `${ambiguous} live rows matched` : "no live row matched" }).catch(() => {});
      return fail("SESSION_ID_UNKNOWN", `claude --bg returned without an id, and ${ambiguous ? `${ambiguous} live sessions match` : "no live session matches"} name "${plan.name}" in ${plan.folder} started since the launch`, "claude agents --json  (find it, then propagate sessions assoc <id> --goal G<n> --item owner/repo#n); it is not retried", ["a session started"]);
    }
    const id = printed ?? row.id;
    const rowKey = row ? row.key : `background:${id}:`;
    const snapshot = { kind: row?.kind ?? "background", id, sessionId: row?.sessionId ?? null, pid: row?.pid ?? null, name: plan.name, cwd: plan.folder };
    try {
      await put({ event: "created", rowKey, launchKey, ...intent });
      await put({ event: "associate", rowKey, goal: plan.goal, item: plan.item, source: plan.source === "from" ? "from" : "explicit", workspace: plan.workspace, project: plan.project, row: snapshot });
    } catch (e) {
      return fail("SESSION_ASSOC_WRITE_FAILED", `the session started (${id}) but its association was not written (${e.message})`, `propagate sessions assoc ${id} --goal ${plan.goal} --item ${plan.item}`, ["a session started"]);
    }
    return { ok: true, sessionId: row?.sessionId ?? null, id, name: plan.name, cwd: plan.folder, state: row?.state ?? "starting", rowKey };
  } finally {
    await release();
  }
}
