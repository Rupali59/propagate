/**
 * public-scrub.test.mjs — the identity-map scrub shared by `make-public` and the
 * ISSUES.md -> GitHub migration (2026-10-12). Two publishers, one function: these
 * pin the two properties both rely on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeMap, scrub, scrubEntries } from "../../lib/core/public-scrub.mjs";

test("longest real name is replaced first, so a prefix name cannot split it", () => {
  const entries = scrubEntries({ Acme: "ws-a", "Acme Labs": "ws-b" });
  assert.equal(scrub("Acme Labs and Acme", entries), "ws-b and ws-a");
});

test("home paths become $HOME after names are scrubbed", () => {
  assert.equal(scrub("/Users/someone/Documents/x", []), "$HOME/Documents/x");
});

test("both map shapes normalise to {names, allow}", () => {
  assert.deepEqual(normalizeMap({ A: "a" }), { names: { A: "a" }, allow: [] });
  assert.deepEqual(normalizeMap({ names: { A: "a" }, allow: ["B"] }), { names: { A: "a" }, allow: ["B"] });
});
