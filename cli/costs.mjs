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

import { readCosts, summarizeWindow, WINDOW_ATTRIBUTION } from "../lib/core/costs.mjs";
import { HOME } from "../lib/core/paths.mjs";

const n = (x) => x.toLocaleString("en-US");

function value(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
}

const laneTokens = (r) => (r.usage ? Object.values(r.usage).reduce((a, b) => a + (Number(b) || 0), 0) : null);

/**
 * `costs lanes` (propagate#251): lane rows grouped by agent_type, the last row per agent_id (resumed lanes write
 * cumulative rows, #233). `backgrounded` counts lanes that ran a tool with run_in_background: such a lane ended
 * rather than waited. A row with no backgrounded field predates #251 and is counted as unknown, never as 0.
 */
export function laneGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.agent_type || "(none)";
    const g = groups.get(key) ?? { agent_type: key, lanes: 0, tokens: 0, unread: 0, minutes: 0, backgrounded: 0, backgroundedUnknown: 0 };
    g.lanes++;
    const t = laneTokens(r);
    if (t === null) g.unread++;
    else g.tokens += t;
    g.minutes += Number(r.minutes) || 0;
    if (r.backgrounded === undefined || r.backgrounded === null) g.backgroundedUnknown++;
    else if (r.backgrounded > 0) g.backgrounded++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens);
}

function costsLanes(rest, inject, out, err) {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--since" || rest[i] === "--agent-type") i++;
    else if (rest[i] !== "--json") {
      err(`costs lanes: unknown argument ${rest[i]}`);
      return 2;
    }
  }
  const since = value(rest, "--since") ?? undefined;
  const type = value(rest, "--agent-type");
  const read = inject.readCosts ?? readCosts;
  const { rows, malformed } = read({ lanesOnly: true, since });
  const picked = type ? rows.filter((r) => r.agent_type === type) : rows;
  const groups = laneGroups(picked);
  if (rest.includes("--json")) {
    out(JSON.stringify({ since: since ?? null, agent_type: type ?? null, lanes: picked.length, malformed, groups }, null, 2));
    return 0;
  }
  if (!picked.length) {
    out(`costs lanes: 0 lane rows${type ? ` for agent_type ${type}` : ""}${since ? ` since ${since}` : ""} (${malformed} malformed lines)`);
    return 0;
  }
  out(`${picked.length} lanes${since ? ` since ${since}` : ""} (last row per agent_id${malformed ? `; ${malformed} malformed lines skipped` : ""})`);
  for (const g of groups) {
    const bg = g.backgrounded ? `, ${g.backgrounded} BACKGROUNDED (ended, did not wait)` : "";
    const unk = g.backgroundedUnknown ? `, ${g.backgroundedUnknown} before #251 (background unknown)` : "";
    out(`  ${g.agent_type.padEnd(32)} ${String(g.lanes).padStart(4)} lanes  ${n(g.tokens)} tokens  ${Math.round(g.minutes)} min${g.unread ? `, ${g.unread} unreadable` : ""}${bg}${unk}`);
  }
  return 0;
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
  if (args[0] === "lanes") return costsLanes(args.slice(1), inject, out, err);
  if (args[0] !== "window") {
    err("costs: usage: costs lanes [--since <ts>] [--agent-type <t>] [--json] | costs window --transcript <jsonl> --from <ts|anchor:re> --to <ts|anchor:re> [--since <ts>] [--until <ts>] [--json]");
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
