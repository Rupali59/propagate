/**
 * waiting.mjs — `propagate waiting [--json]` and `propagate waiting gate-pass <sha> --suite <text> [--apply]` (#411).
 *
 * `waiting` reads GitHub (gh pr/issue/repo, one call each per repo) and the kb reviews folder; it writes nothing.
 * `gate-pass` is the only write: one file `<state>/gates/<sha>.json`, behind --apply (dry run otherwise).
 * Exit: 0 every source read (empty list included), 2 a source could not be read or the arguments are wrong.
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
import { hubRepoOf } from "./broadcast.mjs";

const USAGE = "waiting: usage: waiting [--json] | waiting gate-pass <full sha> --suite <summary> [--apply] [--json]";
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
    return collectWaiting({ gh: inject.gh ?? makeGh(), repos: inject.repos ?? waitingRepos(inject), reviewsRoot: rv.ok ? rv.dir : null, stateDirPath: inject.stateDirPath ?? stateDir() });
  } catch (e) {
    return { rows: [], errors: [`waiting could not run (${e.message})`], sources: [] };
  }
}

/** `waiting gate-pass <full sha> --suite <summary> [--apply]`: the one write, a dry run without --apply. */
function gatePass(argv, inject) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json" && a !== "--apply");
  const apply = argv.includes("--apply");
  const si = rest.indexOf("--suite");
  const suite = si >= 0 ? rest[si + 1] : undefined;
  const pos = rest.filter((a, i) => a !== "--suite" && i !== si + 1);
  if (pos.length !== 1 || !suite || suite.startsWith("--") || rest.some((a) => a.startsWith("--") && a !== "--suite")) {
    err(USAGE);
    return 2;
  }
  if (!validGateSha(pos[0])) {
    err("waiting gate-pass: give the FULL commit sha of the PR head (40 hex characters): a pass is matched on the exact head, never a prefix");
    return 2;
  }
  const dir = inject.stateDirPath ?? stateDir();
  if (!apply) {
    out(json ? JSON.stringify({ applied: false, sha: pos[0], suite }) : `dry run: would record a gate pass for ${pos[0]} (${suite}); add --apply`);
    return 0;
  }
  const file = writeGatePass(dir, pos[0], suite, inject.now);
  out(json ? JSON.stringify({ applied: true, sha: pos[0], suite, file }) : `recorded gate pass for ${pos[0]}: ${file}`);
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
