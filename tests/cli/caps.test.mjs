/**
 * lib/report/caps.mjs — tree-wide context-budget caps. READ-ONLY.
 *
 * The tests that matter are the ones N53 would have failed. N53 is a checker
 * that read a 14-line pointer stub and rendered it as a pass, so three files at
 * 2-3x their cap were invisible while two others passed BY ACCIDENT at 93 and
 * 38 real lines. Every test here asserts an OUTCOME is attributable, not merely
 * that a number came back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countLines, countEntries, isPointerStub, classifyPath, capFor, capsReport,
  DEFAULT_CAPS, GOTCHAS_CAP,
} from "../../lib/report/caps.mjs";

// ── the N53 shape ────────────────────────────────────────────────────────────

test("a legacy-path pointer stub is SKIPPED, never a passing line count", () => {
  const stub = "# STATE\n\n> This file has moved.\n> State lives at ../propagation/state/x/STATE.md\n";
  const c = classifyPath("/hub/W/P/STATE.md", stub, "/hub");
  assert.equal(c.source, "stub-legacy");

  const r = capsReport({
    discover: () => ({ stateMd: ["/hub/W/P/STATE.md"], todosMd: [], issuesMd: [], handoverMd: [], claudeMd: [], gotchasMd: [], memoryMd: [] }),
    readFile: () => stub,
    hubRoot: "/hub",
  });
  const rec = r.records[0];
  assert.equal(rec.status, "skipped", "a stub must NOT be measured as a small passing file — this is N53");
  assert.equal(rec.actual, undefined, "no count should be published for a file we did not really read");
  assert.equal(r.totals.over, 0);
  assert.equal(r.totals.skippedStubs, 1, "and it must be COUNTED, so the skip is visible rather than silent");
});

test("a SHORT REAL file is not mistaken for a stub", () => {
  // Astroclarity (93 lines) and VipinKaushik-mb (38) genuinely pass. If short
  // meant stub, those two would vanish from the report and the accidental-pass
  // problem would just move.
  const real = "# STATE\n\n## Now\n\n### A thing\nbody\n";
  assert.equal(isPointerStub(real), false);
  assert.equal(classifyPath("/hub/W/P/STATE.md", real, "/hub").source, "in-repo");
});

// ── scope, which decides WHICH cap applies ───────────────────────────────────

test("scope is depth: hub root and workspace root are workspace-scope, deeper is project", () => {
  const t = "x\n";
  assert.equal(classifyPath("/hub/CLAUDE.md", t, "/hub").scope, "workspace");
  assert.equal(classifyPath("/hub/W/CLAUDE.md", t, "/hub").scope, "workspace");
  assert.equal(classifyPath("/hub/W/P/CLAUDE.md", t, "/hub").scope, "project");
});

test("without a hub root, in-repo scope degrades to project — and that must be REPORTED", () => {
  // G24: an unconfigured value resolving to null reads as "not configured"
  // rather than "configured wrong". Here it silently judges a workspace file
  // at the project cap, which is how `Vipin Kaushik/CLAUDE.md` read as over.
  assert.equal(classifyPath("/hub/W/CLAUDE.md", "x\n", null).scope, "project");
  const r = capsReport({
    discover: () => ({ stateMd: [], todosMd: [], issuesMd: [], handoverMd: [], claudeMd: ["/hub/W/CLAUDE.md"], gotchasMd: [], memoryMd: [] }),
    readFile: () => "x\n",
    hubRoot: null,
  });
  assert.ok(r.scopeDegraded, "a degraded classification must be stated, not absorbed");
});

test("workspace and project CLAUDE.md carry DIFFERENT caps", () => {
  assert.equal(capFor({ kind: "CLAUDE.md", scope: "workspace" }), DEFAULT_CAPS["workspace/CLAUDE.md"]);
  assert.equal(capFor({ kind: "CLAUDE.md", scope: "project" }), DEFAULT_CAPS["project/CLAUDE.md"]);
  assert.notEqual(DEFAULT_CAPS["workspace/CLAUDE.md"], DEFAULT_CAPS["project/CLAUDE.md"]);
});

// ── counting ─────────────────────────────────────────────────────────────────

test("countLines matches `wc -l`: a trailing newline does not add a line", () => {
  // Off by one flips the verdict for any file sitting EXACTLY at its cap,
  // because the comparison is `>=`. Caught by disagreeing with the very hook
  // this replaces (220 vs its 219).
  assert.equal(countLines("a\nb\nc\n"), 3);
  assert.equal(countLines("a\nb\nc"), 3);
  assert.equal(countLines(""), 0);
});

test("an auto-rendered HYGIENE_RENDER block does not count toward the cap", () => {
  const text = ["keep1", "<!-- HYGIENE_RENDER:START -->", "gen", "gen", "<!-- HYGIENE_RENDER:END -->", "keep2"].join("\n");
  assert.equal(countLines(text), 2, "only hand-written lines count");
});

test("an UNCLOSED render block falls back to the FULL count — fail-safe, never truncating", () => {
  const text = ["keep1", "<!-- HYGIENE_RENDER:START -->", "gen", "gen", "gen"].join("\n");
  assert.equal(countLines(text), 5, "a broken marker must OVER-report, never swallow the rest of the file");
});

test("countEntries strips fenced blocks — propagate's own N51, one file over", () => {
  const text = [
    "### G1 real",
    "body",
    "```markdown",
    "### G99 an EXAMPLE inside a fence",
    "```",
    "### G2 real",
  ].join("\n");
  assert.equal(countEntries(text), 2, "a fenced example is not an entry");
});

// ── statuses that are not passes ─────────────────────────────────────────────

test("GOTCHAS.md is measured in entries and reported EXEMPT — which is not a pass", () => {
  // Renamed from "unset" on 2026-08-28 (D11). "unset" implied a number was still
  // coming; it is not. Gotchas never auto-load — the guard delivers one matching
  // entry at the moment of risk — so there is no budget to cap. The status must
  // still not read as OK: measured and deliberately unjudged is a third thing.
  assert.equal(GOTCHAS_CAP, null, "deliberately uncapped, not pending a number");
  const r = capsReport({
    discover: () => ({ stateMd: [], todosMd: [], issuesMd: [], handoverMd: [], claudeMd: [], gotchasMd: ["/hub/W/propagation/state/x/GOTCHAS.md"], memoryMd: [] }),
    readFile: () => "### A\nb\n### B\nb\n",
    hubRoot: "/hub",
  });
  const rec = r.records[0];
  assert.equal(rec.metric, "entries");
  assert.equal(rec.actual, 2);
  assert.equal(rec.status, "exempt");
  assert.notEqual(rec.status, "ok", "no cap must never render as green");
});

test("an unreadable file reports WHY, and is never counted as measured", () => {
  const r = capsReport({
    discover: () => ({ stateMd: ["/hub/W/P/STATE.md"], todosMd: [], issuesMd: [], handoverMd: [], claudeMd: [], gotchasMd: [], memoryMd: [] }),
    readFile: () => { throw new Error("EACCES"); },
    hubRoot: "/hub",
  });
  assert.equal(r.records[0].status, "unreadable");
  assert.match(r.records[0].reason, /EACCES/);
  assert.equal(r.totals.measured, 0);
});

test("MEMORY.md absence is reported as NOT DISCOVERED, never as a clean zero", () => {
  // It lives at ~/.claude/projects/*/memory/, outside the walked tree. Zero
  // here would be a reader that never looked, rendered as a good result.
  const r = capsReport({
    discover: () => ({ stateMd: [], todosMd: [], issuesMd: [], handoverMd: [], claudeMd: [], gotchasMd: [], memoryMd: [] }),
    readFile: () => "",
    hubRoot: "/hub",
  });
  assert.equal(r.notDiscovered.length, 1);
  assert.equal(r.notDiscovered[0].kind, "MEMORY.md");
});

test("over-cap is >= , and excessLines sums the overage", () => {
  const at = "x\n".repeat(DEFAULT_CAPS["project/STATE.md"]);
  const r = capsReport({
    discover: () => ({ stateMd: ["/hub/W/P/propagation/state/P/STATE.md"], todosMd: [], issuesMd: [], handoverMd: [], claudeMd: [], gotchasMd: [], memoryMd: [] }),
    readFile: () => at,
    hubRoot: "/hub",
  });
  assert.equal(r.records[0].status, "over", "exactly AT the cap is over, matching the shell's `>=`");
  assert.equal(r.totals.excessLines, 0, "at the cap the overage is zero, but the status is still over");
});
