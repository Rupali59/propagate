/**
 * registers() — the derived register census.
 *
 * The two tests that matter most here are NEGATIVE CONTROLS, and they are the
 * reason this file exists rather than a smoke test:
 *
 *   1. An unreadable register must report `unread` WITH ITS PATH, never 0.
 *      `rule:discernment-checks` §6 — a reader that cannot report failure
 *      reports absence instead, and absence is actionable, so it gets acted on.
 *
 *   2. A GOTCHAS.md whose entries are all live must report rotatable = 0 WITH
 *      THE PER-KIND REASON. If a future refactor collapses the per-kind table
 *      into one age filter, this is the test that goes red — without it,
 *      "gotchas never rotate" is a comment rather than a behaviour.
 *
 * These call pure functions against fixture directories only. No CLI is
 * invoked, so the production event store is never in reach (G56).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { registers, rotationCandidates, overCap, LIFECYCLE } from "../../lib/report/registers.mjs";

function fixture(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `registers-${prefix}-`));
}

/** Write a file, creating parents. Returns the absolute path. */
function put(root, rel, body) {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}

const ISSUES_TWO_OPEN_ONE_DONE = `# Issues

### N1 · A live defect — **S2** — OPEN
Body.

### N2 · Another live one — **S1**
Body.

### N3 · Something finished — **S3** — **RESOLVED 2026-08-01**
Body.
`;

// ─────────────────────────────────────────────────────────────────────────────
// The per-kind lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test("issues: a RESOLVED entry is rotatable, an open one is not", () => {
  const root = fixture("issues");
  put(root, "propagation/state/workspace/ISSUES.md", ISSUES_TWO_OPEN_ONE_DONE);

  const r = registers({ searchRoots: [root] });
  const row = r.rows.find((x) => x.kind === "issues");

  assert.ok(row, "the ISSUES.md fixture should be discovered");
  assert.equal(row.entries, 3);
  assert.equal(row.live, 2);
  assert.equal(row.finished, 1);
  assert.equal(row.rotatable, 1);
  assert.equal(row.unread, false);
});

test("NEGATIVE CONTROL — gotchas never rotate, and say why", () => {
  const root = fixture("gotchas-live");
  const g = put(
    root,
    "propagation/state/workspace/GOTCHAS.md",
    `# Gotchas

### G1 · A hazard that still exists
**Trigger:** \`rm -rf\`
**Fires on:** \`rm -rf dist/\`
Body.

### G2 · Another live hazard
Body.

### G3 · RETIRED 2026-08-26 · a hazard whose mechanism is gone
Included on purpose. Without a retired entry in this fixture, \`rotatable\`
would be 0 for the trivial reason that there is nothing finished to rotate,
and the assertion below would pass under a mutation that DID rotate gotchas.
Measured 2026-08-27: that mutation left this very test green until G3 was
added. A negative control that cannot fail is the failure it is named for.
`,
  );

  const r = registers({ searchRoots: [root], gotchasFiles: [g] });
  const row = r.rows.find((x) => x.kind === "gotchas");

  assert.equal(row.entries, 3);
  assert.equal(row.live, 2);
  assert.equal(row.finished, 1, "the fixture must contain something finished, or this proves nothing");
  assert.equal(row.rotatable, 0, "a live hazard must never be rotatable");
  assert.match(
    row.reason,
    /does not expire/,
    "rotatable=0 must carry the per-kind reason, not an empty zero",
  );
  assert.equal(r.totals.rotatable.gotchas, 0);
  assert.equal(LIFECYCLE.gotchas.rotates, false);
});

test("a RETIRED gotcha counts as finished but is still NOT rotatable bulk", () => {
  const root = fixture("gotchas-retired");
  const g = put(
    root,
    "propagation/state/workspace/GOTCHAS.md",
    `# Gotchas

### G1 · A live hazard
Body.

### G6 · RETIRED 2026-08-26 · the submodule three-pointer problem
Kept deliberately: a fixed hazard is still the argument for its fix.
`,
  );

  const r = registers({ searchRoots: [root], gotchasFiles: [g] });
  const row = r.rows.find((x) => x.kind === "gotchas");

  assert.equal(row.finished, 1, "RETIRED is recognised");
  assert.equal(row.live, 1);
  assert.equal(row.rotatable, 0, "retired entries collapse to a tombstone, they are not moved out");
  assert.equal(r.totals.retiredGotchas, 1, "retired gotchas are reported, just not as rotatable");
});

// ─────────────────────────────────────────────────────────────────────────────
// Absence must be attributable
// ─────────────────────────────────────────────────────────────────────────────

