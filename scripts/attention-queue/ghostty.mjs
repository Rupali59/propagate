/**
 * The Ghostty adapter (propagate#445): list terminals and focus one through `osascript`.
 * Ghostty's AppleScript dictionary: windows > tabs > terminals, a terminal has `id` and `tty`, and `focus` brings it up.
 * The binary is PROPAGATE_OSASCRIPT_BIN so tests never run the real one. First use asks macOS for Automation permission.
 */
import { spawnSync } from "node:child_process";

export class GhosttyError extends Error {}

function osascript(lines, inject = {}) {
  const bin = inject.bin ?? process.env.PROPAGATE_OSASCRIPT_BIN ?? "osascript";
  const r = spawnSync(bin, lines.flatMap((l) => ["-e", l]), { encoding: "utf8", timeout: 15000 });
  if (r.error) throw new GhosttyError(`osascript could not run: ${r.error.code ?? r.error.message}`);
  if (r.status !== 0) throw new GhosttyError(`osascript failed (exit ${r.status}): ${String(r.stderr || "").trim() || "no stderr"}`);
  return String(r.stdout ?? "");
}

/** @returns {{id: string, tty: string}[]} */
export function liveTerminals(inject = {}) {
  const out = osascript([
    'if application "Ghostty" is not running then error "Ghostty is not running"',
    'set out to ""',
    'tell application "Ghostty"',
    "repeat with w in windows",
    "repeat with t in tabs of w",
    "repeat with term in terminals of t",
    'set out to out & (id of term) & "\\t" & (tty of term) & linefeed',
    "end repeat",
    "end repeat",
    "end repeat",
    "end tell",
    "return out",
  ], inject);
  const rows = [];
  for (const line of out.split("\n")) {
    const [id, tty] = line.split("\t");
    if (id && tty) rows.push({ id: id.trim(), tty: tty.trim() });
  }
  return rows;
}

export function focus(id, inject = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(id))) throw new GhosttyError(`refusing a terminal id with unexpected characters`);
  osascript([
    'tell application "Ghostty"',
    `set term to first terminal whose id is "${id}"`,
    "focus term",
    "activate",
    "end tell",
  ], inject);
}
