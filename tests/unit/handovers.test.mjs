/**
 * Handover sections as a backlog source — three states, and no execution.
 *
 * HANDOVERS.md is 1,085 lines with ZERO status markers of any kind. Its
 * 2026-08-17 section names its own discharge condition in prose ("my edits are
 * exactly the files with an mtime between 19:02 and 19:14"); running that by
 * hand on 2026-08-22 showed 1 of its 4 repos still outstanding, five days on,
 * and the file could not say so.
 *
 * THE READER DOES NOT RUN THE CONDITION. Deriving "closed" would mean
 * executing shell written in a markdown file, which is both a security hole
 * and against this tool's whole posture: it never edits a downstream, it tells
 * a human. So the condition is REPORTED, and a human runs it.
 *
 * Three states, never two:
 *   closed    an explicit `Resolved:` marker
 *   open      a `Done when:` condition exists -- printed, for a human to run
 *   unknown   neither. NOT "closed", and not "open" either: nobody has said
 *             what would finish it, which is the state 1,085 lines are in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseHandovers } from "../../lib/report/handovers.mjs";

const DOC = `# Handovers

Intro prose that belongs to no section.

## 2026-08-17 · Four repos carry uncommitted fixes

**Done when:** \`git status --porcelain\` is clean in all four repos.

Body text.

## 2026-08-14 · A thing that was finished

**Resolved:** 2026-08-16 — the plist was regenerated.

More body.

## 2026-08-10 · A thing nobody scoped

Just prose. No condition, no resolution.
`;

async function withDoc(text, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "handovers-"));
  const p = path.join(dir, "HANDOVERS.md");
  await writeFile(p, text);
  try {
    return await fn(p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("splits on ## sections and ignores the preamble", async () => {
  await withDoc(DOC, (p) => {
    const r = parseHandovers(p);
    assert.equal(r.sections.length, 3, "three ## sections, and the intro prose is not one");
    assert.deepEqual(
      r.sections.map((s) => s.date),
      ["2026-08-17", "2026-08-14", "2026-08-10"],
    );
  });
});

test("a `Done when:` section is OPEN and carries its condition verbatim", async () => {
  await withDoc(DOC, (p) => {
    const s = parseHandovers(p).sections.find((x) => x.date === "2026-08-17");
    assert.equal(s.status, "open");
    assert.match(s.doneWhen, /git status --porcelain/, "the condition must be reported for a human to run");
  });
});

test("a `Resolved:` section is CLOSED", async () => {
  await withDoc(DOC, (p) => {
    const s = parseHandovers(p).sections.find((x) => x.date === "2026-08-14");
    assert.equal(s.status, "closed");
    assert.match(s.resolved, /2026-08-16/);
  });
});

test("a section with NEITHER marker is `unknown` — never closed", async () => {
  // The load-bearing assertion. A reader that defaulted to "closed" would
  // report 1,085 lines of unscoped prose as finished work; one that defaulted
  // to "open" would claim every historical note is outstanding. Neither is
  // true, and saying so is the whole point.
  await withDoc(DOC, (p) => {
    const s = parseHandovers(p).sections.find((x) => x.date === "2026-08-10");
    assert.equal(s.status, "unknown");
    assert.equal(s.doneWhen, null);
    assert.notEqual(s.status, "closed", "silence must never read as done");
  });
});

test("totals count all three states, and they sum to the section count", async () => {
  await withDoc(DOC, (p) => {
    const r = parseHandovers(p);
    assert.deepEqual(r.totals, { open: 1, closed: 1, unknown: 1 });
    const sum = r.totals.open + r.totals.closed + r.totals.unknown;
    assert.equal(sum, r.sections.length, "a section that fell out of the tally would be invisible");
  });
});

test("NUMBERED sections parse too, and inherit the file's date", async () => {
  // The dated HANDOVER-*.md files number their sections instead of dating
  // them. The first version of SECTION_RE required a date and therefore
  // reported 0 sections for Motherboard/HANDOVER-2026-08-14.md, which has 7 —
  // a file full of real work reading as empty, which is the exact hazard
  // backlog.mjs's header warns about, committed by the module being added to
  // it. Caught by running against the real files, not by this fixture.
  const dir = await mkdtemp(path.join(tmpdir(), "handovers-numbered-"));
  const p = path.join(dir, "HANDOVER-2026-08-14.md");
  await writeFile(
    p,
    "# Handover — 2026-08-14\n\n## 1 · First item\n\n**Done when:** the plist reloads.\n\n## 2 · Second item\n\nProse.\n",
  );
  try {
    const r = parseHandovers(p);
    assert.equal(r.sections.length, 2);
    assert.deepEqual(r.sections.map((s) => s.ordinal), [1, 2]);
    assert.equal(r.sections[0].date, "2026-08-14", "the date comes from the filename when the heading has none");
    assert.equal(r.sections[0].status, "open");
    assert.equal(r.sections[1].status, "unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable file is attributable, never an empty success", async () => {
  const r = parseHandovers("/definitely/not/here/HANDOVERS.md");
  assert.equal(r.sections.length, 0);
  assert.ok(r.error, "must report WHY there are no sections");
  assert.notDeepEqual(r.totals, { open: 0, closed: 0, unknown: 0 }, "totals must be null on error, not zeroes");
});

test("a file with no ## sections at all is distinguishable from an unreadable one", async () => {
  await withDoc("# Handovers\n\nNothing but prose.\n", (p) => {
    const r = parseHandovers(p);
    assert.equal(r.error, null, "readable");
    assert.equal(r.sections.length, 0);
    assert.deepEqual(r.totals, { open: 0, closed: 0, unknown: 0 }, "a real zero, not an error");
  });
});

test("a `Resolved:` deep in the BODY does not close the section — found in the real file", async () => {
  // Both "closed" results on the live 1,085-line HANDOVERS.md were this: one
  // matched a SUB-ITEM's resolution inside the body, the other matched the
  // word mid-sentence in flowing prose. A section-level marker belongs
  // directly under its heading; anything further down is discussion.
  //
  // The fixture could not have caught this. The real file did.
  const doc = `# H

## 2026-08-14 · A section that discusses resolutions

Body prose that runs on for a while, describing several sub-items.

Another paragraph of discussion, because the marker has to be genuinely DEEP in
the body for this test to reproduce the live failure.

A third, for the same reason. On the real file the false match sat many lines
below its heading.

**Resolved:** 2026-08-15 — one of the sub-items, not the section. No list prefix:
this is the exact shape that matched on the live file. A fixture using a "- "
prefix would pass VACUOUSLY, because the regex already rejects that; and one
placed two lines under the heading passes too, because that is inside the window.

More discussion.

## 2026-08-10 · Marker in the right place

**Resolved:** 2026-08-11 — directly under the heading, which is the convention.
`;
  await withDoc(doc, (p) => {
    const r = parseHandovers(p);
    const discusses = r.sections.find((x) => x.date === "2026-08-14");
    assert.equal(discusses.status, "unknown", "a body mention must NOT close a section");
    assert.equal(discusses.resolved, null);
    const proper = r.sections.find((x) => x.date === "2026-08-10");
    assert.equal(proper.status, "closed", "a marker under the heading still counts");
  });
});
