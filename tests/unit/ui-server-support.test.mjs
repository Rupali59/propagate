/**
 * The pieces behind the redesigned UI's server (lane A), each tested without a
 * socket: the build id (F5), the seen-set (D12), the worklist count with
 * unplaced edges (D10), current-content evidence (D11) and the doctor `action`
 * field (E5). The route-level behaviour is tests/cli/ui-server.test.mjs.
 *
 * The seen-set tests pass an explicit file path, so none of them touches the
 * real state directory or the cursor (rule:safety-flag-needs-a-test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildId, buildFiles } from "../../lib/report/ui-build.mjs";
import { validateTriples, readSeen, addSeen, MAX_TRIPLES } from "../../lib/report/seen-edges.mjs";
import { worklistWithUnplaced } from "../../lib/report/inbox.mjs";
import { edgeDiff } from "../../lib/report/evidence.mjs";
import { Reporter, ACTION_KINDS } from "../../lib/report/doctor/reporter.mjs";
import { createExceptionGate } from "../../lib/report/doctor/health-exceptions.mjs";

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

// ── F5: the build id ────────────────────────────────────────────────────────

function fakeCommands() {
  const d = tmp("ui-build-");
  mkdirSync(path.join(d, "ui", "css"), { recursive: true });
  writeFileSync(path.join(d, "ui.mjs"), "server v1");
  writeFileSync(path.join(d, "ui.client.js"), "client v1");
  writeFileSync(path.join(d, "ui", "css", "10-a.css"), "a{}");
  writeFileSync(path.join(d, "ui", "css", "90-z.css"), "z{}");
  return d;
}

test("F5: the build id changes when ui.mjs, the client, or any css fragment changes -- and only then", () => {
  const d = fakeCommands();
  try {
    const base = buildId(d);
    assert.match(base, /^[0-9a-f]{16}$/);
    assert.equal(buildId(d), base, "stable across calls");
    for (const [rel, text] of [["ui.mjs", "server v2"], ["ui.client.js", "client v2"], ["ui/css/90-z.css", "z{color:red}"]]) {
      const orig = readFileSync(path.join(d, rel), "utf8");
      writeFileSync(path.join(d, rel), text);
      assert.notEqual(buildId(d), base, `${rel} must be part of the id`);
      writeFileSync(path.join(d, rel), orig);
    }
    // A new css fragment is picked up by being in the folder (rule:derive-dont-curate).
    writeFileSync(path.join(d, "ui", "css", "50-new.css"), "n{}");
    assert.notEqual(buildId(d), base, "a new fragment must change the id");
    assert.equal(buildFiles(d).length, 5);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("F5: the build id of this checkout equals what open-ui.sh computes with no node", () => {
  // The two must agree or every click replaces a healthy server. The shell form is the one
  // widget/open-ui.sh runs; LC_ALL=C is what makes its glob sort match a JS code-unit sort.
  const root = path.resolve(import.meta.dirname, "..", "..");
  const r = spawnSync("/bin/bash", ["-c",
    `cd "${root}" && cat commands/ui.mjs commands/ui.client.js commands/ui/css/*.css | shasum -a 256 | cut -c1-16`],
  { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  assert.equal(r.stdout.trim(), buildId());
});

test("F5: a commands folder that reads as empty is a blind scan, not a build id", () => {
  const d = tmp("ui-build-empty-");
  try {
    mkdirSync(path.join(d, "ui", "css"), { recursive: true });
    assert.throws(() => buildId(d));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── D12: the seen-set ───────────────────────────────────────────────────────

test("D12: validateTriples accepts edge|source|downstream and refuses everything else", () => {
  assert.deepEqual(validateTriples(["a|b|c", "a|b|c", "x|null|null"]), { ok: true, triples: ["a|b|c", "x|null|null"] });
  for (const bad of [undefined, [], "a|b|c", [3], ["a|b"], ["a|b|c|d"], ["|b|c"], ["a|" + "x".repeat(601) + "|c"]]) {
    assert.equal(validateTriples(bad).ok, false, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("D12: round trip, merge without duplicates, and a corrupt file is reported then recovered", async () => {
  const d = tmp("seen-");
  const file = path.join(d, "seen-edges.json");
  try {
    assert.deepEqual(await readSeen(file), { status: "missing", triples: [] });
    assert.equal((await addSeen(["a|1|1", "b|2|2"], file)).added, 2);
    assert.equal((await addSeen(["b|2|2", "c|3|3"], file)).added, 1);
    assert.deepEqual((await readSeen(file)).triples.sort(), ["a|1|1", "b|2|2", "c|3|3"]);

    writeFileSync(file, "{not json");
    const corrupt = await readSeen(file);
    assert.equal(corrupt.status, "corrupt");
    assert.match(corrupt.error, /not valid JSON/);
    const rec = await addSeen(["d|4|4"], file);
    assert.match(rec.recovered, /not valid JSON/, "overwriting damage must be said, not silent");
    assert.equal((await readSeen(file)).status, "ok");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("D12: concurrent adds do not lose each other's triples", async () => {
  const d = tmp("seen-race-");
  const file = path.join(d, "seen-edges.json");
  try {
    await Promise.all(Array.from({ length: 25 }, (_, i) => addSeen([`e${i}|s|d`], file)));
    assert.equal((await readSeen(file)).triples.length, 25);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("D12: the set is bounded -- past MAX_TRIPLES the OLDEST are dropped", async () => {
  const d = tmp("seen-cap-");
  const file = path.join(d, "seen-edges.json");
  try {
    writeFileSync(file, JSON.stringify({ triples: Array.from({ length: MAX_TRIPLES }, (_, i) => `old${i}|s|d`) }));
    await addSeen(["new|s|d"], file);
    const t = (await readSeen(file)).triples;
    assert.equal(t.length, MAX_TRIPLES);
    assert.ok(t.includes("new|s|d"));
    assert.ok(!t.includes("old0|s|d"), "the oldest goes first");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── D10: unplaced edges are counted and flagged, never null ────────────────

test("D10: an unplaced edge does not turn toJudge null; it is counted and flagged", () => {
  const placed = (id, extra = {}) => ({ edge_id: id, state: "DRIFTED", blocked: false, orderMissing: null, last: null, ...extra });
  const items = [placed("a"), placed("b", { blocked: true }), placed("c", { state: "DIVERGED" }),
    placed("u", { blocked: null, orderMissing: "actionable but absent from the fix-order worklist" })];
  const w = worklistWithUnplaced(items);
  assert.equal(w.toJudge, 2, "a (placed, free) + u (unplaced, counted); b is blocked and c is DIVERGED");
  assert.equal(w.toJudgeIncludesUnplaced, 1);
  assert.equal(w.toJudgeReason, null);
  const clean = worklistWithUnplaced([placed("a"), placed("b", { blocked: true })]);
  assert.equal(clean.toJudge, 1);
  assert.equal(clean.toJudgeIncludesUnplaced, 0);
});

// ── D11: evidence for an edge with no earlier verdict ──────────────────────

test("D11: with no earlier verdict, evidence is the current content, labelled; without the flag it stays a named failure", async () => {
  const readFile = async (f) => `content of ${path.basename(f)}\n`;
  const shown = await edgeDiff({ file: "/x/src.md", sinceCommit: null, downstreamFile: "/x/dst.md", showCurrentWhenNoVerdict: true, deps: { readFile } });
  assert.equal(shown.ok, true);
  assert.equal(shown.noPriorVerdict, true);
  assert.match(shown.reason, /no earlier verdict to diff against/);
  assert.equal(shown.text, "content of src.md\n");
  assert.equal(shown.downstream.text, "content of dst.md\n");

  const plain = await edgeDiff({ file: "/x/src.md", sinceCommit: null, downstreamFile: "/x/dst.md", deps: { readFile } });
  assert.equal(plain.ok, false, "a never-judged QUEUE edge keeps its failure message");
  assert.match(plain.reason, /never judged/);

  const unreadable = await edgeDiff({ file: "/x/src.md", sinceCommit: null, showCurrentWhenNoVerdict: true, deps: { readFile: async () => { throw new Error("EACCES"); } } });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.reason, /EACCES/);
});

// ── E5: the doctor action field ────────────────────────────────────────────

test("E5: check / inconclusive / accepted carry an optional action; entries without one have no `action` key", () => {
  const r = new Reporter();
  r.check("a", false, "d", { kind: "open", target: "/f.md" });
  r.check("b", true);
  r.inconclusive("c", "why", { kind: "command", target: "propagate x" });
  r.accepted("d", "why", { kind: "link", target: "docs/REFERENCE.md#propagation-layout" });
  assert.deepEqual(r.entries[0].action, { kind: "open", target: "/f.md" });
  assert.equal("action" in r.entries[1], false, "the key is omitted, not null");
  assert.equal(r.entries[2].action.kind, "command");
  assert.equal(r.entries[3].action.kind, "link");
  assert.deepEqual(ACTION_KINDS, ["open", "link", "command"]);
});

test("E5: a malformed action is refused loudly, not stored", () => {
  const r = new Reporter();
  for (const bad of [{ kind: "run", target: "x" }, { kind: "open" }, { kind: "open", target: "" }, "open", {}]) {
    assert.throws(() => r.check("x", false, "", bad), /action must be/, JSON.stringify(bad));
  }
  assert.equal(r.entries.length, 0);
});

test("E5: the exception gate passes a finding's action through to its accepted entry", () => {
  const d = tmp("gate-");
  const reg = path.join(d, "health-exceptions.yml");
  writeFileSync(reg, [
    "exceptions:",
    '  "rules-restated:skill-routing@x/CLAUDE.md":',
    '    reason: "permanent"',
    "    since: 2026-10-01",
    "",
  ].join("\n"));
  try {
    const r = new Reporter();
    const gate = createExceptionGate({ reporter: r, registryFile: reg });
    const failing = gate.apply("rules-restated", [
      { subject: "skill-routing@x/CLAUDE.md", label: "x/CLAUDE.md restates rule:skill-routing", action: { kind: "open", target: "/abs/x/CLAUDE.md" } },
      { subject: "other@y/CLAUDE.md", label: "y/CLAUDE.md restates rule:other", action: { kind: "open", target: "/abs/y/CLAUDE.md" } },
    ]);
    assert.equal(failing.length, 1);
    const acc = r.entries.find((e) => e.label.startsWith("accepted: "));
    assert.ok(acc, "the excepted finding is reported as accepted");
    assert.deepEqual(acc.action, { kind: "open", target: "/abs/x/CLAUDE.md" });
  } finally { rmSync(d, { recursive: true, force: true }); }
});
