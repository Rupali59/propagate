/**
 * `refs record-pruned` (propagate#448): a validated record of a branch an outside tool prunes.
 *
 * The safety claim is that WITHOUT --apply nothing is written, for an accepted and a refused case;
 * it is asserted on the bytes of the refs directory, never on the command's own description of
 * itself (rule:safety-flag-needs-a-test).
 */
// @size medium — starts processes (CLI, git); run when affected

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateRefs } from "../../lib/refs/migrate-refs.mjs";
import { planRecord, applyRecord, reconcileOutsidePrunes, openPruneIncomplete, PRUNE_CODES } from "../../lib/refs/record-pruned.mjs";
import { readLifecycle } from "../../lib/refs/snapshot.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");
const EV = '{"cherry":"-"}';

function treeSnapshot(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(`${path.relative(root, abs)}::${readFileSync(abs, "utf8")}`);
    }
  };
  walk(root);
  return out.join("\n");
}

/** A workspace repo with branches `fix/9-x` and `fix/9-y`, and a v2 snapshot of it taken by migrate-refs. */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "rprune-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git("config", "user.email", "t@e.st");
  git("config", "user.name", "t");
  await writeFile(path.join(root, "f.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  git("branch", "fix/9-x");
  git("branch", "fix/9-y");
  const head = git("rev-parse", "fix/9-x");
  await migrateRefs({ workspace: root, apply: true, now: "2026-11-28T00:00:00Z" });
  return { root, git, head, refs: path.join(root, "propagation", "refs") };
}

const stateDirs = [];
function cli(args) {
  const state = mkdtemp_sync();
  return spawnSync("node", [CLI, "refs", "record-pruned", ...args], { encoding: "utf8", env: { ...process.env, PROPAGATE_STATE_DIR: state } });
}
function mkdtemp_sync() {
  const d = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  stateDirs.push(d);
  return d;
}
test.after(async () => {
  for (const d of stateDirs) await rm(d, { recursive: true, force: true });
});

const base = (f, over = {}) => ({ workspace: f.root, branch: "fix/9-x", head: f.head, evidence: EV, detectedBy: "cleaner", now: "2026-11-28T01:00:00Z", ...over });

test("--apply with a matching head appends one cleaner event, schema stamped, the snapshot untouched", async (t) => {
  const f = await fixture(t);
  const snapBefore = readFileSync(path.join(f.refs, "snapshot.json"), "utf8");
  const n = readLifecycle(f.root).total;
  const r = await applyRecord(base(f, { apply: true }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.applied, true);
  const life = readLifecycle(f.root);
  assert.equal(life.total, n + 1);
  const last = life.current.at(-1);
  assert.equal(last.schema, 2);
  assert.equal(last.type, "pruned");
  assert.equal(last.detected_by, "cleaner");
  assert.equal(last.head, f.head);
  assert.deepEqual(last.evidence, { cherry: "-" });
  assert.equal(last.recorded_before_delete, true);
  assert.equal(readFileSync(path.join(f.refs, "snapshot.json"), "utf8"), snapBefore, "a record never rewrites the snapshot");
  assert.equal(existsSync(path.join(f.refs, "lifecycle.jsonl.lock")), false, "the lock is released");
});

test("WITHOUT --apply the refs directory is byte-identical: accepted AND refused", async (t) => {
  const f = await fixture(t);
  const before = treeSnapshot(f.root);
  const ok = await applyRecord(base(f));
  assert.equal(ok.ok, true);
  assert.equal(ok.applied, false);
  assert.equal(treeSnapshot(f.root), before, "an accepted dry run wrote something");
  const bad = await applyRecord(base(f, { head: "0".repeat(40) }));
  assert.equal(bad.ok, false);
  assert.equal(treeSnapshot(f.root), before, "a refused dry run wrote something");
  // and through the CLI, the surface a caller actually uses
  const c = cli(["--workspace", f.root, "--branch", "fix/9-x", "--head", f.head, "--evidence", EV, "--detected-by", "cleaner"]);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(treeSnapshot(f.root), before, "the CLI dry run wrote something");
});

test("each refusal code fires, and --apply of a refusal writes nothing", async (t) => {
  const f = await fixture(t);
  const before = treeSnapshot(f.root);
  const cases = [
    [{ head: "1".repeat(40) }, PRUNE_CODES.HEAD_MISMATCH],
    [{ branch: "never/seen" }, PRUNE_CODES.UNKNOWN_BRANCH],
    [{ detectedBy: "snapshot-diff" }, PRUNE_CODES.DETECTED_BY],
    [{ detectedBy: undefined }, PRUNE_CODES.DETECTED_BY],
    [{ evidence: "not json" }, PRUNE_CODES.EVIDENCE],
    [{ evidence: "{}" }, PRUNE_CODES.EVIDENCE],
    [{ evidence: "" }, PRUNE_CODES.EVIDENCE],
  ];
  for (const [over, code] of cases) {
    const r = await applyRecord(base(f, { ...over, apply: true }));
    assert.equal(r.ok, false, `${JSON.stringify(over)} was accepted`);
    assert.equal(r.exit, 1);
    assert.equal(r.code, code, JSON.stringify(over));
  }
  assert.equal(treeSnapshot(f.root), before);
  assert.equal((await applyRecord(base(f, { apply: true }))).ok, true);
  const dup = await applyRecord(base(f, { apply: true }));
  assert.equal(dup.code, PRUNE_CODES.DUPLICATE);
  assert.equal(readLifecycle(f.root).current.filter((e) => e.detected_by === "cleaner").length, 1, "a duplicate was appended");
});

test("a missing snapshot, an unreadable one and an unknown shape are exit 2, never accepted", async (t) => {
  const f = await fixture(t);
  const snap = path.join(f.refs, "snapshot.json");
  const good = readFileSync(snap, "utf8");

  await writeFile(snap, JSON.stringify({ schema_version: 1, projects: { workspace: { refs: {} } } }));
  let r = await applyRecord(base(f, { apply: true }));
  assert.equal(r.exit, 2, "a v1 snapshot is an unknown shape for this reader");
  await writeFile(snap, JSON.stringify({ schema_version: 1, refs: [] }));
  r = await applyRecord(base(f, { apply: true }));
  assert.equal(r.exit, 2, "the flat shape is unknown too (G26)");
  await writeFile(snap, "{ not json");
  r = await applyRecord(base(f, { apply: true }));
  assert.equal(r.exit, 2);
  await rm(snap);
  r = await applyRecord(base(f, { apply: true }));
  assert.equal(r.exit, 2, "a missing snapshot is not an empty one");
  assert.equal(r.ok, false);

  await writeFile(snap, good);
  await rm(path.join(f.refs, "lifecycle.jsonl"));
  r = await applyRecord(base(f, { apply: true }));
  assert.equal(r.exit, 2, "no lifecycle");
  const c = cli(["--workspace", f.root, "--branch", "fix/9-x", "--head", f.head, "--evidence", EV, "--detected-by", "cleaner"]);
  assert.equal(c.status, 2, c.stderr);
});

test("CLI exit codes 0, 1 and 2, and --json", async (t) => {
  const f = await fixture(t);
  const args = (o = {}) => ["--workspace", f.root, "--branch", "fix/9-y", "--head", o.head ?? f.git("rev-parse", "fix/9-y"), "--evidence", EV, "--detected-by", o.by ?? "cleaner"];
  const ok = cli([...args(), "--apply", "--json"]);
  assert.equal(ok.status, 0, ok.stderr);
  const body = JSON.parse(ok.stdout);
  assert.equal(body.applied, true);
  assert.equal(body.event.detected_by, "cleaner");
  const refused = cli(args({ by: "snapshot-diff" }));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /REFS_PRUNE_DETECTED_BY/);
  const usage = cli(["--workspace", f.root]);
  assert.equal(usage.status, 2);
  const flag = cli([...args(), "--bogus"]);
  assert.equal(flag.status, 2, "an unknown flag is refused, not dropped");
});

// ── reconciliation, through migrate-refs ────────────────────────────────────────────────────────────

test("the delete went through: the diff's pruned is dropped, and a re-snapshot adds nothing", async (t) => {
  const f = await fixture(t);
  await applyRecord(base(f, { apply: true }));
  f.git("branch", "-D", "fix/9-x");
  const plan = await migrateRefs({ workspace: f.root, now: "2026-11-28T02:00:00Z" });
  assert.deepEqual(plan.events.filter((e) => e.type === "pruned"), [], "recorded once already");
  await migrateRefs({ workspace: f.root, apply: true, now: "2026-11-28T02:00:00Z" });
  await migrateRefs({ workspace: f.root, apply: true, now: "2026-11-28T03:00:00Z" });
  const pruned = readLifecycle(f.root).current.filter((e) => e.type === "pruned" && e.ref === "fix/9-x");
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].detected_by, "cleaner");
});

