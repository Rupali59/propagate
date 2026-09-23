/**
 * ui.mjs — a window onto the disposition queue, with the write path gated.
 *
 * WHY IT EXISTS. The monitor notifies; until 2026-09-17 it said
 * `DRIFTED CLAUDE.md → CLAUDE.md`, which is the correct rendering of seven
 * different edges in this tree. That is fixed, but a notification is still a
 * pointer, not a workbench: there was nowhere to SEE the 44 actionable edges,
 * read both sides, and record a judgement.
 *
 * SECURITY MODEL, copied deliberately from `scripts/claude-queue-ui.py`, which
 * worked it out the hard way (its C4: a drive-by browser page can reach a plain
 * loopback server, so loopback alone is not a boundary):
 *
 *   - bind 127.0.0.1 only
 *   - a per-start random token, required on every /api/* call
 *   - Host must be loopback, Origin must be same-origin or absent
 *
 * THE WRITE PATH IS NOT REIMPLEMENTED HERE. Payload construction and the
 * DIVERGED guard come from `lib/edges/disposition.mjs`, shared with `verify`.
 * Two writers building the same event separately is N86's defect exactly — one
 * contract, two implementations, drifting apart unnoticed.
 *
 * REASON IS MANDATORY, which is stricter than the CLI. `validateEvent` requires
 * a reason only for `wontfix` and `baselined`. A button is a lower-friction
 * write than a typed command, so the friction is restored deliberately: N64
 * records 556 unexplained `wontfix_reason` rows from v1, and N85 records
 * templated reasoning across 15 edges in one batch. A disposition whose reason
 * is "ok" is not cheaper to produce than one with a real sentence, but it is
 * worth much less to the next reader.
 *
 * /api/dispose ALSO ACCEPTS A BATCH: {node_id, state, disposition, reason}.
 * The unit is (node_id, state) TOGETHER — `verify --node --state` is the CLI's
 * own batch primitive, and a node with mixed states cannot take one
 * disposition. `validateBatchWrite` refuses the WHOLE group rather than
 * silently narrowing to the members that happen to match, so a partial
 * application is never expressible through this endpoint; `applyBatchDispose`
 * then re-checks each member against freshly reconciled rows and writes one
 * event per member, all carrying the one reason supplied.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { queuePayload } from "../lib/report/queue.mjs";

const TOKEN = randomBytes(24).toString("hex");

/** Same-origin / loopback gate. Returns a refusal string, or null when allowed. */
export function guardRequest(req, token, port) {
  const host = String(req.headers.host ?? "");
  const hostname = host.split(":")[0];
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return "non-loopback Host";
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && String(u.port) === String(port);
    } catch { ok = false; }
    if (!ok) return "cross-origin request";
  }
  const url = new URL(req.url, `http://${host}`);
  if (url.searchParams.get("token") !== token) return "bad or missing token";
  return null;
}

/**
 * Validate a disposition request BEFORE anything is written.
 *
 * Every refusal names the field, because "invalid request" is a reader that
 * failed and could not say why (`rule:discernment-checks` §2).
 */
export function validateWrite({ edge_id, disposition, reason }, item) {
  if (!edge_id) return "edge_id is required";
  if (!item) return `no actionable edge ${edge_id} — it may have been disposed in another window; reload`;
  if (!disposition) return "disposition is required";
  if (!item.allowed.includes(disposition)) {
    return `${item.state} edges do not accept "${disposition}" — allowed: ${item.allowed.join(", ")}`;
  }
  const r = String(reason ?? "").trim();
  if (r.length < 12) {
    return "a reason of at least 12 characters is required — this UI is stricter than the CLI on purpose; a one-click write with no reason is how an append-only store fills with judgements nobody can audit";
  }
  return null;
}

