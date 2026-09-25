/**
 * One wheel, three surfaces, two themes — asserted on RESOLVED colour.
 *
 * WHY THIS FILE KEEPS GROWING, IN ORDER. Each block below was added after a
 * defect shipped through the blocks above it:
 *
 *   structure   every token defined in both themes, no hex shared across the
 *               two families. Shipped: SIX unreadable light values, because
 *               structure is not legibility.
 *   contrast    every token >= 4.5:1 on its declared ground. Shipped: DRIFTED
 *               and DIVERGED indistinguishable to a deuteranope at separation
 *               17, because contrast is between a colour and its BACKGROUND
 *               and this failure is between two FOREGROUNDS.
 *   cvd + hue   the current floor. Five of seven tokens had sat inside a
 *               43-degree arc with two of them 2 degrees apart.
 *
 * The palette is now authored in OKLCH with relative derivation, so a token's
 * value is no longer a hex a regex can read. Everything here resolves through
 * lib/report/color.mjs — which is itself pinned, in tests/unit/color.test.mjs,
 * to numbers measured before it existed. That matters: a resolver returning
 * plausible-but-wrong colours would make every assertion below pass over a
 * palette nobody checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  contrast, deuteranope, rgbDistance, resolveColor, rgbToOklch,
  declarations, alphaOf, MIN_CVD_SEPARATION,
} from "../../lib/report/color.mjs";

const read = (rel) => readFileSync(path.join(import.meta.dirname, "../..", rel), "utf8");
const used = (css) => new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));

/**
 * Set per-element by the CLIENT, never declared in CSS.
 *
 * A third category, distinct from "declared once and not themed": these have
 * no declaration to find, so the both-themes check would report them missing
 * forever. --len is each chart path's measured length, which only the browser
 * can know; the draw-in animation reads it as its dash offset.
 *
 * THE OBLIGATION THIS CREATES: a token in here that the client does not
 * actually set is a reference to nothing, and the animation silently does not
 * run. commands/ui.client.js is asserted to supply every one of these, below.
 */
const RUNTIME_SET = new Set(["--len"]);

/** Geometry and timing, declared once and never themed. */
const NOT_THEMED = new Set([
  "--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--r1", "--r2", "--r3",
  "--r-shell", "--r-core", "--ease",
  "--t-fast", "--t-base", "--t-row", "--t-slow", "--t-draw", "--t-undo",
  "--h-ok", "--h-caution", "--h-warn", "--h-accent", "--h-drift", "--h-reverse", "--h-diverge",
]);

/**
 * Split a source into its light base and EVERY dark block.
 *
 * ui.css has TWO on purpose — the media query for automatic dark, and
 * [data-theme="dark"] so an explicit toggle wins. A token in only one is broken
 * in exactly one path, silently. An earlier version lumped them together, so
 * deleting a token from the media block still passed; the mutation gate caught
 * it because gates 2 and 3 went red and gate 1 did not.
 */
function themes(css, darkStarts) {
  const first = Math.min(...darkStarts.map((d) => {
    const i = css.indexOf(d);
    assert.notEqual(i, -1, `no dark block matching ${JSON.stringify(d)} — this check has gone blind`);
    return i;
  }));
  const light = declarations(css.slice(0, first));
  const darks = darkStarts.map((d) => {
    const i = css.indexOf(d);
    let depth = 0, k = css.indexOf("{", i);
    for (; k < css.length; k += 1) {
      if (css[k] === "{") depth += 1;
      else if (css[k] === "}") { depth -= 1; if (depth === 0) break; }
    }
    // A dark block redefines only what changes; the rest cascades from light,
    // which is how a browser resolves it.
    return { name: d, map: new Map([...light, ...declarations(css.slice(i, k + 1))]), own: declarations(css.slice(i, k + 1)) };
  });
  return { light, darks };
}