test("the delete failed: ONE prune-incomplete with the evidence, and a second run adds none", async (t) => {
  const f = await fixture(t);
  await applyRecord(base(f, { apply: true }));
  await migrateRefs({ workspace: f.root, apply: true, now: "2026-11-28T02:00:00Z" });
  const once = readLifecycle(f.root).current.filter((e) => e.type === "prune-incomplete");
  assert.equal(once.length, 1);
  assert.deepEqual(once[0].evidence, { cherry: "-" });
  assert.equal(once[0].head, f.head);
  await migrateRefs({ workspace: f.root, apply: true, now: "2026-11-28T03:00:00Z" });
  assert.equal(readLifecycle(f.root).current.filter((e) => e.type === "prune-incomplete").length, 1, "emitted again on a second run");
  const snap = JSON.parse(readFileSync(path.join(f.refs, "snapshot.json"), "utf8"));
  assert.equal(openPruneIncomplete(readLifecycle(f.root), snap).length, 1, "doctor sees it while the branch is still there");
  f.git("branch", "-D", "fix/9-x");
  await migrateRefs({ workspace: f.root, apply: true, now: "2026-11-28T04:00:00Z" });
  const snap2 = JSON.parse(readFileSync(path.join(f.refs, "snapshot.json"), "utf8"));
  assert.equal(openPruneIncomplete(readLifecycle(f.root), snap2).length, 0, "a delete that lands later closes it");
});

