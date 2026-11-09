/**
 * context.mjs — `propagate context --transcript <path.jsonl> [--json]`.
 *
 * Read-only. Reports, per compaction window of one Claude Code session transcript, how many
 * gotcha-guard injections reached the model and how many characters they carried. The measurement
 * is lib/report/context.mjs; this reads the file and renders it.
 *
 * Exit: 0 report printed; 2 could not run (no --transcript, unreadable file, or a file with no
 * parseable lines) — "looked at nothing" is never exit 0 (`rule:discernment-checks` §2).
 */

import { readFileSync } from "node:fs";

import { gotchaContextByWindow } from "../lib/report/context.mjs";

const n = (x) => x.toLocaleString("en-US");

function value(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
}

/**
 * @param {string[]} args argv after the command name
 * @param {{out?: (s: string) => void, err?: (s: string) => void}} [inject] tests
 * @returns {Promise<number>} exit code
 */
export async function contextCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  const file = value(args, "--transcript");
  if (!file) {
    err("context: --transcript <path.jsonl> is required (a Claude Code session transcript)");
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    err(`context: cannot read ${file}: ${e.message}`);
    return 2;
  }
  const records = [];
  let unparsed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      unparsed++;
    }
  }
  if (records.length === 0) {
    err(`context: ${file} has no parseable JSONL lines (${unparsed} unparseable) — this scan has gone blind, it has not found nothing`);
    return 2;
  }
  const report = gotchaContextByWindow(records);
  if (args.includes("--json")) {
    out(JSON.stringify({ transcript: file, lines: records.length, unparsed, ...report }, null, 2));
    return 0;
  }
  out(`gotcha-guard context volume — ${file}`);
  out(`  ${n(records.length)} records${unparsed ? `, ${unparsed} unparseable` : ""}; ${n(report.additionalContextRecords)} hook_additional_context records of any kind`);
  out("");
  out("  window  injections  showings       chars");
  for (const w of report.windows) {
    out(`  ${String(w.window).padStart(6)}  ${String(w.injections).padStart(10)}  ${String(w.showings).padStart(8)}  ${n(w.chars).padStart(10)}`);
  }
  out(`   total  ${String(report.total.injections).padStart(10)}  ${String(report.total.showings).padStart(8)}  ${n(report.total.chars).padStart(10)}`);
  out("");
  out("  Counts only hook_additional_context (what the model reads); the systemMessage twin costs no context.");
  if (report.additionalContextRecords === 0) {
    out("  note: no hook_additional_context records of any kind — check this is a session transcript, not a different file.");
  }
  return 0;
}
