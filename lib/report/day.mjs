/**
 * lib/report/day.mjs — `propagate day open` / `propagate day close` (propagate#240).
 *
 * day open  : read-only. Does the Ready supply on EVERY open board cover today's budget (cap minus use)?
 * day close : dry-run unless `apply`. Proposes promotions (Backlog -> Ready) and closure fixes (closed issue whose
 *             Status is not Done -> Done, Finished = closedAt's local date). With `apply` it writes ONLY those two
 *             kinds, batched, then reads every written item back by node id (gotcha G-S: item listings undercount).
 *
 * The ONLY write path is `fetcher.write`, reached from exactly one place, behind `apply === true` and a non-empty
 * mutation list (rule:safety-flag-needs-a-test). Everything else goes through `fetcher.graphql`.
 *
 * A board is read through ITS OWN Status vocabulary. A board whose Status field lacks Backlog / Ready / In progress /
 * Done is named and skipped, never guessed. The read has a readiness floor: 0 open boards, or an item with no field
 * values, means the read has gone blind (a secondary rate limit fails GraphQL while points remain, and an empty read
 * looks like an empty board), never "nothing to do".
 *
 * Costs are WEEK-% POINTS. Calibrated Sizes use sprint-plan's calibrate/demand; the rest use a COUNT BASIS derived
 * each run (week-% consumed in 7 days / items Finished in 7 days), or the command exits 2 "cannot judge".
 */

import { checkGoals, goalsSummaryLine, appetiteEnd } from "./goals-check.mjs";
import { goalId } from "./goals.mjs";
import { MIN_RATE_LIMIT, estimateNeed, sampleChecks, deriveRatio, calibrate, cutList } from "./sprint-plan.mjs";

export const READY_TARGET = 3;
const CHUNK = 20; // aliased mutations / node reads per GraphQL request
const BOARDS_PER_QUERY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIZE_ORDER = ["XS", "S", "M", "L", "XL"];
const BLOCK_LABEL = /block|question|decision|waiting|needs-/i;
export const STATUS_NAMES = ["Backlog", "Ready", "In progress", "Done"];

const gqlString = (s) => JSON.stringify(String(s));
const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const key = (it) => `${it.repo ?? "?"}#${it.number}`;

class Blind extends Error {}

// ── the Done-when matcher ───────────────────────────────────────────────────

