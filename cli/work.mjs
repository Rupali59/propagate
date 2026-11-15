/**
 * `propagate work list|sync|claim|ack|release|unpark|prune` (propagate#150): the work event queue. The queue is a SQLite
 * file under the state dir (lib/work/); `sync` makes it a view over labelled GitHub issues. Docs: docs/REFERENCE.md §work.
 *
 * EXIT CODES. 0 ok (an empty queue, a missing label and a stale sync are all stated and still 0); 1 refused (not found,
 * not the claimant, lease or item expired); 2 could not run (usage, an unreadable or locked store, GitHub). Every failure
 * is `<CODE>: <what>. Next: <command>` on stderr, or `{ok:false, code, what, next}` with --json.
 *
 * One database open per command; its warnings go to stderr and into --json. `list` never prints a claim's token: a stale
 * lane told to run `work list` must not be able to copy the current claimant's.
 */
import fs from "node:fs";

import { stateDir } from "../lib/core/paths.mjs";
import { makeGh } from "../lib/broadcast/gh.mjs";
import { hubRepoOf } from "./broadcast.mjs";
import { openDb, openDbReadOnly, assertStoreSafe, dbPath } from "../lib/work/db.mjs";
import { WorkError, fail } from "../lib/work/errors.mjs";
import { ack, claim, list, release, unpark } from "../lib/work/queue.mjs";
import { prune, DEFAULT_PRUNE_DAYS } from "../lib/work/prune.mjs";
import { KINDS, syncKind } from "../lib/work/sync.mjs";

const USAGE = "usage: propagate work list [--kind k] [--state s] [--json] | work sync --kind k [--hub owner/repo] [--json] | work claim --kind k [--session id] [--json] | work ack <id> --token t [--session id] [--json] | work release <id> --token t [--session id] [--refusal] [--reason r] [--json] | work unpark <id> [--json] | work prune [--older-than <days>] [--apply] [--json]";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CREATED_LINE = "store created now: acked/parked history before this point is not known";

const SUBS = {
  list: { valued: ["--kind", "--state"], bools: ["--json"], pos: 0 },
  sync: { valued: ["--kind", "--hub"], bools: ["--json"], pos: 0 },
  claim: { valued: ["--kind", "--session"], bools: ["--json"], pos: 0 },
  ack: { valued: ["--token", "--session"], bools: ["--json"], pos: 1 },
  release: { valued: ["--token", "--session", "--reason"], bools: ["--json", "--refusal"], pos: 1 },
  unpark: { valued: [], bools: ["--json"], pos: 1 },
  prune: { valued: ["--older-than"], bools: ["--json", "--apply"], pos: 0 },
};

function parse(sub, rest) {
  const spec = SUBS[sub];
  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (spec.valued.includes(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) fail("WORK_USAGE", `${a} needs a value`, USAGE);
      flags[a] = v;
      i++;
    } else if (spec.bools.includes(a)) flags[a] = true;
    else if (a.startsWith("--")) fail("WORK_USAGE", `unknown argument ${a}`, USAGE);
    else pos.push(a);
  }
  if (pos.length !== spec.pos) {
    fail("WORK_USAGE", spec.pos ? `work ${sub} takes one <id>` : `work ${sub} takes no positional argument, got "${pos[0]}"`, USAGE);
  }
  return { pos, flags };
}

/** A lost lock is a raw node:sqlite error (SQLITE_BUSY from BEGIN or COMMIT): never surface it raw. */
function typed(e) {
  if (e instanceof WorkError) return e;
  if (e && (e.code === "ERR_SQLITE_ERROR" || /database is locked|SQLITE_BUSY|database table is locked/i.test(String(e.message)))) {
    return new WorkError(
      "WORK_STORE_UNREADABLE",
      `the queue database is locked or unreadable: ${e.message}`,
      "wait for the other propagate process to finish, then re-run; if it keeps failing, check for a stuck process holding queue.db",
    );
  }
  return null;
}