const SURFACES = [
  {
    name: "commands/ui.css",
    css: read("commands/ui.css"),
    darkStarts: ['@media (prefers-color-scheme: dark)', ':root[data-theme="dark"]'],
    ground: { light: "--bg", dark: "--bg" },
    onFill: "--on-fill",
  },
  {
    name: "widget/propagate-queue.jsx",
    css: (() => {
      const s = read("widget/propagate-queue.jsx");
      const i = s.indexOf("export const className = `") + "export const className = `".length;
      const j = s.indexOf("`", i);
      assert.ok(j > i, "className literal not found or truncated");
      return s.slice(i, j);
    })(),
    darkStarts: ["@media (prefers-color-scheme: dark)"],
    // Ubersicht window material: a translucent gradient over the wallpaper, so
    // there is no --bg token to read. These are that composite at its least
    // opaque stop over an appearance-matched desktop — the realistic worst
    // case, not the flattering one. An earlier version read --bg, found
    // nothing, and said so rather than passing; that is how the widget's own
    // --st-accent failure was found.
    ground: { light: "#fdfbfa", dark: "#151517" },
    // The widget's state indicators are 7x7px swatches, never text on a fill.
    // A claim, asserted below, not an omission.
    onFill: null,
  },
];

const SEMANTIC = ["--st-ok", "--st-caution", "--st-warn", "--st-accent",
  "--edge-drift", "--edge-reverse", "--edge-diverge"];

/** Resolve, or report WHY not. Never returns a plausible default. */
function tryResolve(value, vars) {
  try { return { hex: resolveColor(value, vars), alpha: alphaOf(value) }; }
  catch (err) { return { hex: null, why: String(err.message) }; }
}

for (const s of SURFACES) {
  const view = () => themes(s.css, s.darkStarts);

  test(`${s.name}: every token used is defined in BOTH themes`, () => {
    const { light, darks } = view();
    const missing = [];
    for (const tok of used(s.css)) {
      if (NOT_THEMED.has(tok) || RUNTIME_SET.has(tok)) continue;
      if (!light.has(tok)) { missing.push(`${tok} — used but NOT defined in light`); continue; }
      // Inheritance is legitimate: a dark block that does not redefine a token
      // gets the light one, and requiring a copy would invite the two to
      // disagree. What must hold is that it RESOLVES under every theme.
      for (const d of darks) {
        if (!d.map.has(tok)) missing.push(`${tok} — unresolvable under ${d.name}`);
      }
    }
    assert.deepEqual(missing, [], `${s.name}\n  ${missing.join("\n  ")}`);
  });

  test(`${s.name}: geometry and timing are declared once, never themed`, () => {
    const { darks } = view();
    const themed = [...NOT_THEMED].filter((t) => darks.some((d) => d.own.has(t)));
    assert.deepEqual(themed, [], `these are not colour and must not be redefined per theme: ${themed.join(", ")}`);
  });

  test(`${s.name}: every semantic token clears 4.5:1 on its declared ground`, () => {
    const { light, darks } = view();
    const fails = [];
    for (const [key, theme, map] of [["light", "light", light], ...darks.map((d) => ["dark", d.name, d.map])]) {
      const decl = s.ground[key];
      const bg = decl.startsWith("--") ? tryResolve(map.get(decl), map).hex : decl;
      assert.ok(bg, `${theme}: ground ${decl} did not resolve — this check has gone blind`);
      for (const tok of SEMANTIC) {
        const r = tryResolve(map.get(tok), map);
        assert.ok(r.hex, `${theme}: ${tok} did not resolve — ${r.why}`);
        // A translucent colour has no contrast of its own; the answer depends
        // on the backdrop. Excluded rather than measured wrongly.
        if (r.alpha < 1) continue;
        const v = contrast(r.hex, bg);
        if (v < 4.5) fails.push(`${theme}: ${tok} ${r.hex} on ${bg} is ${v.toFixed(2)}`);
      }
    }
    assert.deepEqual(fails, [], `unreadable:\n  ${fails.join("\n  ")}`);
  });

  test(`${s.name}: ink on a saturated fill clears 4.5:1, or the surface declares it has none`, () => {
    if (s.onFill === null) {
      assert.doesNotMatch(s.css, /\.badge\b/,
        "the widget grew a filled text badge — it now needs an --on-fill and a ratio");
      return;
    }
    const { light, darks } = view();
    const fails = [];
    for (const [theme, map] of [["light", light], ...darks.map((d) => [d.name, d.map])]) {
      const ink = tryResolve(map.get(s.onFill), map).hex;
      assert.ok(ink, `${theme}: ${s.onFill} did not resolve — this check has gone blind`);
      for (const tok of SEMANTIC) {
        const r = tryResolve(map.get(tok), map);
        if (!r.hex || r.alpha < 1) continue;
        const v = contrast(ink, r.hex);
        if (v < 4.5) fails.push(`${theme}: ${s.onFill} ${ink} on ${tok} ${r.hex} is ${v.toFixed(2)}`);
      }
    }
    assert.deepEqual(fails, [], `unreadable badges:\n  ${fails.join("\n  ")}`);
  });

  test(`${s.name}: the three edge states stay distinct under deuteranopia`, () => {
    // They render as small swatches with no text, so colour is the ONLY channel
    // carrying the distinction. The pair that shipped scored 17.
    const { light, darks } = view();
    const toks = ["--edge-drift", "--edge-reverse", "--edge-diverge"];
    const fails = [];
    for (const [theme, map] of [["light", light], ...darks.map((d) => [d.name, d.map])]) {
      for (let i = 0; i < toks.length; i += 1) {
        for (let j = i + 1; j < toks.length; j += 1) {
          const a = tryResolve(map.get(toks[i]), map).hex;
          const b = tryResolve(map.get(toks[j]), map).hex;
          if (!a || !b) continue;
          const d = rgbDistance(deuteranope(a), deuteranope(b));
          if (d < MIN_CVD_SEPARATION) {
            fails.push(`${theme}: ${toks[i]} ${a} and ${toks[j]} ${b} are ${d.toFixed(0)} apart, need ${MIN_CVD_SEPARATION}`);
          }
        }
      }
    }
    assert.deepEqual(fails, [], `a deuteranope cannot tell these apart:\n  ${fails.join("\n  ")}`);
  });

  test(`${s.name}: no two semantic hues collide`, () => {
    // --st-accent and --edge-drift were 2 degrees apart while the structural
    // tests asserted the two families never share a hex. Sharing a HUE is the
    // same defect one step out, and nothing was watching for it.
    const { light } = view();
    const hues = SEMANTIC
      .map((t) => [t, rgbToOklch(tryResolve(light.get(t), light).hex).H])
      .filter(([, h]) => h !== null)
      .sort((a, b) => a[1] - b[1]);
    assert.equal(hues.length, SEMANTIC.length, "every semantic token must carry a real hue");
    const tight = [];
    for (let i = 0; i < hues.length; i += 1) {
      const next = hues[(i + 1) % hues.length];
      let gap = next[1] - hues[i][1];
      if (gap < 0) gap += 360;
      if (gap < 25) tight.push(`${hues[i][0]} (${hues[i][1].toFixed(0)}deg) and ${next[0]} (${next[1].toFixed(0)}deg) are ${gap.toFixed(0)}deg apart`);
    }
    assert.deepEqual(tight, [], `hues too close to tell apart:\n  ${tight.join("\n  ")}`);
  });
}

