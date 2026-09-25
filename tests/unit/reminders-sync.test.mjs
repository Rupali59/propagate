/**
 * Tests for lib/reminders/sync.mjs — the orchestrator that decides which
 * `new` routed reminders become planned inserts into a project's register,
 * and performs them. `docs/plans/2026-09-23-reminders-todo-bridge.md`
 * "Part 1 — the inserter"; PR-021's DECISIONS.md entry (2026-09-25).
 *
 * Fully hermetic: `resolveTagFn`, `githubRoot`, `saveIdentityMapFn` and
 * `insertDeps` are all injected, so nothing here ever reads or writes the
 * real `~/Documents/GitHub` tree. `reconcile.mjs` is exercised through its
 * real, unmodified `apply: false` path (never `apply: true` — this module
 * never calls it that way).
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test
 * tests/unit/reminders-sync.test.mjs` (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  syncReminders,
  resolveRegisterCandidates,
  resolveRegisterTarget,
  chooseRegisterFileName,
  findStagingAnchor,
  codeToDisposition,
  STAGING_HEADING,
} from "../../lib/reminders/sync.mjs";
import { normalizeRecord } from "../../lib/reminders/normalize.mjs";
import { saveIdentityMap, loadIdentityMap, identityMapPath } from "../../lib/reminders/identity-map.mjs";
import { insertLogPath, readInsertLog } from "../../lib/reminders/insert-log.mjs";
import { fullStateSnapshot } from "../helpers/full-state-snapshot.mjs";

async function freshDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}
const cleanup = (...dirs) => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));

/** Raw JXA-shaped record -> normalizeRecord, so `.route` is computed by the
 *  REAL routing logic (real tags.mjs) exactly as a live read would produce. */
function readRemindersFnFor(rawRecords) {
  return async () => {
    const items = rawRecords.map(normalizeRecord);
    const summary = {
      total: items.length,
      routed: items.filter((i) => i.route.kind === "routed").length,
      heldUntagged: items.filter((i) => i.route.kind === "held-untagged").length,
      heldUnknownTag: items.filter((i) => i.route.kind === "held-unknown-tag").length,
    };
    return { ok: true, list: "Claude TODO", items, summary };
  };
}

const NOW = () => "2026-09-25T12:00:00.000Z";

const REGISTER_BASIC = ["## Open", "", `${STAGING_HEADING}`, "", "## Finished", "", "### PR-000 · closed already", "done 2026-01-01", ""].join("\n");

/** A fake resolveTag routing "#ccusage" at a FAKE path under `githubRoot` --
 *  never the real tree. `path.join(githubRoot, "TestProject")` is a direct
 *  child of `githubRoot`, so resolveRegisterCandidates treats it as a
 *  workspace root and the canonical register lives at
 *  `.../TestProject/propagation/state/workspace/TODOS.md`. */
function fakeResolveTagFn(githubRoot) {
  return (tag) => (tag === "ccusage" ? { project: "Test Project", path: path.join(githubRoot, "TestProject") } : null);
}

// ---------------------------------------------------------------------------
// resolveRegisterCandidates / resolveRegisterTarget -- reproduces the two
// REAL measured outcomes on the live tree (ccusage -> held-no-register,
// vipinkaushik -> held-ambiguous-register), against injected `exists`.
// ---------------------------------------------------------------------------