/** The item as printed: never the token. */
function publicItem(r) {
  const { token: _token, ...rest } = r;
  return rest;
}

const line = (r) => {
  const p = (() => { try { return JSON.parse(r.payload); } catch { return {}; } })();
  const lease = r.effective_state === "claimed" ? ` session=${r.session} lease_until=${new Date(r.lease_until).toISOString()}` : "";
  const shown = r.effective_state === "pending" && r.state === "claimed" ? "pending (lease expired)" : r.effective_state;
  return `${r.id}  ${r.kind}  ${shown}  claims=${r.claims} refusals=${r.refusals}${lease}  ${p.url ?? r.dedupe_key}`;
};

/**
 * @param {string[]} argv everything after `work`
 * @param {object} [inject] tests: gh, stateDirPath, now, busyMs, hub, env, io, openDb
 * @returns {Promise<number>} the exit code
 */
export async function workCmd(argv = [], inject = {}) {
  const io = inject.io ?? console;
  const asJson = argv.includes("--json");
  const sub = argv[0];
  try {
    if (!Object.hasOwn(SUBS, sub ?? "")) fail("WORK_USAGE", sub ? `unknown subcommand "${sub}"` : "no subcommand", USAGE);
    const { pos, flags } = parse(sub, argv.slice(1));
    return await run(sub, pos, flags, inject, io, asJson);
  } catch (e) {
    const w = typed(e);
    if (!w) throw e;
    if (asJson) io.log(JSON.stringify(w.toJSON(), null, 2));
    else io.error(w.message);
    return w.exit;
  }
}

