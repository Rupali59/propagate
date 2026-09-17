/**
 * Editing a hand-written register — the one place in this repo that rewrites
 * prose somebody meant.
 *
 * These tests are mostly about REFUSAL, which is the right proportion. A bad
 * write here does not append a junk row to an append-only store; it destroys a
 * sentence, and markdown has no compiler to notice.
 *
 * The three guarantees, each with the input that violates it:
 *
 *   1. line-anchored, re-read immediately before writing
 *   2. exactly one line changes, asserted rather than assumed
 *   3. nothing is written that was not previewed
 *
 * `rule:safety-flag-needs-a-test` is the governing rule: every test below
 * measures the SIDE EFFECT — the bytes on disk — never the return value alone.
 * Three separate incidents in this tree came from trusting a function's own
 * description of what it does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  planIssueClose,
  planIssueSeverity,
  planTodoTick,
  planEdit,
  applyEdit,
  previewDiff,
  badReason,
} from "../../lib/registers/write.mjs";

const NOW = Date.parse("2026-09-17T00:00:00.000Z");
const REASON = "fixed in 3e0ee2e, verified on the live tree";

const withFile = async (content, fn) => {
  const d = mkdtempSync(path.join(tmpdir(), "reg-"));
  const f = path.join(d, "ISSUES.md");
  writeFileSync(f, content);
  try {
    await fn(f, () => readFileSync(f, "utf8"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

const HEADING = "### N82 · The workspace census cannot tell two things apart — **S2** — **OPEN**";

// ── planning: refuse anything not understood ───────────────────────────────

test("closing an issue replaces ONLY the OPEN marker", () => {
  const r = planIssueClose(HEADING, { reason: REASON, now: NOW });
  assert.equal(r.ok, true);
  assert.match(r.next, /\*\*RESOLVED 2026-09-17 — fixed in 3e0ee2e/);
  assert.match(r.next, /\*\*S2\*\*/, "the severity is a different fact and must survive");
  assert.match(r.next, /workspace census cannot tell two things apart/, "and so is the title");
  assert.doesNotMatch(r.next, /\*\*OPEN\*\*/);
});

