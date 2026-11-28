/**
 * macOS notification + heartbeat file.
 *
 * Heartbeat fallback exists because user can deny notification permission;
 * doctor mode checks heartbeat age to detect silent watcher death.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTEGRATIONS } from "../core/config.mjs";
import { resolveBin } from "../core/which.mjs";
import { stateDir } from "../core/paths.mjs";

// ---------------------------------------------------------------------------
// click targets (propagate#296)
// ---------------------------------------------------------------------------

/**
 * THE ROUTE VOCABULARY. A click lands on a view of `propagate ui`, and the route is built HERE from a fixed table and
 * an id, never from item text: a title or a label can hold anything, and the route ends up inside a shell command.
 *
 *   glance  /glance            the glance list           /glance/<id>  one item's detail
 *   edge    /judge?edge=<id>   one edge, in Judge (the route the queue panel in claude-usage-widget sends)
 *   judge   /judge             the Judge list
 *   backlog /backlog           the backlog view
 *
 * The id is percent-encoded, and the encoded route must match ROUTE_RE, which admits no quote, space, `$`, `;` or
 * backtick; a route that does not is refused (uiRoute throws) rather than escaped, so the shell never sees one.
 */
export const ROUTE_KINDS = Object.freeze(["glance", "edge", "judge", "backlog"]);
const ROUTE_RE = /^\/(glance|judge|backlog)(\/[A-Za-z0-9%._~-]{1,600})?(\?edge=[A-Za-z0-9%._~-]{1,200})?$/;
const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** @param {"glance"|"edge"|"judge"|"backlog"} kind @param {string|null} [id] @returns {string} a route like `/glance/edge%3Aab12` */
export function uiRoute(kind, id = null) {
  let r;
  if (kind === "glance") r = id ? `/glance/${enc(id)}` : "/glance";
  else if (kind === "edge") r = id ? `/judge?edge=${enc(id)}` : "/judge";
  else if (kind === "judge") r = "/judge";
  else if (kind === "backlog") r = "/backlog";
  else throw new Error(`notify: no UI route kind ${JSON.stringify(kind)} (known: ${ROUTE_KINDS.join(", ")})`);
  if (!ROUTE_RE.test(r)) throw new Error(`notify: route ${JSON.stringify(r)} is not in the route vocabulary`);
  return r;
}

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The shell command a click runs, for an `open` option. HOW THE URL IS RESOLVED: not here. A route is handed to
 * `widget/open-ui.sh <route>`, the same script the widget's buttons run. It reads the running server's URL (port and
 * token) from `$STATE/ui-url`, starts `propagate ui` when none is up, replaces a stale one it can verify, and opens
 * `<url>#<route>`; the client routes on the fragment. Building a URL here instead would be a second copy of the port
 * and token rules that script owns, and it would open a dead page whenever no server was running.
 *
 * The command carries PROPAGATE_STATE_DIR and PROPAGATE_CLI because terminal-notifier runs it in a fresh shell that
 * has neither: without them the script would read the default state dir and the default checkout, not this install.
 *
 * @param {string|{route: string}|null|undefined} open a path (legacy: opened with `open`), or {route} from uiRoute
 * @param {{pluginRoot?: string, state?: string}} [where] test seams
 * @returns {string|null}
 */
export function clickCommand(open, { pluginRoot = PLUGIN_ROOT, state = stateDir() } = {}) {
  if (!open) return null;
  if (typeof open === "string") return `open ${JSON.stringify(open)}`;
  const route = open.route;
  if (typeof route !== "string" || !ROUTE_RE.test(route)) throw new Error(`notify: open.route ${JSON.stringify(route)} is not in the route vocabulary`);
  return `PROPAGATE_STATE_DIR=${sq(state)} PROPAGATE_CLI=${sq(path.join(pluginRoot, "cli.mjs"))} /bin/bash ${sq(path.join(pluginRoot, "widget", "open-ui.sh"))} ${sq(route)}`;
}

// PATH-resolved, with the configured override first. The absolute Homebrew
// path meant notification was dead on Intel Macs and Linux alike; the
// osascript fallback below is still macOS-only and degrades to stderr.
/**
 * Resolve the notifier, or null.
 *
 * The chain used to END in the literal `/opt/homebrew/bin/terminal-notifier`, so
 * "not installed" produced a confident path into a directory that, off Apple-Silicon
 * Homebrew, was never there — and the spawn failure that followed said nothing about
 * why. Returning null lets the caller fall through to osascript (macOS) and then to
 * stderr, each of which is an honest degradation. Exported so a test can assert the
 * unresolvable case without spawning anything.
 */
export function resolveNotifier() {
  return INTEGRATIONS.notifier ?? resolveBin("terminal-notifier") ?? homebrewNotifier();
}

