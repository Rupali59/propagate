/**
 * claims.mjs — `propagate claims check` (Phase 2, lane 1: the deterministic
 * half only — `claims scan`/`judge`/`render`/`contradict` are later lanes
 * and NOT implemented here).
 *
 * Rendering only. All derivation lives in `lib/claims/check.mjs`, which
 * takes the tree as input and returns structured findings — this file is
 * the only place in the `claims` command surface allowed to print, per
 * `commands/ansi.mjs`'s own rule ("zero of 58 lib/ modules contain an ANSI
 * escape, and none of them print").
 *
 * `--json`: ONLY JSON on stdout. N65 (`propagation/state/workspace/STATE.md`)
 * was filed the same day this lane was written, for exactly the opposite
 * mistake in a sibling command — a human-facing notice printed to stdout
 * ahead of the JSON broke every `--json` consumer with `Unexpected token`.
 * Every human-facing line here goes to `console.error` (stderr) when
 * `--json` is set; in JSON mode nothing but the `console.log(JSON...)` call
 * touches stdout.
 *
 * Import prefix is `../lib/…` from here, not `./lib/…` — G60: a specifier
 * copied out of cli.mjs is relative to the repo root and resolves to a
 * different, non-existent file from inside `commands/`.
 */

import { RESET, DIM, RED, YELLOW, BOLD } from "./ansi.mjs";
import { claimsCheck } from "../lib/claims/check.mjs";
import { WORKSPACES } from "../lib/core/config.mjs";

const CHECK_LABELS = {
  "expired-date": "expired date",
  "footer-stale": "footer date is behind the newest inline date",
  "rotted-citation": "rotted internal citation",
  "dead-concept-token": "concepts: token can never fire",
  "price-literal-drift": "literal not found in its declared downstream",
};

function describe(f) {
  switch (f.check) {
    case "expired-date":
      return `"${f.marker}${f.approx ? " ~" : " "}${f.dateText}" expired ${f.expiredISO} (${f.daysExpired}d ago) — ${f.snippet}`;
    case "footer-stale":
      return `footer says "Last amended: ${f.footer}" but the body carries a newer marker dated ${f.newestInline}`;
    case "rotted-citation":
      if (f.subtype === "self-line") return `cites its own line ${f.citedLine} — ${f.reason} — "${f.context}"`;
      if (f.subtype === "dead-branch") return `cites branch \`${f.branch}\`, absent from ${f.repoRoot} (local + origin) — "${f.context}"`;
      return `cites path \`${f.citedPath}\`, which does not exist — "${f.context}"`;
    case "dead-concept-token":
      return `${f.sourceKey} concepts["${f.section}"] token "${f.token}" — not a substring of ${f.sourceKey}'s own text (sidecar: ${f.sidecar})`;
    case "price-literal-drift":
      return f.direction === "doc-not-in-code"
        ? `doc row "${f.label}" has no match in ${f.downstream}`
        : `${f.downstream} identifier "${f.label}" has no match in the doc`;
    default:
      return JSON.stringify(f);
  }
}

export async function claimsCmd(argv = []) {
  const json = argv.includes("--json");
  const sub = argv[0] === "check" ? "check" : argv[0];

  if (sub !== "check") {
    const msg =
      `unknown claims subcommand: ${sub ?? "(none)"}\n` +
      `usage: propagate claims check [--json]\n` +
      `(scan/judge/render/contradict are later lanes, not yet implemented)`;
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    return 2;
  }

  const result = await claimsCheck({ workspaces: WORKSPACES });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result.files.unreadable.length > 0 || result.sidecars.unreadable.length > 0 ? 1 : 0;
  }

  console.log(`${BOLD}# claims check${RESET}  ${DIM}(deterministic only — no model, no network)${RESET}`);
  console.log(
    `  ${result.coverage.sidecarsChecked} sidecar(s) · ${result.coverage.sourceEdges} declared source(s) · ` +
      `${result.coverage.filesChecked} file(s) checked`,
  );

  // Absence must be attributable (`rule:discernment-checks` §2): a
  // zero-finding run still states what was and was not looked at, so
  // "found nothing" never reads the same as "looked at nothing".
  if (result.sidecars.unreadable.length > 0) {
    console.log(`\n  ${RED}unreadable sidecars (${result.sidecars.unreadable.length})${RESET}`);
    for (const s of result.sidecars.unreadable) console.log(`    ${s.sidecar} — ${s.reason}`);
  }
  if (result.files.unreadable.length > 0) {
    console.log(`\n  ${RED}unreadable files (${result.files.unreadable.length})${RESET}`);
    for (const f of result.files.unreadable) console.log(`    ${f.file} — ${f.reason}`);
  }
  if (result.globsSkipped.length > 0) {
    console.log(
      `\n  ${DIM}skipped (glob downstream, not expanded): ${result.globsSkipped.length}${RESET}`,
    );
  }

  if (result.findings.length === 0) {
    console.log(`\n  no findings — ${result.coverage.filesChecked} file(s) checked, 0 flagged`);
    return 0;
  }

  const byCheck = new Map();
  for (const f of result.findings) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check).push(f);
  }

  for (const [check, items] of byCheck) {
    console.log(`\n  ${YELLOW}${CHECK_LABELS[check] ?? check} (${items.length})${RESET}`);
    for (const f of items) {
      console.log(`    ${f.file}${f.owner ? ` ${DIM}[${f.owner}]${RESET}` : ""}`);
      console.log(`      ${describe(f)}`);
    }
  }

  console.log(`\n  ${result.findings.length} finding(s) total`);
  return 1;
}
