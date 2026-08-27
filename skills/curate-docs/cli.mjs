#!/usr/bin/env node
/**
 * curate-docs — the markdown doc lifecycle for one repo.
 *
 *   DERIVE ──▶ DECLARE ──▶ SALVAGE ──▶ DRAIN ──▶ RECONCILE
 *   read-only   status:     merge live   git rm    re-run
 *
 *   curate-docs [report] [dir]     the kind-grouped map + triage list   (default)
 *   curate-docs orphans  [dir]     nothing cites it
 *   curate-docs detached [dir]     cited, but unreachable from any entry point
 *   curate-docs dangling [dir]     citations that resolve nowhere
 *   curate-docs graph    [dir]     every node with inDegree / hubDistance / status
 *   curate-docs state    [dir]     the derived lifecycle view (never a stored manifest)
 *   curate-docs state <file> --set archived --because shipped [--apply]
 *   curate-docs impact  <file>     what breaks if this goes away — run BEFORE archiving
 *   curate-docs drain   <file>     delete a declared-dead doc [--apply]
 *
 *   --json  --stale-days N  --out PATH  --extra-root DIR  --exclude-unreviewed  --apply
 *
 * WRITES: `state` and `drain` only, and only with `--apply`. tests/state.test.mjs and
 * tests/drain.test.mjs assert the unsafe path is UNREACHABLE without it by snapshotting every
 * byte of the tree across every disposition — not "the flag is read". Three separate incidents
 * in this tree came from a gate that existed on one code path and not the adjacent one
 * (rule:safety-flag-needs-a-test).
 *
 * EXIT CODES:  0 ok · 1 error · 2 bad usage · 3 taxonomy unavailable · 4 no hub · 5 refused
 */

import { writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "./lib/config.mjs";
import { discover } from "./lib/discovery.mjs";
import { buildLinkGraph, detectVault } from "./lib/link-graph.mjs";
import { loadTaxonomy, TaxonomyUnavailable } from "./lib/taxonomy.mjs";
import { readStatus, setStatus, STATUSES, REASONS } from "./lib/state.mjs";
import { impact, drainPrecheck } from "./lib/impact.mjs";
import { classifyDangling } from "./lib/branches.mjs";
import { gather, lastTouched, declaredState } from "./lib/evidence.mjs";
import { renderMarkdown, verdict } from "./lib/report.mjs";

const MODES = ["report", "orphans", "detached", "dangling", "graph", "state", "impact", "drain"];

function parseArgs(argv) {
  const o = {
    mode: "report", dir: process.cwd(), target: null, json: false, staleDays: null,
    outPath: null, extraRoots: [], apply: false, set: null, because: null,
    supersededBy: null, on: new Date().toISOString().slice(0, 10), excludeUnreviewed: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--apply") o.apply = true;
    else if (a === "--exclude-unreviewed") o.excludeUnreviewed = true;
    else if (a === "--stale-days") o.staleDays = Number(argv[++i]);
    else if (a === "--out") o.outPath = argv[++i];
    else if (a === "--set") o.set = argv[++i];
    else if (a === "--because") o.because = argv[++i];
    else if (a === "--superseded-by") o.supersededBy = argv[++i];
    else if (a === "--on") o.on = argv[++i];
    else if (a === "--extra-root") o.extraRoots.push(path.resolve(argv[++i]));
    else if (a === "-h" || a === "--help") o.help = true;
    else rest.push(a);
  }
  if (rest.length && MODES.includes(rest[0])) o.mode = rest.shift();
  if (rest.length) {
    const p = path.resolve(rest[0]);
    if (["impact", "drain"].includes(o.mode) || (o.mode === "state" && o.set)) {
      o.target = p; o.dir = path.dirname(p);
    } else o.dir = p;
  }
  if (o.staleDays !== null && Number.isNaN(o.staleDays)) throw new Error("--stale-days needs a number");
  if (["impact", "drain"].includes(o.mode) && !o.target) throw new Error(`${o.mode} needs a file path`);
  if (o.mode === "state" && o.set && !STATUSES.includes(o.set)) {
    throw new Error(`--set must be one of ${STATUSES.join(", ")}`);
  }
  if (o.because && !REASONS.includes(o.because)) throw new Error(`--because must be one of ${REASONS.join(", ")}`);
  return o;
}

/** For impact/drain the target names the file; the repo root is found by walking up to a
 *  marker. Never past it — the hub trap (see lib/discovery.mjs). */
function repoRootFor(dir) {
  // `.git` first and alone at each level: STATE.md or package.json can legitimately exist in
  // a subdirectory, and stopping there would analyse a fragment of the repo as if it were
  // the whole. (An earlier version called require() here — a ReferenceError in ESM, silently
  // swallowed by its own try/catch, so every lookup fell back to the file's own directory
  // and `impact` reported "cited by: nothing" for a doc the hub linked.)
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    if (existsSync(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  // No git anywhere above: fall back to the nearest directory carrying a repo marker.
  cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    if ([ "STATE.md", "package.json", "CLAUDE.md" ].some((m) => existsSync(path.join(cur, m)))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.resolve(dir);
}

async function analyse(opts, root) {
  const cfg = loadConfig(root, {
    flags: {
      ...(opts.staleDays !== null ? { staleDays: opts.staleDays } : {}),
      ...(opts.extraRoots.length ? { extraRoots: opts.extraRoots } : {}),
      ...(opts.excludeUnreviewed ? { skipDirs: ["unreviewed"] } : {}),
    },
  });

  const v = detectVault(root);
  if (v.vault) {
    const e = new Error(`refused: ${path.basename(root)} — ${v.why}`);
    e.exitCode = 5;
    throw e;
  }

  const found = discover(root, cfg);
  let taxonomy = null, taxonomyNote;
  try {
    taxonomy = await loadTaxonomy();
    taxonomyNote = `propagate (${path.basename(path.dirname(path.dirname(taxonomy.source)))})`;
  } catch (e) {
    if (!(e instanceof TaxonomyUnavailable)) throw e;
    const globs = Object.keys(cfg.kinds ?? {}).length;
    // Declared fallback, never silent. What was rejected was a SILENT local taxonomy; one
    // the repo declares about itself and that announces itself is a different thing.
    taxonomyNote = globs
      ? `.curate-docs.yml (${globs} glob${globs === 1 ? "" : "s"})`
      : "none — every kind undeclared";
  }

  const graph = buildLinkGraph(root, { docs: found.docs, cfg });
  // A citation to a file that exists on another branch is EARLY, not broken. Splitting these
  // out is what stops someone "fixing" a correct forward reference by deleting it.
  const branchSplit = classifyDangling(root, graph.dangling);
  graph.dangling = branchSplit.broken;
  graph.unmerged = branchSplit.unmerged;
  graph.branchScan = { status: branchSplit.status, refsChecked: branchSplit.refsChecked };
  const staleDays = cfg.staleDays?.default ?? 30;

  const rows = found.docs.map((abs) => {
    const node = graph.nodes.get(abs);
    const k = taxonomy ? taxonomy.kindOf(abs) : kindFromConfig(abs, root, cfg);
    const row = {
      abs,
      rel: path.relative(root, abs).split(path.sep).join("/"),
      kind: k.kind, kindSource: k.source,
      hubName: graph.hubless ? "hub" : "entry points",
      inDegree: node.inDegree, hubDistance: node.hubDistance,
      unreadable: node.unreadable, isHub: node.isSeed, isEntryPoint: node.isEntryPoint,
      isGenerated: node.isGenerated,
      isUnlinkedSeed: graph.unlinkedSeeds.includes(abs),
      status: node.status, statusSource: node.statusSource, statusWhy: node.statusWhy,
      lastTouched: lastTouched(root, abs),
      declaredState: k.kind === "plan" ? declaredState(root, abs, { hub: graph.seeds[0], nodes: graph.nodes }) : null,
      outbound: node.outbound.map((o) => path.relative(root, o).split(path.sep).join("/")),
    };
    row.verdict = verdict(row, staleDays, graph.hubless);
    return row;
  });

  // Provenance costs 4 git spawns per doc, so it is gathered only for what needs triage and
  // capped — an uncapped sweep is ~1,500 spawns on a large repo.
  const CAP = 60;
  const flagged = rows.filter((r) => ["ORPHAN", "DETACHED", "NO-STATE"].includes(r.verdict.flag));
  for (const r of flagged.slice(0, CAP)) r.evidence = gather(root, r.abs, graph, { extraRoots: cfg.extraRoots });
  const provenanceCapped = Math.max(0, flagged.length - CAP);

  return {
    root, rows, graph, cfg, staleDays, taxonomyNote, discovery: found, provenanceCapped,
    counts: {
      docs: found.docs.length,
      orphans: graph.orphans.length, detached: graph.detached.length,
      archived: graph.archived.length, unknownStatus: graph.unknownStatus.length,
      dangling: graph.dangling.length, unmerged: graph.unmerged.length,
      ambiguous: graph.ambiguous.length,
      external: graph.external.length, relinkable: graph.relinkable.length,
    },
  };
}

/** Kind from the repo's own declared globs, used only when propagate is unavailable. */
function kindFromConfig(abs, root, cfg) {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  for (const [glob, kind] of Object.entries(cfg.kinds ?? {})) {
    const rx = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
    if (rx.test(rel)) return { kind, source: "config" };
  }
  return { kind: null, source: "undeclared" };
}

const strip = (r) => ({
  path: r.rel, kind: r.kind, kindSource: r.kindSource, status: r.status, statusSource: r.statusSource,
  inDegree: r.inDegree, hubDistance: r.hubDistance, lastTouched: r.lastTouched,
  declaredState: r.declaredState, verdict: r.verdict, evidence: r.evidence ?? null,
});
const relOf = (root, p) => path.relative(root, p).split(path.sep).join("/");

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }

  if (opts.help) {
    const src = await import("node:fs").then((m) => m.readFileSync(new URL(import.meta.url), "utf8"));
    console.log(src.split("\n").filter((l) => l.startsWith(" *")).map((l) => l.slice(3)).join("\n"));
    return;
  }

  const root = ["impact", "drain"].includes(opts.mode) || (opts.mode === "state" && opts.set)
    ? repoRootFor(opts.dir)
    : opts.dir;

  // `state --set` on one file needs no graph.
  if (opts.mode === "state" && opts.set) {
    const cfg = loadConfig(root, {});
    try {
      const r = setStatus(opts.target, {
        status: opts.set, because: opts.because, supersededBy: opts.supersededBy, on: opts.on,
      }, { apply: opts.apply });
      const cur = readStatus(opts.target, root, cfg);
      if (!r.changed) console.log(`unchanged — ${relOf(root, opts.target)} is already ${cur.status}`);
      else if (r.applied) console.log(`${relOf(root, opts.target)} -> ${opts.set}`);
      else {
        console.log(`WOULD SET ${relOf(root, opts.target)} -> ${opts.set}  (no --apply, nothing written)\n`);
        console.log(r.after.split("\n").slice(0, 8).map((l) => `  | ${l}`).join("\n"));
      }
    } catch (e) { console.error(e.message); process.exit(2); }
    return;
  }

  let result;
  try { result = await analyse(opts, root); }
  catch (e) {
    console.error(e.message ?? String(e));
    process.exit(e.exitCode ?? 1);
  }

  if (["impact", "drain"].includes(opts.mode)) {
    const rel = (p) => relOf(root, p);
    if (opts.mode === "impact") {
      const i = impact(opts.target, result.graph);
      if (opts.json) { console.log(JSON.stringify(i, null, 2)); return; }
      console.log(`${rel(i.path)}  status=${i.status}`);
      console.log(`  cited by      : ${i.callers.length ? i.callers.map(rel).join(", ") : "nothing"}`);
      console.log(`  it cites      : ${i.reaches.length ? i.reaches.map(rel).join(", ") : "nothing"}`);
      console.log(`  SOLE caller of: ${i.soleCallerOf.length ? i.soleCallerOf.map(rel).join(", ") : "nothing"}`);
      if (i.soleCallerOf.length) console.log(`\n  Draining this orphans ${i.soleCallerOf.length} document(s). Re-home them first.`);
      return;
    }
    const pre = drainPrecheck(opts.target, result.graph, root);
    if (opts.json) { console.log(JSON.stringify(pre, null, 2)); process.exit(pre.ok ? 0 : 5); }
    if (!pre.ok) {
      console.error(`refused to drain ${rel(opts.target)}:`);
      for (const r of pre.refusals) console.error(`  - ${r}`);
      process.exit(5);
    }
    const cmd = ["git", "-C", root, "rm", "-q", "--", path.relative(root, opts.target)];
    if (!opts.apply) { console.log(`WOULD RUN (no --apply, nothing removed):\n  ${cmd.join(" ")}`); return; }
    execFileSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
    console.log(`drained ${rel(opts.target)} — recoverable from git history`);
    return;
  }

  // A hub that reaches nothing must never render as a clean run. Suppressing the lists is
  // right; suppressing them quietly is the failure this skill exists to catch.
  if (result.graph.hubless && ["orphans", "detached"].includes(opts.mode)) {
    console.error(`hub: ${result.graph.hubReason}`);
    console.error(`orphan/detached lists suppressed — with no reachable hub every doc would read as an orphan.`);
    console.error(`Set hubSeeds in .curate-docs.yml, or link your entry point to something.`);
    process.exit(4);
  }

  if (opts.mode === "state") {
    const byStatus = {};
    for (const r of result.rows) (byStatus[r.status] ??= []).push(r);
    if (opts.json) { console.log(JSON.stringify(result.rows.map(strip), null, 2)); return; }
    console.log(`# lifecycle — ${path.basename(root)}   (derived, not stored)\n`);
    for (const s of ["unknown", "superseded", "archived", "active"]) {
      const rs = byStatus[s] ?? [];
      if (!rs.length) continue;
      console.log(`## ${s} (${rs.length})`);
      for (const r of rs.slice(0, s === "active" ? 10 : 200)) {
        console.log(`  ${r.rel}\t${r.statusSource}${r.statusWhy ? "  " + r.statusWhy : ""}`);
      }
      if (s === "active" && rs.length > 10) console.log(`  … and ${rs.length - 10} more active`);
      console.log("");
    }
    return;
  }

  const picked = {
    orphans: () => result.rows.filter((r) => r.verdict.flag === "ORPHAN"),
    detached: () => result.rows.filter((r) => r.verdict.flag === "DETACHED"),
    graph: () => result.rows,
  }[opts.mode];

  if (opts.mode === "dangling") {
    if (opts.json) {
      console.log(JSON.stringify({ dangling: result.graph.dangling, ambiguous: result.graph.ambiguous, relinkable: result.graph.relinkable, external: result.graph.external }, null, 2));
      return;
    }
    for (const d of result.graph.dangling) console.log(`${relOf(root, d.from)}\tcites\t${d.cites}\tDANGLING`);
    for (const u of result.graph.unmerged) console.log(`${relOf(root, u.from)}\tcites\t${u.cites}\tUNMERGED\ton ${u.refs.join(", ")}`);
    for (const a of result.graph.ambiguous) console.log(`${relOf(root, a.from)}\tcites\t${a.cites}\tAMBIGUOUS\t${a.reason}`);
    console.log(`\n${result.counts.dangling} dangling, ${result.counts.ambiguous} ambiguous (${result.counts.relinkable} with a single obvious target), over ${result.counts.docs} docs.`);
    return;
  }

  if (picked) {
    const rows = picked();
    if (opts.json) { console.log(JSON.stringify(rows.map(strip), null, 2)); return; }
    for (const r of rows) {
      console.log(`${r.verdict.flag}\t${r.rel}\tkind=${r.kind ?? "undeclared"}\tstatus=${r.status}\tin=${r.inDegree}\thops=${r.hubDistance ?? "-"}\t${r.verdict.why}`);
    }
    console.log(`\n${rows.length} of ${result.counts.docs} docs.`);
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({
      root: result.root, counts: result.counts, taxonomy: result.taxonomyNote,
      discovery: result.discovery.describe, hub: result.graph.hubReason,
      rows: result.rows.map(strip),
    }, null, 2));
    return;
  }
  const md = renderMarkdown(result);
  if (opts.outPath) { writeFileSync(opts.outPath, md); console.error(`wrote ${opts.outPath}`); }
  else process.stdout.write(md);
}

main().catch((e) => { console.error(e.stack ?? String(e)); process.exit(1); });