test("resolveRegisterTarget: workspace root with neither canonical nor legacy register -> held-no-register (the real #ccusage shape)", () => {
  const routePath = "/gh/Rupali/claude-usage-widget";
  const r = resolveRegisterTarget({ routePath }, { githubRoot: "/gh", exists: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.code, "held-no-register");
});

test("resolveRegisterTarget: no canonical, a differently-shaped legacy register exists -> held-ambiguous-register (the real #vipinkaushik shape)", () => {
  const routePath = "/gh/Vipin Kaushik";
  const canonical = "/gh/Vipin Kaushik/propagation/state/workspace/TODOS.md";
  const legacy = "/gh/Vipin Kaushik/TODOS.md";
  const r = resolveRegisterTarget({ routePath }, { githubRoot: "/gh", exists: (p) => p === legacy && p !== canonical });
  assert.equal(r.ok, false);
  assert.equal(r.code, "held-ambiguous-register");
  assert.match(r.reason, /decision about the tree, not a coding call/);
});

test("resolveRegisterTarget: canonical exists alone -> resolved", () => {
  const routePath = "/gh/SomeWorkspace";
  const canonical = "/gh/SomeWorkspace/propagation/state/workspace/TODOS.md";
  const r = resolveRegisterTarget({ routePath }, { githubRoot: "/gh", exists: (p) => p === canonical });
  assert.equal(r.ok, true);
  assert.equal(r.registerPath, canonical);
});

test("resolveRegisterCandidates: a nested project path resolves to the project-scoped state dir, not the workspace one", () => {
  const { canonical } = resolveRegisterCandidates({ routePath: "/gh/Rupali/claude-usage-widget" }, { githubRoot: "/gh" });
  assert.equal(canonical, path.join("/gh", "Rupali", "propagation", "state", "claude-usage-widget", "TODOS.md"));
});

// ---------------------------------------------------------------------------
// chooseRegisterFileName -- conservative, TODOS.md default
// ---------------------------------------------------------------------------

test("chooseRegisterFileName defaults to TODOS.md with no second tag", () => {
  assert.equal(chooseRegisterFileName({ tags: ["ccusage"] }), "TODOS.md");
});

test("chooseRegisterFileName switches to ISSUES.md only on an explicit bug/issue signal", () => {
  assert.equal(chooseRegisterFileName({ tags: ["ccusage", "bug"] }), "ISSUES.md");
  assert.equal(chooseRegisterFileName({ tags: ["ccusage", "issue"] }), "ISSUES.md");
  assert.equal(chooseRegisterFileName({ tags: ["ccusage", "urgent"] }), "TODOS.md");
});

// ---------------------------------------------------------------------------
// findStagingAnchor
// ---------------------------------------------------------------------------

test("findStagingAnchor: no staging heading at all -> refused with a clear reason", () => {
  const r = findStagingAnchor(["## Open", "", "### PR-001 · x", ""]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no staging heading/);
});

test("findStagingAnchor: anchors on the last blank line in the section", () => {
  const lines = REGISTER_BASIC.split("\n");
  const r = findStagingAnchor(lines);
  assert.equal(r.ok, true);
  assert.equal(lines[r.anchorLine - 1], "");
});

test("findStagingAnchor: an empty section with no blank line under the heading is refused", () => {
  const r = findStagingAnchor([STAGING_HEADING, "## Open", ""]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty/);
});

// ---------------------------------------------------------------------------
// codeToDisposition -- the mapping table
// ---------------------------------------------------------------------------

test("codeToDisposition maps every insert.mjs refusal code onto the lane's vocabulary", () => {
  assert.equal(codeToDisposition("illegal-boundary"), "held-illegal-boundary");
  assert.equal(codeToDisposition("anchor-moved"), "held-illegal-boundary");
  assert.equal(codeToDisposition("would-change-classification"), "held-would-change-classification");
  assert.equal(codeToDisposition("bad-content"), "held-unrecognized-shape");
  assert.equal(codeToDisposition("read-failed"), "held-unrecognized-shape");
});

// ---------------------------------------------------------------------------
// Full-flow: dry run writes NOTHING, across a mix of dispositions.
// ---------------------------------------------------------------------------

test("dry run: writes nothing -- register, identity map and insert log are all byte-identical before/after, across new + both real refusal shapes", async (t) => {
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-");
  t.after(() => cleanup(stateDir, githubRoot));

  const registerDir = path.join(githubRoot, "TestProject", "propagation", "state", "workspace");
  await mkdir(registerDir, { recursive: true });
  const registerPath = path.join(registerDir, "TODOS.md");
  await writeFile(registerPath, REGISTER_BASIC);

  const rawRecords = [
    { id: "id-1", name: "a new ccusage item", body: "#ccusage", completed: false, completionDate: null, modificationDate: null },
    { id: "id-2", name: "no tag at all", body: "", completed: false, completionDate: null, modificationDate: null },
    { id: "id-3", name: "unrecognised tag", body: "#nosuchtag", completed: false, completionDate: null, modificationDate: null },
  ];

  const beforeRegister = await readFile(registerPath, "utf8");
  const beforeState = fullStateSnapshot(stateDir);

  const result = await syncReminders({
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: false,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.applied, false);
  const ccusageRow = result.rows.find((r) => r.reminderId === "id-1");
  assert.equal(ccusageRow.disposition, "new", "a fully legal, resolvable target reports 'new' (would-insert) in dry-run");

  assert.equal(await readFile(registerPath, "utf8"), beforeRegister, "dry run must not touch the register");
  assert.equal(fullStateSnapshot(stateDir), beforeState, "dry run must not touch the state directory (identity map, insert log)");
  assert.equal(existsSync(identityMapPath(stateDir)), false, "dry run must not even CREATE the identity map file");
});

// ---------------------------------------------------------------------------
// Full-flow: --apply performs the real insert, in order.
// ---------------------------------------------------------------------------

test("apply: inserts the new entry into the register, records insertedAt/insertedInto, and appends one insert-log row", async (t) => {
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-");
  t.after(() => cleanup(stateDir, githubRoot));

  const registerDir = path.join(githubRoot, "TestProject", "propagation", "state", "workspace");
  await mkdir(registerDir, { recursive: true });
  const registerPath = path.join(registerDir, "TODOS.md");
  await writeFile(registerPath, REGISTER_BASIC);

  const rawRecords = [{ id: "id-1", name: "a new ccusage item", body: "#ccusage", completed: false, completionDate: null, modificationDate: null }];

  const result = await syncReminders({
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: true,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.applied, true);
  assert.equal(result.rows[0].disposition, "new");

  const afterRegister = await readFile(registerPath, "utf8");
  assert.match(afterRegister, /### PR-001 · a new ccusage item/);

  const map = await loadIdentityMap(stateDir);
  const entry = map.entries["id-1"];
  assert.equal(entry.id, "PR-001");
  assert.equal(entry.insertedAt, NOW());
  assert.equal(entry.insertedInto, registerPath);

  const log = await readInsertLog(stateDir);
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].reminderId, "id-1");
  assert.equal(log.rows[0].prId, "PR-001");
  assert.equal(log.rows[0].registerFile, registerPath);
  assert.match(log.rows[0].insertedText, /a new ccusage item/);
  // Anchor reversal by CONTENT, never by line number.
  assert.equal(typeof log.rows[0].anchorText, "string");
});

// ---------------------------------------------------------------------------
// Idempotency -- the load-bearing guarantee.
// ---------------------------------------------------------------------------

test("idempotency: a second apply run against the same reminder reports already-inserted and never inserts twice", async (t) => {
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-");
  t.after(() => cleanup(stateDir, githubRoot));

  const registerDir = path.join(githubRoot, "TestProject", "propagation", "state", "workspace");
  await mkdir(registerDir, { recursive: true });
  const registerPath = path.join(registerDir, "TODOS.md");
  await writeFile(registerPath, REGISTER_BASIC);

  const rawRecords = [{ id: "id-1", name: "a new ccusage item", body: "#ccusage", completed: false, completionDate: null, modificationDate: null }];
  const opts = {
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: true,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
  };

  const first = await syncReminders(opts);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.rows[0].disposition, "new");
  const afterFirst = await readFile(registerPath, "utf8");

  const second = await syncReminders(opts);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.rows[0].disposition, "already-inserted");
  assert.equal(second.rows[0].insertedInto, registerPath);

  const afterSecond = await readFile(registerPath, "utf8");
  assert.equal(afterSecond, afterFirst, "the register must be byte-identical after run two -- no duplicate insertion");

  const log = await readInsertLog(stateDir);
  assert.equal(log.rows.length, 1, "the insert log must still carry exactly one row");
});

