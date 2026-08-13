/**
 * watcher.mjs retirement (docs/DECISIONS.md 2026-08-14).
 *
 * Source-inspection only, deliberately NOT an end-to-end subprocess run —
 * same reasoning N14's resolution documents in docs/ISSUES.md for `reload`:
 * this is the one code path that is supposed to touch a real, unattended
 * launchd-invoked entry point, so a test harness accidentally exercising it
 * for real is exactly the risk (docs/GOTCHAS.md G10) this file's whole
 * safety section (task brief) exists to avoid. If this file's refusal ever
 * needs an end-to-end check, do it by hand, deliberately, never as part of
 * an automated suite that could run unattended.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const WATCHER_PATH = fileURLToPath(new URL("../watcher.mjs", import.meta.url));

test("watcher.mjs: header records retirement, date, and points at the DECISIONS.md entry", async () => {
  const src = await readFile(WATCHER_PATH, "utf8");
  const header = src.slice(0, src.indexOf("Original v1 doc comment"));
  assert.match(header, /RETIRED 2026-08-14/);
  assert.match(header, /docs\/DECISIONS\.md 2026-08-14/);
  // Must not be silent about WHY (docs/GOTCHAS.md G2: absence must be
  // attributable) — the evidence numbers from the retirement decision.
  assert.match(header, /4,420/);
  assert.match(header, /99\.2%/);
});

test("watcher.mjs: direct invocation refuses to run unless explicitly overridden, and never silently", async () => {
  const src = await readFile(WATCHER_PATH, "utf8");
  const guardStart = src.indexOf("if (_invokedDirectly)");
  assert.notEqual(guardStart, -1, "the direct-invocation guard must still exist");
  const guardBody = src.slice(guardStart);

  // The refusal must be gated behind an explicit, named override — not a
  // silent no-op (G1: a check that cannot fail is worse than no check) and
  // not an unconditional crash either (an explicit override path is what
  // the task brief asks for: "refuse loudly... rather than silently writing
  // v1 rows").
  assert.match(guardBody, /PROPAGATE_ALLOW_RETIRED_WATCHER/);
  assert.match(guardBody, /process\.exit\(1\)/);
  assert.match(guardBody, /RETIRED/);

  // The override must gate the ORIGINAL main() call — i.e. main() is still
  // reachable (never actually deleted, per the task brief: "do NOT delete
  // the file"), just no longer reachable by default.
  assert.match(guardBody, /main\(\)\.catch/);

  // The refusal branch must come before the main() call in source order, so
  // the default path is "refuse", not "run, then maybe also warn".
  const refusalIdx = guardBody.indexOf("PROPAGATE_ALLOW_RETIRED_WATCHER");
  const mainCallIdx = guardBody.indexOf("main().catch");
  assert.ok(refusalIdx < mainCallIdx, "the refusal check must precede the main() call");
});
