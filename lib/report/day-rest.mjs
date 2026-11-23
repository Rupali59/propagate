/**
 * lib/report/day-rest.mjs — the Projects REST API shapes `day close` falls back to (propagate#339).
 *
 * WHY: GitHub's GraphQL burst limit refuses `day close` exactly when other sessions are starting, and the REST API has
 * its own, separate budget. Measured read-only on 2026-11-19 against a real user project: the items listing returns
 * `fields` with numeric field ids and `value` objects ({id, name:{raw}} for single-select, an ISO date string, a
 * number), takes a `fields=<ids>` query to say which, and every item has a numeric `id` plus its GraphQL `node_id`.
 * The WRITE shape (PATCH `.../items/{id}` with `{fields:[{id, value}]}`) follows GitHub's REST docs and has NOT been
 * run against a real board by this lane (a board write needs the owner's go); the read-back after it is what would catch a
 * wrong shape, and the first real REST write is reported as such in the run's output.
 *
 * PURE: these functions only convert shapes. The calls live in day.mjs and cli/sprint.mjs `ghFetcher().rest`.
 * They convert REST into the GraphQL-shaped nodes that `normalizeDayListing` / `normalizeItem` already consume, so one
 * code path decides what to propose whichever API supplied the data.
 */

/** Field names the planner reads, so the REST listing asks only for these. */
export const WANTED_FIELDS = ["Status", "Size", "Goal", "Priority", "Model", "Order", "Item type", "Finished", "Tokens", "Minutes"];

const raw = (v) => (v && typeof v === "object" ? (v.raw ?? v.html ?? null) : v ?? null);

/** `users/{owner}/projectsV2` rows plus each board's fields, as the GraphQL listing response normalizeDayListing reads. */
export function restBoardsToListing(boards, fieldsByBoard) {
  const nodes = boards.map((b) => ({
    id: String(b.number),
    number: b.number,
    title: b.title,
    closed: b.closed === true || Boolean(b.closed_at),
    fields: {
      nodes: (fieldsByBoard.get(b.number) ?? []).map((f) =>
        Array.isArray(f.options)
          ? { id: f.id, name: f.name, options: f.options.map((o) => ({ id: o.id, name: raw(o.name) })) }
          : { id: f.id, name: f.name, dataType: String(f.data_type ?? "").toUpperCase() }),
    },
  }));
  return { viewer: { projectsV2: { totalCount: nodes.length, nodes } } };
}

/** The numeric ids of the fields the planner wants on a board, for the `fields=` query. */
export function wantedFieldIds(fields) {
  return (fields ?? []).filter((f) => WANTED_FIELDS.some((w) => w.toLowerCase() === String(f.name).toLowerCase())).map((f) => f.id);
}

/** One REST item as the GraphQL-shaped node `normalizeItem` reads. null for an item with no issue or PR behind it. */
export function restItemToNode(it) {
  const c = it?.content;
  if (!c || typeof c.number !== "number") return null;
  const repo = String(c.repository_url ?? "").replace(/^.*\/repos\//, "") || null;
  const nodes = [];
  for (const f of it.fields ?? []) {
    if (f.value === null || f.value === undefined) continue;
    const field = { name: f.name };
    if (f.data_type === "single_select") nodes.push({ name: raw(f.value.name), field });
    else if (f.data_type === "date") nodes.push({ date: String(f.value).slice(0, 10), field });
    else if (f.data_type === "number" && typeof f.value === "number") nodes.push({ number: f.value, field });
  }
  return {
    id: it.node_id,
    restId: it.id,
    content: {
      number: c.number,
      title: c.title,
      body: c.body ?? "",
      state: String(c.state ?? "open").toUpperCase(),
      closedAt: c.closed_at ?? null,
      repository: { nameWithOwner: repo },
      milestone: c.milestone ? { title: c.milestone.title } : null,
      labels: { nodes: (c.labels ?? []).map((l) => ({ name: l.name })) },
    },
    fieldValues: { nodes },
  };
}

/** The PATCH for one write op: users/{owner}/projectsV2/{board}/items/{id} with the field's new value. */
export function restPatchFor(op) {
  const r = op.rest;
  return {
    path: `users/${r.owner}/projectsV2/${r.board}/items/${r.itemId}`,
    body: { fields: [{ id: r.fieldId, value: r.option ?? r.date }] },
  };
}

/** Status name and Finished date out of one REST item, for the read-back. */
export function restReadBackValues(item) {
  const get = (n) => (item?.fields ?? []).find((f) => String(f.name).toLowerCase() === n)?.value ?? null;
  const status = get("status");
  const finished = get("finished");
  return { status: status ? raw(status.name) : null, finished: typeof finished === "string" ? finished.slice(0, 10) : null };
}
