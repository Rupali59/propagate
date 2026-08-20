/**
 * Regression tests for the staleness-banner freeze (F2).
 *
 * The MD header carries a time-derived tripwire ("Last entry: N days ago").
 * The watcher used to skip re-rendering unless that workspace produced new
 * events, so a ledger that went silent froze its banner at whatever it last
 * said — a ledger dead for weeks kept reporting "Watcher healthy" (that wording was
 * removed 2026-08-18 when the v1 watcher it named had been retired for four days).
 * The alarm
 * was only updatable by the thing it was meant to detect.
 *
 * Fix: render on every fire, and make renderMarkdown itself idempotent so it
 * does not tick mtime (and re-trigger launchd via WatchPaths — the B0 loop)
 * when nothing actually changed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderMarkdown } from "../../lib/edges/ledger.mjs";

const DAY = 24 * 60 * 60 * 1000;

async function seed(daysOld) {
  const dir = await mkdtemp(path.join(tmpdir(), "ledrender-"));
  const jsonl = path.join(dir, "PROPAGATION_LEDGER.jsonl");
  const md = path.join(dir, "PROPAGATION_LEDGER.md");
  const ts = new Date(Date.now() - daysOld * DAY).toISOString();
  await writeFile(
    jsonl,
    JSON.stringify({
      type: "drift",
      id: "001",
      source: "CLAUDE.md",
      change: "seed row",
      downstream: [{ path: "x.md", why: "test", kind: "prose" }],
      status: "open",
      timestamp: ts,
    }) + "\n",
  );
  return { jsonl, md };
}

test("second render of unchanged content does not rewrite the file (B0 loop safety)", async () => {
  const { jsonl, md } = await seed(0);

  const wroteFirst = await renderMarkdown(jsonl, md);
  assert.equal(wroteFirst, true, "first render must create the file");
  const firstContent = await readFile(md, "utf8");

  const wroteSecond = await renderMarkdown(jsonl, md);
  assert.equal(
    wroteSecond,
    false,
    "unchanged body must not rewrite — rewriting ticks mtime and re-triggers launchd",
  );
  assert.equal(
    await readFile(md, "utf8"),
    firstContent,
    "file must be byte-identical, including the generated-at footer",
  );
});

test("a stale ledger re-renders its banner even with no new events (F2)", async () => {
  const { jsonl, md } = await seed(45);

  await renderMarkdown(jsonl, md);
  const content = await readFile(md, "utf8");

  assert.match(
    content,
    /Last entry: 45 days ago/,
    "banner must reflect real age",
  );
  assert.match(content, /⚠️/, "over-30d must trip the warning");
  assert.match(
    content,
    /propagate doctor/,
    "the warning must name the command that diagnoses it",
  );
  // The v1 watcher was retired 2026-08-14; the renderer advertised it anyway, and
  // `doctor` could not see the contradiction because this text is generated. A stale
  // ledger is still worth flagging — it just is not evidence about a watcher.
  assert.doesNotMatch(
    content,
    /Watcher/i,
    "the rendered ledger must not name the retired v1 watcher",
  );
});

test("banner updates when age crosses a boundary, without new ledger rows", async () => {
  // The exact freeze scenario: same JSONL, no new events, only time passing.
  const { jsonl, md } = await seed(0);
  await renderMarkdown(jsonl, md);
  assert.match(await readFile(md, "utf8"), /Last entry: today/);

  // Rewrite the same single row as if it had aged 31 days. No new events.
  const aged = JSON.parse((await readFile(jsonl, "utf8")).trim());
  aged.timestamp = new Date(Date.now() - 31 * DAY).toISOString();
  await writeFile(jsonl, JSON.stringify(aged) + "\n");

  const wrote = await renderMarkdown(jsonl, md);
  assert.equal(wrote, true, "a changed banner must be written through");
  const staleContent = await readFile(md, "utf8");
  assert.match(
    staleContent,
    /⚠️.*31 days ago/s,
    "banner must go stale on its own — this is the bug that let a dead ledger claim health",
  );
  assert.doesNotMatch(staleContent, /Watcher/i, "must not name the retired v1 watcher");
});

test("render recreates a deleted MD file", async () => {
  const { jsonl, md } = await seed(0);
  const wrote = await renderMarkdown(jsonl, md);
  assert.equal(wrote, true);
  assert.match(await readFile(md, "utf8"), /Propagation Ledger/);
});