/**
 * Validate a BATCH disposition request BEFORE anything is written.
 *
 * The batch unit is (node_id, state) TOGETHER — `verify --node --state` is
 * the CLI's own batch primitive, and a node with mixed states cannot take
 * one disposition. So unlike `validateWrite` above (which is handed the ONE
 * already-matched item), this is handed EVERY actionable edge currently
 * sharing `node_id`, at WHATEVER state each one presently reads — never
 * pre-filtered to `state`, or a mismatch would be silently dropped instead
 * of refused, which is the one thing a batch write must never do (a partial
 * application would then be expressible through the filtering itself, not
 * even through a bug in the write loop).
 *
 * Refusal codes split by CATEGORY, not by severity:
 *   400 — wrong regardless of current state (a missing field, a disposition
 *         the state doesn't accept, too short a reason). Same category
 *         `validateWrite` above already uses 400 for.
 *   409 — wrong BECAUSE current state disagrees with the request (no
 *         members, or the members aren't uniform). Same category the
 *         write path below uses 409 for ("edge vanished between render and
 *         write") — both are the server's fresher read overruling the
 *         browser's.
 *
 * @param {{node_id?: string, state?: string, disposition?: string, reason?: string}} body
 * @param {Array<{edge_id: string, state: string, allowed: string[]}>} members
 * @returns {{code: number, error: string}|null}
 */
export function validateBatchWrite({ node_id, state, disposition, reason }, members) {
  if (!node_id) return { code: 400, error: "node_id is required" };
  if (!state) return { code: 400, error: "state is required" };
  if (!disposition) return { code: 400, error: "disposition is required" };
  if (!members.length) {
    return {
      code: 409,
      error: `no actionable edges for node ${node_id} — they may have been disposed in another window; reload`,
    };
  }
  const off = members.filter((m) => m.state !== state);
  if (off.length) {
    const seen = [...new Set(off.map((m) => m.state))].join(", ");
    return {
      code: 409,
      error: `${node_id} is not uniformly ${state} — ${off.length} of ${members.length} member(s) are ` +
        `${seen}; a mixed-state node cannot take one disposition. reload`,
    };
  }
  if (!members[0].allowed.includes(disposition)) {
    return { code: 400, error: `${state} edges do not accept "${disposition}" — allowed: ${members[0].allowed.join(", ")}` };
  }
  const r = String(reason ?? "").trim();
  if (r.length < 12) {
    return {
      code: 400,
      error: "a reason of at least 12 characters is required — this UI is stricter than the CLI on purpose; a one-click write with no reason is how an append-only store fills with judgements nobody can audit",
    };
  }
  return null;
}

/**
 * Write a batch: one event per member of an already-validated (node_id,
 * state) group, all carrying the SAME reason. Every member is re-checked
 * against `rows` — freshly reconciled, NOT `members` (which came from the
 * snapshot `validateBatchWrite` was run against) — because the two reads are
 * seconds apart and a member can move between them even after the group
 * passed the uniform-state gate.
 *
 * `appendEvent` / `buildEventPayload` / `divergedGuard` arrive as
 * parameters rather than module-level imports so this is directly
 * unit-testable against a fake writer — the same reason cli.mjs's
 * `computeVerifyAfterWrite` takes `afterRows` as an argument instead of
 * calling `reconcile()` itself.
 *
 * @returns {Promise<{ok: boolean, results: Array<{edge_id: string, ok: boolean, event_id?: string, error?: string}>}>}
 *   `ok` is the AND of every member's own `ok` — NEVER true when one member
 *   failed, so a partial failure cannot read as a bare success. `results` is
 *   always the full per-`edge_id` array, never collapsed to a count, so a
 *   partial failure is legible by which edge it was.
 */
