/**
 * osascript.mjs — talk to Apple Reminders, and tell "found nothing" from
 * "could not look" by EXIT CODE before anything else touches the output.
 *
 * WHY THIS FILE EXISTS ON ITS OWN. `docs/plans/2026-09-23-reminders-todo-bridge.md`
 * F1 measured the failure mode directly: a TCC-denied read and a genuinely empty
 * list both come back as "no data", and the only thing that tells them apart is
 * the process exit status plus the trailing `(-NNNN)` OSStatus in stderr. That
 * measurement is the whole of this module's job — everything past `classify()`
 * assumes the caller already knows which of the two happened.
 *
 * | case               | rc | stdout |
 * |---------------------|----|--------|
 * | real list, 0 matches | 0  | empty  |
 * | missing list         | 1  | `…Can not get list "___missing___". (-1728)` |
 * | bad syntax           | 1  | `…(-2753)` |
 * | healthy read         | 0  | data   |
 *
 * -1743 (errAEEventNotPermitted) is the TCC denial itself — it is an Apple
 * Event Manager status, generated below the scripting language, so the same
 * code applies whether the script is AppleScript or JXA.
 *
 * WHY JXA (`-l JavaScript`), NOT PLAIN APPLESCRIPT. The spec's probed table
 * was measured against a bare `get {name, completed} of every reminder`
 * query, which is enough to prove the exit-code/OSStatus behaviour but is not
 * a serialization format — AppleScript's own record-to-text coercion and its
 * "date as string" conversion are locale-dependent and are a well-known
 * source of unparseable output. JXA gives native `JSON.stringify` and
 * `Date#toISOString()`, which removes an entire class of parsing bugs this
 * module would otherwise own. The OSA error surface (rc, stderr, the trailing
 * `(-NNNN)`) is unchanged by that choice — verified against Apple's own
 * documentation of `errAEEventNotPermitted`/`errAENoSuchObject`, which are
 * Apple Event Manager constants, not AppleScript-specific ones. This is the
 * one place this lane deviated from "read via osascript" as literally
 * probed, and it is recorded here rather than silently.
 *
 * NEVER RUN THIS AGAINST THE LIVE REMINDERS DATABASE TO "SEE WHAT HAPPENS".
 * A first-ever grant prompt blocks osascript on a GUI dialog, which would
 * hang a non-interactive run and put a dialog on the user's desktop
 * unannounced. `readRaw`'s default timeout turns a stuck prompt into a
 * `timeout` classification rather than a hang, but that is a safety net, not
 * a reason to go looking.
 */
import { spawnSync } from "node:child_process";

export const OSASCRIPT_BIN = "/usr/bin/osascript";

/** Trailing `(-NNNN)` in an osascript stderr line, e.g. `…(-1743)`. */
const CODE_RE = /\((-\d+)\)\s*$/;

/** Known Apple Event Manager / OSA statuses this reader gives a name to. */
const KNOWN_CODES = Object.freeze({
  "-1743": "tcc-denied", // errAEEventNotPermitted
  "-1728": "missing-list", // errAENoSuchObject
  "-2753": "syntax-error", // errOSACompileError-ish surfaced by osascript
  // -2700 is the JXA compile/runtime error, measured 2026-09-25 on this
  // machine: the SAME malformed source gives -2741 under AppleScript and
  // -2700 under `osascript -l JavaScript`. This reader builds a JXA script
  // (buildScript below), so -2700 is the code it will actually meet and
  // -2753 is the one the spec's table probed with plain AppleScript. Both
  // are kept -- dropping either would re-open the gap this closes.
  //
  // This is the LIMIT of "the OSA error surface is unchanged by the language
  // choice": true for Apple Event Manager statuses (-1743, -1728, -600),
  // which are generated below the scripting language, and NOT true for
  // compile errors, which the language's own compiler raises. Without this
  // entry a syntax error was still caught -- unknown codes classify
  // INCONCLUSIVE by design -- but it was attributed generically rather than
  // named, and rule:discernment-checks §2 wants absence attributable.
  "-2700": "syntax-error",
  "-600": "app-not-running", // procNotFound
});

