/**
 * lib/events.mjs — the v2 verification store.
 *
 * Foundation-only: this test file exercises lib/events.mjs in isolation.
 * It does NOT touch watcher.mjs/cli.mjs/digest.mjs (not wired in yet) and
 * must not disturb the real store — every test scopes PROPAGATE_STATE_DIR
 * to a fresh tmpdir via a subprocess helper, or (for the fast in-process
 * cases) relies on lib/events.mjs's own EVENTS_DIR only being read, never
 * asserted to be the production path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  mintEventId,
  edgeId,
  appendEvent,
  readEvents,
  knownGoodPairs,
  shardPathForTs,
  DISPOSITIONS,
} from "../lib/events.mjs";

const EVENTS_LIB_PATH = fileURLToPath(new URL("../lib/events.mjs", import.meta.url));

/**
 * Every test that writes events must not write into the real store. Since
 * EVENTS_DIR is a module-level const computed from STATE_DIR at import
 * time, scoping it per-test requires a fresh subprocess per env value —
 * same pattern as tests/config-state-dir.test.mjs and tests/doctor.test.mjs.
 */
async function withScopedStore(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "events-store-"));
  try {
    await fn(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

/** Run a small ESM script in a subprocess with the given env, return parsed stdout JSON. */
function runInSubprocess(script, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, `subprocess failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

function baseEvent(overrides = {}) {
  return {
    edge_id: edgeId("VipinKaushik:lib/pricing.ts", "app/pricing/page.tsx", "pricing table"),
    node_id: "VipinKaushik:lib/pricing.ts",
    source_content: "d9231e2a".repeat(8),
    downstream_content: "7f3c9b41".repeat(8),
    source_git_blob: "5d8d5f09".repeat(5),
    disposition: "propagated",
    reason: "updated the pricing table to match",
    by: "rupali",
    observed_on_ref: "production",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ULID
// ---------------------------------------------------------------------------

test("mintEventId — two ids minted in the same millisecond differ", () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(mintEventId());
  assert.equal(ids.size, 500, "all 500 rapid-fire ids must be unique");
});

test("mintEventId — ids sort in creation order across different milliseconds", async () => {
  const first = mintEventId();
  await new Promise((r) => setTimeout(r, 5));
  const second = mintEventId();
  await new Promise((r) => setTimeout(r, 5));
  const third = mintEventId();

  const sorted = [first, second, third].slice().sort();
  assert.deepEqual(sorted, [first, second, third]);
});

test("mintEventId — is a 26-char Crockford base32 string", () => {
  const id = mintEventId();
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

// ---------------------------------------------------------------------------
// edgeId
// ---------------------------------------------------------------------------

test("edgeId — stable across calls with the same inputs", () => {
  const a = edgeId("VipinKaushik:lib/pricing.ts", "app/pricing/page.tsx", "pricing table");
  const b = edgeId("VipinKaushik:lib/pricing.ts", "app/pricing/page.tsx", "pricing table");
  assert.equal(a, b);
});

test("edgeId — differs when node_id differs", () => {
  const a = edgeId("VipinKaushik:lib/pricing.ts", "app/pricing/page.tsx", "pricing table");
  const b = edgeId("VipinKaushik:lib/contact.ts", "app/pricing/page.tsx", "pricing table");
  assert.notEqual(a, b);
});

test("edgeId — differs when downstream differs", () => {
  const a = edgeId("VipinKaushik:lib/pricing.ts", "app/pricing/page.tsx", "pricing table");
  const b = edgeId("VipinKaushik:lib/pricing.ts", "app/checkout/page.tsx", "pricing table");
  assert.notEqual(a, b);
});

test("edgeId — differs when why differs", () => {
  const a = edgeId("VipinKaushik:lib/pricing.ts", "app/pricing/page.tsx", "pricing table");
  const b = edgeId("VipinKaushik:lib/pricing.ts", "app/pricing/page.tsx", "consultation copy");
  assert.notEqual(a, b);
});

test("edgeId — is an 8-hex-char string", () => {
  const id = edgeId("a", "b", "c");
  assert.match(id, /^[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// appendEvent / readEvents round-trip
// ---------------------------------------------------------------------------

test("round-trip: append then read returns every field unchanged", async () => {
  await withScopedStore(async (stateDir) => {
    const script = `
      import { appendEvent, readEvents } from ${JSON.stringify(EVENTS_LIB_PATH)};
      const event = ${JSON.stringify(baseEvent())};
      const stamped = await appendEvent(event);
      const { events } = await readEvents();
      console.log(JSON.stringify({ stamped, events }));
    `;
    const out = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
    assert.equal(out.events.length, 1);
    const read = out.events[0];

    for (const [key, value] of Object.entries(baseEvent())) {
      assert.equal(read[key], value, `field "${key}" survived the round trip`);
    }
    assert.ok(read.event_id, "event_id was minted");
    assert.ok(read.ts, "ts was minted");
    assert.equal(read.hash_alg, "sha256", "hash_alg defaults to sha256");
    assert.deepEqual(read, out.stamped, "what appendEvent returned is what readEvents reads back");
  });
});

test("appendEvent ignores a caller-supplied event_id/ts and mints its own", async () => {
  await withScopedStore(async (stateDir) => {
    const event = baseEvent({ event_id: "should-be-ignored", ts: "1999-01-01T00:00:00.000Z" });
    const script = `
      import { appendEvent } from ${JSON.stringify(EVENTS_LIB_PATH)};
      const stamped = await appendEvent(${JSON.stringify(event)});
      console.log(JSON.stringify(stamped));
    `;
    const stamped = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
    assert.notEqual(stamped.event_id, "should-be-ignored");
    assert.notEqual(stamped.ts, "1999-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Dispositions — throw conditions
// ---------------------------------------------------------------------------

test("throws on an unknown disposition, naming the event id and field", async () => {
  await assert.rejects(
    appendEvent(baseEvent({ disposition: "bogus" })),
    (err) => {
      assert.match(err.message, /unknown disposition/);
      assert.match(err.message, /"disposition"/);
      assert.match(err.message, /appendEvent: event [0-9A-Z]{26} —/);
      return true;
    },
  );
});

test("throws on wontfix without reason, naming the event id", async () => {
  const event = baseEvent({ disposition: "wontfix" });
  delete event.reason;
  await assert.rejects(appendEvent(event), (err) => {
    assert.match(err.message, /wontfix/);
    assert.match(err.message, /reason/);
    assert.match(err.message, /appendEvent: event [0-9A-Z]{26} —/);
    return true;
  });
});

test("wontfix with reason is accepted (validation only — no disk write asserted here)", async () => {
  await withScopedStore(async (stateDir) => {
    const event = baseEvent({ disposition: "wontfix", reason: "deliberately not propagating this edit" });
    const script = `
      import { appendEvent } from ${JSON.stringify(EVENTS_LIB_PATH)};
      const stamped = await appendEvent(${JSON.stringify(event)});
      console.log(JSON.stringify(stamped));
    `;
    const stamped = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
    assert.equal(stamped.disposition, "wontfix");
  });
});

test("throws on baselined without a reason naming its evidence", async () => {
  const event = baseEvent({ disposition: "baselined" });
  delete event.reason;
  await assert.rejects(appendEvent(event), (err) => {
    assert.match(err.message, /baselined/);
    assert.match(err.message, /reason/);
    assert.match(err.message, /claim, not a verification/);
    return true;
  });
});

test("baselined is never indistinguishable from a real verification — still requires content pins", async () => {
  const event = baseEvent({ disposition: "baselined", reason: "co-committed in abc123" });
  delete event.source_content;
  await assert.rejects(appendEvent(event), (err) => {
    assert.match(err.message, /source_content/);
    return true;
  });
});

test("throws when source_content is missing on a pinning disposition", async () => {
  const event = baseEvent({ disposition: "propagated" });
  delete event.source_content;
  await assert.rejects(appendEvent(event), (err) => {
    assert.match(err.message, /"source_content"/);
    assert.match(err.message, /propagated/);
    return true;
  });
});

test("throws when downstream_content is missing on a pinning disposition", async () => {
  const event = baseEvent({ disposition: "no-change-needed" });
  delete event.downstream_content;
  await assert.rejects(appendEvent(event), (err) => {
    assert.match(err.message, /"downstream_content"/);
    return true;
  });
});

test("throws when a deferred event pins content — deferred must not re-pin", async () => {
  const event = baseEvent({ disposition: "deferred" });
  // source_content/downstream_content still present from baseEvent()
  await assert.rejects(appendEvent(event), (err) => {
    assert.match(err.message, /deferred/);
    assert.match(err.message, /must not pin/);
    return true;
  });
});

test("deferred with no content pinned is accepted", async () => {
  await withScopedStore(async (stateDir) => {
    const event = baseEvent({ disposition: "deferred", reason: "looked, postponing" });
    delete event.source_content;
    delete event.downstream_content;
    const script = `
      import { appendEvent } from ${JSON.stringify(EVENTS_LIB_PATH)};
      const stamped = await appendEvent(${JSON.stringify(event)});
      console.log(JSON.stringify(stamped));
    `;
    const stamped = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
    assert.equal(stamped.disposition, "deferred");
    assert.equal(stamped.source_content, undefined);
    assert.equal(stamped.downstream_content, undefined);
  });
});

test("every disposition round-trips except deferred requiring the inverse content rule", async () => {
  // Sanity sweep: every disposition other than deferred/wontfix/baselined
  // (already covered above) accepts a fully-pinned event.
  const plain = DISPOSITIONS.filter((d) => !["deferred", "wontfix", "baselined"].includes(d));
  for (const disposition of plain) {
    await withScopedStore(async (stateDir) => {
      const event = baseEvent({ disposition, reason: "reason for " + disposition });
      const script = `
        import { appendEvent } from ${JSON.stringify(EVENTS_LIB_PATH)};
        const stamped = await appendEvent(${JSON.stringify(event)});
        console.log(JSON.stringify(stamped));
      `;
      const stamped = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
      assert.equal(stamped.disposition, disposition);
    });
  }
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test("~20 concurrent appends: all land, no interleaving, no duplicate ids", async () => {
  await withScopedStore(async (stateDir) => {
    const script = `
      import { appendEvent, readEvents } from ${JSON.stringify(EVENTS_LIB_PATH)};
      const base = ${JSON.stringify(baseEvent())};
      const N = 20;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          appendEvent({ ...base, reason: "concurrent write #" + i })
        )
      );
      const { events, malformed } = await readEvents();
      console.log(JSON.stringify({ results, events, malformed, N }));
    `;
    const out = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });

    assert.equal(out.malformed, 0, "no interleaved/corrupt lines from concurrent writers");
    assert.equal(out.events.length, out.N, "every concurrent append landed");

    const ids = new Set(out.events.map((e) => e.event_id));
    assert.equal(ids.size, out.N, "no duplicate event ids");

    const reasons = new Set(out.events.map((e) => e.reason));
    assert.equal(reasons.size, out.N, "no write clobbered another — all 20 distinct payloads present");
  });
});

// ---------------------------------------------------------------------------
// readEvents filtering
// ---------------------------------------------------------------------------

test("readEvents filters by edgeId", async () => {
  await withScopedStore(async (stateDir) => {
    const eventA = baseEvent({ edge_id: "aaaaaaaa" });
    const eventB = baseEvent({ edge_id: "bbbbbbbb" });
    const script = `
      import { appendEvent, readEvents } from ${JSON.stringify(EVENTS_LIB_PATH)};
      await appendEvent(${JSON.stringify(eventA)});
      await appendEvent(${JSON.stringify(eventB)});
      const { events } = await readEvents({ edgeId: "aaaaaaaa" });
      console.log(JSON.stringify(events));
    `;
    const events = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
    assert.equal(events.length, 1);
    assert.equal(events[0].edge_id, "aaaaaaaa");
  });
});

test("readEvents filters by since", async () => {
  await withScopedStore(async (stateDir) => {
    const script = `
      import { appendEvent, readEvents } from ${JSON.stringify(EVENTS_LIB_PATH)};
      const base = ${JSON.stringify(baseEvent())};
      const early = await appendEvent(base, { now: new Date("2026-08-01T00:00:00.000Z") });
      const late = await appendEvent(base, { now: new Date("2026-08-20T00:00:00.000Z") });
      const { events } = await readEvents({ since: "2026-08-10T00:00:00.000Z" });
      console.log(JSON.stringify({ early, late, events }));
    `;
    const out = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0].event_id, out.late.event_id);
  });
});

// ---------------------------------------------------------------------------
// knownGoodPairs
// ---------------------------------------------------------------------------

test("knownGoodPairs returns the exact triples appended", async () => {
  await withScopedStore(async (stateDir) => {
    const eventA = baseEvent({ edge_id: "aaaaaaaa", source_content: "srcA", downstream_content: "dstA" });
    const eventB = baseEvent({ edge_id: "bbbbbbbb", source_content: "srcB", downstream_content: "dstB" });
    const eventDeferred = baseEvent({ disposition: "deferred", reason: "looked" });
    delete eventDeferred.source_content;
    delete eventDeferred.downstream_content;

    const script = `
      import { appendEvent, knownGoodPairs } from ${JSON.stringify(EVENTS_LIB_PATH)};
      await appendEvent(${JSON.stringify(eventA)});
      await appendEvent(${JSON.stringify(eventB)});
      await appendEvent(${JSON.stringify(eventDeferred)});
      const pairs = await knownGoodPairs();
      console.log(JSON.stringify([...pairs]));
    `;
    const pairs = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
    assert.equal(pairs.length, 2, "deferred (unpinned) does not contribute a triple");
    assert.ok(pairs.includes("aaaaaaaa|srcA|dstA"));
    assert.ok(pairs.includes("bbbbbbbb|srcB|dstB"));
  });
});

// ---------------------------------------------------------------------------
// Store honours PROPAGATE_STATE_DIR; default resolves outside the plugin dir
// ---------------------------------------------------------------------------

test("EVENTS_DIR honours PROPAGATE_STATE_DIR", async () => {
  await withScopedStore(async (stateDir) => {
    const script = `
      import { EVENTS_DIR } from ${JSON.stringify(EVENTS_LIB_PATH)};
      console.log(JSON.stringify({ EVENTS_DIR }));
    `;
    const out = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
    assert.equal(out.EVENTS_DIR, path.join(path.resolve(stateDir), "events"));
  });
});

test("EVENTS_DIR default (PROPAGATE_STATE_DIR unset) resolves outside the plugin/skill directory", async () => {
  const env = { ...process.env };
  delete env.PROPAGATE_STATE_DIR;
  const script = `
    import { EVENTS_DIR } from ${JSON.stringify(EVENTS_LIB_PATH)};
    import { SKILL_DIR } from ${JSON.stringify(fileURLToPath(new URL("../lib/config.mjs", import.meta.url)))};
    console.log(JSON.stringify({ EVENTS_DIR, SKILL_DIR }));
  `;
  const out = runInSubprocess(script, env);
  assert.equal(
    out.EVENTS_DIR,
    path.join(os.homedir(), ".propagate", "events"),
    "unset default is ~/.propagate/events, not a path under SKILL_DIR",
  );
  assert.ok(
    !out.EVENTS_DIR.startsWith(out.SKILL_DIR),
    "default EVENTS_DIR must not live inside the plugin/skill directory (N13/N14)",
  );
});

// ---------------------------------------------------------------------------
// Month sharding
// ---------------------------------------------------------------------------

test("shardPathForTs — different months land in different files", () => {
  const p1 = shardPathForTs("2026-08-14T10:00:00.000Z");
  const p2 = shardPathForTs("2026-09-01T00:00:00.000Z");
  assert.notEqual(p1, p2);
  assert.match(p1, /2026-08\.jsonl$/);
  assert.match(p2, /2026-09\.jsonl$/);
});

test("month sharding: events in different months land in different files on disk", async () => {
  await withScopedStore(async (stateDir) => {
    const script = `
      import { appendEvent } from ${JSON.stringify(EVENTS_LIB_PATH)};
      const base = ${JSON.stringify(baseEvent())};
      await appendEvent(base, { now: new Date("2026-08-14T10:00:00.000Z") });
      await appendEvent(base, { now: new Date("2026-09-01T00:00:00.000Z") });
      console.log(JSON.stringify({ ok: true }));
    `;
    runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });

    const files = (await readdir(path.join(stateDir, "events"))).sort();
    assert.deepEqual(files, ["2026-08.jsonl", "2026-09.jsonl"]);

    const augRaw = await readFile(path.join(stateDir, "events", "2026-08.jsonl"), "utf8");
    const sepRaw = await readFile(path.join(stateDir, "events", "2026-09.jsonl"), "utf8");
    assert.equal(augRaw.trim().split("\n").length, 1);
    assert.equal(sepRaw.trim().split("\n").length, 1);
  });
});

// ---------------------------------------------------------------------------
// Corrupt lines are counted, never silently skipped
// ---------------------------------------------------------------------------

test("an unreadable/corrupt line is counted and surfaced, never silently skipped", async () => {
  await withScopedStore(async (stateDir) => {
    // Append one valid event, then hand-corrupt its shard file, then read.
    const appendScript = `
      import { appendEvent } from ${JSON.stringify(EVENTS_LIB_PATH)};
      const stamped = await appendEvent(${JSON.stringify(baseEvent())});
      console.log(JSON.stringify(stamped));
    `;
    const stamped = runInSubprocess(appendScript, { ...process.env, PROPAGATE_STATE_DIR: stateDir });

    // Corrupt the shard directly: append a non-JSON line.
    const realShard = path.join(stateDir, "events", `${stamped.ts.slice(0, 7)}.jsonl`);
    const { appendFile: appendFileFs } = await import("node:fs/promises");
    await appendFileFs(realShard, "{not valid json\n");

    const readScript = `
      import { readEvents } from ${JSON.stringify(EVENTS_LIB_PATH)};
      const { events, malformed } = await readEvents();
      console.log(JSON.stringify({ events, malformed }));
    `;
    const out = runInSubprocess(readScript, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
    assert.equal(out.malformed, 1, "the corrupt line is counted");
    assert.equal(out.events.length, 1, "the one valid line is still readable");
  });
});
