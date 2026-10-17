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
 *
 * AND A SECOND BATCH SHAPE, for selections that cross nodes (D9, 2026-10-15):
 * {edges: [{edge_id, state, observed?}], disposition, reason}. The server
 * resolves each id against ITS OWN queue (plus the parked set, D11) -- the
 * client never supplies a path -- and every member is checked against its own
 * expected state, not one shared `state`. See `validateEdgesBatch`.
 *
 * `observed:{source,downstream}` (F1) is the content pair the reviewer actually
 * read. `buildEventPayload` pins `row.source.contentId` from the reconcile run at
 * WRITE time, so without it a verdict silently pins bytes that changed after the
 * diff was drawn. A mismatch is refused per edge with 409.
 */

import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, chmodSync, mkdirSync, openSync, writeSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { queuePayload, buildQueue, orderFor, historyByEdge } from "../lib/report/queue.mjs";
import { streamPayload, readCursor, writeCursor } from "../lib/report/stream.mjs";
import { readSeen, addSeen, validateTriples } from "../lib/report/seen-edges.mjs";
import { buildId } from "../lib/report/ui-build.mjs";
import { stateDir } from "../lib/core/paths.mjs";

export { buildId };

/**
 * THE TOKEN IS STABLE AND LIVES IN A FILE (2026-10-16, Part 7 option C).
 *
 * It used to be randomBytes(24) per start, held in memory. Measured cost: every
 * bookmark died at each restart and the only working link was the one the widget
 * read off the server's stdout (T1), and the secret sat in the address bar and
 * browser history (T2). What stops OTHER WEBSITES is the loopback Host check, the
 * same-Origin check and SameSite=Strict -- not the token's lifetime -- and
 * anything running as this user can read ~/.propagate anyway. So the token is
 * created once, kept in `<stateDir>/ui-token` at mode 0600, and reused.
 *
 * A MALFORMED FILE IS REFUSED, NEVER REGENERATED. Regenerating silently would
 * invalidate every open tab and bookmark with no word said, which is the exact
 * failure (a client that cannot tell "expired" from "broken") F9 was written to
 * end. `propagate ui --rotate-token` is the deliberate way to replace it.
 */
export const TOKEN_FILE_NAME = "ui-token";
const TOKEN_RE = /^[0-9a-f]{64}$/;

export class TokenFileError extends Error {
  constructor(message) { super(message); this.name = "TokenFileError"; }
}

/** Atomic 0600 write: a temp file created 0600 in the same directory, then renamed over. */
function writeTokenFile(file, token) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, token + "\n"); } finally { closeSync(fd); }
  try { chmodSync(tmp, 0o600); renameSync(tmp, file); }
  catch (err) { try { unlinkSync(tmp); } catch { /* already gone */ } throw err; }
}

/**
 * @param {string} dir the state directory
 * @returns {{token: string, file: string, created: boolean, tightened: string|null}}
 * @throws {TokenFileError} when the file exists and is not exactly 64 lowercase hex characters
 */
export function loadOrCreateToken(dir) {
  const file = path.join(dir, TOKEN_FILE_NAME);
  let st = null;
  try { st = statSync(file); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  if (!st) {
    const token = randomBytes(32).toString("hex");
    writeTokenFile(file, token);
    return { token, file, created: true, tightened: null };
  }
  const token = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (!TOKEN_RE.test(token)) {
    throw new TokenFileError(
      `${file} does not hold a token (expected exactly 64 lowercase hex characters). ` +
      `It was left untouched. To replace it deliberately, run: propagate ui --rotate-token`);
  }
  let tightened = null;
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    chmodSync(file, 0o600);
    tightened = mode.toString(8).padStart(4, "0");
  }
  return { token, file, created: false, tightened };
}

/** `propagate ui --rotate-token`: a fresh token, same atomic 0600 write. */
export function rotateToken(dir) {
  const file = path.join(dir, TOKEN_FILE_NAME);
  writeTokenFile(file, randomBytes(32).toString("hex"));
  return file;
}

/** Constant-time equality of two strings; false for a non-string or a length mismatch. */
function tokenEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The ptok cookie, parsed out of however many cookies the browser sent. */
function cookieToken(req) {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === "ptok") return part.slice(i + 1).trim();
  }
  return null;
}

const COOKIE_MAX_AGE = 31536000;

/**
 * On EVERY response, from the one send() path and the 500 fallback. A page that
 * carries a bearer token must not be cached, framed or leaked in a Referer; none
 * of these were set before (T4).
 */
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
};

/**
 * The one refusal that is 401, not 403 (F9). A bad token means "you are not
 * authenticated" and the client can act on it ("token expired, reopen from the
 * widget"); a Host or Origin refusal means "this request should not be made at
 * all" and stays 403. Both used to be 403, so the client could not tell an
 * expired tab from an attack and rendered a crash for the first.
 */