test("NEGATIVE CONTROL — a register with an unrecognised shape is `unread`, not zero", () => {
  const root = fixture("unread");
  put(
    root,
    "propagation/state/workspace/ISSUES.md",
    // Long enough not to be classified as an intentional stub, and carrying no
    // entry headings at all — the shape a reader must refuse rather than score.
    `# Issues\n\n${"Prose with no entry headings whatsoever. ".repeat(60)}\n`,
  );

  const r = registers({ searchRoots: [root] });
  const row = r.rows.find((x) => x.kind === "issues");

  assert.equal(row.unread, true, "a shape the reader does not know must be flagged, never scored 0");
  assert.equal(row.rotatable, 0);
  assert.ok(row.reason, "an unread row must carry a reason");
  assert.equal(r.unread.length, 1);
  assert.equal(r.unread[0].file, row.file, "the unread list names the path, so it is actionable");
});

test("a pointer stub is NOT unread — it is counted at its target", () => {
  const root = fixture("stub");
  put(
    root,
    "propagation/state/workspace/GOTCHAS.md",
    "# GOTCHAS.md — moved\n\nThis is a **pointer stub**, not the state. The file now lives elsewhere.\n",
  );
  const g = path.join(root, "propagation/state/workspace/GOTCHAS.md");

  const r = registers({ searchRoots: [root], gotchasFiles: [g] });
  const row = r.rows.find((x) => x.kind === "gotchas");

  assert.equal(row.unread, false, "a stub is working as designed, not a reader failure");
  assert.equal(row.entries, 0);
  assert.match(row.reason, /pointer stub/);
});

// ─────────────────────────────────────────────────────────────────────────────
// N51's shape, one module over
// ─────────────────────────────────────────────────────────────────────────────

test("a heading inside a fenced block is not counted as an entry", () => {
  const root = fixture("fence");
  put(
    root,
    "propagation/state/workspace/ISSUES.md",
    `# Issues

### N1 · A real entry — OPEN
Body.

The format looks like this:

\`\`\`markdown
### N99 · An example in a fence — **RESOLVED 2026-01-01**
\`\`\`

### N2 · A second real entry — **RESOLVED 2026-08-01**
Body.
`,
  );

  const r = registers({ searchRoots: [root] });
  const row = r.rows.find((x) => x.kind === "issues");

  assert.equal(row.entries, 2, "the fenced example must not inflate the entry count");
  assert.equal(row.finished, 1, "and must not inflate the finished count either — N51's exact bug");
  assert.equal(row.rotatable, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation helpers
// ─────────────────────────────────────────────────────────────────────────────

test("rotationCandidates ranks by rotatable bulk, largest first", () => {
  const root = fixture("rank");
  put(root, "a/propagation/state/workspace/ISSUES.md", ISSUES_TWO_OPEN_ONE_DONE);
  put(
    root,
    "b/propagation/state/workspace/ISSUES.md",
    `# Issues\n\n### N1 · done — **RESOLVED**\nx\n\n### N2 · done — **MOOT**\nx\n\n### N3 · done — **CLOSED**\nx\n`,
  );

  const r = registers({ searchRoots: [root] });
  const ranked = rotationCandidates(r, { limit: 5 });

  assert.ok(ranked.length >= 2);
  assert.ok(
    ranked[0].rotatable >= ranked[1].rotatable,
    "candidates must be ordered by how much they would actually shed",
  );
  assert.equal(ranked[0].rotatable, 3);
});

test("overCap reports only registers at or past their cap, largest first", () => {
  const root = fixture("caps");
  put(root, "propagation/state/workspace/ISSUES.md", `# Issues\n\n${"### N1 · x — OPEN\nbody\n".repeat(40)}`);

  const r = registers({ searchRoots: [root] });
  assert.equal(overCap(r, { issues: 100_000 }).length, 0, "a register under cap is not reported");

  const over = overCap(r, { issues: 10 });
  assert.equal(over.length, 1);
  assert.equal(over[0].cap, 10);
  assert.ok(over[0].lines >= 10);
});

test("totals separate rotatable bulk from retired gotchas", () => {
  const root = fixture("totals");
  put(root, "propagation/state/workspace/ISSUES.md", ISSUES_TWO_OPEN_ONE_DONE);
  const g = put(
    root,
    "propagation/state/workspace/GOTCHAS.md",
    "# G\n\n### G1 · live\nx\n\n### G2 · RETIRED\nx\n",
  );

  const r = registers({ searchRoots: [root], gotchasFiles: [g] });

  assert.equal(r.totals.rotatableTotal, 1, "only the resolved issue counts as rotatable bulk");
  assert.equal(r.totals.retiredGotchas, 1, "the retired gotcha is reported separately");
  assert.equal(r.totals.rotatable.gotchas, 0);
});
