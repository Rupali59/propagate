/**
 * lib/report/goals.mjs — goal states: the arrival conditions `NORTH_STAR.md`
 * deliberately does not carry.
 *
 * Pure parsing over synthetic GOALS.md text. It reads the same
 * `**Done when:**` / `**Resolved:**` three-state that `handovers.mjs` reads,
 * and adds one axis of its own: whether a derivation was CLAIMED.
 *
 * THIS READER NEVER EXECUTES A `Derived by:` COMMAND, and the test below pins
 * that. The plan this came from asked for goals whose derivation command
 * "was actually run", with an erroring command reported as unknown — but
 * `handovers.mjs` refuses exactly that, in its own words: *"Deriving 'closed'
 * would mean executing shell written inside a markdown file — a hole wide
 * enough to drive anything through."* Running it here would reintroduce the
 * hole one module over. The condition is REPORTED so a person runs it.
 *
 * So the axis is claimed / waived / NEITHER, and the third is the defect worth
 * finding: a goal asserting an arrival condition nobody can check, which does
 * not admit that it cannot be checked (`rule:discernment-checks` §2 — "not
 * mechanically derivable" and "nobody checked" are different facts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseGoalsFile, goalCounts } from "../../lib/report/goals.mjs";

function goalsFile(body) {
  const dir = mkdtempSync(path.join(tmpdir(), "goals-"));
  const p = path.join(dir, "GOALS.md");
  writeFileSync(p, body, "utf8");
  return p;
}

test("a goal with Done when + Derived by is open, and its derivation is CLAIMED", () => {
  const p = goalsFile(`# W — goal states

## 1 · One propagation standard

**Done when:** every workspace conforms to the v3 layout.
**Derived by:** \`node cli.mjs doctor\`
`);
  const r = parseGoalsFile(p);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].status, "open");
  assert.equal(r.entries[0].derivation, "claimed");
});

test("a goal that declares itself non-derivable is WAIVED, not a defect", () => {
  const p = goalsFile(`# W

## 1 · Every direction has an arrival condition

**Done when:** each direction line has a goal state.
**Judgement, not derivable:** counting files answers a different question.
`);
  const r = parseGoalsFile(p);
  assert.equal(r.entries[0].derivation, "waived");
  assert.equal(r.entries[0].status, "open");
});

test("a goal with NEITHER is the defect — uncheckable, and it does not say so", () => {
  const p = goalsFile(`# W

## 1 · Be excellent

**Done when:** things are good.
`);
  const r = parseGoalsFile(p);
  assert.equal(r.entries[0].derivation, "none");
  assert.equal(
    goalCounts([r]).uncheckable,
    1,
    "an arrival condition nobody can check, which does not admit it, is the thing this reader exists to surface",
  );
});

test("a section with neither Done when nor Resolved is UNKNOWN, never closed", () => {
  // The whole reason three states exist. Defaulting this to closed would
  // report prose as finished work.
  const p = goalsFile(`# W

## 1 · A heading and some prose

We talked about this once and wrote nothing down.
`);
  const r = parseGoalsFile(p);
  assert.equal(r.entries[0].status, "unknown");
  assert.notEqual(r.entries[0].status, "closed");
});

test("Resolved closes a goal", () => {
  const p = goalsFile(`# W

## 1 · The migration

**Resolved:** 2026-09-14 — all 16 workspaces conform.
`);
  const r = parseGoalsFile(p);
  assert.equal(r.entries[0].status, "closed");
});

test("a GOALS.md with no parseable sections is UNREAD, not empty", () => {
  // registers.mjs draws exactly this line: a reader that cannot understand its
  // input must say so rather than return zero (`rule:discernment-checks` §6).
  const p = goalsFile(`# W

Some prose with no section headings at all.
`);
  const r = parseGoalsFile(p);
  assert.equal(r.entries.length, 0);
  assert.equal(r.unread, true, "zero sections and an unrecognised shape are different facts");
  assert.ok(r.reason, "and the reason must be attributable");
});

test("the reader does not execute Derived by, even when told to", () => {
  // The load-bearing safety assertion. A command that would leave a trace is
  // given to the parser; the trace must not appear.
  const dir = mkdtempSync(path.join(tmpdir(), "goals-exec-"));
  const canary = path.join(dir, "CANARY");
  const p = path.join(dir, "GOALS.md");
  writeFileSync(
    p,
    `# W\n\n## 1 · A goal\n\n**Done when:** never.\n**Derived by:** \`touch ${canary}\`\n`,
    "utf8",
  );
  const r = parseGoalsFile(p);
  assert.equal(r.entries[0].derivation, "claimed");
  assert.equal(
    existsSync(canary),
    false,
    "parseGoalsFile must NEVER run a Derived by: command — that is shell from a markdown file",
  );
});

// The command a report PRINTS will be pasted by whoever reads it, so a
// fragment that looks like a command is worse than none. Both of these were
// real defects on the first GOALS.md written.
test("a fenced Derived by: block yields the command, not the fence marker", () => {
  const p = goalsFile(`# W

## 1 · Registries reconcile

**Done when:** no unexplained rows.
**Derived by:**

\`\`\`sh
bash scripts/deploy-check.sh
bash scripts/mongo-check.sh
\`\`\`
`);
  const r = parseGoalsFile(p);
  assert.equal(r.entries[0].derivation, "claimed");
  assert.match(r.entries[0].command, /deploy-check\.sh/);
  assert.doesNotMatch(r.entries[0].command, /```/, "the fence marker is not a command");
  assert.match(r.entries[0].command, /mongo-check\.sh/, "every line of the block survives");
});

test("a fenced block with trailing # comments does not swallow later commands", () => {
  // Measured on the first real GOALS.md: joining these with " ; " put the
  // second command behind the first one's comment, so only deploy-check ran.
  // Silently doing half the job is worse than failing.
  const p = goalsFile(`# W

## 1 · Registries

**Done when:** clean.
**Derived by:**

\`\`\`sh
bash a.sh   # EMPTY rows are the gaps
bash b.sh   # SHARED rows lose data
\`\`\`
`);
  const cmd = parseGoalsFile(p).entries[0].command;
  assert.doesNotMatch(
    cmd.split("\n")[0],
    /b\.sh/,
    "the second command must not be appended onto the first line, behind its comment",
  );
  assert.equal(cmd.split("\n").length, 2, "one line per command");
});

test("a backslash-continued command is rejoined, not split into a broken one", () => {
  // `git ls-files \ ; | grep …` reads like a command and fails if pasted.
  const p = goalsFile(`# W

## 1 · No product logic

**Done when:** zero app files tracked.
**Derived by:**

\`\`\`sh
cd ~/x && git ls-files \\
  | grep -cE '\\.(tsx|jsx)$' || true
\`\`\`
`);
  const r = parseGoalsFile(p);
  const cmd = r.entries[0].command;
  assert.doesNotMatch(cmd, /\\\s*;/, "a line continuation must not become a command separator");
  assert.match(cmd, /git ls-files \| grep/, "the continued command is rejoined into one");
});

test("an explanatory clause after the command is not part of the command", () => {
  const p = goalsFile(`# W

## 1 · One standard

**Done when:** all conform.
**Derived by:** \`node cli.mjs doctor\` — the conformance line under Discovery integrity.
`);
  const r = parseGoalsFile(p);
  assert.equal(r.entries[0].command, "node cli.mjs doctor");
});

test("counts separate open / closed / unknown and never merge unknown into either", () => {
  const p = goalsFile(`# W

## 1 · Open one
**Done when:** x.
**Derived by:** \`cmd\`

## 2 · Closed one
**Resolved:** 2026-09-14 — done.

## 3 · Unknown one
Just prose.
`);
  const c = goalCounts([parseGoalsFile(p)]);
  assert.deepEqual(
    { open: c.open, closed: c.closed, unknown: c.unknown },
    { open: 1, closed: 1, unknown: 1 },
  );
  assert.equal(c.total, 3);
});
