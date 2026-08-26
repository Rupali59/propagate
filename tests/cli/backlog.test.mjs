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

test("a LONG register that merely mentions 'no open' in prose is NOT a stub", () => {
  // Measured 2026-08-25 on propagate's own ISSUES.md: 63 id-keyed entries, and
  // the words "no open" appear twice in prose at :906 and :933. The stub branch
  // was `STUB_EXPLICIT_RE.test(text) || length < 220` — an OR — so the phrase
  // anywhere at any size declared the whole file a stub with open:0.
  //
  // Reporting a full register as "0 open" is worse than failing to find it: a
  // parser gap becomes a confident false negative.
  const body = ["# Issues", "", "### N1 · a real thing", "x".repeat(600), "", "there is no open question here", ""].join("\n");
  const r = parseTodoLikeFile(body, "/tmp/ISSUES.md");
  assert.notEqual(r.format, "stub", "a 600+ char register must not be a stub because of a prose mention");
  assert.ok(r.open >= 1, "its real entry must survive");
});

test("a SHORT file declaring 'none open' is still a stub — the marker keeps working", () => {
  const r = parseTodoLikeFile("# TODOS\n\nnone open\n", "/tmp/TODOS.md");
  assert.equal(r.format, "stub");
  assert.equal(r.open, 0);
});

test("parseTodoLikeFile recognises DASHLESS leading ids (### N1 ·), not only TM-010 style", () => {
  // ID_HEADING_RE requires 2-6 letters, a dash, 2-4 digits. propagate numbers
  // its register N1..N50 plus A/B/C/E/G prefixes — 63 entries, every one
  // invisible until ID_HEADING_LEADING_RE was added.
  const body = [
    "# Issues",
    "",
    "### N1 · first thing — **S1**",
    "### A2 · second thing — **S2**",
    "### B3 · done thing — **RESOLVED 2026-08-13**",
  ].join("\n");
  const r = parseTodoLikeFile(body, "/tmp/ISSUES.md");
  assert.equal(r.format, "id-keyed");
  assert.equal(r.parsed, 3, "all three headings are entries");
  assert.equal(r.open, 2, "the RESOLVED one is closed, not open");
});

