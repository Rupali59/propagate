/**
 * One session in full (propagate#272, DX8): the live row, its association, the assoc.jsonl history, the repos, the
 * guidance files for its folder, and the next command for its state.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { fail } from "./errors.mjs";
import { ENDED_LABEL, since } from "./view.mjs";

/**
 * Pick one session from the view by `<id|name>`. Tiers, first tier with a hit wins; more than one hit inside the tier
 * is SESSION_AMBIGUOUS (names are not unique, and `sessionId` is shared by a background and an interactive row):
 *   1. `pid:<n>`   2. the background `id`   3. `sessionId` exact or prefix (6+ chars)   4. the name.
 * Falls back to ended associations (matched on the row snapshot stored with the association).
 * @returns {{ok: true, session?: object, ended?: object} | {ok: false, code: string, what: string, next: string, side_effects: string[]}}
 */
export function selectSession(arg, view) {
  const q = String(arg ?? "").trim();
  if (!q) return fail("SESSION_USAGE", "a session id or name is required", "propagate sessions");
  const tiers = [
    (s) => /^pid:\d+$/.test(q) && s.pid === Number(q.slice(4)),
    (s) => s.id !== "" && s.id === q,
    (s) => s.sessionId === q || (q.length >= 6 && s.sessionId.startsWith(q)),
    (s) => s.name !== "" && s.name === q,
  ];
  for (const t of tiers) {
    const hits = view.sessions.filter(t);
    if (hits.length === 1) return { ok: true, session: hits[0] };
    if (hits.length > 1) {
      const options = hits.map((s) => (s.pid ? `pid:${s.pid}` : s.id || s.sessionId.slice(0, 8)));
      return fail("SESSION_AMBIGUOUS", `"${q}" matches ${hits.length} sessions (${hits.map((s) => `${s.kind} ${s.id || s.sessionId.slice(0, 8)}${s.pid ? ` pid ${s.pid}` : ""}`).join("; ")})`, `propagate sessions show ${options[0]}  (or ${options.slice(1).join(", ")})`);
    }
  }
  const gone = view.ended.filter((e) => {
    const r = e.association.row ?? {};
    return r.id === q || r.sessionId === q || (q.length >= 6 && String(r.sessionId ?? "").startsWith(q)) || (r.name && r.name === q);
  });
  if (gone.length === 1) return { ok: true, ended: gone[0] };
  if (gone.length > 1) return fail("SESSION_AMBIGUOUS", `"${q}" matches ${gone.length} ended associations`, "propagate sessions --json");
  return fail("SESSION_NOT_FOUND", `no session matches "${q}" (${view.sessions.length} live)`, "propagate sessions");
}

/** The guidance files for a folder: the CLAUDE.md chain up to the hub root, and the project's state files. */
export function guidanceFor(folder, ctx) {
  if (folder.unplaced) return { claudeMd: [], state: [] };
  const hub = ctx.hubRoot ?? null;
  const top = folder.all ? folder.cwd : hub && (folder.cwd === hub || folder.cwd.startsWith(hub + path.sep)) ? hub : folder.workspaceRoot;
  const claudeMd = [];
  for (let dir = folder.cwd; ; dir = path.dirname(dir)) {
    const f = path.join(dir, "CLAUDE.md");
    if (existsSync(f)) claudeMd.push(f);
    if (dir === top || dir === path.dirname(dir)) break;
  }
  const state = [];
  if (!folder.all && folder.project && !folder.project.startsWith("(")) {
    for (const base of new Set([folder.workspaceRoot, hub].filter(Boolean))) {
      for (const name of ["STATE.md", "DECISIONS.md", "GOTCHAS.md"]) {
        const f = path.join(base, "propagation", "state", folder.project, name);
        if (existsSync(f)) state.push(f);
      }
    }
  }
  return { claudeMd, state };
}

/** The next command for a session's state. */
export function nextFor(s) {
  if (s.state === ENDED_LABEL) return "claude agents --json  (the session is gone; its association stays as history)";
  if (s.last?.event === "unknown") return "claude agents --json  (a launch was recorded but its session could not be identified)";
  if (!s.association) return `propagate sessions assoc ${s.id || s.sessionId.slice(0, 8)} --from owner/repo#n`;
  return `propagate sessions show ${s.id || s.sessionId.slice(0, 8)}  (associated with ${s.association.item ?? "?"}; re-run assoc to change it)`;
}

/**
 * @param {{session?: object, ended?: object}} pick from selectSession
 * @param {{byKey: Map<string, object>}} fold
 * @param {object} ctx resolve.loadContext()
 */
export function buildShow(pick, fold, ctx, { now = Date.now() } = {}) {
  if (pick.ended) {
    const e = pick.ended;
    const entry = fold.byKey.get(e.rowKey);
    const r = e.association.row ?? {};
    return {
      state: ENDED_LABEL,
      live: null,
      row: r,
      association: e.association,
      history: entry?.history ?? [],
      folder: null,
      repos: [],
      guidance: { claudeMd: [], state: [] },
      next: nextFor({ state: ENDED_LABEL }),
    };
  }
  const s = pick.session;
  const entry = fold.byKey.get(s.key);
  const guidance = guidanceFor(s.folder, ctx);
  return {
    state: s.state,
    live: { key: s.key, kind: s.kind, id: s.id, sessionId: s.sessionId, pid: s.pid, name: s.name, cwd: s.cwd, startedAt: s.startedAt, since: since(s.startedAt, now), waitingFor: s.waitingFor },
    association: s.association,
    history: entry?.history ?? [],
    folder: s.folder,
    repos: s.folder.repos ?? [],
    guidance,
    next: nextFor(s),
  };
}

export function renderShow(d) {
  const out = [];
  const l = d.live;
  if (l) {
    out.push(`${l.name || "(unnamed)"}  ${l.id || l.sessionId.slice(0, 8)}  ${l.kind}${l.pid ? ` pid ${l.pid}` : ""}`);
    out.push(`  state:    ${d.state}${l.waitingFor ? ` (waiting for ${l.waitingFor})` : ""}, started ${l.since} ago`);
    out.push(`  cwd:      ${l.cwd}`);
  } else {
    out.push(`${d.row.name || "(unnamed)"}  ${d.row.id || String(d.row.sessionId ?? "").slice(0, 8)}`);
    out.push(`  state:    ${d.state}`);
  }
  const f = d.folder;
  if (f) out.push(`  folder:   ${f.unplaced ? "unplaced (outside every workspace)" : f.all ? "hub (all)" : `${f.workspace} / ${f.project}`}`);
  out.push(`  repos:    ${d.repos.length ? d.repos.join(", ") : f?.all ? "every repo (hub)" : "none found"}`);
  const a = d.association;
  out.push(a ? `  goal:     ${a.goal ?? "-"}   item: ${a.item ?? "-"}   (associated ${a.ts})` : "  goal:     unassociated");
  out.push("  guidance:");
  const files = [...d.guidance.claudeMd, ...d.guidance.state];
  if (files.length) for (const g of files) out.push(`    ${g}`);
  else out.push("    none found");
  out.push("  history:");
  if (d.history.length) for (const h of d.history) out.push(`    ${h.ts}  ${h.event}${h.item ? `  ${h.item}` : ""}${h.goal ? `  ${h.goal}` : ""}`);
  else out.push("    none");
  out.push(`  next:     ${d.next}`);
  return out;
}
