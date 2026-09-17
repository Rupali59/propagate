/**
 * evidence.mjs — the change itself, for the judgement being asked.
 *
 * These tests are mostly about the difference between FOUR THINGS that a naive
 * reader collapses into one empty panel:
 *
 *   "the source has not changed"        a real result — look downstream
 *   "there is no commit to compare to"  this edge has never been judged
 *   "that commit no longer exists"      rebased, or a different clone
 *   "this is not a git repository"      nothing to diff at all
 *
 * Only the first means the edge is quiet. An empty evidence panel asserts it,
 * which is why every other case carries a named reason
 * (`rule:discernment-checks` §2, and §6 — a reader that cannot report failure
 * invents an answer).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { edgeDiff, entryBody, evidenceFor, MAX_LINES } from "../../lib/report/evidence.mjs";

const SRC = readFileSync(path.join(import.meta.dirname, "../../lib/report/evidence.mjs"), "utf8");

// ── the four absences, each named ──────────────────────────────────────────

test("an edge that has never been judged says so — it does NOT say 'no changes'", async () => {
  const r = await edgeDiff({ file: "/x/a.md", sinceCommit: null });
  assert.equal(r.ok, false);
  assert.match(r.reason, /never judged/);
  assert.equal(r.text, undefined, "no text at all, so nothing can render as an empty diff");
});

test("a commit that no longer exists names the commit", async () => {
  // Rebased, or a clone that never had it. Without the sha in the message there
  // is nothing for the reader to go and look up.
  const r = await edgeDiff({
    file: "/x/a.md",
    sinceCommit: "deadbeefdeadbeef",
    deps: { repoRoot: async () => "/x", git: async () => { throw Object.assign(new Error("x"), { stderr: "fatal: Invalid revision range" }); } },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /deadbeef/, "the reader needs the sha to investigate");
  assert.match(r.reason, /Invalid revision/);
});

test("a file outside any repository says that, not 'no changes'", async () => {
  const r = await edgeDiff({ file: "/x/a.md", sinceCommit: "abc", deps: { repoRoot: async () => null } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not inside a git repository/);
});

test("an unknown kind is refused rather than silently returning nothing", async () => {
  const r = await evidenceFor({ kind: "banana", file: "/x" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no evidence reader for kind "banana"/);
});

// ── the result that LOOKS like a failure and is not ────────────────────────

test("an unchanged source is ok:true, flagged empty, and points at the downstream", async () => {
  // The one case where nothing to show IS the answer. It must be distinguishable
  // from all four failures above, and it must tell the reader where to look
  // instead — otherwise a blank panel ends the investigation.
  const r = await edgeDiff({
    file: "/x/a.md",
    sinceCommit: "abc",
    deps: { repoRoot: async () => "/x", git: async () => "" },
  });
  assert.equal(r.ok, true, "this is a RESULT, not a failure");
  assert.equal(r.empty, true);
  assert.match(r.reason, /downstream/, "it must say where to look next");
});

// ── the honesty clause ─────────────────────────────────────────────────────

test("a judgement recorded on a DIRTY tree carries a caveat; a clean one does not", async () => {
  // Measured 2026-09-17: 37 of 48 actionable edges were last judged with a dirty
  // working tree, so the recorded commit is not what the person actually looked
  // at. Presenting that diff as exact would be a false precision on the majority
  // of rows.
  const deps = { repoRoot: async () => "/x", git: async () => "@@ -1 +1 @@\n-a\n+b\n" };
  const d = await edgeDiff({ file: "/x/a.md", sinceCommit: "abc", dirty: true, deps });
  assert.match(d.caveat, /dirty/);
  assert.match(d.caveat, /already present/, "it must say WHAT the reader should discount");

  const c = await edgeDiff({ file: "/x/a.md", sinceCommit: "abc", dirty: false, deps });
  assert.equal(c.caveat, null, "a clean record must not be hedged — that would train the reader to ignore it");
});

// ── the shell, which must never see a path ─────────────────────────────────

test("git is invoked with an ARGUMENT ARRAY, never a shell string", async () => {
  // Paths in this tree already contain spaces (`Vipin Kaushik/`), so this is a
  // live concern rather than a theoretical one. A shell string would also make a
  // file named `;rm -rf ~` executable, and the file names come off disk.
  assert.match(SRC, /execFile/, "must use execFile");
  assert.doesNotMatch(SRC, /\bexec\s*\(/, "exec() takes a shell string");
  assert.doesNotMatch(SRC, /shell:\s*true/);
  assert.match(SRC, /\["-C",\s*repo,\s*\.\.\.args\]/, "args must be passed as an array");
});

test("a hostile path is an argument, not syntax", async () => {
  let seen = null;
  await edgeDiff({
    file: "/x/a; rm -rf ~.md",
    sinceCommit: "abc",
    deps: { repoRoot: async () => "/x", git: async (_repo, args) => { seen = args; return "diff"; } },
  });
  assert.ok(Array.isArray(seen), "args reach git as an array");
  assert.ok(seen.includes("a; rm -rf ~.md"), `the whole name is ONE argument, saw ${JSON.stringify(seen)}`);
});

// ── truncation is stated ───────────────────────────────────────────────────

test("a long diff is clamped AND says how much it clamped", async () => {
  const long = Array.from({ length: MAX_LINES + 120 }, (_, i) => `+line ${i}`).join("\n");
  const r = await edgeDiff({ file: "/x/a.md", sinceCommit: "abc", deps: { repoRoot: async () => "/x", git: async () => long } });
  assert.equal(r.text.split("\n").length, MAX_LINES);
  assert.match(r.truncated, new RegExp(`first ${MAX_LINES} of ${MAX_LINES + 120}`));
});

test("a short diff is NOT marked truncated", async () => {
  const r = await edgeDiff({ file: "/x/a.md", sinceCommit: "abc", deps: { repoRoot: async () => "/x", git: async () => "@@\n+a\n" } });
  assert.equal(r.truncated, null, "a false truncation notice is as misleading as a silent one");
});

// ── an issue's evidence is its ARGUMENT, not its title ─────────────────────

const FILE = [
  "# Issues",
  "",
  "### N1 · first thing — **S2** — **OPEN**",   // line 3
  "body of the first",
  "#### a sub-heading that BELONGS to N1",       // line 5
  "more body",
  "### N2 · second thing — **S1**",              // line 7
  "body of the second",
].join("\n");
const readFixture = async () => FILE;

test("an entry spans to the next heading at the SAME level, keeping its sub-headings", async () => {
  // A `####` inside an entry is part of the argument; the next `###` is the next
  // entry. Getting this wrong truncates the reasoning, which is the only thing
  // on the panel worth reading.
  const r = await entryBody({ file: "/x/ISSUES.md", line: 3, deps: { readFile: readFixture } });
  assert.equal(r.ok, true);
  assert.match(r.text, /^### N1 ·/);
  assert.match(r.text, /a sub-heading that BELONGS/, "the #### is part of N1");
  assert.doesNotMatch(r.text, /N2 · second/, "and N2 is not");
});

test("the LAST entry runs to the end of the file", async () => {
  const r = await entryBody({ file: "/x/ISSUES.md", line: 7, deps: { readFile: readFixture } });
  assert.match(r.text, /body of the second/);
});

test("a non-heading line (a todo) gets surrounding context, not the rest of the file", async () => {
  const r = await entryBody({ file: "/x/TODOS.md", line: 4, deps: { readFile: readFixture } });
  assert.equal(r.ok, true);
  assert.ok(r.text.split("\n").length <= 6, `context should be a few lines, got ${r.text.split("\n").length}`);
  assert.match(r.text, /body of the first/);
});

test("a line past the end of the file says so and says to reload", async () => {
  const r = await entryBody({ file: "/x/ISSUES.md", line: 999, deps: { readFile: readFixture } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /past the end/);
  assert.match(r.reason, /reload/, "the file moved under the reader; tell them what to do");
});

test("an unreadable file is named, never rendered as an empty entry", async () => {
  const r = await entryBody({ file: "/x/gone.md", line: 1, deps: { readFile: async () => { throw new Error("ENOENT"); } } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot read/);
});

test("evidenceFor routes each kind to the right reader", async () => {
  const deps = { readFile: readFixture, repoRoot: async () => "/x", git: async () => "@@\n+x\n" };
  assert.equal((await evidenceFor({ kind: "issue", file: "/x/a.md", line: 3, deps })).kind, "entry");
  assert.equal((await evidenceFor({ kind: "todo", file: "/x/a.md", line: 4, deps })).kind, "entry");
  assert.equal((await evidenceFor({ kind: "edge", file: "/x/a.md", sinceCommit: "abc", deps })).kind, "diff");
});
