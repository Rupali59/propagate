/**
 * lib/report/sprint-plan.mjs — `propagate sprint plan` (propagate#190): does the Ready work fit the usage left?
 *
 * Read-only: no GitHub write, no ledger write. Pure except for the injected `fetcher` (GitHub) and the
 * injected `widget` ({dailyCap, dayUsed}, imported by cli/sprint.mjs from PROPAGATE_USAGE_WIDGET_DIR). Nothing
 * is cached: every call re-derives from the rows it is given.
 *
 * Budget is in WEEK-% POINTS, never dollars (`cc_cost_week` dropped 7 times inside one week; DECISIONS "no
 * dollars in v1"). Demand is per-Size median tokens converted with the ledger's measured tokens-per-week-%.
 * A Size below ROW_FLOOR items of ONE cost basis is "uncalibrated": counted, listed, never summed.
 *
 * Exit: 0 fits and nothing uncalibrated; 1 over (cut list); 2 could not compute / cannot judge fit.
 * A reason for 2 is always printed (rule:discernment-checks §2).
 */

import { READING_MAX_AGE_MS } from "../core/costs.mjs";

export const ROW_FLOOR = 5;
export const OK_FALSE_MAX = 0.5;
export const MIN_RATE_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAME_WEEK_MS = 60 * 60 * 1000;

export const estimateNeed = (readyBoards) => 10 + 40 * readyBoards;

// ── samples ─────────────────────────────────────────────────────────────────

