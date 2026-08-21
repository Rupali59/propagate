/**
 * RED 4 (status-temporal-plum.md §1): the rendered PROPAGATION_LEDGER.md must
 * group rows under branch nodes, giving `source_worktree` its first reader
 * (docs/DATA_MODEL.md §7 — "3 rows written, NONE readers").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderMarkdown } from "../../lib/edges/ledger.mjs";

async function seedJsonl(rows) {
  const dir = await mkdtemp(path.join(tmpdir(), "ledrender-branches-"));
  const jsonl = path.join(dir, "PROPAGATION_LEDGER.jsonl");
  const md = path.join(dir, "PROPAGATION_LEDGER.md");
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(jsonl, body);
  return { jsonl, md };
}

test("rows with no source_worktree render under a default group", async () => {
  const { jsonl, md } = await seedJsonl([
    {
      type: "drift",
      id: "001",
      source: "lib/a.ts",
      change: "edit",
      downstream: [],
      status: "open",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
  ]);
  await renderMarkdown(jsonl, md);
  const content = await readFile(md, "utf8");
  assert.match(content, /## Default \(no branch stamp\)/);
  assert.doesNotMatch(content, /## Branch:/);
  assert.match(content, /\| 001 \|/);
});

test("rows with source_worktree render under a per-branch heading", async () => {
  const { jsonl, md } = await seedJsonl([
    {
      type: "drift",
      id: "001",
      source: "sub-project/lib/a.ts",
      change: "edit",
      downstream: [],
      status: "open",
      timestamp: "2026-01-01T00:00:00.000Z",
      source_worktree: { branch: "feature-x", commit: "abc1234" },
    },
    {
      type: "drift",
      id: "002",
      source: "lib/b.ts",
      change: "edit",
      downstream: [],
      status: "open",
      timestamp: "2026-01-02T00:00:00.000Z",
    },
  ]);
  await renderMarkdown(jsonl, md);
  const content = await readFile(md, "utf8");

  assert.match(content, /## Branch: `feature-x`/);
  assert.match(content, /## Default \(no branch stamp\)/);

  // Default group renders before branch groups (matches the "multiple
  // branches" ordering test below). Row 001 must appear under the branch
  // heading, row 002 under default.
  const defaultIdx = content.indexOf("## Default");
  const branchIdx = content.indexOf("## Branch: `feature-x`");
  assert.ok(defaultIdx < branchIdx, "default group renders before branch groups");

  const defaultSection = content.slice(defaultIdx, branchIdx);
  assert.match(defaultSection, /\| 002 \|/);
  assert.doesNotMatch(defaultSection, /\| 001 \|/);

  const branchSection = content.slice(branchIdx);
  assert.match(branchSection, /\| 001 \|/);
  assert.doesNotMatch(branchSection, /\| 002 \|/);
});

test("multiple branches render in alphabetical order after the default group", async () => {
  const { jsonl, md } = await seedJsonl([
    {
      type: "drift", id: "001", source: "z.ts", change: "e", downstream: [], status: "open",
      timestamp: "2026-01-01T00:00:00.000Z", source_worktree: { branch: "zeta", commit: "aaa" },
    },
    {
      type: "drift", id: "002", source: "a.ts", change: "e", downstream: [], status: "open",
      timestamp: "2026-01-02T00:00:00.000Z", source_worktree: { branch: "alpha", commit: "bbb" },
    },
    {
      type: "drift", id: "003", source: "d.ts", change: "e", downstream: [], status: "open",
      timestamp: "2026-01-03T00:00:00.000Z",
    },
  ]);
  await renderMarkdown(jsonl, md);
  const content = await readFile(md, "utf8");

  const defaultIdx = content.indexOf("## Default");
  const alphaIdx = content.indexOf("## Branch: `alpha`");
  const zetaIdx = content.indexOf("## Branch: `zeta`");
  assert.ok(defaultIdx >= 0 && alphaIdx >= 0 && zetaIdx >= 0);
  assert.ok(defaultIdx < alphaIdx, "default group renders before branch groups");
  assert.ok(alphaIdx < zetaIdx, "branch groups render alphabetically");
});

test("empty ledger still renders a table, no branch headings", async () => {
  const { jsonl, md } = await seedJsonl([]);
  await renderMarkdown(jsonl, md);
  const content = await readFile(md, "utf8");
  assert.match(content, /_no drift events yet_/);
  assert.doesNotMatch(content, /## Branch:/);
  assert.doesNotMatch(content, /## Default/);
});
