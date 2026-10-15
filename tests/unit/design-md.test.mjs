/**
 * design-md.test.mjs — DESIGN.md's own derivation command must run.
 *
 * DESIGN.md tells the reader to derive its colour numbers with a fenced command
 * instead of trusting a figure in prose. That command read `commands/ui.css` for
 * three weeks after 15c74ab split the stylesheet into `commands/ui/css/*.css`, so
 * the one instruction meant to keep the document honest failed (widget redesign
 * eng review, E5, 2026-10-13). A doc whose verification step is dead reads as
 * verified. This runs the block exactly as written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "../..");
const doc = readFileSync(path.join(ROOT, "DESIGN.md"), "utf8");

test("DESIGN.md's first fenced sh block runs and derives every semantic token", () => {
  const m = /```sh\n([\s\S]*?)\n```/.exec(doc);
  assert.ok(m, "DESIGN.md has no ```sh block — the derivation instruction is gone, not passing");
  const r = spawnSync("bash", ["-c", m[1]], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, `the derivation command failed: ${(r.stderr || "").split("\n")[0]}`);
  const rows = r.stdout.trim().split("\n").filter((l) => l.startsWith("--"));
  // Floor, not an exact count: the block prints one row per token it lists.
  assert.ok(rows.length >= 7, `expected >=7 token rows, got ${rows.length} — the scan has gone blind`);
  for (const row of rows) assert.match(row, /#[0-9a-f]{6}\s+\d+\.\d{2}$/, `unresolved token row: ${row}`);
});
