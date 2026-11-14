/**
 * `propagate sessions [--json]`, `sessions show <id|name> [--json]`, `sessions assoc <id> ...` (propagate#272, the read
 * half). Live state is derived from `claude agents --json` on every call; the only thing written is the association
 * (`sessions assoc`, one line in assoc.jsonl) and the folder cache (checkouts.json).
 *
 * EXIT CODES. 0 read or associated; 1 refused (not found, ambiguous, goal unknown, association not written);
 * 2 could not read (claude, its shape, the log) or a usage error. Every failure is `<CODE>: <what>. Next: <command>`
 * on stderr, or `{ok:false, code, what, next, side_effects}` with --json. The code table: docs/REFERENCE.md §sessions.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { stateDir } from "../lib/core/paths.mjs";
import { append, fold } from "../lib/sessions/assoc.mjs";
import { exitOf, fail, renderFailure } from "../lib/sessions/errors.mjs";
import { readLive } from "../lib/sessions/live.mjs";
import { loadContext } from "../lib/sessions/resolve.mjs";
import { buildShow, renderShow, selectSession } from "../lib/sessions/show.mjs";
import { buildView, renderView } from "../lib/sessions/view.mjs";

const USAGE = "usage: propagate sessions [--json] | sessions show <id|name> [--json] | sessions assoc <id> (--from owner/repo#n | --goal G<n> --item owner/repo#n) [--json]";
const ITEM_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/;
const GOAL_RE = /^G\d+$/;
const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;

/** Split argv into positionals and flags. `valued` flags take the next token. Unknown flags are a usage failure. */
function parse(rest, valued, bools) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (valued.includes(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: fail("SESSION_USAGE", `${a} needs a value`, USAGE) };
      flags[a] = v;
      i++;
    } else if (bools.includes(a)) flags[a] = true;
    else if (a.startsWith("--")) return { error: fail("SESSION_USAGE", `unknown argument ${a}`, USAGE) };
    else pos.push(a);
  }
  return { pos, flags };
}

function emitFailure(f, asJson, io) {
  if (asJson) io.log(JSON.stringify(f, null, 2));
  else io.error(renderFailure(f));
  return exitOf(f);
}

/**
 * @param {string[]} argv everything after `sessions`
 * @param {object} [inject] tests: readLive, ctx, now, stateDirPath, snapshot, io
 */
export async function sessionsCmd(argv = [], inject = {}) {
  const io = inject.io ?? console;
  const sub = argv[0];
  const asJson = argv.includes("--json");
  if (sub === "show") return showCmd(argv.slice(1), inject, io);
  if (sub === "assoc") return assocCmd(argv.slice(1), inject, io);
  const p = parse(argv, [], ["--json"]);
  if (p.error || p.pos.length) return emitFailure(p.error ?? fail("SESSION_USAGE", `unknown subcommand "${p.pos[0]}"`, USAGE), asJson, io);
  const got = await readAll(inject);
  if (!got.ok) return emitFailure(got, asJson, io);
  const now = (inject.now ?? Date.now)();
  const view = buildView(got.live, got.fold, got.ctx);
  if (asJson) io.log(JSON.stringify({ ok: true, ...view, warnings: got.ctx.warnings }, null, 2));
  else {
    for (const w of got.ctx.warnings) io.error(`warning: ${w}`);
    for (const l of renderView(view, { now })) io.log(l);
  }
  return 0;
}

/** The three reads every verb needs. A failure in any is a typed failure, never a partial view. */
async function readAll(inject) {
  const live = (inject.readLive ?? readLive)({ now: inject.now });
  if (!live.ok) return live;
  const stateDirPath = inject.stateDirPath ?? stateDir();
  let f;
  try {
    f = fold(stateDirPath);
  } catch (e) {
    return fail("SESSION_ASSOC_UNREADABLE", `could not read assoc.jsonl (${e.message})`, `check the permissions of ${path.join(stateDirPath, "sessions")}`);
  }
  const ctx = inject.ctx ?? loadContext({ stateDirPath, now: inject.now?.() });
  return { ok: true, live, fold: f, ctx };
}

async function showCmd(rest, inject, io) {
  const asJson = rest.includes("--json");
  const p = parse(rest, [], ["--json"]);
  if (p.error || p.pos.length !== 1) return emitFailure(p.error ?? fail("SESSION_USAGE", "show takes exactly one <id|name>", USAGE), asJson, io);
  const got = await readAll(inject);
  if (!got.ok) return emitFailure(got, asJson, io);
  const view = buildView(got.live, got.fold, got.ctx);
  const pick = selectSession(p.pos[0], view);
  if (!pick.ok) return emitFailure(pick, asJson, io);
  const d = buildShow(pick, got.fold, got.ctx, { now: (inject.now ?? Date.now)() });
  if (asJson) io.log(JSON.stringify({ ok: true, ...d }, null, 2));
  else for (const l of renderShow(d)) io.log(l);
  return 0;
}

