/**
 * lib/report/stream.mjs — "what changed since I last looked."
 *
 * See ~/.claude/plans/i-saw-it-what-starry-sparkle.md, "What the derivation
 * may and may not claim." Four properties, each with a documented cost of
 * getting it wrong:
 *
 *  1. FOLD, NOT COUNT. tests/unit/whole-project-ledger.test.mjs:16-19 —
 *     501 reported open where the truth was 8, a 62x error, already
 *     published once. An edge opened then closed inside the reported window
 *     must read closed.
 *  2. TWO SCHEMA VINTAGES. `downstream_on_ref` is absent on every event
 *     written before 2026-08-22 — a reader assuming today's schema
 *     mis-renders roughly two thirds of the live store.
 *  3. THE CURSOR CANNOT INVENT CHANGE. A missing cursor means "I don't know
 *     when you last looked" (7-day default), never "everything changed" —
 *     rule:delegation-criteria §2 records a lost baseline that invented
 *     ~120 spurious rows from nothing. A corrupt one must say so.
 *  4. NO SUPPRESSED IDENTITIES. They cannot be reconstructed from the store
 *     (monitor.mjs's suppressed set is in-memory only, keyed on current
 *     content) so the payload must carry no field claiming to list them.
 *
 * Tests that exercise streamPayload run in a SUBPROCESS with a scoped
 * PROPAGATE_STATE_DIR — EVENTS_DIR is a module-level const resolved at
 * import time (G56: `node --test` on this file directly, bypassing
 * PROPAGATE_STATE_DIR, would write to the production event ledger). Same
 * pattern as tests/unit/graph-index-events.test.mjs. readCursor/writeCursor/
 * foldWindow/refVintage take explicit file paths or plain data and are
 * tested in-process, without a subprocess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCursor, writeCursor, foldWindow, refVintage } from "../../lib/report/stream.mjs";

const SKILL_DIR = fileURLToPath(new URL("../../", import.meta.url));
const EVENTS_PATH = path.join(SKILL_DIR, "lib/edges/events.mjs");
const STREAM_PATH = path.join(SKILL_DIR, "lib/report/stream.mjs");

/**
 * Run a fixture in a subprocess scoped to a fresh PROPAGATE_STATE_DIR: write
 * zero or more valid events via the real `appendEvent` (so each is a
 * genuinely valid record), zero or more RAW lines written directly to the
 * shard file (to simulate a pre-2026-08-22 event that `appendEvent`'s
 * `validateEvent` would now refuse to write), then call `streamPayload` and
 * print the result as the only stdout line.
 *
 * @param {object} opts
 * @param {{event: object, now: string}[]} [opts.appends]
 * @param {{ts: string, event: object}[]} [opts.rawLines] event objects written verbatim
 * @param {string} [opts.rawMalformed] one deliberately-broken line, same shard convention
 * @param {object} [opts.since] passed straight to streamPayload
 * @returns {Promise<object>} the parsed payload
 */
