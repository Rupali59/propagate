/**
 * macOS notification + heartbeat file.
 *
 * Heartbeat fallback exists because user can deny notification permission;
 * doctor mode checks heartbeat age to detect silent watcher death.
 */

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";

/**
 * Display a macOS notification. Best-effort — never throws.
 * @param {string} title
 * @param {string} body
 */
export function notify(title, body) {
  // osascript -e 'display notification "..." with title "..."'
  // Escape double quotes in the message.
  const safeTitle = String(title).replace(/"/g, '\\"');
  const safeBody = String(body).replace(/"/g, '\\"');
  const script = `display notification "${safeBody}" with title "${safeTitle}"`;
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", script], (err) => {
      if (err) {
        process.stderr.write(
          `[propagate] notification failed (likely permission denied): ${err.message}\n`,
        );
      }
      resolve();
    });
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
