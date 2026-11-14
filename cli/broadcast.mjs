/**
 * `propagate broadcast new|status` (phase 1 of propagate#267, "Record").
 *
 * WITHOUT --apply `broadcast new` WRITES NOTHING: the only gh calls are reads (`repo view`, `issue list`). Every write
 * is in lib/broadcast/new.mjs `applyBroadcast`, which this file reaches only behind --apply.
 *
 * EXIT CODES. new: 0 planned or applied clean; 1 apply finished with a problem (a held child, a failed link, a child
 * missing from the read-back); 2 usage error, nothing to broadcast, or GitHub could not be read. status: 0 read;
 * 2 could not read GitHub (never 0).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { HUB_ROOT } from "../lib/core/config.mjs";
import { stateDir } from "../lib/core/paths.mjs";
import { parseGithubRemote } from "../lib/tasks/plan.mjs";
import { applyBroadcast, planBroadcast } from "../lib/broadcast/new.mjs";
import { childGoal, childTitle, groomingBody, groupItemFields } from "../lib/broadcast/model.mjs";
import { readStatus, renderStatus } from "../lib/broadcast/status.mjs";

const USAGE_NEW = "usage: propagate broadcast new --title <t> --goal G<n> (--from goals-check | --to <owner/repo>[,...] --body-file <f>) [--hub <owner/repo>] [--apply] [--json]";
const USAGE_STATUS = "usage: propagate broadcast status [<hub-issue#>] [--hub <owner/repo>] [--json]";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return { present: false };
  const v = argv[i + 1];
  return !v || v.startsWith("--") ? { present: true, missing: true } : { present: true, value: v };
}

/** The workspace repo of the hub root, from its origin remote. null when it cannot be derived. */
export function hubRepoOf(root = HUB_ROOT) {
  if (!root) return null;
  const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? parseGithubRemote(r.stdout) : null;
}

/** Run `goals check --json` and return its parsed output. Injectable. */
async function defaultGoalsCheck() {
  const { checkCmd } = await import("./goals.mjs");
  const lines = [];
  const errs = [];
  const code = await checkCmd(["--json"], { out: (s) => lines.push(s), err: (s) => errs.push(s) });
  return { code, stdout: lines.join("\n"), stderr: errs.join("\n") };
}

/**
 * @param {string[]} argv everything after `broadcast`
 * @param {object} [inject] tests: gh, hub, stateDirPath, goalsCheck, readBody, now, io
 */
export async function broadcastCmd(argv = [], inject = {}) {
  const io = inject.io ?? console;
  const sub = argv[0];
  if (sub === "new") return newCmd(argv.slice(1), inject, io);
  if (sub === "status") return statusCmd(argv.slice(1), inject, io);
  io.error(`broadcast: ${sub ? `unknown subcommand "${sub}"` : "missing subcommand"}`);
  io.error(USAGE_NEW);
  io.error(USAGE_STATUS);
  return 2;
}