// ── one wheel, not three ───────────────────────────────────────────────────

test("all three surfaces resolve the wheel to the SAME colours", () => {
  // They render the same data side by side and the widget links to the graph
  // page. Two near-identical palettes generated against two slightly different
  // grounds is exactly the bug this caught once already.
  const ui = themes(read("commands/ui.css"), ['@media (prefers-color-scheme: dark)', ':root[data-theme="dark"]']);
  const wi = themes(SURFACES[1].css, ["@media (prefers-color-scheme: dark)"]);
  const graph = read("lib/graph/graph-html.mjs");
  const graphName = { "--edge-drift": "--drift", "--edge-reverse": "--reverse", "--edge-diverge": "--diverge" };

  for (const [theme, a, b, idx] of [["light", ui.light, wi.light, 0], ["dark", ui.darks[0].map, wi.darks[0].map, 1]]) {
    for (const tok of SEMANTIC) {
      const x = resolveColor(a.get(tok), a);
      const y = resolveColor(b.get(tok), b);
      assert.equal(x, y, `${tok} differs between the web UI and the widget in ${theme}`);
      const g = graphName[tok];
      if (!g) continue;
      const hits = [...graph.matchAll(new RegExp(`\\${g}:\\s*(#[0-9a-f]{6})`, "g"))].map((m) => m[1]);
      assert.ok(hits.length >= 2, `graph-html.mjs should define ${g} in both themes, found ${hits.length}`);
      assert.equal(hits[idx], x, `${tok} differs between the web UI and graph-html.mjs in ${theme}`);
    }
  }
});

// ── motion ─────────────────────────────────────────────────────────────────

test("ui.css honours prefers-reduced-motion, and the rule is not toothless", () => {
  const css = read("commands/ui.css");
  const i = css.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.notEqual(i, -1, "no reduced-motion block — animation without one is an accessibility defect");
  const block = css.slice(i, css.indexOf("}", css.indexOf("}", i) + 1) + 1);
  assert.match(block, /animation-duration:\s*\.01ms\s*!important/);
  assert.match(block, /transition-duration:\s*\.01ms\s*!important/);
  assert.match(block, /\*,\s*\*::before,\s*\*::after/, "must apply to everything, not a hand-listed set that rots");
});

