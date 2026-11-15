/**
 * `work sync`: read the open, labelled GitHub issues of a repo and make the queue match (propagate#150). The queue is a
 * view over GitHub; this file never writes to GitHub.
 *
 * Shape (C3, R8): fetch EVERYTHING first, with no transaction open, then apply all changes in ONE `BEGIN IMMEDIATE`
 * calling only the `*InTx` queue forms. A transaction held across a network call would stall every claim for the busy
 * timeout.
 */
import { openDb } from "./db.mjs";
import { fail } from "./errors.mjs";
import { enqueueInTx, expireInTx, unparkInTx } from "./queue.mjs";
import { canonicalUrl, firstUrl } from "./canonical.mjs";
import { readJson } from "../broadcast/gh.mjs";

/** Every consumer of a kind must be idempotent, keyed by the item's dedupe_key (C1): the queue is at-least-once. */
export const KINDS = Object.freeze({
  evaluate: Object.freeze({
    label: "kind:evaluate",
    parkedLabel: "evaluate:parked",
    ttlMs: 30 * 24 * 3600 * 1000,
    idempotent_by: "dedupe_key: one register entry per canonical URL",
  }),
});

/** R3: a result this long may have been cut off, so a missing issue cannot be read as a closed one. */
export const ISSUE_LIMIT = 1000;

/** The prose for a label that does not exist on the repo (R25): looked at nothing, which is not zero issues. */
const missingLabelMessage = (label, repo) => `label ${label} does not exist on ${repo}: looked at nothing`;

function githubFailed(what) {
  fail("WORK_GITHUB_FAILED", what, "check `gh auth status` and the repo name, then re-run `propagate work sync`");
}

function parse(payload) {
  try { return JSON.parse(payload); } catch { return {}; }
}

/**
 * @param {string} kindName
 * @param {{repo: string, gh: Function, stateDirPath?: string, now?: () => number, db?: object}} opts
 * @returns {{enqueued:number, skipped:number, expired:number, unparked:number, unparsed:{number:number,title:string}[],
 *   stale:boolean, label_missing:boolean, message?:string}}
 */
export function syncKind(kindName, { repo, gh, stateDirPath, now = Date.now, db: handed } = {}) {
  const kind = KINDS[kindName];
  if (!kind) fail("WORK_USAGE", `unknown work kind ${kindName}`, `use one of: ${Object.keys(KINDS).join(", ")}`);
  const out = { enqueued: 0, skipped: 0, expired: 0, unparked: 0, unparsed: [], stale: false, label_missing: false };

  // ---- fetch: no database handle open, no transaction ----------------------------------------------------------
  const fetchedAt = now();
  const labels = readJson(gh, ["label", "list", "-R", repo, "--limit", "1000", "--json", "name"], `listing labels of ${repo}`);
  if (!labels.ok) githubFailed(labels.error);
  if (!Array.isArray(labels.json)) githubFailed(`listing labels of ${repo}: output was not a list`);
  if (!labels.json.some((l) => l?.name === kind.label)) {
    return { ...out, label_missing: true, message: missingLabelMessage(kind.label, repo) };
  }
  const res = readJson(
    gh,
    ["issue", "list", "-R", repo, "--label", kind.label, "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,title,body,labels"],
    `listing ${kind.label} issues of ${repo}`,
  );
  if (!res.ok) githubFailed(res.error);
  const issues = res.json;
  if (!Array.isArray(issues)) githubFailed(`listing ${kind.label} issues of ${repo}: output was not a list`);
  if (issues.length >= ISSUE_LIMIT) {
    fail(
      "WORK_SYNC_TRUNCATED",
      `${issues.length} open ${kind.label} issues came back, which is the fetch limit: any issue past it would look closed, so nothing was expired`,
      `close or relabel old ${kind.label} issues on ${repo}, then re-run \`propagate work sync\``,
    );
  }

  // ---- apply: one transaction, *InTx forms only -----------------------------------------------------------------
  const opened = handed ? null : openDb(stateDirPath);
  const db = handed ?? opened.db;
  const t = now();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const mark = db.prepare("SELECT fetched_at FROM sync_marks WHERE kind = ? AND scope = ?").get(kindName, repo);
      if (mark && mark.fetched_at > fetchedAt) {
        out.stale = true;
        db.exec("COMMIT");
        return out;
      }
      db.prepare(
        "INSERT INTO sync_marks (kind, scope, fetched_at) VALUES (?, ?, ?) ON CONFLICT(kind, scope) DO UPDATE SET fetched_at = excluded.fetched_at",
      ).run(kindName, repo, fetchedAt);

      const clockOpts = { now };
      const open = new Set(issues.map((i) => i.number));
      const live = () => db.prepare("SELECT * FROM work_items WHERE kind = ? AND scope = ? AND state <> 'expired' ORDER BY created, id").all(kindName, repo);

      // 1. items whose issue is no longer open. Acked work is finished and never expires (R22).
      for (const it of live()) {
        if (it.state === "acked") continue;
        if (!open.has(parse(it.payload).issue_number)) {
          expireInTx(db, it.id, { reason: "issue closed" }, clockOpts);
          out.expired += 1;
        }
      }

      // 2. each open issue
      for (const is of issues) {
        const names = new Set((is.labels ?? []).map((l) => l?.name));
        const parked = names.has(kind.parkedLabel);
        const mine = live().filter((it) => parse(it.payload).issue_number === is.number);

        if (parked) {
          for (const it of mine) {
            if (it.state === "parked") db.prepare("UPDATE work_items SET parked_label_seen = 1 WHERE id = ?").run(it.id);
          }
          out.skipped += 1;
          continue;
        }

        const text = firstUrl(is.body) ? is.body : is.title;
        const url = firstUrl(text);
        const canonical = canonicalUrl(text);
        if (!canonical) {
          out.unparsed.push({ number: is.number, title: is.title });
          continue;
        }

        let current = null;
        for (const it of mine) {
          if (parse(it.payload).canonical_url !== canonical) {
            if (it.state !== "acked") { // R13: the issue now names something else
              expireInTx(db, it.id, { reason: "url changed" }, clockOpts);
              out.expired += 1;
            }
          } else if (it.state !== "acked" && it.expires_at <= t) { // R2: past its ttl, so it can never be claimed
            expireInTx(db, it.id, { reason: "ttl" }, clockOpts);
            out.expired += 1;
          } else {
            current = it;
          }
        }

        if (current) {
          if (current.state === "parked" && current.parked_label_seen === 1) { // R1: only a label we saw can be seen leaving
            unparkInTx(db, current.id, clockOpts);
            out.unparked += 1;
          } else {
            out.skipped += 1;
          }
          continue;
        }

        const r = enqueueInTx(db, {
          kind: kindName,
          scope: repo,
          dedupe_key: `${kindName}:${canonical}`,
          payload: { issue_repo: repo, issue_number: is.number, url, canonical_url: canonical },
          ttlMs: kind.ttlMs,
        }, clockOpts);
        if (r.created) out.enqueued += 1; else out.skipped += 1;
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* no transaction left */ }
      throw e;
    }
  } finally {
    if (opened) opened.db.close();
  }
  return out;
}
