#!/usr/bin/env node
/**
 * Notification hook (propagate#445): queue the session that just asked for the user, for `propagate attention next`.
 *
 * Claude Code's Notification input carries session_id, cwd, hook_event_name, message and notification_type. The tab is
 * found from the process tree: walk parent pids with `ps -o ppid=,tty= -p <pid>` until one has a controlling tty.
 * PROPAGATE_PS_BIN overrides `ps` (tests).
 *
 * Never blocks, always exit 0, silent on any error and inside a subagent (agent_type set). DEPENDENCY-FREE.
 * Needs /reload-plugins after hooks.json changes.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { stateDir } from "../../lib/core/paths.mjs";
import { append, normTty, queueFile } from "./queue.mjs";

export function findTty(startPid, ps = process.env.PROPAGATE_PS_BIN || "ps") {
  let pid = startPid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const r = spawnSync(ps, ["-o", "ppid=,tty=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 });
    const [ppid, tty] = String(r.stdout ?? "").trim().split(/\s+/);
    if (normTty(tty)) return normTty(tty);
    pid = Number(ppid);
    if (!Number.isFinite(pid)) break;
  }
  return "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    if (!input?.agent_type && input?.hook_event_name === "Notification" && typeof input.session_id === "string" && input.session_id) {
      append(queueFile(stateDir()), {
        session_id: input.session_id,
        tty: findTty(process.ppid),
        cwd: input.cwd,
        message: input.message,
        notification_type: input.notification_type,
      });
    }
  } catch {
    /* a queue must never wedge a notification */
  }
  process.exit(0);
}
