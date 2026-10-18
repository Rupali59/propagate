/**
 * tasks-export.test.mjs — the pure half of `tasks export --apply`: `buildRewrite` and `verifyRewrite`.
 *
 * The verifier exists to refuse a bad rewrite BEFORE it is written. A guard like that is only real if
 * a hostile input reaches it, so the hostile cases here are written out by hand as literals and handed
 * to `verifyRewrite` directly (rule:mutate-behind-the-fixture-builder: never build the hostile case
 * through the layer being guarded — `buildRewrite` cuts correctly, so it cannot produce one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRewrite, verifyRewrite } from "../../lib/tasks/export.mjs";

const FILE = "/x/TODOS.md";
const OPTS = { file: FILE, repo: "o/r", projectLabel: "project:p", date: "2026-10-17" };
const moved = (...ids) => ids.map((id, i) => ({ id, line: 0, title: `${id} · Title ${id}`, url: `https://github.com/o/r/issues/${i + 1}`, number: i + 1 }));

const BEFORE = [
  "# TODOS", "",
  "Prose that quotes an entry:", "", "```", "### X-001 · illustration", "```", "",
  "### PR-001 · One", "", "body one", "", "```", "## D16 · quoted", "```", "",
  "### PR-002 · Two", "", "body two", "",
  "## Finished", "", "### PR-000 · Old — DONE", "", "old", "",
].join("\n");

function items() {
  const lines = BEFORE.split("\n");
  return moved("PR-001", "PR-002").map((m) => ({ ...m, line: lines.findIndex((l) => l.startsWith(`### ${m.id} `)) + 1 }));
}

test("CONTROL: the cut removes both blocks (and the fenced quote inside PR-001 with it), keeps the fenced illustration, and verifies", () => {
  const r = buildRewrite(BEFORE, items(), OPTS);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.text.includes(["```", "### X-001 · illustration", "```"].join("\n")));
  assert.doesNotMatch(r.text, /D16/);
  assert.doesNotMatch(r.text, /^### PR-00[12] /m);
  assert.match(r.text, /^### PR-000 · Old — DONE/m);
  assert.equal((r.text.match(/\*\*MOVED\*\*/g) || []).length, 2);
});

test("no Finished section: one is appended, before the final newline, and the file still verifies", () => {
  const before = "# T\n\n### PR-001 · One\n\nbody\n";
  const r = buildRewrite(before, [{ ...moved("PR-001")[0], line: 3 }], OPTS);
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /\n## Finished\n\n### Moved to GitHub 2026-10-17\n\n- PR-001 · Title PR-001 — \*\*MOVED\*\* → \[#1\]/);
  assert.equal(r.text.endsWith("\n"), true);
});

test("a stale line number is refused, naming the entry", () => {
  const r = buildRewrite(BEFORE, [{ ...moved("PR-001")[0], line: 3 }], OPTS);
  assert.equal(r.ok, false);
  assert.match(r.error, /PR-001: line 3 no longer holds this entry/);
});

/** Hand-written damage: drop the fence delimiters at `idxs` (positions among kept "```" lines) from BOTH the claimed kept text and the output. */
function dropFences(good, which) {
  const { kept, keptSrc } = good.verifyArgs;
  const fenceIdx = kept.map((l, i) => (l === "```" ? i : -1)).filter((i) => i >= 0);
  const drop = new Set(which.map((w) => fenceIdx[w]));
  const outLines = good.text.split("\n");
  const outFence = outLines.map((l, i) => (l === "```" ? i : -1)).filter((i) => i >= 0);
  const outDrop = new Set(which.map((w) => outFence[w]));
  return {
    ...good.verifyArgs,
    kept: kept.filter((_, i) => !drop.has(i)),
    keptSrc: keptSrc.filter((_, i) => !drop.has(i)),
    after: outLines.filter((_, i) => !outDrop.has(i)).join("\n"),
  };
}

test("HOSTILE: both delimiters of a fenced illustration vanish (balance intact) -> refused as a fenced-status change", () => {
  const good = buildRewrite(BEFORE, items(), OPTS);
  assert.equal(good.ok, true);
  // Dropping the pair leaves '### X-001 · illustration' live: a heading that was a quotation.
  const v = verifyRewrite(dropFences(good, [0, 1]));
  assert.equal(v.ok, false);
  assert.match(v.error, /^fenced status changed for kept line/);
});

test("HOSTILE: one fence opener vanishes -> refused as unbalanced fences", () => {
  const good = buildRewrite(BEFORE, items(), OPTS);
  const v = verifyRewrite(dropFences(good, [0]));
  assert.equal(v.ok, false);
  assert.match(v.error, /fenced status changed|fence delimiters are no longer balanced/);
});

test("HOSTILE: an unclosed fence appended as 'kept' text (every line's own status unchanged) -> refused as unbalanced", () => {
  const good = buildRewrite(BEFORE, items(), OPTS);
  const { kept, keptSrc } = good.verifyArgs;
  const fenceSrc = keptSrc[kept.indexOf("```")]; // a delimiter that really was fenced before, so its own status matches
  const v = verifyRewrite({
    ...good.verifyArgs,
    // the opener is the LAST line, so no kept line sits inside the unclosed fence and only the balance check can see it
    kept: [...kept.slice(0, -1), "```"],
    keptSrc: [...keptSrc.slice(0, -1), fenceSrc],
    after: good.text.replace(/\n$/, "\n```"),
  });
  assert.equal(v.ok, false);
  assert.match(v.error, /^fence delimiters are no longer balanced/);
});

test("HOSTILE: text added outside the declared insertions, and a kept line lost, are each refused", () => {
  const good = buildRewrite(BEFORE, items(), OPTS);
  const extra = verifyRewrite({ ...good.verifyArgs, after: good.text.replace("## Finished", "## Finished\n\nsneaked in") });
  assert.equal(extra.ok, false);
  assert.match(extra.error, /not kept text/);
  const lost = verifyRewrite({ ...good.verifyArgs, after: good.text.replace("old\n", "") });
  assert.equal(lost.ok, false);
  assert.match(lost.error, /kept lines were found|byte count/);
});

test("HOSTILE: a removed id with no pointer line, and a head the reader does not see, are refused", () => {
  const good = buildRewrite(BEFORE, items(), OPTS);
  const noPointer = verifyRewrite({ ...good.verifyArgs, moved: [...good.verifyArgs.moved, ...moved("PR-099")] });
  assert.equal(noPointer.ok, false);
  assert.match(noPointer.error, /PR-099 appears in 0 pointer line/);
  const noHead = verifyRewrite({ ...good.verifyArgs, headUrl: "https://example.test/else" });
  assert.equal(noHead.ok, false);
  assert.match(noHead.error, /delegatedTo/);
});