// ---------------------------------------------------------------------------
// R3/D4 -- write order: register FIRST, then the identity map. A failed map
// save must never leave the register line silently un-recorded, and the
// silent-LOSS path (map says inserted, register does not have the line)
// must be unreachable by construction.
// ---------------------------------------------------------------------------

test("R3: if the identity-map save fails, the register line is present and insertedAt is absent -- never the reverse", async (t) => {
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-");
  t.after(() => cleanup(stateDir, githubRoot));

  const registerDir = path.join(githubRoot, "TestProject", "propagation", "state", "workspace");
  await mkdir(registerDir, { recursive: true });
  const registerPath = path.join(registerDir, "TODOS.md");
  await writeFile(registerPath, REGISTER_BASIC);

  const rawRecords = [{ id: "id-1", name: "a new ccusage item", body: "#ccusage", completed: false, completionDate: null, modificationDate: null }];

  const result = await syncReminders({
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: true,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
    // THE MUTATION: the map write fails, every time.
    saveIdentityMapFn: async () => {
      throw new Error("simulated disk failure");
    },
  });

  assert.equal(result.ok, false, "syncReminders must report the failure rather than pretending success");
  assert.equal(result.reason, "identity-map-save-failed");

  // THE ASSERTION THAT MATTERS: the register write already landed --
  const afterRegister = await readFile(registerPath, "utf8");
  assert.match(afterRegister, /### PR-001 · a new ccusage item/, "the register line must be present -- it was written BEFORE the map save was attempted");

  // -- and the identity map must NOT show it as inserted (in fact, must not
  // exist at all: nothing ever reached saveIdentityMap successfully).
  assert.equal(existsSync(identityMapPath(stateDir)), false, "the identity map must not exist -- the mocked save never completed");

  // -- and no insert-log row for it either: R3's order is register -> map ->
  // log, so a map-save failure must mean the log append never ran.
  assert.equal(existsSync(insertLogPath(stateDir)), false, "no insert-log row may exist for an insertion the map does not know happened");
});

test("R3 confirmed the RIGHT way round: a healthy save leaves the map AND the log consistent with the register", async (t) => {
  // The mutation's mirror: undo the failure and confirm the guard goes
  // green again for the stated reason, not for an unrelated one.
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-");
  t.after(() => cleanup(stateDir, githubRoot));

  const registerDir = path.join(githubRoot, "TestProject", "propagation", "state", "workspace");
  await mkdir(registerDir, { recursive: true });
  const registerPath = path.join(registerDir, "TODOS.md");
  await writeFile(registerPath, REGISTER_BASIC);

  const rawRecords = [{ id: "id-1", name: "a new ccusage item", body: "#ccusage", completed: false, completionDate: null, modificationDate: null }];

  const result = await syncReminders({
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: true,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
    saveIdentityMapFn: saveIdentityMap, // the REAL one
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(existsSync(identityMapPath(stateDir)), true);
  assert.equal(existsSync(insertLogPath(stateDir)), true);
});

// ---------------------------------------------------------------------------
// Refusal dispositions -- each triggered by a fixture that produces exactly
// it, asserting the reason string, never a bare zero.
// ---------------------------------------------------------------------------

test("held-no-register: a resolvable tag with no TODOS.md anywhere reachable", async (t) => {
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-"); // deliberately empty -- no register anywhere
  t.after(() => cleanup(stateDir, githubRoot));
  await mkdir(path.join(githubRoot, "TestProject"), { recursive: true });

  const rawRecords = [{ id: "id-1", name: "orphaned", body: "#ccusage", completed: false, completionDate: null, modificationDate: null }];
  const result = await syncReminders({
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: false,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
  });

  assert.equal(result.ok, true);
  assert.equal(result.rows[0].disposition, "held-no-register");
  assert.match(result.rows[0].reason, /no TODOS.md found/);
});

test("held-ambiguous-register: canonical location empty, a differently-shaped legacy register exists", async (t) => {
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-");
  t.after(() => cleanup(stateDir, githubRoot));
  await mkdir(path.join(githubRoot, "TestProject"), { recursive: true });
  // A legacy repo-root TODOS.md, NOT at the canonical propagation/state path.
  await writeFile(path.join(githubRoot, "TestProject", "TODOS.md"), "# Legacy shape\n- [ ] something\n");

  const rawRecords = [{ id: "id-1", name: "ambiguous", body: "#ccusage", completed: false, completionDate: null, modificationDate: null }];
  const result = await syncReminders({
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: false,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
  });

  assert.equal(result.ok, true);
  assert.equal(result.rows[0].disposition, "held-ambiguous-register");
  assert.match(result.rows[0].reason, /decision about the tree/);
});

test("held-unrecognized-shape: the canonical register exists but has no staging heading", async (t) => {
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-");
  t.after(() => cleanup(stateDir, githubRoot));

  const registerDir = path.join(githubRoot, "TestProject", "propagation", "state", "workspace");
  await mkdir(registerDir, { recursive: true });
  await writeFile(path.join(registerDir, "TODOS.md"), "## Open\n\n### PR-002 · an item\n");

  const rawRecords = [{ id: "id-1", name: "no staging section", body: "#ccusage", completed: false, completionDate: null, modificationDate: null }];
  const result = await syncReminders({
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: false,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
  });

  assert.equal(result.ok, true);
  assert.equal(result.rows[0].disposition, "held-unrecognized-shape");
  assert.match(result.rows[0].reason, /no staging heading/);
});

test("held-illegal-boundary: a race between resolving the anchor and writing it (simulated) refuses rather than guessing", async (t) => {
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-");
  t.after(() => cleanup(stateDir, githubRoot));

  const registerDir = path.join(githubRoot, "TestProject", "propagation", "state", "workspace");
  await mkdir(registerDir, { recursive: true });
  const registerPath = path.join(registerDir, "TODOS.md");
  await writeFile(registerPath, REGISTER_BASIC);

  const rawRecords = [{ id: "id-1", name: "raced", body: "#ccusage", completed: false, completionDate: null, modificationDate: null }];

  // Simulate the register changing underneath us BETWEEN sync.mjs's own read
  // (which computed the anchor at line 4, the blank line under the staging
  // heading) and applyInsert's internal re-read -- same line count, so the
  // race check fires "not what was previewed" rather than "past the end".
  const racedLines = REGISTER_BASIC.split("\n");
  racedLines[3] = "SOMETHING ELSE LANDED HERE CONCURRENTLY";
  const racedContent = racedLines.join("\n");

  const result = await syncReminders({
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: true,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
    insertDeps: {
      readFile: async () => racedContent,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.rows[0].disposition, "held-illegal-boundary");
  assert.match(result.rows[0].reason, /not what was previewed/);

  // Refused, so the register must be untouched.
  assert.equal(await readFile(registerPath, "utf8"), REGISTER_BASIC);
});

// held-would-change-classification (A3 as a refusal) is thoroughly covered
// with negative controls at the insert.mjs unit level
// (tests/unit/registers-insert.test.mjs) -- both the format-election flip
// and the CLOSED_MARKERS_RE lookahead bleed. Through THIS module's own
// pipeline it is structurally near-unreachable BY DESIGN: `sync.mjs` only
// ever inserts a well-formed `### <prId> · <title>` heading, and
// `backlog.mjs`'s lookahead scan explicitly filters heading lines out of
// its 3-line window -- so a real reminder title containing a closed-marker
// word (e.g. "done") cannot bleed into a preceding entry the way a raw
// prose insert could. That is a property of sync.mjs's own output shape,
// not a gap in insert.mjs's guard, which stays generic for any future
// caller that inserts non-heading text.
//
// What IS worth proving here is the cross-lane coupling with R1's `proposed`
// state (`lib/report/backlog.mjs`, landed independently by Lane 2 while this
// lane was in flight): a legal insert under `STAGING_HEADING` must be read
// back as `proposed`, not silently miscounted as `open` -- since `sync.mjs`
// generates its insert text and picks its anchor with no knowledge of that
// field, this is exactly the kind of promise-in-one-file-the-other-cannot-
// keep coupling `rule:adversarial-review-reads-the-ledger` warns about.
test("integration with R1's proposed state: a legal insert under the staging heading is read back as proposed, not open", async (t) => {
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-");
  t.after(() => cleanup(stateDir, githubRoot));

  const registerDir = path.join(githubRoot, "TestProject", "propagation", "state", "workspace");
  await mkdir(registerDir, { recursive: true });
  const registerPath = path.join(registerDir, "TODOS.md");
  const register = ["## Open", "", "### PR-900 · a pre-existing open item", "", STAGING_HEADING, "", ""].join("\n");
  await writeFile(registerPath, register);

  const rawRecords = [{ id: "id-1", name: "a freshly imported reminder", body: "#ccusage", completed: false, completionDate: null, modificationDate: null }];
  const result = await syncReminders({
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: true,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.rows[0].disposition, "new");

  const after = await readFile(registerPath, "utf8");
  const { parseTodoLikeFile } = await import("../../lib/report/backlog.mjs");
  const parsed = parseTodoLikeFile(after, registerPath);
  assert.equal(parsed.proposed, 1, "the freshly inserted entry must be counted as proposed");
  assert.ok(!parsed.items.some((i) => i.id === "PR-001"), "a proposed entry must NOT appear in open items");
  assert.ok(parsed.items.some((i) => i.id === "PR-900"), "the pre-existing open item must be untouched");
  assert.equal(parsed.open, 1, "open count must be unchanged by a staged insert");
});

// ---------------------------------------------------------------------------
// Held-untagged / held-unknown-tag pass through unaffected.
// ---------------------------------------------------------------------------

test("held-untagged and held-unknown-tag rows pass through unaffected -- never treated as insert candidates", async (t) => {
  const stateDir = await freshDir("sync-state-");
  const githubRoot = await freshDir("sync-gh-");
  t.after(() => cleanup(stateDir, githubRoot));

  const rawRecords = [
    { id: "id-1", name: "no tag", body: "", completed: false, completionDate: null, modificationDate: null },
    { id: "id-2", name: "bad tag", body: "#nosuchtag", completed: false, completionDate: null, modificationDate: null },
  ];
  const result = await syncReminders({
    readRemindersFn: readRemindersFnFor(rawRecords),
    stateDir,
    apply: false,
    now: NOW,
    githubRoot,
    resolveTagFn: fakeResolveTagFn(githubRoot),
  });

  assert.equal(result.ok, true);
  assert.equal(result.rows.find((r) => r.reminderId === "id-1").disposition, "held-untagged");
  assert.equal(result.rows.find((r) => r.reminderId === "id-2").disposition, "held-unknown-tag");
});

// ---------------------------------------------------------------------------
// An inconclusive read never reaches any of the above -- passed straight
// through, per reconcile.mjs's own F2 discipline.
// ---------------------------------------------------------------------------

test("an inconclusive read is passed straight through -- never treated as zero reminders / nothing to sync", async (t) => {
  const stateDir = await freshDir("sync-state-");
  t.after(() => cleanup(stateDir));

  const result = await syncReminders({
    readRemindersFn: async () => ({ ok: false, list: "Claude TODO", reason: "tcc-denied", reasonDetail: "x", code: "tcc-denied" }),
    stateDir,
    apply: true, // even with --apply, an inconclusive read must write nothing
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "tcc-denied");
  assert.equal(existsSync(identityMapPath(stateDir)), false);
});