/** Remove fenced blocks and inline backtick spans: prose that DISCUSSES a marker must not count as stating one. */
export function stripCode(body) {
  return String(body ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/~~~[\s\S]*?(~~~|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/** A STATED condition: a heading / bold / bare line starting "Done when", or a sentence-initial "Done when". */
export function hasDoneWhen(body) {
  const t = stripCode(body);
  if (/^\s*(#+\s*)?[*_]*done when\b/im.test(t)) return true;
  return /(^|\.\s)done when\b/i.test(t);
}

// ── queries ─────────────────────────────────────────────────────────────────

export const DAY_LISTING_QUERY =
  "query{viewer{projectsV2(first:100){totalCount nodes{id number title closed fields(first:30){nodes{" +
  "... on ProjectV2SingleSelectField{id name options{id name}}" +
  "... on ProjectV2Field{id name dataType}}}}}}}";

const CONTENT =
  "state closedAt repository{nameWithOwner} milestone{title} labels(first:20){nodes{name}}";
const FV =
  "fieldValues(first:20){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}" +
  "... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}}" +
  "... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}}}";
const FRAGMENTS =
  `fragment I on ProjectV2Item{id content{... on Issue{number title ${CONTENT}}... on PullRequest{number title ${CONTENT}}} ${FV}} ` +
  `fragment IB on ProjectV2Item{id content{... on Issue{number title body ${CONTENT}}... on PullRequest{number title body ${CONTENT}}} ${FV}}`;

export const GROUPS = ["ready", "prog", "backlog", "done", "recent", "stale"];

/** One aliased block per board: the alias names are the contract the tests' fake fetcher also honours. */
export function dayDetailQuery(numbers, since) {
  const conn = (alias, q, frag) => `${alias}:items(first:100,query:${gqlString(q)}){totalCount nodes{...${frag}}}`;
  const blocks = numbers
    .map(
      (n) =>
        `b${n}:projectV2(number:${n}){number title ` +
        [
          conn("ready", "status:Ready", "IB"),
          conn("prog", 'status:"In progress"', "IB"),
          conn("backlog", "status:Backlog", "IB"),
          conn("done", "status:Done", "I"),
          conn("recent", `status:Done updated:>=${since}`, "I"),
          conn("stale", "is:closed -status:Done", "I"),
        ].join(" ") +
        "}",
    )
    .join(" ");
  return `query{viewer{${blocks}}} ${FRAGMENTS}`;
}

/** One request: aliased updateProjectV2ItemFieldValue calls. Pure text, so a test can read exactly what is written. */
export function writeMutation(ops) {
  const body = ops
    .map(
      (o, i) =>
        `m${i}:updateProjectV2ItemFieldValue(input:{projectId:${gqlString(o.projectId)},itemId:${gqlString(o.itemId)},` +
        `fieldId:${gqlString(o.fieldId)},value:${o.value}}){projectV2Item{id}}`,
    )
    .join(" ");
  return `mutation{${body}}`;
}

/** Read-back: every written item by node id, never the board listing. */
export function readBackQuery(ids) {
  const blocks = ids.map((id, i) => `r${i}:node(id:${gqlString(id)}){... on ProjectV2Item{id ${FV}}}`).join(" ");
  return `query{${blocks}}`;
}

// ── boards ──────────────────────────────────────────────────────────────────

/** @returns {{boards: object[], skipped: {number:number,title:string,why:string}[], total:number}} open boards only */
export function normalizeDayListing(data) {
  const nodes = data?.viewer?.projectsV2?.nodes;
  if (!Array.isArray(nodes)) throw new Error("listing response had no viewer.projectsV2.nodes");
  const boards = [];
  const skipped = [];
  for (const b of nodes) {
    if (!b || b.closed) continue;
    const fields = (b.fields?.nodes ?? []).filter((f) => f && f.name);
    const status = fields.find((f) => f.name.toLowerCase() === "status" && Array.isArray(f.options));
    const opt = {};
    for (const want of STATUS_NAMES) {
      const o = status?.options.find((x) => String(x.name).toLowerCase() === want.toLowerCase());
      if (o) opt[want] = o.id;
    }
    const lacking = STATUS_NAMES.filter((s) => !opt[s]);
    if (lacking.length) {
      skipped.push({
        number: b.number,
        title: b.title,
        why: status ? `Status has no ${lacking.join(", ")} option (has ${status.options.map((o) => o.name).join(" / ")})` : "no Status field",
      });
      continue;
    }
    const finished = fields.find((f) => f.name.toLowerCase() === "finished" && f.dataType === "DATE");
    const hasGoalField = fields.some((f) => f.name.toLowerCase() === "goal");
    boards.push({ projectId: b.id, number: b.number, title: b.title, statusFieldId: status.id, statusOptions: opt, finishedFieldId: finished?.id ?? null, hasGoalField });
  }
  return { boards, skipped, total: data.viewer.projectsV2.totalCount ?? nodes.length };
}

// The no-field-values floor applies to the status-filtered groups only: an item with Status unset legitimately
// matches `is:closed -status:Done` and has no field values (found on the real boards, kirtik-website#127).
function normalizeItem(node, board, requireFields = true) {
  const c = node?.content;
  if (!c || typeof c.number !== "number") return null;
  const fvs = node.fieldValues?.nodes;
  if (requireFields && (!Array.isArray(fvs) || fvs.filter((v) => v && v.field).length === 0)) {
    throw new Blind(`board ${board.number}: item ${c.repository?.nameWithOwner ?? "?"}#${c.number} came back with no field values`);
  }
  const it = {
    id: node.id,
    board: board.number,
    boardTitle: board.title,
    number: c.number,
    title: c.title ?? "",
    repo: c.repository?.nameWithOwner ?? null,
    labels: (c.labels?.nodes ?? []).map((l) => l.name),
    milestone: c.milestone?.title ?? null,
    state: c.state ?? "OPEN",
    closedAt: c.closedAt ?? null,
    body: c.body ?? "",
    // Every single-select name and number value by field name (propagate#264: goals check reads Goal, Priority, Model, Order).
    fields: {},
    status: null,
    size: null,
    itemType: null,
    finished: null,
    tokens: null,
    minutes: null,
  };
  for (const v of fvs ?? []) {
    const fname = v?.field?.name;
    if (fname && typeof v.name === "string") it.fields[fname] = v.name;
    else if (fname && typeof v.number === "number") it.fields[fname] = v.number;
    const name = String(v?.field?.name ?? "").toLowerCase();
    if (name === "status" && typeof v.name === "string") it.status = v.name;
    else if (name === "size" && typeof v.name === "string") it.size = v.name;
    else if (name === "item type" && typeof v.name === "string") it.itemType = v.name;
    else if (name === "finished" && typeof v.date === "string") it.finished = v.date;
    else if (name === "tokens" && typeof v.number === "number") it.tokens = v.number;
    else if (name === "minutes" && typeof v.number === "number") it.minutes = v.number;
  }
  return it;
}

const isClosed = (it) => it.state === "CLOSED" || it.state === "MERGED";
const statusIs = (it, name) => String(it.status ?? "").toLowerCase() === name.toLowerCase();

/** @returns {{byBoard: Map<number, object>, truncated: string[]}} each board: {ready, prog, backlog, done, recent, stale} */
export function normalizeDayDetail(data, boards) {
  const byBoard = new Map();
  const truncated = [];
  for (const board of boards) {
    const b = data?.viewer?.[`b${board.number}`];
    if (!b) throw new Error(`detail response had no board ${board.number}`);
    const groups = {};
    for (const g of GROUPS) {
      const conn = b[g];
      if (!conn || !Array.isArray(conn.nodes)) throw new Error(`board ${board.number} returned no "${g}" connection`);
      groups[g] = conn.nodes.map((n) => normalizeItem(n, board, g !== "stale")).filter(Boolean);
      if ((conn.totalCount ?? 0) > conn.nodes.length) truncated.push(`board ${board.number} ${g}: ${conn.nodes.length} of ${conn.totalCount}`);
    }
    byBoard.set(board.number, groups);
  }
  return { byBoard, truncated };
}

// ── promotion ───────────────────────────────────────────────────────────────

export function priorityRank(it) {
  for (const l of it.labels ?? []) {
    const m = /^(?:priority:)?P([0-3])$/i.exec(l);
    if (m) return Number(m[1]);
  }
  return 9;
}
const sizeRank = (it) => {
  const i = SIZE_ORDER.indexOf(String(it.size ?? "").toUpperCase());
  return i === -1 ? 99 : i;
};
/** Case-insensitive read of one board field from an item's `fields` map (as goals check does); undefined when unset or blank. */
export function fieldOf(it, name) {
  for (const [k, v] of Object.entries(it?.fields ?? {})) {
    if (k.toLowerCase() === name.toLowerCase()) return typeof v === "string" && v.trim() === "" ? undefined : v;
  }
  return undefined;
}
const priorityFieldRank = (it) => {
  const m = /^P([0-3])$/i.exec(String(fieldOf(it, "Priority") ?? ""));
  return m ? Number(m[1]) : 9;
};
const orderRank = (it) => {
  const v = fieldOf(it, "Order");
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : Infinity; // unordered items come after ordered ones
};
/** Order field ascending, then Priority field P0..P3, then the label rank (tie-breaker), then Size, then number. */
export const promotionOrder = (items) =>
  [...items].sort((a, b) => {
    const oa = orderRank(a);
    const ob = orderRank(b);
    if (oa !== ob) return oa < ob ? -1 : 1;
    return priorityFieldRank(a) - priorityFieldRank(b) || priorityRank(a) - priorityRank(b) || sizeRank(a) - sizeRank(b) || a.number - b.number;
  });

const blockedLabel = (it) => (it.labels ?? []).some((l) => BLOCK_LABEL.test(l));
const isEpic = (it) => String(it.itemType ?? "").toLowerCase() === "epic";

/** The active entries of parsed GOALS.md files (`parseGoalsFile`); an unread file contributes none. */
export function activeGoalEntries(goalFiles) {
  const out = [];
  for (const f of goalFiles ?? []) {
    if (!f || f.unread) continue;
    for (const e of f.entries ?? []) if (e.active) out.push(e);
  }
  return out;
}
export const activeGoalIds = (goalFiles) => new Set(activeGoalEntries(goalFiles).map(goalId));

/** Why an item's Goal does not permit promotion, or null. FAILS CLOSED: no active goal read refuses everything. */
export function goalGap(it, active) {
  if (!(active instanceof Set) || active.size === 0) return "no active goal was read";
  const g = fieldOf(it, "Goal");
  if (g === undefined) return "no Goal";
  const s = String(g);
  if (["parked", "idea"].includes(s.toLowerCase()) || !active.has(s)) return `Goal is ${s}, not an active goal`;
  return null;
}

/** Day-close rule 3, one item: why it is not promotable, or null when it is. `active` is the Set of active goal ids. */
export function promotionGap(it, active) {
  if (isClosed(it)) return "closed";
  if (!statusIs(it, "Backlog")) return `Status is ${it.status ?? "unset"}`;
  if (isEpic(it)) return "an Epic";
  if (blockedLabel(it)) return "carries a block/question/decision/waiting label";
  const gg = goalGap(it, active);
  if (gg) return gg;
  const missing = [];
  if (!it.size) missing.push("Size");
  if (!hasDoneWhen(it.body)) missing.push("Done when");
  return missing.length ? `missing ${missing.join(" and ")}` : null;
}

// ── shared: read the boards ─────────────────────────────────────────────────

export async function readBoards({ fetcher, now, count }) {
  const stop = (reason) => ({ stop: reason });
  let rl;
  try {
    rl = fetcher.rateLimit();
  } catch (e) {
    return stop(`could not read the GitHub rate limit: ${e.message}`);
  }
  if (!rl?.graphql || typeof rl.graphql.remaining !== "number") return stop("could not read the GitHub rate limit (no graphql.remaining)");
  if (rl.graphql.remaining < MIN_RATE_LIMIT) return stop(`GraphQL remaining ${rl.graphql.remaining} is below ${MIN_RATE_LIMIT}; refusing to start (nothing fetched)`);

  let listing;
  try {
    count();
    listing = normalizeDayListing(await fetcher.graphql(DAY_LISTING_QUERY));
  } catch (e) {
    return stop(`board listing failed: ${e.message}`);
  }
  const openCount = listing.boards.length + listing.skipped.length;
  if (openCount === 0) return stop("the read has gone blind: the listing returned 0 open boards (a secondary rate limit looks like this); not 'nothing to do'");
  if (listing.boards.length === 0) return stop(`no open board has the Backlog / Ready / In progress / Done Status vocabulary (${listing.skipped.length} skipped)`);

  const need = estimateNeed(listing.boards.length);
  if (rl.graphql.remaining < need) return stop(`GraphQL remaining ${rl.graphql.remaining} is below the ${need} estimated for ${listing.boards.length} boards; refusing to fetch items`);

  const since = ymd(new Date(now - 7 * DAY_MS));
  const byBoard = new Map();
  const truncated = [];
  try {
    for (let i = 0; i < listing.boards.length; i += BOARDS_PER_QUERY) {
      const chunk = listing.boards.slice(i, i + BOARDS_PER_QUERY);
      count();
      const d = normalizeDayDetail(await fetcher.graphql(dayDetailQuery(chunk.map((b) => b.number), since)), chunk);
      for (const [k, v] of d.byBoard) byBoard.set(k, v);
      truncated.push(...d.truncated);
    }
  } catch (e) {
    if (e instanceof Blind) return stop(`the read has gone blind: ${e.message}`);
    return stop(`board item fetch failed: ${e.message}`);
  }
  return { rl, listing, byBoard, truncated };
}

/** The shape `checkGoals` takes: each board's open Ready and In progress items, with the board's Goal-field presence. */
export function boardsForGoals(read) {
  return read.listing.boards.map((b) => {
    const g = read.byBoard.get(b.number);
    const mk = (status) => (it) => ({ ref: key(it), board: b.number, status, fields: it.fields ?? {}, doneWhen: hasDoneWhen(it.body) });
    return {
      number: b.number,
      title: b.title,
      hasGoalField: b.hasGoalField === true,
      // A group cut off at first:100 was checked only in part; checkGoals says so rather than counting it clean.
      truncated: read.truncated.filter((t) => t.startsWith(`board ${b.number} ready:`) || t.startsWith(`board ${b.number} prog:`)),
      items: [...g.ready.filter((i) => !isClosed(i)).map(mk("Ready")), ...g.prog.filter((i) => !isClosed(i)).map(mk("In progress"))],
    };
  });
}

const uniqueBy = (items, f) => [...new Map(items.map((i) => [f(i), i])).values()];

// ── day open ────────────────────────────────────────────────────────────────

/**
 * Week-% points consumed in the last 7 days: the sum of positive increments between consecutive ok:true samples.
 * A pair that spans a weekly reset has a negative increment and is skipped, so consumption before the reset still counts.
 */
export function weekPointsConsumed(rows, now) {
  const from = now - 7 * DAY_MS;
  const ok = (rows ?? [])
    .filter((r) => r?.ok === true && typeof r.week_pct === "number" && Date.parse(r.t) >= from && Date.parse(r.t) <= now)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (ok.length < 2) return { missing: `${ok.length} ok:true sample(s) in 7 days; a span needs 2` };
  let pts = 0;
  for (let i = 1; i < ok.length; i++) {
    const d = ok[i].week_pct - ok[i - 1].week_pct;
    if (d > 0) pts += d;
  }
  if (pts <= 0) return { missing: "no week-% consumption measured in the 7-day sample span" };
  return { pts };
}

/** The count basis: points per finished item, derived each run. */
export function countBasis(rows, finishedItems, now) {
  const used = weekPointsConsumed(rows, now);
  if (used.missing) return { missing: `no sample span: ${used.missing}` };
  const from = ymd(new Date(now - 7 * DAY_MS));
  const today = ymd(new Date(now));
  const n = uniqueBy(finishedItems.filter((i) => i.finished && i.finished >= from && i.finished <= today), key).length;
  if (n === 0) return { missing: "no item has a Finished date in the last 7 days across the boards" };
  return { perItem: used.pts / n, pts: used.pts, n, label: `count basis (derived: ${fmt(used.pts)} pts / ${n} items, 7 d)` };
}

const GROUP_LABEL = { prog: "In progress", ready: "Ready", backlog: "Backlog", done: "Done" };

/**
 * propagate#240: one block per ACTIVE goal, from the boards already read (no GraphQL call is made here).
 * A group cut off at first:100 is shown as "≥N", never as a total.
 */
function goalBlocks({ goalFiles, active, read, ready, prog, backlog, now }) {
  const cut = (g) => read.truncated.some((t) => new RegExp(`^board \\d+ ${g}:`).test(t));
  const done = uniqueBy([...read.byBoard.values()].flatMap((g) => g.done), (i) => i.id);
  const groups = { prog, ready, backlog, done };
  const today = new Date(now).toISOString().slice(0, 10);
  const underGoal = (it, id) => String(fieldOf(it, "Goal") ?? "") === id;
  const blocks = activeGoalEntries(goalFiles).map((e) => {
    const id = goalId(e);
    let appetite = { recorded: false };
    if (e.appetiteWeeks !== null && e.appetiteWeeks !== undefined && e.activeSince) {
      const end = appetiteEnd(e.activeSince, e.appetiteWeeks);
      const daysLeft = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
      appetite = { recorded: true, weeks: e.appetiteWeeks, since: e.activeSince, end, daysLeft };
    }
    const counts = {};
    for (const [g, items] of Object.entries(groups)) counts[g] = { n: items.filter((i) => underGoal(i, id)).length, atLeast: cut(g) };
    const readyByOrder = promotionOrder(ready.filter((i) => underGoal(i, id))).map((i) => ({
      order: fieldOf(i, "Order") ?? null,
      priority: fieldOf(i, "Priority") ?? null,
      model: fieldOf(i, "Model") ?? null,
      size: i.size ?? null,
      ref: key(i),
      title: i.title,
    }));
    return { id, title: e.title, appetite, counts, readyByOrder };
  });
  const notUnder = ready.filter((i) => !active.has(String(fieldOf(i, "Goal") ?? ""))).map((i) => ({ board: i.board, ref: key(i), title: i.title }));
  return { goalBlocks: blocks, readyNotUnderActiveGoal: notUnder };
}

/**
 * @param {object} a
 * @param {object[]} a.sampleRows parsed samples
 * @param {number} a.now epoch ms
 * @param {{dailyCap: Function, dayUsed: Function}|null} a.widget
 * @param {object} a.fetcher {rateLimit, graphql}
 * @param {object[]} a.laneRows
 */
export async function buildDayOpen({ sampleRows, now, widget, widgetMissing, fetcher, laneRows, goalFiles = null }) {
  const res = { command: "day open", exit: 2, graphqlCalls: 0, notes: [] };
  const stop = (reason) => ({ ...res, exit: 2, reason });
  if (!widget) return stop(`could not compute (daily-cap source not configured: set PROPAGATE_USAGE_WIDGET_DIR)${widgetMissing ? `: ${widgetMissing}` : ""}`);

  const pre = sampleChecks({ rows: sampleRows, now, widget });
  if (!pre.ok) return stop(pre.reason);
  const left = Math.max(0, pre.cap.cap - pre.usedPct);
  res.budget = { cap: pre.cap.cap, used: pre.usedPct, points: left, capBasis: pre.cap.basis, weekPct: pre.latest.week_pct };

  const read = await readBoards({ fetcher, now, count: () => res.graphqlCalls++ });
  if (read.stop) return stop(read.stop);
  res.skipped = read.listing.skipped;
  res.notes.push(...read.truncated.map((t) => `truncated at first:100, not paged: ${t}`));
  // propagate#264: the goals summary comes from the boards this read already holds (no second GraphQL read).
  if (goalFiles) res.goals = checkGoals({ files: goalFiles, boards: boardsForGoals(read), now });

  const all = [...read.byBoard.values()];
  const ready = uniqueBy(all.flatMap((g) => g.ready).filter((i) => !isClosed(i)), (i) => i.id);
  const prog = all.flatMap((g) => g.prog).filter((i) => !isClosed(i));
  const doneItems = uniqueBy(all.flatMap((g) => [...g.done, ...g.recent]), (i) => i.id);
  const backlog = all.flatMap((g) => g.backlog);

  const ratio = deriveRatio(laneRows);
  const calibration = calibrate(doneItems, laneRows, ratio);
  const basis = countBasis(sampleRows, doneItems, now);
  res.basis = basis.missing ? { missing: basis.missing } : { label: basis.label, perItem: basis.perItem };

  const costOf = (it) => {
    const c = it.size ? calibration[it.size] : null;
    if (c?.status === "calibrated") return { points: c.pointsPerItem, how: "calibrated" };
    if (basis.perItem !== undefined) return { points: basis.perItem, how: "count" };
    return null;
  };

  const active = activeGoalIds(goalFiles);
  const priced = [];
  for (const it of ready) {
    const c = costOf(it);
    if (!c) return stop(`cannot judge: ${key(it)} has no calibrated Size and the count basis is not derivable (${basis.missing})`);
    priced.push({ ...it, points: c.points, how: c.how });
  }
  const supply = priced.reduce((a, i) => a + i.points, 0);
  res.supply = supply;
  res.readyTotal = ready.length;
  res.calibratedReady = priced.filter((i) => i.how === "calibrated").length;
  res.perBoard = read.listing.boards.map((b) => {
    const items = priced.filter((i) => i.board === b.number);
    return { number: b.number, title: b.title, ready: items.length, points: items.reduce((a, i) => a + i.points, 0) };
  });
  res.inProgress = prog.map((i) => ({ board: i.board, ref: key(i), title: i.title }));
  if (goalFiles) Object.assign(res, goalBlocks({ goalFiles, active, read, ready, prog, backlog, now }));
  res.readyNoSize = ready.filter((i) => !i.size).map((i) => ({ board: i.board, ref: key(i), title: i.title }));

  const budget = left;
  if (supply < budget) {
    const gap = budget - supply;
    const candidates = promotionOrder(backlog.filter((i) => promotionGap(i, active) === null));
    const fill = [];
    let got = 0;
    for (const it of candidates) {
      if (got >= gap) break;
      const c = costOf(it);
      fill.push({ board: it.board, ref: key(it), size: it.size, title: it.title, points: c ? c.points : null });
      if (!c) {
        if (fill.length >= 5) break;
        continue;
      }
      got += c.points;
    }
    res.fill = fill;
    return { ...res, exit: 1, verdict: "short", gap, reason: `short by ~${fmt(gap)} points: Ready supply ${fmt(supply)} against a budget of ${fmt(budget)}` };
  }
  if (supply > 2 * budget) {
    const cut = cutList(priced, budget);
    res.cut = { keptPoints: cut.keptPoints, items: cut.cut.map((i) => ({ board: i.board, ref: key(i), size: i.size, title: i.title, points: i.points })) };
    return { ...res, exit: 1, verdict: "over", reason: `over: Ready supply ${fmt(supply)} points is more than twice the budget of ${fmt(budget)}; ${cut.cut.length} item(s) will not fit` };
  }
  return { ...res, exit: 0, verdict: "enough", reason: `enough: Ready supply ${fmt(supply)} points against a budget of ${fmt(budget)}` };
}

export function renderDayOpen(r) {
  const L = ["propagate day open (read-only)"];
  if (r.budget) {
    const b = r.budget;
    L.push(`budget: ${fmt(b.points)} week-% points left today = cap ${fmt(b.cap)} - used ${fmt(b.used)}  (week at ${fmt(b.weekPct)}%)`, `  daily cap: ${b.capBasis}`);
  }
  if (r.inProgress?.length) {
    L.push(`carry-over: ${r.inProgress.length} In progress`);
    for (const i of r.inProgress) L.push(`  ${i.ref} (board ${i.board}) ${i.title}`);
  }
  if (r.perBoard) {
    L.push(`supply: ${r.readyTotal} Ready item(s) across ${r.perBoard.length} board(s) = ${fmt(r.supply)} points (calibrated ${r.calibratedReady}, rest on the count basis)`);
    for (const b of r.perBoard.filter((x) => x.ready > 0)) L.push(`  board ${b.number} ${b.title}: ${b.ready} Ready = ${fmt(b.points)} points`);
    if (r.basis) L.push(`  cost basis for uncalibrated items: ${r.basis.label ?? `not derivable: ${r.basis.missing}`}`);
  }
  if (r.readyNoSize?.length) {
    L.push(`Ready with no Size (${r.readyNoSize.length}):`);
    for (const i of r.readyNoSize) L.push(`  ${i.ref} (board ${i.board}) ${i.title}`);
  }
  if (r.fill) {
    L.push(`top promotable Backlog items that would fill the gap (${r.fill.length}):`);
    for (const i of r.fill) L.push(`  ${i.ref} [${i.size}] ${i.points === null ? "cost not derivable" : `~${fmt(i.points)} pts`}  ${i.title}`);
    if (!r.fill.length) L.push("  none: no Backlog item passes the promotion rule");
  }
  if (r.cut) {
    L.push(`will not fit (${r.cut.items.length}), kept ${fmt(r.cut.keptPoints)} points:`);
    for (const i of r.cut.items) L.push(`  ${i.ref} [${i.size ?? "no size"}] ~${fmt(i.points)} pts  ${i.title}`);
  }
  for (const s of r.skipped ?? []) L.push(`skipped board ${s.number} ${s.title}: ${s.why}`);
  for (const n of r.notes ?? []) L.push(`note: ${n}`);
  if (r.goalBlocks) {
    for (const g of r.goalBlocks) {
      const a = g.appetite;
      const when = a.recorded ? `appetite: ${a.weeks} weeks from ${a.since}, ${a.daysLeft >= 0 ? `${a.daysLeft} days left` : `${-a.daysLeft} days past`}` : "no appetite recorded";
      L.push(`${g.id} · ${g.title}   ${when}`);
      L.push("  " + Object.keys(GROUP_LABEL).map((k) => `${GROUP_LABEL[k]} ${g.counts[k].atLeast ? "≥" : ""}${g.counts[k].n}`).join(" · "));
      L.push("  Ready by Order:");
      for (const i of g.readyByOrder) L.push(`    ${i.order ?? "–"}  ${i.priority ?? "–"}  ${i.model ?? "–"}  ${i.size ?? "–"}  ${i.ref}  ${i.title}`);
      if (!g.readyByOrder.length) L.push("    none");
    }
    if (!r.goalBlocks.length) L.push("goals: no active goal to show");
    const n = r.readyNotUnderActiveGoal ?? [];
    L.push(`not under an active goal: ${n.length} Ready item(s)${n.length ? `: ${n.map((i) => i.ref).join(", ")}` : ""}`);
  }
  if (r.goals) L.push(goalsSummaryLine(r.goals));
  L.push(`GraphQL calls made by this command: ${r.graphqlCalls}`);
  L.push(r.exit === 2 ? `could not judge: ${r.reason}` : r.reason);
  return L;
}

// ── day close ───────────────────────────────────────────────────────────────

const localYmd = (iso) => ymd(new Date(iso));
const field = (board, fieldId, valueLiteral, item, what) => ({
  projectId: board.projectId,
  fieldId,
  value: valueLiteral,
  itemId: item.id,
  ref: key(item),
  what,
});

/**
 * @param {object} a
 * @param {boolean} [a.apply]
 * @param {((r: object, mutations: string[]) => void)|null} [a.beforeWrite] called with exactly what will be written, before the first write
 */
export async function buildDayClose({ sampleRows, now, widget, fetcher, apply = false, beforeWrite = null, goalFiles = null }) {
  const res = { command: "day close", exit: 2, graphqlCalls: 0, notes: [], applied: false, writes: [] };
  const stop = (reason) => ({ ...res, exit: 2, reason });

  // FAIL CLOSED for promotions (propagate#240): an unread goal source never permits one. Rupali, 2026-11-13: "skip
  // with warning", so ONLY promotions are skipped (promotionGap refuses every item when `active` is empty), loudly;
  // closed -> Done and the cost gaps do not depend on goals and still run.
  const active = activeGoalIds(goalFiles);
  if (active.size === 0) {
    res.promotionsSkipped = "no active goal was read (GOALS.md missing, unreadable or with no active goal): no item is promoted";
    res.notes.push(`WARNING: promotions skipped: ${res.promotionsSkipped}`);
  }

  const read = await readBoards({ fetcher, now, count: () => res.graphqlCalls++ });
  if (read.stop) return stop(read.stop);
  res.skipped = read.listing.skipped;
  res.notes.push(...read.truncated.map((t) => `truncated at first:100, not paged: ${t}`));
  const today = ymd(new Date(now));

  const promote = [];
  const refused = [];
  const closeFix = [];
  const ops = [];
  const expect = new Map();
  const everything = [];

  for (const board of read.listing.boards) {
    const g = read.byBoard.get(board.number);
    const items = uniqueBy([...g.ready, ...g.prog, ...g.backlog, ...g.done, ...g.recent, ...g.stale], (i) => i.id);
    everything.push(...items);

    const readyOpen = g.ready.filter((i) => !isClosed(i)).length;
    const slots = Math.max(0, READY_TARGET - readyOpen);
    const eligible = promotionOrder(g.backlog.filter((i) => promotionGap(i, active) === null));
    for (const it of eligible.slice(0, slots)) {
      promote.push({ board: board.number, ref: key(it), size: it.size, title: it.title });
      ops.push(field(board, board.statusFieldId, `{singleSelectOptionId:${gqlString(board.statusOptions.Ready)}}`, it, "Status -> Ready"));
      expect.set(it.id, { ...(expect.get(it.id) ?? {}), ref: key(it), status: "Ready" });
    }
    for (const it of g.backlog) {
      if (isClosed(it) || statusIs(it, "Backlog") === false || isEpic(it) || blockedLabel(it)) continue;
      const hasSize = Boolean(it.size);
      const hasDw = hasDoneWhen(it.body);
      // When promotions are skipped, every item would carry the same "no active goal was read" gap: one warning says
      // it, so refusals list only Size and Done when, as they did before goals existed.
      const gg = res.promotionsSkipped ? null : goalGap(it, active);
      // Size and Done when both stated and the Goal is fine = promotable (or slot-limited); neither stated and no goal
      // gap = not a candidate. A goal gap on an otherwise startable item is refused, naming the goal reason.
      if (hasSize === hasDw && !(hasSize && gg)) continue;
      const missing = hasSize === hasDw ? [] : [hasSize ? "Done when" : "Size"];
      if (gg) missing.push(gg);
      refused.push({ board: board.number, ref: key(it), title: it.title, missing: missing.join("; ") });
    }

    for (const it of items.filter((i) => isClosed(i) && !statusIs(i, "Done"))) {
      const fin = it.finished ? null : it.closedAt ? localYmd(it.closedAt) : null;
      closeFix.push({ board: board.number, ref: key(it), title: it.title, from: it.status ?? "no status", finished: fin });
      ops.push(field(board, board.statusFieldId, `{singleSelectOptionId:${gqlString(board.statusOptions.Done)}}`, it, "Status -> Done"));
      const e = { ref: key(it), status: "Done" };
      if (fin && board.finishedFieldId) {
        ops.push(field(board, board.finishedFieldId, `{date:${gqlString(fin)}}`, it, `Finished = ${fin}`));
        e.finished = fin;
      } else if (fin) res.notes.push(`board ${board.number} has no Finished date field; ${key(it)} gets Status only`);
      expect.set(it.id, e);
    }
  }

  const closedToday = uniqueBy(everything.filter((i) => isClosed(i) && i.closedAt && localYmd(i.closedAt) === today), key);
  const fixing = new Set(closeFix.map((c) => c.ref));
  const gaps = [];
  for (const it of closedToday) {
    const missing = [];
    if (!it.finished && !fixing.has(key(it))) missing.push("Finished");
    if (it.tokens === null) missing.push("Tokens");
    if (it.minutes === null) missing.push("Minutes");
    if (missing.length) gaps.push({ board: it.board, ref: key(it), title: it.title, missing });
  }
  const inProgress = uniqueBy(
    everything.filter((i) => statusIs(i, "In progress") && !isClosed(i)),
    (i) => i.id,
  ).map((i) => ({ board: i.board, ref: key(i), title: i.title }));

  res.promote = promote;
  res.refused = refused;
  res.closeFix = closeFix;
  res.costGaps = gaps;
  res.inProgress = inProgress;
  res.operations = ops.map((o) => `${o.ref}: ${o.what}`);
  res.doneToday = closedToday.length;

  if (widget) {
    const pre = sampleChecks({ rows: sampleRows, now, widget });
    res.usage = pre.ok ? { used: pre.usedPct, cap: pre.cap.cap } : { missing: pre.reason };
  } else res.usage = { missing: "daily-cap source not configured (PROPAGATE_USAGE_WIDGET_DIR)" };

  res.exit = 0;
  res.reason = apply ? "applied" : "dry-run: nothing written (pass --apply to write the promotions and closure fixes)";

  // The ONLY write path. Reached behind apply === true and a non-empty list.
  if (apply && ops.length) {
    const chunks = [];
    for (let i = 0; i < ops.length; i += CHUNK) chunks.push(ops.slice(i, i + CHUNK));
    const ids = [...expect.keys()];
    const readCalls = Math.ceil(ids.length / CHUNK);
    const needW = 5 * chunks.length + readCalls;
    if (read.rl.graphql.remaining - res.graphqlCalls < needW) {
      return { ...res, exit: 2, reason: `--apply refused: GraphQL remaining ${read.rl.graphql.remaining} cannot cover about ${needW} request(s); nothing written` };
    }
    if (beforeWrite) beforeWrite(res, chunks.map(writeMutation));
    for (const chunk of chunks) {
      res.graphqlCalls++;
      try {
        await fetcher.write(writeMutation(chunk));
      } catch (e) {
        return { ...res, exit: 2, applied: false, reason: `--apply failed after ${res.writes.length} of ${ops.length} write(s): ${e.message}` };
      }
      res.writes.push(...chunk.map((o) => `${o.ref}: ${o.what}`));
    }
    res.applied = true;

    // Read every written item back by node id.
    const mismatches = [];
    let matched = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      res.graphqlCalls++;
      let data;
      try {
        data = await fetcher.graphql(readBackQuery(part));
      } catch (e) {
        return { ...res, exit: 2, reason: `read-back failed: ${e.message}` };
      }
      part.forEach((id, j) => {
        const want = expect.get(id);
        const node = data?.[`r${j}`];
        const vals = node?.fieldValues?.nodes ?? [];
        const get = (n, prop) => vals.find((v) => String(v?.field?.name ?? "").toLowerCase() === n)?.[prop] ?? null;
        const problems = [];
        if (!node) problems.push("node not found");
        else {
          if (get("status", "name") !== want.status) problems.push(`Status is ${get("status", "name") ?? "unset"}, wanted ${want.status}`);
          if (want.finished && get("finished", "date") !== want.finished) problems.push(`Finished is ${get("finished", "date") ?? "unset"}, wanted ${want.finished}`);
        }
        if (problems.length) mismatches.push({ ref: want.ref, problems });
        else matched++;
      });
    }
    res.readBack = { matched, total: ids.length, mismatches };
    if (mismatches.length) return { ...res, exit: 1, reason: `read-back mismatch on ${mismatches.length} of ${ids.length} item(s): ${mismatches.map((m) => m.ref).join(", ")}` };
    res.reason = `applied ${ops.length} write(s) in ${chunks.length} request(s); read-back MATCH ${matched}/${ids.length}`;
  }
  return res;
}

export function renderDayClose(r, { apply = false } = {}) {
  const L = [`propagate day close (${apply ? "--apply" : "dry-run"})`];
  if (r.promotionsSkipped) L.push(`WARNING: promotions skipped: ${r.promotionsSkipped}`);
  const NAMED = 10;
  const list = (title, rows, line) => {
    L.push(`${title} (${rows.length}):`);
    for (const x of rows.slice(0, NAMED)) L.push(`  ${line(x)}`);
    if (rows.length > NAMED) L.push(`  (+${rows.length - NAMED} more; --json lists all)`);
  };
  if (r.promote) {
    list("(a) promote Backlog -> Ready", r.promote, (x) => `${x.ref} [${x.size}] (board ${x.board}) ${x.title}`);
    list("(b) refused: Ready means startable", r.refused, (x) => `${x.ref} (board ${x.board}) missing ${x.missing}  ${x.title}`);
    list("(c) closed but Status not Done -> Done", r.closeFix, (x) => `${x.ref} (board ${x.board}) was ${x.from}${x.finished ? `, Finished = ${x.finished}` : ""}  ${x.title}`);
    list("(d) cost gaps, named and never filled", r.costGaps, (x) => `${x.ref} (board ${x.board}) missing ${x.missing.join(", ")}  ${x.title}`);
    list("(e) In progress: add a where-it-stopped comment or move back to Ready (no write)", r.inProgress, (x) => `${x.ref} (board ${x.board}) ${x.title}`);
    const u = r.usage;
    L.push(`summary: ${r.doneToday} item(s) done today; usage ${u?.missing ? `not derivable (${u.missing})` : `${fmt(u.used)} used of cap ${fmt(u.cap)} week-% points`}`);
  }
  if (r.readBack) {
    L.push(`read-back by node id: ${r.readBack.mismatches.length ? `${r.readBack.mismatches.length} MISMATCH` : `MATCH ${r.readBack.matched}/${r.readBack.total}`}`);
    for (const m of r.readBack.mismatches) L.push(`  ${m.ref}: ${m.problems.join("; ")}`);
  }
  for (const s of r.skipped ?? []) L.push(`skipped board ${s.number} ${s.title}: ${s.why}`);
  for (const n of r.notes ?? []) L.push(`note: ${n}`);
  L.push(`GraphQL calls made by this command: ${r.graphqlCalls}`);
  L.push(r.exit === 2 ? `could not compute: ${r.reason}` : r.reason);
  return L;
}