async function newCmd(rest, inject, io) {
  const fail = (m) => {
    io.error(`broadcast new: ${m}`);
    io.error(USAGE_NEW);
    return 2;
  };
  const known = new Set(["--title", "--goal", "--from", "--to", "--body-file", "--hub", "--apply", "--json"]);
  const valued = new Set(["--title", "--goal", "--from", "--to", "--body-file", "--hub"]);
  for (let i = 0; i < rest.length; i++) {
    if (!known.has(rest[i])) return fail(`unknown argument ${rest[i]}`);
    if (valued.has(rest[i])) i++;
  }
  const get = (n) => flagValue(rest, n);
  for (const n of valued) if (get(n).missing) return fail(`${n} needs a value`);
  const title = get("--title").value;
  const goal = get("--goal").value;
  if (!title) return fail("--title is required");
  if (!goal || !/^G\d+$/.test(goal)) return fail("--goal G<n> is required, for example G3");
  const from = get("--from").value;
  const to = get("--to").value;
  const bodyFile = get("--body-file").value;
  if (from && to) return fail("--from and --to are alternatives, not a pair");
  if (!from && !to) return fail("name the population: --from goals-check or --to <owner/repo>[,...]");
  if (from && from !== "goals-check") return fail(`--from ${from} is not a source (only goals-check)`);
  if (to && !bodyFile) return fail("--to needs --body-file <f>: the body each child carries");
  if (from && bodyFile) return fail("--body-file belongs to --to; --from goals-check writes its own body");
  const apply = rest.includes("--apply");
  const asJson = rest.includes("--json");

  const hub = get("--hub").value ?? inject.hub ?? hubRepoOf();
  if (!hub || !REPO_RE.test(hub)) return fail("could not resolve the hub repo from the hub root's origin; pass --hub <owner/repo>");

  let children;
  if (from) {
    const gc = await (inject.goalsCheck ?? defaultGoalsCheck)();
    if (gc.code === 2) {
      io.error(`broadcast new: goals check could not run: ${String(gc.stderr || "").trim().split("\n")[0] || "exit 2"}`);
      return 2;
    }
    let parsed;
    try {
      parsed = JSON.parse(gc.stdout);
    } catch {
      io.error("broadcast new: goals check --json output was not JSON, so nothing is broadcast");
      return 2;
    }
    const { groups, unparsed } = groupItemFields(parsed.violations);
    for (const u of unparsed) io.error(`broadcast new: item-fields subject not owner/repo#n, skipped: ${u}`);
    if (groups.size === 0) {
      io.error("broadcast new: nothing to broadcast: goals check reports no item-fields violation");
      return 2;
    }
    // Each child serves the goal its items carry (the dispatch snapshot), falling back to --goal.
    let snap = inject.snapshotItems;
    if (snap === undefined) {
      try {
        snap = JSON.parse(readFileSync(`${stateDir()}/day/items.json`, "utf8")).items ?? {};
      } catch {
        snap = {};
        io.error("broadcast new: no dispatch snapshot (run propagate day open); every child takes --goal");
      }
    }
    children = [...groups].map(([repo, items]) => {
      const g = childGoal(repo, items, snap, goal);
      return { repo, goal: g, title: childTitle(title, repo), body: groomingBody({ parentTitle: title, goal: g, repo, items }) };
    });
  } else {
    const repos = to.split(",").map((r) => r.trim()).filter(Boolean);
    const bad = repos.find((r) => !REPO_RE.test(r));
    if (!repos.length || bad) return fail(`--to needs owner/repo values${bad ? `; "${bad}" is not one` : ""}`);
    let body;
    try {
      body = (inject.readBody ?? ((f) => readFileSync(f, "utf8")))(bodyFile);
    } catch (e) {
      return fail(`--body-file unreadable: ${e.message}`);
    }
    children = [...new Set(repos)].map((repo) => ({ repo, title: childTitle(title, repo), body }));
  }

  const plan = planBroadcast({ title, goal, hub, children, stateDirPath: inject.stateDirPath ?? stateDir(), gh: inject.gh });
  if (!plan.ok) {
    io.error(`broadcast new: ${plan.error}`);
    return 2;
  }

  if (!apply) {
    if (asJson) io.log(JSON.stringify({ mode: "dry-run", ...plan }, null, 2));
    else renderPlan(plan, io);
    return 0;
  }
  const res = applyBroadcast(plan, { gh: inject.gh });
  if (asJson) io.log(JSON.stringify({ mode: "apply", ...res }, null, 2));
  else renderApply(res, io);
  return res.ok ? 0 : 1;
}

function renderPlan(plan, io) {
  io.log("broadcast new: DRY RUN (nothing is created; gh is used for reads only). Add --apply to write.");
  const p = plan.parent;
  io.log(`\nparent in ${p.repo}: ${p.title}  labels=${p.labels.join(",")}  ${p.existing ? `REUSE #${p.existing.number}` : "create"}${p.held ? `  HELD ${p.held}` : ""}`);
  for (const l of p.body.split("\n")) io.log(`    ${l}`);
  for (const c of plan.children) {
    io.log(`\nchild in ${c.repo}: ${c.title}  ${c.existing ? `REUSE #${c.existing.number}` : "create"}${c.held ? `  HELD ${c.held}` : ""}`);
    io.log(`    board fields: Goal=${c.goal ?? plan.goal} Priority=P1 Model=${c.model}  (only if the repo has exactly one open board)`);
    for (const l of c.body.split("\n")) io.log(`    ${l}`);
  }
}

function renderApply(res, io) {
  if (res.parent) io.log(`parent ${res.parent.created ? "created" : "reused"}: ${res.parent.url}`);
  for (const c of res.children) {
    io.log(`child ${c.repo}: ${c.held ? `HELD ${c.held}` : `${c.created ? "created" : "reused"} ${c.url ?? "(no url)"}${c.linked ? ", linked" : ", NOT linked"}${c.board ? `, board ${c.board.status}: ${c.board.note}` : ""}`}`);
  }
  for (const p of res.problems) io.error(`problem: ${p}`);
  io.log(res.ok ? "applied and read back: every child is in the parent's sub-issues" : `${res.problems.length} problem(s); see above`);
}

function statusCmd(rest, inject, io) {
  const valued = new Set(["--hub"]);
  let number = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") continue;
    if (valued.has(a)) {
      if (!rest[i + 1] || rest[i + 1].startsWith("--")) {
        io.error(`broadcast status: ${a} needs a value`);
        return 2;
      }
      i++;
      continue;
    }
    if (/^\d+$/.test(a) && number === null) number = Number(a);
    else {
      io.error(`broadcast status: unexpected argument ${a}`);
      io.error(USAGE_STATUS);
      return 2;
    }
  }
  const hub = flagValue(rest, "--hub").value ?? inject.hub ?? hubRepoOf();
  if (!hub || !REPO_RE.test(hub)) {
    io.error("broadcast status: could not resolve the hub repo from the hub root's origin; pass --hub <owner/repo>");
    return 2;
  }
  const res = readStatus({ hub, number, gh: inject.gh, now: inject.now });
  if (!res.ok) {
    io.error(`broadcast status: could not read GitHub: ${res.error}`);
    return 2;
  }
  if (rest.includes("--json")) io.log(JSON.stringify(res, null, 2));
  else for (const l of renderStatus(res, hub)) io.log(l);
  return 0;
}
