/**
 * Block splitting, block identity, and the verdict store.
 *
 * THE LOAD-BEARING PROPERTY IS THE HASH. A verdict is pinned to the sha256 of a
 * block's NORMALISED text, which is what makes "judge once, never re-judge
 * unchanged input" true rather than aspirational. Two things must hold and are
 * asserted here directly:
 *
 *   reflowing a paragraph must NOT move the hash — otherwise a cosmetic
 *   line-width change silently discards every verdict in the file, and people
 *   stop recording them;
 *
 *   changing a WORD must move it — otherwise an edited claim silently inherits a
 *   judgment about text that no longer exists, which is the failure the whole
 *   content-addressed design exists to prevent.
 *
 * The store's tests assert REJECTION, because `validateClaim` runs before the
 * lock and before disk: an invalid record must never reach the file at all.
 * `rule:safety-flag-needs-a-test` — construct the input that takes the unsafe
 * path, then assert the effect is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { splitBlocks, judgeableBlocks, blockSha, normaliseBlock, JUDGEABLE } from "../../lib/claims/blocks.mjs";
import {
  validateClaim, dryValidateClaim, latestByBlock,
  CLAIM_KINDS, CLAIM_STANDINGS, CLAIM_FINDINGS,
} from "../../lib/claims/store.mjs";

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);
const ok = { file: "docs/X.md", block_sha: SHA, kind: "fact" };

// ── identity ────────────────────────────────────────────────────────────────

test("reflowing a paragraph does not move its hash", () => {
  const a = "The constraint is physical.  It follows that\nbookings are online only.";
  const b = "The constraint is physical. It follows\nthat bookings are online only.";
  assert.equal(blockSha(a), blockSha(b), "a line-width change must not discard a verdict");
});

test("changing one word moves the hash", () => {
  const a = "The constraint is physical.";
  const b = "The constraint is logistical.";
  assert.notEqual(blockSha(a), blockSha(b), "an edited claim must re-open, never inherit");
});

test("normalisation does not lowercase — case is meaning, not whitespace", () => {
  assert.notEqual(blockSha("Never advertise remedies"), blockSha("never advertise remedies"));
  assert.equal(normaliseBlock("  a   b \n c "), "a b c");
});

// ── splitting ───────────────────────────────────────────────────────────────

test("each list item is its own claim, not one block for the list", () => {
  const md = "- first refusal\n- second refusal\n- third refusal\n";
  const items = splitBlocks(md).filter((b) => b.kind === "list-item");
  assert.equal(items.length, 3, "five refusals in a list must be five judgeable claims");
  assert.equal(new Set(items.map((b) => b.sha)).size, 3, "and three distinct identities");
});

test("structure is classified and NOT judgeable, but is still returned", () => {
  const md = "# Heading\n\nsome prose\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\n| a | b |\n";
  const blocks = splitBlocks(md);
  const kinds = blocks.map((b) => b.kind);
  assert.ok(kinds.includes("heading") && kinds.includes("code") && kinds.includes("table"));
  // Returned, not dropped: a caller must be able to say "12 skipped as structure"
  // rather than reporting a smaller total with no explanation.
  for (const b of blocks) {
    assert.equal(b.judgeable, JUDGEABLE.includes(b.kind), `${b.kind} judgeable flag must match JUDGEABLE`);
  }
});

test("a blank line inside a fenced block does not split it", () => {
  const md = "```\nline one\n\nline two\n```\n";
  const code = splitBlocks(md).filter((b) => b.kind === "code");
  assert.equal(code.length, 1, "a fence is one block; splitting it emits fragments that are not claims");
  assert.match(code[0].text, /line one[\s\S]*line two/);
});

test("whitespace-only runs produce no block at all", () => {
  assert.equal(splitBlocks("\n\n   \n\n").length, 0, "empty is not a claim and must not inflate counts");
});

test("line numbers are 1-indexed, matching every other reader here", () => {
  const [first] = splitBlocks("alpha\n\nbeta\n");
  assert.equal(first.startLine, 1);
});

test("judgeableBlocks is splitBlocks filtered, never a second implementation", () => {
  const md = "# H\n\nprose\n\n- item\n";
  assert.deepEqual(
    judgeableBlocks(md).map((b) => b.sha),
    splitBlocks(md).filter((b) => b.judgeable).map((b) => b.sha),
  );
});

// ── store validation ────────────────────────────────────────────────────────

test("a well-formed verdict validates", () => {
  assert.equal(validateClaim(ok), true);
  assert.equal(dryValidateClaim(ok), null);
});

test("an unknown kind is rejected, and the message names the legal set", () => {
  const msg = dryValidateClaim({ ...ok, kind: "vibes" });
  assert.match(msg, /unknown "kind"/);
  for (const k of CLAIM_KINDS) assert.ok(msg.includes(k), `message must name ${k}`);
});

test("block_sha must be a full sha256 — a short or absent hash is refused", () => {
  assert.match(dryValidateClaim({ ...ok, block_sha: "abc123" }), /block_sha/);
  assert.match(dryValidateClaim({ ...ok, block_sha: undefined }), /block_sha/);
});

test("standing wrong/superseded require a reason", () => {
  for (const s of ["wrong", "superseded"]) {
    assert.match(dryValidateClaim({ ...ok, standing: s }), /requires a "reason"/, `${s} without reason`);
    assert.equal(dryValidateClaim({ ...ok, standing: s, reason: "measured 2026-09-01" }), null);
  }
  // The other standings do not — most blocks have a kind and nothing else.
  assert.equal(dryValidateClaim({ ...ok, standing: "current" }), null);
  for (const s of CLAIM_STANDINGS) assert.ok(typeof s === "string");
});

test("against and finding travel together, in both directions", () => {
  assert.match(dryValidateClaim({ ...ok, against: SHA2 }), /requires a "finding"/);
  assert.match(dryValidateClaim({ ...ok, finding: "contradicts" }), /without "against"/);
  assert.equal(dryValidateClaim({ ...ok, against: SHA2, finding: "consistent" }), null);
  for (const f of CLAIM_FINDINGS) assert.ok(typeof f === "string");
});

test("a contradiction must say what disagrees with what", () => {
  assert.match(dryValidateClaim({ ...ok, against: SHA2, finding: "contradicts" }), /requires a "reason"/);
  assert.equal(dryValidateClaim({ ...ok, against: SHA2, finding: "contradicts", reason: "code says X" }), null);
});

test("by_kind is closed and imported, never a free-text field", () => {
  assert.match(dryValidateClaim({ ...ok, by_kind: "robot" }), /unknown "by_kind"/);
  assert.equal(dryValidateClaim({ ...ok, by_kind: "agent" }), null);
});

test("a missing file is refused — a verdict must name the document it is about", () => {
  assert.match(dryValidateClaim({ block_sha: SHA, kind: "fact" }), /missing "file"/);
});

// ── append-only semantics ───────────────────────────────────────────────────

test("latestByBlock takes the last verdict per block, deterministically", () => {
  const claims = [
    { block_sha: SHA, kind: "impression", ts: "2026-09-01T00:00:00.000Z", claim_id: "A" },
    { block_sha: SHA, kind: "fact", ts: "2026-09-02T00:00:00.000Z", claim_id: "B" },
    { block_sha: SHA2, kind: "policy", ts: "2026-09-01T00:00:00.000Z", claim_id: "C" },
  ];
  const latest = latestByBlock(claims);
  assert.equal(latest.get(SHA).kind, "fact", "a re-judgment supersedes by being newer, not by editing");
  assert.equal(latest.get(SHA2).kind, "policy");
});

test("same-millisecond ties break by claim_id, not by read order", () => {
  const ts = "2026-09-01T00:00:00.000Z";
  const a = [{ block_sha: SHA, kind: "fact", ts, claim_id: "01B" }, { block_sha: SHA, kind: "policy", ts, claim_id: "01A" }];
  const b = [...a].reverse();
  assert.equal(latestByBlock(a).get(SHA).kind, latestByBlock(b).get(SHA).kind, "order of lines must not change the answer");
});

// ── path identity ───────────────────────────────────────────────────────────

test("canonicalFile collapses symlinked spellings of one path", async () => {
  const { canonicalFile } = await import("../../lib/claims/store.mjs");
  // On macOS /tmp is a symlink to /private/tmp. THIS is the bug that shipped for
  // an hour: a verdict written under one spelling was invisible to a lookup under
  // the other, and `render` reported that as "current — markers already match the
  // store". Found end-to-end, never by a unit test, because both halves used the
  // same spelling in every fixture.
  assert.equal(canonicalFile("/tmp"), canonicalFile("/private/tmp"));
});

test("canonicalFile does not throw for a path that does not exist", async () => {
  const { canonicalFile } = await import("../../lib/claims/store.mjs");
  // A verdict may outlive the document it was about — that is an ORPHANED verdict,
  // a state this store reports. Throwing here would make recording one impossible.
  const p = canonicalFile("/definitely/not/here/DOC.md");
  assert.equal(typeof p, "string");
  assert.ok(p.startsWith("/"), "falls back to an absolute path rather than failing");
});

test("canonicalFile always returns an absolute path, even for a relative input", async () => {
  const { canonicalFile } = await import("../../lib/claims/store.mjs");
  assert.ok(canonicalFile("some/relative/DOC.md").startsWith("/"));
});
