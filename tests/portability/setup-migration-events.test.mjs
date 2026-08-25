/**
 * P2 (state migration) — plan `~/.claude/plans/status-temporal-plum.md` §"Phase 1 -> 1b".
 *
 * `LEGACY_STATE.live` covered 4 of ~14 real artifacts (GOTCHAS G12, discharged for those
 * four and open for the rest). The one whose loss is unrecoverable — the v2 event store
 * at `events/` — was in neither list. This file is the discharge for the remaining four
 * MOVE-semantic artifacts: `events/` (a DIRECTORY, not a file — the existing loop assumed
 * `renameSync` on a single file, which is the wrong primitive for a directory that may
 * already partly exist at the destination), `graph-index.db`, `graph-index.cypher`,
 * `notified.jsonl`.
 *
 * Also covers relocating orphaned `*.jsonl.pre-truncate-*` backups (a truncation backup of
 * the event store, sitting loose at the state-dir root where a glob could mistake it for a
 * live shard) into `events/archive/`.
 *
 * `cross-allow.yml` is COVERED HERE TOO but is NOT move-semantic — see the `seedOnly`
 * tests near the bottom. A first pass at this file put it in `LEGACY_STATE.live` and, run
 * for real against the actual repo, MOVED (deleted) the shipped `cross-allow.yml` out of
 * the repo root — the permanent fallback `CROSS_ALLOW_SHIPPED`
 * (lib/core/config.mjs:444) depends on. Invisible on a machine that already has a user
 * copy shadowing it (this one did), and a real ENOENT for every stranger install that
 * doesn't. `git checkout HEAD -- cross-allow.yml` restored the repo; the tests below are
 * the regression guard so the same design mistake can't land silently again.
 *
 * Per rule:safety-flag-needs-a-test — assert the SIDE EFFECT (bytes on disk, before/after
 * snapshots), never the message. Every test here reads file contents back, not just names.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateLegacyState, LEGACY_STATE } from "../../lib/core/setup.mjs";

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "propagate-migrate-events-"));
  const from = path.join(root, "skill");
  const to = path.join(root, "state");
  mkdirSync(from, { recursive: true });
  return { root, from, to, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

/** Every file under `dir`, as `{relPath: contents}`. Used for before/after snapshots. */
function snapshot(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) out[path.relative(dir, p)] = readFileSync(p, "utf8");
    }
  }
  return out;
}

test("the new move-semantic artifacts are declared in LEGACY_STATE.live", () => {
  for (const name of ["events", "graph-index.db", "graph-index.cypher", "notified.jsonl"]) {
    assert.ok(LEGACY_STATE.live.includes(name), `${name} missing from LEGACY_STATE.live`);
  }
});

test("cross-allow.yml is declared seed-only, never move-semantic", () => {
  // The regression this guards: cross-allow.yml must NEVER be a candidate for
  // relocateFile's move-then-unlink behaviour, because SKILL_DIR/cross-allow.yml is the
  // permanent shipped fallback (CROSS_ALLOW_SHIPPED), not a stray legacy artifact.
  assert.ok(!LEGACY_STATE.live.includes("cross-allow.yml"), "must not be in `live` (move semantics)");
  assert.ok(LEGACY_STATE.seedOnly.includes("cross-allow.yml"), "must be in `seedOnly` (copy semantics)");
});

test("a directory (events/ with several shard files) migrates with all its contents", () => {
  const s = sandbox();
  try {
    const evDir = path.join(s.from, "events");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(path.join(evDir, "2026-08.jsonl"), "shard-aug\n".repeat(3));
    writeFileSync(path.join(evDir, "2026-07.jsonl"), "shard-jul\n".repeat(5));

    const before = snapshot(s.from);

    const r = migrateLegacyState(s.from, s.to);

    assert.ok(r.moved.includes(path.join("events", "2026-08.jsonl")), "aug shard reported moved");
    assert.ok(r.moved.includes(path.join("events", "2026-07.jsonl")), "jul shard reported moved");

    // Nothing lost: every byte that existed in `from` before is now readable at `to`,
    // and nothing remains at `from`.
    for (const [rel, contents] of Object.entries(before)) {
      if (!rel.startsWith("events" + path.sep)) continue;
      assert.equal(readFileSync(path.join(s.to, rel), "utf8"), contents, `${rel} content preserved at destination`);
      assert.ok(!existsSync(path.join(s.from, rel)), `${rel} left behind at source`);
    }
  } finally {
    s.cleanup();
  }
});