async function run(sub, pos, flags, inject, io, asJson) {
  const stateDirPath = inject.stateDirPath ?? stateDir();
  const now = inject.now ?? Date.now;
  const env = inject.env ?? process.env;
  const open = inject.openDb ?? openDb;
  const out = (obj, textLines, warnings, extra = []) => {
    if (asJson) io.log(JSON.stringify({ ok: true, ...obj, warnings }, null, 2));
    else {
      for (const w of warnings) io.error(`warning: ${w}`);
      for (const l of [...extra, ...textLines]) io.log(l);
    }
    return 0;
  };

  if (sub === "list") {
    if (flags["--state"] && !["pending", "claimed", "acked", "expired", "parked"].includes(flags["--state"])) {
      fail("WORK_USAGE", `unknown state ${flags["--state"]}`, "use one of: pending, claimed, acked, expired, parked");
    }
    let handle;
    let createdNow = false;
    let warnings = [];
    if (fs.existsSync(dbPath(stateDirPath))) {
      // WAL readers do not wait on a writer, so list still answers while a claim holds the lock.
      warnings = assertStoreSafe(stateDirPath);
      const ro = openDbReadOnly(stateDirPath);
      if (!ro.db) fail("WORK_STORE_UNREADABLE", `cannot read the queue: ${ro.reason}`, "check the store with `propagate work list` after other propagate processes finish, or set PROPAGATE_STATE_DIR elsewhere");
      handle = ro.db;
    } else {
      const o = open(stateDirPath, { busyMs: inject.busyMs });
      handle = o.db;
      createdNow = o.created_now;
      warnings = o.warnings;
    }
    try {
      const rows = list({ kind: flags["--kind"], state: flags["--state"] }, { db: handle, now }).map(publicItem);
      const text = rows.length ? rows.map(line) : ["0 work items"];
      return out({ items: rows, created_now: createdNow }, text, warnings, createdNow ? [CREATED_LINE] : []);
    } finally {
      handle.close();
    }
  }

  const o = open(stateDirPath, { busyMs: inject.busyMs });
  const { db, created_now: createdNow, warnings } = o;
  try {
    const clock = { db, now };
    switch (sub) {
      case "sync": {
        const kind = flags["--kind"] ?? fail("WORK_USAGE", "--kind is required", USAGE);
        if (!KINDS[kind]) fail("WORK_USAGE", `unknown work kind ${kind}`, `use one of: ${Object.keys(KINDS).join(", ")}`);
        const repo = flags["--hub"] ?? inject.hub ?? hubRepoOf();
        if (!repo || !REPO_RE.test(repo)) {
          fail("WORK_HUB_UNKNOWN", "could not resolve the hub repo from the hub root's origin", "pass --hub <owner/repo>");
        }
        const r = syncKind(kind, { repo, gh: inject.gh ?? makeGh(), db, now });
        const text = r.message
          ? [r.message]
          : [
            r.stale ? "stale: a newer sync already applied; nothing changed" : `synced ${kind} from ${repo}`,
            `enqueued ${r.enqueued}, skipped ${r.skipped}, expired ${r.expired}, unparked ${r.unparked}`,
            ...r.unparsed.map((u) => `unparsed: #${u.number} ${u.title} (no URL in the body or the title)`),
          ];
        return out({ ...r, created_now: createdNow }, text, warnings, createdNow ? [CREATED_LINE] : []);
      }
      case "claim": {
        const kind = flags["--kind"] ?? fail("WORK_USAGE", "--kind is required", USAGE);
        const session = flags["--session"] ?? env.CLAUDE_CODE_SESSION_ID;
        if (!session) fail("WORK_USAGE", "no session id: pass --session or run inside a Claude Code session (CLAUDE_CODE_SESSION_ID)", USAGE);
        const item = claim({ kind, session }, clock);
        if (!item) return out({ item: null }, [`nothing pending for ${kind}`], warnings);
        const p = (() => { try { return JSON.parse(item.payload); } catch { return {}; } })();
        return out({ item }, [`claimed ${item.id}  ${item.kind}  ${p.url ?? item.dedupe_key}`, `token ${item.token}`, `lease_until ${new Date(item.lease_until).toISOString()}`], warnings);
      }
      case "ack": {
        const token = flags["--token"] ?? fail("WORK_USAGE", "--token is required (claim printed it)", USAGE);
        const session = flags["--session"] ?? env.CLAUDE_CODE_SESSION_ID;
        if (!session) fail("WORK_USAGE", "no session id: pass --session or run inside a Claude Code session (CLAUDE_CODE_SESSION_ID)", USAGE);
        const item = ack(pos[0], { session, token }, clock);
        return out({ item: publicItem(item), already: item.already === true }, [item.already ? `already acked ${item.id}` : `acked ${item.id}`], warnings);
      }
      case "release": {
        const token = flags["--token"] ?? fail("WORK_USAGE", "--token is required (claim printed it)", USAGE);
        const session = flags["--session"] ?? env.CLAUDE_CODE_SESSION_ID;
        if (!session) fail("WORK_USAGE", "no session id: pass --session or run inside a Claude Code session (CLAUDE_CODE_SESSION_ID)", USAGE);
        const item = release(pos[0], { session, token, refusal: flags["--refusal"] === true, reason: flags["--reason"] }, clock);
        return out({ item: publicItem(item) }, [item.state === "parked" ? `released ${item.id}: parked after ${item.refusals} refusals` : `released ${item.id}`], warnings);
      }
      case "unpark": {
        const item = unpark(pos[0], clock);
        return out({ item: publicItem(item) }, [`unparked ${item.id}`], warnings);
      }
      case "prune": {
        const days = flags["--older-than"] === undefined ? DEFAULT_PRUNE_DAYS : Number(flags["--older-than"]);
        const r = prune(db, { olderThanDays: days, apply: flags["--apply"] === true }, { now });
        const text = r.dry_run
          ? [`dry run: would remove ${r.items} acked/expired items and ${r.events} events older than ${days} days`, "re-run with --apply to delete them"]
          : [`removed ${r.items} acked/expired items and ${r.events} events older than ${days} days`];
        return out(r, text, warnings);
      }
      default:
        return fail("WORK_USAGE", `unknown subcommand "${sub}"`, USAGE);
    }
  } finally {
    db.close();
  }
}
