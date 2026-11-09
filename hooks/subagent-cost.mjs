#!/usr/bin/env node
/**
 * SubagentStop — append one cost row for the lane that just finished (propagate#188).
 *
 * The payload carries NO token, cost or duration field (docs, measured 2026-11-06), so the
 * row is built from the subagent's own transcript (`agent_transcript_path`) and the
 * `agent-<id>.meta.json` beside it. See lib/core/costs.mjs for the store and why.
 *
 * Contract:
 *   stdin  — the SubagentStop payload
 *   exit 0 — ALWAYS, with nothing on stdout. A cost recorder must never change how a
 *            session ends, and a hook that wedges the session gets disabled wholesale.
 *   Failures are not invisible: each is one line in $PROPAGATE_STATE_DIR/costs/errors.log
 *   (default ~/.propagate/costs/errors.log), so "no row" is attributable.
 *   An internal agent (empty agent_type AND transcript ENOENT) writes no row, only that log line (#223).
 *   `stop_hook_active: true` writes nothing (the hook is already re-entering).
 *
 * Root is derived from this file's location, as doc-authority.mjs does; costs.mjs is
 * imported dynamically so that a load failure is caught and logged instead of crashing
 * Node with exit 1.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stateDir } from "../lib/core/paths.mjs";

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Standalone, so it works even when costs.mjs failed to load. */
function logError(message) {
  try {
    // stateDir() is env-aware (PROPAGATE_STATE_DIR) and the only allowed home for this root
    // (tests/portability/path-registry-literals). paths.mjs imports only node builtins, so it
    // cannot be the thing that failed to load.
    const dir = path.join(stateDir(), "costs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, "errors.log"),
      `${new Date().toISOString()} subagent-cost: ${String(message).replace(/\s+/g, " ").slice(0, 500)}\n`,
    );
  } catch {
    /* nowhere left to report to */
  }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch (err) {
    logError(`unparseable stdin payload: ${err?.message ?? err}`);
    return;
  }
  if (!payload || typeof payload !== "object") {
    logError("stdin payload is not an object");
    return;
  }
  if (payload.stop_hook_active === true) return;

  const costs = await import(pathToFileURL(path.join(ROOT, "lib", "core", "costs.mjs")).href);

  const transcript = payload.agent_transcript_path;
  if (typeof transcript !== "string" || !transcript) {
    logError(`payload for agent ${payload.agent_id ?? "?"} has no agent_transcript_path`);
    return;
  }

  let meta = {};
  try {
    meta = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch (err) {
    logError(`agent ${payload.agent_id ?? "?"}: meta.json unreadable (${err?.code || err?.message}); row written without it`);
  }

  const summary = costs.summarizeTranscript(transcript);
  if (costs.isInternalAgentWithoutTranscript(payload, meta, summary)) {
    // #223: not a lane. The errors.log line is the attributable trace (no new file format).
    logError(`internal agent ${payload.agent_id ?? "?"} skipped: no agent_type, no transcript; no row written`);
    return;
  }
  if (summary.unreadable || summary.empty) {
    logError(`agent ${payload.agent_id ?? "?"}: transcript ${summary.unreadable ? "unreadable (" + summary.reason + ")" : "has no assistant usage"}; row written with usage:null`);
  }
  const ok = !summary.unreadable && !summary.empty;
  const startReading = ok ? costs.readingAt(costs.samplesPath(), summary.start) : { missing: "no transcript timestamps" };
  const endReading = ok ? costs.readingAt(costs.samplesPath(), summary.end) : { missing: "no transcript timestamps" };

  costs.appendCostSync(costs.buildCostRow(payload, meta, summary, startReading, endReading));
}

main()
  .catch((err) => logError(err?.stack ?? err))
  .finally(() => process.exit(0));
