/**
 * Edge ids are persisted, so their derivation is frozen.
 *
 * WHY THIS EXISTS, and why it was written before touching lib/events.mjs (N33).
 * The NUL fix replaces a literal 0x00 byte with the six-character escape. That is
 * "obviously" a no-op — and "obviously a no-op" is the exact class of change that
 * has silently broken a hash before. `edgeId` output is written into the append-only
 * event store: every baselined verification, every disposition, every `--apply` since
 * the v2 migration is keyed by it. If the derivation moves by one byte, every
 * existing event orphans from its edge and the whole store reads as unverified.
 * There is no migration for that, because the store cannot be rewritten.
 *
 * So the fix is not asserted to be safe — it is measured. These expectations were
 * captured from the RUNNING code on 2026-08-19, BEFORE the escape was applied:
 *
 *     node -e 'import("./lib/events.mjs").then(m => console.log(m.edgeId("x","y","z")))'
 *
 * If this test goes red, the fix was not cosmetic and must be reverted, not adjusted.
 * DO NOT re-capture these values to make it pass — that converts the alarm into a
 * rubber stamp, which is the failure rule:discernment-checks §1 is about.
 *
 * Pairs with tests/no-literal-nul.test.mjs: that one proves the byte is gone, this
 * one proves nothing else moved with it. Neither is sufficient alone — the NUL test
 * would pass just as happily if someone deleted the separator entirely, which would
 * collide `a/b`+`c` with `a`+`b/c`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeId } from "../lib/events.mjs";

/** Captured from the pre-fix implementation. Frozen — see the header. */
const FROZEN = [
  { args: ["a/b.md", "c/d.md", "because"], id: "3340074a" },
  { args: ["x", "y", "z"], id: "dab23bf6" },
  { args: ["lib/graph.mjs", "SKILL.md", "worklist semantics"], id: "39cf8b39" },
];

test("edgeId derivation is unchanged by the NUL escape (N33)", () => {
  for (const { args, id } of FROZEN) {
    assert.equal(
      edgeId(...args),
      id,
      `edgeId(${args.map((a) => JSON.stringify(a)).join(", ")}) moved. ` +
        `Every persisted event keyed by the old value would orphan. Revert the change.`,
    );
  }
});

test("the separator still separates — adjacent fields cannot collide", () => {
  // The reason the NUL is there at all. Without a separator that cannot occur in a
  // path, these two distinct edges hash identically, and the duplicate-pair index
  // and edge-id store both silently merge them.
  assert.notEqual(
    edgeId("a/b", "c", "w"),
    edgeId("a", "b/c", "w"),
    "concatenation collision: the separator has been weakened or removed",
  );
  assert.notEqual(
    edgeId("a", "b", "cd"),
    edgeId("a", "bc", "d"),
    "collision across the second separator",
  );
});