test("a directory merges into an existing destination directory without clobbering", () => {
  // The real-world shape: `to` (~/.propagate/events/) already holds live, irreplaceable
  // data (1347 events at time of writing) when `from` (SKILL_DIR/events/, legacy) is
  // migrated in. A file-by-file merge must never overwrite what is already there.
  const s = sandbox();
  try {
    mkdirSync(path.join(s.to, "events"), { recursive: true });
    writeFileSync(path.join(s.to, "events", "2026-08.jsonl"), "REAL-PRODUCTION-DATA");

    mkdirSync(path.join(s.from, "events"), { recursive: true });
    writeFileSync(path.join(s.from, "events", "2026-08.jsonl"), "stale-legacy-copy");
    writeFileSync(path.join(s.from, "events", "2026-06.jsonl"), "old-shard-only-at-source");

    const r = migrateLegacyState(s.from, s.to);

    // The colliding shard is a conflict, not a silent pick.
    assert.ok(r.conflicts.includes(path.join("events", "2026-08.jsonl")), "colliding shard reported as conflict");
    assert.equal(
      readFileSync(path.join(s.to, "events", "2026-08.jsonl"), "utf8"),
      "REAL-PRODUCTION-DATA",
      "destination shard untouched by the collision",
    );
    assert.equal(
      readFileSync(path.join(s.from, "events", "2026-08.jsonl"), "utf8"),
      "stale-legacy-copy",
      "source shard left in place for a human to resolve",
    );

    // The non-colliding shard still migrates cleanly.
    assert.ok(r.moved.includes(path.join("events", "2026-06.jsonl")));
    assert.equal(readFileSync(path.join(s.to, "events", "2026-06.jsonl"), "utf8"), "old-shard-only-at-source");
    assert.ok(!existsSync(path.join(s.from, "events", "2026-06.jsonl")));
  } finally {
    s.cleanup();
  }
});

test("simple new artifacts (graph-index.db, graph-index.cypher, notified.jsonl) migrate like the original four", () => {
  const s = sandbox();
  try {
    const names = ["graph-index.db", "graph-index.cypher", "notified.jsonl"];
    for (const name of names) writeFileSync(path.join(s.from, name), `payload:${name}`);

    const r = migrateLegacyState(s.from, s.to);

    for (const name of names) {
      assert.ok(r.moved.includes(name), `${name} moved`);
      assert.ok(!existsSync(path.join(s.from, name)), `${name} left behind at source`);
      assert.equal(readFileSync(path.join(s.to, name), "utf8"), `payload:${name}`);
    }
  } finally {
    s.cleanup();
  }
});

test("an existing simple destination file among the new move-semantic artifacts is never clobbered", () => {
  const s = sandbox();
  try {
    const name = "graph-index.db";
    writeFileSync(path.join(s.from, name), "legacy-copy");
    mkdirSync(s.to, { recursive: true });
    writeFileSync(path.join(s.to, name), "current-copy");

    const r = migrateLegacyState(s.from, s.to);

    assert.ok(r.conflicts.includes(name));
    assert.ok(!r.moved.includes(name));
    assert.equal(readFileSync(path.join(s.to, name), "utf8"), "current-copy");
    assert.equal(readFileSync(path.join(s.from, name), "utf8"), "legacy-copy");
  } finally {
    s.cleanup();
  }
});