test("the dashless id must be ANCHORED — an id inside heading prose is not an item", () => {
  // The safety margin on a weak fingerprint. `N1` is far less distinctive than
  // `TM-010`, so an unanchored version would promote ordinary headings into
  // backlog items. These three must NOT parse as id-keyed.
  for (const heading of ["## V2 roadmap and beyond", "### Fix S1 before shipping", "## Notes on N1 and friends"]) {
    const r = parseTodoLikeFile(`# Doc\n\n${heading}\n${"y".repeat(400)}\n`, "/tmp/TODOS.md");
    assert.notEqual(r.format, "id-keyed", `"${heading}" must not be read as an ID-keyed item`);
  }
  // ...but a genuine leading id at the same depth must.
  const ok = parseTodoLikeFile(`# Doc\n\n## V2 · a real entry\n${"y".repeat(400)}\n`, "/tmp/TODOS.md");
  assert.equal(ok.format, "id-keyed", "a leading id IS an item, even when short");
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
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("discoverBacklogFiles finds ISSUES.md as a SIBLING of STATE.md — the v3 layout, not just docs/", () => {
  // THE REGRESSION THIS PINS. The v3 move (2026-08-22/23) relocated ISSUES.md
  // to propagation/state/<project>/ISSUES.md, beside STATE.md. This reader
  // still checked only `<dir>/docs/ISSUES.md`, so on 2026-08-25 `backlog`
  // printed "0 docs/ISSUES.md discovered" while the tree's ONLY ISSUES.md --
  // propagate's own, 43 open entries -- sat in a directory the walk was
  // already visiting (it collected STATE.md from beside it).
  //
  // Zero is the dangerous output here: it reads as "no issues exist" rather
  // than "I looked where they are not" (rule:discernment-checks §6).
  const root = tmp("backlog-v3-issues-");
  try {
    const ws = path.join(root, "Workspace", "propagation", "state", "workspace");
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "STATE.md"), "# STATE\n");
    writeFileSync(path.join(ws, "ISSUES.md"), "# ISSUES\n\n### N1 · a thing\n");

    const found = discoverBacklogFiles({ searchRoots: [root] });
    assert.equal(
      found.issuesMd.length,
      1,
      "ISSUES.md beside STATE.md must be discovered — checking only docs/ISSUES.md is the pre-v3 pattern",
    );
    assert.ok(found.issuesMd[0].endsWith(path.join("workspace", "ISSUES.md")));
    // The walk reaching the directory is the premise of the bug report, so
    // assert it rather than assume it: if this fails the cause is traversal,
    // not the path pattern, and the fix above is aimed at the wrong thing.
    assert.equal(found.stateMd.length, 1, "the walk must reach that directory at all");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("discoverBacklogFiles still finds the LEGACY docs/ISSUES.md — unmigrated workspaces must not lose their issues", () => {
  // Both paths are kept deliberately. Swapping rather than adding would move
  // the blind spot instead of removing it.
  const root = tmp("backlog-legacy-issues-");
  try {
    const proj = path.join(root, "Old");
    mkdirSync(path.join(proj, "docs"), { recursive: true });
    writeFileSync(path.join(proj, "docs", "ISSUES.md"), "# ISSUES\n");
    const found = discoverBacklogFiles({ searchRoots: [root] });
    assert.equal(found.issuesMd.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a project carrying BOTH layouts reports two files, never one silently dropped", () => {
  const root = tmp("backlog-both-issues-");
  try {
    const proj = path.join(root, "Both");
    mkdirSync(path.join(proj, "docs"), { recursive: true });
    writeFileSync(path.join(proj, "docs", "ISSUES.md"), "# legacy\n");
    writeFileSync(path.join(proj, "ISSUES.md"), "# current\n");
    const found = discoverBacklogFiles({ searchRoots: [root] });
    assert.equal(found.issuesMd.length, 2, "mid-migration both exist; collapsing them hides one");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

test("the backlog COMMAND renders handovers — collecting them is not delivering them", () => {
  // The defect this pins is not a wrong value, it is an unread one. Handovers
  // were parsed from 2026-08-22 and rendered nowhere until 2026-08-25: present
  // in `--json`, absent from the command every human actually runs. A source
  // that is collected and never shown delivers what one that was never built
  // delivers (rule:enforcement-watches-itself: "grep for the callers of what you
  // just built").
  //
  // Asserting on the RENDERER's source rather than on captured stdout keeps this
  // free of the real filesystem — `backlog()` walks SEARCH_ROOTS, so a stdout
  // test would depend on the machine it runs on.
  const cli = readFileSync(new URL("../../cli.mjs", import.meta.url), "utf8");
  const body = cli.slice(cli.indexOf("async function backlogCmd"));
  const cmd = body.slice(0, body.indexOf("\nasync function ", 1));
  assert.ok(
    /result\.handovers/.test(cmd),
    "backlogCmd must read result.handovers — it collected them and printed nothing for three days",
  );
  assert.ok(/unscoped|handovers/i.test(cmd), "and must label them for a reader");
});

test("handovers reach the backlog result with per-file sections", () => {
  // The data contract the renderer above depends on. If this shape changes the
  // renderer goes quiet, which is the original failure returning by a new door.
  const root = tmp("backlog-handover-");
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "HANDOVERS.md"),
      ["# Handovers", "", "## 2026-08-25 · a thing to hand over", "body text", ""].join("\n"),
    );
    const r = backlog({ searchRoots: [root] });
    assert.ok(r.handovers, "result must carry a handovers block");
    assert.equal(r.handovers.files.length, 1);
    assert.ok(r.handovers.files[0].sections.length >= 1, "its dated section must be found");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a migration POINTER STUB is its own format, not 'unparsed'", () => {
  // Measured 2026-08-25: 14 of the tree's 23 TODOS.md were migration stubs, and
  // every one rendered RED as "format not recognised" — 14 of 23 files reported
  // broken while working exactly as designed.
  //
  // The cost is not cosmetic. `unparsed` is a real defect signal ("content I
  // could not read"); drowning it in 14 false positives trains the reader to
  // skip the list, which is how the genuinely unreadable file goes unnoticed.
  // After this change the red list is 3 files, and all three are real.
  const stub = [
    "# TODOS.md — moved",
    "",
    "This is a **pointer stub**, not the state. The file now lives at `propagation/state/workspace/TODOS.md`",
    "in the `Motherboard` workspace, with `.sidecar.yml` beside it.",
    "",
    "Do not edit this file. Edit the target.",
  ].join("\n");
  const r = parseTodoLikeFile(stub, "/tmp/TODOS.md");
  assert.equal(r.format, "pointer-stub");
  assert.equal(r.unparsed, null, "a stub is not an unreadable file");
  assert.equal(r.open, 0, "0 open is correct — the real file is discovered separately and counted there");
  assert.match(r.stubReason, /propagation\/state\/workspace\/TODOS\.md/, "it must name where the state went");
});

test("pointer-stub is DISTINCT from the 'none open' stub — they assert different things", () => {
  // `stub` says nothing is open HERE. `pointer-stub` says the state is
  // somewhere ELSE and is counted there. Collapsing them would lose the target.
  const none = parseTodoLikeFile("# TODOS\n\nnone open\n", "/tmp/a.md");
  const ptr = parseTodoLikeFile("# TODOS.md — moved\n\nnow lives at `x/TODOS.md`\n", "/tmp/b.md");
  assert.equal(none.format, "stub");
  assert.equal(ptr.format, "pointer-stub");
});

test("a REAL state file mentioning a move is not swallowed as a pointer stub", () => {
  // The safety margin, inherited from isPointerStubText's 40-line bound. A
  // detector that calls everything a stub hides real backlog — worse than the
  // noise it removes.
  const real = ["# TODOS", "", "This work moved from another repo last week.", ""]
    .concat(Array.from({ length: 45 }, (_, i) => `- [ ] task ${i}`))
    .join("\n");
  const r = parseTodoLikeFile(real, "/tmp/TODOS.md");
  assert.equal(r.format, "checkbox", "45 real checkbox items must survive the word 'moved'");
  assert.equal(r.open, 45);
});

test("a heading WITH bullets is a group — the bullets are the items, the label never is", () => {
  // THE REGRESSION THIS PINS, measured 2026-08-26. `parseStateLiveSections` took
  // every subheading as an item and never descended, so the canonical STATE.md
  // shape `## Pending (by priority)` -> `### P1` -> bullets reported the BUCKET
  // as work and the tasks under it were unreachable. Across 48 STATE.md files:
  // 174 items reported, 343 actually present, and 16 priority labels standing in
  // for work that was invisible. Wrong in both directions at once.
  const md = [
    "# S", "",
    "## Pending (by priority)", "",
    "### P1 — Rebuild", "",
    "- **Rebuild the app shell** — no `app/` exists",
    "- **Homepage build** against the brief",
    "",
    "### P2 — Deferred", "",
    "- **Kundli renderer port** from VipinKaushik",
  ].join("\n");
  const { items } = parseStateLiveSections(md, "/tmp/STATE.md");
  assert.deepEqual(
    items.map((i) => i.text),
    ["**Rebuild the app shell** — no `app/` exists", "**Homepage build** against the brief", "**Kundli renderer port** from VipinKaushik"],
  );
  assert.ok(!items.some((i) => /^P[0-9]/.test(i.text)), "a bucket label must never be an item");
  assert.equal(items[0].group, "P1 — Rebuild", "the bucket is carried as context, not discarded");
  assert.equal(items[2].group, "P2 — Deferred");
});

test("a heading with NO bullets is itself the item — Now sections must not regress", () => {
  // The other real shape in the tree: `## Now` uses `### Task` with a prose body
  // and no bullets. The deepest-node rule must keep treating those as items, or
  // fixing Pending would silently empty every Now section.
  const md = [
    "# S", "",
    "## Now (in flight)", "",
    "### Instrument-fronted V1 rebuild", "",
    "the platform-as-protagonist variant, prose body, no bullets",
    "",
    "### Design-process docs seeded", "",
    "more prose",
  ].join("\n");
  const { items } = parseStateLiveSections(md, "/tmp/STATE.md");
  assert.deepEqual(items.map((i) => i.text), ["Instrument-fronted V1 rebuild", "Design-process docs seeded"]);
  assert.equal(items[0].format, "state-subheading");
  assert.ok(items.every((i) => i.group === undefined), "an item that is its own heading has no group");
});

test("one file carrying BOTH shapes resolves each on its own structure", () => {
  const md = [
    "# S", "",
    "## Now (in flight)", "",
    "### Ship the login page", "",
    "prose only",
    "",
    "## Pending (by priority)", "",
    "### P1", "",
    "- do the thing",
  ].join("\n");
  const { items } = parseStateLiveSections(md, "/tmp/STATE.md");
  assert.deepEqual(items.map((i) => [i.format, i.text]), [
    ["state-subheading", "Ship the login page"],
    ["state-bullet", "do the thing"],
  ]);
});

test("a deeper sub-group owns its own bullets — they do not leak into the parent", () => {
  // The nesting bound. Without it a `####` sub-group's bullets would be absorbed
  // by the `###` above it and counted twice, or attributed to the wrong group.
  const md = [
    "# S", "",
    "## Pending", "",
    "### P1 — parent", "",
    "- parent item",
    "",
    "#### Sub-group", "",
    "- child item",
  ].join("\n");
  const { items } = parseStateLiveSections(md, "/tmp/STATE.md");
  assert.deepEqual(items.map((i) => [i.group, i.text]), [
    ["P1 — parent", "parent item"],
    ["Sub-group", "child item"],
  ]);
  assert.equal(items.length, 2, "no bullet may be counted twice");
});

test("dedupe keys on id when present — rewording an entry does not mint a new item", () => {
  // Identity must survive an edit, or nothing can be tracked over time. Until
  // 2026-08-26 dedupe keyed on normalized TEXT for every format, so the `id` the
  // parser had just extracted was thrown away.
  const a = { file: "/x/TODOS.md", line: 3, id: "TM-010", text: "Public read-only API" };
  const b = { file: "/x/TODOS.md", line: 3, id: "TM-010", text: "Public read-only API at api.astroclarity.org" };
  const { items, mergedCount } = dedupeItems([a, b]);
  assert.equal(items.length, 1, "same id, reworded text, is ONE item");
  assert.equal(mergedCount, 1);
});

test("dedupe does NOT collide different ids that share prose", () => {
  // The opposite error from the same line: five unrelated files each carrying a
  // bare `P2` line merged into a single "item" before this fix.
  const a = { file: "/x/TODOS.md", line: 3, id: "TM-010", text: "P2" };
  const b = { file: "/y/TODOS.md", line: 9, id: "YV-004", text: "P2" };
  const { items } = dedupeItems([a, b]);
  assert.equal(items.length, 2, "different ids are different work, whatever the prose says");
});

test("the same id in two DIFFERENT files stays two items — registers number independently", () => {
  const a = { file: "/x/TODOS.md", line: 3, id: "N1", text: "one thing" };
  const b = { file: "/y/TODOS.md", line: 4, id: "N1", text: "a different thing" };
  assert.equal(dedupeItems([a, b]).items.length, 2);
});

test("id-less items still dedupe on prose — the fallback is unchanged", () => {
  const a = { file: "/x/STATE.md", line: 3, text: "Ship the login page" };
  const b = { file: "/y/TODOS.md", line: 8, text: "ship the  login page" };
  const { items, mergedCount } = dedupeItems([a, b]);
  assert.equal(items.length, 1, "normalisation still merges byte-equivalent prose");
  assert.equal(mergedCount, 1);
  assert.equal(items[0].sources.length, 2, "and both origins are kept");
});
