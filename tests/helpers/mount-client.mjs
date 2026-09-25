/**
 * mount-client.mjs — the ONE way this suite renders `commands/ui.client.js`.
 *
 * Extracted from tests/unit/ui-client.test.mjs on 2026-09-25 when a second
 * file needed the same renderer. Copying it would have made two forks of one
 * traversal, which is the defect this repo already paid for inside
 * `lib/report/backlog.mjs` — so the harness moved rather than being duplicated.
 *
 * It loads the three vendored globals exactly as `commands/ui.mjs` serves them
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
export async function mountClient({ inbox, routes = {}, hash = "#ready", reduced = false, settle = 30 } = {}) {
  const { doc, app } = makeDocument();
  const calls = [];
  const answers = { "/api/inbox": inbox, ...routes };

  const ctx = createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Object, Array, String, Number, Boolean, Math, JSON, Map, Set, Promise, RegExp, Error, Date, isNaN, parseInt, parseFloat, Infinity,
    document: doc,
    location: { hash },
    matchMedia: () => ({ matches: reduced }),
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    queueMicrotask,
    fetch: async (url) => {
      const p = String(url).split("?")[0];
      calls.push(p);
      if (!(p in answers)) throw new Error("no stub for " + p);
      return { json: async () => answers[p] };
    },
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window = ctx;

  for (const f of ["commands/vendor/preact.js", "commands/vendor/hooks.js", "commands/vendor/htm.js"]) {
    new Script(read(f)).runInContext(ctx);
  }
  new Script(read("commands/ui.client.js")).runInContext(ctx);
  // Let the mount effect and its fetch settle.
  await new Promise((r) => setTimeout(r, settle));
  return { ctx, app, calls, ui: ctx.__ui };
}
