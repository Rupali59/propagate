/**
 * lib/backlog.mjs — the backlog aggregate view (task brief Component 2).
 * READ-ONLY. Tests use a temp dir tree, never the real workspace, and never
 * assert that a file was written.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  discoverBacklogFiles,
  parseStateLiveSections,
  parseTodoLikeFile,
  extractPriority,
  dedupeItems,
  backlog, closedSectionLines } from "../../lib/report/backlog.mjs";

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// ─────────────────────────────────────────────────────────────────────────
// STATE.md live sections
// ─────────────────────────────────────────────────────────────────────────

test("parseStateLiveSections extracts H3 items under a Now section, ignores unrelated sections", () => {
  const text = [
    "# STATE",
    "",
    "## Now (in flight)",
    "",
    "### First item",
    "body text",
    "",
    "### Second item",
    "more body",
    "",
    "## Some other section",
    "### not counted",
  ].join("\n");
  const { items } = parseStateLiveSections(text, "/fake/STATE.md");
  assert.deepEqual(items.map((i) => i.text), ["First item", "Second item"]);
  assert.equal(items[0].line, 5);
});

test("parseStateLiveSections falls back to top-level bullets when a section has no subheadings", () => {
  const text = ["## Pending", "", "- item one", "- item two", "  - nested, not counted separately", "## Next", "- next item"].join("\n");
  const { items } = parseStateLiveSections(text, "/fake/STATE.md");
  const pending = items.filter((i) => i.section === "Pending");
  assert.deepEqual(pending.map((i) => i.text), ["item one", "item two"]);
  const next = items.filter((i) => i.section === "Next");
  assert.deepEqual(next.map((i) => i.text), ["next item"]);
});

test("parseStateLiveSections matches Now/Active/Pending/Next case-insensitively with trailing qualifiers", () => {
  const text = ["## ACTIVE initiatives (cross-project)", "### one"].join("\n");
  const { items } = parseStateLiveSections(text, "/fake/STATE.md");
  assert.equal(items.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// TODOS.md — checkbox / id-keyed / stub / unrecognised
// ─────────────────────────────────────────────────────────────────────────

test("parseTodoLikeFile recognises checkbox format and counts open vs closed", () => {
  const text = ["# TODOS", "- [ ] open one", "- [x] done one", "- [ ] open two"].join("\n");
  const r = parseTodoLikeFile(text, "/fake/TODOS.md");
  assert.equal(r.format, "checkbox");
  assert.equal(r.parsed, 3);
  assert.equal(r.open, 2);
  assert.equal(r.closed, 1);
  assert.equal(r.unparsed, null);
});

test("parseTodoLikeFile recognises ID-keyed prose headings and excludes closed items", () => {
  const text = [
    "# TODOS",
    "### YV-004 · Build sub-project A",
    "body",
    "### YV-005 · ~~Old thing~~",
    "**Completed:** 2026-06-01",
    "### MI-012 done already",
  ].join("\n");
  const r = parseTodoLikeFile(text, "/fake/TODOS.md");
  assert.equal(r.format, "id-keyed");
  assert.equal(r.parsed, 3);
  assert.deepEqual(r.items.map((i) => i.id), ["YV-004"]);
});

test("parseTodoLikeFile recognises the bullet-style ID-keyed variant (- **TM-010** — ...), distinct from the heading variant", () => {
  const text = [
    "# TODOS",
    "## Cross-cutting",
    "- **TM-010** — Public read-only API at api.astroclarity.org (V2)",
    "- ~~**TM-018** — Reconcile BUILD.md~~ — **Closed 2026-06-20.** done",
    "- **TM-030** — Claim approved handles across platforms",
  ].join("\n");
  const r = parseTodoLikeFile(text, "/fake/TODOS.md");
  assert.equal(r.format, "id-keyed");
  assert.equal(r.parsed, 3);
  assert.deepEqual(r.items.map((i) => i.id), ["TM-010", "TM-030"]);
});

test("parseTodoLikeFile classifies an explicit 'none open' file as a stub, not unparsed", () => {
  const text = "# TODOS\n\nCross-cutting register.\n\n_None open — see STATE.md \"Pending\" for current work._\n";
  const r = parseTodoLikeFile(text, "/fake/TODOS.md");
  assert.equal(r.stub, true);
  assert.equal(r.parsed, 0);
  assert.equal(r.unparsed, null);
});

test("parseTodoLikeFile never reports parsed:0 for a file with real content it cannot classify", () => {
  const paragraph = "This file discusses ongoing architecture concerns in long-form prose without any checkbox or ID markers. ".repeat(5);
  const r = parseTodoLikeFile(paragraph, "/fake/TODOS.md");
  assert.equal(r.format, "unrecognised");
  assert.equal(r.parsed, null, "must not silently report 0 — that reads as 'nothing open'");
  assert.match(r.unparsed, /format not recognised/);
});

test("parseTodoLikeFile: a genuinely tiny file with no items is a stub, not unparsed", () => {
  const r = parseTodoLikeFile("# TODOS\n", "/fake/TODOS.md");
  assert.equal(r.stub, true);
  assert.equal(r.parsed, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Priority extraction
// ─────────────────────────────────────────────────────────────────────────

test("extractPriority reads a P0-P3 token, never invents one", () => {
  assert.equal(extractPriority("**Priority:** P1 — unblocks the rest"), 1);
  assert.equal(extractPriority("no priority mentioned here"), null);
});

// ─────────────────────────────────────────────────────────────────────────
// Dedup — exact match only
// ─────────────────────────────────────────────────────────────────────────

test("dedupeItems merges only byte-identical (normalized) text, reports the merge count", () => {
  const items = [
    { file: "a/STATE.md", line: 1, text: "Fix the login bug" },
    { file: "a/TODOS.md", line: 5, text: "fix the login bug" }, // same, different case
    { file: "b/STATE.md", line: 2, text: "Fix the login bug entirely differently worded" },
  ];
  const { items: out, mergedCount } = dedupeItems(items);
  assert.equal(out.length, 2);
  assert.equal(mergedCount, 1);
  const merged = out.find((i) => i.sources.length === 2);
  assert.ok(merged, "the two identical-text items must share one entry with two sources");
});

test("dedupeItems does NOT merge similar-but-not-identical text (no fuzzy matching)", () => {
  const items = [
    { file: "a", line: 1, text: "Paginate PRs in the daily runner" },
    { file: "b", line: 2, text: "Paginate PRs/issues in the daily runner" },
  ];
  const { items: out, mergedCount } = dedupeItems(items);
  assert.equal(out.length, 2);
  assert.equal(mergedCount, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Discovery + full backlog() over a synthetic tree
// ─────────────────────────────────────────────────────────────────────────

test("discoverBacklogFiles finds STATE.md, TODOS.md, docs/ISSUES.md across a tree, bounded by depth/budget", () => {
  const root = tmp("backlog-disc-");
  try {
    const projA = path.join(root, "ProjA");
    mkdirSync(path.join(projA, "docs"), { recursive: true });
    writeFileSync(path.join(projA, "STATE.md"), "# STATE\n");
    writeFileSync(path.join(projA, "TODOS.md"), "# TODOS\n");
    writeFileSync(path.join(projA, "docs", "ISSUES.md"), "# ISSUES\n");

    const found = discoverBacklogFiles({ searchRoots: [root] });
    assert.equal(found.stateMd.length, 1);
    assert.equal(found.todosMd.length, 1);
    assert.equal(found.issuesMd.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backlog(): end-to-end over a synthetic tree with mixed formats reports parsed/unparsed/stub per file and a deduped ranked list", () => {
  const root = tmp("backlog-e2e-");
  try {
    const alpha = path.join(root, "Alpha");
    mkdirSync(alpha, { recursive: true });
    writeFileSync(
      path.join(alpha, "STATE.md"),
      ["## Now (in flight)", "", "### Ship the login page", "body"].join("\n"),
    );
    writeFileSync(
      path.join(alpha, "TODOS.md"),
      ["# TODOS", "- [ ] Ship the login page", "- [x] done thing"].join("\n"),
    );

    const beta = path.join(root, "Beta");
    mkdirSync(beta, { recursive: true });
    const longProse = "Deferred architectural notes in long-form prose with no recognised markers whatsoever. ".repeat(4);
    writeFileSync(path.join(beta, "TODOS.md"), longProse);

    const gamma = path.join(root, "Gamma");
    mkdirSync(gamma, { recursive: true });
    writeFileSync(path.join(gamma, "TODOS.md"), "# TODOS\n\n_None open._\n");

    const result = backlog({ searchRoots: [root] });

    assert.equal(result.totals.todoFilesRead, 3);
    assert.equal(result.totals.unparsedFiles, 1);
    assert.equal(result.totals.unparsedFileList[0].file, path.join(beta, "TODOS.md"));
    assert.equal(result.totals.stubFiles, 1);

    // "Ship the login page" appears in both STATE.md and TODOS.md -- exact
    // text match after normalization -- so it should be merged into one row.
    assert.equal(result.mergedCount, 1);
    const shipItem = result.ranked.find((i) => /ship the login page/i.test(i.text));
    assert.ok(shipItem);
    assert.equal(shipItem.sources.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backlog(): never touches disk for writes — the input tree is byte-identical after a full run", () => {
  const root = tmp("backlog-readonly-");
  try {
    const p = path.join(root, "Solo");
    mkdirSync(p, { recursive: true });
    const original = "# TODOS\n- [ ] one thing\n";
    writeFileSync(path.join(p, "TODOS.md"), original);
    backlog({ searchRoots: [root] });
    assert.equal(readFileSync(path.join(p, "TODOS.md"), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- closed sections (added 2026-08-14) ------------------------------------
// `Vipin Kaushik/TODOS.md:56` is "## Archived directly (resolved / done /
// cancelled — no cherry-pick needed)" and its body says the rows under it were
// "already closed ... but stayed in TODOS.md as historical rows." Nine of them
// were reported as OPEN backlog: item-level matching missed "CANCELLED" and
// "resolved", both absent from CLOSED_MARKERS_RE until this fix.
test("items under a closed-declaring heading are closed, whatever their own text says", () => {
  const text = [
    "# TODOS",
    "## Cross-cutting",
    "- **TM-010** — Public read-only API (V2)",
    "## Archived directly (resolved / done / cancelled)",
    "- **TM-044** — Prashna feature CANCELLED 2026-06-09",
    "- **TM-087** — Hotjar DNT-compliance resolved (PR #58)",
    "## Orphan",
    "- **TM-099** — still open",
  ].join("\n");
  const r = parseTodoLikeFile(text, "/fake/TODOS.md");
  assert.equal(r.format, "id-keyed");
  assert.equal(r.parsed, 4);
  assert.equal(r.open, 2, "only TM-010 and TM-099 are open");
  assert.deepEqual(r.items.map((i) => i.id).sort(), ["TM-010", "TM-099"]);
});

test("a closed section ends at the next same-or-shallower heading", () => {
  // Otherwise everything after the first archived section reads as closed —
  // an under-reporting backlog, which is the same defect facing the other way.
  const lines = ["# T", "## Archived", "- **A-1** — x", "### Sub of archived", "- **A-2** — y", "## Live", "- **B-1** — z"];
  const closed = closedSectionLines(lines);
  assert.ok(closed.has(3) && closed.has(5), "both archived items are inside the section");
  assert.ok(!closed.has(7), "the item under ## Live must NOT be closed");
});

test("checkbox files respect closed sections too", () => {
  const text = ["# T", "## Done in 2026-06", "- [ ] shipped thing", "## Now", "- [ ] real thing"].join("\n");
  const r = parseTodoLikeFile(text, "/fake/TODOS.md");
  assert.equal(r.open, 1, "an unchecked box under a 'Done' heading is not open work");
});
