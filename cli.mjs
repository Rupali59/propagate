#!/usr/bin/env node
/**
 * /propagate CLI — status, doctor, init.
 *
 * Usage:
 *   node cli.mjs status         — open rows for THIS project (the workspace at cwd)
 *   node cli.mjs status --all   — every workspace's queue
 *   node cli.mjs status --cross — the cross-repo ledger
 *   node cli.mjs doctor         — health check
 *   node cli.mjs init <dir>     — onboard a new workspace (scaffold marker + regen plist + reload)
 */

import { existsSync, globSync } from "node:fs";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  WORKSPACES,
  STATE_PATH,
  HEARTBEAT_PATH,
  WATCHER_LOG,
  SEARCH_ROOTS,
} from "./lib/config.mjs";
import { readLedger } from "./lib/ledger.mjs";
import { loadSidecar, SidecarError } from "./lib/frontmatter.mjs";
import { discoverCrossReposSync, loadCrossRepoSync, resolveTarget } from "./lib/cross-repo.mjs";

/**
 * Validate cross-repo edges: load each .propagates-cross.yml, resolve every
 * source/watch/affects target, count missing + outside-allowlist. Exported for test.
 */
export async function checkCrossRepo(searchRoots = SEARCH_ROOTS) {
  const repos = discoverCrossReposSync(searchRoots);
  let edges = 0, missing = 0, outsideAllowlist = 0;
  for (const repo of repos) {
    let e;
    try { e = loadCrossRepoSync(repo.root); } catch { continue; }
    const targets = [
      ...e.pushEdges.flatMap((p) => p.affects.map((a) => a.path)),
      ...e.pullEdges.map((p) => p.watch),
    ];
    for (const t of targets) {
      edges++;
      const r = resolveTarget(repo.root, t);
      if (r.reason === "missing") missing++;
      else if (r.reason === "outside-partner" || r.reason === "not-contract") outsideAllowlist++;
    }
  }
  return { edges, missing, outsideAllowlist };
}
import { discoverWorkspacesSync } from "./lib/discovery.mjs";
import { regeneratePlist, reloadLaunchd, PLIST_PATH } from "./lib/plist.mjs";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

async function findSidecars(workspaceRoot) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
        await walk(p, depth + 1);
      } else if (e.isFile() && e.name === ".propagates.yml") {
        found.push(p);
      }
    }
  }
  await walk(workspaceRoot, 0);
  return found;
}

/**
 * The workspace whose root contains the current working directory, or null if
 * cwd is outside every known workspace. Lets `status` default to "this project"
 * instead of relaying every workspace's queue.
 */
function currentWorkspace() {
  const cwd = process.cwd();
  // Nearest ancestor, not first match. A repo registered as its own workspace
  // also sits under a broader one (e.g. Keerti-portfolio inside the GitHub hub),
  // and `.find()` returned whichever was discovered first — so `status` run from
  // inside the repo relayed the hub's queue instead of the repo's. Longest
  // matching root wins, matching `findAllSidecarsRecursive`'s scoping.
  const matches = WORKSPACES.filter(
    (ws) => cwd === ws.root || cwd.startsWith(ws.root + path.sep),
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, ws) => (ws.root.length > best.root.length ? ws : best));
}