export const TOKEN_REFUSAL = "bad or missing token";

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
  // Host and Origin ran FIRST and stay first: a valid cookie on a cross-origin
  // request must still be a 403, or the cookie would be a way round the Origin check.
  const url = new URL(req.url, `http://${host}`);
  if (tokenEq(url.searchParams.get("token"), token) || tokenEq(cookieToken(req), token)) return null;
  return TOKEN_REFUSAL;
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
/**
 * PR-023. `/api/seen`'s whole contract, pulled out for the same reason
 * `validateBatchWrite` is: the refusals are the interesting part and they
 * should be testable without standing up a server.
 *
 * `at` must be an ISO timestamp the caller OBSERVED. There is deliberately no
 * default-to-now branch -- a missing `at` is a caller bug, and quietly
 * stamping the clock would mark events seen that nobody rendered, which is
 * precisely the advance-on-view behaviour this feature exists to avoid.
 *
 * @param {{at?: unknown}} body
 * @returns {{code: number, error: string} | null} null when acceptable
 */
export function validateSeenBody(body) {
  const at = body && body.at;
  if (typeof at !== "string" || at.length === 0) {
    return { code: 400, error: `"at" must be an ISO timestamp string, got ${JSON.stringify(at)}` };
  }
  if (Number.isNaN(Date.parse(at))) {
    return { code: 400, error: `"at" is not a parseable timestamp: ${JSON.stringify(at)}` };
  }
  return null;
}

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

const REASON_TOO_SHORT =
  "a reason of at least 12 characters is required — this UI is stricter than the CLI on purpose; a one-click write with no reason is how an append-only store fills with judgements nobody can audit";

/**
 * Validate a CROSS-NODE batch -- {edges:[{edge_id, state, observed?}], disposition,
 * reason} -- BEFORE anything is written (D9, with F2 from the outside review).
 *
 * WHY THIS IS NOT validateBatchWrite. That gate's unit is one (node_id, state)
 * and it refuses a mixed group wholesale. A selection that crosses nodes has no
 * single node and no single state, so the uniformity gate cannot apply, and the
 * first sketch of this path inherited NONE of the other gates either: the
 * disposition was never checked against `allowed`, the reason was never measured,
 * and `edges: []` was vacuously fine (an empty loop is a success). F2 found all
 * three. Each is a refusal here, and each has a mutation test.
 *
 * TWO LEVELS OF REFUSAL, kept apart on purpose:
 *   - BATCH-LEVEL (`fatal`): the request itself is malformed or abusive -- no
 *     edges, duplicate ids, more ids than the queue could hold, no disposition,
 *     a short reason. Nothing is written for anyone.
 *   - PER-EDGE (`refused`): one id is unknown, has moved, or cannot take this
 *     disposition. The other members still proceed -- that is what 207 is for.
 *     A foreign id is "not actionable", never a path lookup: members are the
 *     server's own items, filtered by the ids sent.
 *
 * DUPLICATES ARE REFUSED, NOT SILENTLY MERGED. Two entries for one edge would
 * write two events with one reason; a client that sends them has a bug, and
 * quietly deduping would hide it.
 *
 * @param {{edges?: unknown, disposition?: string, reason?: string}} body
 * @param {{items: Array<{edge_id: string, node_id?: string, state: string, allowed: string[]}>,
 *          parked?: Array<{edge_id: string, node_id?: string, state: string, allowed: string[]}>}} pool
 *   the server's queue items, plus the parked set (D11). Queue wins on a shared id.
 * @returns {{fatal: {code: number, error: string}|null,
 *            members: Array<object>,
 *            refused: Array<{edge_id: string, ok: false, code: number, error: string}>}}
 */
export function validateEdgesBatch(body, pool) {
  const none = (code, error) => ({ fatal: { code, error }, members: [], refused: [] });
  const edges = body?.edges;
  if (!Array.isArray(edges) || edges.length === 0) {
    return none(400, "edges must be a non-empty array of {edge_id, state} — an empty selection is not a successful batch");
  }
  const byId = new Map();
  for (const m of pool?.parked ?? []) byId.set(m.edge_id, { ...m, parked: true });
  for (const m of pool?.items ?? []) byId.set(m.edge_id, m);
  if (edges.length > byId.size) {
    return none(400, `${edges.length} edges sent but only ${byId.size} can be acted on right now — reload`);
  }
  if (!body.disposition) return none(400, "disposition is required");
  if (String(body.reason ?? "").trim().length < 12) return none(400, REASON_TOO_SHORT);

  const seen = new Set();
  for (const e of edges) {
    if (!e || typeof e !== "object" || typeof e.edge_id !== "string" || !e.edge_id || typeof e.state !== "string" || !e.state) {
      return none(400, `every entry of edges must be {edge_id, state}, got ${JSON.stringify(e)?.slice(0, 120)}`);
    }
    if (seen.has(e.edge_id)) return none(400, `edge ${e.edge_id} appears twice in edges — one verdict per edge`);
    seen.add(e.edge_id);
  }

  const members = [];
  const refused = [];
  for (const e of edges) {
    const item = byId.get(e.edge_id);
    if (!item) {
      refused.push({ edge_id: e.edge_id, ok: false, code: 409, error: `not actionable — ${e.edge_id} is not in the queue or the parked set; it may have been disposed in another window. reload` });
      continue;
    }
    if (item.state !== e.state) {
      refused.push({ edge_id: e.edge_id, ok: false, code: 409, error: `edge moved to ${item.state} since selection (you saw ${e.state}) — reload` });
      continue;
    }
    if (!item.allowed.includes(body.disposition)) {
      refused.push({ edge_id: e.edge_id, ok: false, code: 400, error: `${item.state} edges do not accept "${body.disposition}" — allowed: ${item.allowed.join(", ")}` });
      continue;
    }
    members.push({ ...item, expectedState: e.state, observed: e.observed });
  }
  return { fatal: null, members, refused };
}

