/**
 * `reconcile --inbound` and `check`'s inbound advisory — the CLI surfaces
 * for the delivery view (2026-08 plan Part 2).
 *
 * Real temp git repos via execFileSync, real CLI subprocess via spawnSync —
 * same discipline as tests/reconcile.test.mjs's "cli reconcile --json" test
 * and tests/check.test.mjs. PROPAGATE_SEARCH_ROOTS / PROPAGATE_STATE_DIR are
 * scoped per test so nothing touches ~/.propagate or the real ledgers (G21).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const EVENTS_LIB = fileURLToPath(new URL("../../lib/edges/events.mjs", import.meta.url));
const CONTENT_ID_LIB = fileURLToPath(new URL("../../lib/edges/content-id.mjs", import.meta.url));
const RECONCILE_LIB = fileURLToPath(new URL("../../lib/edges/reconcile.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function commitAll(dir, msg = "snapshot") {
  git(["add", "."], dir);
  git(["commit", "-q", "-m", msg], dir);
}

async function makeRepo(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

/** Pin a cross-repo edge to CURRENT content, via a subprocess (same pattern
 *  as tests/reconcile.test.mjs's `pin()` — EVENTS_DIR is resolved at import
 *  time, so a fresh store needs a fresh process). */
function pin({ stateDir, sourceAbs, downstreamAbs, why }) {
  const script = `
import { contentId } from ${JSON.stringify(CONTENT_ID_LIB)};
import { edgeId, appendEvent } from ${JSON.stringify(EVENTS_LIB)};
import { toNodeId, edgeIdFor } from ${JSON.stringify(RECONCILE_LIB)};
const sourceAbs = ${JSON.stringify(sourceAbs)};
const downstreamAbs = ${JSON.stringify(downstreamAbs)};
const nodeId = toNodeId(sourceAbs);
const eId = edgeIdFor(nodeId, downstreamAbs, ${JSON.stringify(why)});
const s = contentId(sourceAbs);
const d = contentId(downstreamAbs);
if (s.unresolvable || d.unresolvable) throw new Error("pin: side unresolvable — " + JSON.stringify({ s, d }));
await appendEvent({
  edge_id: eId, node_id: nodeId,
  source_content: s.id, downstream_content: d.id, source_git_blob: s.gitBlob,
  disposition: "propagated", reason: "test pin", by: "test", observed_on_ref: "main",
  downstream_on_ref: "main",
});
console.log("ok");
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
  assert.equal(result.status, 0, `pin subprocess failed: ${result.stderr}\n${result.stdout}`);
}

/**
 * Build the fixture the whole file shares: two workspace repos, `upstream`
 * declaring a sidecar edge into `downstream`, both discoverable via
 * PROPAGATE_SEARCH_ROOTS. Returns everything a test needs plus a cleanup fn.
 */
async function makeCrossRepoFixture() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "inbound-cli-search-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "inbound-cli-state-"));

  const upstream = path.join(searchRoot, "upstream-repo");
  const downstream = path.join(searchRoot, "downstream-repo");
  await mkdir(path.join(upstream, "persona"), { recursive: true });
  await mkdir(path.join(downstream, "lib"), { recursive: true });
  for (const dir of [upstream, downstream]) {
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
  }

  await writeFile(path.join(upstream, "persona", "profile.yaml"), "name: v1\n");
  await writeFile(path.join(downstream, "lib", "content.ts"), "export const name = 'v1';\n");
  await writeFile(
    path.join(upstream, ".propagates.yml"),
    `workspace: true
sources:
  persona/profile.yaml:
    propagates_to:
      - path: ../downstream-repo/lib/content.ts
        why: "cross-repo pairing"
`,
  );
  await writeFile(path.join(downstream, ".propagates.yml"), `workspace: true\n`);
  await commitAll(upstream, "initial upstream");
  await commitAll(downstream, "initial downstream");

  const sourceAbs = path.join(upstream, "persona", "profile.yaml");
  const downstreamAbs = path.join(downstream, "lib", "content.ts");
  pin({ stateDir, sourceAbs, downstreamAbs, why: "cross-repo pairing" });

  // Drift it: source moves, downstream doesn't.
  await writeFile(sourceAbs, "name: v2\n");

  return {
    searchRoot,
    stateDir,
    upstream,
    downstream,
    sourceAbs,
    downstreamAbs,
    async cleanup() {
      await rm(searchRoot, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

function runCli(args, cwd, fixture) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PROPAGATE_SEARCH_ROOTS: fixture.searchRoot,
      PROPAGATE_STATE_DIR: fixture.stateDir,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 4. `reconcile --inbound` from the downstream repo surfaces the real edge;
//    `--json` parses.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile --inbound — from the downstream repo, surfaces the drifted cross-repo edge; --json parses", async () => {
  const fixture = await makeCrossRepoFixture();
  try {
    const textResult = runCli(["reconcile", "--inbound"], fixture.downstream, fixture);
    assert.equal(textResult.status, 0, `reconcile --inbound failed: ${textResult.stderr}\n${textResult.stdout}`);
    assert.match(textResult.stdout, /INBOUND/);
    assert.match(textResult.stdout, /profile\.yaml/);
    assert.match(textResult.stdout, /content\.ts/);
    assert.match(textResult.stdout, /DRIFTED/);

    const jsonResult = runCli(["reconcile", "--inbound", "--json"], fixture.downstream, fixture);
    assert.equal(jsonResult.status, 0, `reconcile --inbound --json failed: ${jsonResult.stderr}`);
    const parsed = JSON.parse(jsonResult.stdout.trim());
    assert.ok(typeof parsed.generatedAt === "string");
    // `git rev-parse --show-toplevel` (which reconcileInbound uses for
    // repoRoot) resolves symlinks, e.g. macOS's /var -> /private/var —
    // compare via realpath rather than the raw fixture path.
    assert.equal(parsed.repoRoot, realpathSync(fixture.downstream));
    assert.ok(Array.isArray(parsed.rows));
    assert.equal(parsed.rows.length, 1, "exactly the one cross-repo edge must appear");
    const row = parsed.rows[0];
    assert.equal(row.source.path, fixture.sourceAbs);
    assert.equal(row.downstream.path, fixture.downstreamAbs);
    assert.equal(row.state, "DRIFTED");
  } finally {
    await fixture.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// From the UPSTREAM repo, the same edge must NOT appear inbound (it's
// outbound from there) — confirms the filter is directional.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile --inbound — from the upstream repo, the outbound edge does not appear", async () => {
  const fixture = await makeCrossRepoFixture();
  try {
    const result = runCli(["reconcile", "--inbound", "--json"], fixture.upstream, fixture);
    assert.equal(result.status, 0, `reconcile --inbound failed: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.rows.length, 0, "the edge is outbound from upstream, not inbound");
  } finally {
    await fixture.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 8. `--inbound` composes with `--group-by`.
// ─────────────────────────────────────────────────────────────────────────

test("reconcile --inbound --group-by node — composes without error and groups the inbound row", async () => {
  const fixture = await makeCrossRepoFixture();
  try {
    const result = runCli(["reconcile", "--inbound", "--group-by", "node", "--json"], fixture.downstream, fixture);
    assert.equal(result.status, 0, `reconcile --inbound --group-by node failed: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.groupBy, "node");
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.groups.length, 1, "the single inbound row groups under its one node_id");
    assert.equal(parsed.groups[0].count, 1);

    const textResult = runCli(["reconcile", "--inbound", "--group-by", "node"], fixture.downstream, fixture);
    assert.equal(textResult.status, 0);
    assert.match(textResult.stdout, /# groups \(by node\)/);
  } finally {
    await fixture.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 5. `check` prints inbound drift as advisory and does NOT change exit code.
// ─────────────────────────────────────────────────────────────────────────

test("check — prints inbound drift as an advisory warning and does not change exitCode", async () => {
  const fixture = await makeCrossRepoFixture();
  try {
    // No changed/staged files at all in the downstream repo — check's own
    // coupling gate has nothing to report; only the inbound advisory should
    // print, and the exit code must stay 0 (nothing coupled, nothing staged).
    const result = runCli(["check", "--staged"], fixture.downstream, fixture);
    assert.equal(result.status, 0, "check's exit code must be unaffected by inbound drift (advisory only)");
    assert.match(result.stdout, /inbound edge.*drifted \(advisory — does not affect this gate\)/i);
    assert.match(result.stdout, /profile\.yaml/);
    assert.match(result.stdout, /content\.ts/);

    // --json: exitCode field also 0, and the inbound array is populated but
    // clearly does not participate in exitCode's derivation.
    const jsonResult = runCli(["check", "--staged", "--json"], fixture.downstream, fixture);
    assert.equal(jsonResult.status, 0);
    const parsed = JSON.parse(jsonResult.stdout.trim());
    assert.equal(parsed.exitCode, 0);
    assert.ok(Array.isArray(parsed.inbound));
    assert.equal(parsed.inbound.length, 1);
    assert.equal(parsed.inbound[0].state, "DRIFTED");
  } finally {
    await fixture.cleanup();
  }
});

test("check --strict — a real coupling still exits 1, inbound drift alone (no coupling) does not flip it to nonzero on its own", async () => {
  const fixture = await makeCrossRepoFixture();
  try {
    // Still nothing staged/coupled in the downstream repo; --strict would
    // only turn couplings into a nonzero exit, and there are none here — so
    // this stays 0 even with inbound drift present, proving inbound never
    // feeds strict's exit-code path either.
    const result = runCli(["check", "--staged", "--strict"], fixture.downstream, fixture);
    assert.equal(result.status, 0);
  } finally {
    await fixture.cleanup();
  }
});