async function status() {
  if (process.argv.includes("--cross")) {
    const { CROSS_LEDGER_JSONL } = await import("./lib/config.mjs");
    const rows = (await readLedger(CROSS_LEDGER_JSONL)).filter((r) => r.status === "open");
    console.log(`${BOLD}# Cross-repo — ${rows.length} open${RESET}`);
    for (const r of rows) {
      console.log(`  #${r.id} [${r.direction}] ${r.origin_repo} → ${r.partner}: ${r.source} → ${(r.downstream || []).map((d) => d.path).join(", ")}`);
    }
    return;
  }
  // Default: only THIS project's queue (the workspace containing cwd). `--all`
  // relays every workspace. Cross-repo dependencies still surface below.
  const showAll = process.argv.includes("--all");
  const cur = currentWorkspace();
  const targets = showAll || !cur ? WORKSPACES : [cur];
  for (const ws of targets) {
    const scopeTag =
      !showAll && cur ? `  ${DIM}(this project — --all for every workspace)${RESET}` : "";
    console.log(`${BOLD}# ${ws.name}${RESET}${scopeTag}`);
    if (!existsSync(ws.ledgerJsonl)) {
      console.log(`  ${DIM}(no ledger file yet)${RESET}\n`);
      continue;
    }
    const rows = await readLedger(ws.ledgerJsonl);
    const open = rows.filter((r) => r.status === "open");
    if (open.length === 0) {
      console.log(`  ${GREEN}✓ no open drift events${RESET}\n`);
      continue;
    }
    const bySource = new Map();
    for (const r of open) {
      const src = r.source || "(unknown source)";
      if (!bySource.has(src)) bySource.set(src, []);
      bySource.get(src).push(r);
    }
    const proseCount = open.filter((r) => r.type !== "code_drift").length;
    const codeCount = open.filter((r) => r.type === "code_drift").length;
    const breakdown =
      codeCount > 0 && proseCount > 0
        ? ` (${proseCount} drift, ${codeCount} code drift)`
        : codeCount > 0
          ? " (all code drift)"
          : "";
    console.log(
      `  ${YELLOW}${open.length}${RESET} open event${open.length === 1 ? "" : "s"}${breakdown}:\n`,
    );
    for (const [src, items] of bySource) {
      console.log(`  ${BOLD}${src}${RESET}`);
      for (const r of items) {
        const isCodeDrift = r.type === "code_drift";
        const kindTag = isCodeDrift
          ? ` ${YELLOW}[code drift — verify upstream]${RESET}`
          : "";
        const graphTag = r.pending_graph_augment
          ? ` ${DIM}[needs graph-augment]${RESET}`
          : "";
        console.log(`    ${YELLOW}#${r.id}${RESET}  ${r.change}${kindTag}${graphTag}`);
        for (const d of r.downstream || []) {
          const arrow = isCodeDrift ? "↑" : "→";
          console.log(`      ${DIM}${arrow} ${d.path}  (${d.kind}: ${d.why})${RESET}`);
        }
        if (r.notes) console.log(`      ${DIM}notes: ${r.notes}${RESET}`);
      }
      console.log();
    }
  }

  // "Unless there is a dependency": in scoped mode, surface open cross-repo rows
  // whose origin repo lives inside THIS workspace (this project's outbound deps).
  if (!showAll && cur) {
    let crossRows = [];
    try {
      const { CROSS_LEDGER_JSONL } = await import("./lib/config.mjs");
      crossRows = (await readLedger(CROSS_LEDGER_JSONL)).filter((r) => r.status === "open");
    } catch {
      /* no cross ledger */
    }
    const mine = crossRows.filter(
      (r) => r.origin_repo && existsSync(path.join(cur.root, r.origin_repo)),
    );
    if (mine.length) {
      console.log(
        `${BOLD}# Cross-repo dependencies (${mine.length})${RESET}  ${DIM}(propagate status --cross for detail)${RESET}`,
      );
      for (const r of mine) {
        console.log(`  ${YELLOW}#${r.id}${RESET} ${r.origin_repo} → ${r.partner}: ${r.source}`);
      }
      console.log();
    }
  }
}