// launchd gives a job PATH=/usr/bin:/bin:/usr/sbin:/sbin (G-Y), so $PATH misses Homebrew and the notification fell
// to osascript (credited to Script Editor, no click target; #312). These are the two standard prefixes, probed
// for the one binary, and only AFTER $PATH. Not the old literal-path chain: it ended in a path that might not
// exist and returned it anyway, whereas this returns a path only when the file is there, else null.
function homebrewNotifier() {
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    const candidate = path.join(dir, "terminal-notifier");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const TERMINAL_NOTIFIER = resolveNotifier();

/** The longest any notifier call may hold its caller (#462). */
export const NOTIFY_TIMEOUT_MS = 10000;

/**
 * Display a macOS notification. Best-effort — never throws.
 *
 * Prefers terminal-notifier over `osascript`. This is not a style choice:
 * macOS attributes a notification posted by `osascript -e 'display
 * notification'` to **Script Editor**, because that is osascript's host bundle.
 * Clicking such a notification launches Script Editor with an empty document —
 * the reported symptom. terminal-notifier lets us set `-sender`, so the
 * notification is attributed correctly, and `-execute`, so clicking it does
 * something useful instead of nothing.
 *
 * `verify.sh` in the hygiene scripts already did this correctly; only propagate
 * was posting bare osascript notifications.
 *
 * @param {string} title
 * @param {string} body
 * @param {{ open?: string|{route: string}, group?: string, notifier?: string }} [opts]
 *   open  - {route} from uiRoute (opens that view of `propagate ui`, see clickCommand), or a path to open
 *   group - coalescing key, so repeated runs replace rather than stack
 */
export function notify(title, body, opts = {}) {
  const { open, group } = opts;
  const bin = opts.notifier ?? TERMINAL_NOTIFIER; // opts.notifier: test seam
  // A bad route is a programming error, but a notification must never throw: it is sent without a click instead.
  let execute = null;
  try {
    execute = clickCommand(open);
  } catch (e) {
    process.stderr.write(`[propagate] notification sent without a click target: ${e.message}\n`);
  }
  return new Promise((resolve) => {
    const done = () => resolve();

    if (bin && existsSync(bin)) {
      const args = [
        "-title", String(title),
        "-message", String(body),
        // Attribute to Terminal rather than Script Editor. Without this the
        // notification is posted by whatever bundle spawned it.
        "-sender", "com.apple.Terminal",
        ...(group ? ["-group", group] : []),
        // -execute rather than -open: -open wants a URL, and a bare path with
        // spaces is not one; a UI route runs open-ui.sh (clickCommand).
        ...(execute ? ["-execute", execute] : []),
      ];
      // NEVER WAIT ON THE NOTIFIER (#462). With -execute, terminal-notifier stays alive until the notification is
      // clicked or dismissed; awaiting its exit hung the digest for 9 days on one unclicked notice. So it is spawned
      // detached and unref'd and notify() resolves on the spawn itself. The osascript fallback survives only for a
      // spawn that fails (ENOENT, EACCES): a notifier that starts and later exits non-zero is not retried.
      // NOTIFY_TIMEOUT_MS bounds the wait for the spawn event, so no path here can hold the caller.
      let settled = false;
      const finish = (fallback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (fallback) osascriptNotify(title, body, done);
        else done();
      };
      const timer = setTimeout(() => finish(false), NOTIFY_TIMEOUT_MS);
      timer.unref?.();
      try {
        const child = spawn(bin, args, { detached: true, stdio: "ignore" });
        child.once("error", () => finish(true));
        child.once("spawn", () => { child.unref(); finish(false); });
      } catch {
        finish(true);
      }
      return;
    }
    osascriptNotify(title, body, done);
  });
}

/** Fallback path. Attribution will be wrong (Script Editor) — see notify(). */
function osascriptNotify(title, body, done) {
  const safeTitle = String(title).replace(/"/g, '\\"');
  const safeBody = String(body).replace(/"/g, '\\"');
  const script = `display notification "${safeBody}" with title "${safeTitle}"`;
  execFile("/usr/bin/osascript", ["-e", script], { timeout: NOTIFY_TIMEOUT_MS }, (err) => {
    if (err) {
      process.stderr.write(
        `[propagate] notification failed (likely permission denied): ${err.message}\n`,
      );
    }
    done();
  });
}

/**
 * Update heartbeat file with current timestamp. Doctor mode reads this
 * to detect silent failure when notifications are denied.
 * @param {string} heartbeatPath
 */
export async function heartbeat(heartbeatPath) {
  try {
    await writeFile(heartbeatPath, String(Date.now()));
  } catch (err) {
    process.stderr.write(`[propagate] heartbeat write failed: ${err.message}\n`);
  }
}
