/**
 * cli-commands.test.mjs — the subcommand table (ISSUES N69/N70).
 *
 * THE FIRST TEST IS THE WHOLE POINT OF THE REFACTOR. `lib/core/commands.mjs`
 * replaced a 1756-character usage literal with a data table, and the only thing
 * that makes that a refactor rather than a rewrite of the public interface is
 * proving the rendered line is BYTE-IDENTICAL to the one that shipped.
 *
 * The expected string below was captured from `git show HEAD:cli.mjs` at the
 * moment of the change, not retyped. It is frozen HERE rather than read from
 * HEAD at run time, because after this lands HEAD no longer contains the
 * literal — a test that read it would compare the new thing against itself and
 * pass forever (`rule:discernment-checks` §1, a check that cannot fail).
 *
 * WHEN THIS TEST GOES RED, that is the interface changing. Update the frozen
 * string in the same commit, so the diff shows the usage line moving and a
 * reviewer sees it. That is the intended workflow, not an obstacle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { COMMANDS, renderUsage, validateFlags, resolveCommand } from "../../lib/core/commands.mjs";

/**
 * Captured from HEAD before the table existed. Do not retype; paste.
 *
 * CHANGED ONCE SINCE, deliberately, at offset 617 in `verify`:
 *   was  `[--reason ...]`
 *   now  `[--reason ...|--note ...] [--out-of-order]`
 * `--note` is N69's alias (it was silently ignored twenty times), and
 * `--out-of-order` was READ from argv while appearing in no usage string at all
 * — the sanctioned escape hatch, undocumented, which is half of why N70 went
 * unnoticed. The table would now REFUSE it if it stayed undeclared, so
 * documenting it was forced by the validator rather than remembered.
 */
const FROZEN_USAGE = "usage: node cli.mjs [status|doctor|migrate-refs <workspace> [--apply] [--json]|release --check [--json]|init <dir> [--workspace|--edges-only]|reload|check [--changed|--range <a>..<b>|--staged] [--strict]|drain [--all] [--close <id>[,<id>...] --status <done|wontfix|partial> [--reason ...] [--notes ...] [--closed-by ...]] [--group <correlation_id> ...] [--json]|reconcile [--all] [--inbound] [--group-by glob|node|none] [--ref <ref> | --source-ref <ref> --downstream-ref <ref>] [--json]|why <edge_id> [--all] [--json]|verify (--edge <id>|--node <id>|--glob <pattern>) [--state <STATE>] --disposition <d> [--reason ...|--note ...] [--out-of-order] [--ref <ref> | --source-ref <ref> --downstream-ref <ref>] [--apply] [--json]|bootstrap [--baseline-from-git|--baseline-all|--none] [--bound <n>] [--apply] [--json]|inventory [--json|--emit-rows]|skills [--json]|skills-create <name> <intent>|skills-promote <name>|skills-demote <name>|skills-reap [--apply]|backlog [--json]|goals [--json]|plans [--check] [--root <path> ...] [--json]|ui [--port <n>]|queue [--json]|surface [--json]|graph-index [--emit sqlite|cypher] [--out <path>] [--json]|graph [--all] [--node <path>] [--include-unverified] [--html <path>] [--json]|monitor [--dry-run] [--json]|manifest <workspace> [--json]|docs [<file>...|--all|--kinds|--structure [--tables]|--superseded [<doc>]]|journal --since <iso> [--until <iso>] [--json]|rollup [--check|--dry-run] [--force] [--json]|claims check [--json]|claims judge <file> [--json]|claims render <file> [--apply] [--json]|claims contradict <authored-file> [--json]|claims restate [--json]|claims verdict [--apply] [--json] < verdicts.json|claims answer <file> start|end --run <id> --outcome <o> [--json]|reminders [--list <name>] [--json]|reminders sync [--apply] [--json]]";

test("renderUsage() is byte-identical to the literal it replaced", () => {
  const got = renderUsage();
  if (got !== FROZEN_USAGE) {
    // Point at the first divergence — a 1756-char diff is unreadable otherwise.
    let i = 0;
    while (i < Math.max(got.length, FROZEN_USAGE.length) && got[i] === FROZEN_USAGE[i]) i++;
    assert.fail(
      `usage line changed at offset ${i}\n` +
      `  expected: ...${FROZEN_USAGE.slice(Math.max(0, i - 30), i + 50)}...\n` +
      `  actual  : ...${got.slice(Math.max(0, i - 30), i + 50)}...\n` +
      "If the change is intended, update FROZEN_USAGE in the same commit.",
    );
  }
  assert.equal(got, FROZEN_USAGE);
});