test("an already-closed issue is refused with a reason that tells you to reload", () => {
  const closed = HEADING.replace("**OPEN**", "**RESOLVED 2026-09-01 — done**");
  const r = planIssueClose(closed, { reason: REASON, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /already closed|no \*\*OPEN\*\*/);
});

test("a line that is not an issue heading is refused rather than guessed at", () => {
  const r = planIssueClose("Some prose that happens to say **OPEN**.", { reason: REASON, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /not an issue heading/);
});

test("severity changes the Sn marker and nothing else", () => {
  const r = planIssueSeverity(HEADING, { severity: "S1", reason: REASON, now: NOW });
  assert.equal(r.ok, true);
  assert.match(r.next, /\*\*S1\*\*/);
  assert.match(r.next, /\*\*OPEN\*\*/, "changing severity must not close the issue");
});

test("a no-op severity change is refused, not written", () => {
  const r = planIssueSeverity(HEADING, { severity: "S2", reason: REASON, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /already S2/);
});

test("an invalid severity is refused", () => {
  assert.equal(planIssueSeverity(HEADING, { severity: "S9", reason: REASON }).ok, false);
  assert.equal(planIssueSeverity(HEADING, { severity: "high", reason: REASON }).ok, false);
});

test("ticking a todo keeps the text that makes it findable", () => {
  const r = planTodoTick("- [ ] **`make push-plugin` automation (git subtree)**", { reason: REASON, now: NOW });
  assert.equal(r.ok, true);
  assert.match(r.next, /^- \[x\] \*\*`make push-plugin`/);
  assert.match(r.next, /— done 2026-09-17, fixed in 3e0ee2e/);
});

test("indentation is preserved — a nested todo stays nested", () => {
  const r = planTodoTick("    - [ ] a nested item", { reason: REASON, now: NOW });
  assert.equal(r.ok, true);
  assert.match(r.next, /^ {4}- \[x\] a nested item/);
});

test("an already-ticked todo is refused", () => {
  assert.equal(planTodoTick("- [x] done already", { reason: REASON }).ok, false);
});

// ── the reason is mandatory, and that is the point of the register ─────────

test("a missing or throwaway reason is refused", () => {
  // A closed item that does not explain itself is a lost item — the whole value
  // of the register is that the next reader can tell why.
  assert.match(badReason(""), /required/);
  assert.match(badReason("done"), /at least/);
  assert.match(badReason("   "), /required/);
  assert.equal(badReason(REASON), null);
  assert.equal(planIssueClose(HEADING, { reason: "ok", now: NOW }).ok, false);
});

test("a multi-line reason is refused — it is going into a markdown heading", () => {
  assert.match(badReason("a perfectly long reason\nwith a newline"), /single line/);
});

// ── GUARANTEE 1 · the race check, measured on disk ─────────────────────────

test("a line that changed since it was rendered is REFUSED, and the file is untouched", async () => {
  await withFile(`intro\n${HEADING}\ntail\n`, async (f, read) => {
    const before = read();
    const r = await applyEdit({
      file: f,
      line: 2,
      expected: "### N82 · a DIFFERENT title — **S2** — **OPEN**",
      next: "whatever",
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /changed since it was rendered/);
    assert.match(r.error, /expected:/, "the refusal must show both texts, or it cannot be acted on");
    assert.equal(read(), before, "THE FILE MUST BE BYTE-IDENTICAL after a refusal");
  });
});

test("the anchor is the WHOLE line, not a prefix", async () => {
  // A prefix match can land on a different line after an edit above it. The
  // refusal below is the whole reason this takes the full text.
  await withFile(`${HEADING}\n`, async (f, read) => {
    const r = await applyEdit({ file: f, line: 1, expected: "### N82 ·", next: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error, /not what was previewed/);
  });
});

test("a line past the end of the file is refused, not appended", async () => {
  await withFile("one\ntwo\n", async (f, read) => {
    const before = read();
    const r = await applyEdit({ file: f, line: 99, expected: "two", next: "three" });
    assert.equal(r.ok, false);
    assert.match(r.error, /past the end/);
    assert.equal(read(), before);
  });
});

// ── GUARANTEE 2 · exactly one line ─────────────────────────────────────────

test("a successful write changes ONE line and leaves every other byte alone", async () => {
  await withFile(`alpha\n${HEADING}\nbeta\ngamma\n`, async (f, read) => {
    const plan = planIssueClose(HEADING, { reason: REASON, now: NOW });
    const r = await applyEdit({ file: f, line: 2, expected: HEADING, next: plan.next });
    assert.equal(r.ok, true);

    const after = read().split("\n");
    assert.equal(after[0], "alpha");
    assert.equal(after[2], "beta");
    assert.equal(after[3], "gamma");
    assert.match(after[1], /\*\*RESOLVED 2026-09-17/);
    assert.equal(after.length, 5, "the line count must not change (trailing newline included)");
  });
});

test("a replacement containing a newline is refused — this writes ONE line", async () => {
  await withFile(`${HEADING}\n`, async (f, read) => {
    const before = read();
    const r = await applyEdit({ file: f, line: 1, expected: HEADING, next: "one\ntwo" });
    assert.equal(r.ok, false);
    assert.match(r.error, /may not contain a newline/);
    assert.equal(read(), before);
  });
});

test("the trailing newline survives a write", async () => {
  // Rewriting a whole file is how a diff grows a spurious "\ No newline at end
  // of file" and turns a one-line change into a two-line one in review.
  await withFile(`${HEADING}\n`, async (f, read) => {
    const plan = planIssueClose(HEADING, { reason: REASON, now: NOW });
    await applyEdit({ file: f, line: 1, expected: HEADING, next: plan.next });
    assert.ok(read().endsWith("\n"), "the file must still end with a newline");
  });
});

test("no temp file is left behind", async () => {
  await withFile(`${HEADING}\n`, async (f) => {
    const plan = planIssueClose(HEADING, { reason: REASON, now: NOW });
    await applyEdit({ file: f, line: 1, expected: HEADING, next: plan.next });
    assert.equal(existsSync(`${f}.propagate-tmp`), false);
  });
});

test("an unreadable file is reported, never treated as empty", async () => {
  const r = await applyEdit({ file: "/nope/nothing.md", line: 1, expected: "a", next: "b" });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot read/);
});

test("a failed write does NOT leave the file half-changed", async () => {
  // Temp + rename, so a reader can never observe a partial file.
  await withFile(`${HEADING}\n`, async (f, read) => {
    const before = read();
    const r = await applyEdit({
      file: f,
      line: 1,
      expected: HEADING,
      next: "### N82 · closed",
      deps: { writeFile: async () => { throw new Error("ENOSPC"); } },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOSPC/);
    assert.equal(read(), before, "the original must be intact");
  });
});

// ── GUARANTEE 3 · what you approve is what is written ──────────────────────

test("planEdit returns the diff AND the exact line the write will use", () => {
  // The caller hands `next` straight back on confirm. Re-planning at write time
  // would mean a plan computed twice, which can differ twice.
  const p = planEdit({ action: "issue-close", file: "/x/ISSUES.md", line: 12, current: HEADING, reason: REASON, now: NOW });
  assert.equal(p.ok, true);
  assert.ok(p.diff.includes(`-${HEADING}`), "the diff shows what goes");
  assert.ok(p.diff.includes(`+${p.next}`), "and what arrives — the same string the write receives");
  assert.match(p.diff, /@@ -12,1 \+12,1 @@/);
});

test("an unknown action is refused rather than defaulted", () => {
  const p = planEdit({ action: "delete-everything", file: "/x", line: 1, current: HEADING, reason: REASON });
  assert.equal(p.ok, false);
  assert.match(p.error, /unknown action/);
});

test("the previewed line is byte-identical to the line written", async () => {
  // The assertion that ties the preview to the disk. If these ever diverge, a
  // human approved one thing and the file got another.
  await withFile(`${HEADING}\n`, async (f, read) => {
    const p = planEdit({ action: "issue-close", file: f, line: 1, current: HEADING, reason: REASON, now: NOW });
    await applyEdit({ file: f, line: 1, expected: HEADING, next: p.next });
    assert.equal(read().split("\n")[0], p.next, "what was previewed IS what is on disk");
  });
});

test("previewDiff renders a hunk a human can actually read", () => {
  const d = previewDiff("/x/TODOS.md", 7, "- [ ] a", "- [x] a — done");
  assert.match(d, /^--- \/x\/TODOS\.md/);
  assert.match(d, /\n-- \[ \] a\n/);
  assert.match(d, /\n\+- \[x\] a — done$/);
});
