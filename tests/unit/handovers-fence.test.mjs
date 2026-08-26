/**
 * Fenced code blocks are prose ABOUT the format, not the format (N51).
 *
 * Documenting this module's own marker protocol inside `HANDOVERS.md` minted a
 * phantom section: the example carried a dated `## …` heading followed by
 * `**Resolved:** …`, both inside a ```markdown fence, and the parser read them
 * as real. Measured 2026-08-26: 16 sections became 17 and the phantom reported
 * **closed** — the one state that makes work disappear, reached by quoting the
 * documentation.
 *
 * It was worked around first (the example heading was written `<YYYY-MM-DD>`,
 * which SECTION_RE cannot match) and fixed second. These tests pin the fix so
 * the workaround can be removed.
 *
 * Run: `npm test` (G56).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseHandovers } from "../../lib/report/handovers.mjs";

function withFile(body, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "handover-fence-"));
  const file = path.join(dir, "HANDOVERS.md");
  writeFileSync(file, body);
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("a dated heading INSIDE a fence is not a section — the N51 shape exactly", () => {
  const body = [
    "# Handovers", "",
    "## 2026-08-01 · a real section", "",
    "**Done when:** something measurable", "",
    "Here is how to close one:", "",
    "```markdown",
    "## 2026-08-26 · A thing handed over",
    "**Resolved:** 2026-08-26 — what happened",
    "```", "",
    "more prose",
  ].join("\n");
  withFile(body, (f) => {
    const r = parseHandovers(f);
    assert.equal(r.sections.length, 1, "the fenced example must not become a section");
    assert.equal(r.sections[0].title, "a real section");
    assert.equal(r.totals.closed, 0, "and above all it must not report a CLOSED one");
    assert.equal(r.sections[0].status, "open", "the real section keeps its own status");
  });
});

test("a `**Resolved:**` inside a fence cannot close the section containing it", () => {
  // The dangerous direction. Without fence tracking this section reads closed,
  // and closed is the only state that makes work vanish.
  const body = [
    "# Handovers", "",
    "## 2026-08-01 · still open", "",
    "```",
    "**Resolved:** 2026-08-02 — this is an EXAMPLE, not a declaration",
    "```", "",
  ].join("\n");
  withFile(body, (f) => {
    const r = parseHandovers(f);
    assert.equal(r.sections.length, 1);
    assert.notEqual(r.sections[0].status, "closed", "an illustration must never discharge real work");
  });
});

test("tildes fence too, and an unclosed fence does not swallow the rest of the file", () => {
  const body = [
    "# Handovers", "",
    "~~~", "## 2026-08-05 · fenced with tildes", "~~~", "",
    "## 2026-08-06 · real, after the fence closes", "",
    "**Done when:** x",
  ].join("\n");
  withFile(body, (f) => {
    const r = parseHandovers(f);
    assert.deepEqual(r.sections.map((s) => s.title), ["real, after the fence closes"]);
  });
});

test("a REAL marker directly under a heading still works — the fix must not break the happy path", () => {
  const body = [
    "# Handovers", "",
    "## 2026-08-01 · done thing", "",
    "**Resolved:** 2026-08-02 — shipped", "",
    "## 2026-08-03 · live thing", "",
    "**Done when:** the check passes", "",
  ].join("\n");
  withFile(body, (f) => {
    const r = parseHandovers(f);
    assert.deepEqual(r.totals, { open: 1, closed: 1, unknown: 0 });
  });
});

test("a fence between heading and marker CONSUMES the window, so the marker is out of range", () => {
  // Deliberate. A section-level marker belongs directly under its heading,
  // before any illustration. Not consuming fenced lines would widen
  // MARKER_WINDOW by an arbitrary amount and re-open the false-close door.
  const body = [
    "# Handovers", "",
    "## 2026-08-01 · thing", "",
    "```", "a", "b", "c", "d", "```", "",
    "**Resolved:** 2026-08-02 — too far below the heading to be a declaration",
  ].join("\n");
  withFile(body, (f) => {
    const r = parseHandovers(f);
    assert.equal(r.sections[0].status, "unknown", "distance still counts, fenced or not");
  });
});