/**
 * Build the JXA script that reads one Reminders list as JSON.
 *
 * Every field the rest of this lane needs and nothing it does not:
 * `completionDate` (F5 — never `modificationDate`) is read alongside
 * `modificationDate` deliberately, so a caller CAN see both and still must
 * choose `completionDate` explicitly rather than the field being absent and
 * "whichever is present" becoming the fallback.
 *
 * @param {string} listName
 * @returns {string}
 */
export function buildScript(listName) {
  // JSON.stringify the list name INTO the script so quotes/backslashes in a
  // renamed list cannot break out of the JS string literal.
  const nameLiteral = JSON.stringify(String(listName));
  return `
(function () {
  var Reminders = Application("Reminders");
  var list = Reminders.lists.byName(${nameLiteral});
  var items = list.reminders();
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var r = items[i];
    var completionDate = null;
    var modificationDate = null;
    try { var cd = r.completionDate(); if (cd) completionDate = cd.toISOString(); } catch (e) {}
    try { var md = r.modificationDate(); if (md) modificationDate = md.toISOString(); } catch (e) {}
    out.push({
      id: r.id(),
      name: r.name(),
      body: r.body() || "",
      completed: r.completed(),
      completionDate: completionDate,
      modificationDate: modificationDate,
    });
  }
  return JSON.stringify(out);
})();
`.trim();
}

/**
 * Run one JXA script through osascript and return its raw shape, NEVER
 * throwing — a thrown exec is exactly the "silent zero" shape this module
 * exists to avoid (rule:discernment-checks §2/§6). Every caller gets
 * `{status, stdout, stderr}` and decides via `classify()`.
 *
 * Injectable for tests as the `exec` param — a fixture object with the same
 * shape can stand in for `spawnSync` without a subprocess.
 *
 * @param {string} script
 * @param {{ exec?: (bin: string, args: string[]) => {status: number|null, stdout: string, stderr: string}, timeoutMs?: number }} [opts]
 */
export function readRaw(script, opts = {}) {
  const { exec, timeoutMs = 15_000 } = opts;
  if (exec) return exec(OSASCRIPT_BIN, ["-l", "JavaScript", "-e", script]);

  const r = spawnSync(OSASCRIPT_BIN, ["-l", "JavaScript", "-e", script], {
    encoding: "utf8",
    timeout: timeoutMs,
  });

  // spawnSync on a timeout returns status: null, signal: "SIGTERM", never
  // throws — but that null status must not be misread as rc===0 by a lazy
  // truthiness check downstream, so it is normalized to a real classification
  // right here rather than left for classify() to guess at.
  if (r.error) {
    const isTimeout = r.error.code === "ETIMEDOUT" || r.signal === "SIGTERM";
    return {
      status: 1,
      stdout: r.stdout ?? "",
      stderr: isTimeout
        ? `osascript timed out after ${timeoutMs}ms (possibly blocked on a permission dialog)`
        : String(r.error.message ?? r.error),
      timedOut: isTimeout,
    };
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Classify a raw `{status, stdout, stderr}` into FOUND-NOTHING/OK vs
 * COULD-NOT-LOOK, per F1. This is the one function every other module in
 * this lane trusts to have already made that call — nothing downstream may
 * re-derive "empty" from stdout without going through this first.
 *
 * @param {{status: number|null, stdout: string, stderr: string, timedOut?: boolean}} raw
 * @returns {{ ok: true } | { ok: false, reason: string, reasonDetail: string, code: string|null }}
 */
export function classify(raw) {
  const status = raw?.status;
  const stderr = String(raw?.stderr ?? "");

  if (raw?.timedOut) {
    return { ok: false, reason: "timeout", reasonDetail: stderr || "osascript did not return", code: null };
  }

  if (status === 0) return { ok: true };

  // rc !== 0: COULD-NOT-LOOK. Name why, never guess.
  const m = stderr.trim().match(CODE_RE);
  const code = m ? m[1] : null;
  const reason = code && KNOWN_CODES[code] ? KNOWN_CODES[code] : "osascript-error";
  return {
    ok: false,
    reason,
    reasonDetail: stderr.trim() || `osascript exited ${status} with no stderr`,
    code,
  };
}