test("cross-allow.yml: seeded (COPIED) into an empty destination, source untouched", () => {
  // This is the scenario a stranger install hits: no user copy exists yet in the state
  // dir. Seeding it gives them an editable starting point without ever touching the
  // shipped copy at fromDir -- which, in production, IS the repo's tracked file.
  const s = sandbox();
  try {
    writeFileSync(path.join(s.from, "cross-allow.yml"), "shipped-default-content");

    const r = migrateLegacyState(s.from, s.to);

    assert.ok(r.seeded.includes("cross-allow.yml"), "reported as seeded");
    assert.ok(!r.moved.includes("cross-allow.yml"), "never reported as moved -- it is not move-semantic");
    assert.equal(readFileSync(path.join(s.to, "cross-allow.yml"), "utf8"), "shipped-default-content", "copied byte-identical");
    // The load-bearing assertion: the shipped copy still exists at the source.
    assert.ok(existsSync(path.join(s.from, "cross-allow.yml")), "shipped copy MUST still exist at fromDir after migration");
    assert.equal(readFileSync(path.join(s.from, "cross-allow.yml"), "utf8"), "shipped-default-content", "source content unchanged");
  } finally {
    s.cleanup();
  }
});

test("cross-allow.yml: an existing user copy at the destination is never touched or overwritten", () => {
  // The steady state on the real machine: ~/.propagate/cross-allow.yml already existed
  // (since before this migration code did) with the user's real partner_roots list.
  const s = sandbox();
  try {
    writeFileSync(path.join(s.from, "cross-allow.yml"), "shipped-default-content");
    mkdirSync(s.to, { recursive: true });
    writeFileSync(path.join(s.to, "cross-allow.yml"), "REAL-USER-PARTNER-ROOTS");

    const r = migrateLegacyState(s.from, s.to);

    assert.ok(!r.seeded.includes("cross-allow.yml"), "not reported as seeded -- there was nothing to seed");
    assert.equal(readFileSync(path.join(s.to, "cross-allow.yml"), "utf8"), "REAL-USER-PARTNER-ROOTS", "user copy at destination untouched");
    assert.ok(existsSync(path.join(s.from, "cross-allow.yml")), "shipped copy at source still exists");
    assert.equal(readFileSync(path.join(s.from, "cross-allow.yml"), "utf8"), "shipped-default-content", "shipped copy content unchanged");
  } finally {
    s.cleanup();
  }
});

test("cross-allow.yml: absent from fromDir seeds nothing and is not an error", () => {
  const s = sandbox();
  try {
    const r = migrateLegacyState(s.from, s.to);
    assert.ok(!r.seeded.includes("cross-allow.yml"));
    assert.ok(!existsSync(path.join(s.to, "cross-allow.yml")));
  } finally {
    s.cleanup();
  }
});

test("EXDEV (cross-device rename failure) still falls back to copy+unlink for a directory's files", () => {
  // node:test's MockTracker cannot reliably intercept the `node:fs` builtin named
  // export this module imports (confirmed by hand: mocking `require("node:fs")
  // .renameSync` from a test does not affect the `renameSync` this module calls --
  // the file still moved via the REAL implementation, silently passing a test that
  // asserted nothing about the fallback path actually running). `migrateLegacyState`
  // therefore accepts a test-only `_renameImpl` override so the EXDEV branch can be
  // forced deterministically and its OWN fallback code -- not the happy path wearing
  // its clothes -- is what gets exercised.
  const s = sandbox();
  try {
    const evDir = path.join(s.from, "events");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(path.join(evDir, "2026-08.jsonl"), "exdev-payload");

    let called = false;
    const failingRename = () => {
      called = true;
      const err = new Error("EXDEV: cross-device link not permitted");
      err.code = "EXDEV";
      throw err;
    };

    const r = migrateLegacyState(s.from, s.to, { _renameImpl: failingRename });

    assert.ok(called, "the injected rename was actually invoked (and made to fail)");
    assert.ok(r.moved.includes(path.join("events", "2026-08.jsonl")), "fell back to copy+unlink and still reported moved");
    assert.equal(readFileSync(path.join(s.to, "events", "2026-08.jsonl"), "utf8"), "exdev-payload");
    assert.ok(!existsSync(path.join(s.from, "events", "2026-08.jsonl")), "source unlinked after the copy fallback");
  } finally {
    s.cleanup();
  }
});