test("the table covers every subcommand, and has not gone thin", () => {
  const n = Object.keys(COMMANDS).length;
  assert.ok(n >= 38, `only ${n} commands in the table — entries were lost in transcription`);
  for (const key of ["status", "verify", "claims check", "reminders sync", "graph-index"]) {
    assert.ok(COMMANDS[key], `${key} is missing from the table`);
  }
});

/* -- the drift closure: args text and flags map cannot disagree ----------- */

test("every flag that APPEARS in a command's usage text is declared in its flags map", () => {
  // The table carries the help text and the allowlist as two fields, so they
  // could drift from each other even though neither can drift from the other
  // file. This is what closes that last gap.
  const missing = [];
  for (const [name, c] of Object.entries(COMMANDS)) {
    if (c.args === null || c.flags === null) continue;   // the recorded gap, asserted separately
    for (const m of c.args.matchAll(/--[a-z][a-z-]*/g)) {
      if (!Object.hasOwn(c.flags, m[0])) missing.push(`${name}: ${m[0]} is in the usage text but not in flags`);
    }
  }
  assert.deepEqual(missing, [], missing.join("\n"));
});

/**
 * Accepted by the CLI, absent from every usage string. Measured 2026-09-26 by
 * sweeping what `commands/*.mjs` actually reads from argv.
 *
 * THIS LIST IS THE FINDING, not an exemption. `--out-of-order` was in exactly
 * this state — read from argv, documented nowhere — and that is half of why an
 * override could be used for months without anyone being able to search for it
 * (N70). These 37 are the rest of that population, now at least VALIDATED (so a
 * typo is refused) and NAMED (so the documentation gap is bounded rather than
 * unknown).
 *
 * It may SHRINK — never grow. Shrinking means someone wrote the flag into its
 * command's `args` text, which is the actual fix.
 *
 * The `claims *` rows are deliberately over-broad: one module parses every
 * claims subcommand, so it reads `--outcome` whichever one is invoked. Declaring
 * them per-subcommand is permissive rather than wrong, and permissive here
 * cannot refuse a flag that works.
 */
const UNDOCUMENTED = [
  "check --json",
  "claims answer --apply",
  "claims answer --reason",
  "claims check --apply",
  "claims check --outcome",
  "claims check --reason",
  "claims check --run",
  "claims contradict --apply",
  "claims contradict --outcome",
  "claims contradict --reason",
  "claims contradict --run",
  "claims judge --apply",
  "claims judge --outcome",
  "claims judge --reason",
  "claims judge --run",
  "claims render --outcome",
  "claims render --reason",
  "claims render --run",
  "claims restate --apply",
  "claims restate --outcome",
  "claims restate --reason",
  "claims restate --run",
  "claims verdict --outcome",
  "claims verdict --reason",
  "claims verdict --run",
  "docs --check",
  "docs --doctrine",
  "docs --dry-run",
  "docs --force",
  "docs --json",
  "docs --reference",
  "docs --undeclared",
  "doctor --json",
  "drain --cross",
  "reminders --apply",
  "reminders sync --list",
  "status --all",
  "status --cross",
  "status --json"
];

test("the undocumented-but-working set is exactly the one recorded", () => {
  const actual = [];
  for (const [name, c] of Object.entries(COMMANDS)) {
    if (c.args === null || c.flags === null) continue;
    for (const f of Object.keys(c.flags)) if (!c.args.includes(f)) actual.push(`${name} ${f}`);
  }
  assert.deepEqual(actual.sort(), [...UNDOCUMENTED].sort(),
    "the set of accepted-but-undocumented flags changed.\n" +
    "  Shrinking is the fix: add the flag to its command's `args` text.\n" +
    "  Growing means a flag was accepted without being written down — N70's shape.");
});

/* -- validateFlags ------------------------------------------------------- */