async function doctor() {
  let problems = 0;
  function check(label, ok, detail = "") {
    if (ok) {
      console.log(`  ${GREEN}✓${RESET} ${label}${detail ? "  " + DIM + detail + RESET : ""}`);
    } else {
      console.log(`  ${RED}✗${RESET} ${label}${detail ? "  " + RED + detail + RESET : ""}`);
      problems++;
    }
  }
  function warn(label, detail = "") {
    console.log(`  ${YELLOW}!${RESET} ${label}${detail ? "  " + DIM + detail + RESET : ""}`);
  }

  console.log(`${BOLD}# launchd${RESET}`);
  try {
    const out = execSync("launchctl list", { encoding: "utf8" });
    const loaded = out.split("\n").some((l) => l.includes("com.rupali.propagate"));
    check("plist loaded", loaded, loaded ? "" : "run: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rupali.propagate.plist");
  } catch (err) {
    check("launchctl reachable", false, err.message);
  }

  console.log(`\n${BOLD}# Heartbeat${RESET}`);
  if (existsSync(HEARTBEAT_PATH)) {
    const raw = (await readFile(HEARTBEAT_PATH, "utf8")).trim();
    const ts = parseInt(raw, 10);
    const ageMs = Date.now() - ts;
    const ageMin = Math.round(ageMs / 60_000);
    const ageDays = Math.round(ageMs / (1000 * 60 * 60 * 24));
    if (ageDays > 1) {
      check("heartbeat recent", false, `${ageDays} days old`);
    } else if (ageMin > 60) {
      check("heartbeat recent", true, `${ageMin} min old (ok if no edits recently)`);
    } else {
      check("heartbeat recent", true, `${ageMin} min old`);
    }
  } else {
    check("heartbeat file exists", false, "watcher has never run successfully");
  }

  console.log(`\n${BOLD}# State${RESET}`);
  check("state.json exists", existsSync(STATE_PATH));
  if (existsSync(STATE_PATH)) {
    try {
      const raw = await readFile(STATE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      check("state.json parseable", true, `${Object.keys(parsed.mtimes || {}).length} tracked files`);
    } catch (err) {
      check("state.json parseable", false, err.message);
    }
  }
  if (existsSync(`${STATE_PATH}.bak`)) {
    check("state.json.bak exists", true);
  } else {
    console.log(`  ${YELLOW}!${RESET} state.json.bak exists  ${DIM}no .bak yet (normal until watcher writes for the 2nd time)${RESET}`);
  }

  for (const ws of WORKSPACES) {
    console.log(`\n${BOLD}# Workspace: ${ws.name}${RESET}`);
    check("ledger JSONL exists", existsSync(ws.ledgerJsonl));
    if (existsSync(ws.ledgerJsonl)) {
      try {
        const rows = await readLedger(ws.ledgerJsonl);
        const openCount = rows.filter((r) => r.status === "open").length;
        check("ledger JSONL parseable", true, `${rows.length} rows, ${openCount} open`);
      } catch (err) {
        check("ledger JSONL parseable", false, err.message);
      }
    }
    check("ledger MD exists", existsSync(ws.ledgerMd));

    // Sidecars
    const sidecars = await findSidecars(ws.root);
    console.log(`  ${DIM}found ${sidecars.length} sidecar${sidecars.length === 1 ? "" : "s"}${RESET}`);
    for (const sc of sidecars) {
      const rel = path.relative(ws.root, sc);
      try {
        await loadSidecar(sc);
        check(`  ${rel}`, true);
      } catch (err) {
        const msg = err instanceof SidecarError ? err.message.split("] ").pop() : err.message;
        check(`  ${rel}`, false, msg);
      }
    }

    // Path validation: every sidecar downstream target resolves on disk.
    // prose missing → problem (fail); code (declare-ahead) → warn; glob → need ≥1 match.
    let pathProblems = 0;
    let pathWarns = 0;
    for (const sc of sidecars) {
      const scDir = path.dirname(sc);
      let sidecar;
      try {
        sidecar = await loadSidecar(sc);
      } catch {
        continue;
      }
      const rel = path.relative(ws.root, sc);
      for (const [src, body] of Object.entries(sidecar.sources || {})) {
        for (const d of body.propagates_to || []) {
          const kind = d.kind || "prose";
          if (/[*?[\]]/.test(d.path)) {
            let n = 0;
            try {
              n = globSync(d.path, { cwd: scDir }).filter((m) => !m.includes("node_modules/")).length;
            } catch {
              /* ignore */
            }
            if (n === 0) {
              warn(`${rel}: ${src} → ${d.path}`, "glob matched 0 files");
              pathWarns++;
            }
          } else if (!existsSync(path.resolve(scDir, d.path))) {
            // Warn-only: doctor is a cross-workspace health report — a stale edge
            // in one workspace must not red the aggregate exit code. Per-repo
            // enforcement lives in that repo's pre-commit (check-propagation.sh).
            warn(
              `${rel}: ${src} → ${d.path}`,
              kind === "code" ? "declare-ahead code, not on disk" : "prose downstream missing",
            );
            pathWarns++;
          }
        }
      }
    }
    if (pathProblems === 0) {
      check("sidecar downstream paths resolve", true, pathWarns ? `${pathWarns} warn` : "");
    }
  }

  console.log(`\n${BOLD}# Cross-repo${RESET}`);
  try {
    const x = await checkCrossRepo();
    check("cross-repo edges resolve", x.missing === 0 && x.outsideAllowlist === 0,
      `${x.edges} edges, ${x.missing} missing, ${x.outsideAllowlist} outside-allowlist`);
    // G7: every fired row must carry a normalized `partner` join key.
    const { CROSS_LEDGER_JSONL } = await import("./lib/config.mjs");
    const rows = await readLedger(CROSS_LEDGER_JSONL);
    const noPartner = rows.filter((r) => r.type === "drift" && !r.partner).length;
    check("cross rows carry partner", noPartner === 0, `${noPartner} rows missing partner`);
  } catch (err) {
    check("cross-repo check ran", false, err.message);
  }

  console.log(`\n${BOLD}# Graph integration${RESET}`);
  let graphMcp = false;
  try {
    const out = execSync("claude mcp list 2>&1", { encoding: "utf8" });
    graphMcp = /code-review-graph/.test(out);
  } catch {
    /* claude CLI may not be available */
  }
  if (graphMcp) {
    check("code-review-graph MCP registered", true);
  } else {
    console.log(`  ${YELLOW}!${RESET} code-review-graph MCP not registered  ${DIM}(V1 expected; see TM-064)${RESET}`);
  }

  console.log(`\n${BOLD}# Log tail${RESET}`);
  if (existsSync(WATCHER_LOG)) {
    const raw = await readFile(WATCHER_LOG, "utf8");
    const lines = raw.trim().split("\n");
    const last = lines.slice(-3);
    for (const l of last) console.log(`  ${DIM}${l}${RESET}`);
  } else {
    console.log(`  ${DIM}(no log yet)${RESET}`);
  }

  console.log();
  if (problems === 0) {
    console.log(`${GREEN}${BOLD}doctor: all green${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}doctor: ${problems} problem${problems === 1 ? "" : "s"} found${RESET}`);
    process.exit(1);
  }
}

async function init(targetDir) {
  if (!targetDir) {
    console.error(`${RED}error:${RESET} usage: node cli.mjs init <dir>`);
    process.exit(2);
  }
  const abs = path.resolve(targetDir);
  if (!existsSync(abs)) {
    console.error(`${RED}error:${RESET} ${abs} does not exist`);
    process.exit(2);
  }
  const stats = await stat(abs);
  if (!stats.isDirectory()) {
    console.error(`${RED}error:${RESET} ${abs} is not a directory`);
    process.exit(2);
  }

  // Verify target is under one of SEARCH_ROOTS (otherwise discovery won't find it).
  const underSearchRoot = SEARCH_ROOTS.some((r) => abs.startsWith(r + path.sep) || abs === r);
  if (!underSearchRoot) {
    console.log(
      `${YELLOW}warning:${RESET} ${abs} is not under any SEARCH_ROOTS (${SEARCH_ROOTS.join(", ")}).`,
    );
    console.log(`${DIM}discovery walks SEARCH_ROOTS only; add the parent to lib/config.mjs SEARCH_ROOTS if needed.${RESET}`);
  }

  const markerPath = path.join(abs, ".propagates.yml");
  if (existsSync(markerPath)) {
    console.log(`${YELLOW}already initialized:${RESET} ${markerPath} exists`);
  } else {
    const template = `# Propagation sidecar for ${path.basename(abs)} — auto-generated by \`/propagate init\`
# on ${new Date().toISOString().slice(0, 10)}.
#
# Declare source-of-truth files and their downstreams. The watcher fires
# a drift event whenever a source's mtime advances. Walk through open
# events via \`node ~/.claude/skills/propagate/cli.mjs status\`.
#
# Example:
#   sources:
#     CLAUDE.md:
#       propagates_to:
#         - path: server/auth/telegram.js
#           why: "Auth posture documented in CLAUDE.md must match HMAC impl"
#           kind: code

sources: {}
`;
    await writeFile(markerPath, template, "utf8");
    console.log(`${GREEN}✓${RESET} created ${markerPath}`);
  }

  // Re-discover workspaces (now includes the new one if under SEARCH_ROOTS)
  const workspaces = discoverWorkspacesSync(SEARCH_ROOTS);
  console.log(`${DIM}discovered ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}:${RESET}`);
  for (const ws of workspaces) {
    const isNew = ws.root === abs;
    console.log(`  ${isNew ? GREEN + "+" : DIM + " "}${RESET} ${ws.name}  ${DIM}${ws.root}${RESET}`);
  }

  // Regenerate plist
  console.log(`\n${BOLD}regenerating plist${RESET} ${DIM}${PLIST_PATH}${RESET}`);
  const result = await regeneratePlist({ workspaces });
  console.log(`${GREEN}✓${RESET} plist written with ${result.watchedRoots.length} workspace root${result.watchedRoots.length === 1 ? "" : "s"}`);

  // Reload launchd
  console.log(`\n${BOLD}reloading launchd${RESET}`);
  try {
    const out = reloadLaunchd();
    console.log(out.split("\n").map((l) => `  ${DIM}${l}${RESET}`).join("\n"));
    console.log(`${GREEN}✓${RESET} launchd reloaded`);
  } catch (err) {
    console.error(`${RED}reload failed:${RESET} ${err.message}`);
    console.error(`${DIM}fix the error then run: launchctl bootstrap gui/$(id -u) ${PLIST_PATH}${RESET}`);
    process.exit(1);
  }

  console.log(`\n${GREEN}${BOLD}init complete.${RESET}`);
  console.log(`${DIM}next: edit ${markerPath} to declare source files + downstreams${RESET}`);
  console.log(`${DIM}then: touch a source file to verify the watcher fires${RESET}`);
}

// Only dispatch when executed directly (node cli.mjs ...), NOT when a test imports
// checkCrossRepo from this module.
const _invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (_invokedDirectly) {
  const mode = process.argv[2] || "status";
  if (mode === "status") {
    await status();
  } else if (mode === "doctor") {
    await doctor();
  } else if (mode === "init") {
    await init(process.argv[3]);
  } else {
    console.error(`unknown mode: ${mode}`);
    console.error("usage: node cli.mjs [status|doctor|init <dir>]");
    process.exit(2);
  }
}