export async function applyBatchDispose({ body, members, rows, appendEvent, buildEventPayload, divergedGuard, by }) {
  const byEdgeId = new Map((rows ?? []).map((r) => [r.edge_id, r]));
  const reason = String(body.reason).trim();
  const results = [];
  for (const m of members) {
    const row = byEdgeId.get(m.edge_id);
    if (!row) {
      results.push({ edge_id: m.edge_id, ok: false, error: "edge vanished between render and write — reload" });
      continue;
    }
    if (row.state !== body.state) {
      results.push({ edge_id: m.edge_id, ok: false, error: `edge moved to ${row.state} since selection — reload` });
      continue;
    }
    const guard = divergedGuard(row.state, body.disposition);
    if (guard) {
      results.push({ edge_id: m.edge_id, ok: false, error: guard });
      continue;
    }
    try {
      const stamped = await appendEvent(buildEventPayload(row, body.disposition, reason, by));
      results.push({ edge_id: m.edge_id, ok: true, event_id: stamped.event_id });
    } catch (err) {
      results.push({ edge_id: m.edge_id, ok: false, error: String(err?.message ?? err) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}


export function page(token) {
  // THE TEMPLATE LITERAL IS NOW A SHELL, not a program. The CSS and the client
  // script live in commands/ui.css and commands/ui.client.js and are INLINED
  // here at serve time -- still one self-contained page, no build step, no
  // second request.
  //
  // This is G65 fixed structurally rather than tested around. Code inside a
  // template literal is escaped twice, and four dead-page bugs in one session
  // came from that: a backslash-n that became a real newline, two backticks in
  // comments, and an escaped slash that collapsed. Each was invisible -- HTTP
  // 200 on every request, nothing in any log, the only evidence in a browser
  // console nothing reads. A plain file has nothing to escape, and
  // `node --check` can parse it directly.
  //
  // THE TOKEN IS THE ONLY INTERPOLATION, and it goes on a data attribute rather
  // than into the script, so ui.client.js contains no substitution point at all.
  // It is JSON-encoded, and it is 48 hex characters minted by randomBytes -- but
  // the encoding is what makes that a property of the value rather than a thing
  // to remember.
  const read = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8");
  // Three vendored globals BEFORE the client, in their own script tags. Separate
  // tags rather than one concatenation so a syntax error in one cannot silently
  // take the others with it -- and so the browser attributes the error to a file.
  const vendor = ["vendor/preact.js", "vendor/hooks.js", "vendor/htm.js"].map(read);
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>propagate</title>",
    "<style>", read("ui.css"), "</style></head>",
    "<body data-token=", JSON.stringify(token), ">",
    '<div id="app"></div>',
    ...vendor.flatMap((v) => ["<script>", v, "</script>"]),
    "<script>", read("ui.client.js"), "</script></body></html>",
  ].join("");
}


export async function uiCmd(argv = [], io = console) {
  const portArg = argv.indexOf("--port");
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : 4599;
  const root = path.join(process.env.HOME ?? "", "Documents/GitHub/");

  const { appendEvent } = await import("../lib/edges/events.mjs");
  const { registerQueue } = await import("../lib/registers/queue.mjs");
  const { planEdit, applyEdit } = await import("../lib/registers/write.mjs");
  const { backlog } = await import("../lib/report/backlog.mjs");
  const { evidenceFor } = await import("../lib/report/evidence.mjs");
  const { readSnapshot } = await import("../lib/report/doctor/snapshot.mjs");
  const { divergedGuard, buildEventPayload } = await import("../lib/edges/disposition.mjs");
  const { defaultDeps } = await import("../lib/report/queue.mjs");
  // TWO MODULES EXPORT defaultDeps AND THEY ARE NOT INTERCHANGEABLE.
  // queue.mjs's has {reconcile, loadWorkspaces}; inbox.mjs's adds
  // historyByEdge, planBaseline and registerQueue. Passing the first to
  // inboxPayload returns a 500 that no unit test can see, because every test
  // injects its own deps and therefore never exercises either default.
  const inbox = await import("../lib/report/inbox.mjs");
  const { inboxPayload, referencePayload, baselineBuckets } = inbox;
  const inboxDeps = await inbox.defaultDeps();
  const { analyticsPayload } = await import("../lib/report/analytics.mjs");
  const deps = await defaultDeps();

  const server = createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);

    if (url.pathname === "/" && url.searchParams.get("token") === TOKEN) {
      return send(200, page(TOKEN), "text/html; charset=utf-8");
    }
    // THE GRAPH IS A VIEW HERE, not a file on disk. It used to be generated to
    // ~/.propagate/graph.html and opened directly, which made it a second
    // destination with its own lifetime and no way back. Rupali's requirement:
    // one page holds everything and every link lands on it.
    if (url.pathname === "/graph") {
      const refusal = guardRequest(req, TOKEN, port);
      if (refusal) return send(403, refusal, "text/plain");
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const out = path.join(process.env.PROPAGATE_STATE_DIR || path.join(process.env.HOME ?? "", ".propagate"), "graph.html");
        await promisify(execFile)(process.execPath, [path.join(import.meta.dirname, "..", "cli.mjs"), "graph", "--html", out], { maxBuffer: 64e6 });
        return send(200, readFileSync(out, "utf8"), "text/html; charset=utf-8");
      } catch (err) {
        return send(500, `could not render the graph — ${String(err?.message ?? err)}`, "text/plain");
      }
    }

    if (url.pathname.startsWith("/api/")) {
      const refusal = guardRequest(req, TOKEN, port);
      if (refusal) return send(403, { ok: false, error: refusal });

      /* ── THE FIVE DIVISIONS ────────────────────────────────────────────
         Three endpoints, split by COST rather than by topic. Measured:

           inbox      343 ms   READY / BLOCKED / PARKED / GAP total
           reference  188 ms   the register walk — nobody acts in it
           baseline  1052 ms   a git walk per repo, for the four buckets
           analytics   55 ms   33 days of metrics already on disk

         Putting all of it on first paint would cost more than the 1452 ms this
         work set out to fix. What loads immediately is what you act on. */
      if (url.pathname === "/api/inbox") {
        try { return send(200, await inboxPayload({ root, deps: inboxDeps })); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }
      if (url.pathname === "/api/reference") {
        try { return send(200, await referencePayload({ deps: inboxDeps })); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }
      if (url.pathname === "/api/baseline") {
        try { return send(200, await baselineBuckets({ deps: inboxDeps })); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }
      if (url.pathname === "/api/analytics") {
        try { return send(200, await analyticsPayload({ root })); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

      if (url.pathname === "/api/queue") {
        try { return send(200, await queuePayload({ root, deps })); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

      if (url.pathname === "/api/dispose" && req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: "malformed JSON body" }); }

        // BATCH: {node_id, state, disposition, reason}. Checked on node_id's
        // presence, BEFORE the single-edge path, so a batch body (which has
        // no edge_id of its own) is never misread as an incomplete
        // single-edge request.
        if (body.node_id !== undefined) {
          const payloadNow = await queuePayload({ root, deps });
          // EVERY actionable edge currently sharing node_id, at WHATEVER
          // state each one reads — never pre-filtered to body.state, or a
          // mixed-state group would be silently narrowed instead of refused.
          const members = payloadNow.items.filter((i) => i.node_id === body.node_id);
          const invalid = validateBatchWrite(body, members);
          if (invalid) return send(invalid.code, { ok: false, error: invalid.error });

          // Re-derive AGAIN right before writing, same discipline as the
          // single-edge path below: payloadNow is itself fresh, but a human
          // reading a batch row and clicking is seconds behind even that.
          const workspaces = await deps.loadWorkspaces();
          const { rows } = await deps.reconcile(workspaces, {});
          const result = await applyBatchDispose({
            body,
            members,
            rows,
            appendEvent,
            buildEventPayload,
            divergedGuard,
            by: `${process.env.USER || "ui"} (ui)`,
          });
          // 200 only when every member landed. A partial failure still
          // returns 200-shaped JSON with ok:false plus the per-edge_id
          // array — never a bare {ok:true} that hides which member failed —
          // so 207 (Multi-Status) marks the mixed case at the transport
          // level too, for a client that only checks the status code.
          return send(result.ok ? 200 : 207, result);
        }

        const payloadNow = await queuePayload({ root, deps });
        const item = payloadNow.items.find((i) => i.edge_id === body.edge_id);
        const invalid = validateWrite(body, item);
        if (invalid) return send(400, { ok: false, error: invalid });

        // Re-derive the row, then re-run the SAME guard verify uses. The queue
        // snapshot the browser holds may be seconds old; the guard must run
        // against state read now, not against what the page was rendered from.
        const workspaces = await deps.loadWorkspaces();
        const { rows } = await deps.reconcile(workspaces, {});
        const row = rows.find((r) => r.edge_id === body.edge_id);
        if (!row) return send(409, { ok: false, error: "edge vanished between render and write — reload" });
        const guard = divergedGuard(row.state, body.disposition);
        if (guard) return send(409, { ok: false, error: guard });

        try {
          const stamped = await appendEvent(buildEventPayload(row, body.disposition, String(body.reason).trim(), `${process.env.USER || "ui"} (ui)`));
          return send(200, { ok: true, event_id: stamped.event_id });
        } catch (err) {
          return send(400, { ok: false, error: String(err?.message ?? err) });
        }
      }
      // EVIDENCE — read-only, and behind the SAME path allowlist as the write
      // route. An evidence endpoint that reads an arbitrary path is a
      // file-disclosure primitive behind a token; read-only does not make it
      // safe, it makes it quieter. Edges are allowed by their source path, which
      // comes from reconcile rather than from the client.
      if (url.pathname === "/api/evidence" && req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: "malformed JSON body" }); }

        let allowed = false;
        if (body.kind === "edge") {
          const q = await queuePayload({ root, deps });
          const item = q.items.find((i) => i.edge_id === body.edge_id);
          if (!item) return send(404, { ok: false, error: "no such actionable edge — reload" });
          // The path and the commit come from the LEDGER, never from the
          // browser, so neither can be pointed somewhere else.
          body.file = item.source;
          body.sinceCommit = item.lastVerified?.commit ?? null;
          body.dirty = !!item.lastVerified?.dirty;
          allowed = true;
        } else {
          const known = registerQueue({ backlogFn: backlog });
          const set = new Set([...(known.issues ?? []), ...(known.todos ?? [])].map((i) => i.file));
          allowed = set.has(body.file);
        }
        if (!allowed) return send(403, { ok: false, error: `${body.file} is not a file this surface reads` });

        const ev = await evidenceFor(body);
        return send(200, ev);
      }

      // HEALTH — doctor's own sections, from the snapshot the monitor writes.
      // Not re-run here: doctor costs ~37s and this is a page load.
      if (url.pathname === "/api/health") {
        const snap = await readSnapshot();
        if (!snap.ok) return send(200, { ok: false, reason: snap.reason, sections: null, ageMs: snap.ageMs ?? null });
        return send(200, { ok: true, ageMs: snap.ageMs, generatedAt: snap.payload.generatedAt,
          problems: snap.payload.problems, totals: snap.payload.totals, sections: snap.payload.sections });
      }

      // RULES — the HUB half of the model. docs/HUB-AND-WORKSPACE.md: the hub is
      // checked by `rules check` and declared edges, workspaces by doctor. The
      // surface carried doctor and the registers and none of this, so half the
      // architecture was missing from the only page that claims to show it.
      if (url.pathname === "/api/rules") {
        try {
          // Same arguments cli.mjs's own `rulesCmd` uses, so this page and the
          // command cannot report different things about the hub.
          const { checkRules } = await import("../lib/rules/rules-check.mjs");
          const { RULES_DIR, SEARCH_ROOTS } = await import("../lib/core/config.mjs");
          // os.homedir(), NOT a HOME_DIR import: config does not export one, and
          // destructuring a missing named export yields undefined rather than
          // throwing -- so the phantom would have fallen through to a fallback
          // and worked by luck. G24's shape: a null that reads as unconfigured.
          const { homedir } = await import("node:os");
          const globalMd = path.join(homedir(), ".claude", "CLAUDE.md");
          return send(200, checkRules({ rulesDir: RULES_DIR, roots: SEARCH_ROOTS, extra: [globalMd], exclude: [globalMd] }));
        } catch (err) {
          return send(200, { error: String(err?.message ?? err), findings: null });
        }
      }

      if (url.pathname === "/api/gotchas") {
        try {
          const { gotchaEntries } = await import("../lib/registers/queue.mjs");
          const { sourcesFor } = await import("../lib/gotchas/parse.mjs");
          const { WORKSPACES } = await import("../lib/core/config.mjs");
          // Workspace roots, NOT cwd — the same scope lib/report/surface.mjs
          // uses, so the widget's count and this list cannot disagree. Taking
          // cwd made the number depend on where the process started (N80).
          const set = new Set();
          for (const w of WORKSPACES) for (const f of sourcesFor(w.root ?? w.path ?? w) ?? []) set.add(f);
          return send(200, gotchaEntries({ files: [...set] }));
        } catch (err) { return send(200, { error: String(err?.message ?? err), entries: null }); }
      }

      if (url.pathname === "/api/registers") {
        try { return send(200, registerQueue({ backlogFn: backlog })); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

      // PREVIEW — plans the edit and returns the hunk. Writes nothing.
      if (url.pathname === "/api/register-preview" && req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: "malformed JSON body" }); }
        const plan = planEdit(body);
        return send(plan.ok ? 200 : 400, plan);
      }

      // WRITE — the confirm step.
      //
      // IT RE-PLANS SERVER-SIDE AND REQUIRES THE RESULT TO MATCH what the
      // browser sends back. `next` arriving from a client is otherwise an
      // arbitrary line of markdown, and this endpoint would be a
      // write-anything-anywhere primitive behind a token. Re-planning makes the
      // browser's copy a CHECKSUM of the preview rather than its source.
      //
      // The planners are deterministic given (line, reason, date), so a
      // mismatch means the preview is genuinely stale — including the one real
      // edge case, a preview held across midnight. That refuses with a message
      // telling you to preview again, which is correct: the date in the file
      // would otherwise be the day you started reading, not the day you wrote.
      if (url.pathname === "/api/register-write" && req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: "malformed JSON body" }); }

        // THE PATH ALLOWLIST. Without it this endpoint writes an arbitrary line
        // into an arbitrary file — a much broader primitive than "edit a
        // register", and one that a token-gated loopback server should not
        // expose just because it is convenient. The allowed set is derived from
        // the SAME census the page was rendered from, so a file the surface
        // never offered cannot be written through it.
        const known = registerQueue({ backlogFn: backlog });
        const allowed = new Set([...(known.issues ?? []), ...(known.todos ?? [])].map((i) => i.file));
        if (!allowed.has(body.file)) {
          return send(403, { ok: false, error: `${body.file} is not a register this surface manages` });
        }

        const replan = planEdit(body);
        if (!replan.ok) return send(400, replan);
        if (replan.next !== body.next) {
          return send(409, {
            ok: false,
            error: "the preview no longer matches what this would write — preview again before confirming",
          });
        }
        const r = await applyEdit({ file: body.file, line: body.line, expected: body.current, next: replan.next });
        return send(r.ok ? 200 : 409, r);
      }

      return send(404, { ok: false, error: "no such endpoint" });
    }
    return send(404, "not found", "text/plain");
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const link = `http://127.0.0.1:${port}/?token=${TOKEN}`;
  io.log(`propagate ui — ${link}`);
  io.log(`  loopback only, per-start token. Ctrl-C to stop.`);
  return { server, port, token: TOKEN, link };
}