test("an orphaned *.jsonl.pre-truncate-* backup at the destination root is relocated into events/archive/", () => {
  // The real machine: ~/.propagate/2026-08.jsonl.pre-truncate-2026-08-17 sits at the
  // STATE DIR ROOT today -- the only surviving copy of ~150 rows whose originals were
  // truncated away. It must be relocated, never deleted, never truncated, never
  // silently overwritten.
  const s = sandbox();
  try {
    mkdirSync(s.to, { recursive: true });
    const backupName = "2026-08.jsonl.pre-truncate-2026-08-17";
    writeFileSync(path.join(s.to, backupName), "IRREPLACEABLE-BACKUP-CONTENT");

    const r = migrateLegacyState(s.from, s.to);

    const archivedPath = path.join(s.to, "events", "archive", backupName);
    assert.ok(existsSync(archivedPath), "backup relocated into events/archive/");
    assert.equal(readFileSync(archivedPath, "utf8"), "IRREPLACEABLE-BACKUP-CONTENT", "content byte-identical");
    assert.ok(!existsSync(path.join(s.to, backupName)), "no longer sitting loose at the state-dir root");
    assert.ok(
      r.moved.includes(path.join("events", "archive", backupName)),
      "reported as moved, not silently relocated",
    );
  } finally {
    s.cleanup();
  }
});

test("a pre-truncate backup is never clobbered if events/archive/ already has one of that name", () => {
  const s = sandbox();
  try {
    const backupName = "2026-08.jsonl.pre-truncate-2026-08-17";
    mkdirSync(path.join(s.to, "events", "archive"), { recursive: true });
    writeFileSync(path.join(s.to, "events", "archive", backupName), "already-archived");
    writeFileSync(path.join(s.to, backupName), "loose-duplicate");

    const r = migrateLegacyState(s.from, s.to);

    assert.equal(readFileSync(path.join(s.to, "events", "archive", backupName), "utf8"), "already-archived");
    // Never delete, never truncate: the loose duplicate must still exist somewhere readable.
    assert.equal(readFileSync(path.join(s.to, backupName), "utf8"), "loose-duplicate", "loose copy left in place, not lost");
    assert.ok(r.conflicts.includes(path.join("events", "archive", backupName)));
  } finally {
    s.cleanup();
  }
});

test("row-count-shaped regression guard: a full LEGACY_STATE.live migration loses nothing, gains nothing", () => {
  // Not a literal ledger-row count (this module doesn't touch the ledger), but the same
  // discipline the plan asks for: snapshot everything before, assert the after-snapshot
  // is exactly the union of (untouched retired/unrelated files) + (moved live files at
  // their new home), with byte-identical content -- nothing silently dropped, nothing
  // silently duplicated.
  const s = sandbox();
  try {
    for (const name of LEGACY_STATE.live) {
      if (name === "events") continue; // covered by its own directory tests above
      writeFileSync(path.join(s.from, name), `content:${name}`);
    }
    const evDir = path.join(s.from, "events");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(path.join(evDir, "shard.jsonl"), "event-rows");

    const beforeFromCount = Object.keys(snapshot(s.from)).length;
    const r = migrateLegacyState(s.from, s.to);
    const afterTo = snapshot(s.to);
    const afterFrom = snapshot(s.from);

    assert.equal(Object.keys(afterFrom).length, 0, "nothing left behind at source");
    assert.equal(Object.keys(afterTo).length, beforeFromCount, "every file that existed now exists exactly once at destination");
    assert.deepEqual(r.conflicts, [], "no conflicts in the clean case");
  } finally {
    s.cleanup();
  }
});
