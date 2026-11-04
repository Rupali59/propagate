/**
 * The edge-state vocabulary lives in lib/edges/states.mjs and nowhere else (#127 phase 1, #118).
 *
 * #118 happened because eight state strings were re-spelled in seven files, each with its own idea of
 * a deferred edge. This test derives every place outside states.mjs that COMPARES against a state
 * literal (`=== "X"`, `!== "X"`, `"X" ===`, `case "X"`) and fails on any that is not allowlisted.
 *
 * Derived, not curated (rule:derive-dont-curate): the population is the source tree, found by walking
 * it, with a FLOOR. The allowlist is the exemption list (forgetting an entry fails loudly), and every
 * entry must still match, so a stale exemption fails too. Comment lines are not code and are skipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { EDGE_STATES } from "../../lib/edges/states.mjs";

const ROOT = path.join(import.meta.dirname, "../..");
const SCAN_DIRS = ["lib", "cli", "hooks", "widget", "skills", "scripts"];
const SKIP = new Set(["node_modules", ".git", "vendor", "tests"]);
const VOCAB = "lib/edges/states.mjs";

// Rendering-only or rule-specific uses that are not the vocabulary. `needle` must appear on the line.
const ALLOWLIST = [
  { file: "lib/edges/disposition.mjs", needle: 'state === "DIVERGED" && disposition',
    why: "divergedGuard: the DIVERGED-only rule (only both-reconciled may resolve it) is a write-path rule, not a classification" },
  { file: "lib/edges/disposition.mjs", needle: 'state !== "DIVERGED")',
    why: "divergedGuard, the converse half of the same rule" },
  { file: "lib/edges/disposition.mjs", needle: 'row.state !== "DIVERGED") return base',
    why: "divergedRefusal: only a DIVERGED row gets the both-reconciled command appended" },
  { file: "lib/migrate/workspace.mjs", needle: 'r.state === "CLEAN"',
    why: "migration report: counts the CLEAN edges whose verification a rekey would lose; CLEAN-specific, not an action" },
  { file: "cli/status.mjs", needle: 's === "CLEAN"',
    why: "`verified` is the CLEAN count and `forced` is counted within it; DECOUPLED is `done` but not `verified`" },
  { file: "cli/ui.client.js", needle: 'd.state === "DIVERGED"',
    why: "chart datum routing in the browser (no import path): a DIVERGED bar opens the pick-a-side chip" },
  { file: "widget/propagate-queue.jsx", needle: "k === 'DIVERGED'",
    why: "Ubersicht widget (sandboxed, no import path): a DIVERGED legend row opens the pick-a-side chip" },
];

const STATES = EDGE_STATES.join("|");
const COMPARISON = new RegExp(
  `(?:[!=]==?\\s*["'\`](?:${STATES})["'\`])|(?:["'\`](?:${STATES})["'\`]\\s*[!=]==?)|(?:case\\s+["'\`](?:${STATES})["'\`])`,
);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|jsx)$/.test(e)) out.push(p);
  }
  return out;
}

function scan() {
  const files = [
    ...SCAN_DIRS.flatMap((d) => { try { return walk(path.join(ROOT, d)); } catch { return []; } }),
    path.join(ROOT, "cli.mjs"),
  ];
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (COMPARISON.test(line)) hits.push({ file: rel, line: i + 1, text: t });
    });
  }
  return { files, hits };
}

const { files, hits } = scan();

test("floor: the scan walked the tree and sees real comparisons, so zero outside hits is a result", () => {
  assert.ok(files.length >= 100, `only ${files.length} source files found: the scan has gone blind, it has not found nothing`);
  const inVocab = hits.filter((h) => h.file === VOCAB).length;
  assert.ok(inVocab >= EDGE_STATES.length - 1,
    `only ${inVocab} state comparisons found in ${VOCAB}: the pattern has gone blind (it must see actionOf's case labels)`);
});

test("no file outside states.mjs compares against a state literal, except the allowlisted ones", () => {
  const outside = hits.filter((h) => h.file !== VOCAB);
  const unlisted = outside.filter((h) => !ALLOWLIST.some((a) => a.file === h.file && h.text.includes(a.needle)));
  assert.deepEqual(unlisted.map((h) => `${h.file}:${h.line}: ${h.text}`), [],
    "a state literal compared outside lib/edges/states.mjs: use actionOf / ACTIONABLE / UNSETTLED, or allowlist it with a reason");
});

test("every allowlist entry still matches a real hit (a stale exemption is a hole)", () => {
  const stale = ALLOWLIST.filter((a) => !hits.some((h) => h.file === a.file && h.text.includes(a.needle)));
  assert.deepEqual(stale.map((a) => `${a.file}: ${a.needle}`), []);
});

test("derived: the allowlist size is stated, so growth is a visible edit", () => {
  assert.ok(ALLOWLIST.length <= 8, `allowlist grew to ${ALLOWLIST.length}: each new entry should be a deliberate decision`);
});
