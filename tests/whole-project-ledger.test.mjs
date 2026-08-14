/**
 * The whole-project ledger view must be complete, and must say so when it is not.
 *
 * Measured 2026-08-15 against the real tree: 11 ledgers, 1922 rows, 798 ids,
 * 8 genuinely open — and `status --all` reported 4. Half the open work was
 * invisible and nothing said so, which is the failure mode this skill exists to
 * catch, occurring in its own tooling (docs/GOTCHAS.md G1, rule:discernment-checks §2).
 *
 * Two independent causes, both reproduced here as fixtures:
 *   1. PROPAGATION_CROSS_LEDGER is read by `status --cross` and by digest.mjs,
 *      but never by `status --all`.
 *   2. A ledger can exist at a path no workspace owns — below DEFAULT_MAX_DEPTH,
 *      or beside a sidecar that never opted in with `workspace: true`. Discovery
 *      cannot see it, so it contributed 0 to every total.
 *
 * The third test guards the counting method itself. The ledger is append-only,
 * so a row closed later KEEPS its original `open` line. Counting lines instead of
 * folding by last-status-per-id reported 501 open where the truth was 8 — a 62x
 * error that has already been published once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = path.join(SKILL_DIR, "cli.mjs");

/** Strip ANSI so assertions match the text, not the colour codes around it.
 * `✗ label` is really `\x1B[31m✗\x1B[0m label` on a TTY-less pipe too. */
const plain = (s) => s.replace(/\x1B\[[0-9;]*m/g, "");

function run(root, args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: root,
    encoding: "utf8",
    // G10: PROPAGATE_STATE_DIR must move with PROPAGATE_SEARCH_ROOTS, or the
    // test writes metrics into the production state dir.
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: root },
  });
}

const row = (o) => JSON.stringify({ timestamp: "2026-08-15T00:00:00.000Z", ...o }) + "\n";

/** A workspace with `open` rows, plus a second ledger that no workspace owns. */
async function makeTreeWithUnownedLedger() {
  const root = await mkdtemp(path.join(tmpdir(), "wholeledger-"));

  const ws = path.join(root, "workspace-a");
  await mkdir(path.join(ws, "docs"), { recursive: true });
  await writeFile(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  await writeFile(
    path.join(ws, "docs", "PROPAGATION_LEDGER.jsonl"),
    row({ id: 1, type: "drift", status: "open", source: "a.md", downstream: [] }),
    "utf8",
  );

  // Unowned: nested deeper than DEFAULT_MAX_DEPTH, and its sidecar never opts in
  // with `workspace: true` — exactly the real
  // PanditPawanKaushik/.claude/worktrees/client-answers-propagation case.
  const orphan = path.join(ws, ".claude", "worktrees", "feature-x");
  await mkdir(path.join(orphan, "docs"), { recursive: true });
  await writeFile(path.join(orphan, ".propagates.yml"), "sources: {}\n", "utf8");
  await writeFile(
    path.join(orphan, "docs", "PROPAGATION_LEDGER.jsonl"),
    row({ id: 39, type: "drift", status: "open", source: "ROUTE_TAXONOMY.md", downstream: [] }),
    "utf8",
  );

  return { root, orphanLedger: path.join(orphan, "docs", "PROPAGATION_LEDGER.jsonl") };
}

test("doctor check `no unowned ledger files` fails when a ledger has no owner", async () => {
  const { root } = await makeTreeWithUnownedLedger();
  const res = run(root, ["doctor"]);
  const out = plain(res.stdout + res.stderr);

  // The literal check label, so tests/doctor-check-coverage.test.mjs can see this
  // check is covered — and asserted as FAILING (✗), not merely present.
  assert.match(
    out,
    /✗\s*no unowned ledger files/,
    `the "no unowned ledger files" check must FAIL here, not pass or be absent:\n${out}`,
  );
  // Attributability: silence is indistinguishable from "no such ledger", which
  // is the bug. It must name the file and its open count.
  assert.match(out, /worktrees/, `doctor must name the offending path:\n${out}`);
  assert.match(out, /1 open/, `doctor must state how many rows are stranded:\n${out}`);
});

test("doctor check `no unowned ledger files` passes when every ledger is owned", async () => {
  // The other half of the ratchet: a check that always fails is as useless as one
  // that never does. Same tree, minus the orphan.
  const root = await mkdtemp(path.join(tmpdir(), "wholeledger-clean-"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  await writeFile(
    path.join(root, "docs", "PROPAGATION_LEDGER.jsonl"),
    row({ id: 1, type: "drift", status: "open", source: "a.md", downstream: [] }),
    "utf8",
  );
  const out = plain(run(root, ["doctor"]).stdout);
  assert.doesNotMatch(
    out,
    /✗\s*no unowned ledger files/,
    `check must pass when the only ledger is owned:\n${out}`,
  );
});

test("status --all counts every open row, including ledgers discovery cannot reach", async () => {
  const { root } = await makeTreeWithUnownedLedger();
  const res = run(root, ["status", "--all"]);
  const out = plain(res.stdout + res.stderr);

  // 2 open exist on disk (workspace-a #1, orphan #39). Before the fix the
  // orphan is invisible and nothing mentions it at all.
  assert.match(
    out,
    /unowned|owned by no workspace|no workspace owns|not reachable/i,
    `status --all must disclose the ledger it could not read:\n${out}`,
  );
});

test("open counts are folded by last status per id, never counted as raw lines", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wholeledger-fold-"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");

  // Append-only shape: one id opened then closed, one id still open.
  // Raw `open` lines = 2. Folded open = 1. The whole 501-vs-8 error in one fixture.
  await writeFile(
    path.join(root, "docs", "PROPAGATION_LEDGER.jsonl"),
    row({ id: 1, type: "drift", status: "open", source: "a.md", downstream: [] }) +
      row({ id: 2, type: "drift", status: "open", source: "b.md", downstream: [] }) +
      row({ id: 1, type: "status_change", status: "done" }),
    "utf8",
  );

  const res = run(root, ["status", "--all", "--json"]);
  const parsed = JSON.parse(res.stdout);
  const totalOpen = (parsed.workspaces || []).reduce((n, w) => n + (w.counts?.open ?? 0), 0);

  assert.equal(
    totalOpen,
    1,
    `folded open must be 1 (id 2); counting raw \`open\` lines would give 2. Got ${totalOpen}`,
  );
});
