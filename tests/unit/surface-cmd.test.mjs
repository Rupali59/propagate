/**
 * commands/surface.mjs — the text renderer's CHANGED line (PR-024).
 *
 * `lib/report/surface.mjs` derives `changed` as {value, label, tone}, the
 * same shape `headline` uses, and `--json` has carried it since that field
 * was added. The text renderer never read it, so the number was invisible to
 * anyone not passing `--json` — filed as PR-024 and fixed here.
 *
 * `changedLine()` is unit-tested directly (exported from commands/surface.mjs)
 * rather than through `surfaceCmd()` end-to-end, because `surfaceCmd()` calls
 * the real `surfacePayload()` with no injection seam — composing live doctor
 * snapshot, queue, registers and stream state with no fixture layer. That
 * composition is lib/report/surface.mjs's territory, not this command's; this
 * command owns only the rendering of whatever payload it is handed, which is
 * exactly what `changedLine()` isolates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { changedLine, surfaceCmd } from "../../commands/surface.mjs";

// ---------------------------------------------------------------------------
// changedLine — the null-vs-zero distinction is the load-bearing part
// ---------------------------------------------------------------------------

test("changedLine: a real count prints the number, not just the tone mark", () => {
  const line = changedLine({ value: 3, label: "changed", tone: "none" });
  assert.match(line, /\b3\b/);
  assert.match(line, /changed/);
});

test("changedLine: zero changed is a CLEAN result and prints as 0, not blank", () => {
  const line = changedLine({ value: 0, label: "changed", tone: "ok" });
  assert.match(line, /\b0\b/, "a real zero must be visible, not rendered as an empty string");
  assert.match(line, /✓/, "tone ok uses the ok mark");
});

test("changedLine: a null value (no stream) never prints as 0 or blank — it says it could not derive", () => {
  const line = changedLine({ value: null, label: "no stream", tone: "unknown" });
  assert.ok(line, "must produce a line, never a silent omission");
  assert.doesNotMatch(line, /\b0\b/, "a null must not be confusable with a real zero");
  assert.match(line, /could not derive/);
  assert.match(line, /no stream/);
});

test("changedLine: a null value (stream error) is distinguishable from the 'no stream' case", () => {
  const noStream = changedLine({ value: null, label: "no stream", tone: "unknown" });
  const streamError = changedLine({ value: null, label: "stream error", tone: "unknown" });
  assert.notEqual(noStream, streamError, "two different reasons for 'could not derive' must read differently");
});

test("changedLine: FAILING INPUT — a naive renderer that used `value ?? 0` would collapse null into zero", () => {
  // Demonstrate the exact defect this function exists to prevent, so the
  // assertions above are not accidental: `value ?? 0` is a real implementation
  // someone could plausibly write, and it destroys the distinction.
  const changed = { value: null, label: "no stream", tone: "unknown" };
  const naive = `${changed.value ?? 0} ${changed.label}`;
  assert.match(naive, /^0 /, "the naive version reads exactly like a real zero — this is the bug PR-024's fix avoids");
  const real = changedLine(changed);
  assert.notEqual(real, naive);
});

test("changedLine: an absent changed field renders nothing rather than throwing", () => {
  assert.equal(changedLine(null), null);
  assert.equal(changedLine(undefined), null);
});

// ---------------------------------------------------------------------------
// surfaceCmd — --json sanity check. The full text-mode integration (does the
// changed line actually land in `propagate surface`'s real output, in the
// right position) is a CLI subprocess test: tests/cli/surface.test.mjs.
// ---------------------------------------------------------------------------

function fakeIo() {
  const lines = [];
  return { log: (s) => lines.push(String(s)), lines };
}

test("surfaceCmd: --json mode is untouched by this change — one JSON line, changed inside it", async () => {
  const io = fakeIo();
  const rc = await surfaceCmd(["--json"], io);
  assert.ok(rc === 0 || rc === 2, `unexpected exit code ${rc}`);
  assert.equal(io.lines.length, 1, "--json prints exactly one line");
  const payload = JSON.parse(io.lines[0]);
  if (rc === 0) assert.ok("changed" in payload, "the field this whole fix is about must still be in --json");
});