/**
 * F1. Did the reviewer read the bytes the verdict is about to pin?
 *
 * `buildEventPayload` takes `source_content` and `downstream_content` from the
 * reconcile run at WRITE time, not from what was on screen. So an edit made
 * between drawing the diff and clicking would be pinned as "judged" without
 * anyone having seen it. `observed` is the pair /api/evidence returned for the
 * diff the reviewer saw; the write is refused when the row no longer says the
 * same.
 *
 * ABSENT `observed` is allowed (null) -- the CLI-shaped callers and every
 * pre-redesign client omit it, and refusing them would break working writes. The
 * redesigned client always sends it. PRESENT-BUT-MALFORMED is refused as 400, not
 * waved through: a half-checked pin is the failure this exists to prevent.
 *
 * @returns {{code: number, error: string}|null}
 */
export function observedRefusal(observed, row) {
  if (observed === undefined) return null;
  if (!observed || typeof observed !== "object" || !("source" in observed) || !("downstream" in observed)) {
    return { code: 400, error: "observed must carry both source and downstream content ids (the pair /api/evidence returned)" };
  }
  const nowSource = row?.source?.contentId ?? null;
  const nowDownstream = row?.downstream?.contentId ?? null;
  const sideSrc = (observed.source ?? null) !== nowSource;
  const sideDst = (observed.downstream ?? null) !== nowDownstream;
  if (!sideSrc && !sideDst) return null;
  const which = [sideSrc && "source", sideDst && "downstream"].filter(Boolean).join(" and ");
  return {
    code: 409,
    error: `the ${which} changed since you read the diff, so this verdict would pin content you did not see — reload and read it again`,
  };
}

/**
 * The refusal for a disposition outside `allowedDispositions(...).allowed`, or
 * null. Only the ORDERING half is reported here -- the DIVERGED pairing has its
 * own message at both call sites and runs first.
 */