/** @returns {{rows: object[], malformed: number}} rows oldest first */
export function parseSamples(raw) {
  const rows = [];
  let malformed = 0;
  for (const line of String(raw ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object" && Number.isFinite(Date.parse(r.t))) rows.push(r);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { rows, malformed };
}

/** The 7-day share of sampler runs that wrote ok:false. `rate` is null when there were no runs. */
export function okFalseRate(rows, now, days = 7) {
  const from = now - days * DAY_MS;
  let total = 0;
  let failed = 0;
  for (const r of rows) {
    const t = Date.parse(r.t);
    if (!(t >= from && t <= now)) continue;
    total++;
    if (r.ok !== true) failed++;
  }
  return { total, failed, rate: total ? failed / total : null };
}

/** Latest ok:true row with a numeric week_pct and a week_resets_at, at most READING_MAX_AGE_MS old. */
export function latestSample(rows, now) {
  let best = null;
  for (const r of rows ?? []) {
    if (r?.ok !== true || typeof r.week_pct !== "number" || typeof r.week_resets_at !== "string") continue;
    const t = Date.parse(r.t);
    if (!Number.isFinite(t) || t > now) continue;
    if (!best || t > Date.parse(best.t)) best = r;
  }
  if (!best) return { missing: "no ok:true sample with week_pct and week_resets_at" };
  const age = now - Date.parse(best.t);
  if (age > READING_MAX_AGE_MS) return { missing: `latest ok:true sample (${best.t}) is older than 6h` };
  return { row: best };
}

const sameWeek = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_WEEK_MS;

/**
 * Everything about the budget that needs only the samples. Failure is `{ok:false, reason, okRate}`.
 * @param {{rows: object[], now: number, widget: {dailyCap: Function, dayUsed: Function}}} a
 */
export function sampleChecks({ rows, now, widget }) {
  const okRate = okFalseRate(rows, now);
  const fail = (reason) => ({ ok: false, reason, okRate });
  const lat = latestSample(rows, now);
  if (lat.missing) return fail(lat.missing);
  if (okRate.rate !== null && okRate.rate > OK_FALSE_MAX) {
    return fail(`the sampler wrote ok:false on ${okRate.failed} of ${okRate.total} runs in 7 days (above ${OK_FALSE_MAX * 100}%)`);
  }
  const latest = lat.row;
  if (Date.parse(latest.week_resets_at) <= now) return fail("the latest sample's week_resets_at has passed; no sample of the new week yet");
  const used = widget.dayUsed(rows, now);
  if (!used || used.status !== "ok") return fail(`today's use is not derivable (dayUsed: ${used?.status ?? "no result"})`);
  if (used.unattributed && used.unattributed.pct > 0) {
    return fail(`today's use spans a coverage gap (${used.unattributed.pct} week points unattributed); not bridged`);
  }
  const base = used.baseline;
  if (base && typeof base.week_resets_at === "string" && !sameWeek(base.week_resets_at, latest.week_resets_at)) {
    return fail(`a week_resets_at boundary falls inside the measured span (${base.week_resets_at} -> ${latest.week_resets_at}); the delta is refused`);
  }
  const cap = widget.dailyCap({ latest, usedPct: used.usedPct, now, samples: rows });
  return { ok: true, latest, usedPct: used.usedPct, cap, okRate };
}

const endOfLocalDay = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
};
const localMidnight = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Budget points = min(100 - week_pct, max(0, cap - usedToday) + flooredCap * futureDays), where futureDays are the
 * local days after today up to min(sprint end, weekly reset). Future days use the floored cap, not the raised one:
 * the raise is today's aim and cannot be known for a day that has not started.
 */
export function budgetPoints(pre, sprintEnd, now) {
  const reset = Date.parse(pre.latest.week_resets_at);
  const end = endOfLocalDay(sprintEnd);
  const spanEnd = Math.min(end, reset);
  const tomorrow = localMidnight(localMidnight(now) + DAY_MS + 3 * 3600000);
  const futureDays = spanEnd > tomorrow ? Math.ceil((spanEnd - tomorrow) / DAY_MS) : 0;
  const left = Math.max(0, 100 - pre.latest.week_pct);
  const todayLeft = Math.max(0, pre.cap.cap - pre.usedPct);
  const shaped = todayLeft + pre.cap.flooredCap * futureDays;
  return {
    points: Math.min(left, shaped),
    weekLeft: left,
    shaped,
    todayLeft,
    futureDays,
    sprintEnd,
    reset: pre.latest.week_resets_at,
    spanEnds: spanEnd === reset ? "the weekly reset" : "the sprint end",
    capBasis: pre.cap.basis,
  };
}

// ── boards ──────────────────────────────────────────────────────────────────

export const LISTING_QUERY =
  'query{viewer{projectsV2(first:100){totalCount nodes{number title closed ready:items(first:1,query:"status:Ready"){totalCount} fields(first:30){nodes{... on ProjectV2IterationField{name configuration{iterations{title startDate duration}}}}}}}}}';

const ITEM_FRAGMENT =
  "fragment I on ProjectV2Item{content{... on Issue{number title repository{nameWithOwner} milestone{title} labels(first:20){nodes{name}}}" +
  "... on PullRequest{number title repository{nameWithOwner} milestone{title} labels(first:20){nodes{name}}}}" +
  "fieldValues(first:15){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}" +
  "... on ProjectV2ItemFieldIterationValue{title startDate duration field{... on ProjectV2FieldCommon{name}}}" +
  "... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}}}}";

export function detailQuery(numbers) {
  const blocks = numbers
    .map(
      (n) =>
        `b${n}:projectV2(number:${n}){number title ` +
        `ready:items(first:100,query:"status:Ready"){totalCount nodes{...I}} ` +
        `done:items(first:100,query:"status:Done"){totalCount nodes{...I}}}`,
    )
    .join(" ");
  return `query{viewer{${blocks}}} ${ITEM_FRAGMENT}`;
}

/** @returns {{boards: {number:number,title:string,ready:number,iterations:object[]}[]}} open boards only */
export function normalizeListing(data) {
  const nodes = data?.viewer?.projectsV2?.nodes;
  if (!Array.isArray(nodes)) throw new Error("listing response had no viewer.projectsV2.nodes");
  const boards = [];
  for (const b of nodes) {
    if (!b || b.closed) continue;
    const sprint = (b.fields?.nodes ?? []).find((f) => f?.name === "Sprint" && f.configuration);
    boards.push({
      number: b.number,
      title: b.title,
      ready: b.ready?.totalCount ?? 0,
      iterations: sprint?.configuration?.iterations ?? [],
    });
  }
  return { boards, total: data.viewer.projectsV2.totalCount ?? nodes.length };
}

function normalizeItem(node, board) {
  const c = node?.content;
  if (!c || typeof c.number !== "number") return null;
  const fv = { size: null, sprint: null, tokens: null };
  for (const v of node.fieldValues?.nodes ?? []) {
    const name = String(v?.field?.name ?? "").toLowerCase();
    if (name === "size" && typeof v.name === "string") fv.size = v.name;
    else if (name === "sprint" && typeof v.title === "string") fv.sprint = { title: v.title, startDate: v.startDate, duration: v.duration };
    else if (name === "tokens" && typeof v.number === "number") fv.tokens = v.number;
  }
  return {
    board: board.number,
    boardTitle: board.title,
    number: c.number,
    title: c.title ?? "",
    repo: c.repository?.nameWithOwner ?? null,
    labels: (c.labels?.nodes ?? []).map((l) => l.name),
    milestone: c.milestone?.title ?? null,
    ...fv,
  };
}

/** @returns {{ready: object[], done: object[], truncated: string[]}} */
export function normalizeDetail(data, numbers) {
  const ready = [];
  const done = [];
  const truncated = [];
  for (const n of numbers) {
    const b = data?.viewer?.[`b${n}`];
    if (!b) throw new Error(`detail response had no board ${n}`);
    for (const [key, out] of [["ready", ready], ["done", done]]) {
      const conn = b[key];
      for (const node of conn?.nodes ?? []) {
        const it = normalizeItem(node, b);
        if (it) out.push(it);
      }
      if ((conn?.totalCount ?? 0) > (conn?.nodes?.length ?? 0)) truncated.push(`board ${n} ${key}: ${conn.nodes.length} of ${conn.totalCount}`);
    }
  }
  return { ready, done, truncated };
}

/** The iteration containing today on any board; with several, the earliest end. Dates are YYYY-MM-DD. */
export function currentSprint(boards, now) {
  const today = new Date(now);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const t = ymd(today);
  const found = [];
  for (const b of boards) {
    for (const it of b.iterations) {
      if (!it?.startDate || !Number.isFinite(it.duration)) continue;
      const [y, m, d] = it.startDate.split("-").map(Number);
      const endDate = ymd(new Date(y, m - 1, d + it.duration - 1));
      if (it.startDate <= t && t <= endDate) found.push({ title: it.title, start: it.startDate, end: endDate, board: b.number });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  return { ...found[0], ends: [...new Set(found.map((f) => f.end))] };
}

// ── calibration and demand ──────────────────────────────────────────────────

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length;
  return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2;
};

const laneTokens = (row) => (row?.usage ? Object.values(row.usage).reduce((a, b) => a + (Number(b) || 0), 0) : null);

/**
 * Tokens per week-% from ledger lane rows with a positive, complete week_pct delta. Rows with a negative or
 * missing delta (a reset, a missing reading) are excluded and counted. Under ROW_FLOOR rows: not derivable.
 */
export function deriveRatio(laneRows) {
  let tokens = 0;
  let pts = 0;
  let n = 0;
  let excluded = 0;
  for (const r of laneRows ?? []) {
    const d = r?.week_pct?.delta;
    const tk = laneTokens(r);
    if (typeof d !== "number" || d <= 0 || r.week_pct.missing || tk === null || tk <= 0) {
      excluded++;
      continue;
    }
    tokens += tk;
    pts += d;
    n++;
  }
  if (n < ROW_FLOOR) return { missing: `only ${n} usable ledger lane rows (floor ${ROW_FLOOR}); ${excluded} excluded`, n, excluded };
  return { tokensPerPct: tokens / pts, n, excluded };
}

/**
 * Per Size: items with Tokens, split by cost basis. "lane" = a ledger lane row for `#N` whose total tokens equal the
 * board's Tokens; anything else is "main-or-unknown". Bases are never pooled. Only the lane basis converts to points
 * (the ratio is measured from lanes); a Size with 5 items of the other basis only is still uncalibrated, and says so.
 */
export function calibrate(done, laneRows, ratio) {
  const byIssue = new Map();
  for (const r of laneRows ?? []) {
    if (typeof r?.issue !== "string") continue;
    const t = laneTokens(r);
    if (t === null) continue;
    (byIssue.get(r.issue) ?? byIssue.set(r.issue, new Set()).get(r.issue)).add(t);
  }
  const sizes = new Map();
  for (const it of done) {
    if (!it.size || typeof it.tokens !== "number" || it.tokens <= 0) continue;
    const basis = byIssue.get(`#${it.number}`)?.has(it.tokens) ? "lane" : "main";
    const s = sizes.get(it.size) ?? { lane: [], main: [] };
    s[basis].push(it.tokens);
    sizes.set(it.size, s);
  }
  const out = {};
  for (const [size, s] of sizes) {
    const base = { n_lane: s.lane.length, n_main_or_unknown: s.main.length };
    if (s.lane.length >= ROW_FLOOR && ratio.tokensPerPct) {
      const med = median(s.lane);
      out[size] = { ...base, status: "calibrated", basis: "lane", medianTokens: med, pointsPerItem: med / ratio.tokensPerPct };
    } else if (s.lane.length >= ROW_FLOOR) {
      out[size] = { ...base, status: "uncalibrated", reason: `lane basis has n=${s.lane.length} but tokens-per-week-% is not derivable (${ratio.missing})` };
    } else if (s.main.length >= ROW_FLOOR) {
      out[size] = { ...base, status: "uncalibrated", reason: `n=${s.main.length} on main-or-unknown basis only; no tokens-per-week-% ratio exists for that basis` };
    } else {
      out[size] = { ...base, status: "uncalibrated", reason: `n=${s.lane.length} lane, n=${s.main.length} main-or-unknown; floor is ${ROW_FLOOR} of one basis` };
    }
  }
  return out;
}

export function demand(ready, calibration) {
  const calibrated = [];
  const uncalibrated = [];
  const unsized = [];
  let points = 0;
  for (const it of ready) {
    if (!it.size) unsized.push(it);
    else if (calibration[it.size]?.status === "calibrated") {
      const p = calibration[it.size].pointsPerItem;
      calibrated.push({ ...it, points: p });
      points += p;
    } else uncalibrated.push(it);
  }
  return { calibrated, uncalibrated, unsized, points, total: ready.length };
}

const priorityRank = (it) => {
  for (const l of it.labels ?? []) {
    const m = /^priority:P([0-3])$/i.exec(l);
    if (m) return Number(m[1]);
  }
  return 9;
};

/** Keep order: priority label (P0 first), then milestone (none last), then board. Stable. */
export function keepOrder(items) {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const pa = priorityRank(a.it);
      const pb = priorityRank(b.it);
      if (pa !== pb) return pa - pb;
      const ma = a.it.milestone;
      const mb = b.it.milestone;
      if (ma !== mb) {
        if (ma === null) return 1;
        if (mb === null) return -1;
        return ma < mb ? -1 : 1;
      }
      if (a.it.board !== b.it.board) return a.it.board - b.it.board;
      return a.i - b.i;
    })
    .map((x) => x.it);
}

