/**
 * lib/report/sprint-review.mjs — `propagate sprint review` (propagate#191): done against planned, per board.
 *
 * Read-only unless `apply` is true. The ONLY write path is `fetcher.write`, and it is reached from exactly one
 * place, behind `apply === true` and a non-empty move list (rule:safety-flag-needs-a-test). Every other call goes
 * through `fetcher.graphql`, which only ever receives queries.
 *
 * Definitions, per board, for the reviewed iteration [start, end]:
 *   planned    = items whose Sprint field is that iteration
 *   done       = planned, Status Done, Finished date inside [start, end]
 *   carry-over = planned, Status not Done  (these are the only items `--apply` moves)
 *   unverified = planned, Status Done, Finished missing or outside the window (counted, never moved, never "done")
 * "Added mid-sprint" is NOT derivable: GitHub records no timestamp for when an item entered an iteration.
 *
 * Exit: 0 reviewed; 2 could not compute (with the reason). Never re-prioritises (#141 rule 6): a move changes only
 * the Sprint field of an item that was already planned.
 */

import { ROW_FLOOR, MIN_RATE_LIMIT, estimateNeed, deriveRatio, calibrate } from "./sprint-plan.mjs";

const CHUNK = 20; // aliased mutations per GraphQL request
export const estimateWriteNeed = (moves) => 5 * Math.ceil(moves / CHUNK);

// ── queries ─────────────────────────────────────────────────────────────────

const ITER = "id title startDate duration";
export const REVIEW_LISTING_QUERY =
  `query{viewer{projectsV2(first:100){totalCount nodes{id number title closed fields(first:30){nodes{... on ProjectV2IterationField{id name configuration{iterations{${ITER}} completedIterations{${ITER}}}}}}}}}}`;

const gqlString = (s) => JSON.stringify(String(s));

const ITEM_FRAGMENT =
  "fragment R on ProjectV2Item{id content{... on Issue{number title repository{nameWithOwner}}... on PullRequest{number title repository{nameWithOwner}}}" +
  "fieldValues(first:20){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}" +
  "... on ProjectV2ItemFieldIterationValue{title startDate duration field{... on ProjectV2FieldCommon{name}}}" +
  "... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}}" +
  "... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}}}}";

/** @param {{number:number, title:string}[]} targets one entry per board: the iteration title to read */
export function reviewDetailQuery(targets) {
  const blocks = targets
    .map(
      (t) =>
        `b${t.number}:projectV2(number:${t.number}){number title ` +
        `items(first:100,query:${gqlString(`sprint:${JSON.stringify(t.sprintTitle)}`)}){totalCount nodes{...R}}}`,
    )
    .join(" ");
  return `query{viewer{${blocks}}} ${ITEM_FRAGMENT}`;
}

/** One request: aliased updateProjectV2ItemFieldValue calls. Pure text, so a test can read exactly what is written. */
export function moveMutation(moves) {
  const body = moves
    .map(
      (m, i) =>
        `m${i}:updateProjectV2ItemFieldValue(input:{projectId:${gqlString(m.projectId)},itemId:${gqlString(m.itemId)},` +
        `fieldId:${gqlString(m.fieldId)},value:{iterationId:${gqlString(m.toIterationId)}}}){projectV2Item{id}}`,
    )
    .join(" ");
  return `mutation{${body}}`;
}

// ── boards and iterations ───────────────────────────────────────────────────

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function endOf(it) {
  const [y, m, d] = it.startDate.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + it.duration - 1));
}

/** @returns {{boards: object[], total: number}} open boards that have a Sprint iteration field */
export function normalizeReviewListing(data) {
  const nodes = data?.viewer?.projectsV2?.nodes;
  if (!Array.isArray(nodes)) throw new Error("listing response had no viewer.projectsV2.nodes");
  const boards = [];
  for (const b of nodes) {
    if (!b || b.closed) continue;
    const f = (b.fields?.nodes ?? []).find((x) => x?.name === "Sprint" && x.configuration);
    if (!f) continue;
    const all = [...(f.configuration.completedIterations ?? []), ...(f.configuration.iterations ?? [])]
      .filter((it) => it?.startDate && Number.isFinite(it.duration))
      .map((it) => ({ id: it.id, title: it.title, start: it.startDate, end: endOf(it) }));
    all.sort((a, b2) => (a.start < b2.start ? -1 : a.start > b2.start ? 1 : 0));
    boards.push({ projectId: b.id, number: b.number, title: b.title, fieldId: f.id, iterations: all });
  }
  return { boards, total: data.viewer.projectsV2.totalCount ?? nodes.length };
}

