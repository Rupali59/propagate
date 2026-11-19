/**
 * search-usage.mjs — `propagate search-usage [--since <date>] [--until <date>] [--project <substr>] [--json]`.
 *
 * Read-only: derives external-search use from the transcripts under ~/.claude/projects/ and writes only to
 * stdout. The measurement is lib/report/search-usage.mjs; this parses flags and renders it.
 *
 * Exit: 0 report printed; 2 could not run (bad flag value, or fewer than the floor of transcripts in scope:
 * "the scan has gone blind" is never a clean zero, `rule:discernment-checks` §2).
 */

import { searchUsage, SOURCES } from "../lib/report/search-usage.mjs";

const n = (x) => x.toLocaleString("en-US");
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function value(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

/**
 * @param {string[]} args argv after the command name
 * @param {{out?: (s: string) => void, err?: (s: string) => void}} [inject] tests
 * @returns {Promise<number>} exit code
 */
export async function searchUsageCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  let report;
  try {
    report = searchUsage({ since: value(args, "--since"), until: value(args, "--until"), project: value(args, "--project") });
  } catch (e) {
    err(`search-usage: ${e.message}`);
    return 2;
  }
  if (report.blind) {
    err(`search-usage: ${report.reason} — the scan has gone blind, it has not found nothing`);
    return 2;
  }
  if (args.includes("--json")) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  const t = report.transcripts;
  const span = [report.span.since && `since ${report.span.since}`, report.span.until && `until ${report.span.until}`, report.span.project && `project ~ ${report.span.project}`].filter(Boolean);
  out(`external search use — ${n(t.scanned)} transcripts (${n(t.top_level)} sessions, ${n(t.subagent)} subagent)${span.length ? `; ${span.join(", ")}` : ""}`);
  out("");
  out("  source                    calls   is_error  not_found       429  timeout      dns");
  for (const id of Object.keys(SOURCES)) {
    const s = report.sources[id];
    const f = s.failures;
    out(`  ${s.label.padEnd(22)} ${String(n(s.calls)).padStart(7)}  ${String(f.is_error).padStart(8)}  ${String(f.not_found).padStart(9)}  ${String(f.rate_limited).padStart(8)}  ${String(f.timeout).padStart(7)}  ${String(f.dns).padStart(7)}`);
  }
  out("");
  const ts = report.toolsearch;
  out(`  ToolSearch loads: ${n(ts.total)} total; ` + Object.entries(ts).filter(([k, v]) => k !== "total" && v > 0).map(([k, v]) => `${k} ${v}`).join(", "));
  const w = report.websearch;
  out(`  WebSearch: ${n(w.total)} calls, ${n(w.distinct)} distinct queries; exact-repeat rate ${pct(w.exact_repeat_rate)}, one-off rate ${pct(w.one_off_rate)}`);
  out("    topics: " + Object.entries(w.buckets).map(([k, v]) => `${k} ${v}`).join(", "));
  out("");
  out("  Failures are read from each call's own result. is_error is counted on its own; the other columns classify");
  out("  an error's text, or WebFetch's leading 'The server returned HTTP <code>'. Words in other tools' output never count.");
  return 0;
}