/** Walk the keep order; from the first item that does not fit, it and everything after it is cut. */
export function cutList(calibrated, budget) {
  let used = 0;
  const keep = [];
  const cut = [];
  let over = false;
  for (const it of keepOrder(calibrated)) {
    if (!over && used + it.points <= budget) {
      used += it.points;
      keep.push(it);
    } else {
      over = true;
      cut.push(it);
    }
  }
  return { keep, cut, keptPoints: used };
}

// ── the plan ────────────────────────────────────────────────────────────────

/**
 * @param {object} a
 * @param {object[]} a.sampleRows  parsed samples, oldest first
 * @param {number} a.now  epoch ms
 * @param {{dailyCap: Function, dayUsed: Function}|null} a.widget  null: not configured
 * @param {string|null} [a.widgetMissing] why it is null
 * @param {{rateLimit: () => object, graphql: (q: string) => Promise<object>}} a.fetcher
 * @param {object[]} a.laneRows  readCosts({lanesOnly:true}).rows
 * @param {number|null} [a.approvals]
 */
export async function buildSprintPlan({ sampleRows, now, widget, widgetMissing, fetcher, laneRows, approvals = null }) {
  const plan = { exit: 2, graphqlCalls: 0, notes: [] };
  const stop = (reason) => ({ ...plan, exit: 2, reason });
  const gql = async (q) => {
    plan.graphqlCalls++;
    return fetcher.graphql(q);
  };

  if (!widget) return stop(`could not compute (daily-cap source not configured: set PROPAGATE_USAGE_WIDGET_DIR)${widgetMissing ? `: ${widgetMissing}` : ""}`);

  const pre = sampleChecks({ rows: sampleRows, now, widget });
  plan.okRate = pre.okRate;
  if (!pre.ok) return stop(pre.reason);

  let rl;
  try {
    rl = fetcher.rateLimit();
  } catch (e) {
    return stop(`could not read the GitHub rate limit: ${e.message}`);
  }
  if (!rl?.graphql || typeof rl.graphql.remaining !== "number") return stop("could not read the GitHub rate limit (no graphql.remaining)");
  plan.rate = rl;
  if (rl.graphql.remaining < MIN_RATE_LIMIT) {
    return stop(`GraphQL remaining ${rl.graphql.remaining} is below ${MIN_RATE_LIMIT}; refusing to start (nothing fetched)`);
  }

  let listing;
  try {
    listing = normalizeListing(await gql(LISTING_QUERY));
  } catch (e) {
    return stop(`board listing failed: ${e.message}`);
  }
  plan.boardsListed = listing.boards.length;
  const withReady = listing.boards.filter((b) => b.ready > 0);
  plan.boardsWithReady = withReady.map((b) => ({ number: b.number, title: b.title, ready: b.ready }));
  if (listing.boards.length < listing.total) {
    plan.notes.push(`${listing.total} boards exist; ${listing.boards.length} open ones read (closed boards skipped)`);
  }

  const sprint = currentSprint(withReady.length ? withReady : listing.boards, now);
  plan.sprint = sprint;
  if (!sprint) return stop("no current Sprint iteration on any board with Ready items");
  plan.budget = budgetPoints(pre, sprint.end, now);
  if (sprint.ends.length > 1) plan.notes.push(`boards disagree on the current Sprint end (${sprint.ends.join(", ")}); the earliest is used`);

  const need = estimateNeed(withReady.length);
  if (rl.graphql.remaining < need) {
    return stop(`GraphQL remaining ${rl.graphql.remaining} is below the ${need} estimated for ${withReady.length} boards; refusing to fetch items`);
  }

  let detail;
  const numbers = withReady.map((b) => b.number);
  try {
    detail = numbers.length ? normalizeDetail(await gql(detailQuery(numbers)), numbers) : { ready: [], done: [], truncated: [] };
  } catch (e) {
    return stop(`board item fetch failed: ${e.message}`);
  }
  if (detail.truncated.length) plan.notes.push(`truncated at first:100, not paged: ${detail.truncated.join("; ")}`);

  plan.ratio = deriveRatio(laneRows);
  plan.calibration = calibrate(detail.done, laneRows, plan.ratio);
  plan.demand = demand(detail.ready, plan.calibration);
  plan.inSprint = detail.ready.filter((i) => i.sprint && i.sprint.title === sprint.title).length;

  const labelCount = (k) => detail.ready.filter((i) => i.labels.includes(`needs:${k}`)).length;
  plan.resources = {
    graphql: { remaining: rl.graphql.remaining, limit: rl.graphql.limit },
    rest: rl.core ? { remaining: rl.core.remaining, limit: rl.core.limit } : null,
    needs: { mac: labelCount("mac"), vm: labelCount("vm"), rupali: labelCount("rupali"), github: labelCount("github") },
    approvals,
  };

  const d = plan.demand;
  const budget = plan.budget.points;
  if (d.points > budget) {
    plan.cut = cutList(d.calibrated, budget);
    return { ...plan, exit: 1, reason: `over: calibrated demand ${fmt(d.points)} points against a budget of ${fmt(budget)}` };
  }
  if (d.total === 0) return { ...plan, exit: 0, reason: "0 Ready items" };
  const calibratedN = d.calibrated.length;
  if (calibratedN < d.total) {
    return { ...plan, exit: 2, reason: `cannot judge fit: ${calibratedN} of ${d.total} Ready items calibrated` };
  }
  return { ...plan, exit: 0, reason: `fits: ${fmt(d.points)} points against a budget of ${fmt(budget)}` };
}