async function runStream({ appends = [], rawLines = [], rawMalformed = null, since } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "stream-test-state-"));
  const appendCalls = appends
    .map((a) => `await appendEvent(${JSON.stringify(a.event)}, { now: new Date(${JSON.stringify(a.now)}) });`)
    .join("\n");
  const rawWrites = rawLines
    .map(
      (r) =>
        `await appendFile(shardPathForTs(${JSON.stringify(r.ts)}), JSON.stringify(${JSON.stringify(r.event)}) + "\\n");`,
    )
    .join("\n");
  const malformedWrite = rawMalformed
    ? `await appendFile(shardPathForTs(${JSON.stringify(since ?? "2026-09-01T00:00:00.000Z")}), ${JSON.stringify(rawMalformed + "\n")});`
    : "";

  const script = `
    import { appendEvent, shardPathForTs, EVENTS_DIR } from ${JSON.stringify(EVENTS_PATH)};
    import { mkdir, appendFile } from "node:fs/promises";
    import { streamPayload } from ${JSON.stringify(STREAM_PATH)};

    await mkdir(EVENTS_DIR, { recursive: true });
    ${appendCalls}
    ${rawWrites}
    ${malformedWrite}

    const payload = await streamPayload(${JSON.stringify(since === undefined ? {} : { since })});
    console.log(JSON.stringify(payload));
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
  if (result.status !== 0) {
    await rm(stateDir, { recursive: true, force: true });
    throw new Error(`fixture failed: ${result.stderr}`);
  }
  const payload = JSON.parse(result.stdout.trim().split("\n").pop());
  await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return payload;
}

const CONTENT = "s".repeat(64);
const DOWNSTREAM_CONTENT = "d".repeat(64);

const pinning = (over = {}) => ({
  edge_id: "e-fold01",
  node_id: "ws:a.md",
  disposition: "propagated",
  observed_on_ref: "main",
  downstream_on_ref: "main",
  source_content: CONTENT,
  downstream_content: DOWNSTREAM_CONTENT,
  ...over,
});

const deferred = (over = {}) => ({
  edge_id: "e-fold01",
  node_id: "ws:a.md",
  disposition: "deferred",
  observed_on_ref: "main",
  downstream_on_ref: "main",
  ...over,
});

// ── 1. the fold is a fold ───────────────────────────────────────────────────

test("an edge opened then closed inside the window reports CLOSED, not open (the 501-vs-8 shape)", async () => {
  const payload = await runStream({
    since: "2026-09-19T00:00:00.000Z",
    appends: [
      { event: deferred(), now: "2026-09-20T00:00:00.000Z" }, // opened
      { event: pinning({ reason: null }), now: "2026-09-21T00:00:00.000Z" }, // closed, later
    ],
  });

  assert.equal(payload.changed.length, 1, "one edge, one row — folded, not two raw lines");
  assert.equal(payload.changed[0].edge_id, "e-fold01");
  assert.equal(payload.changed[0].open, false, "the LATER pinning event must win over the earlier deferred one");
  assert.equal(payload.changed[0].disposition, "propagated");
  assert.equal(payload.summary.total, 1);
  assert.equal(payload.summary.open, 0);
  assert.equal(payload.summary.closed, 1);
});

test("an edge opened and never closed inside the window reports OPEN", async () => {
  const payload = await runStream({
    since: "2026-09-19T00:00:00.000Z",
    appends: [{ event: deferred({ edge_id: "e-fold02" }), now: "2026-09-20T00:00:00.000Z" }],
  });
  assert.equal(payload.changed.length, 1);
  assert.equal(payload.changed[0].open, true);
  assert.equal(payload.summary.open, 1);
  assert.equal(payload.summary.closed, 0);
});

// ── 2. both schema vintages render ─────────────────────────────────────────

test("a pre-2026-08-22 event (no downstream_on_ref key) and a modern one both render, neither dropped nor mislabelled", async () => {
  const payload = await runStream({
    since: "2026-09-01T00:00:00.000Z",
    appends: [
      // resolved: a real ref string
      {
        event: pinning({ edge_id: "e-new01", downstream_on_ref: "feature-branch" }),
        now: "2026-09-10T00:00:00.000Z",
      },
      // unresolved: the key is present but resolution genuinely failed
      {
        event: pinning({ edge_id: "e-unresolved01", downstream_on_ref: null }),
        now: "2026-09-11T00:00:00.000Z",
      },
    ],
    rawLines: [
      // absent: the pre-2026-08-22 shape, written directly — appendEvent's
      // validateEvent would now refuse this, which is why it is hand-written.
      {
        ts: "2026-09-05T00:00:00.000Z",
        event: {
          event_id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
          ts: "2026-09-05T00:00:00.000Z",
          hash_alg: "sha256",
          edge_id: "e-old01",
          node_id: "ws:b.md",
          disposition: "propagated",
          observed_on_ref: "main",
          source_content: CONTENT,
          downstream_content: DOWNSTREAM_CONTENT,
          // downstream_on_ref DELIBERATELY absent
        },
      },
    ],
    rawMalformed: "{ this is not valid json",
  });

  assert.equal(payload.changed.length, 3, "all three edges must appear — none dropped");
  const byId = Object.fromEntries(payload.changed.map((c) => [c.edge_id, c]));

  assert.equal(byId["e-old01"].downstreamOnRef.status, "absent", "pre-vintage: key never written");
  assert.equal(byId["e-old01"].downstreamOnRef.value, undefined);

  assert.equal(byId["e-new01"].downstreamOnRef.status, "resolved");
  assert.equal(byId["e-new01"].downstreamOnRef.value, "feature-branch");

  assert.equal(byId["e-unresolved01"].downstreamOnRef.status, "unresolved", "present key, null value: resolution failed");
  assert.equal(byId["e-unresolved01"].downstreamOnRef.value, null);

  assert.equal(payload.malformed, 1, "the one deliberately-broken line must be counted, not silently dropped");
});

// ── 3. the cursor cannot invent change ─────────────────────────────────────

test("readCursor: a missing file defaults to the 7-day window, attributed as missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stream-cursor-"));
  const file = path.join(dir, "does-not-exist.json");
  const c = await readCursor(file);
  assert.equal(c.status, "missing");
  const ageMs = Date.now() - Date.parse(c.since);
  assert.ok(ageMs > 6.9 * 86400000 && ageMs < 7.1 * 86400000, `expected ~7 days old, got ${ageMs}ms`);
  await rm(dir, { recursive: true, force: true });
});

test("readCursor: unparseable JSON is reported as CORRUPT, not as missing or as 'everything changed'", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stream-cursor-"));
  const file = path.join(dir, "cursor.json");
  await writeFile(file, "{ not json at all", "utf8");
  const c = await readCursor(file);
  assert.equal(c.status, "corrupt");
  assert.match(c.error, /not valid JSON/);
  const ageMs = Date.now() - Date.parse(c.since);
  assert.ok(ageMs > 6.9 * 86400000 && ageMs < 7.1 * 86400000, "still falls back to the safe 7-day default");
  await rm(dir, { recursive: true, force: true });
});

test("readCursor: valid JSON with a non-ISO since is CORRUPT, not silently accepted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stream-cursor-"));
  const file = path.join(dir, "cursor.json");
  await writeFile(file, JSON.stringify({ since: "not-a-real-date" }), "utf8");
  const c = await readCursor(file);
  assert.equal(c.status, "corrupt");
  assert.match(c.error, /not a valid ISO timestamp/);
  await rm(dir, { recursive: true, force: true });
});

test("writeCursor then readCursor round-trips a valid cursor as ok", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stream-cursor-"));
  const file = path.join(dir, "cursor.json");
  const at = "2026-09-24T12:00:00.000Z";
  const written = await writeCursor(at, file);
  assert.equal(written, at);
  const c = await readCursor(file);
  assert.equal(c.status, "ok");
  assert.equal(c.since, at);
  await rm(dir, { recursive: true, force: true });
});

test("streamPayload itself defaults to the 7-day window when `since` is omitted or unparseable — never 'everything'", async () => {
  const missing = await runStream({ appends: [] }); // since: undefined
  assert.equal(missing.sinceSource, "default-7d");
  let ageMs = Date.now() - Date.parse(missing.since);
  assert.ok(ageMs > 6.9 * 86400000 && ageMs < 7.1 * 86400000);

  const invalid = await runStream({ since: "definitely-not-a-date", appends: [] });
  assert.equal(invalid.sinceSource, "invalid-given-defaulted");
  ageMs = Date.now() - Date.parse(invalid.since);
  assert.ok(ageMs > 6.9 * 86400000 && ageMs < 7.1 * 86400000);
});

// ── 4. no suppressed identities ─────────────────────────────────────────────

test("the payload carries no field purporting to list suppressed identities", async () => {
  const payload = await runStream({
    since: "2026-09-19T00:00:00.000Z",
    appends: [{ event: pinning(), now: "2026-09-20T00:00:00.000Z" }],
  });
  const topLevelSuppress = Object.keys(payload).filter((k) => /suppress/i.test(k));
  assert.deepEqual(topLevelSuppress, [], "no top-level field names a suppressed set — it cannot be reconstructed");
  for (const row of payload.changed) {
    const rowSuppress = Object.keys(row).filter((k) => /suppress/i.test(k));
    assert.deepEqual(rowSuppress, [], `changed row ${row.edge_id} must not claim suppressed identities either`);
  }
});

// ── pure helpers, no subprocess needed ──────────────────────────────────────

test("foldWindow keeps the latest event per edge_id, by ts", () => {
  const events = [
    { edge_id: "e1", ts: "2026-09-20T00:00:00.000Z", disposition: "deferred", event_id: "a" },
    { edge_id: "e1", ts: "2026-09-21T00:00:00.000Z", disposition: "propagated", event_id: "b" },
    { edge_id: "e2", ts: "2026-09-20T00:00:00.000Z", disposition: "wontfix", event_id: "c" },
  ];
  const winners = foldWindow(events);
  assert.equal(winners.size, 2);
  assert.equal(winners.get("e1").disposition, "propagated");
  assert.equal(winners.get("e2").disposition, "wontfix");
});

test("foldWindow ignores events with no edge_id rather than crashing on them", () => {
  const winners = foldWindow([{ ts: "2026-09-20T00:00:00.000Z", disposition: "propagated" }, null, undefined]);
  assert.equal(winners.size, 0);
});

test("refVintage distinguishes absent / unresolved / resolved", () => {
  assert.deepEqual(refVintage({}), { status: "absent", value: undefined });
  assert.deepEqual(refVintage({ downstream_on_ref: null }), { status: "unresolved", value: null });
  assert.deepEqual(refVintage({ downstream_on_ref: "main" }), { status: "resolved", value: "main" });
});
