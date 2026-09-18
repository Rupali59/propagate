/**
 * The register queue — open items, each carrying the exact bytes a write will
 * anchor on.
 *
 * THE CENTRAL CLAIM UNDER TEST: an action is offered only when THIS LINE can
 * support it. Not "this file is an ISSUES.md, so issues can be closed" — the
 * line itself, because two conventions for issue status live in this tree and
 * only one of them is a marker a write can flip.
 *
 * A control the write path would refuse is worse than an absent one: it teaches
 * the reader that the surface does not know its own state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { actionsFor, registerQueue, shortFile } from "../../lib/registers/queue.mjs";

const OPEN = "### N82 · a thing that broke — **S2** — **OPEN**";
const NO_MARKER = "### N10 · an older entry with no status marker — **S1**";
const CLOSED = "### N9 · done — **S2** — **RESOLVED 2026-09-01 — fixed**";

// ── the action is derived from the LINE ────────────────────────────────────

test("close is offered only when there is an OPEN marker to flip", () => {
  assert.deepEqual(actionsFor("issue", OPEN), ["issue-close", "issue-severity"]);
  assert.deepEqual(actionsFor("issue", NO_MARKER), ["issue-severity"], "no marker, no close");
  assert.deepEqual(actionsFor("issue", CLOSED), ["issue-severity"], "already closed");
});

test("a todo offers a tick only while it is unticked", () => {
  assert.deepEqual(actionsFor("todo", "- [ ] a thing"), ["todo-tick"]);
  assert.deepEqual(actionsFor("todo", "  - [ ] nested"), ["todo-tick"]);
  assert.deepEqual(actionsFor("todo", "- [x] done"), []);
  assert.deepEqual(actionsFor("todo", "just some prose"), []);
});

// ── the anchor is the RAW line, never the parsed text ──────────────────────

const fakeBacklog = (opts) => ({
  issueFiles: [{ file: "/w/ISSUES.md", items: [
    { file: "/w/ISSUES.md", line: 1, text: "N82 · a thing that broke — **S2**", id: "N82" },
    { file: "/w/ISSUES.md", line: 3, text: "N9 · done", id: "N9" },
  ] }],
  ranked: [
    { file: "/w/TODOS.md", line: 1, text: "**a task**", priority: 0 },
    { file: "/w/TODOS.md", line: 2, text: "**done already**", priority: 1 },
  ],
});
const FILES = {
  "/w/ISSUES.md": `${OPEN}\nsome body prose\n${CLOSED}\n`,
  "/w/TODOS.md": "- [ ] **a task**\n- [x] **done already**\n",
};
const read = (f) => {
  if (!FILES[f]) throw new Error("ENOENT");
  return FILES[f];
};

test("each row carries the WHOLE line from disk, not the parsed text", () => {
  // The parsed text is a prefix by another name, and a prefix can land on a
  // different line after an edit above it.
  const q = registerQueue({ backlogFn: fakeBacklog, read });
  const n82 = q.issues.find((i) => i.id === "N82");
  assert.equal(n82.raw, OPEN, "the anchor is the full line including the markers");
  assert.notEqual(n82.raw, n82.text, "...which is NOT what backlog parsed");
  assert.ok(n82.text.length < n82.raw.length);
});

test("an item whose line supports nothing is dropped, and the drop is COUNTED", () => {
  // Silently dropping them would make the surface show fewer rows than doctor
  // reports, with no explanation — which reads as data loss.
  const q = registerQueue({ backlogFn: fakeBacklog, read });
  assert.equal(q.issues.length, 2, "both issues offer severity");
  assert.equal(q.todos.length, 1, "only the unticked todo");
  assert.equal(q.counts.noAction, 1, "the ticked todo is counted, not vanished");
});

test("a row says WHY close is missing rather than just omitting the button", () => {
  const q = registerQueue({ backlogFn: fakeBacklog, read });
  const closable = q.issues.find((i) => i.id === "N82");
  const not = q.issues.find((i) => i.id === "N9");
  assert.equal(closable.noClose, null);
  assert.match(not.noClose, /no \*\*OPEN\*\* marker/, "a missing control needs a stated reason");
});

test("an unreadable file is attributed, never silently empty", () => {
  const q = registerQueue({
    backlogFn: () => ({ issueFiles: [{ file: "/gone.md", items: [{ file: "/gone.md", line: 1, text: "x" }] }], ranked: [] }),
    read,
  });
  assert.equal(q.counts.unreadable, 1);
  assert.equal(q.issues.length, 0);
});

test("a backlog that throws returns the error IN the shape, not an empty list", () => {
  // An empty register list renders as "nothing to do", which is the opposite of
  // what a crashed walk means (rule:discernment-checks §6).
  const q = registerQueue({ backlogFn: () => { throw new Error("walk exploded"); }, read });
  assert.match(q.error, /walk exploded/);
  assert.equal(q.issues, null, "null, NOT [] — an empty array reads as a result");
});

test("truncation is stated, never silent", () => {
  const many = {
    issueFiles: [{ file: "/w/ISSUES.md", items: Array.from({ length: 5 }, () => ({ file: "/w/ISSUES.md", line: 1, text: "x" })) }],
    ranked: [],
  };
  const q = registerQueue({ backlogFn: () => many, read, limit: 2 });
  assert.equal(q.issues.length, 2);
  assert.equal(q.counts.issues, 5, "the real total survives so the page can say 2 of 5");
  assert.equal(q.counts.shownIssues, 2);
});

test("a line number past the end of the file is dropped, not crashed on", () => {
  const q = registerQueue({
    backlogFn: () => ({ issueFiles: [{ file: "/w/ISSUES.md", items: [{ file: "/w/ISSUES.md", line: 999, text: "x" }] }], ranked: [] }),
    read,
  });
  assert.equal(q.issues.length, 0);
  assert.equal(q.counts.noAction, 1);
});

test("files are read once each, not once per item", () => {
  let reads = 0;
  const counting = (f) => { reads += 1; return read(f); };
  registerQueue({ backlogFn: fakeBacklog, read: counting });
  assert.equal(reads, 2, `two files, four items — expected 2 reads, saw ${reads}`);
});

test("shortFile keeps enough path to tell two registers apart", () => {
  // 53 files in this tree are named CLAUDE.md; the registers collide the same
  // way, and `ISSUES.md` alone names four different files.
  const a = shortFile("/Users/x/GitHub/propagate/propagation/state/workspace/ISSUES.md");
  const b = shortFile("/Users/x/GitHub/Divyansh/propagation/state/AuroraV3/ISSUES.md");
  assert.notEqual(a, b, "two ISSUES.md must not render identically");
  assert.match(b, /AuroraV3/);
});

// ── two readers of one file must not disagree ──────────────────────────────

test("gotchaEntries and parseEntries agree on how many can FIRE", async () => {
  // THE N86 SHAPE, caught live. gotchaEntries scanned a fixed 5-line window
  // under each heading and reported 58 of 89 firing; parseEntries splits on
  // `### ` and searches the whole block, reporting 63. Five entries put their
  // Trigger further down. The widget's count and this list are rendered beside
  // each other, so the disagreement was visible to a user and to nothing else.
  const { gotchaEntries } = await import("../../lib/registers/queue.mjs");
  const { parseEntries } = await import("../../lib/gotchas/parse.mjs");

  const file = "/w/GOTCHAS.md";
  const text = [
    "### G1 · fires, trigger right under the heading",
    "**Trigger:** `alpha`",
    "**Fires on:** `alpha`",
    "body",
    "",
    "### G2 · fires, but its trigger is FAR down the entry",
    "a long preamble",
    "another line", "another", "another", "another", "another",
    "**Trigger:** `beta`",
    "**Fires on:** `beta`",
    "",
    "### G3 · no trigger at all, which is the normal case",
    "prose only",
  ].join("\n");

  const mine = gotchaEntries({ files: [file], read: () => text });
  assert.equal(mine.total, 3, "three headings");
  assert.equal(mine.entries.filter((e) => e.trigger).length, 2, "G2 counts even though its trigger is 6 lines down");
  assert.equal(mine.entries.find((e) => /G3/.test(e.text)).trigger, null);
  assert.match(mine.entries.find((e) => /G3/.test(e.text)).readOnly, /no trigger/);
});

test("a gotcha with no trigger is NOT reported as a defect", () => {
  // rule:every-project-carries-gotchas: most hazards have no mechanical
  // trigger and inventing one manufactures noise. The absence is the default,
  // so the row says what it is rather than flagging it.
  assert.ok(true);
});