/**
 * Pick the iteration to review on each board, and the iteration to carry into.
 * Default: the most recently ended; if none has ended, the current one (labelled in-progress).
 * With `title`: the iteration of that title. `next` is the earliest iteration that starts after the reviewed one.
 */
export function pickIterations(boards, today, title = null) {
  const picked = [];
  const skipped = [];
  for (const b of boards) {
    let it;
    let inProgress = false;
    if (title !== null) it = b.iterations.find((x) => x.title === title);
    else {
      const ended = b.iterations.filter((x) => x.end < today);
      it = ended[ended.length - 1];
      if (!it) {
        it = b.iterations.find((x) => x.start <= today && today <= x.end);
        inProgress = Boolean(it);
      }
    }
    if (!it) {
      skipped.push({ number: b.number, title: b.title, why: title !== null ? `no iteration titled "${title}"` : "no ended or current Sprint iteration" });
      continue;
    }
    inProgress = inProgress || it.end >= today;
    const next = b.iterations.find((x) => x.start > it.start) ?? null;
    picked.push({ board: b, sprint: it, next, inProgress });
  }
  return { picked, skipped };
}

// ── items ───────────────────────────────────────────────────────────────────

function normalizeItem(node, board) {
  const c = node?.content;
  if (!c || typeof c.number !== "number" || typeof node.id !== "string") return null;
  const it = { board: board.number, itemId: node.id, number: c.number, title: c.title ?? "", repo: c.repository?.nameWithOwner ?? null, status: null, size: null, sprint: null, finished: null, tokens: null, minutes: null };
  for (const v of node.fieldValues?.nodes ?? []) {
    const name = String(v?.field?.name ?? "").toLowerCase();
    if (name === "status" && typeof v.name === "string") it.status = v.name;
    else if (name === "size" && typeof v.name === "string") it.size = v.name;
    else if (name === "sprint" && typeof v.title === "string") it.sprint = v.title;
    else if (name === "finished" && typeof v.date === "string") it.finished = v.date.slice(0, 10);
    else if (name === "tokens" && typeof v.number === "number") it.tokens = v.number;
    else if (name === "minutes" && typeof v.number === "number") it.minutes = v.number;
  }
  return it;
}

export function normalizeReviewDetail(data, targets) {
  const out = new Map();
  const truncated = [];
  for (const t of targets) {
    const b = data?.viewer?.[`b${t.number}`];
    if (!b) throw new Error(`detail response had no board ${t.number}`);
    const items = [];
    for (const node of b.items?.nodes ?? []) {
      const it = normalizeItem(node, b);
      // The server filter is a request, not a proof: keep only items whose own Sprint value is the reviewed one.
      if (it && it.sprint === t.sprintTitle) items.push(it);
    }
    if ((b.items?.totalCount ?? 0) > (b.items?.nodes?.length ?? 0)) truncated.push(`board ${t.number}: ${b.items.nodes.length} of ${b.items.totalCount}`);
    out.set(t.number, items);
  }
  return { byBoard: out, truncated };
}

/** Classify planned items. Pure. */
export function classify(items, sprint) {
  const done = [];
  const carry = [];
  const unverified = [];
  for (const it of items) {
    if (it.status === "Done") {
      if (it.finished && it.finished >= sprint.start && it.finished <= sprint.end) done.push(it);
      else unverified.push(it);
    } else carry.push(it);
  }
  const sortN = (a, b) => a.number - b.number;
  return { planned: items.length, done: done.sort(sortN), carry: carry.sort(sortN), unverified: unverified.sort(sortN) };
}

// ── the review ──────────────────────────────────────────────────────────────

/**
 * @param {object} a
 * @param {number} a.now  epoch ms
 * @param {{rateLimit: Function, graphql: Function, write: Function}} a.fetcher
 * @param {object[]} a.laneRows
 * @param {string|null} [a.sprintTitle]
 * @param {boolean} [a.apply]
 * @param {((review: object, mutations: string[]) => void)|null} [a.beforeWrite]  called with exactly what will be written, before the first write
 */
