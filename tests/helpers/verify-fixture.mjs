/**
 * verify-fixture.mjs — the A -> B -> C chain, and the store snapshot.
 *
 * Extracted from tests/cli/verify-ordering.test.mjs on 2026-09-26 when the
 * N69/N70 flag tests needed the same fixture. Copying it would have made two
 * forks of one traversal, and this particular fixture carries a comment that
 * IS an assertion -- "editing B as well would make A->B DIVERGED, so the
 * ordering guard would never be reached and these tests would pass for a
 * completely unrelated reason. That mistake cost three red tests on first run."
 * A second copy is a second chance to lose that.
 *
 * `storeSnapshot` is the load-bearing helper: it reads every byte of the event
 * store, so "unchanged" means unchanged rather than "the message said dry run".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function runCli(argv, { searchRoot, stateDir }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
}

/** Every byte of the event store, so "unchanged" means unchanged. */
export function storeSnapshot(stateDir) {
  const dir = path.join(stateDir, "events");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("");
}

/**
 * A -> B -> C, all in one repo, all three files coupled in a chain. Committing
 * then editing A and B leaves both edges unsettled, which is the shape the
 * guard exists for: verifying B->C while A->B is still dirty.
 */
export async function makeChain() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "verify-order-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "verify-order-state-"));
  const ws = path.join(searchRoot, "ws");
  await mkdir(ws, { recursive: true });
  git(["init", "-q", "-b", "main"], ws);
  git(["config", "user.email", "t@example.com"], ws);
  git(["config", "user.name", "T"], ws);

  await writeFile(path.join(ws, "A.md"), "A v1\n");
  await writeFile(path.join(ws, "B.md"), "B v1\n");
  await writeFile(path.join(ws, "C.md"), "C v1\n");
  await writeFile(
    path.join(ws, ".propagates.yml"),
    [
      "workspace: true",
      "sources:",
      "  A.md:",
      "    propagates_to:",
      "      - path: B.md",
      "        why: A feeds B",
      "        kind: prose",
      "  B.md:",
      "    propagates_to:",
      "      - path: C.md",
      "        why: B feeds C",
      "        kind: prose",
      "",
    ].join("\n"),
  );
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "init"], ws);

  const env = { searchRoot, stateDir };

  // Baseline both edges so they start CLEAN rather than NEVER_VERIFIED —
  // otherwise every edge is unsettled and the guard fires trivially, which
  // would make these tests pass for the wrong reason.
  const before = JSON.parse(runCli(["reconcile", "--all", "--json"], env).stdout);
  for (const row of before.rows) {
    runCli(
      ["verify", "--edge", row.edge_id, "--disposition", "baselined", "--reason", "test baseline", "--apply", "--json"],
      env,
    );
  }

  // Move ONLY A. That makes A->B DRIFTED (source moved, downstream did not)
  // and leaves B->C CLEAN.
  //
  // Editing B as well would make A->B DIVERGED, and `divergedGuard` refuses
  // every disposition except both-reconciled on a DIVERGED edge — so the
  // ordering guard would never be reached and these tests would pass or fail
  // for a completely unrelated reason. That mistake cost three red tests on
  // first run; the fixture is the assertion here.
  //
  // B->C being CLEAN is deliberate and is the sharper case: the guard must
  // fire on it anyway, because its SOURCE (B) is the downstream of a DRIFTED
  // edge. A "clean" edge whose source is about to move is exactly the false
  // CLEAN this guard exists to prevent.
  await writeFile(path.join(ws, "A.md"), "A v2\n");

  const after = JSON.parse(runCli(["reconcile", "--all", "--json"], env).stdout);
  const edgeAB = after.rows.find((r) => r.source.path.endsWith("A.md"));
  const edgeBC = after.rows.find((r) => r.source.path.endsWith("B.md"));
  return { env, ws, searchRoot, stateDir, edgeAB, edgeBC };
}

export const cleanup = async (...dirs) => {
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
};

