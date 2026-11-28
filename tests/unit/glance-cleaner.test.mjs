/**
 * glance-cleaner.test.mjs — propagate#446: the glance's cleaner row (contract C3), from a LITERAL last-audit.json.
 * Each absence has its own text and none reads 0 (rule:discernment-checks §2). Names are synthetic (public repo).
 *
 * Run: PROPAGATE_STATE_DIR="$(mktemp -d)" node --test tests/unit/glance-cleaner.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { glanceCmd } from "../../cli/glance.mjs";
import { computeGlance } from "../../lib/glance/compute.mjs";
import { cleanerRow, countText } from "../../lib/glance/cleaner.mjs";

const NOW = Date.parse("2026-11-28T06:30:00Z");
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const tmp = () => mkdtempSync(path.join(tmpdir(), "gc-"));

/** A cleaner dir holding the C3 sample, `worktrees` dated `at`. */
function cleanerWith(audit) {
  const dir = tmp();
  if (audit !== undefined) {
    mkdirSync(path.join(dir, "logs"), { recursive: true });
    writeFileSync(path.join(dir, "logs", "last-audit.json"), typeof audit === "string" ? audit : JSON.stringify(audit));
  }
  return dir;
}
const sample = (over = {}, at = iso(NOW - 3 * 60000)) => ({
  domains: { worktrees: { at, awaiting_merge: null, hold: 42, kept_by_decision: null, stale_lock: 54, tier_a: 2, tier_b: 71, unknown: 42, ...over } },
  free_kb: 38743052, now: iso(NOW), schema_version: 1,
});
const row = (cleanerDir) => {
  const { glance } = computeGlance({ dir: tmp(), now: NOW, paths: { cleanerDir } });
  return { glance, items: glance.items.filter((i) => i.signal === "cleaner"), skipped: glance.skipped.filter((s) => s.signal === "cleaner") };
};

test("a fresh audit reads the stated row, awaiting-merge 'not built' and never 0", () => {
  const { items } = row(cleanerWith(sample()));
  assert.equal(items.length, 1);
  assert.equal(items[0].verdict, "working");
  assert.equal(items[0].what, "disk 36.9G free · worktrees: awaiting-merge not built · Tier B 71 · stale-lock 54 (audit 3m)");
});

test("a null Tier B and stale-lock read 'not built' too; a real 0 stays 0", () => {
  const nulls = row(cleanerWith(sample({ tier_b: null, stale_lock: null }))).items[0].what;
  assert.match(nulls, /Tier B not built · stale-lock not built/);
  const zero = row(cleanerWith(sample({ tier_b: 0 }))).items[0].what;
  assert.match(zero, /Tier B 0 ·/);
  assert.equal(countText(null), "not built");
  assert.equal(countText("7"), "invalid");
});

test("the worktrees domain is dated by its OWN at, not by the top-level now", () => {
  const a = sample({}, iso(NOW - 30 * H));
  a.now = iso(NOW); // another domain ran a moment ago and rewrote the top level
  a.domains.caches = { at: iso(NOW - 60000), tier_a: 1, tier_b: 0 };
  const { items } = row(cleanerWith(a));
  assert.equal(items[0].flag, "unknown");
  assert.match(items[0].what, /worktrees audit stale \(30h old\)/);
  assert.doesNotMatch(items[0].what, /Tier B/, "a stale audit shows no stale counts");
});

test("a missing file reads 'cleaner never run'", () => {
  const { items } = row(cleanerWith(undefined));
  assert.equal(items[0].flag, "unknown");
  assert.equal(items[0].what, "cleaner never run");
});

test("an unset cleanerDir is skipped with 'cleaner not configured', not an item and not a zero", () => {
  const { items, skipped } = row(null);
  assert.equal(items.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /^cleaner not configured/);
});

test("an unreadable audit, a wrong schema and a missing worktrees domain are each their own unknown", () => {
  assert.match(row(cleanerWith("{not json")).items[0].what, /not valid JSON/);
  assert.match(row(cleanerWith({ ...sample(), schema_version: 2 })).items[0].what, /schema 2 not understood/);
  assert.match(row(cleanerWith({ schema_version: 1, now: iso(NOW), domains: { caches: {} } })).items[0].what, /no worktrees audit/);
  assert.match(row(cleanerWith(sample({}, "yesterday"))).items[0].what, /no valid time/);
});

test("with free_kb absent the free figure falls back to statfs, and says unknown when that fails", () => {
  const dir = cleanerWith({ ...sample(), free_kb: undefined });
  const ok = cleanerRow({ cleanerDir: dir, now: NOW, statfs: () => ({ bavail: 1048576, bsize: 1024 }) });
  assert.match(ok.working.what, /^disk 1\.0G free/);
  const none = cleanerRow({ cleanerDir: dir, now: NOW, statfs: () => { throw new Error("x"); } });
  assert.match(none.working.what, /^disk unknown free/);
});

test("`propagate glance` prints the whole cleaner row on its own line, and nothing for a cleaner that is not configured", async () => {
  const lines = [];
  await glanceCmd(["--no-write", "--no-color"], { stateDirPath: tmp(), now: NOW, cleanerDir: cleanerWith(sample()), queueDir: null, color: false, out: (s) => lines.push(s) });
  assert.ok(lines.includes("cleaner: disk 36.9G free · worktrees: awaiting-merge not built · Tier B 71 · stale-lock 54 (audit 3m)"), lines.join("\n"));
  const none = [];
  await glanceCmd(["--no-write", "--no-color"], { stateDirPath: tmp(), now: NOW, queueDir: null, color: false, out: (s) => none.push(s) });
  assert.equal(none.some((l) => l.startsWith("cleaner:")), false);
});
