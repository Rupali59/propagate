import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewsDir, reviewDirName } from "../../lib/kb/review/paths.mjs";

test("reviewsDir: derived from the standards dir's parent", () => {
  assert.deepEqual(reviewsDir({ kbStandardsDir: "/h/kb/standards" }), { ok: true, dir: "/h/kb/reviews" });
});

test("reviewsDir: an explicit kbReviewsDir wins", () => {
  assert.deepEqual(reviewsDir({ kbStandardsDir: "/h/kb/standards", kbReviewsDir: "/x/r" }), { ok: true, dir: "/x/r" });
});

test("reviewsDir: neither set is 'not configured', never a guessed path", () => {
  assert.deepEqual(reviewsDir({}), { ok: false, reason: "kb reviews not configured" });
  assert.deepEqual(reviewsDir(undefined), { ok: false, reason: "kb reviews not configured" });
});

test("reviewDirName: date plus slug", () => {
  assert.equal(reviewDirName("2026-11-23", "llm-screening"), "2026-11-23-llm-screening");
});

test("reviewDirName: a bad slug throws KB_REVIEW_USAGE", () => {
  for (const bad of ["LLM Screening", "a".repeat(61), "", "-x", "x-", "a--b", "a/b"]) {
    assert.throws(() => reviewDirName("2026-11-23", bad), (e) => e.code === "KB_REVIEW_USAGE", JSON.stringify(bad));
  }
  assert.doesNotThrow(() => reviewDirName("2026-11-23", "a".repeat(60)));
});

test("reviewDirName: a bad date throws KB_REVIEW_USAGE", () => {
  assert.throws(() => reviewDirName("23-11-2026", "ok"), (e) => e.code === "KB_REVIEW_USAGE");
});
