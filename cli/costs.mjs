/**
 * costs.mjs — `propagate costs window --transcript <jsonl> --from <ts|anchor:re> --to <ts|anchor:re>
 * [--since <ts>] [--until <ts>] [--json]`.
 *
 * Read-only. Tokens and minutes for a window of a main-session transcript (propagate#233); the
 * measurement is summarizeWindow in lib/core/costs.mjs. Exit: 0 printed; 2 could not run or could
 * not resolve (anchor-not-found, from-after-to, bad input) — no numbers are printed then.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { summarizeWindow, WINDOW_ATTRIBUTION } from "../lib/core/costs.mjs";
import { HOME } from "../lib/core/paths.mjs";

const n = (x) => x.toLocaleString("en-US");

function value(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
}

/** Newest .jsonl directly under ~/.claude/projects/<cwd with / and . as ->/, or null. */
export function newestTranscript(cwd = process.cwd(), home = HOME) {
  const dir = path.join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
  if (!existsSync(dir)) return null;
  let best = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = path.join(dir, f);
    const mtime = statSync(p).mtimeMs;
    if (!best || mtime > best.mtime) best = { path: p, mtime };
  }
  return best ? best.path : null;
}

/**
 * @param {string[]} args argv after the command name (starts with `window`)
 * @param {{out?: (s: string) => void, err?: (s: string) => void}} [inject] tests
 * @returns {Promise<number>} exit code
 */
export async function costsCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  if (args[0] !== "window") {
    err("costs: usage: costs window --transcript <jsonl> --from <ts|anchor:re> --to <ts|anchor:re> [--since <ts>] [--until <ts>] [--json]");
    return 2;
  }
  const rest = args.slice(1);
  const from = value(rest, "--from");
  const to = value(rest, "--to");
  if (!from || !to) {
    err("costs window: --from and --to are required (an ISO timestamp, or anchor:<regex>)");
    return 2;
  }
  let transcript = value(rest, "--transcript");
  let picked = false;
  if (!transcript) {
    transcript = newestTranscript();
    picked = true;
    if (!transcript) {
      err("costs window: no --transcript given and no .jsonl under this project's ~/.claude/projects/ directory");
      return 2;
    }
  }
  const r = summarizeWindow(transcript, {
    from,
    to,
    since: value(rest, "--since") ?? undefined,
    until: value(rest, "--until") ?? undefined,
  });
  if (r.error) {
    err(`costs window: ${r.error}${r.which ? ` (${r.which})` : ""}${r.reason ? `: ${r.reason}` : ""}${r.value ? `: ${r.value}` : ""}`);
    if (r.error === "anchor-not-found") err("  no numbers are printed: a zero here would be indistinguishable from a quiet window.");
    return 2;
  }
  if (rest.includes("--json")) {
    out(JSON.stringify({ transcript, ...r }, null, 2));
    return 0;
  }
  out(`costs window — ${transcript}${picked ? " (newest transcript picked: no --transcript given)" : ""}`);
  out(`  from  ${r.from_ts}${r.from_anchor ? `  matched: ${r.from_anchor}` : ""}`);
  out(`  to    ${r.to_ts}${r.to_anchor ? `  matched: ${r.to_anchor}` : ""}`);
  out(`  until ${r.until ?? "none"}  (${r.until_source})`);
  out(`  ${r.minutes} min, ${n(r.api_calls)} API calls${r.models.length ? `, ${r.models.join(", ")}` : ""}`);
  out(`  input ${n(r.usage.input)}  output ${n(r.usage.output)}  cache_create ${n(r.usage.cache_create)}  cache_read ${n(r.usage.cache_read)}`);
  out(`  total tokens ${n(r.total)}`);
  out(`  ${WINDOW_ATTRIBUTION}`);
  return 0;
}