export async function buildSprintReview({ now, fetcher, laneRows, sprintTitle = null, apply = false, beforeWrite = null }) {
  const review = { exit: 2, graphqlCalls: 0, notes: [], applied: false, writes: [] };
  const stop = (reason) => ({ ...review, exit: 2, reason });
  const gql = async (q) => {
    review.graphqlCalls++;
    return fetcher.graphql(q);
  };

  let rl;
  try {
    rl = fetcher.rateLimit();
  } catch (e) {
    return stop(`could not read the GitHub rate limit: ${e.message}`);
  }
  if (!rl?.graphql || typeof rl.graphql.remaining !== "number") return stop("could not read the GitHub rate limit (no graphql.remaining)");
  review.rate = rl;
  if (rl.graphql.remaining < MIN_RATE_LIMIT) return stop(`GraphQL remaining ${rl.graphql.remaining} is below ${MIN_RATE_LIMIT}; refusing to start (nothing fetched)`);

  let listing;
  try {
    listing = normalizeReviewListing(await gql(REVIEW_LISTING_QUERY));
  } catch (e) {
    return stop(`board listing failed: ${e.message}`);
  }
  if (listing.boards.length === 0) return stop("no open board has a Sprint iteration field");

  const { picked, skipped } = pickIterations(listing.boards, ymd(new Date(now)), sprintTitle);
  review.skipped = skipped;
  if (!picked.length) return stop(sprintTitle !== null ? `no board has a Sprint iteration titled "${sprintTitle}"` : "no board has an ended or current Sprint iteration");

  const ends = [...new Set(picked.map((p) => p.sprint.end))];
  if (ends.length > 1 || new Set(picked.map((p) => p.sprint.start)).size > 1) {
    review.notes.push(`boards disagree on the reviewed Sprint's dates (${picked.map((p) => `board ${p.board.number}: ${p.sprint.start}..${p.sprint.end}`).join("; ")}); each board is judged against its own dates`);
  }
  for (const p of picked) if (p.inProgress) review.notes.push(`board ${p.board.number}: "${p.sprint.title}" has not ended (${p.sprint.end}); counts are partial`);

  const need = estimateNeed(picked.length);
  if (rl.graphql.remaining < need) return stop(`GraphQL remaining ${rl.graphql.remaining} is below the ${need} estimated for ${picked.length} boards; refusing to fetch items`);

  const targets = picked.map((p) => ({ number: p.board.number, sprintTitle: p.sprint.title }));
  let detail;
  try {
    detail = normalizeReviewDetail(await gql(reviewDetailQuery(targets)), targets);
  } catch (e) {
    return stop(`board item fetch failed: ${e.message}`);
  }
  if (detail.truncated.length) review.notes.push(`truncated at first:100, not paged: ${detail.truncated.join("; ")}`);
  review.notes.push("added mid-sprint: not derivable (GitHub records no timestamp for when an item entered an iteration)");

  review.boards = [];
  const allDone = [];
  for (const p of picked) {
    const c = classify(detail.byBoard.get(p.board.number) ?? [], p.sprint);
    allDone.push(...c.done);
    review.boards.push({ number: p.board.number, title: p.board.title, sprint: p.sprint, next: p.next, inProgress: p.inProgress, ...c });
  }

  const sum = (k) => review.boards.reduce((a, b) => a + (typeof b[k] === "number" ? b[k] : b[k].length), 0);
  review.totals = { planned: sum("planned"), done: sum("done"), carry: sum("carry"), unverified: sum("unverified") };

  // cost fields: every Done item in the window, plus the Status-Done items whose Finished is missing or outside
  const lacking = (items, f) => items.filter((i) => i[f] === null);
  const statusDone = review.boards.flatMap((b) => [...b.done, ...b.unverified]);
  review.missing = {
    statusDone: statusDone.length,
    finished: lacking(statusDone, "finished").length,
    tokens: lacking(allDone, "tokens").length,
    minutes: lacking(allDone, "minutes").length,
    doneInWindow: allDone.length,
  };

  review.ratio = deriveRatio(laneRows);
  review.calibration = calibrate(allDone, laneRows, review.ratio);

  // the moves: carry-over into the board's next iteration, board then issue number
  const moves = [];
  review.unmovable = [];
  for (const b of review.boards) {
    const p = picked.find((x) => x.board.number === b.number);
    if (!b.carry.length) continue;
    if (p.inProgress) {
      review.unmovable.push({ board: b.number, count: b.carry.length, why: `${p.sprint.title} has not ended (${p.sprint.end}); carry-over is only moved after the end` });
      continue;
    }
    if (!p.next) {
      review.unmovable.push({ board: b.number, count: b.carry.length, why: `no later iteration exists on board ${b.number}` });
      continue;
    }
    for (const it of b.carry) {
      moves.push({ board: b.number, projectId: p.board.projectId, fieldId: p.board.fieldId, itemId: it.itemId, number: it.number, repo: it.repo, title: it.title, from: p.sprint.title, to: p.next.title, toIterationId: p.next.id });
    }
  }
  moves.sort((a, b) => a.board - b.board || a.number - b.number);
  review.moves = moves;
  review.exit = 0;
  review.reason = `reviewed ${picked.length} board(s)`;

  if (apply && moves.length) {
    const needW = estimateWriteNeed(moves.length);
    if (rl.graphql.remaining - review.graphqlCalls < needW) {
      return { ...review, exit: 2, reason: `--apply refused: GraphQL remaining ${rl.graphql.remaining} cannot cover about ${needW} for ${moves.length} move(s); nothing written` };
    }
    const chunks = [];
    for (let i = 0; i < moves.length; i += CHUNK) chunks.push(moves.slice(i, i + CHUNK));
    if (beforeWrite) beforeWrite(review, chunks.map(moveMutation));
    for (const chunk of chunks) {
      review.graphqlCalls++;
      try {
        await fetcher.write(moveMutation(chunk));
      } catch (e) {
        return { ...review, exit: 2, applied: false, reason: `--apply failed after ${review.writes.length} of ${moves.length} move(s): ${e.message}` };
      }
      review.writes.push(...chunk.map((m) => `${m.repo ?? "?"}#${m.number}`));
    }
    review.applied = true;
  }
  return review;
}

