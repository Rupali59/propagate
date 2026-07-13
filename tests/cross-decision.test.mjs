import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { processDecisions, __setCrossPathsForTest } from "../watcher.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { resolvePartner } from "../lib/cross-repo.mjs";

const NOW = Date.parse("2026-07-13T00:00:00Z");

test("decision trigger: seeds pre-cutoff, fires post-cutoff partner decisions, idempotent", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "xdec-"));
  const repo = path.join(parent, "Vipin Kaushik"); await mkdir(path.join(repo, "docs"), { recursive: true });
  await writeFile(path.join(repo, ".propagates-cross.yml"), "platform_contracts: []\n");
  await writeFile(path.join(repo, "docs", "DECISIONS.md"), `
## 2026-05-01: old partner decision (pre-cutoff)
Affects: Motherboard

## 2026-06-14 — GA4 IaC owned by Motherboard
Affects: workspace, Motherboard, Tathya

## 2026-06-20: intra-only decision
Affects: VipinKaushik, Astroclarity
`);
  const crossJsonl = path.join(parent, "PROPAGATION_CROSS_LEDGER.jsonl");
  __setCrossPathsForTest({ searchRoots: [parent], crossJsonl, crossMd: path.join(parent, "x.md") });

  const state = { mtimes: {}, crossDecisions: {}, lastRunAt: 0, version: 2 };
  const { events } = await processDecisions(state, NOW);
  // 2026-06-14 names Motherboard + Tathya → 2 rows. Pre-cutoff seeded (no fire).
  // Intra-only (VipinKaushik/Astroclarity name no partner) → skipped.
  assert.equal(events, 2, "post-cutoff partner decision fires one row per partner");
  const rows = await readLedger(crossJsonl);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.partner)), new Set(["Motherboard", "Tathya"]));
  assert.ok(rows.every((r) => r.flow === "decision" && r.direction === "outbound"));

  const seededKey = Object.keys(state.crossDecisions).find((k) => k.includes("2026-05-01"));
  assert.ok(seededKey, "pre-cutoff entry seeded as processed, not fired");

  const { events: e2 } = await processDecisions(state, NOW);
  assert.equal(e2, 0, "re-run: all processed, no re-fire (idempotent)");
});

test("resolvePartner does not false-positive on 'mb' substring (dropped alias)", () => {
  assert.equal(resolvePartner("number-crunching"), null);
  assert.equal(resolvePartner("VipinKaushik"), null, "the website is not the MB plugin");
  assert.equal(resolvePartner("VipinKaushik-mb"), "Motherboard");
});

test("decision trigger skips template/convention entries (title placeholder)", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "xtpl-"));
  const repo = path.join(parent, "Vipin Kaushik"); await mkdir(path.join(repo, "docs"), { recursive: true });
  await writeFile(path.join(repo, ".propagates-cross.yml"), "platform_contracts: []\n");
  await writeFile(path.join(repo, "docs", "DECISIONS.md"), `
## 2026-06-15: <title>
Affects: Motherboard
`);
  const crossJsonl = path.join(parent, "PROPAGATION_CROSS_LEDGER.jsonl");
  __setCrossPathsForTest({ searchRoots: [parent], crossJsonl, crossMd: path.join(parent, "x.md") });
  const state = { mtimes: {}, crossDecisions: {}, lastRunAt: 0, version: 2 };
  const { events } = await processDecisions(state, NOW);
  assert.equal(events, 0, "template entry with <title> is not relayed");
});
