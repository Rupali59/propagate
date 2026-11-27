/**
 * lib/core/unread.mjs: the one spelling for "I did not understand this input" (propagate#408).
 *
 * A reader that returns a count must be able to say it could not read its input, in a shape no caller can
 * mistake for 0. New readers return `unread(reason)`. The readers that predate this each grew their own spelling;
 * `isUnread` recognises all of them, so one test (tests/unit/blind-readers.test.mjs) covers the class without
 * rewriting any of them.
 */

/** @param {string} reason @returns {{unread: true, reason: string}} */
export function unread(reason) {
  return { unread: true, reason: String(reason) };
}

/**
 * Is `x` any recognised "could not read this" result?
 *   - `{unread: true}`                         lib/core/unread.mjs, goals.mjs
 *   - `{unreadable: true}` / `status|error|state: "unreadable"` (or "unreadable: ...")   costs.mjs, tracker.mjs
 *   - `{count: null, reason}`                  gotchas untriagedGauge
 *   - `{format: "unrecognised"}`               backlog.mjs
 *   - `{error: "unreadable..."}`               handovers.mjs
 * Strict on purpose: `unread: false` and `unread: 0` (a counter) are NOT unread.
 * @param {unknown} x
 * @returns {boolean}
 */
export function isUnread(x) {
  if (!x || typeof x !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (x);
  if (o.unread === true || o.unreadable === true) return true;
  const named = (v) => typeof v === "string" && v.startsWith("unreadable");
  if (named(o.status) || named(o.error) || named(o.state)) return true;
  if (o.count === null && typeof o.reason === "string" && o.reason !== "") return true;
  if (o.format === "unrecognised") return true;
  return false;
}