const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const pct = (r) => (r === null ? "no runs" : `${Math.round(r * 100)}%`);

export function renderPlan(plan) {
  const L = ["propagate sprint plan (read-only)"];
  if (plan.okRate) L.push(`sampler ok:false rate, 7 days: ${plan.okRate.failed} of ${plan.okRate.total} (${pct(plan.okRate.rate)})`);
  if (plan.budget) {
    const b = plan.budget;
    L.push(
      `budget: ${fmt(b.points)} week-% points to ${b.sprintEnd} (sprint end ${plan.sprint.title}); week resets ${b.reset}; span ends at ${b.spanEnds}`,
      `  = min(${fmt(b.weekLeft)} left in the week, ${fmt(b.todayLeft)} left today + ${b.futureDays} later day(s) at the floored cap)`,
      `  daily cap: ${b.capBasis}`,
    );
  }
  if (plan.demand) {
    const d = plan.demand;
    L.push(
      `demand: ${d.total} Ready items on ${plan.boardsWithReady.length} board(s) (in the current Sprint: ${plan.inSprint}; outside it: ${d.total - plan.inSprint})`,
      `  calibrated ${d.calibrated.length} = ${fmt(d.points)} points; uncalibrated ${d.uncalibrated.length}; unsized ${d.unsized.length} (counted, never summed)`,
    );
    L.push(`  tokens per week-%: ${plan.ratio.tokensPerPct ? Math.round(plan.ratio.tokensPerPct).toLocaleString("en-US") + ` (${plan.ratio.n} lane rows)` : `not derivable: ${plan.ratio.missing}`}`);
    const sizes = Object.entries(plan.calibration);
    if (!sizes.length) L.push("  Sizes: no Done item with a Size and Tokens on these boards");
    for (const [s, c] of sizes) {
      L.push(`  ${s}: ${c.status === "calibrated" ? `calibrated, median ${Math.round(c.medianTokens).toLocaleString("en-US")} tokens = ${fmt(c.pointsPerItem)} points/item (n=${c.n_lane} lane)` : `uncalibrated (${c.reason})`}`);
    }
    const list = (label, items) => items.length && L.push(`  ${label}: ${items.map((i) => `${i.repo ?? "?"}#${i.number}`).join(", ")}`);
    list("uncalibrated items", d.uncalibrated);
    list("unsized items", d.unsized);
  }
  if (plan.cut) {
    L.push(`cut list (${plan.cut.cut.length}), kept ${fmt(plan.cut.keptPoints)} points; order: priority label, milestone, board:`);
    for (const i of plan.cut.cut) L.push(`  cut ${i.repo ?? "?"}#${i.number} [${i.size}] ${fmt(i.points)} pts  ${i.title}`);
  }
  if (plan.resources) {
    const r = plan.resources;
    L.push(
      "resources:",
      `  GitHub GraphQL remaining: ${r.graphql.remaining}/${r.graphql.limit}`,
      `  GitHub REST remaining: ${r.rest ? `${r.rest.remaining}/${r.rest.limit}` : "not derivable (rate_limit had no core)"}`,
      `  Ready items needing: mac ${r.needs.mac}, vm ${r.needs.vm}, rupali ${r.needs.rupali}, github ${r.needs.github}`,
      "  concurrent Mac lanes: not derivable yet (#150)",
      "  VM jobs: not derivable yet (#150)",
      `  rupali approvals: ${r.approvals === null ? "not given (her number, --approvals)" : r.approvals}`,
    );
  }
  for (const n of plan.notes) L.push(`note: ${n}`);
  L.push(`GraphQL calls made by this command: ${plan.graphqlCalls}`);
  const own = /^(fits|over|cannot judge|0 Ready)/.test(plan.reason);
  L.push(own ? plan.reason : `could not compute: ${plan.reason}`);
  return L;
}
