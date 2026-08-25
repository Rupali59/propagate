/**
 * `doctor` — "at most one live ledger file per workspace".
 *
 * Part of the propagation/ layout plan (~/.claude/plans/status-temporal-plum.md
 * §1, §3a): a half-finished migration to `propagation/` — a `git mv` that
 * moved the .jsonl but not the .md, or that ran before discovery knew about
 * the layout — can leave a workspace with a live ledger at TWO candidate
 * paths at once. Discovery silently pins to one and the other goes unowned.
 * This check must FAIL loudly, naming both paths, rather than let doctor
 * stay green on a split brain.
 *
 * RED first: written against `liveLedgerCandidates` (lib/core/discovery.mjs)
 * and the doctor check that consumes it (cli.mjs, "at most one live ledger
 * file per workspace").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function driftLine(id) {
  return JSON.stringify({
    type: "drift",
    id,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    source: `${id}.md`,
    change: `drift on ${id}`,
    status: "open",
  });
}

async function seedEventStore(stateDir) {
  const eventsDir = path.join(stateDir, "events");
  await mkdir(eventsDir, { recursive: true });
  const shard = new Date().toISOString().slice(0, 7) + ".jsonl";
  await writeFile(
    path.join(eventsDir, shard),
    JSON.stringify({
      event_id: "01FIXTURE0000000000000001",
      edge_id: "fixture-edge",
      node_id: "fixture-node",
      disposition: "verified",
      source_content: "abc123",
      downstream_content: "def456",
      ts: new Date().toISOString(),
      hash_alg: "sha256",
    }) + "\n",
    "utf8",
  );
}

function runDoctor(root, stateDir = root) {
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: stateDir },
  });
}

test("doctor FAILS when a workspace has live ledger files at more than one candidate path, naming both", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "doctor-multi-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const ws = path.join(root, "ws");
  await writeFile(await mkdir(ws, { recursive: true }).then(() => path.join(ws, ".propagates.yml")), "workspace: true\nsources: {}\n", "utf8");

  // The docs/-pinned ledger discovery will resolve TO (checked after
  // propagation/ in the cascade, but propagation/ is the one with a file).
  const docsDir = path.join(ws, "docs");
  await mkdir(docsDir, { recursive: true });
  const docsJsonl = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
  await writeFile(docsJsonl, driftLine("001") + "\n", "utf8");
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.md"), "# Propagation Ledger\n", "utf8");

  // A phantom second live ledger at propagation/ — half-finished migration.
  const propagationDir = path.join(ws, "propagation");
  await mkdir(propagationDir, { recursive: true });
  const propagationJsonl = path.join(propagationDir, "ledger.jsonl");
  await writeFile(propagationJsonl, driftLine("001") + "\n", "utf8");
  await writeFile(path.join(propagationDir, "ledger.md"), "# Propagation Ledger\n", "utf8");

  await seedEventStore(root);

  const result = runDoctor(root);
  const out = result.stdout + result.stderr;

  assert.notEqual(result.status, 0, "doctor must exit non-zero when a workspace has two live ledger files");
  assert.match(out, /at most one live ledger file per workspace/i);
  assert.match(
    out,
    new RegExp(docsJsonl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "output names the docs/ candidate",
  );
  assert.match(
    out,
    new RegExp(propagationJsonl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "output names the propagation/ candidate",
  );
});

test("doctor PASSES the multi-ledger check when only one live ledger file exists", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "doctor-multi-ledger-clean-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const ws = path.join(root, "ws");
  await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");

  const docsDir = path.join(ws, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.jsonl"), driftLine("001") + "\n", "utf8");
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.md"), "# Propagation Ledger\n", "utf8");

  await seedEventStore(root);

  const result = runDoctor(root);
  const out = result.stdout + result.stderr;

  assert.match(out, /at most one live ledger file per workspace/i);
  assert.doesNotMatch(
    out,
    /✗[^\n]*at most one live ledger file per workspace/i,
    "single-ledger workspace must not trip this check",
  );
});