test("re-created at a different head: no prune-incomplete", () => {
  const rec = { schema: 2, type: "pruned", project: "p", ref: "b", head: "aaa", detected_by: "cleaner", evidence: { a: 1 }, at: "t" };
  const next = { captured_at: "t2", projects: { p: { refs: { b: { head: "bbb" } } } } };
  assert.deepEqual(reconcileOutsidePrunes([], { current: [rec] }, next), []);
  const same = { captured_at: "t2", projects: { p: { refs: { b: { head: "aaa" } } } } };
  assert.equal(reconcileOutsidePrunes([], { current: [rec] }, same).length, 1);
});

test("the pure planner needs no I/O and names the project", () => {
  const snapshot = { projects: { p: { refs: { b: { head: "h1" } } }, q: { refs: { b: { head: "h2" } } } } };
  const mk = (over) => planRecord({ snapshot, lifecycle: { current: [] }, branch: "b", head: "h1", evidence: EV, detectedBy: "cleaner", ...over });
  assert.equal(mk({}).event.project, "p");
  assert.equal(mk({ head: "h3" }).code, PRUNE_CODES.HEAD_MISMATCH);
  const both = { projects: { p: { refs: { b: { head: "h1" } } }, q: { refs: { b: { head: "h1" } } } } };
  assert.equal(mk({ snapshot: both }).code, PRUNE_CODES.AMBIGUOUS);
  assert.equal(mk({ snapshot: both, project: "q" }).event.project, "q");
});