/** The dispatch snapshot (`day open` writes it): `{generatedAt, items: {"owner/repo#n": {goal, ...}}}`. null when unreadable. */
function readSnapshot(inject) {
  if (inject.snapshot !== undefined) return inject.snapshot;
  try {
    return JSON.parse(readFileSync(path.join(inject.stateDirPath ?? stateDir(), "day", "items.json"), "utf8"));
  } catch {
    return null;
  }
}

async function assocCmd(rest, inject, io) {
  const asJson = rest.includes("--json");
  const p = parse(rest, ["--from", "--goal", "--item"], ["--json"]);
  if (p.error) return emitFailure(p.error, asJson, io);
  if (p.pos.length !== 1) return emitFailure(fail("SESSION_USAGE", "assoc takes exactly one <id>", USAGE), asJson, io);
  const { "--from": from, "--goal": goalFlag, "--item": itemFlag } = p.flags;
  if (from && (goalFlag || itemFlag)) return emitFailure(fail("SESSION_USAGE", "--from is an alternative to --goal/--item, not a pair", USAGE), asJson, io);
  if (!from && !(goalFlag && itemFlag)) return emitFailure(fail("SESSION_USAGE", "name the work: --from owner/repo#n, or --goal G<n> with --item owner/repo#n", USAGE), asJson, io);
  const item = from ?? itemFlag;
  if (!ITEM_RE.test(item)) return emitFailure(fail("SESSION_USAGE", `"${item}" is not owner/repo#n`, USAGE), asJson, io);
  if (goalFlag && !GOAL_RE.test(goalFlag)) return emitFailure(fail("SESSION_USAGE", `"${goalFlag}" is not a goal id like G3`, USAGE), asJson, io);

  const warnings = [];
  let goal = goalFlag;
  if (from) {
    const snap = readSnapshot(inject);
    const entry = snap?.items?.[from];
    if (!entry || typeof entry.goal !== "string" || !GOAL_RE.test(entry.goal)) {
      const why = !snap ? "there is no dispatch snapshot" : !entry ? `${from} is not in the dispatch snapshot` : `${from} has no Goal in the dispatch snapshot`;
      return emitFailure(fail("SESSION_GOAL_UNKNOWN", `${why}, so its goal cannot be derived`, `pass --goal G<n> --item ${from}, or run propagate day open`), asJson, io);
    }
    goal = entry.goal;
    const age = (inject.now ?? Date.now)() - Date.parse(snap.generatedAt);
    if (!(age <= SNAPSHOT_STALE_MS)) warnings.push(`the dispatch snapshot is ${Number.isFinite(age) ? `${Math.round(age / 3600000)} h old` : "undated"}: run propagate day open to refresh the goal`);
  }

  const got = await readAll(inject);
  if (!got.ok) return emitFailure(got, asJson, io);
  const view = buildView(got.live, got.fold, got.ctx);
  const pick = selectSession(p.pos[0], view);
  if (!pick.ok) return emitFailure(pick, asJson, io);
  if (!pick.session) return emitFailure(fail("SESSION_NOT_FOUND", `"${p.pos[0]}" is an ended session; only a live session can be associated`, "propagate sessions"), asJson, io);
  const s = pick.session;
  const event = {
    event: "associate",
    rowKey: s.key,
    goal,
    item,
    source: from ? "from" : "explicit",
    workspace: s.folder.unplaced ? null : s.folder.workspace,
    project: s.folder.unplaced ? null : s.folder.project,
    row: { kind: s.kind, id: s.id, sessionId: s.sessionId, pid: s.pid, name: s.name, cwd: s.cwd },
  };
  let stored;
  try {
    stored = await append(event, { stateDirPath: inject.stateDirPath, now: inject.now });
  } catch (e) {
    return emitFailure(fail("SESSION_ASSOC_WRITE_FAILED", `the association was not written (${e.message})`, "retry propagate sessions assoc; nothing was changed"), asJson, io);
  }
  if (asJson) io.log(JSON.stringify({ ok: true, associated: stored, warnings }, null, 2));
  else {
    for (const w of warnings) io.error(`warning: ${w}`);
    io.log(`associated ${s.name || s.id || s.sessionId.slice(0, 8)} (${s.id || s.sessionId.slice(0, 8)}) with ${item} for ${goal}`);
  }
  return 0;
}
