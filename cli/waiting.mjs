/**
 * waiting.mjs — `propagate waiting [--json]` and `propagate waiting gate-pass <sha> --suite <text> [--apply]` (#411).
 *
 * `waiting` reads GitHub (gh pr/issue/repo, one call each per repo) and the kb reviews folder; it writes nothing.
 * `gate-pass` is the only write: one file `<state>/gates/<sha>.json`, behind --apply (dry run otherwise). It needs
 * evidence (#428): `--run <id>` (a test-queue run record that passed on a clean tree whose head contains the PR head;
 * the evidence is checked on a dry run too) or `--no-run-evidence "<why>"`.
 * Exit: 0 every source read (empty list included), 1 gate-pass evidence missing or refused, 2 a source could not be
 * read or the arguments are wrong.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTEGRATIONS } from "../lib/core/config.mjs";
import { stateDir } from "../lib/core/paths.mjs";
import { makeGh } from "../lib/broadcast/gh.mjs";
import { reviewsDir } from "../lib/kb/review/paths.mjs";
import { parseGithubRemote } from "../lib/tasks/plan.mjs";
import { collectWaiting, renderWaiting, validGateSha, writeGatePass } from "../lib/report/waiting.mjs";
import { checkRunEvidence, queueDir } from "../lib/report/test-queue.mjs";
import { hubRepoOf } from "./broadcast.mjs";

const USAGE = "waiting: usage: waiting [--json] | waiting gate-pass <full sha> --suite <summary> (--run <id> [--repo-dir <dir>] | --no-run-evidence <why>) [--apply] [--json]";
const VALUE_FLAGS = ["--suite", "--run", "--no-run-evidence", "--repo-dir"];
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function originOf(root) {
  const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? parseGithubRemote(r.stdout) : null;
}

/** The repos to read: this checkout's origin (propagate) and the hub's origin, both from remotes. Deduplicated. */
export function waitingRepos(inject = {}) {
  const found = [inject.propagateRepo === undefined ? originOf(PLUGIN_ROOT) : inject.propagateRepo, inject.hubRepo === undefined ? hubRepoOf() : inject.hubRepo];
  return [...new Set(found.filter(Boolean))];
}

/** The same collection `day open` prints; never throws. */
export function readWaiting(inject = {}) {
  try {
    const rv = inject.reviewsRoot !== undefined ? { ok: !!inject.reviewsRoot, dir: inject.reviewsRoot } : reviewsDir(inject.integrations ?? INTEGRATIONS);
    return collectWaiting({ gh: inject.gh ?? makeGh(), repos: inject.repos ?? waitingRepos(inject), reviewsRoot: rv.ok ? rv.dir : null, stateDirPath: inject.stateDirPath ?? stateDir(), queueDirPath: inject.queueDir !== undefined ? inject.queueDir : inject.stateDirPath ? null : queueDir(), now: inject.now });
  } catch (e) {
    return { rows: [], errors: [`waiting could not run (${e.message})`], sources: [] };
  }
}

/** `waiting gate-pass <full sha> --suite <summary> (--run <id> | --no-run-evidence <why>) [--apply]`: the one write, a dry run without --apply. */
function gatePass(argv, inject) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  const json = argv.includes("--json");
  const apply = argv.includes("--apply");
  const vals = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--apply") continue;
    if (VALUE_FLAGS.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--") || v === "") {
        err(USAGE);
        return 2;
      }
      vals[a] = v;
      i++;
    } else if (a.startsWith("--")) {
      err(USAGE);
      return 2;
    } else pos.push(a);
  }
  const suite = vals["--suite"];
  if (pos.length !== 1 || !suite) {
    err(USAGE);
    return 2;
  }
  if (!validGateSha(pos[0])) {
    err("waiting gate-pass: give the FULL commit sha of the PR head (40 hex characters): a pass is matched on the exact head, never a prefix");
    return 2;
  }
  const sha = pos[0];
  const runId = vals["--run"];
  const why = vals["--no-run-evidence"];
  if (runId === undefined && why === undefined) {
    err("waiting gate-pass: a pass needs evidence. Give --run <id> (a test-queue run record, see `test-queue report`) or --no-run-evidence \"<why there is no run>\"");
    return 1;
  }
  if (runId !== undefined && why !== undefined) {
    err("waiting gate-pass: give --run <id> or --no-run-evidence, not both: a pass either has a run behind it or says it has none");
    return 1;
  }
  let extra = { no_run_evidence: why };
  let evidence = `no run evidence: ${why}`;
  if (runId !== undefined) {
    const repoDir = path.resolve(vals["--repo-dir"] ?? inject.repoDir ?? process.cwd());
    const c = checkRunEvidence({ dir: inject.queueDir ?? queueDir(), runId, sha, repoDir });
    if (!c.ok) {
      err(`waiting gate-pass: run ${runId} does not back a pass on ${sha}:`);
      for (const r of c.reasons) err(`  - ${r}`);
      return 1;
    }
    const peak = c.run.cpu_busy?.peak;
    extra = { run_id: runId, run_tree: c.run.tree ?? null, cpu_peak: typeof peak === "number" ? peak : null };
    evidence = `run ${runId} (exit 0, clean tree, head ${String(c.run.head).slice(0, 7)} contains ${sha.slice(0, 7)}${typeof peak === "number" ? `, cpu peak ${Math.round(peak)}%` : ""})`;
  }
  const dir = inject.stateDirPath ?? stateDir();
  if (!apply) {
    out(json ? JSON.stringify({ applied: false, sha, suite, evidence: extra }) : `dry run: would record a gate pass for ${sha} (${suite}) on ${evidence}; add --apply`);
    return 0;
  }
  const file = writeGatePass(dir, sha, suite, inject.now, extra);
  out(json ? JSON.stringify({ applied: true, sha, suite, evidence: extra, file }) : `recorded gate pass for ${sha} on ${evidence}: ${file}`);
  return 0;
}

export async function waitingCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  const json = args.includes("--json");
  if (args[0] === "gate-pass") return gatePass(args.slice(1), inject);
  const bad = args.find((a) => a !== "--json");
  if (bad) {
    err(`${USAGE}\nwaiting: unknown argument ${bad}`);
    return 2;
  }
  const r = readWaiting(inject);
  if (json) out(JSON.stringify({ ...r, count: r.rows.length }, null, 2));
  else for (const line of renderWaiting(r)) out(line);
  if (r.errors.length) {
    for (const e of r.errors) err(`waiting: ${e}`);
    return 2;
  }
  return 0;
}
