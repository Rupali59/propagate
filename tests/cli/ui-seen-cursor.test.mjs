/**
 * ui-seen-cursor.test.mjs — PR-023, the mark-as-seen boundary.
 *
 * The behaviour that was REJECTED is the one worth testing hardest: advancing
 * the cursor when the panel is viewed. A glance would then mark unread changes
 * seen, and nothing would ever tell you it had happened. So the first test
 * below asserts the negative — reading the stream leaves the cursor untouched
 * — and it is the reason this file exists.
 *
 * The cursor lives under PROPAGATE_STATE_DIR, which `lib/report/stream.mjs`
 * resolves at IMPORT time (a module-level const, same shape as G56's
 * EVENTS_DIR). So every case that touches disk runs in a subprocess with the
 * variable already set; setting it in-process would be read too late.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateSeenBody } from "../../commands/ui.mjs";

const STREAM_URL = pathToFileURL(fileURLToPath(new URL("../../lib/report/stream.mjs", import.meta.url))).href;

/** Every byte under the state dir — the artifact, not a report about it. */
function snapshot(dir) {
  if (!existsSync(dir)) return "<absent>";
  return readdirSync(dir, { recursive: true })
    .map(String)
    .sort()
    .map((rel) => {
      const abs = path.join(dir, rel);
      try { return `${rel}\u0000${readFileSync(abs, "utf8")}`; } catch { return `${rel}\u0000<dir>`; }
    })
    .join("\u0001");
}

function run(stateDir, code) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
  assert.equal(r.status, 0, `subprocess failed:\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "seen-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/* ── the rejected behaviour, asserted absent ────────────────────────────── */

test("READING the stream does not move the cursor — advance-on-view stays rejected", async () => {
  await withDir(async (dir) => {
    // Establish a cursor, then read the stream repeatedly.
    run(dir, `
      import { writeCursor } from ${JSON.stringify(STREAM_URL)};
      await writeCursor("2026-09-01T00:00:00.000Z");
      console.log(JSON.stringify({ ok: true }));
    `);
    const before = snapshot(dir);

    run(dir, `
      import { streamPayload, readCursor } from ${JSON.stringify(STREAM_URL)};
      const c = await readCursor();
      await streamPayload({ since: c.since });
      await streamPayload({ since: c.since });
      console.log(JSON.stringify({ ok: true }));
    `);

    assert.equal(snapshot(dir), before,
      "reading the stream changed the state dir — the cursor must only move when a human marks it");
  });
});

/* ── the write path ─────────────────────────────────────────────────────── */

test("marking seen writes the cursor, and writes NOTHING else", async () => {
  await withDir(async (dir) => {
    const at = "2026-09-20T12:00:00.000Z";
    const out = run(dir, `
      import { writeCursor, readCursor } from ${JSON.stringify(STREAM_URL)};
      const w = await writeCursor(${JSON.stringify(at)});
      const r = await readCursor();
      console.log(JSON.stringify({ written: w, status: r.status, since: r.since }));
    `);
    assert.equal(out.written, at);
    assert.equal(out.status, "ok");
    assert.equal(out.since, at, "the boundary read back must be the one that was marked");

    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => !f.endsWith("/"));
    assert.deepEqual(files.sort(), ["stream-cursor.json"],
      `marking seen touched more than the cursor: ${JSON.stringify(files)}`);
  });
});

test("a missing or corrupt cursor falls back to 7 days — it never claims everything changed", async () => {
  await withDir(async (dir) => {
    const missing = run(dir, `
      import { readCursor } from ${JSON.stringify(STREAM_URL)};
      const r = await readCursor();
      console.log(JSON.stringify({ status: r.status, since: r.since }));
    `);
    assert.equal(missing.status, "missing");
    const age = Date.now() - Date.parse(missing.since);
    assert.ok(age > 6.5 * 864e5 && age < 7.5 * 864e5,
      `a missing cursor must default to ~7 days, got ${missing.since}`);

    writeFileSync(path.join(dir, "stream-cursor.json"), "{ not json");
    const corrupt = run(dir, `
      import { readCursor } from ${JSON.stringify(STREAM_URL)};
      const r = await readCursor();
      console.log(JSON.stringify({ status: r.status, since: r.since, hasError: Boolean(r.error) }));
    `);
    assert.equal(corrupt.status, "corrupt");
    assert.equal(corrupt.hasError, true, "a corrupt cursor must say WHY, not just fall back silently");
    assert.ok(Date.parse(corrupt.since) > 0, "corrupt must still yield a usable window");
  });
});

/* ── the route's contract ───────────────────────────────────────────────── */

test("validateSeenBody refuses anything that is not an observed timestamp", () => {
  assert.equal(validateSeenBody({ at: "2026-09-20T12:00:00.000Z" }), null);

  for (const bad of [undefined, null, "", 0, 1758374400000, {}, [], "not a date"]) {
    const v = validateSeenBody({ at: bad });
    assert.ok(v, `"at" of ${JSON.stringify(bad)} should have been refused`);
    assert.equal(v.code, 400);
    assert.match(v.error, /"at"/);
  }
  assert.ok(validateSeenBody({}), "a body with no `at` is a caller bug, not a default-to-now");
  assert.ok(validateSeenBody(null), "a null body must be refused rather than thrown on");
});

test("there is no default-to-now: the validator cannot be satisfied by an empty body", () => {
  // If this ever passes, someone added a fallback that stamps the clock --
  // which marks events seen that nobody rendered. That is advance-on-view
  // arriving through the back door.
  assert.notEqual(validateSeenBody({}), null);
  assert.notEqual(validateSeenBody({ at: "" }), null);
});