test("a known flag passes, an unknown one is refused and names a near miss", () => {
  assert.equal(validateFlags(["verify", "--edge", "X", "--disposition", "propagated", "--apply"]).ok, true);

  const bad = validateFlags(["verify", "--edge", "X", "--resaon", "oops"]);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "unknown-flag");
  assert.match(bad.message, /--resaon/);
  assert.match(bad.message, /did you mean --reason\?/);
});

test("a VALUE flag's argument is skipped, so reason text mentioning a flag is not refused", () => {
  // The case that makes `value` vs `boolean` load-bearing rather than tidy.
  const r = validateFlags(["verify", "--reason", "see --edge for why", "--apply"]);
  assert.equal(r.ok, true, JSON.stringify(r));

  // And the negative control: with the kind wrong, this WOULD be refused.
  assert.equal(COMMANDS.verify.flags["--reason"], "value",
    "--reason must take a value, or reason text containing a flag is rejected");
});

test("--flag=value is refused rather than silently ignored", () => {
  // get() reads args[indexOf(flag)+1], so the = form yields undefined. Accepting
  // it would be N69 again: an argument that looks taken and is not.
  const r = validateFlags(["verify", "--edge=X"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "equals-form");
  assert.match(r.message, /--edge <value>/);
});

test("a flag valid for ONE command is refused for another", () => {
  // Without this the allowlist could be a single global set and still pass.
  assert.equal(validateFlags(["bootstrap", "--bound", "5"]).ok, true);
  const r = validateFlags(["status", "--bound", "5"]);
  assert.equal(r.ok, false, "--bound belongs to bootstrap, not status");
});

test("an unknown MODE is not this module's error to report", () => {
  // cli.mjs already prints `unknown mode: X` and exits 2. Inventing a second
  // message here would be two truths about one failure.
  const r = validateFlags(["nosuchmode", "--whatever"]);
  assert.equal(r.ok, true);
  assert.equal(r.name, null);
});

test("two-word modes resolve to themselves, not to their first token", () => {
  assert.equal(resolveCommand(["reminders", "sync", "--apply"]).name, "reminders sync");
  assert.equal(resolveCommand(["reminders", "--json"]).name, "reminders");
  assert.equal(resolveCommand(["claims", "check"]).name, "claims check");
});

/* -- the gap, named and bounded ------------------------------------------ */

/**
 * Handled by cli.mjs, documented by no usage string, flags not yet enumerated.
 * This list may SHRINK — never grow. Growing means a new subcommand shipped
 * without documentation and without flag validation, which is the N69 hazard
 * arriving in a new place.
 */
const UNVALIDATED = [
  "caps", "freeze-ledger", "migrate", "migrate-ledger",
  "registers", "relocate-ledger", "rules", "setup",
];

test("the unvalidated set is exactly the one recorded — it may shrink, never grow", () => {
  const actual = Object.entries(COMMANDS).filter(([, c]) => c.flags === null).map(([n]) => n).sort();
  assert.deepEqual(actual, [...UNVALIDATED].sort(),
    "the set of commands skipping flag validation changed.\n" +
    "  Shrinking is good: transcribe its usage line and give it a flags map.\n" +
    "  Growing means a subcommand shipped with neither docs nor validation.");
});

test("EVERY mode cli.mjs dispatches is in the table — the gap cannot hide a new one", async () => {
  // rule:enforcement-watches-itself: a table that silently omits a mode reports
  // success while validating nothing for it. Read the dispatch, not a list.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const cli = readFileSync(path.join(import.meta.dirname, "../../cli.mjs"), "utf8");

  const handled = [...new Set([...cli.matchAll(/mode === "([a-z][a-z-]*)"/g)].map((m) => m[1]))];
  assert.ok(handled.length >= 35,
    `only ${handled.length} dispatched modes found — the extraction has gone blind, which is ` +
    "worse than failing: it would report full coverage of nothing");

  const firstTokens = new Set(Object.keys(COMMANDS).map((k) => k.split(" ")[0]));
  const missing = handled.filter((m) => !firstTokens.has(m)).sort();
  assert.deepEqual(missing, [],
    `cli.mjs dispatches these and the table does not list them, so they are neither ` +
    `documented nor validated: ${missing.join(", ")}`);
});
