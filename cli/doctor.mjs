/**
 * doctor.mjs: the `doctor` health check and its dispatch (`doctor`, `--json`, `--full`, `--since`), moved out of cli.mjs (#162, epic #143).
 */
import { existsSync, globSync, realpathSync, readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { homedir as _homedir } from "node:os";
const HOME_DIR = _homedir();
import { WORKSPACES, WATCHER_LOG, SEARCH_ROOTS, searchRootsExplain, CROSS_LEDGER_JSONL, SKILL_DIR, GRAPH_MCP_CACHE_PATH, STATE_DIR as CONFIG_ROOT_DIR, shortPath } from "../lib/core/config.mjs";
import { CLAUDE_USER_CONFIG, stateDir } from "../lib/core/paths.mjs";
import { openCount, readLedgerByEra } from "../lib/edges/ledger.mjs";
import { findLedgersUnder } from "../lib/edges/refs.mjs";
import { findAllSidecarsRecursive } from "../lib/edges/edges.mjs";
import { edgeEventIndex } from "../lib/edges/events.mjs";
import { METRICS_PATH, EXPECTATIONS, UNCALIBRATED, evaluateExpectations, detectVanishedKeys, RETIRED_METRICS, readLastMetricsRecord, appendMetricsRecord } from "../lib/report/metrics.mjs";
import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";
import { actionSuffix, marksSuffix } from "../lib/report/doctor/structure.mjs";
import { ACTION_KINDS } from "../lib/report/doctor/reporter.mjs";

/**
 * Render a Reporter's drained entries (lib/report/doctor/reporter.mjs).
 *
 * This is the ONLY place doctor's extracted sections turn into stdout, and it
 * reproduces `doctor()`'s own check/warn/info/note formatting exactly — the
 * split must be byte-identical, so the format lives in one place rather than
 * being re-derived per module. Modules under lib/ collect entries and print
 * nothing; no module there contains an ANSI escape, and this keeps it that way.
 */
export function renderDoctorEntries(entries) {
  for (const e of entries) {
    const d = e.detail;
    // E5. An entry's optional action is appended to its line in the form
    // structure.mjs parses back (ACTION_MARK), so /api/health can offer it. Dim,
    // after the detail: a person reads "what to do" at the end of the row.
    // propagate#295: the glance marks (human, check_id) go BEFORE the action, which runs to the end of the line.
    const marks = marksSuffix(e);
    const act = (marks ? DIM + marks + RESET : "") + (e.action ? DIM + actionSuffix(e.action) + RESET : "");
    if (e.kind === "pass") {
      console.log(`  ${GREEN}\u2713${RESET} ${e.label}${d ? "  " + DIM + d + RESET : ""}${act}`);
    } else if (e.kind === "fail") {
      console.log(`  ${RED}\u2717${RESET} ${e.label}${d ? "  " + RED + d + RESET : ""}${act}`);
    } else if (e.kind === "inconclusive") {
      // A THIRD marker, deliberately its own glyph. This votes like a failure
      // (the run cannot exit 0 unmeasured) but reads differently, because
      // nothing is broken — the check could not run and says why. Sharing the
      // dim "·" default with `info` is the exact defect this entry kind exists
      // to fix: GOTCHAS G68, where a check that examined nothing rendered as a
      // green tick.
      console.log(`  ${YELLOW}?${RESET} ${e.label}${d ? "  " + DIM + d + RESET : ""}${act}`);
    } else if (e.kind === "warn") {
      console.log(`  ${YELLOW}!${RESET} ${e.label}${d ? "  " + DIM + d + RESET : ""}${act}`);
    } else if (e.kind === "header") {
      console.log(`${e.leadingBlank ? "\n" : ""}${BOLD}${e.label}${RESET}`);
    } else if (e.kind === "note") {
      // Marker-less dim line — context about a check that could NOT run.
      console.log(`  ${DIM}${e.label}${RESET}`);
    } else if (e.kind === "info") {
      console.log(`  ${DIM}\u00b7${RESET} ${e.label}${d ? "  " + DIM + d + RESET : ""}${act}`);
    } else {
      // AN UNKNOWN KIND, rendered LOUDLY. This branch used to be where `info`
      // landed, so it was doing two jobs: rendering a known kind, and silently
      // absorbing any kind nobody had written a rule for. That is the defect
      // STATE.md records hitting four times in one day — a value the code can
      // emit that the renderer has no rule for, which does not error and does
      // not look wrong. Adding `inconclusive` would have fallen straight into
      // it and read as a neutral tally.
      console.log(
        `  ${RED}?!${RESET} ${e.label}  ${RED}(unrendered entry kind "${e.kind}")${RESET}` +
          (d ? "  " + DIM + d + RESET : ""),
      );
    }
  }
}

/**
 * Print ONE doctor check that carries an `action` ({kind, target}, as the Reporter's entries do).
 * Exists because doctor()'s own check() prints bare text; an action has to cross the text
 * boundary in the form structure.mjs parses back, and re-deriving that format here would be a
 * second copy of it. Validates like the Reporter does: a typo would otherwise ship a Health row
 * that silently says "no action mapped". The caller counts the problem; this only prints.
 * Exported so the seam can be tested without running the whole of doctor.
 */
export function checkWithAction(label, ok, detail, action) {
  if (!action || !ACTION_KINDS.includes(action.kind) || typeof action.target !== "string" || !action.target) {
    throw new Error(`doctor check ${JSON.stringify(label)}: action must be {kind: ${ACTION_KINDS.join("|")}, target: non-empty string}, got ${JSON.stringify(action)}`);
  }
  renderDoctorEntries([{ kind: ok ? "pass" : "fail", label, detail, action }]);
}

const stripAnsiText = (t) => String(t).replace(/\x1B\[[0-9;]*m/g, "");

/**
 * propagate#295: CLI `doctor` writes the glance from its IN-MEMORY result (the snapshot on disk is the previous run's).
 * Edges are carried from the monitor's last glance. Never moves doctor's exit code; a failure is one stderr line.
 */
async function writeGlanceAfterDoctor(doctorJson) {
  try {
    const { runGlance } = await import("../lib/glance/compute.mjs");
    const { envPaths } = await import("./glance.mjs");
    runGlance({ dir: CONFIG_ROOT_DIR || stateDir(), doctor: doctorJson, paths: envPaths() });
  } catch (e) {
    console.error(`${DIM}doctor: glance not written (${String(e?.message ?? e)})${RESET}`);
  }
}


/**
 * Report ledgers `findLedgersUnder` (lib/edges/refs.mjs) finds that
 * `discoverWorkspacesSync` would not — dot-directories, past `DEFAULT_MAX_DEPTH`,
 * or below a sidecar that never opted in with `workspace: true`. Plan:
 * ~/.claude/plans/status-temporal-plum.md P4 "undiscoverable-ledger report".
 *
 * `findLedgersUnder` existed with zero production callers (only `enumerateRefs`
 * was ever imported from refs.mjs, by lib/edges/bootstrap.mjs) — a correct,
 * built capability nothing watched (docs/GOTCHAS.md G48). This wires it in as
 * a `doctor` section, deliberately INFORMATIONAL: a ledger being invisible to
 * discovery is a real gap worth naming, but it is not, by itself, a defect in
 * the repo being checked — reporting it with a `✗` would train people to
 * ignore doctor (G1, G23).
 *
 * NOT the same coverage as the pre-existing `findUnownedLedgers` / "no unowned
 * ledger files" hard check already in `doctor` below: that one has its own raw
 * walk with its own SKIP set (deliberately not excluding dot-dirs so it can
 * catch exactly the PanditPawanKaushik-worktree class of case) and fails
 * doctor outright. This section adds the WHY — dot-directory / depth /
 * no-workspace-marker, taken from `discoverWorkspacesSync`'s actual read-only
 * ground truth — that the other check does not carry. See P4's verification
 * report for a live-machine finding: the two mechanisms overlap for most
 * inputs, but not all (`.gstack` is skipped by one and not the other).
 *
 * Every non-finding case is named per `rule:discernment-checks` §2 — "no
 * result" and "no result *because*" must never collapse into the same output:
 *   - `no-roots`     — SEARCH_ROOTS resolved to nothing to walk
 *   - `walk-failed`  — the raw filesystem walk itself threw
 *   - `none-found`   — the walk ran and found nothing undiscoverable
 *   - `found`        — findings[], each `{ path, reason, open }`
 *
 * `open` is the FOLDED open-row count (openCount(), reused rather than
 * reimplemented — the ledger is append-only, so a closed row keeps its
 * original `open` line and a raw line count overcounts; docs/GOTCHAS.md
 * "501 where the truth was 8"). `open` is `-1` when the ledger itself could
 * not be read — still reported by path and reason, never silently dropped.
 *
 * Exported (not inlined in `doctor()`) so the no-roots/walk-failed branches —
 * impractical to force from a real machine's configured search roots — can be
 * pinned directly, same reasoning as `decisionsAttributionReport` above.
 *
 * @param {string[]} searchRoots
 * @returns {Promise<{status: "no-roots"|"walk-failed"|"none-found"|"found", findings: Array<{path: string, reason: string, open: number}>, error?: string}>}
 */
export async function undiscoverableLedgersReport(searchRoots) {
  if (!searchRoots || searchRoots.length === 0) {
    return { status: "no-roots", findings: [] };
  }

  let rawFindings;
  try {
    const seen = new Set();
    rawFindings = [];
    for (const root of searchRoots) {
      for (const f of findLedgersUnder(root)) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        rawFindings.push(f);
      }
    }
  } catch (err) {
    return { status: "walk-failed", findings: [], error: err.message };
  }

  const undiscoverable = rawFindings.filter((f) => !f.discoverable);
  if (undiscoverable.length === 0) {
    return { status: "none-found", findings: [] };
  }

  const findings = [];
  for (const f of undiscoverable) {
    let open;
    try {
      open = await openCount(f.path);
    } catch {
      open = -1; // unreadable ledger — still reported, never dropped (G2)
    }
    findings.push({ path: f.path, reason: f.reason, open });
  }
  return { status: "found", findings };
}








/**
 * Assign each unique sidecar (by `fs.realpathSync`) to its nearest — i.e.
 * deepest — owning workspace, so `doctor` validates each sidecar exactly
 * once instead of once per containing workspace.
 *
 * Workspace roots nest (`GitHub` ⊃ `PanditPawanKaushik` ⊃ `SSJK-mb`), and
 * `findSidecars` recursively walks a workspace's *entire* subtree with no
 * awareness of nested workspace boundaries — so a sidecar under `SSJK-mb`
 * is found by all three ancestors' walks. Before this function existed,
 * `doctor` validated (loadSidecar + downstream-path checks) whatever
 * `findSidecars` returned for every workspace independently, so that one
 * sidecar's defects were reported once per containing workspace. See
 * docs/ISSUES.md A2 for the measured consequence (28 sources open in more
 * than one ledger — all nested parent/child pairs).
 *
 * Keyed by realpath, not the raw path string, because symlinks and worktree
 * checkouts make the same file reachable via more than one path — two
 * different raw strings that are the same file must still collapse to one
 * validation, one report.
 *
 * @param {Array<{root: string}>} workspaces
 * @param {Map<string, string[]>} sidecarsByWsRoot ws.root -> absolute sidecar
 *   paths found under it (as returned by `findSidecars(ws.root)`), one entry
 *   per workspace — a sidecar nested under two workspace roots appears in
 *   both entries' arrays, which is exactly the duplication being collapsed.
 * @returns {{assignedByWsRoot: Map<string, string[]>, uniqueCount: number}}
 *   `assignedByWsRoot` covers every workspace passed in (empty array for a
 *   workspace assigned nothing); `uniqueCount` is the number of distinct
 *   real files across all input sidecars — the coverage-invariant target.
 */
export function assignSidecarsToWorkspaces(workspaces, sidecarsByWsRoot) {
  const byRealpath = new Map(); // realpath -> { originalPath, candidates: [ws, ...] }
  for (const ws of workspaces) {
    const list = sidecarsByWsRoot.get(ws.root) || [];
    for (const sc of list) {
      let real;
      try {
        real = realpathSync(sc);
      } catch {
        real = sc; // vanished between find and realpath — fall back to the raw path
      }
      if (!byRealpath.has(real)) byRealpath.set(real, { originalPath: sc, candidates: [] });
      byRealpath.get(real).candidates.push(ws);
    }
  }

  const assignedByWsRoot = new Map(workspaces.map((ws) => [ws.root, []]));
  for (const { originalPath, candidates } of byRealpath.values()) {
    // Deepest wins: the workspace whose root is the longest (most nested)
    // among every workspace whose subtree contains this sidecar.
    const nearest = candidates.reduce((best, ws) => (ws.root.length > best.root.length ? ws : best));
    assignedByWsRoot.get(nearest.root).push(originalPath);
  }

  return { assignedByWsRoot, uniqueCount: byRealpath.size };
}





/**
 * The sidecars `doctor` validates under one workspace root.
 *
 * Delegates to `findAllSidecarsRecursive`, the walk `status`, `check` and
 * `reconcile` use, so doctor validates exactly the sidecars those commands act
 * on. It used to carry a private walk that skipped only node_modules/.next/.git:
 * it descended into `.worktrees/` and `.claude/worktrees/`, whose sidecars are a
 * second checkout of a repo already scanned, and resolved their `source:` keys
 * against a tree where they were never meant to hold (#129: ~50 of 52 doctor
 * failures). `findAllSidecarsRecursive` skips worktrees by design ("primary
 * worktree's sidecar is canonical"); a worktree is usually on another branch
 * too (GOTCHAS G87). `[]` for the second argument: nested-workspace hand-off is
 * `assignSidecarsToWorkspaces`'s job here, not the walk's.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<string[]>}
 */
export async function findSidecars(workspaceRoot) {
  return findAllSidecarsRecursive(workspaceRoot, []);
}









/** One hour — long enough that repeat `doctor` runs in a session are free, short
 * enough that a genuine MCP registration change is visible same-day. */
const GRAPH_MCP_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Probe whether the `code-review-graph` MCP is registered, via `claude mcp
 * list`. Bounded and cached — see docs/ISSUES.md N16: this shell-out was
 * measured taking 17.8s of a ~19s `doctor` run (94%) to report a single
 * WARNING that is known and deferred (TM-064). An unbounded synchronous
 * subprocess inside a health check is a liveness risk, not just slow — a
 * hung `claude` binary would hang `doctor` itself, forever, with no signal.
 *
 * Returns `{ status, checkedAt, fromCache, detail? }` where `status` is one
 * of `"registered" | "not-registered" | "timeout" | "error"`. `"timeout"`
 * and `"error"` are distinct from `"not-registered"` on purpose: "I could
 * not look" and "I looked and it is not there" must never collapse into the
 * same report (that distinction is this register's entire theme — see
 * docs/ISSUES.md's root-defect section). Never returns a bare boolean and
 * never silently maps a timeout to a pass.
 *
 * Result is cached to GRAPH_MCP_CACHE_PATH (respects PROPAGATE_STATE_DIR via
 * lib/config.mjs) for GRAPH_MCP_CACHE_TTL_MS, including timeout/error
 * outcomes — a hung `claude` binary should not cost every `doctor` run 2s
 * for an hour either, and the cached entry still carries its own status so a
 * cached timeout is reported as a cached timeout, not a cached pass.
 *
 * @param {{cachePath?: string, ttlMs?: number, now?: () => number}} [opts] test seams
 */
/**
 * Is `code-review-graph` registered as an MCP server, read from disk?
 *
 * Returns a STRING so it drops straight into the existing `/code-review-graph/`
 * test below — the shape `claude mcp list` used to return. Deliberately not a
 * boolean: the caller already distinguishes registered / not-registered / error,
 * and collapsing that here would lose the distinction this register is about.
 *
 * Scope order matches Claude Code's own: project `.mcp.json` walking up from cwd,
 * then user scope in `~/.claude.json`. Never throws for an absent or malformed
 * config — an unreadable file is 'not found here', and the walk continues.
 */
function readGraphRegistration() {
  const names = [];
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const f = path.join(dir, ".mcp.json");
    try {
      if (existsSync(f)) names.push(...Object.keys(JSON.parse(readFileSync(f, "utf8")).mcpServers || {}));
    } catch {
      /* malformed .mcp.json is 'nothing declared here', not a crash */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  try {
    const home = CLAUDE_USER_CONFIG;
    if (existsSync(home)) names.push(...Object.keys(JSON.parse(readFileSync(home, "utf8")).mcpServers || {}));
  } catch {
    /* same */
  }
  return names.join("\n");
}

export async function checkGraphMcpStatus(opts = {}) {
  const cachePath = opts.cachePath ?? GRAPH_MCP_CACHE_PATH;
  const ttlMs = opts.ttlMs ?? GRAPH_MCP_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;

  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(await readFile(cachePath, "utf8"));
      // KEYED BY CWD, added 2026-09-01 with the config-read change above.
      // The answer became cwd-DEPENDENT the moment this stopped shelling out:
      // 24 of the 26 .mcp.json files in this tree declare code-review-graph at
      // PROJECT scope, and none declares it at user scope. A cwd-independent
      // cache therefore served a project answer to the hub and vice versa —
      // measured immediately: from Motherboard/motherboard-infra, whose own
      // .mcp.json declares it, doctor reported "not registered (cached 2m ago)".
      // With the cache cleared it correctly reported registered.
      //
      // A mismatch is a MISS, not a stale hit. Recomputing costs a handful of
      // existsSync calls; the old 17,793ms subprocess is what the cache existed
      // for and it is gone, so the cheap thing to do when unsure is recompute.
      const sameCwd = cached.cwd === undefined || cached.cwd === process.cwd();
      if (sameCwd && typeof cached.checkedAt === "number" && now() - cached.checkedAt < ttlMs) {
        return { ...cached, fromCache: true };
      }
    }
  } catch {
    /* corrupt or unreadable cache -- fall through and recompute */
  }

  // N16, closed 2026-09-01. This shelled out to `claude mcp list`, which
  // `rule:tool-priority` explicitly forbids here: "claude mcp list health-checks
  // ~30 remote servers and is slow (tens of seconds). Never put it in a
  // health-check path." Measured 2026-08-13 it was 17,793ms — 94% of doctor's
  // whole run. The 2s timeout added afterwards did not fix that; it guaranteed
  // the check could never SUCCEED, so doctor reported `status unknown` on every
  // run. Honest, per rule:discernment-checks §2, and useless.
  //
  // Registration is readable from disk with no subprocess at all. The gstack
  // preamble already does this and says why: "Read claude.json directly to keep
  // this preamble fast (no subprocess to claude CLI on every skill start)."
  //
  // BUT USER SCOPE ALONE IS THE WRONG ANSWER, and measuring saved this fix from
  // being wrong in a new way. `~/.claude.json`'s top-level `mcpServers` holds 4
  // entries and NONE is the graph. All 24 registrations are PROJECT-scoped
  // `.mcp.json` files (of 26 in the tree). Reading only user scope would have
  // reported a confident `not-registered` for a server that is registered
  // almost everywhere — trading a slow honest unknown for a fast wrong answer.
  //
  // So: walk cwd upward for `.mcp.json`, then fall back to user scope. That is
  // the same resolution order Claude Code itself uses, and it is milliseconds.
  const runMcpList = opts.runMcpList ?? (() => readGraphRegistration());

  let result;
  try {
    const out = runMcpList();
    result = { status: /code-review-graph/.test(out) ? "registered" : "not-registered", checkedAt: now(), cwd: process.cwd() };
  } catch (err) {
    // execSync throws on nonzero exit AND on hitting `timeout` -- the timeout
    // case is marked by `killed`/`signal` (Node kills the child with
    // `killSignal`, default SIGTERM) and must stay distinguishable from "ran
    // fine and said no" or "the `claude` binary errored for some other reason".
    const timedOut = err.killed === true || err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
    result = { status: timedOut ? "timeout" : "error", checkedAt: now(), cwd: process.cwd(), detail: err.message };
  }

  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(result), "utf8");
  } catch {
    /* best-effort cache write -- a failed write must not fail the check itself */
  }
  return { ...result, fromCache: false };
}

