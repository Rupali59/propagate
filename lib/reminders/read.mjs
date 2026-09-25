/**
 * read.mjs — the whole read path: osascript (or a fixture) -> classify ->
 * parse -> normalize -> route. This is the one function `commands/reminders.mjs`
 * calls, and the one function L5's reconciler is meant to consume instead of
 * re-deriving any of the above.
 *
 * WRITES NOTHING. Grep this file: there is no `writeFile`, no `appendEvent`,
 * no ledger import. Read-only is the whole of L4's scope
 * (`docs/plans/2026-09-23-reminders-todo-bridge.md` "The L4/L5 boundary") —
 * the UUID<->PR-0NN identity map, the reconciliation log and `--apply` are
 * L5's mutable stores, not this lane's.
 *
 * FIXTURE INJECTION (`fixturePath`, or `PROPAGATE_REMINDERS_FIXTURE` — read
 * HERE, by `readReminders()` itself, not just by the command layer; see
 * PR-027). A JSON file holding `{status, stdout, stderr}` — the exact shape
 * `osascript.mjs#readRaw` returns — so any caller of `readReminders()` can
 * drive every branch of `classify()` without a real subprocess or the real
 * Reminders app. It is not gated behind NODE_ENV: the risk of a stray
 * production use is nil (nobody sets this by accident) and the alternative
 * — mocking a binary on PATH — is worse, per this repo's existing precedent
 * of PROPAGATE_STATE_DIR / PROPAGATE_SEARCH_ROOTS as legitimate env-level
 * seams rather than test-only hacks. An explicit `fixturePath` option wins
 * over the env var when both are present — see the comment at its call site.
 */
import { readFile } from "node:fs/promises";
import { buildScript, readRaw, classify } from "./osascript.mjs";
import { normalizeRecord } from "./normalize.mjs";

export const DEFAULT_LIST = "Claude TODO";

/**
 * @param {{ listName?: string, exec?: Function, fixturePath?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<
 *   | { ok: true, list: string, items: ReturnType<typeof normalizeRecord>[], summary: {total:number, routed:number, heldUntagged:number, heldUnknownTag:number} }
 *   | { ok: false, list: string, reason: string, reasonDetail: string, code: string|null }
 * >}
 */
export async function readReminders(opts = {}) {
  const { listName = DEFAULT_LIST, exec, fixturePath: fixturePathOpt, timeoutMs } = opts;

  // PR-027: this env var was documented above as the injection seam and only
  // ever honoured by commands/reminders.mjs, one caller up. A direct caller —
  // checkReminders() in lib/report/doctor/reminders.mjs is the measured
  // instance — got a live osascript call regardless of the var. Read it HERE
  // so every caller of readReminders() honours it, not just the CLI command.
  //
  // PRECEDENCE, decided deliberately: an explicit `fixturePath` option wins
  // over the ambient env var. An explicit argument is a stronger statement of
  // intent than something set in the environment and easy to forget is set —
  // a caller that passes fixturePath is saying "use THIS fixture", and an
  // ambient var should not override that even if both happen to be present.
  const fixturePath = fixturePathOpt ?? (process.env.PROPAGATE_REMINDERS_FIXTURE || undefined);

  const raw = fixturePath ? await loadFixture(fixturePath) : readRaw(buildScript(listName), { exec, timeoutMs });

  const verdict = classify(raw);
  if (!verdict.ok) {
    return { ok: false, list: listName, reason: verdict.reason, reasonDetail: verdict.reasonDetail, code: verdict.code };
  }

  // rc === 0. Empty stdout is a real, legitimate "zero reminders" — the ONE
  // outcome F1 draws a hard line around: it must render as ok:true with an
  // empty list, never merged with the could-not-look branch above.
  const stdout = String(raw.stdout ?? "").trim();
  let records;
  try {
    records = stdout === "" ? [] : JSON.parse(stdout);
  } catch (err) {
    // rc===0 but the payload is not what we asked for. Per
    // rule:discernment-checks §6, a reader that cannot report "I did not
    // understand this" invents an answer — this is that guard, not a crash.
    return {
      ok: false,
      list: listName,
      reason: "unparseable-output",
      reasonDetail: `osascript exited 0 but stdout did not parse as JSON: ${String(err.message ?? err)}`,
      code: null,
    };
  }
  if (!Array.isArray(records)) {
    return {
      ok: false,
      list: listName,
      reason: "unparseable-output",
      reasonDetail: `expected a JSON array, got ${typeof records}`,
      code: null,
    };
  }

  const items = records.map(normalizeRecord);
  const summary = {
    total: items.length,
    routed: items.filter((i) => i.route.kind === "routed").length,
    heldUntagged: items.filter((i) => i.route.kind === "held-untagged").length,
    heldUnknownTag: items.filter((i) => i.route.kind === "held-unknown-tag").length,
  };

  return { ok: true, list: listName, items, summary };
}

/** @param {string} fixturePath */
async function loadFixture(fixturePath) {
  const txt = await readFile(fixturePath, "utf8");
  return JSON.parse(txt);
}
