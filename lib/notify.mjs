/**
 * macOS notification + heartbeat file.
 *
 * Heartbeat fallback exists because user can deny notification permission;
 * doctor mode checks heartbeat age to detect silent watcher death.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { INTEGRATIONS } from "./config.mjs";
import { resolveBin } from "./which.mjs";

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
  return INTEGRATIONS.notifier ?? resolveBin("terminal-notifier") ?? null;
}

const TERMINAL_NOTIFIER = resolveNotifier();

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
 * @param {{ open?: string, group?: string }} [opts]
 *   open  - a path to open when the notification is clicked (e.g. the ledger)
 *   group - coalescing key, so repeated runs replace rather than stack
 */
export function notify(title, body, opts = {}) {
  const { open, group } = opts;
  return new Promise((resolve) => {
    const done = () => resolve();

    if (existsSync(TERMINAL_NOTIFIER)) {
      const args = [
        "-title", String(title),
        "-message", String(body),
        // Attribute to Terminal rather than Script Editor. Without this the
        // notification is posted by whatever bundle spawned it.
        "-sender", "com.apple.Terminal",
        ...(group ? ["-group", group] : []),
        // -execute rather than -open: -open wants a URL, and a bare path with
        // spaces (e.g. "Vipin Kaushik") is not one.
        ...(open ? ["-execute", `open ${JSON.stringify(open)}`] : []),
      ];
      execFile(TERMINAL_NOTIFIER, args, (err) => {
        if (!err) return done();
        // fall through to osascript rather than losing the notification
        osascriptNotify(title, body, done);
      });
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
  execFile("/usr/bin/osascript", ["-e", script], (err) => {
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
