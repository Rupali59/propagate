#!/usr/bin/env node
/**
 * scripts/costs-backfill.mjs — one-shot back-fill of the cost ledger (propagate#188).
 *
 *   node scripts/costs-backfill.mjs [--widget] [--transcript <agent-*.jsonl>]... [--samples <path>] [--apply]
 *
 * DRY RUN BY DEFAULT: without --apply it prints the rows it would write and touches the
 * store not at all (rule:safety-flag-needs-a-test; tests/unit/costs.test.mjs snapshots the
 * store bytes before and after). --apply is the only path that reaches appendCostSync.
 *
 * Idempotent: every back-fill row carries a `backfill_key`; a row whose key is already in the
 * store is skipped, so re-running --apply cannot double-count.
 *
 *   --widget       the 7 claude-usage-widget lanes from propagate#188's table. Their transcripts
 *                  may be gone, so `usage` is null and `tokens_reported` is labelled as what it is:
 *                  the lane's final API request, NOT its cost (measured 2026-11-06).
 *   --transcript   a real subagent transcript, summarised by costs.mjs like the hook does.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ATTRIBUTION,
  samplesPath as defaultSamplesPath,
  appendCostSync,
  buildCostRow,
  readCosts,
  readingAt,
  summarizeTranscript,
  shardPathForTs,
} from "../lib/core/costs.mjs";

/** From propagate#188's comment, "Back-fill rows, 2026-11-05". Tokens are final-request sizes. */
export const WIDGET_LANES = [
  { issue: "#35", what: "parse per plan", tokens: 215962, minutes: 25.5 },
  { issue: "#53", what: "hook warns only", tokens: 169427, minutes: 13.2 },
  { issue: "#83", what: "embed spend", tokens: 150467, minutes: 15.8 },
  { issue: "#81", what: "costs freshness", tokens: 170071, minutes: 15.2 },
  { issue: "#91", what: "configurable paths", tokens: 275508, minutes: 15.5 },
  { issue: "#92", what: "shellcheck", tokens: 135566, minutes: 3.6 },
  { issue: "#93", what: "Oxlint", tokens: 174189, minutes: 7.0 },
];

export function widgetRows() {
  return WIDGET_LANES.map((l) => ({
    ts: "2026-11-05T00:00:00.000Z",
    ts_precision: "date only (2026-11-05)",
    kind: "lane",
    repo: "Rupali59/claude-usage-widget",
    issue: l.issue,
    description: l.what,
    usage: null,
    usage_status: "not recorded: transcript not summarised",
    tokens_reported: l.tokens,
    tokens_reported_label: "final-request size, not cost",
    minutes: l.minutes,
    week_pct: { missing: "week 63% to 71% across all 7 lanes plus verification: shared, never divided per item" },
    attribution: ATTRIBUTION,
    source: "backfill",
    backfill_key: `widget:${l.issue}`,
  }));
}

export function transcriptRow(transcriptPath, samplesPath) {
  const summary = summarizeTranscript(transcriptPath);
  const base = path.basename(transcriptPath, ".jsonl");
  const agentId = base.replace(/^agent-/, "");
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    /* buildCostRow records the description as null */
  }
  const ok = !summary.unreadable && !summary.empty;
  const payload = {
    // <proj>/<session>/subagents/agent-<id>.jsonl
    session_id: path.basename(path.dirname(path.dirname(transcriptPath))),
    agent_id: agentId,
    agent_type: meta.agentType,
  };
  const none = { missing: "no transcript timestamps" };
  const row = buildCostRow(
    payload,
    meta,
    summary,
    ok ? readingAt(samplesPath, summary.start) : none,
    ok ? readingAt(samplesPath, summary.end) : none,
    { source: "backfill" },
  );
  row.backfill_key = `transcript:${agentId}`;
  return row;
}

export function runBackfill({ widget, transcripts, samplesPath, apply }) {
  const rows = [];
  if (widget) rows.push(...widgetRows());
  for (const t of transcripts) rows.push(transcriptRow(t, samplesPath));

  const present = new Set(readCosts().rows.map((r) => r.backfill_key).filter(Boolean));
  const fresh = rows.filter((r) => !present.has(r.backfill_key));
  const skipped = rows.length - fresh.length;

  if (apply) {
    for (const r of fresh) appendCostSync(r);
  }
  return { rows, fresh, skipped, applied: Boolean(apply) };
}

function main(argv) {
  const transcripts = [];
  let widget = false;
  let apply = false;
  let samplesPath = defaultSamplesPath();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--widget") widget = true;
    else if (a === "--transcript") transcripts.push(path.resolve(argv[++i] ?? ""));
    else if (a === "--samples") samplesPath = path.resolve(argv[++i] ?? "");
    else {
      process.stderr.write(`costs-backfill: unknown argument ${a}\n`);
      return 2;
    }
  }
  if (!widget && transcripts.length === 0) {
    process.stderr.write("costs-backfill: nothing to do (give --widget and/or --transcript <path>)\n");
    return 2;
  }
  for (const t of transcripts) {
    if (!existsSync(t)) {
      process.stderr.write(`costs-backfill: transcript not found: ${t}\n`);
      return 2;
    }
  }

  const { rows, fresh, skipped, applied } = runBackfill({ widget, transcripts, samplesPath, apply });
  for (const r of rows) process.stdout.write(JSON.stringify(r) + "\n");
  process.stdout.write(
    applied
      ? `APPLIED: appended ${fresh.length} row(s), skipped ${skipped} already present.\n`
      : `DRY RUN: would append ${fresh.length} row(s), ${skipped} already present. Store untouched; pass --apply to write` +
          (fresh[0] ? ` (first shard: ${shardPathForTs(fresh[0].ts)}).` : ".") +
          "\n",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
