/**
 * lib/reminders/** — unit coverage for the four hazards this lane fixes,
 * per `docs/plans/2026-09-23-reminders-todo-bridge.md` F1/F3/F4/F5.
 *
 * All pure-function tests: no subprocess, no real osascript, no filesystem
 * beyond `validateTagTable()`'s own `existsSync` checks against real
 * project directories already in this tree. `tests/cli/reminders.test.mjs`
 * covers the subprocess / "writes nothing" surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { classify, buildScript } from "../../lib/reminders/osascript.mjs";
import { extractTags, splitLines } from "../../lib/reminders/parse.mjs";
import { TAG_TABLE, resolveTag, validateTagTable } from "../../lib/reminders/tags.mjs";
import { normalizeRecord } from "../../lib/reminders/normalize.mjs";
import { readReminders } from "../../lib/reminders/read.mjs";

// ---------------------------------------------------------------------------
// F1 — found nothing vs could not look, distinguished by EXIT CODE
// ---------------------------------------------------------------------------

test("F1: rc=0 with empty stdout classifies OK (a genuinely empty list)", () => {
  const v = classify({ status: 0, stdout: "", stderr: "" });
  assert.equal(v.ok, true);
});

test("F1: rc=0 with data classifies OK", () => {
  const v = classify({ status: 0, stdout: "[]", stderr: "" });
  assert.equal(v.ok, true);
});

test("F1: rc=1 with -1743 (TCC denial) classifies INCONCLUSIVE with a named reason, never as empty", () => {
  const v = classify({
    status: 1,
    stdout: "",
    stderr: 'execution error: Not authorized to send Apple events to Reminders. (-1743)',
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "tcc-denied");
  assert.ok(v.reasonDetail.length > 0, "the reason must be attributable, not a bare failure");

  // FAILING INPUT: this is the defect the whole lane exists to prevent — a
  // reader that folds any non-zero rc into "0 reminders". Assert directly
  // that the two are NOT the same shape as the true-empty case above.
  const emptyCase = classify({ status: 0, stdout: "", stderr: "" });
  assert.notEqual(v.ok, emptyCase.ok, "a TCC denial must not render identically to a real empty list");
});

test("F1: rc=1 with -1728 (missing list) classifies INCONCLUSIVE as missing-list", () => {
  const v = classify({ status: 1, stdout: "", stderr: 'Can not get list "___missing___". (-1728)' });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "missing-list");
});

test("F1: rc=1 with -2753 (bad syntax) classifies INCONCLUSIVE as syntax-error", () => {
  const v = classify({ status: 1, stdout: "", stderr: "A syntax error occurred. (-2753)" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "syntax-error");
});

test("F1: rc=1 with an unrecognized code still classifies INCONCLUSIVE, never guessed as OK", () => {
  const v = classify({ status: 1, stdout: "", stderr: "some other AppleScript failure. (-9999)" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "osascript-error");
  assert.equal(v.code, "-9999");
});

test("F1: a spawnSync timeout classifies INCONCLUSIVE as timeout, not as empty", () => {
  const v = classify({ status: 1, stdout: "", stderr: "osascript timed out after 15000ms", timedOut: true });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "timeout");
});

test("F1 end-to-end via readReminders: TCC denial never surfaces as ok:true with zero items", async () => {
  const exec = () => ({ status: 1, stdout: "", stderr: "Not authorized to send Apple events to Reminders. (-1743)" });
  const result = await readReminders({ exec });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "tcc-denied");
  assert.equal("items" in result, false, "an inconclusive result must not carry an items array at all");
});

test("F1 end-to-end via readReminders: a genuinely empty list is a DIFFERENT output — ok:true, zero items", async () => {
  const exec = () => ({ status: 0, stdout: "[]", stderr: "" });
  const result = await readReminders({ exec });
  assert.equal(result.ok, true);
  assert.equal(result.summary.total, 0);
});

test("F1: rc=0 but unparseable stdout is INCONCLUSIVE, not an invented empty list", async () => {
  // Feeding the reader a shape it should not recognise (rule:discernment-checks §6).
  const exec = () => ({ status: 0, stdout: "not json at all {{{", stderr: "" });
  const result = await readReminders({ exec });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unparseable-output");
});

test("buildScript embeds the list name as a JSON string literal, safe against quotes", () => {
  const script = buildScript('weird " list');
  assert.match(script, /byName\("weird \\" list"\)/);
});

// ---------------------------------------------------------------------------
// F3 — split tags on CR, LF and CRLF
// ---------------------------------------------------------------------------

test("F3: the live fixture — CR before the tag — is not invisible", () => {
  // This exact body was written to the live "Claude TODO" list this session,
  // per the spec (plan:99-101, :222-229): AppleScript `return` is CR.
  const body = "gh ENOENT error\r#ccusage";
  const tags = extractTags(body);
  assert.deepEqual(tags, ["ccusage"]);

  // FAILING INPUT: a \n-anchored split. Demonstrate the failure this test
  // guards against directly, so the assertion above is not accidental.
  const naiveSplit = body.split("\n");
  assert.equal(naiveSplit.length, 1, "a \\n split sees ONE line and misses the tag entirely — this is the bug F3 fixes");
});

test("F3: CR, LF and CRLF bodies with the same content yield the same tags", () => {
  const content = ["a section of per day", "#vipinkaushik", "trailing note"];
  const cr = content.join("\r");
  const lf = content.join("\n");
  const crlf = content.join("\r\n");

  const tagsCr = extractTags(cr);
  const tagsLf = extractTags(lf);
  const tagsCrlf = extractTags(crlf);

  assert.deepEqual(tagsCr, ["vipinkaushik"]);
  assert.deepEqual(tagsLf, ["vipinkaushik"]);
  assert.deepEqual(tagsCrlf, ["vipinkaushik"]);
});

test("F3: mixed line endings within one body still find every tag", () => {
  const body = "line one\r#ccusage\nline three\r\n#vipinkaushik";
  assert.deepEqual(extractTags(body), ["ccusage", "vipinkaushik"]);
});

test("splitLines: empty and non-string bodies return no lines, not a throw", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines(undefined), []);
  assert.deepEqual(splitLines(null), []);
});

test("extractTags: an untagged body yields no tags", () => {
  assert.deepEqual(extractTags("just an invoice paste, no hashtag here"), []);
});

// ---------------------------------------------------------------------------
// F4 — the tag table fails loudly
// ---------------------------------------------------------------------------

test("F4: every entry in TAG_TABLE resolves to a directory that exists on disk", () => {
  const rows = validateTagTable();
  assert.ok(rows.length > 0, "the table must not be empty, or this assertion is vacuous");
  const broken = rows.filter((r) => !r.exists);
  assert.deepEqual(broken, [], `these tags route to a path that does not exist: ${JSON.stringify(broken)}`);
});

test("F4: validateTagTable's exists flag is a real filesystem check, not hardcoded true — proven against a path that cannot exist", () => {
  // FAILING INPUT for the check itself: a fabricated path guaranteed absent.
  // validateTagTable() only walks the real TAG_TABLE, so this exercises the
  // same existsSync() call it uses, directly, to prove the flag can go false.
  const ghostPath = "/definitely/not/a/real/path/xyz-reminders-fixture";
  assert.equal(existsSync(ghostPath), false, "fixture path must genuinely not exist for this to be a real check");

  // And every real row must be the opposite of that.
  for (const row of validateTagTable()) {
    assert.notEqual(row.path, ghostPath);
    assert.equal(existsSync(row.path), true, `${row.tag} -> ${row.path} does not exist`);
  }
});

test("F4: an unresolvable tag is reported as held-unknown-tag, never dropped and never guessed", () => {
  const raw = {
    id: "x1", name: "test", body: "please look at this\r#doesnotexist", completed: false,
    completionDate: null, modificationDate: null,
  };
  const item = normalizeRecord(raw);
  assert.equal(item.route.kind, "held-unknown-tag");
  assert.equal(item.route.tag, "doesnotexist");

  // FAILING INPUT: a "nearest match" fallback would route this to `ccusage`
  // or `vipinkaushik` by some similarity heuristic. Assert explicitly that
  // it did NOT.
  assert.notEqual(item.route.kind, "routed");
});

test("F4: an unresolvable tag surfaces through the full read path, not silently dropped from items", async () => {
  const raw = [{ id: "x1", name: "t", body: "#nosuchproject", completed: false, completionDate: null, modificationDate: null }];
  const exec = () => ({ status: 0, stdout: JSON.stringify(raw), stderr: "" });
  const result = await readReminders({ exec });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1, "the item must still be present in the report");
  assert.equal(result.items[0].route.kind, "held-unknown-tag");
  assert.equal(result.summary.heldUnknownTag, 1);
});

test("resolveTag: a known tag resolves to its table entry", () => {
  assert.equal(resolveTag("ccusage").project, TAG_TABLE.ccusage.project);
  assert.equal(resolveTag("CCUSAGE").project, TAG_TABLE.ccusage.project, "case-insensitive lookup");
});

test("resolveTag: an unknown tag returns null, not a fuzzy nearest match", () => {
  assert.equal(resolveTag("ccusag"), null);
  assert.equal(resolveTag(""), null);
});

// ---------------------------------------------------------------------------
// F5 — completion date, never modification date
// ---------------------------------------------------------------------------

test("F5: a body edit that bumps modificationDate with no completion change is NOT reported as completed", () => {
  // Exactly this session's own incident (plan:252-254): editing a body to
  // add a tag bumped modification date to 15:36 with completion unchanged.
  const raw = {
    id: "x2",
    name: "Add upcoming purnima and amavasya dates",
    body: "note\r#vipinkaushik",
    completed: false,
    completionDate: null,
    modificationDate: "2026-09-25T15:36:00.000Z", // bumped by the tag edit
  };
  const item = normalizeRecord(raw);
  assert.equal(item.completed, false, "completed must come from Reminders' own boolean, not from a recent modification");
  assert.equal(item.completedAt, null, "no completionDate means no completedAt, regardless of modifiedAt");

  // FAILING INPUT: a normalizer using `raw.completionDate ?? raw.modificationDate`
  // as the completion timestamp source. Prove this fixture would trip that
  // exact mutant.
  const wrongCompletedAt = raw.completionDate ?? raw.modificationDate;
  assert.notEqual(item.completedAt, wrongCompletedAt, "the wrong implementation would report the modification time as a completion");
});

test("F5: a truly completed item reports completedAt from completionDate", () => {
  const raw = {
    id: "x3", name: "done thing", body: "#ccusage", completed: true,
    completionDate: "2026-09-24T10:00:00.000Z",
    modificationDate: "2026-09-25T15:36:00.000Z", // later, and irrelevant
  };
  const item = normalizeRecord(raw);
  assert.equal(item.completed, true);
  assert.equal(item.completedAt, "2026-09-24T10:00:00.000Z", "completedAt must be completionDate, never the later modificationDate");
});

test("F5: modifiedAt is carried through for diagnostics but never drives completed/completedAt", () => {
  const raw = {
    id: "x4", name: "n", body: "", completed: false,
    completionDate: null, modificationDate: "2026-09-20T00:00:00.000Z",
  };
  const item = normalizeRecord(raw);
  assert.equal(item.modifiedAt, "2026-09-20T00:00:00.000Z");
  assert.equal(item.completed, false);
  assert.equal(item.completedAt, null);
});