export async function doctor({ exitProcess = true } = {}) {
  const doctorStart = Date.now();
  let problems = 0;
  // Metrics counters (docs/OBSERVABILITY.md §6 step 1) — accumulated as the
  // existing checks below run, not recomputed. `doctor` already gathers every
  // one of these; this just keeps a running tally instead of throwing it away.
  let sidecarsLoadedCount = 0;
  let sidecarsRejectedCount = 0;
  let sidecarsProblemsCount = 0;
  let ledgerUnknownTypesTotal = 0;
  let ledgerMalformedTotal = 0;
  let rowsOpenTotal = 0;
  let decisionsEntriesCount = 0;
  let decisionsWithTokensCount = 0;
  let plistWatchpathsCount = 0;
  // Set by checkEnvironment and read by `# Metrics` — the ONE reconcile() of the run (D8).
  let doctorReconcileRows = null;
  // Detail collected for the four subjects whose sole assertion now lives in
  // EXPECTATIONS (lib/metrics.mjs, GOTCHAS G20) — the inline check() calls
  // that used to assert these facts were downgraded to info()/warn(), but the
  // exact-offender detail they used to print must still reach the reader, so
  // it's captured here and handed to evaluateExpectations() as context.
  const ledgerUnknownTypesDetails = [];
  const sidecarsRejectedDetails = [];
  let decisionsPath = "";
  let decisionsZeroEntries = [];
  // Doctor's extracted sections share ONE Reporter (lib/report/doctor/reporter.mjs):
  // it owns `problems`, the only accumulator that is global to the run. Imported
  // dynamically like doctor's other lazy imports (D5) so `propagate status` never
  // pulls this subtree in. Each section imports its own module at its call site.
  const { Reporter } = await import("../lib/report/doctor/reporter.mjs");

  // `action` (2026-10-16): a check with one goes through checkWithAction, which renders via
  // renderDoctorEntries -- the ONE place that appends the marker structure.mjs parses back, so
  // /api/health offers it. A check without one prints exactly as before.
  // The 4th argument was historically a PASS detail that check() silently ignored (e.g. "cross
  // rows carry partner" passes "N row(s) scanned" so "scanned nothing" and "found nothing" read
  // differently). Giving check() an `action` slot made that string throw as a malformed action and
  // failed doctor on a clean install (release --check, 2026-10-16). So: a string is the pass
  // detail its callers always meant; only an object is an action.
  function check(label, ok, detail = "", action) {
    if (typeof action === "string") {
      if (ok && action) detail = action;
      action = undefined;
    }
    if (action) {
      checkWithAction(label, ok, detail, action);
      if (!ok) problems++;
      return;
    }
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
  // Summary line for an aggregate that restates counts already reported by
  // per-entry `check()` failures above it — informational, not a second vote.
  // A run-level summary is useful (see docs/ISSUES.md A2's "5th problem"
  // note); it must never double-count the same underlying defect it is
  // summarizing. Uses a neutral marker (not ✗) precisely so it reads as
  // "here's the tally", not "here's a new failure".
  function info(label, detail = "") {
    console.log(`  ${DIM}·${RESET} ${label}${detail ? "  " + DIM + detail + RESET : ""}`);
  }

  // The v1 launchd watcher is RETIRED (docs/DECISIONS.md 2026-08-14):
  // measured 4,420 runs / 4,384 no-ops (99.2%), plus two incidents in one day
  // traced to its state.json mtime baseline. `reconcile` (on demand) + `check`
  // (pre-push) + the digest's DRIFT/INBOUND sections replace its coverage.
  // Per docs/GOTCHAS.md G2 ("absence must be attributable") this section
  // stays — informational only, never a `check()` — so a reader lands on
  // "retired on purpose" instead of wondering where the watcher checks went.
  // The section that follows ("v2 replacement health") is what can now fail.
  // Extracted to lib/report/doctor/environment.mjs (#31 T2). It owns THREE
  // consecutive sections, so it emits their headers as entries rather than
  // having this caller print them — that is what keeps them ordered with the
  // checks in between. It also owns the single reconcile() call and hands the
  // rows back for `# Metrics` (D8); nothing else may call reconcile in a doctor
  // run, because two calls could report two different trees.
  {
    const { checkEnvironment } = await import("../lib/report/doctor/environment.mjs");
    const reporter = new Reporter();
    const { counts, details } = await checkEnvironment({ reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    doctorReconcileRows = details.reconcileRows;
  }

  // Installed git hooks: presence is not liveness (#22). Placed immediately after
  // the environment block because it belongs to the same question — is what was
  // installed actually working — and because that section already owns the launchd
  // rows, which are the other component whose presence read as health while it did
  // nothing.
  //
  // SEARCH_ROOTS rather than the discovered workspaces: six of the seven hooks in
  // this tree sit in PROJECT repos, not workspace roots, so iterating workspaces
  // would have found the workspace hook and missed its projects'.
  {
    const { checkHooks } = await import("../lib/report/doctor/hooks.mjs");
    const reporter = new Reporter();
    const { HUB_ROOT: hookHubRoot } = await import("../lib/core/config.mjs");
    const { planInstructionGate } = await import("../lib/report/hooks-gate.mjs");
    const { ownedRemotes, excludedRepos } = await import("./hooks.mjs");
    const { owned: hookOwned } = ownedRemotes([]);
    const gatePlan = planInstructionGate({ roots: SEARCH_ROOTS, workspaces: WORKSPACES, owned: hookOwned, exclude: excludedRepos() });
    await checkHooks({ reporter, roots: SEARCH_ROOTS, hubRoot: hookHubRoot, gatePlan, ownedAllowlist: hookOwned });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
  }


  // Sidecars: gather once per workspace root, then collapse duplicates.
  // findSidecars(ws.root) walks that workspace's ENTIRE subtree with no
  // awareness of nested workspace boundaries, so a sidecar under a nested
  // workspace (e.g. SSJK-mb under PanditPawanKaushik under the GitHub hub)
  // is found by every ancestor's walk. assignSidecarsToWorkspaces collapses
  // that to one validation per unique sidecar, owned by its nearest
  // (deepest) workspace. See docs/ISSUES.md A2.
  const sidecarsByWsRoot = new Map();
  for (const ws of WORKSPACES) {
    sidecarsByWsRoot.set(ws.root, await findSidecars(ws.root));
  }
  const { assignedByWsRoot } = assignSidecarsToWorkspaces(WORKSPACES, sidecarsByWsRoot);
  const { checkWorkspace } = await import("../lib/report/doctor/workspaces.mjs");

  for (const ws of WORKSPACES) {
    console.log(`\n${BOLD}# Workspace: ${ws.name}${RESET}`);
    // Extracted to lib/report/doctor/workspaces.mjs (#31 T2). The section's own
    // rationale — why sidecars are assigned across ALL workspaces, and which of
    // its findings are deliberately not failures — moved with the code. Do not
    // restate it here.
    const reporter = new Reporter();
    const { counts, details } = await checkWorkspace({
      ws,
      sidecars: assignedByWsRoot.get(ws.root) || [],
      reporter,
    });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    // Per-workspace counts, summed into the run-global tallies `# Metrics`
    // reads. Returned values rather than shared mutation (D4): a dropped key
    // is a missing property, not a silent zero.
    rowsOpenTotal += counts.rowsOpen;
    ledgerUnknownTypesTotal += counts.ledgerUnknownTypes;
    sidecarsLoadedCount += counts.sidecarsLoaded;
    sidecarsRejectedCount += counts.sidecarsRejected;
    sidecarsProblemsCount += counts.sidecarsProblems;
    ledgerUnknownTypesDetails.push(...details.ledgerUnknownTypes);
    sidecarsRejectedDetails.push(...details.sidecarsRejected);
  }

  console.log(`\n${BOLD}# Cross-repo${RESET}`);
  try {
    // propagate#117: the cross-client guard over the reconcile rows doctor already
    // computed (one reconcile per run, D8), plus the retired-format leftovers check.
    // This replaced "cross-repo edges resolve", which resolved a format nothing fired.
    const { checkCrossRepoEdges } = await import("../lib/report/doctor/cross.mjs");
    const { loadPlatformRoots } = await import("../lib/edges/cross-repo.mjs");
    const { HUB_ROOT: crossHubRoot } = await import("../lib/core/config.mjs");
    const crossReporter = new Reporter();
    checkCrossRepoEdges({
      reporter: crossReporter,
      rows: doctorReconcileRows,
      hubRoot: crossHubRoot,
      workspaces: WORKSPACES,
      platformRoots: loadPlatformRoots(crossHubRoot),
      searchRoots: SEARCH_ROOTS,
    });
    renderDoctorEntries(crossReporter.drain());
    problems += crossReporter.problems;
    // G7: every fired row must carry a normalized `partner` join key.
    //
    // READS BOTH ERAS. This used to read the live ledger only. Once Phase D
    // froze v1 into archive/, that made `noPartner === 0` trivially true — a
    // check that cannot fail (rule:discernment-checks §1), and it would have
    // read as a fix rather than as a relocation. The property is about the v1
    // history, which is exactly what the archive now holds.
    const { CROSS_LEDGER_JSONL } = await import("../lib/core/config.mjs");
    const crossEra = await readLedgerByEra(CROSS_LEDGER_JSONL);
    // EVERY parsed row, not the era buckets. Filtering by era here made the
    // check scan 0 rows on an unfrozen cross ledger and report green — the
    // vacuous pass this very check was repointed to avoid.
    const crossAll = crossEra.all;
    const noPartner = crossAll.filter((r) => r.type === "drift" && !r.partner).length;
    // Scanning nothing and finding nothing are different facts; say which.
    check(
      "cross rows carry partner",
      noPartner === 0,
      `${noPartner} rows missing partner`,
      `${crossAll.length} row(s) scanned across live + archive`,
    );
  } catch (err) {
    check("cross-repo check ran", false, err.message);
  }

  console.log(`\n${BOLD}# DECISIONS.md attribution${RESET}`);
  // FIRST EXTRACTED SECTION (#31 T2). The section's own rationale — N12, why
  // the equality assertion lives in EXPECTATIONS rather than here, and why a
  // THROWN parse must fail rather than read as "0 == 0" — moved with the code
  // to lib/report/doctor/decisions.mjs. Do not restate it here.
  //
  // The shape every other section will follow: build a Reporter, call the
  // module, render its drained entries IMMEDIATELY (so run order is unchanged),
  // add its problems to the run tally, then copy its returned counts/details
  // into the metrics accumulators. Returned values, never shared mutation —
  // a dropped key becomes a missing property instead of a silent zero.
  {
    // Dynamic, like doctor's other 14 imports (D5): a static top-of-file import
    // would pull doctor's whole subtree into `propagate status`/`check`/`drain`,
    // a startup cost on a published binary that no test would catch.
    const { checkDecisions } = await import("../lib/report/doctor/decisions.mjs");
    const reporter = new Reporter();
    const { counts, details } = await checkDecisions({ skillDir: SKILL_DIR, reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    decisionsEntriesCount = counts.decisionsEntries;
    decisionsWithTokensCount = counts.decisionsWithTokens;
    decisionsPath = details.decisionsPath;
    decisionsZeroEntries = details.decisionsZeroEntries;
  }

  // # Backlog — todos, issues and handovers. Dynamic import for the same reason
  // as the block above (D5). Reports counts as context and NAMES only defects:
  // the open-item list is 500 long and belongs in `propagate backlog`.
  {
    const { checkBacklog } = await import("../lib/report/doctor/backlog.mjs");
    const reporter = new Reporter();
    const { counts } = await checkBacklog({ reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    // counts are returned for the same reason every doctor module returns them
    // (D4 — a dropped key becomes a missing property, not a silent zero), and
    // deliberately not stored: nothing reads them yet. Wiring them into
    // `# Metrics` is a separate, deliberate step, and an unread accumulator
    // here would be exactly the dead state this codebase keeps deleting.
    void counts;
  }

  // # Delivery — is the plugin anyone RUNS the same code as the one in this repo?
  // Every other section in doctor reads the SOURCE tree, which is why the served
  // plugin sat four versions behind through four merged PRs with doctor green the
  // whole time (2026-09-16). Extracted rather than inlined for the same reason as
  // the blocks above, and reached by dynamic import so `status` never pays for it.
  {
    const { checkDelivery } = await import("../lib/report/doctor/delivery.mjs");
    const reporter = new Reporter();
    await checkDelivery({ reporter, repoRoot: SKILL_DIR });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
  }

  // # Registers — adjacent to # Backlog and deliberately separate from it.
  // Backlog answers "can every register be READ and every handover CLOSED";
  // this answers "has a register grown past the point anyone opens it". A file
  // can be perfectly readable and still be 2738 lines of which 31 entries are
  // finished, which is what propagate's own ISSUES.md was on 2026-08-27.
  {
    const { checkRegisters } = await import("../lib/report/doctor/registers.mjs");
    const reporter = new Reporter();
    const { counts } = await checkRegisters({ reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    // Same posture as the block above: returned so a dropped key is a missing
    // property rather than a silent zero (D4), not stored because nothing reads
    // them yet.
    void counts;
  }

  // # Reminders bridge — PR-007's failures, and the reason this block exists at
  // all. A `docs/SYSTEMS.md` row does NOT integrate failure: `formatAdoptionLines()`
  // only PRINTS the liveness_probe column, it never runs it, and the cited
  // precedent (`ssjk-mongo-backup`) ran daily, exited 0 and produced zero backups
  // for weeks. Detection has to be a doctor check or it is not detection (D2).
  //
  // Reading Reminders needs macOS TCC permission, so a denial is "could not
  // look" -- neither pass nor fail. That is `inconclusive`, the fourth entry kind
  // N87 slice 2 added, and this is its FIRST real consumer, which is why PR-007
  // was sequenced behind it. `Reporter.inconclusive` throws on an empty reason
  // and increments `problems`, so a could-not-look can never read as a pass.
  {
    const { checkReminders } = await import("../lib/report/doctor/reminders.mjs");
    const reporter = new Reporter();
    await checkReminders({ reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
  }

  // # Services — offline only (no network call). One line when clean; findings warn, never fail.
  {
    try {
      const { checkServices } = await import("../lib/report/doctor/services.mjs");
      const reporter = new Reporter();
      await checkServices({ reporter });
      renderDoctorEntries(reporter.drain());
      problems += reporter.problems;
    } catch (err) {
      console.log(`  ${YELLOW}!${RESET} services  ${DIM}could not be derived: ${err.message}${RESET}`);
    }
  }

  // # Knowledge base — offline only (no network call, no probe spawn). Findings warn; only a declaration error fails.
  // A throw is an inconclusive entry (counted), never a silent yellow line: could-not-run is not no-problem.
  {
    const { runStandardsSection } = await import("../lib/report/doctor/kb.mjs");
    const reporter = new Reporter();
    await runStandardsSection({ reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
  }

  // # Goals — arrival conditions. Surfaced HERE rather than left to whoever
  // remembers to type `propagate goals`, because a capability nobody invokes is
  // indistinguishable from one that was never built
  // (`rule:enforcement-watches-itself` lists nine such mechanisms in this tree).
  //
  // Informational, never a doctor failure: a workspace with no GOALS.md is the
  // expected state today — one exists, of sixteen — and "not adopted yet" must
  // not read as broken. The line that WOULD justify escalating is `uncheckable`
  // going above zero: a goal asserting an arrival condition nobody can check,
  // which does not admit that it cannot be checked.
  console.log(`\n${BOLD}# Goals${RESET}`);
  {
    try {
      const { parseGoalsFile, goalCounts, checkDirectionQuote } = await import("../lib/report/goals.mjs");
      const { discoverBacklogFiles } = await import("../lib/report/backlog.mjs");
      const files = (discoverBacklogFiles().goalsMd ?? []).map(parseGoalsFile);
      const g = goalCounts(files);
      // Does each goal still test the DIRECTION it quotes? Derived, not an edge:
      // the reverse GOALS.md -> NORTH_STAR.md edge was declared 2026-09-16 and
      // reverted the same hour because propagate refuses mutual pairs (a cycle has
      // no canonical direction, so no fix order exists). This closes the same gap
      // by comparison instead. Normalisation matters — see the module header.
      try {
        // G24: an unconfigured root must NOT silently become a relative path.
        // "not configured" and "configured wrong" are different facts and only
        // one of them is the user's fault; joining onto "" hides both.
        const root = SEARCH_ROOTS[0];
        const nsPath = root ? path.join(root, "NORTH_STAR.md") : null;
        const northStarText = nsPath && existsSync(nsPath) ? readFileSync(nsPath, "utf8") : null;
        for (const f of files) {
          if (f.unread) continue;
          const v = northStarText === null
            ? { state: "absent", why: root
                ? `NORTH_STAR.md not found at ${nsPath} — the quote cannot be checked`
                : "no search root configured, so NORTH_STAR.md cannot be located — not a clean result" }
            : checkDirectionQuote({ goalsText: readFileSync(f.file, "utf8"), northStarText });
          const label = "direction quote";
          if (v.state === "matches") check(label, true, v.why);
          else if (v.state === "unquoted") info(label, v.why);
          else warn(`${label} — ${v.state}`, v.why);
        }
      } catch (err) {
        info("direction quote", `could not be derived: ${err.message}`);
      }
      if (g.files === 0) {
        // "No GOALS.md anywhere" and "all of them empty" are different facts.
        console.log(
          `  ${DIM}·${RESET} goal states  ${DIM}no GOALS.md under the search roots — an empty scan, not a clean one${RESET}`,
        );
      } else {
        console.log(
          `  ${DIM}·${RESET} goal states  ${DIM}${g.total} across ${g.files} file(s) — ` +
            `${g.open} open · ${g.closed} closed · ${g.unknown} unknown${RESET}`,
        );
        console.log(
          `  ${DIM}·${RESET} derivation  ${DIM}${g.claimed} name a command · ${g.waived} declared judgement · ` +
            `${g.uncheckable} neither${RESET}`,
        );
        if (g.uncheckable > 0) {
          console.log(
            `  ${YELLOW}!${RESET} ${g.uncheckable} goal(s) nobody can check  ${DIM}run \`propagate goals\` — each asserts` +
              ` an arrival condition with no \`Derived by:\` and no \`Judgement, not derivable:\`${RESET}`,
          );
        }
        if (g.unread > 0) {
          console.log(
            `  ${YELLOW}!${RESET} ${g.unread} GOALS.md could not be read  ${DIM}a reader that failed, not an empty file${RESET}`,
          );
        }
      }
    } catch (err) {
      // Absence must be attributable — never let a thrown reader read as "no goals".
      console.log(`  ${YELLOW}!${RESET} goal states  ${DIM}could not be derived: ${err.message}${RESET}`);
    }
  }

  // # Claims — judgment states. Surfaced HERE for the same reason Goals is:
  // `claims judge` takes ONE file, so without this nobody sees the tree-wide
  // picture unless they already suspect something.
  //
  // Informational, never a doctor failure. `unjudged` is the expected state
  // today — no lane emits questions yet — and "not adopted" must not read as
  // broken. The line that WOULD justify escalating is `unanswerable` above
  // zero: a caller tried to judge and could not, which is a fact about the
  // machinery rather than about the corpus.
  //
  // The three states are never collapsed (`rule:discernment-checks` §2). In
  // particular a corpus with no verdict store reports `0 runs`, NOT `0
  // findings` — "nobody has looked" and "looked and found nothing" are
  // different facts and only one of them is a pass.
  console.log(`\n${BOLD}# Claims${RESET}`);
  {
    try {
      const { buildClaimsCorpus } = await import("../lib/claims/check.mjs");
      // The fold lives in lib/, same seam as `goalCounts` above: cli.mjs
      // renders and never accumulates. It also reads each store ONCE —
      // `readClaims({file})` per file is O(files x store-size), measured at
      // 754ms here against 0ms for a single whole-store read.
      const { claimsCounts } = await import("../lib/report/claims.mjs");
      const corpus = await buildClaimsCorpus({ workspaces: WORKSPACES });
      const files = [...corpus.fileEntries.keys()];
      if (files.length === 0) {
        // "No declared sources" and "sources with nothing judgeable" differ.
        console.log(
          `  ${DIM}·${RESET} judgment states  ${DIM}no declared source files under the search roots — an empty scan, not a clean one${RESET}`,
        );
      } else {
        const { judged, unjudged, unanswerable, runs, unreadable, malformed } = await claimsCounts(files);
        console.log(
          `  ${DIM}·${RESET} judgment states  ${DIM}${judged} judged · ${unjudged} unjudged · ` +
            `${unanswerable} unanswerable  across ${files.length} declared source(s), ${runs} answering run(s)${RESET}`,
        );
        if (unanswerable > 0) {
          console.log(
            `  ${YELLOW}!${RESET} ${unanswerable} block(s) nobody could judge  ${DIM}a caller attempted and failed —` +
              ` \`claims judge <file>\` names the run; this is the machinery, not the corpus${RESET}`,
          );
        }
        if (unreadable > 0) {
          console.log(
            `  ${YELLOW}!${RESET} ${unreadable} declared source(s) could not be read  ${DIM}a reader that failed, not an empty file${RESET}`,
          );
        }
        if (malformed > 0) {
          // store.mjs's premise is that corrupt lines are COUNTED on read and
          // never silently skipped. Counting them and not printing them is the
          // same silence one layer up.
          console.log(
            `  ${YELLOW}!${RESET} ${malformed} malformed line(s) in the claim/run stores  ${DIM}counted on read, not skipped — they are not judgments and never will be${RESET}`,
          );
        }
      }
    } catch (err) {
      // Absence must be attributable — never let a thrown reader read as "nothing to judge".
      console.log(`  ${YELLOW}!${RESET} judgment states  ${DIM}could not be derived: ${err.message}${RESET}`);
    }
  }

  console.log(`\n${BOLD}# Graph integration${RESET}`);
  {
    const graphResult = await checkGraphMcpStatus();
    const ageMin = Math.max(0, Math.round((Date.now() - graphResult.checkedAt) / 60_000));
    const cacheNote = graphResult.fromCache ? ` (cached ${ageMin}m ago)` : "";
    if (graphResult.status === "registered") {
      check("code-review-graph MCP registered", true, cacheNote.trim());
    } else if (graphResult.status === "not-registered") {
      console.log(`  ${YELLOW}!${RESET} code-review-graph MCP not registered  ${DIM}(V1 expected; see TM-064)${cacheNote}${RESET}`);
    } else if (graphResult.status === "timeout") {
      // Explicit unknown state, not a pass and not a silent skip: "I could
      // not look" must read differently from "I looked and it's fine".
      console.log(`  ${YELLOW}!${RESET} graph integration check timed out after 2s — status unknown${DIM}${cacheNote}${RESET}`);
    } else {
      console.log(
        `  ${YELLOW}!${RESET} graph integration check failed — status unknown  ${DIM}${graphResult.detail || ""}${cacheNote}${RESET}`,
      );
    }
  }

  console.log(`\n${BOLD}# Discovery integrity${RESET}`);
  // Extracted to lib/report/doctor/discovery.mjs (#31 T2). Grouped by which
  // accumulators it owns — ledger.malformed and plist.watchpaths, and nothing
  // else writes them — rather than by topic; the module doc says why, and why a
  // finer split is easy from there but was not done in this pass.
  {
    const { checkDiscovery } = await import("../lib/report/doctor/discovery.mjs");
    const reporter = new Reporter();
    const { counts } = await checkDiscovery({ reporter });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    ledgerMalformedTotal = counts.ledgerMalformed;
    plistWatchpathsCount = counts.plistWatchpaths;
  }

  console.log(`\n${BOLD}# Undiscoverable ledgers (informational)${RESET}`);
  console.log(
    `  ${DIM}ledgers findLedgersUnder() reaches that discovery would not — see lib/edges/refs.mjs header. Never a doctor failure.${RESET}`,
  );
  try {
    const undiscoverableReport = await undiscoverableLedgersReport(SEARCH_ROOTS);
    if (undiscoverableReport.status === "no-roots") {
      info("undiscoverable-ledger scan", "no-roots — no search roots configured");
    } else if (undiscoverableReport.status === "walk-failed") {
      info("undiscoverable-ledger scan", `walk-failed — ${undiscoverableReport.error}`);
    } else if (undiscoverableReport.status === "none-found") {
      info("undiscoverable-ledger scan", "none-found");
    } else {
      for (const f of undiscoverableReport.findings) {
        info(
          `undiscoverable ledger (${f.reason})`,
          `${f.path} — ${f.open < 0 ? "open count unreadable" : `${f.open} open row(s)`}`,
        );
      }
    }
  } catch (err) {
    // Reporting must never break doctor (same discipline as the symlink scan above).
    info("undiscoverable-ledger scan", `walk-failed — ${err.message}`);
  }

  // # Instruction budget — per-session load vs the harness warning (plan budget-2).
  // The measurement is lib/report/instructions.mjs; the three assertions are in
  // EXPECTATIONS, so this section prints and hands back scalars, nothing more.
  let instructionsMetrics = {};
  let instructionsContext = {};
  {
    const { checkInstructions } = await import("../lib/report/doctor/instructions.mjs");
    const { INTEGRATIONS } = await import("../lib/core/config.mjs");
    const reporter = new Reporter();
    const r = checkInstructions({ reporter, roots: SEARCH_ROOTS, registryFile: INTEGRATIONS.instructionBudgetFile });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
    instructionsMetrics = r.metrics;
    instructionsContext = r.context;
  }

  // # Unrecorded work (#131): records left uncommitted past N days, branches ahead of or
  // missing an upstream. Warn-only by design (see SEVERITY in the module, and #129).
  {
    const { checkUnrecorded, DEFAULT_DAYS } = await import("../lib/report/doctor/unrecorded.mjs");
    // Env only: doctor's flag allowlist (lib/core/commands.mjs) rejects unknown flags.
    const raw = process.env.PROPAGATE_UNRECORDED_DAYS;
    const parsed = Number(raw);
    const days = raw !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAYS;
    const reporter = new Reporter();
    checkUnrecorded({ reporter, roots: SEARCH_ROOTS, workspaces: WORKSPACES, days });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
  }

  // # Scheduled jobs (workspace-hub#75): launchd jobs that run this tree's code ran recently.
  // Warn-only (SEVERITY in the module); a Mac that was off overnight must not turn doctor red.
  {
    const { checkScheduledJobs } = await import("../lib/report/doctor/scheduled-jobs.mjs");
    const reporter = new Reporter();
    checkScheduledJobs({ reporter, roots: SEARCH_ROOTS, ledgerPath: path.join(CONFIG_ROOT_DIR, "scheduled-jobs-runs.json") });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
  }

  // # Retirement candidates (#298): unadopted systems across every discovered SYSTEMS.md,
  // from scanRetirement, the one candidate function the digest and the glance also read.
  // Warn-only (SEVERITY in the module).
  {
    const { checkRetirement } = await import("../lib/report/doctor/retirement.mjs");
    const reporter = new Reporter();
    checkRetirement({ reporter, workspaces: WORKSPACES, skillDir: SKILL_DIR });
    renderDoctorEntries(reporter.drain());
    problems += reporter.problems;
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

  console.log(`\n${BOLD}# Metrics${RESET}`);
  // docs/OBSERVABILITY.md §6 step 1: persist what doctor already computed
  // above instead of throwing it away. Nothing here is newly derived — every
  // value was already gathered by a check() above; this just tallies it,
  // asserts the calibrated expectations, and records the run.
  {
    // Doc-structure metrics. Deduped by resolved path — workspaces nest, and counting
    // a nested doc twice inflated an earlier census from 1339 to 2219.
    let docsProseOnly = 0;
    let docsSupersedesUnresolvable = 0;
    // Gotchas liveness. `gotchas` is the one kind that can be present, current and
    // correctly reconciled while delivering NOTHING: its entries carry executable
    // triggers, and a trigger that cannot fire is a hazard documented but not
    // delivered. N45 measured 3 of 10 inert while --selftest reported green.
    // Staleness checks structurally cannot see this, so it is tallied here.
    //
    // `null` until the walk runs, never 0 — a 0 would assert "every hazard fires"
    // on a scan that never happened (rule:discernment-checks §2).
    let gotchasScanned = null;
    let gotchasFiles = 0;
    const gotchasInert = [];
    // gotchas.untriaged (propagate#216): entries with no `**Status:**` line, over the registers this
    // census already finds PLUS the guard's global index (added inside untriagedGauge, not by widening the census). Worktree and archive copies (path has a .worktrees, archive or _archive
    // segment) are excluded, and what is left is deduped TWICE by sha1 — a register by file content,
    // then an entry by its text — because the same register is reachable from several workspaces.
    // The census itself dedupes only by resolved path, so this dedupe is this gauge's own.
    // null, never 0, when any register could not be read or the walk did not run. No fixed floor on
    // the number of registers: a fresh install has none and 0 is the true count there.
    const untriagedFiles = []; // census registers; untriagedGauge() adds the guard's global index
    try {
      const { proseOnlySupersession, kindOf } = await import("../lib/report/doc-kind.mjs");
      const { selftestProblems } = await import("../lib/gotchas/parse.mjs");
      const { globSync } = await import("node:fs");
      const seenDocs = new Set();
      for (const ws of WORKSPACES) {
        let found = [];
        let gotchasExtra = [];
        try {
          found = globSync(path.join(ws.root, "**", "docs", "**", "*.md"));
          // The propagation layout is NOT under a `docs/` directory, so the glob
          // above cannot see it. Measured 2026-08-23: the moment two GOTCHAS.md
          // files migrated to propagation/state/, this census fell 9 -> 7 and
          // would have reported the migration as REDUCING adoption. A metric that
          // moves because the file moved is measuring the walk, not the tree.
          //
          // Kept SEPARATE from `found`, deliberately. Folding these 21 files into
          // the shared loop pushed docs.supersession_prose_only from 101 to 104 and
          // tripped its ratchet — not because any doc got worse, but because the
          // population grew under a baseline calibrated on the docs/ tree. Widening
          // a scan must never look like a regression in a metric it does not own.
          gotchasExtra = globSync(path.join(ws.root, "**", "propagation", "state", "*", "*.md"));
        } catch {
          continue;
        }
        // 0 ONLY ONCE A GLOB HAS ACTUALLY RUN. This assignment used to sit above
        // the loop, so zero discovered workspaces rendered
        // "0 GOTCHAS.md of 0 docs scanned — none adopted yet" — a confident
        // report of a scan that never happened, three lines under a comment
        // promising the opposite. Review 2026-08-23 reproduced it with an
        // unconfigured HOME.
        //
        // "Found nothing" and "looked at nothing" are different facts and only
        // one is a pass (rule:discernment-checks §2) — which is the rule this
        // census exists to enforce, failing inside its own implementation.
        if (gotchasScanned === null) gotchasScanned = 0;
        // `found` feeds every metric; `gotchasExtra` feeds only the gotchas tally.
        // Set, not Array.includes: the membership test runs once per doc, and
        // an array scan inside that loop is O(docs x extras) for no reason.
        const gotchasExtraSet = new Set(gotchasExtra);
        for (const d of found.concat(gotchasExtra)) {
          if (d.includes("node_modules")) continue;
          const abs = path.resolve(d);
          if (seenDocs.has(abs)) continue;
          seenDocs.add(abs);
          gotchasScanned++;
          // ONE kindOf per doc. It reads the file to parse frontmatter, so the
          // gotchas check and the supersedes loop calling it separately meant
          // 1,326 redundant reads per `doctor` run — added by the gotchas census
          // and invisible because the result was still correct.
          const kind = kindOf(abs);
          if (kind.kind === "gotchas") {
            gotchasFiles++;
            if (!/[\\/](\.worktrees|archive|_archive)[\\/]/.test(abs)) untriagedFiles.push(abs);
            const problems = selftestProblems([abs]);
            if (problems.length) gotchasInert.push({ file: abs, problems });
          }
          if (gotchasExtraSet.has(d)) continue; // ratchet-bearing metrics below own the docs/ tree only
          if (proseOnlySupersession(abs)) docsProseOnly++;
          for (const t of kind.supersedes) {
            const [rel] = t.split("#");
            if (!existsSync(path.resolve(path.dirname(abs), rel))) docsSupersedesUnresolvable++;
          }
        }
      }
    } catch {
      // Leave both at 0 rather than crashing doctor; the expectations below treat
      // "0 because it never ran" the same as "0 because it is clean", which is the one
      // weakness here and is why the prose ratchet is a floor, not an equality.
      //
      // gotchasScanned deliberately does NOT share that weakness: it stays null if the
      // walk threw before starting, so "looked at nothing" cannot render as "found
      // nothing". Reproducing the known weakness in new code would be choosing it.
    }

    // INFORMATIONAL, not a check(). Not every repo needs a GOTCHAS.md — a doc-only
    // husk has no hazards to record — so failing a build on adoption would train
    // people to ignore the line. What must never happen is silence: the count was
    // last measured by hand, written into rule:every-project-carries-gotchas, and
    // was five days stale by the time anyone read it. Derive it, do not restate it.
    if (gotchasScanned === null) {
      info("gotchas", "not scanned — the doc walk did not run, so adoption is UNKNOWN, not zero");
    } else {
      // Always name the denominator. "3 files" is not checkable later; "3 of 412
      // docs scanned" is, and it is the difference between a fact and a number.
      info(
        "gotchas",
        `${gotchasFiles} GOTCHAS.md of ${gotchasScanned} docs scanned` +
          (gotchasFiles === 0 ? " — none adopted yet" : ""),
      );
      // "no entries parsed" is a FORMAT problem, not an inert-trigger problem.
      const unreadable = gotchasInert.filter((g) => g.problems.some((p) => /0 carry a \*\*Trigger/.test(p)));
      const inertEntries = gotchasInert.filter((g) => !unreadable.includes(g));
      if (gotchasInert.length) {
        // The failure the file exists to prevent, reported as green. Name the file
        // AND the entry: "2 inert" without the offender is not actionable.
        warn(
          "gotchas inert",
          // TWO DIFFERENT FACTS, and collapsing them hid the worse one. A file
          // whose entries parse but cannot fire is one problem; a file the
          // parser cannot read AT ALL is another, and the second is bigger
          // because nothing in it is reachable.
          //
          // Measured 2026-08-24: the single flagged file was
          // PanditPawanKaushik/docs/gemstone-storefront/shopify/GOTCHAS.md —
          // 478 lines of real, current hazards using `### 1.1` headings instead
          // of `### G1 ·`, so parseEntries returns ZERO entries. Reporting that
          // as "carries an entry that cannot fire" describes a file that has no
          // entries to fire, and buries the fact that the whole file is dark.
          `${unreadable.length} unreadable, ${inertEntries.length} with an entry that cannot fire` +
            ` (of ${gotchasFiles} file(s))`,
        );
        for (const g of gotchasInert.slice(0, 3)) {
          info("", `${shortPath(g.file)} — ${g.problems[0]}`);
        }
        if (gotchasInert.length > 3) info("", `… and ${gotchasInert.length - 3} more`);
      }
    }

    // Graph shape. Derived here rather than in the loop above because it needs
    // the whole reconcile pass, and it is the only metric that can fail for a
    // structural reason (a cycle) rather than a content one. A failure that
    // reports "1 cycle" without naming the pair is not actionable, so the
    // members are carried into the detail via graphCycleMembers.
    // NOT its own check(): a graph failure is a reconcile failure, and
    // "reconcile completes" above already owns that. Adding a second label
    // would have meant a second check nothing could make fail — the exact G1
    // debt tests/doctor-check-coverage.test.mjs exists to stop growing.
    //
    // When the rows are unavailable the metrics stay NULL, never 0. A 0 here
    // would assert "no cycles" on a derivation that never ran, which is the
    // silent-pass failure of rule:discernment-checks §2. null fails the
    // equality assertions below and says why.
    let graphCycles = null;
    let graphDuplicatePairs = null;
    const graphCycleMembers = [];
    const graphDuplicateDetails = [];
    if (doctorReconcileRows) {
      const { buildGraph } = await import("../lib/graph/graph.mjs");
      const g = buildGraph(doctorReconcileRows, { workspaceRoots: WORKSPACES.map((w) => w.root) });
      graphCycles = g.stats.cycles;
      graphDuplicatePairs = g.stats.duplicatePairs;
      for (const c of g.sccs) graphCycleMembers.push(c.map(shortPath).join(" <-> "));
      for (const d of g.duplicatePairs) {
        graphDuplicateDetails.push(
          `${shortPath(d.from)} -> ${shortPath(d.to)} (${d.edges.map((e) => e.edge_id).join(", ")})`,
        );
      }
    }

    let gotchasUntriaged = null;
    let gotchasUntriagedReason = null;
    if (gotchasScanned === null) {
      gotchasUntriagedReason = "the doc walk did not run";
    } else {
      const { untriagedGauge } = await import("../lib/gotchas/parse.mjs");
      const g = untriagedGauge(untriagedFiles);
      gotchasUntriaged = g.count;
      gotchasUntriagedReason = g.reason;
    }

    const metrics = {
      "workspaces.discovered": WORKSPACES.length,
      "gotchas.untriaged": gotchasUntriaged,
      "graph.cycles": graphCycles,
      "graph.duplicate_pairs": graphDuplicatePairs,
      "docs.supersession_prose_only": docsProseOnly,
      "docs.supersedes_unresolvable": docsSupersedesUnresolvable,
      "sidecars.loaded": sidecarsLoadedCount,
      "sidecars.rejected": sidecarsRejectedCount,
      "sidecars.problems": sidecarsProblemsCount,
      "ledger.unknown_types": ledgerUnknownTypesTotal,
      "ledger.malformed": ledgerMalformedTotal,
      "rows.open": rowsOpenTotal,
      "decisions.entries": decisionsEntriesCount,
      "decisions.with_tokens": decisionsWithTokensCount,
      "plist.watchpaths": plistWatchpathsCount,
      ...instructionsMetrics,
      "doctor.duration_ms": Date.now() - doctorStart,
      // Placeholder — the real value (this run's final `problems` count,
      // including the metrics checks below) is assigned right before
      // appendMetricsRecord. The KEY must exist here already: the
      // vanished-key comparison below runs before that assignment, and
      // comparing against a metrics object that hasn't grown its own
      // "doctor.problems" key yet would make the metric look vanished on
      // EVERY run — a self-inflicted instance of the exact R6 failure this
      // check exists to catch.
      "doctor.problems": 0,
    };

    // R6: a metric key that was emitted last run and is silent this run is a
    // violation distinct from an out-of-range value — a vanished signal is the
    // same silent absence one level up. Read the PREVIOUS record before this
    // run's is appended.
    const previousRecord = await readLastMetricsRecord(METRICS_PATH);
    const vanished = detectVanishedKeys(metrics, previousRecord?.metrics ?? null);
    for (const key of vanished) {
      check(
        `metric still emitted: ${key}`,
        false,
        `present in the previous run (${previousRecord.run_id}, ${previousRecord.ts}), absent from this one`,
      );
    }
    // A DECLARED retirement is reported, not suppressed. It is not a failure —
    // somebody removed it on purpose — but it must not be silent either, or the
    // first run after a retirement is indistinguishable from a collector that
    // quietly stopped emitting (rule:discernment-checks §2).
    for (const r of RETIRED_METRICS) {
      if (previousRecord?.metrics && r.key in previousRecord.metrics && !(r.key in metrics)) {
        info(`metric retired: ${r.key}`, `withdrawn ${r.retired} — ${String(r.reason).split(".")[0]}`);
      }
    }

    // G16: these are predictions, not targets — a violation here is real
    // information, never something to tune away by loosening the assertion.
    // G20: context carries the exact-offender detail the (now-informational)
    // inline checks above used to print, so the sole assertion here is at
    // least as informative as the two-mechanism version it replaced.
    const violations = evaluateExpectations(metrics, EXPECTATIONS, {
      searchRoots: SEARCH_ROOTS,
      searchRootsExplain: WORKSPACES.length === 0 ? searchRootsExplain() : null,
      decisionsPath,
      decisionsZeroEntries,
      ledgerUnknownTypesDetails,
      sidecarsRejectedDetails,
      graphCycleMembers,
      graphDuplicateDetails,
      instructionsContext,
      gotchasUntriagedReason,
    });
    for (const v of violations) {
      const detailPrefix = v.detail ? `${v.detail} — ` : "";
      check(v.describe, false, `${detailPrefix}observed ${JSON.stringify(v.observed)} — ${v.basis}`, v.action);
    }
    if (violations.length === 0) {
      check("all calibrated expectations hold", true, `${EXPECTATIONS.length} checked`);
    }
    info(
      "uncalibrated metrics recorded, not asserted",
      UNCALIBRATED.map((u) => u.key).join(", "),
    );

    // THE SETTLE GAUGE (Plan 3 D5). Derived from the ledger -- see the module for
    // what it excludes. Info only and uncalibrated: a median over a few gaps is a
    // reading, and asserting a threshold on it would be the invention G16 forbids.
    try {
      const { sessionGapMedian, describeCadence } = await import("../lib/report/verify-cadence.mjs");
      const { events: cadenceEvents } = await edgeEventIndex();
      info("verify cadence (uncalibrated, not asserted)", describeCadence(sessionGapMedian(cadenceEvents)));
    } catch (err) {
      // A gauge that cannot be read says so; it must not read as "no data yet".
      info("verify cadence (uncalibrated, not asserted)", `could not derive — ${String(err?.message ?? err)}`);
    }

    // Recorded AFTER the checks above so doctor.problems reflects the true
    // final count, including any violation/vanished-key checks just run.
    metrics["doctor.problems"] = problems;
    const record = await appendMetricsRecord(metrics, { metricsPath: METRICS_PATH });
    info("metrics recorded", `${METRICS_PATH} (run ${record.run_id})`);
  }

  console.log();
  if (problems === 0) {
    console.log(`${GREEN}${BOLD}doctor: all green${RESET}`);
  } else {
    console.log(`${RED}${BOLD}doctor: ${problems} problem${problems === 1 ? "" : "s"} found${RESET}`);
  }

  // `exitProcess: false` is what makes doctor COMPOSABLE. Until 2026-09-17 this
  // function ended in `process.exit()`, so `await doctor()` could never resolve —
  // the process died inside it. Nothing noticed, because nothing had ever tried
  // to use doctor's result: the text output was already on stdout by then, and a
  // caller that awaited it simply never ran its next line. Found while building
  // `doctor --json`, whose captured output vanished with the process.
  //
  // The default is unchanged, so every existing caller exits exactly as before.
  if (!exitProcess) return problems;
  process.exit(problems === 0 ? 0 : 1);
}

/**
 * `doctor [--since <t> | --json | --full]`: the dispatch arms that used to sit inline in cli.mjs, moved verbatim.
 * Each arm ends exactly as it did there (process.exit, process.exitCode, or doctor()'s own exit); nothing is returned.
 * @param {string[]} argv the arguments after `doctor`
 */
export async function doctorCmd(argv) {
  if (argv.includes("--since")) {
    // `doctor --since <t>` — OBSERVABILITY §6 step 4, TODOS PR-028.
    //
    // A QUERY OVER metrics.jsonl, NOT A DOCTOR RUN. That is the whole value: §6
    // step 1 records that doctor is point-in-time so a regression between
    // invocations is invisible, and this makes the history answerable in
    // milliseconds instead of by re-running a check that takes minutes.
    //
    // THE OUTPUT SAYS IT RAN NO CHECKS, first line, every time. A metrics summary
    // printed under the word `doctor` otherwise reads as "doctor ran and is happy",
    // which is N87's failure — green meaning the checks it ran, over the workspaces
    // it listed — reproduced in a new command.
    const { parseSince, summariseSince, readMetricsRecords, METRICS_PATH, UNCALIBRATED, EXPECTATIONS } =
      await import("../lib/report/metrics.mjs");
    const i = argv.indexOf("--since");
    const asJson = argv.includes("--json");
    let since;
    try {
      since = parseSince(argv[i + 1]);
    } catch (err) {
      // REFUSE, never widen. A tolerated bad spec silently becomes a wide window,
      // and an empty wide window reads as "nothing wrong".
      if (asJson) console.log(JSON.stringify({ ok: false, reason: String(err.message) }, null, 2));
      else console.error(`${RED}${err.message}${RESET}`);
      process.exit(2);
    }
    const sum = summariseSince(await readMetricsRecords(), since.at, { label: since.label });
    if (asJson) {
      console.log(JSON.stringify({ ok: true, ran_checks: false, source: METRICS_PATH, ...sum }, null, 2));
    } else if (sum.reason) {
      // Attributable absence. "No runs in that window" and "every metric held
      // steady" are different facts and only one is reassuring.
      console.log(`\n  ${YELLOW}no data${RESET} — ${sum.reason}`);
      console.log(`  ${DIM}source ${METRICS_PATH.replace(HOME_DIR, "~")}; this command RAN NO CHECKS${RESET}\n`);
    } else {
      console.log(`\n  ${DIM}metrics history only — THIS COMMAND RAN NO CHECKS. Run \`doctor\` for that.${RESET}`);
      console.log(`  ${sum.runs} doctor run(s) ${sum.window}, of ${sum.records} record(s) — ${sum.from} .. ${sum.to}\n`);
      const moved = sum.metrics.filter((m) => m.delta !== null && m.delta !== 0);
      const odd = sum.metrics.filter((m) => m.vanished || m.appeared);
      if (!moved.length && !odd.length) {
        console.log(`  every one of ${sum.metrics.length} metric(s) ended where it started${RESET}`);
      }
      for (const m of moved) {
        const arrow = m.delta > 0 ? `+${m.delta}` : String(m.delta);
        const u = UNCALIBRATED.find((x) => x.key === m.key);
        const cal = u ? `\n${" ".repeat(36)}${DIM}uncalibrated — ${String(u.reason).split(".")[0]}${RESET}` : "";
        console.log(`  ${m.key.padEnd(32)} ${String(m.first).padStart(9)} -> ${String(m.last).padEnd(9)} ${arrow.padStart(8)}   ${DIM}min ${m.min} max ${m.max}${RESET}${cal}`);
      }
      // A key that stopped being recorded is not a key that went to zero — the
      // distinction detectVanishedKeys exists for, held across a window.
      for (const m of odd) {
        console.log(`  ${YELLOW}!${RESET} ${m.key} ${m.vanished ? "VANISHED during the window" : "APPEARED during the window"} ${DIM}(seen in ${m.runsSeen} of ${sum.runs} runs)${RESET}`);
      }
      // THE GENERAL FORM OF N115, and the question nothing else asks: which gauges
      // have not moved at all? `state.tracked_files` read 0 on 831 consecutive runs
      // because it measured a deleted file, and being uncalibrated made that
      // unfalsifiable. A constant gauge is not proof of death — `graph.cycles` is
      // legitimately always 0 — so this NAMES them rather than failing, and splits
      // them by whether EXPECTATIONS asserts the value.
      //
      // THE LIMIT, stated because the first version overclaimed: this can only see
      // EXPECTATIONS. A gauge asserted by an inline `check()` in a doctor module —
      // `plist.watchpaths` is — looks unexamined here and is not. So the output
      // names what it can see and tells the reader where to look, rather than
      // asserting that nothing covers the key.
      const flat = sum.metrics.filter((x) => x.delta === 0 && !x.vanished && !x.appeared);
      if (flat.length) {
        const asserted = new Set(EXPECTATIONS.map((e) => e.key));
        const unexamined = flat.filter((x) => !asserted.has(x.key));
        console.log(`  ${DIM}${flat.length} gauge(s) did not move; ${flat.length - unexamined.length} of those are asserted, so a constant is known good${RESET}`);
        if (unexamined.length) {
          console.log(`  ${DIM}unmoved and NOT in EXPECTATIONS — check whether an inline doctor check covers each (N115's shape):${RESET}`);
          for (const x of unexamined) {
            const exempt = UNCALIBRATED.some((u) => u.key === x.key);
            console.log(`    ${DIM}${x.key} = ${x.last} across all ${x.runsSeen} run(s)${exempt ? " — declared UNCALIBRATED, so genuinely unexamined" : " — may be covered by an inline check(); EXPECTATIONS is all this can see"}${RESET}`);
          }
        }
      }
      console.log("");
    }
  } else if (argv.includes("--json")) {
    // `--json` CAPTURES doctor's own output and classifies it, rather than
    // instrumenting Reporter. Measured 2026-09-17 before building: doctor prints
    // 561 marked lines and 31 headers, while the doctor region of this file holds
    // 31 direct `console.log` calls that never touch a Reporter. A reporter-only
    // JSON would therefore be silently INCOMPLETE — whole sections missing from a
    // payload that looks whole, which is the defect N87 filed against doctor
    // itself.
    //
    // Deriving from the rendered lines buys the property that matters: the JSON
    // and the text CANNOT disagree, because one is a function of the other. A
    // future section that prints without a Reporter still appears.
    //
    // Text mode is untouched — the capture installs only on this branch.
    const { buildDoctorJson } = await import("../lib/report/doctor/structure.mjs");
    const captured = [];
    const realLog = console.log;
    console.log = (...args) => { captured.push(args.join(" ")); };
    let failed = null;
    let problems = 0;
    try {
      // `exitProcess: false` is load-bearing — see doctor()'s own note. With the
      // default, the process dies inside this await and nothing below ever runs.
      problems = await doctor({ exitProcess: false });
    } catch (err) {
      failed = String(err?.message ?? err);
    } finally {
      console.log = realLog; // restore in `finally`, or a throw silences the CLI
    }
    // A doctor that threw must not emit a plausible-looking healthy payload
    // (rule:discernment-checks §6). The error rides IN the expected shape so a
    // consumer renders the reason instead of an empty, calm-looking card.
    const payload = buildDoctorJson(captured, { problems, generatedAt: new Date().toISOString() });
    if (failed) payload.error = failed;
    await writeGlanceAfterDoctor(payload);
    console.log(JSON.stringify(payload));
    process.exitCode = failed || problems > 0 ? 1 : 0;
  } else if (argv.includes("--full")) {
    await doctor();
  } else {
    // The DEFAULT view is the full view, folded (#107). Same capture as `--json`
    // above and for the same reason: ~31 doctor console.log calls never touch a
    // Reporter, so folding the rendered lines is the only fold that cannot omit a
    // section. The exit code comes from `problems`, exactly as `--json` derives
    // it, so the folded default and `--full` cannot disagree about pass/fail.
    const { foldDoctorLines } = await import("../lib/report/doctor/fold.mjs");
    const captured = [];
    const realLog = console.log;
    console.log = (...args) => { captured.push(args.join(" ")); };
    let problems = 0;
    try {
      problems = await doctor({ exitProcess: false });
    } catch (err) {
      // A doctor that threw must not swallow what it had printed: show the
      // full capture, then let the error propagate as it did before folding.
      console.log = realLog;
      for (const l of captured) console.log(l);
      throw err;
    } finally {
      console.log = realLog;
    }
    // The verdict FIRST (propagate#295): doctor prints it last, after ~190 lines, so it is lifted to the top too.
    const verdict = captured.findLast((l) => /doctor: (all green|\d+ problems? found)/.test(stripAnsiText(l)));
    if (verdict) console.log(verdict);
    for (const l of foldDoctorLines(captured, { dim: DIM, yellow: YELLOW, reset: RESET })) console.log(l);
    const { buildDoctorJson } = await import("../lib/report/doctor/structure.mjs");
    await writeGlanceAfterDoctor(buildDoctorJson(captured, { problems, generatedAt: new Date().toISOString() }));
    process.exitCode = problems > 0 ? 1 : 0;
  }
}