// ── output ──────────────────────────────────────────────────────────────────

const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/** `moveLines` is what --apply will write; it is printed before any write whether or not --apply was given. */
export function moveLines(review) {
  return review.moves.map((m) => `  move ${m.repo ?? "?"}#${m.number} (board ${m.board}) "${m.from}" -> "${m.to}"  ${m.title}`);
}

export function renderReview(review, { apply = false } = {}) {
  const L = [`propagate sprint review (${apply ? "--apply" : "read-only"})`];
  for (const b of review.boards ?? []) {
    L.push(
      `board ${b.number} ${b.title}: ${b.sprint.title} ${b.sprint.start}..${b.sprint.end}${b.inProgress ? " (not ended)" : ""}`,
      `  planned ${b.planned}, done ${b.done.length}, carry-over ${b.carry.length}, done without Finished in the window ${b.unverified.length}`,
    );
    for (const i of b.carry) L.push(`    carry ${i.repo ?? "?"}#${i.number} [${i.status ?? "no status"}] ${i.title}`);
    for (const i of b.unverified) L.push(`    unverified ${i.repo ?? "?"}#${i.number} (Finished ${i.finished ?? "missing"}) ${i.title}`);
  }
  for (const s of review.skipped ?? []) L.push(`skipped board ${s.number} ${s.title}: ${s.why}`);
  if (review.totals) {
    const t = review.totals;
    L.push(`totals (an item on two boards counts on each): planned ${t.planned}, done ${t.done}, carry-over ${t.carry}, done without Finished in the window ${t.unverified}`);
  }
  if (review.missing) {
    const m = review.missing;
    L.push(
      "missing cost fields (rule:record-completion-cost):",
      `  Status-Done planned items without Finished: ${m.finished} of ${m.statusDone}`,
      `  Done items in the window without Tokens: ${m.tokens} of ${m.doneInWindow}`,
      `  Done items in the window without Minutes: ${m.minutes} of ${m.doneInWindow}`,
    );
  }
  if (review.calibration) {
    const sizes = Object.entries(review.calibration);
    L.push(`Size calibration gain this sprint (Done items with Size and Tokens; floor ${ROW_FLOOR} of ONE basis, lane or main-or-unknown):`);
    if (!sizes.length) L.push("  none: no Done item this sprint has both a Size and Tokens");
    for (const [s, c] of sizes) {
      const toFloor = Math.max(0, ROW_FLOOR - Math.max(c.n_lane, c.n_main_or_unknown));
      L.push(`  ${s}: ${c.n_lane} lane, ${c.n_main_or_unknown} main-or-unknown from this sprint alone; ${toFloor} more of one basis to reach the floor (these items only; earlier sprints also count in \`sprint plan\`)`);
    }
    if (review.ratio?.missing) L.push(`  tokens per week-%: not derivable: ${review.ratio.missing}`);
  }
  if (review.moves && !(apply && review.moves.length)) {
    L.push(apply ? `will write ${review.moves.length} move(s), carry-over only, no re-prioritising:` : `--apply would write ${review.moves.length} move(s) (nothing written):`);
    L.push(...moveLines(review));
    for (const u of review.unmovable ?? []) L.push(`  cannot move ${u.count} item(s) on board ${u.board}: ${u.why}`);
  }
  if (apply && review.moves?.length && !review.applied) L.push(`wrote ${review.writes.length} of ${review.moves.length} move(s)`);
  if (review.applied) L.push(`wrote ${review.writes.length} move(s): ${review.writes.join(", ")}`);
  for (const n of review.notes) L.push(`note: ${n}`);
  L.push(`GraphQL calls made by this command: ${review.graphqlCalls}`);
  L.push(review.exit === 0 ? review.reason : `could not compute: ${review.reason}`);
  return L;
}
