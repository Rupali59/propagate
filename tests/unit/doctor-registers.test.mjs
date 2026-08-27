/**
 * Tests for lib/report/doctor/registers.mjs.
 *
 * WHY THIS FILE EXISTS, and it is not a happy accident. `# Registers` shipped
 * with two `check()` labels and no test that could make either fail, and
 * `tests/cli/doctor-check-coverage.test.mjs` caught it on the first full run:
 *
 *     these doctor checks have no test that makes them fail:
 *       registers readable
 *       every register could be read
 *
 * That guard is `rule:discernment-checks` §1 mechanised — every check ships
 * with the input that makes it fail — and it did its job on the person adding a
 * section to the very tool it guards. The correct response was to construct
 * those two inputs, not to add the labels to KNOWN_UNCOVERED.
 *
 * Injected data throughout, deliberately: on the day this landed the real tree
 * had 0 unread registers, so a test that only exercised reality could never
 * show the failing path.
 *
 * Run: `npm test` (G56).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { checkRegisters } from "../../lib/report/doctor/registers.mjs";

const noGotchas = () => [];

/** A census with nothing wrong: work outstanding, but every file readable. */
const healthy = () => ({
  rows: [
    { kind: "issues", file: "/x/ISSUES.md", lines: 900, entries: 40, live: 30, finished: 10, rotatable: 10, reason: null, unread: false },
    { kind: "gotchas", file: "/x/GOTCHAS.md", lines: 400, entries: 12, live: 12, finished: 0, rotatable: 0, reason: "a hazard does not expire", unread: false },
  ],
  totals: {
    files: 2,
    hot: { issues: 30, handovers: 0, todos: 0, gotchas: 12 },
    rotatable: { issues: 10, handovers: 0, todos: 0, gotchas: 0 },
    retiredGotchas: 0,
    rotatableTotal: 10,
    dropped: [],
  },
  unread: [],
});

test("a healthy census passes and adds no problems", async () => {
  const r = new Reporter();
  const { counts } = await checkRegisters({ reporter: r, registersFn: healthy, gotchasSourcesFn: noGotchas });

  assert.equal(r.problems, 0);
  assert.equal(counts.registerFiles, 2);
  assert.equal(counts.rotatable, 10);
  assert.ok(r.entries.some((e) => e.kind === "pass"), "the check must actually run, not be skipped");
});

test("rotatable work alone NEVER makes doctor red", async () => {
  // The property the section rests on, and the same one `# Backlog` rests on.
  // Finished entries sitting in a hot file are a chore, not a defect. If they
  // voted, doctor would be permanently red here and the section would be
  // skipped — the same outcome as not having it.
  const r = new Reporter();
  await checkRegisters({ reporter: r, registersFn: healthy, gotchasSourcesFn: noGotchas });
  assert.equal(r.problems, 0);

  const text = r.entries.map((e) => `${e.label} ${e.detail ?? ""}`).join("\n");
  assert.match(text, /10 resolved issue/, "the chore is still reported, just not as a verdict");
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO FAILING CASES the coverage guard demanded
// ─────────────────────────────────────────────────────────────────────────────

test("FAILING CASE — an unread register makes it red and NAMES the path", async () => {
  const r = new Reporter();
  const { counts } = await checkRegisters({
    reporter: r,
    gotchasSourcesFn: noGotchas,
    registersFn: () => {
      const base = healthy();
      const bad = {
        kind: "issues",
        file: "/x/BROKEN.md",
        lines: 12,
        entries: 0,
        live: 0,
        finished: 0,
        rotatable: 0,
        reason: "format not recognised",
        unread: true,
      };
      return { ...base, rows: [...base.rows, bad], unread: [bad] };
    },
  });

  assert.equal(r.problems, 1, "a register that could not be read is a verdict, not a warning");
  assert.equal(counts.unread, 1);

  const text = r.entries.map((e) => `${e.label} ${e.detail ?? ""}`).join("\n");
  assert.match(text, /\/x\/BROKEN\.md/, "a count sends nobody anywhere — the file must be named");
  assert.match(text, /format not recognised/, "and the reason must travel with it");
});

test("FAILING CASE — a census that THROWS is a failure, never an empty tree", async () => {
  // rule:discernment-checks §2 and §6. "0 registers" from a census that threw
  // is indistinguishable from a tree with no registers, and only one of those
  // is health. A reader that cannot report failure reports absence instead.
  const r = new Reporter();
  const { counts } = await checkRegisters({
    reporter: r,
    gotchasSourcesFn: noGotchas,
    registersFn: () => {
      throw new Error("walk exploded");
    },
  });

  assert.equal(r.problems, 1, "a census that threw must vote red");
  assert.equal(counts.registerFiles, 0);
  const text = r.entries.map((e) => `${e.label} ${e.detail ?? ""}`).join("\n");
  assert.match(text, /walk exploded/, "the underlying error must reach the reader");
});

// ─────────────────────────────────────────────────────────────────────────────
// Reporting that must not be lost
// ─────────────────────────────────────────────────────────────────────────────

test("dropped subtrees are reported BY REASON, not lumped as one cause", async () => {
  // An earlier draft rendered every dropped subtree as "exceeded the walk
  // budget". Measured against the real tree, all 59 were the depth limit and
  // none was budget exhaustion — attributing one cause to the other is worse
  // than saying nothing, because it sends the reader to the wrong remedy.
  const r = new Reporter();
  await checkRegisters({
    reporter: r,
    gotchasSourcesFn: noGotchas,
    registersFn: () => {
      const base = healthy();
      base.totals.dropped = [
        { path: "/x/a", reason: "max depth 6 reached -- not walked further" },
        { path: "/x/b", reason: "max depth 6 reached -- not walked further" },
        { path: "/x/c", reason: "walk budget exhausted" },
      ];
      return base;
    },
  });

  const text = r.entries.map((e) => `${e.label} ${e.detail ?? ""}`).join("\n");
  assert.match(text, /2 × max depth 6/);
  assert.match(text, /1 × walk budget exhausted/);
  assert.equal(r.problems, 0, "an unwalked subtree is context, not a verdict");
});

test("retired gotchas are reported but never counted as rotatable", async () => {
  const r = new Reporter();
  const { counts } = await checkRegisters({
    reporter: r,
    gotchasSourcesFn: noGotchas,
    registersFn: () => {
      const base = healthy();
      base.totals.retiredGotchas = 3;
      return base;
    },
  });

  const text = r.entries.map((e) => `${e.label} ${e.detail ?? ""}`).join("\n");
  assert.match(text, /3 —/, "retired gotchas must be visible");
  assert.match(text, /argument for its fix/, "with the reason they are kept");
  assert.equal(counts.rotatable, 10, "and must NOT be folded into the rotatable total");
});