test("every animation and transition uses a declared duration token", () => {
  // A hardcoded 300ms cannot be turned off by the reduced-motion block's
  // override of a token, and it is invisible in the system.
  const css = read("commands/ui.css");
  const body = css.slice(css.indexOf("* { box-sizing"));
  const hard = [...body.matchAll(/(?:animation|transition)(?:-duration)?:\s*[^;]*?(\d+m?s)/g)]
    .map((m) => m[0].trim())
    .filter((d) => !/var\(--t-/.test(d) && !/\b1200ms\b/.test(d));
  assert.deepEqual(hard, [], `hardcoded durations outside the token set:\n  ${hard.join("\n  ")}`);
});

test("the undo ring degrades to something that still tells the time", () => {
  // The ring IS the clock. Hiding it under reduced motion without a fallback
  // removes the information, not just the animation — the client renders a
  // numeric countdown, and .secs is where it lands.
  const css = read("commands/ui.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ring \{ display: none/);
  assert.match(css, /\.undo \.secs/, "a numeric fallback must exist for the ring to degrade to");
});

test("a runtime-set token is supplied by whatever uses it, or has a fallback", () => {
  // A CSS token nothing sets resolves to nothing and the animation reading it
  // silently does not run — no error, no warning, and it looks deliberate.
  // Same class of failure as G65's dead page.
  //
  // TWO WAYS TO SATISFY THIS, and the distinction is the point. Either the
  // client sets the token, or the CSS declares a fallback so the rule still
  // means something without it. What is forbidden is a bare var(--x) that
  // nothing supplies.
  const client = read("commands/ui.client.js");
  const css = read("commands/ui.css");
  const bare = [];
  for (const tok of RUNTIME_SET) {
    if (client.includes(tok)) continue;                       // supplied
    const uses = [...css.matchAll(new RegExp(`var\\(${tok}([^)]*)\\)`, "g"))];
    for (const u of uses) {
      if (!u[1].includes(",")) bare.push(`${tok} in "${u[0]}" — no setter and no fallback`);
    }
  }
  assert.deepEqual(bare, [], bare.join("\n  "));
});

test("if the client draws chart series, it MUST measure and set --len", () => {
  // The fallback above keeps the CSS honest while no charts exist. Once they
  // do, a series drawn without a measured length has no draw-in at all, which
  // is the animation silently not happening rather than being turned off.
  const client = read("commands/ui.client.js");
  if (!/class="series"|className="series"|\bseries\b.*<path/.test(client)) return;   // no charts yet
  assert.match(client, /getTotalLength\(\)/, "a series path must measure itself");
  assert.match(client, /--len/, "and hand that length to the CSS");
});

test("ui.css styles every edge state the graph can emit", () => {
  // THE THIRD INSTANCE OF ONE SHAPE, all found on 2026-09-21: a value the code
  // can produce that the stylesheet has no rule for. The widget's toneFor
  // emitted five tones and it styled four; the chart CSS read a --len nothing
  // set; and ACTIONABLE holds four states while ui.css styled three.
  //
  // None of them errors. The element renders with no background, or the
  // animation silently does not run. That is what makes this class worth a
  // test rather than a careful eye.
  const graph = read("lib/graph/graph.mjs");
  const m = /const ACTIONABLE = new Set\(\[([^\]]*)\]\)/.exec(graph);
  assert.ok(m, "could not find ACTIONABLE in graph.mjs — this check has gone blind");
  const states = [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
  assert.ok(states.length >= 4, `expected the actionable states, found ${states.length}`);

  const css = read("commands/ui.css");
  const unstyled = states.filter((st) => !new RegExp(`\\.badge\\.${st}\\s*\\{`).test(css));
  assert.deepEqual(unstyled, [],
    `the graph can emit these states and ui.css gives their badge no background: ${unstyled.join(", ")}`);
});

// ── the population, derived rather than curated ─────────────────────────────

/**
 * N97 / G70. Every colour assertion above iterates SEMANTIC — seven tokens.
 * `commands/ui.css` uses forty-six. The thirty-nine outside that list carry the
 * actual text of the interface and were checked by nothing, which is how four
 * rules shipped putting --dim on --field at 4.40 and .badge.none at 3.60, in a
 * repo whose DESIGN.md sets the floor at 4.5 and whose suite was green.
 *
 * So this check does not name tokens. It reads the stylesheet, finds every rule
 * that declares BOTH a colour and a background, and asserts that pair in both
 * themes. Adding a rule adds coverage; there is no list to remember to extend.
 */
/**
 * T4 / D-T4 guard 1. The FOURTH instance of the shape the test above records,
 * and the first one caught BEFORE it shipped: `.sitem.quiet` had no rule when
 * the component that uses it was written, so the row that must read as muted
 * would have rendered identically to a failure.
 *
 * The population is derived from the two modules that can put a disposition on
 * the wire, never listed here. `reconcile.mjs` emits ROUTING dispositions and
 * `sync.mjs` emits INSERT refusals; the panel renders rows from both, so a
 * guard reading one of them would be blind to half the vocabulary — which is
 * G70's defect exactly, a curated population reporting a clean sweep.
 */
test("ui.css styles every held disposition the reminders lane can emit", () => {
  const sources = [
    ["lib/reminders/sync.mjs", /export const REFUSAL_DISPOSITIONS = Object\.freeze\(\[([^\]]*)\]\)/],
    ["lib/reminders/reconcile.mjs", /export const DISPOSITIONS = Object\.freeze\(\[([^\]]*)\]\)/],
  ];

  const dispositions = [];
  for (const [rel, re] of sources) {
    const m = re.exec(read(rel));
    assert.ok(m, `could not find the disposition list in ${rel} — this check has gone blind`);
    const found = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
    assert.ok(found.length >= 6, `${rel}: parsed only ${found.length} dispositions — the extraction has gone blind`);
    // Only the ones the CONFLICTS panel renders as a badge. `new`, `no-change`,
    // `completed` and `reopened` are outcomes, not conflicts, and never reach it.
    dispositions.push(...found.filter((d) => d.startsWith("held-") || d === "already-inserted"));
  }

  assert.ok(dispositions.length >= 8,
    `expected at least 8 held dispositions across both modules, found ${dispositions.length}: ${dispositions.join(", ")}`);

  const css = read("commands/ui.css");
  const unstyled = dispositions.filter((d) => !new RegExp(`\\.badge\\.${d}\\b`).test(css));
  assert.deepEqual(unstyled, [],
    `the reminders lane can emit these and ui.css gives their badge no background: ${unstyled.join(", ")}`);

  // The muted row is a rule too, and it is the one that had none.
  assert.match(css, /\.sitem\.quiet\s*\{/,
    "`already-inserted` is rendered in a `.sitem.quiet` row and the stylesheet has no rule for it");
});

test("every colour/background pair ui.css DECLARES clears 4.5:1, both themes", () => {
  const css = read("commands/ui.css");
  const t = themes(css, ['@media (prefers-color-scheme: dark)', ':root[data-theme="dark"]']);

  const pairs = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim().split("\n").pop().trim();
    const fg = m[2].match(/(?:^|[;\s])color:\s*var\((--[a-z0-9-]+)\)/);
    const bg = m[2].match(/background(?:-color)?:\s*var\((--[a-z0-9-]+)\)/);
    if (fg && bg) pairs.push({ sel, fg: fg[1], bg: bg[1] });
  }

  // Absence must be attributable: a regex that stops matching would otherwise
  // report a clean sweep of nothing. This is the same guard the edge-state
  // check carries, and the reason it is here is that this test's whole subject
  // is a population that was smaller than anyone thought.
  assert.ok(pairs.length >= 12,
    `only ${pairs.length} colour/background pairs found — the extraction has gone blind`);

  const fails = [];
  for (const [name, vars] of [["light", t.light], ["dark", t.darks[0].map]]) {
    for (const p of pairs) {
      let ink, ground;
      try { ink = resolveColor(vars.get(p.fg), vars); ground = resolveColor(vars.get(p.bg), vars); }
      catch (err) { fails.push(`${name}: ${p.sel} — cannot resolve ${p.fg}/${p.bg}: ${err.message}`); continue; }
      const v = contrast(ink, ground);
      if (v < 4.5) fails.push(`${name}: ${p.sel} — ${p.fg} on ${p.bg} is ${v.toFixed(2)}`);
    }
  }
  assert.deepEqual(fails, [],
    `${pairs.length} pairs checked in 2 themes; under 4.5:1:\n  ${fails.join("\n  ")}`);
});
