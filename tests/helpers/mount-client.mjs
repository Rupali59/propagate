/**
 * mount-client.mjs — the ONE way this suite renders `cli/ui.client.js`.
 *
 * Extracted from tests/unit/ui-client.test.mjs on 2026-09-25 when a second
 * file needed the same renderer. Copying it would have made two forks of one
 * traversal, which is the defect this repo already paid for inside
 * `lib/report/backlog.mjs` — so the harness moved rather than being duplicated.
 *
 * It loads the three vendored globals exactly as `cli/ui.mjs` serves them
 * and evaluates the client in a VM realm over `tests/helpers/minidom.mjs`. The
 * point is that a component which THROWS is caught: the failure a person sees
 * is a blank pane with HTTP 200 and nothing in any log, and only a real render
 * can see it.
 */
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import path from "node:path";

import { makeDocument } from "./minidom.mjs";

const root = path.join(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

/**
 * Mount the real client with the real vendored Preact.
 *
 * `routes` stubs endpoints beyond `/api/inbox`; a path with no stub THROWS
 * rather than resolving empty, so a test that forgot one fails loudly instead
 * of asserting against a pane that never got data.
 */
/**
 * RESPONSE SPECS (2026-10-15, for the redesigned client's api() wrapper).
 *
 * A route used to be a value, answered as `200` JSON. The client now has to be
 * proven against every way a request can end, so a route may also be:
 *   - a function `(call) => value | spec | Promise`, where call is
 *     `{path, url, opts, body, n}` (n counts calls to that path);
 *   - `respond(status, body)`      a JSON body with a chosen status;
 *   - `rawText(status, text)`      a body that is NOT JSON (a proxy's HTML page);
 *   - `rejectWith(error)`          a fetch that rejects (the server is down).
 * Anything else is the old behaviour: 200, JSON.
 */
const SPEC = Symbol("response-spec");
export const respond = (status, body) => ({ [SPEC]: true, status, body });
export const rawText = (status, text) => ({ [SPEC]: true, status, text: String(text) });
export const rejectWith = (error) => ({ [SPEC]: true, reject: error });

export async function mountClient({ inbox, routes = {}, hash = "#ready", reduced = false, timeoutMs = 5000, build, speedUp = false, untracked = [] } = {}) {
  const { doc, app } = makeDocument();
  if (build) doc.body.dataset.build = build;
  const calls = [];
  const fetches = [];
  const unstubbed = [];
  const nth = new Map();
  const inFlight = new Set();
  const listeners = new Map();

  // PENDING MACROTASKS, COUNTED — the condition the earlier attempts kept proxying.
  //
  // "DOM unchanged for N ticks" is a guess at quiescence. Preact schedules its
  // re-render and its effect flush through `requestAnimationFrame` and
  // `setTimeout`, and this realm maps rAF ONTO setTimeout — so wrapping that one
  // function makes the framework's outstanding work directly observable, and every
  // hop of its chain is counted rather than waited out.
  //
  // `setInterval` is deliberately NOT tracked: the client uses one, and a repeating
  // timer never drains, so counting it would make quiescence unreachable. That is
  // the mistake an earlier attempt made by counting rAF callbacks and finding 24 of
  // 25 tests timing out — a mechanism that reschedules itself is never quiet.
  let pendingTimers = 0;
  const ids = new Map();
  const trackedSetTimeout = (fn, ms, ...rest) => {
    // SPEED-UP: the undo hold is five real seconds, and a test that must see the
    // write land would otherwise sleep for it. Delays of a second or more are
    // divided by 100, which keeps every ORDERING (a 150ms debounce still lands
    // before a 5s hold) while making the hold 50ms. Off by default.
    if (speedUp && typeof ms === "number" && ms >= 1000) ms = ms / 100;
    pendingTimers += 1;
    let done = false;
    const id = setTimeout(() => {
      done = true;
      pendingTimers -= 1;
      fn?.(...rest);
    }, ms);
    ids.set(id, () => { if (!done) { done = true; pendingTimers -= 1; } });
    return id;
  };
  const trackedClearTimeout = (id) => {
    ids.get(id)?.();
    ids.delete(id);
    clearTimeout(id);
  };
  const track = (promise) => {
    inFlight.add(promise);
    const drop = () => inFlight.delete(promise);
    promise.then(drop, drop);
    return promise;
  };
  const answers = { "/api/inbox": inbox, ...routes };

  const ctx = createContext({
    console,
    setTimeout: trackedSetTimeout, clearTimeout: trackedClearTimeout,
    // Untracked on purpose — see pendingTimers above.
    setInterval, clearInterval,
    Object, Array, String, Number, Boolean, Math, JSON, Map, Set, Promise, RegExp, Error, Date, isNaN, isFinite, parseInt, parseFloat, Infinity,
    AbortController, encodeURIComponent, decodeURIComponent, Symbol,
    document: doc,
    location: { hash },
    matchMedia: () => ({ matches: reduced }),
    // Captured rather than dropped, so a test can press a key or change the hash.
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    // Expressed in terms of the TRACKED timer, so rAF needs no separate counter.
    requestAnimationFrame: (fn) => trackedSetTimeout(fn, 0),
    cancelAnimationFrame: (id) => trackedClearTimeout(id),
    queueMicrotask,
    // TRACKED, so settling can be a CONDITION rather than a duration. BOTH the
    // response and the `json()` body are counted: the client renders after
    // `json()` resolves, so watching only the outer promise would call the mount
    // settled one await too early.
    fetch: (url, opts = {}) => {
      const p = String(url).split("?")[0];
      calls.push(p);
      const n = (nth.get(p) ?? 0) + 1;
      nth.set(p, n);
      const body = typeof opts.body === "string" ? opts.body : null;
      fetches.push({ path: p, url: String(url), opts, body, n });
      if (!(p in answers)) {
        unstubbed.push(p);
        throw new Error("no stub for " + p);
      }
      if (opts.signal?.aborted) {
        const e = new Error("aborted"); e.name = "AbortError"; return Promise.reject(e);
      }
      let a = answers[p];
      if (typeof a === "function") a = a({ path: p, url: String(url), opts, body, n });
      // A spec may be handed back directly or after a delay; resolve first, then shape.
      const shaped = Promise.resolve(a).then((v) => {
        if (v && v[SPEC]) {
          if (v.reject) return Promise.reject(v.reject);
          const text = v.text !== undefined ? v.text : JSON.stringify(v.body);
          return { status: v.status, text };
        }
        return { status: 200, text: JSON.stringify(v) };
      });
      // An aborted request rejects like the real fetch does, even if it was already answered.
      const guarded = new Promise((resolve, reject) => {
        shaped.then(resolve, reject);
        opts.signal?.addEventListener?.("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
      });
      // UNTRACKED paths are ones a test holds open ON PURPOSE, to look at the page
      // while a request is outstanding. Counting them in `inFlight` would make the
      // mount wait for the very thing the test is trying to observe half-done.
      const t = untracked.includes(p) ? (x) => x : track;
      return t(guarded.then((r) => ({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: () => t(Promise.resolve(r.text)),
        json: () => t(Promise.resolve(r.text).then((x) => JSON.parse(x))),
      })));
    },
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window = ctx;

  for (const f of ["cli/vendor/preact.js", "cli/vendor/hooks.js", "cli/vendor/htm.js"]) {
    new Script(read(f)).runInContext(ctx);
  }
  new Script(read("cli/ui.client.js")).runInContext(ctx);
  // WAIT ON A CONDITION, NOT A CLOCK. This was `await setTimeout(30)` until
  // 2026-09-28, and that one line is the whole of PR-008.
  //
  // `node --test` parallelises across files, so under contention 30ms was not
  // enough for the mount effect's fetch to resolve and Preact to re-render.
  // Assertions then ran against the loading placeholder — the actual value in
  // EVERY recorded occurrence. It explains the whole shape of that issue:
  // intermittent, always clean in isolation, ~11 test names across two files as
  // more mount-based tests were added, and 2 failures escalating to 6 in a day.
  //
  // Confirmed before rewriting: raising the constant to 400 turned a 6-failure run
  // into 2306 passing. Raising it would have been the SAME BUG WITH A BIGGER
  // NUMBER — it re-breaks on a slower or busier machine, and the next person meets
  // a fresh intermittent failure with no memory of this.
  //
  // THE SIGNAL COVERS ATTRIBUTES AND STYLE, not just text, and leaving those out
  // cost a test immediately: the chart's measure effect runs in a rAF and writes
  // the CSS custom property `--len` from getTotalLength(). A style write changes no
  // text, so a text-only signal called the render stable while that callback was
  // still queued and the assertion read `undefined`.
  //
  // COUNTING PENDING rAF CALLBACKS WAS TRIED AND IS WRONG — recorded so nobody
  // tries it again. A component that schedules a frame from inside a frame is
  // never "quiet", so the condition can never be met: 24 of 25 tests timed out.
  // Frames are a mechanism; a settled DOM is the property.
  const domSignature = (node) => {
    if (!node) return "";
    if (node.nodeType === 3) return `#${node.data ?? ""}`;
    let attrs = "";
    let style = "";
    try { attrs = [...(node.attributes ?? [])].map(([k, v]) => `${k}=${v}`).sort().join(","); } catch { attrs = "?"; }
    try { style = [...(node.style?._props ?? [])].map(([k, v]) => `${k}:${v}`).sort().join(";"); } catch { style = "?"; }
    return `<${node.tagName ?? "?"} ${attrs} {${style}}>${(node.childNodes ?? []).map(domSignature).join("")}`;
  };

  // TWO consecutive quiet ticks, not one, and the reason is specific rather than
  // superstitious. Preact flushes `useEffect` through `afterNextFrame`, which races
  // `requestAnimationFrame` against a timeout and then calls `setTimeout(callback)`
  // — so the flush is TWO chained macrotasks. A single quiet tick can land between
  // the hops, and the chart's measure effect (`--len` from getTotalLength) had not
  // run yet: one test failed for exactly that, deterministically, in isolation.
  //
  // This is still a condition, not a duration. The loop runs as long as anything
  // changes; the constant only says how many consecutive UNCHANGED observations
  // count as quiescent, and 2 is what Preact's own double-hop requires.
  const QUIET_TICKS = 2;
  async function settle(ms = timeoutMs) {
  const deadline = Date.now() + ms;
  let previous = null;
  let quiet = 0;
  for (;;) {
    // RACED AGAINST THE DEADLINE, or the deadline below is unreachable. The first
    // version awaited `allSettled` unconditionally, so a fetch that never resolves
    // hung forever instead of timing out — the timeout existed and could not fire.
    // Found immediately by the failing-case test, which is the entire argument for
    // writing one.
    while (inFlight.size > 0 && Date.now() <= deadline) {
      const left = Math.max(1, deadline - Date.now());
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((r) => setTimeout(r, left)),
      ]);
    }
    // A macrotask tick drains every pending microtask first, so Preact's
    // scheduled re-render — and any rAF, which this realm maps to setTimeout(0) —
    // has already run by the time the signature is taken.
    await new Promise((r) => setTimeout(r, 0));
    const now = domSignature(app);
    // THE MOUNT MUST HAVE FETCHED BEFORE ANYTHING COUNTS AS QUIET.
    //
    // Second defect the failing-case test exposed. Preact flushes the mount effect
    // over two chained macrotasks, so the DOM can be unchanged for two ticks BEFORE
    // any fetch is issued — and the loop would exit before the mount had started.
    // With a fast route that is invisible (the data arrives inside the window);
    // with a slow one it returns the loading placeholder. That is the original bug
    // with a different window, which is exactly what this rewrite set out to remove.
    //
    // `/api/inbox` on mount is an invariant of this client, asserted independently
    // by "first paint fetches ONLY /api/inbox". A component that fetches nothing
    // would hang here and the timeout would say so, naming zero calls — which is
    // the honest failure for a harness whose settle signal does not apply.
    const started = calls.length > 0;
    const idle = inFlight.size === 0 && pendingTimers === 0;
    quiet = started && idle && now === previous ? quiet + 1 : 0;
    if (quiet >= QUIET_TICKS) break;
    previous = now;
    if (Date.now() > deadline) {
      // Loud and attributable. A timeout that says only "timed out" sends the next
      // reader back to guessing at durations, which is where this started.
      throw new Error(
        `mountClient: did not settle within ${ms}ms — ${inFlight.size} fetch(es) still in ` +
          `flight and ${pendingTimers} timer(s) pending, after ${calls.length} call(s) to ` +
          `${[...new Set(calls)].join(", ") || "nothing"}. ` +
          `Last DOM signature: ${JSON.stringify(now.slice(0, 200))}`,
      );
    }
  }
  }
  await settle();

  /** Fire a window-level event the client registered for (keydown, hashchange, beforeunload). */
  const fire = (type, ev = {}) => {
    const e = { type, preventDefault() { e.defaultPrevented = true; }, ...ev };
    for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
    return e;
  };
  const press = (key, extra = {}) => fire("keydown", { key, ...extra });
  const setHash = (h) => { ctx.location.hash = h; fire("hashchange"); };
  const listenerCount = (type) => listeners.get(type)?.size ?? 0;
  return { ctx, app, calls, fetches, unstubbed, ui: ctx.__ui, settle, fire, press, setHash, listenerCount, doc };

}
