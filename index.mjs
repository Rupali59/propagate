#!/usr/bin/env node
/**
 * /propagate index — CLI over the derived SQLite index (index.db).
 *
 * Storage is derived and disposable: `rm index.db && node index.mjs --rebuild`
 * must always reproduce identical query output, because REBUILD SEMANTICS is
 * full re-read + drop/recreate every time, never incremental. See
 * lib/index-db.mjs for the rationale.
 *
 * Usage:
 *   node index.mjs --rebuild [--json]
 *   node index.mjs --query open-drift [--json]
 *   node index.mjs --query decisions-since [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
 *   node index.mjs --query affects <repo> [--json]
 *   node index.mjs --query stale-state [--json]
 *   node index.mjs --query open-older-than <days> [--json]
 *   node index.mjs --query unknown-types [--json]
 *   node index.mjs --sql "<read-only SQL>" [--json]
 */

import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";

import { SEARCH_ROOTS, SKILL_DIR } from "./lib/config.mjs";
import {
  rebuildIndex,
  openDb,
  tableCounts,
  queryOpenDrift,
  queryDecisionsSince,
  queryAffects,
  queryStaleState,
  queryOpenOlderThan,
  queryUnknownTypes,
  runReadOnlySql,
} from "./lib/index-db.mjs";
import { scanSkills, probeTranscripts } from "./lib/skills-scan.mjs";

export const DB_PATH = path.join(SKILL_DIR, "index.db");

export function doRebuild(dbPath = DB_PATH, roots = SEARCH_ROOTS, skillDir = SKILL_DIR) {
  const result = rebuildIndex({ dbPath, roots, skillDir, scanSkillsFn: scanSkills, probeTranscriptsFn: probeTranscripts });
  result.db.close();
  return {
    timingsMs: result.timingsMs,
    counts: result.counts,
    coverageGapCount: result.counts.coverage_gap,
    markersSeen: result.discovery.markersSeen,
    workspacesDiscovered: result.discovery.workspaces.length,
  };
}

function openReadDb(dbPath = DB_PATH) {
  if (!existsSync(dbPath)) {
    throw new Error(`propagate-index: ${dbPath} does not exist — run --rebuild first`);
  }
  return openDb(dbPath);
}

function runCannedQuery(name, args, dbPath = DB_PATH) {
  const db = openReadDb(dbPath);
  try {
    switch (name) {
      case "open-drift":
        return queryOpenDrift(db);
      case "decisions-since": {
        const fromIdx = args.indexOf("--from");
        const toIdx = args.indexOf("--to");
        const from = fromIdx >= 0 ? args[fromIdx + 1] : null;
        const to = toIdx >= 0 ? args[toIdx + 1] : null;
        return queryDecisionsSince(db, { from, to });
      }
      case "affects": {
        const repo = args.find((a) => !a.startsWith("--"));
        if (!repo) throw new Error("propagate-index: --query affects requires a <repo> argument");
        return queryAffects(db, repo);
      }
      case "stale-state":
        return queryStaleState(db);
      case "open-older-than": {
        const daysArg = args.find((a) => !a.startsWith("--"));
        const days = parseInt(daysArg, 10);
        if (!Number.isFinite(days)) throw new Error("propagate-index: --query open-older-than requires <days>");
        return queryOpenOlderThan(db, days);
      }
      case "unknown-types":
        return queryUnknownTypes(db);
      default:
        throw new Error(`propagate-index: unknown canned query "${name}"`);
    }
  } finally {
    db.close();
  }
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");

  if (args.includes("--rebuild")) {
    const t0 = Date.now();
    const report = doRebuild();
    const wall = Date.now() - t0;
    if (json) {
      console.log(JSON.stringify({ wallMs: wall, ...report }, null, 2));
    } else {
      console.log(`propagate-index: rebuilt in ${wall}ms`);
      console.log(`  sweep: ${report.timingsMs.sweep}ms, total: ${report.timingsMs.total}ms`);
      console.log(`  markers seen: ${report.markersSeen}, workspaces discovered: ${report.workspacesDiscovered}`);
      for (const [table, count] of Object.entries(report.counts)) {
        console.log(`  ${table}: ${count}`);
      }
    }
    return;
  }

  const queryIdx = args.indexOf("--query");
  if (queryIdx >= 0) {
    const name = args[queryIdx + 1];
    const rest = args.slice(queryIdx + 2).filter((a) => a !== "--json");
    const rows = runCannedQuery(name, rest);
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log(`${name}: ${rows.length} row(s)`);
      for (const r of rows) console.log(JSON.stringify(r));
    }
    return;
  }

  const sqlIdx = args.indexOf("--sql");
  if (sqlIdx >= 0) {
    const sql = args[sqlIdx + 1];
    const db = openReadDb();
    let rows;
    try {
      rows = runReadOnlySql(db, sql);
    } finally {
      db.close();
    }
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log(`${rows.length} row(s)`);
      for (const r of rows) console.log(JSON.stringify(r));
    }
    return;
  }

  console.error(
    "usage: node index.mjs --rebuild | --query <name> [args] | --sql \"<read-only SQL>\"  [--json]",
  );
  process.exit(1);
}

const _invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (_invokedDirectly) {
  main();
}