export function orderingRefusal(allowedResult, disposition) {
  if (!allowedResult || allowedResult.allowed.includes(disposition)) return null;
  if (!allowedResult.viaOutOfOrder.includes(disposition)) return null;
  return (
    `this edge's source is itself unsettled, so "${disposition}" would pin a downstream against a source nobody has confirmed. ` +
    `Allowed now: ${allowedResult.allowed.join(", ") || "none"}. Settle the upstream first, or use the CLI's --out-of-order with a reason.`
  );
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
export async function applyBatchDispose({ body, members, rows, appendEvent, buildEventPayload, divergedGuard, by, allowedFor }) {
  const byEdgeId = new Map((rows ?? []).map((r) => [r.edge_id, r]));
  const reason = String(body.reason).trim();
  const results = [];
  for (const m of members) {
    const row = byEdgeId.get(m.edge_id);
    if (!row) {
      results.push({ edge_id: m.edge_id, ok: false, code: 409, error: "edge vanished between render and write — reload" });
      continue;
    }
    // PER-MEMBER expected state (D9). The node_id shape has one shared
    // `body.state`; the edges shape carries each member's own, because a
    // cross-node selection mixes DRIFTED with REVERSED. `m.expectedState` wins
    // when present, and the old shape (no expectedState) behaves exactly as before.
    const expected = m.expectedState ?? body.state;
    if (row.state !== expected) {
      results.push({ edge_id: m.edge_id, ok: false, code: 409, error: `edge moved to ${row.state} since selection — reload` });
      continue;
    }
    const seen = observedRefusal(m.observed, row);
    if (seen) {
      results.push({ edge_id: m.edge_id, ok: false, code: seen.code, error: seen.error });
      continue;
    }
    const guard = divergedGuard(row.state, body.disposition);
    if (guard) {
      results.push({ edge_id: m.edge_id, ok: false, code: 409, error: guard });
      continue;
    }
    // THE ORDERING GUARD, which this write path never had. `verify` refuses to
    // pin a downstream against an unsettled source; the UI wrote the event
    // anyway, so the one surface with no --out-of-order flag was the one that
    // could bypass the rule without saying so. `allowedFor` is injected (it
    // needs the whole graph) and OPTIONAL so a caller that cannot supply it is
    // visibly unguarded rather than silently guarded by a stub.
    const ordering = orderingRefusal(allowedFor?.(row), body.disposition);
    if (ordering) {
      results.push({ edge_id: m.edge_id, ok: false, code: 409, error: ordering });
      continue;
    }
    try {
      const stamped = await appendEvent(buildEventPayload(row, body.disposition, reason, by));
      results.push({ edge_id: m.edge_id, ok: true, event_id: stamped.event_id });
    } catch (err) {
      results.push({ edge_id: m.edge_id, ok: false, code: 400, error: String(err?.message ?? err) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}


// The stylesheet, as the browser receives it: every commands/ui/css/*.css, in NAME order,
// joined. The numeric prefix IS the cascade order — 10-tokens first, 90-responsive last, so
// the media overrides still win. Split out of one 453-line ui.css on 2026-10-08.
//
// DERIVED, not listed: a new fragment is picked up by being in the folder, so it cannot be
// forgotten (rule:derive-dont-curate). The floor is the other half: a folder that reads as
// empty or half-empty must fail loudly, never serve an unstyled page that looks like a
// working one. Tests read THIS, not a file, so they check what is actually served.
const CSS_DIR = new URL("./ui/css/", import.meta.url);
const CSS_FLOOR = 5;
export function stylesheet() {
  const files = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).sort();
  if (files.length < CSS_FLOOR) {
    throw new Error(`commands/ui/css holds ${files.length} stylesheet(s), expected at least ${CSS_FLOOR} — the page would render unstyled`);
  }
  return files.map((f) => `/* ── commands/ui/css/${f} ── */\n` + readFileSync(new URL(f, CSS_DIR), "utf8")).join("");
}

export function page(token, build = buildId()) {
  // THE TEMPLATE LITERAL IS NOW A SHELL, not a program. The CSS and the client
  // script live in commands/ui/css/*.css (joined by stylesheet()) and commands/ui.client.js and are INLINED
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
  // THE TOKEN AND THE BUILD ID ARE THE ONLY INTERPOLATIONS, and both go on data
  // attributes rather than into the script, so ui.client.js contains no
  // substitution point at all. Each is JSON-encoded. The token is 48 hex
  // characters minted by randomBytes and the build id is 16 hex characters of a
  // sha256 -- but the encoding is what makes that a property of the value rather
  // than a thing to remember, and the build id is added the SAME way as the token
  // on purpose: a second interpolation done differently is how G65 started.
  //
  // `data-build` is the id of the files THIS call just read from disk. /api/version
  // answers with the id the RUNNING SERVER was started from. A client that sees
  // the two differ is talking to a server older than its own page (F5).
  const read = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8");
  // Five vendored globals BEFORE the client, in their own script tags. Separate
  // tags rather than one concatenation so a syntax error in one cannot silently
  // take the others with it -- and so the browser attributes the error to a file.
  // d3 then Plot (Overview, 2026-10-16): Plot's UMD build reads the d3 global when it
  // loads, so the order is a dependency, not taste. If either fails to load the client
  // still runs and the Overview says "chart unavailable" in place of its charts; the
  // KPIs and the table do not need them. Name, version, licence and sha256: vendor/README.txt (not .md: the plugin validator reads every .md under commands/ as a slash command).
  const vendor = ["vendor/preact.js", "vendor/hooks.js", "vendor/htm.js", "vendor/d3.min.js", "vendor/plot.umd.min.js"].map(read);
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>propagate</title>",
    "<style>", stylesheet(), "</style></head>",
    "<body data-token=", JSON.stringify(token), " data-build=", JSON.stringify(build), ">",
    '<div id="app"></div>',
    ...vendor.flatMap((v) => ["<script>", v, "</script>"]),
    "<script>", read("ui.client.js"), "</script></body></html>",
  ].join("");
}


/**
 * @param {string[]} argv
 * @param {Console} io
 * @param {object} [overrides] TEST SEAMS ONLY. The real defaults are used when a
 *   key is absent, and tests/cli/ui-server.test.mjs also runs once with none, so
 *   the production construction path is exercised (rule:name-what-no-test-executes:
 *   an injection seam is exactly what lets the real arm ship unrun).
 *   Keys: deps, inboxDeps, appendEvent, evidenceFor, readSnapshot, surfacePayload, machinery ({sources, ttlMs, now}), root.
 */
export async function uiCmd(argv = [], io = console, overrides = {}) {
  if (argv.includes("--rotate-token")) {
    const file = rotateToken(stateDir());
    io.log(`propagate ui — wrote a new token to ${file} (mode 0600).`);
    io.log("  The next widget click replaces a running server that still holds the old token;");
    io.log("  Open tabs and bookmarks work again once you reopen the page from the widget.");
    return { rotated: true, file };
  }
  const tokenState = loadOrCreateToken(stateDir());
  const TOKEN = tokenState.token;
  const portArg = argv.indexOf("--port");
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : 4599;
  const root = overrides.root ?? path.join(process.env.HOME ?? "", "Documents/GitHub/");

  const appendEvent = overrides.appendEvent ?? (await import("../lib/edges/events.mjs")).appendEvent;
  const { registerQueue } = await import("../lib/registers/queue.mjs");
  const { planEdit, applyEdit } = await import("../lib/registers/write.mjs");
  const { backlog } = await import("../lib/report/backlog.mjs");
  const evidenceFor = overrides.evidenceFor ?? (await import("../lib/report/evidence.mjs")).evidenceFor;
  const readSnapshot = overrides.readSnapshot ?? (await import("../lib/report/doctor/snapshot.mjs")).readSnapshot;
  const surfacePayload = overrides.surfacePayload ?? (await import("../lib/report/surface.mjs")).surfacePayload;
  // The machinery tiles' data: one cached reader per server (lib/report/machinery.mjs holds the TTL and why).
  const machinery = (await import("../lib/report/machinery.mjs")).createMachinery(overrides.machinery ?? {});
  // F5. The id of the code this process was STARTED from. page() recomputes from
  // disk on every request; the two differ exactly when files changed under a
  // running server, which is the stale-server case.
  const BUILD = buildId();
  const { divergedGuard, buildEventPayload, allowedDispositions } = await import("../lib/edges/disposition.mjs");
  const { buildGraph, blockedBy } = await import("../lib/graph/graph.mjs");
  // Blockers for the rows the write path just re-derived (NOT the browser's
  // snapshot): the graph is built once per write request from fresh rows.
  const allowedForRows = (rows) => {
    const graph = buildGraph(rows);
    return (row) => allowedDispositions(row, blockedBy(graph, row.edge_id));
  };
  const { defaultDeps } = await import("../lib/report/queue.mjs");
  // TWO MODULES EXPORT defaultDeps AND THEY ARE NOT INTERCHANGEABLE.
  // queue.mjs's has {reconcile, loadWorkspaces}; inbox.mjs's adds
  // historyByEdge, planBaseline and registerQueue. Passing the first to
  // inboxPayload returns a 500 that no unit test can see, because every test
  // injects its own deps and therefore never exercises either default.
  const inbox = await import("../lib/report/inbox.mjs");
  const { inboxPayload, referencePayload, baselineBuckets } = inbox;
  const inboxDeps = overrides.inboxDeps ?? (await inbox.defaultDeps());
  const { analyticsPayload } = await import("../lib/report/analytics.mjs");
  const deps = overrides.deps ?? (await defaultDeps());

  /**
   * ONE read for every write-path decision: the reconciled rows, the queue built
   * from them, and the parked set (D11). Items and rows come from the SAME
   * reconcile, so validation and the write cannot disagree about what an edge is.
   *
   * It replaces queuePayload + a second reconcile. The second one existed because
   * a batch row can be seconds old by the time it is clicked; but queuePayload is
   * itself read at REQUEST time, so the second reconcile only narrowed a window of
   * milliseconds. The real staleness (the human's) is handled by `state` moved
   * checks and by `observed` (F1), which compare against these rows.
   *
   * THE PARKED SET (D11) is NEVER_VERIFIED rows carrying a `deferred` flag. They
   * read as NEVER_VERIFIED, which `isActionable` drops, so they are in no queue;
   * someone examined each and parked it, and judging one is legitimate. They go
   * through the SAME divergedGuard / ordering / allowedDispositions as queue
   * items (`allowedFor`). A NEVER_VERIFIED edge that is NOT parked is deliberately
   * absent here: giving it a verdict is a baseline, a different operation.
   */
  const readWorld = async () => {
    const workspaces = await deps.loadWorkspaces();
    const { rows } = await deps.reconcile(workspaces, {});
    const history = await historyByEdge();
    const order = orderFor(rows);
    const items = buildQueue(rows, history, { root, order });
    const allowedFor = allowedForRows(rows);
    const parked = rows
      .filter((r) => r.deferred && r.state === "NEVER_VERIFIED")
      .map((r) => {
        const a = allowedFor(r);
        return {
          edge_id: r.edge_id,
          node_id: r.node_id,
          state: r.state,
          parked: true,
          source: r.source?.path ?? null,
          downstream: r.downstream?.path ?? null,
          lastVerified: history.get(r.edge_id)?.lastVerified ?? null,
          allowed: a.allowed,
          viaOutOfOrder: a.viaOutOfOrder,
        };
      });
    return { rows, items, parked, allowedFor };
  };

  const handle = async (req, res) => {
    const send = (code, body, type = "application/json", extra = {}) => {
      res.writeHead(code, { "content-type": type, ...SECURITY_HEADERS, ...extra });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    // A refusal from guardRequest, as a response: 401 for the token (F9), 403 for
    // Host / Origin. `error:"token"` is the stable word a client keys on; the
    // prose refusal for the others stays human-readable.
    const refuse = (refusal, asText = false) => {
      const code = refusal === TOKEN_REFUSAL ? 401 : 403;
      if (asText) return send(code, refusal, "text/plain");
      return send(code, { ok: false, error: refusal === TOKEN_REFUSAL ? "token" : refusal });
    };

    if (url.pathname === "/") {
      // A tokened visit becomes a cookie session and a CLEAN url (the fragment,
      // i.e. a widget deep link, survives a 302). A cookie alone serves the page.
      // Neither -> falls through to the 404 below, revealing nothing.
      if (tokenEq(url.searchParams.get("token"), TOKEN)) {
        return send(302, "", "text/plain", {
          location: "/",
          "set-cookie": `ptok=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
        });
      }
      if (tokenEq(cookieToken(req), TOKEN)) return send(200, page(TOKEN), "text/html; charset=utf-8");
    }
    // THE GRAPH IS A VIEW HERE, not a file on disk. It used to be generated to
    // ~/.propagate/graph.html and opened directly, which made it a second
    // destination with its own lifetime and no way back. Rupali's requirement:
    // one page holds everything and every link lands on it.
    if (url.pathname === "/graph") {
      const refusal = guardRequest(req, TOKEN, port);
      if (refusal) return refuse(refusal, true);
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const out = path.join(stateDir(), "graph.html");
        await promisify(execFile)(process.execPath, [path.join(import.meta.dirname, "..", "cli.mjs"), "graph", "--html", out], { maxBuffer: 64e6 });
        return send(200, readFileSync(out, "utf8"), "text/html; charset=utf-8");
      } catch (err) {
        return send(500, `could not render the graph — ${String(err?.message ?? err)}`, "text/plain");
      }
    }

    if (url.pathname.startsWith("/api/")) {
      const refusal = guardRequest(req, TOKEN, port);
      if (refusal) return refuse(refusal);

      // F5. What build this PROCESS was started from. Read-only, behind the same
      // guard. The client compares it with its own page's data-build.
      if (url.pathname === "/api/version") return send(200, { ok: true, build: BUILD });

      // The widget's exact payload (D8, narrowed by D10): the browser reads
      // Health, velocity and usage from it. The badges do NOT -- those come from
      // /api/inbox, over the rows the list renders. Read-only; loads after first
      // paint because it costs more than the inbox.
      if (url.pathname === "/api/surface") {
        try { return send(200, await surfacePayload({ root })); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

      // Dashboard Phase 2. Six sources, read in-process and cached for a minute; the client asks
      // AFTER first paint because claims and skills take over a second each. A source that fails
      // is status:"error" inside the body, so one bad source is still a 200 with five good blocks.
      if (url.pathname === "/api/machinery") {
        try { return send(200, await machinery.read({ fresh: url.searchParams.get("fresh") === "1" })); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

      // Dashboard Phase 4a. The pages behind four of the six tiles. Each reads the SAME cached computation as
      // /api/machinery (one run feeds the tile and the page, so their numbers cannot disagree) and is read-only.
      // A source that failed is a 502 with its reason, which the page shows as a banner, never an empty table.
      // /api/rules used to return the raw hub rules check (unfetched, no coverage status, whole file bodies in
      // `lines`); it is this now, so the Rules page and the Rules tile are one answer.
      const viewKey = /^[/]api[/](claims|rules|caps|skills)$/.exec(url.pathname);
      if (viewKey && req.method === "GET") {
        try {
          const r = await machinery.readDetail(viewKey[1], { fresh: url.searchParams.get("fresh") === "1" });
          return send(r.ok ? 200 : 502, r);
        } catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

      // D12. The content-keyed seen-set. GET returns it; POST adds the triples
      // the client actually rendered. Its own file: writeCursor's is untouched.
      if (url.pathname === "/api/seen-edges") {
        if (req.method === "POST") {
          let raw = "";
          for await (const c of req) raw += c;
          let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: "malformed JSON body" }); }
          const v = validateTriples(body?.triples);
          if (!v.ok) return send(400, { ok: false, error: v.error });
          try { return send(200, { ok: true, ...(await addSeen(v.triples)) }); }
          catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
        }
        try { return send(200, { ok: true, ...(await readSeen()) }); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

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

      // STREAM — "what changed since I last looked", folded from the append-
      // only event store by lib/report/stream.mjs. Same shape as /api/analytics
      // above: in-process, no subprocess, behind the same guardRequest. `since`
      // is an optional query param (an ISO string); when absent or unparseable,
      // streamPayload() itself defaults to the last 7 days rather than
      // "everything" and says so via the payload's own `sinceSource`.
      if (url.pathname === "/api/stream") {
        // PR-023. An explicit ?since= still wins; otherwise the window comes
        // from the cursor the reader last marked. `readCursor` never throws
        // and never invents a boundary -- missing and corrupt both fall back
        // to seven days -- so a lost or damaged cursor degrades to today's
        // behaviour rather than reporting that everything changed.
        //
        // The cursor's STATUS rides alongside rather than inside the payload:
        // streamPayload derives `sinceSource` from whether `since` was given,
        // which would read "given" here and lose where it came from. The
        // panel needs to tell "since you last looked" from "the last seven
        // days because you have never marked one" -- different facts.
        try {
          const explicit = url.searchParams.get("since");
          const cursor = explicit ? null : await readCursor();
          const payload = await streamPayload({ since: explicit ?? cursor?.since });
          return send(200, { ...payload, cursor: cursor ? { status: cursor.status, error: cursor.error ?? null } : null });
        } catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

      // T4/R2. The refusals the bridge produces had no reader anywhere --
      // measured on 2026-09-25, nothing in lib/report/surface.mjs or this file
      // carried a held row, so every refusal existed and no surface showed it.
      // That is the invisible-work defect PR-021 documents, one layer out.
      //
      // DRY RUN, always. Opening a panel must never write, and a reader could
      // otherwise mistake looking for applying -- so `apply` is not plumbed
      // through from the query string at all, rather than defaulting to false
      // where a future edit could flip it.
      //
      // The read is bounded at doctor's 3s rather than readRaw's 15s default:
      // this is an HTTP request a human is waiting on, and a hung Reminders
      // read would otherwise hold the panel for fifteen seconds.
      if (url.pathname === "/api/conflicts") {
        try {
          const { syncReminders } = await import("../lib/reminders/sync.mjs");
          const { readReminders } = await import("../lib/reminders/read.mjs");
          const { DOCTOR_READ_TIMEOUT_MS } = await import("../lib/report/doctor/reminders.mjs");
          const out = await syncReminders({
            apply: false,
            readRemindersFn: () => readReminders({ timeoutMs: DOCTOR_READ_TIMEOUT_MS }),
          });
          return send(200, out);
        } catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

      // PR-023. The ONLY thing this writes is the cursor. It takes the
      // timestamp from the body rather than reading the clock, because the
      // reader saw a specific payload: anything that arrived between that
      // render and this click has NOT been seen, and stamping `now` would
      // silently swallow it. That is the whole reason advance-on-view was
      // rejected, and reading the clock here would reintroduce it by a
      // shorter path.
      if (url.pathname === "/api/seen" && req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: "malformed JSON body" }); }
        const invalid = validateSeenBody(body);
        if (invalid) return send(invalid.code, { ok: false, error: invalid.error });
        try { return send(200, { ok: true, since: await writeCursor(body.at) }); }
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

        // F12. These reads used to be unwrapped: a throw in reconcile or the
        // queue build escaped the async handler, which Node treats as an
        // unhandled rejection, and the process died together with any held write.
        // Every dependency call below sits behind one catch that answers JSON.
        let world;
        const by = `${process.env.USER || "ui"} (ui)`;
        try {
          // THE CROSS-NODE BATCH (D9): {edges:[{edge_id,state,observed?}], disposition, reason}.
          // Checked FIRST on `edges` being present, so it is never misread as an
          // incomplete single-edge or node batch.
          if (body.edges !== undefined) {
            world = await readWorld();
            const v = validateEdgesBatch(body, { items: world.items, parked: world.parked });
            if (v.fatal) return send(v.fatal.code, { ok: false, error: v.fatal.error });
            const written = await applyBatchDispose({
              body,
              members: v.members,
              rows: world.rows,
              appendEvent,
              buildEventPayload,
              divergedGuard,
              by,
              allowedFor: world.allowedFor,
            });
            // Results in the order the client sent them, whichever stage refused.
            const byId = new Map([...v.refused, ...written.results].map((r) => [r.edge_id, r]));
            const results = body.edges.map((e) => byId.get(e.edge_id));
            const ok = results.every((r) => r.ok);
            return send(ok ? 200 : 207, { ok, results });
          }

          // BATCH: {node_id, state, disposition, reason}. Checked on node_id's
          // presence, BEFORE the single-edge path, so a batch body (which has
          // no edge_id of its own) is never misread as an incomplete
          // single-edge request.
          if (body.node_id !== undefined) {
            // `observed`, when sent, is a map edge_id -> {source, downstream}.
            if (body.observed !== undefined && (!body.observed || typeof body.observed !== "object" || Array.isArray(body.observed))) {
              return send(400, { ok: false, error: "observed must be an object mapping edge_id to {source, downstream}" });
            }
            world = await readWorld();
            // EVERY actionable edge currently sharing node_id, at WHATEVER
            // state each one reads — never pre-filtered to body.state, or a
            // mixed-state group would be silently narrowed instead of refused.
            const members = world.items
              .filter((i) => i.node_id === body.node_id)
              .map((i) => ({ ...i, observed: body.observed?.[i.edge_id] }));
            const invalid = validateBatchWrite(body, members);
            if (invalid) return send(invalid.code, { ok: false, error: invalid.error });

            const result = await applyBatchDispose({
              body,
              members,
              rows: world.rows,
              appendEvent,
              buildEventPayload,
              divergedGuard,
              by,
              allowedFor: world.allowedFor,
            });
            // 200 only when every member landed. A partial failure still
            // returns 200-shaped JSON with ok:false plus the per-edge_id
            // array — never a bare {ok:true} that hides which member failed —
            // so 207 (Multi-Status) marks the mixed case at the transport
            // level too, for a client that only checks the status code.
            return send(result.ok ? 200 : 207, result);
          }

          world = await readWorld();
          // D11: a parked edge is judgeable here too; the queue wins on a shared id.
          const item = world.items.find((i) => i.edge_id === body.edge_id) ?? world.parked.find((i) => i.edge_id === body.edge_id);
          const invalid = validateWrite(body, item);
          if (invalid) return send(400, { ok: false, error: invalid });

          // The row comes from the SAME reconcile as the item, then runs the SAME
          // guards verify uses. The browser's snapshot may be seconds old; these
          // are checked against rows read now, not against what the page was
          // rendered from.
          const row = world.rows.find((r) => r.edge_id === body.edge_id);
          if (!row) return send(409, { ok: false, error: "edge vanished between render and write — reload" });
          const seen = observedRefusal(body.observed, row);
          if (seen) return send(seen.code, { ok: false, error: seen.error });
          const guard = divergedGuard(row.state, body.disposition);
          if (guard) return send(409, { ok: false, error: guard });
          const ordering = orderingRefusal(world.allowedFor(row), body.disposition);
          if (ordering) return send(409, { ok: false, error: ordering });

          try {
            const stamped = await appendEvent(buildEventPayload(row, body.disposition, String(body.reason).trim(), by));
            return send(200, { ok: true, event_id: stamped.event_id });
          } catch (err) {
            return send(400, { ok: false, error: String(err?.message ?? err) });
          }
        } catch (err) {
          return send(500, { ok: false, error: String(err?.message ?? err) });
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

        // F12: see /api/dispose. A throw from the queue read, the register walk
        // or the diff reader answers {ok:false,error} with 500; it never kills
        // the process.
        try {
          let allowed = false;
          let contentIds = null;
          if (body.kind === "edge") {
            const world = await readWorld();
            // D11: a parked edge has evidence too, labelled "no earlier verdict".
            const item = world.items.find((i) => i.edge_id === body.edge_id) ?? world.parked.find((i) => i.edge_id === body.edge_id);
            if (!item) return send(404, { ok: false, error: "no such actionable edge — reload" });
            // The path and the commit come from the LEDGER, never from the
            // browser, so neither can be pointed somewhere else.
            body.file = item.source;
            body.sinceCommit = item.lastVerified?.commit ?? null;
            body.dirty = !!item.lastVerified?.dirty;
            body.downstreamFile = item.downstream;
            body.downstreamSinceCommit = item.lastVerified?.downstreamCommit ?? null;
            body.downstreamDirty = item.lastVerified?.downstreamDirty ?? null;
            body.showCurrentWhenNoVerdict = item.parked === true;
            // F1. The content pair of the SAME rows this item came from. The
            // client echoes it back as `observed` on the verdict; the write is
            // refused if the row no longer says this. The diff is read AFTER
            // these ids were taken, so an edit in between leaves the ids OLDER
            // than the diff -- the refusal fires, which is the safe direction.
            const row = world.rows.find((r) => r.edge_id === body.edge_id);
            contentIds = { source: row?.source?.contentId ?? null, downstream: row?.downstream?.contentId ?? null };
            allowed = true;
          } else {
            const known = registerQueue({ backlogFn: backlog });
            const set = new Set([...(known.issues ?? []), ...(known.todos ?? [])].map((i) => i.file));
            allowed = set.has(body.file);
          }
          if (!allowed) return send(403, { ok: false, error: `${body.file} is not a file this surface reads` });

          const ev = await evidenceFor(body);
          return send(200, contentIds ? { ...ev, contentIds } : ev);
        } catch (err) {
          return send(500, { ok: false, error: String(err?.message ?? err) });
        }
      }

      // HEALTH — doctor's own sections, from the snapshot the monitor writes.
      // Not re-run here: doctor costs ~37s and this is a page load.
      if (url.pathname === "/api/health") {
        try {
          const snap = await readSnapshot();
          if (!snap.ok) return send(200, { ok: false, reason: snap.reason, sections: null, ageMs: snap.ageMs ?? null });
          return send(200, { ok: true, ageMs: snap.ageMs, generatedAt: snap.payload.generatedAt,
            problems: snap.payload.problems, totals: snap.payload.totals, sections: snap.payload.sections });
        } catch (err) {
          return send(500, { ok: false, error: String(err?.message ?? err) });
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
  };

  // The last line of F12's defence. Each endpoint above answers its own errors,
  // but an async handler's rejection is unhandled and Node exits on it, so one
  // missed await would still take the server (and a held write) down.
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json", ...SECURITY_HEADERS });
        }
        res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
      } catch { /* the socket is already gone */ }
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const link = `http://127.0.0.1:${port}/?token=${TOKEN}`;
  io.log(`propagate ui — ${link}`);
  io.log(`  loopback only, stable token in ${tokenState.file} (mode 0600). Ctrl-C to stop.`);
  if (tokenState.tightened) io.log(`  tightened ${tokenState.file} from mode ${tokenState.tightened} to 0600.`);
  return { server, port, token: TOKEN, link };
}
