/**
 * The doctor snapshot — a cache that must never lie about its own freshness.
 *
 * WHY THE CACHE IS JUSTIFIED AT ALL. `rule:delegation-criteria` §2 kills
 * background components that could be derived on demand, and it is right to: it
 * records a 60-second watcher that ran 4,420 times and found nothing in 4,384.
 * The exemption here is measured, not asserted — `doctor` costs **36,926 ms**,
 * which genuinely breaks a glance surface, and the cache rides on the monitor's
 * EXISTING 1800 s job rather than adding a scheduled thing.
 *
 * WHAT THESE TESTS ARE ACTUALLY ABOUT: the three ways a cache can mislead.
 * A failed refresh that leaves the old file in place is the worst outcome,
 * because the reader sees plausible numbers and no reason to doubt them. Every
 * test below is a variation on "say which of the three states you are in".
 *
 * `runDoctor` is injected throughout. A test suite that paid 37 seconds per case
 * would be deleted within a month, and the failure branch could not be exercised
 * at all — an error path nobody has seen run is not covered, whatever a coverage
 * number says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeSnapshot, readSnapshot } from "../../lib/report/doctor/snapshot.mjs";

const withDir = async (fn) => {
  const d = mkdtempSync(path.join(tmpdir(), "snap-"));
  try {
    await fn(path.join(d, "doctor-snapshot.json"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

const GOOD = { sections: [{ name: "State", pass: 1, warn: 0, fail: 0, info: 0, note: 0, entries: [] }], totals: { pass: 1, warn: 0, fail: 0, info: 0, note: 0 }, problems: 0, sectionCount: 1 };

// ── the three absences, each named ─────────────────────────────────────────

test("a missing snapshot says so, and says the monitor has not run", async () => {
  await withDir(async (file) => {
    const r = await readSnapshot(file);
    assert.equal(r.ok, false);
    assert.match(r.reason, /no snapshot yet/);
    assert.match(r.reason, /monitor/, "the reason must name what would fix it");
  });
});

test("a corrupt snapshot is NOT read as 'no problems'", async () => {
  await withDir(async (file) => {
    writeFileSync(file, "{ this is not json");
    const r = await readSnapshot(file);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not valid JSON/);
  });
});

test("a snapshot whose doctor failed reports the failure, not a clean tree", async () => {
  await withDir(async (file) => {
    await writeSnapshot({ file, runDoctor: async () => { throw new Error("git exploded"); } });
    const r = await readSnapshot(file);
    assert.equal(r.ok, false);
    assert.match(r.reason, /doctor failed/);
    assert.match(r.reason, /git exploded/, "the underlying cause must survive to the reader");
  });
});

// ── the failure mode this module exists to prevent ─────────────────────────

test("a FAILED refresh carries the previous good timestamp forward", async () => {
  // The whole point. Leaving the old file in place shows plausible numbers with
  // no reason to doubt them; deleting it loses the last good answer. Writing an
  // error that remembers when things last worked is the only honest option.
  await withDir(async (file) => {
    await writeSnapshot({ file, runDoctor: async () => ({ ...GOOD, generatedAt: "2026-09-17T04:00:00.000Z" }) });
    await writeSnapshot({ file, runDoctor: async () => { throw new Error("boom"); } });

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.lastGoodAt, "2026-09-17T04:00:00.000Z", "a reader must be able to say 'last good at 04:00'");
    assert.equal(raw.error, "boom");
    assert.equal(raw.totals, null, "and must NOT find stale totals sitting there looking current");
    assert.equal(raw.sections, null);
  });
});

test("a failed refresh does not leave the old PAYLOAD readable as current", async () => {
  await withDir(async (file) => {
    await writeSnapshot({ file, runDoctor: async () => ({ ...GOOD, problems: 0 }) });
    assert.equal((await readSnapshot(file)).ok, true);
    await writeSnapshot({ file, runDoctor: async () => { throw new Error("nope"); } });
    const after = await readSnapshot(file);
    assert.equal(after.ok, false, "ok:true here would be the lie");
  });
});

// ── the happy path, and freshness ──────────────────────────────────────────

test("a good snapshot round-trips and reports its age", async () => {
  await withDir(async (file) => {
    await writeSnapshot({ file, runDoctor: async () => ({ ...GOOD }) });
    const r = await readSnapshot(file);
    assert.equal(r.ok, true);
    assert.equal(r.payload.problems, 0);
    assert.equal(r.payload.sections.length, 1);
    assert.ok(typeof r.ageMs === "number" && r.ageMs >= 0, "age must be derivable so staleness is visible");
    assert.ok(r.ageMs < 60_000, "a snapshot just written is not hours old");
  });
});

test("generatedAt is stamped when the runner omits it", async () => {
  await withDir(async (file) => {
    await writeSnapshot({ file, runDoctor: async () => ({ ...GOOD }) });
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.ok(Date.parse(raw.generatedAt) > 0, "a snapshot with no timestamp cannot be aged");
  });
});

test("the write is atomic — no .tmp is left behind", async () => {
  await withDir(async (file) => {
    await writeSnapshot({ file, runDoctor: async () => ({ ...GOOD }) });
    assert.equal(existsSync(`${file}.tmp`), false);
    assert.equal(existsSync(file), true);
  });
});
